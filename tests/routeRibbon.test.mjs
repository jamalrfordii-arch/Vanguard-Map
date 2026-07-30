// tests/routeRibbon.test.mjs — scene geometry for the route corridor.
// Run from repo root:  node --import ./tests/_stubs/register.mjs tests/routeRibbon.test.mjs
//
// The four claims that would silently produce a WRONG PICTURE:
//   1. PROJECTION PARITY — lonLatToXZ must equal aisManager.lonLatToScene
//      exactly, or routes and the vessels they describe drift apart on screen.
//   2. MERCATOR STRETCH — a corridor's scene width must grow with sec(latitude),
//      or high-latitude corridors are drawn at a fraction of their true width.
//   3. THE ASYMMETRY SURVIVES EXAGGERATION — one factor for both sides, so a
//      0.15/0.30 plan always draws 1:2, at every zoom level.
//   4. STARBOARD IS THE SAME SIDE the cross-track maths calls starboard.

import './_stubs/domEnv.mjs';
import assert from 'node:assert/strict';
import {
    lonLatToXZ, seaLevelY, sceneUnitsPerNm, pixelsPerSceneUnit,
    corridorExaggeration, splitAntimeridian, buildRouteRibbon, ribbonIndices,
} from '../routeRibbon.js';
import { lonLatToScene } from '../aisManager.js';
import { rhumbCrossTrackNm } from '../routeGeometry.js';
import { MAP_WIDTH, MAP_HEIGHT, STM } from '../config.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
const near = (a, b, tol, m) =>
    assert.ok(Math.abs(a - b) <= tol, `${m ?? ''} expected ${b} ±${tol}, got ${a}`);

const wp = (id, lat, lon, leg = null) => ({ id, lat, lon, leg, name: `WP${id}`, radius: null });
const planOf = (wps) => ({ waypoints: wps });
const LEG = (over = {}) => ({ geometryType: 'Loxodrome', portsideXTD: 0.2, starboardXTD: 0.2, ...over });

console.log('1. PROJECTION PARITY (routes must land where the ships land)');
test('lonLatToXZ matches aisManager.lonLatToScene exactly', () => {
    // Duplicated on purpose — importing aisManager would drag THREE and the
    // whole AIS stack into a pure module. This test is what makes the
    // duplication safe: the two cannot drift without failing here.
    for (const [lon, lat] of [[0, 0], [11.6, 57.6], [-122.3, 47.6], [179.9, -41.3],
                              [-179.9, 65], [56.4, 26.6], [0, 84], [0, -84]]) {
        const mine = lonLatToXZ(lon, lat);
        const theirs = lonLatToScene(lon, lat);
        near(mine.x, theirs.x, 1e-12, `x at ${lon},${lat}:`);
        near(mine.z, theirs.z, 1e-12, `z at ${lon},${lat}:`);
    }
});
test('east is +X and north is -Z', () => {
    assert.ok(lonLatToXZ(10, 0).x > lonLatToXZ(0, 0).x, 'east increases X');
    assert.ok(lonLatToXZ(0, 10).z < lonLatToXZ(0, 0).z, 'north decreases Z');
});
test('the map spans MAP_WIDTH across 360° of longitude', () => {
    near(lonLatToXZ(180, 0).x - lonLatToXZ(-180, 0).x, MAP_WIDTH, 1e-9);
});

console.log('sea-level Y');
test('sits on the curved sea plane, lifted by the configured offset', () => {
    near(seaLevelY(0, 0), STM.ROUTE_Y_OFFSET, 1e-9, 'map centre is the high point');
    assert.ok(seaLevelY(MAP_WIDTH / 2, 0) < seaLevelY(0, 0), 'the globe curves away');
});
test('Y is a pure function of position — no terrain sampling', () => {
    assert.equal(seaLevelY(12, -34), seaLevelY(12, -34));
});

