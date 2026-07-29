// tests/tileLandMask.test.mjs — contract test for the baked tile land mask.
// Run from repo root:  node tests/tileLandMask.test.mjs
// Pure node, no browser, no THREE.
//
// Guards the three promises the mask makes:
//   (1) it FAILS OPEN — an absent, truncated or corrupt asset must never cause
//       a tile to be skipped, because a skipped tile is missing ground;
//   (2) the bit addressing round-trips exactly, including the longitude wrap and
//       the ancestor fallback for zooms finer than the baked maximum;
//   (3) the shipped asset actually keeps the tiles that hold real land — the
//       failure the old depth heuristic had (12 of 17 sampled islands skipped)
//       must not come back in a new form.
//
// (3) is the one that matters. A mask that culls aggressively and correctly and
// a mask that culls aggressively and wrongly look identical in every aggregate
// statistic; only naming real places apart tells them apart.

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tileLandMask } from '../tileLandMask.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSET = join(REPO, 'data', 'tile-land-mask.bin');

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// Tile index for a lon/lat in the geographic TMS grid tileStreamManager uses:
// 2^(z+1) columns from lon −180, 2^z rows from lat −90 (ty=0 = south).
function tileOf(lat, lon, z) {
    return {
        tx: Math.floor((lon + 180) / (360 / 2 ** (z + 1))),
        ty: Math.floor((lat + 90) / (180 / 2 ** z)),
    };
}

// ── (1) fail-open ─────────────────────────────────────────────────────────────
console.log('fail-open (a mask that cannot answer must never cull)');

test('unloaded mask fetches everything', () => {
    assert.equal(tileLandMask.ready, false);
    assert.equal(tileLandMask.shouldFetch(9, 0, 0), true);
    assert.equal(tileLandMask.shouldFetch(10, 1234, 567), true);
    assert.equal(tileLandMask.isWaterOnly(10, 1234, 567), false);
});

test('bad magic is rejected, mask stays unready', () => {
    const junk = new Uint8Array(64);
    assert.throws(() => tileLandMask.ingest(junk.buffer), /bad magic/);
    assert.equal(tileLandMask.ready, false);
    assert.equal(tileLandMask.shouldFetch(10, 5, 5), true);
});

test('a plane of the wrong length is rejected rather than mis-indexed', () => {
    // Correct magic + header, but the z3 plane is one byte short. Silently
    // accepting it would shift every subsequent bit lookup.
    const buf = new ArrayBuffer(36 + 15);
    const b = new Uint8Array(buf), dv = new DataView(buf);
    'VG1TMASK'.split('').forEach((c, i) => { b[i] = c.charCodeAt(0); });
    dv.setUint32(8, 1, true);    // version
    dv.setUint32(12, 3, true);   // minZoom
    dv.setUint32(16, 3, true);   // maxZoom
    dv.setUint32(20, 1, true);   // dilation
    dv.setUint32(24, 0, true);   // flags
    dv.setUint32(28, 36, true);  // offset
    dv.setUint32(32, 15, true);  // length — should be 16 (128 tiles / 8)
    assert.throws(() => tileLandMask.ingest(buf), /expected 16/);
    assert.equal(tileLandMask.ready, false);
});

// ── load the real asset ───────────────────────────────────────────────────────
if (!existsSync(ASSET)) {
    console.error(`\n  ✗ ${ASSET} missing — run: python3 tools/build_tile_land_mask.py`);
    process.exitCode = 1;
    process.exit();
}
const bytes = readFileSync(ASSET);
tileLandMask.ingest(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

console.log('\nasset');
test('header parses and every baked plane is present', () => {
    assert.equal(tileLandMask.ready, true);
    assert.equal(tileLandMask.minZoom, 3);
    assert.ok(tileLandMask.maxZoom >= 10, `maxZoom ${tileLandMask.maxZoom} < 10`);
    for (let z = tileLandMask.minZoom; z <= tileLandMask.maxZoom; z++) {
        assert.ok(tileLandMask.fetchFraction(z) !== null, `z${z} plane missing`);
    }
});

// ── (2) addressing ────────────────────────────────────────────────────────────
console.log('\naddressing');

test('longitude wraps instead of reading a neighbouring row', () => {
    const TPX = 2 ** 11;
    for (const ty of [200, 512, 800]) {
        assert.equal(tileLandMask.shouldFetch(10, TPX, ty), tileLandMask.shouldFetch(10, 0, ty));
        assert.equal(tileLandMask.shouldFetch(10, -1, ty), tileLandMask.shouldFetch(10, TPX - 1, ty));
    }
});

test('off-grid latitude fails open', () => {
    assert.equal(tileLandMask.shouldFetch(10, 5, -1), true);
    assert.equal(tileLandMask.shouldFetch(10, 5, 2 ** 10), true);
});

test('zoom beyond the baked max resolves against its ancestor', () => {
    // z11 tile (2tx, 2ty) lives inside z10 tile (tx, ty).
    const { tx, ty } = tileOf(1.29, 103.85, 10);   // Singapore
    assert.equal(tileLandMask.shouldFetch(11, tx * 2, ty * 2), tileLandMask.shouldFetch(10, tx, ty));
    assert.equal(tileLandMask.shouldFetch(12, tx * 4 + 3, ty * 4 + 1), tileLandMask.shouldFetch(10, tx, ty));
});

test('a coarse level keeps every tile a finer level keeps (levels nest)', () => {
    // A parent tile must be kept whenever any child is, or descending a zoom
    // would reveal ground the level above refused to load.
    let checked = 0;
    for (let ty = 0; ty < 512; ty += 7) {
        for (let tx = 0; tx < 1024; tx += 11) {
            if (tileLandMask.shouldFetch(9, tx, ty)) continue;
            for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
                assert.equal(tileLandMask.shouldFetch(10, tx * 2 + cx, ty * 2 + cy), false,
                    `z9 ${tx}/${ty} culled but z10 child ${tx * 2 + cx}/${ty * 2 + cy} kept`);
            }
            checked++;
        }
    }
    assert.ok(checked > 1000, `only ${checked} culled parents sampled`);
});

