// tests/scenarioRoute.test.mjs — the closed loop, offline.
// Run from repo root:  node --import ./tests/_stubs/register.mjs tests/scenarioRoute.test.mjs
//
// This is the test that makes Enhanced Monitoring buildable. Real AIS carries no
// route plans, so without this there is nothing to monitor and no way to test
// the monitor. Here the same scenario produces BOTH the declared plan and the
// vessel's actual track, and the two can be compared.
//
// The three claims that matter:
//   1. PARITY — the plan's schedule and the ship's motion come from the same
//      arithmetic. If they drift, every scenario ship runs late against its own
//      schedule and the schedule alarm is worthless.
//   2. THE PLAN STAYS CLEAN — `deviate` moves the SHIP, never the declared route.
//   3. THE DEVIATION IS PHYSICALLY ADMISSIBLE — it ramps, so invariants.js does
//      not reject it as a sideways teleport. An unramped offset would be
//      rejected at the gate and never reach the monitor at all.

import './_stubs/domEnv.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOMParser } from './_stubs/xmlDom.mjs';
import {
    planFromScenarioEntity, plansFromScenario, rtzFromScenarioEntity,
    loadScenarioPlans, legTimings, isSynthetic, SYNTHETIC_AUTHOR,
} from '../scenarioRoute.js';
import { parse, activeSchedule, scheduleElementFor, isMonitoring } from '../rtzCodec.js';
import { voyagePlanStore } from '../voyagePlanStore.js';
import { SyntheticAISSource, haversineNm } from '../dataSource.js';
import { projectOntoRoute } from '../routeGeometry.js';
import { checkPositionReport, parseEventTime, invariantLedger } from '../invariants.js';
import { simClock } from '../simClock.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
const near = (a, b, tol, m) =>
    assert.ok(Math.abs(a - b) <= tol, `${m ?? ''} expected ${b} ±${tol}, got ${a}`);

const dp = new DOMParser();
const P = (xml) => parse(xml, { domParser: dp });
const START = Date.parse('2026-07-29T06:00:00Z');

// A due-east run at 12 kn along the equator: 1° of longitude = 60 nm exactly,
// which makes every distance and time in this suite checkable by hand.
function scenario(over = {}) {
    return {
        name: 'STM TEST',
        startTime: '2026-07-29T06:00:00Z',
        entities: [{
            mmsi: '999000123', name: 'SYN MONITORED', shipType: 70, speedKts: 12,
            waypoints: [
                { lon: 0, lat: 0 },
                { lon: 1, lat: 0 },     // 60 nm  → t = 18000 s (5 h)
                { lon: 2, lat: 0 },     // 120 nm → t = 36000 s
                { lon: 3, lat: 0 },     // 180 nm → t = 54000 s
            ],
            stmRoute: {
                routeName: 'EQUATOR TEST', xtdNm: 0.2, safetyDepth: 15,
                speedMin: 8, speedMax: 14, routeStatus: 7,
                ...over,
            },
        }],
    };
}
const entityOf = (s) => s.entities[0];

