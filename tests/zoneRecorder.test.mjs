// tests/zoneRecorder.test.mjs — try to fool the zone recorder.
// Run from repo root:  node tests/zoneRecorder.test.mjs
// Pure node, no browser, no THREE. Every rule (zone membership, window
// arming, auto-stop, domain tagging, NDJSON round trip) ships with a test
// that tries to defeat it — same doctrine as invariants.test.mjs.

import assert from 'node:assert/strict';
import { ZoneRecorder, ZR_STATE } from '../zoneRecorder.js';
import { ZoneRecordedSource } from '../dataSource.js';
import { simClock } from '../simClock.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const T0  = Date.parse('2026-07-10T12:00:00Z');
const MIN = 60_000;

// Hormuz-ish zone: 26.5N 56.5E, 60nm radius. At this latitude 1° lon ≈ 53.7nm.
const ZONE = { lat: 26.5, lon: 56.5, radiusNm: 60 };

function freshRecorder() {
    const zr = new ZoneRecorder({ tickMs: 999999 }); // timer irrelevant; we call tick()
    zr.arm({ ...ZONE, startMs: T0, endMs: T0 + 30 * MIN });
    return zr;
}

const aisMsg = (lat, lon, mmsi = '999000001') => ({
    MessageType: 'PositionReport',
    MetaData: { MMSI: mmsi, ShipName: 'TEST', latitude: lat, longitude: lon,
                time_utc: new Date(simClock.now()).toISOString() },
    Message: { PositionReport: { Sog: 12, Cog: 90, TrueHeading: 90 } },
});
const fltState = (lat, lon, hex = 'abc123') =>
    ({ hex, flight: 'TEST01', lat, lon, alt_baro: 35000, gs: 450, track: 270 });

// ── Window state machine ─────────────────────────────────────────────────────
console.log('window arming (sim-time driven)');

test('armed before window start → ARMED, not recording', () => {
    simClock.setTime(T0 - 10 * MIN);
    const zr = freshRecorder();
    assert.equal(zr.state, ZR_STATE.ARMED);
    zr.aisTap()(aisMsg(26.5, 56.5));          // dead center, but window not open
    assert.equal(zr.count(), 0);
    zr.disarm();
});

test('sim clock crossing startMs → RECORDING', () => {
    simClock.setTime(T0 - 10 * MIN);
    const zr = freshRecorder();
    simClock.setTime(T0 + 1);
    zr.tick();
    assert.equal(zr.state, ZR_STATE.RECORDING);
    zr.disarm();
});

test('sim clock crossing endMs → DONE, taps go deaf', () => {
    simClock.setTime(T0 + 1);
    const zr = freshRecorder();
    zr.tick();
    zr.aisTap()(aisMsg(26.5, 56.5));
    assert.equal(zr.count(), 1);
    simClock.setTime(T0 + 31 * MIN);
    zr.tick();
    assert.equal(zr.state, ZR_STATE.DONE);
    zr.aisTap()(aisMsg(26.5, 56.5));          // after window — must be ignored
    assert.equal(zr.count(), 1);
    zr.disarm();
});

test('stop() mid-recording → DONE, capture kept; disarm() while ARMED → IDLE', () => {
    simClock.setTime(T0 + 1);
    const zr = freshRecorder(); zr.tick();
    zr.aisTap()(aisMsg(26.5, 56.5));
    zr.stop();
    assert.equal(zr.state, ZR_STATE.DONE);
    assert.equal(zr.count(), 1);              // early stop must not discard
    simClock.setTime(T0 - 10 * MIN);
    const zr2 = freshRecorder();
    zr2.stop();                               // no-op unless recording
    assert.equal(zr2.state, ZR_STATE.ARMED);
    zr2.disarm();
    assert.equal(zr2.state, ZR_STATE.IDLE);
});

test('scrubbed clock: window in the past at arm time → rejected', () => {
    simClock.setTime(T0 + 60 * MIN);
    assert.throws(() => new ZoneRecorder().arm({ ...ZONE, startMs: T0, endMs: T0 + 30 * MIN }),
        /already over/);
});

test('inverted window rejected', () => {
    simClock.setTime(T0);
    assert.throws(() => new ZoneRecorder().arm({ ...ZONE, startMs: T0 + MIN, endMs: T0 }),
        /startMs < endMs/);
});

// ── Zone membership ──────────────────────────────────────────────────────────
console.log('zone membership (true haversine, not a lon/lat box)');

test('vessel inside zone → recorded', () => {
    simClock.setTime(T0 + 1);
    const zr = freshRecorder(); zr.tick();
    zr.aisTap()(aisMsg(26.5, 57.0));          // ~27nm east — inside 60nm
    assert.equal(zr.count(), 1);
    zr.disarm();
});

test('vessel outside zone → ignored', () => {
    simClock.setTime(T0 + 1);
    const zr = freshRecorder(); zr.tick();
    zr.aisTap()(aisMsg(26.5, 58.0));          // ~80nm east — outside
    assert.equal(zr.count(), 0);
    zr.disarm();
});

test('corner trap: inside the bounding box but outside the circle → ignored', () => {
    simClock.setTime(T0 + 1);
    const zr = freshRecorder(); zr.tick();
    // NE corner of the 60nm box: ~1.0N ~0.9E offset → ~78nm diagonal, outside circle
    zr.aisTap()(aisMsg(27.5, 57.4));
    assert.equal(zr.count(), 0);
    zr.disarm();
});

