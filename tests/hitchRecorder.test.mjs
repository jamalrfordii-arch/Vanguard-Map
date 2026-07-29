// tests/hitchRecorder.test.mjs — try to fool the frame-spike recorder.
// Run from repo root:  node tests/hitchRecorder.test.mjs
//
// The recorder's whole value is ATTRIBUTION: not "a frame took 448ms" (the FPS
// counter already tells you that) but "and these counters moved across it". The
// tests below are mostly about the attribution being trustworthy — a recorder
// that blames the wrong subsystem is worse than none, because it sends you
// somewhere real-looking and wrong.

import './_stubs/domEnv.mjs';

import assert from 'node:assert/strict';
import { hitchRecorder } from '../hitchRecorder.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// ── Harness ──────────────────────────────────────────────────────────────────
// performance.now() is the recorder's only clock, so drive it directly rather
// than sleeping — the tests stay instant and deterministic.
let _clock = 0;
globalThis.performance = { now: () => _clock };

function reset() {
    hitchRecorder.clear();
    hitchRecorder.setThreshold(50);
    hitchRecorder.setEnabled(true);
    hitchRecorder._probes.clear();
    hitchRecorder._lastT = 0;
    hitchRecorder._frame = 0;
    hitchRecorder._useA  = true;
    hitchRecorder._cumInFrameMs = 0;
    hitchRecorder._frameStart   = 0;
    // Re-register the built-in self-probe that _probes.clear() just removed —
    // mirrors the constructor. Without it every hitch reports inFrameMs 0 and the
    // loop-accounting tests would pass vacuously.
    hitchRecorder.registerProbe('loop', (o) => {
        o.inFrameMs = Math.round(hitchRecorder._cumInFrameMs);
    });
    _clock = 0;
}

// Advance the clock by `ms` and run one frame (no in-frame work).
const tick = (ms) => { _clock += ms; hitchRecorder.frame(); };

// One full frame: `gapMs` of dead time, then frame(), then `workMs` of work
// inside animate(), then frameEnd(). NOTE the gap a frame OBSERVES is its own
// gapMs plus the previous frame's workMs — the previous frame's work happens
// after its frame() call, so it lands inside the next measured interval. That
// is also true in the real loop, which is why a slow animate() is reported on
// the following frame.
const frameWith = (gapMs, workMs = 0) => {
    _clock += gapMs;
    hitchRecorder.frame();
    _clock += workMs;
    hitchRecorder.frameEnd();
};

// ── Detection ────────────────────────────────────────────────────────────────
console.log('detection');

test('normal frames record nothing', () => {
    reset();
    for (let i = 0; i < 200; i++) tick(16);
    assert.equal(hitchRecorder.list().length, 0);
});

test('a stall above the threshold is recorded', () => {
    reset();
    tick(16); tick(16);
    tick(448);
    const h = hitchRecorder.list();
    assert.equal(h.length, 1);
    assert.equal(h[0].ms, 448);
});

test('the first two frames cannot produce a phantom hitch', () => {
    reset();
    // Frame 1 has no previous timestamp; frame 2's delta is measured from a
    // start-of-loop origin that includes module init. Neither is a real gap, and
    // reporting them would put a fake 3-second hitch at the top of every session.
    _clock = 5000;
    hitchRecorder.frame();
    _clock = 9000;
    hitchRecorder.frame();
    assert.equal(hitchRecorder.list().length, 0);
});

test('threshold is respected on both sides', () => {
    reset();
    hitchRecorder.setThreshold(100);
    tick(16); tick(16);
    tick(99);    // under
    tick(101);   // over
    const h = hitchRecorder.list();
    assert.equal(h.length, 1);
    assert.equal(h[0].ms, 101);
});

test('disabled means disabled', () => {
    reset();
    tick(16); tick(16);
    hitchRecorder.setEnabled(false);
    tick(900);
    assert.equal(hitchRecorder.list().length, 0);
    hitchRecorder.setEnabled(true);
});

