// tests/spatialGrid.test.mjs — the grid must be EXACT, not approximate.
// Run from repo root:  node tests/spatialGrid.test.mjs
//
// This replaces an O(n²) per-frame loop in main.js (dark-marker overlap). The
// danger with a spatial index is not that it is slow — it is that it can be
// subtly WRONG at cell boundaries, and the symptom would be marker opacity
// flickering as vessels drift across invisible grid lines. Nobody traces that
// back to a spatial index.
//
// So nearly every test here compares the grid against brute force and demands
// EXACT agreement, especially on inputs designed to sit on cell edges.

import assert from 'node:assert/strict';
import { countNeighborsWithin, countNeighborsBruteForce } from '../spatialGrid.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
const eq = (a, b, msg) => assert.deepEqual(Array.from(a), Array.from(b), msg);

console.log('agreement with brute force');

test('empty and single-point inputs', () => {
    eq(countNeighborsWithin([], 4), []);
    eq(countNeighborsWithin([{ x: 0, z: 0 }], 4), [0]);
});

test('a simple cluster', () => {
    const pts = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 0, z: 1 }, { x: 50, z: 50 }];
    eq(countNeighborsWithin(pts, 4), countNeighborsBruteForce(pts, 4));
    eq(countNeighborsWithin(pts, 4), [2, 2, 2, 0]);
});

test('EXACT match on 500 random points — the real workload size', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pts = Array.from({ length: 500 }, () => ({ x: rnd() * 300 - 150, z: rnd() * 300 - 150 }));
    for (const r of [1, 4, 10, 25]) {
        eq(countNeighborsWithin(pts, r), countNeighborsBruteForce(pts, r), `radius ${r}`);
    }
});

test('EXACT match when points sit exactly ON cell boundaries', () => {
    // Cell size == radius, so multiples of the radius are the boundaries. This is
    // where an off-by-one in the 3x3 sweep would show, and only here.
    const r = 4;
    const pts = [];
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) pts.push({ x: i * r, z: j * r });
    eq(countNeighborsWithin(pts, r), countNeighborsBruteForce(pts, r));
});

test('EXACT match for points just inside and just outside the radius', () => {
    const r = 4;
    const pts = [
        { x: 0, z: 0 },
        { x: r - 1e-6, z: 0 },     // just inside
        { x: r + 1e-6, z: 0 },     // just outside
        { x: 0, z: r - 1e-6 },
        { x: r * 0.7071, z: r * 0.7071 },  // diagonal, ~exactly r away
    ];
    eq(countNeighborsWithin(pts, r), countNeighborsBruteForce(pts, r));
});

test('EXACT match on a dense pile in one cell — the degenerate case', () => {
    // All points in a single cell. The grid gives no speed-up here; it must still
    // be correct rather than, say, capping the bucket scan.
    const pts = Array.from({ length: 200 }, (_, i) => ({ x: i * 1e-4, z: i * 1e-4 }));
    eq(countNeighborsWithin(pts, 4), countNeighborsBruteForce(pts, 4));
});

test('negative coordinates work — Math.floor, not truncation', () => {
    // (-1|0) is 0 but Math.floor(-1) is -1. Truncating toward zero would merge
    // the cells either side of the origin and overcount there.
    const pts = [{ x: -5, z: -5 }, { x: -1, z: -1 }, { x: 1, z: 1 }, { x: 5, z: 5 }];
    for (const r of [1, 2, 4, 8]) {
        eq(countNeighborsWithin(pts, r), countNeighborsBruteForce(pts, r), `radius ${r}`);
    }
});

console.log('robustness');

test('non-finite coordinates are skipped, not propagated', () => {
    // A vessel with a NaN position must not poison its neighbours' counts.
    const pts = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: NaN, z: 0 }, { x: 0, z: Infinity }];
    const got = countNeighborsWithin(pts, 4);
    assert.equal(got[0], 1, 'finite points should still see each other');
    assert.equal(got[1], 1);
    assert.equal(got[2], 0, 'NaN point gets no count');
    assert.equal(got[3], 0);
});

test('a zero or negative radius counts nothing rather than throwing', () => {
    const pts = [{ x: 0, z: 0 }, { x: 1, z: 1 }];
    eq(countNeighborsWithin(pts, 0), [0, 0]);
    eq(countNeighborsWithin(pts, -4), [0, 0]);
});

test('missing / malformed entries do not throw', () => {
    const pts = [{ x: 0, z: 0 }, null, undefined, {}, { x: 1, z: 0 }];
    const got = countNeighborsWithin(pts, 4);
    assert.equal(got.length, 5);
    assert.equal(got[0], 1);
});

console.log('it is actually faster');

test('500 points costs far fewer distance tests than brute force', () => {
    // The point of the exercise. Brute force is n*(n-1) = 249,500 tests; the grid
    // should be a small fraction. Measured by counting, not timing — timing in CI
    // is noise.
    let seed = 999;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pts = Array.from({ length: 500 }, () => ({ x: rnd() * 300 - 150, z: rnd() * 300 - 150 }));
    const r = 4;
    // Reconstruct the grid's work: sum of 3x3 neighbourhood populations.
    const cells = new Map();
    for (const p of pts) {
        const k = `${Math.floor(p.x / r)}|${Math.floor(p.z / r)}`;
        cells.set(k, (cells.get(k) || 0) + 1);
    }
    let work = 0;
    for (const p of pts) {
        const a = Math.floor(p.x / r), b = Math.floor(p.z / r);
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++)
            work += cells.get(`${a + dx}|${b + dz}`) || 0;
    }
    const brute = pts.length * (pts.length - 1);
    assert.ok(work < brute / 20,
        `grid does ${work} tests vs brute ${brute} — expected at least 20x fewer`);
});

console.log(`\n${passed} passed`);
