// conflictMath.js — pure CPA (closest point of approach) math for aerial
// conflict detection. No THREE, no window, no DOM — sibling of igrf.js in
// that sense, kept separate from conflictManager.js (which owns the THREE
// scene/visuals/timer wiring) specifically so this logic is testable in
// plain node. See tests/conflict.test.mjs.

import { CONFLICT } from './config.js';

const NM_PER_DEG_LAT = 60;
const M_TO_FT = 3.28084;

export function pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

// Local flat-earth projection around the pair's mean latitude — fine at the
// scale of a few hundred nm, which is the only range this check cares about.
export function toLocalNm(lat, lon, lat0, lon0) {
    return {
        x: (lon - lon0) * NM_PER_DEG_LAT * Math.cos(lat0 * Math.PI / 180),
        y: (lat - lat0) * NM_PER_DEG_LAT,
    };
}

// a, b: { latDeg, lonDeg, altMeters, speedKts, headingDeg, verticalRateMs }
// Returns null if never within both thresholds inside the lookahead window,
// otherwise { horizontalNm, verticalFt, etaSec, severity }.
export function evaluatePair(a, b, cfg = CONFLICT) {
    const lat0 = (a.latDeg + b.latDeg) / 2;
    const lon0 = (a.lonDeg + b.lonDeg) / 2;
    const pa = toLocalNm(a.latDeg, a.lonDeg, lat0, lon0);
    const pb = toLocalNm(b.latDeg, b.lonDeg, lat0, lon0);

    // Velocity vectors in kts (== nm/hr), heading clockwise from north.
    const hr = h => (h ?? 0) * Math.PI / 180;
    const va = { x: a.speedKts * Math.sin(hr(a.headingDeg)), y: a.speedKts * Math.cos(hr(a.headingDeg)) };
    const vb = { x: b.speedKts * Math.sin(hr(b.headingDeg)), y: b.speedKts * Math.cos(hr(b.headingDeg)) };

    const rx = pb.x - pa.x, ry = pb.y - pa.y;
    const vx = vb.x - va.x, vy = vb.y - va.y;
    const vv = vx * vx + vy * vy;

    const lookaheadHr = cfg.LOOKAHEAD_SEC / 3600;

    // Separation as a function of look-ahead time t (hours): horizontal from the
    // relative-motion vector, vertical from each aircraft's altitude + climb rate
    // (verticalRateMs → ft/hr). Kept as closures so we can evaluate either the
    // single horizontal-CPA instant OR sweep the window (see below).
    const altA0 = a.altMeters * M_TO_FT, vrA = (a.verticalRateMs ?? 0) * M_TO_FT * 3600;
    const altB0 = b.altMeters * M_TO_FT, vrB = (b.verticalRateMs ?? 0) * M_TO_FT * 3600;
    const horizNmAt = t => Math.hypot(rx + vx * t, ry + vy * t);
    const vertFtAt  = t => Math.abs((altA0 + vrA * t) - (altB0 + vrB * t));

    // Horizontal closest-point-of-approach time, clamped to [0, lookahead].
    // vv ~ 0 means no closing/opening rate (formation flight); fall back to t=0
    // (current separation) rather than dividing by ~zero.
    let tHr = vv > 1e-6 ? -(rx * vx + ry * vy) / vv : 0;
    tHr = Math.max(0, Math.min(lookaheadHr, tHr));

    // A conflict needs BOTH thresholds breached at the SAME instant. Horizontal
    // CPA is usually the tightest moment, so try it first. But a pair can stay
    // horizontally close for a window while vertically converging into threshold
    // a little later — checking only the CPA instant misses that (regression
    // covered by tests/conflict.test.mjs). So if CPA doesn't qualify, sweep the
    // look-ahead window second-by-second for the earliest instant that does.
    // The time of loss-of-separation is what drives eta/severity.
    let tConf = null;
    if (horizNmAt(tHr) <= cfg.HORIZONTAL_NM && vertFtAt(tHr) <= cfg.VERTICAL_FT) {
        tConf = tHr;
    } else {
        for (let s = 0; s <= cfg.LOOKAHEAD_SEC; s++) {
            const t = s / 3600;
            if (horizNmAt(t) <= cfg.HORIZONTAL_NM && vertFtAt(t) <= cfg.VERTICAL_FT) { tConf = t; break; }
        }
    }
    if (tConf === null) return null;

    const horizontalNm = horizNmAt(tConf);
    const verticalFt    = vertFtAt(tConf);
    const etaSec        = tConf * 3600;
    const severity = (horizontalNm <= cfg.CRITICAL_NM && etaSec <= cfg.CRITICAL_SEC)
        ? 'CRITICAL' : 'ADVISORY';

    return { horizontalNm, verticalFt, etaSec, severity };
}

