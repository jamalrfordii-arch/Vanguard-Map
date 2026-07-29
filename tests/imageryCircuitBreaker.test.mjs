// tests/imageryCircuitBreaker.test.mjs — pin the imagery outage detector.
// Run from repo root:  node tests/imageryCircuitBreaker.test.mjs
//
// This exists because the thing it guards has already been got wrong once. On
// 2026-07-24 blank-imagery detection was wired straight into the retry path and
// reverted the same day: blank responses are SYSTEMIC (rate limiting hits every
// in-flight tile at once), so per-tile retries amplified an endpoint outage into
// ~180 simultaneous retries, each costing a 512² readback and a 28k-point rebuild.
//
// So the property that actually matters here is not "does it detect blanks" —
// it's "does it refuse to retry when retrying would make things worse". Every
// test below is about that distinction, and several deliberately try to fool it.

import assert from 'node:assert/strict';
import { ImageryCircuitBreaker } from '../imageryCircuitBreaker.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const mk = (o = {}) => new ImageryCircuitBreaker({
    windowMs: 1000, blankThreshold: 5, coolOffMs: 5000, healthyToClose: 3, ...o,
});

console.log('closed state — isolated glitches');

test('starts closed', () => {
    assert.equal(mk().isOpen(0), false);
});

test('a single blank does NOT open it — that tile should just retry', () => {
    const b = mk();
    assert.equal(b.recordBlank(0), false);
    assert.equal(b.isOpen(0), false, 'one blank is a glitch, not an outage');
});

test('blanks just under threshold stay closed', () => {
    const b = mk();                       // threshold 5
    for (let i = 0; i < 4; i++) b.recordBlank(i * 10);
    assert.equal(b.isOpen(50), false);
});

console.log('opening — systemic outage');

test('threshold blanks inside the window opens it', () => {
    const b = mk();
    let tripped = false;
    for (let i = 0; i < 5; i++) tripped = b.recordBlank(i * 10) || tripped;
    assert.ok(tripped, 'the 5th blank should report that it tripped');
    assert.equal(b.isOpen(50), true);
});

test('blanks SPREAD OUT beyond the window do not open it', () => {
    // The window is what separates "endpoint is down" from "we have been running
    // a long time and occasionally see a bad tile". Without pruning, any
    // long-lived session would eventually trip on accumulated unrelated blanks.
    const b = mk();                       // windowMs 1000, threshold 5
    for (let i = 0; i < 20; i++) b.recordBlank(i * 500);   // one every 500ms
    assert.equal(b.isOpen(20 * 500), false,
        'slow trickle of blanks over time is not an outage');
});

test('opening is reported once, not on every subsequent blank', () => {
    const b = mk();
    let trips = 0;
    for (let i = 0; i < 12; i++) if (b.recordBlank(i * 10)) trips++;
    assert.equal(trips, 1, 'only the transition should report as a trip');
});

console.log('cool-off — the anti-amplification property');

test('stays open through the cool-off window', () => {
    const b = mk();                       // coolOffMs 5000
    for (let i = 0; i < 5; i++) b.recordBlank(0);
    assert.equal(b.isOpen(4999), true, 'must not reopen the floodgates early');
});

test('closes once cool-off elapses with no further blanks', () => {
    const b = mk();
    for (let i = 0; i < 5; i++) b.recordBlank(0);
    assert.equal(b.isOpen(5000), false);
});

test('a SUSTAINED outage re-arms cool-off — it cannot flap', () => {
    // The bug this prevents: measuring cool-off from when it OPENED means a
    // 60-second outage would let retries through every 5s, which is exactly the
    // amplification the breaker exists to stop. Cool-off runs from the LAST blank.
    const b = mk();
    for (let i = 0; i < 5; i++) b.recordBlank(0);
    for (let t = 1000; t <= 20000; t += 1000) {
        b.recordBlank(t);                       // endpoint still bad
        assert.equal(b.isOpen(t), true, `flapped open at t=${t}`);
    }
    assert.equal(b.isOpen(20000 + 4999), true, 'still cooling off after last blank');
    assert.equal(b.isOpen(20000 + 5000), false, 'finally closes 5s after the last blank');
});

console.log('recovery');

test('a healthy streak closes it early', () => {
    const b = mk();                       // healthyToClose 3
    for (let i = 0; i < 5; i++) b.recordBlank(0);
    assert.equal(b.isOpen(10), true);
    b.recordHealthy(10); b.recordHealthy(11); b.recordHealthy(12);
    assert.equal(b.isOpen(13), false, 'endpoint demonstrably recovered');
});

test('ONE healthy response does not close it — stragglers slip through an outage', () => {
    // During rate limiting a few real images still get served. Treating a single
    // success as recovery would reopen retries mid-outage, which is the failure
    // mode this whole module exists to prevent.
    const b = mk();
    for (let i = 0; i < 5; i++) b.recordBlank(0);
    b.recordHealthy(10);
    assert.equal(b.isOpen(11), true);
});

test('a blank breaks the healthy streak', () => {
    const b = mk();
    for (let i = 0; i < 5; i++) b.recordBlank(0);
    b.recordHealthy(10); b.recordHealthy(11);
    b.recordBlank(12);                    // streak reset — not yet recovered
    b.recordHealthy(13);
    assert.equal(b.isOpen(14), true, 'two healthy after a blank is not a full streak');
});

test('reopens if the endpoint degrades again after recovering', () => {
    const b = mk();
    for (let i = 0; i < 5; i++) b.recordBlank(0);
    for (let i = 0; i < 3; i++) b.recordHealthy(10 + i);
    assert.equal(b.isOpen(20), false);
    // Window pruning must have cleared the old blanks, otherwise a single new
    // blank would instantly retrip it on stale evidence.
    assert.equal(b.recordBlank(2000), false, 'one new blank must not retrip on stale history');
    for (let i = 1; i < 5; i++) b.recordBlank(2000 + i);
    assert.equal(b.isOpen(2010), true);
});

console.log('diagnostics');

test('stats reports state without changing it', () => {
    const b = mk();
    for (let i = 0; i < 5; i++) b.recordBlank(0);
    const s1 = b.stats(100);
    assert.equal(s1.open, true);
    assert.equal(s1.totalBlanks, 5);
    assert.ok(s1.coolOffRemainingMs > 0);
    assert.deepEqual(b.stats(100), s1, 'stats must be side-effect free');
});

console.log(`\n${passed} passed`);
