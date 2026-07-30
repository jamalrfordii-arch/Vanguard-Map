// tests/voyagePlanStore.test.mjs — contract test for the voyage-plan owner.
// Run from repo root:  node tests/voyagePlanStore.test.mjs
//
// Guards the promises the store makes, in the same spirit as
// tests/entityStore.test.mjs:
//   (1) all() returns a STABLE array reference across mutations;
//   (2) re-receiving a plan SUPERSEDES rather than duplicates (a VIS
//       subscription pushes an update on every change — duplicating would
//       grow without bound and make byMmsi ambiguous);
//   (3) byMmsi() answers "the route this ship is steering" — one plan, or null;
//   (4) null means UNMONITORED, never "compliant";
//   (5) eviction is bounded AND announced.

import './_stubs/domEnv.mjs';
import assert from 'node:assert/strict';
import { DOMParser } from './_stubs/xmlDom.mjs';
import { voyagePlanStore, planKey, isValidAt, isMonitored } from '../voyagePlanStore.js';
import { parse, serialise } from '../rtzCodec.js';
import { simClock } from '../simClock.js';
import { STM } from '../config.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const dp = new DOMParser();
const P = (xml) => parse(xml, { domParser: dp });

// Silence the intentional console.warn from eviction / rejection paths so the
// suite output stays readable; capture them so we can assert they happened.
const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => { warnings.push(a.join(' ')); };
process.on('exit', () => { console.warn = realWarn; });

function routeXml({ mmsi = '265177000', name = 'ROUTE A', status = 7,
                    uvid = null, from = null, to = null, wps = 3 } = {}) {
    const points = [];
    for (let i = 0; i < wps; i++) {
        points.push(`<waypoint id="${i + 1}"><position lat="0" lon="${i}"/>` +
                    `<leg portsideXTD="0.2" starboardXTD="0.2"/></waypoint>`);
    }
    return `<?xml version="1.0"?>
<route version="1.1" xmlns="http://www.cirm.org/RTZ/1/1">
  <routeInfo routeName="${name}"${mmsi ? ` vesselMMSI="${mmsi}"` : ''}` +
    `${status != null ? ` routeStatus="${status}"` : ''}` +
    `${uvid ? ` vesselVoyage="${uvid}"` : ''}` +
    `${from ? ` validityPeriodStart="${from}"` : ''}` +
    `${to ? ` validityPeriodStop="${to}"` : ''}/>
  <waypoints>${points.join('')}</waypoints>
</route>`;
}

const planFrom = (opts) => P(routeXml(opts)).plan;

function reset() {
    voyagePlanStore.clear();
    warnings.length = 0;
    simClock.goLive();
}

// Collect vg1:* events for assertions.
const events = [];
for (const n of ['vg1:voyagePlanReceived', 'vg1:voyagePlanActivated', 'vg1:voyagePlanRemoved',
                 'vg1:voyagePlanExpired', 'vg1:voyagePlanEvicted']) {
    window.addEventListener(n, (e) => events.push({ type: n, detail: e.detail }));
}
const eventsOf = (type) => events.filter(e => e.type === type);

console.log('stable reference (the core promise)');
test('all() returns the same array reference across add/remove', () => {
    reset();
    const ref1 = voyagePlanStore.all();
    voyagePlanStore.add(planFrom({ uvid: 'urn:a' }));
    voyagePlanStore.removeByUvid('urn:a');
    assert.equal(voyagePlanStore.all(), ref1);
});
test('clear() empties in place without swapping the reference', () => {
    reset();
    const ref = voyagePlanStore.all();
    voyagePlanStore.add(planFrom({ uvid: 'urn:a' }));
    voyagePlanStore.clear();
    assert.equal(voyagePlanStore.all(), ref);
    assert.equal(voyagePlanStore.count(), 0);
});

