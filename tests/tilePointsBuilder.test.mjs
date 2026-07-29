// tests/tilePointsBuilder.test.mjs — pin the extracted tile point-cloud maths.
// Run from repo root:  node tests/tilePointsBuilder.test.mjs
//
// This module was lifted out of tileStreamManager._buildPoints (2026-07-24) so the
// work can move into a Worker. The extraction is only safe if it is genuinely a
// no-op, and the property that matters most is DETERMINISM: tiles are evicted and
// rebuilt constantly, and the original seeded its PRNG from tile coords precisely
// so a rebuilt tile looks identical rather than shimmering. A worker version that
// produced *valid but different* points would pass a casual eye and fail here.

import assert from 'node:assert/strict';
import { buildTilePoints, geoTileBounds, lonToSceneX, latToSceneZ, elevToColor,
         elevToSceneY, curveOffset, isGeoidFlatOcean }
    from '../tilePointsBuilder.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// ── A synthetic quantized-mesh tile ──────────────────────────────────────────
// Two triangles forming a quad, with real height variation so the relief-scaled
// edge overlap and the elevation palette both actually engage.
function fakeQM({ minHeight = 100, maxHeight = 900 } = {}) {
    // Matches the real decoder's output shape (see _flatQM / the QM header reader
    // in tileStreamManager): u/v/height are Uint16 0..32767, not floats.
    return {
        vertexCount: 4,
        uBuf: new Uint16Array([0, 32767, 0, 32767]),   // W,E,W,E
        vBuf: new Uint16Array([0, 0, 32767, 32767]),   // S,S,N,N
        hBuf: new Uint16Array([0, 13000, 32767, 20000]),
        minHeight, maxHeight,
        indices: new Uint32Array([0, 1, 2, 1, 3, 2]),
        edgeIndices: { west: [0, 2], south: [0, 1], east: [1, 3], north: [2, 3] },
    };
}

const cfg = (over = {}) => ({ zoom: 9, ptsBudget: 2000, imgSize: 256, ptSize: 0.012, ...over });

// ── Pure-module hygiene ──────────────────────────────────────────────────────
console.log('purity');

test('module has no browser or THREE dependency', () => {
    // It loaded at all under plain node with no DOM stub — that IS the assertion.
    // If someone reintroduces a THREE import or touches `window`, the import above
    // throws and this file fails before reaching any other test.
    assert.equal(typeof buildTilePoints, 'function');
    assert.equal(typeof globalThis.window, 'undefined',
        'test env must stay DOM-free so an accidental window reference is caught');
});

// ── Geometry helpers ─────────────────────────────────────────────────────────
console.log('helpers');

test('tile bounds tile the world without gaps at a given zoom', () => {
    const z = 3, n = 2 ** (z + 1);
    const a = geoTileBounds(0, 0, z), b = geoTileBounds(1, 0, z);
    assert.equal(a.west, -180);
    assert.equal(a.east, b.west, 'adjacent tiles must share an edge exactly');
    assert.equal(geoTileBounds(n - 1, 0, z).east, 180);
});

test('lon/lat → scene mapping is monotonic and centred', () => {
    assert.equal(lonToSceneX(0), 0);
    assert.ok(lonToSceneX(90) > lonToSceneX(0));
    // Z is Mercator and inverted: north is negative.
    assert.ok(latToSceneZ(45) < latToSceneZ(0));
    assert.ok(Math.abs(latToSceneZ(0)) < 1e-9);
});

test('elevation palette is continuous WITHIN water and within land', () => {
    // Deliberately excludes 0m: the water→land transition is a shoreline and is
    // SUPPOSED to be a hard edge. An earlier version of this test asserted global
    // continuity, "failed" at 0m, and was wrong to — worth keeping the distinction
    // explicit so nobody later "fixes" the shoreline by smoothing it away.
    for (const edge of [-6000, -2000, -200, 150, 600, 1500, 3000]) {
        const lo = elevToColor(edge - 0.01), hi = elevToColor(edge + 0.01);
        for (const ch of ['r', 'g', 'b']) {
            assert.ok(Math.abs(lo[ch] - hi[ch]) < 0.05,
                `palette jumps at ${edge}m on ${ch}: ${lo[ch]} → ${hi[ch]}`);
        }
    }
});

test('the shoreline at 0m IS a hard edge, by design', () => {
    const sea  = elevToColor(-0.01);
    const land = elevToColor(0.01);
    const diff = Math.abs(sea.r - land.r) + Math.abs(sea.g - land.g) + Math.abs(sea.b - land.b);
    assert.ok(diff > 0.2, `shoreline should be a visible transition, got ${diff.toFixed(3)}`);
});

// ── The extraction contract ──────────────────────────────────────────────────
console.log('build output');

