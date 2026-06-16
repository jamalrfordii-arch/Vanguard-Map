// integrityManager.js — AIS Integrity / counter-spoofing scoring.
//
// Turns the invisible invariant gate into a visible analytical layer: every
// vessel gets a 0–100 TRUST SCORE built from flags that indicate its AIS
// broadcast may be spoofed, manipulated, or erroneous. Flags are INDICATORS FOR
// ANALYST REVIEW, never verdicts.
//
// Performance model (this is why it scales to thousands of vessels):
//   • evaluate() runs PER REPORT, event-driven, reusing the violations the
//     invariant gate already computed. O(1) per message, one vessel.
//   • tick() runs on a ~4 s timer: flag decay + loitering/rendezvous over the
//     small set of STOPPED vessels only. O(k²), k tiny.
//   • The render loop never recomputes — it only reads record.tier.
//
// Console: window.vg1Integrity.flagged() / .getRecord(mmsi) / .all()

import { INTEGRITY } from './config.js';
import { haversineNm } from './invariants.js';
import { simClock } from './simClock.js';

const W = INTEGRITY.WEIGHTS;

// Elevation provider — injected by main.js (setElevationFn) so this module stays
// pure (no THREE/terrainBuilder import) and unit-testable in plain node.
let _elevAt = () => 0;

// Map an invariant violation type → integrity flag type.
function flagTypeFor(violationType) {
    switch (violationType) {
        case 'IMPOSSIBLE_SPEED': return 'IMPOSSIBLE_SPEED';
        case 'EXCESSIVE_SPEED':  return 'EXCESSIVE_SPEED';
        case 'SOG_MISMATCH':     return 'SOG_MISMATCH';
        case 'TIME_REGRESSION':
        case 'FUTURE_EVENT':
        case 'STALE_EVENT':      return 'TIME_REGRESSION';
        default:                 return 'DEFAULT';
    }
}

// Flags that persist while their condition holds (don't expire on the TTL).
const STICKY = new Set(['ON_LAND', 'DARK', 'LOITERING', 'FALSE_FLAG', 'MMSI_INVALID']);

const HUMAN = {
    ON_LAND:          'Reported position is on dry land',
    IMPOSSIBLE_SPEED: 'Teleport-grade position jump',
    EXCESSIVE_SPEED:  'Speed exceeds vessel-class maximum',
    SOG_MISMATCH:     'Track-implied speed ≠ reported speed',
    TIME_REGRESSION:  'Timestamp inconsistency',
    MMSI_INVALID:     'Malformed MMSI / invalid country code',
    DARK:             'AIS transponder went silent',
    LOITERING:        'Stopped alongside another vessel (possible STS)',
    FALSE_FLAG:       'Registered flag ≠ MMSI country',
    DEFAULT:          'AIS anomaly',
};

// Inject the scene-space elevation sampler (terrainBuilder.getTrueElevation in
// the app; a stub in tests). x,z are scene coords; returns metres.
export function setElevationFn(fn) { if (typeof fn === 'function') _elevAt = fn; }

class IntegrityManager {
    constructor() {
        this.records = new Map();   // mmsi → record
        this._dirty  = false;       // a tier changed since last broadcast
        if (typeof window !== 'undefined') window.vg1Integrity = this;
    }

