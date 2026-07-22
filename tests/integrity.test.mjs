// tests/integrity.test.mjs — AIS Integrity scoring suite.
// Run from repo root:  node tests/integrity.test.mjs
// Pure node, no browser, no THREE (elevation is injected; time is stubbed).

import assert from 'node:assert/strict';
import { integrityManager as IM, setElevationFn } from '../integrityManager.js';
import { INTEGRITY } from '../config.js';
import { simClock } from '../simClock.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// ── Controllable environment ─────────────────────────────────────────────────
let T = 1_000_000;            // fake "now" (ms)
simClock.now = () => T;        // override the singleton clock
let ELEV = -50;               // injected elevation (m): <0 ocean, >5 land
setElevationFn(() => ELEV);

const reset = () => IM.records.clear();
const vessel = (mmsi, over = {}) => ({
    mmsi, name: over.name || 'TEST', class: over.class || 'CARGO',
    latDeg: over.latDeg ?? 0, lonDeg: over.lonDeg ?? 0, speedKts: over.sog ?? 10,
});
const ctx = (over = {}) => ({ sceneX: over.x ?? 0, sceneZ: over.z ?? 0, sogKts: over.sog ?? 10 });

console.log('AIS Integrity suite\n');

test('clean ocean vessel → 100 / TRUSTED', () => {
    reset(); ELEV = -50;
    IM.evaluate(vessel('211000001'), [], ctx());
    const r = IM.getRecord('211000001');
    assert.equal(r.score, 100);
    assert.equal(r.tier, 'TRUSTED');
});

test('lone on-land hit → ON_LAND flag but stays TRUSTED (weak weight by design)', () => {
    // ON_LAND is deliberately a WEAK signal (see config.js rationale + commit
    // 801d309): inland-waterway traffic on the Rhine/Great Lakes/Danube would
    // otherwise be false-flagged by the coarse DEM. A single on-land hit records
    // the flag for analyst context but must NOT by itself demote the vessel.
    reset(); ELEV = 120;
    IM.evaluate(vessel('211000002'), [], ctx());
    const r = IM.getRecord('211000002');
    assert.ok(r.flags.has('ON_LAND'));
    assert.equal(r.score, 100 - INTEGRITY.WEIGHTS.ON_LAND);   // 85
    assert.equal(r.tier, 'TRUSTED');
});

test('SOG mismatch → flag recorded, score 80, still TRUSTED (boundary)', () => {
    reset(); ELEV = -50;
    IM.evaluate(vessel('211000003'), [{ type: 'SOG_MISMATCH', message: 'implied 90kt vs 12kt' }], ctx());
    const r = IM.getRecord('211000003');
    assert.ok(r.flags.has('SOG_MISMATCH'));
    assert.equal(r.score, 100 - INTEGRITY.WEIGHTS.SOG_MISMATCH);  // 80
    assert.equal(r.tier, 'TRUSTED');
});

test('on-land corroborated by SOG mismatch → demoted to QUESTIONABLE', () => {
    // Corroboration is the whole point of the weak weight: on-land alone stays
    // TRUSTED, but a second independent flag pushes it below the TRUSTED band
    // (85 - 20 = 65 → QUESTIONABLE).
    reset(); ELEV = 120;
    IM.evaluate(vessel('211000004'), [{ type: 'SOG_MISMATCH' }], ctx());
    const r = IM.getRecord('211000004');
    assert.equal(r.score, 100 - INTEGRITY.WEIGHTS.ON_LAND - INTEGRITY.WEIGHTS.SOG_MISMATCH); // 65
    assert.equal(r.tier, 'QUESTIONABLE');
});

test('two strong kinematic violations → SUSPECT', () => {
    // Teleport (35) + SOG mismatch (20) = 55 penalty → score 45 → SUSPECT (< 50).
    // Guards the bottom band with the flags that actually warrant a red vessel.
    reset(); ELEV = -50;
    IM.evaluate(vessel('211000014'),
        [{ type: 'IMPOSSIBLE_SPEED' }, { type: 'SOG_MISMATCH' }], ctx());
    const r = IM.getRecord('211000014');
    assert.equal(r.score, 100 - INTEGRITY.WEIGHTS.IMPOSSIBLE_SPEED - INTEGRITY.WEIGHTS.SOG_MISMATCH); // 45
    assert.equal(r.tier, 'SUSPECT');
});

