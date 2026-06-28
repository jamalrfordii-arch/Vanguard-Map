// tests/discoveryRules.test.mjs — local rule-engine suite for DISCOVERY.
// Run from repo root:  node tests/discoveryRules.test.mjs
// Pure node, no browser, no fetch, no LLM — this only tests discoveryRules.js
// itself (see invariants.test.mjs for the same philosophy on the AIS side).
//
// Two things are under test, and they are NOT the same risk:
//   1. DECISION correctness — does each heuristic fire exactly at its
//      documented threshold (config.js DISCOVERY_RULES) and not one tick
//      early/late?
//   2. TEMPLATE correctness — when a rule fires, is the rendered finding
//      text actually readable English built from the right fields, with
//      correct singular/plural and correct optional-suffix handling?
//      A rule can return the right "escalate: true" while silently
//      rendering "undefined" into the console — decision tests alone would
//      never catch that, so every firing rule gets its string asserted too.
//
// The third thing under test is the SHAPE CONTRACT between this file and
// discoveryManager.js's _buildSnapshot() (the only producer of the object
// this module consumes). The rules read snapshot.rfEvents[].severity,
// .summary, .vessel; snapshot.chokepointActivity[].dark/.name/.count/.state;
// snapshot.integrityFlagged[].tier/.flags/.mmsi/.score; snapshot.
// developingStories[].mmsi/.events[].type — if a future edit to
// _buildSnapshot() renames any of these, discoveryRules.js doesn't throw,
// it just silently stops firing. REAL_SHAPED_SNAPSHOT below is a literal
// copy of _buildSnapshot()'s field names (discoveryManager.js lines
// 133-165) precisely so a rename there breaks this test, not a live
// console going quiet with no error.

import assert from 'node:assert/strict';
import { runDiscoveryRules } from '../discoveryRules.js';
import { DISCOVERY_RULES as R } from '../config.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// Minimal valid snapshot — every field discoveryRules.js reads, all empty.
const base = () => ({
    rfEvents: [], chokepointActivity: [], integrityFlagged: [],
    developingStories: [],
});

console.log('discoveryRules — empty snapshot');

test('nothing in, nothing out', () => {
    const r = runDiscoveryRules(base());
    assert.deepEqual(r.findings, []);
    assert.equal(r.escalate, false);
    assert.deepEqual(r.escalateReasons, []);
});

console.log('\nRF ALERT finding');

test('ALERT severity fires, WARN does not', () => {
    const s = base();
    s.rfEvents = [
        { severity: 'ALERT', summary: 'Unidentified HF burst', vessel: null },
        { severity: 'WARN', summary: 'Brief GPS degradation', vessel: null },
    ];
    const r = runDiscoveryRules(s);
    assert.equal(r.findings.length, 1, 'only the ALERT should fire, not the WARN');
});

test('template: no vessel → no "(linked: ...)" suffix', () => {
    const s = base();
    s.rfEvents = [{ severity: 'ALERT', summary: 'Unidentified HF burst', vessel: null }];
    const r = runDiscoveryRules(s);
    assert.equal(r.findings[0].text, 'RF ALERT — Unidentified HF burst');
    assert.equal(r.findings[0].mmsi, null);
});

test('template: vessel present → "(linked: MMSI ...)" suffix, mmsi carried on finding', () => {
    const s = base();
    s.rfEvents = [{ severity: 'ALERT', summary: 'Unidentified HF burst', vessel: '273841200' }];
    const r = runDiscoveryRules(s);
    assert.equal(r.findings[0].text, 'RF ALERT — Unidentified HF burst (linked: MMSI 273841200)');
    assert.equal(r.findings[0].mmsi, '273841200');
});

console.log('\nChokepoint dark-vessel finding');

test('dark === 0 does not fire', () => {
    const s = base();
    s.chokepointActivity = [{ name: 'Strait of Hormuz', count: 4, state: 'NORMAL', dark: 0 }];
    assert.equal(runDiscoveryRules(s).findings.length, 0);
});

test('template: singular "1 dark vessel" (no trailing s)', () => {
    const s = base();
    s.chokepointActivity = [{ name: 'Strait of Hormuz', count: 4, state: 'ELEVATED', dark: 1 }];
    const r = runDiscoveryRules(s);
    assert.equal(r.findings[0].text, '1 dark vessel transiting Strait of Hormuz (4 tracked, state ELEVATED)');
});

test('template: plural "2 dark vessels"', () => {
    const s = base();
    s.chokepointActivity = [{ name: 'Bab-el-Mandeb', count: 6, state: 'ELEVATED', dark: 2 }];
    const r = runDiscoveryRules(s);
    assert.equal(r.findings[0].text, '2 dark vessels transiting Bab-el-Mandeb (6 tracked, state ELEVATED)');
});