test('produces points within budget and reports its own count', () => {
    const r = buildTilePoints(cfg(), 100, 200, fakeQM());
    assert.ok(r.count > 0, 'a tile with real geometry must produce points');
    assert.ok(r.count <= 2000, `count ${r.count} exceeded ptsBudget`);
    assert.equal(r.positions.length, 2000 * 3, 'buffers are allocated at full budget');
    assert.equal(r.colors.length, 2000 * 3);
});

test('DETERMINISTIC — same tile rebuilds identically', () => {
    // The original seeds its PRNG from tile coords specifically so an evicted and
    // reloaded tile does not shimmer. This is the property a worker port is most
    // likely to break, and the one a screenshot would never reveal.
    const a = buildTilePoints(cfg(), 100, 200, fakeQM());
    const b = buildTilePoints(cfg(), 100, 200, fakeQM());
    assert.equal(a.count, b.count);
    for (let i = 0; i < a.count * 3; i++) {
        assert.equal(a.positions[i], b.positions[i], `position[${i}] differs between builds`);
        assert.equal(a.colors[i],    b.colors[i],    `color[${i}] differs between builds`);
    }
});

test('different tiles get different point layouts', () => {
    // Same seed for every tile would produce a visibly repeating stipple pattern.
    const a = buildTilePoints(cfg(), 100, 200, fakeQM());
    const b = buildTilePoints(cfg(), 101, 200, fakeQM());
    let same = 0;
    for (let i = 0; i < Math.min(a.count, b.count) * 3; i++) if (a.positions[i] === b.positions[i]) same++;
    assert.ok(same < a.count, 'tile coords must seed the sampling, not a fixed seed');
});

test('points land inside the tile footprint (plus the edge-overlap margin)', () => {
    const tx = 100, ty = 200, z = 9;
    const r = buildTilePoints(cfg({ zoom: z }), tx, ty, fakeQM());
    const b = geoTileBounds(tx, ty, z);
    const x0 = lonToSceneX(b.west), x1 = lonToSceneX(b.east);
    const zN = latToSceneZ(b.north), zS = latToSceneZ(b.south);
    const padX = Math.abs(x1 - x0) * 0.10, padZ = Math.abs(zS - zN) * 0.10;
    for (let i = 0; i < r.count; i++) {
        const x = r.positions[i * 3], zz = r.positions[i * 3 + 2];
        assert.ok(x >= Math.min(x0, x1) - padX && x <= Math.max(x0, x1) + padX,
            `point ${i} x=${x} outside tile [${x0},${x1}]`);
        assert.ok(zz >= Math.min(zN, zS) - padZ && zz <= Math.max(zN, zS) + padZ,
            `point ${i} z=${zz} outside tile [${zN},${zS}]`);
    }
});

test('colours are Uint8 0-255, NOT floats — the GPU normalizes them', () => {
    // Changed 2026-07-25: colour is now Uint8Array read with BufferAttribute's
    // normalized flag, matching the base splat cloud. Two ways this breaks that a
    // screenshot would not reveal:
    //   • consumer forgets `true` on BufferAttribute → everything blows out white
    //   • an unclamped value >1.0 WRAPS (Uint8Array does not saturate), so a bright
    //     desert point at 1.15 would store as 38 and render near-BLACK
    const r = buildTilePoints(cfg(), 100, 200, fakeQM());
    assert.ok(r.colors instanceof Uint8Array, 'colours must be Uint8 for the memory win');
    let sawNonZero = false;
    for (let i = 0; i < r.count * 3; i++) {
        const v = r.colors[i];
        assert.ok(Number.isInteger(v) && v >= 0 && v <= 255, `colour[${i}] = ${v} out of 0..255`);
        if (v > 0) sawNonZero = true;
    }
    assert.ok(sawNonZero, 'all-zero colour would mean the clamp inverted everything');
});

test('saturated imagery clamps to 255 instead of WRAPPING to near-black', () => {
    // The specific hazard: measured colours reached 1.15 via the procedural tint.
    // (1.15 * 255) | 0 = 293, which wraps to 37 in a Uint8Array — a blown-out
    // highlight would render as a dark speck. Feed pure-white imagery and assert
    // the bright end really is bright.
    const N = 256, img = new Uint8ClampedArray(N * N * 4).fill(255);
    const r = buildTilePoints(cfg({ imgSize: N }), 100, 200, fakeQM(), img);
    let max = 0;
    for (let i = 0; i < r.count * 3; i++) if (r.colors[i] > max) max = r.colors[i];
    assert.ok(max > 200, `saturated imagery produced max channel ${max} — looks like a wrap`);
});

