// tileStreamManager.js — Multi-level adaptive terrain LOD via Cesium Quantized-Mesh
//
// Replaces Terrarium PNG tiles with Cesium Ion's binary Quantized-Mesh (QM) format.
// QM advantages over Terrarium PNG:
//   • Adaptive triangle density — mountains get thousands of tris, flat ocean gets ~10
//   • Exact shared edge vertices between tiles → zero cracks or gaps at tile seams
//   • Built-in edge vertex arrays → proper skirts that eliminate ALL coastal black walls
//   • Binary, so no canvas/pixel decode step — roughly 2× faster tile load
//
// Five zoom LOD tiers are unchanged from the previous version.  Only the tile
// fetch, decode, and mesh-build pipeline changes.
//
// ── HOW TO ENABLE ────────────────────────────────────────────────────────────────
//   1. Sign up free at cesium.com/ion (no credit card)
//   2. Go to Access Tokens → copy "My Default Token"
//   3. Paste it into CESIUM_TOKEN below
//   4. Reload Vanguard1 — terrain will stream at all zoom levels
// ─────────────────────────────────────────────────────────────────────────────────

import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT, TERRAIN_VERTICAL_SCALE, TILESTREAM, SPLAT_LAND_GRID } from './config.js';
import { getTrueElevation } from './terrainBuilder.js';
import { quality } from './qualityManager.js';
import { hitchRecorder } from './hitchRecorder.js';
// Moved to a pure module 2026-07-24 so a Worker can run the heavy half; imported
// back here because several other call sites in this file still use them.
import { clampPointSize } from './tilePointsBuilder.js';
import { buildTilePoints, geoTileBounds, lonToSceneX, latToSceneZ,
         elevToColor, _pFbm, curveOffset } from './tilePointsBuilder.js';
import { tilePointsPool } from './tilePointsPool.js';
import { ImageryCircuitBreaker } from './imageryCircuitBreaker.js';
import { isBeyondTerrainCoverage } from './terrainCoverage.js';
import { TileGeometryCache, fingerprint, cacheKey } from './tileGeometryCache.js';
import { activeTerrainMode } from './tilePointsBuilder.js';
// Baked land/water bitmask, consulted before any tile fetch (2026-07-25).
// Fails open — see tileLandMask.js for why the old depth heuristic it replaces
// was wrong in both directions.
import { tileLandMask } from './tileLandMask.js';

// Reused every frame in update() to read camera tilt — never allocate a new
// Vector3 per frame (see CLAUDE.md perf rule: reuse scratch vectors).
const _tmpVec3 = new THREE.Vector3();
// Frustum-shaped tile loading (2026-07-24). Reused every frame — (2R+1)² boxes per
// level per frame at R=6 is 169, so allocating here would be real GC pressure
// (CLAUDE.md perf rule: no `new` in a per-frame loop).
const _tmpBox      = new THREE.Box3();
const _tmpFrustum  = new THREE.Frustum();
const _tmpProjMat  = new THREE.Matrix4();
// Tiles within this many rings of the anchor load REGARDLESS of the frustum.
// This is the rotation guarantee: a hard camera spin always finds nearby ground
// already loaded instead of a black wedge, because a pure frustum test would
// invalidate the entire loaded set the moment you yaw. 2 rings ≈ a 5×5 block
// around the look-at point.
const ROTATION_SAFETY_RINGS = 2;
// Tiles are thin in Y but their elevation varies; a generous vertical span keeps
// the test honestly 2D-in-plan rather than accidentally culling high terrain.
const TILE_BOX_Y = 3;

// ── Cesium Ion credentials ────────────────────────────────────────────────────
// Token is NOT hardcoded (repo is public-ready). Get a free token at
// cesium.com/ion → Access Tokens, then run once in the DevTools console:
//   localStorage.setItem('vg1_cesium_token', 'YOUR_TOKEN')
// Without a token, tile streaming stays disabled and the map falls back to
// the point cloud at all zoom levels — everything else works normally.
const CESIUM_TOKEN = (typeof localStorage !== 'undefined' && localStorage.getItem('vg1_cesium_token')) || '';
if (!CESIUM_TOKEN) console.warn('[Tiles] No Cesium Ion token — tile streaming disabled. See tileStreamManager.js header.');

// Cesium World Terrain — asset ID 1, global coverage up to zoom 15.
// NOTE: Cesium tiles use TMS Y ordering (Y=0=south pole).
//       We flip the Y coordinate in _loadTile before fetching.
// QM_BASE is resolved dynamically via the Ion endpoint API — do NOT hardcode.
// TileStreamManager._init() fetches the real URL before any tile loading begins.

// ArcGIS World Imagery — fetched by explicit 4326 bbox (export endpoint), since
// the terrain grid is geographic and no longer matches mercator tile indices.
const IMAGERY_EXPORT_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export';

// ── Throttled, retrying imagery fetch (2026-07-15) ────────────────────────────
// The free ArcGIS export endpoint drops requests under burst load — a full
// loadRadius grid can fire 80+ imagery fetches per camera move, which is what
// made tiles trickle in as a checkerboard. Cap concurrency and retry once so
// imagery arrives reliably. Paired with the decoupled mesh load below, tile
// GEOMETRY never waits on imagery — the ground appears immediately (elevation-
// coloured) and the satellite photo drapes on when its throttled fetch returns.
// ── MEASURED NEGATIVE RESULT, 2026-07-25 — do not re-try this ────────────────
// A live z10 dive measured a 28% blank-imagery rate (112 blank / 284 healthy), and
// the obvious suspect was this constant, raised 6→12→20 across earlier sessions to
// speed up tile fill. So concurrency was made adaptive: an AIMD controller halved
// it on every breaker trip and probed back up while healthy.
//
// It did not work, and the measurement was unambiguous. The controller drove the
// limit all the way to its floor of 4 — a 5x reduction — and the blank rate went
// 28% → 29%. Unchanged. The throttle cost fill speed and bought nothing, so it was
// reverted and this note left in its place.
//
// The follow-up probe explains why: fetched SERIALLY under no load, 7 of 8 tiles
// came back healthy (sd 11-23 vs the 1.5 blank threshold). The endpoint is fine
// when it isn't busy. What it objects to is total request VOLUME over time, not
// how many are in flight at once — and lowering concurrency spread the same ~330
// requests across the same 60 seconds, so the endpoint saw an identical rate.
//
// The lever that follows from that evidence is FEWER REQUESTS, not slower ones.
// See the ancestor-imagery reuse below, which lets a tile fall back to its already
// fetched parent's satellite imagery instead of the elevation palette.
const IMG_MAX_CONCURRENT = 20;
const IMG_TIMEOUT_MS     = 9000;  // hard cap per attempt so a hung request always frees its slot
// Same unbounded-queue issue as _qmQueue/_buildQueue above, applied here too
// for consistency (2026-07-21) — this one doesn't hold a `_loading` entry open
// (imagery is fire-and-forget, not awaited before a tile registers), so it's
// lower-severity, but an unbounded FIFO of stale imagery jobs for locations
// long since abandoned is still pure waste. No priority concept here (plain
// FIFO), so on overflow just drop the OLDEST queued job — it's the most stale
// by definition — and resolve it with `null`, the same value a genuine fetch
// failure already produces, which every caller already handles (`if (!bmp)
// return;`).
const MAX_IMG_QUEUE = 400;
let _imgActive = 0;
const _imgQueue = [];
function _imgPump() {
    while (_imgActive < IMG_MAX_CONCURRENT && _imgQueue.length) {
        (_imgQueue.shift()).run();
    }
}
function fetchImagery(url, retries = 1) {
    return new Promise(resolve => {
        const run = async () => {
            _imgActive++;
            let res = null;
            for (let attempt = 0; attempt <= retries; attempt++) {
                // AbortController timeout — without this a single hung ArcGIS
                // response would pin one of the concurrency slots forever and,
                // once all slots were pinned, no tile ever got its imagery.
                const ctl   = new AbortController();
                const timer = setTimeout(() => ctl.abort(), IMG_TIMEOUT_MS);
                try {
                    const r = await fetch(url, { mode: 'cors', signal: ctl.signal });
                    clearTimeout(timer);
                    if (r.ok) { res = r; break; }
                } catch (_) { clearTimeout(timer); /* abort / network — retry below */ }
                if (attempt < retries) await new Promise(rz => setTimeout(rz, 250 + attempt * 350));
            }
            _imgActive--;
            _imgPump();
            resolve(res);
        };
        if (_imgQueue.length >= MAX_IMG_QUEUE) {
            const dropped = _imgQueue.shift();
            dropped.resolve(null);
        }
        _imgQueue.push({ run, resolve });
        _imgPump();
    });
}
// ── Blank-imagery detection (2026-07-24) ─────────────────────────────────────
// The 2026-07-21 retry-with-backoff fix stopped one step short: it treats any
// response that DECODES as success. But the imagery endpoint also answers with
// solid-colour images — rate-limit placeholders, no-data fills — which decode
// perfectly, apply cleanly, clear _imgFailures, and leave the tile a flat block
// of colour forever with nothing recording that anything went wrong.
//
// Measured on two live stuck tiles (z9 564/321 and 567/315, reported as black
// and olive rectangles over Chad): per-tile colour standard deviation 0.0014 on
// a 0-1 scale, versus 0.1016 for a healthy neighbour — a 70× gap, and their
// min/max luminance spanned 0.230-0.237. Both were absent from _imgFailures and
// getStuckImageryTiles() returned empty, so the existing diagnostics reported
// perfect health while two obvious grey rectangles sat on screen.
//
// Threshold is deliberately far below anything real: even open ocean or blank
// desert carries JPEG compression noise well above 1.5/255.
//
// USED FOR DIAGNOSIS ONLY (reverted from driving retries the same day — see the
// call site). A blank response is recorded in _imgFailures so getStuckImageryTiles()
// surfaces it, but the tile still accepts the flat imagery. Retrying per-tile was
// an amplifier: blank responses are caused by endpoint rate limiting, which hits
// every in-flight tile simultaneously, so ~180 tiles retried at once and each retry
// costs a 512² readback plus a potential 28k-point rebuild.
const BLANK_IMAGERY_SD = 1.5;      // 0-255 luminance scale
let _blankImageryHits = 0;
// ── Ancestor imagery cache (2026-07-25) ──────────────────────────────────────
// The measured problem: ~27% of tiles end up with no usable satellite imagery, and
// the fallback is the elevation PALETTE — flat green/olive rectangles that don't
// look like the photographic ground around them. Rebuilding elevation colour was
// never the right fallback when a perfectly good, already-downloaded satellite
// image of the SAME GROUND is sitting one zoom level up.
//
// So every successful decode is kept here, and a tile that fails or blanks paints
// itself from its nearest cached ancestor's sub-rect instead. Half the resolution,
// but real imagery — and continuous with its neighbours, which the palette never is.
//
// Stored DOWNSCALED to ANCESTOR_IMG_N. At the native 512² a single entry is 1MB and
// a useful cache would be tens of MB, on a heap already over 1GB. At 256² an entry
// is 256KB, so the whole cache is ~8MB — and since a child only ever samples a
// QUARTER of the parent, it reads an effective 128², which is roughly the detail
// a half-resolution fallback can justify anyway.
// ── MEASURED FIX 2026-07-25 (second pass) ───────────────────────────────────
// The first version used ONE 32-entry LRU shared across all zoom levels, and it
// did nothing: flat-colour tiles went 27% → 33%. The reason is that every level
// caches into it, and the FINEST level dominates the traffic. A close view holds
// ~123 healthy z10 tiles churning through 32 slots, so the handful of z9 parents
// a z10 tile would want were always evicted long before that tile blanked — the
// lookup essentially never hit.
//
// Coarse tiles are also intrinsically worth more: one z9 tile can repaint FOUR
// z10 children, so it must not compete for space against single-use fine tiles.
// Hence a separate budget per level. N is 128 rather than 256 because a child
// samples only a quarter of a parent anyway (an effective 64², which is all a
// half-resolution fallback can justify) and it keeps the whole thing ~4MB/level.
// ── MEASURED REGRESSION, REVERTED 2026-07-25 — read before retrying ──────────
// The idea: only tiles within N rings of the camera fetch their OWN imagery;
// everything beyond borrows from an already-downloaded ancestor. Sharp at the
// centre, softening outward, far fewer requests. It sounded right and it was
// measured WRONG — mean palette (tiles with no satellite imagery) across five
// sparse sites went 59% -> 75%. Worse, not better:
//
//     Simpson z11  35% -> 73%      Siberia z11  23% -> 78%
//     Sahara  z11  66% -> 71%      Kansas  z11  93% -> 71%
//     Amazon  z11  78% -> 71%
//
// WHY it failed, and why this is a design flaw rather than a bad constant: the
// gate was applied to EVERY level. Borrowing depends on a coarser ancestor having
// real imagery — but the coarse levels were rationed by the same rule, so the
// pyramid was starved at its base. There was nothing left to borrow FROM. The
// ancestor cache ended the run at a 0.9% hit rate (171 hits, 18,879 misses).
//
// If retried, the gate must apply ONLY to the finest currently-lit level, with
// coarser levels always fetching in full — they are few (z9 ~30, z10 ~93 vs z11
// ~181) and they are the source everything else draws on. Gate the many, never
// the few. Set to Infinity = disabled; the borrowing machinery below is retained
// because it does help on the path it was built for (blank responses).
const IMAGERY_OWN_RINGS = Infinity;   // retained for reference; superseded below

// ── PROGRESSIVE IMAGERY (2026-07-25) — the corrected retry ───────────────────
// The measured problem ("slow patchy load"): a cold close view fires ~455
// imagery requests (z10 ~93 + z11 ~181 + z12 ~181) through a ~13 tiles/second
// pipe, so tiles pop from green palette to photo one at a time for ~19 seconds.
// Cold Lisbon baseline: 0/250 tiles photographic at 3s, 15 at 6s, 93 at 12s.
//
// The first rationing attempt made things WORSE (59% -> 75% palette) because it
// gated EVERY level, starving the coarse levels the borrow path draws from. The
// scar-tissue post-mortem states the correction exactly: "apply the ring gate
// ONLY to the finest levels and let coarser levels always fetch in full — they
// are few and they are the source. Gate the many, never the few."
//
// This is that retry:
//   z <= SOURCE_MAX_ZOOM : fetch own imagery for EVERY tile (the few, ~93; they
//                          are the pyramid's base and are never rationed)
//   z >  SOURCE_MAX_ZOOM : own imagery only within DEEP_OWN_RINGS of the
//                          look-at (sharp where you are actually looking);
//                          everything beyond BORROWS the parent's photo via the
//                          existing _borrowImagery / waiter machinery
//
// Net: ~455 requests -> ~190, and the whole view turns photographic on the z10
// timetable (~7s) at coarse resolution, sharpening centre-out — instead of a
// 19-second patchwork of palette and photo.
const SOURCE_MAX_ZOOM = 10;
const DEEP_OWN_RINGS  = 3;              // (2r+1)^2 = 49 sharp tiles per deep level
function _ownImageryRingsFor(zoom) {
    return zoom <= SOURCE_MAX_ZOOM ? Infinity : DEEP_OWN_RINGS;
}
const ANCESTOR_IMG_N   = 128;
// 64 -> 160 (2026-07-25, progressive imagery). 64 was SMALLER than the ~93 z10
// tiles a close view loads, so parents were evicted before their children could
// borrow — measured as the 0.9% hit rate that sank the first rationing attempt.
// The cache must comfortably hold every source-level tile in a view, or the
// borrow path starves by construction. 160 x 64KB = ~10MB per level. 
const ANCESTOR_PER_LVL = 160;
const _ancestorImg     = new Map();   // zoom → Map("z/tx/ty" → Uint8ClampedArray)
/** Nearest-neighbour RGBA downscale. Cheap on purpose — this is a fallback image
 *  that will itself be read at quarter scale, so box filtering buys nothing. */
function _downscaleRGBA(src, srcN, dstN) {
    if (srcN === dstN) return src.slice();
    const out = new Uint8ClampedArray(dstN * dstN * 4);
    for (let y = 0; y < dstN; y++) {
        const sy = Math.min(srcN - 1, (y * srcN / dstN) | 0);
        for (let x = 0; x < dstN; x++) {
            const sx = Math.min(srcN - 1, (x * srcN / dstN) | 0);
            const s = (sy * srcN + sx) * 4, d = (y * dstN + x) * 4;
            out[d] = src[s]; out[d+1] = src[s+1]; out[d+2] = src[s+2]; out[d+3] = src[s+3];
        }
    }
    return out;
}
// Tiles that wanted ancestor imagery before any ancestor existed. Levels stream
// concurrently, so a child routinely builds before its parent finishes — without
// this they would stay on the elevation palette forever, which is the failure the
// whole borrowing mechanism exists to avoid. Bounded: a camera sweep must not grow
// an unbounded list of stale intentions.
const MAX_BORROW_WAITERS = 400;
const _borrowWaiters = [];
let _borrowDrains = 0;

/** Re-attempt waiters now that new ancestor imagery has landed.
 *  BOUNDED: a full rescan on every put made 18,879 lookups in one sweep. Waiters
 *  are retried a few at a time from the front; anything not reached stays queued
 *  for the next put, so nothing is dropped, it just costs less per event. */
const DRAIN_PER_PUT = 24;
function _drainBorrowWaiters() {
    if (!_borrowWaiters.length) return;
    _borrowDrains++;
    // Iterate backwards so successful entries can be spliced out in place.
    const start = Math.max(0, _borrowWaiters.length - DRAIN_PER_PUT);
    for (let i = _borrowWaiters.length - 1; i >= start; i--) {
        const w = _borrowWaiters[i];
        // Drop stale waiters whose tile has since been evicted or rebuilt.
        if (!w.cache._tiles.has(w.key)) { _borrowWaiters.splice(i, 1); continue; }
        if (w.cache._borrowImagery(w.key, w.tx, w.ty, w.qmData, w.priority)) {
            _borrowWaiters.splice(i, 1);
        }
    }
}

function _ancestorPut(z, tx, ty, data, size = ANCESTOR_IMG_N) {
    let lvl = _ancestorImg.get(z);
    if (!lvl) { lvl = new Map(); _ancestorImg.set(z, lvl); }
    const k = `${tx}/${ty}`;
    // Map preserves insertion order, so deleting first makes re-insert = "touch",
    // giving LRU eviction for free.
    if (lvl.has(k)) lvl.delete(k);
    // Per-entry size (2026-07-25): SOURCE-grid images are stored at native 512,
    // because a z12 grandchild reads a quarter-of-a-quarter of them — from a
    // 128-cached image that is an effective 32 pixels, which reads as smear. From
    // 512 it is an effective 128, a legitimate coarse photograph.
    lvl.set(k, { data, size });
    while (lvl.size > ANCESTOR_PER_LVL) lvl.delete(lvl.keys().next().value);
    // New coverage may unblock descendants that built before this arrived.
    _drainBorrowWaiters();
}
/**
 * Find the nearest cached ancestor covering this tile.
 * Tile (tx,ty) at zoom z maps to (tx>>1, ty>>1) at z-1 — the geographic grid
 * halves per level in BOTH axes, so the ancestor chain is pure integer shifts.
 * @returns {{data, u0, v0, scale, size}|null}
 */
// ── Source-grid imagery (2026-07-25) ─────────────────────────────────────────
// The progressive-imagery design assumed the SOURCE level (z10) loads and thereby
// fills the ancestor cache. Measured cold at Buenos Aires: it does not — at deep
// zoom z10 is DARK (targetOpac 0) and dark levels load nothing, so the ancestor
// cache held z11/z12 ring tiles only and the borrow hit rate was 0.1%. The
// pyramid had no base.
//
// So the base is fetched EXPLICITLY: when a deep tile skips its own imagery, it
// requests its z10-grid ancestor image instead (deduplicated — a whole close view
// needs only ~24 of them, and each serves 4 z11 children and 16 z12
// grandchildren). Stored at native 512 so grandchildren still read an effective
// 128 pixels. Every landed source image drains the borrow waiters, painting all
// registered fringe tiles photographic at once.
const _sourceImgInflight = new Set();
let _sourceImgFetched = 0;
function _ensureSourceImagery(zoom, tx, ty) {
    const up = zoom - SOURCE_MAX_ZOOM;
    if (up <= 0) return;
    const ax = tx >> up, ay = ty >> up;
    const key = `${SOURCE_MAX_ZOOM}/${ax}/${ay}`;
    if (_ancestorImg.get(SOURCE_MAX_ZOOM)?.has(`${ax}/${ay}`)) return;
    if (_sourceImgInflight.has(key)) return;
    _sourceImgInflight.add(key);
    const bb = geoTileBounds(ax, ay, SOURCE_MAX_ZOOM);
    const url = `${IMAGERY_EXPORT_URL}?bbox=${bb.west},${bb.south},${bb.east},${bb.north}`
              + `&bboxSR=4326&imageSR=4326&size=512,512&format=jpg&f=image`;
    fetchImagery(url).then(imageryBitmap).then(bmp => {
        if (!bmp) return;
        try {
            const cv = new OffscreenCanvas(512, 512);
            const g  = cv.getContext('2d', { willReadFrequently: true });
            g.drawImage(bmp, 0, 0, 512, 512);
            const d = g.getImageData(0, 0, 512, 512).data;
            bmp.close();
            if (!_isBlankImagery(d)) {
                _ancestorPut(SOURCE_MAX_ZOOM, ax, ay, d, 512);
                _sourceImgFetched++;
            }
        } catch (_) {}
    }).catch(() => {}).finally(() => _sourceImgInflight.delete(key));
}