console.log('add / identity');
test('add stores a plan and indexes it by UVID', () => {
    reset();
    const p = voyagePlanStore.add(planFrom({ uvid: 'urn:mrn:stm:voyage:id:acme:1' }));
    assert.ok(p);
    assert.equal(voyagePlanStore.count(), 1);
    assert.equal(voyagePlanStore.byUvid('urn:mrn:stm:voyage:id:acme:1'), p);
});
test('add stamps receivedAt from simClock when absent', () => {
    reset();
    const p = voyagePlanStore.add(planFrom({ uvid: 'urn:a' }));
    assert.ok(Number.isFinite(p.receivedAt));
});
test('a plan with no UVID gets a SYNTHESISED key, clearly flagged', () => {
    reset();
    const p = voyagePlanStore.add(planFrom({ uvid: null, mmsi: '111', name: 'NO UVID' }));
    assert.equal(p.uvidSynthesised, true, 'must never pass as a ship-issued UVID');
    assert.ok(planKey(p).startsWith(STM.ORG_MRN_PREFIX));
    assert.ok(planKey(p).includes(':local:'), 'the key says it is local');
});
test('a plan WITH a UVID is never flagged as synthesised', () => {
    reset();
    const p = voyagePlanStore.add(planFrom({ uvid: 'urn:mrn:stm:voyage:id:ship:9' }));
    assert.equal(p.uvidSynthesised, undefined);
    assert.equal(planKey(p), 'urn:mrn:stm:voyage:id:ship:9',
        'the ship owns its UVID — we must not rewrite it');
});
test('a plan with fewer than 2 waypoints is REFUSED and says why', () => {
    reset();
    assert.equal(voyagePlanStore.add(planFrom({ wps: 1 })), null);
    assert.equal(voyagePlanStore.count(), 0);
    assert.ok(warnings.some(w => w.includes('fewer than 2 waypoints')));
});
test('add rejects junk without throwing', () => {
    reset();
    assert.equal(voyagePlanStore.add(null), null);
    assert.equal(voyagePlanStore.add('nope'), null);
    assert.equal(voyagePlanStore.add({}), null);
    assert.equal(voyagePlanStore.count(), 0);
});

console.log('supersede, not duplicate (the VIS subscription case)');
test('re-adding the same UVID REPLACES the plan', () => {
    reset();
    voyagePlanStore.add(planFrom({ uvid: 'urn:x', name: 'FIRST' }));
    voyagePlanStore.add(planFrom({ uvid: 'urn:x', name: 'SECOND' }));
    assert.equal(voyagePlanStore.count(), 1, 'one UVID, one plan');
    assert.equal(voyagePlanStore.byUvid('urn:x').routeName, 'SECOND');
});
test('the supersede is reported in the event, not hidden', () => {
    reset(); events.length = 0;
    voyagePlanStore.add(planFrom({ uvid: 'urn:x' }));
    voyagePlanStore.add(planFrom({ uvid: 'urn:x' }));
    const evs = eventsOf('vg1:voyagePlanReceived');
    assert.equal(evs[evs.length - 2].detail.superseded, false);
    assert.equal(evs[evs.length - 1].detail.superseded, true);
});
test('replacement keeps the array position (no churn for renderers)', () => {
    reset();
    voyagePlanStore.add(planFrom({ uvid: 'urn:a' }));
    voyagePlanStore.add(planFrom({ uvid: 'urn:b' }));
    voyagePlanStore.add(planFrom({ uvid: 'urn:a', name: 'UPDATED' }));
    assert.equal(voyagePlanStore.all()[0].routeName, 'UPDATED');
    assert.equal(voyagePlanStore.count(), 2);
});
test('two DIFFERENT UVIDs for one vessel both persist', () => {
    reset();
    voyagePlanStore.add(planFrom({ uvid: 'urn:a', mmsi: '265177000', status: 6 }));
    voyagePlanStore.add(planFrom({ uvid: 'urn:b', mmsi: '265177000', status: 7 }));
    assert.equal(voyagePlanStore.allByMmsi('265177000').length, 2,
        'a ship legitimately holds an approved plan and the one it is steering');
});