test('no NaN positions — a single NaN poisons the bounding sphere and culls the tile', () => {
    const r = buildTilePoints(cfg(), 100, 200, fakeQM());
    for (let i = 0; i < r.count * 3; i++) {
        assert.ok(Number.isFinite(r.positions[i]), `position[${i}] not finite`);
    }
});

test('respects a lowered point budget', () => {
    // ACTIVE_PTS_CAP was halved 28000→14000 the same day; the builder must actually
    // honour the number it is handed rather than a baked-in constant.
    const small = buildTilePoints(cfg({ ptsBudget: 200 }), 100, 200, fakeQM());
    assert.ok(small.count <= 200, `count ${small.count} exceeded a 200 budget`);
    assert.equal(small.positions.length, 200 * 3);
});

test('a degenerate (zero-area) tile yields no points instead of NaNs', () => {
    // All vertices identical → totalArea 0. The original guards this explicitly
    // because it would otherwise divide-to-NaN and emit NaN-positioned points.
    const flat = fakeQM({ minHeight: 50, maxHeight: 50 });
    flat.vertices = new Float32Array([0,0,50, 0,0,50, 0,0,50, 0,0,50]);
    flat.us = new Float32Array([0,0,0,0]);
    flat.vs = new Float32Array([0,0,0,0]);
    const r = buildTilePoints(cfg(), 100, 200, flat);
    for (let i = 0; i < r.count * 3; i++) {
        assert.ok(Number.isFinite(r.positions[i]), 'degenerate tile produced a NaN position');
    }
});

// ── DEM land mask ────────────────────────────────────────────────────────────
console.log('DEM land mask (coastline carving)');

// A tile whose quantized-mesh header LIES: every vertex claims 800m of land.
// This is the _flatQM bogus-height case, and it is precisely why the builder's
// own height-based ocean trims cannot be trusted on their own.
const lyingQM = () => ({
    vertexCount: 4,
    uBuf: new Uint16Array([0, 32767, 0, 32767]),
    vBuf: new Uint16Array([0, 0, 32767, 32767]),
    hBuf: new Uint16Array([0, 0, 0, 0]),
    minHeight: 800, maxHeight: 800,
    indices: new Uint32Array([0, 1, 2, 1, 3, 2]),
    edgeIndices: { west: [0, 2], south: [0, 1], east: [1, 3], north: [2, 3] },
});

const maskAll = (n, v) => new Uint8Array(n * n).fill(v);
const maskHalf = (n) => {           // west half land, east half ocean
    const m = new Uint8Array(n * n);
    for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) m[v * n + u] = u < n / 2 ? 1 : 0;
    return m;
};

test('without a mask, a lying tile still fills its whole square', () => {
    // Establishes the baseline the mask exists to fix — if this ever stops being
    // true the bug is gone and the mask can be reconsidered.
    const r = buildTilePoints(cfg(), 100, 200, lyingQM(), null, null);
    assert.ok(r.count > 100, `expected a full square of points, got ${r.count}`);
});

test('an all-ocean mask suppresses every point, even when the tile claims land', () => {
    const r = buildTilePoints(cfg(), 100, 200, lyingQM(), null, maskAll(32, 0));
    assert.equal(r.count, 0, 'DEM says ocean everywhere — nothing should be emitted');
});

test('an all-land mask changes nothing', () => {
    const withMask = buildTilePoints(cfg(), 100, 200, lyingQM(), null, maskAll(32, 1));
    const without  = buildTilePoints(cfg(), 100, 200, lyingQM(), null, null);
    assert.equal(withMask.count, without.count, 'an all-land mask must be a no-op');
});

test('a half mask carves the tile along the mask boundary', () => {
    const tx = 100, ty = 200, z = 9;
    const r = buildTilePoints(cfg({ zoom: z }), tx, ty, lyingQM(), null, maskHalf(32));
    assert.ok(r.count > 0, 'the land half must still produce points');
    const b = geoTileBounds(tx, ty, z);
    const x0 = lonToSceneX(b.west), x1 = lonToSceneX(b.east);
    const mid = x0 + (x1 - x0) / 2;
    // Allow the seam-overlap fringe: points can sit slightly past the base bounds,
    // and a fringe point maps to the nearest edge cell by design.
    const slack = Math.abs(x1 - x0) * 0.06;
    let past = 0;
    for (let i = 0; i < r.count; i++) if (r.positions[i * 3] > mid + slack) past++;
    assert.equal(past, 0, `${past} points emitted on the ocean side of the mask`);
});

