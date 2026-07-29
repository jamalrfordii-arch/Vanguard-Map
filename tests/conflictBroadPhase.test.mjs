// tests/conflictBroadPhase.test.mjs — try to fool the conflict broad phase.
// Run from repo root:  node tests/conflictBroadPhase.test.mjs
//
// The broad phase exists purely for speed, so the ONLY thing that matters is
// that it is conservative: it may hand evaluatePair() pairs that turn out fine,
// but it must never skip a pair that would have been flagged. A false negative
// here is an aerial conflict that silently stops being detected — strictly worse
// than the frame stutter it was added to fix.
//
// So the central test is differential: brute-force every pair, broad-phase the
// same input, and require the flagged sets to be IDENTICAL across thousands of
// randomised fleets, including adversarial ones built specifically to sit right
// at the bound.

import assert from 'node:assert/strict';
import { evaluatePair, forEachCandidatePair, maxCandidateSeparationNm } from '../conflictMath.js';
import { CONFLICT } from '../config.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// Deterministic PRNG so a failure is always reproducible.
let _seed = 987654321;
const rnd = () => { _seed = (_seed * 1664525 + 1013904223) >>> 0; return _seed / 4294967296; };
const range = (lo, hi) => lo + rnd() * (hi - lo);

const plane = (over = {}) => ({
    icao24: 'x' + Math.floor(rnd() * 1e6).toString(16),
    callsign: 'T',
    latDeg: range(-70, 70), lonDeg: range(-179, 179),
    altMeters: range(1000, 12000),
    speedKts: range(60, 600),
    headingDeg: range(0, 360),
    verticalRateMs: range(-15, 15),
    ...over,
});

const brute = (list) => {
    const found = new Set();
    for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++)
            if (evaluatePair(list[i], list[j])) found.add([list[i].icao24, list[j].icao24].sort().join('|'));
    return found;
};

const broad = (list) => {
    const found = new Set();
    forEachCandidatePair(list, CONFLICT, (a, b) => {
        if (evaluatePair(a, b)) found.add([a.icao24, b.icao24].sort().join('|'));
    });
    return found;
};

const sameSet = (x, y) => x.size === y.size && [...x].every(k => y.has(k));

// ── The bound itself ─────────────────────────────────────────────────────────
console.log('separation bound');

test('bound covers the fastest possible mutual closure', () => {
    const a = plane({ speedKts: 600 }), b = plane({ speedKts: 500 });
    const closureNm = (600 + 500) * (CONFLICT.LOOKAHEAD_SEC / 3600);
    assert.equal(maxCandidateSeparationNm(a, b),
        CONFLICT.HORIZONTAL_NM + closureNm,
        'bound must be threshold + everything the pair could close in the window');
});

test('bound grows with speed — a slow pair is cheaper to reject', () => {
    const slow = maxCandidateSeparationNm(plane({ speedKts: 80 }), plane({ speedKts: 80 }));
    const fast = maxCandidateSeparationNm(plane({ speedKts: 600 }), plane({ speedKts: 600 }));
    assert.ok(fast > slow * 3, `expected a much wider bound for fast traffic: ${slow} vs ${fast}`);
});

// ── Differential fuzz: the test that actually matters ────────────────────────
console.log('differential vs brute force');

test('200 random fleets produce identical results', () => {
    for (let iter = 0; iter < 200; iter++) {
        const n = 2 + Math.floor(rnd() * 40);
        const list = Array.from({ length: n }, () => plane());
        const b = brute(list), f = broad(list);
        assert.ok(sameSet(b, f),
            `iter ${iter}: brute ${[...b].join(',')} vs broad ${[...f].join(',')}`);
    }
});

