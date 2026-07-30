// enhancedMonitor.js — STM Enhanced Monitoring: is this vessel following the
// route it declared?
//
// Shaped exactly like portCallManager.js: a per-MMSI Map of state, a tick() on a
// config.js timer (STM.TICK_MS) rather than per frame, localStorage-free, and a
// vg1:* event on every state change. No visual half — routeLayer owns that.
//
// ── THE ONE STRUCTURAL FACT MOST IMPLEMENTATIONS GET WRONG ──────────────────
// The thresholds are NOT constants. They are per-leg values the ship itself
// declared in its shared RTZ. The STM Validation shore-side implementation
// (deliverables D2.9/D2.11) defines every alarm purely in those terms:
//
//   "Off XTE on route"    the target deviates from the route axis by more than
//                         the portsideXTD / starboardXTD value of RTZ
//   "Out of schedule"     the target's ETA to the next waypoint is behind the
//                         schedule
//   "Grounding on route"  the Draught parameter value for the route target is
//                         larger than the safetyDepth value of RTZ
//
// No primary STM source specifies a numeric threshold anywhere. So every default
// in STM.* is OUR invention, and any alarm raised on one carries
// `usedDefault: true` and says so in its message. A system that quietly
// substitutes its own threshold for the ship's declared one is manufacturing
// authority it does not have.
//
// ── THREE THINGS THAT WOULD MAKE THIS USELESS IF GOT WRONG ──────────────────
// 1. UNMONITORED IS NOT COMPLIANT. Essentially no live AIS vessel shares a
//    route plan. A vessel with no plan gets state UNMONITORED and NO alarms —
//    and the UI must never let that read as "fine". monitoringCoverage() exists
//    so the panel can say "12 of 431 monitored" out loud.
// 2. CORNER-CUTTING IS NOT A DEVIATION. A ship turning inside a waypoint's
//    declared turn radius legitimately exceeds XTD for a moment. Alarming on it
//    would fire on every competent turn, so it is suppressed inside the radius
//    and every breach must persist for STM.DEVIATION_CONFIRM_MS.
// 3. alertsManager HAS NO DEDUP. It collapses consecutive same-type rows
//    visually at render time, but nothing keys on (type, mmsi). At TICK_MS=5s an
//    unthrottled deviation would raise 12 identical alerts a minute, so this
//    module throttles at source per (mmsi, alarmType).
//
// Debug: window.vg1Monitor
// Tests: node tests/enhancedMonitor.test.mjs

import { STM } from './config.js';
import { simClock } from './simClock.js';
import { voyagePlanStore } from './voyagePlanStore.js';
import { projectOntoRoute } from './routeGeometry.js';
import { scheduleElementFor, activeSchedule } from './rtzCodec.js';
import { isSynthetic } from './scenarioRoute.js';

/** Vessel-level monitoring states. */
export const MONITOR_STATE = {
    UNMONITORED: 'UNMONITORED',   // no plan shared — UNKNOWN, not compliant
    ON_TRACK:    'ON_TRACK',
    DEVIATING:   'DEVIATING',
    OFF_ROUTE:   'OFF_ROUTE',
    NO_FIX:      'NO_FIX',        // plan exists, vessel dark or stale
    SUPPRESSED:  'SUPPRESSED',    // at anchor / NUC / moored — not misbehaving
    ARRIVED:     'ARRIVED',       // reached the end of the declared route
};

/** Alarm types, with the alertsManager type they map to and their severity. */
export const ALARMS = {
    OFF_XTE:               { alert: 'ROUTE_DEVIATION',      severity: 'WARNING' },
    OUT_OF_SCHEDULE:       { alert: 'SCHEDULE_SLIP',        severity: 'WARNING' },
    SAFETY_DEPTH_CONFLICT: { alert: 'SAFETY_DEPTH_CONFLICT', severity: 'CRITICAL' },
    SPEED_OUT_OF_ENVELOPE: { alert: 'ROUTE_DEVIATION',      severity: 'WARNING' },
    NON_ARRIVAL:           { alert: 'NON_ARRIVAL',          severity: 'CRITICAL' },
    ROUTE_ABANDONED:       { alert: 'ROUTE_DEVIATION',      severity: 'WARNING' },
};