let _ancHits = 0, _ancMisses = 0, _ancBorrows = 0;
function _ancestorFor(z, tx, ty, maxUp = 3) {
    let ax = tx, ay = ty;
    for (let up = 1; up <= maxUp; up++) {
        ax >>= 1; ay >>= 1;
        const entry = _ancestorImg.get(z - up)?.get(`${ax}/${ay}`);
        if (entry) {
            // Fraction of the ancestor this tile occupies, and where. `tx - (ax<<up)`
            // is this tile's index within the ancestor's 2^up × 2^up block.
            const span = 1 << up;
            const ix = tx - (ax << up);      // 0 = westernmost child
            const iy = ty - (ay << up);      // 0 = SOUTHERNMOST child (ty grows north)
            // ⚠ THE V AXIS IS FLIPPED, and this is not cosmetic. The builder derives
            // fv from `z0 = latToSceneZ(north)` → `z1 = latToSceneZ(south)`, so fv=0
            // is NORTH. But tile ty counts NORTHWARD from the south pole. Using iy
            // directly mirrors every borrowed tile vertically — which looks entirely
            // plausible in isolation and is only wrong where it meets its neighbours,
            // i.e. exactly the bug that ships. Verified against tilePointsBuilder
            // lines 166-167; pinned by a test.
            _ancHits++;
            return { data: entry.data, size: entry.size, scale: 1 / span,
                     u0: ix / span,
                     v0: (span - 1 - iy) / span };
        }
    }
    _ancMisses++;
    return null;
}

// Debug handle. The first version of this cache silently never hit — a shared LRU
// that the finest level always evicted — and nothing recorded that, so it looked
// like it worked. Counters exist so "did the fallback actually fire?" is a question
// with an answer.  window.vg1Ancestry()
if (typeof window !== 'undefined') {
    window.vg1Ancestry = () => ({
        hits: _ancHits, misses: _ancMisses, borrowsApplied: _ancBorrows,
        hitRate: (_ancHits + _ancMisses) ? +(100 * _ancHits / (_ancHits + _ancMisses)).toFixed(1) : 0,
        cachedPerLevel: [..._ancestorImg].map(([z, m]) => `z${z}:${m.size}`),
        approxMB: +([..._ancestorImg].reduce((a, [, m]) => a + m.size, 0)
                    * ANCESTOR_IMG_N * ANCESTOR_IMG_N * 4 / 1048576).toFixed(1),
    });
}

// Shared across every LOD level's cache on purpose: the endpoint rate-limits the
// whole app, not one zoom level, so evidence from z9 is evidence for z10 too. A
// per-cache breaker would need `threshold` blanks on EACH level before any of them
// reacted, which is exactly the burst we're trying not to send.
// Debug handle: window.vg1ImgBreaker.stats(performance.now())
const _imgBreaker = new ImageryCircuitBreaker();

// ── Built-geometry cache (2026-07-25) ────────────────────────────────────────
// The service worker already caches SOURCE bytes (~4ms vs ~1500ms on a hit), but
// a hit still pays the build: measured 1339ms per z12 tile, 986 seconds of build
// work for one NYC dive. This caches the OUTPUT, so a revisit skips fetch AND
// build. See tileGeometryCache.js — the dangerous part is the key, not the IO.
// Debug: window.vg1GeoCache.stats
const _geoCache = new TileGeometryCache();
if (typeof window !== 'undefined') window.vg1GeoCache = _geoCache;

/** Fingerprint the inputs that change what buildTilePoints emits. Anything
 *  missing here becomes silently stale geometry after a settings change. */
function _geoFingerprint(cfg, hasImagery) {
    return fingerprint({
        zoom: cfg.zoom, ptsBudget: cfg.ptsBudget, imgSize: cfg.imgSize,
        activeCap: ACTIVE_PTS_CAP, terrainMode: activeTerrainMode(),
        photoBlend: TILESTREAM.PHOTO_BLEND, procEnabled: TILESTREAM.PROC?.ENABLED !== false,
        procRelief: TILESTREAM.PROC?.RELIEF ?? 0.004,
        saturation: TILESTREAM.POINT_SATURATION, hasImagery,
    });
}
if (typeof window !== 'undefined') window.vg1ImgBreaker = _imgBreaker;
function _isBlankImagery(data) {
    let n = 0, s = 0, s2 = 0;
    // Prime-ish stride so a regular pattern in the image can't alias the sample.
    for (let i = 0; i < data.length; i += 4 * 97) {
        const l = (data[i] + data[i + 1] + data[i + 2]) / 3;
        s += l; s2 += l * l; n++;
    }
    if (n < 16) return false;                       // too few samples to judge
    const mean = s / n;
    const sd   = Math.sqrt(Math.max(0, s2 / n - mean * mean));
    if (sd >= BLANK_IMAGERY_SD) return false;
    if (++_blankImageryHits <= 5) {
        console.warn(`[Tiles] blank imagery rejected (sd ${sd.toFixed(2)}, mean ${mean.toFixed(0)}) — retrying`);
    }
    return true;
}

// Decode a fetched imagery Response into an ImageBitmap (or null on any failure).
// Shared by the points and mesh load paths.
async function imageryBitmap(res) {
    if (!res || !res.ok) return null;
    try { return await createImageBitmap(await res.blob()); }
    catch (_) { return null; }
}

// ── Throttled, priority terrain (QM) fetch (2026-07-15) ───────────────────────
// MEASURED on the live app: building points is ~2.5ms/tile (negligible), but
// each Cesium terrain fetch is ~1.5s and a single dive fires 350+ of them at
// once — saturating the browser's connection pool so tiles trickle in over
// several seconds (the "slow + patchy" load). Fix: cap concurrency and serve
// the NEAREST tiles first (priority = squared tile distance from the look-at),
// so the ground you're looking at fills in immediately and the fringe follows.
// High cap: Cesium's CDN is HTTP/2 and handles many concurrent streams fine, so
// this isn't about limiting throughput — it's the PRIORITY QUEUE below serving
// nearest tiles first so the visible ground fills in before the distant fringe.
// (Measured: throttling to 8 actually cut throughput ~15×; 48 keeps it flowing.)
const QM_MAX_CONCURRENT = 48;
// QUEUE CAP (2026-07-21, same root cause as the build-queue fix below — found
// via the SAME live test, one stage earlier): `_loading.add(key)` (in
// `_loadTile`) happens BEFORE this queue is even reached, and stays held for
// this job's entire time waiting here, PLUS its fetch, PLUS (if points mode)
// its wait in the build queue. This queue had no cap and each job's priority
// is a frozen snapshot from whenever it was queued — under sustained candidate
// churn (fast movement, or a slow/throttled connection stretching out how long
// jobs sit here) it can grow far faster than QM_MAX_CONCURRENT drains it.
// LIVE-CONFIRMED: capping only the build queue (below) was NOT enough — under
// a throttled-network test, `_loading` still ballooned to 2421 entries at one
// LOD level, because the actual growth was happening HERE, one stage earlier.
// Same fix as the build queue: cap the queue, and when a new job would exceed
// it, evict the current worst-priority (most stale) job and REJECT its
// promise instead of leaving it to rot — `_loadTile`'s catch block already
// treats non-404/non-parse errors as transient (no permanent blacklist), so a
// cancelled tile is simply free to be requested again if it becomes relevant.
const MAX_QM_QUEUE = 400;
let _qmActive = 0;
const _qmQueue = [];
function _qmPump() {
    while (_qmActive < QM_MAX_CONCURRENT && _qmQueue.length) {
        // pick the lowest-priority (nearest) queued job
        let bi = 0;
        for (let i = 1; i < _qmQueue.length; i++) {
            if (_qmQueue[i].priority < _qmQueue[bi].priority) bi = i;
        }
        const job = _qmQueue.splice(bi, 1)[0];
        _qmActive++;
        job.run();
    }
}
function fetchTerrain(url, headers, priority = 0) {
    return new Promise((resolve, reject) => {
        const run = async () => {
            try { const r = await fetch(url, { headers, mode: 'cors' }); _qmActive--; _qmPump(); resolve(r); }
            catch (e) { _qmActive--; _qmPump(); reject(e); }
        };
        if (_qmQueue.length >= MAX_QM_QUEUE) {
            let wi = 0;
            for (let i = 1; i < _qmQueue.length; i++) {
                if (_qmQueue[i].priority > _qmQueue[wi].priority) wi = i;
            }
            if (_qmQueue[wi].priority > priority) {
                const evicted = _qmQueue.splice(wi, 1)[0];
                evicted.reject(new Error('cancelled: qm queue full'));
            } else {
                reject(new Error('cancelled: qm queue full'));
                return;
            }
        }
        _qmQueue.push({ priority, reject, run });
        _qmPump();
    });
}

// ── Frame-budgeted point-geometry build queue (2026-07-21, "FPS drops when I
// change the angle") ──────────────────────────────────────────────────────────
// LIVE-MEASURED root cause: _buildPoints (below) costs ~40ms/call at current
// point budgets (26k-34k barycentric samples/tile, each with FBM procedural
// relief + colour variation + optional imagery blend) — 16x the ~2.5ms this
// file's older comments assumed, almost certainly because ptsBudget was raised
// ~2x (the "DENSITY PASS" note above) and per-sample ocean-margin trimming/
// jitter were added AFTER that number was measured, without re-checking it.
// _loadTile used to call it synchronously, inline, the instant a tile's QM
// fetch resolved — fine for a static view, but ROTATING the camera sweeps the
// forward-shifted load anchor across a much wider arc than panning/zooming
// does, so a fast rotate-drag surfaces dozens of brand-new candidate tiles
// within 1-2 real frames. Every one of those then ran its own ~40ms build
// synchronously inside whatever rAF callback its fetch happened to resolve in
// — confirmed live via instrumentation: normal frame time ~18ms, spiking to
// 73-84ms (2+ builds stacked in one frame) during a rotate-drag, with ZERO new
// network activity during the spike — the cost was 100% this CPU-bound build,
// not loading. Network fetches already get exactly this treatment (_qmQueue /
// _imgQueue above); this is the same idea for the geometry build itself. Every
// queued build job runs through here, nearest-tile-first (same priority
// convention as the QM queue), draining for up to BUILD_BUDGET_MS of wall
// time per real animation frame, then yielding — whatever's left waits for the
// next frame. This changes WHEN a tile's points get built, never what they
// look like once built.
// UNBOUNDED-BACKLOG FIX (2026-07-21, found via the thrash + throttled-network
// tests): the queue above has no size cap and every job's `priority` is a
// snapshot taken once, at enqueue time, of distance-from-anchor — it's never
// re-scored against where the camera actually is by the time the job's turn
// comes up. Under heavy candidate churn (rapid teleporting, or a slow
// connection stretching out how long tiles sit fetched-but-not-yet-built) the
// queue can grow far faster than BUILD_BUDGET_MS can drain it. LIVE-CONFIRMED:
// after a 90-teleport thrash test, one LOD level had 1022 UNIQUE tiles stuck
// in `_loading` — for a level whose loadRadius caps real candidates at 25.
// Those were jobs queued for locations abandoned minutes earlier; because
// nothing ever removed them, `_loadTile`'s `finally { this._loading.delete
// (key) }` never ran for any of them — a tile from a spot you're not even
// looking at anymore can permanently occupy a `_loading` slot, and if you
// scroll back to that exact tile later it looks like it's "loading" forever
// (it's not — it's just buried behind hundreds of stale jobs ahead of it).
// Fix: cap the queue; when a new job would exceed the cap, evict the
// CURRENT worst-priority (farthest / most stale) job instead of growing
// further, and resolve ITS promise with `null` (cancelled) rather than
// leaving it to rot — `_loadTile` treats a `null` result as "never mind,
// this tile isn't wanted anymore" and returns early, so its `finally` still
// runs and `_loading` still clears for it. Net effect: the queue self-bounds,
// and abandoning an area cleanly releases its in-flight tiles instead of
// leaking `_loading` slots for them forever.
const BUILD_BUDGET_MS   = 6;
const MAX_BUILD_QUEUE   = 300;   // generous headroom over any single-level loadRadius grid
const _buildQueue = [];

// ── Cumulative diagnostics (2026-07-24) ──────────────────────────────────────
// Monotonic counters for hitchRecorder, which reports the DELTA across a stalled
// frame — so these must only ever increase (a per-frame counter reset by us would
// read 0 by the time the recorder samples it). Cheap: four number increments.
const _stats = { builds: 0, buildMs: 0, worstBuildMs: 0, overBudgetPumps: 0 };

function _pumpBuildQueue() {
    const t0 = performance.now();
    // NOTE the budget is checked BETWEEN jobs, never inside one. A single
    // job.run() is ~40ms by this file's own measurements, so this loop can and
    // does overshoot BUILD_BUDGET_MS by a whole job — the budget bounds how many
    // builds start, not how long the pump takes. That is inherent to running a
    // synchronous build on the main thread; the counters below make the overshoot
    // visible instead of leaving it to be rediscovered.
    while (_buildQueue.length && performance.now() - t0 < BUILD_BUDGET_MS) {
        let bi = 0;
        for (let i = 1; i < _buildQueue.length; i++) {
            if (_buildQueue[i].priority < _buildQueue[bi].priority) bi = i;
        }
        const job = _buildQueue.splice(bi, 1)[0];
        const jt0 = performance.now();
        job.run();
        const jms = performance.now() - jt0;
        _stats.builds++;
        _stats.buildMs += jms;
        if (jms > _stats.worstBuildMs) _stats.worstBuildMs = jms;
    }
    if (performance.now() - t0 > BUILD_BUDGET_MS) _stats.overBudgetPumps++;
    requestAnimationFrame(_pumpBuildQueue);
}

// Report to the hitch recorder. Registered at module load so it is active for the
// whole session including boot, where the worst stalls live.
hitchRecorder.registerProbe('tiles', (o) => {
    o.builds          = _stats.builds;
    o.buildMs         = Math.round(_stats.buildMs);
    o.overBudgetPumps = _stats.overBudgetPumps;
    // Queue depths are absolute, not cumulative — a NEGATIVE delta here means the
    // queue drained across the stalled frame, which is exactly what you want to
    // see when attributing a stall to tile building.
    o.buildQueue      = _buildQueue.length;
    o.qmQueue         = _qmQueue.length;
    o.imgQueue        = _imgQueue.length;
    o.qmActive        = _qmActive;
    o.imgActive       = _imgActive;
});
requestAnimationFrame(_pumpBuildQueue);
// Queues fn to run inside the budgeted drain above; resolves with fn's return
// value once it actually runs, or with `null` if it gets evicted for space
// before its turn. `priority` should be squared distance from the load
// anchor, same convention as fetchTerrain, so the tiles you're actually
// looking at get built before distant fringe candidates.
function _queueBuild(fn, priority = 0) {
    return new Promise(resolve => {
        if (_buildQueue.length >= MAX_BUILD_QUEUE) {
            let wi = 0;
            for (let i = 1; i < _buildQueue.length; i++) {
                if (_buildQueue[i].priority > _buildQueue[wi].priority) wi = i;
            }
            if (_buildQueue[wi].priority > priority) {
                const evicted = _buildQueue.splice(wi, 1)[0];
                evicted.resolve(null);   // cancelled — let its _loadTile clean up
            } else {
                // The new job is itself the worst — don't even queue it.
                resolve(null);
                return;
            }
        }
        _buildQueue.push({ priority, resolve, run: () => resolve(fn()) });
    });
}

