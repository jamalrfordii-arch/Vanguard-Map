// tests/hemisphericRule.test.mjs — the "wrong-way flight level" detector.
// Run from repo root:  node tests/hemisphericRule.test.mjs
// Pure node, no browser, no THREE.
//
// Locks the ICAO hemispheric-rule logic: eastbound (000–179°) flies ODD flight
// levels, westbound (180–359°) flies EVEN, scoped to the RVSM band (FL290–FL410),
// and only for aircraft actually established at a level. Every "wrong-way" hit is
// an advisory, so the emphasis here is on NOT crying wolf: climbers, out-of-band
// traffic, and headingless reports must all return null.

import assert from 'node:assert/strict';
import { hemisphericLevelCheck as chk } from '../hemisphericRule.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
const FT = (fl) => fl * 100; // FL310 → 31000 ft

console.log('compliant cruise levels → not wrong-way');
test('eastbound at an odd FL (FL310) is correct', () => {
    const r = chk(FT(310), 90); // due east
    assert.ok(r && !r.wrongWay, 'FL310 eastbound is compliant');
    assert.equal(r.expectedParity, 'odd');
});
test('westbound at an even FL (FL320) is correct', () => {
    const r = chk(FT(320), 270); // due west
    assert.ok(r && !r.wrongWay);
    assert.equal(r.expectedParity, 'even');
});
test('RVSM band edges: FL290 eastbound and FL410 eastbound are compliant', () => {
    assert.ok(!chk(FT(290), 90).wrongWay, 'FL290 (odd) eastbound ok');
    assert.ok(!chk(FT(410), 90).wrongWay, 'FL410 (odd) eastbound ok');
});

console.log('wrong-way levels → flagged');
test('eastbound at an even FL (FL300) is wrong-way', () => {
    const r = chk(FT(300), 90);
    assert.ok(r.wrongWay, 'FL300 eastbound violates the rule');
    assert.equal(r.actualParity, 'even');
    assert.equal(r.expectedParity, 'odd');
});
test('westbound at an odd FL (FL310) is wrong-way', () => {
    assert.ok(chk(FT(310), 270).wrongWay);
});

console.log('heading boundaries & wrapping');
test('000° and 179° are eastbound; 180° and 359° are westbound', () => {
    assert.equal(chk(FT(310), 0).eastbound, true);
    assert.equal(chk(FT(310), 179).eastbound, true);
    assert.equal(chk(FT(310), 180).eastbound, false);
    assert.equal(chk(FT(310), 359).eastbound, false);
});
test('headings normalise (350°, -10°, 370°)', () => {
    assert.equal(chk(FT(310), 350).eastbound, false, '350° is westbound');
    assert.equal(chk(FT(310), -10).eastbound, false, '-10° → 350° westbound');
    assert.equal(chk(FT(310), 370).eastbound, true,  '370° → 010° eastbound');
});

console.log('does NOT cry wolf');
test('within tolerance of a level still counts (FL310 + 150 ft)', () => {
    assert.ok(!chk(FT(310) + 150, 90).wrongWay, 'FL310+150 eastbound still reads as FL310');
});
test('mid-transition (FL315, 500 ft off a level) returns null', () => {
    assert.equal(chk(FT(315), 90), null);
});
test('below the RVSM band (FL250) returns null', () => {
    assert.equal(chk(FT(250), 90), null);
});
test('above the RVSM band (FL450) returns null', () => {
    assert.equal(chk(FT(450), 90), null);
});
test('missing / non-finite heading returns null', () => {
    assert.equal(chk(FT(310), null), null);
    assert.equal(chk(FT(310), NaN), null);
});
test('non-finite altitude returns null', () => {
    assert.equal(chk(NaN, 90), null);
});
test('custom band bounds are honoured', () => {
    // Narrow the band so FL290 falls outside it.
    assert.equal(chk(FT(290), 90, { bandLoFt: 31000 }), null);
});

console.log(`\nhemisphericRule.test: ${passed} checks passed`);
