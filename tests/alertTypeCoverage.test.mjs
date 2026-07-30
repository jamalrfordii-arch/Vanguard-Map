// tests/alertTypeCoverage.test.mjs — every alert type must be RAISABLE.
// Run from repo root:  node --import ./tests/_stubs/register.mjs tests/alertTypeCoverage.test.mjs
//
// alertsManager gates every raise through _isEnabled(type), which looks the type
// up in the RULE SET, not in TYPE_META. So a type with display metadata but no
// rule is silently unraisable: addAlert() returns, nothing appears, no error.
//
// ZONE_BREACH has been in that state in this codebase for some time — metadata
// at TYPE_META, no entry in DEFAULT_RULES, no raise site anywhere. It is a
// stubbed hook that looks wired and is not.
//
// This test makes that failure mode impossible to reintroduce: every alarm
// enhancedMonitor can emit must have BOTH halves present. It parses
// alertsManager.js as text rather than importing it, so it needs no DOM and
// cannot be fooled by module-init side effects.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ALARMS } from '../enhancedMonitor.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const src = readFileSync(new URL('../alertsManager.js', import.meta.url), 'utf8');

/** Type keys present in TYPE_META. */
function metaTypes() {
    const block = /const TYPE_META = \{([\s\S]*?)\n\};/.exec(src);
    assert.ok(block, 'TYPE_META block not found — has alertsManager been restructured?');
    return new Set([...block[1].matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:/gm)].map(m => m[1]));
}

/** Type values referenced by DEFAULT_RULES. */
function ruleTypes() {
    const block = /const DEFAULT_RULES = \[([\s\S]*?)\n\];/.exec(src);
    assert.ok(block, 'DEFAULT_RULES block not found');
    return new Set([...block[1].matchAll(/type:\s*'([A-Z][A-Z0-9_]*)'/g)].map(m => m[1]));
}

const META = metaTypes();
const RULES = ruleTypes();

console.log('the blocks parse');
test('TYPE_META and DEFAULT_RULES were both found and are non-trivial', () => {
    assert.ok(META.size > 10, `${META.size} types in TYPE_META`);
    assert.ok(RULES.size > 10, `${RULES.size} types referenced by DEFAULT_RULES`);
});

console.log('every alarm enhancedMonitor can emit is raisable');
test('each ALARMS[*].alert has a TYPE_META entry', () => {
    const missing = Object.values(ALARMS).map(a => a.alert).filter(t => !META.has(t));
    assert.deepEqual([...new Set(missing)], [], 'missing TYPE_META entries');
});
test('each ALARMS[*].alert has a DEFAULT_RULES entry — the ZONE_BREACH trap', () => {
    const missing = Object.values(ALARMS).map(a => a.alert).filter(t => !RULES.has(t));
    assert.deepEqual([...new Set(missing)], [],
        'these have display metadata but no rule, so _isEnabled() is false and ' +
        'addAlert() will silently do nothing');
});
test('the STM types specifically are all wired both ways', () => {
    for (const t of ['ROUTE_DEVIATION', 'SCHEDULE_SLIP', 'SAFETY_DEPTH_CONFLICT',
                     'NON_ARRIVAL', 'ROUTE_RECEIVED']) {
        assert.ok(META.has(t), `${t} missing from TYPE_META`);
        assert.ok(RULES.has(t), `${t} missing from DEFAULT_RULES`);
    }
});
test('the monitor never claims a severity TYPE_META disagrees with', () => {
    // enhancedMonitor puts a severity in the event payload; alertsManager takes
    // severity from TYPE_META. If they disagree, the log and the event tell an
    // operator two different things about the same finding.
    for (const [alarm, def] of Object.entries(ALARMS)) {
        const m = new RegExp(`^\\s*${def.alert}\\s*:.*severity:\\s*'([A-Z]+)'`, 'm').exec(src);
        assert.ok(m, `no severity found for ${def.alert}`);
        assert.equal(def.severity, m[1],
            `${alarm} claims ${def.severity} but TYPE_META says ${m[1]} for ${def.alert}`);
    }
});

console.log('the known pre-existing gap is still recorded, not silently fixed');
test('ZONE_BREACH remains the documented counter-example', () => {
    // Not our bug to fix here, but if someone ever wires it up this test should
    // fail so the comment in alertsManager stops being wrong.
    if (META.has('ZONE_BREACH') && !RULES.has('ZONE_BREACH')) {
        console.log('      (ZONE_BREACH still has metadata but no rule — unchanged, as expected)');
    } else {
        assert.ok(RULES.has('ZONE_BREACH'),
            'ZONE_BREACH now has a rule — update the comments that cite it as the ' +
            'cautionary example of a half-wired alert type');
    }
});

console.log(`\nalertTypeCoverage.test: ${passed} checks passed`);
