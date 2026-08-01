// scenarioRoute.js — turn a synthetic scenario entity into an STM voyage plan.
//
// THE BOOTSTRAPPING PROBLEM
// -------------------------
// Enhanced Monitoring compares a vessel against the route it declared. Real AIS
// carries no route plans at all, so with live traffic alone there is nothing to
// monitor and no way to test the monitor. This module closes the loop offline:
// a scenario's waypoints ARE a declared route, and dataSource's `_buildLegs()`
// already derives leg times from distance and speed — which is a schedule.
//
//   scenario waypoints ──► VoyagePlan ──► RTZ XML
//                              │
//                              └──► enhancedMonitor measures the ship against it
//
// With `stmRoute.deviate` set (see dataSource.js), the vessel is pushed off the
// plan while the plan stays clean, so the whole chain — plan, deviation,
// detection, alarm — runs with no network and, under RecordedAISSource, runs
// deterministically enough to be a regression fixture.
//
// HONESTY REQUIREMENT
// -------------------
// A synthetic plan is one WE invented; a received plan is one a ship SHARED.
// Blurring those in a demo is the single most misleading thing this subsystem
// could do, so every plan built here is marked three ways: `synthetic: true`,
// `sourceFormat: 'SYNTHETIC'`, and — because the first two do not survive an RTZ
// export — a `routeAuthor` of SYNTHETIC_AUTHOR that a re-import can still see.
//
// Tests: node tests/scenarioRoute.test.mjs

import { STM } from './config.js';
import { haversineNm } from './dataSource.js';
import { ROUTE_STATUS_MONITORING } from './voyagePlan.js';
// serialise still comes from a specific codec: generating a synthetic plan means
// choosing an output format. That choice is explicit here rather than implied.
import { serialise } from './rtzCodec.js';

/** Wire marker for a plan Vanguard1 generated rather than received. */
export const SYNTHETIC_AUTHOR = 'VANGUARD1 SYNTHETIC';

/** True for any plan that did not come from a real ship or service. */
export function isSynthetic(plan) {
    return !!(plan && (plan.synthetic === true ||
                       plan.sourceFormat === 'SYNTHETIC' ||
                       plan.routeAuthor === SYNTHETIC_AUTHOR));
}

/**
 * Cumulative leg times (seconds from scenario start) for a scenario entity.
 *
 * Deliberately mirrors SyntheticAISSource._buildLegs so the plan's schedule and
 * the vessel's actual motion come from the SAME arithmetic. If these two ever
 * drift apart, every scenario ship silently runs late or early against its own
 * declared schedule and the schedule alarm becomes untrustworthy — so the parity
 * between them is asserted directly in tests/scenarioRoute.test.mjs.
 */
export function legTimings(entity) {
    const wps = entity?.waypoints ?? [];
    if (!wps.length) return [];
    const out = [{ ...wps[0], t: wps[0].t ?? 0, d: 0 }];
    for (let i = 1; i < wps.length; i++) {
        const prev = out[i - 1];
        const wp = wps[i];
        const nm = haversineNm(prev.lat, prev.lon, wp.lat, wp.lon);
        let t = wp.t;
        if (t == null) {
            t = prev.t + (nm / Math.max(0.1, entity.speedKts ?? 12)) * 3600;
        }
        out.push({ ...wp, t, d: prev.d + nm });
    }
    return out;
}

/**
 * Build the leg attributes shared by every leg of a scenario route.
 * Returns null when the scenario declares nothing — a plan with no declared
 * corridor is a legitimate input, and the monitor must fall back to its
 * announced default rather than have one invented here.
 */
function legFrom(stm) {
    const port = stm.portsideXtdNm ?? stm.xtdNm ?? null;
    const stbd = stm.starboardXtdNm ?? stm.xtdNm ?? null;
    const leg = {
        geometryType:   stm.geometryType ?? 'Loxodrome',
        portsideXTD:    port,
        starboardXTD:   stbd,
        safetyContour:  stm.safetyContour ?? null,
        safetyDepth:    stm.safetyDepth ?? null,
        speedMin:       stm.speedMin ?? null,
        speedMax:       stm.speedMax ?? null,
        draughtForward: stm.draughtForward ?? null,
        draughtAft:     stm.draughtAft ?? null,
        staticUKC:      stm.staticUKC ?? null,
        dynamicUKC:     stm.dynamicUKC ?? null,
        masthead:       stm.masthead ?? null,
        note1:          stm.note1 ?? null,
        note2:          stm.note2 ?? null,
    };
    // Always return a leg, even when every attribute is null. `geometryType`
    // alone is load-bearing — it selects rhumb vs great-circle cross-track, and
    // Loxodrome is RTZ's own documented default, not one invented here. The
    // remaining nulls are the honest record that the scenario declared no
    // corridor, which the monitor must answer with its ANNOUNCED fallback.
    return leg;
}

/**
 * Canonical VoyagePlan from one scenario entity.
 *
 * @param {object} entity  a scenario `entities[]` element carrying `stmRoute`
 * @param {object} [opts]
 *   scenarioStartMs — epoch ms the scenario's t=0 corresponds to (required for
 *                     a real schedule; without it the plan carries waypoints and
 *                     legs but NO schedule, because a relative-time schedule is
 *                     not a schedule and pretending otherwise would give the
 *                     monitor 1970 ETAs to alarm on)
 *   scenarioName    — used in the route name when the entity does not set one
 * @returns {object|null} the plan, or null if the entity cannot form a route
 */