test('masking preserves determinism', () => {
    // The PRNG stream must not depend on which samples got rejected, or an evicted
    // and rebuilt tile would shimmer.
    const a = buildTilePoints(cfg(), 100, 200, lyingQM(), null, maskHalf(32));
    const b = buildTilePoints(cfg(), 100, 200, lyingQM(), null, maskHalf(32));
    assert.equal(a.count, b.count);
    for (let i = 0; i < a.count * 3; i++) assert.equal(a.positions[i], b.positions[i]);
});

test('mask resolution is inferred from its length, not hard-coded', () => {
    // The builder derives N from sqrt(length); a 16x16 mask must work identically.
    const r16 = buildTilePoints(cfg(), 100, 200, lyingQM(), null, maskAll(16, 0));
    assert.equal(r16.count, 0, '16x16 all-ocean mask should also suppress everything');
});

test('a tile with REAL relief must not be carved — small islands live here', () => {
    // The regression this replaces: the DEM is ~9.8km per texel while a 32x32 mask
    // over a z9 tile has 1.22km cells. Islands smaller than a DEM texel are absent
    // from the DEM but fully present in Cesium's mesh. Carving those against the
    // DEM deletes real land. The caller only supplies a mask when the tile's own
    // heights are invented, so a genuine-relief tile must be reachable WITHOUT one
    // and must keep every point.
    const realRelief = fakeQM({ minHeight: 5, maxHeight: 640 });   // an island
    const uncarved = buildTilePoints(cfg(), 100, 200, realRelief, null, null);
    assert.ok(uncarved.count > 100,
        `a real island tile must render fully, got ${uncarved.count} points`);

    // And prove the hazard is real: had a DEM-blind mask been applied, the island
    // would have vanished. This is the exact failure that shipped and was caught.
    const wouldHaveVanished = buildTilePoints(cfg(), 100, 200, realRelief, null, maskAll(32, 0));
    assert.equal(wouldHaveVanished.count, 0,
        'sanity: an all-ocean mask does delete the island — hence the caller-side gate');
});

// ── Ancestor imagery (imgRect) ───────────────────────────────────────────────
// A tile whose own imagery blanked can paint itself from an already-fetched
// ANCESTOR tile's image, sampling the sub-rect that covers its ground. Real
// satellite colour at half resolution beats the flat elevation palette.
//
// The bug this guards is an axis flip. The builder derives fv from
// z0=latToSceneZ(north) → z1=latToSceneZ(south), so fv=0 is NORTH — but tile `ty`
// counts NORTHWARD. Using ty directly mirrors every borrowed tile vertically,
// which is invisible in isolation and only wrong at the seams. It was written
// wrong the first time and caught by checking, not by looking.
console.log('ancestor imagery (imgRect)');

/** A parent image split N/S: north half pure red, south half pure blue. */
function nsSplitImage(N) {
    const d = new Uint8ClampedArray(N * N * 4);
    for (let y = 0; y < N; y++) {
        // Image row 0 is the fv=0 end, i.e. NORTH.
        const north = y < N / 2;
        for (let x = 0; x < N; x++) {
            const i = (y * N + x) * 4;
            d[i] = north ? 255 : 0; d[i+1] = 0; d[i+2] = north ? 0 : 255; d[i+3] = 255;
        }
    }
    return d;
}

/** Mean colour of the points a build produced. */
function meanRGB(r) {
    let cr = 0, cg = 0, cb = 0;
    for (let i = 0; i < r.count; i++) { cr += r.colors[i*3]; cg += r.colors[i*3+1]; cb += r.colors[i*3+2]; }
    return { r: cr / r.count, g: cg / r.count, b: cb / r.count };
}

test('identity rect reproduces plain own-imagery sampling', () => {
    // The default path must be untouched by the new parameter.
    const img = nsSplitImage(256);
    const a = buildTilePoints(cfg({ imgSize: 256 }), 100, 200, fakeQM(), img, null, null);
    const b = buildTilePoints(cfg({ imgSize: 256 }), 100, 200, fakeQM(), img, null,
                              { u0: 0, v0: 0, scale: 1, size: 256 });
    assert.equal(a.count, b.count);
    for (let i = 0; i < a.count * 3; i++) {
        assert.equal(a.colors[i], b.colors[i], `colour[${i}] differs — identity rect is not a no-op`);
    }
});

test('the NORTH child samples the NORTH half of its parent', () => {
    // v0 = (span-1-iy)/span. For span=2 the north child is iy=1 → v0=0 → the
    // fv=0 (north/red) end. Getting this backwards yields blue and a mirrored map.
    const img = nsSplitImage(256);
    const north = buildTilePoints(cfg({ imgSize: 256 }), 100, 200, fakeQM(), img, null,
                                  { u0: 0, v0: 0, scale: 0.5, size: 256 });
    const m = meanRGB(north);
    assert.ok(m.r > m.b, `north child sampled the south half (r=${m.r.toFixed(3)} b=${m.b.toFixed(3)})`);
});