console.log('byMmsi — "the route this ship is steering"');
test('returns the status-7 plan, not the approved-but-not-loaded one', () => {
    reset();
    voyagePlanStore.add(planFrom({ uvid: 'urn:approved', mmsi: '1', status: 6 }));
    const active = voyagePlanStore.add(planFrom({ uvid: 'urn:active', mmsi: '1', status: 7 }));
    assert.equal(voyagePlanStore.byMmsi('1'), active);
});
test('returns NULL when the vessel shares no plan — UNMONITORED, not compliant', () => {
    reset();
    assert.equal(voyagePlanStore.byMmsi('999999999'), null);
});
test('returns null when the only plan is not at monitoring status', () => {
    reset();
    voyagePlanStore.add(planFrom({ uvid: 'urn:p', mmsi: '1', status: 2 }));
    assert.equal(voyagePlanStore.byMmsi('1'), null,
        'status 2 is an intention nobody is executing');
    assert.equal(voyagePlanStore.allByMmsi('1').length, 1, 'but the plan is still held');
});
test('an INACTIVE (status 8) plan is never returned', () => {
    reset();
    voyagePlanStore.add(planFrom({ uvid: 'urn:p', mmsi: '1', status: 8 }));
    assert.equal(voyagePlanStore.byMmsi('1'), null);
});
test('MMSI matching is string-based (numeric input still works)', () => {
    reset();
    voyagePlanStore.add(planFrom({ uvid: 'urn:p', mmsi: '265177000', status: 7 }));
    assert.ok(voyagePlanStore.byMmsi(265177000));
    assert.ok(voyagePlanStore.byMmsi('265177000'));
});
test('a plan with no MMSI is never returned by byMmsi', () => {
    reset();
    voyagePlanStore.add(planFrom({ uvid: 'urn:p', mmsi: null, status: 7 }));
    assert.equal(voyagePlanStore.byMmsi('1'), null);
    assert.equal(voyagePlanStore.count(), 1, 'it is still held, just not attributable');
});
test('when two plans are both at status 7 the NEWEST wins', () => {
    reset();
    const older = voyagePlanStore.add(planFrom({ uvid: 'urn:old', mmsi: '1', status: 7 }));
    older.receivedAt = 1000;
    const newer = voyagePlanStore.add(planFrom({ uvid: 'urn:new', mmsi: '1', status: 7 }));
    newer.receivedAt = 2000;
    assert.equal(voyagePlanStore.byMmsi('1'), newer);
});

console.log('validity windows');
test('isValidAt honours both ends of the window', () => {
    const p = { validFrom: 1000, validTo: 2000 };
    assert.equal(isValidAt(p, 500), false);
    assert.equal(isValidAt(p, 1500), true);
    assert.equal(isValidAt(p, 2500), false);
});
test('a plan declaring no window is always valid', () => {
    assert.equal(isValidAt({ validFrom: null, validTo: null }, 12345), true);
});
test('a plan outside its window is not monitored even at status 7', () => {
    reset();
    const p = voyagePlanStore.add(planFrom({
        uvid: 'urn:p', mmsi: '1', status: 7,
        from: '2020-01-01T00:00:00Z', to: '2020-01-02T00:00:00Z',
    }));
    assert.equal(isMonitored(p, Date.parse('2026-07-29T00:00:00Z')), false);
    assert.equal(voyagePlanStore.byMmsi('1', Date.parse('2026-07-29T00:00:00Z')), null);
    assert.equal(isMonitored(p, Date.parse('2020-01-01T12:00:00Z')), true);
});
test('expire() drops closed-window plans and announces each one', () => {
    reset(); events.length = 0;
    voyagePlanStore.add(planFrom({ uvid: 'urn:old', mmsi: '1', status: 7,
        to: '2020-01-02T00:00:00Z' }));
    voyagePlanStore.add(planFrom({ uvid: 'urn:live', mmsi: '2', status: 7 }));
    const gone = voyagePlanStore.expire(Date.parse('2026-07-29T00:00:00Z'));
    assert.equal(gone.length, 1);
    assert.equal(voyagePlanStore.count(), 1);
    assert.equal(eventsOf('vg1:voyagePlanExpired').length, 1);
});

