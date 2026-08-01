// tests/stmPanel.test.mjs — the STM readout's formatting logic.
// Run from repo root:  node --import ./tests/_stubs/register.mjs tests/stmPanel.test.mjs
//
// The DOM half is covered in tests/browser/stmPanelDom.html. What is tested here
// is the part that decides WHAT THE OPERATOR IS TOLD, because that is where this
// panel can lie:
//
//   · UNKNOWN must always be shown, including when nothing is deviating. A
//     readout that says "0 deviating" and omits "428 unknown" is worse than no
//     readout at all.
//   · There must be no all-clear state.
//   · Parse warnings — above all the XTD unit inference, a factor of 1852 on a
//     monitoring threshold — must reach the message, not just a console.
//   · A plan that is not at status 7 must say that nothing is monitored against
//     it, because it looks identical to one that is.

import assert from 'node:assert/strict';
import { formatCoverage, summariseImport, isRouteFile, looksLikeFileDrag } from '../stmPanel.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
const rowFor = (rows, label) => rows.find(r => r.label === label);
const labels = (rows) => rows.map(r => r.label);

console.log('coverage — UNKNOWN is never hidden');
test('reports monitored out of total', () => {
    const rows = formatCoverage({ total: 431, monitored: 12, unmonitored: 419 });
    assert.equal(rowFor(rows, 'MONITORED').value, '12 of 431');
});
test('UNKNOWN is present even when NOTHING is deviating', () => {
    // The whole point. "0 deviating" alone reads as an all-clear.
    const rows = formatCoverage({ total: 431, monitored: 12, unmonitored: 419, deviating: 0 });
    assert.ok(rowFor(rows, 'UNKNOWN'), 'UNKNOWN row missing');
    assert.equal(rowFor(rows, 'UNKNOWN').value, '419');
    assert.equal(rowFor(rows, 'DEVIATING'), undefined, 'zero deviating is not worth a row');
});
test('UNKNOWN is present even when it is ZERO', () => {
    const rows = formatCoverage({ total: 3, monitored: 3, unmonitored: 0 });
    assert.equal(rowFor(rows, 'UNKNOWN').value, '0',
        'the row is structural — it must not appear and disappear');
});
test('there is no "OK" / "ALL CLEAR" row in any state', () => {
    for (const cov of [{ total: 0, monitored: 0, unmonitored: 0 },
                       { total: 3, monitored: 3, unmonitored: 0, deviating: 0 },
                       { total: 500, monitored: 1, unmonitored: 499 }]) {
        const text = JSON.stringify(formatCoverage(cov));
        assert.doesNotMatch(text, /\bOK\b|ALL CLEAR|CLEAR|NOMINAL|GOOD/i, text);
    }
});
test('unmonitored is derived when the field is absent', () => {
    const rows = formatCoverage({ total: 10, monitored: 4 });
    assert.equal(rowFor(rows, 'UNKNOWN').value, '6');
});
test('a deviating count is shown and coloured', () => {
    const rows = formatCoverage({ total: 3, monitored: 2, unmonitored: 1, deviating: 1 });
    const r = rowFor(rows, 'DEVIATING');
    assert.equal(r.value, '1');
    assert.ok(r.colour, 'a deviation must be visually distinct');
});
test('ARRIVED and STATIONARY are separate from ON_TRACK', () => {
    const rows = formatCoverage({ total: 5, monitored: 5, unmonitored: 0, arrived: 2, suppressed: 1 });
    assert.equal(rowFor(rows, 'ARRIVED').value, '2');
    assert.equal(rowFor(rows, 'STATIONARY').value, '1',
        'at anchor / moored / NUC is not the same as following the route');
});
test('null or empty coverage does not throw', () => {
    assert.doesNotThrow(() => formatCoverage(null));
    assert.doesNotThrow(() => formatCoverage({}));
    assert.equal(rowFor(formatCoverage(null), 'MONITORED').value, '0 of 0');
});