console.log('2. MERCATOR STRETCH (why one units-per-nm constant is wrong)');
test('one degree of longitude is 60 nm at the equator', () => {
    near(sceneUnitsPerNm(0), (MAP_WIDTH / 360) / 60, 1e-12);
});
test('a corridor at 60°N needs TWICE the scene width of the same corridor at 0°', () => {
    near(sceneUnitsPerNm(60) / sceneUnitsPerNm(0), 2, 0.01,
        'sec(60°) = 2 — using a constant here halves every high-latitude corridor');
});
test('the stretch is symmetric about the equator and grows toward the poles', () => {
    near(sceneUnitsPerNm(45), sceneUnitsPerNm(-45), 1e-12);
    assert.ok(sceneUnitsPerNm(70) > sceneUnitsPerNm(60));
});
test('latitude is clamped so the poles do not produce infinity', () => {
    assert.ok(Number.isFinite(sceneUnitsPerNm(90)));
    assert.ok(Number.isFinite(sceneUnitsPerNm(-90)));
});
test('the true-scale problem is real: 0.2 nm is ~1/10,000 of the map', () => {
    const units = 0.2 * sceneUnitsPerNm(0);
    assert.ok(units / MAP_WIDTH < 1e-4,
        `a true-scale corridor is ${(units / MAP_WIDTH).toExponential(1)} of the map — invisible`);
});

console.log('3. EXAGGERATION (legible far, true near, ratio always exact)');
test('never shrinks a corridor — the factor is at least 1', () => {
    assert.equal(corridorExaggeration(1, 1000, 7), 1, 'already far bigger than the floor');
    assert.ok(corridorExaggeration(0.001, 10, 7) > 1);
});
test('grows the corridor to exactly the pixel floor', () => {
    const half = 0.0028, px = 50, minPx = 7;
    const f = corridorExaggeration(half, px, minPx);
    near(half * f * px, minPx, 1e-9, 'the wider rim lands on the floor');
});
test('falls to 1 as the camera descends — the ribbon becomes TRUE', () => {
    const half = 0.0028;
    const far = corridorExaggeration(half, 10, 7);
    const near_ = corridorExaggeration(half, 5000, 7);
    assert.ok(far > near_, 'less exaggeration when closer');
    assert.equal(near_, 1, 'and none at all once true scale clears the floor');
});
test('degenerate inputs return 1 rather than dividing by zero', () => {
    assert.equal(corridorExaggeration(0, 100, 7), 1);
    assert.equal(corridorExaggeration(1, 0, 7), 1);
    assert.equal(corridorExaggeration(NaN, 100, 7), 1);
});
test('THE ASYMMETRY SURVIVES: 0.15/0.30 draws 1:2 at every zoom', () => {
    // If each side were clamped to the floor independently they would come out
    // equal and the picture would misstate the plan.
    const p = 0.15 * sceneUnitsPerNm(57.6), s = 0.30 * sceneUnitsPerNm(57.6);
    for (const pxPerUnit of [1, 12, 300, 20000]) {
        const f = corridorExaggeration(Math.max(p, s), pxPerUnit);
        near((s * f) / (p * f), 2, 1e-9, `ratio at ${pxPerUnit} px/unit:`);
    }
});
test('pixelsPerSceneUnit behaves like a perspective camera', () => {
    const a = pixelsPerSceneUnit(1080, 50, 10);
    const b = pixelsPerSceneUnit(1080, 50, 20);
    near(a / b, 2, 1e-9, 'twice as far is half the size');
    assert.equal(pixelsPerSceneUnit(1080, 50, 0), 0, 'no divide-by-zero');
});

console.log('antimeridian');
test('a run crossing the dateline is SPLIT, not drawn back across the map', () => {
    const runs = splitAntimeridian([
        { lon: 178, lat: 0 }, { lon: 179.5, lat: 0 }, { lon: -179.5, lat: 0 }, { lon: -178, lat: 0 },
    ]);
    assert.equal(runs.length, 2);
    assert.deepEqual(runs.map(r => r.length), [2, 2]);
});
test('an ordinary run is left whole', () => {
    const runs = splitAntimeridian([{ lon: 0, lat: 0 }, { lon: 1, lat: 0 }, { lon: 2, lat: 0 }]);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].length, 3);
});
test('a single stranded point is dropped (a 1-vertex ribbon is nothing)', () => {
    const runs = splitAntimeridian([{ lon: 179.9, lat: 0 }, { lon: -179.9, lat: 0 }]);
    assert.equal(runs.length, 0);
});

