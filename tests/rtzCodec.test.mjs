// tests/rtzCodec.test.mjs — RTZ route plan ⇄ canonical VoyagePlan.
// Run from repo root:  node tests/rtzCodec.test.mjs
// Pure node. Uses tests/_stubs/xmlDom.mjs for DOMParser (Node has none, and the
// project has no dependencies).
//
// The tests that earn their keep here:
//   · round-trip identity — parse(serialise(parse(x))) === parse(x). This is
//     what catches unit-conversion and time-format bugs the moment they appear.
//   · XTD unit inference reports which branch it took, rather than silently
//     changing a monitoring threshold by a factor of 1852.
//   · <defaultWaypoint> attributes actually reach the legs that omit them.
//   · malformed input produces a report, never a half-built plan.

import assert from 'node:assert/strict';
import { DOMParser } from './_stubs/xmlDom.mjs';
import {
    parse, serialise, isMonitoring, activeSchedule, scheduleElementFor,
    ROUTE_STATUS, ROUTE_STATUS_MONITORING, RTZ_NS,
} from '../rtzCodec.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
const near = (a, b, tol, msg) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ±${tol}, got ${a}`);

const dp = new DOMParser();
const P = (xml, opts = {}) => parse(xml, { domParser: dp, ...opts });

// ── fixtures ─────────────────────────────────────────────────────────────────

// A realistic STM-flavoured route: Gothenburg approaches outbound, RTZ 1.1,
// asymmetric XTD, a mixed schedule, and a vendor extension we must not destroy.
const GOTHENBURG = `<?xml version="1.0" encoding="UTF-8"?>
<route version="1.1" xmlns="http://www.cirm.org/RTZ/1/1">
  <routeInfo routeName="GOTHENBURG - ROTTERDAM"
             routeAuthor="MASTER"
             routeStatus="7"
             vesselName="NORDIC TRADER"
             vesselMMSI="265177000"
             vesselIMO="9123456"
             vesselVoyage="urn:mrn:stm:voyage:id:acme:b6d7b492-ab3c-42f2-8afd-116c3d872f0c"
             validityPeriodStart="2026-07-29T06:00:00Z"
             validityPeriodStop="2026-08-01T18:00:00Z"/>
  <waypoints>
    <defaultWaypoint>
      <leg geometryType="Loxodrome" portsideXTD="0.25" starboardXTD="0.25" safetyDepth="15"/>
    </defaultWaypoint>
    <waypoint id="1" revision="0" name="GOTHENBURG PILOT" radius="0.5">
      <position lat="57.6000" lon="11.6000"/>
    </waypoint>
    <waypoint id="2" revision="0" name="VINGA" radius="0.4">
      <position lat="57.6300" lon="11.6000"/>
      <leg geometryType="Loxodrome" portsideXTD="0.15" starboardXTD="0.30"
           safetyDepth="18" speedMin="8" speedMax="14" legNote1="TSS INBOUND LANE"/>
    </waypoint>
    <waypoint id="3" revision="0" name="SKAGEN" radius="1.0">
      <position lat="57.7000" lon="10.5000"/>
      <leg geometryType="Orthodrome" speedMax="16"/>
    </waypoint>
  </waypoints>
  <schedules>
    <schedule id="1" name="MONITORING">
      <manual>
        <scheduleElement waypointId="1" etd="2026-07-29T06:00:00Z" speed="10"/>
        <scheduleElement waypointId="2" eta="2026-07-29T06:30:00Z"
                         etaWindowBefore="00:15" etaWindowAfter="00:45" speed="12" speedWindow="1.5"/>
        <scheduleElement waypointId="3" eta="2026-07-29T10:00:00Z" stay="00.02.30"/>
      </manual>
      <calculated>
        <scheduleElement waypointId="2" eta="2026-07-29T06:35:00Z"/>
      </calculated>
    </schedule>
  </schedules>
  <extensions>
    <extension manufacturer="ACME" name="AcmeRouteExt" version="2.0">
      <acmeThing value="keep me"/>
    </extension>
  </extensions>
</route>`;

const MINIMAL_10 = `<?xml version="1.0"?>
<route version="1.0" xmlns="http://www.cirm.org/RTZ/1/0">
  <routeInfo routeName="MINIMAL"/>
  <waypoints>
    <waypoint id="1"><position lat="0" lon="0"/></waypoint>
    <waypoint id="2"><position lat="0" lon="1"/></waypoint>
  </waypoints>
