// portCallManager.js — cargo intelligence Phase 2: port-call detection.
// (research/vanguard1-cargo-intel-spec-2026-07-23.md §5)
//
// Detects when a live AIS vessel enters, dwells in, and leaves a named port from
// portManager.js's PORTS list, and writes a small persisted per-MMSI port-call log
// (last port, arrival/departure time, draught on arrival/departure) that Phase 3
// (vessel-card "LAST PORT"/"INFERRED VOYAGE" fields, not yet built) will read.
//
// KNOWN APPROXIMATION, stated up front: PORTS entries are centroids with no real
// harbor polygon, so this is a generous radius+dwell heuristic, not exact
// geofencing. A vessel anchored offshore waiting for a berth, or a large port
// whose docks sit far from its centroid (e.g. Rotterdam's Maasvlakte), can miss
// or misfire. Treat this as "probably called at this port," not ground truth.
//
// Two-speed shape, same as conflictManager.js: tick(vessels) does the O(n·m)
// distance/state-machine work on a timer (CARGO.TICK_MS) from main.js, NOT every
// frame. There is no per-frame visual half here — no glyph/line, this is a pure
// state tracker — so there's no updateVisuals() counterpart.
//
// State machine per vessel (mmsi → record):
//   UNDERWAY    — not near any port
//   APPROACHING — inside PORT_CALL_RADIUS_NM of a port, not yet stopped long enough
//   IN_PORT     — inside radius AND stopped (< STOPPED_SPEED_KTS) for DWELL_MIN_MS
// The IN_PORT → (exits radius) transition finalizes and persists the port-call
// record and fires vg1:portCall; there's no lingering "DEPARTED" state — a vessel
// goes straight back to UNDERWAY, ready to detect its next port.
//
// Console: window.vg1PortCalls.

import { haversineNm } from './dataSource.js';
import { PORTS } from './portManager.js';
import { CARGO } from './config.js';
import { simClock } from './simClock.js';

const LS_KEY     = 'vg1_port_call_log';
const MAX_MMSI   = 5000;   // soft cap on remembered vessels
const MAX_CALLS  = 5;      // rolling log depth per vessel
const FLUSH_MS   = 4000;

function _loadLog() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; }
    catch (_) { return {}; }
}
function _scheduleFlush(store) {
    if (store._flushTimer || typeof localStorage === 'undefined') return;
    store._flushTimer = setTimeout(() => {
        store._flushTimer = null;
        try {
            const keys = Object.keys(store.log);
            if (keys.length > MAX_MMSI) {
                const trimmed = {};
                for (const k of keys.slice(keys.length - MAX_MMSI)) trimmed[k] = store.log[k];
                store.log = trimmed;
            }
            localStorage.setItem(LS_KEY, JSON.stringify(store.log));
        } catch (_) { /* quota / private mode — log stays in-memory only */ }
    }, FLUSH_MS);
}

export class PortCallManager {
    constructor() {
        this._state = new Map();   // mmsi → { state, port, stoppedSince, enteredAt }
        this._log   = { log: _loadLog(), _flushTimer: null };

        if (typeof window !== 'undefined') window.vg1PortCalls = this;
    }

    // Nearest PORTS entry within CARGO.PORT_CALL_RADIUS_NM, or null.
    _nearestPort(latDeg, lonDeg) {
        let best = null, bestNm = Infinity;
        for (const p of PORTS) {
            const nm = haversineNm(latDeg, lonDeg, p.lat, p.lon);
            if (nm <= CARGO.PORT_CALL_RADIUS_NM && nm < bestNm) { best = p; bestNm = nm; }
        }
        return best;
    }