console.log('plan construction');
test('builds a plan with one waypoint per scenario waypoint', () => {
    const p = planFromScenarioEntity(entityOf(scenario()), { scenarioStartMs: START });
    assert.equal(p.waypoints.length, 4);
    assert.deepEqual(p.waypoints.map(w => w.id), [1, 2, 3, 4]);
    assert.equal(p.mmsi, '999000123');
    assert.equal(p.vesselName, 'SYN MONITORED');
    assert.equal(p.routeName, 'EQUATOR TEST');
});
test('the first waypoint has NO inbound leg (RTZ convention)', () => {
    const p = planFromScenarioEntity(entityOf(scenario()), { scenarioStartMs: START });
    assert.equal(p.waypoints[0].leg, null, 'nothing leads into waypoint 1');
    assert.ok(p.waypoints[1].leg, 'waypoint 2 has the leg that arrives at it');
});
test('a symmetric xtdNm fills both sides', () => {
    const p = planFromScenarioEntity(entityOf(scenario()), { scenarioStartMs: START });
    near(p.waypoints[1].leg.portsideXTD, 0.2, 1e-9);
    near(p.waypoints[1].leg.starboardXTD, 0.2, 1e-9);
});
test('asymmetric sides are honoured and override xtdNm', () => {
    const s = scenario({ xtdNm: 0.2, portsideXtdNm: 0.15, starboardXtdNm: 0.30 });
    const p = planFromScenarioEntity(entityOf(s), { scenarioStartMs: START });
    near(p.waypoints[1].leg.portsideXTD, 0.15, 1e-9);
    near(p.waypoints[1].leg.starboardXTD, 0.30, 1e-9);
});
test('a scenario declaring no corridor leaves XTD NULL, not invented', () => {
    const s = scenario({});
    delete s.entities[0].stmRoute.xtdNm;
    delete s.entities[0].stmRoute.safetyDepth;
    delete s.entities[0].stmRoute.speedMin;
    delete s.entities[0].stmRoute.speedMax;
    const p = planFromScenarioEntity(entityOf(s), { scenarioStartMs: START });
    const leg = p.waypoints[1].leg;
    assert.ok(leg, 'the leg still exists — geometryType is load-bearing');
    assert.equal(leg.geometryType, 'Loxodrome', "RTZ's own default, not one invented here");
    assert.equal(leg.portsideXTD, null,
        'the monitor must fall back to its ANNOUNCED default, not a silent one here');
    assert.equal(leg.starboardXTD, null);
    assert.equal(leg.safetyDepth, null);
});
test('an entity with no stmRoute yields no plan', () => {
    const s = scenario();
    delete s.entities[0].stmRoute;
    assert.equal(planFromScenarioEntity(entityOf(s), { scenarioStartMs: START }), null);
});
test('an entity with fewer than 2 waypoints yields no plan', () => {
    const s = scenario();
    s.entities[0].waypoints = [{ lon: 0, lat: 0 }];
    assert.equal(planFromScenarioEntity(entityOf(s), { scenarioStartMs: START }), null);
});
test('defaults to routeStatus 7 so it is monitored out of the box', () => {
    const s = scenario();
    delete s.entities[0].stmRoute.routeStatus;
    assert.equal(planFromScenarioEntity(entityOf(s), { scenarioStartMs: START }).routeStatus, 7);
});

console.log('synthetic labelling (never let a demo blur this)');
test('the plan is marked synthetic three independent ways', () => {
    const p = planFromScenarioEntity(entityOf(scenario()), { scenarioStartMs: START });
    assert.equal(p.synthetic, true);
    assert.equal(p.sourceFormat, 'SYNTHETIC');
    assert.equal(p.routeAuthor, SYNTHETIC_AUTHOR);
    assert.equal(isSynthetic(p), true);
});
test('the marker SURVIVES an RTZ export and re-import', () => {
    // synthetic/sourceFormat are canonical-model fields and do not exist on the
    // wire, so routeAuthor is what carries the fact across the boundary.
    const xml = rtzFromScenarioEntity(entityOf(scenario()), { scenarioStartMs: START });
    const back = P(xml).plan;
    assert.equal(back.sourceFormat, 'RTZ_1_1', 'it really did become a normal RTZ document');
    assert.equal(back.routeAuthor, SYNTHETIC_AUTHOR);
    assert.equal(isSynthetic(back), true, 'still identifiable as ours after the round trip');
});
test('a genuinely received plan is NOT flagged synthetic', () => {
    const xml = rtzFromScenarioEntity(entityOf(scenario()), { scenarioStartMs: START })
        .replace(SYNTHETIC_AUTHOR, 'MASTER');
    assert.equal(isSynthetic(P(xml).plan), false);
});