// ── LOD tier configuration ────────────────────────────────────────────────────
// tileSeg is intentionally absent — QM provides adaptive mesh density itself.
// RECALIBRATED 2026-07-12 for the geographic grid. The old bands (z6→z13) were
// tuned against the broken mercator indexing, ~4 zoom levels too deep: on the
// correct grid a z12 tile is ~0.037 scene units wide, so the loaded 3×3 patch
// covered a postage stamp of the view. Rule used here: at each level's showAlt,
// the (2R+1)² loaded grid spans roughly the visible ground (span ≈ 1.4·camY).
// Uncovered fringes are harmless — in points mode the base splat never fades.
// ALL-POINTS LADDER (2026-07-12, Jamal's final call): the point cloud IS the
// product. Streamed Cesium DEM (zig-zag-correct geometry) + per-point satellite
// color integrate INTO the cloud as progressively denser, finer, truer points.
// The base splat never fades (solidCoverage skips points levels → uFade stays
// 1), so there are no holes and no style break — transitions are just density.
const LOD_LEVELS = [
    { zoom:  3, showAlt: 200,  fadeBand: 50,  maxActive: 100, loadRadius: 4, render: 'points', ptsBudget:  6000, ptSize: 0.020,  imgSize: 256 },   // tile 18.8u
    { zoom:  4, showAlt:  75,  fadeBand: 20,  maxActive: 100, loadRadius: 4, render: 'points', ptsBudget:  6000, ptSize: 0.018,  imgSize: 256 },   // tile 9.4u
    { zoom:  5, showAlt:  37,  fadeBand: 10,  maxActive: 100, loadRadius: 4, render: 'points', ptsBudget:  9000, ptSize: 0.017,  imgSize: 512 },   // tile 4.7u — sizes up for overlap smoothness 2026-07-13
    { zoom:  6, showAlt:  18,  fadeBand:  5,  maxActive: 100, loadRadius: 4, render: 'points', ptsBudget: 12000, ptSize: 0.013,  imgSize: 512 },   // tile 2.3u — sizes up for overlap smoothness 2026-07-13
    // BELOW y≈9: ALL-POINTS (2026-07-15, Jamal's call after the mesh tiles kept
    // checkerboarding). The black tiles were NOT 404s and NOT bad imagery —
    // confirmed via live network inspection (every QM tile 200, every ArcGIS
    // tile ~145 avg brightness). It was a render-state/crossfade race in the
    // MESH path. Points sidestep it entirely: satellite color is baked per point
    // at build time, so there's no async imagery drape, no tile-vs-tile z-fight,
    // and no eviction-black. AND because solidCoverage() only fades the base
    // splat for MESH levels, an all-points ladder means the base cloud NEVER
    // fades — it permanently backstops every tile, so no gap can show black or
    // ocean. Tradeoff (2026-07-13 note): at extreme close range discrete dots
    // don't fuse into a solid surface — mitigated here by rising point density.
    // Tunable live: window.tileStream._caches[i]._cfg.{ptsBudget,ptSize}.
    // DETAIL PASS v2 2026-07-15: for a SOLID look at extreme close-up, ptSize is
    // held HIGH (~0.010–0.015) all the way down instead of shrinking — big
    // overlapping points fuse into a surface as you dive (tiny dots never can).
    // Budget climbs toward the deepest levels for fine detail. No-mesh path to a
    // solid close-up; if street level still isn't solid enough, add a mesh rung
    // at z12. Watch FPS at z11/z12 (highest budgets) — trim ptsBudget first.
    // Live-tune point size (no reload):
    //   window.tileStream._caches.forEach(c=>c._tiles.forEach(t=>{if(t.mesh.material.size)t.mesh.material.size*=1.2}))
    // LOD THRESHOLDS RAISED 2026-07-15: diagnosed live — every level loaded fully
    // (80-100 tiles, 0 misses) but the finer levels rendered at ZERO opacity;
    // detail was gated behind an absurdly close dive (z12 only lit below y=0.28).
    // showAlt values here reveal each finer level at a more normal zoom-in
    // altitude, so detail actually appears as you approach. maxActive raised so
    // the wider active area doesn't evict visible tiles; base cloud backstops any
    // fringe past loadRadius. Tunable live: _caches[i]._cfg.showAlt.
    // SPEED PASS 2026-07-15: budgets cut ~55% and maxActive lowered — building
    // 40-52k photo-colored points per tile on the main thread was janking the
    // load. The large ptSize (held high) means fewer points still fuse into a
    // surface, so this is much faster to build/load with little visible loss.
    // The coming procedural layer restores fine detail without per-point cost.
    // loadRadius 4→3 (2026-07-15): a 7×7 patch instead of 9×9 = ~40% fewer tile
    // fetches per view. Measured: fetch is the whole cost (~1.7s/tile, ~190/view),
    // so fewer tiles is the only real lever on FIRST-load speed. Nearest-first
    // priority + the base-cloud backstop keep the trimmed edge coherent, and the
    // SW cache makes every revisit instant regardless.
    // DENSITY PASS 2026-07-15: budgets ~2× — building is 2.5ms/tile (measured),
    // so density is nearly free; the sparse-dots-in-flats look was under-sampling,
    // not a speed limit. Network is the only cost and density doesn't add fetches.
    { zoom:  7, showAlt: 13.0, fadeBand: 4.0,  maxActive: 60, loadRadius: 3, render: 'points', ptsBudget: 26000, ptSize: 0.0150, imgSize: 256 },   // tile 1.2u
    { zoom:  8, showAlt:  7.5, fadeBand: 2.2,  maxActive: 60, loadRadius: 3, render: 'points', ptsBudget: 30000, ptSize: 0.0135, imgSize: 256 },   // tile 0.6u
    // imgSize 256→512 on the close levels (2026-07-15): per-point satellite
    // colour was low-res upscaled at close zoom = smeary flats. 512 sharpens the
    // colour; the SW cache absorbs the one-time extra fetch cost on revisits.
    { zoom:  9, showAlt:  4.2, fadeBand: 1.2,  maxActive: 60, loadRadius: 3, render: 'points', ptsBudget: 34000, ptSize: 0.0120, imgSize: 512 },   // tile 0.29u
    // ── Deeper levels z10-z12 DISABLED (2026-07-18) ──────────────────────────────
    // Product decision: z9 is the current maximum detail. The camera is capped at
    // this height (sceneSetup.js minDistance = 2.3), so we don't dive past the z9
    // satellite level — z9 covers every landmass globally (Cesium DEM + Sentinel-2
    // imagery + the flat-tile fallback), which is the "every piece of land at this
    // detail" target. To re-enable deep dives later, restore these three rows and
    // drop minDistance back to ~0.08:
    // z10 RE-ENABLED 2026-07-24. The 07-18 decision to cap at z9 was partly about
    // cost, and that calculus changed the same day: point building moved to a
    // worker pool, the active/parent budget halved, loading became frustum-shaped,
    // and tiles are now carved to the coastline. z11/z12 stay off — try one rung
    // at a time and measure, because the documented risk is Cesium's deep-zoom QM
    // coverage thinning out over flatter ground (404s → holes), not frame cost.
    // Watch cache._unavailable (404 count) before adding another level.
    { zoom: 10, showAlt: 2.3, fadeBand: 0.6,  maxActive: 60, loadRadius: 3, render: 'points', ptsBudget: 40000, ptSize: 0.0112, imgSize: 512 },
    // z11 RE-ENABLED 2026-07-25 — the reason is legibility, not detail for its own
    // sake. At z10 a tile spans ~16km into 512px over Tokyo: ~31 m/pixel, so roads,
    // blocks and buildings are all sub-pixel and a dense city resolves to grey
    // speckle. z11 halves that to ~15 m/px, where port structure and major roads
    // start to read. Gate check before enabling: effective resolution 0.00034u vs
    // the base cloud's 0.0732u — ~215x finer, nowhere near tripping LEVEL_BEATS_BASE.
    // NOTE this required lowering controls.minDistance (sceneSetup.js) as well:
    // showAlt 1.3 against a 1.15 minimum orbit distance meant z11 could only ever
    // reach ~43% opacity — lit, but never the surface you actually look at.
    { zoom: 11, showAlt: 1.3, fadeBand: 0.35, maxActive: 60, loadRadius: 3, render: 'points', ptsBudget: 46000, ptSize: 0.0106, imgSize: 512 },
    // z12 RE-ENABLED 2026-07-25 — the deepest rung, and probably the last one that
    // can exist: probing the Ion origin found z13 returning 404 everywhere tested,
    // so z12 looks like the floor of Cesium World Terrain rather than our choice.
    // 7.8 m/px at 512 (vs z11's 15.5, z10's 31) — this is where a city stops being
    // grey sprawl and blocks become visible.
    // Pre-flight checks, both of which caught real traps on earlier rungs:
    //   • LEVEL_BEATS_BASE: effective resolution 0.000161u vs base 0.0732u — 456x
    //     finer, passes comfortably, so it will not suppress itself.
    //   • OPACITY REACHABILITY: fully lit only below effAlt showAlt-fadeBand = 0.48.
    //     minDistance was 0.60, which would have capped z12 at 45% opacity — lit but
    //     never the surface you look at, and easy to misread as "z12 did nothing".
    //     Lowered to 0.35 in sceneSetup.js alongside this.
    // Terrain coverage above 60N is gated separately (terrainCoverage.js) — z12 has
    // no data there, same as z9-z11.
    // ── MESH RENDERING TRIED AND REJECTED (2026-07-25) ──────────────────────
    // z12 was briefly switched to render:'mesh' to chase Google-Earth-style
    // continuity — quantized mesh gives exact shared edge vertices and skirts, so
    // a textured surface is seamless by construction where points never can be.
    // It built correctly (triangle tiles, no errors). Jamal rejected it on look:
    // the point-cloud aesthetic is the map's identity and is worth more than
    // seamlessness. Reverted to points, deliberately and not because it failed.
    //
    // KEEP THE BUG FIX IT SURFACED. Getting here exposed a real defect in
    // applyMeshImagery: it conflated "tile evicted" with "tile rebuilt while
    // imagery was in flight", returning success for both. The second case leaves
    // a mesh tile permanently untextured with no retry and no failure record —
    // almost certainly the "mesh tiles kept checkerboarding" that disabled mesh
    // mode on 2026-07-15. That fix stays in, along with the blank-imagery guard
    // the old comment asked for. If mesh is ever revisited, it starts from a
    // sounder place than it did today.
    //
    // If close-zoom load speed becomes the problem, the agreed lever is to drop
    // z12 entirely and let z11 be the deepest level — NOT to change how tiles are
    // rendered.
    { zoom: 12, showAlt: 0.7, fadeBand: 0.22, maxActive: 60, loadRadius: 3, render: 'points', ptsBudget: 52000, ptSize: 0.0102, imgSize: 512 },
];
// Original per-level point budgets, captured before the adaptive coverage logic
// in update() caps the active/parent levels. Non-active levels are restored to
// these each frame so a level that was capped while active returns to full
// density when it steps back to being a backdrop.
const BASE_BUDGET = LOD_LEVELS.map(c => c.ptsBudget);

// ── Active/parent point budget (2026-07-24: 28000 → 14000) ───────────────────
// Points per tile for the two levels actually doing the work. This is the single
// biggest lever on how fast a close-in view FILLS, because tile building is
// synchronous main-thread work: ~40ms per 28,000-point tile, and a close view has
// ~242 active tiles, so roughly 10 SECONDS of CPU regardless of network speed.
// BUILD_BUDGET_MS only bounds how many builds START — it is checked between jobs,
// never inside one — so every build overshoots it by ~34ms.
//
// Halving is visually free because the tiles were massively oversampled. At z9 the
// tile span is 0.293u and ptSize is 0.0120 world units, so:
//     28,000 pts → 0.00175u spacing → point size is ~6.9× the gap
//     14,000 pts → 0.00248u spacing → point size is ~4.8× the gap
// Still heavy overlap; nowhere near opening holes. And z9 stays ~29× finer than
// the base splat cloud (0.0732u effective), so this comes nowhere near tripping
// LEVEL_BEATS_BASE — verified for every level before changing it.
//
// Net effect: same total geometry across twice as many tiles is affordable, each
// build costs half as much, and the pump stalls the frame loop far less.
// Raise back toward 28000 if close-up terrain ever looks sparse; the honest fix
// for the underlying cost is moving _buildPoints into a worker (terrainWorker
// already establishes that pattern), which would make this constant much less
// load-bearing.
// RAISED 14000 → 40000 (2026-07-25). Two things that were true when 14000 was set
// are no longer true, and the note above anticipated both:
//
//  1. "the honest fix for the underlying cost is moving _buildPoints into a worker
//     ... which would make this constant much less load-bearing." That happened —
//     tilePointsPool.js. Build cost no longer lands on the frame loop at all.
//  2. The fill cost that motivated halving is gone. Points were overlapping 39x at
//     z12; clampPointSize now caps overlap at 6x, cutting point AREA ~30x. Frame
//     time went 36.1 → 18.7 ms on that change alone.
//
// And the measurement that says 14000 is now the binding constraint, taken live at
// Tokyo z12 (effAlt 0.385, tile = 197x197 px on screen):
//     imagery 512²  →  points 118²  →  screen 197²
// Points were 1.67x COARSER THAN THE SCREEN — 0.36 colour samples per pixel. The
// tile was soft by construction, and no imagery improvement could have fixed it.
// 197² ≈ 38,700, so 40000 puts roughly one point per screen pixel. That is the
// ceiling worth having: beyond it, points cost memory without adding anything the
// display can show, and the right move becomes textured MESH tiles (one sample per
// screen pixel by construction) rather than more points.
//
// Cost accepted: ~24 bytes/point, so a 181-tile z12 view goes ~61MB → ~174MB of
// geometry. Watch heap; if it bites, the answer is fewer ACTIVE tiles (maxActive),
// not coarser ones — sparse tiles look worse than fewer tiles.
const ACTIVE_PTS_CAP = 40000;

// Tiles retained by a level that is currently drawing NOTHING (targetOpac 0).
// Small, but deliberately not zero — see the eviction note in update().
const DARK_LEVEL_KEEP = 12;

// ── DEM land mask (2026-07-24) ───────────────────────────────────────────────
// Resolution of the per-tile land/ocean mask handed to the point builder. 32×32
// = 1024 getTrueElevation() calls per tile; those are plain array lookups into
// the already-resident DEM, so the cost is microseconds and it happens once per
// tile build, not per frame. At z9 a tile spans ~0.293 scene units, so a cell is
// ~0.009u — the same order as the point spacing, which is the right granularity
// for carving a coastline.
const LAND_MASK_N = 32;
// Elevation at or above this counts as land. Matches the per-sample OCEAN_MARGIN_M
// used inside the builder so the two trims agree rather than fighting.
//
// −20 → TILESTREAM.LAND_MARGIN_M (0 m), 2026-07-25. The old value called
// anything shallower than 20 m "land" and drew points over it, which is 13.4%
// of the ocean AREA inside the Sunda box and most of the water visible from a
// low camera over the shelf — the speckled blue-green rectangles hanging over
// open water in Jamal's screenshots, at a spot the HUD read as DEP −3 M. This
// is the same depth-as-land confusion as the old _isPureOceanTile gate, just
// applied per mask cell instead of per tile. Land is elevation ≥ 0; the small
// epsilon needed so a noisy QM shoreline triangle doesn't lose its beach lives
// in the builder's own OCEAN_MARGIN_M, which is the right place for it.
const LAND_MASK_MARGIN_M = TILESTREAM.LAND_MARGIN_M ?? 0;

// Sample the authoritative global DEM across a tile's footprint.
// Returns { mask: Uint8Array(N*N), landCells } — 1 = land, 0 = ocean.
// Row 0 is the NORTH edge, matching how the builder indexes scene Z.
function buildTileLandMask(tx, ty, zoom) {
    const b  = geoTileBounds(tx, ty, zoom);
    const x0 = lonToSceneX(b.west),  x1 = lonToSceneX(b.east);
    const z0 = latToSceneZ(b.north), z1 = latToSceneZ(b.south);
    const mask = new Uint8Array(LAND_MASK_N * LAND_MASK_N);
    let landCells = 0;
    for (let v = 0; v < LAND_MASK_N; v++) {
        // Cell CENTRE, not corner: sampling corners biases a coastline cell toward
        // whichever side the corner happens to fall on.
        const sz = z0 + ((v + 0.5) / LAND_MASK_N) * (z1 - z0);
        for (let u = 0; u < LAND_MASK_N; u++) {
            const sx = x0 + ((u + 0.5) / LAND_MASK_N) * (x1 - x0);
            const land = getTrueElevation(sx, sz) >= LAND_MASK_MARGIN_M ? 1 : 0;
            mask[v * LAND_MASK_N + u] = land;
            landCells += land;
        }
    }
    return { mask, landCells };
}

// ── "Beats the base cloud?" gate (2026-07-24) ────────────────────────────────
// A streamed level renders as POINTS on top of the base splat cloud, and for
// points levels solidCoverage() deliberately never fades the base (uFade stays
// 1). So a coarse level is not a backdrop filling a hole — it is a coarser
// image composited at 92% opacity OVER a finer one. That is strictly a
// downgrade, and it was the actual cause of mid-zoom softness (measured live
// 2026-07-24, effective altitude ~40-150 where z3 is the active level).
//
// The comparison is EFFECTIVE resolution, not point spacing alone. Each point
// carries exactly one colour sample, so a layer can't resolve finer than its
// point spacing no matter how sharp its imagery — but it also can't resolve
// finer than its imagery no matter how dense its points. So:
//
//     effective = max(point spacing, texel size)
//
// Getting this wrong in the obvious direction (comparing point spacing only)
// marks z5 as useless: its points are at parity with the base cloud (0.049 vs
// 0.050) so it looks like a wash. But the base cloud's points oversample a
// coarse global mosaic — adjacent base points share a texel — while z5's points
// each carry a genuinely distinct sample from 512px imagery. At equal point
// density, z5 is the sharper image.
//
//   level  spacing   texel    effective     vs base (0.073)
//   z3     0.242     0.073    0.242         3.3× WORSE  → skip
//   z4     0.121     0.037    0.121         1.7× worse  → skip
//   z5     0.049     0.009    0.049         1.5× better → draw
//   z6     0.021     0.005    0.021         3.5× better → draw
//
// Base cloud: points at MAP_WIDTH/LAND_GRID = 0.050, colour from the global
// mosaic at MAP_WIDTH/(256·2^tileZoom) = 300/4096 = 0.073 → effective 0.073.
//
// NOTE this is why raising the global base mosaic to zoom 5 would NOT have
// fixed the mid-band: the base texture was never what you were looking at
// there — a coarser streamed layer was sitting on top of it.
//
// Both sides are computed from the live quality tier (base cloud is sparser and
// its mosaic coarser on low tiers), so more streamed levels legitimately qualify
// on weak hardware. Comparing against the config constants would wrongly gate
// levels off on exactly the machines that need the help most.
const BASE_CLOUD_SPACING_U = MAP_WIDTH /
    Math.max(1800, Math.round(SPLAT_LAND_GRID * quality.gridScale()));
const BASE_TEXEL_U         = MAP_WIDTH / (256 * (2 ** quality.tileZoom()));
const BASE_EFFECTIVE_U     = Math.max(BASE_CLOUD_SPACING_U, BASE_TEXEL_U);
// A level must be at least this much better to be worth compositing. 1.0 = any
// improvement counts; slack avoids flapping on a level that lands within
// rounding distance of the base.
const BEATS_BASE_MARGIN = 1.05;
const LEVEL_EFFECTIVE_U = LOD_LEVELS.map(c => Math.max(
    (MAP_WIDTH / (2 ** (c.zoom + 1))) / Math.sqrt(c.ptsBudget || 1),   // point spacing
    (MAP_WIDTH / (2 ** (c.zoom + 1))) / (c.imgSize || 256),            // texel size
));
// Mesh levels are exempt — a textured mesh is not competing on point density,
// and solidCoverage() DOES fade the base cloud under those.
const LEVEL_BEATS_BASE = LOD_LEVELS.map((c, i) =>
    ((c.render || TILESTREAM.STYLE) !== 'points') ||
    (LEVEL_EFFECTIVE_U[i] * BEATS_BASE_MARGIN <= BASE_EFFECTIVE_U));
console.info('[Tiles] effective resolution vs base cloud',
    `(base ${BASE_EFFECTIVE_U.toFixed(4)}u — points ${BASE_CLOUD_SPACING_U.toFixed(4)}, texel ${BASE_TEXEL_U.toFixed(4)}):`,
    LOD_LEVELS.map((c, i) => `z${c.zoom}=${LEVEL_EFFECTIVE_U[i].toFixed(4)}${LEVEL_BEATS_BASE[i] ? '' : ' SKIP'}`).join(' '));

const FADE_SPEED   = 2.0;    // opacity ramp rate (units per second)
const MAX_OPACITY  = 0.96;   // tile meshes are primary terrain at close range
const SKIRT_DEPTH  = -35;    // scene units below deepest ocean floor (~-18)

// ── Effective "zoom" for LOD selection (2026-07-21, "smaller tiles load when
// I turn the angle, not when I zoom in") ────────────────────────────────────
// Every LOD/coverage check below used to key off raw camera.position.y — the
// camera's world-space height — as a stand-in for "how zoomed in are you."
// That's only true for a straight-down view. OrbitControls orbits at a FIXED
// DISTANCE from its target; tilting the view toward the horizon at that exact
// same distance (same "zoom") still drops camera.position.y, because
// y = radius·cos(polarAngle) — nothing about how close you are to the ground
// changed, only which direction you're looking from. LIVE-CONFIRMED: at a
// constant 10-unit orbit radius, tilting from 5° to 65° dropped
// camera.position.y from 9.6 to 3.9 — enough to skip past TWO LOD tiers
// (z7→z9) using the old logic, with zero change in actual zoom. That's
// exactly the reported symptom: finer/smaller tiles appearing on a pure
// rotate/tilt, never a deliberate zoom. Fix: use the camera's actual 3D
// distance to the look-at anchor instead — angle-invariant by construction,
// since OrbitControls holds that distance fixed while orbiting. Falls back to
// raw altitude when no anchor is given (matches the prior camX/camZ fallback
// pattern used throughout this file for the same lookAt-or-camera-position
// choice).
function _effectiveAltitude(camera, lookAt) {
    if (lookAt) return camera.position.distanceTo(lookAt);
    return camera.position.y;
}

const DEG2RAD = Math.PI / 180;
const TWO_PI  = Math.PI * 2;

// Soft round dot sprite for points-mode tiles — matches the splat cloud's look
// far better than the square default of THREE.PointsMaterial.
let _dotTex = null;
function dotTexture() {
    if (_dotTex) return _dotTex;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    // Sharper dot (2026-07-15): opaque core out to 0.78 radius with only a thin
    // anti-aliased rim, instead of a soft 0.6→1.0 gradient. Large dense points
    // were overlapping soft halos into a blurry blend; a crisp core reads as
    // detailed terrain while the thin rim still avoids hard aliased circles.
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0.0,  'rgba(255,255,255,1)');
    grad.addColorStop(0.78, 'rgba(255,255,255,1)');
    grad.addColorStop(0.94, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1.0,  'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    _dotTex = new THREE.CanvasTexture(c);
    return _dotTex;
}

// ── Coordinate helpers ────────────────────────────────────────────────────────

/**
 * Geographic (EPSG:4326, TMS) tile bounds in degrees (2026-07-12 REWRITE).
 * Cesium World Terrain is NOT Web-Mercator tiled — layer.json declares
 * projection EPSG:4326, scheme "tms": 2^(z+1) columns × 2^z rows, ty=0 at the
 * SOUTH pole. The old Web-Mercator math requested tiles from the wrong grid;
 * everything that ever loaded was an index collision serving terrain from the
 * wrong latitude. Verified: mercator-indexed canyon tile → 404; geographic
 * (1545, 2868) → in layer.json availability, HTTP 200.
 */




// ── Tactical elevation colour palette ─────────────────────────────────────────
// Mirrors terrainWorker.js so tile geometry blends seamlessly with the base
// splat cloud at every transition altitude.
// ── Procedural detail amplification (2026-07-15) ──────────────────────────────
// Cesium DEM tops out near ~30m; below that there is no real data. This bakes
// COHERENT synthetic fine detail — multi-octave value noise (fBm) — into each
// tile's points at build time: sub-DEM micro-relief + surface-texture colour
// variation. Global, uniform, zero render/network cost, and deterministic in
// WORLD space so adjacent tiles stitch seamlessly. Tunable via
// TILESTREAM.PROCEDURAL ({ ENABLED, FREQ, RELIEF, COLOR }).


