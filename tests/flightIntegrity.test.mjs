// tests/flightIntegrity.test.mjs — Aerial Integrity scoring suite.
// Run from repo root:  node tests/flightIntegrity.test.mjs
// Pure node, no browser, no THREE; time is stubbed via simClock override.

import assert from 'node:assert/strict';
import { flightIntegrityManager as FIM } from '../flightIntegrityManager.js';
import { FLIGHT_INTEGRITY } from '../config.js';
import { simClock } from '../simClock.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// ── Controllable environment ─────────────────────────────────────────────────
let T = 1_000_000;        // fake "now" (ms)
simClock.now = () => T;    // override the singleton clock

const reset = () => FIM.records.clear();
const report = (icao24, over = {}) => ({
    icao24, callsign: over.callsign || 'TEST1',
    lat: over.lat ?? 0, lon: over.lon ?? 0,
    altMeters: over.altMeters ?? 10000,
    speedKts: over.speedKts ?? 450,
    headingDeg: over.headingDeg ?? 90,
    squawk: over.squawk ?? '2000',
    emergency: over.emergency ?? null,
    now: over.now ?? T,
});

console.log('Aerial Integrity suite\n');

test('clean aircraft → 100 / TRUSTED', () => {
    reset();
    FIM.evaluate(report('a1b2c3'));
    const r = FIM.getRecord('a1b2c3');
    assert.equal(r.score, 100);
    assert.equal(r.tier, 'TRUSTED');
});

test('malformed ICAO24 → ICAO_INVALID flag', () => {
    reset();
    FIM.evaluate(report('xyz')); // not 6 hex chars
    assert.ok(FIM.getRecord('xyz').flags.has('ICAO_INVALID'));
    reset();
    FIM.evaluate(report('000000')); // reserved all-zero
    assert.ok(FIM.getRecord('000000').flags.has('ICAO_INVALID'));
    assert.equal(FIM.getRecord('000000').score, 100 - FLIGHT_INTEGRITY.WEIGHTS.ICAO_INVALID);
});

test('emergency squawk 7700 → EMERGENCY flag, score drops', () => {
    reset();
    FIM.evaluate(report('a1b2c4', { squawk: '7700' }));
    const r = FIM.getRecord('a1b2c4');
    assert.ok(r.flags.has('EMERGENCY'));
    assert.equal(r.score, 100 - FLIGHT_INTEGRITY.WEIGHTS.EMERGENCY);
    assert.equal(r.tier, 'QUESTIONABLE'); // 50, boundary of TIER_QUESTIONABLE
});

test('ADS-B emergency field set (non-squawk) → EMERGENCY flag', () => {
    reset();
    FIM.evaluate(report('a1b2c5', { squawk: '2000', emergency: 'lifeguard' }));
    assert.ok(FIM.getRecord('a1b2c5').flags.has('EMERGENCY'));
});

test('emergency clears once squawk/field return to normal', () => {
    reset();
    FIM.evaluate(report('a1b2c6', { squawk: '7700' }));
    assert.ok(FIM.getRecord('a1b2c6').flags.has('EMERGENCY'));
    T += 5000;
    FIM.evaluate(report('a1b2c6', { squawk: '2000', now: T }));
    assert.ok(!FIM.getRecord('a1b2c6').flags.has('EMERGENCY'));
    assert.equal(FIM.getRecord('a1b2c6').score, 100);
});

test('teleport-grade jump → IMPOSSIBLE_SPEED (reject-grade flag), not EXCESSIVE_SPEED', () => {
    reset();
    FIM.evaluate(report('a1b2c7', { lat: 0, lon: 0, now: T }));
    T += 10_000; // 10s later, 50 degrees of longitude away — impossible
    FIM.evaluate(report('a1b2c7', { lat: 0, lon: 50, now: T }));
    const r = FIM.getRecord('a1b2c7');
    assert.ok(r.flags.has('IMPOSSIBLE_SPEED'));
    assert.ok(!r.flags.has('EXCESSIVE_SPEED'));
    assert.equal(r.score, 100 - FLIGHT_INTEGRITY.WEIGHTS.IMPOSSIBLE_SPEED);
});

test('fast but plausible jump → EXCESSIVE_SPEED only', () => {
    reset();
    FIM.evaluate(report('a1b2c8', { lat: 0, lon: 0, speedKts: 800, now: T }));
    T += 60_000; // 1 min later
    // ~0.22 deg lon at equator ≈ 13.2nm in 1 min = 792kts implied
    FIM.evaluate(report('a1b2c8', { lat: 0, lon: 0.22, speedKts: 800, now: T }));
    const r = FIM.getRecord('a1b2c8');
    assert.ok(r.flags.has('EXCESSIVE_SPEED'));
    assert.ok(!r.flags.has('IMPOSSIBLE_SPEED'));
});

