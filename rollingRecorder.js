// rollingRecorder.js — always-on positional history, so scrubbing rewinds ships.
//
// THE PROBLEM THIS SOLVES
// ───────────────────────
// simClock is a time REFERENCE, not a recording. Everything computed FROM it —
// sun position, terminator, staleness — follows a scrub correctly. Vessel and
// aircraft positions do not, because the live feed only ever says "here is where
// this ship is now". So scrubbing back nine hours produced correct nine-hour-ago
// sunlight over ships sitting at their present positions: a view that looks like
// history and is not. The timeline rail labels that state LIGHTING ONLY.
//
// This module removes the caveat by continuously retaining where things were.
//
// WHY NOT JUST USE AISRecorder
// ────────────────────────────
// AISRecorder keeps every raw message and is capped at 200k records — minutes of
// a 500-vessel feed, and it replays FORWARD from a cursor, which is the wrong
// shape for scrubbing (jumping to an arbitrary time means replaying everything
// in between). This keeps a DECIMATED, per-vessel ring instead: one sample per
// vessel per DECIMATE_MS. That makes the cost predictable and, more importantly,
// makes an arbitrary seek O(log n) per vessel rather than a re-walk.
//
// MEMORY IS BOUNDED TWO WAYS, deliberately
//   1. a time window (drop anything older than windowMs)
//   2. a hard global sample cap that raises the cutoff when exceeded
// The cap is the real guarantee: window alone scales with vessel count, and a
// busy theatre must not be able to grow this without limit.
//
// HONESTY CONTRACT
// ────────────────
// isTimeBacked() returns true ONLY while the buffer actually covers the current
// sim time. Scrub beyond coverage and it reverts to false, so the rail goes back
// to saying LIGHTING ONLY rather than implying a history that was never kept.
// Claiming coverage we don't have would be exactly the quiet falsehood this
// codebase already fights hardest (see invariants.js).
//
// Console: window.vg1Rolling

import { DataSource } from './dataSource.js';
import { simClock } from './simClock.js';
import { impliedSpeedKts } from './invariants.js';
import { INVARIANTS } from './config.js';

const DEFAULTS = {
    windowMs:    2 * 3600_000,   // 2h of history
    decimateMs:  30_000,         // at most one sample per vessel per 30s
    maxSamples:  150_000,        // hard ceiling across ALL vessels
};

// ─────────────────────────────────────────────────────────────────────────────
// PURE HELPERS — no DOM, no clock. Exported for tests/rollingRecorder.test.mjs.
// ─────────────────────────────────────────────────────────────────────────────

/** Index of the last sample with t <= target, or -1. Samples sorted ascending. */
export function floorIndex(samples, target) {
    let lo = 0, hi = samples.length - 1, best = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (samples[mid].t <= target) { best = mid; lo = mid + 1; }
        else hi = mid - 1;
    }
    return best;
}

/**
 * Position at `target`, linearly interpolated between bracketing samples.
 * Returns null when target is outside the vessel's retained span — callers must
 * treat "no coverage" as a real answer and not substitute the nearest sample,
 * which would silently invent a position.
 */
export function sampleAt(samples, target) {
    if (!samples || samples.length === 0) return null;
    if (target < samples[0].t) return null;
    const last = samples[samples.length - 1];
    if (target > last.t) return null;

    const i = floorIndex(samples, target);
    if (i < 0) return null;
    const a = samples[i];
    if (i === samples.length - 1 || a.t === target) return { ...a, interpolated: false };

    const b = samples[i + 1];
    const span = b.t - a.t;
    const f = span > 0 ? (target - a.t) / span : 0;

    // Longitude is interpolated the short way around so a track crossing the
    // antimeridian does not sweep the entire globe backwards.
    let dLon = b.lon - a.lon;
    if (dLon >  180) dLon -= 360;
    if (dLon < -180) dLon += 360;
    let lon = a.lon + dLon * f;
    if (lon >  180) lon -= 360;
    if (lon < -180) lon += 360;

    return {
        t:   target,
        lat: a.lat + (b.lat - a.lat) * f,
        lon,
        sog: a.sog + (b.sog - a.sog) * f,
        cog: a.cog,                        // bearing: hold, don't lerp across 0/360
        name: a.name, shipType: a.shipType,
        interpolated: true
    };
}

/** AISStream-shaped report so aisManager cannot tell replay from live. */
export function buildReport(mmsi, s) {
    return {
        MessageType: 'PositionReport',
        MetaData: {
            MMSI: mmsi,
            ShipName: s.name || 'UNKNOWN',
            ShipType: s.shipType ?? 70,
            latitude: s.lat,
            longitude: s.lon,
            // The EVENT time is the sample's time, not now. invariants.js reads
            // this and would otherwise flag every replayed report as a
            // TIME_REGRESSION against the clock it is being replayed into.
            time_utc: new Date(s.t).toISOString(),
        },
        Message: { PositionReport: { Sog: s.sog, Cog: s.cog, TrueHeading: s.cog } }
    };
}

