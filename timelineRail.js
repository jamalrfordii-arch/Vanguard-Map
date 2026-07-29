// timelineRail.js — the bottom bezel rail: sim-clock transport + scrub timeline.
//
// The first REAL bezel region (2026-07-27). Everything else in the bezel is
// still a mockup; this one is wired to the live simClock, so scrubbing it moves
// sun position, terminator, vessel staleness and satellite propagation with it —
// every consumer already reads simClock.now().
//
// WHY THIS ONE FIRST
// ──────────────────
// It is the most useful of the four rails, it is self-contained (simClock
// already has setTime/setRate/pause/step/goLive), and it needs no other rail to
// make sense. If docked chrome turns out to feel wrong, this is the cheapest
// possible thing to have built and thrown away.
//
// PRESENTATION lives in index.html (#time-rail). This module is behaviour only.
//
// TIME WINDOW
// ───────────
// The track spans a fixed 24 h anchored to WALL time — [wallNow-23h, wallNow+1h]
// — not to sim time. An anchor that followed sim time would keep the playhead
// pinned to the centre, which makes scrubbing feel like nothing is happening.
// A wall anchor means the playhead genuinely travels as you scrub, and "now"
// sits at a stable, learnable place near the right edge.
//
// Console: window.vg1Timeline

import { simClock } from './simClock.js';
import { invariantLedger } from './invariants.js';

const HOUR   = 3600_000;
const SPAN   = 24 * HOUR;      // total track width in ms
// NO LOOK-AHEAD. The right edge is wall-now, full stop.
//
// The first cut put the edge 1 h in the future, which was wrong on principle:
// this app's whole posture is that a position you cannot evidence is a position
// you do not draw (see invariants.js — IMPOSSIBLE_SPEED rejects rather than
// flags). Nothing is knowable about the future, so scrubbing there could only
// ever render fiction with the same visual weight as fact. The forward control
// disables at the edge instead of no-opping, so the boundary is legible.
const AHEAD  = 0;
// The SVG viewBox is set to the element's PIXEL width on every paint, so one
// user unit === one CSS pixel. The first cut stretched a fixed 1000-unit viewBox
// with preserveAspectRatio="none", which horizontally distorted the hour labels
// and the playhead triangle — visible immediately on screen, invisible to tests.
const VB_H   = 58;
const AXIS_Y = 34;             // baseline y within the viewBox
const MIN_W  = 200;            // guard: never build geometry against a 0-width rail

// Rates the button cycles through. 0 is reachable via the play/pause button
// instead, so it is deliberately absent here.
const RATES = [1, 10, 60, 300, 1800];

