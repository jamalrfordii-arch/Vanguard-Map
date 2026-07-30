// dataSource.js — Pluggable data sources for VANGUARD1 entity feeds.
//
// A DataSource emits AISStream-shaped messages into a sink (normally
// aisManager.ingest). The manager cannot tell live, recorded, and
// synthetic traffic apart — dark detection, trails, wakes, anomaly
// detection, and the copilot all work identically on every source.
//
//   LiveSource       → the existing WebSocket inside aisManager (unchanged)
//   SyntheticAISSource → scripted vessels from a scenario object/JSON
//   RecordedAISSource  → replays an NDJSON capture against simClock time
//   CompositeSource    → merges any of the above
//   AISRecorder        → taps the live feed and exports NDJSON for replay
//
// All sources are driven by simClock, so pausing/scrubbing/fast-forward
// affects synthetic and recorded traffic automatically.
//
// DevTools quick reference (wired in main.js):
//   vg1Scenario.load('./scenarios/hormuz-demo.json')
//   vg1Scenario.record()   // start capturing live AIS
//   vg1Scenario.save()     // download capture as NDJSON
//   vg1Scenario.replay('./captures/some-capture.ndjson')
//   vg1Scenario.stopAll()

import { simClock } from './simClock.js';
import { SIM } from './config.js';

// ── Geo helpers (pure math, no THREE) ────────────────────────────────────────
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const EARTH_NM = 3440.065; // Earth radius in nautical miles

export function haversineNm(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * DEG2RAD;
    const dLon = (lon2 - lon1) * DEG2RAD;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_NM * Math.asin(Math.sqrt(a));
}

