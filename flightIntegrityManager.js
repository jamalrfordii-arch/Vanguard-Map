// flightIntegrityManager.js — Aerial Integrity / trust scoring.
//
// Sibling of integrityManager.js (AIS), same philosophy: every aircraft gets
// a 0-100 TRUST SCORE built from flags that indicate its ADS-B broadcast may
// be spoofed, malfunctioning, or genuinely an emergency. Flags are INDICATORS
// FOR ANALYST REVIEW, never verdicts.
//
// Unlike the AIS pipeline, there is no separate "invariants gate" module for
// aircraft yet (that was the other option on the table — deliberately out of
// scope here). This module is self-contained: it keeps its own per-icao24
// previous-position snapshot and does the kinematic math itself, so the only
// wiring flightManager.js needs is "hand me every parsed report."
//
// Performance model, same shape as integrityManager.js:
//   • evaluate() runs PER POLL UPDATE, O(1) per aircraft.
//   • tick() runs on a timer: flag decay only (no loitering concept in the
//     air — aircraft don't raft up). O(n).
//   • The render loop never recomputes — it only reads record.tier.
//
// Console: window.vg1FlightIntegrity.flagged() / .getRecord(icao24) / .all()

import { FLIGHT_INTEGRITY } from './config.js';
import { haversineNm, impliedSpeedKts } from './invariants.js';
import { simClock } from './simClock.js';

const W = FLIGHT_INTEGRITY.WEIGHTS;

// Flags that persist while their condition holds (don't expire on the TTL).
const STICKY = new Set(['ICAO_INVALID', 'EMERGENCY', 'DARK']);

const HUMAN = {
    ICAO_INVALID:     'Malformed or null ICAO24 hex address',
    EMERGENCY:        'Emergency squawk or ADS-B emergency flag set',
    IMPOSSIBLE_SPEED: 'Teleport-grade position jump between polls',
    ALTITUDE_JUMP:    'Climb/descent rate implied between polls is impossible',
    SPEED_MISMATCH:   'Reported ground speed inconsistent with track-implied speed',
    EXCESSIVE_SPEED:  'Implied speed exceeds plausible-aircraft ceiling',
    DARK:             'ADS-B transponder went silent',
    DEFAULT:          'Aerial anomaly',
};

const EMERGENCY_SQUAWKS = new Set(['7500', '7600', '7700']);

function normalizeSquawk(sq) {
    if (sq == null) return null;
    const s = String(sq).trim();
    return s.length ? s.padStart(4, '0') : null;
}

class FlightIntegrityManager {
    constructor() {
        this.records = new Map();   // icao24 → record
        this._dirty  = false;
        if (typeof window !== 'undefined') window.vg1FlightIntegrity = this;
    }

    _get(icao24) {
        let r = this.records.get(icao24);
        if (!r) {
            r = { icao24, callsign: '', latDeg: null, lonDeg: null, altMeters: null,
                  speedKts: 0, headingDeg: 0, squawk: null, emergency: null,
                  lastSeen: 0, flags: new Map(), score: 100, tier: 'TRUSTED',
                  _icaoChecked: false };
            this.records.set(icao24, r);
        }
        return r;
    }

    _setFlag(r, type, detail) {
        r.flags.set(type, { weight: W[type] ?? W.DEFAULT, detail: detail || HUMAN[type] || type,
                            ts: simClock.now(), decays: !STICKY.has(type) });
    }
    _clearFlag(r, type) { r.flags.delete(type); }

    _rescore(r) {
        let penalty = 0;
        for (const f of r.flags.values()) penalty += f.weight;
        const score = Math.max(0, Math.min(100, 100 - penalty));
        const tier = score >= FLIGHT_INTEGRITY.TIER_TRUSTED ? 'TRUSTED'
                   : score >= FLIGHT_INTEGRITY.TIER_QUESTIONABLE ? 'QUESTIONABLE' : 'SUSPECT';
        if (tier !== r.tier) this._dirty = true;
        r.score = score; r.tier = tier;
    }