test('dense clusters — many genuine conflicts, not just empty sky', () => {
    // Random global traffic almost never conflicts, so a passing fuzz there can be
    // vacuous. Pack aircraft into a small box so real conflicts actually occur.
    let totalConflicts = 0;
    for (let iter = 0; iter < 200; iter++) {
        const lat0 = range(-50, 50), lon0 = range(-170, 170);
        const list = Array.from({ length: 2 + Math.floor(rnd() * 25) }, () => plane({
            latDeg: lat0 + range(-0.6, 0.6),
            lonDeg: lon0 + range(-0.6, 0.6),
            altMeters: 9000 + range(-400, 400),
        }));
        const b = brute(list), f = broad(list);
        totalConflicts += b.size;
        assert.ok(sameSet(b, f), `iter ${iter}: ${b.size} brute vs ${f.size} broad`);
    }
    assert.ok(totalConflicts > 50,
        `fuzz was vacuous — only ${totalConflicts} conflicts generated across 200 fleets`);
});

test('pairs sitting exactly on the bound are not dropped', () => {
    // Place two aircraft at almost exactly the maximum candidate separation,
    // closing head-on. This is where an off-by-a-little bound silently fails.
    for (let iter = 0; iter < 200; iter++) {
        const speed = range(200, 600);
        const sepNm = CONFLICT.HORIZONTAL_NM + 2 * speed * (CONFLICT.LOOKAHEAD_SEC / 3600);
        const lat0 = range(-45, 45);
        const a = plane({ latDeg: lat0, lonDeg: 0, speedKts: speed, headingDeg: 0,
                          altMeters: 9000, verticalRateMs: 0 });
        const b = plane({ latDeg: lat0 + (sepNm * 0.98) / 60, lonDeg: 0, speedKts: speed,
                          headingDeg: 180, altMeters: 9000, verticalRateMs: 0 });
        assert.ok(sameSet(brute([a, b]), broad([a, b])), `iter ${iter} at 98% of the bound`);
    }
});

test('co-located aircraft (zero separation) still pair up', () => {
    const a = plane({ latDeg: 10, lonDeg: 20, altMeters: 9000, speedKts: 400, headingDeg: 90, verticalRateMs: 0 });
    const b = plane({ latDeg: 10, lonDeg: 20, altMeters: 9000, speedKts: 400, headingDeg: 270, verticalRateMs: 0 });
    assert.ok(sameSet(brute([a, b]), broad([a, b])));
    assert.equal(broad([a, b]).size, 1, 'two aircraft on top of each other must flag');
});

// ── Degenerate input ─────────────────────────────────────────────────────────
console.log('degenerate input');

test('empty and single-aircraft lists do not throw', () => {
    assert.doesNotThrow(() => forEachCandidatePair([], CONFLICT, () => {}));
    assert.doesNotThrow(() => forEachCandidatePair([plane()], CONFLICT, () => {}));
    assert.equal(forEachCandidatePair([plane()], CONFLICT, () => {}), 0);
});

test('does not mutate the caller’s array', () => {
    // It sorts internally; sorting the caller's list in place would silently
    // reorder flightManager's aircraft for everyone else.
    const list = Array.from({ length: 12 }, () => plane());
    const before = list.map(p => p.icao24);
    forEachCandidatePair(list, CONFLICT, () => {});
    assert.deepEqual(list.map(p => p.icao24), before);
});

test('all-identical latitudes degrade gracefully to all-pairs', () => {
    const list = Array.from({ length: 20 }, () => plane({ latDeg: 30, lonDeg: range(-1, 1) }));
    assert.ok(sameSet(brute(list), broad(list)));
});

// ── The actual point: it has to be cheaper ───────────────────────────────────
console.log('work reduction');

test('realistic global traffic considers far fewer pairs than all-pairs', () => {
    const list = Array.from({ length: 300 }, () => plane());
    const allPairs = (300 * 299) / 2;
    const considered = forEachCandidatePair(list, CONFLICT, () => {});
    assert.ok(considered < allPairs * 0.25,
        `expected a large cut, considered ${considered} of ${allPairs}`);
    console.log(`      (${considered} pairs vs ${allPairs} all-pairs — ${(100 * considered / allPairs).toFixed(1)}%)`);
});

console.log(`\n${passed} passed`);
