// qualityManager.js — Adaptive quality tiers for cross-device performance.
//
// Goal: an iPhone should be able to load the map (at reduced detail) just as a
// desktop RTX does at full detail. Two layers:
//
//   1. Detection — at load, read the GPU string (the same WEBGL_debug_renderer
//      _info call that caught the "Basic Render Driver"), CPU cores, RAM, and
//      mobile signals, and pick a starting tier: LOW / MEDIUM / HIGH / ULTRA.
//   2. Runtime adaptation — measure real frame time and lower the renderer's
//      pixel ratio when it sags, raise it when there's headroom. Detection is a
//      guess; FPS is the truth, so the map self-tunes after boot.
//
// Heavy LOAD-TIME knobs (splat density, pixel-ratio cap) are set from the tier
// before those systems build. Cheap RUNTIME knobs (pixel ratio) flex live.
//
// Manual override: vg1Quality.setTier('LOW') (persisted), vg1Quality.info().

const TIERS = {
    LOW:    { label: 'LOW',    splatScale: 0.18, pixelCap: 1.0,  particleScale: 0.3,  vesselDetail: false, post: { bloom: true,  fog: false, clouds: false, tiltshift: false, bokeh: false } },
    MEDIUM: { label: 'MEDIUM', splatScale: 0.42, pixelCap: 1.25, particleScale: 0.6,  vesselDetail: true,  post: { bloom: true,  fog: true,  clouds: false, tiltshift: false, bokeh: false } },
    HIGH:   { label: 'HIGH',   splatScale: 0.72, pixelCap: 1.5,  particleScale: 0.85, vesselDetail: true,  post: { bloom: true,  fog: true,  clouds: true,  tiltshift: true,  bokeh: false } },
    ULTRA:  { label: 'ULTRA',  splatScale: 1.0,  pixelCap: 2.0,  particleScale: 1.0,  vesselDetail: true,  post: { bloom: true,  fog: true,  clouds: true,  tiltshift: true,  bokeh: true  } },
};
const ORDER = ['LOW', 'MEDIUM', 'HIGH', 'ULTRA'];
const LS_KEY  = 'vg1_quality';
const FPS_KEY = 'vg1_fps_cap';

function gpuString() {
    try {
        const c  = document.createElement('canvas');
        const gl = c.getContext('webgl2') || c.getContext('webgl');
        if (!gl) return '';
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        return dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)).toLowerCase() : '';
    } catch (_) { return ''; }
}

function isMobile() {
    const ua = navigator.userAgent || '';
    if (/Mobi|Android|iPhone|iPod/i.test(ua)) return true;
    // iPad on iPadOS reports as Mac; use touch + screen to disambiguate.
    if (navigator.maxTouchPoints > 1 && window.innerWidth < 1024) return true;
    return false;
}

function detectTier() {
    const gpu   = gpuString();
    const cores = navigator.hardwareConcurrency || 4;
    const mem   = navigator.deviceMemory || 4;      // GB, coarse, desktop often undefined → 4
    const mobile = isMobile();

    // Software / fallback renderers — always lowest.
    if (/swiftshader|basic render|software|llvmpipe|microsoft basic/.test(gpu)) return 'LOW';

    if (mobile) return (cores >= 6 && mem >= 4) ? 'MEDIUM' : 'LOW';

    // Desktop discrete GPUs.
    if (/(rtx|radeon rx|geforce rtx|geforce gtx|arc a7|arc a5)/.test(gpu) && cores >= 8 && mem >= 8) return 'ULTRA';
    if (/(nvidia|geforce|radeon|intel arc)/.test(gpu) && cores >= 6) return 'HIGH';
    if (cores >= 8 && mem >= 8) return 'HIGH';        // strong CPU, unknown GPU
    if (cores >= 4) return 'MEDIUM';
    return 'LOW';
}

class QualityManager {
    constructor() {
        const saved = (typeof localStorage !== 'undefined') ? localStorage.getItem(LS_KEY) : null;
        this.auto     = !saved;
        this.detected = detectTier();
        this.tier     = (saved && TIERS[saved]) ? saved : this.detected;

        this._renderer = null;
        this._pr       = TIERS[this.tier].pixelCap;   // current live pixel ratio
        this._emaMs    = 16.7;                          // frame-time moving average
        this._cool     = 0;                             // frames since last change (hysteresis)
        // User FPS cap (0 = uncapped). Runtime knob — the frame limiter lives in
        // main.js's animate loop; this is just the persisted source of truth.
        this._fpsCap   = (() => { try { return parseInt(localStorage.getItem(FPS_KEY) || '0', 10) || 0; } catch (_) { return 0; } })();
    }