const SVG_NS = 'http://www.w3.org/2000/svg';
function el(name, attrs) {
    const n = document.createElementNS(SVG_NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
}
function pad(n) { return String(n).padStart(2, '0'); }

class TimelineRail {
    /**
     * @param {{aisManager?: object}} deps
     *   aisManager is INJECTED rather than imported: it is a local const in
     *   main.js, not a module singleton, and the dependency policy forbids
     *   adding a new load-bearing window global to reach it. The rail only ever
     *   reads it (hasTimeBackedSource), never mutates it.
     */
    constructor(deps = {}) {
        this._ais   = deps.aisManager || null;
        this.root   = document.getElementById('time-rail');
        this.svg    = document.getElementById('tr-svg');
        this.track  = document.getElementById('tr-track');
        this.clockEl= document.getElementById('tr-clock');
        this.rateEl = document.getElementById('tr-rate');
        this.modeEl = document.getElementById('tr-mode');
        this.playEl = document.getElementById('tr-play');
        this.pauseEl= document.getElementById('tr-pause');
        this.nowEl  = document.getElementById('tr-now');
        this.tzEl   = document.getElementById('tr-tz');

        if (!this.root || !this.svg) {          // markup absent — stay inert
            console.warn('[TimelineRail] #time-rail not found; rail disabled.');
            this.enabled = false;
            return;
        }
        this.enabled  = true;
        this._dragging = false;
        this._lastPaint = 0;
        this._rateIdx = 0;
        this._w = MIN_W;          // live pixel width of the track
        this._tz = this._loadTz();

        this._buildStatic();
        this._bind();
        this.update(true);

        if (typeof window !== 'undefined') window.vg1Timeline = this;
    }

    // ── Time-zone display ────────────────────────────────────────────────────
    // Stored per-browser like the other UI prefs (vg1_cam_damping, watchlist).
    // NOTE this is DISPLAY ONLY — simClock stays epoch-ms and every consumer
    // (sun position, terminator, staleness) is unaffected. Changing the zone
    // must never change what the map draws, only how the readout is spelled.
    _loadTz() {
        try { return localStorage.getItem('vg1_tz') || 'UTC'; } catch (_) { return 'UTC'; }
    }
    _saveTz(tz) {
        this._tz = tz;
        try { localStorage.setItem('vg1_tz', tz); } catch (_) {}
    }
    _formatClock(d) {
        const zone = this._tz === 'local'
            ? Intl.DateTimeFormat().resolvedOptions().timeZone
            : this._tz;
        try {
            return new Intl.DateTimeFormat('en-GB', {
                hour: '2-digit', minute: '2-digit', second: '2-digit',
                hour12: false, timeZone: zone
            }).format(d);
        } catch (_) {
            // Unknown zone (stale localStorage, exotic build) — fall back to UTC
            // rather than throwing inside the animation loop.
            return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
        }
    }

    // ── Window maths ─────────────────────────────────────────────────────────
    _window() {
        const end = Date.now() + AHEAD;     // AHEAD is 0 — the edge IS now
        return { start: end - SPAN, end };
    }

    // Single choke point for every write to sim time. Clamps to "never later
    // than now" so no control — scrub, drag, step, rate drift — can put the
    // playhead into a future the app cannot evidence.
    _setClamped(t) {
        const max = Date.now();
        simClock.setTime(Math.min(t, max));
    }
    _xFor(t) {
        const { start } = this._window();
        return ((t - start) / SPAN) * this._w;
    }
    _timeAt(fracX) {
        const { start } = this._window();
        return start + fracX * SPAN;
    }

    // ── Static furniture: graduations that don't change shape ────────────────
    _buildStatic() {
        const svg = this.svg;
        svg.setAttribute('viewBox', `0 0 ${this._w} ${VB_H}`);

        // baseline — x2 is re-set each paint to the live width
        this._baseline = el('line', {
            x1: 0, y1: AXIS_Y, x2: this._w, y2: AXIS_Y,
            stroke: '#1c2126', 'stroke-width': 2
        });
        svg.appendChild(this._baseline);

        // hour graduations — minor each hour, major every 6
        this._gradG = el('g', {});
        svg.appendChild(this._gradG);

        // elapsed span (start → playhead) drawn under the ticks
        this._elapsed = el('line', {
            x1: 0, y1: AXIS_Y, x2: 0, y2: AXIS_Y,
            stroke: '#39424a', 'stroke-width': 2
        });
        svg.appendChild(this._elapsed);

        // event ticks (invariant violations) live in their own layer
        this._eventG = el('g', {});
        svg.appendChild(this._eventG);

        // hour labels
        this._labelG = el('g', {});
        svg.appendChild(this._labelG);

        // playhead last so it draws on top
        this._headLine = el('line', {
            x1: 0, y1: AXIS_Y - 15, x2: 0, y2: AXIS_Y + 8,
            stroke: '#f4f7fa', 'stroke-width': 1.5
        });
        this._headTri = el('path', { d: 'M0 0', fill: '#f4f7fa' });
        svg.appendChild(this._headLine);
        svg.appendChild(this._headTri);
    }

    // ── Interaction ──────────────────────────────────────────────────────────
    _bind() {
        const scrubTo = (clientX) => {
            const r = this.track.getBoundingClientRect();
            const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
            this._setClamped(this._timeAt(frac));
        };

        this.track.addEventListener('pointerdown', (e) => {
            this._dragging = true;
            this.track.setPointerCapture?.(e.pointerId);
            scrubTo(e.clientX);
            e.preventDefault();
        });
        this.track.addEventListener('pointermove', (e) => {
            if (this._dragging) scrubTo(e.clientX);
        });
        const end = (e) => {
            if (!this._dragging) return;
            this._dragging = false;
            this.track.releasePointerCapture?.(e.pointerId);
        };
        this.track.addEventListener('pointerup', end);
        this.track.addEventListener('pointercancel', end);

        // Play and pause are separate controls, so each does exactly one thing.
        this.playEl.addEventListener('click', () => {
            if (simClock.isPaused()) simClock.resume();
            this.update(true);
        });
        this.pauseEl.addEventListener('click', () => {
            if (!simClock.isPaused()) simClock.pause();
            this.update(true);
        });

        document.getElementById('tr-back').addEventListener('click', () => {
            this._setClamped(simClock.now() - HOUR);
        });

        // Fast-forward to live. Handles BOTH ways of being off-live — scrubbed
        // into the past, or paused at the current moment — because goLive()
        // re-anchors to wall time AND restores rate 1. From the operator's side
        // that is one intent: "stop looking at then, show me now, keep running".
        this.nowEl.addEventListener('click', () => {
            if (this.nowEl.disabled) return;
            simClock.goLive();
            this._rateIdx = 0;
            this.update(true);
        });

        this.rateEl.addEventListener('click', () => {
            this._rateIdx = (this._rateIdx + 1) % RATES.length;
            simClock.setRate(RATES[this._rateIdx]);
            this.update(true);
        });

        this.tzEl.value = this._tz;
        this.tzEl.addEventListener('change', () => {
            this._saveTz(this.tzEl.value);
            this.update(true);
        });

        // simClock is the source of truth; mirror any change made elsewhere
        // (DevTools, directorManager, a scenario replay) back into the rail.
        window.addEventListener('vg1:clockChanged', () => this.update(true));
    }

    // ── Paint ────────────────────────────────────────────────────────────────
    // Called every frame from main.js; throttled internally. The rail shows
    // seconds, so ~4 Hz is plenty and keeps the animation loop cheap.
    update(force = false) {
        if (!this.enabled) return;

        // Visibility gate. NOT offsetParent: #time-rail is position:fixed, and
        // offsetParent is ALWAYS null for fixed elements regardless of whether
        // they are visible — so that check silently made the clock stop ticking
        // (it only advanced when something passed force=true). Found on screen,
        // not in tests.
        //
        // Reading body[data-chrome] is a string compare against the exact
        // attribute the CSS keys off, so it cannot drift from the rendered
        // state — and unlike offsetHeight it forces no layout, which matters
        // because this runs from the animation loop.
        if (!force) {
            const mode = document.body.dataset.chrome;
            if (mode !== 'operate' && mode !== 'inspect') return;
        }

        const nowReal = performance.now();
        if (!force && nowReal - this._lastPaint < 250) return;
        this._lastPaint = nowReal;

        // Track the element's pixel width so one SVG unit === one CSS pixel.
        const wNow = Math.max(MIN_W, Math.round(this.track.clientWidth || MIN_W));
        if (wNow !== this._w) {
            this._w = wNow;
            this.svg.setAttribute('viewBox', `0 0 ${wNow} ${VB_H}`);
            this._baseline.setAttribute('x2', wNow);
        }

        const t     = simClock.now();
        const live  = simClock.isLive();
        const rate  = simClock.rate();
        const paused= simClock.isPaused();
        const d     = new Date(t);

        // readouts
        this.clockEl.textContent = this._formatClock(d);
        this.rateEl.textContent  = paused ? 'HOLD' : (rate >= 60 ? `${rate / 60}×m` : `${rate}×`);

        // Play / pause: whichever state is CURRENT is the lit one. Because they
        // are separate buttons the icons never change, only which is active.
        this.playEl.setAttribute('aria-pressed',  paused ? 'false' : 'true');
        this.pauseEl.setAttribute('aria-pressed', paused ? 'true'  : 'false');

        // Fast-forward is live ONLY when there is something to catch up from:
        // scrubbed into the past, or paused. When already running at wall time
        // it has no destination, so it disables rather than sitting there
        // looking clickable — the boundary is felt in the control.
        this.nowEl.disabled = live && !paused;

        // ── Data-honesty badge ───────────────────────────────────────────────
        // The rail must not imply that scrubbing rewinds the world. It does not:
        // simClock is a time REFERENCE, and only the things that derive from it
        // (sun position, terminator, staleness) actually move. Vessel and
        // aircraft positions come from a live feed with no continuous history,
        // so unless a recorded source is driving them, the past is lighting-only.
        //
        //   LIVE     — wall clock, everything is current and real
        //   REPLAY   — a recorded source is driving entities; the past is real
        //   LIGHTING — scrubbed off-live with no recording: sun is truthful,
        //              vessel positions are NOT. Flagged in the anomaly hue
        //              because a silently-wrong view is the failure mode this
        //              codebase already fights hardest (see invariants.js).
        const replaying = !!this._ais?.hasTimeBackedSource?.();
        const state = live ? 'live' : (replaying ? 'replay' : 'lighting');
        if (this.modeEl.dataset.state !== state) {
            this.modeEl.dataset.state = state;
            this.modeEl.textContent =
                state === 'live'   ? 'LIVE'
              : state === 'replay' ? 'REPLAY'
              :                      'LIGHTING ONLY';
            this.modeEl.title =
                state === 'lighting'
                  ? 'Sun and terminator reflect this time. Vessel and aircraft positions do NOT — '
                    + 'no recording is loaded, so they are still showing live positions.'
                  : state === 'replay'
                  ? 'A recorded source is driving entities, so positions are real for this time.'
                  : 'Attached to wall-clock time.';
        }

        // graduations + labels (rebuilt because the window slides with wall time)
        const { start } = this._window();
        this._gradG.replaceChildren();
        this._labelG.replaceChildren();
        const firstHour = Math.ceil(start / HOUR) * HOUR;
        for (let ht = firstHour; ht <= start + SPAN; ht += HOUR) {
            const x = this._xFor(ht);
            const hh = new Date(ht).getUTCHours();
            const major = hh % 6 === 0;
            this._gradG.appendChild(el('line', {
                x1: x, y1: AXIS_Y, x2: x, y2: AXIS_Y + (major ? 7 : 4),
                stroke: major ? '#242b32' : '#1c2126', 'stroke-width': 1
            }));
            if (major) {
                const tx = el('text', {
                    x, y: AXIS_Y + 19, 'text-anchor': 'middle',
                    'font-family': 'JetBrains Mono, ui-monospace, monospace',
                    'font-size': 7.5, fill: '#3b434b'
                });
                tx.textContent = `${pad(hh)}:00`;
                this._labelG.appendChild(tx);
            }
        }

        // elapsed + playhead
        const hx = Math.max(0, Math.min(this._w, this._xFor(t)));
        this._elapsed.setAttribute('x2', hx);
        this._headLine.setAttribute('x1', hx);
        this._headLine.setAttribute('x2', hx);
        this._headTri.setAttribute('d', `M${hx} ${AXIS_Y - 17} l4 5 -8 0 z`);

        this._paintEvents();
    }

    // Invariant violations, positioned by when we HEARD them (tArrival).
    // Colour follows the palette rule: magenta = anomaly (a rejected report),
    // amber = degraded (a flagged one). Nothing else on the rail is coloured.
    _paintEvents() {
        const { start } = this._window();
        const rows = invariantLedger.recent(60);
        this._eventG.replaceChildren();
        for (const v of rows) {
            const t = v.tArrival;
            if (!(t >= start && t <= start + SPAN)) continue;
            const x = this._xFor(t);
            const reject = v.severity === 'reject';
            this._eventG.appendChild(el('line', {
                x1: x, y1: AXIS_Y - (reject ? 12 : 8), x2: x, y2: AXIS_Y,
                stroke: reject ? '#ff2d6f' : '#ffb020',
                'stroke-width': reject ? 1.4 : 1,
                opacity: reject ? 0.95 : 0.7
            }));
        }
    }
}

export function initTimelineRail(deps) { return new TimelineRail(deps); }