    // ── Per-poll evaluation ──────────────────────────────────────────────────
    // report: { icao24, callsign, lat, lon, altMeters, speedKts, headingDeg,
    //           squawk, emergency, now }
    evaluate(report) {
        if (!report || !report.icao24) return;
        const r = this._get(report.icao24);
        const prev = (r.latDeg != null && r.lastSeen) // snapshot BEFORE we overwrite below
            ? { lat: r.latDeg, lon: r.lonDeg, altMeters: r.altMeters, t: r.lastSeen }
            : null;
        const now = report.now ?? simClock.now();

        r.callsign  = report.callsign ?? r.callsign;
        r.speedKts  = report.speedKts ?? 0;
        r.headingDeg = report.headingDeg ?? 0;
        r.squawk    = normalizeSquawk(report.squawk);
        r.emergency = report.emergency || null;

        // ICAO24 validity — checked once. Must be 6 hex chars, not all-zero/all-F
        // (both used by misconfigured or anonymized transponders).
        if (!r._icaoChecked) {
            r._icaoChecked = true;
            const hex = String(report.icao24).toLowerCase();
            if (!/^[0-9a-f]{6}$/.test(hex) || hex === '000000' || hex === 'ffffff') {
                this._setFlag(r, 'ICAO_INVALID', `ICAO24 "${report.icao24}" malformed/reserved`);
            }
        }

        // Emergency — squawk 7500 (hijack) / 7600 (radio failure) / 7700 (general
        // emergency), or the ADS-B "emergency" field itself set to anything but none.
        const emergencySquawk = r.squawk && EMERGENCY_SQUAWKS.has(r.squawk);
        const emergencyField  = r.emergency && r.emergency !== 'none';
        if (emergencySquawk || emergencyField) {
            this._setFlag(r, 'EMERGENCY',
                emergencySquawk ? `squawking ${r.squawk}` : `ADS-B emergency: ${r.emergency}`);
        } else {
            this._clearFlag(r, 'EMERGENCY');
        }

        // Was dark, now reporting again — clear it. The kinematic check below
        // naturally judges whether the gap was plausible (distance / real dt),
        // so no separate "reappeared far away" flag is needed.
        this._clearFlag(r, 'DARK');

        // ── Kinematic checks (need a previous snapshot) ──────────────────────
        if (prev && prev.lat != null && report.lat != null) {
            const dt = now - prev.t;
            if (dt >= FLIGHT_INTEGRITY.MIN_DT_MS) {
                const vKts = impliedSpeedKts(prev.lat, prev.lon, report.lat, report.lon, dt);

                if (vKts > FLIGHT_INTEGRITY.IMPOSSIBLE_SPEED_KTS) {
                    this._setFlag(r, 'IMPOSSIBLE_SPEED',
                        `implied ${vKts.toFixed(0)}kts over ${(dt / 60000).toFixed(1)}min`);
                } else {
                    this._clearFlag(r, 'IMPOSSIBLE_SPEED');
                    if (vKts > FLIGHT_INTEGRITY.EXCESSIVE_SPEED_KTS) {
                        this._setFlag(r, 'EXCESSIVE_SPEED',
                            `implied ${vKts.toFixed(0)}kts exceeds ${FLIGHT_INTEGRITY.EXCESSIVE_SPEED_KTS}kt ceiling`);
                    } else {
                        this._clearFlag(r, 'EXCESSIVE_SPEED');
                    }
                    if (vKts >= FLIGHT_INTEGRITY.SPEED_MISMATCH_MIN_KTS && report.speedKts != null &&
                        vKts > Math.max(1, report.speedKts) * FLIGHT_INTEGRITY.SPEED_MISMATCH_FACTOR) {
                        this._setFlag(r, 'SPEED_MISMATCH',
                            `reports ${report.speedKts}kts but track implies ${vKts.toFixed(0)}kts`);
                    } else {
                        this._clearFlag(r, 'SPEED_MISMATCH');
                    }
                }

                // Altitude jump — implied climb/descent rate (ft/min).
                if (prev.altMeters != null && report.altMeters != null) {
                    const dAltFt = (report.altMeters - prev.altMeters) * 3.28084;
                    const fpm = Math.abs(dAltFt) / (dt / 60000);
                    if (fpm > FLIGHT_INTEGRITY.ALTITUDE_JUMP_FPM) {
                        this._setFlag(r, 'ALTITUDE_JUMP',
                            `implied ${fpm.toFixed(0)}ft/min ${dAltFt > 0 ? 'climb' : 'descent'}`);
                    } else {
                        this._clearFlag(r, 'ALTITUDE_JUMP');
                    }
                }
            }
        }

        r.latDeg = report.lat; r.lonDeg = report.lon; r.altMeters = report.altMeters;
        r.lastSeen = now;

        this._rescore(r);
        this._broadcastIfDirty();
    }

    // ── Dark (wired to flightManager.onAircraftRemove after STALE_MS) ────────
    markDark(icao24) {
        const r = this.records.get(icao24);
        if (!r) return; // never seen — nothing to flag
        this._setFlag(r, 'DARK');
        this._rescore(r);
        this._broadcastIfDirty();
    }

    remove(icao24) { this.records.delete(icao24); }

    // ── Periodic: flag decay only — aircraft don't loiter together ──────────
    tick() {
        const now = simClock.now();
        for (const r of this.records.values()) {
            let changed = false;
            for (const [type, f] of r.flags) {
                if (f.decays && now - f.ts > FLIGHT_INTEGRITY.FLAG_TTL_MS) { r.flags.delete(type); changed = true; }
            }
            if (changed) this._rescore(r);
        }
        this._dirty = true;
        this._broadcastIfDirty();
    }

    _broadcastIfDirty() {
        if (!this._dirty || typeof window === 'undefined') return;
        this._dirty = false;
        window.dispatchEvent(new CustomEvent('vg1:flightIntegrityChanged'));
    }

    // ── Read API ──────────────────────────────────────────────────────────────
    getRecord(icao24) { return this.records.get(icao24) || null; }
    score(icao24)     { const r = this.records.get(icao24); return r ? r.score : 100; }
    tier(icao24)      { const r = this.records.get(icao24); return r ? r.tier : 'TRUSTED'; }
    flagged() {
        return [...this.records.values()].filter(r => r.tier !== 'TRUSTED')
            .sort((a, b) => a.score - b.score);
    }
    all() { return [...this.records.values()]; }
    reasons(icao24) {
        const r = this.records.get(icao24); if (!r) return [];
        return [...r.flags.entries()].map(([type, f]) => ({ type, weight: f.weight, detail: f.detail }))
            .sort((a, b) => b.weight - a.weight);
    }
}

export const flightIntegrityManager = new FlightIntegrityManager();
