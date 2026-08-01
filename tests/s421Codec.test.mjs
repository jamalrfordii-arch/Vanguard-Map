// tests/s421Codec.test.mjs — the PROVISIONAL S-421 codec.
// Run from repo root:  node --import ./tests/_stubs/register.mjs tests/s421Codec.test.mjs
//
// ── WHAT THIS SUITE CAN AND CANNOT TELL YOU ─────────────────────────────────
//
// It CANNOT tell you the codec is standards-compliant. Every fixture below was
// written by the same reading of the S-421 model that wrote the parser, so they
// agree with each other by construction. A green run here means "internally
// consistent", never "reads real S-421". The IHO product register was under
// maintenance and the schema server refuses automated retrieval, so no real
// document was available when this was written (2026-07-30).
//
// What it CAN tell you, and what it is therefore built around:
//
//   · the GML geometry reading is right — that part IS specified, and axis order
//     is the one bug here that silently produces plausible wrong answers
//   · unknown values stay null instead of acquiring defaults
//   · the declared edition is recorded verbatim and never normalised
//   · A MISMATCHED DOCUMENT PRODUCES AN ACTIONABLE REPORT. This is the most
//     valuable test in the file. The codec's element names are inferred; the
//     first real document will disagree with some of them, and what happens then
//     decides whether this codec is a five-minute fix or a rewrite.

import assert from 'node:assert/strict';
import { DOMParser } from './_stubs/xmlDom.mjs';
import { parse, serialise, readPosition, elementCensus, FEATURE_NAMES } from '../s421Codec.js';
import { parseAny, sniff } from '../routeCodecs.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
const dp = () => new DOMParser();
const P = (xml) => parse(xml, { domParser: dp() });

const S421 = `<?xml version="1.0" encoding="UTF-8"?>
<Route xmlns="http://www.iho.int/S421/1.0" xmlns:gml="http://www.opengis.net/gml/3.2"
       uvid="urn:mrn:stm:voyage:id:demo:abc" productEdition="1.0.0">
  <RouteInfo routeName="GOTHENBURG - HANSTHOLM" routeStatus="7"
             vesselName="NORDIC TRADER" vesselMMSI="265177000"/>
  <Waypoints>
    <Waypoint id="1" name="GOTHENBURG PILOT">
      <gml:Point srsName="urn:ogc:def:crs:EPSG::4326"><gml:pos>57.60 11.65</gml:pos></gml:Point>
    </Waypoint>
    <Waypoint id="2" name="VINGA">
      <gml:Point srsName="urn:ogc:def:crs:EPSG::4326"><gml:pos>57.63 11.50</gml:pos></gml:Point>
      <Leg portsideXTD="0.15" starboardXTD="0.30" safetyDepth="15" speedMin="8" speedMax="14"/>
    </Waypoint>
  </Waypoints>
  <Schedule name="PLANNED">
    <Manual>
      <ScheduleElement waypointId="1" etd="2026-07-29T06:00:00Z"/>
      <ScheduleElement waypointId="2" eta="2026-07-29T06:25:00Z"/>
    </Manual>
  </Schedule>
</Route>`;

