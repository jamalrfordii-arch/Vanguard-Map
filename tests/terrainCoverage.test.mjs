// tests/terrainCoverage.test.mjs — pin the measured Cesium terrain coverage limit.
// Run from repo root:  node tests/terrainCoverage.test.mjs
//
// These numbers came from probing the Ion origin directly (app bearer token,
// cache: 'reload' to bypass the service worker). They encode a fact about the DATA,
// not a tuning preference, so the tests exist mostly to stop someone "optimising"
// the boundary or making it symmetric by intuition. The southern hemisphere was
// measured to 60°S and is fine — SRTM's northern and southern limits are not
// mirror images, and assuming they were would silently delete real terrain.

import assert from 'node:assert/strict';
import { isBeyondTerrainCoverage, SRTM_NORTH_LIMIT_DEG, SRTM_FIRST_LIMITED_ZOOM }
    from '../terrainCoverage.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('the measured boundary');

test('constants match what was measured', () => {
    assert.equal(SRTM_NORTH_LIMIT_DEG, 60.0);
    assert.equal(SRTM_FIRST_LIMITED_ZOOM, 9);
});

test('z9+ above 60N is refused — the 404s observed at 60.5N and beyond', () => {
    for (const z of [9, 10, 11, 12, 13]) {
        for (const lat of [60.0, 60.5, 61, 65, 70, 84]) {
            assert.equal(isBeyondTerrainCoverage(z, lat), true, `z${z} at ${lat}N`);
        }
    }
});

test('z9+ below 60N is allowed — 56N..60N all returned 200', () => {
    for (const z of [9, 10, 11, 12]) {
        for (const lat of [59.5, 55, 38.5, 0, -25, -60]) {
            assert.equal(isBeyondTerrainCoverage(z, lat), false, `z${z} at ${lat}N`);
        }
    }
});

test('z8 and coarser are covered globally — measured 200 at 65N', () => {
    // z3-z8 come from non-SRTM sources. Gating them would blank the entire Arctic
    // at world/regional zoom, which is a far worse bug than the one being fixed.
    for (const z of [3, 4, 5, 6, 7, 8]) {
        for (const lat of [60, 65, 75, 84]) {
            assert.equal(isBeyondTerrainCoverage(z, lat), false, `z${z} at ${lat}N must be allowed`);
        }
    }
});

console.log('boundary handling');

test('gates on the SOUTH edge, so the straddling row is kept', () => {
    // The tile CONTAINING 60.0N was served (200). Gating on centre or north edge
    // would discard that row of real terrain all the way around the globe.
    assert.equal(isBeyondTerrainCoverage(11, 59.95), false, 'tile just below the line stays');
    assert.equal(isBeyondTerrainCoverage(11, 60.0),  true,  'tile starting AT the line is gone');
});

test('the limit is NOT symmetric — the far south must stay fetchable', () => {
    // Probed to 60°S: all 200. SRTM's southern limit is around 56°S but Cesium
    // evidently fills it from elsewhere. Mirroring the northern rule would delete
    // southern Chile, Argentina and the Antarctic approaches for no measured reason.
    for (const lat of [-54, -56, -58, -60, -70]) {
        assert.equal(isBeyondTerrainCoverage(11, lat), false, `${lat}N must remain fetchable`);
    }
});

console.log('robustness');

test('a non-finite latitude attempts the fetch rather than skipping it', () => {
    // Fail OPEN. A missing latitude is a bug in the caller, and the cost of trying
    // is one 404; the cost of wrongly skipping is a permanent hole in the map.
    for (const bad of [NaN, undefined, null, Infinity, -Infinity]) {
        assert.equal(isBeyondTerrainCoverage(11, bad), false, `${bad} should not suppress a fetch`);
    }
});

test('a non-numeric zoom does not suppress fetches either', () => {
    for (const z of [undefined, null, NaN, 'eleven']) {
        assert.equal(isBeyondTerrainCoverage(z, 70), false, `zoom ${z} should fail open`);
    }
});

console.log(`\n${passed} passed`);
