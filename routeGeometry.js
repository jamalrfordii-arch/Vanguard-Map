// routeGeometry.js — geodesy for STM route plans. Pure math, no THREE, no DOM.
//
// Everything Enhanced Monitoring needs to answer "where is this ship relative to
// the route it declared?": rhumb-line and great-circle distance/bearing, signed
// cross-track distance, along-track distance, and route-level projection with
// leg progression.
//
// WHY BOTH RHUMB AND GREAT CIRCLE, AND WHY IT MATTERS
// ---------------------------------------------------
// RTZ legs carry `geometryType` = "Loxodrome" (rhumb line, constant course) or
// "Orthodrome" (great circle, shortest path). Between the same two points these
// are DIFFERENT PATHS — on a 500 nm leg at 60°N the great circle sags several
// miles poleward of the rhumb line. Measuring cross-track with the great-circle
// formula against a leg the ship is steering as a rhumb line manufactures a
// deviation that does not exist, and vice versa. So the cross-track function
// dispatches on the leg's declared geometryType, defaulting to Loxodrome per the
// RTZ specification.
//
// UNITS: nautical miles and degrees throughout. Bearings are 0-360 true.
// Cross-track sign convention: POSITIVE = vessel is to STARBOARD of the
// route axis (right of the direction of travel), NEGATIVE = to PORT. This
// matches RTZ's asymmetric starboardXTD / portsideXTD pair directly.
//
// Tests: node tests/routeGeometry.test.mjs

import { haversineNm, bearingDeg } from './dataSource.js';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const EARTH_NM = 3440.065;          // same value dataSource.js uses — kept identical on purpose
const TWO_PI = Math.PI * 2;

// ── small helpers ────────────────────────────────────────────────────────────

/** Wrap a longitude difference in radians into (-π, π]. */
function wrapPi(d) {
    while (d >  Math.PI) d -= TWO_PI;
    while (d <= -Math.PI) d += TWO_PI;
    return d;
}

/** Normalise a bearing in degrees into [0, 360). */
export function normaliseBearing(deg) {
    if (deg == null || !Number.isFinite(deg)) return null;
    return ((deg % 360) + 360) % 360;
}

/**
 * Smallest absolute angle between two bearings, in degrees, 0-180.
 * Used to tell "the ship turned" from "the ship is 359° vs 001°".
 */
export function bearingDeltaDeg(a, b) {
    const na = normaliseBearing(a), nb = normaliseBearing(b);
    if (na == null || nb == null) return null;
    const d = Math.abs(na - nb) % 360;
    return d > 180 ? 360 - d : d;
}

/** Inverse Gudermannian — the Mercator "stretched latitude", in radians. */
function mercatorPhi(latRad) {
    return Math.log(Math.tan(Math.PI / 4 + latRad / 2));
}

// ── Rhumb line (loxodrome) ───────────────────────────────────────────────────
// A rhumb line crosses every meridian at the same angle. It is what a ship
// steering a constant compass course actually follows, and it is RTZ's default
// leg geometry. It is also a straight line in a Mercator projection, which is
// why loxodrome legs need no tessellation in Vanguard1's scene space (see
// lonLatToScene in aisManager.js).

/** Rhumb-line distance in nautical miles. */
export function rhumbDistanceNm(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * DEG2RAD, p2 = lat2 * DEG2RAD;
    const dPhi = p2 - p1;
    const dLon = wrapPi((lon2 - lon1) * DEG2RAD);

    const dPsi = mercatorPhi(p2) - mercatorPhi(p1);
    // q is the ratio dPhi/dPsi; at dPsi→0 (an east-west line) that limit is
    // cos(lat). Guarding on dPsi rather than on dPhi is deliberate: near the
    // poles dPsi grows without bound while dPhi stays small, so testing dPhi
    // would take the wrong branch exactly where the error is largest.
    const q = Math.abs(dPsi) > 1e-12 ? dPhi / dPsi : Math.cos(p1);

    return Math.sqrt(dPhi * dPhi + q * q * dLon * dLon) * EARTH_NM;
}

/** Rhumb-line (constant) bearing in degrees true, 0-360. */
export function rhumbBearingDeg(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * DEG2RAD, p2 = lat2 * DEG2RAD;
    const dLon = wrapPi((lon2 - lon1) * DEG2RAD);
    const dPsi = mercatorPhi(p2) - mercatorPhi(p1);
    return normaliseBearing(Math.atan2(dLon, dPsi) * RAD2DEG);
}

