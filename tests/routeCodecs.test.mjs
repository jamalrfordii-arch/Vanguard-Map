// tests/routeCodecs.test.mjs — the format registry, and the boundary it exists to hold.
// Run from repo root:  node --import ./tests/_stubs/register.mjs tests/routeCodecs.test.mjs
//
// STM_ROUTE_SPEC §4.2 states the rule this file enforces: "If S-421 GML types are
// visible anywhere outside s421Codec.js, the uplift becomes a refactor of the
// entire subsystem instead of one file."
//
// That rule was already broken when it was written, and nothing noticed, because
// with ONE codec a boundary costs nothing to violate and shows no symptom. On
// 2026-07-30 the monitor imported scheduleElementFor from rtzCodec, the store
// imported ROUTE_STATUS_MONITORING from rtzCodec, and the panel imported parse
// from rtzCodec and printed "not a usable RTZ document" at an operator who might
// have dropped a perfectly valid file in another format.
//
// So this suite has two halves:
//
//   PART 1  the registry behaves — sniffing, reporting, provenance
//   PART 2  the boundary holds — a STATIC scan that fails if anything outside a
//           codec or the registry imports a codec, or if a format name leaks
//           into a string an operator reads
//
// Part 2 is the one that matters in six months. Behaviour tests pass whether or
// not the architecture survived; only a static check catches the import someone
// adds at 2am because it was one line shorter.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DOMParser } from './_stubs/xmlDom.mjs';
import {
    CODECS, register, codecById, rootTagOf, sniff, parseAny,
    acceptedExtensions, acceptedExtensionsText, formatsText,
    isRouteFile, provisionalCodecs,
} from '../routeCodecs.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const RTZ_MIN = `<?xml version="1.0" encoding="UTF-8"?>
<route version="1.1" xmlns="http://www.cirm.org/RTZ/1/1">
  <routeInfo routeName="TEST" vesselMMSI="265177000" routeStatus="7"/>
  <waypoints>
    <waypoint id="1"><position lat="57.60" lon="11.65"/></waypoint>
    <waypoint id="2"><position lat="57.63" lon="11.50"/>
      <leg portsideXTD="0.15" starboardXTD="0.30"/></waypoint>
  </waypoints>