console.log('schedule');
test('ETAs derive from the leg timings, exactly', () => {
    const e = entityOf(scenario());
    const p = planFromScenarioEntity(e, { scenarioStartMs: START });
    const legs = legTimings(e);

    assert.equal(scheduleElementFor(p, 1).etd, START, 'wp1 is a departure');
    assert.equal(scheduleElementFor(p, 1).eta, null);
    for (let i = 1; i < legs.length; i++) {
        assert.equal(scheduleElementFor(p, i + 1).eta, START + legs[i].t * 1000,
            `waypoint ${i + 1} ETA must be the leg timing, to the millisecond`);
    }
});
test('…and those timings match the hand-check to within a few seconds', () => {
    // 1° of longitude at the equator is 60.04 nm, not exactly 60 (the earth
    // radius is 3440.065 nm), so 60.04/12 h = 5h 0m 12s. Asserting a flat 5 h
    // would be asserting my own rounding, not the code's behaviour.
    const p = planFromScenarioEntity(entityOf(scenario()), { scenarioStartMs: START });
    near(scheduleElementFor(p, 2).eta, START + 5 * 3600_000, 20_000, 'wp2 ≈ 5 h');
    near(scheduleElementFor(p, 4).eta, START + 15 * 3600_000, 60_000, 'wp4 ≈ 15 h');
});
test('the schedule is manual, so the monitor picks it', () => {
    const p = planFromScenarioEntity(entityOf(scenario()), { scenarioStartMs: START });
    assert.equal(activeSchedule(p).kind, 'manual');
    assert.equal(isMonitoring(p), true);
});
test('explicit waypoint times override the derived ones', () => {
    const s = scenario();
    s.entities[0].waypoints[1].t = 999;
    const p = planFromScenarioEntity(entityOf(s), { scenarioStartMs: START });
    assert.equal(scheduleElementFor(p, 2).eta, START + 999_000);
});
test('WITHOUT a scenario start there is NO schedule — not a 1970 one', () => {
    const p = planFromScenarioEntity(entityOf(scenario()), {});
    assert.equal(p.schedules.length, 0,
        'a relative-time schedule is not a schedule; emitting epoch-0 ETAs would ' +
        'hand the monitor 56 years of slip to alarm on');
    assert.equal(p.waypoints.length, 4, 'the geometry is still usable');
});

console.log('PARITY: the plan and the ship share one arithmetic');
test('scenarioRoute.legTimings matches SyntheticAISSource._buildLegs exactly', () => {
    // If these two ever diverge, every scenario vessel runs late or early
    // against its own declared schedule and the schedule alarm is meaningless.
    const e = entityOf(scenario());
    const mine = legTimings(e);
    const src = new SyntheticAISSource(scenario());
    src._onStart();
    const theirs = src._entities[0]._legs;

    assert.equal(mine.length, theirs.length);
    for (let i = 0; i < mine.length; i++) {
        near(mine[i].t, theirs[i].t, 1e-6, `waypoint ${i + 1} time:`);
        near(mine[i].d, theirs[i].d, 1e-9, `waypoint ${i + 1} distance:`);
        near(mine[i].lat, theirs[i].lat, 1e-12);
        near(mine[i].lon, theirs[i].lon, 1e-12);
    }
});

console.log('the ship follows the plan (no deviation)');
function runScenario(s, atSeconds) {
    const msgs = [];
    const src = new SyntheticAISSource(s);
    // DataSource.start() fires an IMMEDIATE first tick, so the clock has to be
    // at the first sample time before start() — otherwise message 0 is emitted
    // at wall-clock now, which for a scenario dated in the past means the vessel
    // is clamped to its final waypoint. That stray sample silently poisoned
    // every position assertion in this file until the ramp test caught it.
    simClock.setTime(START + atSeconds[0] * 1000);
    src.start(m => msgs.push(m));
    for (const sec of atSeconds.slice(1)) {
        simClock.setTime(START + sec * 1000);
        src._tick();
    }
    src.stop();
    simClock.goLive();
    return msgs;
}
const posOf = (m) => ({ lat: m.MetaData.latitude, lon: m.MetaData.longitude,
                        sog: m.Message.PositionReport.Sog, cog: m.Message.PositionReport.Cog });