/** Point reached by steering `brgDeg` for `distNm` along a rhumb line. */
export function rhumbDestination(lat, lon, brgDeg, distNm) {
    const p1 = lat * DEG2RAD;
    const brg = brgDeg * DEG2RAD;
    const delta = distNm / EARTH_NM;

    const dPhi = delta * Math.cos(brg);
    let p2 = p1 + dPhi;

    // Latitude overshoot past a pole — wrap it back rather than emitting a
    // nonsense latitude. Rare, but a route crossing 90°N should not produce NaN.
    if (Math.abs(p2) > Math.PI / 2) p2 = p2 > 0 ? Math.PI - p2 : -Math.PI - p2;

    const dPsi = mercatorPhi(p2) - mercatorPhi(p1);
    const q = Math.abs(dPsi) > 1e-12 ? dPhi / dPsi : Math.cos(p1);
    const dLon = delta * Math.sin(brg) / q;

    return {
        lat: p2 * RAD2DEG,
        lon: (((lon + dLon * RAD2DEG) + 540) % 360) - 180,
    };
}

// ── Great circle (orthodrome) ────────────────────────────────────────────────

/** Great-circle initial bearing, degrees true. Delegates to dataSource. */
export const gcBearingDeg = bearingDeg;

/** Great-circle distance, nautical miles. Delegates to dataSource. */
export const gcDistanceNm = haversineNm;

/**
 * Signed great-circle cross-track distance from point P to the great circle
 * through A→B, in nautical miles. Positive = P is to starboard of A→B.
 */
export function gcCrossTrackNm(latP, lonP, latA, lonA, latB, lonB) {
    const d13 = haversineNm(latA, lonA, latP, lonP) / EARTH_NM;   // angular
    if (d13 === 0) return 0;
    const t13 = bearingDeg(latA, lonA, latP, lonP) * DEG2RAD;
    const t12 = bearingDeg(latA, lonA, latB, lonB) * DEG2RAD;
    return Math.asin(Math.sin(d13) * Math.sin(t13 - t12)) * EARTH_NM;
}

/**
 * Great-circle along-track distance from A toward B, in nautical miles: how far
 * along the leg the foot of the perpendicular from P falls. May be negative (P
 * lies behind A) or exceed the leg length (P lies beyond B) — both are useful
 * signals and are NOT clamped here.
 */
export function gcAlongTrackNm(latP, lonP, latA, lonA, latB, lonB) {
    const d13 = haversineNm(latA, lonA, latP, lonP) / EARTH_NM;
    if (d13 === 0) return 0;
    const xt = gcCrossTrackNm(latP, lonP, latA, lonA, latB, lonB) / EARTH_NM;
    // Guard the acos domain: floating point can push the ratio a hair past ±1
    // when P is essentially on the track, which would yield NaN.
    const ratio = Math.cos(d13) / Math.cos(xt);
    const clamped = Math.min(1, Math.max(-1, ratio));
    const along = Math.acos(clamped) * EARTH_NM;
    // acos loses the sign, so recover it: if P is more than 90° of bearing away
    // from the leg direction, the foot of the perpendicular is behind A.
    const t13 = bearingDeg(latA, lonA, latP, lonP);
    const t12 = bearingDeg(latA, lonA, latB, lonB);
    return bearingDeltaDeg(t13, t12) > 90 ? -along : along;
}

/** Point at fraction f (0-1) along the great circle A→B. Used for tessellation. */
export function gcInterpolate(latA, lonA, latB, lonB, f) {
    const p1 = latA * DEG2RAD, l1 = lonA * DEG2RAD;
    const p2 = latB * DEG2RAD, l2 = lonB * DEG2RAD;
    const d = haversineNm(latA, lonA, latB, lonB) / EARTH_NM;
    if (d < 1e-12) return { lat: latA, lon: lonA };

    const a = Math.sin((1 - f) * d) / Math.sin(d);
    const b = Math.sin(f * d) / Math.sin(d);
    const x = a * Math.cos(p1) * Math.cos(l1) + b * Math.cos(p2) * Math.cos(l2);
    const y = a * Math.cos(p1) * Math.sin(l1) + b * Math.cos(p2) * Math.sin(l2);
    const z = a * Math.sin(p1) + b * Math.sin(p2);

    return {
        lat: Math.atan2(z, Math.sqrt(x * x + y * y)) * RAD2DEG,
        lon: Math.atan2(y, x) * RAD2DEG,
    };
}

