// tests/vesselScale.test.mjs — pin altitude-aware vessel sizing.
// Run from repo root:  node tests/vesselScale.test.mjs
//
// The property that matters most here is NOT "ships get smaller close up" — it's
// "the far view does not change". Vessel scale at world zoom is tuned, load-bearing
// and was never broken; a fix aimed at close zoom that quietly resized the whole
// fleet at altitude would be a bad trade. Several tests below exist only to hold
// that line.

import assert from 'node:assert/strict';
import { vesselRenderScale, vesselMarkerScale, pixelsPerSceneUnit, trueScaleFor, KM_PER_SCENE_UNIT }
    from '../vesselScale.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// Measured live 2026-07-25 — see vesselScale.js header.
const HULL_UNITS = 3.4;
const BASE       = 0.0844;    // median instance scale today
const MIN_PX     = 12;
const VH = 900, FOV = 35;

console.log('projection');

test('pixels per scene unit falls off with distance', () => {
    const near = pixelsPerSceneUnit(VH, FOV, 1.15);
    const far  = pixelsPerSceneUnit(VH, FOV, 200);
    assert.ok(near > far);
    assert.ok(Math.abs(near / far - 200 / 1.15) < 1e-6, 'should be exactly inverse in distance');
});

test('degenerate camera input yields 0, not NaN or Infinity', () => {
    for (const d of [0, -1, NaN]) assert.equal(pixelsPerSceneUnit(VH, FOV, d), 0);
    assert.equal(pixelsPerSceneUnit(0, FOV, 10), 0);
});

test('true scale matches the documented real-world figure', () => {
    // config.js SHIP_RENDER says a real 300m tanker is "roughly 0.002 scene units".
    // That is the length in UNITS, before dividing by the 3.4-unit hull template.
    assert.ok(Math.abs(0.3 / KM_PER_SCENE_UNIT - 0.002246) < 1e-5);
    // And as an instance scale it is far smaller again.
    assert.ok(Math.abs(trueScaleFor(300, HULL_UNITS) - 0.00066) < 1e-4);
});

console.log('the far view must not change');

test('at world zoom the scale is EXACTLY today\'s value', () => {
    const px = pixelsPerSceneUnit(VH, FOV, 200);
    assert.equal(vesselRenderScale(BASE, 200, px, MIN_PX, HULL_UNITS), BASE);
});

test('at regional zoom it is still exactly today\'s value', () => {
    const px = pixelsPerSceneUnit(VH, FOV, 50);
    assert.equal(vesselRenderScale(BASE, 200, px, MIN_PX, HULL_UNITS), BASE);
});

test('never returns MORE than the base scale, at any distance', () => {
    // The pixel floor demands a huge scale when far away; clamping to base is the
    // only thing stopping distant vessels from inflating.
    for (let d = 0.5; d < 500; d *= 1.5) {
        const px = pixelsPerSceneUnit(VH, FOV, d);
        const s = vesselRenderScale(BASE, 200, px, MIN_PX, HULL_UNITS);
        assert.ok(s <= BASE + 1e-12, `inflated to ${s} at distance ${d}`);
    }
});

console.log('the close view must shrink');

test('at max zoom the vessel is dramatically smaller than today', () => {
    const px = pixelsPerSceneUnit(VH, FOV, 1.15);
    const s  = vesselRenderScale(BASE, 200, px, MIN_PX, HULL_UNITS);
    assert.ok(s < BASE / 10, `expected a big reduction, got ${s} vs base ${BASE}`);
});

test('and lands at exactly MIN_PX on screen', () => {
    const dist = 1.15;
    const px = pixelsPerSceneUnit(VH, FOV, dist);
    const s  = vesselRenderScale(BASE, 200, px, MIN_PX, HULL_UNITS);
    const renderedPx = HULL_UNITS * s * px;
    assert.ok(Math.abs(renderedPx - MIN_PX) < 0.01,
        `rendered ${renderedPx.toFixed(2)}px, wanted ${MIN_PX}`);
});

test('scale is monotonic in distance — no popping as you fly in', () => {
    let prev = 0;
    for (let d = 0.6; d < 300; d *= 1.2) {
        const s = vesselRenderScale(BASE, 200, pixelsPerSceneUnit(VH, FOV, d), MIN_PX, HULL_UNITS);
        assert.ok(s >= prev - 1e-12, `scale dipped at distance ${d}: ${s} < ${prev}`);
        prev = s;
    }
});

test('a bigger ship is still bigger at close range — proportions survive', () => {
    // The whole point of the 2026-07-23 true-scale work was honest RELATIVE sizes.
    // A pixel floor could flatten every vessel onto the same size and destroy that,
    // so the floor must only bind where true scale is genuinely too small.
    const px = pixelsPerSceneUnit(VH, FOV, 0.02);   // extremely close
    const small = vesselRenderScale(0.02,  30, px, MIN_PX, HULL_UNITS);
    const big   = vesselRenderScale(0.16, 380, px, MIN_PX, HULL_UNITS);
    assert.ok(big > small, `proportions collapsed: ${big} vs ${small}`);
});