test('an undeviated ship sits ON its declared route axis', () => {
    const s = scenario();
    const plan = planFromScenarioEntity(entityOf(s), { scenarioStartMs: START });
    const msgs = runScenario(s, [3600, 7200, 18000, 30000]);
    assert.ok(msgs.length >= 4, `${msgs.length} messages`);
    let hint = null;
    for (const m of msgs) {
        const p = posOf(m);
        const r = projectOntoRoute(p.lat, p.lon, plan, hint);
        hint = r.legIndex;
        near(r.crossTrackNm, 0, 0.01, 'on axis');
    }
});
test('emitted SOG keeps 0.1-knot AIS resolution, not whole knots', () => {
    // The source used to Math.round() SOG, which is COARSER than real AIS and
    // silently degraded every speed-derived scenario test.
    const s = scenario();
    s.entities[0].speedKts = 12.4;
    s.entities[0].waypoints = [{ lon: 0, lat: 0 }, { lon: 1, lat: 0 }];
    const m = runScenario(s, [3600])[0];
    near(posOf(m).sog, 12.4, 0.15, 'reported speed');
    assert.notEqual(posOf(m).sog, Math.round(posOf(m).sog), 'a fractional speed survived');
});

console.log('DEVIATION: the ship leaves, the plan does not');
const DEV = { fromWpIndex: 1, offsetNm: 0.8, rampNm: 2, side: 'starboard' };

test('the declared plan is IDENTICAL with and without a deviation', () => {
    const clean = planFromScenarioEntity(entityOf(scenario()), { scenarioStartMs: START });
    const dirty = planFromScenarioEntity(entityOf(scenario({ deviate: DEV })), { scenarioStartMs: START });
    const strip = (p) => JSON.stringify({ ...p, parseReport: null });
    assert.equal(strip(dirty), strip(clean),
        'a deviation is the ship failing to follow its route, never a change to the route');
});
test('the ship IS pushed off the axis, to the declared side', () => {
    const s = scenario({ deviate: DEV });
    const plan = planFromScenarioEntity(entityOf(s), { scenarioStartMs: START });
    // Well past waypoint 2 (t=18000) and past the 2 nm ramp.
    const m = runScenario(s, [25000])[0];
    const p = posOf(m);
    const r = projectOntoRoute(p.lat, p.lon, plan, 1);
    assert.ok(r.crossTrackNm > 0, `starboard is positive, got ${r.crossTrackNm}`);
    near(Math.abs(r.crossTrackNm), 0.8, 0.05, 'full declared offset');
});
test('side: "port" pushes the other way', () => {
    const s = scenario({ deviate: { ...DEV, side: 'port' } });
    const plan = planFromScenarioEntity(entityOf(s), { scenarioStartMs: START });
    const p = posOf(runScenario(s, [25000])[0]);
    const r = projectOntoRoute(p.lat, p.lon, plan, 1);
    assert.ok(r.crossTrackNm < 0, `port is negative, got ${r.crossTrackNm}`);
    near(Math.abs(r.crossTrackNm), 0.8, 0.05, 'same magnitude, opposite side');
});
test('the offset RAMPS IN rather than stepping', () => {
    const s = scenario({ deviate: DEV });
    const plan = planFromScenarioEntity(entityOf(s), { scenarioStartMs: START });
    // Waypoint 2 is at t=18000 s. The ramp is 2 nm ≈ 600 s at 12 kn.
    const xtAt = (sec) => {
        const p = posOf(runScenario(s, [sec])[0]);
        return Math.abs(projectOntoRoute(p.lat, p.lon, plan, 1).crossTrackNm);
    };
    const a = xtAt(18100), b = xtAt(18400), c = xtAt(19000);
    assert.ok(a < b && b < c, `offset must grow monotonically, got ${a} < ${b} < ${c}`);
    assert.ok(a < 0.3, `barely started at +100 s, got ${a}`);
    near(c, 0.8, 0.05, 'fully developed after the ramp');
});
test('no deviation before the declared waypoint', () => {
    const s = scenario({ deviate: { ...DEV, fromWpIndex: 2 } });
    const plan = planFromScenarioEntity(entityOf(s), { scenarioStartMs: START });
    const p = posOf(runScenario(s, [10000])[0]);   // still on leg 0
    near(projectOntoRoute(p.lat, p.lon, plan, 0).crossTrackNm, 0, 0.01);
});