// ── Rhumb cross-track / along-track ──────────────────────────────────────────
// There is no neat closed form for perpendicular distance to a rhumb line on a
// sphere, but there IS one in the Mercator plane: a rhumb line is straight
// there, so the problem reduces to point-to-line-segment in (λ, ψ) coordinates.
// The result is then scaled back to nautical miles at the latitude of the foot
// of the perpendicular, where the local Mercator scale factor is sec(φ).
//
// Accuracy: exact for the along-track component, and within ~0.1% for
// cross-track at the distances that matter here (XTD corridors are 0.1-2 nm,
// where the latitude scale factor is effectively constant across the offset).

function rhumbProject(latP, lonP, latA, lonA, latB, lonB) {
    const psiP = mercatorPhi(latP * DEG2RAD);
    const psiA = mercatorPhi(latA * DEG2RAD);
    const psiB = mercatorPhi(latB * DEG2RAD);

    // Work in a longitude frame centred on A so an antimeridian crossing is a
    // small number rather than a ~360° jump.
    const lamP = wrapPi((lonP - lonA) * DEG2RAD);
    const lamB = wrapPi((lonB - lonA) * DEG2RAD);
    const lamA = 0;

    const vx = lamB - lamA, vy = psiB - psiA;
    const wx = lamP - lamA, wy = psiP - psiA;

    const vv = vx * vx + vy * vy;
    if (vv < 1e-24) {
        // Degenerate leg (A and B coincident) — no axis to measure against.
        return { t: 0, crossRad: Math.sqrt(wx * wx + wy * wy), footLatRad: latA * DEG2RAD, sign: 1 };
    }

    const t = (wx * vx + wy * vy) / vv;          // 0 at A, 1 at B; unclamped

    // 2D cross product v × w, in the Mercator plane with east = +x, north = +y.
    // Positive means P lies to the LEFT of A→B — port. Starboard is negative of
    // that, and our convention is starboard-positive, so the sign flips.
    // Sanity check the branch: eastbound leg v = (+1, 0), P to the north
    // w = (0, +1) ⇒ crossLeft = +1 ⇒ port ⇒ negative. That is the test
    // "a point north of an eastbound leg is to PORT".
    const crossLeft = (vx * wy - vy * wx) / Math.sqrt(vv);
    const sign = crossLeft > 0 ? -1 : 1;
    const crossRaw = crossLeft;

    const footPsi = psiA + t * vy;
    // Invert the Mercator ordinate back to a latitude (the Gudermannian).
    const footLatRad = 2 * Math.atan(Math.exp(footPsi)) - Math.PI / 2;

    return { t, crossRad: Math.abs(crossRaw), footLatRad, sign };
}

/** Signed rhumb-line cross-track distance in nm. Positive = starboard of A→B. */
export function rhumbCrossTrackNm(latP, lonP, latA, lonA, latB, lonB) {
    const { crossRad, footLatRad, sign } = rhumbProject(latP, lonP, latA, lonA, latB, lonB);
    // Mercator distances are inflated by sec(φ); divide it back out.
    const scale = Math.cos(footLatRad);
    return sign * crossRad * scale * EARTH_NM;
}

/** Rhumb-line along-track distance from A, in nm. Unclamped, may be negative. */
export function rhumbAlongTrackNm(latP, lonP, latA, lonA, latB, lonB) {
    const { t } = rhumbProject(latP, lonP, latA, lonA, latB, lonB);
    return t * rhumbDistanceNm(latA, lonA, latB, lonB);
}

// ── Geometry-aware dispatch ──────────────────────────────────────────────────

/** True if the leg's declared geometry is a great circle. Default is rhumb. */
function isOrthodrome(geometryType) {
    return String(geometryType || '').toLowerCase() === 'orthodrome';
}

/** Leg length honouring geometryType. */
export function legLengthNm(latA, lonA, latB, lonB, geometryType) {
    return isOrthodrome(geometryType)
        ? gcDistanceNm(latA, lonA, latB, lonB)
        : rhumbDistanceNm(latA, lonA, latB, lonB);
}