// ── TileCache — one per LOD level ─────────────────────────────────────────────
class TileCache {
    constructor(scene, cfg) {
        this._scene      = scene;
        this._cfg        = cfg;
        this._tiles      = new Map();   // key → { mesh, skirtMesh, opacity, lastAccess }
        this._loading    = new Set();   // keys currently in-flight
        this._lruOrder   = [];          // keys sorted oldest→newest access
        this._targetOpac  = 0;           // altitude-driven target opacity
        this._tileBase    = null;        // set by TileStreamManager after Ion endpoint resolves
        this._sessionToken = null;       // short-lived Ion session token (refreshed every 50 min)
        this._pureOcean   = new Set();   // keys pre-classified as open ocean — never fetched (2026-07-21)
        // key → { attempts, lastReason, firstFailAt } — tiles whose imagery
        // never landed. Added 2026-07-21 after a live video showed a tile
        // stuck for 15+s on its palette+procedural-noise fallback (reads as a
        // static/noise square at close zoom — see _scheduleImageryRetry).
        // Cleared once imagery succeeds; read by getStuckImageryTiles() below.
        this._imgFailures = new Map();
    }

    // ── Imagery retry-with-backoff (2026-07-21) ────────────────────────────────
    // fetchImagery() itself only retries once (2 attempts, ~250-600ms apart) —
    // enough for a single dropped packet, not enough for a several-second
    // ArcGIS rate-limit stall or connection-pool contention under load. Before
    // this fix, exhausting that one retry meant `.then(bmp => { if (!bmp)
    // return; ... })` at both call sites just gave up FOREVER, silently, with
    // no record anywhere — the tile stayed on its palette+procedural-noise
    // fallback (elevToColor + _pFbm micro-detail — designed to look fine for
    // the ~1-2s a real fetch normally takes, not indefinitely) with nothing to
    // ever revisit it. That is almost certainly what the video's stuck square
    // was: not a separate rendering bug, just the "about to be overdrawn any
    // second" fallback sitting there uncorrected because imagery permanently
    // gave up after one retry. Fix: keep retrying with backoff, track failures
    // so they're diagnosable (getStuckImageryTiles()), and only stop once the
    // tile itself is no longer the current one for that key (evicted/replaced).
    _scheduleImageryRetry(key, imgUrl, expectedThing, applyFn, attempt = 1, suppressed = 0) {
        const MAX_ATTEMPTS = 5;                       // total tries across all rounds
        const BACKOFF_MS   = [0, 1500, 3500, 7000, 12000]; // delay BEFORE this attempt
        // How many times a tile will wait out a cool-off before giving up. Bounded
        // so a permanently dead endpoint cannot leave timers rescheduling forever.
        const MAX_SUPPRESSED = 8;
        // Jitter is LOAD-BEARING, not politeness. Without it every tile suppressed
        // by the breaker sets a timer expiring on the same millisecond, so the
        // instant cool-off ends they all fetch at once — recreating precisely the
        // burst that tripped the breaker, in a loop. Spreading recovery over a few
        // seconds is what makes the breaker converge instead of oscillate.
        const RECOVERY_JITTER_MS = 6000;
        const stillRelevant = () => {
            const entry = this._tiles.get(key);
            return !!entry && (entry.mesh === expectedThing || entry.skirtMesh === expectedThing);
        };
        const tryOnce = () => {
            if (!stillRelevant()) { this._imgFailures.delete(key); return; }
            // ── Circuit breaker gate (2026-07-25) ────────────────────────────
            // During a systemic outage, do not fetch at all. Retrying is what
            // turned an endpoint hiccup into ~180 simultaneous readbacks and
            // rebuilds on 2026-07-24; gating the LADDER matters as much as gating
            // the first attempt, because ladders already in flight when the
            // breaker opens would otherwise keep hammering right through it.
            //
            // Waiting out a cool-off deliberately does NOT consume an attempt: the
            // endpoint being down is not this tile's fault, and spending its retry
            // budget on an outage would leave it permanently unpainted once
            // service came back. `suppressed` is bounded separately instead.
            const nowMs = performance.now();
            if (_imgBreaker.isOpen(nowMs)) {
                if (suppressed >= MAX_SUPPRESSED) {
                    this._imgFailures.set(key, {
                        attempts: attempt,
                        lastReason: 'imagery endpoint down through repeated cool-offs — gave up',
                        firstFailAt: this._imgFailures.get(key)?.firstFailAt ?? nowMs,
                    });
                    return;
                }
                const wait = _imgBreaker.stats(nowMs).coolOffRemainingMs
                           + Math.random() * RECOVERY_JITTER_MS;
                this._imgFailures.set(key, {
                    attempts: attempt,
                    lastReason: `waiting out imagery endpoint cool-off (${suppressed + 1}/${MAX_SUPPRESSED})`,
                    firstFailAt: this._imgFailures.get(key)?.firstFailAt ?? nowMs,
                });
                setTimeout(() => this._scheduleImageryRetry(
                    key, imgUrl, expectedThing, applyFn, attempt, suppressed + 1), wait);
                return;
            }
            fetchImagery(imgUrl).then(imageryBitmap).then(async bmp => {
                // applyFn returns true/false — false covers not just "no bitmap"
                // but also downstream failures (e.g. OffscreenCanvas extraction),
                // which deserve the same retry treatment as a failed fetch.
                const applied = bmp ? await applyFn(bmp) : false;
                if (applied) { this._imgFailures.delete(key); return; }
                if (!stillRelevant()) { this._imgFailures.delete(key); return; }
                if (attempt >= MAX_ATTEMPTS) {
                    this._imgFailures.set(key, {
                        attempts: attempt, lastReason: 'exhausted retries',
                        firstFailAt: this._imgFailures.get(key)?.firstFailAt ?? performance.now(),
                    });
                    return;
                }
                this._imgFailures.set(key, {
                    attempts: attempt, lastReason: 'pending retry',
                    firstFailAt: this._imgFailures.get(key)?.firstFailAt ?? performance.now(),
                });
                // `suppressed` is carried, not reset: a tile that already sat out
                // several outages must not earn a fresh suppression budget every
                // time it also fails normally, or its timer chain is unbounded.
                this._scheduleImageryRetry(key, imgUrl, expectedThing, applyFn, attempt + 1, suppressed);
            });
        };
        const delay = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
        if (delay > 0) setTimeout(tryOnce, delay); else tryOnce();
    }

    // Diagnostic read: tiles currently stuck without real imagery, past at
    // least one failed attempt. Used by the tile-load tester (see
    // window.vg1TileTest) and callable directly from DevTools.
    getStuckImageryTiles() {
        return [...this._imgFailures.entries()].map(([key, v]) => ({
            key, level: this._cfg.zoom, ...v,
            ageMs: performance.now() - v.firstFailAt,
        }));
    }

    // ── Open-ocean pre-check (2026-07-21, rewritten 2026-07-25) ────────────────
    // A tile that's genuinely open water everywhere has nothing to gain from a
    // Cesium QM + ArcGIS imagery fetch — the base splat cloud + water plane
    // already render it correctly, and (per the 2026-07-21 tile-ocean-bleed fix
    // in _buildPoints) an all-ocean tile ends up building an EMPTY points
    // geometry anyway. Fetching it is pure waste: bandwidth, a slot in the
    // throttled QM/imagery queues that a real coastal/land tile could have
    // used, and decode time for data that gets thrown away.
    //
    // ── WHAT CHANGED, AND WHY THE OLD VERSION HAD TO GO (2026-07-25) ──────────
    // The original test sampled the 2048×1024 baked DEM and skipped a tile only
    // when all 49 samples read deeper than −60 m. That is a DEPTH test doing a
    // LAND test's job, and it failed in both directions at once:
    //
    //   • Shelves. Sunda, the North Sea, the Yellow Sea and the Gulf are all
    //     shallower than 60 m, so EVERY tile over them passed the gate. Measured
    //     at z10: 69.1% of Sunda tiles fetched where 63.4% are near land, 70.1%
    //     vs 53.1% in the North Sea. Those are the wasted tiles Jamal reported
    //     seeing stacked over open water around the Indonesian islands.
    //
    //   • Islands. One DEM pixel is ~19 km, so a small island averages into the
    //     deep water around it. The gate SKIPPED the tiles holding Malta,
    //     Bermuda, Guam, Nassau, Key West, Malé, Nauru, Diego Garcia, St Helena,
    //     Funafuti, Kiritimati and Palau — 12 of 17 real islands sampled, each
    //     getting no streamed terrain at all.
    //
    // Both are the same mistake, and no choice of margin fixes them: shelf depth
    // and land are independent facts. So the answer is now baked offline from a
    // real coastline (GSHHG ~0.9 km, unioned with GEBCO and with this same DEM
    // so a tile the point builder would paint is never culled) and read here as
    // one bit — see tools/build_tile_land_mask.py and tileLandMask.js.
    //
    // The DEM heuristic survives ONLY as the fallback for when the asset is
    // absent or still loading, where its shelf over-fetching is the safe
    // failure: it fetches too much rather than blanking ground.
    _isPureOceanTile(tx, ty, key) {
        if (this._pureOcean.has(key)) return true;
        // Baked mask is authoritative when present; `shouldFetch` returns true
        // (fetch anyway) whenever it cannot answer, so this never blanks ground.
        if (tileLandMask.ready) {
            const water = !tileLandMask.shouldFetch(this._cfg.zoom, tx, ty);
            if (water) this._pureOcean.add(key);
            return water;
        }
        const OCEAN_TILE_MARGIN_M = -60;
        const SAMPLES = 7;   // 49 samples/tile — cheap (sync array lookups, no network),
                              // worth the extra safety margin against writing off a tile
                              // that has a real sliver of coastline in it
        const b  = geoTileBounds(tx, ty, this._cfg.zoom);
        const x0 = lonToSceneX(b.west),  x1 = lonToSceneX(b.east);
        const z0 = latToSceneZ(b.north), z1 = latToSceneZ(b.south);
        let allDeepOcean = true;
        for (let i = 0; i < SAMPLES && allDeepOcean; i++) {
            const u = i / (SAMPLES - 1);
            for (let j = 0; j < SAMPLES; j++) {
                const v = j / (SAMPLES - 1);
                const sx = x0 + u * (x1 - x0);
                const sz = z0 + v * (z1 - z0);
                if (getTrueElevation(sx, sz) >= OCEAN_TILE_MARGIN_M) { allDeepOcean = false; break; }
            }
        }
        // Deliberately NOT cached in _pureOcean. This branch only runs in the
        // window before the baked mask finishes loading, and its answers are the
        // ones we now know to be wrong for small islands — caching them would
        // pin "skip Malta" for the rest of the session, long after the
        // authoritative mask arrived.
        return allDeepOcean;
    }

    // Is this tile's ground footprint anywhere in the view frustum? Plan-view box
    // with a generous Y span (TILE_BOX_Y) so terrain height can't cull a tile that
    // is really on screen. Uses module-scope scratch objects — called up to 169×
    // per level per frame.
    _tileInFrustum(tx, ty, frustum) {
        const b  = geoTileBounds(tx, ty, this._cfg.zoom);
        const x0 = lonToSceneX(b.west),  x1 = lonToSceneX(b.east);
        const z0 = latToSceneZ(b.north), z1 = latToSceneZ(b.south);
        _tmpBox.min.set(Math.min(x0, x1), -TILE_BOX_Y, Math.min(z0, z1));
        _tmpBox.max.set(Math.max(x0, x1),  TILE_BOX_Y, Math.max(z0, z1));
        return frustum.intersectsBox(_tmpBox);
    }

    setTargetOpacity(v)    {
        // Dwell tracking (2026-07-25): _wantedSince is when this level LAST
        // became wanted, cleared whenever it stops being wanted. The load gate
        // below uses it to skip bands the camera is merely passing through.
        if (v > 0.05) { if (this._wantedSince == null) this._wantedSince = performance.now(); }
        else this._wantedSince = null;
        this._targetOpac = v;
    }
    setTileBase(url)       { this._tileBase    = url; }
    setSessionToken(token) { this._sessionToken = token; }

    // True when the tile directly under (camX, camZ) is loaded and (nearly)
    // fully faded in. Fade-outs of coarser layers gate on THIS, not altitude —
    // otherwise fast zooms outrun the network and the ground goes black
    // (2026-07-12 regression report).
    // Geographic TMS grid (2026-07-12): 2^(z+1) columns × 2^z rows, ty=0 south.
    _gridTx(sceneX) {
        const TPX = 2 ** (this._cfg.zoom + 1);
        const lon = (sceneX / MAP_WIDTH) * 360;
        return ((Math.floor(((lon + 180) / 360) * TPX) % TPX) + TPX) % TPX;
    }
    _gridTy(sceneZ) {
        const TPY = 2 ** this._cfg.zoom;
        // scene Z → latitude (inverse of the scene's Mercator transform)
        const my  = -sceneZ * TWO_PI / MAP_HEIGHT;
        const lat = (2 * Math.atan(Math.exp(my)) - Math.PI / 2) * (180 / Math.PI);
        const ty  = Math.floor(((lat + 90) / 180) * TPY);
        return Math.max(0, Math.min(TPY - 1, ty));
    }

