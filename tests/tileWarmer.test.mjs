// tests/tileWarmer.test.mjs — pin the background warmer's pure logic.
// Run from repo root:  node tests/tileWarmer.test.mjs
//
// The warmer's job is to spend DEAD time only. The properties that matter are
// therefore about restraint: it must never run while the user is doing anything,
// must target the right tiles (centre-out, recent places first), and must not
// let the visit list grow into a warming budget the machine can't afford.

import assert from 'node:assert/strict';
import { VisitStore, ringTiles, IdleDetector } from '../tileWarmer.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('visit store');

test('records new places, refreshes rather than duplicates nearby ones', () => {
    const v = new VisitStore({ gridDeg: 0.25 });
    assert.equal(v.record(-74.0, 40.7), true,  'first visit is new');
    assert.equal(v.record(-74.05, 40.72), false, 'same 0.25-degree cell — refresh, not new');
    assert.equal(v.spots.length, 1, 'hovering around a port must not fill the list');
    assert.equal(v.record(15.1, -27.3), true, 'a genuinely different place is new');
});

test('LRU-capped so warming budget cannot grow without bound', () => {
    const v = new VisitStore({ maxSpots: 3, gridDeg: 0.25 });
    for (let i = 0; i < 10; i++) v.record(i * 10, 0, i);
    assert.equal(v.spots.length, 3);
    assert.deepEqual(v.spots.map(s => s.lon), [70, 80, 90], 'oldest dropped first');
});

test('refresh moves a spot to most-recent — revisited places outlive stale ones', () => {
    const v = new VisitStore({ maxSpots: 2, gridDeg: 0.25 });
    v.record(0, 0, 1); v.record(50, 0, 2);
    v.record(0.01, 0.01, 3);           // refresh of spot A
    v.record(100, 0, 4);               // pushes out the LRU — should be B, not A
    assert.deepEqual(v.spots.map(s => Math.round(s.lon)), [0, 100],
        'the refreshed spot must survive; the stale one goes');
});

test('ordered() is most-recent first — warm where the user just was', () => {
    const v = new VisitStore();
    v.record(0, 0, 1); v.record(50, 0, 2); v.record(100, 0, 3);
    assert.deepEqual(v.ordered().map(s => s.lon), [100, 50, 0]);
});

test('round-trips through JSON (it persists across sessions in localStorage)', () => {
    const v = new VisitStore();
    v.record(-74, 40.7, 5); v.record(15.1, -27.3, 6);
    const back = VisitStore.fromJSON(JSON.parse(JSON.stringify(v)), {});
    assert.deepEqual(back.ordered().map(s => s.lon), v.ordered().map(s => s.lon));
});

test('rejects garbage coordinates rather than persisting them', () => {
    const v = new VisitStore();
    assert.equal(v.record(NaN, 40), false);
    assert.equal(v.record(0, Infinity), false);
    assert.equal(v.spots.length, 0);
});

console.log('ring enumeration');

test('a radius-2 ring is 25 tiles with the CENTRE first', () => {
    const t = ringTiles(-74, 40.7, 12, 2);
    assert.equal(t.length, 25);
    // Warming is interruptible — the camera can move at any moment — so the
    // most valuable tile (dead centre) must be attempted before any edge tile.
    const dLon = 360 / 2 ** 13, dLat = 180 / 2 ** 12;
    assert.equal(t[0].tx, Math.floor((-74 + 180) / dLon));
    assert.equal(t[0].ty, Math.floor((40.7 + 90) / dLat));
});

test('rings come out in distance order, not raster order', () => {
    const t = ringTiles(0, 0, 12, 2);
    const cx = t[0].tx, cy = t[0].ty;
    const dist = e => Math.max(Math.abs(e.tx - cx), Math.abs(e.ty - cy));
    for (let i = 1; i < t.length; i++) {
        assert.ok(dist(t[i]) >= dist(t[i - 1]), `ring order broken at ${i}`);
    }
});

test('longitude wraps at the dateline, latitude clamps at the poles', () => {
    const wrap = ringTiles(179.98, 0, 12, 2);
    const tpx = 2 ** 13;
    for (const e of wrap) assert.ok(e.tx >= 0 && e.tx < tpx, `tx ${e.tx} out of range`);
    const pole = ringTiles(0, 89.99, 12, 2);
    assert.ok(pole.length < 25, 'rows past the pole must be dropped, not wrapped');
    for (const e of pole) assert.ok(e.ty < 2 ** 12);
});

console.log('idle detection');

test('not idle immediately; idle only after stillMs of no movement', () => {
    const d = new IdleDetector({ stillMs: 4000, moveEps: 0.01 });
    assert.equal(d.tick(0, 10, 0, 0), false, 'first sample can never be idle');
    assert.equal(d.tick(0, 10, 0, 3999), false, 'not yet');
    assert.equal(d.tick(0, 10, 0, 4000), true, 'still for 4s — idle');
});

test('ANY camera movement resets the clock — orbiting is activity', () => {
    const d = new IdleDetector({ stillMs: 4000, moveEps: 0.01 });
    d.tick(0, 10, 0, 0);
    d.tick(0, 10, 0, 4000);
    assert.equal(d.tick(5, 10, 0, 4001), false, 'moved — no longer idle');
    assert.equal(d.tick(5, 10, 0, 8000), false, '3999ms after the move');
    assert.equal(d.tick(5, 10, 0, 8001), true, 'idle again 4s after the move');
});

test('sub-epsilon jitter does not reset the clock — damping wobble is not activity', () => {
    // OrbitControls damping leaves the camera creeping by tiny amounts for many
    // frames after the user lets go. If that counted as movement the warmer
    // would NEVER run, and the failure would be silent — stats just stay at 0.
    const d = new IdleDetector({ stillMs: 1000, moveEps: 0.01 });
    d.tick(0, 10, 0, 0);
    // Continuous sub-epsilon creep, the shape damping actually produces. An
    // earlier version of this test jumped the camera BACK to its start for the
    // final sample — a 0.09-unit hop that is genuine movement, and the detector
    // was right to reset on it. The test was wrong, not the code.
    for (let t = 100; t <= 900; t += 100) d.tick(0.005 * (t / 100), 10, 0, t);
    assert.equal(d.tick(0.05, 10, 0, 1000), true, 'creep must not defeat idleness');
});

console.log(`\n${passed} passed`);
