// tests/enhancedMonitor.test.mjs — STM Enhanced Monitoring.
// Run from repo root:  node --import ./tests/_stubs/register.mjs tests/enhancedMonitor.test.mjs
//
// This is the module that makes a claim ABOUT A SHIP, so the tests are written
// adversarially: most of them try to make it raise an alarm it should not.
//
//   · UNMONITORED must never look like compliant.
//   · Corner-cutting inside a declared turn radius is competent navigation.
//   · A vessel at anchor is not failing to follow its route.
//   · A stopped vessel has no projected ETA — division by ~zero must not
//     manufacture an infinite slip.
//   · An alarm raised on OUR default rather than the ship's declared value must
//     say so, in the message the operator reads.
//   · One alarm per cooldown window, not twelve a minute.

import './_stubs/domEnv.mjs';
import assert from 'node:assert/strict';
import { EnhancedMonitor, MONITOR_STATE, ALARMS } from '../enhancedMonitor.js';
import { voyagePlanStore } from '../voyagePlanStore.js';
import { scheduleElementFor } from '../voyagePlan.js';
import { planFromScenarioEntity } from '../scenarioRoute.js';
import { haversineNm } from '../dataSource.js';
import { simClock } from '../simClock.js';
import { STM } from '../config.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
const near = (a, b, tol, m) =>
    assert.ok(Math.abs(a - b) <= tol, `${m ?? ''} expected ${b} ±${tol}, got ${a}`);

const START = Date.parse('2026-07-29T06:00:00Z');
const MMSI = '265177000';

// A collecting fake for the alert channel, so we can assert exactly what an
// operator would have seen.
function fakeAlerts() {
    const raised = [];
    return { raised, addAlert(a) { raised.push(a); return a; } };
}

// Due-east equatorial route at 12 kn: 1° lon = 60.04 nm, so every distance and
// time in this suite is hand-checkable.
function makePlan(over = {}) {
    return planFromScenarioEntity({
        mmsi: MMSI, name: 'NORDIC TRADER', speedKts: 12,
        waypoints: [
            { lon: 0, lat: 0, name: 'A' },
            { lon: 1, lat: 0, name: 'B' },
            { lon: 2, lat: 0, name: 'C' },
        ],
        stmRoute: { routeName: 'TEST', xtdNm: 0.2, routeStatus: 7, ...over },
    }, { scenarioStartMs: START });
}

const vessel = (over = {}) => ({
    mmsi: MMSI, latDeg: 0, lonDeg: 0.5, speedKts: 12, cogDeg: 90,
    draughtM: null, navStatus: 0, isDark: false, ...over,
});

/** Offset in latitude that puts a vessel `nm` to STARBOARD of an eastbound leg. */
const stbdLat = (nm) => -nm / 60.04;

let mon, alerts;

/**
 * Sim time at which a vessel sitting at `lon` on the axis is EXACTLY on
 * schedule for waypoint B.
 *
 * Fixtures have to place the ship where its own declared schedule says it
 * should be, or a legitimate OUT_OF_SCHEDULE fires alongside whatever alarm the
 * test is really about. The first draft of this file put the vessel at lon 0.5
 * one hour in — 1.5 hours AHEAD of its own ETA — and eight tests failed because
 * the monitor was correct and the fixture was not.
 */
function onScheduleTime(lon) {
    const plan = voyagePlanStore.byMmsi(MMSI);
    const eta = scheduleElementFor(plan, 2)?.eta;
    if (eta == null) return START + 3600_000;
    const remainNm = haversineNm(0, lon, 0, 1);
    return Math.round(eta - (remainNm / 12) * 3600_000);
}

/** A vessel at `lon`, with the clock set so it is on schedule there. */
function atLon(lon, over = {}) {
    simClock.setTime(onScheduleTime(lon));
    return vessel({ lonDeg: lon, ...over });
}