    hasCoverageAt(camX, camZ, minOpacity = 0.8) {
        const TPX = 2 ** (this._cfg.zoom + 1);
        const TPY = 2 ** this._cfg.zoom;
        const ctx = this._gridTx(camX);
        const cty = this._gridTy(camZ);
        // 3×3 neighbourhood: at oblique camera angles the exact camera tile can
        // lag (or 404) while the surrounding ground is fully painted — a single-
        // tile check kept the dots welded on over visibly loaded terrain.
        const thresh = Math.min(minOpacity, this._targetOpac || minOpacity);
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const tx = ((ctx + dx) % TPX + TPX) % TPX;
                const ty = Math.max(0, Math.min(TPY - 1, cty + dy));
                const entry = this._tiles.get(`${this._cfg.zoom}/${tx}/${ty}`);
                if (entry && entry.opacity >= thresh) return true;
            }
        }
        return false;
    }

    update(camX, camZ, delta, frustum = null) {
        if (this._targetOpac <= 0 && this._tiles.size === 0) return;

        const TPX = 2 ** (this._cfg.zoom + 1);
        const TPY = 2 ** this._cfg.zoom;

        const camTx = this._gridTx(camX);
        const camTy = this._gridTy(camZ);

        const R = this._cfg.loadRadius;
        const candidates = [];
        for (let dy = -R; dy <= R; dy++) {
            for (let dx = -R; dx <= R; dx++) {
                const tx = ((camTx + dx) % TPX + TPX) % TPX;
                const ty = Math.max(0, Math.min(TPY - 1, camTy + dy));
                candidates.push({ tx, ty, d2: dx * dx + dy * dy });
            }
        }
        candidates.sort((a, b) => a.d2 - b.d2);

        for (const { tx, ty, d2 } of candidates) {
            const key = `${this._cfg.zoom}/${tx}/${ty}`;
            if (this._unavailable && this._unavailable.has(key)) continue;  // known 404
            // ── Provably-absent terrain (2026-07-25) ─────────────────────────
            // Cesium World Terrain has NO z9+ data above 60N (SRTM's northern
            // limit — measured, see terrainCoverage.js). Without this gate, flying
            // over Scandinavia, northern Russia, Alaska, Canada or Greenland fires
            // the full load radius at every fine level, 404s on every one, and
            // negative-caches them — ~150 doomed round trips per view. The map
            // still LOOKED fine because the base cloud backstops it, which is
            // exactly why it went unnoticed. Skipping is free: there is nothing
            // there to fetch.
            if (isBeyondTerrainCoverage(this._cfg.zoom,
                    geoTileBounds(tx, ty, this._cfg.zoom).south)) continue;
            if (!this._tiles.has(key) && !this._loading.has(key) && this._targetOpac > 0) {
                if (this._isPureOceanTile(tx, ty, key)) continue;  // open ocean — never fetched, see _isPureOceanTile
                // ── Frustum-shaped loading (2026-07-24) ──────────────────────
                // The footprint was a symmetric circle around the look-at anchor,
                // so at any oblique angle a large slice of it sat BEHIND the
                // camera. Measured live: 36% of loaded tiles (z9) and 38% (z8)
                // were outside the view frustum — a third of the tile budget spent
                // on ground that cannot be seen.
                //
                // Only the LOAD is gated. Tiles already in _tiles keep rendering
                // and fading normally below, so turning the camera reveals whatever
                // was already fetched rather than dropping it.
                //
                // The safety ring is what makes this safe to do at all: a pure
                // frustum test optimises for a static camera and falls off a cliff
                // on rotation, which is the one motion that invalidates the whole
                // set at once. See ROTATION_SAFETY_RINGS.
                if (frustum && d2 > ROTATION_SAFETY_RINGS * ROTATION_SAFETY_RINGS
                    && !this._tileInFrustum(tx, ty, frustum)) continue;
                // ── Level-weighted priority (2026-07-25) ─────────────────
                // Priority was distance only, so a level fading in at 7% opacity
                // fetched with the SAME urgency as the level actually on screen —
                // measured live: z8 (op 0.92) and z9 (op 0.07) with 101 and 65
                // tiles in flight simultaneously, each getting half the pipe. The
                // visible level took twice as long to complete so that a level
                // you could barely see could load alongside it.
                //
                // The penalty scales with how INVISIBLE the level is: at op 0.92
                // it adds ~8 (negligible next to d2), at op 0.07 it adds ~93 —
                // more than any d2 in a loadRadius-4 grid (max 32), so a faint
                // level's nearest tile still queues behind the dominant level's
                // farthest. Same priority flows into the build pool, and queue
                // eviction under pressure drops the faint level's jobs first,
                // which is exactly the right victim.
                // A/B: window.vg1LevelPriority = false restores distance-only.
                const _lvlPenalty = (typeof window !== 'undefined' && window.vg1LevelPriority === false)
                    ? 0 : (1 - Math.min(1, this._targetOpac)) * 100;
                // ── DWELL GATE (2026-07-25) ──────────────────────────────────
                // Measured on a scripted 8s world→street dive (Fortaleza, fresh):
                // 435 of 653 tiles loaded — 67% — were for levels dominant for
                // 214-699ms during the descent and settled at ZERO opacity, zero
                // visible. Pure transit waste: fetched, built, never seen. The
                // destination levels were dominant 1165ms and 3263ms.
                //
                // So a level must be continuously wanted for DWELL_MS before it
                // may LOAD (fades are untouched). The measured threshold gap is
                // clean: every fly-through band < 700ms, every destination level
                // > 1100ms. Cost: at most 0.8s extra latency when deliberately
                // stopping at a mid-zoom band — while a fast dive arrives with
                // the whole pipe never having been spent on ground behind it.
                // Detail is preserved by construction: anywhere you actually
                // STAY loads exactly what it loads today, just uncontested.
                // A/B: window.vg1DwellGate = false disables.
                const DWELL_MS = 800;
                if (this._wantedSince != null
                    && (performance.now() - this._wantedSince) < DWELL_MS
                    && !(typeof window !== 'undefined' && window.vg1DwellGate === false)) {
                    continue;
                }
                this._loadTile(tx, ty, d2 + _lvlPenalty);
            }
            const entry = this._tiles.get(key);
            if (entry) {
                this._touchLRU(key);
                entry.opacity = Math.min(this._targetOpac, entry.opacity + FADE_SPEED * delta);
                entry.mesh.visible = entry.opacity > 0.001;
                entry.mesh.material.opacity = entry.opacity;
                if (entry.skirtMesh) {
                    entry.skirtMesh.visible  = entry.mesh.visible;
                    entry.skirtMesh.material.opacity = entry.opacity;
                }
            }
        }

        const visKeys = new Set(candidates.map(c => `${this._cfg.zoom}/${c.tx}/${c.ty}`));
        this._tiles.forEach((entry, key) => {
            if (visKeys.has(key)) return;
            entry.opacity = Math.max(0, entry.opacity - FADE_SPEED * delta * 2.5);
            entry.mesh.material.opacity = entry.opacity;
            if (entry.skirtMesh) {
                entry.skirtMesh.material.opacity = entry.opacity;
                entry.skirtMesh.visible = entry.opacity > 0.001;
            }
            if (entry.opacity <= 0.001) entry.mesh.visible = false;
        });

        // ── Retention is tiered by whether the level is DRAWING (2026-07-25) ──
        // Audited live at Tokyo z12: levels z5-z10 held 171 tiles, every one with
        // `visible === false` — fully fetched, fully imaged, fully built, and
        // contributing nothing. ~5M points and a large slice of a 1.45GB heap doing
        // no work, because maxActive is a flat per-level cap that ignores whether
        // the level is on screen.
        //
        // A dark level keeps only a small warm set. This is cheap to undo precisely
        // because the ANCESTOR IMAGERY CACHE holds the pictures separately (see
        // _ancestorPut) and point building runs in the worker pool — so coming back
        // rebuilds from cached imagery instead of refetching over the network, which
        // is the part that was ever slow.
        //
        // NOT zero: eviction is per-frame and altitude oscillates around fade
        // thresholds, so an empty warm set would thrash a level in and out on every
        // small camera move.
        const drawing = this._targetOpac > 0.001;
        const budget  = drawing ? this._cfg.maxActive
                                : Math.min(this._cfg.maxActive, DARK_LEVEL_KEEP);
        while (this._lruOrder.length > budget) {
            this._evict(this._lruOrder[0]);
        }
    }

    dispose() {
        [...this._tiles.keys()].forEach(k => this._evict(k));
        this._loading.clear();
    }

    // ── Internal ──────────────────────────────────────────────────────────────
    // (_sceneToCamTileY removed 2026-07-12 — it computed Web-Mercator tile rows,
    //  the wrong grid for Cesium's EPSG:4326 TMS scheme. See _gridTx/_gridTy.)

    /**
     * Repaint a tile from the nearest cached ANCESTOR's imagery.
     * Used for two cases that look different but want identical handling:
     *   • fringe tiles that deliberately never fetched their own imagery
     *   • tiles whose own imagery came back blank
     * @returns {boolean} true if a borrow was applied (or is no longer needed).
     */
    _borrowImagery(key, tx, ty, qmData, priority) {
        const entry = this._tiles.get(key);
        if (!entry) return true;                 // evicted — stop waiting on it
        const anc = _ancestorFor(this._cfg.zoom, tx, ty);
        if (!anc) return false;                  // nothing to borrow from YET
        const mesh = entry.mesh;
        this._buildPoints(tx, ty, qmData, anc.data, priority,
                          { u0: anc.u0, v0: anc.v0, scale: anc.scale, size: anc.size })
            .then(re => {
                if (!re) return;
                // Re-check: the tile may have been evicted or repainted with its
                // OWN (better) imagery while this rebuild was in flight. Clobbering
                // real imagery with a borrowed, coarser copy would be a regression,
                // and it is exactly the race the 2026-07-24 imagery work was about.
                const now = this._tiles.get(key);
                if (!now || now.mesh !== mesh) {
                    this._scene.remove(re.mesh);
                    re.mesh.geometry.dispose(); re.mesh.material.dispose();
                    return;
                }
                _ancBorrows++;
                now.imagery = 'borrowed';
                re.mesh.material.opacity = mesh.material.opacity;
                re.mesh.visible          = mesh.visible;
                re.mesh.renderOrder      = mesh.renderOrder;
                this._scene.remove(mesh);
                mesh.geometry.dispose(); mesh.material.dispose();
                now.mesh = re.mesh;
            })
            .catch(() => {});
        return true;
    }

    /**
     * Warm one tile: fetch + build + geometry-cache it WITHOUT putting anything
     * on screen. Called by tileWarmer.js during idle time so that a later visit
     * finds the cache hot and loads instantly (measured: a warm dive shows
     * 231/231 tiles at the first sample vs a ~10s cold ramp).
     *
     * Deliberately reuses the SAME pipeline as a live load — fetchTerrain,
     * fetchImagery, _buildPoints (which writes the geometry cache) — so a warmed
     * tile is byte-identical to a lived-in one. The only difference is that the
     * resulting mesh is disposed instead of added to the scene. Warming also
     * populates the service worker's byte cache as a side effect, so even the
     * fetch half of a later cold-ish load drops to ~4ms.
     *
     * Priority 1e9 = worst possible: every queue here evicts the WORST job under
     * pressure, so warming is always the first thing sacrificed when live loading
     * needs the capacity. That is the property that makes background warming safe
     * to run at all.
     */
    async warmTile(tx, ty) {
        const key = `${this._cfg.zoom}/${tx}/${ty}`;
        if (this._tiles.has(key) || this._loading.has(key)) return 'live';
        if (this._unavailable?.has(key)) return 'unavailable';
        if (!this._tileBase) return 'not-ready';
        if (isBeyondTerrainCoverage(this._cfg.zoom,
                geoTileBounds(tx, ty, this._cfg.zoom).south)) return 'no-coverage';
        if (this._isPureOceanTile(tx, ty, key)) return 'ocean';
        // Already warm? A cache hit here costs one IndexedDB read and settles it.
        const fpW = _geoFingerprint(this._cfg, true);
        if (await _geoCache.get(cacheKey(this._cfg.zoom, tx, ty, fpW))) return 'already-warm';

        const WARM_PRIORITY = 1e9;
        const qmUrl  = `${this._tileBase}${this._cfg.zoom}/${tx}/${ty}.terrain?v=1.2.0`;
        const bb  = geoTileBounds(tx, ty, this._cfg.zoom);
        const ISZ = this._cfg.imgSize || 256;
        const imgUrl = `${IMAGERY_EXPORT_URL}?bbox=${bb.west},${bb.south},${bb.east},${bb.north}`
                     + `&bboxSR=4326&imageSR=4326&size=${ISZ},${ISZ}&format=jpg&f=image`;
        try {
            const imgPromise = fetchImagery(imgUrl);
            const qmRes = await fetchTerrain(qmUrl, {
                'Accept': 'application/vnd.quantized-mesh,application/octet-stream;q=0.9',
                'Authorization': `Bearer ${this._sessionToken}`,
            }, WARM_PRIORITY);
            if (!qmRes) return 'evicted';                    // live load outranked us — fine
            if (!qmRes.ok) {
                if (qmRes.status === 404) { (this._unavailable ||= new Set()).add(key); return 'unavailable'; }
                return 'failed';
            }
            const buffer = await qmRes.arrayBuffer();
            let qmData;
            try { qmData = this._parseQM(buffer); }
            catch (_) { try { qmData = this._flatQM(buffer, tx, ty); } catch (_) { return 'failed'; } }

            // Imagery is best-effort: warming with it makes the eventual live
            // I1 lookup hit; without it we still warm the palette (I0) build.
            let imgData = null;
            try {
                const bmp = await imageryBitmap(await imgPromise);
                if (bmp) {
                    const cv = new OffscreenCanvas(ISZ, ISZ);
                    const g  = cv.getContext('2d', { willReadFrequently: true });
                    g.drawImage(bmp, 0, 0, ISZ, ISZ);
                    const d = g.getImageData(0, 0, ISZ, ISZ).data;
                    bmp.close();
                    if (!_isBlankImagery(d)) imgData = d;
                }
            } catch (_) { imgData = null; }

            const built = await this._buildPoints(tx, ty, qmData, imgData, WARM_PRIORITY);
            if (!built) return 'evicted';
            // The cache write already happened inside _buildPoints. The mesh is a
            // by-product we never wanted — dispose before it touches the GPU.
            built.mesh.geometry.dispose();
            built.mesh.material.dispose();
            return 'warmed';
        } catch (_) {
            return 'failed';
        }
    }

    async _loadTile(tx, ty, priority = 0) {
        const key = `${this._cfg.zoom}/${tx}/${ty}`;
        if (this._loading.has(key) || this._tiles.has(key)) return;
        if (!this._tileBase) return;   // endpoint not resolved yet — skip silently
        this._loading.add(key);

        // ty is ALREADY in the geographic TMS grid (y=0 at the south pole) —
        // exactly what the Cesium tile server expects. No flip (2026-07-12).
        // _tileBase comes from the Ion endpoint API — already has trailing slash
        const qmUrl = `${this._tileBase}${this._cfg.zoom}/${tx}/${ty}.terrain?v=1.2.0`;

        // ArcGIS mercator tile indices no longer line up with the geographic
        // grid — fetch imagery by explicit 4326 bbox via the export endpoint.
        // Row 0 of the returned image is north, same as before, so the existing
        // texV = 1 - tileV mapping is unchanged.
        // Mesh levels always drape imagery; points levels fetch it only for
        // per-point PHOTO_COLOR sampling.
        const renderMode  = TILESTREAM.FORCE_MESH ? 'mesh' : (this._cfg.render || TILESTREAM.STYLE);
        const wantImagery = renderMode !== 'points'
                         || TILESTREAM.PHOTO_COLOR;
        // ── Screen-space imagery budget (2026-07-25) ─────────────────────────
        // Measured over five sparse sites at z11: 35-93% of tiles ended up with NO
        // satellite imagery, falling back to elevation colour (the flat green/tan
        // rectangles). Kansas was 93%. The cause is volume — a z11 view fires ~181
        // imagery requests ON TOP OF z10's ~93, and the endpoint blanks under that
        // load. Concurrency was tried and measured NOT to be the lever (see
        // IMG_MAX_CONCURRENT); total request count is.
        //
        // But those ~274 requests are not equally worth making. `priority` is the
        // squared tile-grid distance from the camera tile, so the tiles at the edge
        // of the load radius occupy a handful of pixels while costing exactly as
        // much as the one you are looking at. So: only the near rings fetch their
        // OWN imagery. Everything beyond borrows from an ancestor that has already
        // been downloaded (see _ancestorFor) — coarser, but real photography, and
        // continuous with its neighbours, which the palette never is.
        //
        // The result is a resolution pyramid: sharp at the centre of view, softening
        // outward. That is roughly how vision works anyway, and it is a far better
        // trade than uniform sharpness that 60% of the time resolves to a flat
        // green rectangle.
        const _rings = _ownImageryRingsFor(this._cfg.zoom);
        const fetchOwnImagery = priority <= _rings * _rings;
        const bb  = geoTileBounds(tx, ty, this._cfg.zoom);
        const ISZ = this._cfg.imgSize || 256;
        const imgUrl = `${IMAGERY_EXPORT_URL}?bbox=${bb.west},${bb.south},${bb.east},${bb.north}`
                     + `&bboxSR=4326&imageSR=4326&size=${ISZ},${ISZ}&format=jpg&f=image`;

        try {
            // Kick off imagery IN PARALLEL with geometry (2026-07-20 fix). imgUrl
            // depends only on tx/ty/zoom, not on qmData — there was never a real
            // dependency between the two fetches, but the points-mode branch below
            // used to `await fetchTerrain(...)` FULLY, then only THEN `await
            // fetchImagery(...)` — serializing two independent ~1-1.5s fetches into
            // one ~2-3s critical path per tile, for every tile in the (now wider,
            // post-2026-07-20-coverage-fix) load radius. Starting the imagery
            // request here means it's usually already resolved (or resolving
            // concurrently) by the time the points branch needs it below — same
            // two throttled queues, same priority behavior, just not chained.
            // Gated to points mode specifically (not just wantImagery) — mesh
            // mode already fires its own separate, un-awaited fetchImagery()
            // further down; starting one here too would double-fetch every
            // mesh tile's imagery for no reason.
            const imgPromise = (renderMode === 'points' && wantImagery && fetchOwnImagery)
                             ? fetchImagery(imgUrl) : null;
            // ── Skip the redundant first build when imagery WINS THE RACE ──────
            // (2026-07-25) Every tile was built TWICE — measured buildsPerTile 1.96:
            // once with palette colour to show something immediately, then a full
            // regeneration once imagery landed. That made sense when a build was
            // ~2.5ms. It is now 1339ms at z12, and the two fetches have similar
            // latency (QM ~1.5s, imagery p50 ~1.5s), so imagery is frequently
            // ALREADY IN HAND by the time geometry arrives — in which case the
            // palette pass is pure waste and its only effect is to delay the real
            // one behind it in a saturated queue.
            //
            // Non-blocking by construction: this only records the winner, it never
            // awaits imagery. If imagery is late we still build the palette version
            // first and drape later, exactly as before — the "show now" guarantee
            // that stops checkerboarding is untouched.
            let _imgEarly = null;
            if (imgPromise) imgPromise.then(b => { _imgEarly = b; }).catch(() => {});

            // Geometry (Cesium QM) is fetched ALONE and never waits on imagery —
            // this is what stops the checkerboard-while-loading (2026-07-15).
            // Routed through the throttled, nearest-first terrain queue so a dive
            // doesn't fire 350+ fetches at once and choke the connection pool.
            const qmRes = await fetchTerrain(qmUrl, {
                // Use the short-lived session token from the Ion endpoint response,
                // NOT the main API key — Cesium tile servers validate the session token.
                'Authorization': `Bearer ${this._sessionToken}`,
                'Accept': 'application/vnd.quantized-mesh,application/octet-stream;q=0.9,*/*;q=0.01',
            }, priority);

            if (!qmRes.ok) throw new Error(`QM HTTP ${qmRes.status}`);

            const buffer   = await qmRes.arrayBuffer();
            let   qmData;
            try {
                qmData = this._parseQM(buffer);
            } catch (parseErr) {
                // Valid 200 response but the QM decoder overran. Cesium returns very
                // small (~300 byte) minimal-geometry tiles for near-flat ground —
                // plains, farmland, plateaus — and those are exactly the ones the
                // decoder trips on. They are NOT missing tiles; blacklisting them
                // (as before) punched permanent black voids across all flat terrain,
                // at every zoom, which is what made the tile stream look full of
                // holes. Fall back to a flat quad from the header's min-height (an
                // excellent approximation for ground this flat) so the tile still
                // renders with satellite imagery draped — no void. (2026-07-18)
                if (buffer && buffer.byteLength >= 88) {
                    qmData = this._flatQM(buffer, tx, ty);
                } else {
                    throw parseErr;   // genuinely empty/garbage body — real failure
                }
            }

            const renderAs = TILESTREAM.FORCE_MESH ? 'mesh' : (this._cfg.render || TILESTREAM.STYLE);
            if (renderAs === 'points') {
                // 2026-07-21 (tile load speed): this USED to await imagery before
                // building anything, serializing point-geometry display behind
                // the slow ArcGIS imagery fetch. Live-measured on a real dive:
                // QM terrain geometry ~160ms avg (98 tiles), but ArcGIS imagery
                // p50 ~1.5s / p90 ~2.8s through only IMG_MAX_CONCURRENT(20)
                // slots — with a ~50-100 tile load-radius batch that imagery
                // queue, not the terrain fetch, was the real ~10s "feels slow"
                // cost of a dive (this tile stayed in `_loading` — blocking
                // fade-in and the next candidate — for the full imagery wait
                // even though its actual geometry was ready in a fraction of
                // that time). Geometry build is cheap (~2.5ms/tile, already
                // measured elsewhere in this file) and the palette fallback
                // (elevToColor) is designed to never look blank/wrong, so:
                // build + show the tile NOW with palette colour, then swap in
                // photo colour when imagery lands — the exact "show now, drape
                // later" pattern _buildMesh/_applyImagery already uses for
                // mesh mode, just adapted for points (which have no separate
                // material.map to swap — the fix rebuilds the point geometry
                // instead, reusing the same deterministic per-tile seed so the
                // dot positions are identical and only colour changes).
                // If imagery already arrived (see _imgEarly), decode it now and
                // build ONCE with real colour instead of building palette-then-
                // rebuilding. `_earlyImgData` non-null also suppresses the drape
                // pass below, since there is nothing left for it to do.
                let _earlyImgData = null;
                if (_imgEarly) {
                    try {
                        const cv = new OffscreenCanvas(ISZ, ISZ);
                        const g  = cv.getContext('2d', { willReadFrequently: true });
                        g.drawImage(_imgEarly, 0, 0, ISZ, ISZ);
                        const d = g.getImageData(0, 0, ISZ, ISZ).data;
                        // Same blank guard the drape path applies — a placeholder
                        // must not be baked in as though it were real imagery.
                        if (!_isBlankImagery(d)) { _earlyImgData = d; _imgBreaker.recordHealthy(performance.now()); }
                    } catch (_) { _earlyImgData = null; }
                }
                const built = await this._buildPoints(tx, ty, qmData, _earlyImgData, priority);
                // Cancelled by the build-queue cap (2026-07-21) — this candidate
                // aged out behind higher-priority (closer) work and was evicted
                // rather than left to rot. Nothing to register; `finally` below
                // still clears `_loading` for this key so it's free to be
                // re-requested fresh if it becomes relevant again.
                if (built === null) return;
                const { mesh } = built;

                // Empty-tile guard (2026-07-21, "black square in the middle of
                // real land" — found via a live location sweep, reproduced over
                // Kansas farmland). A tile can legitimately come back with ZERO
                // points after the ocean-exclusion filtering above (2026-07-20/21
                // fixes) if EVERY vertex reads below OCEAN_MARGIN_M — normally
                // that only happens for genuine open ocean, but the `_flatQM`
                // decoder-overrun fallback (used for near-flat ground — exactly
                // what farmland/plains are) sets all 4 vertices to the SAME
                // `minHeight`, and if THAT value is bogus/negative for some tiles
                // (root cause not fully pinned down — possibly a bad header read
                // on certain malformed responses), the whole tile now gets
                // filtered to nothing. Before the ocean-exclusion fixes this just
                // meant a wrongly-blue-colored patch of real land; now it means
                // ZERO points. The real bug this guard closes: an empty tile was
                // still being registered in `_tiles` at full opacity, so
                // `hasCoverageAt()`/`solidCoverage()` (which only check opacity,
                // not point count) told the base splat cloud "this spot is
                // covered, fade out" — base cloud (which has correct real
                // elevation for this location) hides, tile draws nothing, net
                // result: a solid black hole over real land. Fix: if geometry
                // build produced no points, this tile isn't usable — dispose it,
                // don't register it, and blacklist the key like a 404 so it isn't
                // retried every frame. The base cloud (or a coarser tile level)
                // remains correctly visible as backstop instead.
                if (mesh.geometry.attributes.position.count === 0) {
                    // FALLBACK-BEFORE-GIVING-UP (2026-07-21, "not loading tile" — a
                    // sharp-edged solid black square sitting inside otherwise-normal
                    // farmland, reported live and matching this exact code path).
                    // The guard above this comment used to just drop the tile and
                    // blacklist it, on the stated assumption that "base cloud
                    // backstops the gap either way" (see the same claim at this
                    // file's other blacklist site, ~line 963). That assumption is
                    // wrong for a single empty CELL: LayerCoordinator computes ONE
                    // global fade value per frame from the view's overall tile
                    // coverage fraction (layerCoordinator.js), not per-cell — so as
                    // long as most of the surrounding tiles loaded fine (the normal
                    // case, which is exactly why this reads as an isolated hole and
                    // not a whole-screen problem), the base cloud still fades out
                    // everywhere, including over this one ungeometried cell, and
                    // nothing is left to draw there. Mesh mode never has this problem
                    // because it always falls back to a flat coloured quad instead of
                    // nothing (elevToColor, "never black" — see _flatQM above). Give
                    // points mode that same guarantee: rebuild once from the flat-quad
                    // fallback (forces a valid, non-ocean height straight from this
                    // tile's own header) before accepting defeat.
                    this._scene.remove(mesh);
                    mesh.geometry.dispose();
                    mesh.material.dispose();

                    let rescued = false;
                    try {
                        const flatData = this._flatQM(buffer, tx, ty);
                        const fallbackBuilt = await this._buildPoints(tx, ty, flatData, null, priority);
                        if (fallbackBuilt && fallbackBuilt.mesh.geometry.attributes.position.count > 0) {
                            this._tiles.set(key, { mesh: fallbackBuilt.mesh, skirtMesh: null, opacity: 0, lastAccess: performance.now() });
                            this._lruOrder.push(key);
                            rescued = true;
                        } else if (fallbackBuilt) {
                            this._scene.remove(fallbackBuilt.mesh);
                            fallbackBuilt.mesh.geometry.dispose();
                            fallbackBuilt.mesh.material.dispose();
                        }
                    } catch (_) { /* fall through to blacklist below */ }

                    if (!rescued) {
                        if (!this._unavailable) this._unavailable = new Set();
                        this._unavailable.add(key);
                    }
                    return;
                }

                this._tiles.set(key, { mesh, skirtMesh: null, opacity: 0, lastAccess: performance.now(),
                                       imagery: _earlyImgData ? 'own' : undefined });
                this._lruOrder.push(key);
                if (_earlyImgData) { _ancestorPut(this._cfg.zoom, tx, ty,
                                        _downscaleRGBA(_earlyImgData, ISZ, ANCESTOR_IMG_N)); }

                // Fringe tile: no own-imagery fetch was issued, so paint it from an
                // ancestor instead of leaving it on the elevation palette. If no
                // ancestor has arrived YET (levels stream concurrently, so a child
                // often builds before its parent), register as a waiter — every
                // successful ancestor decode drains the list. Without that the
                // fringe would be permanently palette whenever it lost the race,
                // which was 85% of the time before the per-level cache budgets.
                if (!fetchOwnImagery) {
                    // Guarantee the pyramid has a base: request this tile's
                    // z10-grid source image (deduplicated across the whole view).
                    _ensureSourceImagery(this._cfg.zoom, tx, ty);
                    if (!this._borrowImagery(key, tx, ty, qmData, priority)) {
                        _borrowWaiters.push({ cache: this, key, tx, ty, qmData, priority,
                                              zoom: this._cfg.zoom });
                        while (_borrowWaiters.length > MAX_BORROW_WAITERS) _borrowWaiters.shift();
                    }
                }

                if (imgPromise && !_earlyImgData) {
                    // Applies a resolved bitmap; returns true on success, false on
                    // any failure so the caller (_scheduleImageryRetry) knows to
                    // retry rather than leave the tile on its palette fallback.
                    const applyPointsImagery = async (bmp) => {
                        let imgData = null;
                        try {
                            const cv = new OffscreenCanvas(ISZ, ISZ);
                            const g  = cv.getContext('2d', { willReadFrequently: true });
                            g.drawImage(bmp, 0, 0, ISZ, ISZ);
                            imgData = g.getImageData(0, 0, ISZ, ISZ).data;
                        } catch (_) { imgData = null; }
                        bmp.close();
                        if (!imgData) return false;
                        // ── REVERTED 2026-07-24, same day it was added ───────────
                        // This previously did `if (_isBlankImagery(imgData)) return
                        // false;` to route solid-colour responses into the retry
                        // path. The detection is correct (see _isBlankImagery — the
                        // measurements behind it are solid) but ACTING on it here was
                        // not, because the condition that produces blank imagery is
                        // SYSTEMIC: the endpoint rate-limits and every in-flight tile
                        // goes blank at once. So instead of one tile retrying, ~180
                        // tiles each retried up to MAX_ATTEMPTS, and every retry costs
                        // a 512² getImageData readback on the main thread plus, on
                        // eventual success, a full 28,000-point rebuild through
                        // _queueBuild. That amplification is the wrong response to an
                        // outage — it hits hardest exactly when the endpoint is
                        // already struggling.
                        //
                        // Detection is still called below for DIAGNOSIS only, so the
                        // condition is visible instead of silent. Re-enabling the
                        // retry needs a global circuit breaker first: count blank
                        // responses across all tiles, and if many land close together
                        // treat it as an endpoint outage and pause retries entirely
                        // for a cool-off rather than retrying per tile.
                        // ── RE-ENABLED 2026-07-25, with the circuit breaker the
                        // reverted note above asked for (imageryCircuitBreaker.js).
                        //
                        // Two separate corrections here, and the FIRST one is the
                        // reason the black rectangles were permanent:
                        //
                        //  1. We no longer APPLY blank imagery. Previously a
                        //     placeholder was baked into the point colours, so the
                        //     tile became a flat black/olive block FOREVER — there
                        //     is no later pass that would ever repaint it. Returning
                        //     before the rebuild leaves the tile on its elevation-
                        //     colour fallback (elevToColor, never black), which
                        //     reads as plausible terrain instead of a dead hole.
                        //     This is also strictly CHEAPER than what it replaced:
                        //     we skip a 28k-point rebuild rather than adding one.
                        //
                        //  2. Retry is now gated on the breaker, which is what makes
                        //     re-enabling safe. Isolated blank (breaker closed) →
                        //     return false → that one tile retries, cheap and it
                        //     usually works. Systemic blank (breaker open, meaning
                        //     many tiles blanked at once) → return true → give up
                        //     quietly. That is the amplification the 07-24 revert
                        //     was right to be afraid of, and it is now structurally
                        //     impossible rather than avoided by not trying.
                        if (_isBlankImagery(imgData)) {
                            const nowMs = performance.now();
                            const tripped = _imgBreaker.recordBlank(nowMs);
                            const open    = _imgBreaker.isOpen(nowMs);
                            // Before giving up on real imagery: an ancestor tile
                            // covers this exact ground and may already be decoded.
                            // Half the resolution, but photographic and continuous
                            // with the neighbours — the elevation palette is neither.
                            // Same handling as a fringe tile — one implementation,
                            // and it registers as a waiter if no ancestor exists yet
                            // rather than giving up permanently.
                            if (!this._borrowImagery(key, tx, ty, qmData, priority)) {
                                _borrowWaiters.push({ cache: this, key, tx, ty, qmData, priority,
                                                      zoom: this._cfg.zoom });
                                while (_borrowWaiters.length > MAX_BORROW_WAITERS) _borrowWaiters.shift();
                            }
                            if (tripped) {
                                console.warn('[Tiles] imagery endpoint looks rate-limited — ' +
                                    `pausing imagery retries (${_imgBreaker.stats(nowMs).blanksInWindow} ` +
                                    'blank responses in window). Tiles keep elevation colouring.');
                            }
                            this._imgFailures.set(key, {
                                attempts: 0,
                                lastReason: open
                                    ? 'blank imagery — endpoint outage, retry suppressed by circuit breaker'
                                    : 'blank imagery — isolated, retrying',
                                firstFailAt: this._imgFailures.get(key)?.firstFailAt ?? nowMs,
                            });
                            return open;   // open → stop (no amplification); closed → retry this tile
                        }
                        _imgBreaker.recordHealthy(performance.now());
                        // Keep it for descendants. Only genuine, non-blank imagery
                        // is cached — caching a placeholder would propagate the very
                        // failure this exists to paper over, to four child tiles.
                        _ancestorPut(this._cfg.zoom, tx, ty,
                                     _downscaleRGBA(imgData, ISZ, ANCESTOR_IMG_N));
                        // Tile may have been evicted, or REBUILT, while imagery was
                        // in flight.
                        //
                        // 2026-07-24: these two cases used to be conflated and both
                        // returned `true` ("moved on"), which means success — no
                        // retry, no _imgFailures entry, nothing in
                        // getStuckImageryTiles(). They are not the same thing:
                        //
                        //   • key GONE      → genuinely moved on. The tile was
                        //                     evicted; this imagery is for ground
                        //                     nobody is looking at. Success is right.
                        //   • key PRESENT,  → NOT moved on. The geography is still
                        //     mesh differs    on screen and still wants this imagery;
                        //                     only the mesh object identity changed
                        //                     (something rebuilt it meanwhile).
                        //                     Swallowing this leaves that tile on its
                        //                     elevation-colour fallback permanently.
                        //
                        // Observed live: 7 of 242 tiles stuck showing the 1500-3000m
                        // palette band (a flat red-brown, colour sd 0.0016 vs 0.05-0.12
                        // for real imagery) while _imgFailures and
                        // getStuckImageryTiles() both read empty — the diagnostics
                        // said everything was fine. The endpoint had the imagery; we
                        // fetched it and threw it away.
                        //
                        // The race was always possible but rare while builds were
                        // synchronous. Moving builds to the worker pool the same day
                        // made _buildPoints async and concurrent, widening the window
                        // enough to hit ~3% of tiles. Returning false routes it into
                        // the existing retry-with-backoff, which is bounded by
                        // MAX_ATTEMPTS so a persistently-racing tile gives up and gets
                        // RECORDED rather than looping or lying.
                        const entry = this._tiles.get(key);
                        if (!entry) return true;                 // evicted — genuinely moved on
                        if (entry.mesh !== mesh) return false;   // rebuilt — still wants imagery, retry
                        const rebuilt = await this._buildPoints(tx, ty, qmData, imgData, priority);
                        if (rebuilt === null) return false;   // evicted from the build queue — worth another try
                        const { mesh: newMesh } = rebuilt;
                        // Same seed → same point positions → carrying over the
                        // current fade/visibility state makes this swap invisible;
                        // only the colour actually changes on screen.
                        newMesh.material.opacity = mesh.material.opacity;
                        newMesh.visible          = mesh.visible;
                        newMesh.renderOrder      = mesh.renderOrder;
                        this._scene.remove(mesh);
                        mesh.geometry.dispose();
                        mesh.material.dispose();
                        entry.mesh = newMesh;
                        // GROUND TRUTH for diagnostics (2026-07-25). Inferring
                        // "has imagery" from point-colour variance is WRONG: flat
                        // terrain (desert, plains, canopy) produces flat colour
                        // whether or not imagery landed. That confound made a
                        // five-site sweep report 35-93% missing imagery where the
                        // app's own records showed ZERO failures. Record the fact
                        // instead of estimating it.
                        entry.imagery = 'own';
                        return true;
                    };
                    imgPromise.then(imageryBitmap).then(bmp => {
                        if (bmp) {
                            applyPointsImagery(bmp).then(ok => {
                                if (!ok) this._scheduleImageryRetry(key, imgUrl, mesh, applyPointsImagery, 2);
                            });
                        } else {
                            // First attempt (imgPromise, fired in parallel with
                            // geometry above) already failed — pick up at attempt 2.
                            this._scheduleImageryRetry(key, imgUrl, mesh, applyPointsImagery, 2);
                        }
                    });
                }
            } else {
                // Mesh: build + show the terrain NOW with its elevation-colour
                // fallback (elevToColor — never black), then drape satellite
                // imagery asynchronously when the throttled fetch returns.
                const builtMesh = await _queueBuild(() => this._buildMesh(tx, ty, qmData, null), priority);
                if (builtMesh === null) return;   // evicted from the build queue — see points-mode comment above
                const { mesh, skirtMesh } = builtMesh;
                this._tiles.set(key, { mesh, skirtMesh, opacity: 0, lastAccess: performance.now() });
                this._lruOrder.push(key);

                if (wantImagery) {
                    const applyMeshImagery = async (bmp) => {
                        // ── THE RACE THAT CAUSED THE CHECKERBOARD (fixed 2026-07-25)
                        // This used to be: `if (!entry || entry.mesh !== mesh) return
                        // true;` — conflating two cases the 07-24 points-path fix had
                        // already shown are different:
                        //
                        //   key GONE      → evicted. Genuinely moved on; success.
                        //   key PRESENT,  → NOT moved on. The geography is still on
                        //   mesh differs    screen and still wants this imagery; only
                        //                   the mesh object changed because something
                        //                   rebuilt it. Returning `true` here means
                        //                   NO retry, NO failure record — the tile
                        //                   keeps its untextured elevation colour
                        //                   FOREVER.
                        //
                        // That is the mesh path's version of exactly the defect the
                        // points path was fixed for, and it is the most likely cause
                        // of the "mesh tiles kept checkerboarding" that got mesh mode
                        // disabled on 2026-07-15. The points path never had it fixed
                        // here because this branch was unreachable.
                        const entry = this._tiles.get(key);
                        if (!entry) { bmp.close(); return true; }          // evicted
                        if (entry.mesh !== mesh) { bmp.close(); return false; } // retry
                        // Blank guard, as the previous note asked for before a mesh
                        // level shipped. The readback was called "not worth paying
                        // for" — but it was measured on 2026-07-25 at p50 0.4ms,
                        // which is nothing next to draping a placeholder permanently.
                        try {
                            const cv = new OffscreenCanvas(ISZ, ISZ);
                            const g  = cv.getContext('2d', { willReadFrequently: true });
                            g.drawImage(bmp, 0, 0, ISZ, ISZ);
                            const d = g.getImageData(0, 0, ISZ, ISZ).data;
                            if (_isBlankImagery(d)) {
                                const nowMs = performance.now();
                                _imgBreaker.recordBlank(nowMs);
                                this._imgFailures.set(key, { attempts: 0,
                                    lastReason: 'blank imagery (mesh) — not draped',
                                    firstFailAt: this._imgFailures.get(key)?.firstFailAt ?? nowMs });
                                bmp.close();
                                return _imgBreaker.isOpen(nowMs);
                            }
                            _imgBreaker.recordHealthy(performance.now());
                        } catch (_) { /* readback unavailable — drape anyway */ }
                        this._applyImagery(mesh, bmp);
                        entry.imagery = 'own';
                        return true;
                    };
                    fetchImagery(imgUrl).then(imageryBitmap).then(bmp => {
                        if (bmp) { applyMeshImagery(bmp); return; }
                        this._scheduleImageryRetry(key, imgUrl, mesh, applyMeshImagery, 2);
                    });
                }
            }

        } catch (err) {
            console.debug(`[TileStream z${this._cfg.zoom}] ${key} failed:`, err.message);
            // Negative cache PERMANENT failures so update() stops re-requesting
            // them every frame. Two kinds are permanent:
            //   • HTTP 404 — Cesium has no QM tile here (sparse deep-zoom coverage).
            //   • Malformed/truncated body — the QM parser throws a RangeError
            //     ("Offset is outside the bounds of the DataView"). Some z9 tiles
            //     come back unparseable; without this they flooded the console and
            //     wasted a fetch every frame forever (2026-07-15). Base cloud
            //     backstops the gap either way. Transient network errors are NOT
            //     cached, so they can still retry.
            const permanent = /HTTP 404/.test(err.message)
                || err instanceof RangeError
                || /DataView|out of bounds|Offset is outside/i.test(err.message);
            if (permanent) {
                if (!this._unavailable) this._unavailable = new Set();
                this._unavailable.add(key);
            }
        } finally {
            this._loading.delete(key);
        }
    }

    // ── Quantized-Mesh binary decoder ─────────────────────────────────────────
    //
    // Format overview:
    //   [0..87]   88-byte header  (center ECEF, minHeight, maxHeight, bounding sphere, HOP)
    //   [88]      uint32 vertexCount
    //   [92]      uint16[vertexCount] u         (0-32767, west→east)
    //             uint16[vertexCount] v         (0-32767, south→north)
    //             uint16[vertexCount] height    (0-32767, minHeight→maxHeight)
    //   [align]   pad to 4-byte boundary if necessary
    //             uint32 triangleCount
    //             uint16[triangleCount*3] or uint32[triangleCount*3] indices
    //             (high-watermark encoded — see _decodeHWM)
    //   [edge]    4× { uint32 count, uint16[count] indices } for W/S/E/N edges
    //
    // Minimal flat-tile fallback for valid 200 responses the QM decoder can't parse
    // (tiny near-flat tiles). A single quad spanning the whole tile at the header's
    // min-height, with the four corners wired as the edge vertices so seams still
    // match neighbours. Near-flat ground is exactly what these tiles represent, so
    // the approximation is faithful and the imagery drapes correctly.
    // 2026-07-21 (Sahara/Egypt "blue patch on dry land" — found via location
    // sweep): the raw byte-24 minHeight read is NOT trustworthy for these
    // fallback tiles. It's only reached when the real QM decoder has ALREADY
    // thrown mid-parse — i.e. the body is malformed in some way we don't fully
    // understand — so nothing downstream of byte 0 is guaranteed to still
    // match the documented header layout. On real inland desert (Western
    // Desert, Egypt, ~27.6N 28.5E) this was silently returning a value near 0
    // (sea level) for terrain that is actually tens to hundreds of metres up,
    // and elevToColor paints anything near/below sea level as water — so the
    // whole flat quad rendered as a solid blue "lake" in the middle of dry
    // land. Real point geometry was present (not the zero-point Kansas case),
    // just colour-mapped from a corrupt height. Cross-check against the
    // coarse-DEM `getTrueElevation` (the same authoritative source already
    // used for pure-ocean tile classification below) and prefer IT whenever
    // the raw header value disagrees by more than a few metres — cheap,
    // already-loaded, and immune to whatever corrupted this particular buffer.
    // ── DEM-relief fallback (2026-07-25) ─────────────────────────────────────
    // This used to return a single FLAT quad at one elevation, which is where the
    // "tiles badly placed" flat plates came from: a flat tile cannot meet its
    // sloping neighbours, so it reads as a plate hovering over (or sunk into) the
    // surrounding terrain, with a hard rectangular seam. Measured on a live z10
    // dive: 14 such tiles (z8:9, z9:4, z10:1).
    //
    // The 2026-07-21 note below had already established that the coarse DEM is the
    // trustworthy source for these tiles and was already sampling it — but only at
    // the tile CENTRE, to pick one flat height. Sampling it on a grid instead costs
    // essentially nothing (getTrueElevation is an in-memory texel read, already
    // loaded) and gives the tile real, if coarse, relief that lands on the same
    // surface its neighbours are built from.
    //
    // Resolution note: the DEM is ~9.8km/texel while a z10 tile spans ~20km, so an
    // 8×8 grid oversamples and the relief comes out blocky. That is fine and
    // deliberate — blocky-but-correct beats flat-and-wrong, and these are fallback
    // tiles for ground Cesium could not serve at all. isFallback stays TRUE so the
    // land-mask carve still applies: the heights are DEM-derived, not decoded, and
    // the carve keys off exactly that distinction.
    _flatQM(buffer, tx, ty) {
        let minHeight = 0;
        try { const v = new DataView(buffer); minHeight = v.getFloat32(24, true); } catch (_) {}
        if (!Number.isFinite(minHeight)) minHeight = 0;

        // Grid cells per axis. 8 → 81 vertices, 128 triangles: negligible next to
        // the 40k points the tile will be sampled into.
        const N = 8;
        let grid = null;
        if (tx !== undefined && ty !== undefined) {
            try {
                const b = geoTileBounds(tx, ty, this._cfg.zoom);
                const g = new Float32Array((N + 1) * (N + 1));
                let lo = Infinity, hi = -Infinity, ok = true;
                for (let r = 0; r <= N && ok; r++) {
                    // r = 0 is SOUTH (v = 0), matching the QM v axis.
                    const lat = b.south + (b.north - b.south) * (r / N);
                    const sz  = latToSceneZ(lat);
                    for (let cIdx = 0; cIdx <= N; cIdx++) {
                        const lon = b.west + (b.east - b.west) * (cIdx / N);
                        const e = getTrueElevation(lonToSceneX(lon), sz);
                        if (!Number.isFinite(e)) { ok = false; break; }
                        g[r * (N + 1) + cIdx] = e;
                        if (e < lo) lo = e;
                        if (e > hi) hi = e;
                    }
                }
                if (ok && Number.isFinite(lo) && Number.isFinite(hi)) {
                    grid = g; minHeight = lo;
                    // Guard the quantiser against a genuinely flat sample (open
                    // ocean, or uniform plain): hi === lo would divide by zero.
                    var maxH = hi > lo ? hi : lo;
                }
            } catch (_) { grid = null; /* DEM not ready yet — fall through to flat */ }
        }

        if (grid) {
            const V = (N + 1) * (N + 1);
            const uBuf = new Uint16Array(V), vBuf = new Uint16Array(V), hBuf = new Uint16Array(V);
            const span = (maxH - minHeight) || 1;
            for (let r = 0; r <= N; r++) {
                for (let cIdx = 0; cIdx <= N; cIdx++) {
                    const i = r * (N + 1) + cIdx;
                    uBuf[i] = Math.round((cIdx / N) * 32767);
                    vBuf[i] = Math.round((r / N) * 32767);
                    hBuf[i] = Math.round(((grid[i] - minHeight) / span) * 32767);
                }
            }
            const indices = new Uint32Array(N * N * 6);
            let t = 0;
            for (let r = 0; r < N; r++) {
                for (let cIdx = 0; cIdx < N; cIdx++) {
                    const a = r * (N + 1) + cIdx, bb = a + 1;
                    const cc = a + (N + 1),       d  = cc + 1;
                    indices[t++] = a;  indices[t++] = bb; indices[t++] = cc;
                    indices[t++] = bb; indices[t++] = d;  indices[t++] = cc;
                }
            }
            // Edge vertex lists, same contract as the real decoder — these are what
            // keep seams matched against neighbouring tiles.
            const west = [], east = [], south = [], north = [];
            for (let r = 0; r <= N; r++) { west.push(r * (N + 1)); east.push(r * (N + 1) + N); }
            for (let cIdx = 0; cIdx <= N; cIdx++) { south.push(cIdx); north.push(N * (N + 1) + cIdx); }
            return {
                vertexCount: V, uBuf, vBuf, hBuf,
                minHeight, maxHeight: maxH,
                isFallback: true,
                indices,
                edgeIndices: { west, south, east, north },
            };
        }

        // DEM unavailable (not yet loaded) — the original single flat quad.
        return {
            vertexCount: 4,
            uBuf: new Uint16Array([0, 32767, 0, 32767]),   // W,E,W,E
            vBuf: new Uint16Array([0, 0, 32767, 32767]),   // S,S,N,N
            hBuf: new Uint16Array([0, 0, 0, 0]),           // all at minHeight → flat
            minHeight, maxHeight: minHeight,
            // Flags this tile's heights as INVENTED, not decoded. Everything
            // downstream that wants to know "can I trust this tile's elevations?"
            // keys off this — notably the DEM land-mask carve, which must only
            // override heights that were never real. See buildTilePoints.
            isFallback: true,
            indices: new Uint32Array([0, 1, 2, 1, 3, 2]),
            edgeIndices: { west: [0, 2], south: [0, 1], east: [1, 3], north: [2, 3] },
        };
    }

    _parseQM(buffer) {
        const view = new DataView(buffer);

        // ── Header ──────────────────────────────────────────────────────────
        // Bytes 0-23:  center ECEF (3×float64) — not needed for our projection
        // Bytes 24-27: minHeight (float32)
        // Bytes 28-31: maxHeight (float32)
        // Bytes 32-87: bounding sphere + horizon occlusion — not needed
        const minHeight = view.getFloat32(24, true);
        const maxHeight = view.getFloat32(28, true);
        let off = 88;

        // ── Vertex arrays ────────────────────────────────────────────────────
        const vertexCount = view.getUint32(off, true);
        off += 4;

        const uBuf = new Uint16Array(vertexCount);
        const vBuf = new Uint16Array(vertexCount);
        const hBuf = new Uint16Array(vertexCount);

        // ZIG-ZAG DELTA DECODE (2026-07-12 — the missing piece). Per the
        // quantized-mesh spec, u/v/height are NOT absolute values: each entry is
        // a zig-zag-encoded signed DELTA from the previous vertex. Reading them
        // raw produced correlated-garbage geometry — the "star shard" terrain in
        // Jamal's close-zoom screenshots. zigZag: (n >> 1) ^ -(n & 1).
        const zz = (n) => (n >> 1) ^ (-(n & 1));
        let au = 0, av = 0, ah = 0;
        for (let i = 0; i < vertexCount; i++) { au += zz(view.getUint16(off + i * 2, true)); uBuf[i] = au; }
        off += vertexCount * 2;
        for (let i = 0; i < vertexCount; i++) { av += zz(view.getUint16(off + i * 2, true)); vBuf[i] = av; }
        off += vertexCount * 2;
        for (let i = 0; i < vertexCount; i++) { ah += zz(view.getUint16(off + i * 2, true)); hBuf[i] = ah; }
        off += vertexCount * 2;

        // ── 4-byte alignment ─────────────────────────────────────────────────
        // The index section must start on a 4-byte boundary.
        if (off % 4 !== 0) off += 2;

        // ── Triangle indices (high-watermark encoded) ─────────────────────────
        const triangleCount = view.getUint32(off, true);
        off += 4;

        // Tiles with > 65536 vertices use 32-bit indices (extremely rare in practice)
        const use32      = vertexCount > 65536;
        const indexCount = triangleCount * 3;

        const rawIndices = new Uint32Array(indexCount);
        if (use32) {
            for (let i = 0; i < indexCount; i++) {
                rawIndices[i] = view.getUint32(off + i * 4, true);
            }
            off += indexCount * 4;
        } else {
            for (let i = 0; i < indexCount; i++) {
                rawIndices[i] = view.getUint16(off + i * 2, true);
            }
            off += indexCount * 2;
        }

        // High-watermark decode: if code===0 → emit highWaterMark then advance it;
        //                        else        → emit highWaterMark - code
        const indices = new Uint32Array(indexCount);
        let hwm = 0;
        for (let i = 0; i < indexCount; i++) {
            const code = rawIndices[i];
            if (code === 0) { indices[i] = hwm++; }
            else            { indices[i] = hwm - code; }
        }

        // ── Edge vertex index arrays (west, south, east, north) ───────────────
        // Each edge's vertices share exact positions with the adjacent tile's
        // corresponding edge — this is what gives QM its crack-free seams.
        const readEdge = () => {
            const count = view.getUint32(off, true); off += 4;
            const arr = new Array(count);
            if (use32) {
                for (let i = 0; i < count; i++) { arr[i] = view.getUint32(off, true); off += 4; }
            } else {
                for (let i = 0; i < count; i++) { arr[i] = view.getUint16(off, true); off += 2; }
            }
            return arr;
        };

        const west  = readEdge();
        const south = readEdge();
        const east  = readEdge();
        const north = readEdge();

        return {
            vertexCount,
            uBuf, vBuf, hBuf,
            minHeight, maxHeight,
            indices,
            edgeIndices: { west, south, east, north },
        };
    }

    // ── Mesh builder — converts QM vertices to Three.js BufferGeometry ────────
    // ── Points-mode builder (2026-07-12, "idea 3") ─────────────────────────────
    // Samples the decoded quantized mesh into a dense field of splat-palette
    // points. The map never changes aesthetic at close zoom — it just gains
    // geometric truth (real Cesium DEM) and density. No imagery, no lighting,
    // no skirts, no style break at the handoff.
    async _buildPoints(tx, ty, qmData, imgData = null, priority = 0, imgRect = null) {
        // STAGE 2 (2026-07-24): the heavy half now runs in a Worker pool. It was
        // ~40ms of synchronous main-thread work per tile and a close view needs
        // ~250 of them, which is why a close-in view took ~10s to fill and
        // stuttered throughout. The maths itself is unchanged — the pool calls the
        // same tilePointsBuilder.buildTilePoints() the main thread used to.
        //
        // Returns null when the pool evicts this job for space (a fast camera
        // sweep queued something closer). Callers already treat null as "aged
        // out, nothing to register" — the same contract _queueBuild had.
        // Carve to the real coastline. The builder's own ocean trims judge by the
        // tile's self-reported quantized-mesh heights, which are wrong for tiles
        // that fell back to _flatQM with a bogus height — those render a full
        // square of land-coloured points out over open water. The DEM has no such
        // failure mode. See buildTilePoints' landMask parameter.
        // ── When to trust the DEM over the tile (corrected 2026-07-24) ───────
        // The global DEM is 4096px for 360°, i.e. ~9.8km per texel. A z9 tile is
        // ~39km across, so a 32×32 mask has 1.22km cells — EIGHT TIMES finer than
        // the source it samples. Any island smaller than a DEM texel simply is not
        // in the DEM, while Cesium's quantized mesh has it in full detail.
        //
        // Carving everything against the DEM therefore deleted small islands
        // (reported live immediately after the first version shipped). The DEM is
        // only the better authority when the tile's OWN heights are invented —
        // the _flatQM fallback, which sets every vertex to one bogus value and is
        // exactly the case that produced land-coloured squares over open water.
        // When Cesium gave real relief, Cesium wins: it is the finer source.
        const heightsAreInvented = qmData.isFallback === true
                                || qmData.maxHeight === qmData.minHeight;
        let landMask = null;
        if (heightsAreInvented) {
            const m = buildTileLandMask(tx, ty, this._cfg.zoom);
            landMask = m.mask;
            // Every cell reads ocean AND the tile has no real heights of its own:
            // nothing to draw. Deliberately NOT applied to tiles with genuine
            // relief — that is what removed the islands.
            if (m.landCells === 0) {
                this._pureOcean.add(`${this._cfg.zoom}/${tx}/${ty}`);
                return null;
            }
        }

        // ── Built-geometry cache lookup ──────────────────────────────────
        // Only for tiles built from their OWN imagery: a borrowed-ancestor build
        // depends on WHICH ancestor happened to be resident, which is not a
        // property of this tile and must not be cached under its key.
        const _cacheable = !imgRect;
        const _key = _cacheable
            ? cacheKey(this._cfg.zoom, tx, ty, _geoFingerprint(this._cfg, !!imgData))
            : null;
        if (_key) {
            const hit = await _geoCache.get(_key);
            if (hit) return this._meshFromBuilt(hit);
        }

        const built = await tilePointsPool.build(this._cfg, tx, ty, qmData, imgData, priority, landMask, imgRect);
        // Store BEFORE the mesh is made — _meshFromBuilt subarrays the buffers.
        // Fire-and-forget: a cache write must never delay a tile appearing, and a
        // quota failure must never propagate into the tile pipeline.
        if (_key && built) _geoCache.put(_key, built).catch(() => {});
        if (!built) return null;
        return this._meshFromBuilt(built);
    }

    /**
     * Turn built point buffers into a THREE.Points. Split out 2026-07-25 so the
     * geometry-cache hit path and the fresh-build path construct the mesh through
     * ONE implementation — two copies would drift, and a drifted cache path would
     * show up as tiles that render subtly differently depending on whether they
     * happened to be cached, which is close to undiagnosable.
     */
    _meshFromBuilt(built) {
        const { positions, colors, count: n } = built;

        // Palette selector, also used by the material brightness below. Mirrors the
        // same expression inside buildTilePoints — kept in both because the two
        // halves are deliberately independent now.
        const _deep = this._cfg.zoom >= 6;

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, n * 3), 3));
        // `true` = NORMALIZED. buildTilePoints now returns Uint8 colour (see its
        // allocation note); without this flag WebGL reads 0-255 as literal values
        // and every point renders blown out to white.
        geo.setAttribute('color',    new THREE.BufferAttribute(colors.subarray(0, n * 3), 3, true));
        geo.computeBoundingSphere();

        // Point brightness: PointsMaterial.color multiplies the per-point vertex
        // colors, so a sub-1 grey dims the whole terrain — taming the blown-out
        // bright deserts and pulling those pixels back under the 0.95 bloom
        // threshold so they stop glowing (2026-07-15). Live-tunable per tile via
        // material.color; global default is TILESTREAM.POINT_BRIGHTNESS.
        const _pb = _deep ? (TILESTREAM.POINT_BRIGHTNESS ?? 0.80)
                          : (TILESTREAM.POINT_BRIGHTNESS_FAR ?? 0.72);
        const mat = new THREE.PointsMaterial({
            // ×POINT_SMOOTH (2026-07-18): slightly larger points overlap into a
            // smoother, more continuous surface (less visible individual dots).
            // Tunable — 1.0 = original size, higher = smoother/softer.
            // Clamped so points cannot overlap more than POINT_MAX_OVERLAP times
            // the gap between them. Measured 2026-07-25: z12 was running at 39x,
            // a single point spanning ~a third of its own tile, which threw away
            // the 9.6m imagery that level exists to deliver. Sized from `n`, the
            // ACTUAL point count, because ACTIVE_PTS_CAP and ptsBudget disagree —
            // using the budget would under-size every capped tile by ~1.9x and
            // open real gaps. Only ever shrinks, so the hand-tuned coarse levels
            // (z5 sits at 0.3x by design) are untouched. See clampPointSize.
            size:            clampPointSize(
                                 this._cfg.zoom, n,
                                 (this._cfg.ptSize || TILESTREAM.POINT_SIZE) * (TILESTREAM.POINT_SMOOTH ?? 1),
                                 TILESTREAM.POINT_MAX_OVERLAP ?? 6),
            map:             dotTexture(),
            vertexColors:    true,
            color:           new THREE.Color(_pb, _pb, _pb),
            transparent:     true,
            opacity:         0,
            alphaTest:       0.12,
            depthWrite:      false,
            sizeAttenuation: true,
        });

        const pts = new THREE.Points(geo, mat);
        pts.renderOrder = 3 + (this._cfg.zoom - 6);
        pts.visible = false;
        this._scene.add(pts);

        return { mesh: pts };
    }

    // Drape satellite imagery onto an already-rendered mesh tile. Called when the
    // decoupled, throttled imagery fetch returns AFTER the geometry is live, so
    // the ground never waits on (or blanks out for) a slow imagery request.
    // UVs are already baked into the geometry by _buildMesh, so this is just a
    // material swap: elevation-colour vertexColors → satellite texture map.
    _applyImagery(mesh, imageryBmp) {
        const tex = new THREE.Texture(imageryBmp);
        tex.colorSpace      = THREE.SRGBColorSpace;
        tex.minFilter       = THREE.LinearMipmapLinearFilter;
        tex.magFilter       = THREE.LinearFilter;
        tex.generateMipmaps = true;
        tex.needsUpdate     = true;

        const mat = mesh.material;
        if (mat.map) mat.map.dispose();   // replace any prior tile texture
        mat.map          = tex;
        mat.vertexColors = false;         // satellite imagery carries the colour now
        mat.needsUpdate  = true;
    }

    _buildMesh(tx, ty, qmData, imageryBmp = null) {
        // ── Tile geographic bounds (EPSG:4326 TMS grid) ───────────────────────
        const b = geoTileBounds(tx, ty, this._cfg.zoom);

        // Scene-space bounds of this tile (scene stays Mercator — only the TILE
        // GRID is geographic; corners are projected through the scene transform)
        const x0 = lonToSceneX(b.west);    // west edge
        const x1 = lonToSceneX(b.east);    // east edge
        const z0 = latToSceneZ(b.north);   // north edge (more negative Z)
        const z1 = latToSceneZ(b.south);   // south edge

        const { vertexCount, uBuf, vBuf, hBuf, minHeight, maxHeight, indices, edgeIndices } = qmData;

        const positions = new Float32Array(vertexCount * 3);
        const colors    = new Float32Array(vertexCount * 3);
        const uvs       = new Float32Array(vertexCount * 2);

        for (let i = 0; i < vertexCount; i++) {
            // QM: u=0→west, u=32767→east, v=0→south, v=32767→north
            const tileU = uBuf[i] / 32767;   // 0=west, 1=east
            const tileV = vBuf[i] / 32767;   // 0=south, 1=north

            // Map u/v → scene X/Z
            // Note: z0 is north (more negative), z1 is south.
            // tileV=0 → south=z1, tileV=1 → north=z0, so Z = z1 + tileV*(z0-z1)
            const sceneX = x0 + tileU * (x1 - x0);
            const sceneZ = z1 + tileV * (z0 - z1);

            // Decode height in meters
            const elev = minHeight + (hBuf[i] / 32767) * (maxHeight - minHeight);

            // ── Elevation Y ───────────────────────────────────────────────────
            // Ocean vertices are clamped to exactly y=0 (sea level).  This
            // prevents the near-vertical coastal faces that appear as black walls
            // when deep ocean polygons connect to elevated land vertices.  The
            // sea plane at y=0 covers the transition seamlessly.
            // Vertex colour still uses actual depth via elevToColor, so the ocean
            // colour gradient (shallow teal → deep navy) is preserved.
            let elevY;
            if (elev <= 0) {
                elevY = 0;                          // clamp ocean to sea level
            } else if (elev < 15) {
                elevY = (elev / 2000.0) * (elev / 15); // taper: 0m→0, 15m→full
            } else {
                elevY = elev / 2000.0;              // land
            }
            elevY *= TERRAIN_VERTICAL_SCALE;

            const curve = curveOffset(sceneX, sceneZ);

            // Positions are in absolute scene space; mesh.position stays at origin
            positions[i * 3]     = sceneX;
            positions[i * 3 + 1] = elevY + curve;
            positions[i * 3 + 2] = sceneZ;

            // UV for satellite texture
            // ArcGIS tile row 0 = north.  flipY=true maps image row 0 → V=1.
            // So: texV = 1 - tileV (1=north=top of image)
            uvs[i * 2]     = tileU;
            uvs[i * 2 + 1] = 1.0 - tileV;

            const { r, g, b } = elevToColor(elev);
            colors[i * 3]     = r;
            colors[i * 3 + 1] = g;
            colors[i * 3 + 2] = b;
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
        geo.setAttribute('uv',       new THREE.BufferAttribute(uvs, 2));
        geo.setIndex(new THREE.BufferAttribute(indices, 1));
        geo.computeVertexNormals();
        geo.computeBoundingSphere();

        // ── Satellite imagery texture (best-effort) ───────────────────────────
        let imageryTex = null;
        if (imageryBmp) {
            imageryTex = new THREE.Texture(imageryBmp);
            imageryTex.colorSpace      = THREE.SRGBColorSpace;
            imageryTex.minFilter       = THREE.LinearMipmapLinearFilter;
            imageryTex.magFilter       = THREE.LinearFilter;
            imageryTex.generateMipmaps = true;
            imageryTex.needsUpdate     = true;
        }

        // polygonOffset scales with zoom — higher zoom tiles need a stronger push
        // to avoid z-fighting with lower-zoom tiles beneath them.
        const zoomOffset = this._cfg.zoom * 0.5;

        // UNLIT (2026-07-12): the satellite imagery already carries all shading.
        // MeshStandardMaterial + scene lighting on ultra-coarse QM meshes (flat
        // terrain tiles can arrive with ~10 vertices) rendered each huge triangle
        // as its own lit facet — the giant dark/yellow triangles in the "bad
        // load" report. Basic material = texture only, no per-facet lighting.
        const mat = new THREE.MeshBasicMaterial({
            map:                 imageryTex || null,
            vertexColors:        !imageryTex,
            // Brightness lift (2026-07-18): the raw satellite texture is muted and,
            // on the night side, dimmed further by the atmosphere/fog passes. A >1
            // colour multiplier restores the punch the boosted point tiles had, so
            // the close-up mesh reads strong day OR night. Tunable; ~1.5 balances
            // night readability against daytime bloom. Persists after imagery drape
            // (_applyImagery only swaps the map, not the colour).
            color:               new THREE.Color(1.5, 1.5, 1.5),
            transparent:         true,
            opacity:             0,
            depthWrite:          true,
            side:                THREE.DoubleSide,
            polygonOffset:       true,
            polygonOffsetFactor: -zoomOffset,
            polygonOffsetUnits:  -zoomOffset,
        });

        // Mesh sits at scene origin — positions are already in world space
        const mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = 3 + (this._cfg.zoom - 6);
        mesh.position.set(0, 0, 0);
        mesh.visible = false;
        this._scene.add(mesh);

        // ── Skirt — built from QM's own edge vertex arrays ────────────────────
        // Each edge list contains vertex indices in order around that tile edge.
        // SKIRTS DISABLED (2026-07-12): the SKIRT_DEPTH=-35 curtains were built
        // for continental viewing distances. At the deep-dive altitudes a tile
        // is ~0.6u wide with a 35u-deep skirt — giant streak-textured walls and
        // shards dominating the view (diagnosed from Jamal's close-zoom
        // screenshots). QM same-level neighbours share edge vertices exactly, so
        // no cracks open within a level; level-boundary seams are covered by the
        // LOD crossfade. _buildSkirt kept below for reference.
        return { mesh, skirtMesh: null };
    }

    // ── Skirt builder — uses QM edge vertex index arrays ─────────────────────
    _buildSkirt(positions, colors, edgeIndices, zoomOffset) {
        const { west, south, east, north } = edgeIndices;
        // Process all 4 edges in order
        const allEdges = [north, south, west, east];

        const skirtPos    = [];
        const skirtColors = [];
        const skirtIdx    = [];
        let vi = 0;

        for (const edge of allEdges) {
            for (let i = 0; i < edge.length - 1; i++) {
                const i0 = edge[i];
                const i1 = edge[i + 1];

                const x0 = positions[i0 * 3],     y0 = positions[i0 * 3 + 1], z0 = positions[i0 * 3 + 2];
                const x1 = positions[i1 * 3],     y1 = positions[i1 * 3 + 1], z1 = positions[i1 * 3 + 2];

                // Darken skirt to read as shadow/depth
                const r = colors[i0 * 3]     * 0.35;
                const g = colors[i0 * 3 + 1] * 0.35;
                const b = colors[i0 * 3 + 2] * 0.35;

                const base = vi;
                // Four vertices: top-left, top-right, bottom-left, bottom-right
                skirtPos.push(x0, y0, z0,  x1, y1, z1,  x0, SKIRT_DEPTH, z0,  x1, SKIRT_DEPTH, z1);
                skirtColors.push(
                    r,       g,       b,
                    r,       g,       b,
                    r * 0.5, g * 0.5, b * 0.5,
                    r * 0.5, g * 0.5, b * 0.5
                );
                // Two triangles (DoubleSide handles both face directions)
                skirtIdx.push(base, base + 2, base + 1,  base + 1, base + 2, base + 3);
                vi += 4;
            }
        }

        const skirtGeo = new THREE.BufferGeometry();
        skirtGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(skirtPos),    3));
        skirtGeo.setAttribute('color',    new THREE.BufferAttribute(new Float32Array(skirtColors), 3));
        skirtGeo.setIndex(skirtIdx);
        skirtGeo.computeVertexNormals();
        skirtGeo.computeBoundingSphere();

        const skirtMat = new THREE.MeshStandardMaterial({
            vertexColors:        true,
            roughness:           0.95,
            metalness:           0.0,
            transparent:         true,
            opacity:             0,
            depthWrite:          true,
            side:                THREE.DoubleSide,
            polygonOffset:       true,
            polygonOffsetFactor: -(zoomOffset + 0.5),
            polygonOffsetUnits:  -(zoomOffset + 0.5),
        });

        return new THREE.Mesh(skirtGeo, skirtMat);
    }

    _touchLRU(key) {
        const idx = this._lruOrder.indexOf(key);
        if (idx !== -1) this._lruOrder.splice(idx, 1);
        this._lruOrder.push(key);
        const e = this._tiles.get(key);
        if (e) e.lastAccess = performance.now();
    }

    _evict(key) {
        const entry = this._tiles.get(key);
        if (!entry) return;
        entry.mesh.geometry.dispose();
        // Never dispose the shared points-mode dot sprite — it's one texture
        // reused by every tile. Only per-tile imagery textures get disposed.
        if (entry.mesh.material.map && entry.mesh.material.map !== _dotTex) {
            entry.mesh.material.map.dispose();
        }
        entry.mesh.material.dispose();
        this._scene.remove(entry.mesh);
        if (entry.skirtMesh) {
            entry.skirtMesh.geometry.dispose();
            entry.skirtMesh.material.dispose();
            this._scene.remove(entry.skirtMesh);
        }
        this._tiles.delete(key);
        const idx = this._lruOrder.indexOf(key);
        if (idx !== -1) this._lruOrder.splice(idx, 1);
    }
}

