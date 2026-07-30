// routeRibbon.js — scene geometry for an STM route corridor. Pure math, no THREE.
//
// Turns a canonical VoyagePlan into the vertex data routeLayer.js feeds to the
// GPU: a centreline in scene space, a unit perpendicular per vertex, and the
// TRUE port/starboard corridor half-widths at each point.
//
// Split out from routeLayer per tests/_stubs/three.mjs's own advice — "if a test
// starts needing more of THREE than this covers, that is usually a sign the
// logic should be extracted into a pure module instead." All the arithmetic that
// can be wrong lives here and is testable in plain Node; routeLayer only turns
// these arrays into BufferGeometry.
//
// ── THREE THINGS THAT ARE EASY TO GET WRONG ─────────────────────────────────
//
// 1. MERCATOR IS CONFORMAL, SO ANGLES SURVIVE BUT DISTANCES DO NOT.
//    A perpendicular in lat/lon really is a perpendicular in scene space — that
//    part is free. But the scale is stretched by sec(latitude), so a 0.2 nm
//    corridor occupies nearly twice as many scene units at 60°N as at the
//    equator. Using one constant units-per-nm would draw high-latitude corridors
//    at half their true width.
//
// 2. A TRUE-SCALE CORRIDOR IS INVISIBLE. MAP_WIDTH=300 spans the equatorial
//    circumference, so one scene unit is 72.1 nm and a 0.2 nm corridor is
//    0.0028 units — about a ten-thousandth of the map. This is the same problem
//    vesselScale.js solved for hulls, and it gets the same answer: express the
//    constraint as a pixel floor rather than a magic multiplier.
//
// 3. THE ASYMMETRY CARRIES MEANING. Real routes declare different port and
//    starboard limits (0.15 / 0.30 is typical). If each side were independently
//    clamped to a pixel floor they would come out equal, and the picture would
//    misstate the plan. So ONE exaggeration factor is applied to BOTH sides,
//    chosen from the wider one — the ratio is then exact at every zoom level.
//
// Tests: node tests/routeRibbon.test.mjs

import { MAP_WIDTH, MAP_HEIGHT, STM } from './config.js';

/** Scene units per degree of longitude. */
const X_PER_DEG = MAP_WIDTH / 360;

/** Mercator latitude clamp, matching submarineCables.js/terrainBuilder. */
const LAT_CLAMP = 85;

/**
 * Longitude/latitude → scene XZ.
 *
 * MUST stay bit-identical to aisManager.lonLatToScene, or routes and the vessels
 * they describe drift apart on screen and every corridor lies. There is a parity
 * test asserting exactly that in tests/routeRibbon.test.mjs — it is the reason
 * this is duplicated here rather than imported (importing aisManager would drag
 * THREE and the whole AIS stack into a pure module).
 */
export function lonLatToXZ(lon, lat) {
    const x = (lon / 180) * (MAP_WIDTH / 2);
    const latRad = lat * (Math.PI / 180);
    const mercY = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
    const z = -(mercY / Math.PI) * (MAP_HEIGHT / 2);
    return { x, z };
}

/**
 * Sea-level Y for a scene XZ, reproducing terrainBuilder's globe curvature so a
 * route lies ON the sea plane rather than slicing through it. Pure function of
 * position — no terrain sampling, so a 400-waypoint route costs no samples.
 */
export function seaLevelY(x, z, offset = STM.ROUTE_Y_OFFSET) {
    const dist2 = (x / MAP_WIDTH) ** 2 + (z / MAP_HEIGHT) ** 2;
    return -dist2 * 20.0 + offset;
}

/**
 * Scene units per nautical mile at a given latitude.
 *
 * Mercator's local scale factor is sec(latitude) and, because the projection is
 * conformal, it is the same in every direction at a point — so this single
 * number is correct for a perpendicular offset as well as an along-track one.
 */
export function sceneUnitsPerNm(lat) {
    const clamped = Math.max(-LAT_CLAMP, Math.min(LAT_CLAMP, lat));
    const equatorial = X_PER_DEG / 60;          // 1° lon = 60 nm at the equator
    return equatorial / Math.cos(clamped * Math.PI / 180);
}

/**
 * Pixels per scene unit at `dist` from a perspective camera.
 * Same projection maths as vesselScale.pixelsPerSceneUnit — duplicated rather
 * than imported so this module stays free of that file's ship-specific concerns.
 */
export function pixelsPerSceneUnit(viewportH, fovDeg, dist) {
    if (!(dist > 0) || !(viewportH > 0)) return 0;
    return viewportH / (2 * dist * Math.tan((fovDeg * Math.PI / 180) / 2));
}