const H_MS = 3600_000;

function now() {
    try { return simClock.now(); } catch { return Date.now(); }
}

function emit(name, detail) {
    if (typeof window === 'undefined' || !window.dispatchEvent) return;
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch { /* non-fatal */ }
}

export class EnhancedMonitor {
    /**
     * @param {object} [opts] { store, alerts } — injected for testability.
     *   `alerts` defaults to window.alertsManager, which is the real (and only)
     *   way anything raises an alert in this codebase.
     */
    constructor(opts = {}) {
        this.store = opts.store ?? voyagePlanStore;
        this._alerts = opts.alerts ?? null;
        /** mmsi → MonitorState */
        this.states = new Map();
        this._lastTick = null;
        /** Total vessels seen on the most recent tick, for coverage reporting. */
        this._seen = 0;

        if (typeof window !== 'undefined') window.vg1Monitor = this;
    }

    get alerts() {
        return this._alerts ??
            (typeof window !== 'undefined' ? window.alertsManager : null) ?? null;
    }

    // ── reads ────────────────────────────────────────────────────────────────

    /** Monitor state for a vessel, or null if never evaluated. */
    stateOf(mmsi) { return this.states.get(String(mmsi)) ?? null; }

    /**
     * How much of the fleet is actually being monitored.
     *
     * The route panel must show this. A map where a handful of ships have route
     * ribbons and hundreds do not is a map where hundreds are UNKNOWN, and an
     * operator will read bare water as "fine" unless told the number out loud.
     */
    monitoringCoverage() {
        let monitored = 0, deviating = 0, suppressed = 0, arrived = 0;
        for (const [, s] of this.states) {
            if (s.state === MONITOR_STATE.UNMONITORED) continue;
            monitored++;
            if (s.state === MONITOR_STATE.DEVIATING || s.state === MONITOR_STATE.OFF_ROUTE) deviating++;
            if (s.state === MONITOR_STATE.SUPPRESSED) suppressed++;
            if (s.state === MONITOR_STATE.ARRIVED) arrived++;
        }
        return { total: this._seen, monitored, unmonitored: Math.max(0, this._seen - monitored),
                 deviating, suppressed, arrived };
    }

    /** Every vessel currently in a confirmed deviating state. */
    deviating() {
        return [...this.states.values()].filter(s =>
            s.state === MONITOR_STATE.DEVIATING || s.state === MONITOR_STATE.OFF_ROUTE);
    }

    // ── the tick ─────────────────────────────────────────────────────────────

    /**
     * Evaluate every vessel against its declared plan.
     *
     * @param {Iterable} vessels anything yielding
     *   { mmsi, latDeg, lonDeg, speedKts, cogDeg, draughtM, navStatus, lastSeen, isDark }
     *   — aisManager.vessels.values() satisfies this directly, which is the same
     *   duck-typed contract portCallManager.tick uses.
     */
    tick(vessels) {
        const t = now();
        this._lastTick = t;
        let seen = 0;

        // A plan whose validity window has closed must stop being monitored
        // rather than keep alarming against a stale schedule.
        this.store.expire(t);

        for (const v of vessels ?? []) {
            if (!v || v.mmsi == null) continue;
            seen++;
            this._evaluate(v, t);
        }
        this._seen = seen;
        return this.monitoringCoverage();
    }