function reset(planOver) {
    voyagePlanStore.clear();
    simClock.setTime(START + 3600_000);
    alerts = fakeAlerts();
    mon = new EnhancedMonitor({ store: voyagePlanStore, alerts });
    if (planOver !== null) {
        voyagePlanStore.add(makePlan(planOver ?? {}));
        // Default vessel sits at lon 0.5 — put the clock where that is on time,
        // so every non-schedule test is schedule-neutral by construction.
        simClock.setTime(onScheduleTime(0.5));
    }
    return mon;
}
/** Advance sim time and tick, so hysteresis can be exercised. */
function run(v, steps = 1, stepMs = STM.TICK_MS) {
    for (let i = 0; i < steps; i++) {
        simClock.setTime(simClock.now() + stepMs);
        mon.tick([v]);
    }
    return mon.stateOf(MMSI);
}
/** Hold a condition long enough for hysteresis to confirm it. */
const confirm = (v) => run(v, Math.ceil(STM.DEVIATION_CONFIRM_MS / STM.TICK_MS) + 2);

const events = [];
for (const n of ['vg1:routeDeviation', 'vg1:routeMonitorState', 'vg1:routeDeviationCleared']) {
    window.addEventListener(n, e => events.push({ type: n, detail: e.detail }));
}
const evOf = (t) => events.filter(e => e.type === t);

console.log('UNMONITORED is not compliant');
test('a vessel with no plan gets UNMONITORED and NO alarms', () => {
    reset(null);
    const s = run(vessel({ latDeg: stbdLat(50) }));   // wildly off any route
    assert.equal(s.state, MONITOR_STATE.UNMONITORED);
    assert.equal(s.alarms.size, 0);
    assert.equal(alerts.raised.length, 0, 'nothing to deviate from, so nothing to report');
});
test('coverage reports the unmonitored count out loud', () => {
    reset();
    mon.tick([vessel(), { mmsi: '111', latDeg: 0, lonDeg: 0 }, { mmsi: '222', latDeg: 1, lonDeg: 1 }]);
    const c = mon.monitoringCoverage();
    assert.equal(c.total, 3);
    assert.equal(c.monitored, 1);
    assert.equal(c.unmonitored, 2, 'the UI must be able to say "1 of 3 monitored"');
});
test('a plan at status 2 does NOT make the vessel monitored', () => {
    reset({ routeStatus: 2 });
    const s = run(vessel({ latDeg: stbdLat(5) }));
    assert.equal(s.state, MONITOR_STATE.UNMONITORED, 'nobody is steering a status-2 plan');
    assert.equal(alerts.raised.length, 0);
});
test('a vessel whose plan EXPIRES reverts to UNMONITORED', () => {
    voyagePlanStore.clear();
    simClock.setTime(START);
    alerts = fakeAlerts();
    mon = new EnhancedMonitor({ store: voyagePlanStore, alerts });
    const plan = makePlan();
    plan.validTo = START + 60_000;
    voyagePlanStore.add(plan);

    assert.notEqual(run(vessel()).state, MONITOR_STATE.UNMONITORED, 'monitored while valid');
    simClock.setTime(START + 120_000);
    mon.tick([vessel()]);
    assert.equal(mon.stateOf(MMSI).state, MONITOR_STATE.UNMONITORED,
        'an expired plan must stop being monitored, not keep alarming on a stale schedule');
});

console.log('ON_TRACK');
test('a vessel on its axis is ON_TRACK with no alarms', () => {
    reset();
    const s = confirm(vessel({ latDeg: 0, lonDeg: 0.5 }));
    assert.equal(s.state, MONITOR_STATE.ON_TRACK);
    assert.equal(s.alarms.size, 0);
    assert.equal(alerts.raised.length, 0);
});
test('measurements are recorded even when nothing is wrong', () => {
    reset();
    const s = run(vessel({ latDeg: 0, lonDeg: 0.5 }));
    assert.equal(s.legIndex, 0);
    near(s.crossTrackNm, 0, 0.01);
    assert.ok(s.distanceToNextWpNm > 0);
    assert.ok(s.distanceToEndNm > s.distanceToNextWpNm);
});

