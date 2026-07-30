// zoneBreach.js — entry/exit detection for the user-placed alert zone.
//
// uiController owns the zone itself ({ center, radius } in scene units) and has
// always COUNTED vessels inside it for the badge. What was missing was the event:
// ZONE_BREACH has had display metadata in alertsManager since before this file
// existed but no rule and no raise site, so it could never fire. This is the
// detector that makes it real.
//
// Pure state machine — no THREE, no DOM, no alertsManager. Takes distances,
// returns which vessels ENTERED and which LEFT. Testable in plain Node, which is
// the whole reason it is not just a few lines inside tickAlertZone.
//
// ── THREE THINGS THAT WOULD MAKE THIS WORSE THAN NOTHING ────────────────────
//
// 1. PLACING A ZONE OVER TRAFFIC IS NOT A BREACH. Drop a zone on the Singapore
//    Strait and 60 vessels are instantly "inside" — but none of them crossed
//    anything, and 60 CRITICAL alerts would bury the log and teach the operator
//    to ignore the type. The already-inside set is SEEDED SILENTLY when the zone
//    is placed; only a later crossing is an event.
//
// 2. A VESSEL SITTING ON THE BOUNDARY MUST NOT CHATTER. At exactly the radius,
//    ordinary GPS jitter flips inside/outside every tick. Entry uses the radius;
//    exit needs the radius plus a margin, so leaving is deliberately harder than
//    entering. Same shape as the XTD hysteresis in enhancedMonitor.
//
// 3. IT MUST NOT RUN PER FRAME. tickAlertZone is called from the animation loop;
//    the badge count is cheap enough to stay there, but breach evaluation is
//    gated on ZONE.EVAL_MS. A vessel legitimately crossing back and forth is
//    additionally held off by a per-vessel cooldown.
//
// Tests: node tests/zoneBreach.test.mjs

import { ZONE } from './config.js';

export class ZoneBreachTracker {
    constructor(opts = {}) {
        this.exitHysteresis = opts.exitHysteresis ?? ZONE.EXIT_HYSTERESIS;
        this.cooldownMs = opts.cooldownMs ?? ZONE.ALARM_COOLDOWN_MS;
        /** mmsi → true for every vessel currently considered inside. */
        this._inside = new Set();
        /** mmsi → sim time of the last breach reported for it. */
        this._lastReported = new Map();
        this._seeded = false;
    }

    /** How many vessels the tracker currently considers inside. */
    get insideCount() { return this._inside.size; }

    /** True once a zone has been seeded — evaluate() is inert before that. */
    get seeded() { return this._seeded; }

    /**
     * Adopt the vessels already inside a freshly placed zone WITHOUT reporting
     * them. This is the difference between "a zone was drawn around traffic" and
     * "traffic entered a zone", and conflating the two is what would make the
     * alert type useless in the one place an operator would actually use it.
     *
     * @param {Array<{mmsi: string, dist: number}>} vessels
     * @param {number} radius zone radius, same units as dist
     */
    seed(vessels, radius) {
        this._inside.clear();
        this._lastReported.clear();
        for (const v of vessels ?? []) {
            if (v?.mmsi != null && v.dist < radius) this._inside.add(String(v.mmsi));
        }
        this._seeded = true;
        return this._inside.size;
    }

    /** Forget everything. Called when the zone is cleared. */
    reset() {
        this._inside.clear();
        this._lastReported.clear();
        this._seeded = false;
    }

    /**
     * @param {Array<{mmsi: string, dist: number}>} vessels
     * @param {number} radius
     * @param {number} now sim time in ms
     * @returns {{entered: string[], exited: string[], inside: number}}
     *   `entered` is only those that should RAISE — already filtered by cooldown.
     */
    evaluate(vessels, radius, now) {
        const entered = [], exited = [];
        if (!this._seeded) return { entered, exited, inside: this._inside.size };

        const exitRadius = radius * (1 + this.exitHysteresis);
        const seen = new Set();

        for (const v of vessels ?? []) {
            if (v?.mmsi == null || !Number.isFinite(v.dist)) continue;
            const mmsi = String(v.mmsi);
            seen.add(mmsi);
            const was = this._inside.has(mmsi);

            if (!was && v.dist < radius) {
                this._inside.add(mmsi);
                // Cooldown is a backstop, not the primary guard — the
                // inside/outside state machine already prevents repeats while a
                // vessel stays put. This catches a vessel genuinely oscillating
                // across the boundary faster than an operator could act on.
                const last = this._lastReported.get(mmsi);
                if (last == null || now - last >= this.cooldownMs) {
                    this._lastReported.set(mmsi, now);
                    entered.push(mmsi);
                }
            } else if (was && v.dist > exitRadius) {
                this._inside.delete(mmsi);
                exited.push(mmsi);
            }
        }

        // A vessel that stopped being reported at all — went dark, went stale,
        // was removed — is no longer inside. Dropping it silently rather than
        // as an exit: we did not see it leave, we stopped seeing it, and those
        // are different facts. It is not reported in `exited` for that reason.
        for (const mmsi of [...this._inside]) {
            if (!seen.has(mmsi)) this._inside.delete(mmsi);
        }

        return { entered, exited, inside: this._inside.size };
    }
}

/** Singleton — one alert zone exists at a time (uiController's `_alertZone`). */
export const zoneBreachTracker = new ZoneBreachTracker();