console.log('robustness');

test('missing view info leaves the vessel at its base scale', () => {
    // Off-screen or pre-first-frame. Returning 0 would make the fleet disappear.
    assert.equal(vesselRenderScale(BASE, 200, 0, MIN_PX, HULL_UNITS), BASE);
    assert.equal(vesselRenderScale(BASE, 200, 100, MIN_PX, 0), BASE);
});

test('an unknown hull length still renders — floors, never vanishes', () => {
    const px = pixelsPerSceneUnit(VH, FOV, 1.15);
    for (const L of [0, null, undefined, NaN]) {
        const s = vesselRenderScale(BASE, L, px, MIN_PX, HULL_UNITS);
        assert.ok(s > 0, `length ${L} produced scale ${s}`);
        assert.ok(Number.isFinite(s));
    }
});

test('a zero base scale stays zero — unused instancer slots stay degenerate', () => {
    // shipInstancer degenerate-scales free slots. Reviving one to MIN_PX would
    // scatter phantom vessels across the map.
    assert.equal(vesselRenderScale(0, 200, 1000, MIN_PX, HULL_UNITS), 0);
});

console.log('marker / shadow sprite sizing');

test('close up the marker sits UNDER the ship, not over the whole screen', () => {
    // The reported symptom: fixed scale 5 (~668 km) filling the view at z12.
    const px = pixelsPerSceneUnit(VH, FOV, 0.38);
    const ship = vesselRenderScale(BASE, 200, px, MIN_PX, HULL_UNITS);
    const m = vesselMarkerScale(ship, HULL_UNITS, px);
    assert.ok(m < 0.05, `marker still enormous close up: ${m}`);
    const hullLen = HULL_UNITS * ship;
    assert.ok(m >= hullLen, 'marker should still be at least as big as the hull');
    assert.ok(m <= 6 * hullLen, `marker is ${(m / hullLen).toFixed(1)}x the hull — too dominant`);
});

test('far away it is UNCHANGED from today — the cap binds before the floor', () => {
    // Shrinking proportionally at all zooms would make the fleet unfindable at
    // world view, the opposite failure and just as bad. At 200 units the legacy
    // scale-5 marker is only ~36px, so the pixel floor (40px) would ASK for more
    // than the cap allows — and the cap wins. That is the intended outcome: the
    // far view cannot change. An earlier version of this test asserted >=39px and
    // failed, because it assumed the floor was reachable there; it is not.
    const px = pixelsPerSceneUnit(VH, FOV, 200);
    const ship = vesselRenderScale(BASE, 200, px, MIN_PX, HULL_UNITS);
    assert.equal(vesselMarkerScale(ship, HULL_UNITS, px), 5, 'far view must stay at the legacy size');
});

test('the pixel floor DOES bind at mid zoom, between the two regimes', () => {
    // Otherwise the floor would be dead code and the marker would jump straight
    // from legacy-size to hull-proportional.
    const px = pixelsPerSceneUnit(VH, FOV, 20);
    const ship = vesselRenderScale(BASE, 200, px, MIN_PX, HULL_UNITS);
    const m = vesselMarkerScale(ship, HULL_UNITS, px);
    assert.ok(m < 5 - 1e-9, 'should be below the cap at mid zoom');
    assert.ok(Math.abs(m * px - 40) < 0.5, `floor not binding: ${(m * px).toFixed(1)}px`);
});

test('never exceeds the legacy cap — the far view can only shrink', () => {
    for (let d = 0.3; d < 600; d *= 1.6) {
        const px = pixelsPerSceneUnit(VH, FOV, d);
        const ship = vesselRenderScale(BASE, 200, px, MIN_PX, HULL_UNITS);
        assert.ok(vesselMarkerScale(ship, HULL_UNITS, px) <= 5 + 1e-9, `grew past cap at ${d}`);
    }
});

test('shrinks monotonically as you approach', () => {
    let prev = 0;
    for (let d = 0.3; d < 400; d *= 1.4) {
        const px = pixelsPerSceneUnit(VH, FOV, d);
        const ship = vesselRenderScale(BASE, 200, px, MIN_PX, HULL_UNITS);
        const m = vesselMarkerScale(ship, HULL_UNITS, px);
        assert.ok(m >= prev - 1e-12, `marker grew while approaching at ${d}`);
        prev = m;
    }
});

test('degenerate input falls back to the legacy constant, never to zero', () => {
    // Returning 0 would silently delete every marker on the map.
    for (const bad of [0, -1, NaN, undefined])
        assert.equal(vesselMarkerScale(bad, HULL_UNITS, 1000), 5, `shipScale=${bad}`);
    assert.equal(vesselMarkerScale(0.08, HULL_UNITS, 0), 5, 'no view info');
});

console.log(`\n${passed} passed`);