    // vessels: iterable of { mmsi, latDeg, lonDeg, speedKts, draughtM }
    // (aisManager.vessels.values() satisfies this directly — called from main.js
    // on a timer, same calling convention as conflictManager.evaluate()).
    tick(vessels) {
        const now = simClock.now();
        for (const v of vessels) {
            if (v.latDeg == null || v.lonDeg == null) continue;
            const mmsi = String(v.mmsi);
            let rec = this._state.get(mmsi);
            if (!rec) { rec = { state: 'UNDERWAY', port: null, stoppedSince: null }; this._state.set(mmsi, rec); }

            const nearPort = this._nearestPort(v.latDeg, v.lonDeg);
            const stopped  = v.speedKts != null && v.speedKts < CARGO.STOPPED_SPEED_KTS;

            if (rec.state === 'UNDERWAY') {
                if (nearPort) { rec.state = 'APPROACHING'; rec.port = nearPort; rec.stoppedSince = null; }
                continue;
            }

            if (rec.state === 'APPROACHING') {
                if (!nearPort) {
                    // Left every port's radius before dwelling long enough — a
                    // transit-by, not a call.
                    rec.state = 'UNDERWAY'; rec.port = null; rec.stoppedSince = null;
                    continue;
                }
                if (nearPort.name !== rec.port.name) {
                    // Drifted from one port's radius straight into another's
                    // (e.g. two closely-spaced ports) — retarget, dwell resets.
                    rec.port = nearPort; rec.stoppedSince = null;
                    continue;
                }
                if (stopped) {
                    if (rec.stoppedSince == null) rec.stoppedSince = now;
                    if (now - rec.stoppedSince >= CARGO.DWELL_MIN_MS) {
                        rec.state = 'IN_PORT';
                        rec.arrivedAt = rec.stoppedSince;
                        rec.draughtOnArrival = v.draughtM ?? null;
                    }
                } else {
                    rec.stoppedSince = null; // still moving — reset the dwell timer
                }
                continue;
            }

            if (rec.state === 'IN_PORT') {
                if (!nearPort || nearPort.name !== rec.port.name) {
                    // Finalize — this is the IN_PORT → DEPARTED transition (§5). No
                    // lingering DEPARTED state; goes straight back to UNDERWAY.
                    const record = {
                        port: rec.port.name,
                        arrivedAt: rec.arrivedAt,
                        departedAt: now,
                        draughtOnArrival: rec.draughtOnArrival,
                        draughtOnDeparture: v.draughtM ?? null,
                    };
                    this._appendCall(mmsi, record);
                    if (typeof window !== 'undefined') {
                        window.dispatchEvent(new CustomEvent('vg1:portCall', { detail: { mmsi, ...record } }));
                    }
                    rec.state = 'UNDERWAY'; rec.port = null; rec.stoppedSince = null;
                    rec.arrivedAt = null; rec.draughtOnArrival = null;
                }
                // else: still in port, nothing to do this tick.
            }
        }
    }

    _appendCall(mmsi, record) {
        const arr = this._log.log[mmsi] || [];
        arr.push(record);
        while (arr.length > MAX_CALLS) arr.shift();
        this._log.log[mmsi] = arr;
        _scheduleFlush(this._log);
    }

    // ── Read API ──────────────────────────────────────────────────────────────
    // Current live state for one vessel (UNDERWAY/APPROACHING/IN_PORT + port), or null.
    current(mmsi) { return this._state.get(String(mmsi)) || null; }
    // Completed port-call history for one vessel (most recent last), or [].
    history(mmsi) { return this._log.log[String(mmsi)] || []; }
    // Most recent completed call for one vessel, or null.
    lastCall(mmsi) { const h = this.history(mmsi); return h.length ? h[h.length - 1] : null; }

    clear() { this._log.log = {}; try { localStorage.removeItem(LS_KEY); } catch (_) {} }
}

// True singleton, same pattern as integrityManager.js — imported directly by both
// main.js (drives .tick() on a timer) and uiController.js (reads .current()/
// .lastCall() for the vessel-detail card). window.vg1PortCalls (set in the
// constructor above) stays a DEBUG MIRROR only, per CLAUDE.md's dependency policy
// (Tier 3: window.* is for console poking, never the real data path).
export const portCallManager = new PortCallManager();