    _evaluate(v, t) {
        const mmsi = String(v.mmsi);
        const plan = this.store.byMmsi(mmsi, t);

        if (!plan) {
            // No plan shared. This is the overwhelmingly common case and it is
            // an ABSENCE OF INFORMATION, not a clean bill of health. Any prior
            // state is dropped so a vessel whose plan expired stops reading as
            // monitored.
            const prev = this.states.get(mmsi);
            if (prev && prev.state !== MONITOR_STATE.UNMONITORED) {
                this._setState(prev, MONITOR_STATE.UNMONITORED, t);
                prev.uvid = null;
                prev.alarms.clear();
            } else if (!prev) {
                this.states.set(mmsi, this._blank(mmsi, t));
            }
            return;
        }

        let s = this.states.get(mmsi);
        if (!s || s.uvid !== (plan.uvid ?? null)) {
            // New vessel, or the ship swapped to a different plan — reset the leg
            // hint and alarm history rather than carrying them across routes.
            s = this._blank(mmsi, t);
            this.states.set(mmsi, s);
        }
        s.uvid = plan.uvid ?? null;
        s.synthetic = isSynthetic(plan);
        s.lastEvaluated = t;

        // ── no fix ───────────────────────────────────────────────────────────
        if (v.isDark || v.latDeg == null || v.lonDeg == null) {
            this._setState(s, MONITOR_STATE.NO_FIX, t);
            return;
        }

        // ── measure against the plan ─────────────────────────────────────────
        const proj = projectOntoRoute(v.latDeg, v.lonDeg, plan, s.legIndex,
                                      STM.ROUTE_CORRIDOR_HINT_NM);
        if (proj.legIndex == null) {
            this._setState(s, MONITOR_STATE.NO_FIX, t);
            return;
        }
        s.legIndex = proj.legIndex;
        s.crossTrackNm = proj.crossTrackNm;
        s.alongTrackNm = proj.alongTrackNm;
        s.distanceToNextWpNm = proj.distanceToNextWpNm;
        s.distanceToEndNm = proj.distanceToEndNm;
        s.method = proj.method;

        const toWp = plan.waypoints[proj.legIndex + 1];
        const leg = toWp?.leg ?? null;

        // ── arrival ──────────────────────────────────────────────────────────
        // THE VOYAGE IS OVER. Once the vessel reaches the end of its declared
        // route there is nothing left to be late for, and every schedule
        // computation downstream becomes degenerate: distanceToNextWpNm is ~0,
        // so the projected ETA collapses to "now", and comparing now against the
        // final declared ETA produces a slip that grows one minute per minute,
        // forever, on a ship that arrived exactly on time.
        //
        // Found by tests/browser/stmIntegration.html, not by any unit test: it
        // only appears once a full voyage is played out past its own end, which
        // is precisely what a fixture pinned to one moment in time cannot do.
        const finalWp = plan.waypoints[plan.waypoints.length - 1];
        const arrivalRadius = Math.max(finalWp?.radius ?? 0, STM.ARRIVAL_RADIUS_NM);
        if (proj.distanceToEndNm != null && proj.distanceToEndNm <= arrivalRadius) {
            this._setState(s, MONITOR_STATE.ARRIVED, t);
            s.alarms.clear();
            s.projectedEta = null;
            s.scheduleSlipMs = null;
            return;
        }

        // ── suppression ──────────────────────────────────────────────────────
        // At anchor, not under command, restricted in ability to manoeuvre,
        // moored or aground: the vessel is not failing to follow its route, and
        // alarming would be noise. Measurements are still recorded.
        if (v.navStatus != null && STM.SUPPRESS_ON_NAV_STATUS.includes(v.navStatus)) {
            s.suppressedBy = v.navStatus;
            this._setState(s, MONITOR_STATE.SUPPRESSED, t);
            s.alarms.clear();
            return;
        }
        s.suppressedBy = null;

        // ── evaluate every alarm ─────────────────────────────────────────────
        const verdicts = [
            this._offXte(v, plan, proj, leg, toWp),
            this._outOfSchedule(v, plan, proj, toWp),
            this._safetyDepth(v, leg),
            this._speedEnvelope(v, leg, plan, toWp),
            this._nonArrival(v, plan, proj, t),
            this._abandoned(v, plan, proj, leg),
        ];

        let anyConfirmed = false, abandoned = false;
        for (const verdict of verdicts) {
            if (!verdict) continue;
            const confirmed = this._applyHysteresis(s, verdict, t);
            if (confirmed) {
                anyConfirmed = true;
                if (verdict.type === 'ROUTE_ABANDONED') abandoned = true;
            }
        }

        this._setState(s,
            abandoned ? MONITOR_STATE.OFF_ROUTE
            : anyConfirmed ? MONITOR_STATE.DEVIATING
            : MONITOR_STATE.ON_TRACK, t);
    }