// ─────────────────────────────────────────────────────────────────────────────

export class RollingRecorder extends DataSource {
    constructor(opts = {}) {
        super();
        this.windowMs   = opts.windowMs   ?? DEFAULTS.windowMs;
        this.decimateMs = opts.decimateMs ?? DEFAULTS.decimateMs;
        this.maxSamples = opts.maxSamples ?? DEFAULTS.maxSamples;

        this._byMmsi   = new Map();   // mmsi -> [{t,lat,lon,sog,cog,name,shipType}]
        this._total    = 0;
        this._lastKeep = new Map();   // mmsi -> t of last retained sample
        this._ais      = null;
        this._replaying = false;
        this._evictions = 0;
        this._rejected  = 0;   // teleport-grade reports refused entry
    }

    /** Give it the manager so it can mute the live feed during replay. */
    attach(aisManager) { this._ais = aisManager; return this; }

    // ── capture ──────────────────────────────────────────────────────────────
    /**
     * Chainable tap for aisManager.onRawMessage. Records REAL wall time, not
     * sim time: this is a record of when things actually were where they were,
     * and must stay meaningful no matter what the clock is doing. Recording
     * against a scrubbed clock would write history into the past twice.
     */
    tap() {
        return (msg) => {
            if (this._replaying) return;         // don't record our own playback
            const md = msg?.MetaData;
            const pr = msg?.Message?.PositionReport;
            if (!md || !pr) return;
            const mmsi = String(md.MMSI ?? '');
            if (!mmsi) return;
            const lat = md.latitude, lon = md.longitude;
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

            const now  = Date.now();
            const last = this._lastKeep.get(mmsi);
            if (last != null && now - last < this.decimateMs) return;   // decimate

            let arr = this._byMmsi.get(mmsi);
            if (!arr) { arr = []; this._byMmsi.set(mmsi, arr); }

            // ── reject teleports BEFORE they enter the history ───────────────
            // aisManager.ingest() fires onRawMessage BEFORE _handleMsg runs the
            // invariant checks, so this tap sees raw traffic — including reports
            // that invariants.js will reject as IMPOSSIBLE_SPEED. Observed live:
            // one MMSI moved 66° of arc in 119 s.
            //
            // Storing those would be worse than wasteful. sampleAt() lerps
            // between neighbouring samples, so a good point and a garbage point
            // would produce a smooth, plausible-looking track through positions
            // the vessel was never in — fabricated history that passes the very
            // speed check the raw report failed. Apply the same rule here.
            const prev = arr.length ? arr[arr.length - 1] : null;
            if (prev) {
                const dt = now - prev.t;
                // dt <= 0 is the MOST impossible case, not an exemption: moving
                // any distance in zero elapsed time is infinite speed. An earlier
                // version guarded with `if (dt > 0)` and so waved through exactly
                // the worst reports. Decimation makes dt==0 rare in production,
                // which is what would have kept this hidden.
                const kts = dt > 0
                    ? impliedSpeedKts(prev.lat, prev.lon, lat, lon, dt)
                    : (Math.abs(lat - prev.lat) + Math.abs(lon - prev.lon) > 1e-6 ? Infinity : 0);
                // HARD_REJECT_KTS (120) is the VESSEL teleport threshold that
                // invariants.js itself uses. An earlier version reached for
                // FLIGHT_INTEGRITY.IMPOSSIBLE_SPEED_KTS — an aircraft limit that
                // is not on this object at all, so the comparison was
                // `kts > undefined`, always false, and the guard was dead code
                // that silently rejected nothing.
                if (kts > INVARIANTS.HARD_REJECT_KTS) { this._rejected++; return; }
            }

            arr.push({
                t: now, lat, lon,
                sog: Number.isFinite(pr.Sog) ? pr.Sog : 0,
                cog: Number.isFinite(pr.Cog) ? pr.Cog : 0,
                name: md.ShipName, shipType: md.ShipType,
            });
            this._lastKeep.set(mmsi, now);
            this._total++;
            if (this._total > this.maxSamples) this._evict();
        };
    }