// ── Attribution ──────────────────────────────────────────────────────────────
console.log('attribution');

test('reports counters that moved ACROSS the gap, not their absolute values', () => {
    reset();
    let builds = 0;
    hitchRecorder.registerProbe('tiles', (o) => { o.builds = builds; });
    builds = 500;                 // a large standing total...
    tick(16); tick(16);
    builds = 512;                 // ...and 12 more during the stall
    tick(300);
    const h = hitchRecorder.list()[0];
    assert.equal(h.changed['tiles.builds'], 12,
        'must report the delta (12), not the total (512)');
});

test('counters that did not move are omitted entirely', () => {
    reset();
    hitchRecorder.registerProbe('tiles',  (o) => { o.builds = 7; });     // static
    let programs = 0;
    hitchRecorder.registerProbe('render', (o) => { o.programs = programs; });
    tick(16); tick(16);
    programs = 3;
    tick(200);
    const changed = hitchRecorder.list()[0].changed;
    // A report listing every unchanged counter buries the finding. The two that
    // moved ARE the finding.
    assert.deepEqual(Object.keys(changed), ['render.programs']);
    assert.equal(changed['render.programs'], 3);
});

test('a draining queue reports as a negative delta', () => {
    reset();
    let depth = 40;
    hitchRecorder.registerProbe('tiles', (o) => { o.buildQueue = depth; });
    tick(16); tick(16);
    depth = 12;                   // 28 jobs drained during the stall
    tick(400);
    assert.equal(hitchRecorder.list()[0].changed['tiles.buildQueue'], -28,
        'queue depth is absolute, not cumulative — the drain must stay visible');
});

test('ping-pong buffers do not leak values between consecutive hitches', () => {
    reset();
    let n = 0;
    hitchRecorder.registerProbe('tiles', (o) => { o.builds = n; });
    tick(16); tick(16);
    n = 10; tick(200);            // +10
    n = 11; tick(200);            // +1  — must NOT re-report 10
    const h = hitchRecorder.list();
    assert.equal(h[0].changed['tiles.builds'], 10);
    assert.equal(h[1].changed['tiles.builds'], 1);
});

test('a throwing probe cannot break the frame loop', () => {
    reset();
    hitchRecorder.registerProbe('bad',  () => { throw new Error('probe exploded'); });
    hitchRecorder.registerProbe('good', (o) => { o.n = 1; });
    assert.doesNotThrow(() => { tick(16); tick(16); tick(200); },
        'a diagnostic must never be able to take down what it is measuring');
    assert.equal(hitchRecorder.list().length, 1);
});

// ── Inside vs outside the render loop ────────────────────────────────────────
console.log('loop accounting');

test('a stall OUTSIDE animate() is attributed outside it', () => {
    reset();
    frameWith(16, 4);
    frameWith(16, 4);
    frameWith(500, 5);          // 500ms of dead time; animate() itself did 5ms
    const h = hitchRecorder.list()[0];
    assert.equal(h.ms, 504, 'observed gap = own 500 + previous frame’s 4ms of work');
    assert.equal(h.inFrameMs, 4, 'only the previous frame’s work is ours');
    assert.equal(h.outsideMs, 500, 'the 500ms of dead time is not our loop');
    // This is the discriminator that matters: if this number is large, no amount
    // of instrumenting managers will find the cause, because it is not in them.
});

test('a stall caused BY the render loop is attributed inside it', () => {
    reset();
    frameWith(16, 4);
    frameWith(16, 4);
    frameWith(16, 300);         // animate() itself took 300ms
    frameWith(16, 4);           // the NEXT frame observes it
    const h = hitchRecorder.list().find(x => x.inFrameMs > 100);
    assert.ok(h, 'a slow animate() must show up as inFrameMs, not as mystery time');
    assert.equal(h.inFrameMs, 300);
    assert.equal(h.outsideMs, 16, 'the rest is just the normal frame gap');
});