    _blank(mmsi, t) {
        return {
            mmsi, uvid: null, synthetic: false,
            legIndex: null, crossTrackNm: null, alongTrackNm: null,
            distanceToNextWpNm: null, distanceToEndNm: null,
            projectedEta: null, scheduleSlipMs: null,
            method: null, suppressedBy: null,
            state: MONITOR_STATE.UNMONITORED, stateSince: t,
            alarms: new Map(), lastEvaluated: t,
        };
    }

    _setState(s, state, t) {
        if (s.state === state) return;
        const from = s.state;
        s.state = state;
        s.stateSince = t;
        emit('vg1:routeMonitorState', {
            mmsi: s.mmsi, uvid: s.uvid, from, to: state, simTime: t,
        });
    }

    // ── the alarms ───────────────────────────────────────────────────────────

    /**
     * Cross-track deviation. The threshold is the ship's OWN declared corridor,
     * asymmetric, for the leg it is currently on.
     */
    _offXte(v, plan, proj, leg, toWp) {
        const xt = proj.crossTrackNm;
        if (xt == null) return null;

        const starboard = xt >= 0;
        let limit = starboard ? leg?.starboardXTD : leg?.portsideXTD;
        const usedDefault = limit == null;
        if (usedDefault) limit = STM.DEFAULT_XTD_NM;

        // Corner-cutting suppression. Inside a waypoint's declared turn radius a
        // vessel legitimately swings wide of the axis; alarming there would fire
        // on every competent turn. Only the DECLARED radius suppresses — we do
        // not invent one, because inventing it would blind the monitor near
        // every waypoint on a route that never declared any.
        const radius = toWp?.radius;
        if (radius != null && proj.distanceToNextWpNm != null &&
            proj.distanceToNextWpNm <= radius) {
            return { type: 'OFF_XTE', breach: false, reason: 'inside turn radius' };
        }

        return {
            type: 'OFF_XTE',
            breach: Math.abs(xt) > limit,
            usedDefault,
            evidence: {
                crossTrackNm: round3(xt), side: starboard ? 'starboard' : 'port',
                xtdLimitNm: limit, usedDefault, legIndex: proj.legIndex,
            },
            message: (u) => `${Math.abs(xt).toFixed(2)} nm ${starboard ? 'starboard' : 'port'} ` +
                `of route axis, outside the ${limit} nm corridor` +
                (u ? ' (assumed — the plan declares no XTD for this leg)' : ''),
        };
    }

    /**
     * Schedule slip. Projects an ETA to the next waypoint from distance ALONG
     * THE ROUTE and current SOG, then compares against the declared ETA using
     * the plan's own per-waypoint tolerance window.
     */
    _outOfSchedule(v, plan, proj, toWp) {
        const elem = scheduleElementFor(plan, toWp?.id);
        if (!elem?.eta) return null;                      // nothing declared to be late against

        const sog = v.speedKts;
        if (sog == null || sog < STM.MIN_SOG_FOR_SCHEDULE_KTS) {
            // A stopped vessel has no meaningful projected ETA — dividing by ~0
            // would manufacture an arbitrarily large slip. Report nothing.
            return { type: 'OUT_OF_SCHEDULE', breach: false, reason: 'stopped' };
        }
        const dist = proj.distanceToNextWpNm;
        if (dist == null) return null;

        const projectedEta = now() + (dist / sog) * H_MS;
        const slip = projectedEta - elem.eta;
        const late = slip > 0;
        let tol = late ? elem.etaWindowAfter : elem.etaWindowBefore;
        const usedDefault = tol == null;
        if (usedDefault) tol = STM.DEFAULT_SCHEDULE_TOLERANCE_MS;

        const st = this.states.get(String(v.mmsi));
        if (st) { st.projectedEta = projectedEta; st.scheduleSlipMs = slip; }

        return {
            type: 'OUT_OF_SCHEDULE',
            breach: Math.abs(slip) > tol,
            usedDefault,
            evidence: {
                projectedEta, declaredEta: elem.eta, slipMs: Math.round(slip),
                toleranceMs: tol, usedDefault, waypointId: toWp?.id,
                distanceToWpNm: round3(dist), sogKts: sog,
            },
            message: (u) => `${fmtMins(Math.abs(slip))} ${late ? 'behind' : 'ahead of'} schedule ` +
                `for ${toWp?.name ?? `WP${toWp?.id}`} (tolerance ${fmtMins(tol)})` +
                (u ? ' (assumed — the plan declares no ETA window)' : ''),
        };
    }