/**
 * How much to exaggerate a corridor so the WIDER side reaches `minPx` on screen.
 *
 * Never less than 1 — this only ever grows a corridor, so as the camera descends
 * the factor falls to 1 and the ribbon becomes geometrically true. That is the
 * same guarantee vesselScale makes in reverse (it only ever shrinks a hull).
 *
 * Returns 1 when there is nothing to scale, so callers never divide by zero.
 */
export function corridorExaggeration(maxHalfWidthUnits, pxPerUnit, minPx = STM.CORRIDOR_MIN_PX) {
    if (!(maxHalfWidthUnits > 0) || !(pxPerUnit > 0) || !(minPx > 0)) return 1;
    const px = maxHalfWidthUnits * pxPerUnit;
    return px >= minPx ? 1 : minPx / px;
}

/**
 * Split a lon/lat run wherever it crosses the antimeridian.
 * Without this a route from 179°E to 179°W draws a line straight back across the
 * entire map. Same problem and same fix as submarineCables.splitAntimeridian.
 */
export function splitAntimeridian(points) {
    const runs = [];
    let cur = [];
    for (let i = 0; i < points.length; i++) {
        if (i > 0 && Math.abs(points[i].lon - points[i - 1].lon) > 180) {
            if (cur.length >= 2) runs.push(cur);
            cur = [];
        }
        cur.push(points[i]);
    }
    if (cur.length >= 2) runs.push(cur);
    return runs;
}

/** Unit starboard vector in scene XZ for a heading (dx, dz). */
function starboardXZ(dx, dz) {
    // Scene frame: +X east, +Z south (Mercator puts north at -Z). Viewed from
    // above with north up, rotating the direction of travel 90° clockwise gives
    // (dx, dz) → (-dz, dx). Sanity check: heading east (1, 0) → (0, 1) = south,
    // and south of an eastbound leg is indeed starboard — the same convention
    // routeGeometry.crossTrackNm uses, which is what lets a positive cross-track
    // and the drawn starboard rim mean the same thing.
    const len = Math.hypot(dx, dz);
    if (!(len > 0)) return { x: 0, z: 0 };
    return { x: -dz / len, z: dx / len };
}

/**
 * Densify a leg into lon/lat points.
 *
 * A loxodrome is a STRAIGHT LINE in Mercator and lonLatToXZ is a Mercator
 * projection, so a rhumb leg needs its two endpoints and nothing more — which is
 * why a long ocean route costs almost no vertices here. Only great-circle legs
 * curve in scene space and need subdividing.
 */
function densifyLeg(a, b, geometryType, maxSegNm) {
    if (String(geometryType || '').toLowerCase() !== 'orthodrome') {
        return [{ lon: b.lon, lat: b.lat }];
    }
    // Great-circle interpolation, inline to keep this module dependency-free.
    const D2R = Math.PI / 180, R2D = 180 / Math.PI, EARTH_NM = 3440.065;
    const p1 = a.lat * D2R, l1 = a.lon * D2R, p2 = b.lat * D2R, l2 = b.lon * D2R;
    const dLat = p2 - p1, dLon = l2 - l1;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
    const d = 2 * Math.asin(Math.min(1, Math.sqrt(h)));
    const nm = d * EARTH_NM;
    const steps = Math.max(1, Math.ceil(nm / Math.max(1, maxSegNm)));
    const out = [];
    for (let i = 1; i <= steps; i++) {
        const f = i / steps;
        if (d < 1e-12) { out.push({ lon: b.lon, lat: b.lat }); break; }
        const sa = Math.sin((1 - f) * d) / Math.sin(d);
        const sb = Math.sin(f * d) / Math.sin(d);
        const x = sa * Math.cos(p1) * Math.cos(l1) + sb * Math.cos(p2) * Math.cos(l2);
        const y = sa * Math.cos(p1) * Math.sin(l1) + sb * Math.cos(p2) * Math.sin(l2);
        const z = sa * Math.sin(p1) + sb * Math.sin(p2);
        out.push({
            lat: Math.atan2(z, Math.hypot(x, y)) * R2D,
            lon: Math.atan2(y, x) * R2D,
        });
    }
    return out;
}