console.log('GML geometry — the part that is actually specified');
test('EPSG::4326 URN is LATITUDE first', () => {
    const { plan } = P(S421);
    assert.ok(plan, 'no plan');
    assert.equal(plan.waypoints[0].lat, 57.60);
    assert.equal(plan.waypoints[0].lon, 11.65);
});
test('CRS84 is LONGITUDE first — the silent-wrong-answer case', () => {
    // In the Kattegat both orderings land somewhere plausible on the globe, so
    // getting this wrong does not announce itself.
    const doc = dp().parseFromString(
        `<Waypoint xmlns:gml="http://www.opengis.net/gml/3.2">
           <gml:Point srsName="http://www.opengis.net/def/crs/OGC/1.3/CRS84">
             <gml:pos>11.65 57.60</gml:pos></gml:Point></Waypoint>`, 'application/xml');
    const pos = readPosition(doc.documentElement);
    assert.equal(pos.lat, 57.60, 'CRS84 puts longitude first');
    assert.equal(pos.lon, 11.65);
});
test('srsName is inherited from an ancestor when the pos does not carry it', () => {
    const doc = dp().parseFromString(
        `<Waypoints xmlns:gml="http://www.opengis.net/gml/3.2" srsName="http://www.opengis.net/def/crs/OGC/1.3/CRS84">
           <Waypoint><gml:Point><gml:pos>11.65 57.60</gml:pos></gml:Point></Waypoint></Waypoints>`,
        'application/xml');
    const wp = doc.documentElement.getElementsByTagName('Waypoint')[0];
    assert.equal(readPosition(wp).lat, 57.60);
});
test('posList is read as well as pos', () => {
    const doc = dp().parseFromString(
        `<W xmlns:gml="http://www.opengis.net/gml/3.2"><gml:LineString srsName="urn:ogc:def:crs:EPSG::4326">
           <gml:posList>57.60 11.65 57.63 11.50</gml:posList></gml:LineString></W>`, 'application/xml');
    const pos = readPosition(doc.documentElement);
    assert.equal(pos.lat, 57.60);
    assert.equal(pos.lon, 11.65);
});
test('out-of-range and malformed coordinates are rejected, not clamped', () => {
    for (const body of ['<gml:pos>500 11</gml:pos>', '<gml:pos>57</gml:pos>',
                        '<gml:pos>abc def</gml:pos>', '<gml:pos></gml:pos>']) {
        const doc = dp().parseFromString(
            `<W xmlns:gml="http://www.opengis.net/gml/3.2"><gml:Point>${body}</gml:Point></W>`,
            'application/xml');
        assert.equal(readPosition(doc.documentElement), null, body);
    }
});
test('readPosition on nothing returns null rather than throwing', () => {
    assert.doesNotThrow(() => readPosition(null));
    assert.equal(readPosition(null), null);
});

console.log('the canonical plan');
test('route identity and vessel come through', () => {
    const { plan } = P(S421);
    assert.equal(plan.routeName, 'GOTHENBURG - HANSTHOLM');
    assert.equal(plan.routeStatus, 7);
    assert.equal(plan.mmsi, '265177000');
    assert.equal(plan.uvid, 'urn:mrn:stm:voyage:id:demo:abc');
});
test('per-leg XTD is read per leg, never globally', () => {
    const { plan } = P(S421);
    assert.equal(plan.waypoints[0].leg, null, 'the first waypoint has no inbound leg');
    assert.equal(plan.waypoints[1].leg.portsideXTD, 0.15);
    assert.equal(plan.waypoints[1].leg.starboardXTD, 0.30);
});
test('an undeclared XTD stays NULL — no default is invented', () => {
    const x = S421.replace('portsideXTD="0.15" starboardXTD="0.30" ', '');
    const { plan } = P(x);
    assert.equal(plan.waypoints[1].leg.portsideXTD, null);
    assert.equal(plan.waypoints[1].leg.starboardXTD, null,
        'a default here is a threshold WE invented, reported as if the ship declared it');
});
test('schedules are read with their kind', () => {
    const { plan } = P(S421);
    assert.equal(plan.schedules.length, 1);
    assert.equal(plan.schedules[0].kind, 'manual');
    assert.equal(plan.schedules[0].elements.length, 2);
    assert.equal(plan.schedules[0].elements[0].etd, '2026-07-29T06:00:00Z');
});
test('a value in a CHILD ELEMENT is read as well as an attribute', () => {
    // S-100 GML encodings favour child elements where RTZ uses attributes, and
    // real exporters are inconsistent. Both must work or half a file parses null.
    // Written out in full rather than string-surgered from S421 — the first
    // version of this test built its fixture with three chained .replace() calls
    // and produced malformed XML, so it failed for a reason that had nothing to
    // do with the behaviour under test.
    const x = `<?xml version="1.0"?>
<Route xmlns="http://www.iho.int/S421/1.0" xmlns:gml="http://www.opengis.net/gml/3.2">
  <RouteInfo routeStatus="7" vesselMMSI="265177000">
    <routeName>CHILD ELEMENT NAME</routeName>
  </RouteInfo>
  <Waypoints>
    <Waypoint id="1"><gml:Point srsName="urn:ogc:def:crs:EPSG::4326"><gml:pos>57.60 11.65</gml:pos></gml:Point></Waypoint>
    <Waypoint id="2"><gml:Point srsName="urn:ogc:def:crs:EPSG::4326"><gml:pos>57.63 11.50</gml:pos></gml:Point></Waypoint>
  </Waypoints>
</Route>`;
    const { plan, report } = P(x);
    assert.ok(plan, 'fixture did not parse: ' + JSON.stringify(report.warnings));
    assert.equal(plan.routeName, 'CHILD ELEMENT NAME');
    assert.equal(plan.mmsi, '265177000', 'the attribute form still works alongside it');
});