test('the SOUTH child samples the SOUTH half of its parent', () => {
    const img = nsSplitImage(256);
    const south = buildTilePoints(cfg({ imgSize: 256 }), 100, 200, fakeQM(), img, null,
                                  { u0: 0, v0: 0.5, scale: 0.5, size: 256 });
    const m = meanRGB(south);
    assert.ok(m.b > m.r, `south child sampled the north half (r=${m.r.toFixed(3)} b=${m.b.toFixed(3)})`);
});

test('north and south children disagree — the rect actually moves the window', () => {
    // Guards the degenerate pass where u0/v0 are ignored and both children return
    // the same thing, which would make the two tests above pass for a bad reason
    // if the palette happened to dominate.
    const img = nsSplitImage(256);
    const n = meanRGB(buildTilePoints(cfg({ imgSize: 256 }), 100, 200, fakeQM(), img, null,
                                      { u0: 0, v0: 0, scale: 0.5, size: 256 }));
    const s = meanRGB(buildTilePoints(cfg({ imgSize: 256 }), 100, 200, fakeQM(), img, null,
                                      { u0: 0, v0: 0.5, scale: 0.5, size: 256 }));
    assert.ok(Math.abs(n.r - s.r) > 0.05, 'sub-rect offset had no effect on sampling');
});

test('rect `size` overrides cfg.imgSize — ancestors are cached at their own scale', () => {
    // The ancestor is stored downscaled to 256 regardless of the LEVEL's imgSize,
    // which is 512 on the deep levels. If the sampler used cfg.imgSize as the row
    // stride it would walk off the end of each row and shear the image — garbage
    // that still renders, rather than an obvious failure. So: the same rect against
    // the same image must give byte-identical results at either cfg.imgSize.
    const img = nsSplitImage(256);
    const rect = { u0: 0, v0: 0, scale: 0.5, size: 256 };
    const a = buildTilePoints(cfg({ imgSize: 256 }), 100, 200, fakeQM(), img, null, rect);
    const b = buildTilePoints(cfg({ imgSize: 512 }), 100, 200, fakeQM(), img, null, rect);
    assert.equal(a.count, b.count);
    for (let i = 0; i < a.count * 3; i++) {
        assert.equal(a.colors[i], b.colors[i],
            `colour[${i}] differs — cfg.imgSize is leaking into the stride`);
    }
    assert.ok(meanRGB(a).r > meanRGB(a).b, 'north child should still read as north');
});

// ── DEM-relief fallback tiles ────────────────────────────────────────────────
// _flatQM (tileStreamManager) used to emit a single FLAT quad when Cesium had no
// terrain for a tile. A flat tile cannot meet its sloping neighbours, so it read
// as a plate hovering over the terrain with a hard rectangular seam — 14 of them
// on a measured z10 dive. It now samples the coarse DEM on an (N+1)² grid.
//
// _flatQM itself imports THREE and can't run here, but the part that can actually
// be got WRONG is the data shape it hands to this builder: grid winding, edge
// vertex lists, and the height quantisation. These tests pin that contract.
console.log('DEM-relief fallback tiles');

/** Mirrors the grid _flatQM now emits. `h(r,c)` returns metres. */
function gridQM(N, h) {
    const V = (N + 1) * (N + 1);
    const uBuf = new Uint16Array(V), vBuf = new Uint16Array(V), hBuf = new Uint16Array(V);
    let lo = Infinity, hi = -Infinity;
    const raw = [];
    for (let r = 0; r <= N; r++) for (let c = 0; c <= N; c++) {
        const e = h(r, c); raw.push(e);
        if (e < lo) lo = e; if (e > hi) hi = e;
    }
    const span = (hi - lo) || 1;
    for (let r = 0; r <= N; r++) for (let c = 0; c <= N; c++) {
        const i = r * (N + 1) + c;
        uBuf[i] = Math.round((c / N) * 32767);
        vBuf[i] = Math.round((r / N) * 32767);
        hBuf[i] = Math.round(((raw[i] - lo) / span) * 32767);
    }
    const indices = new Uint32Array(N * N * 6);
    let t = 0;
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        const a = r * (N + 1) + c, b = a + 1, cc = a + (N + 1), d = cc + 1;
        indices[t++] = a; indices[t++] = b; indices[t++] = cc;
        indices[t++] = b; indices[t++] = d; indices[t++] = cc;
    }
    const west = [], east = [], south = [], north = [];
    for (let r = 0; r <= N; r++) { west.push(r * (N + 1)); east.push(r * (N + 1) + N); }
    for (let c = 0; c <= N; c++) { south.push(c); north.push(N * (N + 1) + c); }
    return { vertexCount: V, uBuf, vBuf, hBuf, minHeight: lo, maxHeight: hi,
             isFallback: true, indices, edgeIndices: { west, south, east, north } };
}

