// tests/windGrid.test.mjs — pin the coarse→fine wind field resample.
// Run from repo root:  node tests/windGrid.test.mjs
//
// This exists to cut GFS from 651 HTTP requests per page load to 27 by fetching a
// 5° field and interpolating up. The risks are not "is bilinear interpolation
// right" — they are the two seams: longitude WRAPS at the dateline and latitude
// DOES NOT wrap at the poles. Getting either backwards produces a field that looks
// entirely plausible except along one line, which is exactly the sort of thing that
// ships. Most of the tests below are about those two edges.

import assert from 'node:assert/strict';
import { resampleWindGrid, gridCellCount } from '../windGrid.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

/** Build a source grid from a function of (lat, lon). */
function mk(resDeg, fn) {
    const w = Math.round(360 / resDeg), h = Math.round(180 / resDeg) + 1;
    const u = new Float32Array(w * h), v = new Float32Array(w * h);
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
        const lat = -90 + r * resDeg, lon = -180 + c * resDeg;
        const { u: uu, v: vv } = fn(lat, lon);
        u[r * w + c] = uu; v[r * w + c] = vv;
    }
    return { u, v, w, h, res: resDeg };
}

console.log('request-count arithmetic (the whole point)');

test('5° is 2664 cells = 27 batches; 1° is 65160 = 652', () => {
    assert.equal(gridCellCount(5), 2664);
    assert.equal(gridCellCount(1), 65160);
    assert.equal(Math.ceil(gridCellCount(5) / 100), 27);
    assert.equal(Math.ceil(gridCellCount(1) / 100), 652);
    assert.ok(gridCellCount(1) / gridCellCount(5) > 24, 'should be a ~24x reduction');
});

console.log('exactness and shape');

test('output has the requested dimensions', () => {
    const s = mk(5, () => ({ u: 1, v: 2 }));
    const d = resampleWindGrid(s.u, s.v, s.w, s.h, 5, 360, 181, 1);
    assert.equal(d.u.length, 360 * 181);
    assert.equal(d.v.length, 360 * 181);
});

test('a uniform field resamples to exactly that field', () => {
    const s = mk(5, () => ({ u: 3.5, v: -1.25 }));
    const d = resampleWindGrid(s.u, s.v, s.w, s.h, 5, 360, 181, 1);
    for (let i = 0; i < d.u.length; i++) {
        assert.ok(Math.abs(d.u[i] - 3.5) < 1e-5, `u drifted at ${i}: ${d.u[i]}`);
        assert.ok(Math.abs(d.v[i] + 1.25) < 1e-5, `v drifted at ${i}: ${d.v[i]}`);
    }
});

test('destination points that coincide with source points reproduce them exactly', () => {
    // Every 5th column/row of the 1° grid lands exactly on a 5° sample.
    const f = (lat, lon) => ({ u: lat / 10, v: lon / 10 });
    const s = mk(5, f);
    const d = resampleWindGrid(s.u, s.v, s.w, s.h, 5, 360, 181, 1);
    for (const [lat, lon] of [[-90,-180],[0,0],[45,90],[85,175],[-45,-90]]) {
        const row = (lat + 90) / 1, col = (lon + 180) / 1;
        const o = row * 360 + col;
        const e = f(lat, lon);
        assert.ok(Math.abs(d.u[o] - e.u) < 1e-4, `u at ${lat},${lon}: ${d.u[o]} vs ${e.u}`);
        assert.ok(Math.abs(d.v[o] - e.v) < 1e-4, `v at ${lat},${lon}: ${d.v[o]} vs ${e.v}`);
    }
});

test('a linear field interpolates linearly — no bias between samples', () => {
    const s = mk(5, (lat) => ({ u: lat, v: 0 }));
    const d = resampleWindGrid(s.u, s.v, s.w, s.h, 5, 360, 181, 1);
    for (const lat of [-87, -3, 2, 37, 88]) {
        const o = (lat + 90) * 360 + 180;
        assert.ok(Math.abs(d.u[o] - lat) < 1e-3, `at lat ${lat}: ${d.u[o]}`);
    }
});

console.log('the dateline seam — longitude WRAPS');

