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
import { MAP_WIDTH, MAP_HEIGHT, TERRAIN_VERTICAL_SCALE, TILESTREAM } from './config.js';
import { getTrueElevation } from './terrainBuilder.js';

// Reused every frame in update() to read camera tilt — never allocate a new
// Vector3 per frame (see CLAUDE.md perf rule: reuse scratch vectors).
const _tmpVec3 = new THREE.Vector3();

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
const IMG_MAX_CONCURRENT = 20;    // 6→12→20: imagery is the visible fill-in throttle; a full-coverage close-zoom grid needs more parallel drapes
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
function _pumpBuildQueue() {
    const t0 = performance.now();
    while (_buildQueue.length && performance.now() - t0 < BUILD_BUDGET_MS) {
        let bi = 0;
        for (let i = 1; i < _buildQueue.length; i++) {
            if (_buildQueue[i].priority < _buildQueue[bi].priority) bi = i;
        }
        const job = _buildQueue.splice(bi, 1)[0];
        job.run();
    }
    requestAnimationFrame(_pumpBuildQueue);
}
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
    //   { zoom: 10, showAlt: 2.3, fadeBand: 0.6,  maxActive: 60, loadRadius: 3, render: 'points', ptsBudget: 40000, ptSize: 0.0112, imgSize: 512 },
    //   { zoom: 11, showAlt: 1.3, fadeBand: 0.35, maxActive: 60, loadRadius: 3, render: 'points', ptsBudget: 46000, ptSize: 0.0106, imgSize: 512 },
    //   { zoom: 12, showAlt: 0.7, fadeBand: 0.22, maxActive: 60, loadRadius: 3, render: 'points', ptsBudget: 52000, ptSize: 0.0102, imgSize: 512 },
];
// Original per-level point budgets, captured before the adaptive coverage logic
// in update() caps the active/parent levels. Non-active levels are restored to
// these each frame so a level that was capped while active returns to full
// density when it steps back to being a backdrop.
const BASE_BUDGET = LOD_LEVELS.map(c => c.ptsBudget);

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
function geoTileBounds(tx, ty, zoom) {
    const dLon = 360 / (2 ** (zoom + 1));
    const dLat = 180 / (2 ** zoom);
    return {
        west:  tx * dLon - 180,
        east:  (tx + 1) * dLon - 180,
        south: ty * dLat - 90,
        north: (ty + 1) * dLat - 90,
    };
}

/** Longitude → scene X (matches lonLatToScene in aisManager.js). */
function lonToSceneX(lonDeg) {
    return lonDeg * (MAP_WIDTH / 360);
}

/** Latitude → scene Z (Web Mercator, matches lonLatToScene). */
function latToSceneZ(latDeg) {
    const lr = Math.max(-1.48, Math.min(1.48, latDeg * DEG2RAD));
    const my = Math.log(Math.tan(Math.PI / 4 + lr / 2));
    return -my * (MAP_HEIGHT / TWO_PI);
}

/**
 * Earth-curvature Y offset — matches the formula in terrainWorker.js exactly
 * so tile meshes sit flush against the splat-cloud surface.
 */
function curveOffset(sceneX, sceneZ) {
    const dist = Math.sqrt((sceneX / MAP_WIDTH) ** 2 + (sceneZ / MAP_HEIGHT) ** 2);
    return -Math.pow(dist, 2) * 20.0;
}

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
function _pHash(x, y) {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
}
function _pValNoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = _pHash(xi, yi),     b = _pHash(xi + 1, yi);
    const c = _pHash(xi, yi + 1), d = _pHash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;   // 0..1
}
function _pFbm(x, y) {
    let f = 0, amp = 0.5, freq = 1;
    for (let o = 0; o < 4; o++) { f += amp * _pValNoise(x * freq, y * freq); freq *= 2.03; amp *= 0.5; }
    return f;   // ~0..1, mean ≈ 0.5
}

