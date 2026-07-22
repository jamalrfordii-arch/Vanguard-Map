// tests/config.test.mjs — the "do-not-touch" guard.
// Run from repo root:  node tests/config.test.mjs
// Pure node, no browser, no THREE.
//
// CLAUDE.md has a "Visual ownership — DO NOT change these" section: a list of
// hand-tuned uniforms and *paired* LOD thresholds that break the map's look when
// they drift. Today those rules live only in prose. This suite turns them into
// assertions, so an edit (yours, a contributor's, or an agent's) that crosses a
// documented safe bound fails loudly in CI instead of silently shipping.
//
// This does NOT assert "the right look" — that's the visual-regression guard's
// job. It asserts the *documented constraints*: orderings, floors, and ceilings
// that CLAUDE.md says must hold.

import assert from 'node:assert/strict';
import * as cfg from '../config.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('coordinate-system contract');
test('MAP_WIDTH === MAP_HEIGHT === 300 (square Mercator scene)', () => {
    assert.equal(cfg.MAP_WIDTH, 300);
    assert.equal(cfg.MAP_HEIGHT, 300);
});

console.log('LOD seams stay paired & ordered');
test('TILE_LOD_ALTS is strictly descending and all positive', () => {
    const a = cfg.TILE_LOD_ALTS;
    assert.ok(Array.isArray(a) && a.length >= 2, 'TILE_LOD_ALTS must be a non-trivial array');
    for (let i = 1; i < a.length; i++) {
        assert.ok(a[i] < a[i - 1],
            `TILE_LOD_ALTS must strictly descend: ${a[i - 1]} -> ${a[i]} at index ${i}`);
        assert.ok(a[i] > 0, `TILE_LOD_ALTS entries must be > 0 (got ${a[i]})`);
    }
});
test('continent-mesh fade band is ordered (START > END)', () => {
    assert.ok(cfg.CONTINENT_FADE_START > cfg.CONTINENT_FADE_END,
        `CONTINENT_FADE_START (${cfg.CONTINENT_FADE_START}) must exceed CONTINENT_FADE_END (${cfg.CONTINENT_FADE_END})`);
});
test('splat->tiles handoff band is ordered (START > END)', () => {
    assert.ok(cfg.SPLAT_FADE_TILES_START > cfg.SPLAT_FADE_TILES_END,
        `SPLAT_FADE_TILES_START (${cfg.SPLAT_FADE_TILES_START}) must exceed SPLAT_FADE_TILES_END (${cfg.SPLAT_FADE_TILES_END})`);
});
test('tile streaming begins at or below the highest TILE_LOD alt', () => {
    // The first (highest) LOD altitude is where tiles start loading; the
    // splat->tiles handoff should happen within that streaming envelope, not above it.
    assert.ok(cfg.SPLAT_FADE_TILES_START <= cfg.TILE_LOD_ALTS[0],
        `splat->tiles handoff (${cfg.SPLAT_FADE_TILES_START}) should be <= first tile LOD alt (${cfg.TILE_LOD_ALTS[0]})`);
});

console.log('bloom — the "hairpin"');
test('BLOOM_THRESHOLD stays at/above the 0.90 blow-out floor', () => {
    assert.ok(cfg.BLOOM_THRESHOLD >= 0.90,
        `BLOOM_THRESHOLD (${cfg.BLOOM_THRESHOLD}) below 0.90 blows out the whole scene (CLAUDE.md)`);
    assert.ok(cfg.BLOOM_THRESHOLD <= 1.0, 'BLOOM_THRESHOLD cannot exceed 1.0');
});
test('bloom max (base + threat range) never reaches the 1.0 white-out', () => {
    const maxBloom = cfg.BLOOM_STRENGTH_BASE + cfg.BLOOM_THREAT_RANGE;
    assert.ok(cfg.BLOOM_STRENGTH_BASE > 0, 'BLOOM_STRENGTH_BASE must be positive');
    assert.ok(maxBloom < 1.0,
        `base+threat bloom (${maxBloom.toFixed(2)}) is dangerously high; CLAUDE.md tops out ~0.55`);
});
test('BLOOM_RADIUS stays in its tuned band', () => {
    assert.ok(cfg.BLOOM_RADIUS > 0 && cfg.BLOOM_RADIUS <= 0.6,
        `BLOOM_RADIUS (${cfg.BLOOM_RADIUS}) drifted from its tuned ~0.40`);
});

console.log('splat / terrain palette floors & ceilings');
test('SPLAT_SATURATION stays below the 2.5 neon ceiling', () => {
    assert.ok(cfg.SPLAT_SATURATION > 0 && cfg.SPLAT_SATURATION <= 2.5,
        `SPLAT_SATURATION (${cfg.SPLAT_SATURATION}) > 2.5 makes the tropics go neon (CLAUDE.md)`);
});
test('SPLAT_LAND_LIFT stays at/above the 0.15 hard floor', () => {
    assert.ok(cfg.SPLAT_LAND_LIFT >= 0.15,
        `SPLAT_LAND_LIFT (${cfg.SPLAT_LAND_LIFT}) below 0.15 crushes shadowed land (CLAUDE.md)`);
});
test('SPLAT_LAND_GAMMA stays at/below the 0.85 ceiling', () => {
    assert.ok(cfg.SPLAT_LAND_GAMMA > 0 && cfg.SPLAT_LAND_GAMMA <= 0.85,
        `SPLAT_LAND_GAMMA (${cfg.SPLAT_LAND_GAMMA}) above 0.85 flattens the shadow-lift curve (CLAUDE.md)`);
});
test('SPLAT_BRIGHTNESS stays in a sane (0, 2] band', () => {
    assert.ok(cfg.SPLAT_BRIGHTNESS > 0 && cfg.SPLAT_BRIGHTNESS <= 2.0,
        `SPLAT_BRIGHTNESS (${cfg.SPLAT_BRIGHTNESS}) out of tuned band`);
});

console.log('GPU ceiling');
test('CONTINENT_MESH_SEGS does not exceed the low-end-GPU ceiling (1536)', () => {
    assert.ok(cfg.CONTINENT_MESH_SEGS <= 1536,
        `CONTINENT_MESH_SEGS (${cfg.CONTINENT_MESH_SEGS}) > 1536 — CLAUDE.md: do not raise on low-end GPUs`);
});

console.log(`\nconfig.test: ${passed} checks passed`);