// ── TileStreamManager — public API ────────────────────────────────────────────
export class TileStreamManager {
    constructor(scene) {
        this._scene   = scene;
        this._caches  = LOD_LEVELS.map(cfg => new TileCache(scene, cfg));
        this._enabled = true;
        this._ready   = false;   // true once Ion endpoint resolves
        // Kick the land mask off here rather than in _init(): it is a local
        // static asset with no dependency on the Ion endpoint, and every frame
        // it is missing is a frame that falls back to the DEM heuristic.
        tileLandMask.load();
        this._init();
    }

    // ── Cesium Ion endpoint lookup ─────────────────────────────────────────────
    // The Ion endpoint API returns:
    //   • data.url          — real tile root (e.g. assets.ion.cesium.com/…)
    //   • data.accessToken  — short-lived session token (~1 hour) for tile fetches
    // The session token is different from the main API key and MUST be used when
    // fetching individual terrain tiles.  We refresh it every 50 minutes.
    async _init() {
        if (!CESIUM_TOKEN) { this._enabled = false; return; } // no token → layer off, no failed fetch
        const ENDPOINT = `https://api.cesium.com/v1/assets/1/endpoint?access_token=${CESIUM_TOKEN}`;
        try {
            const res = await fetch(ENDPOINT, { mode: 'cors' });
            if (!res.ok) throw new Error(`Ion endpoint HTTP ${res.status}`);

            const data = await res.json();
            if (!data.url)         throw new Error('Ion endpoint response missing "url"');
            if (!data.accessToken) throw new Error('Ion endpoint response missing "accessToken"');

            // Ensure URL ends with '/' so we can safely concatenate zoom/x/y
            let tileBase = data.url;
            if (!tileBase.endsWith('/')) tileBase += '/';

            // Push resolved URL + session token into every TileCache
            this._caches.forEach(c => {
                c.setTileBase(tileBase);
                c.setSessionToken(data.accessToken);
            });
            this._ready = true;

            // Session token expires in ~1 hour — refresh at 50 minutes to stay ahead
            setTimeout(() => this._init(), 50 * 60 * 1000);

            console.log('[TileStream] Cesium Ion endpoint resolved →', tileBase);
        } catch (err) {
            console.warn(
                '[TileStream] Cesium Ion endpoint failed — tile streaming disabled.\n' +
                '  Reason:', err.message, '\n' +
                '  Check network access to api.cesium.com and that the token is valid.'
            );
            this._enabled = false;
        }
    }