function elevToColor(elev) {
    let r, g, b;

    if (elev < -6000) {
        r = 0.01; g = 0.04; b = 0.15;
    } else if (elev < -2000) {
        const t = (elev + 6000) / 4000;
        r = 0.01 + t * 0.03; g = 0.04 + t * 0.10; b = 0.15 + t * 0.20;
    } else if (elev < -200) {
        const t = (elev + 2000) / 1800;
        r = 0.04 + t * 0.04; g = 0.14 + t * 0.16; b = 0.35 + t * 0.20;
    } else if (elev < 0) {
        const t = (elev + 200) / 200;
        r = 0.08 + t * 0.04; g = 0.30 + t * 0.10; b = 0.55 + t * 0.10;
    } else if (elev < 150) {
        const t = elev / 150;
        r = 0.16 + t * 0.10; g = 0.28 + t * 0.08; b = 0.10 + t * 0.02;
    } else if (elev < 600) {
        const t = (elev - 150) / 450;
        r = 0.26 + t * 0.08; g = 0.36 - t * 0.04; b = 0.12 - t * 0.02;
    } else if (elev < 1500) {
        const t = (elev - 600) / 900;
        r = 0.34 + t * 0.10; g = 0.32 - t * 0.08; b = 0.10 - t * 0.02;
    } else if (elev < 3000) {
        const t = (elev - 1500) / 1500;
        r = 0.44 + t * 0.10; g = 0.24 - t * 0.06; b = 0.08 + t * 0.04;
    } else if (elev < 4500) {
        const t = (elev - 3000) / 1500;
        r = 0.54 + t * 0.30; g = 0.18 + t * 0.58; b = 0.12 + t * 0.72;
    } else {
        r = 0.86; g = 0.90; b = 0.96;
    }

    return {
        r: Math.min(1, Math.max(0, r)),
        g: Math.min(1, Math.max(0, g)),
        b: Math.min(1, Math.max(0, b)),
    };
}

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
    _scheduleImageryRetry(key, imgUrl, expectedThing, applyFn, attempt = 1) {
        const MAX_ATTEMPTS = 5;                       // total tries across all rounds
        const BACKOFF_MS   = [0, 1500, 3500, 7000, 12000]; // delay BEFORE this attempt
        const stillRelevant = () => {
            const entry = this._tiles.get(key);
            return !!entry && (entry.mesh === expectedThing || entry.skirtMesh === expectedThing);
        };
        const tryOnce = () => {
            if (!stillRelevant()) { this._imgFailures.delete(key); return; }
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
                this._scheduleImageryRetry(key, imgUrl, expectedThing, applyFn, attempt + 1);
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

    // ── Open-ocean pre-check (2026-07-21) ──────────────────────────────────────
    // A tile that's genuinely open ocean everywhere has nothing to gain from a
    // Cesium QM + ArcGIS imagery fetch — the base splat cloud + water plane
    // already render it correctly, and (per the same-day tile-ocean-bleed fix
    // in _buildPoints) an all-ocean tile ends up building an EMPTY points
    // geometry anyway. Fetching it first was pure waste: bandwidth, a slot in
    // the throttled QM/imagery queues that a real coastal/land tile could have
    // used instead, and decode time for data that gets thrown away. This uses
    // the SAME low-res DEM already loaded for the base terrain/water-mask
    // (`getTrueElevation`, via terrainBuilder.js) to classify a tile BEFORE
    // ever fetching it — cheap, synchronous, no network. A 5×5 sample grid
    // across the tile's real bounds, with a conservative -60m margin (deeper
    // than the ±20m per-point margins used elsewhere) so a genuine sliver of
    // low-lying coast within a tile is never wrongly written off as ocean —
    // this only fires for tiles that read deep-negative EVERYWHERE sampled.
    // Cached per key in `_pureOcean` (mirrors `_unavailable`'s 404 cache) so
    // it's a one-time check, not a per-frame cost.
    _isPureOceanTile(tx, ty, key) {
        if (this._pureOcean.has(key)) return true;
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
        if (allDeepOcean) this._pureOcean.add(key);
        return allDeepOcean;
    }

    setTargetOpacity(v)    { this._targetOpac  = v; }
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

    update(camX, camZ, delta) {
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
            if (!this._tiles.has(key) && !this._loading.has(key) && this._targetOpac > 0) {
                if (this._isPureOceanTile(tx, ty, key)) continue;  // open ocean — never fetched, see _isPureOceanTile
                this._loadTile(tx, ty, d2);   // d2 = nearest-first fetch priority
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

        while (this._lruOrder.length > this._cfg.maxActive) {
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
            const imgPromise = (renderMode === 'points' && wantImagery) ? fetchImagery(imgUrl) : null;

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
                const built = await _queueBuild(() => this._buildPoints(tx, ty, qmData, null), priority);
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
                        const fallbackBuilt = await _queueBuild(() => this._buildPoints(tx, ty, flatData, null), priority);
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

                this._tiles.set(key, { mesh, skirtMesh: null, opacity: 0, lastAccess: performance.now() });
                this._lruOrder.push(key);

                if (imgPromise) {
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
                        // Tile may have been evicted (or already re-fetched) while
                        // imagery was in flight — only swap if it's still exactly
                        // the tile we built above.
                        const entry = this._tiles.get(key);
                        if (!entry || entry.mesh !== mesh) return true; // not a failure — tile moved on
                        const rebuilt = await _queueBuild(() => this._buildPoints(tx, ty, qmData, imgData), priority);
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
                        // Tile may have been evicted while imagery was in flight.
                        const entry = this._tiles.get(key);
                        if (!entry || entry.mesh !== mesh) { bmp.close(); return true; } // not a failure — tile moved on
                        this._applyImagery(mesh, bmp);
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
    _flatQM(buffer, tx, ty) {
        let minHeight = 0;
        try { const v = new DataView(buffer); minHeight = v.getFloat32(24, true); } catch (_) {}
        if (!Number.isFinite(minHeight)) minHeight = 0;

        if (tx !== undefined && ty !== undefined) {
            try {
                const b  = geoTileBounds(tx, ty, this._cfg.zoom);
                const cx = lonToSceneX((b.west + b.east) / 2);
                const cz = latToSceneZ((b.north + b.south) / 2);
                const trueElev = getTrueElevation(cx, cz);
                if (Number.isFinite(trueElev) && Math.abs(trueElev - minHeight) > 5) {
                    minHeight = trueElev;
                }
            } catch (_) { /* DEM not ready yet — keep the raw header read */ }
        }

        return {
            vertexCount: 4,
            uBuf: new Uint16Array([0, 32767, 0, 32767]),   // W,E,W,E
            vBuf: new Uint16Array([0, 0, 32767, 32767]),   // S,S,N,N
            hBuf: new Uint16Array([0, 0, 0, 0]),           // all at minHeight → flat
            minHeight, maxHeight: minHeight,
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
    _buildPoints(tx, ty, qmData, imgData = null) {
        const b  = geoTileBounds(tx, ty, this._cfg.zoom);
        let x0 = lonToSceneX(b.west),  x1 = lonToSceneX(b.east);
        let z0 = latToSceneZ(b.north), z1 = latToSceneZ(b.south);
        // Edge overlap (2026-07-18): point tiles have no skirts, so their dots stop
        // exactly at the tile boundary and adjacent tiles leave a thin dark seam
        // between them (very visible against a dark/night backdrop). Expand each
        // tile's point footprint a few % past its bounds so neighbours overlap and
        // cover the crack. Vertices are placed via tileU/tileV across [x0,x1]/[z0,z1],
        // so widening those spans spreads the points outward.
        //
        // Relief-scaled overlap (2026-07-21): a flat 0.8% margin covers flat/rolling
        // ground fine, but Jamal reported real black gaps "when the land elevates" —
        // steep tiles (mountains, cliffs, canyon walls) have far more VERTICAL
        // separation between two horizontally-close edge points than flat terrain
        // does, so the same horizontal overlap that hides a flat seam isn't enough
        // to visually bridge a steep one; the gap opens along the elevation change,
        // not along an XZ boundary. qmData.minHeight/maxHeight (already decoded,
        // free) is a direct measure of this tile's local relief — scale the margin
        // up for tiles with real vertical range instead of a one-size-fits-all 0.8%.
        {
            const relief = Math.max(0, qmData.maxHeight - qmData.minHeight);
            // 0.8% base, ramping toward 4% by ~4000m of relief (steep alpine terrain).
            const reliefBoost = Math.min(0.032, relief / 125000);
            const overlapFrac = 0.008 + reliefBoost;
            const _ovx = (x1 - x0) * overlapFrac, _ovz = (z1 - z0) * overlapFrac;
            x0 -= _ovx; x1 += _ovx; z0 -= _ovz; z1 += _ovz;
        }
        // Colour set by zoom (2026-07-18): only the close-up deep levels get the
        // vivid boost; coarse world-view tiles keep the original calibrated palette.
        const _deep      = this._cfg.zoom >= 6;   // 8→6 (2026-07-18): bring the bright, photographic "close-up" palette (more real imagery, more colour) in at a HIGHER altitude — z6/z7 now match the z8/z9 look, so the good render appears sooner as you descend. z3-z5 (world view) stay on the calmer far palette to avoid the desert gold-cast.
        const photoBlend = imgData ? (_deep ? TILESTREAM.PHOTO_BLEND : (TILESTREAM.PHOTO_BLEND_FAR ?? 0.80)) : 0;

        const { vertexCount, uBuf, vBuf, hBuf, minHeight, maxHeight, indices } = qmData;

        // Decode all vertices once: scene XZ + elevation in metres
        const vsx = new Float32Array(vertexCount);
        const vsz = new Float32Array(vertexCount);
        const vel = new Float32Array(vertexCount);
        for (let i = 0; i < vertexCount; i++) {
            const tileU = uBuf[i] / 32767;
            const tileV = vBuf[i] / 32767;
            vsx[i] = x0 + tileU * (x1 - x0);
            vsz[i] = z1 + tileV * (z0 - z1);
            vel[i] = minHeight + (hBuf[i] / 32767) * (maxHeight - minHeight);
        }

        // Area-weighted point budget per triangle, so density is even no matter
        // how coarse or fine Cesium's adaptive mesh is (flat tiles = few big
        // triangles; mountains = many small ones).
        //
        // Open-ocean exclusion (2026-07-20, "tile extends to the ocean and I can
        // still see the ocean through the tiles"): this loop used to give EVERY
        // triangle its area-weighted share of the budget, land or sea alike —
        // ocean triangles just clamp to elevY=0 (see the sampling loop below).
        // That's fine for tight coastal tiles, but coarse tiles (z3-z6) can span
        // huge stretches of open water alongside a sliver of coast, and every
        // point spent on that water is wasted: it's sparse (a few thousand points
        // over a whole tile), sits right at y=0 near the real water plane
        // (y=-0.2), and never fuses into a surface — so instead of solid ocean
        // you get a faint scatter of dots hovering just above the real, correctly
        // rendered water, letting it show through between them. Worse, the LAND
        // sub-tile of tile mesh sits directly above/beside these dots, reading as
        // a distinct patch "floating" over a moat of visible water where the
        // ocean-clamped points should've been. Fix: triangles that are open ocean
        // at every vertex (well below sea level, past any real coastal margin)
        // get NO budget at all — skip them in the area sum so their share goes to
        // land/coastal triangles instead, and skip them in the sampling loop below
        // too. The base splat cloud + water plane already render the ocean
        // correctly; the tile layer has no business drawing sparse ghost dots
        // over it. A -20m margin keeps genuine shoreline/shallow triangles (which
        // straddle the coastline within a tile) still eligible, same spirit as
        // the terrainWorker.js coastal-fill band.
        const OCEAN_MARGIN_M = -20;
        const triCount = indices.length / 3;
        const areas = new Float32Array(triCount);
        let totalArea = 0;
        for (let t = 0; t < triCount; t++) {
            const a = indices[t * 3], b2 = indices[t * 3 + 1], c = indices[t * 3 + 2];
            const isOpenOcean = vel[a] < OCEAN_MARGIN_M && vel[b2] < OCEAN_MARGIN_M && vel[c] < OCEAN_MARGIN_M;
            if (isOpenOcean) { areas[t] = 0; continue; }
            const area = Math.abs(
                (vsx[b2] - vsx[a]) * (vsz[c] - vsz[a]) -
                (vsx[c] - vsx[a]) * (vsz[b2] - vsz[a])
            ) * 0.5;
            areas[t] = area;
            totalArea += area;
        }

        const budget    = this._cfg.ptsBudget || TILESTREAM.POINTS_PER_TILE;
        const positions = new Float32Array(budget * 3);
        const colors    = new Float32Array(budget * 3);
        let n = 0;

        // Deterministic LCG seeded by tile coords — same tile always samples the
        // same points (no shimmer on evict + reload).
        let seed = ((tx * 73856093) ^ (ty * 19349663) ^ (this._cfg.zoom * 83492791)) >>> 0;
        const rand = () => {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            return seed / 4294967296;
        };

        // Procedural detail params — finer + smaller-amplitude at deeper zoom, so
        // it reads as genuine sub-DEM roughness rather than uniform bumpiness.
        const _sat       = _deep ? (TILESTREAM.POINT_SATURATION ?? 1.0)
                                 : (TILESTREAM.POINT_SATURATION_FAR ?? 1.0);   // vivid close-up, natural far (2026-07-18)
        const PROC       = TILESTREAM.PROCEDURAL || {};
        const _procOn    = PROC.ENABLED !== false;
        const _zf        = 2 ** Math.max(0, this._cfg.zoom - 7);      // 1 at z7 … 32 at z12
        const _procFreq  = (PROC.FREQ   ?? 12)    * _zf;
        const _procRelief= (PROC.RELIEF ?? 0.004) / Math.sqrt(_zf);
        const _procColor = (PROC.COLOR  ?? 0.14);

        // Fully-oceanic tile (every triangle excluded above) — totalArea is 0,
        // which would otherwise divide-to-NaN below. Nothing to draw: the water
        // plane and base cloud already cover it correctly, so just emit an empty
        // points geometry instead of a NaN-positioned one.
        for (let t = 0; totalArea > 0 && t < triCount && n < budget; t++) {
            const ia = indices[t * 3], ib = indices[t * 3 + 1], ic = indices[t * 3 + 2];
            let count = Math.round(budget * (areas[t] / totalArea));
            if (count === 0 && rand() < budget * (areas[t] / totalArea)) count = 1;
            for (let k = 0; k < count && n < budget; k++) {
                // Uniform barycentric sample (sqrt trick)
                const su = Math.sqrt(rand());
                const bv = su * (1 - rand());
                const bw = su - bv;                 // su*(r2) — bv+bw = su
                const ba = 1 - su;
                const sx = ba * vsx[ia] + bv * vsx[ib] + bw * vsx[ic];
                const sz = ba * vsz[ia] + bv * vsz[ib] + bw * vsz[ic];
                const el = ba * vel[ia] + bv * vel[ib] + bw * vel[ic];

                // Per-SAMPLE ocean trim (2026-07-21, "trim the tiles that hang
                // off into the ocean"): the triangle-level exclusion above only
                // drops triangles that are ocean at ALL THREE vertices — a
                // triangle with just one shore vertex and two far-out sea-floor
                // vertices (common at z6/z7's coarse Cesium triangulation near a
                // steep coast, where one huge triangle can span from the shore
                // out across a wide flat seabed) still gets its full area-
                // weighted budget, and every sample in it still got a point
                // before this fix, regardless of how deep that specific sample's
                // interpolated elevation was. Clamped to y=0 + dark elevToColor
                // blue, those samples rendered as a solid-looking shelf of
                // points hovering at sea level out over real, deeper water —
                // reported live as tiles "hanging off into the ocean." Reusing
                // the same OCEAN_MARGIN_M (-20m) here at the per-sample level:
                // skip (don't emit) any individual sample whose interpolated
                // elevation is past the margin, even inside an otherwise-
                // eligible straddling triangle. Shoreline samples (the shallow
                // side of that same triangle) still come through fine.
                if (el < OCEAN_MARGIN_M) continue;

                // Same elevation treatment as the mesh path: ocean clamps to sea
                // level, shoreline tapers, land scales.
                let elevY;
                if (el <= 0)       elevY = 0;
                else if (el < 15)  elevY = (el / 2000.0) * (el / 15);
                else               elevY = el / 2000.0;
                elevY *= TERRAIN_VERTICAL_SCALE;

                // ── Procedural sub-DEM micro-relief (synthesized, land only) ──────
                if (_procOn && el > 0) {
                    elevY += (_pFbm(sx * _procFreq, sz * _procFreq) - 0.5) * _procRelief;
                }

                positions[n * 3]     = sx;
                positions[n * 3 + 1] = elevY + curveOffset(sx, sz);
                positions[n * 3 + 2] = sz;

                let { r, g, b: cb } = elevToColor(el);
                if (photoBlend > 0) {
                    // Sample the satellite photo at this point's exact spot.
                    // Image row 0 = north; tile V axis runs south→north.
                    // 2×2 BOX AVERAGE (2026-07-13): single-pixel sampling made
                    // adjacent points carry uncorrelated colors — the mid-zoom
                    // "grainy and undefined" look. Averaging 4 texels smooths
                    // sample variance without blurring real structures.
                    const IS = this._cfg.imgSize || 256;
                    const tu = Math.min(IS - 2, Math.max(0, Math.round(((sx - x0) / (x1 - x0)) * (IS - 1))));
                    const tv = Math.min(IS - 2, Math.max(0, Math.round(((sz - z0) / (z1 - z0)) * (IS - 1))));
                    const i00 = (tv * IS + tu) * 4, i01 = i00 + 4;
                    const i10 = ((tv + 1) * IS + tu) * 4, i11 = i10 + 4;
                    const pr = (imgData[i00] + imgData[i01] + imgData[i10] + imgData[i11]) / 1020;
                    const pg = (imgData[i00+1] + imgData[i01+1] + imgData[i10+1] + imgData[i11+1]) / 1020;
                    const pb = (imgData[i00+2] + imgData[i01+2] + imgData[i10+2] + imgData[i11+2]) / 1020;
                    r  = r  * (1 - photoBlend) + pr * photoBlend;
                    g  = g  * (1 - photoBlend) + pg * photoBlend;
                    cb = cb * (1 - photoBlend) + pb * photoBlend;
                }
                // ── Procedural surface-texture colour variation (land only) ───────
                if (_procOn && el > 0) {
                    const _pt = 1 + (_pFbm(sx * _procFreq * 3.1 + 17.0, sz * _procFreq * 3.1 + 9.0) - 0.5) * _procColor;
                    r *= _pt; g *= _pt; cb *= _pt;
                }
                // ── Vividness (2026-07-18) ────────────────────────────────────────
                // Tile points are unlit, so this is the ONLY colour control they
                // have — the satellite palette is naturally muted (hazy, low-contrast
                // orbital imagery), which reads muddy at close zoom, especially over
                // arid terrain and on the night side. Push each point away from its
                // own luminance so the imagery comes in strong and true-coloured,
                // consistently for every tile on the planet. Clamp keeps the boost
                // from punching bright pixels over the bloom threshold.
                if (_sat !== 1) {
                    const L = 0.299 * r + 0.587 * g + 0.114 * cb;
                    r  = L + (r  - L) * _sat;
                    g  = L + (g  - L) * _sat;
                    cb = L + (cb - L) * _sat;
                    if (r < 0) r = 0; else if (r > 1.15) r = 1.15;
                    if (g < 0) g = 0; else if (g > 1.15) g = 1.15;
                    if (cb < 0) cb = 0; else if (cb > 1.15) cb = 1.15;
                }
                colors[n * 3]     = r;
                colors[n * 3 + 1] = g;
                colors[n * 3 + 2] = cb;
                n++;
            }
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, n * 3), 3));
        geo.setAttribute('color',    new THREE.BufferAttribute(colors.subarray(0, n * 3), 3));
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
            size:            (this._cfg.ptSize || TILESTREAM.POINT_SIZE) * (TILESTREAM.POINT_SMOOTH ?? 1),
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
                cache._cfg.ptsBudget  = Math.min(BASE_BUDGET[i], 28000);   // 24000→28000 (2026-07-20)
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
            // _detailDim (0..1) lets the layer coordinator fade the tile points
            // out from under a fully-present 3DGS capture so the splat is clean.
            this._caches[i].setTargetOpacity(target * (this._detailDim ?? 1));
            this._caches[i].update(camX, camZ, delta);
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
