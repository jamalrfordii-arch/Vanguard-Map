// topRail.js — the top bezel rail: global theatre state.
//
// Second real bezel region (2026-07-27). Replaces the twelve-row status readout
// that lived in #ui-layer's HUD panel.
//
// WHAT THIS MODULE DOES NOT DO
// ────────────────────────────
// It does NOT populate the feed counts, statuses, GPU label or node count. Those
// elements were MOVED out of #ui-layer with their IDs intact, and their existing
// writers — aisManager, flightManager, terrainBuilder, submarineCables,
// uiController, main.js — keep writing to them by getElementById exactly as
// before. Re-plumbing all six through a new module would have been a much larger
// change with nothing to show for it.
//
// So this module owns only the two things that are genuinely NEW presentation:
//
//   1. the frame-time sparkline — a number cannot show you a hitch
//   2. the dark-vessel alarm state — the one number up here that means trouble
//
// Console: window.vg1TopRail

const SPARK_N = 32;          // samples retained
const SPARK_W = 64;          // svg user units (viewBox is fixed, element is 64px)
const SPARK_H = 16;
const SVG_NS  = 'http://www.w3.org/2000/svg';

class TopRail {
    constructor() {
        this.svg      = document.getElementById('top-spark');
        this.darkEl   = document.getElementById('dark-vessel-count');
        this.enabled  = !!this.svg;
        if (!this.enabled) {
            console.warn('[TopRail] #top-spark not found; sparkline disabled.');
            return;
        }
        this._ms      = [];          // ring of recent frame times (ms)
        this._lastDraw = 0;

        this._line = document.createElementNS(SVG_NS, 'polyline');
        this._line.setAttribute('fill', 'none');
        this._line.setAttribute('stroke', '#98a3ad');
        this._line.setAttribute('stroke-width', '1');
        this.svg.appendChild(this._line);

        // Worst sample in the window, marked so a stall is findable at a glance.
        this._peak = document.createElementNS(SVG_NS, 'circle');
        this._peak.setAttribute('r', '1.6');
        this._peak.setAttribute('fill', '#ffb020');
        this._peak.setAttribute('opacity', '0');
        this.svg.appendChild(this._peak);

        if (typeof window !== 'undefined') window.vg1TopRail = this;
    }

    /** Push one frame time (ms). Called from main.js's per-second FPS block. */
    sample(ms) {
        if (!this.enabled || !(ms > 0)) return;
        this._ms.push(ms);
        if (this._ms.length > SPARK_N) this._ms.shift();
    }

    /**
     * Repaint. Self-throttled and mode-gated.
     *
     * The visibility gate reads body[data-chrome] rather than offsetParent —
     * #top-rail is position:fixed, and offsetParent is ALWAYS null for fixed
     * elements, which silently froze the timeline rail the first time round.
     */
    update(force = false) {
        if (!this.enabled) return;
        if (!force) {
            const mode = document.body.dataset.chrome;
            if (mode !== 'operate' && mode !== 'inspect') return;
        }
        const now = performance.now();
        if (!force && now - this._lastDraw < 500) return;
        this._lastDraw = now;

        this._drawSpark();
        this._updateDark();
    }

    _drawSpark() {
        const n = this._ms.length;
        if (n < 2) { this._line.setAttribute('points', ''); this._peak.setAttribute('opacity', '0'); return; }

        // Scale against a fixed 50ms ceiling rather than the window max, so the
        // line's HEIGHT means the same thing frame to frame. Auto-scaling would
        // make a calm stretch look identical to a bad one — the classic
        // sparkline lie.
        const CEIL = 50;
        const pts = [];
        let worstI = 0, worstV = -1;
        for (let i = 0; i < n; i++) {
            const v = this._ms[i];
            if (v > worstV) { worstV = v; worstI = i; }
            const x = (i / (SPARK_N - 1)) * SPARK_W;
            const y = SPARK_H - Math.min(1, v / CEIL) * (SPARK_H - 2) - 1;
            pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
        }
        this._line.setAttribute('points', pts.join(' '));

        // Flag the peak only when it is actually bad (worse than ~30fps).
        if (worstV > 33) {
            const x = (worstI / (SPARK_N - 1)) * SPARK_W;
            const y = SPARK_H - Math.min(1, worstV / CEIL) * (SPARK_H - 2) - 1;
            this._peak.setAttribute('cx', x.toFixed(1));
            this._peak.setAttribute('cy', y.toFixed(1));
            this._peak.setAttribute('opacity', '1');
        } else {
            this._peak.setAttribute('opacity', '0');
        }
    }

    // Dark vessels is the one number in this rail that means something is wrong,
    // so it is the only one allowed the anomaly hue — and only when non-zero.
    _updateDark() {
        if (!this.darkEl) return;
        const v = parseInt(this.darkEl.textContent, 10);
        this.darkEl.classList.toggle('alarm', Number.isFinite(v) && v > 0);
    }
}

export function initTopRail() { return new TopRail(); }