test('an 8x8 DEM grid builds points at all', () => {
    // The whole change is worthless if the builder chokes on 81 vertices / 128
    // triangles instead of the 4 / 2 it used to get.
    const r = buildTilePoints(cfg(), 100, 200, gridQM(8, (row, c) => 200 + row * 90 + c * 40));
    assert.ok(r.count > 100, `expected a filled tile, got ${r.count} points`);
});

test('the fallback tile now has REAL RELIEF — this is the whole point', () => {
    // The regression it replaces: every point at the same height, so the tile sat
    // as a flat plate among sloping neighbours.
    const sloped = buildTilePoints(cfg(), 100, 200, gridQM(8, (row, c) => 100 + row * 300 + c * 150));
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < sloped.count; i++) {
        const y = sloped.positions[i * 3 + 1];
        if (y < mn) mn = y; if (y > mx) mx = y;
    }
    assert.ok(mx - mn > 0.01, `fallback tile is still flat (relief ${(mx - mn).toFixed(5)})`);
});

test('a genuinely flat DEM region stays flat without dividing by zero', () => {
    // hi === lo is the degenerate case (uniform plain, or open ocean). It must
    // produce finite heights, not NaN — one NaN poisons the bounding sphere and
    // culls the whole tile.
    const r = buildTilePoints(cfg(), 100, 200, gridQM(8, () => 450));
    assert.ok(r.count > 0);
    for (let i = 0; i < r.count; i++) {
        assert.ok(Number.isFinite(r.positions[i * 3 + 1]), `NaN height at point ${i}`);
    }
});

test('grid heights map monotonically — north-south orientation is not flipped', () => {
    // v=0 is SOUTH in the QM contract. Getting this backwards would mirror every
    // fallback tile's terrain against its neighbours, which looks plausible in
    // isolation and wrong only at the seams — exactly the kind of bug that ships.
    const r = buildTilePoints(cfg(), 100, 200, gridQM(8, (row) => 100 + row * 400));
    const zs = [], ys = [];
    for (let i = 0; i < r.count; i++) { zs.push(r.positions[i * 3 + 2]); ys.push(r.positions[i * 3 + 1]); }
    // Scene Z is inverted (north = -Z), and height rises with row (= north),
    // so height must rise as Z DEcreases. Compare the extremes.
    let zMinI = 0, zMaxI = 0;
    for (let i = 1; i < zs.length; i++) { if (zs[i] < zs[zMinI]) zMinI = i; if (zs[i] > zs[zMaxI]) zMaxI = i; }
    assert.ok(ys[zMinI] > ys[zMaxI],
        'northern (lower Z) edge should be higher — grid rows are flipped');
});

// ── The camera's ground floor ────────────────────────────────────────────────
// elevToSceneY was exported 2026-07-25 so main.js's collision clamp and
// ground-following orbit pivot measure the terrain with the SAME transform the
// tiles are drawn with. Before that, the clamp used the base splat cloud's
// `/650` exaggeration against a tile surface built with `/2000` — a ~3× error
// that held the camera far above the visible ground and capped the tilt angle
// at close zoom. The map became effectively 2D from about y=2 down.
//
// These tests exist so that error cannot come back silently: if the tile
// elevation transform is ever changed, the camera floor changes with it, and
// if the two are ever allowed to drift apart again, the integration test fails.
console.log('ground floor');

test('elevToSceneY: sea level and below is flat zero', () => {
    for (const e of [-8000, -200, -1, 0]) {
        assert.equal(elevToSceneY(e), 0, `${e}m should sit exactly at sea level`);
    }
});

test('elevToSceneY is monotonic and continuous across the 15m shoreline taper', () => {
    let prev = -Infinity;
    for (const e of [0, 1, 5, 14.99, 15, 15.01, 100, 1000, 3000, 8848]) {
        const y = elevToSceneY(e);
        assert.ok(Number.isFinite(y), `${e}m produced ${y}`);
        assert.ok(y >= prev, `not monotonic at ${e}m: ${y} < ${prev}`);
        prev = y;
    }
    // The taper meets the linear ramp exactly at 15m — a step here would show as
    // a visible cliff ringing every coastline.
    assert.ok(Math.abs(elevToSceneY(14.999) - elevToSceneY(15.001)) < 1e-5,
        'shoreline taper must join the linear ramp continuously');
});