</route>`;

console.log('parse — happy path');
test('parses routeInfo into the canonical plan', () => {
    const { plan, report } = P(GOTHENBURG);
    assert.ok(report.ok, 'report should be ok');
    assert.equal(report.version, '1.1');
    assert.equal(plan.routeName, 'GOTHENBURG - ROTTERDAM');
    assert.equal(plan.vesselName, 'NORDIC TRADER');
    assert.equal(plan.mmsi, '265177000');
    assert.equal(plan.imo, '9123456');
    assert.equal(plan.routeStatus, 7);
    assert.equal(plan.uvid, 'urn:mrn:stm:voyage:id:acme:b6d7b492-ab3c-42f2-8afd-116c3d872f0c');
    assert.equal(plan.sourceFormat, 'RTZ_1_1');
});
test('validity period parses to epoch ms', () => {
    const { plan } = P(GOTHENBURG);
    assert.equal(plan.validFrom, Date.parse('2026-07-29T06:00:00Z'));
    assert.equal(plan.validTo, Date.parse('2026-08-01T18:00:00Z'));
});
test('waypoints parse with positions, radius and ids', () => {
    const { plan } = P(GOTHENBURG);
    assert.equal(plan.waypoints.length, 3);
    assert.deepEqual(plan.waypoints.map(w => w.id), [1, 2, 3]);
    near(plan.waypoints[0].lat, 57.6, 1e-9);
    near(plan.waypoints[0].lon, 11.6, 1e-9);
    assert.equal(plan.waypoints[0].name, 'GOTHENBURG PILOT');
    near(plan.waypoints[2].radius, 1.0, 1e-9);
});
test('MMSI is a STRING (leading zeros in some MIDs are significant)', () => {
    const { plan } = P(GOTHENBURG);
    assert.equal(typeof plan.mmsi, 'string');
});

console.log('parse — defaultWaypoint inheritance');
test('a leg that omits XTD inherits it from <defaultWaypoint>', () => {
    const { plan } = P(GOTHENBURG);
    // wp3's own leg declares only geometryType + speedMax.
    const leg3 = plan.waypoints[2].leg;
    near(leg3.portsideXTD, 0.25, 1e-9, 'inherited from default');
    near(leg3.starboardXTD, 0.25, 1e-9, 'inherited from default');
    near(leg3.safetyDepth, 15, 1e-9, 'inherited from default');
});
test('an explicitly declared attribute OVERRIDES the default', () => {
    const { plan } = P(GOTHENBURG);
    const leg2 = plan.waypoints[1].leg;
    near(leg2.portsideXTD, 0.15, 1e-9);
    near(leg2.starboardXTD, 0.30, 1e-9);
    near(leg2.safetyDepth, 18, 1e-9);
});
test('merging is per-attribute, not whole-object', () => {
    // wp3 declares speedMax but not safetyDepth. A whole-object fallback would
    // drop the default safetyDepth entirely; the per-attribute merge keeps it.
    const { plan } = P(GOTHENBURG);
    const leg3 = plan.waypoints[2].leg;
    near(leg3.speedMax, 16, 1e-9, 'own value survives');
    near(leg3.safetyDepth, 15, 1e-9, 'default still applies to the unstated attribute');
    assert.equal(leg3.geometryType, 'Orthodrome', 'own geometryType wins over the default');
});
test('XTD is ASYMMETRIC and both sides survive', () => {
    const { plan } = P(GOTHENBURG);
    const leg2 = plan.waypoints[1].leg;
    assert.notEqual(leg2.portsideXTD, leg2.starboardXTD,
        'port and starboard corridors are different — collapsing them loses the plan');
});

console.log('parse — schedules');
test('manual and calculated schedules are separate canonical entries', () => {
    const { plan } = P(GOTHENBURG);
    assert.equal(plan.schedules.length, 2);
    assert.deepEqual(plan.schedules.map(s => s.kind).sort(), ['calculated', 'manual']);
});
test('activeSchedule prefers manual over calculated', () => {
    const { plan } = P(GOTHENBURG);
    assert.equal(activeSchedule(plan).kind, 'manual');
});
test('eta parses to epoch ms; windows parse to DURATIONS not clock times', () => {
    const { plan } = P(GOTHENBURG);
    const e = scheduleElementFor(plan, 2);
    assert.equal(e.eta, Date.parse('2026-07-29T06:30:00Z'));
    assert.equal(e.etaWindowBefore, 15 * 60_000, '00:15 is fifteen minutes, not 00:15 UTC');
    assert.equal(e.etaWindowAfter, 45 * 60_000);
    near(e.speedWindow, 1.5, 1e-9);
});
test('stay parses the dd.hh.mm form', () => {
    const { plan } = P(GOTHENBURG);
    assert.equal(scheduleElementFor(plan, 3).stay, (2 * 60 + 30) * 60_000, '00.02.30 = 2h30m');
});
test('a missing eta is null, not 0 or now', () => {
    const { plan } = P(GOTHENBURG);
    assert.equal(scheduleElementFor(plan, 1).eta, null);
    assert.equal(scheduleElementFor(plan, 1).etd, Date.parse('2026-07-29T06:00:00Z'));
});

console.log('parse — routeStatus');
test('status 7 is recognised as "used for monitoring"', () => {
    const { plan } = P(GOTHENBURG);
    assert.equal(plan.routeStatus, ROUTE_STATUS_MONITORING);
    assert.equal(ROUTE_STATUS[plan.routeStatus], 'USED FOR MONITORING');
    assert.equal(isMonitoring(plan), true);
});
test('a plan at status 2 is NOT monitoring (nobody is steering it)', () => {
    const { plan } = P(GOTHENBURG.replace('routeStatus="7"', 'routeStatus="2"'));
    assert.equal(isMonitoring(plan), false);
});
test('routeStatus carried only in <extensions> is still found', () => {
    const xml = `<route version="1.1"><routeInfo routeName="X"/>
      <waypoints><waypoint id="1"><position lat="0" lon="0"/></waypoint>
                 <waypoint id="2"><position lat="0" lon="1"/></waypoint></waypoints>
      <extensions><extension manufacturer="STM" name="RouteInfoExtensionSTM"
                             routeStatus="7" vesselVoyage="urn:mrn:stm:voyage:id:x:1"/></extensions>
      </route>`;
    const { plan } = P(xml);
    assert.equal(plan.routeStatus, 7);
    assert.equal(plan.uvid, 'urn:mrn:stm:voyage:id:x:1');
});
test('an out-of-range routeStatus is flagged, not silently accepted', () => {
    const { plan, report } = P(GOTHENBURG.replace('routeStatus="7"', 'routeStatus="99"'));
    assert.equal(plan.routeStatus, 99);
    assert.ok(report.warnings.some(w => w.code === 'UNKNOWN_ROUTE_STATUS'));
});

console.log('parse — XTD unit inference (the factor-of-1852 trap)');
test('values in the RTZ nautical-mile range are taken as NM', () => {
    const { plan, report } = P(GOTHENBURG);
    assert.equal(report.xtdUnitInferred, 'NM');
    near(plan.waypoints[1].leg.starboardXTD, 0.30, 1e-9);
});
test('a value above the NM range is read as METRES and converted', () => {
    const xml = GOTHENBURG.replace('starboardXTD="0.30"', 'starboardXTD="556"');
    const { plan, report } = P(xml);
    assert.equal(report.xtdUnitInferred, 'M');
    near(plan.waypoints[1].leg.starboardXTD, 556 / 1852, 1e-6, '556 m ≈ 0.3 nm');
});
test('the inference ANNOUNCES itself in the report', () => {
    const { report } = P(GOTHENBURG.replace('starboardXTD="0.30"', 'starboardXTD="556"'));
    const w = report.warnings.find(x => x.code === 'XTD_UNIT_INFERRED');
    assert.ok(w, 'a silent unit change is exactly what must not happen');
    assert.match(w.detail, /metres/);
});
test('the unit warning is emitted once, not once per leg', () => {
    const xml = GOTHENBURG
        .replace('portsideXTD="0.25" starboardXTD="0.25"', 'portsideXTD="463" starboardXTD="463"')
        .replace('portsideXTD="0.15" starboardXTD="0.30"', 'portsideXTD="278" starboardXTD="556"');
    const { report } = P(xml);
    assert.equal(report.warnings.filter(w => w.code === 'XTD_UNIT_INFERRED').length, 1);
});

console.log('parse — robustness');
test('a route with fewer than 2 waypoints is flagged and not ok', () => {
    const xml = `<route version="1.1"><routeInfo routeName="STUB"/>
      <waypoints><waypoint id="1"><position lat="0" lon="0"/></waypoint></waypoints></route>`;
    const { plan, report } = P(xml);
    assert.equal(report.ok, false);
    assert.ok(report.warnings.some(w => w.code === 'INSUFFICIENT_WAYPOINTS'));
    assert.equal(plan.waypoints.length, 1, 'what parsed is still returned for inspection');
});
test('a waypoint with no position is DROPPED and recorded', () => {
    const xml = `<route version="1.1"><routeInfo routeName="X"/><waypoints>
      <waypoint id="1"><position lat="0" lon="0"/></waypoint>
      <waypoint id="2"/>
      <waypoint id="3"><position lat="0" lon="1"/></waypoint></waypoints></route>`;
    const { plan, report } = P(xml);
    assert.deepEqual(plan.waypoints.map(w => w.id), [1, 3]);
    assert.ok(report.droppedElements.some(d => d.includes('id=2')));
});
test('an out-of-range position is dropped, not clamped', () => {
    const xml = `<route version="1.1"><routeInfo routeName="X"/><waypoints>
      <waypoint id="1"><position lat="0" lon="0"/></waypoint>
      <waypoint id="2"><position lat="91" lon="0"/></waypoint>
      <waypoint id="3"><position lat="0" lon="1"/></waypoint></waypoints></route>`;
    const { plan, report } = P(xml);
    assert.deepEqual(plan.waypoints.map(w => w.id), [1, 3]);
    assert.ok(report.droppedElements.some(d => d.includes('out of range')));
});
test('malformed XML returns a report, never a half-built plan', () => {
    const { plan, report } = P('<route><waypoints><waypoint></route>');
    assert.equal(plan, null);
    assert.ok(report.warnings.some(w => w.code === 'XML_PARSE_ERROR'));
});
test('a non-route document is rejected by root element', () => {
    const { plan, report } = P('<?xml version="1.0"?><notARoute/>');
    assert.equal(plan, null);
    assert.ok(report.warnings.some(w => w.code === 'NOT_AN_RTZ_ROUTE'));
});
test('empty input is rejected without throwing', () => {
    assert.equal(P('').plan, null);
    assert.equal(P('   ').plan, null);
});
test('an unknown version is parsed leniently but flagged', () => {
    const { plan, report } = P(GOTHENBURG.replace('version="1.1"', 'version="9.9"'));
    assert.ok(plan, 'still parsed');
    assert.ok(report.warnings.some(w => w.code === 'UNKNOWN_RTZ_VERSION'));
});
test('a namespace-prefixed document parses (real files are inconsistent)', () => {
    const xml = `<?xml version="1.0"?>
      <rtz:route xmlns:rtz="http://www.cirm.org/RTZ/1/1" version="1.1">
        <rtz:routeInfo routeName="PREFIXED"/>
        <rtz:waypoints>
          <rtz:waypoint id="1"><rtz:position lat="0" lon="0"/></rtz:waypoint>
          <rtz:waypoint id="2"><rtz:position lat="0" lon="1"/></rtz:waypoint>
        </rtz:waypoints>
      </rtz:route>`;
    const { plan, report } = P(xml);
    assert.ok(report.ok, JSON.stringify(report.warnings));
    assert.equal(plan.routeName, 'PREFIXED');
    assert.equal(plan.waypoints.length, 2);
});
test('a document with no namespace declared at all still parses', () => {
    const { plan, report } = P(MINIMAL_10.replace(' xmlns="http://www.cirm.org/RTZ/1/0"', ''));
    assert.ok(report.ok);
    assert.equal(plan.waypoints.length, 2);
});
test('comments and CDATA do not derail the parse', () => {
    const xml = `<?xml version="1.0"?>
      <!-- a leading comment -->
      <route version="1.1"><routeInfo routeName="C"/><waypoints>
        <!-- inline --><waypoint id="1"><position lat="0" lon="0"/></waypoint>
        <waypoint id="2"><position lat="0" lon="1"/></waypoint>
      </waypoints></route>`;
    assert.ok(P(xml).report.ok);
});
test('XML entities in attribute values are decoded', () => {
    const xml = MINIMAL_10.replace('routeName="MINIMAL"', 'routeName="A &amp; B &lt;1&gt;"');
    assert.equal(P(xml).plan.routeName, 'A & B <1>');
});

console.log('serialise');
test('emits a well-formed RTZ 1.1 document with the right namespace', () => {
    const { plan } = P(GOTHENBURG);
    const xml = serialise(plan);
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.ok(xml.includes(`xmlns="${RTZ_NS['1.1']}"`));
    assert.ok(xml.includes('version="1.1"'));
});
test('null fields are OMITTED, never emitted as empty attributes', () => {
    const { plan } = P(MINIMAL_10);
    const xml = serialise(plan);
    assert.ok(!/=""/.test(xml), `no empty attributes; got:\n${xml}`);
    assert.ok(!xml.includes('vesselMMSI'), 'absent MMSI must not appear at all');
});
test('the serialised document re-parses', () => {
    const { plan } = P(GOTHENBURG);
    const { report } = P(serialise(plan));
    assert.ok(report.ok, JSON.stringify(report.warnings));
});
test('special characters survive serialisation', () => {
    const { plan } = P(MINIMAL_10);
    plan.routeName = 'A & B <test> "quoted"';
    const round = P(serialise(plan)).plan;
    assert.equal(round.routeName, 'A & B <test> "quoted"');
});

console.log('ROUND-TRIP IDENTITY (the acceptance test)');
function stripVolatile(p) {
    // `raw` is the original bytes and legitimately differs; parseReport is
    // metadata about the parse, not the plan. Everything else must survive.
    const { raw, parseReport, sourceOrigin, receivedAt, ...rest } = p;
    return rest;
}
test('parse(serialise(parse(x))) deep-equals parse(x)', () => {
    const first = P(GOTHENBURG).plan;
    const second = P(serialise(first)).plan;
    assert.deepEqual(stripVolatile(second), stripVolatile(first));
});
test('round trip is STABLE — a second pass changes nothing further', () => {
    const a = P(GOTHENBURG).plan;
    const b = P(serialise(a)).plan;
    const c = P(serialise(b)).plan;
    assert.deepEqual(stripVolatile(c), stripVolatile(b));
});
test('round trip preserves asymmetric XTD exactly', () => {
    const a = P(GOTHENBURG).plan;
    const b = P(serialise(a)).plan;
    near(b.waypoints[1].leg.portsideXTD, 0.15, 1e-12);
    near(b.waypoints[1].leg.starboardXTD, 0.30, 1e-12);
});
test('round trip preserves schedule windows as durations', () => {
    const a = P(GOTHENBURG).plan;
    const b = P(serialise(a)).plan;
    const e = scheduleElementFor(b, 2);
    assert.equal(e.etaWindowBefore, 15 * 60_000);
    assert.equal(e.etaWindowAfter, 45 * 60_000);
    assert.equal(e.eta, Date.parse('2026-07-29T06:30:00Z'));
});
test('round trip preserves stay', () => {
    const a = P(GOTHENBURG).plan;
    const b = P(serialise(a)).plan;
    assert.equal(scheduleElementFor(b, 3).stay, (2 * 60 + 30) * 60_000);
});
test('round trip through a METRES file yields NM both times', () => {
    const xml = GOTHENBURG.replace('starboardXTD="0.30"', 'starboardXTD="556"');
    const a = P(xml).plan;
    const b = P(serialise(a)).plan;
    near(a.waypoints[1].leg.starboardXTD, 556 / 1852, 1e-9);
    near(b.waypoints[1].leg.starboardXTD, 556 / 1852, 1e-9);
    assert.equal(b.parseReport.xtdUnitInferred, 'NM',
        'the re-emitted document is in NM, so the second parse must NOT re-infer metres');
});

console.log('raw preservation (vendor extensions)');
test('the original document is retained verbatim on the plan', () => {
    const { plan } = P(GOTHENBURG);
    assert.equal(plan.raw, GOTHENBURG);
});
test('the retained raw still carries the vendor extension we do not model', () => {
    const { plan } = P(GOTHENBURG);
    assert.ok(plan.raw.includes('acmeThing'),
        'canonical serialisation drops it, so re-export must use raw when unmodified');
    assert.ok(!serialise(plan).includes('acmeThing'),
        'and this is exactly why: the canonical model cannot round-trip vendor nodes');
});

console.log('helpers');
test('activeSchedule / scheduleElementFor return null rather than guessing', () => {
    const { plan } = P(MINIMAL_10);
    assert.equal(activeSchedule(plan), null);
    assert.equal(scheduleElementFor(plan, 1), null);
});
test('isMonitoring is false for a null or statusless plan', () => {
    assert.equal(isMonitoring(null), false);
    assert.equal(isMonitoring(P(MINIMAL_10).plan), false);
});

console.log(`\nrtzCodec.test: ${passed} checks passed`);
