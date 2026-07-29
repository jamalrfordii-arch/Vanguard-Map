// vesselInstruments.js — drawn readouts for the right dock (selected entity).
//
// Third bezel region's payload. The dock re-homes the existing #vessel-detail
// card; this module adds the part that makes it an INSTRUMENT rather than a
// table: a bearing dial and a speed-within-envelope gauge.
//
// WHY DRAW INSTEAD OF SPELL
// ─────────────────────────
// "HEADING 213°" has to be read and then mentally mapped to a direction. A
// needle pointing south-west is understood pre-attentively. "SPEED 11.4 KTS"
// says nothing about whether 11.4 is fast FOR THIS VESSEL; a mark on its
// envelope answers that without a number at all.
//
// The text rows underneath are deliberately kept. Precision and glanceability
// are different jobs and the dock has room for both.
//
// This module renders only. It never fetches or derives entity state — it is
// handed the same `userData` object uiController is already reading, so the
// dial can never disagree with the text row beside it.
//
// Console: window.vg1VesselInstruments

const SVG_NS = 'http://www.w3.org/2000/svg';

// Speed envelopes by entity kind (knots). Used as the gauge's full-scale, so
// "how fast is this, really" is answerable at a glance.
const ENVELOPE = {
    ship:      { max: 30,   label: '0–30 kn'   },
    aircraft:  { max: 600,  label: '0–600 kn'  },
    satellite: { max: 17500, label: '0–17.5k kn' },
};