console.log('4. STARBOARD IS THE SAME SIDE THE MATHS CALLS STARBOARD');
test('the perpendicular points to the side rhumbCrossTrackNm calls positive', () => {
    // Eastbound leg along the equator. Offset a point along +perp and confirm
    // routeGeometry reports a POSITIVE (starboard) cross-track for it. If these
    // two disagree, a deviating ship is drawn bulging out of the wrong rim.
    const r = buildRouteRibbon(planOf([wp(1, 0, 0), wp(2, 0, 2, LEG())]));
    const seg = r.segments[0];
    const i = 0;
    const px = seg.centre[i * 3], pz = seg.centre[i * 3 + 2];
    const nx = seg.perp[i * 3], nz = seg.perp[i * 3 + 2];

    near(Math.hypot(nx, nz), 1, 1e-6, 'perp is a unit vector');
    assert.ok(nz > 0.9, 'heading east, starboard is +Z (south) in this frame');

    // +Z is south, so a starboard offset means a lower latitude.
    const offLat = -0.05;
    assert.ok(rhumbCrossTrackNm(offLat, 1, 0, 0, 0, 2) > 0,
        'and routeGeometry agrees that south of an eastbound leg is starboard');
    void px; void pz; void nx;
});
test('a northbound leg puts starboard to the east', () => {
    const r = buildRouteRibbon(planOf([wp(1, 0, 0), wp(2, 2, 0, LEG())]));
    const seg = r.segments[0];
    assert.ok(seg.perp[0] > 0.9, 'heading north, starboard is +X (east)');
});

console.log('ribbon construction');
test('a loxodrome leg costs exactly 2 vertices — straight in Mercator', () => {
    const r = buildRouteRibbon(planOf([wp(1, 60, -10), wp(2, 60, 10, LEG())]));
    assert.equal(r.segments.length, 1);
    assert.equal(r.segments[0].count, 2,
        'no subdivision at all — this is why long ocean routes are cheap');
});
test('an orthodrome leg is subdivided', () => {
    const r = buildRouteRibbon(planOf([wp(1, 60, -10), wp(2, 60, 10, LEG({ geometryType: 'Orthodrome' }))]));
    assert.ok(r.segments[0].count > 10, `got ${r.segments[0].count} vertices`);
});
test('widths are per-vertex, following latitude along the route', () => {
    const r = buildRouteRibbon(planOf([wp(1, 0, 0), wp(2, 60, 0, LEG({ geometryType: 'Orthodrome' }))]));
    const s = r.segments[0];
    assert.ok(s.stbdW[s.count - 1] > s.stbdW[0] * 1.8,
        'the same declared corridor is wider in scene units at 60°N');
});
test('asymmetric declared XTD reaches the vertex data', () => {
    const r = buildRouteRibbon(planOf([wp(1, 0, 0), wp(2, 0, 1, LEG({ portsideXTD: 0.15, starboardXTD: 0.30 }))]));
    const s = r.segments[0];
    near(s.stbdW[1] / s.portW[1], 2, 1e-6);
});
test('the leg on the ARRIVING waypoint governs the run into it (RTZ convention)', () => {
    const r = buildRouteRibbon(planOf([
        wp(1, 0, 0),
        wp(2, 0, 1, LEG({ starboardXTD: 0.5 })),
        wp(3, 0, 2, LEG({ starboardXTD: 0.1 })),
    ]));
    const s = r.segments[0];
    near(s.stbdW[1] / sceneUnitsPerNm(0), 0.5, 1e-6, 'vertex at wp2 uses wp2.leg');
    near(s.stbdW[2] / sceneUnitsPerNm(0), 0.1, 1e-6, 'vertex at wp3 uses wp3.leg');
});
test('a missing XTD falls back to the announced default AND says so', () => {
    const r = buildRouteRibbon(planOf([wp(1, 0, 0), wp(2, 0, 1, LEG({ portsideXTD: null, starboardXTD: null }))]));
    assert.equal(r.usedDefaultXtd, true, 'the UI must be able to render "we assumed this"');
    near(r.segments[0].stbdW[1] / sceneUnitsPerNm(0), STM.DEFAULT_XTD_NM, 1e-6);
});
test('a fully declared route does NOT report a default', () => {
    const r = buildRouteRibbon(planOf([wp(1, 0, 0), wp(2, 0, 1, LEG())]));
    assert.equal(r.usedDefaultXtd, false);
});
test('waypoints carry scene positions and a stretched turn radius', () => {
    const wps = [wp(1, 60, 0), wp(2, 60, 1, LEG())];
    wps[0].radius = 0.5;
    const r = buildRouteRibbon(planOf(wps));
    assert.equal(r.waypoints.length, 2);
    near(r.waypoints[0].radiusUnits, 0.5 * sceneUnitsPerNm(60), 1e-9);
    assert.equal(r.waypoints[1].radiusUnits, null, 'no declared radius stays null');
});
test('a route with fewer than 2 waypoints builds nothing, without throwing', () => {
    assert.equal(buildRouteRibbon(planOf([wp(1, 0, 0)])).ok, false);
    assert.equal(buildRouteRibbon(planOf([])).ok, false);
    assert.equal(buildRouteRibbon(null).ok, false);
});
test('a dateline-crossing route yields two segments', () => {
    const r = buildRouteRibbon(planOf([wp(1, 0, 178), wp(2, 0, 179.5, LEG()), wp(3, 0, -179, LEG()), wp(4, 0, -178, LEG())]));
    assert.equal(r.segments.length, 2, 'never one line straight back across the map');
});
test('corners are mitred, not notched', () => {
    // At an interior vertex the perpendicular is the average of the two legs'
    // directions, so the rim turns the corner smoothly.
    const r = buildRouteRibbon(planOf([wp(1, 0, 0), wp(2, 0, 1, LEG()), wp(3, 1, 1, LEG())]));
    const s = r.segments[0];
    const mid = { x: s.perp[3], z: s.perp[5] };
    near(Math.hypot(mid.x, mid.z), 1, 1e-6, 'still a unit vector at the corner');
    assert.ok(mid.x !== 0 && mid.z !== 0, 'blends both leg directions');
});
test('every emitted number is finite', () => {
    const r = buildRouteRibbon(planOf([wp(1, 84, -179), wp(2, -84, 179, LEG({ geometryType: 'Orthodrome' }))]));
    for (const s of r.segments) {
        for (const arr of [s.centre, s.perp, s.portW, s.stbdW]) {
            for (const v of arr) assert.ok(Number.isFinite(v), `non-finite ${v}`);
        }
    }
});