    set enabled(v) {
        this._enabled = v;
        if (!v) {
            this._caches.forEach(c => {
                c.setTargetOpacity(0);
                c.update(0, 0, 999);
            });
        }
    }
    get enabled() { return this._enabled; }
    get style()   { return TILESTREAM.STYLE; }

    // Aggregate diagnostic across every LOD level's cache — tiles currently
    // stuck without real imagery. See TileCache._scheduleImageryRetry's header
    // comment for what this catches. Used by window.vg1TileTest.
    getStuckImageryTiles() {
        return this._caches.flatMap(c => c.getStuckImageryTiles());
    }

    // Total tile count currently registered across every LOD level, and how
    // many of those are stuck without imagery — the two numbers the tile-load
    // tester actually needs.
    getLoadStats() {
        let total = 0;
        this._caches.forEach(c => { total += c._tiles.size; });
        const stuck = this.getStuckImageryTiles();
        return { totalTiles: total, stuckTiles: stuck.length, stuck };
    }

    update(camera, lookAt = null) {
        if (!this._enabled || !this._ready) return;

        const camY  = _effectiveAltitude(camera, lookAt);
        // Anchor tile loading on the LOOK-AT point, not the camera. With the
        // map's oblique tilt the camera sits several degrees of latitude behind
        // what's on screen — at z12 that's ~40 tiles, so every request landed
        // behind the viewport and the viewed ground never loaded (2026-07-12).
        const camX  = lookAt ? lookAt.x : camera.position.x;
        const camZ  = lookAt ? lookAt.z : camera.position.z;
        const delta = 1 / 60;

        // Camera tilt (2026-07-20) — 0=top-down, 1=horizontal. Mirrors
        // terrainBuilder.js's updatePointCloud so both systems agree on what
        // "oblique" means. Tracked here for possible future use but NOT
        // currently applied to tile loading — a forward-shifted load anchor
        // (proportional to this tilt) was tried and REVERTED same day: it
        // caused tiles to fetch for genuinely-different-and-sometimes-wrong
        // ground locations (reported live as "tiles landing in the ocean"),
        // because shifting the anchor changes WHICH real-world tile a given
        // screen position's data comes from, not just how big the loaded
        // area is. The "two layers of tile" / coverage-depends-on-angle
        // problem this was meant to fix is still open — the real fix needs
        // to reshape the coverage footprint into a frustum-aware wedge
        // without moving its center, not translate a same-shaped circle.
        this._tileTilt = 0;
        if (typeof camera.getWorldDirection === 'function') {
            const _lookDir = _tmpVec3.set(0, 0, 0);
            camera.getWorldDirection(_lookDir);
            this._tileTilt = THREE.MathUtils.clamp(1.0 + _lookDir.y, 0, 1);
        }

        // CROSS-FADE, don't stack (2026-07-12): previously EVERY level with
        // camY < showAlt ran at near-full opacity simultaneously — at y≈12 that
        // was four semi-transparent terrain layers z-fighting (+ the splat cloud),
        // producing the seams/double-exposure of the "bad load" report. Now only
        // the deepest gated level renders, its parent fading out as it fades in
        // (parent stays as backdrop while the child's tiles are still fetching).
        let active = -1;
        LOD_LEVELS.forEach((cfg, i) => { if (camY < cfg.showAlt) active = i; });
        // Coverage gate: coarser layers only fade out once the active level has
        // actually LOADED the tile under the camera. Altitude alone outruns the
        // network on fast zooms and left a black hole (2026-07-12).
        const activeCovered = active >= 0 && this._caches[active].hasCoverageAt(camX, camZ);
        // Fast-dive ladder (2026-07-12): if the active level isn't loaded yet,
        // find the deepest level that IS covered and hold every level from there
        // down to the active one at full opacity — the ground never vanishes no
        // matter how fast the camera descends through the bands.
        let ground = -1;
        if (!activeCovered) {
            for (let i = active - 1; i >= 0; i--) {
                if (this._caches[i].hasCoverageAt(camX, camZ)) { ground = i; break; }
            }
        }

        // ── Adaptive coverage radius (2026-07-18, widened 2026-07-20) ────────────
        // "Make the tile stream take over at this height." The active level and its
        // fade parent size their tile grid to span the VISIBLE ground (span ≈ 1.4·camY)
        // so fine tiles fill the whole view instead of a central postage stamp. Every
        // other deep level collapses to a minimal 5×5 footprint, so the point budget
        // is spent on the two levels you actually see rather than smeared across ten.
        // 2026-07-20 CHANGE: the old guard (`if (cfg.zoom < 8) return`) excluded ANY
        // parent level below zoom8 from adapting at all — but the parent (i===active-1)
        // is z<8 in most of the actual active bands (active=z7→parent=z6, active=z8→
        // parent=z7), so the backdrop that's supposed to fill gaps around the active
        // tiles was staying at a static, narrow loadRadius=2 footprint almost all the
        // time. That's what produced small crisp "panels" surrounded by base-cloud
        // grain (Jamal, live) — the parent backdrop wasn't sized to the view either.
        // Now: a level still adapts if it's currently serving as the parent (i===
        // active-1), regardless of its own zoom — purely-coarse/inactive levels
        // (anything else <8) are untouched, so idle high-altitude levels don't balloon.
        // loadRadius ceiling 5→6→8 and the active/parent ptsBudget cap 24000→28000
        // (still below each level's own configured BASE_BUDGET) to reinvest some of
        // the 2026-07-20 SPLAT_LAND_GRID FPS win into real coverage. Re-test FPS if
        // this is pushed further — each +1 loadRadius is a big jump in tile count
        // ((2r+1)² tiles), not a linear one.
        // TILT BOOST (2026-07-20): viewSpan now also grows with camera obliqueness
        // (this._tileTilt, set above) — up to +80% at full horizontal — because a
        // grazing view shows far more ground on screen than altitude alone implies
        // (see the report this fixes: "two layers of tile" changing with camera
        // ANGLE, not zoom height, at constant altitude).
        // REVERTED same day: raising the ceiling to 8 (301 tiles/level, ~482
        // combined active+parent) collapsed FPS to 7-8 at the exact reported
        // oblique scenario — live-measured, not assumed. A bigger SYMMETRIC
        // radius around a single anchor point is the wrong lever: most of that
        // extra radius was spent on ground behind/beside the camera that was
        // never on screen, not the forward wedge that actually needed it. Back
        // to loadRadius=6 (181 tiles/level, the last confirmed-good ~60fps
        // state) until a directional/frustum-shaped coverage fix replaces this
        // symmetric-circle approach — that's the real fix, not a bigger circle.
        // One frustum per frame, shared by every level's load test below.
        _tmpProjMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        _tmpFrustum.setFromProjectionMatrix(_tmpProjMat);

        const viewSpan = 1.4 * camY;
        LOD_LEVELS.forEach((cfg, i) => {
            const isAdaptiveParent = i === active - 1;
            if (cfg.zoom < 8 && !isAdaptiveParent) return;   // purely-coarse, non-parent levels: leave static
            const cache     = this._caches[i];
            const tileSpanU = MAP_WIDTH / (2 ** (cfg.zoom + 1));   // scene units per tile (X)
            if (i === active || isAdaptiveParent) {
                const r = Math.ceil((viewSpan / tileSpanU) / 2);
                cache._cfg.loadRadius = Math.max(3, Math.min(6, r));   // reverted 8→6 same day, see note above
                cache._cfg.maxActive  = (2 * cache._cfg.loadRadius + 1) ** 2 + 12;
                cache._cfg.ptsBudget  = Math.min(BASE_BUDGET[i], ACTIVE_PTS_CAP);
            } else {
                cache._cfg.loadRadius = 2;
                cache._cfg.maxActive  = 30;
                cache._cfg.ptsBudget  = BASE_BUDGET[i];
            }
        });

        LOD_LEVELS.forEach((cfg, i) => {
            const maxo = (cfg.render || TILESTREAM.STYLE) === 'points'
                ? TILESTREAM.POINT_OPACITY : MAX_OPACITY;
            let target = 0;
            if (i === active) {
                const t = Math.min(1, (cfg.showAlt - camY) / cfg.fadeBand);
                target  = maxo * t;
            } else if (activeCovered && i === active - 1) {
                // Single full-opacity backdrop (perf 2026-07-18): dropped the z7
                // grandparent layer — the z8 parent already backfills the active
                // level's 404 holes, and the flat-tile fallback removed most of
                // those holes anyway, so the second backdrop was mostly redundant
                // draw calls. Keep just the parent.
                // (prior note) The active (finer) level
                // 404s ~40% of its tiles over flatter terrain where Cesium lacks deep-
                // zoom QM — and its immediate parent often 404s the SAME spots. So we
                // stack two coarser levels beneath it: the parent (adds most of the
                // fill) and the grandparent (coarser, effectively complete coverage,
                // guarantees real imagery behind every remaining hole instead of a
                // black void). Each finer level is opaque and drawn on top via
                // renderOrder + polygonOffset, so detail is preserved and they don't
                // z-fight. The grandparent's tiles are large, so it's only a handful.
                target = maxo;
            } else if (!activeCovered && ground >= 0 && i >= ground && i < active) {
                target = maxo;   // hold the ladder while the active level fetches
            }
            // BEATS-THE-BASE GATE (2026-07-24). A points level coarser than the
            // base splat cloud is not a backdrop — the base never fades under
            // points levels, so drawing it just composites a blurrier image over
            // a sharper one at 92% opacity. Measured: z3 is 4.8× coarser and its
            // imagery is the same resolution as the base mosaic, so it was pure
            // loss in the effective-altitude 37-200 band. See LEVEL_BEATS_BASE.
            //
            // Side effect, verified live and desirable: TileCache.update() only
            // fetches when `_targetOpac > 0`, so a gated level stops downloading
            // as well as drawing — measured 0 tiles at z3/z4 at effective
            // altitude 50 and 100, where it previously held 45 and 94. That is
            // a real cold-boot bandwidth saving on top of the visual fix.
            //
            // The fast-dive ladder does still read hasCoverageAt() from these
            // caches, so gated levels can no longer serve as its backdrop. That
            // is safe HERE because the base splat does not fade in this band
            // (updatePointCloud's `closeness` term is 0 until camera.y drops to
            // SPLAT_FADE_TILES_START), so the ground it would have protected is
            // already fully covered by the base cloud. If the base fade band is
            // ever raised to overlap a gated level, revisit this.
            if (!LEVEL_BEATS_BASE[i]) target = 0;

            // _detailDim (0..1) lets the layer coordinator fade the tile points
            // out from under a fully-present 3DGS capture so the splat is clean.
            this._caches[i].setTargetOpacity(target * (this._detailDim ?? 1));
            this._caches[i].update(camX, camZ, delta, _tmpFrustum);
        });
    }