// ── Separation for an ARBITRARY pair (2026-07-24) ────────────────────────────
// Unlike evaluatePair (which returns null unless a threshold is breached), this
// always returns the CURRENT separation plus closing state and time-to-CPA for
// any two aircraft — used by the aircraft card's "nearest traffic" readout, which
// replaced the on-map conflict lines. Pure/testable, same flat projection.
//   returns { horizontalNm, verticalFt, closing, rangeRateKts, cpaSec, cpaNm }
export function pairSeparation(a, b) {
    const lat0 = (a.latDeg + b.latDeg) / 2;
    const lon0 = (a.lonDeg + b.lonDeg) / 2;
    const pa = toLocalNm(a.latDeg, a.lonDeg, lat0, lon0);
    const pb = toLocalNm(b.latDeg, b.lonDeg, lat0, lon0);

    const hr = h => (h ?? 0) * Math.PI / 180;
    const sa = a.speedKts ?? 0, sb = b.speedKts ?? 0;
    const va = { x: sa * Math.sin(hr(a.headingDeg)), y: sa * Math.cos(hr(a.headingDeg)) };
    const vb = { x: sb * Math.sin(hr(b.headingDeg)), y: sb * Math.cos(hr(b.headingDeg)) };

    const rx = pb.x - pa.x, ry = pb.y - pa.y;
    const vx = vb.x - va.x, vy = vb.y - va.y;
    const vv = vx * vx + vy * vy;

    const horizontalNm = Math.hypot(rx, ry);
    const verticalFt   = Math.abs(((a.altMeters ?? 0) - (b.altMeters ?? 0))) * M_TO_FT;

    // Range rate at t=0: d/dt|r| = (r·v)/|r|. Negative ⇒ closing.
    const rangeRateKts = horizontalNm > 1e-6 ? (rx * vx + ry * vy) / horizontalNm : 0;
    const closing = rangeRateKts < 0;

    // Time to horizontal closest approach (only meaningful when closing).
    const tHr = vv > 1e-6 ? -(rx * vx + ry * vy) / vv : 0;
    const cpaSec = tHr > 0 ? tHr * 3600 : null;
    const cpaNm  = tHr > 0 ? Math.hypot(rx + vx * tHr, ry + vy * tHr) : horizontalNm;

    return { horizontalNm, verticalFt, closing, rangeRateKts, cpaSec, cpaNm };
}

// ── Broad phase (2026-07-24) ─────────────────────────────────────────────────
// evaluate() was all-pairs: 300 aircraft = 44,850 evaluatePair() calls every
// CONFLICT.TICK_MS, measured at 85ms average and 197ms worst on the main thread.
// That was the single largest source of frame stutter in the app, and because
// the adaptive quality controller reads frame time, it was also quietly forcing
// the renderer to give up supersampling — a perf bug wearing a clarity bug's
// clothes.
//
// The bound: two aircraft can only reach CPA inside the lookahead window if they
// are close enough NOW that maximum mutual closure could cover the gap. Minimum
// possible separation at any t is
//     sep(t) >= sep(0) - (speedA + speedB) * t
// so a conflict (sep < HORIZONTAL_NM) requires
//     sep(0) < HORIZONTAL_NM + (speedA + speedB) * LOOKAHEAD_HR
// This is a strict lower bound on separation, so the test is CONSERVATIVE: it
// can admit pairs that turn out fine, it can never reject a real conflict.
// Vertical separation is not considered — a pair that cannot close horizontally
// is not a conflict regardless of altitude, so the horizontal bound alone is safe.
export function maxCandidateSeparationNm(a, b, cfg = CONFLICT) {
    return cfg.HORIZONTAL_NM + (a.speedKts + b.speedKts) * (cfg.LOOKAHEAD_SEC / 3600);
}

// Visits every pair worth running evaluatePair() on. Sorts by latitude once,
// then sweeps: because the list is sorted, once a partner is further north than
// the widest possible candidate gap, so is every partner after it — hence the
// `break` rather than `continue`, which is what turns this from O(n²) into
// roughly O(n log n) for realistically-spread traffic.
//
// NOTE ON THE ANTIMERIDIAN: the longitude delta here is deliberately NOT wrapped,
// matching toLocalNm()'s flat projection, which also does not wrap. A pair
// straddling 180° reads as ~360° apart to both, so both reject it. That is a
// pre-existing limitation of the CPA projection, not something introduced here —
// this function must mirror it exactly or it would change behaviour. Fixing it
// means fixing toLocalNm, and this bound will then follow automatically.
export function forEachCandidatePair(live, cfg = CONFLICT, visit) {
    const n = live.length;
    if (n < 2) return 0;

    const sorted = live.slice().sort((p, q) => p.latDeg - q.latDeg);

    // Sweep width uses the FASTEST aircraft present, so the latitude window is
    // valid for every pair in the list, not just the average one.
    let maxSpeed = 0;
    for (let i = 0; i < n; i++) if (sorted[i].speedKts > maxSpeed) maxSpeed = sorted[i].speedKts;
    const windowDegLat = (cfg.HORIZONTAL_NM + 2 * maxSpeed * (cfg.LOOKAHEAD_SEC / 3600)) / 60;

    let considered = 0;
    for (let i = 0; i < n; i++) {
        const a = sorted[i];
        for (let j = i + 1; j < n; j++) {
            const b = sorted[j];
            const dLatDeg = b.latDeg - a.latDeg;
            if (dLatDeg > windowDegLat) break;      // sorted → nothing further can qualify

            // Per-pair (tighter than the global sweep window) circular reject.
            const sepNm   = maxCandidateSeparationNm(a, b, cfg);
            const dLatNm  = dLatDeg * 60;
            const cosLat  = Math.cos(((a.latDeg + b.latDeg) / 2) * Math.PI / 180);
            const dLonNm  = (b.lonDeg - a.lonDeg) * 60 * cosLat;
            if (dLatNm * dLatNm + dLonNm * dLonNm > sepNm * sepNm) continue;

            considered++;
            visit(a, b);
        }
    }
    return considered;
}
