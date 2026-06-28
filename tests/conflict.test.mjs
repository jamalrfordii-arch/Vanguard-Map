// tests/conflict.test.mjs — Aerial conflict detection (CPA math) suite.
// Run from repo root:  node tests/conflict.test.mjs
// Pure node, no browser, no THREE — exercises conflictMath.js directly.

import assert from 'node:assert/strict';
import { evaluatePair, pairKey, toLocalNm } from '../conflictMath.js';
import { CONFLICT } from '../config.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// Two aircraft at the same latitude, separated in longitude, both at FL350,
// flying head-on toward each other on a collision course.
function headOn(sepNm, speedKts = 480) {
    const lat0 = 40;
    const dLon = sepNm / (60 * Math.cos(lat0 * Math.PI / 180)); // degrees longitude for sepNm
    const altMeters = 10668; // ~FL350
    return [
        { icao24: 'aaaaaa', callsign: 'AAL1', latDeg: lat0, lonDeg: -dLon / 2, altMeters,
          speedKts, headingDeg: 90, verticalRateMs: 0 },  // flying east, toward b
        { icao24: 'bbbbbb', callsign: 'UAL2', latDeg: lat0, lonDeg:  dLon / 2, altMeters,
          speedKts, headingDeg: 270, verticalRateMs: 0 }, // flying west, toward a
    ];
}

console.log('Aerial Conflict (CPA) suite\n');

test('pairKey is order-independent', () => {
    assert.equal(pairKey('aaaaaa', 'bbbbbb'), pairKey('bbbbbb', 'aaaaaa'));
});

test('toLocalNm: 1 degree latitude ≈ 60nm north', () => {
    const p = toLocalNm(1, 0, 0, 0);
    assert.ok(Math.abs(p.y - 60) < 0.01);
    assert.ok(Math.abs(p.x) < 0.01);
});

test('head-on pair already inside threshold, same altitude → CRITICAL', () => {
    const [a, b] = headOn(1.5); // 1.5nm apart right now, closing fast
    const r = evaluatePair(a, b);
    assert.ok(r, 'expected a conflict to be detected');
    assert.equal(r.severity, 'CRITICAL');
    assert.ok(r.horizontalNm <= CONFLICT.HORIZONTAL_NM);
    assert.ok(r.verticalFt < CONFLICT.VERTICAL_FT);
});

test('head-on pair currently far apart but converging within lookahead → flagged', () => {
    // 40nm apart, closing at ~960kt combined closure rate → CPA in ~150s,
    // well inside the 300s lookahead window, and CPA separation should be
    // ~0nm since this is a perfect head-on geometry.
    const [a, b] = headOn(40);
    const r = evaluatePair(a, b);
    assert.ok(r, 'expected convergence to be detected ahead of time');
    assert.ok(r.etaSec > 0 && r.etaSec <= CONFLICT.LOOKAHEAD_SEC);
});

test('head-on pair too far apart for the lookahead window → not flagged', () => {
    // At 480kt closing speed each (960kt combined), 5 minutes covers ~80nm
    // total closure. Put them far enough apart that CPA separation at the
    // lookahead horizon is still outside HORIZONTAL_NM.
    const [a, b] = headOn(500);
    const r = evaluatePair(a, b);
    assert.equal(r, null);
});

test('parallel same-direction traffic, laterally separated beyond threshold → not flagged', () => {
    const lat0 = 40;
    const altMeters = 10668;
    const a = { icao24: 'aaaaaa', callsign: 'A1', latDeg: lat0, lonDeg: 0, altMeters,
        speedKts: 450, headingDeg: 90, verticalRateMs: 0 };
    const b = { icao24: 'bbbbbb', callsign: 'B1', latDeg: lat0 + 1, lonDeg: 0, altMeters, // ~60nm north, same heading/speed → never converges
        speedKts: 450, headingDeg: 90, verticalRateMs: 0 };
    const r = evaluatePair(a, b);
    assert.equal(r, null);
});

test('horizontally close but vertically well separated → not flagged', () => {
    const [a, b] = headOn(1.0);
    b.altMeters += 3048; // +10,000ft separation, way outside VERTICAL_FT
    const r = evaluatePair(a, b);
    assert.equal(r, null);
});

test('horizontally close, vertically converging into threshold within lookahead → flagged', () => {
    const [a, b] = headOn(1.0);
    b.altMeters = a.altMeters + 1500 * 0.3048; // ~1500ft above, just outside VERTICAL_FT now
    b.verticalRateMs = -10; // descending fast enough to close the vertical gap
    const r = evaluatePair(a, b);
    assert.ok(r, 'expected vertical convergence to bring this into conflict');
});

test('slow aircraft below MIN_SPEED_KTS are excluded upstream (manager-level filter, not math)', () => {
    // evaluatePair itself doesn't filter on speed — that's ConflictManager.evaluate()'s
    // job (so taxiing/parked aircraft never reach the pairwise math at all).
    // Documented here so the split in responsibility doesn't get lost.
    assert.ok(CONFLICT.MIN_SPEED_KTS > 0);
});

console.log(`\n${passed} passed`);