export function planFromScenarioEntity(entity, opts = {}) {
    const stm = entity?.stmRoute;
    if (!stm) return null;

    const legs = legTimings(entity);
    if (legs.length < 2) return null;   // no route axis

    const sharedLeg = legFrom(stm);

    // RTZ attaches a <leg> to the waypoint it leads INTO, so waypoint 1 has no
    // inbound leg. routeGeometry reads `wpTo.leg` for exactly this reason.
    const waypoints = legs.map((wp, i) => ({
        id: i + 1,
        revision: 0,
        name: wp.name ?? `WP${i + 1}`,
        lat: wp.lat,
        lon: wp.lon,
        radius: wp.radius ?? stm.waypointRadiusNm ?? null,
        leg: i === 0 ? null : (sharedLeg ? { ...sharedLeg } : null),
    }));

    const startMs = opts.scenarioStartMs ?? null;
    const schedules = [];
    if (startMs != null) {
        const elements = legs.map((wp, i) => {
            const at = startMs + wp.t * 1000;
            return {
                waypointId: i + 1,
                // The first waypoint is a departure, the rest are arrivals.
                eta: i === 0 ? null : at,
                etd: i === 0 ? at : null,
                etaWindowBefore: i === 0 ? null : (stm.etaWindowBeforeMs ?? null),
                etaWindowAfter:  i === 0 ? null : (stm.etaWindowAfterMs ?? null),
                etdWindowBefore: null,
                etdWindowAfter:  null,
                stay: null,
                speed: entity.speedKts ?? null,
                speedWindow: stm.speedWindow ?? null,
            };
        });
        schedules.push({ id: 1, name: 'MONITORING', kind: 'manual', elements });
    }

    const mmsi = entity.mmsi != null ? String(entity.mmsi) : null;
    return {
        uvid: stm.uvid ?? `${STM.ORG_MRN_PREFIX}:scenario:${mmsi ?? 'unknown'}`,
        mmsi,
        imo: entity.imo ?? null,
        vesselName: entity.name ?? null,
        routeName: stm.routeName ??
            (opts.scenarioName ? `${opts.scenarioName} — ${entity.name ?? mmsi}` : `ROUTE ${mmsi ?? ''}`.trim()),
        routeStatus: stm.routeStatus ?? ROUTE_STATUS_MONITORING,
        routeAuthor: SYNTHETIC_AUTHOR,
        validFrom: stm.validFromMs ?? null,
        validTo: stm.validToMs ?? null,
        sourceFormat: 'SYNTHETIC',
        sourceOrigin: 'scenario',
        receivedAt: null,               // stamped by the store on add()
        synthetic: true,
        waypoints,
        schedules,
        parseReport: {
            ok: true, format: 'SCENARIO', version: null,
            warnings: [], droppedElements: [], xtdUnitInferred: null,
        },
        // No original document — this plan was generated, not received. `raw` is
        // filled by rtzFromScenarioEntity() when an RTZ rendering is wanted.
        raw: null,
    };
}

/** Every plan a scenario declares, in entity order. Entities without `stmRoute` are skipped. */
export function plansFromScenario(scenario, opts = {}) {
    const startMs = opts.scenarioStartMs ??
        (scenario?.startTime ? Date.parse(scenario.startTime) : null);
    return (scenario?.entities ?? [])
        .map(e => planFromScenarioEntity(e, {
            scenarioStartMs: Number.isFinite(startMs) ? startMs : null,
            scenarioName: scenario?.name,
        }))
        .filter(Boolean);
}

/**
 * RTZ 1.1 document for a scenario entity — the export path.
 * Round-trips through rtzCodec, so what comes back is exactly what a real
 * RTZ consumer would see, including the SYNTHETIC routeAuthor marker.
 */
export function rtzFromScenarioEntity(entity, opts = {}) {
    const plan = planFromScenarioEntity(entity, opts);
    return plan ? serialise(plan, { version: opts.version ?? '1.1' }) : null;
}

/**
 * Load every plan a scenario declares into a store.
 * The store is passed in rather than imported so this module stays testable
 * without touching global state, and so a caller can stage plans somewhere else.
 * @returns {{added: number, skipped: number}}
 */
export function loadScenarioPlans(scenario, store, opts = {}) {
    const plans = plansFromScenario(scenario, opts);
    let added = 0, skipped = 0;
    for (const p of plans) {
        // Attach an RTZ rendering so the plan can be re-exported, inspected in
        // the UI, or pushed over VIS later exactly like a received one.
        try { p.raw = serialise(p, { version: '1.1' }); } catch { /* non-fatal */ }
        if (store.add(p)) added++; else skipped++;
    }
    return { added, skipped };
}

// ── Debug handle (Tier 3 — DevTools only, never the data path) ───────────────
if (typeof window !== 'undefined') {
    window.vg1ScenarioRoute = {
        planFromScenarioEntity, plansFromScenario, rtzFromScenarioEntity,
        loadScenarioPlans, legTimings, isSynthetic, SYNTHETIC_AUTHOR,
    };
}
