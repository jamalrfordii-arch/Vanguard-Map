// simClock.js — Single source of simulated time for VANGUARD1.
//
// Every manager that needs "what time is it" must call simClock.now() /
// simClock.date() instead of Date.now() / new Date(). In live mode (the
// default) the clock is bit-identical to wall time, so existing behavior
// is unchanged. The clock can also be paused, scrubbed to any epoch, or
// run at a rate multiplier — and every consumer (sun position, terminator,
// satellite propagation, vessel staleness) follows automatically.
//
// Pure module: no THREE, no DOM reads. Emits 'vg1:clockChanged' on window
// so UI/managers can react without importing each other (per architecture
// rules in CLAUDE.md).
//
// DevTools quick reference:
//   simClock.setTime('2026-05-10T12:00:00Z')  // scrub to a moment
//   simClock.setRate(60)                       // 1 real sec = 1 sim min
//   simClock.pause(); simClock.resume();
//   simClock.goLive()                          // back to wall clock

class SimClock {
    constructor() {
        this._live       = true;       // live mode: now() === Date.now()
        this._anchorReal = Date.now(); // real epoch ms at last re-anchor
        this._anchorSim  = this._anchorReal; // sim epoch ms at last re-anchor
        this._rate       = 1;          // sim seconds per real second (0 = paused)
    }

    // ── Read ──────────────────────────────────────────────────────────────────
    now() {
        if (this._live) return Date.now();
        return this._anchorSim + (Date.now() - this._anchorReal) * this._rate;
    }

    date() { return new Date(this.now()); }

    isLive()  { return this._live; }
    isPaused(){ return !this._live && this._rate === 0; }
    rate()    { return this._live ? 1 : this._rate; }

    // Signed offset from wall time in ms (0 when live).
    offsetMs() { return this.now() - Date.now(); }

    // ── Control ──────────────────────────────────────────────────────────────
    // Accepts epoch ms, a Date, or an ISO string. Leaves live mode.
    setTime(t) {
        const ms = t instanceof Date ? t.getTime()
                 : typeof t === 'string' ? Date.parse(t)
                 : Number(t);
        if (!Number.isFinite(ms)) {
            console.warn('[SimClock] setTime: unparseable time', t);
            return;
        }
        this._reanchor(ms, this._live ? 1 : this._rate);
        this._live = false;
        this._emit();
    }

    // Sim seconds per real second. 0 pauses. Leaves live mode unless rate
    // is exactly 1 AND the clock is already aligned with wall time.
    setRate(r) {
        const rate = Number(r);
        if (!Number.isFinite(rate) || rate < 0) {
            console.warn('[SimClock] setRate: rate must be a finite number >= 0', r);
            return;
        }
        this._reanchor(this.now(), rate);
        this._live = false;
        this._emit();
    }

    pause()  { if (!this.isPaused()) this.setRate(0); }
    resume() { if (this.isPaused())  this.setRate(1); }

    // Jump by a signed amount of sim time, e.g. step(-3600_000) = back 1 h.
    step(deltaMs) { this.setTime(this.now() + Number(deltaMs || 0)); }

    // Return to wall-clock time at 1×.
    goLive() {
        this._live       = true;
        this._anchorReal = Date.now();
        this._anchorSim  = this._anchorReal;
        this._rate       = 1;
        this._emit();
    }

    // ── Internals ────────────────────────────────────────────────────────────
    _reanchor(simMs, rate) {
        this._anchorReal = Date.now();
        this._anchorSim  = simMs;
        this._rate       = rate;
    }

    _emit() {
        if (typeof window === 'undefined') return;
        window.dispatchEvent(new CustomEvent('vg1:clockChanged', {
            detail: { simTime: this.now(), rate: this.rate(), live: this._live }
        }));
    }
}

export const simClock = new SimClock();

// Live tuning from DevTools, same convention as window.splatCloud.
if (typeof window !== 'undefined') window.simClock = simClock;