console.log('THE GATE: a deviation the invariant checker would reject is useless');
test('the ramped deviation produces NO IMPOSSIBLE_SPEED rejection', () => {
    // An unramped 0.8 nm step between consecutive reports is a sideways
    // teleport: invariants.js rejects it, the vessel never moves, and the
    // deviation the scenario is staging never reaches the monitor at all.
    invariantLedger.clear();
    const s = scenario({ deviate: DEV });
    // Sample across the ramp at a 60 s cadence — above INVARIANTS.MIN_DT_MS
    // (30 s), so the speed checks are actually armed rather than skipped.
    const times = [];
    for (let t = 17800; t <= 20200; t += 60) times.push(t);
    const msgs = runScenario(s, times);
    assert.ok(msgs.length === times.length, `${msgs.length}/${times.length} messages`);

    let prev = null, rejects = 0, mismatches = 0;
    for (const m of msgs) {
        const p = posOf(m);
        const tEvent = parseEventTime(m.MetaData.time_utc);
        const v = checkPositionReport(prev, {
            mmsi: m.MetaData.MMSI, name: m.MetaData.ShipName,
            lat: p.lat, lon: p.lon, sogKts: p.sog,
            tEvent, tArrival: tEvent, class: 'CARGO',
        });
        rejects += v.filter(x => x.severity === 'reject').length;
        mismatches += v.filter(x => x.type === 'SOG_MISMATCH').length;
        prev = { latDeg: p.lat, lonDeg: p.lon, tEvent };
    }
    assert.equal(rejects, 0, `${rejects} report(s) rejected — the deviation is not physical`);
    assert.equal(mismatches, 0, `${mismatches} SOG mismatch(es) — reported speed disagrees with motion`);
});
test('while deviating, COG differs from the leg bearing — the drift signal', () => {
    // The leg runs due east (090). A ship crabbing to starboard is making good
    // a course south of that. If COG were still reported as the leg bearing,
    // the set-and-drift signal that aisManager.cogDeg exists to carry would be
    // fabricated away at the source.
    const s = scenario({ deviate: DEV });
    const msgs = runScenario(s, [18300, 18360]);
    const cog = posOf(msgs[msgs.length - 1]).cog;
    assert.ok(cog > 90 && cog < 180,
        `expected a course south of due east while crabbing starboard, got ${cog}`);
});
test('an unramped deviation WOULD be caught — the guard is real, not decorative', () => {
    // rampNm: 0 makes the offset apply instantly at the waypoint. Sampled across
    // that instant, the implied speed is enormous.
    const s = scenario({ deviate: { ...DEV, offsetNm: 5, rampNm: 0 } });
    // Straddle the ACTUAL waypoint-2 time rather than a rounded guess. 1° of
    // longitude is 60.04 nm, so the crossing is at 18012 s, not 18000 — sampling
    // 17990/18010 leaves the ship on the previous leg for both samples and the
    // jump never happens.
    const tWp = legTimings(entityOf(s))[1].t;
    const msgs = runScenario(s, [tWp - 10, tWp + 10]);
    const [a, b] = msgs.map(posOf);
    const tA = parseEventTime(msgs[0].MetaData.time_utc);
    const tB = parseEventTime(msgs[1].MetaData.time_utc);
    const implied = haversineNm(a.lat, a.lon, b.lat, b.lon) / ((tB - tA) / 3600000);
    assert.ok(implied > 120,
        `an instant 5 nm jump implies ${implied.toFixed(0)} kn, above the 120 kn reject line`);
});