    /**
     * Two-stage eviction. Stage 1 is the time window; stage 2 is the hard cap.
     *
     * Stage 2 exists because a TIME cutoff cannot bound memory on its own — a
     * burst of samples sharing one timestamp is not "older than" anything, so
     * no cutoff can remove it and the cap is silently unenforceable. A unit
     * test offering 1200 samples against a cap of 200 retained all 1200 before
     * this was split in two. In production samples usually spread over time and
     * stage 1 alone would *mostly* work, which is precisely what makes the hole
     * dangerous: it only opens under load, when memory matters most.
     *
     * Stage 2 therefore evicts by COUNT, oldest-first from whichever vessel is
     * hoarding the most, which terminates regardless of timestamps.
     */
    _evict() {
        // ── stage 1: honour the time window ──────────────────────────────────
        const cutoff = Date.now() - this.windowMs;
        for (const [mmsi, arr] of this._byMmsi) {
            let drop = 0;
            while (drop < arr.length && arr[drop].t < cutoff) drop++;
            if (drop) { arr.splice(0, drop); this._total -= drop; this._evictions += drop; }
            if (arr.length === 0) { this._byMmsi.delete(mmsi); this._lastKeep.delete(mmsi); }
        }
        if (this._total <= this.maxSamples) return;

        // ── stage 2: enforce the cap by count ────────────────────────────────
        // Trim the largest series first so history is given up evenly rather
        // than one vessel's track being erased while others keep hours.
        while (this._total > this.maxSamples && this._byMmsi.size) {
            let biggest = null, biggestLen = 0;
            for (const [mmsi, arr] of this._byMmsi) {
                if (arr.length > biggestLen) { biggestLen = arr.length; biggest = mmsi; }
            }
            if (!biggest || biggestLen === 0) break;
            const arr = this._byMmsi.get(biggest);
            // Drop a chunk rather than one at a time — splice(0,1) in a loop is
            // O(n²) and this runs on the ingest path.
            const chunk = Math.max(1, Math.min(arr.length, Math.ceil(biggestLen * 0.25),
                                               this._total - this.maxSamples));
            arr.splice(0, chunk);
            this._total -= chunk;
            this._evictions += chunk;
            if (arr.length === 0) { this._byMmsi.delete(biggest); this._lastKeep.delete(biggest); }
        }
    }

    // ── coverage ─────────────────────────────────────────────────────────────
    /** Oldest and newest retained sample times across all vessels. */
    coverage() {
        let lo = Infinity, hi = -Infinity;
        for (const arr of this._byMmsi.values()) {
            if (!arr.length) continue;
            if (arr[0].t < lo) lo = arr[0].t;
            const last = arr[arr.length - 1].t;
            if (last > hi) hi = last;
        }
        return this._total ? { from: lo, to: hi } : null;
    }

    covers(t) {
        const c = this.coverage();
        return !!c && t >= c.from && t <= c.to;
    }

    /** Only claim time-backing when we can actually answer for the current time. */
    isTimeBacked() {
        return !simClock.isLive() && this.covers(simClock.now());
    }

    // ── replay ───────────────────────────────────────────────────────────────
    _tick() {
        if (!this._running) return;
        const live = simClock.isLive();
        const t    = simClock.now();

        if (live || !this.covers(t)) {
            // Nothing truthful to show for this moment — hand the feed back.
            if (this._replaying) {
                this._replaying = false;
                this._ais?.setLivePaused?.(false);
            }
            return;
        }

        // Scrubbed into covered history: mute live so recorded and live traffic
        // don't fight over the same vessels (aisManager already supports this).
        if (!this._replaying) {
            this._replaying = true;
            this._ais?.setLivePaused?.(true);
        }

        // One report per vessel AT sim time, rather than replaying the message
        // stream forward from a cursor. That makes an arbitrary seek O(log n)
        // per vessel and keeps each tick bounded by vessel count.
        for (const [mmsi, arr] of this._byMmsi) {
            const s = sampleAt(arr, t);
            if (s) this._emit(buildReport(mmsi, s));
        }
    }

    _onStop() {
        if (this._replaying) { this._replaying = false; this._ais?.setLivePaused?.(false); }
    }

    // ── introspection (DevTools) ─────────────────────────────────────────────
    stats() {
        const c = this.coverage();
        return {
            vessels: this._byMmsi.size,
            samples: this._total,
            capPct: +((this._total / this.maxSamples) * 100).toFixed(1),
            evicted: this._evictions,
            rejectedTeleports: this._rejected,
            replaying: this._replaying,
            coverageMinutes: c ? +(((c.to - c.from) / 60000).toFixed(1)) : 0,
            approxBytes: this._total * 96,
        };
    }
}

export function initRollingRecorder(aisManager, opts) {
    const r = new RollingRecorder(opts).attach(aisManager);
    if (typeof window !== 'undefined') window.vg1Rolling = r;
    return r;
}