console.log('OFF_XTE — the threshold is the SHIP\'s declared corridor');
test('inside the declared corridor raises nothing', () => {
    reset({ xtdNm: 0.2 });
    const s = confirm(vessel({ latDeg: stbdLat(0.15), lonDeg: 0.5 }));
    assert.equal(s.state, MONITOR_STATE.ON_TRACK, '0.15 nm is inside a 0.2 nm corridor');
});
test('outside it raises OFF_XTE once confirmed', () => {
    reset({ xtdNm: 0.2 });
    const s = confirm(vessel({ latDeg: stbdLat(0.5), lonDeg: 0.5 }));
    assert.equal(s.state, MONITOR_STATE.DEVIATING);
    assert.ok(s.alarms.get('OFF_XTE')?.confirmed);
    assert.equal(alerts.raised.length, 1);
    assert.equal(alerts.raised[0].type, ALARMS.OFF_XTE.alert);
});
test('the ASYMMETRIC corridor is honoured per side', () => {
    // 0.15 port / 0.30 starboard. The same 0.2 nm displacement breaches to port
    // and not to starboard.
    reset({ portsideXtdNm: 0.15, starboardXtdNm: 0.30 });
    assert.equal(confirm(vessel({ latDeg: stbdLat(0.2), lonDeg: 0.5 })).state,
        MONITOR_STATE.ON_TRACK, '0.2 nm starboard is inside the 0.30 nm limit');

    reset({ portsideXtdNm: 0.15, starboardXtdNm: 0.30 });
    const port = confirm(vessel({ latDeg: -stbdLat(0.2), lonDeg: 0.5 }));
    assert.equal(port.state, MONITOR_STATE.DEVIATING, '…and outside the 0.15 nm port limit');
    assert.equal(port.alarms.get('OFF_XTE').evidence.side, 'port');
    near(port.alarms.get('OFF_XTE').evidence.xtdLimitNm, 0.15, 1e-9);
});
test('the evidence records which side and which limit applied', () => {
    reset({ xtdNm: 0.2 });
    const e = confirm(vessel({ latDeg: stbdLat(0.6), lonDeg: 0.5 })).alarms.get('OFF_XTE').evidence;
    assert.equal(e.side, 'starboard');
    near(e.xtdLimitNm, 0.2, 1e-9);
    near(e.crossTrackNm, 0.6, 0.02);
    assert.equal(e.usedDefault, false);
});

console.log('corner-cutting is competent navigation, not a deviation');
test('inside a DECLARED turn radius, XTE is suppressed', () => {
    reset({ xtdNm: 0.2, waypointRadiusNm: 0.5 });
    // Just short of waypoint B, swung wide — well outside the corridor.
    const s = confirm(atLon(0.995, { latDeg: stbdLat(0.6) }));
    assert.equal(s.state, MONITOR_STATE.ON_TRACK,
        'a ship turning inside its declared radius is not deviating');
    assert.equal(alerts.raised.length, 0);
});
test('the SAME excursion mid-leg DOES alarm', () => {
    reset({ xtdNm: 0.2, waypointRadiusNm: 0.5 });
    const s = confirm(vessel({ latDeg: stbdLat(0.6), lonDeg: 0.5 }));
    assert.equal(s.state, MONITOR_STATE.DEVIATING, 'suppression must be local to the turn');
});
test('a route declaring NO radius is not blinded near waypoints', () => {
    // We must not invent a radius — doing so would suppress real deviations
    // around every waypoint of a plan that never declared one.
    reset({ xtdNm: 0.2 });
    const s = confirm(atLon(0.995, { latDeg: stbdLat(0.6) }));
    assert.equal(s.state, MONITOR_STATE.DEVIATING);
});