console.log('holding at the final waypoint');
test('a vessel holding at its last waypoint reports ZERO speed, not way-on', () => {
    // It used to report the full transit speed forever: t clamps to totalT while
    // the interpolation fraction stays at 1, so the leg-derived SOG never fell
    // to zero. A stationary ship broadcasting 12 kn is a false statement about
    // the vessel, and it was what made the monitor compute an ever-growing
    // schedule slip in the integration harness.
    const s = scenario();
    const total = legTimings(entityOf(s))[3].t;
    const m = runScenario(s, [total + 7200])[0];      // two hours past the end
    const p = posOf(m);
    assert.equal(p.sog, 0, `held at the final waypoint but reported ${p.sog} kn`);
    near(p.lat, 0, 1e-6);
    near(p.lon, 3, 1e-6, 'and it is parked on the last waypoint');
});
test('a vessel still under way is unaffected', () => {
    const s = scenario();
    const p = posOf(runScenario(s, [9000])[0]);
    assert.ok(p.sog > 10, `mid-voyage speed should be ~12 kn, got ${p.sog}`);
});
test('a LOOPING vessel never holds, so it keeps its speed', () => {
    const s = scenario();
    s.entities[0].loop = true;
    const total = legTimings(entityOf(s))[3].t;
    const p = posOf(runScenario(s, [total + 3600])[0]);
    assert.ok(p.sog > 10, `looping vessel should keep moving, got ${p.sog}`);
});

console.log('scenario-level helpers');
test('plansFromScenario reads startTime from the scenario itself', () => {
    const plans = plansFromScenario(scenario());
    assert.equal(plans.length, 1);
    assert.equal(scheduleElementFor(plans[0], 2).eta,
                 START + legTimings(entityOf(scenario()))[1].t * 1000);
});
test('entities without stmRoute are skipped, not errored', () => {
    const s = scenario();
    s.entities.push({ mmsi: '999000999', name: 'PLAIN', waypoints: [{ lon: 0, lat: 0 }, { lon: 1, lat: 0 }] });
    assert.equal(plansFromScenario(s).length, 1);
});
test('an empty or malformed scenario yields an empty list', () => {
    assert.deepEqual(plansFromScenario(null), []);
    assert.deepEqual(plansFromScenario({}), []);
    assert.deepEqual(plansFromScenario({ entities: [] }), []);
});

