// hitchRecorder.js — catch frame-time spikes and record what caused them.
//
// WHY (2026-07-24): a 448ms stall was observed live while profiling. Frames that
// long are the largest remaining visible defect in the render loop, and they also
// poison every performance measurement taken with wall-clock frame deltas — an
// attempt to measure the cost of 2× supersampling produced a ±3ms noise floor that
// swamped the signal entirely, purely because of hitches landing inside the sample
// windows. So this module pays for itself twice: it finds the stutter, and it makes
// future timing work possible by letting you exclude or explain the outliers.
//
// DESIGN CONSTRAINT — this runs every frame, so the normal path must be nearly free.
// Per frame it does: one performance.now() subtraction, and one fill of a set of
// PRE-ALLOCATED probe objects (plain number writes, no allocation, no DOM). Snapshot
// diffing, string building and array work happen ONLY on a frame that actually
// hitched. See CLAUDE.md's performance rules — a diagnostic that causes GC pressure
// would manufacture the very thing it is trying to measure.
//
// ATTRIBUTION MODEL. A hitch is a gap between two frames; what we want is what
// happened DURING the gap. So probes are sampled every frame into a ping-pong pair
// of objects, and on a hitch we report the delta between the frame before and the
// frame after. Counters must therefore be CUMULATIVE (monotonic), not per-frame —
// a per-frame counter reset by its owner would read 0 by the time we sample it.
//
// Console: window.vg1Hitch — .list() .summary() .worst() .clear() .setThreshold(ms)

// Frames slower than this are treated as hitches rather than as normal variance.
// 50ms ≈ 20fps — well outside anything the frame loop should produce, and the same
// threshold qualityManager uses to reject a sample as "not steady-state signal".
const DEFAULT_THRESHOLD_MS = 50;
// Ring buffer size. Small on purpose: hitches cluster, and 60 examples is far more
// than anyone reads. Keeping it bounded means this can be left on permanently.
const MAX_HITCHES = 60;