    // Set by the layer coordinator: 1 = tiles at full opacity, 0 = fully faded
    // (a photoreal capture owns this ground). Applied on the next update().
    setDetailDim(scale) { this._detailDim = Math.max(0, Math.min(1, scale)); }

    // For the splat-cloud handoff (main.js): true when streamed tile terrain
    // SOLIDLY covers the look-at point, so the base splat can fade out and stop
    // cluttering the detailed view. UPDATED 2026-07-15: points levels now COUNT
    // (the old all-mesh assumption is gone). The all-points tiles are dense
    // enough to be the primary terrain, so once they solidly cover the base
    // should fade. The old black-hole regression is gated away by hasCoverageAt's
    // ≥0.8 opacity requirement below: the base only fades where tile points are
    // actually loaded and solid — anywhere they aren't, it stays as backstop.
    // ── Where the streamed coverage actually is (2026-07-24) ─────────────────
    // coverageFraction() answers HOW MUCH of the look-at neighbourhood is covered.
    // This answers HOW FAR that coverage extends, so the base splat cloud can fade
    // only inside it instead of globally (see terrainBuilder.updatePointCloud).
    // Returns scene units; 0 means no level is currently painting anything, in
    // which case the base cloud must stay fully opaque everywhere.
    coveredRadiusU(camera, lookAt = null) {
        if (!this._enabled || !this._ready) return 0;
        const camY = _effectiveAltitude(camera, lookAt);
        let best = 0;
        for (let i = 0; i < LOD_LEVELS.length; i++) {
            const cache = this._caches[i];
            // Only levels that are actually being DRAWN cover anything. A level
            // holding loaded tiles at zero opacity hides nothing.
            if (cache._targetOpac <= 0 || cache._tiles.size === 0) continue;
            if (camY >= LOD_LEVELS[i].showAlt) continue;
            const tileSpanU = MAP_WIDTH / (2 ** (LOD_LEVELS[i].zoom + 1));
            // Inscribed radius of the loaded (2r+1)² block, not the circumscribed
            // one — the corners of a square footprint are NOT covered, and fading
            // the base out to the diagonal would punch holes there.
            best = Math.max(best, cache._cfg.loadRadius * tileSpanU);
        }
        return best;
    }

    solidCoverage(camera, lookAt = null) {
        if (!this._enabled || !this._ready) return false;
        const camY = _effectiveAltitude(camera, lookAt);
        const x = lookAt ? lookAt.x : camera.position.x;
        const z = lookAt ? lookAt.z : camera.position.z;
        for (let i = LOD_LEVELS.length - 1; i >= 0; i--) {
            const cfg = LOD_LEVELS[i];
            if (camY >= cfg.showAlt) continue;
            if (this._caches[i].hasCoverageAt(x, z)) return true;
        }
        return false;
    }

    // Fraction 0..1 of the near neighbourhood around the look-at point covered by
    // solidly-loaded (opacity ≥ 0.8) tiles at the active level. Drives HOW MUCH
    // the base splat fades (main.js): the base leaves only as REAL coverage
    // arrives, so a slow load shows the base cloud, never a black void. Fixes the
    // "one tile loads → whole base drops → black holes everywhere else" bug
    // (2026-07-15).
    coverageFraction(camera, lookAt = null) {
        if (!this._enabled || !this._ready) return 0;
        const camY = _effectiveAltitude(camera, lookAt);
        let ai = -1;
        for (let i = LOD_LEVELS.length - 1; i >= 0; i--) {
            if (camY < LOD_LEVELS[i].showAlt) { ai = i; break; }
        }
        if (ai < 0) return 0;
        const x = lookAt ? lookAt.x : camera.position.x;
        const z = lookAt ? lookAt.z : camera.position.z;
        // Scan the nominal active level AND its two parents, taking the best solid
        // fraction. At a band threshold the active level is barely faded in (near-
        // transparent) while its PARENT is the level actually painting the ground —
        // counting only the active level made the base cloud refuse to hand off
        // (coverage read 0 though tiles were clearly on screen). Now the base fades
        // to whatever level is genuinely solid under the look-at.
        let best = 0;
        for (let i = ai; i >= 0 && i >= ai - 2; i--) {
            const cache = this._caches[i];
            const TPX = 2 ** (cache._cfg.zoom + 1);
            const TPY = 2 ** cache._cfg.zoom;
            const ctx = cache._gridTx(x);
            const cty = cache._gridTy(z);
            let total = 0, solid = 0;
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++) {
                    const tx = ((ctx + dx) % TPX + TPX) % TPX;
                    const ty = Math.max(0, Math.min(TPY - 1, cty + dy));
                    total++;
                    const e = cache._tiles.get(`${cache._cfg.zoom}/${tx}/${ty}`);
                    if (e && e.opacity >= 0.8) solid++;
                }
            }
            if (total && solid / total > best) best = solid / total;
        }
        return best;
    }

    closeCoverage(camera, lookAt = null) {
        if (!this._enabled || !this._ready) return false;
        const camY = _effectiveAltitude(camera, lookAt);
        let active = -1;
        LOD_LEVELS.forEach((cfg, i) => { if (camY < cfg.showAlt) active = i; });
        if (active < 0) return false;
        // Parent coverage counts too: Cesium World Terrain has no deep-zoom QM
        // tiles over flat regions (z12 404s across much of Africa, 2026-07-12),
        // and the LOD gate holds the parent at full opacity there — the ground
        // IS painted, so the dots may hand off. Anchor on the look-at point,
        // same as update() — the camera is degrees behind what's on screen.
        const x = lookAt ? lookAt.x : camera.position.x;
        const z = lookAt ? lookAt.z : camera.position.z;
        return this._caches[active].hasCoverageAt(x, z)
            || (active > 0 && this._caches[active - 1].hasCoverageAt(x, z));
    }

    dispose() {
        this._caches.forEach(c => c.dispose());
    }
}
