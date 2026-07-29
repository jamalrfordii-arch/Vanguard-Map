/**
 * viewport.js — the single owner of the MAP RECT.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Until the bezel, the canvas WAS the window. `renderer.setSize(window.innerWidth,
 * window.innerHeight)` and `#canvas-container` carried no CSS at all, so ~30 call
 * sites across 10 modules asked `window.innerWidth/innerHeight` for "how big is the
 * map?" and got the right answer by accident.
 *
 * With docked rails and a transient selection dock the canvas is a SUB-RECT of the
 * window. Every one of those sites becomes wrong — silently, and by a DIFFERENT
 * amount depending on whether the dock happens to be open. That is the worst kind of
 * bug: no error, no crash, just picking that misses by 48px and line thickness that
 * is subtly off.
 *
 * This is the same move this codebase has already made twice:
 *
 *     simClock.js     replaced ambient Date.now()        → time
 *     entityStore.js  replaced ambient window.aisShips   → entity collection
 *     viewport.js     replaces ambient window.inner*     → map dimensions
 *
 * RULE: nothing outside this module may ask the window how big the map is.
 * `window.vg1Viewport` is a DEBUG MIRROR only (Tier 3 in the dependency policy) —
 * never a data path.
 *
 * WHY ResizeObserver AND NOT window 'resize'
 * ──────────────────────────────────────────
 * Opening or closing the selection dock changes the map size WITHOUT any window
 * resize event ever firing. A `window.addEventListener('resize', …)` would miss it
 * completely and leave the camera aspect, the composer targets and every Line2
 * `resolution` uniform stale until the user happened to drag the browser window.
 * The observer watches the container, so it catches window resizes AND layout
 * changes with one code path.
 *
 * THE POST-CHAIN COST — read before wiring this up
 * ────────────────────────────────────────────────
 * `renderer.setSize()` + `composer.setSize()` reallocates the render targets for the
 * whole chain: Render → Bloom → Fog → Clouds → TiltShift×2 → Bokeh. That is seven
 * passes' worth of framebuffers. Doing it every frame of a 280 ms CSS width
 * transition is ~17 reallocations and a guaranteed hitch every time someone clicks a
 * vessel.
 *
 * So: DO NOT resize during the transition. Let CSS stretch the existing canvas for
 * those 280 ms (imperceptible at that duration) and take ONE resize at the end.
 * `settleMs` below debounces exactly that; wire `transitionend` on the grid to
 * `viewport.measure()` for a precise settle instead of a timed guess.
 * Use hitchRecorder.js to confirm you actually removed the hitch.
 */

// ─────────────────────────────────────────────────────────────────────────────
// PURE HELPERS — no DOM, no THREE. Exported so tests/viewport.test.mjs can run
// them under plain node with no browser shim.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a pointer event's client coords into normalized device coords, relative
 * to an arbitrary rect rather than to the window.
 *
 * This is THE function that fixes picking. uiController.js currently does:
 *     mouse.x =  (event.clientX / window.innerWidth ) * 2 - 1;
 *     mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
 * which is correct only while the canvas is the full window. With a 48px left rail
 * and a 36px top rail, every raycast is offset — you click a vessel and select the
 * one up-and-left of it. beaufortWarningManager.js:245 already does it correctly;
 * this generalises that.
 *
 * @param {number} clientX
 * @param {number} clientY
 * @param {{left:number, top:number, width:number, height:number}} rect
 * @returns {{x:number, y:number}} NDC in [-1, 1]
 */
export function ndcFromRect(clientX, clientY, rect) {
    return {
        x:  ((clientX - rect.left) / rect.width)  * 2 - 1,
        y: -((clientY - rect.top)  / rect.height) * 2 + 1
    };
}

/**
 * Inverse: NDC → pixel coords within the map rect. Screen-space label placement
 * (portManager hover/click detection, main.js off-screen edge arrows) needs this.
 * Those sites currently multiply by window.innerWidth/Height, which puts port
 * labels and edge arrows in the wrong place once rails exist — edge arrows would
 * point at the rails instead of at the map boundary.
 */
export function pxFromNdc(ndcX, ndcY, width, height) {
    return {
        x: (ndcX *  0.5 + 0.5) * width,
        y: (ndcY * -0.5 + 0.5) * height
    };
}

/**
 * Clamp a DOM tooltip so it stays inside the MAP rect rather than inside the
 * window. Without this, a tooltip near the right edge slides underneath the
 * selection dock and a tooltip near the bottom slides under the timeline rail.
 * Call sites: uiController.js:2363, beaufortWarningManager.js:304,
 * ibtracsManager.js:1023.
 */