test('malformed MMSI → MMSI_INVALID flag', () => {
    reset(); ELEV = -50;
    IM.evaluate(vessel('99999'), [], ctx());     // not 9 digits
    assert.ok(IM.getRecord('99999').flags.has('MMSI_INVALID'));
    reset();
    IM.evaluate(vessel('199000001'), [], ctx());  // MID 199 < 201 (invalid)
    assert.ok(IM.getRecord('199000001').flags.has('MMSI_INVALID'));
});

test('on-land clears when vessel returns to water', () => {
    reset(); ELEV = 120;
    IM.evaluate(vessel('211000005'), [], ctx());
    assert.ok(IM.getRecord('211000005').flags.has('ON_LAND'));
    ELEV = -50;
    IM.evaluate(vessel('211000005'), [], ctx());
    assert.ok(!IM.getRecord('211000005').flags.has('ON_LAND'));
    assert.equal(IM.getRecord('211000005').score, 100);
});

test('markDark sets DARK flag; markReappear clears it', () => {
    reset(); ELEV = -50;
    IM.evaluate(vessel('211000006'), [], ctx());
    IM.markDark('211000006');
    assert.ok(IM.getRecord('211000006').flags.has('DARK'));
    assert.equal(IM.getRecord('211000006').score, 100 - INTEGRITY.WEIGHTS.DARK);
    IM.markReappear('211000006');
    assert.ok(!IM.getRecord('211000006').flags.has('DARK'));
    assert.equal(IM.getRecord('211000006').score, 100);
});

test('soft flag decays after TTL on tick; sticky flag persists', () => {
    reset(); ELEV = 120;   // on-land (sticky) + SOG (decays)
    IM.evaluate(vessel('211000007'), [{ type: 'SOG_MISMATCH' }], ctx());
    const r = IM.getRecord('211000007');
    assert.ok(r.flags.has('SOG_MISMATCH') && r.flags.has('ON_LAND'));
    T += INTEGRITY.FLAG_TTL_MS + 1000;   // advance past TTL
    IM.tick();
    assert.ok(!r.flags.has('SOG_MISMATCH'), 'SOG should have decayed');
    assert.ok(r.flags.has('ON_LAND'), 'ON_LAND should persist (sticky)');
});

test('loitering: two stopped offshore vessels within radius flag after dwell', () => {
    reset(); ELEV = -50;
    // 0.005° lon apart at equator ≈ 0.3 nm (< LOITER_RADIUS_NM 0.5)
    IM.evaluate(vessel('211000008', { lat: 0, lon: 0,     sog: 0 }), [], ctx({ sog: 0 }));
    IM.evaluate(vessel('211000009', { lat: 0, lon: 0.005, sog: 0 }), [], ctx({ sog: 0 }));
    IM.tick();                                   // starts the loiter clock
    assert.ok(!IM.getRecord('211000008').flags.has('LOITERING'), 'no flag before dwell');
    T += INTEGRITY.LOITER_MIN_MS + 1000;         // wait out the dwell
    IM.tick();
    assert.ok(IM.getRecord('211000008').flags.has('LOITERING'));
    assert.ok(IM.getRecord('211000009').flags.has('LOITERING'));
});

test('flagged() returns below-trusted vessels worst-first', () => {
    reset();
    ELEV = -50; IM.evaluate(vessel('211000010'), [], ctx());                        // 100 TRUSTED (excluded)
    ELEV = -50; IM.evaluate(vessel('211000011'),
        [{ type: 'IMPOSSIBLE_SPEED' }, { type: 'SOG_MISMATCH' }], ctx());           // 45 SUSPECT (worst)
    ELEV = 120; IM.evaluate(vessel('211000012'), [{ type: 'SOG_MISMATCH' }], ctx()); // 65 QUESTIONABLE
    const f = IM.flagged();
    assert.equal(f.length, 2);                       // trusted one excluded
    assert.equal(f[0].mmsi, '211000011');            // worst (45) first
    assert.equal(f[1].mmsi, '211000012');            // 65 next
});

console.log(`\n${passed} passed.`);