test('missing coordinates never crash, never record', () => {
    simClock.setTime(T0 + 1);
    const zr = freshRecorder(); zr.tick();
    zr.aisTap()({ MetaData: { MMSI: 'x' } });
    zr.aisTap()(null);
    zr.flightTap()({ hex: 'no-pos' });
    zr.flightTap()(undefined);
    assert.equal(zr.count(), 0);
    zr.disarm();
});

// ── Domains ──────────────────────────────────────────────────────────────────
console.log('dual-domain tagging');

test('ships tagged ais, planes tagged flt, counts split correctly', () => {
    simClock.setTime(T0 + 1);
    const zr = freshRecorder(); zr.tick();
    zr.aisTap()(aisMsg(26.5, 56.5));
    zr.flightTap()(fltState(26.6, 56.4));
    zr.flightTap()(fltState(26.4, 56.6, 'def456'));
    assert.deepEqual(zr.counts(), { ais: 1, flt: 2 });
    zr.disarm();
});

test('plane outside zone ignored even while ships inside are recorded', () => {
    simClock.setTime(T0 + 1);
    const zr = freshRecorder(); zr.tick();
    zr.aisTap()(aisMsg(26.5, 56.5));
    zr.flightTap()(fltState(30.0, 60.0));     // far away
    assert.deepEqual(zr.counts(), { ais: 1, flt: 0 });
    zr.disarm();
});

test('record cap holds', () => {
    simClock.setTime(T0 + 1);
    const zr = new ZoneRecorder({ maxRecords: 3, tickMs: 999999 });
    zr.arm({ ...ZONE, startMs: T0, endMs: T0 + 30 * MIN });
    zr.tick();
    for (let i = 0; i < 10; i++) zr.aisTap()(aisMsg(26.5, 56.5, `99900000${i}`));
    assert.equal(zr.count(), 3);
    zr.disarm();
});

// ── NDJSON round trip ────────────────────────────────────────────────────────
console.log('NDJSON round trip');

test('manifest + records survive export → parse', () => {
    simClock.setTime(T0 + 1);
    const zr = freshRecorder(); zr.tick();
    zr.aisTap()(aisMsg(26.5, 56.5));
    zr.flightTap()(fltState(26.6, 56.4));
    const { manifest, records } = ZoneRecorder.parseNDJSON(zr.toNDJSON());
    assert.equal(manifest.type, 'vg1-zone-capture');
    assert.deepEqual(manifest.zone, ZONE);
    assert.deepEqual(manifest.counts, { ais: 1, flt: 1 });
    assert.equal(records.length, 2);
    assert.deepEqual(records.map(r => r.d).sort(), ['ais', 'flt']);
    zr.disarm();
});

test('parse tolerates a capture without manifest (plain records)', () => {
    const raw = [JSON.stringify({ t: T0, d: 'ais', msg: aisMsg(26.5, 56.5) })].join('\n');
    const { manifest, records } = ZoneRecorder.parseNDJSON(raw);
    assert.equal(manifest, null);
    assert.equal(records.length, 1);
});

test('parse sorts records by time even if the file is shuffled', () => {
    const shuffled = [
        JSON.stringify({ t: T0 + 2000, d: 'flt', msg: fltState(26.5, 56.5) }),
        JSON.stringify({ t: T0,        d: 'ais', msg: aisMsg(26.5, 56.5) }),
        JSON.stringify({ t: T0 + 1000, d: 'ais', msg: aisMsg(26.5, 56.5) }),
    ].join('\n');
    const { records } = ZoneRecorder.parseNDJSON(shuffled);
    assert.deepEqual(records.map(r => r.t), [T0, T0 + 1000, T0 + 2000]);
});

// ── Replay dispatch ──────────────────────────────────────────────────────────
console.log('ZoneRecordedSource replay dispatch');

test('ais → sink, flt → flightSink, driven by sim time', () => {
    const records = [
        { t: T0,        d: 'ais', msg: aisMsg(26.5, 56.5) },
        { t: T0 + 1000, d: 'flt', msg: fltState(26.6, 56.4) },
        { t: T0 + 5000, d: 'ais', msg: aisMsg(26.4, 56.6, '999000002') },
    ];
    const gotAis = [], gotFlt = [];
    simClock.setTime(T0 - 1000);
    const src = new ZoneRecordedSource(records, { flightSink: (s) => gotFlt.push(...s) });
    // Drive manually — same pattern archiveManager uses via attachSource.
    src._sink = (m) => gotAis.push(m); src._running = true; src._onStart();
    src._tick();                                       // before first record
    assert.equal(gotAis.length + gotFlt.length, 0);
    simClock.setTime(T0 + 2000); src._tick();          // first two due
    assert.equal(gotAis.length, 1);
    assert.equal(gotFlt.length, 1);
    simClock.setTime(T0 + 6000); src._tick();          // third due
    assert.equal(gotAis.length, 2);
    simClock.setTime(T0); src._tick();                 // scrub back
    simClock.setTime(T0 + 6000); src._tick();          // records replay again
    assert.equal(gotAis.length, 4);
});

test('firstTimestamp/lastTimestamp for scrub targets', () => {
    const src = new ZoneRecordedSource([
        { t: T0, d: 'ais', msg: {} }, { t: T0 + 9000, d: 'flt', msg: {} },
    ]);
    assert.equal(src.firstTimestamp(), T0);
    assert.equal(src.lastTimestamp(), T0 + 9000);
});

simClock.goLive();
console.log(`\n${passed} passed${process.exitCode ? ' — WITH FAILURES' : ', all green'}`);