console.log('monitored()');
test('returns only the plans actually being steered', () => {
    reset();
    voyagePlanStore.add(planFrom({ uvid: 'urn:a', mmsi: '1', status: 7 }));
    voyagePlanStore.add(planFrom({ uvid: 'urn:b', mmsi: '2', status: 3 }));
    voyagePlanStore.add(planFrom({ uvid: 'urn:c', mmsi: '3', status: 7 }));
    assert.deepEqual(voyagePlanStore.monitored().map(p => p.uvid).sort(), ['urn:a', 'urn:c']);
});
test('the monitored fraction is knowable — the UI needs it to stay honest', () => {
    reset();
    voyagePlanStore.add(planFrom({ uvid: 'urn:a', mmsi: '1', status: 7 }));
    voyagePlanStore.add(planFrom({ uvid: 'urn:b', mmsi: '2', status: 3 }));
    assert.equal(voyagePlanStore.monitored().length, 1);
    assert.equal(voyagePlanStore.count(), 2);
});

console.log('remove');
test('removeByUvid returns the plan and clears the index', () => {
    reset();
    const p = voyagePlanStore.add(planFrom({ uvid: 'urn:a' }));
    assert.equal(voyagePlanStore.removeByUvid('urn:a'), p);
    assert.equal(voyagePlanStore.byUvid('urn:a'), null);
    assert.equal(voyagePlanStore.count(), 0);
});
test('removeByUvid on a missing key returns null and mutates nothing', () => {
    reset();
    voyagePlanStore.add(planFrom({ uvid: 'urn:a' }));
    assert.equal(voyagePlanStore.removeByUvid('nope'), null);
    assert.equal(voyagePlanStore.count(), 1);
});
test('removeByMmsi drops every plan for that vessel', () => {
    reset();
    voyagePlanStore.add(planFrom({ uvid: 'urn:a', mmsi: '1' }));
    voyagePlanStore.add(planFrom({ uvid: 'urn:b', mmsi: '1' }));
    voyagePlanStore.add(planFrom({ uvid: 'urn:c', mmsi: '2' }));
    assert.equal(voyagePlanStore.removeByMmsi('1'), 2);
    assert.equal(voyagePlanStore.count(), 1);
});

console.log('eviction — bounded AND announced');
test('the count cap is enforced, oldest first', () => {
    reset();
    const realMax = STM.MAX_PLANS;
    STM.MAX_PLANS = 3;
    try {
        for (let i = 0; i < 5; i++) {
            const p = voyagePlanStore.add(planFrom({ uvid: `urn:${i}`, name: `R${i}` }));
            p.receivedAt = 1000 + i;
        }
        assert.equal(voyagePlanStore.count(), 3);
        assert.equal(voyagePlanStore.byUvid('urn:0'), null, 'oldest went first');
        assert.ok(voyagePlanStore.byUvid('urn:4'), 'newest survived');
    } finally { STM.MAX_PLANS = realMax; }
});
test('eviction WARNS — silent truncation reads as "we have everything"', () => {
    reset();
    const realMax = STM.MAX_PLANS;
    STM.MAX_PLANS = 2;
    try {
        for (let i = 0; i < 4; i++) {
            const p = voyagePlanStore.add(planFrom({ uvid: `urn:${i}` }));
            p.receivedAt = 1000 + i;
        }
        assert.ok(warnings.some(w => w.includes('evicted')), 'must say what it dropped');
        assert.ok(eventsOf('vg1:voyagePlanEvicted').length > 0);
    } finally { STM.MAX_PLANS = realMax; }
});
test('the BYTE cap bites before the count cap on large routes', () => {
    reset();
    const realBytes = STM.MAX_PLAN_BYTES;
    STM.MAX_PLAN_BYTES = 4000;   // ~2 of our fixtures
    try {
        for (let i = 0; i < 6; i++) {
            const p = voyagePlanStore.add(planFrom({ uvid: `urn:${i}`, wps: 8 }));
            if (p) p.receivedAt = 1000 + i;
        }
        assert.ok(voyagePlanStore.count() < 6, 'byte cap enforced');
        assert.ok(voyagePlanStore.bytes() <= STM.MAX_PLAN_BYTES ||
                  voyagePlanStore.count() === 1, 'never evicts the last plan into nothing');
    } finally { STM.MAX_PLAN_BYTES = realBytes; }
});