export function bearingDeg(lat1, lon1, lat2, lon2) {
    const y = Math.sin((lon2 - lon1) * DEG2RAD) * Math.cos(lat2 * DEG2RAD);
    const x = Math.cos(lat1 * DEG2RAD) * Math.sin(lat2 * DEG2RAD) -
              Math.sin(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.cos((lon2 - lon1) * DEG2RAD);
    return (Math.atan2(y, x) * RAD2DEG + 360) % 360;
}

// Build an AISStream-shaped PositionReport so sources are indistinguishable
// from the live WebSocket feed inside aisManager._handleMsg.
function makePositionReport(e, lat, lon, sog, cog) {
    return {
        MessageType: 'PositionReport',
        MetaData: {
            MMSI:      e.mmsi,
            ShipName:  e.name || 'UNKNOWN',
            ShipType:  e.shipType ?? 70,
            latitude:  lat,
            longitude: lon,
            // Dual timestamps: event time in ISO, parsed by invariants.parseEventTime.
            time_utc:  new Date(simClock.now()).toISOString(),
        },
        Message: {
            PositionReport: {
                Sog: sog, Cog: cog, TrueHeading: cog,
                // Scenario-declared navigational status (0 = under way using
                // engine, 1 = at anchor, …). Lets a scenario script a vessel that
                // is legitimately stopped, which Enhanced Monitoring must NOT
                // raise a schedule alarm on — docs/STM_ROUTE_SPEC.md §5.6.
                // Omitted → the field is absent, exactly as it is from most real
                // AIS reports, so the default path stays honest.
                ...(e.navStatus != null ? { NavigationalStatus: e.navStatus } : {}),
            }
        }
    };
}

/**
 * Great-circle destination: the point reached from (lat, lon) by steering
 * `brgDeg` for `distNm`. The inverse of haversineNm/bearingDeg above, kept here
 * beside them so the geodesy primitives stay in one place.
 *
 * routeGeometry.js imports FROM this module, never the other way round —
 * dataSource is the bottom of the geodesy stack and must stay that way, or the
 * two form an import cycle (CLAUDE.md's dependency policy forbids one).
 */
export function destinationPoint(lat, lon, brgDeg, distNm) {
    const d = distNm / EARTH_NM;
    const p1 = lat * DEG2RAD, brg = brgDeg * DEG2RAD;
    const sinP1 = Math.sin(p1), cosP1 = Math.cos(p1);
    const sinD = Math.sin(d), cosD = Math.cos(d);
    const p2 = Math.asin(sinP1 * cosD + cosP1 * sinD * Math.cos(brg));
    const l2 = lon * DEG2RAD + Math.atan2(Math.sin(brg) * sinD * cosP1,
                                          cosD - sinP1 * Math.sin(p2));
    return { lat: p2 * RAD2DEG, lon: (((l2 * RAD2DEG) + 540) % 360) - 180 };
}

// AIS transmits SOG in 0.1-knot steps and COG in 0.1-degree steps. Synthetic
// sources used to emit Math.round(sog) / Math.round(cog) — whole units — which
// is COARSER than real AIS and silently degraded every scenario-driven test of
// anything speed- or course-derived (a projected ETA, a drift angle). Emitting
// at the real transmitted resolution makes synthetic traffic properly
// indistinguishable from live, which is the whole promise of this module.
const aisSog = (v) => Math.round(v * 10) / 10;
const aisCog = (v) => Math.round((((v % 360) + 360) % 360) * 10) / 10;

// Default along-track distance over which a scripted STM deviation ramps in.
// Long enough that the sideways rate stays a plausible set-and-drift excursion
// rather than a teleport the invariant gate would reject. See _deviationAt().
const DEVIATION_DEFAULT_RAMP_NM = 2;

// ── Base class ────────────────────────────────────────────────────────────────
export class DataSource {
    constructor() {
        this._sink    = null;
        this._running = false;
        this._timer   = null;
    }

    start(sink) {
        if (this._running) return;
        this._sink    = sink;
        this._running = true;
        this._onStart();
        this._timer = setInterval(() => this._tick(), SIM.SOURCE_TICK_MS);
        this._tick(); // emit immediately so entities appear without delay
    }

    stop() {
        if (!this._running) return;
        this._running = false;
        clearInterval(this._timer);
        this._timer = null;
        this._onStop();
    }

    _emit(msg) { if (this._running && this._sink) this._sink(msg); }

    // Subclass hooks
    _onStart() {}
    _onStop()  {}
    _tick()    {}

    /**
     * Does this source carry REAL timestamps for the positions it emits?
     *
     * i.e. if the sim clock is scrubbed to time T, can this source say where its
     * entities actually were at T — or does it only ever emit "now"?
     *
     * The timeline rail uses this to tell the operator the truth about what they
     * are looking at. Scrubbing into the past always moves the sun and the
     * terminator (they are computed from simClock), but vessel positions only
     * follow if something recorded them. Without this flag the rail would imply
     * the whole world rewound, which is the same class of quiet falsehood
     * invariants.js exists to prevent.
     *
     * Default false: a live or synthetic feed only knows the present.
     */
    isTimeBacked() { return false; }
}

// ── SyntheticAISSource ────────────────────────────────────────────────────────
// Scenario format (JSON-friendly):
// {
//   "name":      "Hormuz demo",
//   "startTime": "2026-06-12T06:00:00Z",   // optional; default = sim time at start()
//   "entities": [{
//      "mmsi":     "999000001",
//      "name":     "SYN TANKER ALPHA",
//      "shipType": 80,                      // ITU type → class mapping in aisManager
//      "speedKts": 14,                      // used when waypoints lack explicit "t"
//      "loop":     false,
//      "dark":     [{ "from": 600, "to": 1500 }],   // seconds from scenario start —
//                                                   // vessel stops transmitting (tests
//                                                   // dark-vessel detection end to end)
//      "waypoints": [
//         { "lon": 56.4, "lat": 26.6 },
//         { "lon": 56.9, "lat": 26.2, "t": 3600 }   // optional explicit time (s)
//      ],
//
//      // ── STM route plan (optional) ────────────────────────────────────────
//      // Declares that this vessel SHARES a voyage plan. scenarioRoute.js turns
//      // the waypoints above into a canonical VoyagePlan / RTZ document, and
//      // enhancedMonitor then measures the vessel against it. Closed loop, no
//      // network: the ship follows the plan, `deviate` pushes it off, the
//      // monitor fires.
//      "stmRoute": {
//         "routeName":      "HORMUZ OUTBOUND",
//         "xtdNm":          0.2,      // symmetric corridor; or set both sides:
//         "portsideXtdNm":  0.15,     //   asymmetric, as real routes usually are
//         "starboardXtdNm": 0.30,
//         "safetyDepth":    15,       // metres
//         "speedMin":       8,
//         "speedMax":       14,
//         "geometryType":   "Loxodrome",
//         "routeStatus":    7,        // 7 = used for monitoring (loaded in ECDIS)
//
//         // Push the SHIP off the PLAN. The plan itself is always built from the
//         // clean waypoints — a deviation is the vessel failing to follow its
//         // declared route, never a change to what it declared.
//         "deviate": { "fromWpIndex": 2, "offsetNm": 0.8, "rampNm": 2, "side": "starboard" }
//      }
//   }]
// }
//
// Positions are linearly interpolated in lon/lat between waypoints — fine for
// regional scenarios; long ocean legs should use more waypoints.
export class SyntheticAISSource extends DataSource {
    constructor(scenario) {
        super();
        this.scenario  = scenario;
        this._t0       = null; // scenario start, sim epoch ms
        this._entities = [];
    }

    _onStart() {
        this._t0 = this.scenario.startTime
            ? Date.parse(this.scenario.startTime)
            : simClock.now();
        this._entities = (this.scenario.entities || []).map(e => ({
            ...e,
            _legs: this._buildLegs(e)
        }));
    }

    // Precompute cumulative leg times (s from scenario start) per entity, plus
    // cumulative along-route distance (`d`, nm from the first waypoint) which
    // the STM deviation ramp needs to know how far the ship has run.
    _buildLegs(e) {
        const wps = e.waypoints || [];
        if (wps.length === 0) return [];
        const legs = [{ ...wps[0], t: wps[0].t ?? 0, d: 0 }];
        for (let i = 1; i < wps.length; i++) {
            const prev = legs[i - 1];
            const wp   = wps[i];
            const nm   = haversineNm(prev.lat, prev.lon, wp.lat, wp.lon);
            let t = wp.t;
            if (t == null) {
                const hours = nm / Math.max(0.1, e.speedKts ?? 12);
                t = prev.t + hours * 3600;
            }
            legs.push({ ...wp, t, d: prev.d + nm });
        }
        return legs;
    }

    /**
     * Displace a clean on-plan position off the route axis, for scenarios that
     * script a deviation.
     *
     * THE OFFSET MUST RAMP IN. A step change of, say, 0.8 nm between two
     * consecutive reports is a sideways teleport: over a short reporting
     * interval the implied speed is enormous, invariants.js rejects the report
     * as IMPOSSIBLE_SPEED, and the vessel never moves — so the deviation the
     * scenario is trying to stage never reaches the monitor at all. Ramping over
     * `rampNm` of along-track distance is both what a real set-and-drift
     * excursion looks like and what keeps the report physically admissible.
     *
     * Returns null when no deviation applies at this point on the route.
     */
    _deviationAt(e, legIndex, alongNm, cog) {
        const dev = e.stmRoute?.deviate;
        if (!dev || !(dev.offsetNm > 0)) return null;

        const legs = e._legs;
        const fromIdx = Math.max(0, Math.min(dev.fromWpIndex ?? 0, legs.length - 1));
        if (legIndex < fromIdx) return null;

        const startD = legs[fromIdx].d;
        const run = alongNm - startD;
        if (run <= 0) return null;

        const ramp = dev.rampNm ?? DEVIATION_DEFAULT_RAMP_NM;
        const frac = ramp > 0 ? Math.min(1, run / ramp) : 1;
        const offset = dev.offsetNm * frac;
        // Starboard is 90° right of the course made good; port is 90° left.
        const bearing = cog + (String(dev.side ?? 'starboard').toLowerCase() === 'port' ? -90 : 90);
        return { offset, bearing };
    }

    _tick() {
        const elapsedS = (simClock.now() - this._t0) / 1000;
        if (elapsedS < 0) return; // scenario hasn't started yet in sim time

        for (const e of this._entities) {
            const legs = e._legs;
            if (legs.length === 0) continue;

            const totalT = legs[legs.length - 1].t;
            let t = elapsedS;
            let holding = false;
            if (e.loop && totalT > 0) t = elapsedS % totalT;
            else if (t > totalT)    { t = totalT; holding = true; } // hold at final waypoint

            // Dark windows — vessel exists but stops transmitting.
            const dark = (e.dark || []).some(w => t >= w.from && t <= w.to);
            if (dark) continue;

            // Find active leg
            let i = 0;
            while (i < legs.length - 1 && legs[i + 1].t < t) i++;
            const a = legs[i];
            const b = legs[Math.min(i + 1, legs.length - 1)];

            let lat, lon, cog, sog, alongNm;
            if (a === b || b.t === a.t) {
                lat = b.lat; lon = b.lon; cog = e.headingDeg ?? 0; sog = 0;
                alongNm = b.d ?? 0;
            } else {
                const f  = (t - a.t) / (b.t - a.t);
                lat = a.lat + (b.lat - a.lat) * f;
                lon = a.lon + (b.lon - a.lon) * f;
                cog = bearingDeg(a.lat, a.lon, b.lat, b.lon);
                sog = haversineNm(a.lat, a.lon, b.lat, b.lon) / ((b.t - a.t) / 3600);
                alongNm = (a.d ?? 0) + ((b.d ?? 0) - (a.d ?? 0)) * f;
            }

            // ── STM deviation ────────────────────────────────────────────────
            // Applied to the SHIP, never to the plan. While it is ramping the
            // vessel is crabbing sideways, so course and speed over ground are
            // derived from the ACTUAL displacement rather than from the leg
            // geometry — otherwise the emitted COG would say "straight down the
            // route" while the positions said otherwise, which is precisely the
            // set-and-drift signal this whole feature exists to exercise.
            const dev = this._deviationAt(e, i, alongNm, cog);
            if (dev) {
                const moved = destinationPoint(lat, lon, dev.bearing, dev.offset);
                const prev = e._lastEmit;
                lat = moved.lat; lon = moved.lon;
                if (prev && t > prev.t) {
                    const dtH = (t - prev.t) / 3600;
                    const gone = haversineNm(prev.lat, prev.lon, lat, lon);
                    if (dtH > 0 && gone > 0) {
                        sog = gone / dtH;
                        cog = bearingDeg(prev.lat, prev.lon, lat, lon);
                    }
                }
            }
            e._lastEmit = { lat, lon, t };

            // A vessel HOLDING at its final waypoint is not moving, so it must
            // not keep reporting way-on speed. It used to: the leg-derived SOG
            // stayed at the transit speed forever because t clamps to totalT
            // while f stays at 1, so a stationary ship broadcast 12.4 kn
            // indefinitely. Downstream that is not cosmetic — it is a false
            // statement about the vessel, and any consumer reasoning about
            // arrival or dwell inherits it.
            if (holding) { sog = 0; cog = e.headingDeg ?? cog; }

            this._emit(makePositionReport(e, lat, lon, aisSog(sog), aisCog(cog)));
        }
    }
}

// ── RecordedAISSource ─────────────────────────────────────────────────────────
// Replays a capture against simClock. Records are { t: epochMs, msg: {...} },
// one JSON object per line (NDJSON), sorted by t ascending.
// Typical use: simClock.setTime(captureStart); replay source emits each
// message when sim time passes its timestamp. Scrubbing backwards rewinds
// the cursor and replays forward from the new position.
export class RecordedAISSource extends DataSource {
    // Replays stored records with their original timestamps.
    isTimeBacked() { return true; }

    constructor(records) {
        super();
        this._records  = records; // [{t, msg}], sorted
        this._cursor   = 0;
        this._lastSim  = null;
    }

    static async fromURL(url) {
        const res  = await fetch(url);
        if (!res.ok) throw new Error(`[RecordedAISSource] fetch failed: ${res.status}`);
        const text = await res.text();
        const records = text.split('\n')
            .filter(l => l.trim())
            .map(l => JSON.parse(l))
            .sort((x, y) => x.t - y.t);
        return new RecordedAISSource(records);
    }

    firstTimestamp() { return this._records.length ? this._records[0].t : null; }
    lastTimestamp()  { return this._records.length ? this._records[this._records.length - 1].t : null; }

    _onStart() {
        this._lastSim = simClock.now();
        this._seek(this._lastSim);
    }

    _seek(simMs) {
        let lo = 0, hi = this._records.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (this._records[mid].t < simMs) lo = mid + 1; else hi = mid;
        }
        this._cursor = lo;
    }

    _tick() {
        const now = simClock.now();
        if (now < this._lastSim) this._seek(now); // scrubbed backwards
        while (this._cursor < this._records.length && this._records[this._cursor].t <= now) {
            this._emit(this._records[this._cursor].msg);
            this._cursor++;
        }
        this._lastSim = now;
    }
}