    _get(mmsi) {
        let r = this.records.get(mmsi);
        if (!r) {
            r = { mmsi, name: '', cls: '', latDeg: null, lonDeg: null,
                  sceneX: 0, sceneZ: 0, sogKts: 0, lastSeen: 0,
                  flags: new Map(), loiterSince: null, score: 100, tier: 'TRUSTED',
                  _mmsiChecked: false };
            this.records.set(mmsi, r);
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
        const tier = score >= INTEGRITY.TIER_TRUSTED ? 'TRUSTED'
                   : score >= INTEGRITY.TIER_QUESTIONABLE ? 'QUESTIONABLE' : 'SUSPECT';
        if (tier !== r.tier) this._dirty = true;
        r.score = score; r.tier = tier;
    }

    // ── Per-report evaluation (called from aisManager.onPositionEvaluated) ─────
    evaluate(vessel, violations, ctx) {
        if (!vessel || !vessel.mmsi) return;
        const r = this._get(String(vessel.mmsi));
        r.name = vessel.name; r.cls = vessel.class;
        r.latDeg = vessel.latDeg; r.lonDeg = vessel.lonDeg;
        r.sceneX = ctx?.sceneX ?? r.sceneX; r.sceneZ = ctx?.sceneZ ?? r.sceneZ;
        r.sogKts = ctx?.sogKts ?? vessel.speedKts ?? 0;
        r.lastSeen = simClock.now();

        // MMSI validity — checked once. Valid maritime MID range is 201–775.
        if (!r._mmsiChecked) {
            r._mmsiChecked = true;
            const m = String(vessel.mmsi);
            const mid = parseInt(m.slice(0, 3), 10);
            if (!/^\d{9}$/.test(m) || !(mid >= 201 && mid <= 775)) {
                this._setFlag(r, 'MMSI_INVALID', `MMSI ${m} malformed`);
            }
        }

        // On-land — re-evaluated every report (condition-based).
        const elev = _elevAt(r.sceneX, r.sceneZ);
        if (elev > INTEGRITY.ON_LAND_MIN_M) this._setFlag(r, 'ON_LAND', `position is on land (elev ${Math.round(elev)} m)`);
        else this._clearFlag(r, 'ON_LAND');

        // Kinematic / timestamp violations from the invariant gate.
        for (const v of (violations || [])) {
            const type = flagTypeFor(v.type);
            this._setFlag(r, type, v.message || HUMAN[type]);
        }

        this._rescore(r);
        this._broadcastIfDirty();
    }

    // ── Dark / reappear (wired to aisManager.onVesselDark/onVesselReappear) ────
    markDark(mmsi)     { const r = this._get(String(mmsi)); this._setFlag(r, 'DARK'); this._rescore(r); this._broadcastIfDirty(); }
    markReappear(mmsi) { const r = this.records.get(String(mmsi)); if (r) { this._clearFlag(r, 'DARK'); this._rescore(r); this._broadcastIfDirty(); } }

    remove(mmsi) { this.records.delete(String(mmsi)); }

    // ── Periodic: flag decay + loitering/rendezvous ───────────────────────────
    tick() {
        const now = simClock.now();

        // 1. Expire soft (decaying) flags past their TTL.
        for (const r of this.records.values()) {
            let changed = false;
            for (const [type, f] of r.flags) {
                if (f.decays && now - f.ts > INTEGRITY.FLAG_TTL_MS) { r.flags.delete(type); changed = true; }
            }
            if (changed) this._rescore(r);
        }

        // 2. Loitering / STS — stopped, offshore vessels within LOITER_RADIUS_NM.
        const stopped = [];
        for (const r of this.records.values()) {
            if (r.sogKts < INTEGRITY.LOITER_MIN_KTS && r.latDeg != null
                && _elevAt(r.sceneX, r.sceneZ) < 0) stopped.push(r);
        }
        const paired = new Set();
        for (let i = 0; i < stopped.length; i++) {
            for (let j = i + 1; j < stopped.length; j++) {
                const a = stopped[i], b = stopped[j];
                if (haversineNm(a.latDeg, a.lonDeg, b.latDeg, b.lonDeg) <= INTEGRITY.LOITER_RADIUS_NM) {
                    paired.add(a); paired.add(b);
                }
            }
        }
        for (const r of this.records.values()) {
            if (paired.has(r)) {
                if (r.loiterSince == null) r.loiterSince = now;
                if (now - r.loiterSince >= INTEGRITY.LOITER_MIN_MS && !r.flags.has('LOITERING')) {
                    this._setFlag(r, 'LOITERING'); this._rescore(r);
                }
            } else if (r.loiterSince != null) {
                r.loiterSince = null;
                if (r.flags.has('LOITERING')) { this._clearFlag(r, 'LOITERING'); this._rescore(r); }
            }
        }

        this._dirty = true;        // board refreshes each tick
        this._broadcastIfDirty();
    }

    _broadcastIfDirty() {
        if (!this._dirty || typeof window === 'undefined') return;
        this._dirty = false;
        window.dispatchEvent(new CustomEvent('vg1:integrityChanged'));
    }

    // ── Read API ──────────────────────────────────────────────────────────────
    getRecord(mmsi) { return this.records.get(String(mmsi)) || null; }
    score(mmsi)     { const r = this.records.get(String(mmsi)); return r ? r.score : 100; }
    tier(mmsi)      { const r = this.records.get(String(mmsi)); return r ? r.tier : 'TRUSTED'; }
    // Flagged vessels (below TRUSTED), worst first — drives the panel board.
    flagged() {
        return [...this.records.values()].filter(r => r.tier !== 'TRUSTED')
            .sort((a, b) => a.score - b.score);
    }
    all() { return [...this.records.values()]; }
    // Human-readable reasons for a vessel's flags (for the card).
    reasons(mmsi) {
        const r = this.records.get(String(mmsi)); if (!r) return [];
        return [...r.flags.entries()].map(([type, f]) => ({ type, weight: f.weight, detail: f.detail }))
            .sort((a, b) => b.weight - a.weight);
    }
}

export const integrityManager = new IntegrityManager();
