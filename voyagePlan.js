// voyagePlan.js — the canonical route plan model. NO FORMAT LIVES HERE.
//
// WHY THIS FILE EXISTS (2026-07-30). STM_ROUTE_SPEC §4.2 says the codec boundary
// is the whole point: "If S-421 GML types are visible anywhere outside
// s421Codec.js, the uplift becomes a refactor of the entire subsystem instead of
// one file." That was written as a rule for the SECOND codec. It was already
// broken by the first, because nothing tested it:
//
//     voyagePlanStore.js  →  import { ROUTE_STATUS_MONITORING }            from './rtzCodec.js'
//     enhancedMonitor.js  →  import { scheduleElementFor, activeSchedule } from './rtzCodec.js'
//     scenarioRoute.js    →  import { ROUTE_STATUS_MONITORING }           from './rtzCodec.js'
//
// The monitoring engine imported from a serialisation format. Not because any of
// those things are RTZ concepts — none of them are — but because RTZ was written
// first and they landed in the file that happened to exist. Add a second codec
// and either it re-exports RTZ's constants, or the monitor is welded to RTZ for
// good.
//
// So: everything a plan MEANS lives here. Everything about how a plan is
// SPELLED lives in a codec. A module that reasons about voyages imports this
// file; only routeCodecs.js and the codecs themselves import a codec.
//
// ── THE CANONICAL VoyagePlan ─────────────────────────────────────────────────
//
//   {
//     uvid,          // urn:mrn:stm:voyage:id:<org>:<uuid> — stable identity
//     mmsi,          // the ship this plan belongs to, as a string
//     routeName,     // human label, for the operator
//     routeStatus,   // ROUTE_STATUS enum; 7 is the only one monitored — see below
//     vesselName, vesselMMSI, vesselIMO,
//     waypoints: [{ id, name, lat, lon, radiusNm, leg }],
//     schedules: [{ kind: 'manual'|'calculated', name, elements: [...] }],
//     sourceFormat,  // 'RTZ' | 'S421' — provenance, NOT a behaviour switch
//     sourceVersion, // the version string the DOCUMENT declared, verbatim
//     synthetic,     // true when WE generated it; never true for a shared plan
//     raw,           // original bytes, retained for lossless re-export
//   }
//
// `leg` carries the monitoring thresholds and is per-waypoint by design: XTD is
// a property of the leg a ship is on, never a global constant. A leg with no
// declared XTD leaves it null — the monitor then reports UNKNOWN rather than
// substituting a default and calling the result compliance.
//
// sourceFormat and sourceVersion are recorded and NEVER normalised. Two
// documents describing the same voyage under different editions of a standard
// are not interchangeable if the editions differ on geometry or CRS handling,
// and a silently-upgraded plan is a monitoring threshold computed against the
// wrong reference. Same class of error as inferring XTD units — a factor applied
// where none was intended.

// ── routeStatus ──────────────────────────────────────────────────────────────
// From the STM route status enumeration, which RTZ 1.1 (CIRM Guidelines v1.8)
// and S-421 (IEC 63173-1) both carry — it describes the PLAN's standing in the
// voyage, not the file it arrived in. That is precisely why it does not belong
// to either codec.
export const ROUTE_STATUS = {
    1: 'ORIGINAL',
    2: 'PLANNED FOR VOYAGE',
    3: 'OPTIMIZED',
    4: 'CROSS CHECKED',
    5: 'SAFETY CHECKED',
    6: 'APPROVED',
    7: 'USED FOR MONITORING',
    8: 'INACTIVE',
};

// 7 is the one Enhanced Monitoring keys on: the route is loaded in the ship's
// ECDIS and being steered. Monitoring a route at any other status is monitoring
// an intention nobody is executing — an approved-but-not-loaded plan looks
// identical to a live one and would generate deviation alarms against a route
// the bridge is not following.
export const ROUTE_STATUS_MONITORING = 7;

/** True when this plan is the one the ship is actually steering. */
export function isMonitoring(plan) {
    return plan?.routeStatus === ROUTE_STATUS_MONITORING;
}

/**
 * The schedule Enhanced Monitoring should measure against.
 *
 * Preference: manual (what the crew entered) over calculated (what a tool
 * produced) — the crew's intent outranks a solver's. The standards say only one
 * schedule should be active at status 7; when a document breaks that rule we
 * take the first rather than merging, because merging two schedules invents a
 * timetable no one published.
 */
export function activeSchedule(plan) {
    const s = plan?.schedules ?? [];
    if (!s.length) return null;
    return s.find(x => x.kind === 'manual') ?? s[0];
}

/** Schedule element for a given waypoint id, or null. */
export function scheduleElementFor(plan, waypointId) {
    const sch = activeSchedule(plan);
    if (!sch) return null;
    return sch.elements.find(e => e.waypointId === waypointId) ?? null;
}

/**
 * A short provenance label for the operator: what format this plan arrived in
 * and under which declared version.
 *
 * Deliberately reads from the plan rather than from a codec, and says UNKNOWN
 * rather than guessing. A plan whose origin we cannot name is a plan whose
 * parsing assumptions we cannot defend.
 */
export function provenanceLabel(plan) {
    if (!plan) return 'UNKNOWN';
    if (plan.synthetic) return 'SYNTHETIC';
    const fmt = plan.sourceFormat ?? 'UNKNOWN';
    return plan.sourceVersion ? `${fmt} ${plan.sourceVersion}` : fmt;
}

// ── Debug handle (Tier 3 — DevTools only, never the data path) ───────────────
if (typeof window !== 'undefined') {
    window.vg1VoyagePlan = {
        ROUTE_STATUS, ROUTE_STATUS_MONITORING,
        isMonitoring, activeSchedule, scheduleElementFor, provenanceLabel,
    };
}