// ── (3) real places ───────────────────────────────────────────────────────────
console.log('\nreal places (the test that actually catches a bad bake)');

// Every one of these was SKIPPED by the −60 m depth heuristic this mask replaces,
// except the four marked "already worked" — kept so a regression toward the old
// behaviour is visible as a diff, not just a smaller number.
const MUST_FETCH = {
    'Nauru':             [-0.5228, 166.9315],
    'Malé, Maldives':    [4.1755, 73.5093],
    'Nassau, Bahamas':   [25.06, -77.34],
    'Bermuda':           [32.30, -64.78],
    'Funafuti, Tuvalu':  [-8.52, 179.20],     // also guards the antimeridian
    'Kiritimati':        [1.87, -157.40],
    'Diego Garcia':      [-7.31, 72.41],
    'St Helena':         [-15.96, -5.71],
    'Malta':             [35.90, 14.51],
    'Key West':          [24.56, -81.78],
    'Guam':              [13.44, 144.79],
    'Palau':             [7.34, 134.47],
    'Singapore':         [1.29, 103.85],      // already worked
    'Bahrain':           [26.07, 50.55],      // already worked
    'Socotra':           [12.47, 53.90],      // already worked
    'Isle of Man':       [54.24, -4.55],      // already worked
    // Land BELOW sea level — an elevation-only mask culls these.
    'Death Valley':      [36.25, -116.82],
    'Dead Sea':          [31.50, 35.47],
    'Caspian shore':     [41.00, 51.00],
    // Ports the map actually plots vessels into.
    'Rotterdam':         [51.95, 4.14],
    'Shanghai':          [31.23, 121.47],
    'Panama Canal':      [9.08, -79.68],
    'Suez':              [30.02, 32.55],
    'Strait of Hormuz':  [26.57, 56.25],
    'Gibraltar':         [36.14, -5.35],
    'Bab-el-Mandeb':     [12.58, 43.33],
    'Malacca Strait':    [1.43, 102.89],
    'Bosphorus':         [41.12, 29.07],
};

for (const [name, [lat, lon]] of Object.entries(MUST_FETCH)) {
    test(`${name} is kept at z8, z9 and z10`, () => {
        for (const z of [8, 9, 10]) {
            const { tx, ty } = tileOf(lat, lon, z);
            assert.equal(tileLandMask.shouldFetch(z, tx, ty), true,
                `culled at z${z} (tile ${tx}/${ty})`);
        }
    });
}

// The other half of the contract: open ocean must actually be culled, or the
// mask is a very expensive way to change nothing.
const MUST_SKIP = {
    'mid Pacific':        [0, -150],
    'South Pacific gyre': [-40, -120],
    'mid Atlantic':       [-20, -25],
    'Indian Ocean basin': [-30, 80],
    'Southern Ocean':     [-55, 40],
    'Philippine Sea':     [18, 132],
};

for (const [name, [lat, lon]] of Object.entries(MUST_SKIP)) {
    test(`${name} is culled at z10`, () => {
        const { tx, ty } = tileOf(lat, lon, 10);
        assert.equal(tileLandMask.shouldFetch(10, tx, ty), false, `still fetched (tile ${tx}/${ty})`);
    });
}

test('the mask culls a meaningful share of the globe at z10', () => {
    const f = tileLandMask.fetchFraction(10);
    assert.ok(f > 0.25 && f < 0.55, `fetch fraction ${(f * 100).toFixed(1)}% is outside the sane band — `
        + 'below 25% suggests land is being culled, above 55% suggests the bake did nothing');
});

console.log(`\n${passed} passed`);