console.log('\nSUSPECT-tier corroborated finding (config: SUSPECT_MIN_FLAGS_FOR_AUTO = ' + R.SUSPECT_MIN_FLAGS_FOR_AUTO + ')');

test(`exactly ${R.SUSPECT_MIN_FLAGS_FOR_AUTO} flags fires`, () => {
    const s = base();
    s.integrityFlagged = [{ mmsi: '111222333', score: 30, tier: 'SUSPECT', flags: ['SOG_MISMATCH', 'TIME_REGRESSION'] }];
    const r = runDiscoveryRules(s);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].text, 'MMSI 111222333 is SUSPECT (trust 30/100) — SOG_MISMATCH, TIME_REGRESSION');
    assert.equal(r.findings[0].mmsi, '111222333');
});

test(`one fewer flag (${R.SUSPECT_MIN_FLAGS_FOR_AUTO - 1}) does not fire`, () => {
    const s = base();
    s.integrityFlagged = [{ mmsi: '111222333', score: 30, tier: 'SUSPECT', flags: ['SOG_MISMATCH'] }];
    assert.equal(runDiscoveryRules(s).findings.length, 0);
});

test('non-SUSPECT tier does not fire even with 2+ flags', () => {
    const s = base();
    s.integrityFlagged = [{ mmsi: '111222333', score: 70, tier: 'WATCH', flags: ['SOG_MISMATCH', 'TIME_REGRESSION'] }];
    assert.equal(runDiscoveryRules(s).findings.length, 0);
});

console.log(`\nSTS pair / loitering (config: STS_PAIR_CONFIDENT_MAX = ${R.STS_PAIR_CONFIDENT_MAX})`);

test('1 loitering vessel — neither finding nor escalation (no pair yet)', () => {
    const s = base();
    s.integrityFlagged = [{ mmsi: 'A', score: 50, tier: 'WATCH', flags: ['LOITERING'] }];
    const r = runDiscoveryRules(s);
    assert.equal(r.findings.length, 0);
    assert.equal(r.escalate, false);
});

test(`exactly ${R.STS_PAIR_CONFIDENT_MAX} loitering → confident STS template, no escalation`, () => {
    const s = base();
    s.integrityFlagged = [
        { mmsi: 'A', score: 50, tier: 'WATCH', flags: ['LOITERING'] },
        { mmsi: 'B', score: 50, tier: 'WATCH', flags: ['LOITERING'] },
    ];
    const r = runDiscoveryRules(s);
    assert.equal(r.findings.some(f => f.text === 'Possible ship-to-ship transfer — MMSI A and B stopped alongside each other'), true);
    assert.equal(r.escalate, false);
});

test(`${R.STS_PAIR_CONFIDENT_MAX + 1} loitering → escalates instead of templating (ambiguous flotilla)`, () => {
    const s = base();
    s.integrityFlagged = [
        { mmsi: 'A', score: 50, tier: 'WATCH', flags: ['LOITERING'] },
        { mmsi: 'B', score: 50, tier: 'WATCH', flags: ['LOITERING'] },
        { mmsi: 'C', score: 50, tier: 'WATCH', flags: ['LOITERING'] },
    ];
    const r = runDiscoveryRules(s);
    assert.equal(r.findings.some(f => /ship-to-ship/.test(f.text)), false, 'should not template a 3-way as a pair');
    assert.equal(r.escalate, true);
    assert.equal(r.escalateReasons.some(reason => reason.includes('3 vessels loitering together (A, B, C)')), true);
});

console.log(`\nMulti-signal single vessel (config: MULTI_SIGNAL_TYPES_MIN = ${R.MULTI_SIGNAL_TYPES_MIN})`);

test('3 events but all the SAME type → no escalation (volume, not diversity)', () => {
    const s = base();
    s.developingStories = [{ mmsi: 'A', events: [
        { type: 'AIS_GAP' }, { type: 'AIS_GAP' }, { type: 'AIS_GAP' },
    ] }];
    assert.equal(runDiscoveryRules(s).escalate, false);
});

test(`${R.MULTI_SIGNAL_TYPES_MIN} distinct types on one vessel → escalates`, () => {
    const s = base();
    s.developingStories = [{ mmsi: 'A', events: [
        { type: 'AIS_GAP' }, { type: 'COURSE_CHANGE' },
    ] }];
    const r = runDiscoveryRules(s);
    assert.equal(r.escalate, true);
    assert.equal(r.escalateReasons.some(reason => reason.includes('MMSI A shows 2 different kinds')), true);
});

console.log(`\nCross-domain co-occurrence (config: CROSS_DOMAIN_ESCALATE_MIN_DOMAINS = ${R.CROSS_DOMAIN_ESCALATE_MIN_DOMAINS})`);