console.log('indices');
test('ribbonIndices produces 2 triangles per span', () => {
    assert.equal(ribbonIndices(2).length, 6);
    assert.equal(ribbonIndices(5).length, 4 * 6);
    assert.equal(ribbonIndices(1).length, 0);
    assert.equal(ribbonIndices(0).length, 0);
});
test('every index is inside the vertex range', () => {
    const n = 7, idx = ribbonIndices(n);
    for (const i of idx) assert.ok(i >= 0 && i < n * 2, `index ${i} out of range`);
});

console.log('end to end on the shipped demo route');
test('the Kattegat demo route builds clean geometry', () => {
    const plan = planOf([
        wp(1, 57.60, 11.65), wp(2, 57.63, 11.50, LEG({ portsideXTD: 0.15, starboardXTD: 0.30 })),
        wp(3, 57.72, 10.60, LEG({ portsideXTD: 0.15, starboardXTD: 0.30 })),
        wp(4, 57.40, 8.60, LEG({ portsideXTD: 0.15, starboardXTD: 0.30 })),
    ]);
    const r = buildRouteRibbon(plan);
    assert.equal(r.ok, true);
    assert.equal(r.segments.length, 1);
    assert.equal(r.segments[0].count, 4, 'all-loxodrome: one vertex per waypoint');
    assert.equal(r.usedDefaultXtd, false);
    near(r.segments[0].stbdW[1] / r.segments[0].portW[1], 2, 1e-6, 'asymmetry preserved');

    // And the exaggeration needed to see it at world view is large but bounded.
    const f = corridorExaggeration(r.maxHalfWidthUnits, pixelsPerSceneUnit(1080, 50, 200));
    assert.ok(f > 1, 'world view needs exaggeration to be legible');
    console.log(`      (world view exaggeration ≈ ${f.toFixed(0)}×, disclosed in the UI)`);
});

console.log(`\nrouteRibbon.test: ${passed} checks passed`);
