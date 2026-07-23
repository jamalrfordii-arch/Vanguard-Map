// tests/altitude.test.mjs — the vertical scale + flight-level band selection.
// Run from repo root (needs the THREE stub loader; npm test wires it):
//   node --import ./tests/_stubs/register.mjs tests/altitude.test.mjs
//
// altitudeMetersToY is the single source of vertical truth: it places every
// aircraft AND (via the same import) every altitude-deck grid line. altitudeBandIndex
// decides which deck is highlighted under the selected aircraft. Both are frozen
// here so the deck grids can never drift from where planes render, and so the
// deck-highlight bug fixed on 2026-07-22 (nearest-flight-level → containing-band)
// can't regress.

import assert from 'node:assert/strict';
import { altitudeMetersToY, altitudeBandIndex } from '../flightManager.js';
import { FLIGHT } from '../config.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
const FT_TO_M = 0.3048;
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

console.log('altitudeMetersToY — scene Y at the real flight levels');
test('FL180 → Y ≈ 11.14', () => assert.ok(near(altitudeMetersToY(18000 * FT_TO_M), 11.14, 0.01)));
test('FL290 → Y ≈ 16.73', () => assert.ok(near(altitudeMetersToY(29000 * FT_TO_M), 16.73, 0.01)));
test('FL410 → Y ≈ 22.83', () => assert.ok(near(altitudeMetersToY(41000 * FT_TO_M), 22.83, 0.01)));
test('the base/scale constants come from config (not hardcoded)', () => {
    const alt = 8000; // metres, above the floor
    const expected = FLIGHT.ALT_Y_BASE + alt * (FLIGHT.ALT_Y_SPAN_UNITS / FLIGHT.ALT_Y_SPAN_M);
    assert.ok(near(altitudeMetersToY(alt), expected, 1e-9));
});

console.log('floor & ceiling behaviour');
test('at/below the tracking floor an aircraft sits at ALT_Y_BASE', () => {
    assert.equal(altitudeMetersToY(0), FLIGHT.ALT_Y_BASE);
    assert.equal(altitudeMetersToY(FLIGHT.MIN_ALT_M), FLIGHT.ALT_Y_BASE);
    assert.equal(altitudeMetersToY(-500), FLIGHT.ALT_Y_BASE, 'negative/bad low data floors, never goes below base');
});
test('altitude is CLAMPED at ALT_CEIL_M — bad data cannot fly off-scale', () => {
    const ceilY = altitudeMetersToY(FLIGHT.ALT_CEIL_M);
    // 100,000 ft (~30,480 m) is well above the ceiling → must render AT the clamp, not above.
    assert.equal(altitudeMetersToY(100000 * FT_TO_M), ceilY,
        'an absurd altitude renders at the ceiling Y, not somewhere off-scale');
    assert.ok(ceilY < 40, `ceiling Y (${ceilY.toFixed(1)}) stays in a sane range`);
});
test('Y increases monotonically with altitude up to the clamp', () => {
    let prev = -Infinity;
    for (const m of [0, 1000, 3000, 6000, 9000, 12000, 15000, 18000]) {
        const y = altitudeMetersToY(m);
        assert.ok(y >= prev, `Y must not decrease as altitude rises (m=${m})`);
        prev = y;
    }
});

console.log('altitudeBandIndex — containing band, not nearest flight level');
const CEILINGS = [18000, 29000, 41000]; // the three deck ceilings (ft)
test('altitudes map to the band that CONTAINS them', () => {
    const cases = [
        [5000, 0], [17000, 0], [18000, 0],   // 0–18k band
        [18001, 1], [23500, 1], [29000, 1],  // 18–29k band
        [29001, 2], [35000, 2], [41000, 2],  // 29–41k band
    ];
    for (const [ft, idx] of cases) {
        assert.equal(altitudeBandIndex(ft, CEILINGS), idx, `${ft}ft should be band ${idx}`);
    }
});
test('the previously-mis-highlighted cruise altitudes now pick the right band', () => {
    // These are exactly the altitudes the old nearest-flight-level logic got wrong.
    assert.equal(altitudeBandIndex(20000, CEILINGS), 1, 'FL200 is in the 18–29k band, not 0–18k');
    assert.equal(altitudeBandIndex(33000, CEILINGS), 2, 'FL330 is in the 29–41k band, not 18–29k');
    assert.equal(altitudeBandIndex(35000, CEILINGS), 2, 'FL350 is in the 29–41k band, not 18–29k');
});
test('altitudes above the top ceiling clamp to the top band', () => {
    assert.equal(altitudeBandIndex(60000, CEILINGS), 2);
});

console.log(`\naltitude.test: ${passed} checks passed`);
