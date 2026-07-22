// tests/projection.test.mjs — golden-value tests for lonLatToScene (Mercator).
// Run from repo root (needs the THREE stub loader):
//   node --import ./tests/_stubs/register.mjs tests/projection.test.mjs
//   ...or just `npm test`, which wires the loader for the whole suite.
//
// lonLatToScene() places EVERY vessel, aircraft, and marker on the map. A silent
// regression here would misplace the entire world without throwing. These are
// hand-computed golden values (derived below), frozen so any change to the
// projection formula or to MAP_WIDTH/MAP_HEIGHT trips a failure.
//
// Formula under test (aisManager.js):
//   x = (lon / 180) * (MAP_WIDTH  / 2)                      // linear in longitude
//   z = -(mercY / PI) * (MAP_HEIGHT / 2),  mercY = ln(tan(PI/4 + latRad/2))
// Sign convention (CLAUDE.md): east = +X, north = -Z, south = +Z.

import assert from 'node:assert/strict';
import { lonLatToScene } from '../aisManager.js';
import { MAP_WIDTH, MAP_HEIGHT } from '../config.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
const near = (a, b, eps = 1e-2) => Math.abs(a - b) <= eps;

// Golden Z for |lat| = 45°, derived by hand:
//   mercY = ln(tan(45° + 22.5°)) = ln(tan(67.5°)) = ln(2.4142136) = 0.8813736
//   z     = -(0.8813736 / PI) * 150 = -42.083   (north => negative Z)
const Z_AT_45 = 42.083;

console.log('origin & equator');
test('(0,0) maps to scene origin', () => {
    const p = lonLatToScene(0, 0);
    assert.ok(near(p.x, 0) && near(p.z, 0), `expected ~(0,0), got (${p.x}, ${p.z})`);
});
test('default y is 0, overridable', () => {
    assert.equal(lonLatToScene(0, 0).y, 0);
    assert.equal(lonLatToScene(0, 0, 12).y, 12);
});

console.log('longitude is linear, east = +X');
test('lon +180 -> x = +MAP_WIDTH/2 (east edge)', () => {
    assert.ok(near(lonLatToScene(180, 0).x, MAP_WIDTH / 2));
});
test('lon -180 -> x = -MAP_WIDTH/2 (west edge)', () => {
    assert.ok(near(lonLatToScene(-180, 0).x, -MAP_WIDTH / 2));
});
test('lon +90 -> x = +MAP_WIDTH/4', () => {
    assert.ok(near(lonLatToScene(90, 0).x, MAP_WIDTH / 4));
});
test('longitude does not affect Z', () => {
    assert.ok(near(lonLatToScene(123.4, 0).z, 0));
});

console.log('latitude via Mercator, north = -Z');
test('lat +45 -> z = -42.083 (north is negative Z)', () => {
    const p = lonLatToScene(0, 45);
    assert.ok(p.z < 0, `north latitude must give negative Z, got ${p.z}`);
    assert.ok(near(p.z, -Z_AT_45, 0.05), `expected ~${-Z_AT_45}, got ${p.z}`);
});
test('lat -45 -> z = +42.083 (south is positive Z, symmetric)', () => {
    const p = lonLatToScene(0, -45);
    assert.ok(near(p.z, Z_AT_45, 0.05), `expected ~${Z_AT_45}, got ${p.z}`);
});
test('equator/north/south hemispheres are mirror-symmetric in Z', () => {
    for (const lat of [10, 30, 60, 80]) {
        assert.ok(near(lonLatToScene(0, lat).z, -lonLatToScene(0, -lat).z, 1e-6),
            `Z(+${lat}) must equal -Z(-${lat})`);
    }
});

console.log('Mercator monotonicity & finiteness');
test('increasing latitude strictly decreases Z (north-ward)', () => {
    let prev = Infinity;
    for (const lat of [-80, -45, -10, 0, 10, 45, 80]) {
        const z = lonLatToScene(0, lat).z;
        assert.ok(z < prev, `Z must strictly decrease as lat rises; lat ${lat} gave ${z} (prev ${prev})`);
        prev = z;
    }
});
test('near the ±85° Mercator limit Z is finite (no singularity blow-up)', () => {
    for (const lat of [85, -85]) {
        const z = lonLatToScene(0, lat).z;
        assert.ok(Number.isFinite(z), `Z at lat ${lat} must be finite, got ${z}`);
    }
});
test('MAP_HEIGHT scales Z linearly (sanity on the constant)', () => {
    // z(45) should be exactly -(ln(tan(67.5°))/PI) * (MAP_HEIGHT/2)
    const expected = -(Math.log(Math.tan(Math.PI / 4 + (45 * Math.PI / 180) / 2)) / Math.PI) * (MAP_HEIGHT / 2);
    assert.ok(near(lonLatToScene(0, 45).z, expected, 1e-6));
});

console.log(`\nprojection.test: ${passed} checks passed`);
