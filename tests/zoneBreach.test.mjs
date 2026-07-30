// tests/zoneBreach.test.mjs — alert-zone entry/exit detection.
// Run from repo root:  node --import ./tests/_stubs/register.mjs tests/zoneBreach.test.mjs
//
// ZONE_BREACH had display metadata in alertsManager and no rule and no raise
// site, so it could never fire. This is the detector that makes it real, and
// these tests are mostly about the three ways a naive version would be worse
// than leaving it unwired:
//
//   · seeding — a zone placed over traffic must not report 60 breaches
//   · hysteresis — a vessel on the boundary must not chatter
//   · disappearance ≠ departure — a vessel going dark is not a vessel leaving

import assert from 'node:assert/strict';
import { ZoneBreachTracker } from '../zoneBreach.js';
import { ZONE } from '../config.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const R = 10;                                   // zone radius, scene units
const v = (mmsi, dist) => ({ mmsi, dist });
let t = 1_000_000;
const tick = (tr, vessels, dt = ZONE.EVAL_MS) => { t += dt; return tr.evaluate(vessels, R, t); };
const fresh = (opts) => { t = 1_000_000; return new ZoneBreachTracker(opts); };

console.log('inert until a zone exists');
test('evaluate() before seed() reports nothing', () => {
    const tr = fresh();
    assert.equal(tr.seeded, false);
    const r = tr.evaluate([v('1', 1)], R, t);
    assert.deepEqual(r.entered, []);
    assert.deepEqual(r.exited, []);
});
test('reset() puts it back to inert', () => {
    const tr = fresh();
    tr.seed([v('1', 1)], R);
    assert.equal(tr.seeded, true);
    tr.reset();
    assert.equal(tr.seeded, false);
    assert.equal(tr.insideCount, 0);
    assert.deepEqual(tick(tr, [v('2', 1)]).entered, [], 'inert after reset');
});

console.log('SEEDING — drawing a zone around traffic is not a breach');
test('vessels already inside at placement are adopted SILENTLY', () => {
    // The case that matters: a zone dropped on a busy strait.
    const tr = fresh();
    const crowd = Array.from({ length: 60 }, (_, i) => v(String(i), 1 + i * 0.1));
    const adopted = tr.seed(crowd, R);
    assert.ok(adopted > 50, `${adopted} adopted`);
    assert.deepEqual(tick(tr, crowd).entered, [],
        '60 CRITICAL alerts on zone placement would bury the log and train the ' +
        'operator to ignore the type');
});
test('a vessel that arrives AFTER placement IS reported', () => {
    const tr = fresh();
    tr.seed([v('inside', 2)], R);
    const r = tick(tr, [v('inside', 2), v('newcomer', 3)]);
    assert.deepEqual(r.entered, ['newcomer']);
});
test('seeding an empty zone adopts nobody', () => {
    const tr = fresh();
    assert.equal(tr.seed([], R), 0);
    assert.deepEqual(tick(tr, [v('a', 1)]).entered, ['a']);
});
test('seeding twice re-baselines (a zone moved to a new place)', () => {
    const tr = fresh();
    tr.seed([v('a', 1)], R);
    tr.seed([v('b', 1)], R);                     // zone re-placed elsewhere
    assert.equal(tr.insideCount, 1);
    assert.deepEqual(tick(tr, [v('b', 1)]).entered, [], 'b was already there');
    assert.deepEqual(tick(tr, [v('b', 1), v('a', 1)]).entered, ['a'], 'a is new here');
});
test('a vessel outside at placement is not adopted', () => {
    const tr = fresh();
    tr.seed([v('far', R + 5)], R);
    assert.equal(tr.insideCount, 0);
    assert.deepEqual(tick(tr, [v('far', 1)]).entered, ['far'], 'it crossed in later');
});

console.log('entry');
test('crossing the radius reports exactly once', () => {
    const tr = fresh();
    tr.seed([], R);
    assert.deepEqual(tick(tr, [v('a', R - 0.1)]).entered, ['a']);
    assert.deepEqual(tick(tr, [v('a', R - 0.1)]).entered, [], 'still inside is not a new entry');
    assert.deepEqual(tick(tr, [v('a', 1)]).entered, [], 'moving deeper in is not a new entry');
});
test('a vessel exactly AT the radius is outside (strict <)', () => {
    const tr = fresh();
    tr.seed([], R);
    assert.deepEqual(tick(tr, [v('a', R)]).entered, [], 'the boundary belongs to outside');
    assert.deepEqual(tick(tr, [v('a', R - 0.001)]).entered, ['a']);
});
test('several vessels entering together are all reported', () => {
    const tr = fresh();
    tr.seed([], R);
    assert.deepEqual(tick(tr, [v('a', 1), v('b', 2), v('c', 3)]).entered.sort(), ['a', 'b', 'c']);
});