console.log('EDITIONS — recorded, never normalised');
test('the declared edition is kept verbatim', () => {
    const { plan, report } = P(S421);
    assert.equal(report.version, '1.0.0');
    assert.equal(plan.sourceVersion, '1.0.0');
    assert.equal(plan.sourceFormat, 'S421');
});
test('a DIFFERENT declared edition is kept verbatim too — not harmonised', () => {
    const { plan } = P(S421.replace('productEdition="1.0.0"', 'productEdition="5.2.0"'));
    assert.equal(plan.sourceVersion, '5.2.0',
        'two editions may differ on geometry or CRS handling; silently harmonising ' +
        'them computes thresholds against the wrong reference');
});
test('no declared edition is recorded as unknown, and SAID so', () => {
    const { plan, report } = P(S421.replace(' productEdition="1.0.0"', ''));
    assert.equal(plan.sourceVersion, null, 'null, not a guessed default');
    assert.ok(report.warnings.some(w => w.code === 'S421_EDITION_UNDECLARED'));
});
test('the namespace the document declared is retained', () => {
    const { plan } = P(S421);
    assert.match(plan.sourceNamespace, /S421/);
});

console.log('PROVISIONAL — every plan is marked');
test('parse() marks its output as coming from an unverified codec', () => {
    assert.equal(P(S421).plan.provisionalCodec, true);
    assert.equal(P(S421).report.provisional, true);
});
test('the registry marks it too, and routes S-421 by namespace', () => {
    assert.equal(sniff(S421).id, 'S421', 'the S421 namespace wins over the <Route> root name');
    const { plan, format } = parseAny(S421, { domParser: dp() });
    assert.equal(format, 'S421');
    assert.equal(plan.provisionalCodec, true);
});
test('an RTZ document still goes to RTZ, not to S-421', () => {
    // Both use <Route>/<route>. Regression guard for the collision.
    const rtzDoc = `<route version="1.1" xmlns="http://www.cirm.org/RTZ/1/1">
        <routeInfo routeName="X" vesselMMSI="1" routeStatus="7"/><waypoints>
        <waypoint id="1"><position lat="57.6" lon="11.6"/></waypoint>
        <waypoint id="2"><position lat="57.7" lon="11.5"/></waypoint></waypoints></route>`;
    assert.equal(sniff(rtzDoc).id, 'RTZ');
    assert.equal(parseAny(rtzDoc, { domParser: dp() }).format, 'RTZ');
});

console.log('THE ACTIONABLE FAILURE — how one real document repairs this codec');
test('a document whose names do not match reports WHAT IT FOUND', () => {
    const alien = `<?xml version="1.0"?>
      <Route xmlns="http://www.iho.int/S421/1.0" xmlns:gml="http://www.opengis.net/gml/3.2">
        <RouteInfo routeName="X" routeStatus="7"/>
        <RteWaypoints>
          <RtePoint id="1"><gml:Point><gml:pos>57.6 11.6</gml:pos></gml:Point></RtePoint>
          <RtePoint id="2"><gml:Point><gml:pos>57.7 11.5</gml:pos></gml:Point></RtePoint>
        </RteWaypoints>
      </Route>`;
    const { plan, report } = P(alien);
    assert.equal(plan, null);
    const w = report.warnings.find(x => x.code === 'S421_NAMES_DID_NOT_MATCH');
    assert.ok(w, 'must not fail as a generic "no waypoints"');
    assert.match(w.detail, /RtePoint/, 'the names actually present must be listed');
    assert.match(w.detail, /PROVISIONAL/, 'and it must say why it might be our fault');
    assert.match(w.detail, /FEATURE_NAMES/, 'and name the thing to fix');
});
test('elementCensus ranks by frequency so the real waypoint name stands out', () => {
    const doc = dp().parseFromString(
        '<R><A/><B/><B/><B/><C/><C/></R>', 'application/xml');
    const census = elementCensus(doc.documentElement);
    assert.equal(census[0], 'B×3');
    assert.equal(census[1], 'C×2');
});
test('every FEATURE_NAMES role offers more than one spelling', () => {
    // Leniency is free here; strictness costs a rejected valid file.
    for (const [role, names] of Object.entries(FEATURE_NAMES)) {
        assert.ok(names.length >= 2, `${role} has only one accepted spelling`);
    }
});