console.log('END TO END: scenario → store → monitored, offline');
test('loadScenarioPlans puts a monitorable plan in the store', () => {
    voyagePlanStore.clear();
    const res = loadScenarioPlans(scenario({ deviate: DEV }), voyagePlanStore);
    assert.equal(res.added, 1, JSON.stringify(res));

    const plan = voyagePlanStore.byMmsi('999000123');
    assert.ok(plan, 'the store answers "what is this ship steering?"');
    assert.equal(plan.routeStatus, 7);
    assert.ok(isSynthetic(plan), 'and it still says it is ours');
    assert.ok(plan.raw && plan.raw.includes('<route'), 'an RTZ rendering is attached');
});
test('the stored plan re-parses as valid RTZ', () => {
    voyagePlanStore.clear();
    loadScenarioPlans(scenario(), voyagePlanStore);
    const { report } = P(voyagePlanStore.byMmsi('999000123').raw);
    assert.ok(report.ok, JSON.stringify(report.warnings));
});
test('FULL LOOP: the deviating ship measurably breaches its own declared XTD', () => {
    voyagePlanStore.clear();
    const s = scenario({ xtdNm: 0.2, deviate: DEV });
    loadScenarioPlans(s, voyagePlanStore);
    const plan = voyagePlanStore.byMmsi('999000123');

    const p = posOf(runScenario(s, [25000])[0]);
    const r = projectOntoRoute(p.lat, p.lon, plan, 1);
    const leg = plan.waypoints[r.legIndex + 1].leg;
    const limit = r.crossTrackNm >= 0 ? leg.starboardXTD : leg.portsideXTD;

    near(limit, 0.2, 1e-9, 'the corridor the SHIP declared');
    assert.ok(Math.abs(r.crossTrackNm) > limit,
        `${Math.abs(r.crossTrackNm).toFixed(2)} nm off a ${limit} nm corridor — a real breach, ` +
        `detected end to end with no network and no live AIS`);
});
test('…and the same ship is compliant BEFORE the deviation starts', () => {
    voyagePlanStore.clear();
    const s = scenario({ xtdNm: 0.2, deviate: DEV });
    loadScenarioPlans(s, voyagePlanStore);
    const plan = voyagePlanStore.byMmsi('999000123');

    const p = posOf(runScenario(s, [9000])[0]);   // mid leg 0
    const r = projectOntoRoute(p.lat, p.lon, plan, 0);
    assert.ok(Math.abs(r.crossTrackNm) < 0.2,
        'no alarm before the excursion — the fixture can distinguish the two states');
});

console.log('the shipped demo scenario says what it claims');
// scenarios/stm-kattegat-demo.json documents three states in its own comment.
// A comment is not a guarantee, so assert them — otherwise an innocent edit to
// the JSON quietly turns the demo into two vessels that both look fine.
test('stm-kattegat-demo.json produces ON_TRACK, DEVIATING and UNMONITORED', () => {
    const demo = JSON.parse(
        readFileSync(new URL('../scenarios/stm-kattegat-demo.json', import.meta.url), 'utf8'));
    const startMs = Date.parse(demo.startTime);
    assert.ok(Number.isFinite(startMs), 'the demo declares a startTime');

    voyagePlanStore.clear();
    const res = loadScenarioPlans(demo, voyagePlanStore);
    assert.equal(res.added, 2, 'exactly two of the three vessels share a plan');
    assert.equal(demo.entities.length, 3);

    const src = new SyntheticAISSource(demo);
    simClock.setTime(startMs + 8 * 3600_000);        // 8 h in, past the ramp
    const msgs = [];
    src.start(m => msgs.push(m));
    src.stop();
    simClock.goLive();
    assert.equal(msgs.length, 3, 'all three vessels transmitting');

    const state = {};
    for (const m of msgs) {
        const plan = voyagePlanStore.byMmsi(m.MetaData.MMSI);
        if (!plan) { state[m.MetaData.ShipName] = 'UNMONITORED'; continue; }
        const r = projectOntoRoute(m.MetaData.latitude, m.MetaData.longitude, plan, null);
        const leg = plan.waypoints[r.legIndex + 1]?.leg;
        const limit = r.crossTrackNm >= 0 ? leg?.starboardXTD : leg?.portsideXTD;
        state[m.MetaData.ShipName] =
            (limit != null && Math.abs(r.crossTrackNm) > limit) ? 'DEVIATING' : 'ON_TRACK';
    }

    assert.equal(state['NORDIC TRADER'], 'ON_TRACK');
    assert.equal(state['BALTIC CARRIER'], 'DEVIATING');
    assert.equal(state['KATTEGAT STAR'], 'UNMONITORED',
        'the honest third state — not compliant, not deviating, UNKNOWN');
});
test('every demo plan is marked synthetic', () => {
    const demo = JSON.parse(
        readFileSync(new URL('../scenarios/stm-kattegat-demo.json', import.meta.url), 'utf8'));
    for (const p of plansFromScenario(demo)) assert.ok(isSynthetic(p), p.routeName);
});

console.log(`\nscenarioRoute.test: ${passed} checks passed`);