console.log('HYSTERESIS — a vessel on the boundary must not chatter');
test('leaving requires clearing the radius PLUS the margin', () => {
    const tr = fresh();
    tr.seed([], R);
    tick(tr, [v('a', 1)]);                       // enters
    assert.equal(tr.insideCount, 1);
    // Just outside the radius but inside the exit margin — still counted inside.
    const justOut = R * (1 + ZONE.EXIT_HYSTERESIS / 2);
    assert.deepEqual(tick(tr, [v('a', justOut)]).exited, [],
        'GPS jitter at the boundary would otherwise flip state every tick');
    assert.equal(tr.insideCount, 1);
    // Beyond the margin — a real departure.
    assert.deepEqual(tick(tr, [v('a', R * (1 + ZONE.EXIT_HYSTERESIS) + 0.1)]).exited, ['a']);
    assert.equal(tr.insideCount, 0);
});
test('jitter across the boundary produces ONE entry, not a stream', () => {
    const tr = fresh();
    tr.seed([], R);
    const jitter = [R - 0.05, R + 0.05, R - 0.05, R + 0.05, R - 0.05, R + 0.05];
    let entries = 0;
    for (const d of jitter) entries += tick(tr, [v('a', d)]).entered.length;
    assert.equal(entries, 1, `${entries} entries from one vessel wobbling on the edge`);
});
test('a genuine re-entry after a genuine departure IS reported', () => {
    const tr = fresh({ cooldownMs: 0 });
    tr.seed([], R);
    assert.deepEqual(tick(tr, [v('a', 1)]).entered, ['a']);
    assert.deepEqual(tick(tr, [v('a', R * 3)]).exited, ['a']);
    assert.deepEqual(tick(tr, [v('a', 1)]).entered, ['a'], 'it really did come back');
});

console.log('cooldown — the backstop');
test('a fast oscillation is held off by the per-vessel cooldown', () => {
    const tr = fresh({ cooldownMs: 60_000 });
    tr.seed([], R);
    assert.deepEqual(tick(tr, [v('a', 1)]).entered, ['a']);
    tick(tr, [v('a', R * 3)]);                   // out
    assert.deepEqual(tick(tr, [v('a', 1)]).entered, [],
        're-entry within the cooldown is tracked but not re-reported');
    assert.equal(tr.insideCount, 1, 'state still says inside, which is correct');
});
test('after the cooldown a re-entry reports again', () => {
    const tr = fresh({ cooldownMs: 60_000 });
    tr.seed([], R);
    tick(tr, [v('a', 1)]);
    tick(tr, [v('a', R * 3)]);
    assert.deepEqual(tick(tr, [v('a', 1)], 61_000).entered, ['a']);
});
test('the cooldown is PER VESSEL, not global', () => {
    const tr = fresh({ cooldownMs: 60_000 });
    tr.seed([], R);
    assert.deepEqual(tick(tr, [v('a', 1)]).entered, ['a']);
    assert.deepEqual(tick(tr, [v('a', 1), v('b', 1)]).entered, ['b'],
        'b must not be silenced by a cooldown belonging to a');
});

console.log('DISAPPEARANCE IS NOT DEPARTURE');
test('a vessel that stops being reported is dropped, but NOT as an exit', () => {
    // We did not see it leave — we stopped seeing it. Reporting that as a
    // departure would assert something we do not know.
    const tr = fresh();
    tr.seed([], R);
    tick(tr, [v('a', 1)]);
    const r = tick(tr, []);                      // went dark / stale / removed
    assert.deepEqual(r.exited, [], 'not an exit');
    assert.equal(tr.insideCount, 0, 'but no longer counted inside');
});
test('a vessel reappearing inside after vanishing counts as a new entry', () => {
    const tr = fresh({ cooldownMs: 0 });
    tr.seed([], R);
    tick(tr, [v('a', 1)]);
    tick(tr, []);
    assert.deepEqual(tick(tr, [v('a', 1)]).entered, ['a']);
});

console.log('robustness');
test('junk in the vessel list is skipped, not fatal', () => {
    const tr = fresh();
    tr.seed([], R);
    assert.doesNotThrow(() => tick(tr, [null, undefined, {}, { mmsi: null, dist: 1 },
                                        { mmsi: 'x', dist: NaN }, { mmsi: 'y', dist: Infinity },
                                        v('ok', 1)]));
    assert.deepEqual(tr.evaluate([v('ok', 1)], R, t).entered, [], 'ok already entered');
    assert.equal(tr.insideCount, 1);
});
test('null and undefined vessel lists do not throw', () => {
    const tr = fresh();
    tr.seed([], R);
    assert.doesNotThrow(() => tr.evaluate(null, R, t));
    assert.doesNotThrow(() => tr.evaluate(undefined, R, t));
});
test('numeric MMSIs are normalised to strings', () => {
    const tr = fresh();
    tr.seed([], R);
    assert.deepEqual(tick(tr, [{ mmsi: 265177000, dist: 1 }]).entered, ['265177000']);
    assert.deepEqual(tick(tr, [{ mmsi: '265177000', dist: 1 }]).entered, [],
        'the same vessel, however it is typed');
});
test('inside count tracks reality across a full cycle', () => {
    const tr = fresh({ cooldownMs: 0 });
    tr.seed([], R);
    tick(tr, [v('a', 1), v('b', 1), v('c', R * 3)]);
    assert.equal(tr.insideCount, 2);
    tick(tr, [v('a', 1), v('b', R * 3), v('c', 1)]);
    assert.equal(tr.insideCount, 2, 'b left, c arrived');
});

console.log('config sanity');
test('the exit margin is positive but small', () => {
    assert.ok(ZONE.EXIT_HYSTERESIS > 0, 'zero margin reintroduces the chatter');
    assert.ok(ZONE.EXIT_HYSTERESIS < 0.5, 'a huge margin makes departures nearly impossible');
});
test('evaluation is throttled well above frame rate', () => {
    assert.ok(ZONE.EVAL_MS >= 1000,
        'tickAlertZone runs per frame; breach evaluation must not');
});

console.log(`\nzoneBreach.test: ${passed} checks passed`);