test('elevToSceneY pins the /2000 divisor the camera floor depends on', () => {
    // Not testing an arbitrary constant for its own sake: main.js derives the
    // camera's ground clearance from this function. If someone retunes the tile
    // terrain height, this fails and forces them to re-check the camera floor
    // rather than discovering it as "the camera clips into mountains".
    assert.ok(Math.abs(elevToSceneY(2000) - 1.0 * 0.20) < 1e-9,
        '2000m should map to exactly 1 pre-scale unit × TERRAIN_VERTICAL_SCALE');
});

test('INTEGRATION — built point heights match elevToSceneY, so the floor tracks the surface', () => {
    // The property the camera actually relies on. A flat tile at a known
    // elevation: every point it emits must sit at elevToSceneY(H) + curveOffset,
    // because that is exactly what main.js assumes when it decides where the
    // ground is. If the builder ever applies an extra scale or offset that
    // elevToSceneY doesn't know about, the camera floor silently desyncs from
    // the visible terrain — which is the bug this whole section exists to prevent.
    const H = 1200;
    const flat = fakeQM({ minHeight: H, maxHeight: H });
    flat.hBuf = new Uint16Array([0, 0, 0, 0]);           // all vertices at H
    const r = buildTilePoints(cfg(), 100, 200, flat);
    assert.ok(r.count > 50, `need points to compare, got ${r.count}`);

    // Procedural micro-relief perturbs each point slightly (PROC.RELIEF ≈ 0.004),
    // so compare within that band rather than exactly.
    const TOL = 0.01;
    let worst = 0;
    for (let i = 0; i < r.count; i++) {
        const x = r.positions[i * 3], y = r.positions[i * 3 + 1], z = r.positions[i * 3 + 2];
        const expected = elevToSceneY(H) + curveOffset(x, z);
        worst = Math.max(worst, Math.abs(y - expected));
    }
    assert.ok(worst < TOL,
        `built heights drifted ${worst.toFixed(4)} from elevToSceneY (tolerance ${TOL}) — ` +
        `the camera floor no longer matches the rendered surface`);
});

// ── Geoid-flat ocean predicate ───────────────────────────────────────────────
// Cesium World Terrain has no bathymetry at these levels: open-water tiles
// decode as the flat GEOID surface, which is NOT 0 m — it ranges ~−107..+85 m
// against the ellipsoid (+11..+20 m measured near Japan, 2026-07-28). So this
// predicate must accept the whole geoid envelope as "flat ocean" while
// rejecting anything with real relief. It is one of TWO keys — the land plane
// is the other — so its job is height-shape only, not land detection.
console.log('\ngeoid-flat ocean predicate');

test('the measured Japan case (+10.9..+19.5 m) reads as geoid-flat', () => {
    assert.equal(isGeoidFlatOcean(10.9, 19.5), true);
});

test('geoid extremes are inside the envelope', () => {
    assert.equal(isGeoidFlatOcean(80, 85), true,      'high geoid (Indonesia-ish)');
    assert.equal(isGeoidFlatOcean(-107, -100), true,  'low geoid (Indian Ocean low)');
    assert.equal(isGeoidFlatOcean(-3, 2), true,       'near-zero geoid');
});

test('real relief is NOT geoid-flat', () => {
    assert.equal(isGeoidFlatOcean(35.8, 1240.5), false, 'the Kii Peninsula tile');
    assert.equal(isGeoidFlatOcean(0, 90), false,        '90 m of relief is a coast, not a surface');
    assert.equal(isGeoidFlatOcean(-4000, -3900), false, 'real bathymetry sits outside ±ABS_MAX');
    assert.equal(isGeoidFlatOcean(150, 160), false,     'a 150 m plateau is land even though flat');
});

test('non-finite heights are never "ocean" (suppression needs positive evidence)', () => {
    assert.equal(isGeoidFlatOcean(NaN, 10), false);
    assert.equal(isGeoidFlatOcean(0, Infinity), false);
    assert.equal(isGeoidFlatOcean(undefined, 5), false);
});

// ── Per-sample water carve ───────────────────────────────────────────────────
// Land-bearing coastal tiles must not paint their water fraction. The carve
// grid marks water cells (0) and the builder skips samples there — but ONLY
// when the sample's height is inside the geoid envelope (bandM). Real relief
// survives even in a water cell, so an island the land plane missed keeps its
// mountains. Grid row 0 = north, same as landMask.
console.log('\nper-sample water carve');

// A 2×2 carve grid: west column water, east column land.
const carveWestWater = { mask: new Uint8Array([0, 1, 0, 1]), n: 2, bandM: 120 };