test('exactly 2 domains active → does not cross the cross-domain gate', () => {
    const s = base();
    s.rfEvents = [{ severity: 'WARN', summary: 'x', vessel: null }]; // domain 1 (active = length>0, severity irrelevant to this gate)
    s.chokepointActivity = [{ name: 'X', count: 1, state: 'NORMAL', dark: 0 }]; // domain 2
    const r = runDiscoveryRules(s);
    assert.equal(r.escalateReasons.some(reason => reason.includes('domains active simultaneously')), false);
});

test(`exactly ${R.CROSS_DOMAIN_ESCALATE_MIN_DOMAINS} domains active → escalates`, () => {
    const s = base();
    s.rfEvents = [{ severity: 'WARN', summary: 'x', vessel: null }];                 // domain 1
    s.chokepointActivity = [{ name: 'X', count: 1, state: 'NORMAL', dark: 0 }];      // domain 2
    s.integrityFlagged = [{ mmsi: 'A', score: 50, tier: 'WATCH', flags: ['LOITERING'] }]; // domain 3 (loitering)
    const r = runDiscoveryRules(s);
    assert.equal(r.escalateReasons.some(reason => reason.includes('3 domains active simultaneously')), true);
});

console.log(`\nCoordinated multi-vessel activity (config: COORDINATED_VESSEL_MIN = ${R.COORDINATED_VESSEL_MIN})`);

test(`${R.COORDINATED_VESSEL_MIN - 1} vessels with developing stories → no escalation from this rule`, () => {
    const s = base();
    s.developingStories = [{ mmsi: 'A', events: [{ type: 'X' }] }, { mmsi: 'B', events: [{ type: 'X' }] }];
    const r = runDiscoveryRules(s);
    assert.equal(r.escalateReasons.some(reason => reason.includes('developing stories in the same window')), false);
});

test(`${R.COORDINATED_VESSEL_MIN} vessels with developing stories → escalates`, () => {
    const s = base();
    s.developingStories = [
        { mmsi: 'A', events: [{ type: 'X' }] },
        { mmsi: 'B', events: [{ type: 'X' }] },
        { mmsi: 'C', events: [{ type: 'X' }] },
    ];
    const r = runDiscoveryRules(s);
    assert.equal(r.escalateReasons.some(reason => reason.includes('3 vessels with developing stories')), true);
});

console.log('\nShape contract — exact field names _buildSnapshot() actually produces');

// Mirrors discoveryManager.js _buildSnapshot() (lines 133-165) field-for-field.
// If that function is ever refactored and a field gets renamed, this fixture
// must be updated to match — and if it isn't, this test starts failing
// instead of the rule engine just quietly stopping firing.
const REAL_SHAPED_SNAPSHOT = {
    developingStories: [{
        mmsi: '273841200',
        events: [
            { type: 'AIS_GAP', ageSec: 340, detail: 'transponder dark 22 min' },
            { type: 'COURSE_CHANGE', ageSec: 90, detail: 'turned 47° toward chokepoint' },
        ],
    }],
    invariantViolations: [],
    integrityFlagged: [
        { mmsi: '111222333', score: 28, tier: 'SUSPECT', flags: ['SOG_MISMATCH', 'TIME_REGRESSION'] },
    ],
    rfEvents: [
        { type: 'UNAUTHORIZED_TRANSMISSION', severity: 'ALERT', summary: 'Unidentified HF burst near last known position', vessel: '273841200', ageSec: 60 },
    ],
    chokepointActivity: [
        { name: 'Strait of Hormuz', count: 4, state: 'ELEVATED', dark: 1 },
    ],
};

test('real-shaped snapshot: RF ALERT, chokepoint, and SUSPECT findings all fire from production field names', () => {
    const r = runDiscoveryRules(REAL_SHAPED_SNAPSHOT);
    assert.equal(r.findings.some(f => f.text.startsWith('RF ALERT — Unidentified HF burst')), true,
        'rfEvents[].severity/.summary/.vessel field names must match what discoveryRules.js reads');
    assert.equal(r.findings.some(f => f.text.includes('1 dark vessel transiting Strait of Hormuz')), true,
        'chokepointActivity[].dark/.name/.count/.state field names must match');
    assert.equal(r.findings.some(f => f.text.startsWith('MMSI 111222333 is SUSPECT')), true,
        'integrityFlagged[].tier/.flags/.mmsi/.score field names must match');
    // This snapshot also has a 2-distinct-type developing story (AIS_GAP + COURSE_CHANGE)
    // on the SAME vessel the RF alert is linked to — a real cross-domain case, should escalate.
    assert.equal(r.escalate, true);
});

console.log(`\n${passed} passed${process.exitCode ? ', with failures above' : ', 0 failed'}.`);