console.log('navigational status suppression');
for (const [status, label] of [[1, 'at anchor'], [2, 'not under command'],
                               [3, 'restricted manoeuvrability'], [5, 'moored'], [6, 'aground']]) {
    test(`a vessel ${label} (status ${status}) is SUPPRESSED, not deviating`, () => {
        reset({ xtdNm: 0.2 });
        const s = confirm(vessel({ latDeg: stbdLat(2), lonDeg: 0.5, speedKts: 0, navStatus: status }));
        assert.equal(s.state, MONITOR_STATE.SUPPRESSED);
        assert.equal(s.alarms.size, 0);
        assert.equal(alerts.raised.length, 0);
        assert.equal(s.suppressedBy, status);
    });
}
test('under way using engine (status 0) is NOT suppressed', () => {
    reset({ xtdNm: 0.2 });
    assert.equal(confirm(vessel({ latDeg: stbdLat(2), lonDeg: 0.5, navStatus: 0 })).state,
        MONITOR_STATE.OFF_ROUTE);
});
test('an ABSENT navStatus does not suppress (we know nothing, not "at anchor")', () => {
    reset({ xtdNm: 0.2 });
    assert.equal(confirm(vessel({ latDeg: stbdLat(0.5), lonDeg: 0.5, navStatus: null })).state,
        MONITOR_STATE.DEVIATING);
});
test('measurements survive suppression — we still know where it is', () => {
    reset({ xtdNm: 0.2 });
    const s = run(vessel({ latDeg: stbdLat(2), lonDeg: 0.5, navStatus: 1 }));
    assert.ok(s.crossTrackNm != null, 'suppressing the alarm is not suppressing the measurement');
});

console.log('schedule slip');
test('a vessel exactly on schedule raises nothing', () => {
    reset();
    const st = confirm(atLon(0.3, { latDeg: 0, speedKts: 12 }));
    assert.equal(st.alarms.has('OUT_OF_SCHEDULE'), false,
        `slip was ${st.scheduleSlipMs} ms`);
    assert.ok(Math.abs(st.scheduleSlipMs) < 5 * 60_000, 'and the measured slip is ~zero');
});
test('a STOPPED vessel produces NO schedule alarm (no divide-by-~zero)', () => {
    reset();
    const s = confirm(vessel({ latDeg: 0, lonDeg: 0.5, speedKts: 0 }));
    assert.equal(s.alarms.has('OUT_OF_SCHEDULE'), false,
        'projecting an ETA from ~0 kn would manufacture an arbitrarily large slip');
});
test('a very slow vessel is also excluded', () => {
    reset();
    const s = confirm(vessel({ latDeg: 0, lonDeg: 0.5, speedKts: 0.2 }));
    assert.equal(s.alarms.has('OUT_OF_SCHEDULE'), false);
});
test('running far too slowly to make the ETA raises SCHEDULE_SLIP', () => {
    reset();
    simClock.setTime(START + 4 * 3600_000);      // ETA at B is ~5 h
    const s = confirm(vessel({ latDeg: 0, lonDeg: 0.2, speedKts: 1 }));
    assert.ok(s.alarms.get('OUT_OF_SCHEDULE')?.confirmed, JSON.stringify(s.scheduleSlipMs));
    assert.ok(s.scheduleSlipMs > 0, 'late is a positive slip');
    assert.ok(alerts.raised.some(a => a.type === 'SCHEDULE_SLIP'));
});
test('the plan\'s OWN eta window is used when it declares one', () => {
    // A 6 h window. At 8 kn from lon 0.2 the vessel arrives ~2 h late — inside
    // that tolerance, and well outside the 30 min default it would otherwise
    // have been judged against.
    reset({ etaWindowAfterMs: 6 * 3600_000 });
    simClock.setTime(START + 4 * 3600_000);
    const s = confirm(vessel({ latDeg: 0, lonDeg: 0.2, speedKts: 8 }));
    assert.ok(s.scheduleSlipMs > 30 * 60_000,
        `slip ${Math.round(s.scheduleSlipMs / 60000)} min must exceed the 30 min DEFAULT`);
    assert.equal(s.alarms.has('OUT_OF_SCHEDULE'), false,
        'but it is inside the tolerance the SHIP declared, so no alarm');
});
test('the projection uses distance ALONG THE ROUTE, not straight-line', () => {
    reset();
    const s = run(vessel({ latDeg: 0, lonDeg: 0.5, speedKts: 12 }));
    near(s.distanceToNextWpNm, 0.5 * 60.04, 0.5, 'half a degree to run');
});

