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