    /**
     * Declared draught against the leg's declared safety depth.
     *
     * This is a PLAN CONSISTENCY check, not a real under-keel clearance
     * calculation — real UKC needs bathymetry, tide and squat, none of which
     * exist here. The alarm is named for what it actually is.
     */
    _safetyDepth(v, leg) {
        const d = v.draughtM, sd = leg?.safetyDepth;
        if (d == null || sd == null) return null;    // frequently null, and that is correct
        return {
            type: 'SAFETY_DEPTH_CONFLICT',
            breach: d > sd,
            usedDefault: false,
            evidence: { draughtM: d, safetyDepthM: sd, marginM: round3(sd - d) },
            message: () => `declared draught ${d} m exceeds the leg's declared safety depth ${sd} m`,
        };
    }

    _speedEnvelope(v, leg, plan, toWp) {
        const sog = v.speedKts;
        if (sog == null || (leg?.speedMin == null && leg?.speedMax == null)) return null;
        // A stopped ship is not "below the minimum speed" in any useful sense.
        if (sog < STM.MIN_SOG_FOR_SCHEDULE_KTS) {
            return { type: 'SPEED_OUT_OF_ENVELOPE', breach: false, reason: 'stopped' };
        }
        const window = scheduleElementFor(plan, toWp?.id)?.speedWindow ?? 0;
        const below = leg.speedMin != null && sog < leg.speedMin - window;
        const above = leg.speedMax != null && sog > leg.speedMax + window;
        return {
            type: 'SPEED_OUT_OF_ENVELOPE',
            breach: below || above,
            usedDefault: false,
            evidence: { sogKts: sog, speedMin: leg.speedMin, speedMax: leg.speedMax, window },
            message: () => `${sog} kn is outside the declared ` +
                `${leg.speedMin ?? '—'}–${leg.speedMax ?? '—'} kn envelope for this leg`,
        };
    }

    /**
     * The ship never showed up. The final waypoint's ETA has passed by more than
     * its tolerance and the vessel is still under way — operationally the most
     * consequential of these alarms, and one RTZ has no field for.
     */
    _nonArrival(v, plan, proj, t) {
        const wps = plan.waypoints;
        const final = wps[wps.length - 1];
        const elem = scheduleElementFor(plan, final?.id);
        if (!elem?.eta) return null;
        const tol = elem.etaWindowAfter ?? STM.DEFAULT_SCHEDULE_TOLERANCE_MS;
        const overdue = t - (elem.eta + tol);
        // Still short of the end of the route, and past due.
        const stillRunning = (proj.distanceToEndNm ?? 0) > 0.5;
        return {
            type: 'NON_ARRIVAL',
            breach: overdue > 0 && stillRunning,
            usedDefault: elem.etaWindowAfter == null,
            evidence: {
                finalWaypointId: final?.id, declaredEta: elem.eta,
                overdueMs: Math.round(overdue), toleranceMs: tol,
                distanceToEndNm: round3(proj.distanceToEndNm),
            },
            message: (u) => `overdue at ${final?.name ?? 'final waypoint'} by ` +
                `${fmtMins(overdue)}, still ${(proj.distanceToEndNm ?? 0).toFixed(1)} nm short` +
                (u ? ' (assumed tolerance)' : ''),
        };
    }