export function clampToRect(x, y, elW, elH, rect, pad = 12) {
    return {
        x: Math.max(rect.left + pad, Math.min(x, rect.left + rect.width  - elW - pad)),
        y: Math.max(rect.top  + pad, Math.min(y, rect.top  + rect.height - elH - pad))
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// LIVE STATE
// ─────────────────────────────────────────────────────────────────────────────

let _el      = null;
let _rect    = { left: 0, top: 0, width: 1, height: 1 };
let _dprCap  = 1;
let _obs     = null;
let _timer   = null;
let _settle  = 120;
const _subs  = new Set();

function _readRect() {
    if (!_el) return;
    const r = _el.getBoundingClientRect();
    // Guard against a zero-size read: during the dock collapse transition the
    // grid column hits 0 for a frame. A 0-width canvas makes camera.aspect NaN,
    // which silently corrupts the projection matrix and blanks the map — with no
    // console error. Never let a zero through.
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    const changed = (w !== _rect.width || h !== _rect.height ||
                     r.left !== _rect.left || r.top !== _rect.top);
    _rect = { left: r.left, top: r.top, width: w, height: h };
    return changed;
}

function _emit() {
    for (const fn of _subs) {
        try { fn(_rect.width, _rect.height); }
        catch (e) { console.error('[viewport] subscriber threw:', e); }
    }
    // Tier 1 notification for anything that would rather listen than subscribe.
    try {
        window.dispatchEvent(new CustomEvent('vg1:viewportChanged', {
            detail: { width: _rect.width, height: _rect.height }
        }));
    } catch (_) { /* non-DOM context (tests) */ }
}

/**
 * Bind to the element the renderer draws into (#canvas-container).
 * @param {HTMLElement} el
 * @param {{settleMs?:number, pixelCap?:number}} [opts]
 */
export function attach(el, opts = {}) {
    _el     = el;
    _settle = opts.settleMs ?? 120;
    _dprCap = opts.pixelCap ?? 1;
    _readRect();

    if (typeof ResizeObserver !== 'undefined') {
        _obs = new ResizeObserver(() => {
            // Debounce: the grid transition fires this ~17× over 280 ms and each
            // reallocation of the 7-pass post chain is expensive. One resize at
            // the end is what we want.
            clearTimeout(_timer);
            _timer = setTimeout(() => { if (_readRect()) _emit(); }, _settle);
        });
        _obs.observe(el);
    } else {
        // No ResizeObserver (very old browser): fall back to window resize. This
        // will NOT catch dock open/close — call measure() manually from the
        // layout code in that case.
        window.addEventListener('resize', () => { if (_readRect()) _emit(); });
    }
    return api;
}

/**
 * Force an immediate re-measure + emit.
 *
 * DELIBERATELY does NOT clear the pending ResizeObserver debounce.
 *
 * It used to, and that was a bug found by running the app (2026-07-27): a caller
 * that measures optimistically — e.g. vg1Chrome() on a double-rAF after a mode
 * switch — can read one frame early while layout is still settling under load.
 * Cancelling the observer's pending timer removed the only thing that would have
 * corrected that stale read, so the cached rect stayed wrong indefinitely while
 * getBoundingClientRect() reported the truth. Symptom: camera aspect and every
 * resolution uniform silently pinned to the PREVIOUS layout.
 *
 * Letting the debounced observer read land as well costs one redundant
 * getBoundingClientRect and emits nothing when the value already agrees
 * (_readRect returns `changed`). Cheap insurance against an invisible failure.
 */
export function measure() {
    if (_readRect()) _emit();
    return _rect;
}

/** Subscribe to size changes. Returns an unsubscribe fn. */
export function onChange(fn) {
    _subs.add(fn);
    return () => _subs.delete(fn);
}

export const width  = () => _rect.width;
export const height = () => _rect.height;
export const aspect = () => _rect.width / _rect.height;
export const rect   = () => ({ ..._rect });

/**
 * Drawing-buffer size, honouring the renderer's live pixel ratio.
 *
 * MUST match THREE.WebGLRenderer.setSize() EXACTLY, which does:
 *     _canvas.width = Math.floor( width * _pixelRatio )
 *
 * The Math.floor is not cosmetic. The FPS monitor nudges the ratio to fractional
 * values at runtime (observed live at 1.7), and 2560 * 1.7 === 4351.999999999999
 * in IEEE-754. Returning that float while the renderer allocated 4351 put every
 * LineMaterial.resolution off by one pixel — invisible, but wrong, and exactly
 * the class of drift this module exists to eliminate. Found by running the app;
 * unit tests missed it because they used integer ratios.
 */
export function bufferSize(cssW, cssH, ratio) {
    return { w: Math.floor(cssW * ratio), h: Math.floor(cssH * ratio) };
}
export const bufferWidth  = () => Math.floor(_rect.width  * _dprCap);
export const bufferHeight = () => Math.floor(_rect.height * _dprCap);

/** THREE.Vector2-shaped resolution for Line2 / LineMaterial uniforms. */
export function resolution(out) {
    if (out && typeof out.set === 'function') return out.set(bufferWidth(), bufferHeight());
    return { x: bufferWidth(), y: bufferHeight() };
}

/**
 * Update the pixel cap and NOTIFY, because the drawing buffer just changed size
 * even though the CSS rect did not.
 *
 * The runtime FPS monitor nudges renderer pixel ratio live (see sceneSetup).
 * Every LineMaterial.resolution uniform is expressed in DRAWING-BUFFER pixels,
 * so a ratio change invalidates all of them. Before this emitted, nothing told
 * them — they stayed pinned to the previous ratio and lines rendered at the
 * wrong thickness until the next window resize happened to refresh them.
 */
export function setPixelCap(cap) {
    if (!(cap > 0) || cap === _dprCap) return;
    _dprCap = cap;
    _emit();
}

/** Pointer event → NDC against the live map rect. Replaces uiController:2350-2351. */
export function ndcFromEvent(e) {
    return ndcFromRect(e.clientX, e.clientY, _rect);
}

const api = {
    attach, measure, onChange, width, height, aspect, rect,
    bufferWidth, bufferHeight, bufferSize, resolution, setPixelCap,
    ndcFromEvent, ndcFromRect, pxFromNdc, clampToRect
};

// Tier 3 debug mirror ONLY — read from DevTools, never a data path.
try { window.vg1Viewport = api; } catch (_) {}

export default api;