console.log('malformed input');
test('empty, non-string and broken XML each produce a report, never a half-plan', () => {
    for (const bad of ['', '   ', null, undefined, 42]) {
        const { plan, report } = P(bad);
        assert.equal(plan, null);
        assert.ok(report.warnings.length);
    }
});
test('a route with one waypoint is rejected with a reason', () => {
    const one = S421.replace(/<Waypoint id="2"[\s\S]*?<\/Waypoint>/, '');
    const { plan, report } = P(one);
    assert.equal(plan, null);
    assert.ok(report.warnings.some(w => w.code === 'INSUFFICIENT_WAYPOINTS'));
});
test('a plan with no routeStatus is stored but flagged as unmonitorable', () => {
    const { plan, report } = P(S421.replace(' routeStatus="7"', ''));
    assert.ok(plan, 'still a usable plan');
    assert.equal(plan.routeStatus, null);
    assert.ok(report.warnings.some(w => w.code === 'ROUTE_STATUS_ABSENT'));
});

console.log('round trip — internally consistent, NOT standards-validated');
test('parse(serialise(parse(x))) deep-equals parse(x) on the fields that matter', () => {
    // Both halves share the same inferred names, so this proves our model
    // survives the trip and nothing more. It would pass just as green if every
    // element name in this codec were wrong.
    const a = P(S421).plan;
    const b = P(serialise(a)).plan;
    assert.ok(b, 'the serialiser produced something the parser rejected');
    for (const k of ['routeName', 'routeStatus', 'mmsi', 'uvid', 'sourceFormat', 'sourceVersion']) {
        assert.deepEqual(b[k], a[k], k);
    }
    assert.deepEqual(b.waypoints.map(w => [w.id, w.lat, w.lon]),
                     a.waypoints.map(w => [w.id, w.lat, w.lon]));
    assert.deepEqual(b.waypoints[1].leg, a.waypoints[1].leg);
    assert.deepEqual(b.schedules, a.schedules);
});
test('serialise emits lat-first under the EPSG URN it declares', () => {
    const xml = serialise(P(S421).plan);
    assert.match(xml, /srsName="urn:ogc:def:crs:EPSG::4326"/);
    assert.match(xml, /<gml:pos>57\.6 11\.65<\/gml:pos>/);
});
test('serialise(null) is an empty string, not a crash', () => {
    assert.equal(serialise(null), '');
});

console.log(`\ns421Codec.test: ${passed} checks passed`);

// Appended: the operator-facing half. A provisional codec that does not SAY it
// is provisional is worse than no codec — it launders an inferred mapping into
// something that reads as authoritative in the import log.
import { summariseImport } from '../stmPanel.js';

console.log('the operator is told');
test('an import summary flags a provisionally-parsed plan', () => {
    const { plan } = P(S421);
    const s = summariseImport([{ name: 'demo.gml', plan, report: { ok: true, warnings: [], droppedElements: [] } }]);
    assert.match(s, /PROVISIONAL/);
    assert.match(s, /S421/);
    assert.match(s, /not validated against a real document/);
});
test('an RTZ plan carries no such warning', () => {
    const s = summariseImport([{ name: 'a.rtz',
        plan: { routeName: 'X', mmsi: '1', routeStatus: 7, waypoints: [{ id: 1, leg: null }, { id: 2, leg: null }], sourceFormat: 'RTZ' },
        report: { ok: true, warnings: [], droppedElements: [] } }]);
    assert.doesNotMatch(s, /PROVISIONAL/);
});

console.log(`\ns421Codec.test (with panel): ${passed} checks passed`);