function el(name, attrs) {
    const n = document.createElementNS(SVG_NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
}

class VesselInstruments {
    constructor() {
        this.dial   = document.getElementById('vd-dial');
        this.bar    = document.getElementById('vd-spdbar');
        this.hdgBig = document.getElementById('vd-hdg-big');
        this.spdBig = document.getElementById('vd-spd-big');
        this.envEl  = document.getElementById('vd-spd-env');
        this.trace  = document.getElementById('vd-trace');
        this.traceNote = document.getElementById('vd-trace-note');
        this.badge  = document.getElementById('vd-integrity-badge');
        this._rolling = null;   // injected — see setHistorySource()
        this.enabled = !!(this.dial && this.bar);
        if (!this.enabled) {
            console.warn('[VesselInstruments] dock instrument nodes missing; disabled.');
            return;
        }
        this._buildDial();
        this._buildBar();
        if (typeof window !== 'undefined') window.vg1VesselInstruments = this;
    }

    // ── static bezel: graduations that never change ──────────────────────────
    _buildDial() {
        const C = 31, R = 24;
        const g = el('g', {});
        // minor ticks every 30°, major at the cardinals
        for (let a = 0; a < 360; a += 30) {
            const major = a % 90 === 0;
            g.appendChild(el('line', {
                x1: C, y1: C - R - (major ? 6 : 4), x2: C, y2: C - R - 1,
                stroke: major ? '#626c76' : '#3b434b', 'stroke-width': 1,
                transform: `rotate(${a} ${C} ${C})`
            }));
        }
        this.dial.appendChild(g);
        this.dial.appendChild(el('circle', {
            cx: C, cy: C, r: R, fill: 'none', stroke: '#1c2126', 'stroke-width': 1
        }));
        // north index
        this.dial.appendChild(el('path', { d: `M${C} 1.5 l2.2 4 -4.4 0 z`, fill: '#626c76' }));

        // needle group — rotated per update
        this._needle = el('g', {});
        this._needle.appendChild(el('line', {
            x1: C, y1: C, x2: C, y2: C - R + 3, stroke: '#f4f7fa', 'stroke-width': 1.5
        }));
        this._needle.appendChild(el('path', {
            d: `M${C} ${C - R + 1} l2.4 4.4 -4.8 0 z`, fill: '#f4f7fa'
        }));
        this._needle.appendChild(el('line', {
            x1: C, y1: C, x2: C, y2: C + 8, stroke: '#3b434b', 'stroke-width': 1.2
        }));
        this.dial.appendChild(this._needle);
        this.dial.appendChild(el('circle', {
            cx: C, cy: C, r: 1.9, fill: '#0c0f13', stroke: '#626c76', 'stroke-width': 1
        }));
        this._C = C;
    }

    _buildBar() {
        this.bar.appendChild(el('line', {
            x1: 0, y1: 6, x2: 150, y2: 6, stroke: '#1c2126', 'stroke-width': 1.5
        }));
        this._fill = el('rect', { x: 0, y: 5, width: 0, height: 2, fill: '#98a3ad', opacity: 0.75 });
        this.bar.appendChild(this._fill);
        this._mark = el('path', { d: 'M0 0', fill: '#f4f7fa', opacity: 0 });
        this.bar.appendChild(this._mark);
    }

    /**
     * @param {object} ud  the selected entity's userData — the SAME object
     *                     uiController reads, so the dial cannot disagree with
     *                     the text row next to it.
     */
    /** Inject the rolling recorder — the source of per-vessel reporting history. */
    setHistorySource(rolling) { this._rolling = rolling; return this; }

    update(ud) {
        if (!this.enabled || !ud) return;
        this._drawTrace(ud);
        this._styleBadge();

        // ── heading ──────────────────────────────────────────────────────────
        const hdg = ud.headingDeg;
        if (hdg != null && Number.isFinite(hdg)) {
            this._needle.setAttribute('transform', `rotate(${hdg} ${this._C} ${this._C})`);
            this._needle.setAttribute('opacity', '1');
            if (this.hdgBig) this.hdgBig.textContent = `${Math.round(hdg)}°`;
        } else {
            // No heading is a real state (stationary vessel, missing field) and
            // must look different from "heading 000" — hide the needle rather
            // than point it north and imply a bearing that was never reported.
            this._needle.setAttribute('opacity', '0');
            if (this.hdgBig) this.hdgBig.textContent = '—';
        }

        // ── speed ────────────────────────────────────────────────────────────
        const kind = ud.isRealFlight ? 'aircraft' : ud.isRealSatellite ? 'satellite' : 'ship';
        const env  = ENVELOPE[kind];
        let kts = null;
        if (ud.speedKts != null)      kts = ud.speedKts;
        else if (ud.speedKmS != null) kts = ud.speedKmS * 1.944;   // same conversion uiController uses

        if (this.envEl) this.envEl.textContent = env.label;

        if (kts != null && Number.isFinite(kts)) {
            const frac = Math.max(0, Math.min(1, kts / env.max));
            const x    = frac * 150;
            this._fill.setAttribute('width', x.toFixed(1));
            this._mark.setAttribute('d', `M${x.toFixed(1)} 0 l3.2 4.2 -6.4 0 z`);
            this._mark.setAttribute('opacity', '1');
            if (this.spdBig) this.spdBig.textContent = `${kts.toFixed(1)} kn`;
        } else {
            this._fill.setAttribute('width', '0');
            this._mark.setAttribute('opacity', '0');
            if (this.spdBig) this.spdBig.textContent = '—';
        }
    }

    // ── reporting trace ──────────────────────────────────────────────────────
    // The AIS gap as a HOLE in the record, not a text badge.
    //
    // Source is rollingRecorder's per-vessel sample series — the gaps in it ARE
    // the reporting gaps, so nothing new had to be tracked. Two honesty
    // constraints follow from that and are surfaced in the label rather than
    // hidden:
    //   · resolution is bounded by decimation (one sample per 30 s), so this
    //     shows COVERAGE, not every individual report
    //   · the window is only as long as the buffer has been running, so a fresh
    //     session legitimately shows very little
    _drawTrace(ud) {
        if (!this.trace) return;
        const mmsi = String(ud.id ?? '');
        const arr  = this._rolling?._byMmsi?.get(mmsi);
        this.trace.replaceChildren();

        if (!arr || arr.length < 2) {
            if (this.traceNote) this.traceNote.textContent = 'no history yet';
            return;
        }

        const W = 270, H = 30, AXIS = 20;
        const t0 = arr[0].t, t1 = arr[arr.length - 1].t;
        const span = Math.max(1, t1 - t0);
        const x = t => ((t - t0) / span) * W;

        this.trace.appendChild(el('line', {
            x1: 0, y1: AXIS, x2: W, y2: AXIS, stroke: '#1c2126', 'stroke-width': 1
        }));

        // A reporting gap is an ABSOLUTE property of the vessel — it stopped
        // transmitting for a meaningful stretch — not a property of how often we
        // happen to sample. An earlier version used 3× the decimation interval,
        // which meant speeding sampling up for testing reclassified ordinary
        // AIS intervals as gaps: the threshold moved when only the observer had.
        //
        // Floor it at 3 minutes (well beyond normal AIS reporting for even slow
        // vessels), but never below 3× cadence, since we cannot resolve a gap
        // shorter than our own sampling interval and should not pretend to.
        const cadence = this._rolling?.decimateMs ?? 30_000;
        const GAP = Math.max(180_000, cadence * 3);
        let worst = 0;

        for (let i = 0; i < arr.length; i++) {
            this.trace.appendChild(el('rect', {
                x: x(arr[i].t).toFixed(1), y: AXIS - 9, width: 1.6, height: 9,
                fill: '#98a3ad', opacity: 0.9
            }));
            if (i === 0) continue;
            const dt = arr[i].t - arr[i - 1].t;
            if (dt < GAP) continue;
            worst = Math.max(worst, dt);
            const xa = x(arr[i - 1].t), xb = x(arr[i].t);
            this.trace.appendChild(el('rect', {
                x: xa.toFixed(1), y: AXIS - 13, width: Math.max(1, xb - xa).toFixed(1),
                height: 13, fill: 'rgba(255,45,111,0.10)'
            }));
            for (const gx of [xa, xb]) {
                this.trace.appendChild(el('line', {
                    x1: gx.toFixed(1), y1: AXIS - 13, x2: gx.toFixed(1), y2: AXIS,
                    stroke: '#ff2d6f', 'stroke-width': 1
                }));
            }
            this.trace.appendChild(el('line', {
                x1: xa.toFixed(1), y1: AXIS, x2: xb.toFixed(1), y2: AXIS,
                stroke: '#ff2d6f', 'stroke-width': 1.4, 'stroke-dasharray': '3 3'
            }));
        }

        const mins = Math.round(span / 60000);
        if (this.traceNote) {
            this.traceNote.textContent = worst
                ? `gap ${_dur(worst)} · ${mins}m window`
                : `${mins}m window · ${arr.length} fixes`;
            this.traceNote.style.color = worst ? '#ff2d6f' : '';
        }
    }

    // TRUSTED is neutral: a healthy vessel is not news and should not glow.
    // Only degraded states earn a hue, matching the rest of the bezel.
    _styleBadge() {
        if (!this.badge) return;
        const t = (this.badge.textContent || '').toUpperCase();
        this.badge.classList.toggle('vg-bad',  t.includes('SUSPECT'));
        this.badge.classList.toggle('vg-warn', t.includes('QUESTION'));
    }
}

function _dur(ms) {
    const m = Math.round(ms / 60000);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

let _inst = null;
export function vesselInstruments() {
    if (!_inst) _inst = new VesselInstruments();
    return _inst;
}