    get s() { return TIERS[this.tier]; }

    // ── Load-time knobs ──────────────────────────────────────────────────────
    // Tile-download resolution per tier (the load-time-vs-capability lever).
    // zoom 2/3/4 → 1024²/2048²/4096². Read by dataLoader.loadAllData.
    tileZoom()    { return { LOW: 2, MEDIUM: 3, HIGH: 4, ULTRA: 4 }[this.tier] ?? 4; }
    splatScale()  { return this.s.splatScale; }
    gridScale()   { return Math.sqrt(this.s.splatScale); }  // grid is 2D → sqrt for linear point count
    pixelCap()    { return Math.min(window.devicePixelRatio || 1, this.s.pixelCap); }
    particleScale() { return this.s.particleScale; }
    vesselDetail()  { return this.s.vesselDetail; }
    post(name)      { return !!this.s.post[name]; }

    // ── Renderer + runtime adaptation ────────────────────────────────────────
    attachRenderer(renderer) {
        this._renderer = renderer;
        this._pr = this.pixelCap();
        renderer.setPixelRatio(this._pr);
    }

    // Call each frame with delta-seconds. Smooths frame time and nudges the
    // renderer pixel ratio between a floor and the tier cap. Cheap, live, safe.
    tick(deltaSec) {
        if (!this._renderer) return;
        const ms = Math.min(100, (deltaSec || 0) * 1000);
        this._emaMs = this._emaMs * 0.9 + ms * 0.1;
        if (this._cool > 0) { this._cool--; return; }

        const cap   = this.pixelCap();
        const floor = 0.6;
        // Cap-aware thresholds: when the user caps FPS, frame time is INTENTIONALLY
        // ~ (1000/cap) ms — judge "too slow" relative to that budget so we don't
        // blur the map just because it's capped. Uncapped → original 45/66 fps gates.
        const budget = this._fpsCap > 0 ? 1000 / this._fpsCap : 16.7;
        const slowMs = this._fpsCap > 0 ? budget * 1.4  : 22;
        const fastMs = this._fpsCap > 0 ? budget * 0.85 : 15;
        if (this._emaMs > slowMs && this._pr > floor) {       // genuinely behind budget → ease down
            this._pr = Math.max(floor, this._pr - 0.1);
            this._renderer.setPixelRatio(this._pr);
            this._cool = 90;
        } else if (this._emaMs < fastMs && this._pr < cap) {  // comfortable headroom → ease up
            this._pr = Math.min(cap, this._pr + 0.1);
            this._renderer.setPixelRatio(this._pr);
            this._cool = 120;
        }
    }

    // ── FPS cap (runtime frame limiter; the limiter itself runs in main.js) ────
    fpsCap()        { return this._fpsCap; }
    setFpsCap(v) {
        this._fpsCap = Math.max(0, parseInt(v, 10) || 0);
        try { localStorage.setItem(FPS_KEY, String(this._fpsCap)); } catch (_) {}
        console.info('[Quality] FPS cap', this._fpsCap || 'uncapped');
    }

    // ── Manual override ──────────────────────────────────────────────────────
    setTier(t) {
        t = String(t).toUpperCase();
        if (!TIERS[t]) { console.warn('[Quality] unknown tier', t, '— use', ORDER.join('/')); return; }
        this.tier = t;
        this.auto = false;
        try { localStorage.setItem(LS_KEY, t); } catch (_) {}
        if (this._renderer) { this._pr = this.pixelCap(); this._renderer.setPixelRatio(this._pr); }
        console.info('[Quality] tier set to', t, '(reload to apply load-time settings like splat density)');
    }

    resetAuto() {
        try { localStorage.removeItem(LS_KEY); } catch (_) {}
        this.auto = true;
        this.tier = this.detected;
        console.info('[Quality] back to auto:', this.tier);
    }

    info() {
        return { tier: this.tier, auto: this.auto, detected: this.detected,
                 gpu: gpuString(), cores: navigator.hardwareConcurrency,
                 deviceMemory: navigator.deviceMemory, mobile: isMobile(),
                 livePixelRatio: +this._pr.toFixed(2), frameMs: +this._emaMs.toFixed(1) };
    }
}

export const quality = new QualityManager();
if (typeof window !== 'undefined') window.vg1Quality = quality;