/** Signed cross-track honouring geometryType. Positive = starboard. */
export function crossTrackNm(latP, lonP, latA, lonA, latB, lonB, geometryType) {
    return isOrthodrome(geometryType)
        ? gcCrossTrackNm(latP, lonP, latA, lonA, latB, lonB)
        : rhumbCrossTrackNm(latP, lonP, latA, lonA, latB, lonB);
}

/** Along-track from A honouring geometryType. Unclamped. */
export function alongTrackNm(latP, lonP, latA, lonA, latB, lonB, geometryType) {
    return isOrthodrome(geometryType)
        ? gcAlongTrackNm(latP, lonP, latA, lonA, latB, lonB)
        : rhumbAlongTrackNm(latP, lonP, latA, lonA, latB, lonB);
}

/**
 * Tessellate a leg into a lon/lat polyline for rendering.
 *
 * A loxodrome is a STRAIGHT LINE in Mercator, and Vanguard1's lonLatToScene() is
 * a Mercator projection — so a rhumb leg needs exactly two points and no
 * subdivision at all. Only orthodromes curve in scene space. This is the reason
 * routeLayer can draw a long ocean route at essentially zero vertex cost.
 */
export function tessellateLeg(latA, lonA, latB, lonB, geometryType, maxSegNm = 25) {
    if (!isOrthodrome(geometryType)) return [{ lat: latA, lon: lonA }, { lat: latB, lon: lonB }];

    const total = gcDistanceNm(latA, lonA, latB, lonB);
    const steps = Math.max(1, Math.ceil(total / Math.max(1, maxSegNm)));
    const pts = [];
    for (let i = 0; i <= steps; i++) pts.push(gcInterpolate(latA, lonA, latB, lonB, i / steps));
    return pts;
}

// ── Route-level projection ───────────────────────────────────────────────────

/**
 * Per-leg measurement of a vessel against one leg of a plan.
 * `wpFrom` / `wpTo` are canonical Waypoint objects; the leg's geometry comes
 * from `wpTo.leg` because RTZ attaches a leg to the waypoint it leads INTO.
 */
export function measureLeg(lat, lon, wpFrom, wpTo) {
    const geom = wpTo?.leg?.geometryType;
    const len = legLengthNm(wpFrom.lat, wpFrom.lon, wpTo.lat, wpTo.lon, geom);
    const xt = crossTrackNm(lat, lon, wpFrom.lat, wpFrom.lon, wpTo.lat, wpTo.lon, geom);
    const at = alongTrackNm(lat, lon, wpFrom.lat, wpFrom.lon, wpTo.lat, wpTo.lon, geom);
    return {
        legLengthNm: len,
        crossTrackNm: xt,
        alongTrackNm: at,
        // Fraction along the leg. Outside [0,1] means the perpendicular foot
        // falls off the end of the segment — reported, not clamped.
        fraction: len > 0 ? at / len : 0,
        remainingNm: len - at,
    };
}

/**
 * Project a vessel position onto a whole route.
 *
 * LEG ASSIGNMENT IS BY PROGRESSION, NOT BY NEAREST LEG. A route that doubles
 * back on itself — a survey pattern, a river hairpin, a holding circuit — has
 * two legs geometrically close to the same point, and "nearest" will flip
 * between them and generate phantom deviations. So: start from the leg the
 * vessel was on last tick (`hintLegIndex`), advance while the perpendicular foot
 * has run past the end of the leg, and only fall back to a global search when
 * the vessel is not plausibly on the hinted leg at all.
 *
 * Returns null-ish fields rather than guesses when the plan has fewer than two
 * waypoints — there is no route axis to measure against.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {{waypoints: Array}} plan  canonical VoyagePlan
 * @param {number|null} hintLegIndex index of the leg believed current (0 = wp0→wp1)
 * @param {number} corridorNm        how far off-axis still counts as "on this leg"
 */
