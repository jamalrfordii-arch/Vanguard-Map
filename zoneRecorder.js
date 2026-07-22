// zoneRecorder.js — Armed, zone-scoped recording of ship + plane movement.
//
// The existing AISRecorder captures the WHOLE live feed, manually started.
// ZoneRecorder is the aimed version: define a circular zone (lon/lat +
// radius nm) and a sim-time window, ARM it, and it records only the traffic
// inside that zone during that window — both domains, tagged:
//
//   { t, d: 'ais', msg }   — AISStream-shaped message (aisManager tap)
//   { t, d: 'flt', msg }   — raw wire-shaped aircraft state (flightManager tap)
//
// Driven entirely by simClock (never Date.now), so an armed window fires
// correctly even when the clock is scrubbed or running at a rate multiplier.
//
// State machine:  IDLE → ARMED → RECORDING → DONE   (disarm() from any state)
// Emits 'vg1:zoneRecorder' on window at every transition + periodically while
// recording, so UI can react without importing this module (per CLAUDE.md).
//
// Pure module: no THREE, no DOM — node-testable (tests/zoneRecorder.test.mjs).
//
// DevTools quick reference (wired in main.js as window.vg1ZoneRec):
//   vg1ZoneRec.arm({ lat: 26.5, lon: 56.5, radiusNm: 80,
//                    startMs: simClock.now(), endMs: simClock.now() + 30*60000 })
//   vg1ZoneRec.status()    // { state, count, zone, window }
//   vg1ZoneRec.disarm()

import { simClock } from './simClock.js';
import { haversineNm } from './dataSource.js';
import { ZONE_REC } from './config.js';

export const ZR_STATE = Object.freeze({
    IDLE:      'IDLE',
    ARMED:     'ARMED',
    RECORDING: 'RECORDING',
    DONE:      'DONE',
});

export class ZoneRecorder {
    constructor({ maxRecords = ZONE_REC.MAX_RECORDS, tickMs = ZONE_REC.TICK_MS } = {}) {
        this._records = [];
        this._max     = maxRecords;
        this._tickMs  = tickMs;
        this._timer   = null;
        this._zone    = null;  // { lat, lon, radiusNm }
        this._window  = null;  // { startMs, endMs }
        this._label   = null;
        this.state    = ZR_STATE.IDLE;
    }

    // ── Arm / disarm ──────────────────────────────────────────────────────────
    // zone + window are both required. startMs may be in the past (recording
    // begins immediately); endMs must be after startMs.
    arm({ lat, lon, radiusNm = ZONE_REC.DEFAULT_RADIUS_NM, startMs, endMs, label = null }) {
        if (!Number.isFinite(lat) || !Number.isFinite(lon))
            throw new Error('[ZoneRecorder] arm: lat/lon required');
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs)
            throw new Error('[ZoneRecorder] arm: window requires startMs < endMs');
        if (endMs <= simClock.now())
            throw new Error('[ZoneRecorder] arm: window already over in sim time');

        this.disarm();
        this._zone    = { lat, lon, radiusNm };
        this._window  = { startMs, endMs };
        this._label   = label;
        this._records = [];
        this.state    = ZR_STATE.ARMED;
        this._timer   = setInterval(() => this.tick(), this._tickMs);
        this.tick(); // transition immediately if the window is already open
        this._emit();
        return this;
    }

    disarm() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        if (this.state !== ZR_STATE.IDLE) {
            this.state = ZR_STATE.IDLE;
            this._emit();
        }
    }

    // Stop a recording early, KEEPING the capture (→ DONE). Distinct from
    // disarm(), which cancels and discards. No-op unless recording.
    stop() {
        if (this.state !== ZR_STATE.RECORDING) return;
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        this.state = ZR_STATE.DONE;
        this._emit();
    }

    // Reset after a DONE capture has been saved/exported.
    clear() {
        this.disarm();
        this._records = [];
        this._zone    = null;
        this._window  = null;
        this._label   = null;
    }

    // ── State machine (sim-time driven; also callable directly in tests) ─────
    tick() {
        if (this.state !== ZR_STATE.ARMED && this.state !== ZR_STATE.RECORDING) return;
        const now = simClock.now();
        if (this.state === ZR_STATE.ARMED && now >= this._window.startMs) {
            this.state = ZR_STATE.RECORDING;
            this._emit();
        }
        if (this.state === ZR_STATE.RECORDING && now >= this._window.endMs) {
            this.state = ZR_STATE.DONE;
            if (this._timer) { clearInterval(this._timer); this._timer = null; }
            this._emit();
        }
    }

    // ── Taps ──────────────────────────────────────────────────────────────────
    // Chainable: designed to be called from an existing onRawMessage /
    // onRawAircraft handler alongside other taps (see main.js wiring).
    aisTap() {
        return (msg) => {
            if (this.state !== ZR_STATE.RECORDING) return;
            const md = msg && msg.MetaData;
            if (!md || !Number.isFinite(md.latitude) || !Number.isFinite(md.longitude)) return;
            this._push('ais', md.latitude, md.longitude, msg);
        };
    }

    flightTap() {
        return (state) => {
            if (this.state !== ZR_STATE.RECORDING) return;
            if (!state || !Number.isFinite(state.lat) || !Number.isFinite(state.lon)) return;
            this._push('flt', state.lat, state.lon, state);
        };
    }

    _push(domain, lat, lon, msg) {
        if (this._records.length >= this._max) return;
        const z = this._zone;
        if (haversineNm(z.lat, z.lon, lat, lon) > z.radiusNm) return;
        this._records.push({ t: simClock.now(), d: domain, msg });
    }

    // ── Introspection ─────────────────────────────────────────────────────────
    count()  { return this._records.length; }
    counts() {
        let ais = 0, flt = 0;
        for (const r of this._records) (r.d === 'ais' ? ais++ : flt++);
        return { ais, flt };
    }
    status() {
        return { state: this.state, count: this._records.length,
                 zone: this._zone, window: this._window, label: this._label };
    }

    // ── Export / import ───────────────────────────────────────────────────────
    // First line = manifest, rest = records. RecordedAISSource-compatible in
    // shape ({t, msg}) with the extra `d` domain tag ZoneRecordedSource reads.
    toNDJSON() {
        const manifest = {
            type:   'vg1-zone-capture',
            label:  this._label,
            zone:   this._zone,
            window: this._window,
            counts: this.counts(),
        };
        return [JSON.stringify(manifest), ...this._records.map(r => JSON.stringify(r))].join('\n');
    }

    static parseNDJSON(text) {
        const lines = String(text || '').split('\n').filter(l => l.trim());
        if (lines.length === 0) return { manifest: null, records: [] };
        let manifest = null, start = 0;
        const first = JSON.parse(lines[0]);
        if (first && first.type === 'vg1-zone-capture') { manifest = first; start = 1; }
        const records = lines.slice(start).map(l => JSON.parse(l)).sort((a, b) => a.t - b.t);
        return { manifest, records };
    }

    // ── Events ───────────────────────────────────────────────────────────────
    _emit() {
        if (typeof window === 'undefined') return;
        window.dispatchEvent(new CustomEvent('vg1:zoneRecorder', {
            detail: this.status(),
        }));
    }
}