</route>`;

// ════════════════════════════ PART 1 — BEHAVIOUR ════════════════════════════

console.log('root tag extraction');
test('reads the local name past the XML declaration', () => {
    assert.equal(rootTagOf(RTZ_MIN).root, 'route');
});
test('a namespace prefix on the root does not become part of the name', () => {
    assert.equal(rootTagOf('<rtz:route xmlns:rtz="http://www.cirm.org/RTZ/1/1"/>').root, 'route');
});
test('leading comments and DOCTYPE are skipped', () => {
    const x = '<!-- exported by SomeECDIS 4.2 -->\n<!DOCTYPE route>\n<route/>';
    assert.equal(rootTagOf(x).root, 'route');
});
test('a comment containing a fake root does not fool it', () => {
    assert.equal(rootTagOf('<!-- <notARoute> --><route/>').root, 'route');
});
test('non-strings and empty input return null rather than throwing', () => {
    for (const v of [null, undefined, 42, {}, '', '   ']) {
        assert.doesNotThrow(() => rootTagOf(v));
        assert.equal(rootTagOf(v), null, String(v));
    }
});

console.log('codec selection');
test('the RTZ namespace selects the RTZ codec', () => {
    assert.equal(sniff(RTZ_MIN).id, 'RTZ');
});
test('a bare <route> with NO namespace is still offered to RTZ', () => {
    // Real files in the wild omit the declaration. rtzCodec is lenient on read
    // for that reason; refusing here would reject documents it can handle.
    assert.equal(sniff('<route version="1.0"><routeInfo/></route>').id, 'RTZ');
});
test('namespace beats root name', () => {
    const odd = '<somethingElse xmlns="http://www.cirm.org/RTZ/1/1"/>';
    assert.equal(sniff(odd)?.id, 'RTZ');
});
test('an unrelated document selects nothing', () => {
    assert.equal(sniff('<html><body/></html>'), null);
    assert.equal(sniff('{"not":"xml"}'), null);
});

console.log('parseAny — one failure shape for every caller');
test('a good RTZ document parses and is stamped with its format', () => {
    const { plan, format } = parseAny(RTZ_MIN, { domParser: new DOMParser() });
    assert.ok(plan, 'no plan produced');
    assert.equal(format, 'RTZ');
    assert.equal(plan.sourceFormat, 'RTZ');
});
test('an unrecognised document reports the ROOT IT FOUND, not "unsupported"', () => {
    // "unsupported file" tells an operator nothing they can act on.
    const { plan, report, format } = parseAny('<foo><bar/></foo>');
    assert.equal(plan, null);
    assert.equal(format, null);
    assert.equal(report.ok, false);
    assert.equal(report.warnings[0].code, 'UNRECOGNISED_ROUTE_FORMAT');
    assert.match(report.warnings[0].detail, /root is <foo>/);
});
test('a file with no XML at all says so specifically', () => {
    const { report } = parseAny('just some text');
    assert.match(report.warnings[0].detail, /no XML element/);
});
test('the failure report has the same SHAPE a codec would produce', () => {
    // One failure path for every caller — ok / warnings[] / droppedElements[].
    const { report } = parseAny('<foo/>');
    assert.equal(typeof report.ok, 'boolean');
    assert.ok(Array.isArray(report.warnings));
    assert.ok(Array.isArray(report.droppedElements));
});

console.log('registry surface');
test('accepted extensions are derived, never written down twice', () => {
    // Asserts the PROPERTY, not a snapshot. The first version of this test
    // hard-coded ['rtz','rtzp','xml'] and failed the moment S-421 registered —
    // which is the behaviour the registry exists to produce. A test that has to
    // be edited every time the thing it guards works correctly is a test that
    // will eventually be edited without being read.
    const union = [...new Set(CODECS.flatMap(c => c.extensions))];
    assert.deepEqual(acceptedExtensions(), union, 'must be exactly the union, deduplicated');
    assert.equal(acceptedExtensions().length, new Set(acceptedExtensions()).size, 'no duplicates');
    assert.equal(acceptedExtensionsText(), union.map(e => '.' + e).join(' / '));
    assert.ok(acceptedExtensions().includes('rtz'), 'RTZ is registered, so .rtz is accepted');
});
test('isRouteFile follows the registry, including case', () => {
    for (const n of ['a.rtz', 'a.RTZ', 'a.rtzp', 'a.xml', 'x.y.rtz']) assert.equal(isRouteFile(n), true, n);
    for (const n of ['a.json', 'a.txt', 'a', '', null, undefined, '.rtz']) assert.equal(isRouteFile(n), false, String(n));
});
test('formatsText lists what is actually registered', () => {
    assert.equal(formatsText(), CODECS.map(c => c.label).join(' / '));
});
test('RTZ is not marked provisional', () => {
    assert.equal(codecById('RTZ').provisional, false);
    assert.ok(!provisionalCodecs().includes('RTZ'));
});

console.log('registering a second format changes NO caller');
test('a new codec is sniffed, parsed, and flows into the derived strings', () => {
    const before = acceptedExtensions().length;
    register({
        id: 'TESTFMT', label: 'TEST', extensions: ['tfmt'], roots: ['testroute'],
        nsMatch: 'example.invalid/TEST', provisional: true,
        parse: () => ({ plan: { routeName: 'X', sourceVersion: '9.9' }, report: { ok: true, warnings: [], droppedElements: [] } }),
    });
    try {
        assert.equal(sniff('<testroute/>').id, 'TESTFMT');
        assert.equal(isRouteFile('a.tfmt'), true, 'the panel would now accept it with no UI change');
        assert.equal(acceptedExtensions().length, before + 1);
        assert.match(formatsText(), /TEST/);

        const { plan, format } = parseAny('<testroute/>');
        assert.equal(format, 'TESTFMT');
        assert.equal(plan.sourceFormat, 'TESTFMT');
        assert.equal(plan.provisionalCodec, true, 'a provisional codec must mark its output');
        assert.equal(plan.sourceVersion, '9.9', 'the registry must not touch what the codec read');
        assert.ok(provisionalCodecs().includes('TEST'));
    } finally {
        CODECS.splice(CODECS.findIndex(c => c.id === 'TESTFMT'), 1);
    }
});
test('the registry never invents a version', () => {
    register({
        id: 'NOVER', label: 'NOVER', extensions: ['nover'], roots: ['nover'], nsMatch: null,
        parse: () => ({ plan: { routeName: 'X' }, report: { ok: true, warnings: [], droppedElements: [] } }),
    });
    try {
        const { plan } = parseAny('<nover/>');
        assert.equal(plan.sourceVersion, undefined,
            'an absent version must stay absent — a guessed edition is a threshold ' +
            'computed against the wrong reference');
    } finally {
        CODECS.splice(CODECS.findIndex(c => c.id === 'NOVER'), 1);
    }
});

// ════════════════════════════ PART 2 — THE BOUNDARY ═════════════════════════

const ROOT = new URL('..', import.meta.url);
const src = (f) => readFileSync(new URL(f, ROOT), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

const rootModules = readdirSync(ROOT)
    .filter(f => f.endsWith('.js') && !f.startsWith('._') && !/\.bak$/.test(f));

const isCodec = (f) => /Codec\.js$/.test(f);
const CODEC_RE = /from\s*['"]\.\/[A-Za-z0-9_]*[Cc]odec\.js['"]/;

// Modules allowed to import a codec directly, WITH the reason. Each entry is
// re-verified below: if it stops importing one, this test fails and tells you to
// delete the entry. Same discipline as moduleGraph's KNOWN_BROKEN — an
// allow-list that outlives its reason is how the original breach hid.
const ALLOWED = {
    'routeCodecs.js':
        'it IS the registry — being the one place that knows the codecs is its entire job.',
    'scenarioRoute.js':
        'imports serialise only. Generating a synthetic plan means CHOOSING an output '
      + 'format, and that choice belongs at the call site where it is visible, not '
      + 'hidden behind a registry that would have to guess.',
};

console.log('BOUNDARY — nothing outside a codec may import a codec');
test('no unexpected module imports a codec module', () => {
    const offenders = rootModules
        .filter(f => !isCodec(f) && !(f in ALLOWED))
        .filter(f => CODEC_RE.test(src(f)));
    assert.deepEqual(offenders, [],
        'these import a codec directly — route them through routeCodecs.js, or add '
      + 'an ALLOWED entry with a reason that survives being read aloud:\n'
      + offenders.map(f => `      ${f}`).join('\n'));
});
test('every ALLOWED entry is still importing a codec (delete it once it stops)', () => {
    const stale = Object.keys(ALLOWED).filter(f => rootModules.includes(f) && !CODEC_RE.test(src(f)));
    assert.deepEqual(stale, [],
        'these no longer import a codec — remove them from ALLOWED:\n'
      + stale.map(f => `      ${f}`).join('\n'));
});
test('scenarioRoute imports ONLY serialise, never a parser', () => {
    // The narrow exception must stay narrow. A parse import here would mean
    // synthetic-plan generation had quietly become an import path.
    const m = /import\s*\{([^}]*)\}\s*from\s*['"]\.\/rtzCodec\.js['"]/.exec(src('scenarioRoute.js'));
    assert.ok(m, 'expected scenarioRoute to import from rtzCodec');
    const names = m[1].split(',').map(s => s.trim()).filter(Boolean);
    assert.deepEqual(names, ['serialise'], `scenarioRoute imports ${names.join(', ')}`);
});

console.log('BOUNDARY — the monitor and the store know nothing about formats');
test('the monitoring path imports meaning from voyagePlan, not from a codec', () => {
    for (const f of ['enhancedMonitor.js', 'voyagePlanStore.js', 'routeGeometry.js', 'routeRibbon.js']) {
        assert.ok(!CODEC_RE.test(src(f)), `${f} imports a codec`);
    }
    assert.match(src('enhancedMonitor.js'), /from\s*['"]\.\/voyagePlan\.js['"]/);
    assert.match(src('voyagePlanStore.js'), /from\s*['"]\.\/voyagePlan\.js['"]/);
});
test('voyagePlan.js itself imports no codec — it is the format-free layer', () => {
    assert.ok(!CODEC_RE.test(src('voyagePlan.js')));
});

console.log('BOUNDARY — no format name reaches the operator');
test('stmPanel hard-codes no format name and no extension list', () => {
    // The panel may MENTION formats via formatsText()/acceptedExtensionsText().
    // What it must not do is spell one out, because that string goes stale the
    // moment a codec is registered and then it is simply a lie on screen.
    const s = src('stmPanel.js');
    for (const bad of [/['"`][^'"`]*\bRTZ\b[^'"`]*['"`]/, /\.rtzp?\b/, /\bS-421\b/, /\bGML\b/]) {
        assert.doesNotMatch(s, bad, `stmPanel.js contains ${bad} — use routeCodecs helpers`);
    }
    assert.match(s, /formatsText\(\)/, 'the drop label should come from the registry');
    assert.match(s, /acceptedExtensionsText\(\)/, 'the extension hint should come from the registry');
});

console.log(`\nrouteCodecs.test: ${passed} checks passed`);