// ── ZoneRecordedSource ────────────────────────────────────────────────────────
// Replays a mixed ship+plane zone capture (zoneRecorder.js) against simClock.
// Records are { t, d: 'ais'|'flt', msg }, sorted by t ascending.
//
// AIS records flow through the normal DataSource sink (attach via
// aisManager.attachSource, downstream identical to any other source).
// Flight records are batched per tick and handed to `flightSink` as a
// wire-shaped states array — wire it to flightManager.ingest in main.js.
// Scrubbing backwards rewinds the cursor, same contract as RecordedAISSource.
export class ZoneRecordedSource extends DataSource {
    // Mixed ship+plane zone capture — records carry their own event times.
    isTimeBacked() { return true; }

    constructor(records, { flightSink = null } = {}) {
        super();
        this._records    = records; // [{t, d, msg}], sorted
        this._flightSink = flightSink;
        this._cursor     = 0;
        this._lastSim    = null;
    }

    firstTimestamp() { return this._records.length ? this._records[0].t : null; }
    lastTimestamp()  { return this._records.length ? this._records[this._records.length - 1].t : null; }

    _onStart() {
        this._lastSim = simClock.now();
        this._seek(this._lastSim);
    }

    _seek(simMs) {
        let lo = 0, hi = this._records.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (this._records[mid].t < simMs) lo = mid + 1; else hi = mid;
        }
        this._cursor = lo;
    }

    _tick() {
        const now = simClock.now();
        if (now < this._lastSim) this._seek(now); // scrubbed backwards
        const flightBatch = [];
        while (this._cursor < this._records.length && this._records[this._cursor].t <= now) {
            const r = this._records[this._cursor++];
            if (r.d === 'flt') flightBatch.push(r.msg);
            else               this._emit(r.msg);
        }
        if (flightBatch.length && this._flightSink && this._running) {
            this._flightSink(flightBatch);
        }
        this._lastSim = now;
    }
}

