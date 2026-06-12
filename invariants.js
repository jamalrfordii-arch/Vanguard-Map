// invariants.js — physics & logic invariant checking for entity reports.
//
// The Einstein layer: an anomaly is a violation of a physical invariant,
// not a heuristic. Invariants never need retraining and (almost) never
// false-positive:
//
//   IMPOSSIBLE_SPEED  reject  implied speed exceeds anything that floats
//   EXCESSIVE_SPEED   flag    implied speed exceeds the vessel class max
//   SOG_MISMATCH      flag    vessel claims slow but moved fast (spoof tell)
//   FUTURE_EVENT      flag    event timestamp is ahead of arrival time
//   STALE_EVENT       flag    report arrived long after the event (delayed relay)
//   TIME_REGRESSION   flag    event time went backwards for this vessel
//
// Severities: 'reject' → the report must NOT move the vessel.
//             'flag'   → apply the report, but record the violation.
//
// Pure module: no THREE, no DOM reads. Dispatches 'vg1:invariantViolation'
// on window (same pattern as simClock). Ledger inspectable from DevTools:
//   vg1Invariants.stats()    — counts by type
//   vg1Invariants.recent(20) — last N violations with raw evidence attached
//   vg1Invariants.clear()

import { INVARIANTS } from './config.js';

// ── Geo (kept local so this module stays dependency-light) ──────────────────
const DEG2RAD  = Math.PI / 180;
const EARTH_NM = 3440.065;

export function haversineNm(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * DEG2RAD;
    const dLon = (lon2 - lon1) * DEG2RAD;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_NM * Math.asin(Math.sqrt(a));
}

export function impliedSpeedKts(lat1, lon1, lat2, lon2, dtMs) {
    if (!(dtMs > 0)) return 0;
    return haversineNm(lat1, lon1, lat2, lon2) / (dtMs / 3600000);
}

// ── Event-time parsing (dual timestamps) ─────────────────────────────────────
// AISStream MetaData.time_utc looks like "2026-06-12 14:03:22.123456789 +0000 UTC".
// Synthetic/recorded sources use plain ISO 8601. Returns epoch ms or null —
// callers fall back to arrival time when null, never guess.
export function parseEventTime(s) {
    if (!s) return null;
    if (typeof s === 'number') return Number.isFinite(s) ? s : null;
    const direct = Date.parse(s);
    if (Number.isFinite(direct)) return direct;
    const m = String(s).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)/);
    if (m) {
        const t = Date.parse(`${m[1]}T${m[2]}Z`);
        if (Number.isFinite(t)) return t;
    }
    return null;
}

// ── Violation ledger (ring buffer) ───────────────────────────────────────────
const _ledger = [];
const _counts = {};

function _record(v) {
    _ledger.push(v);
    if (_ledger.length > INVARIANTS.LEDGER_MAX) _ledger.shift();
    _counts[v.type] = (_counts[v.type] || 0) + 1;
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('vg1:invariantViolation', { detail: v }));
    }
}

export const invariantLedger = {
    stats()    { return { ..._counts, total: _ledger.length }; },
    recent(n = 20) { return _ledger.slice(-n); },
    clear()    { _ledger.length = 0; for (const k in _counts) delete _counts[k]; },
};

// ── The checker ──────────────────────────────────────────────────────────────
// prev:   { latDeg, lonDeg, tEvent } | null   — vessel state before this report
// report: { mmsi, name, lat, lon, sogKts, tEvent, tArrival, class }
// Returns array of violations (possibly empty). Caller decides: any 'reject'
// → do not apply the report.
export function checkPositionReport(prev, report) {
    const out = [];
    const add = (type, severity, detail) => {
        const v = {
            type, severity, detail,
            mmsi: report.mmsi, name: report.name,
            tEvent: report.tEvent, tArrival: report.tArrival,
            evidence: { prev: prev ? { lat: prev.latDeg, lon: prev.lonDeg, tEvent: prev.tEvent } : null,
                        report: { lat: report.lat, lon: report.lon, sogKts: report.sogKts } }
        };
        out.push(v);
        _record(v);
    };

    // ── Temporal invariants (need only this report) ──────────────────────────
    if (report.tEvent - report.tArrival > INVARIANTS.MAX_FUTURE_SKEW_MS) {
        add('FUTURE_EVENT', 'flag',
            `event ${((report.tEvent - report.tArrival) / 1000).toFixed(0)}s ahead of arrival`);
    }
    if (report.tArrival - report.tEvent > INVARIANTS.MAX_EVENT_AGE_MS) {
        add('STALE_EVENT', 'flag',
            `report ${((report.tArrival - report.tEvent) / 60000).toFixed(1)}min old on arrival`);
    }

    // ── Kinematic invariants (need previous state) ───────────────────────────
    if (prev && prev.tEvent != null) {
        const dt = report.tEvent - prev.tEvent;

        if (dt < 0) {
            add('TIME_REGRESSION', 'flag', `event time went backwards by ${(-dt / 1000).toFixed(0)}s`);
        } else if (dt >= INVARIANTS.MIN_DT_MS) {
            const vKts = impliedSpeedKts(prev.latDeg, prev.lonDeg, report.lat, report.lon, dt);

            if (vKts > INVARIANTS.HARD_REJECT_KTS) {
                add('IMPOSSIBLE_SPEED', 'reject',
                    `implied ${vKts.toFixed(0)}kts over ${(dt / 60000).toFixed(1)}min — nothing floats that fast`);
            } else {
                const maxKts = INVARIANTS.MAX_SPEED_KTS[report.class] ?? INVARIANTS.MAX_SPEED_KTS.DEFAULT;
                if (vKts > maxKts) {
                    add('EXCESSIVE_SPEED', 'flag',
                        `implied ${vKts.toFixed(0)}kts exceeds ${report.class ?? 'DEFAULT'} max ${maxKts}kts`);
                }
                // Spoof tell: claims to be slow but the positions moved fast.
                if (vKts >= INVARIANTS.SOG_MISMATCH_MIN_KTS &&
                    report.sogKts != null &&
                    vKts > Math.max(1, report.sogKts) * INVARIANTS.SOG_MISMATCH_FACTOR) {
                    add('SOG_MISMATCH', 'flag',
                        `reports ${report.sogKts}kts but moved at ${vKts.toFixed(0)}kts`);
                }
            }
        }
    }

    return out;
}

// DevTools exposure, same convention as window.simClock.
if (typeof window !== 'undefined') window.vg1Invariants = invariantLedger;