console.log('coverage — synthetic plans are declared as such');
test('an all-synthetic set says so explicitly', () => {
    const rows = formatCoverage({ total: 3, monitored: 2, unmonitored: 1 },
                                { totalPlans: 2, syntheticPlans: 2 });
    assert.match(rowFor(rows, 'PLANS').value, /all synthetic/,
        'a demo must never look like real shared plans');
});
test('a mixed set gives the synthetic count', () => {
    const rows = formatCoverage({ total: 3, monitored: 2, unmonitored: 1 },
                                { totalPlans: 5, syntheticPlans: 2 });
    assert.equal(rowFor(rows, 'PLANS').value, '5 (2 synthetic)');
});
test('an all-real set makes no synthetic claim', () => {
    const rows = formatCoverage({ total: 3, monitored: 2, unmonitored: 1 },
                                { totalPlans: 4, syntheticPlans: 0 });
    assert.equal(rowFor(rows, 'PLANS').value, '4');
});
test('with no plans at all the PLANS row is omitted', () => {
    assert.ok(!labels(formatCoverage({ total: 3, monitored: 0, unmonitored: 3 })).includes('PLANS'));
});

console.log('import summary');
const okPlan = (over = {}) => ({
    routeName: 'GOTHENBURG - HANSTHOLM', mmsi: '265177000', routeStatus: 7,
    waypoints: [
        { id: 1, leg: null },
        { id: 2, leg: { portsideXTD: 0.15, starboardXTD: 0.30 } },
    ],
    ...over,
});
const rep = (over = {}) => ({ ok: true, warnings: [], droppedElements: [], ...over });