console.log('safety depth — a plan-consistency check, honestly named');
test('draught over the declared safety depth is CRITICAL', () => {
    reset({ safetyDepth: 15 });
    const s = confirm(vessel({ draughtM: 18 }));
    assert.ok(s.alarms.get('SAFETY_DEPTH_CONFLICT')?.confirmed);
    const raised = alerts.raised.find(a => a.type === 'SAFETY_DEPTH_CONFLICT');
    assert.ok(raised, 'raised');
    assert.equal(raised.extra.severity, 'CRITICAL');
});
test('draught under it raises nothing', () => {
    reset({ safetyDepth: 15 });
    assert.equal(confirm(vessel({ draughtM: 12 })).alarms.has('SAFETY_DEPTH_CONFLICT'), false);
});
test('a NULL draught yields no verdict — most AIS targets never send one', () => {
    reset({ safetyDepth: 15 });
    assert.equal(confirm(vessel({ draughtM: null })).alarms.has('SAFETY_DEPTH_CONFLICT'), false);
});
test('a plan with no declared safetyDepth yields no verdict', () => {
    reset();
    assert.equal(confirm(vessel({ draughtM: 30 })).alarms.has('SAFETY_DEPTH_CONFLICT'), false,
        'nothing declared to conflict with — silence, not a guess');
});

console.log('speed envelope');
test('inside the declared envelope raises nothing', () => {
    reset({ speedMin: 8, speedMax: 14 });
    assert.equal(confirm(vessel({ speedKts: 12 })).alarms.has('SPEED_OUT_OF_ENVELOPE'), false);
});
test('above the declared maximum alarms', () => {
    reset({ speedMin: 8, speedMax: 14 });
    assert.ok(confirm(vessel({ speedKts: 20 })).alarms.get('SPEED_OUT_OF_ENVELOPE')?.confirmed);
});
test('a stopped vessel is not "below the minimum"', () => {
    reset({ speedMin: 8, speedMax: 14 });
    assert.equal(confirm(vessel({ speedKts: 0 })).alarms.has('SPEED_OUT_OF_ENVELOPE'), false);
});

console.log('ROUTE_ABANDONED');
test('far beyond the corridor the route is treated as abandoned', () => {
    reset({ xtdNm: 0.2 });
    const s = confirm(vessel({ latDeg: stbdLat(30), lonDeg: 0.5 }));
    assert.equal(s.state, MONITOR_STATE.OFF_ROUTE);
    assert.ok(s.alarms.get('ROUTE_ABANDONED')?.confirmed);
});
test('the stored routeStatus is NOT mutated — the ship owns that field', () => {
    reset({ xtdNm: 0.2 });
    confirm(vessel({ latDeg: stbdLat(30), lonDeg: 0.5 }));
    assert.equal(voyagePlanStore.byMmsi(MMSI).routeStatus, 7,
        'abandonment is monitor state, not a change to the ship\'s declaration');
});

