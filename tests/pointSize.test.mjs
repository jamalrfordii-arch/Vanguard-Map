// tests/pointSize.test.mjs — pin the deep-level point-size clamp.
// Run from repo root:  node tests/pointSize.test.mjs
//
// Context: ptSize in LOD_LEVELS barely changes down the ladder while tile span
// collapses 128-fold, so point overlap grew to 39x at z12 — each point spanning
// about a third of its own tile. z11 and z12 were fetching 15.5 m and 9.6 m
// imagery and then rendering it through points far too fat to resolve it.
//
// The two properties that matter, and the ones a careless "fix" would break:
//   1. It must SHRINK the deep levels (that is the point).
//   2. It must NOT TOUCH the coarse levels, which are deliberately
//      under-overlapped and hand-tuned. A formula would have inflated z5 ~14x.

import assert from 'node:assert/strict';
import { clampPointSize } from '../tilePointsBuilder.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const MAP_WIDTH = 300;
const gapOf = (z, pts) => (MAP_WIDTH / (2 ** (z + 1))) / Math.sqrt(pts);
const overlapOf = (z, pts, size) => size / gapOf(z, pts);

// Measured live at Tokyo: [zoom, actual points per tile, configured ptSize]
const LIVE = [
    [5,  6913,  0.0196], [6,  9380,  0.0150], [7, 10807, 0.0172], [8, 27437, 0.0169],
    [9, 29207,  0.0138], [10, 34848, 0.0129], [11, 14494, 0.0122], [12, 14802, 0.0117],
];

console.log('the deep levels get corrected');

test('z12 drops from ~39x overlap to the cap', () => {
    const [z, pts, size] = LIVE[7];
    assert.ok(overlapOf(z, pts, size) > 35, 'sanity: the measured problem was ~39x');
    const clamped = clampPointSize(z, pts, size, 6);
    assert.ok(Math.abs(overlapOf(z, pts, clamped) - 6) < 1e-9,
        `z12 still at ${overlapOf(z, pts, clamped).toFixed(1)}x`);
    assert.ok(clamped < size / 6, 'z12 point size should shrink several-fold');
});

test('z10 and z11 are corrected too', () => {
    for (const [z, pts, size] of [LIVE[5], LIVE[6]]) {
        assert.ok(overlapOf(z, pts, size) > 10, `sanity: z${z} was over-overlapped`);
        const c = clampPointSize(z, pts, size, 6);
        assert.ok(overlapOf(z, pts, c) <= 6 + 1e-9, `z${z} not clamped`);
        assert.ok(c < size, `z${z} should have shrunk`);
    }
});

console.log('the tuned levels are left alone');

test('coarse levels are untouched — a formula would have inflated them', () => {
    // z5 sits at 0.3x overlap by design, backstopped by the base splat cloud.
    // Driving it to 6x would mean a point size of ~0.28 instead of 0.0196.
    for (const [z, pts, size] of LIVE.slice(0, 4)) {
        assert.equal(clampPointSize(z, pts, size, 6), size,
            `z${z} must not change (it is at ${overlapOf(z, pts, size).toFixed(1)}x)`);
    }
});

test('clamping NEVER grows a point size, at any input', () => {
    // The load-bearing safety property: it can only ever shrink, so it cannot
    // damage a level that is already correct.
    for (const [z, pts, size] of LIVE)
        for (const cap of [1, 4, 6, 20, 100])
            assert.ok(clampPointSize(z, pts, size, cap) <= size + 1e-12,
                `z${z} grew at cap ${cap}`);
});

test('a level exactly at the cap is left exactly alone', () => {
    const z = 10, pts = 34848;
    const exact = 6 * gapOf(z, pts);
    assert.equal(clampPointSize(z, pts, exact, 6), exact);
});

console.log('uses ACTUAL point count, not the budget');

test('a capped tile is sized from the points it really has', () => {
    // ACTIVE_PTS_CAP (14,000) and ptsBudget (52,000 at z12) disagree. Sizing from
    // the budget would under-size a capped tile by sqrt(52000/14000) ≈ 1.9x and
    // open real holes between points.
    const z = 12;
    const fromBudget = clampPointSize(z, 52000, 0.0117, 6);
    const fromActual = clampPointSize(z, 14000, 0.0117, 6);
    assert.ok(fromActual > fromBudget, 'fewer points must mean LARGER points, not smaller');
    assert.ok(Math.abs(fromActual / fromBudget - Math.sqrt(52000 / 14000)) < 0.01,
        'should scale with 1/sqrt(count)');
});

console.log('robustness');

test('degenerate inputs return the configured size unchanged', () => {
    for (const pts of [0, -1, NaN, Infinity, undefined, null])
        assert.equal(clampPointSize(12, pts, 0.0117, 6), 0.0117, `points=${pts}`);
    for (const cap of [0, -3, NaN])
        assert.equal(clampPointSize(12, 14000, 0.0117, cap), 0.0117, `cap=${cap}`);
    for (const size of [0, -1, undefined])
        assert.equal(clampPointSize(12, 14000, size, 6), size, `size=${size}`);
});

test('result is always finite and positive for sane inputs', () => {
    for (const [z, pts, size] of LIVE) {
        const c = clampPointSize(z, pts, size, 6);
        assert.ok(Number.isFinite(c) && c > 0, `z${z} produced ${c}`);
    }
});

console.log(`\n${passed} passed`);