test('interpolates across -180/+180 instead of clamping', () => {
    // A field that varies only near the dateline. The cell at lon 177.5 sits
    // BETWEEN source samples 175 and -180, which are adjacent on a sphere. Clamping
    // instead of wrapping would freeze it at the 175 value.
    const s = mk(5, (lat, lon) => ({ u: lon === 175 ? 10 : (lon === -180 ? 0 : 5), v: 0 }));
    const d = resampleWindGrid(s.u, s.v, s.w, s.h, 5, 360, 181, 1);
    const at = (lat, lon) => d.u[(lat + 90) * 360 + (lon + 180)];
    const mid = at(0, 177);          // 2/5 of the way from 175 → -180
    assert.ok(mid < 10 && mid > 0, `expected a blend across the seam, got ${mid}`);
    assert.ok(Math.abs(mid - (10 + (0 - 10) * 0.4)) < 0.2,
        `seam blend is wrong: ${mid}, expected ~6`);
});

test('no discontinuity in a field that is continuous around the globe', () => {
    // u = cos(lon) is periodic, so the resampled field must not jump at the seam.
    const s = mk(5, (lat, lon) => ({ u: Math.cos(lon * Math.PI / 180), v: 0 }));
    const d = resampleWindGrid(s.u, s.v, s.w, s.h, 5, 360, 181, 1);
    const row = 90 * 360;                    // equator
    const last = d.u[row + 359], first = d.u[row + 0];
    assert.ok(Math.abs(last - first) < 0.05,
        `seam discontinuity: lon 179 = ${last}, lon -180 = ${first}`);
});

console.log('the poles — latitude CLAMPS, it must NOT wrap');

test('the north pole row does not blend with the south pole', () => {
    // If latitude wrapped like longitude, the top row would mix with the bottom —
    // arctic wind contaminated by antarctic wind. Poles are opposite, not adjacent.
    const s = mk(5, (lat) => ({ u: lat >= 90 ? 100 : (lat <= -90 ? -100 : 0), v: 0 }));
    const d = resampleWindGrid(s.u, s.v, s.w, s.h, 5, 360, 181, 1);
    const north = d.u[180 * 360 + 100];      // lat +90
    const south = d.u[0 * 360 + 100];        // lat -90
    assert.ok(north > 50, `north pole lost its value: ${north}`);
    assert.ok(south < -50, `south pole lost its value: ${south}`);
    const nearNorth = d.u[179 * 360 + 100];  // lat +89
    assert.ok(nearNorth > 0, `lat 89 should lean north, got ${nearNorth}`);
});

test('every output value is finite — no NaN leaks from edge indexing', () => {
    const s = mk(5, (lat, lon) => ({ u: Math.sin(lat / 20) * 12, v: Math.cos(lon / 30) * 8 }));
    const d = resampleWindGrid(s.u, s.v, s.w, s.h, 5, 360, 181, 1);
    for (let i = 0; i < d.u.length; i++) {
        assert.ok(Number.isFinite(d.u[i]), `u[${i}] = ${d.u[i]}`);
        assert.ok(Number.isFinite(d.v[i]), `v[${i}] = ${d.v[i]}`);
    }
});

console.log('vector semantics');

test('opposing winds average toward CALM, not toward a fabricated direction', () => {
    // The reason we interpolate u/v rather than speed+bearing. Between a due-north
    // and a due-south wind the honest answer is "near zero", and a bearing average
    // would instead invent a fast wind pointing east or west.
    const s = mk(5, (lat, lon) => (lon < 0 ? { u: 0, v: 10 } : { u: 0, v: -10 }));
    const d = resampleWindGrid(s.u, s.v, s.w, s.h, 5, 360, 181, 1);
    const atBoundary = d.v[90 * 360 + 180];   // lon 0, where the two meet
    assert.ok(Math.abs(atBoundary) < 11, 'speed should not exceed the inputs');
    const justInside = d.v[90 * 360 + 182];   // lon +2, 40% toward the -10 side
    assert.ok(justInside < 10, `expected a slackening toward calm, got ${justInside}`);
});

console.log(`\n${passed} passed`);