console.log('hysteresis');
test('a single off-corridor tick does NOT raise an alarm', () => {
    reset({ xtdNm: 0.2 });
    const s = run(vessel({ latDeg: stbdLat(0.5), lonDeg: 0.5 }), 1);
    assert.equal(s.alarms.get('OFF_XTE')?.confirmed, false, 'pending, not confirmed');
    assert.equal(alerts.raised.length, 0);
    assert.equal(s.state, MONITOR_STATE.ON_TRACK);
});
test('a momentary excursion that ends never alarms at all', () => {
    reset({ xtdNm: 0.2 });
    run(vessel({ latDeg: stbdLat(0.5), lonDeg: 0.5 }), 2);   // brief
    const s = run(atLon(0.55, { latDeg: 0 }), 2);   // back on axis
    assert.equal(s.alarms.has('OFF_XTE'), false);
    assert.equal(alerts.raised.length, 0, 'transients must not reach the operator');
});
test('a sustained breach confirms after DEVIATION_CONFIRM_MS', () => {
    reset({ xtdNm: 0.2 });
    const s = confirm(vessel({ latDeg: stbdLat(0.5), lonDeg: 0.5 }));
    assert.ok(s.alarms.get('OFF_XTE').confirmed);
    assert.ok(s.alarms.get('OFF_XTE').confirmedAt >= s.alarms.get('OFF_XTE').since + STM.DEVIATION_CONFIRM_MS);
});
test('a confirmed alarm stays confirmed until DEVIATION_CLEAR_MS has passed', () => {
    reset({ xtdNm: 0.2 });
    confirm(vessel({ latDeg: stbdLat(0.5), lonDeg: 0.5 }));
    // Back on axis, but not yet long enough to release.
    const s = run(vessel({ latDeg: 0, lonDeg: 0.5 }), 1);
    assert.ok(s.alarms.get('OFF_XTE')?.confirmed, 'clearing is deliberately slower than tripping');
    run(vessel({ latDeg: 0, lonDeg: 0.5 }), Math.ceil(STM.DEVIATION_CLEAR_MS / STM.TICK_MS) + 1);
    assert.equal(mon.stateOf(MMSI).alarms.has('OFF_XTE'), false, 'and then it clears');
    assert.ok(evOf('vg1:routeDeviationCleared').length > 0);
});

console.log('throttling — alertsManager has no dedup of its own');
test('a persistent deviation raises ONE alert per cooldown, not one per tick', () => {
    reset({ xtdNm: 0.2 });
    const v = vessel({ latDeg: stbdLat(0.5), lonDeg: 0.5 });
    // Ten minutes of continuous breach at TICK_MS — 120 ticks.
    run(v, 120);
    assert.equal(alerts.raised.length, 1,
        `${alerts.raised.length} alerts for one continuous deviation — cooldown is ${STM.ALARM_COOLDOWN_MS / 60000} min`);
});
test('after the cooldown it re-raises, so a live problem is not forgotten', () => {
    reset({ xtdNm: 0.2 });
    const v = vessel({ latDeg: stbdLat(0.5), lonDeg: 0.5 });
    confirm(v);
    assert.equal(alerts.raised.length, 1);
    simClock.setTime(simClock.now() + STM.ALARM_COOLDOWN_MS + 1000);
    mon.tick([v]);
    assert.equal(alerts.raised.length, 2);
});

