// tests/integrityEvents.test.mjs — event-contract test for integrityManager.
// Run from repo root (needs the DOM env; npm test wires it for the whole suite):
//   node --import ./tests/_stubs/register.mjs tests/integrityEvents.test.mjs
//
// integrity.test.mjs covers the SCORING math. This covers the SIGNAL: the
// integrity board and the watchlist both listen for `vg1:integrityChanged` to
// know when to re-read a vessel's tier. The manager promises to fire that event
// exactly when a vessel crosses a tier boundary (and on every tick, to refresh
// the board) — and NOT to spam it on no-op re-evaluations. This guards that
// contract; breaking the _dirty/_broadcastIfDirty logic would either flood
// listeners every frame or leave the board stale.
//
// domEnv must load first: with window undefined the manager's broadcast is a
// deliberate no-op (production-safe), so we need window in place to observe it.
import './_stubs/domEnv.mjs';
import { captureEvents } from './_stubs/domEnv.mjs';
import assert from 'node:assert/strict';
import { integrityManager as IM, setElevationFn } from '../integrityManager.js';
import { simClock } from '../simClock.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// Deterministic environment (mirrors tests/integrity.test.mjs).
let T = 1_000_000;
simClock.now = () => T;
let ELEV = -50;                       // <0 ocean, >5 land
setElevationFn(() => ELEV);

const reset  = () => IM.records.clear();
const vessel = (mmsi) => ({ mmsi, name: 'TEST', class: 'CARGO', latDeg: 0, lonDeg: 0, speedKts: 10 });
const ctx    = () => ({ sceneX: 0, sceneZ: 0, sogKts: 10 });

console.log('vg1:integrityChanged fires on tier CHANGE only');
test('a clean vessel (tier stays TRUSTED) emits nothing', () => {
    reset(); ELEV = -50;
    const events = captureEvents('vg1:integrityChanged');
    IM.evaluate(vessel('211000001'), [], ctx());
    assert.equal(IM.getRecord('211000001').tier, 'TRUSTED');
    assert.equal(events.length, 0, 'no tier change → no event');
    events.stop();
});

test('a vessel crossing into SUSPECT emits exactly one event', () => {
    reset(); ELEV = -50;
    const events = captureEvents('vg1:integrityChanged');
    // teleport (35) + SOG mismatch (20) = 55 → score 45 → TRUSTED→SUSPECT.
    IM.evaluate(vessel('211000002'),
        [{ type: 'IMPOSSIBLE_SPEED' }, { type: 'SOG_MISMATCH' }], ctx());
    assert.equal(IM.getRecord('211000002').tier, 'SUSPECT');
    assert.equal(events.length, 1, 'one tier crossing → one event');
    events.stop();
});

test('re-evaluating the same vessel with the same flags emits nothing (idempotent)', () => {
    reset(); ELEV = -50;
    IM.evaluate(vessel('211000003'),
        [{ type: 'IMPOSSIBLE_SPEED' }, { type: 'SOG_MISMATCH' }], ctx()); // TRUSTED→SUSPECT
    const events = captureEvents('vg1:integrityChanged');
    IM.evaluate(vessel('211000003'),
        [{ type: 'IMPOSSIBLE_SPEED' }, { type: 'SOG_MISMATCH' }], ctx()); // SUSPECT→SUSPECT
    assert.equal(events.length, 0, 'tier unchanged on re-eval → no duplicate event');
    events.stop();
});

console.log('tick() refreshes the board every time');
test('tick() always emits (board refresh contract)', () => {
    reset(); ELEV = -50;
    IM.evaluate(vessel('211000004'), [], ctx()); // TRUSTED, no event
    const events = captureEvents('vg1:integrityChanged');
    IM.tick();
    assert.ok(events.length >= 1, 'tick refreshes the board so it must emit');
    events.stop();
});

console.log(`\nintegrityEvents.test: ${passed} checks passed`);