class HitchRecorder {
    constructor() {
        this._threshold = DEFAULT_THRESHOLD_MS;
        this._enabled   = true;
        this._renderer  = null;
        this._lastT     = 0;
        this._frame     = 0;

        // name → { fill, a, b } — `a`/`b` ping-pong so we always hold the previous
        // frame's values alongside the current frame's without allocating.
        this._probes = new Map();
        this._useA   = true;

        this._hitches = [];        // ring buffer
        this._total   = 0;         // hitches seen since load (may exceed buffer)
        this._worstMs = 0;

        // GPU timing (EXT_disjoint_timer_query_webgl2). Optional — absent on many
        // drivers, and Chrome disables it in some configurations. Never required.
        this._gpu = null;

        // Cumulative ms spent INSIDE animate(), from frame() to frameEnd().
        // This is the first question to answer about any stall and the cheapest:
        // if a 500ms gap contains only 4ms of animate(), the blocking work is not
        // in our render loop at all — it is another rAF callback, a browser task,
        // or a GC pause, and instrumenting more managers would be wasted effort.
        this._cumInFrameMs = 0;
        this._frameStart   = 0;
        this.registerProbe('loop', (o) => { o.inFrameMs = Math.round(this._cumInFrameMs); });

        // ── Visibility guard ─────────────────────────────────────────────────
        // A backgrounded tab has rAF throttled or stopped entirely, so the first
        // frame after returning measures a gap that spans the whole hidden period
        // — seconds of "hitch" that never happened to anyone. Left unguarded this
        // does not just add noise, it puts the largest fake entries at the TOP of
        // worst() and summary(), which is the first thing anyone reads.
        //
        // This matters in production (users alt-tab) and it matters doubly under
        // automation: driving this app through a headless/background tab is a
        // known trap in this codebase — see memory/scar-tissue.md 2026-07-21,
        // where exactly this stopped rAF while screenshots still looked live.
        this._skippedHidden = 0;
        this._wasHidden     = false;

        // ── Heap probe — the GC discriminator ────────────────────────────────
        // Chrome-only (`performance.memory`), and deliberately NOT cumulative: a
        // large NEGATIVE delta in usedJSHeapSize across a stalled frame is a major
        // garbage collection, which is the leading explanation for a long stall
        // that moves no other counter. Reported in MB because byte counts at this
        // scale are unreadable. Absent on other browsers — the probe simply does
        // not register, rather than reporting a misleading zero.
        if (typeof performance !== 'undefined' && performance.memory) {
            this.registerProbe('heap', (o) => {
                o.usedMB = Math.round(performance.memory.usedJSHeapSize / 1048576);
            });
        }
        if (typeof document !== 'undefined' && document.addEventListener) {
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') this._wasHidden = true;
            });
        }
    }

    // ── Registration ─────────────────────────────────────────────────────────
    // `fill(out)` must write CUMULATIVE counters onto `out` and allocate nothing.
    //   hitchRecorder.registerProbe('tiles', (o) => { o.built = _totalBuilt; ... });
    registerProbe(name, fill) {
        if (typeof fill !== 'function') return;
        this._probes.set(name, { fill, a: {}, b: {} });
    }

    attachRenderer(renderer) {
        this._renderer = renderer;
        // renderer.info is the single best discriminator available for free:
        //   programs ↑  → shader compilation (a classic hundreds-of-ms stall)
        //   textures ↑  → texture upload
        //   geometries ↑→ buffer upload / geometry construction
        // Registered here rather than in main.js so it can never be forgotten.
        this.registerProbe('renderer', (o) => {
            const i = renderer.info;
            o.programs   = i.programs ? i.programs.length : 0;
            o.geometries = i.memory.geometries;
            o.textures   = i.memory.textures;
            o.calls      = i.render.calls;
        });
        this._initGpuTimer(renderer);
    }

    // ── Per-frame hook — call FIRST in animate() ─────────────────────────────
    frame() {
        if (!this._enabled) return;
        const now = performance.now();
        const dt  = this._lastT ? now - this._lastT : 0;
        this._lastT = now;
        this._frameStart = now;
        this._frame++;

        // Sample every probe into whichever half is "current" this frame.
        const cur = this._useA ? 'a' : 'b';
        const prv = this._useA ? 'b' : 'a';
        for (const p of this._probes.values()) {
            try { p.fill(p[cur]); } catch (_) { /* a broken probe must not break the frame */ }
        }

        // Frame 1 has no previous sample and dt is meaningless — skip.
        if (dt > this._threshold && this._frame > 2) {
            if (this._wasHidden) {
                // This gap spans a period where the tab was backgrounded. It is not
                // a stall; discard it and start measuring cleanly from here.
                this._skippedHidden++;
                this._wasHidden = false;
            } else {
                this._record(dt, cur, prv);
            }
        } else if (this._wasHidden && dt <= this._threshold) {
            // Returned to visible without a long gap — nothing to discard.
            this._wasHidden = false;
        }

        this._useA = !this._useA;
    }

    // Call LAST in animate(). Closes the in-frame timer opened by frame().
    frameEnd() {
        if (!this._enabled || !this._frameStart) return;
        this._cumInFrameMs += performance.now() - this._frameStart;
    }

    _record(dt, cur, prv) {
        this._total++;
        if (dt > this._worstMs) this._worstMs = dt;

        const deltas = {};
        for (const [name, p] of this._probes) {
            const a = p[cur], b = p[prv];
            for (const k of Object.keys(a)) {
                const d = a[k] - (b[k] ?? a[k]);
                // Only report counters that actually MOVED across the gap. A hitch
                // report listing thirty unchanged numbers is noise; the two that
                // changed are the finding.
                if (d) deltas[name + '.' + k] = d;
            }
        }

        // `inFrameMs` is the headline number: how much of this gap our own render
        // loop can account for. The remainder is time the loop was not running —
        // another rAF callback, a browser task, or a GC pause.
        const inFrame  = deltas['loop.inFrameMs'] ?? 0;
        delete deltas['loop.inFrameMs'];

        this._hitches.push({
            frame:      this._frame,
            atSec:      +(performance.now() / 1000).toFixed(1),
            ms:         +dt.toFixed(1),
            inFrameMs:  inFrame,
            outsideMs:  +(dt - inFrame).toFixed(1),
            gpuMs:      this._gpu ? this._gpu.lastMs : null,
            changed:    deltas,
        });
        if (this._hitches.length > MAX_HITCHES) this._hitches.shift();
    }

    // ── GPU timing ───────────────────────────────────────────────────────────
    // Wall-clock frame deltas cannot separate "the GPU was slow" from "JS blocked
    // the loop". A timer query can. Results are asynchronous (available a few
    // frames later), so this reports the most recent COMPLETED measurement, not
    // the current frame's — fine for spotting sustained GPU cost, not for
    // attributing one specific spike.
    _initGpuTimer(renderer) {
        try {
            const gl  = renderer.getContext();
            const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
            if (!ext) return;
            this._gpu = { gl, ext, query: null, pending: null, lastMs: null };
        } catch (_) { this._gpu = null; }
    }

    beginGpu() {
        const g = this._gpu;
        if (!g || g.pending) return;              // one in flight at a time
        try {
            g.query = g.gl.createQuery();
            g.gl.beginQuery(g.ext.TIME_ELAPSED_EXT, g.query);
        } catch (_) { g.query = null; }
    }

    endGpu() {
        const g = this._gpu;
        if (!g) return;
        try {
            if (g.query) {
                g.gl.endQuery(g.ext.TIME_ELAPSED_EXT);
                g.pending = g.query;
                g.query   = null;
            }
            if (g.pending) {
                const available = g.gl.getQueryParameter(g.pending, g.gl.QUERY_RESULT_AVAILABLE);
                const disjoint  = g.gl.getParameter(g.ext.GPU_DISJOINT_EXT);
                if (available) {
                    // Disjoint means the GPU was interrupted and the timing is
                    // garbage — discard rather than report a number we don't trust.
                    if (!disjoint) {
                        g.lastMs = +(g.gl.getQueryParameter(g.pending, g.gl.QUERY_RESULT) / 1e6).toFixed(2);
                    }
                    g.gl.deleteQuery(g.pending);
                    g.pending = null;
                }
            }
        } catch (_) { /* driver quirks must never break the frame */ }
    }

    gpuMs() { return this._gpu ? this._gpu.lastMs : null; }

    // ── Console API ──────────────────────────────────────────────────────────
    list()  { return this._hitches.slice(); }
    worst() {
        let w = null;
        for (const h of this._hitches) if (!w || h.ms > w.ms) w = h;
        return w;
    }
    clear() {
        this._hitches.length = 0; this._total = 0; this._worstMs = 0;
        this._skippedHidden = 0;
        // Do NOT clear _wasHidden: if the tab is backgrounded right now, the gap
        // still to come must be discarded even though the buffer was just reset.
    }
    setThreshold(ms) { this._threshold = Math.max(1, +ms || DEFAULT_THRESHOLD_MS); }
    setEnabled(on)   { this._enabled = !!on; }

    // Groups hitches by which counters moved, so a repeated cause shows up as one
    // line with a count rather than forty individual records to read through.
    summary() {
        const byCause = new Map();
        let sumIn = 0, sumOut = 0;
        for (const h of this._hitches) {
            const key = Object.keys(h.changed).sort().join(' + ') || '(nothing moved)';
            const e = byCause.get(key) || { count: 0, totalMs: 0, worstMs: 0, inMs: 0 };
            e.count++; e.totalMs += h.ms; e.inMs += (h.inFrameMs ?? 0);
            if (h.ms > e.worstMs) e.worstMs = h.ms;
            byCause.set(key, e);
            sumIn  += (h.inFrameMs ?? 0);
            sumOut += (h.outsideMs ?? 0);
        }
        const rows = [...byCause.entries()]
            .map(([cause, e]) => ({ cause, count: e.count, worstMs: +e.worstMs.toFixed(1),
                                    avgMs: +(e.totalMs / e.count).toFixed(1),
                                    avgInFrameMs: +(e.inMs / e.count).toFixed(1) }))
            .sort((x, y) => y.worstMs - x.worstMs);
        return { totalHitches: this._total, held: this._hitches.length,
                 worstMs: +this._worstMs.toFixed(1), thresholdMs: this._threshold,
                 gpuTimingAvailable: !!this._gpu,
                 // Non-zero means the tab was backgrounded during the sample
                 // window. Those gaps were discarded, but a run with many of them
                 // is not a clean sample of anything — re-run it foregrounded.
                 discardedWhileHidden: this._skippedHidden,
                 // If insideOurLoopMs is small next to outsideOurLoopMs, the render
                 // loop is not what is stalling and manager-level instrumentation
                 // will not find it.
                 insideOurLoopMs:  +sumIn.toFixed(1),
                 outsideOurLoopMs: +sumOut.toFixed(1),
                 byCause: rows };
    }
}

export const hitchRecorder = new HitchRecorder();
if (typeof window !== 'undefined') window.vg1Hitch = hitchRecorder;