console.log('HONESTY: an alarm on OUR default must say so');
test('a plan with no declared XTD alarms on the default and admits it', () => {
    reset({ xtdNm: null });
    const s = confirm(vessel({ latDeg: stbdLat(1.0), lonDeg: 0.5 }));
    const a = s.alarms.get('OFF_XTE');
    assert.ok(a?.confirmed);
    assert.equal(a.evidence.usedDefault, true);
    near(a.evidence.xtdLimitNm, STM.DEFAULT_XTD_NM, 1e-9);

    const raised = alerts.raised.find(x => x.extra?.type === 'OFF_XTE');
    assert.ok(raised, 'raised');
    assert.equal(raised.extra.usedDefault, true);
    assert.match(raised.message, /assumed/i,
        'the operator must be told the threshold was ours, not the ship\'s');
});
test('a declared XTD does NOT claim a default was used', () => {
    reset({ xtdNm: 0.2 });
    confirm(vessel({ latDeg: stbdLat(0.5), lonDeg: 0.5 }));
    const raised = alerts.raised.find(x => x.extra?.type === 'OFF_XTE');
    assert.equal(raised.extra.usedDefault, false);
    assert.doesNotMatch(raised.message, /assumed/i);
});
test('a SYNTHETIC plan is labelled in the alert an operator reads', () => {
    reset({ xtdNm: 0.2 });
    confirm(vessel({ latDeg: stbdLat(0.5), lonDeg: 0.5 }));
    const raised = alerts.raised[0];
    assert.equal(raised.extra.synthetic, true);
    assert.match(raised.message, /SYNTHETIC/,
        'never blur "the ship shared this" with "we made it up"');
});
test('every alert carries sim time, so it survives scrubbing', () => {
    reset({ xtdNm: 0.2 });
    confirm(vessel({ latDeg: stbdLat(0.5), lonDeg: 0.5 }));
    const raised = alerts.raised[0];
    assert.ok(Number.isFinite(raised.extra.simTime));
    assert.ok(raised.extra.simTime >= START, 'simClock time, not Date.now()');
});
test('structured evidence rides in `extra`, not just prose', () => {
    reset({ xtdNm: 0.2 });
    confirm(vessel({ latDeg: stbdLat(0.5), lonDeg: 0.5 }));
    const e = alerts.raised[0].extra;
    assert.equal(e.mmsi, MMSI);
    assert.ok(e.uvid);
    assert.ok(e.evidence.crossTrackNm != null && e.evidence.xtdLimitNm != null);
});

console.log('ARRIVED — the bug the full-voyage harness found');
test('a vessel at the end of its route is ARRIVED, not endlessly late', () => {
    // THE REGRESSION: at the final waypoint distanceToNextWpNm is ~0, so the
    // projected ETA collapses to "now" and the slip grows one minute per minute
    // forever. A ship that arrived exactly on time reported 46 min late, then
    // 1 h 01, then 1 h 16 … and raised 25 alerts over six hours.
    reset();
    const finalEta = scheduleElementFor(voyagePlanStore.byMmsi(MMSI), 3).eta;
    simClock.setTime(finalEta);
    const s = confirm(vessel({ latDeg: 0, lonDeg: 2, speedKts: 0 }));   // at waypoint C
    assert.equal(s.state, MONITOR_STATE.ARRIVED);
    assert.equal(s.alarms.size, 0);
    assert.equal(alerts.raised.length, 0);
});
test('…and it STAYS arrived hours later, with no growing slip', () => {
    reset();
    const finalEta = scheduleElementFor(voyagePlanStore.byMmsi(MMSI), 3).eta;
    simClock.setTime(finalEta + 6 * 3600_000);          // six hours after arriving
    const s = confirm(vessel({ latDeg: 0, lonDeg: 2, speedKts: 0 }));
    assert.equal(s.state, MONITOR_STATE.ARRIVED);
    assert.equal(s.scheduleSlipMs, null, 'no slip is computed once the voyage is over');
    assert.equal(alerts.raised.length, 0,
        'this is the exact case that produced 25 spurious alerts before the fix');
});
test('a vessel still short of the end is NOT arrived', () => {
    reset();
    const s = run(atLon(1.5, { latDeg: 0 }));
    assert.notEqual(s.state, MONITOR_STATE.ARRIVED);
    assert.ok(s.distanceToEndNm > STM.ARRIVAL_RADIUS_NM);
});
test('arrival is counted as monitored, not as deviating', () => {
    reset();
    simClock.setTime(scheduleElementFor(voyagePlanStore.byMmsi(MMSI), 3).eta);
    confirm(vessel({ latDeg: 0, lonDeg: 2, speedKts: 0 }));
    const c = mon.monitoringCoverage();
    assert.equal(c.monitored, 1);
    assert.equal(c.deviating, 0);
    assert.equal(c.arrived, 1);
});