// ── CompositeSource ───────────────────────────────────────────────────────────
// Live world + injected synthetic events, or several scenarios at once.
export class CompositeSource extends DataSource {
    // Time-backed iff ANY child is: one recorded stream is enough for the
    // scrubbed past to be partially real, and the rail says so.
    isTimeBacked() {
        return (this._sources || []).some(s => s.isTimeBacked?.());
    }

    constructor(sources) {
        super();
        this._sources = sources || [];
    }
    add(source) {
        this._sources.push(source);
        if (this._running) source.start(this._sink);
    }
    _onStart() { this._sources.forEach(s => s.start(this._sink)); }
    _onStop()  { this._sources.forEach(s => s.stop()); }
    _tick()    {} // children drive themselves
}

// ── AISRecorder ───────────────────────────────────────────────────────────────
// Assign to aisManager.onRawMessage to capture the live feed; export NDJSON
// that RecordedAISSource can replay. Capped to avoid unbounded memory.
export class AISRecorder {
    constructor(maxRecords = SIM.RECORDER_MAX) {
        this._records = [];
        this._max     = maxRecords;
        this.active   = false;
    }

    tap() {
        return (msg) => {
            if (!this.active || this._records.length >= this._max) return;
            this._records.push({ t: simClock.now(), msg });
        };
    }

    start() { this.active = true;  }
    stop()  { this.active = false; }
    clear() { this._records = []; }
    count() { return this._records.length; }

    toNDJSON() { return this._records.map(r => JSON.stringify(r)).join('\n'); }

    // Trigger a browser download of the capture.
    download(filename) {
        const name = filename || `ais-capture-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`;
        const blob = new Blob([this.toNDJSON()], { type: 'application/x-ndjson' });
        const a    = document.createElement('a');
        a.href     = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        URL.revokeObjectURL(a.href);
    }
}
