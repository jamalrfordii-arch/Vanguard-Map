// tests/invariants.test.mjs — the Feynman suite: try to fool the invariant checker.
// Run from repo root:  node tests/invariants.test.mjs
// Pure node, no browser, no THREE. Every detector ships with the test that
// tries to defeat it ("the first principle is that you must not fool yourself").

import assert from 'node:assert/strict';
import { checkPositionReport, parseEventTime, impliedSpeedKts, invariantLedger } from '../invariants.js';
import { SyntheticAISSource } from '../dataSource.js';
import { simClock } from '../simClock.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const H = 3600_000; // 1h in ms
// Equator shortcut: 1° lon = 60nm, so 0.2° = 12nm, 5° = 300nm, etc.
const prevAt = (tEvent) => ({ latDeg: 0, lonDeg: 0, tEvent });
const report = (over) => ({
    mmsi: '999000099', name: 'TEST VESSEL', lat: 0, lon: 0,
    sogKts: 10, tEvent: H, tArrival: H, class: 'CARGO', ...over
});

console.log('parseEventTime');
test('parses ISO 8601', () =>
    assert.equal(parseEventTime('2026-06-12T00:00:00.000Z'), Date.parse('2026-06-12T00:00:00Z')));
test('parses AISStream "+0000 UTC" format', () =>
    assert.equal(parseEventTime('2026-06-12 06:30:00.123456789 +0000 UTC'),
                 Date.parse('2026-06-12T06:30:00.123Z')));
test('returns null on garbage (never guesses)', () =>
    assert.equal(parseEventTime('not a time'), null));

console.log('kinematics');
test('implied speed math: 60nm in 1h = 60kts', () =>
    assert.ok(Math.abs(impliedSpeedKts(0, 0, 0, 1, H) - 60) < 0.5));

console.log('invariant gate');
invariantLedger.clear();

test('honest 12kt transit → no violations', () =>
    assert.equal(checkPositionReport(prevAt(0), report({ lon: 0.2, sogKts: 12 })).length, 0));

test('teleport (300nm in 1h = 300kts) → IMPOSSIBLE_SPEED reject', () => {
    const v = checkPositionReport(prevAt(0), report({ lon: 5 }));
    assert.equal(v.length, 1);
    assert.equal(v[0].type, 'IMPOSSIBLE_SPEED');
    assert.equal(v[0].severity, 'reject');
});

test('48kt "tanker" → EXCESSIVE_SPEED flag, not reject', () => {
    const v = checkPositionReport(prevAt(0), report({ lon: 0.8, sogKts: 47, class: 'TANKER' }));
    assert.deepEqual(v.map(x => [x.type, x.severity]), [['EXCESSIVE_SPEED', 'flag']]);
});

test('spoof tell: claims 2kts, moved at 20kts → SOG_MISMATCH', () => {
    const v = checkPositionReport(prevAt(0), report({ lon: 0.3334, sogKts: 2 }));
    assert.deepEqual(v.map(x => x.type), ['SOG_MISMATCH']);
});

test('event timestamp from the future → FUTURE_EVENT flag', () => {
    const v = checkPositionReport(null, report({ tEvent: H + 120_000, tArrival: H }));
    assert.deepEqual(v.map(x => x.type), ['FUTURE_EVENT']);
});

test('report arriving 11min late → STALE_EVENT flag', () => {
    const v = checkPositionReport(null, report({ tEvent: H, tArrival: H + 11 * 60_000 }));
    assert.deepEqual(v.map(x => x.type), ['STALE_EVENT']);
});

test('event time going backwards → TIME_REGRESSION flag', () => {
    const v = checkPositionReport(prevAt(H), report({ tEvent: H - 60_000, tArrival: H }));
    assert.deepEqual(v.map(x => x.type), ['TIME_REGRESSION']);
});

test('jump within MIN_DT window → no speed verdict (insufficient baseline)', () =>
    assert.equal(checkPositionReport(prevAt(0), report({ lon: 5, tEvent: 10_000, tArrival: 10_000 })).length, 0));

test('ledger accumulated the violations above', () => {
    const s = invariantLedger.stats();
    assert.ok(s.IMPOSSIBLE_SPEED >= 1 && s.SOG_MISMATCH >= 1 && s.total >= 5);
});

console.log('end-to-end: synthetic teleporter caught at the gate');
test('SyntheticAISSource → checkPositionReport rejects the scripted teleport', () => {
    invariantLedger.clear();
    const msgs = [];
    const src = new SyntheticAISSource({
        name: 'invariant test',
        entities: [{
            mmsi: '999000666', name: 'SYN TELEPORT ECHO', shipType: 80,
            waypoints: [ { lon: 0, lat: 0, t: 0 }, { lon: 10, lat: 0, t: 3600 } ] // 600nm/h
        }]
    });
    src.start(m => msgs.push(m));
    simClock.setTime(Date.now() + 1800_000); // jump sim time 30min ahead
    src._tick();
    src.stop();
    simClock.goLive();

    assert.ok(msgs.length >= 2, `expected ≥2 messages, got ${msgs.length}`);
    const [a, b] = [msgs[0], msgs[msgs.length - 1]];
    const toReport = (m) => ({
        mmsi: m.MetaData.MMSI, name: m.MetaData.ShipName,
        lat: m.MetaData.latitude, lon: m.MetaData.longitude,
        sogKts: m.Message.PositionReport.Sog,
        tEvent: parseEventTime(m.MetaData.time_utc),
        tArrival: parseEventTime(m.MetaData.time_utc),
        class: 'TANKER'
    });
    const v = checkPositionReport(
        { latDeg: a.MetaData.latitude, lonDeg: a.MetaData.longitude, tEvent: parseEventTime(a.MetaData.time_utc) },
        toReport(b)
    );
    assert.ok(v.some(x => x.type === 'IMPOSSIBLE_SPEED' && x.severity === 'reject'),
        `expected IMPOSSIBLE_SPEED reject, got ${JSON.stringify(v.map(x => x.type))}`);
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