console.log('raw preservation');
test('the original document survives storage for verbatim re-export', () => {
    reset();
    const xml = routeXml({ uvid: 'urn:a' });
    const p = voyagePlanStore.add(P(xml).plan);
    assert.equal(p.raw, xml);
});

console.log('persistence');
test('load() with no stored payload is a no-op, not an error', () => {
    reset();
    localStorage.clear();
    assert.deepEqual(voyagePlanStore.load(P), { loaded: 0, failed: 0 });
});
test('flushNow → load round-trips through localStorage', () => {
    reset();
    localStorage.clear();
    voyagePlanStore.add(planFrom({ uvid: 'urn:persist', mmsi: '265177000', status: 7 }));
    voyagePlanStore.flushNow();

    voyagePlanStore.clear();
    assert.equal(voyagePlanStore.count(), 0);

    const res = voyagePlanStore.load(P);
    assert.equal(res.loaded, 1, JSON.stringify(res));
    assert.ok(voyagePlanStore.byUvid('urn:persist'));
    assert.equal(voyagePlanStore.byMmsi('265177000').routeStatus, 7);
});
test('load() keeps PROVENANCE and separately marks the restore', () => {
    // These are two different facts. "Came from a VIS push" stays true across a
    // browser restart; "was restored from localStorage rather than re-confirmed
    // by its source" is what makes a restored plan slightly less trustworthy —
    // it may have been superseded while the tab was closed. Overwriting one with
    // the other loses information whichever way round it is done.
    reset(); localStorage.clear();
    const p = voyagePlanStore.add(planFrom({ uvid: 'urn:p' }));
    p.sourceOrigin = 'vis';
    voyagePlanStore.flushNow();
    voyagePlanStore.clear();
    voyagePlanStore.load(P);

    const back = voyagePlanStore.byUvid('urn:p');
    assert.equal(back.sourceOrigin, 'vis', 'provenance survives the round trip');
    assert.equal(back.restoredFromStorage, true, 'and the restore is recorded separately');
});
test('a freshly parsed plan is NOT marked as restored', () => {
    reset();
    const p = voyagePlanStore.add(planFrom({ uvid: 'urn:fresh' }));
    assert.equal(p.restoredFromStorage, undefined);
});
test('a corrupt stored payload is discarded with a warning, not thrown', () => {
    reset(); localStorage.clear();
    localStorage.setItem(STM.STORAGE_KEY, '{not json');
    assert.doesNotThrow(() => voyagePlanStore.load(P));
    assert.ok(warnings.some(w => w.includes('corrupt')));
});
test('individually unparseable rows are counted, not fatal', () => {
    reset(); localStorage.clear();
    localStorage.setItem(STM.STORAGE_KEY, JSON.stringify([
        { raw: routeXml({ uvid: 'urn:good' }) },
        { raw: '<route><broken>' },
        { raw: null },
    ]));
    const res = voyagePlanStore.load(P);
    assert.equal(res.loaded, 1);
    assert.equal(res.failed, 2);
});

console.log('interop with the codec');
test('a stored plan re-serialises to valid RTZ', () => {
    reset();
    const p = voyagePlanStore.add(planFrom({ uvid: 'urn:a', mmsi: '1', status: 7 }));
    const { report } = P(serialise(p));
    assert.ok(report.ok, JSON.stringify(report.warnings));
});

console.log(`\nvoyagePlanStore.test: ${passed} checks passed`);
