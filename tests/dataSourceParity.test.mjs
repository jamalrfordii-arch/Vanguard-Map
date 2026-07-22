// tests/dataSourceParity.test.mjs — data-source parity & replay determinism.
// Run from repo root:  node tests/dataSourceParity.test.mjs
// Pure node, no browser, no THREE.
//
// dataSource.js promises that every source (synthetic, recorded, zone, composite)
// emits AISStream-shaped messages that aisManager.ingest() cannot tell apart from
// the live WebSocket feed. That promise is the foundation of every deterministic
// test in this repo — so we test the promise itself:
//   1. SHAPE       — synthetic output conforms to the AISStream PositionReport schema.
//   2. DISCIPLINE  — synthetic vessels only ever use reserved 999… MMSIs.
//   3. DETERMINISM — the same scenario, sampled at the same sim times, is byte-identical.
//   4. CROSS-SOURCE PARITY — a RecordedAISSource replays a synthetic capture verbatim,
//      i.e. a recorded feed is indistinguishable from the synthetic one that made it.
//
// Sources are driven directly via _onStart()/_tick() with the sim clock frozen at
// each sample — no real setInterval timers, so output depends only on the scenario
// and the sample times (fully deterministic, no leaked timers).

import assert from 'node:assert/strict';
import { SyntheticAISSource, RecordedAISSource } from '../dataSource.js';
import { simClock } from '../simClock.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const START_ISO = '2026-06-12T06:00:00Z';
const START_MS  = Date.parse(START_ISO);

// Two scripted vessels, both on reserved 999… MMSIs, both moving.
const SCENARIO = {
    name: 'parity-fixture',
    startTime: START_ISO,
    entities: [
        { mmsi: '999000001', name: 'SYN TANKER ALPHA', shipType: 80, speedKts: 14,
          waypoints: [{ lon: 56.4, lat: 26.6 }, { lon: 56.9, lat: 26.2, t: 3600 }] },
        { mmsi: '999000002', name: 'SYN CARGO BRAVO', shipType: 70, speedKts: 12,
          waypoints: [{ lon: 55.0, lat: 25.0 }, { lon: 55.6, lat: 25.4, t: 3600 }] },
    ],
};

// Freeze the clock so now() is constant at each sample (setRate(0) => no drift).
function freezeAt(ms) { simClock.setRate(0); simClock.setTime(ms); }

// Attach a sink and mark the source running WITHOUT starting the interval timer,
// so we can tick it deterministically by hand.
function armed(src, sink) { src._sink = sink; src._running = true; return src; }

// Drive a SyntheticAISSource across a fixed set of sim-time samples, collecting
// every emitted message.
function runSynthetic(sampleOffsetsSec, sink) {
    const msgs = [];
    const src = armed(new SyntheticAISSource(SCENARIO), sink || (m => msgs.push(m)));
    freezeAt(START_MS);
    src._onStart(); // builds _t0 from scenario.startTime + per-entity legs
    for (const s of sampleOffsetsSec) {
        freezeAt(START_MS + s * 1000);
        src._tick();
    }
    return msgs;
}

const AIS_SCHEMA_FIELDS = ['MMSI', 'ShipName', 'ShipType', 'latitude', 'longitude', 'time_utc'];
function assertAisShaped(m, ctx = '') {
    assert.equal(m.MessageType, 'PositionReport', `${ctx} MessageType`);
    assert.ok(m.MetaData && typeof m.MetaData === 'object', `${ctx} MetaData present`);
    for (const f of AIS_SCHEMA_FIELDS) {
        assert.ok(m.MetaData[f] !== undefined, `${ctx} MetaData.${f} present`);
    }
    assert.ok(Number.isFinite(m.MetaData.latitude) && Math.abs(m.MetaData.latitude) <= 90,
        `${ctx} latitude in range`);
    assert.ok(Number.isFinite(m.MetaData.longitude) && Math.abs(m.MetaData.longitude) <= 180,
        `${ctx} longitude in range`);
    const pr = m.Message && m.Message.PositionReport;
    assert.ok(pr && Number.isFinite(pr.Sog) && Number.isFinite(pr.Cog),
        `${ctx} Message.PositionReport.Sog/Cog present`);
}

const SAMPLES = [600, 1800, 3000]; // seconds from scenario start

console.log('1. AISStream shape conformance');
const synthMsgs = runSynthetic(SAMPLES);
test('synthetic source emits at least one message per sample', () => {
    assert.ok(synthMsgs.length >= SAMPLES.length, `got ${synthMsgs.length} messages`);
});
test('every synthetic message conforms to the AISStream PositionReport schema', () => {
    synthMsgs.forEach((m, i) => assertAisShaped(m, `msg[${i}]`));
});

console.log('2. reserved-MMSI discipline (no synthetic data in the real MMSI range)');
test('every emitted MMSI is a reserved 999… id', () => {
    for (const m of synthMsgs) {
        assert.ok(String(m.MetaData.MMSI).startsWith('999'),
            `synthetic MMSI must start with 999, got ${m.MetaData.MMSI}`);
    }
});

console.log('3. replay determinism (same scenario + same sample times => identical output)');
test('two independent runs are deeply equal', () => {
    assert.deepEqual(runSynthetic(SAMPLES), runSynthetic(SAMPLES));
});
test('a different sample schedule produces different positions (guards a trivial-pass)', () => {
    const early = runSynthetic([100]);
    const late  = runSynthetic([3400]);
    const pe = early.find(m => m.MetaData.MMSI === '999000001');
    const pl = late.find(m => m.MetaData.MMSI === '999000001');
    assert.ok(pe && pl, 'both schedules should emit vessel 999000001');
    assert.notEqual(pe.MetaData.longitude, pl.MetaData.longitude,
        'a moving vessel must report different longitudes at different times');
});

console.log('4. cross-source parity (RecordedAISSource replays a synthetic capture verbatim)');
test('a recorded capture of synthetic output replays byte-for-byte', () => {
    // Capture: tag each synthetic message with the (frozen) sim time it was emitted.
    const records = [];
    runSynthetic([600, 1800, 3000], (msg) => records.push({ t: simClock.now(), msg }));
    records.sort((a, b) => a.t - b.t);
    assert.ok(records.length > 0, 'capture produced no records');

    // Replay: a RecordedAISSource fed those records must emit the same msg objects.
    const out = [];
    const replay = armed(new RecordedAISSource(records), m => out.push(m));
    freezeAt(records[0].t - 1);                     // start just before the first record
    replay._onStart();                             // seeks cursor to "now"
    freezeAt(records[records.length - 1].t + 1);   // advance past the last record
    replay._tick();                                // flush everything due

    assert.deepEqual(out, records.map(r => r.msg));
    out.forEach((m, i) => assertAisShaped(m, `replayed[${i}]`));
});

// Leave the clock as we found it for any downstream runner.
simClock.goLive();

console.log(`\ndataSourceParity.test: ${passed} checks passed`);
