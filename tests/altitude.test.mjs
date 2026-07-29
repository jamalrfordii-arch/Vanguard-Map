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
import { altitudeMetersToY, altitudeBandIndex, smoothVerticalRate, altitudeRibbonDeltaY } from '../flightManager.js';
import { FLIGHT, FLIGHT_DYNAMICS } from '../config.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
const FT_TO_M = 0.3048;
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

console.log('altitudeMetersToY — non-linear (power-curve) scene Y');
const _B = FLIGHT.ALT_Y_BASE, _CEIL = FLIGHT.ALT_CEIL_M, _MIN = FLIGHT.MIN_ALT_M;
const _TOTAL = _CEIL * (FLIGHT.ALT_Y_SPAN_UNITS / FLIGHT.ALT_Y_SPAN_M);
const expectedY = (m) => _B + _TOTAL * Math.pow((Math.min(m, _CEIL) - _MIN) / (_CEIL - _MIN), FLIGHT.ALT_Y_GAMMA);

test('deck heights follow the documented power curve (from config, not hardcoded)', () => {
    for (const fl of [18000, 29000, 41000]) {
        assert.ok(near(altitudeMetersToY(fl * FT_TO_M), expectedY(fl * FT_TO_M), 1e-6),
            `FL${fl / 100} matches the config-driven curve`);
    }
});
test('flight-level decks ascend and stay within the scene envelope', () => {
    const y180 = altitudeMetersToY(18000 * FT_TO_M);
    const y290 = altitudeMetersToY(29000 * FT_TO_M);
    const y410 = altitudeMetersToY(41000 * FT_TO_M);
    assert.ok(y180 < y290 && y290 < y410, 'decks ascend');
    assert.ok(y410 < altitudeMetersToY(_CEIL), 'all below the ceiling');
});
test('the low/terminal band is EXPANDED vs the thin upper air (the whole point)', () => {
    const unitsLow  = altitudeMetersToY(10000 * FT_TO_M) - altitudeMetersToY(0);                 // 0→10k ft
    const unitsHigh = altitudeMetersToY(41000 * FT_TO_M) - altitudeMetersToY(31000 * FT_TO_M);   // 31k→41k ft (same 10k span)
    assert.ok(unitsLow > unitsHigh,
        `low 10k ft (${unitsLow.toFixed(1)}u) must get more height than high 10k ft (${unitsHigh.toFixed(1)}u)`);
});
test('top of scale is pinned (scene framing unchanged from the linear map)', () => {
    assert.ok(near(altitudeMetersToY(_CEIL), _B + _TOTAL, 1e-6));
    assert.ok(near(_B + _TOTAL, 32.5, 0.2), 'still ~32.5 scene units at the ceiling');
});
test('gamma = 1 would reproduce a linear scale (curve reduces correctly)', () => {
    // Pure check of the formula's linear limit, independent of the configured gamma.
    const linAt = (m) => _B + _TOTAL * ((Math.min(m, _CEIL) - _MIN) / (_CEIL - _MIN)); // pow(t,1)=t
    const t = 0.5, m = _MIN + t * (_CEIL - _MIN);
    assert.ok(near(linAt(m), _B + _TOTAL * 0.5, 1e-9), 'midpoint is halfway up at gamma 1');
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

console.log('canonical altitude-band taxonomy (glow = deck = panel)');
test('ALT_BANDS ceilings ascend and end open-topped', () => {
    const c = FLIGHT.ALT_BANDS.map(b => b.ceilFt);
    for (let i = 1; i < c.length; i++) assert.ok(c[i] > c[i - 1], `ceilings ascend at ${i}`);
    assert.equal(c.at(-1), Infinity, 'the top band is open (41,000+)');
});
test('the finite bands are the real deck flight levels, in the deck colours', () => {
    const finite = FLIGHT.ALT_BANDS.filter(b => Number.isFinite(b.ceilFt));
    assert.deepEqual(finite.map(b => b.ceilFt), [18000, 29000, 41000]);
    // These are the exact colours the decks render — locking "glow matches deck".
    assert.deepEqual(finite.map(b => b.color), [0x40c4ff, 0xffab40, 0xd9b3ff]);
});
test('altitude → band maps the same way the glow/deck/panel now all use', () => {
    const ceil = FLIGHT.ALT_BANDS.map(b => b.ceilFt);
    assert.equal(altitudeBandIndex(10000, ceil), 0, '10k → 0–18k (blue)');
    assert.equal(altitudeBandIndex(20000, ceil), 1, '20k → 18–29k (amber)');
    assert.equal(altitudeBandIndex(33000, ceil), 2, '33k → 29–41k (purple)');
    assert.equal(altitudeBandIndex(45000, ceil), 3, '45k → 41k+ (pink, the open top band)');
});
test('every band carries a colour, a deck label, and a panel label', () => {
    for (const b of FLIGHT.ALT_BANDS) {
        assert.equal(typeof b.color, 'number');
        assert.ok(b.label && b.flLabel, 'both label styles present');
    }
});

console.log('smoothVerticalRate — EMA damping of the noisy per-poll rate');
const A = FLIGHT_DYNAMICS.VERTICAL_RATE_EMA;
test('first sample (null/undefined prev) passes through unsmoothed', () => {
    assert.equal(smoothVerticalRate(null, 7.3, A), 7.3);
    assert.equal(smoothVerticalRate(undefined, -4, A), -4);
});
test('subsequent samples blend toward the new reading by alpha', () => {
    assert.ok(near(smoothVerticalRate(0, 10, 0.4), 4, 1e-9), '0→10 at α=0.4 gives 4');
    assert.ok(near(smoothVerticalRate(10, 0, 0.4), 6, 1e-9), '10→0 at α=0.4 gives 6');
});
test('a single spike is damped, not passed through whole', () => {
    // steady ~5 m/s climb, then one 40 m/s quantization spike
    let vr = smoothVerticalRate(null, 5, A);     // 5
    vr = smoothVerticalRate(vr, 5, A);           // ~5
    const spiked = smoothVerticalRate(vr, 40, A);
    assert.ok(spiked < 40 * 0.6, `spike damped well below raw (got ${spiked.toFixed(1)})`);
    assert.ok(spiked > vr, 'but still moves toward the spike');
});
test('a sustained climb converges to the true rate', () => {
    let vr = null;
    for (let i = 0; i < 20; i++) vr = smoothVerticalRate(vr, 8, A);
    assert.ok(near(vr, 8, 0.1), `converges to the steady 8 m/s (got ${vr.toFixed(2)})`);
});
test('bad prev/raw never yields NaN', () => {
    assert.ok(Number.isFinite(smoothVerticalRate(NaN, 5, A)), 'NaN prev → treated as first sample');
});

console.log('altitudeRibbonDeltaY — climb/descent tail length in scene units');
test('level or null rate → zero-length ribbon', () => {
    assert.equal(altitudeRibbonDeltaY(9000, 0, 90), 0);
    assert.equal(altitudeRibbonDeltaY(9000, null, 90), 0);
});
test('climbing → positive (up), descending → negative (down)', () => {
    assert.ok(altitudeRibbonDeltaY(6000, 10, 90) > 0, 'climb points up');
    assert.ok(altitudeRibbonDeltaY(6000, -10, 90) < 0, 'descent points down');
});
test('symmetric-ish: a climb and matching descent are opposite in sign', () => {
    const up = altitudeRibbonDeltaY(6000, 8, 90);
    const dn = altitudeRibbonDeltaY(6000, -8, 90);
    assert.ok(up > 0 && dn < 0);
});
test('same climb rate draws a LONGER ribbon down low than up high (curve-aware)', () => {
    const low  = altitudeRibbonDeltaY(1500, 10, 90);   // ~FL050, expanded band
    const high = altitudeRibbonDeltaY(11000, 10, 90);  // ~FL360, compressed band
    assert.ok(low > high, `low ribbon (${low.toFixed(2)}u) should exceed high (${high.toFixed(2)}u)`);
});
test('descent near the ground clamps at the floor (no negative altitude)', () => {
    // Descending hard from 200 m: projected altitude floors at 0, ribbon stays finite.
    const dY = altitudeRibbonDeltaY(200, -50, 90);
    assert.ok(Number.isFinite(dY) && dY <= 0);
});

console.log(`\naltitude.test: ${passed} checks passed`);