/**
 * Build the renderable geometry for one voyage plan.
 *
 * @param {object} plan canonical VoyagePlan
 * @param {object} [opts] { maxSegNm, defaultXtdNm }
 * @returns {{
 *   segments: Array<{count, centre: Float32Array, perp: Float32Array,
 *                    portW: Float32Array, stbdW: Float32Array}>,
 *   waypoints: Array<{x, y, z, id, name, radiusUnits}>,
 *   maxHalfWidthUnits: number,
 *   usedDefaultXtd: boolean,
 *   ok: boolean
 * }}
 *
 * `centre` is xyz per vertex; `perp` is a unit starboard vector per vertex
 * (xyz, y always 0); `portW`/`stbdW` are TRUE half-widths in scene units. The
 * shader computes `centre + perp * width * uExaggeration`, so changing zoom is a
 * uniform write and never a geometry rebuild.
 */
export function buildRouteRibbon(plan, opts = {}) {
    const maxSegNm = opts.maxSegNm ?? STM.ORTHODROME_TESSELLATION_NM;
    const defaultXtd = opts.defaultXtdNm ?? STM.DEFAULT_XTD_NM;

    const wps = plan?.waypoints ?? [];
    const empty = {
        segments: [], waypoints: [], maxHalfWidthUnits: 0,
        usedDefaultXtd: false, ok: false,
    };
    if (wps.length < 2) return empty;

    let usedDefaultXtd = false;

    // Densify into a lon/lat polyline, carrying each point's corridor widths.
    // RTZ attaches a leg to the waypoint it leads INTO, so the leg governing the
    // run from wps[i-1] to wps[i] is wps[i].leg.
    const pts = [{ lon: wps[0].lon, lat: wps[0].lat, leg: wps[1]?.leg ?? null }];
    for (let i = 1; i < wps.length; i++) {
        const leg = wps[i].leg ?? null;
        for (const p of densifyLeg(wps[i - 1], wps[i], leg?.geometryType, maxSegNm)) {
            pts.push({ ...p, leg });
        }
    }

    const segments = [];
    let maxHalfWidthUnits = 0;

    for (const run of splitAntimeridian(pts)) {
        const n = run.length;
        const centre = new Float32Array(n * 3);
        const perp = new Float32Array(n * 3);
        const portW = new Float32Array(n);
        const stbdW = new Float32Array(n);

        const xz = run.map(p => lonLatToXZ(p.lon, p.lat));

        for (let i = 0; i < n; i++) {
            const { x, z } = xz[i];
            const y = seaLevelY(x, z);
            centre[i * 3] = x; centre[i * 3 + 1] = y; centre[i * 3 + 2] = z;

            // Direction of travel: forward difference, backward at the last
            // vertex, averaged in between so a corner produces a mitre rather
            // than a visible notch in the ribbon.
            const prev = xz[Math.max(0, i - 1)];
            const next = xz[Math.min(n - 1, i + 1)];
            const s = starboardXZ(next.x - prev.x, next.z - prev.z);
            perp[i * 3] = s.x; perp[i * 3 + 1] = 0; perp[i * 3 + 2] = s.z;

            // Mercator stretch is per-latitude, so widths are computed per
            // vertex rather than once per route.
            const upn = sceneUnitsPerNm(run[i].lat);
            const leg = run[i].leg;
            let pNm = leg?.portsideXTD, sNm = leg?.starboardXTD;
            if (pNm == null || sNm == null) {
                usedDefaultXtd = true;
                pNm ??= defaultXtd;
                sNm ??= defaultXtd;
            }
            portW[i] = pNm * upn;
            stbdW[i] = sNm * upn;
            maxHalfWidthUnits = Math.max(maxHalfWidthUnits, portW[i], stbdW[i]);
        }

        segments.push({ count: n, centre, perp, portW, stbdW });
    }

    const waypoints = wps.map(w => {
        const { x, z } = lonLatToXZ(w.lon, w.lat);
        return {
            x, y: seaLevelY(x, z), z,
            id: w.id, name: w.name,
            // Turn radius is a real distance too, so it stretches the same way.
            radiusUnits: w.radius != null ? w.radius * sceneUnitsPerNm(w.lat) : null,
        };
    });

    return { segments, waypoints, maxHalfWidthUnits, usedDefaultXtd, ok: segments.length > 0 };
}

/**
 * Triangle indices for a ribbon of `count` centreline vertices.
 * Vertex layout is interleaved rims: 2i = port, 2i+1 = starboard.
 */
export function ribbonIndices(count) {
    if (count < 2) return new Uint32Array(0);
    const idx = new Uint32Array((count - 1) * 6);
    for (let i = 0, o = 0; i < count - 1; i++) {
        const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
        idx[o++] = a; idx[o++] = b; idx[o++] = c;
        idx[o++] = b; idx[o++] = d; idx[o++] = c;
    }
    return idx;
}
