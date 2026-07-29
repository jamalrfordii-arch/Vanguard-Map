// tests/terrainHeight.test.mjs — pin the shared elevation transform.
// Run from repo root:  node tests/terrainHeight.test.mjs
//
// The map draws land TWICE (base splat cloud + streamed tiles) and the two
// transforms silently disagreed by ~3x for months, which put the base cloud's
// "backstop" points ABOVE the tile surface they were meant to sit behind. The
// tests that matter here are therefore about AGREEMENT: whichever mode is active,
// the two surfaces must produce identical heights. LEGACY is the historical split
// and is kept only as an escape hatch — the tests below pin its exact old maths so
// it stays a faithful rollback, and separately prove it can't be reached by typo.

import assert from 'node:assert/strict';
import { TERRAIN_MODE, formulaFor, landElevToUnits, elevToSceneY, resolveMode, DEFAULT_MODE }
    from '../terrainHeight.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const V = 0.20;   // TERRAIN_VERTICAL_SCALE
const ELEVS = [1, 14, 15, 100, 500, 1000, 2000, 3000, 5000, 8848];

console.log('legacy mode reproduces today exactly');

test('LEGACY keeps base and tiles on their historical, DIFFERENT formulas', () => {
    assert.equal(formulaFor('base',  TERRAIN_MODE.LEGACY), 'tall');
    assert.equal(formulaFor('tiles', TERRAIN_MODE.LEGACY), 'flat');
});

test('LEGACY base matches the old terrainWorker maths exactly', () => {
    for (const h of ELEVS) {
        const highBlend = Math.min(1, Math.max(0, (h - 2000) / 2000));
        let expected = h / (650 + highBlend * 450);
        if (h < 15) expected *= h / 15;
        const got = elevToSceneY(h, V, 'base', TERRAIN_MODE.LEGACY) / V;
        assert.ok(Math.abs(got - expected) < 1e-9, `${h}m: ${got} vs ${expected}`);
    }
});

test('LEGACY tiles match the old tilePointsBuilder maths exactly', () => {
    for (const h of ELEVS) {
        let expected = h / 2000;
        if (h < 15) expected *= h / 15;
        const got = elevToSceneY(h, V, 'tiles', TERRAIN_MODE.LEGACY) / V;
        assert.ok(Math.abs(got - expected) < 1e-9, `${h}m: ${got} vs ${expected}`);
    }
});

test('LEGACY still reproduces the ~3x disagreement — it is a faithful rollback', () => {
    // Deliberately asserts the DEFECT rather than asserting it away. LEGACY exists
    // to restore the old behaviour exactly, warts included; if this ever stops
    // failing to agree, LEGACY has silently stopped being a true rollback.
    const base  = elevToSceneY(1000, V, 'base',  TERRAIN_MODE.LEGACY);
    const tiles = elevToSceneY(1000, V, 'tiles', TERRAIN_MODE.LEGACY);
    assert.ok(Math.abs(base / tiles - 2000 / 650) < 1e-6,
        `expected a ~3.08x gap, got ${(base / tiles).toFixed(3)}x`);
    assert.ok(Math.abs((base - tiles) - 0.2077) < 1e-3,
        'the 1000m gap should be ~0.208 scene units');
});

console.log('unified modes actually agree');

test('TALL: base and tiles produce IDENTICAL heights at every elevation', () => {
    for (const h of ELEVS) {
        assert.equal(elevToSceneY(h, V, 'base', TERRAIN_MODE.TALL),
                     elevToSceneY(h, V, 'tiles', TERRAIN_MODE.TALL), `disagreed at ${h}m`);
    }
});

test('FLAT: base and tiles produce IDENTICAL heights at every elevation', () => {
    for (const h of ELEVS) {
        assert.equal(elevToSceneY(h, V, 'base', TERRAIN_MODE.FLAT),
                     elevToSceneY(h, V, 'tiles', TERRAIN_MODE.FLAT), `disagreed at ${h}m`);
    }
});

test('TALL leaves the BASE CLOUD untouched — the world view must not move', () => {
    for (const h of ELEVS) {
        assert.equal(elevToSceneY(h, V, 'base', TERRAIN_MODE.TALL),
                     elevToSceneY(h, V, 'base', TERRAIN_MODE.LEGACY), `base moved at ${h}m`);
    }
});

test('FLAT leaves the TILES untouched — the close view must not move', () => {
    for (const h of ELEVS) {
        assert.equal(elevToSceneY(h, V, 'tiles', TERRAIN_MODE.FLAT),
                     elevToSceneY(h, V, 'tiles', TERRAIN_MODE.LEGACY), `tiles moved at ${h}m`);
    }
});