test('speed mismatch — reported gs far below track-implied speed', () => {
    reset();
    FIM.evaluate(report('a1b2c9', { lat: 0, lon: 0, speedKts: 100, now: T }));
    T += 60_000;
    // 0.1 deg lon ≈ 6nm in 1min = 360kts implied vs reported 100kts (3.6x > 1.6 factor)
    FIM.evaluate(report('a1b2c9', { lat: 0, lon: 0.1, speedKts: 100, now: T }));
    const r = FIM.getRecord('a1b2c9');
    assert.ok(r.flags.has('SPEED_MISMATCH'));
});

test('altitude jump — implausible climb rate flags ALTITUDE_JUMP', () => {
    reset();
    FIM.evaluate(report('a1b2ca', { altMeters: 3000, now: T }));
    T += 10_000; // 10s
    // climb 2000m (~6562ft) in 10s = ~39000ft/min, way past 12000fpm ceiling
    FIM.evaluate(report('a1b2ca', { altMeters: 5000, now: T }));
    const r = FIM.getRecord('a1b2ca');
    assert.ok(r.flags.has('ALTITUDE_JUMP'));
    assert.equal(r.score, 100 - FLIGHT_INTEGRITY.WEIGHTS.ALTITUDE_JUMP);
});

test('plausible climb does not flag', () => {
    reset();
    FIM.evaluate(report('a1b2cb', { altMeters: 3000, now: T }));
    T += 60_000; // 1 min
    // climb 300m (~984ft) in 1 min = 984ft/min — well under ceiling
    FIM.evaluate(report('a1b2cb', { altMeters: 3300, now: T }));
    assert.ok(!FIM.getRecord('a1b2cb').flags.has('ALTITUDE_JUMP'));
});

test('markDark sets DARK flag; reappearing report clears it', () => {
    reset();
    FIM.evaluate(report('a1b2cc'));
    FIM.markDark('a1b2cc');
    assert.ok(FIM.getRecord('a1b2cc').flags.has('DARK'));
    assert.equal(FIM.getRecord('a1b2cc').score, 100 - FLIGHT_INTEGRITY.WEIGHTS.DARK);
    T += 5000;
    FIM.evaluate(report('a1b2cc', { now: T }));
    assert.ok(!FIM.getRecord('a1b2cc').flags.has('DARK'));
    assert.equal(FIM.getRecord('a1b2cc').score, 100);
});

test('markDark on unknown icao24 is a no-op (never seen before)', () => {
    reset();
    FIM.markDark('unknown');
    assert.equal(FIM.getRecord('unknown'), null);
});

test('soft flag decays after TTL on tick; sticky flag (EMERGENCY) persists', () => {
    reset();
    FIM.evaluate(report('a1b2cd', { lat: 0, lon: 0, squawk: '7700', now: T }));
    T += 10_000;
    FIM.evaluate(report('a1b2cd', { lat: 0, lon: 50, squawk: '7700', now: T })); // also trips IMPOSSIBLE_SPEED
    const r = FIM.getRecord('a1b2cd');
    assert.ok(r.flags.has('IMPOSSIBLE_SPEED') && r.flags.has('EMERGENCY'));
    T += FLIGHT_INTEGRITY.FLAG_TTL_MS + 1000;
    FIM.tick();
    assert.ok(!r.flags.has('IMPOSSIBLE_SPEED'), 'IMPOSSIBLE_SPEED should have decayed');
    assert.ok(r.flags.has('EMERGENCY'), 'EMERGENCY should persist (sticky)');
});

test('flagged() returns below-trusted aircraft worst-first', () => {
    reset();
    FIM.evaluate(report('e10001', { squawk: '2000' }));   // 100 TRUSTED
    FIM.evaluate(report('e10002', { squawk: '7700' }));   // 50 QUESTIONABLE
    FIM.evaluate(report('e10003', { squawk: '7600' }));   // 50 QUESTIONABLE (alt emergency code)
    const f = FIM.flagged();
    assert.equal(f.length, 2);                        // trusted one excluded
    assert.ok(f.every(r => r.icao24 === 'e10002' || r.icao24 === 'e10003'));
});

test('tier thresholds: TRUSTED ≥80, QUESTIONABLE ≥50, else SUSPECT', () => {
    reset();
    FIM.evaluate(report('1a1a1a'));
    assert.equal(FIM.getRecord('1a1a1a').tier, 'TRUSTED');

    reset();
    FIM.evaluate(report('2b2b2b', { squawk: '7700' })); // -50 → score 50 → QUESTIONABLE boundary
    assert.equal(FIM.getRecord('2b2b2b').score, 50);
    assert.equal(FIM.getRecord('2b2b2b').tier, 'QUESTIONABLE');

    reset();
    FIM.evaluate(report('3c3c3c', { lat: 0, lon: 0, squawk: '7700', now: T }));
    T += 10_000;
    FIM.evaluate(report('3c3c3c', { lat: 0, lon: 50, squawk: '7700', now: T })); // EMERGENCY(50) + IMPOSSIBLE_SPEED(35) = 85 → score 15
    assert.equal(FIM.getRecord('3c3c3c').score, 15);
    assert.equal(FIM.getRecord('3c3c3c').tier, 'SUSPECT');
});

console.log(`\n${passed} passed.`);
