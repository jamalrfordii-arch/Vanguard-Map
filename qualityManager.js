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
const RS_KEY  = 'vg1_render_scale';

// Absolute ceiling on pixel ratio, supersampling included. Pixel COUNT is the
// square of this, so 2.0 is already 4× the shading work of native; 2.5 is 6.25×.
// This is a guard against a user on a dpr=2 display picking scale 2 and asking
// the GPU for 16× the pixels of a native dpr=1 render.
const RENDER_SCALE_MAX = 2.0;
// Allowed user choices. 1.0 = native (default; nothing changes unless asked).
export const RENDER_SCALE_OPTIONS = [1.0, 1.25, 1.5, 2.0];

// ── Frame-time sampling gates (2026-07-24) ───────────────────────────────────
// The controller used to Math.min(100, ...) every delta into the EMA. That clamp
// is main.js's — it exists to stop dead-reckoning overshoot after a stall — and
// it is actively WRONG as a performance signal: a 3-second boot frame arrives
// here as exactly 100ms and reads as a plausible "10fps" sample. Feeding a few
// hundred of those in during load ratcheted a scene that actually runs at 77fps
// all the way down to the pixel-ratio floor, where it then stayed (climbing back
// needs EMA < 15ms, four steps, 120-frame cooldowns). One delta value cannot
// serve both purposes — so reject outliers here rather than clamping them.
//
// Anything above this is boot, GC, a tab-throttle resume, an alt-tab return, or
// a worker landing a big upload. None of it is steady-state signal.
const SAMPLE_MAX_MS = 50;
// Accepted frames required before the controller may touch pixel ratio at all.
// ~2s at 60fps — long enough for tile streaming and the continent mesh to land.
const WARMUP_FRAMES = 120;
// Pixel-ratio floor. Measured 2026-07-24 (RTX 5060, whole-world camera): sweeping
// 0.6 → 1.0 → 1.5 → 2.0 moved frame time 13.5 → 13.0 → 14.1 → 15.1 ms. The whole
// range costs 1.6ms; this scene is not fill-rate bound. 0.6 was giving up 64% of
// the pixels to buy ~1ms, and measured SLOWER than 1.0 (the upscale blit costs
// more than it saves).
//
// 0.85 → 1.0 (2026-07-24, deliberate): never render below native. Follow-up
// measurement showed the controller still stepping down on a scene running at
// 95fps, because the EMA is pulled up by a tail of multi-hundred-ms hitches
// (one 448ms stall observed). Downscaling is the wrong response to jank — it
// does nothing for a 448ms stall and pays for it permanently in legibility.
//
// CONSEQUENCE, stated plainly: every tier's pixelCap is >= 1.0, and pixelCap()
// clamps to devicePixelRatio (also >= 1), so floor === cap on every device and
// the runtime downscale path is now effectively INERT everywhere — including on
// the weak/mobile hardware it was written for. That is a real trade, not a free
// win. If a low-end device turns out to need relief, do NOT just lower this
// number globally: make the floor tier-aware (e.g. 0.75 for LOW/MEDIUM, 1.0 for
// HIGH/ULTRA) so strong machines keep native rendering. The climb-UP path above
// still works and is what lets ULTRA supersample if the dpr clamp is ever lifted.
const PR_FLOOR = 1.0;
// ── Fill-bound detection (2026-07-25) ────────────────────────────────────────
// A step down is judged against what a purely fill-bound renderer would have
// saved. Below this fraction, resolution is not what's costing the frame.
// 0.35 is deliberately generous: we only want to catch the case where the lever
// is plainly disconnected (measured ~0.08 live), not to second-guess noisy data.
const FILL_BOUND_MIN_RATIO = 0.35;
// Consecutive ineffective steps before we stop believing in the lever. >1 so a
// single noisy sample (a background tab, a GC pause) can't latch it.
const FILL_BOUND_STRIKES   = 2;
// Accepted frames before the fill-bound VERDICT is re-opened. ~30s at 60fps.
// Necessary because the verdict is a property of the SCENE, not the machine: the
// same GPU is fill-bound at one altitude and CPU-bound at another, and a single
// session flies through both. Measured 2026-07-25: the clamp cut point AREA ~30x
// and the cap raise tripled point COUNT within minutes — a verdict formed before
// those is worthless after them. Re-arming only clears the latch; the existing
// bidirectional probe still has to earn the new answer, so a genuinely fill-bound
// scene simply re-latches and nothing moves.
const REARM_FRAMES = 1800;

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
        // NOTE: this is an OPTIMISTIC placeholder, not the live ratio — pixelCap()
        // clamps to devicePixelRatio, which isn't knowable until a renderer is
        // attached. info() reads the renderer instead; see the comment there.
        this._pr       = TIERS[this.tier].pixelCap;
        this._emaMs    = 16.7;                          // frame-time moving average (re-seeded from the first accepted sample)
        this._warm     = 0;                             // accepted frames since boot (see WARMUP_FRAMES)
        this._cool     = 0;                             // frames since last change (hysteresis)
        // Fill-bound belief. Starts TRUE so behaviour is unchanged until a step
        // down is actually measured and found not to help — the controller must
        // not begin by assuming its own lever is broken.
        this._fillBound    = true;
        this._ineffective  = 0;
        this._pendingProbe = null;
        this._leverProven  = false;
        this._sinceRearm   = 0;
        // User FPS cap (0 = uncapped). Runtime knob — the frame limiter lives in
        // main.js's animate loop; this is just the persisted source of truth.
        this._fpsCap   = (() => { try { return parseInt(localStorage.getItem(FPS_KEY) || '0', 10) || 0; } catch (_) { return 0; } })();
        // Supersampling multiplier. Explicit user opt-in — defaults to 1.0 so
        // the auto-tier can never stumble into it, and so an unattended machine
        // behaves exactly as before this setting existed.
        this._renderScale = (() => {
            try { return Math.min(RENDER_SCALE_MAX, Math.max(1, parseFloat(localStorage.getItem(RS_KEY)) || 1)); }
            catch (_) { return 1; }
        })();
    }

    get s() { return TIERS[this.tier]; }

    // ── Load-time knobs ──────────────────────────────────────────────────────
    // Tile-download resolution per tier (the load-time-vs-capability lever).
    // zoom 2/3/4 → 1024²/2048²/4096². Read by dataLoader.loadAllData.
    tileZoom()    { return { LOW: 2, MEDIUM: 3, HIGH: 4, ULTRA: 4 }[this.tier] ?? 4; }
    splatScale()  { return this.s.splatScale; }
    gridScale()   { return Math.sqrt(this.s.splatScale); }  // grid is 2D → sqrt for linear point count
    // Automatic ceiling: never exceeds the display's native ratio. The tier cap
    // is a ceiling on AUTOMATIC behaviour only.
    autoCap()     { return Math.min(window.devicePixelRatio || 1, this.s.pixelCap); }
    // Effective ceiling, including the user's explicit supersampling opt-in.
    // renderScale > 1 deliberately lifts the devicePixelRatio clamp: rendering
    // above native and letting the display downsample is real SSAA, and it is
    // the only lever that sharpens EVERY layer at once (terrain, glyphs, HUD
    // text) rather than one altitude band. Cost is quadratic in this number —
    // 1.5 is 2.25× the pixels, 2.0 is 4× — hence RENDER_SCALE_MAX.
    pixelCap()    { return Math.min(RENDER_SCALE_MAX, this.autoCap() * this._renderScale); }
    renderScale() { return this._renderScale; }
    // Live ratio for shaders that size things in DEVICE pixels and must compensate
    // (terrainBuilder's splat cloud). 1 before a renderer exists — callers just
    // need a sane starting value; the vg1:pixelRatioChanged listener corrects it.
    currentPixelRatio() { return this._renderer ? this._renderer.getPixelRatio() : 1; }
    particleScale() { return this.s.particleScale; }
    vesselDetail()  { return this.s.vesselDetail; }
    post(name)      { return !!this.s.post[name]; }

    // ── Renderer + runtime adaptation ────────────────────────────────────────
    attachRenderer(renderer) {
        this._renderer = renderer;
        this._pr = this.pixelCap();
        this._applyPixelRatio(this._pr);
    }

    // THE ONLY place pixel ratio is written. renderer.setPixelRatio() alone is
    // NOT enough when post-processing is in use: EffectComposer captures
    // `renderer.getPixelRatio()` once in its constructor and multiplies every
    // subsequent setSize() by that stored value. Nothing else updates it, so
    // changing only the renderer resizes the CANVAS while leaving the composer's
    // render targets — where the entire chain (RenderPass → Bloom → Fog →
    // Clouds → TiltShift×2) actually shades — at their original resolution.
    // The net effect was a resample of a full-resolution image into a
    // differently-sized canvas: all of the blur, none of the savings. That is
    // why the 2026-07-24 pixel-ratio sweep measured almost no frame-time
    // difference between 0.6 and 1.0 (13.5ms vs 13.0ms) and wrongly concluded
    // the scene was not fill-rate bound — the sweep never varied the resolution
    // anything was rendered at. Listeners (main.js) call composer.setPixelRatio.
    _applyPixelRatio(v) {
        if (!this._renderer) return;
        this._renderer.setPixelRatio(v);
        if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
            window.dispatchEvent(new CustomEvent('vg1:pixelRatioChanged', { detail: { pixelRatio: v } }));
        }
    }

    // Call each frame with delta-seconds. Smooths frame time and nudges the
    // renderer pixel ratio between a floor and the tier cap. Cheap, live, safe.
    tick(deltaSec) {
        if (!this._renderer) return;
        const ms = (deltaSec || 0) * 1000;

        // Outlier rejection — see SAMPLE_MAX_MS. Dropped entirely, not clamped:
        // a rejected frame must leave no trace in the average.
        if (!(ms > 0) || ms > SAMPLE_MAX_MS) return;

        // Seed from the first real sample rather than averaging away the 16.7
        // guess over ~40 frames while the controller is already acting on it.
        if (this._warm === 0) { this._emaMs = ms; this._warm = 1; return; }

        this._emaMs = this._emaMs * 0.9 + ms * 0.1;

        // Warmup gate — measure before acting. Without this the controller makes
        // a permanent decision from the load period, which is the one stretch
        // guaranteed not to represent how the map actually runs.
        if (this._warm < WARMUP_FRAMES) { this._warm++; return; }
        if (this._cool > 0) { this._cool--; return; }

        const cap   = this.pixelCap();
        const floor = Math.min(PR_FLOOR, cap);   // never let the floor exceed the cap
        // Cap-aware thresholds: when the user caps FPS, frame time is INTENTIONALLY
        // ~ (1000/cap) ms — judge "too slow" relative to that budget so we don't
        // blur the map just because it's capped. Uncapped → original 45/66 fps gates.
        const budget = this._fpsCap > 0 ? 1000 / this._fpsCap : 16.7;
        const slowMs = this._fpsCap > 0 ? budget * 1.4  : 22;
        const fastMs = this._fpsCap > 0 ? budget * 0.85 : 15;
        // ── Did the LAST step down actually help? (2026-07-25) ───────────────
        // Measured live on an RTX 5060: frame time 17.7ms at pr=1, 19.2ms at pr=2 —
        // FOUR TIMES the pixels for 8% more frame time. Hiding the entire 20M-point
        // splat cloud changed nothing at all. The frame cost was almost entirely
        // outside the render (hitchRecorder: 3173ms outside the loop vs 1068 inside).
        //
        // But this controller assumed pixel ratio was THE frame-time lever, saw
        // 23.9ms > slowMs, and walked resolution down to the floor and kept it
        // there. It was paying for image quality and buying nothing — and rendering
        // at 1x is exactly what makes a 20M-point cloud look like static, because
        // ~8 splats land on every pixel and the depth test picks one at random
        // instead of averaging them.
        //
        // So: verify the lever works before pulling it. If a step down produced far
        // less improvement than a fill-bound renderer would give, this scene is not
        // fill-bound, and lowering resolution is pure loss.
        // Periodic re-arm — see REARM_FRAMES. Cheap: costs one 0.1 probe step.
        if (++this._sinceRearm >= REARM_FRAMES && this._leverProven) {
            this._sinceRearm = 0;
            this._leverProven = false;
            this._ineffective = 0;
        }

        if (this._pendingProbe) {
            const { prBefore, emaBefore } = this._pendingProbe;
            this._pendingProbe = null;
            // Fill-bound cost scales with pixel AREA, so predict the change in
            // EITHER direction: stepping down should save time, stepping up should
            // cost it. Probing both ways matters — a controller that only learns
            // from steps down can never discover anything once it is at the floor.
            const predicted = emaBefore * (Math.pow(this._pr / prBefore, 2) - 1);
            const actual    = this._emaMs - emaBefore;
            if (Math.abs(predicted) > 0.5) {          // too small to read through noise
                if (actual / predicted < FILL_BOUND_MIN_RATIO) {
                    if (++this._ineffective >= FILL_BOUND_STRIKES) this._fillBound = false;
                } else {
                    // The lever demonstrably works. Latch that permanently: it is
                    // what stops the exhaustion rule below from oscillating.
                    this._ineffective = 0;
                    this._fillBound   = true;
                    this._leverProven = true;
                }
            }
        }

        // ── Proof by exhaustion ──────────────────────────────────────────────
        // Sitting at the floor and STILL behind budget means resolution has already
        // been taken as low as it may go without fixing the frame time. That is
        // itself the measurement: the constraint is elsewhere. Without this the
        // controller deadlocks — it cannot step down to probe (already at the
        // floor) and refuses to step up (still slow), so it stays at 1x forever,
        // which is precisely the state found live on 2026-07-25.
        //
        // Safe because it is bounded on both sides: climbing is measured by the
        // probe above, so if it genuinely hurts, _fillBound is restored, and
        // _leverProven then prevents this rule from firing again.
        if (!this._leverProven && this._fillBound
            && this._pr <= floor + 1e-9 && this._emaMs > slowMs) {
            this._fillBound = false;
        }

        if (this._emaMs > slowMs && this._pr > floor && this._fillBound) {
            // Genuinely behind budget AND resolution is a real lever → ease down.
            const prBefore = this._pr;
            this._pr = Math.max(floor, this._pr - 0.1);
            this._applyPixelRatio(this._pr);
            this._cool = 90;
            this._pendingProbe = { prBefore, emaBefore: this._emaMs };
        } else if (this._pr < cap && (this._emaMs < fastMs || !this._fillBound)) {
            // Ease up on comfortable headroom — OR when resolution has been shown
            // not to drive frame time, in which case running below cap is free loss.
            const prBefore = this._pr;
            this._pr = Math.min(cap, this._pr + 0.1);
            this._applyPixelRatio(this._pr);
            this._cool = 120;
            // Probe the climb as well, so an over-optimistic "not fill-bound" call
            // is self-correcting rather than permanent.
            this._pendingProbe = { prBefore, emaBefore: this._emaMs };
        }
    }

    // ── FPS cap (runtime frame limiter; the limiter itself runs in main.js) ────
    fpsCap()        { return this._fpsCap; }
    setFpsCap(v) {
        this._fpsCap = Math.max(0, parseInt(v, 10) || 0);
        try { localStorage.setItem(FPS_KEY, String(this._fpsCap)); } catch (_) {}
        console.info('[Quality] FPS cap', this._fpsCap || 'uncapped');
    }

    // ── Supersampling (explicit user setting) ────────────────────────────────
    // Applies immediately — no reload. The pixel-ratio change propagates to the
    // composer via _applyPixelRatio's event, so the whole post chain resizes too.
    setRenderScale(v) {
        const next = Math.min(RENDER_SCALE_MAX, Math.max(1, parseFloat(v) || 1));
        this._renderScale = next;
        try { localStorage.setItem(RS_KEY, String(next)); } catch (_) {}
        // Jump straight to the new ceiling rather than letting tick() creep
        // there 0.1 at a time over several seconds — this is a direct request.
        this._pr = this.pixelCap();
        this._applyPixelRatio(this._pr);
        // Re-arm the controller: the frame cost just changed by up to 4×, so the
        // existing average describes a scene that no longer exists.
        this._warm = 0;
        this._fillBound    = true;
        this._ineffective  = 0;
        this._pendingProbe = null;
        this._leverProven  = false;
        this._cool = 0;
        console.info('[Quality] render scale', next + '×',
            `(pixel ratio ${this._pr.toFixed(2)}, ${(this._pr / Math.max(0.01, this.autoCap())).toFixed(2)}× native, `
            + `${((this._pr / Math.max(0.01, this.autoCap())) ** 2).toFixed(2)}× the pixels)`);
    }

    // ── Manual override ──────────────────────────────────────────────────────
    setTier(t) {
        t = String(t).toUpperCase();
        if (!TIERS[t]) { console.warn('[Quality] unknown tier', t, '— use', ORDER.join('/')); return; }
        this.tier = t;
        this.auto = false;
        try { localStorage.setItem(LS_KEY, t); } catch (_) {}
        if (this._renderer) { this._pr = this.pixelCap(); this._applyPixelRatio(this._pr); }
        console.info('[Quality] tier set to', t, '(reload to apply load-time settings like splat density)');
    }

    resetAuto() {
        try { localStorage.removeItem(LS_KEY); } catch (_) {}
        this.auto = true;
        this.tier = this.detected;
        console.info('[Quality] back to auto:', this.tier);
    }

    info() {
        // livePixelRatio reads the RENDERER, not this._pr. Those diverge before
        // attachRenderer() runs (_pr is seeded to the tier cap in the constructor)
        // and any time something calls renderer.setPixelRatio directly. Reporting
        // the stale field once cost an hour of chasing the wrong cause — it showed
        // 2.0 on a display where pixelCap() could only ever return 1.0.
        // Before attachRenderer there is NO live ratio — reporting _pr here would
        // repeat the exact bug this fix was for (it's seeded to the tier cap,
        // which is optimistic and often unreachable). Say "unknown", not a number.
        const live = this._renderer ? this._renderer.getPixelRatio() : null;
        return { tier: this.tier, auto: this.auto, detected: this.detected,
                 gpu: gpuString(), cores: navigator.hardwareConcurrency,
                 deviceMemory: navigator.deviceMemory, mobile: isMobile(),
                 livePixelRatio: live === null ? null : +live.toFixed(2),
                 // autoCap clamps the tier cap to devicePixelRatio, so ULTRA's
                 // 2.0 is unreachable on a dpr=1 display by automatic means.
                 // pixelCap is the effective ceiling including renderScale.
                 autoCap:  +this.autoCap().toFixed(2),
                 pixelCap: +this.pixelCap().toFixed(2),
                 renderScale: this._renderScale,
                 superSampling: live === null ? 'no renderer attached yet'
                     : +(live / Math.max(0.01, this.autoCap())).toFixed(2) + '× native',
                 devicePixelRatio: window.devicePixelRatio || 1,
                 warmedUp: this._warm >= WARMUP_FRAMES,
                 frameMs: +this._emaMs.toFixed(1) };
    }
}

export const quality = new QualityManager();
if (typeof window !== 'undefined') window.vg1Quality = quality;