    /**
     * The route has been abandoned rather than deviated from. Beyond this the
     * vessel is no longer meaningfully "on" the plan, and continuing to raise
     * XTE alarms against it is spam.
     *
     * The stored routeStatus is NOT mutated — the ship owns that field. This is
     * monitor state only.
     */
    _abandoned(v, plan, proj, leg) {
        const xt = proj.crossTrackNm;
        if (xt == null) return null;
        const widest = Math.max(leg?.portsideXTD ?? STM.DEFAULT_XTD_NM,
                                leg?.starboardXTD ?? STM.DEFAULT_XTD_NM);
        const limit = widest * STM.ABANDON_XTD_MULTIPLE;
        return {
            type: 'ROUTE_ABANDONED',
            breach: Math.abs(xt) > limit || proj.method === 'off-route',
            usedDefault: leg?.portsideXTD == null && leg?.starboardXTD == null,
            evidence: { crossTrackNm: round3(xt), abandonLimitNm: round3(limit), method: proj.method },
            message: () => `${Math.abs(xt).toFixed(1)} nm off axis — beyond ` +
                `${STM.ABANDON_XTD_MULTIPLE}× the declared corridor; treating the route as abandoned`,
        };
    }

    // ── hysteresis + throttling ──────────────────────────────────────────────

    /**
     * Confirm/clear an alarm with hysteresis, and raise at most one alert per
     * (mmsi, type) per STM.ALARM_COOLDOWN_MS.
     * @returns {boolean} whether the alarm is currently CONFIRMED
     */
    _applyHysteresis(s, verdict, t) {
        const { type, breach } = verdict;
        let a = s.alarms.get(type);

        if (!breach) {
            if (!a) return false;
            if (a.confirmed) {
                a.clearingSince ??= t;
                if (t - a.clearingSince >= STM.DEVIATION_CLEAR_MS) {
                    s.alarms.delete(type);
                    emit('vg1:routeDeviationCleared', { mmsi: s.mmsi, uvid: s.uvid, type, simTime: t });
                    return false;
                }
                return true;                 // still confirmed while clearing
            }
            s.alarms.delete(type);           // never confirmed — drop it silently
            return false;
        }

        if (!a) {
            a = { since: t, confirmed: false, clearingSince: null, lastRaised: null };
            s.alarms.set(type, a);
        }
        a.clearingSince = null;
        a.evidence = verdict.evidence ?? null;

        if (!a.confirmed && t - a.since >= STM.DEVIATION_CONFIRM_MS) {
            a.confirmed = true;
            a.confirmedAt = t;
        }
        if (!a.confirmed) return false;

        // Throttle at source: alertsManager has no dedup of its own.
        if (a.lastRaised == null || t - a.lastRaised >= STM.ALARM_COOLDOWN_MS) {
            a.lastRaised = t;
            this._raise(s, verdict, t);
        }
        return true;
    }

    _raise(s, verdict, t) {
        const meta = ALARMS[verdict.type];
        const usedDefault = !!verdict.usedDefault;
        const text = typeof verdict.message === 'function'
            ? verdict.message(usedDefault) : String(verdict.message ?? verdict.type);

        const detail = {
            mmsi: s.mmsi, uvid: s.uvid, type: verdict.type,
            severity: meta?.severity ?? 'WARNING',
            message: text, usedDefault, synthetic: s.synthetic,
            evidence: verdict.evidence ?? null,
            // alertsManager stamps Date.now(); STM alerts must survive
            // time-scrubbing, so the sim time is carried explicitly.
            simTime: t,
        };

        emit('vg1:routeDeviation', detail);

        const alerts = this.alerts;
        if (alerts?.addAlert) {
            try {
                alerts.addAlert({
                    type: meta?.alert ?? 'ROUTE_DEVIATION',
                    mmsi: s.mmsi,
                    message: (s.synthetic ? '[SYNTHETIC PLAN] ' : '') + text,
                    extra: detail,
                });
            } catch (e) {
                console.warn('[enhancedMonitor] alert raise failed:', e?.message ?? e);
            }
        }
    }

    /** Drop all monitor state. Plans are untouched — the store owns those. */
    clear() { this.states.clear(); this._seen = 0; }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function round3(n) { return n == null ? null : Math.round(n * 1000) / 1000; }
function fmtMins(ms) {
    const m = Math.round(Math.abs(ms) / 60000);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    return `${h} h ${String(m % 60).padStart(2, '0')} min`;
}

/** Singleton, following portCallManager's export shape. */
export const enhancedMonitor = new EnhancedMonitor();