export function projectOntoRoute(lat, lon, plan, hintLegIndex = null, corridorNm = 5) {
    const wps = plan?.waypoints ?? [];
    const legCount = wps.length - 1;
    if (legCount < 1) {
        return {
            legIndex: null, crossTrackNm: null, alongTrackNm: null,
            distanceToNextWpNm: null, distanceToEndNm: null,
            fraction: null, snapLat: null, snapLon: null, method: 'no-route',
        };
    }

    const measureAt = (i) => measureLeg(lat, lon, wps[i], wps[i + 1]);

    let idx = null;
    let m = null;
    let method = 'progression';

    if (hintLegIndex != null && hintLegIndex >= 0 && hintLegIndex < legCount) {
        idx = hintLegIndex;
        m = measureAt(idx);
        // Walk forward while the foot of the perpendicular is past this leg's
        // end. Bounded by legCount so a bad hint can never spin.
        let guard = 0;
        while (m.fraction > 1 && idx < legCount - 1 && guard++ < legCount) {
            idx += 1;
            m = measureAt(idx);
        }
        // Walk back one leg if the ship is behind the start of the hinted leg —
        // one step only. Deeper backtracking means the hint is wrong, not that
        // the ship reversed, and the global search below handles that better.
        if (m.fraction < 0 && idx > 0) {
            const back = measureAt(idx - 1);
            if (back.fraction <= 1) { idx -= 1; m = back; }
        }
        // Hint rejected: too far off-axis, or still off the end of the route.
        if (Math.abs(m.crossTrackNm) > corridorNm || m.fraction > 1 || m.fraction < 0) {
            idx = null; m = null;
        }
    }

    if (idx == null) {
        // Global fallback. Prefer legs whose perpendicular foot actually lands
        // ON the segment; only if none do, fall back to raw proximity — that is
        // the "ship is off the end of the route" case and it must still return
        // something rather than null.
        method = 'search';
        let bestOn = null, bestOnI = -1, bestAny = null, bestAnyI = -1;
        for (let i = 0; i < legCount; i++) {
            const c = measureAt(i);
            const absXt = Math.abs(c.crossTrackNm);
            if (c.fraction >= 0 && c.fraction <= 1) {
                if (bestOn == null || absXt < Math.abs(bestOn.crossTrackNm)) { bestOn = c; bestOnI = i; }
            }
            const endDist = Math.min(
                haversineNm(lat, lon, wps[i].lat, wps[i].lon),
                haversineNm(lat, lon, wps[i + 1].lat, wps[i + 1].lon));
            if (bestAny == null || endDist < bestAny._d) { bestAny = { ...c, _d: endDist }; bestAnyI = i; }
        }
        if (bestOn) { m = bestOn; idx = bestOnI; }
        else        { m = bestAny; idx = bestAnyI; method = 'off-route'; }
    }

    // Distance still to run to the end of the route, following the route.
    let toEnd = Math.max(0, m.remainingNm);
    for (let i = idx + 1; i < legCount; i++) {
        toEnd += legLengthNm(wps[i].lat, wps[i].lon, wps[i + 1].lat, wps[i + 1].lon,
                             wps[i + 1]?.leg?.geometryType);
    }

    // Foot of the perpendicular, for drawing the "you are here on the plan" tick.
    const geom = wps[idx + 1]?.leg?.geometryType;
    const f = Math.min(1, Math.max(0, m.fraction));
    const snap = isOrthodrome(geom)
        ? gcInterpolate(wps[idx].lat, wps[idx].lon, wps[idx + 1].lat, wps[idx + 1].lon, f)
        : rhumbDestination(wps[idx].lat, wps[idx].lon,
                           rhumbBearingDeg(wps[idx].lat, wps[idx].lon, wps[idx + 1].lat, wps[idx + 1].lon),
                           f * m.legLengthNm);

    return {
        legIndex: idx,
        fromWaypointId: wps[idx].id,
        toWaypointId: wps[idx + 1].id,
        crossTrackNm: m.crossTrackNm,
        alongTrackNm: m.alongTrackNm,
        legLengthNm: m.legLengthNm,
        fraction: m.fraction,
        distanceToNextWpNm: Math.max(0, m.remainingNm),
        distanceToEndNm: toEnd,
        snapLat: snap.lat,
        snapLon: snap.lon,
        method,
    };
}

// ── Debug handle (Tier 3 — DevTools only, never the data path) ───────────────
if (typeof window !== 'undefined') {
    window.vg1RouteGeom = {
        rhumbDistanceNm, rhumbBearingDeg, rhumbDestination,
        gcDistanceNm, gcBearingDeg, gcCrossTrackNm, gcAlongTrackNm, gcInterpolate,
        rhumbCrossTrackNm, rhumbAlongTrackNm,
        crossTrackNm, alongTrackNm, legLengthNm, tessellateLeg,
        measureLeg, projectOntoRoute,
    };
}
