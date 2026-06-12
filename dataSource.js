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

function haversineNm(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * DEG2RAD;
    const dLon = (lon2 - lon1) * DEG2RAD;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_NM * Math.asin(Math.sqrt(a));
}

function bearingDeg(lat1, lon1, lat2, lon2) {
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
            PositionReport: { Sog: sog, Cog: cog, TrueHeading: cog }
        }
    };
}

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
//      ]
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

    // Precompute cumulative leg times (s from scenario start) per entity.
    _buildLegs(e) {
        const wps = e.waypoints || [];
        if (wps.length === 0) return [];
        const legs = [{ ...wps[0], t: wps[0].t ?? 0 }];
        for (let i = 1; i < wps.length; i++) {
            const prev = legs[i - 1];
            const wp   = wps[i];
            let t = wp.t;
            if (t == null) {
                const nm    = haversineNm(prev.lat, prev.lon, wp.lat, wp.lon);
                const hours = nm / Math.max(0.1, e.speedKts ?? 12);
                t = prev.t + hours * 3600;
            }
            legs.push({ ...wp, t });
        }
        return legs;
    }

    _tick() {
        const elapsedS = (simClock.now() - this._t0) / 1000;
        if (elapsedS < 0) return; // scenario hasn't started yet in sim time

        for (const e of this._entities) {
            const legs = e._legs;
            if (legs.length === 0) continue;

            const totalT = legs[legs.length - 1].t;
            let t = elapsedS;
            if (e.loop && totalT > 0) t = elapsedS % totalT;
            else if (t > totalT)      t = totalT; // hold at final waypoint

            // Dark windows — vessel exists but stops transmitting.
            const dark = (e.dark || []).some(w => t >= w.from && t <= w.to);
            if (dark) continue;

            // Find active leg
            let i = 0;
            while (i < legs.length - 1 && legs[i + 1].t < t) i++;
            const a = legs[i];
            const b = legs[Math.min(i + 1, legs.length - 1)];

            let lat, lon, cog, sog;
            if (a === b || b.t === a.t) {
                lat = b.lat; lon = b.lon; cog = e.headingDeg ?? 0; sog = 0;
            } else {
                const f  = (t - a.t) / (b.t - a.t);
                lat = a.lat + (b.lat - a.lat) * f;
                lon = a.lon + (b.lon - a.lon) * f;
                cog = bearingDeg(a.lat, a.lon, b.lat, b.lon);
                sog = haversineNm(a.lat, a.lon, b.lat, b.lon) / ((b.t - a.t) / 3600);
            }

            this._emit(makePositionReport(e, lat, lon, Math.round(sog), Math.round(cog)));
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

// ── CompositeSource ───────────────────────────────────────────────────────────
// Live world + injected synthetic events, or several scenarios at once.
export class CompositeSource extends DataSource {
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