console.log('NO_FIX');
test('a dark vessel with a plan is NO_FIX, not deviating', () => {
    reset({ xtdNm: 0.2 });
    const s = confirm(vessel({ isDark: true }));
    assert.equal(s.state, MONITOR_STATE.NO_FIX);
    assert.equal(alerts.raised.length, 0, 'we cannot know whether it is off track');
});
test('a vessel with no position is NO_FIX', () => {
    reset({ xtdNm: 0.2 });
    assert.equal(run(vessel({ latDeg: null, lonDeg: null })).state, MONITOR_STATE.NO_FIX);
});

console.log('events');
test('state transitions are announced', () => {
    reset({ xtdNm: 0.2 });
    events.length = 0;
    confirm(vessel({ latDeg: stbdLat(0.5), lonDeg: 0.5 }));
    const t = evOf('vg1:routeMonitorState');
    assert.ok(t.length > 0);
    assert.ok(t.some(e => e.detail.to === MONITOR_STATE.DEVIATING));
});
test('vg1:routeDeviation carries the same payload as the alert', () => {
    reset({ xtdNm: 0.2 });
    events.length = 0;
    confirm(vessel({ latDeg: stbdLat(0.5), lonDeg: 0.5 }));
    const d = evOf('vg1:routeDeviation')[0];
    assert.equal(d.detail.mmsi, MMSI);
    assert.equal(d.detail.type, 'OFF_XTE');
    assert.ok(d.detail.evidence);
});

console.log('robustness');
test('tick() survives junk in the vessel list', () => {
    reset();
    assert.doesNotThrow(() => mon.tick([null, undefined, {}, { mmsi: null }, vessel()]));
});
test('tick() with no vessels at all is a no-op', () => {
    reset();
    assert.doesNotThrow(() => mon.tick([]));
    assert.doesNotThrow(() => mon.tick(null));
    assert.equal(mon.monitoringCoverage().total, 0);
});
test('a missing alertsManager does not break monitoring', () => {
    voyagePlanStore.clear();
    simClock.setTime(START + 3600_000);
    const bare = new EnhancedMonitor({ store: voyagePlanStore, alerts: { /* no addAlert */ } });
    voyagePlanStore.add(makePlan({ xtdNm: 0.2 }));
    const v = vessel({ latDeg: stbdLat(0.5), lonDeg: 0.5 });
    assert.doesNotThrow(() => {
        for (let i = 0; i < 20; i++) { simClock.setTime(simClock.now() + STM.TICK_MS); bare.tick([v]); }
    });
    assert.equal(bare.stateOf(MMSI).state, MONITOR_STATE.DEVIATING, 'still detected');
});
test('switching to a different plan resets the leg hint and alarms', () => {
    reset({ xtdNm: 0.2 });
    confirm(vessel({ latDeg: stbdLat(0.5), lonDeg: 0.5 }));
    assert.ok(mon.stateOf(MMSI).alarms.size > 0);

    const other = makePlan({ xtdNm: 5, uvid: 'urn:mrn:stm:voyage:id:x:other' });
    voyagePlanStore.add(other);
    // The newest status-7 plan wins, so byMmsi now returns `other`.
    const s = run(vessel({ latDeg: stbdLat(0.5), lonDeg: 0.5 }), 1);
    assert.equal(s.uvid, other.uvid);
    assert.equal(s.alarms.size, 0, 'a new route starts with a clean slate');
});
test('deviating() lists exactly the vessels in trouble', () => {
    reset({ xtdNm: 0.2 });
    confirm(vessel({ latDeg: stbdLat(0.5), lonDeg: 0.5 }));
    assert.deepEqual(mon.deviating().map(s => s.mmsi), [MMSI]);
});

console.log('coverage accounting');
test('deviating and suppressed counts are reported separately', () => {
    reset({ xtdNm: 0.2 });
    confirm(vessel({ latDeg: stbdLat(0.5), lonDeg: 0.5 }));
    const c = mon.monitoringCoverage();
    assert.equal(c.monitored, 1);
    assert.equal(c.deviating, 1);
    assert.equal(c.suppressed, 0);
});

console.log(`\nenhancedMonitor.test: ${passed} checks passed`);