test('loop.inFrameMs is lifted out of changed[] rather than duplicated', () => {
    reset();
    frameWith(16, 4);
    frameWith(16, 4);
    frameWith(300, 2);
    const h = hitchRecorder.list()[0];
    // It is a headline field; leaving it in `changed` too would make every hitch
    // look like it had an attributed cause and defeat the "(nothing moved)" signal.
    assert.equal(h.changed['loop.inFrameMs'], undefined);
    assert.equal(typeof h.inFrameMs, 'number');
});

// ── Visibility guard ─────────────────────────────────────────────────────────
console.log('visibility guard');

test('a gap spanning a backgrounded period is discarded, not reported', () => {
    reset();
    frameWith(16, 4);
    frameWith(16, 4);
    hitchRecorder._wasHidden = true;      // tab went to the background
    frameWith(4000, 4);                   // ...and came back four seconds later
    // rAF is throttled or stopped while hidden, so this gap is an artifact of the
    // browser, not a stall anyone experienced. Reporting it would also park the
    // largest fake entry at the top of worst() — the first thing anyone reads.
    assert.equal(hitchRecorder.list().length, 0, 'must not be recorded');
    assert.equal(hitchRecorder.summary().discardedWhileHidden, 1, 'but must be counted');
});

test('only the first gap after returning is discarded', () => {
    reset();
    frameWith(16, 4);
    frameWith(16, 4);
    hitchRecorder._wasHidden = true;
    frameWith(4000, 4);                   // discarded
    frameWith(300, 4);                    // a REAL stall right after — must count
    assert.equal(hitchRecorder.list().length, 1);
    assert.equal(hitchRecorder.list()[0].ms, 304);
});

test('returning without a long gap clears the flag rather than arming a false discard', () => {
    reset();
    frameWith(16, 4);
    frameWith(16, 4);
    hitchRecorder._wasHidden = true;
    frameWith(16, 4);                     // came back immediately, no gap
    frameWith(300, 4);                    // a real stall later must NOT be eaten
    assert.equal(hitchRecorder.list().length, 1);
    assert.equal(hitchRecorder.summary().discardedWhileHidden, 0);
});

test('clear() keeps a pending hidden flag armed', () => {
    reset();
    frameWith(16, 4);
    frameWith(16, 4);
    hitchRecorder._wasHidden = true;      // backgrounded NOW
    hitchRecorder.clear();                // a run is started while still hidden
    frameWith(4000, 4);
    // Resetting the buffer must not disarm the guard, or the very first sample of
    // every automated run would be a multi-second phantom.
    assert.equal(hitchRecorder.list().length, 0);
});

// ── Bounded memory ───────────────────────────────────────────────────────────
console.log('bounded memory');

test('the ring buffer stays bounded under a hitch storm', () => {
    reset();
    tick(16); tick(16);
    for (let i = 0; i < 500; i++) tick(200);
    // This is meant to be safe to leave on permanently, which it is not if a bad
    // session can grow an unbounded array of records.
    assert.ok(hitchRecorder.list().length <= 60, 'ring buffer must cap');
    assert.equal(hitchRecorder.summary().totalHitches, 500,
        'the total count must still be honest even though records were dropped');
});

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('summary');

test('groups repeated hitches by cause and ranks by worst', () => {
    reset();
    let programs = 0, builds = 0;
    hitchRecorder.registerProbe('render', (o) => { o.programs = programs; });
    hitchRecorder.registerProbe('tiles',  (o) => { o.builds   = builds;   });
    tick(16); tick(16);
    builds += 5;   tick(120);     // cause A
    builds += 5;   tick(140);     // cause A again
    programs += 2; tick(400);     // cause B, worse
    const s = hitchRecorder.summary();
    assert.equal(s.byCause.length, 2, 'two distinct causes');
    assert.equal(s.byCause[0].cause, 'render.programs', 'worst cause ranks first');
    assert.equal(s.byCause[0].worstMs, 400);
    assert.equal(s.byCause[1].count, 2, 'the repeated cause is grouped, not listed twice');
});

console.log(`\n${passed} passed`);