test('geoid-height samples in water cells are carved; land cells keep theirs', () => {
    // Whole tile at geoid heights (+10..+20) — every sample is inside bandM.
    const r = buildTilePoints(cfg(), 100, 200, fakeQM({ minHeight: 10, maxHeight: 20 }),
                              null, null, null, carveWestWater);
    assert.ok(r.count > 200, `only ${r.count} points built`);
    const b = geoTileBounds(100, 200, 9);
    const xMid = (lonToSceneX(b.west) + lonToSceneX(b.east)) / 2;
    let west = 0, east = 0;
    for (let i = 0; i < r.count; i++) {
        (r.positions[i * 3] < xMid ? west++ : east++);
    }
    // Seam-overlap widening lets a thin fringe of points spill past the cell
    // edge, so demand a strong asymmetry rather than an absolute zero.
    assert.ok(west < r.count * 0.05,
        `${west}/${r.count} points in the carved water half — carve not applied`);
    assert.ok(east > r.count * 0.9, `east (land) half unexpectedly thin: ${east}`);
});

test('relief above the band is NEVER carved — unmapped islands survive', () => {
    // Same water-west carve, but the tile is a mountain (+200..+900 m).
    const r = buildTilePoints(cfg(), 100, 200, fakeQM({ minHeight: 200, maxHeight: 900 }),
                              null, null, null, carveWestWater);
    const b = geoTileBounds(100, 200, 9);
    const xMid = (lonToSceneX(b.west) + lonToSceneX(b.east)) / 2;
    let west = 0;
    for (let i = 0; i < r.count; i++) if (r.positions[i * 3] < xMid) west++;
    assert.ok(west > r.count * 0.3,
        `mountain west half lost its points (${west}/${r.count}) — height guard broken`);
});

test('no carve grid → identical output to before (determinism preserved)', () => {
    const a = buildTilePoints(cfg(), 100, 200, fakeQM(), null, null, null, null);
    const c = buildTilePoints(cfg(), 100, 200, fakeQM(), null, null, null);
    assert.equal(a.count, c.count);
    assert.deepEqual(Array.from(a.positions.slice(0, 30)), Array.from(c.positions.slice(0, 30)));
});

// ── Surf-fringe colour treatment ─────────────────────────────────────────────
// Surf cells (value 2) are water the ring kept painted. Off deep coasts the
// imagery there is near-BLACK abyssal water; the builder must lift those
// samples toward the ocean palette instead of drawing black borders around
// every coastline. Land cells with the same dark imagery must NOT be lifted —
// a dark forest is allowed to be dark.
console.log('\nsurf-fringe colour');

function darkImage(N) {
    const d = new Uint8ClampedArray(N * N * 4);
    for (let i = 0; i < d.length; i += 4) { d[i] = 3; d[i+1] = 5; d[i+2] = 10; d[i+3] = 255; }
    return d;
}

test('surf samples over abyssal-dark imagery are lifted toward ocean blue', () => {
    const qm  = fakeQM({ minHeight: 10, maxHeight: 20 });      // geoid band
    const img = darkImage(256);
    const surf = buildTilePoints(cfg(), 100, 200, qm, img, null, null,
                                 { mask: new Uint8Array([2]), n: 1, bandM: 120 });
    const land = buildTilePoints(cfg(), 100, 200, qm, img, null, null,
                                 { mask: new Uint8Array([1]), n: 1, bandM: 120 });
    assert.ok(surf.count > 200 && land.count > 200);
    const mean = (r) => {
        let cr = 0, cg = 0, cb = 0;
        for (let i = 0; i < r.count; i++) { cr += r.colors[i*3]; cg += r.colors[i*3+1]; cb += r.colors[i*3+2]; }
        return { r: cr / r.count / 255, g: cg / r.count / 255, b: cb / r.count / 255 };
    };
    const ms = mean(surf), ml = mean(land);
    assert.ok(ms.b > ml.b + 0.05,
        `surf blue ${ms.b.toFixed(3)} not lifted above land ${ml.b.toFixed(3)}`);
    assert.ok(ms.b > ms.r, `surf tint not blue-dominant (r ${ms.r.toFixed(3)} b ${ms.b.toFixed(3)})`);
});

test('surf tint never fires on real relief — mountains in a surf cell stay photographic', () => {
    const img = darkImage(256);
    const mountain = buildTilePoints(cfg(), 100, 200, fakeQM({ minHeight: 200, maxHeight: 900 }),
                                     img, null, null, { mask: new Uint8Array([2]), n: 1, bandM: 120 });
    const control  = buildTilePoints(cfg(), 100, 200, fakeQM({ minHeight: 200, maxHeight: 900 }),
                                     img, null, null, null);
    assert.equal(mountain.count, control.count, 'relief above bandM must be untouched by the carve');
    assert.deepEqual(Array.from(mountain.colors.slice(0, 30)), Array.from(control.colors.slice(0, 30)),
        'colours differ — the tint leaked past the height guard');
});

console.log(`\n${passed} passed`);