test('a successful import names the route, MMSI, waypoints and XTD', () => {
    const s = summariseImport([{ name: 'a.rtz', plan: okPlan(), report: rep() }]);
    assert.match(s, /IMPORTED 1 ROUTE PLAN/);
    assert.match(s, /GOTHENBURG - HANSTHOLM/);
    assert.match(s, /265177000/);
    assert.match(s, /2 wp/);
    assert.match(s, /0\.15\/0\.3 nm|0\.15\/0\.30 nm/);
});
test('status 7 is reported as MONITORED', () => {
    assert.match(summariseImport([{ name: 'a.rtz', plan: okPlan(), report: rep() }]),
        /status 7 — MONITORED/);
});
test('a NON-7 status says plainly that nothing is monitored against it', () => {
    // The trap: a status-4 plan imports fine, draws nothing, alarms on nothing,
    // and looks exactly like a working import.
    const s = summariseImport([{ name: 'a.rtz', plan: okPlan({ routeStatus: 4 }), report: rep() }]);
    assert.match(s, /status 4 — not monitored/);
    assert.match(s, /nothing will be monitored against it/);
});
test('a plan declaring no corridor says so rather than showing blanks', () => {
    const p = okPlan({ waypoints: [{ id: 1, leg: null }, { id: 2, leg: null }] });
    assert.match(summariseImport([{ name: 'a.rtz', plan: p, report: rep() }]),
        /no corridor declared/);
});
test('THE XTD UNIT WARNING REACHES THE OPERATOR', () => {
    // A factor of 1852 applied to a monitoring threshold. Console-only is not
    // good enough.
    const s = summariseImport([{ name: 'a.rtz', plan: okPlan(), report: rep({
        warnings: [{ code: 'XTD_UNIT_INFERRED', detail: 'read as metres and converted' }],
    }) }]);
    assert.match(s, /WARNINGS/);
    assert.match(s, /XTD_UNIT_INFERRED/);
    assert.match(s, /metres/);
});
test('warnings are deduplicated by code across several files', () => {
    const w = rep({ warnings: [{ code: 'XTD_UNIT_INFERRED', detail: 'd' }] });
    const s = summariseImport([
        { name: 'a.rtz', plan: okPlan(), report: w },
        { name: 'b.rtz', plan: okPlan(), report: w },
    ]);
    assert.equal((s.match(/XTD_UNIT_INFERRED/g) ?? []).length, 1);
});
test('a rejected file is REPORTED, never silently skipped', () => {
    const s = summariseImport([{ name: 'junk.xml', plan: null,
        report: rep({ ok: false, warnings: [{ code: 'NOT_AN_RTZ_ROUTE', detail: 'root is <foo>' }] }) }]);
    assert.match(s, /REJECTED junk\.xml/);
    assert.match(s, /root is <foo>/);
});
test('a rejection with no detail still produces a message', () => {
    const s = summariseImport([{ name: 'x.rtz', plan: null, report: rep({ warnings: [] }) }]);
    assert.match(s, /REJECTED x\.rtz/);
    // Format-neutral ON PURPOSE (2026-07-30). The registry picks the codec, so a
    // fallback naming one format would tell an operator who dropped a valid
    // S-421 file that it was "not a usable RTZ document" — wrong, and misleading
    // about why it failed. parseAny emits UNRECOGNISED_ROUTE_FORMAT naming the
    // actual root element when it genuinely cannot place a document; this string
    // is only the last resort when a codec rejected without saying why.
    assert.match(s, /not a usable route plan document/);
    assert.doesNotMatch(s, /\bRTZ\b|\bS-421\b|\bGML\b/,
        'a generic rejection must not name one format — see routeCodecs.js');
});
test('dropped waypoints are counted and sampled', () => {
    const s = summariseImport([{ name: 'a.rtz', plan: okPlan(), report: rep({
        droppedElements: ['waypoint id=2 (missing position)', 'waypoint id=9 (out of range)'],
    }) }]);
    assert.match(s, /DROPPED 2 element/);
    assert.match(s, /id=2/);
});
test('the redundant INSUFFICIENT_WAYPOINTS warning is not repeated', () => {
    // It already surfaces as the rejection reason; printing it twice is noise.
    const s = summariseImport([{ name: 'a.rtz', plan: null, report: rep({
        ok: false, warnings: [{ code: 'INSUFFICIENT_WAYPOINTS', detail: '1 usable waypoint' }],
    }) }]);
    assert.match(s, /REJECTED/);
    assert.ok(!/WARNINGS/.test(s), 'no separate warnings block for it');
});
test('several plans are each listed', () => {
    const s = summariseImport([
        { name: 'a.rtz', plan: okPlan({ routeName: 'ALPHA' }), report: rep() },
        { name: 'b.rtz', plan: okPlan({ routeName: 'BRAVO' }), report: rep() },
    ]);
    assert.match(s, /IMPORTED 2 ROUTE PLANS/);
    assert.match(s, /ALPHA/);
    assert.match(s, /BRAVO/);
});
test('an empty outcome list produces an empty string, not a crash', () => {
    assert.equal(summariseImport([]), '');
});

console.log('file / drag predicates');
test('accepts the RTZ extensions, case-insensitively', () => {
    for (const n of ['r.rtz', 'r.RTZ', 'r.rtzp', 'route.xml', 'a.b.rtz']) {
        assert.equal(isRouteFile(n), true, n);
    }
});
test('rejects everything else, including null', () => {
    for (const n of ['r.json', 'r.ndjson', 'r.txt', 'r', '', null, undefined]) {
        assert.equal(isRouteFile(n), false, String(n));
    }
});
test('looksLikeFileDrag only fires for an actual file drag', () => {
    assert.equal(looksLikeFileDrag({ types: ['Files'] }), true);
    assert.equal(looksLikeFileDrag({ types: ['text/plain'] }), false);
    assert.equal(looksLikeFileDrag({ types: [] }), false);
    assert.equal(looksLikeFileDrag(null), false);
    assert.equal(looksLikeFileDrag(undefined), false);
});

console.log(`\nstmPanel.test: ${passed} checks passed`);