test('TALL raises tiles ~3x, FLAT drops the base ~3x — each moves ONE surface', () => {
    const h = 1000;
    const tilesLegacy = elevToSceneY(h, V, 'tiles', TERRAIN_MODE.LEGACY);
    const tilesTall   = elevToSceneY(h, V, 'tiles', TERRAIN_MODE.TALL);
    assert.ok(tilesTall / tilesLegacy > 3, 'TALL should lift tiles ~3x');
    const baseLegacy = elevToSceneY(h, V, 'base', TERRAIN_MODE.LEGACY);
    const baseFlat   = elevToSceneY(h, V, 'base', TERRAIN_MODE.FLAT);
    assert.ok(baseLegacy / baseFlat > 3, 'FLAT should drop the base ~3x');
});

console.log('shape');

test('ocean is flat zero in every mode — the sea plane owns that band', () => {
    for (const m of Object.values(TERRAIN_MODE))
        for (const c of ['base', 'tiles'])
            for (const h of [-8000, -1, 0])
                assert.equal(elevToSceneY(h, V, c, m), 0, `${c}/${m} at ${h}m`);
});

test('monotonic and finite everywhere', () => {
    for (const f of ['tall', 'flat']) {
        let prev = -Infinity;
        for (const h of [0, 0.5, 1, 14.9, 15, 15.1, 100, 2000, 4000, 8848, 20000]) {
            const y = landElevToUnits(h, f);
            assert.ok(Number.isFinite(y), `${f} at ${h}m → ${y}`);
            assert.ok(y >= prev, `${f} not monotonic at ${h}m`);
            prev = y;
        }
    }
});

test('shoreline taper joins the ramp continuously in both formulas', () => {
    // The taper multiplier is exactly 1.0 at h=15, so the two branches meet with
    // no step. Probe with a tiny epsilon in h — sampling at +/-0.002 measures the
    // ramp's own slope, not a discontinuity, which is what a first version of this
    // test mistook for a failure.
    const EPS = 1e-6;
    for (const f of ['tall', 'flat']) {
        const divisor = f === 'tall' ? 650 : 2000;
        // The real continuity assertion: the taper multiplier reaches EXACTLY 1.0
        // at h=15, so the tapered branch lands precisely on the linear ramp.
        assert.equal(landElevToUnits(15, f), 15 / divisor,
            `${f} taper does not reach exactly 1.0 at the join`);
        // Crossing the join changes the value by no more than the ramp's own slope
        // over 2*EPS. Bounding it by the slope (rather than an arbitrary epsilon)
        // is what makes this a discontinuity test instead of a precision test — an
        // earlier version used a flat 1e-9 and failed on the derivative.
        const maxByslope = 2 * EPS / divisor * 1.5;   // 1.5x headroom
        const step = Math.abs(landElevToUnits(15 + EPS, f) - landElevToUnits(15 - EPS, f));
        assert.ok(step < maxByslope,
            `${f} steps at the 15m shoreline join: ${step} exceeds slope bound ${maxByslope}`);
    }
});

test('the high-elevation taper only affects the TALL formula', () => {
    // 650→1100 above 2000m keeps peaks from running away. FLAT is linear, so a
    // taper leaking into it would silently change every mountain tile.
    assert.equal(landElevToUnits(8000, 'flat'), 8000 / 2000);
    assert.ok(landElevToUnits(8000, 'tall') < 8000 / 650, 'tall should taper high peaks');
});

console.log('mode resolution');

test('unknown or missing stored modes fall back to the DEFAULT, which is FLAT', () => {
    assert.equal(DEFAULT_MODE, TERRAIN_MODE.FLAT, 'decided 2026-07-25');
    for (const v of [undefined, null, '', 'nonsense', 'TALL', 42])
        assert.equal(resolveMode(v), DEFAULT_MODE, `${v} should resolve to the default`);
});

test('all three modes are honoured when named explicitly', () => {
    for (const m of Object.values(TERRAIN_MODE))
        assert.equal(resolveMode(m), m, `${m} should be selectable`);
});

test('LEGACY is never reached by accident — only by explicitly asking', () => {
    // It is the one mode where the base cloud and tiles disagree, i.e. the only one
    // that still has the floating-dots defect. Falling back to it on a typo would
    // silently reintroduce the bug this module exists to fix.
    for (const v of [undefined, null, '', 'legac', 'LEGACY', 0, false])
        assert.notEqual(resolveMode(v), TERRAIN_MODE.LEGACY, `${v} must not select legacy`);
    assert.equal(resolveMode('legacy'), TERRAIN_MODE.LEGACY, 'but the escape hatch must work');
});

test('an unknown consumer defaults to the tile formula, never crashes', () => {
    assert.equal(formulaFor('who-knows', TERRAIN_MODE.LEGACY), 'flat');
});

console.log(`\n${passed} passed`);
