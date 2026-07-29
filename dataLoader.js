// dataLoader.js — Remote tile fetching, stitching, and GeoJSON ingestion

import { mark } from './bootProfiler.js';   // measurement-only; no behavior change

export function loadRawImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = url;
    });
}

const _sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Blank-tile guard (2026-07-24) ─────────────────────────────────────────────
// The old stitcher did `Promise.all(urls.map(loadRawImage))`, which only guards
// against a NETWORK error: a tile that comes back HTTP 200 but with blank/black
// pixels (EOX s2cloudless does this intermittently under load) loaded "fine" and
// was drawn straight into the mosaic — baking a permanent black square into
// _colorData, i.e. every base-cloud point in that grid cell rendered black. That
// was the "dark rectangle over Perth" bug. We now (a) tolerate per-tile failures
// instead of failing the whole map, (b) detect near-black tiles and retry them
// with a cache-bust, and (c) patch any still-bad tile from its nearest good
// neighbour so nothing bakes black.
//
// Mean luminance via a tiny 16×16 downsample — cheap enough to run per tile.
const _lumCanvas = (typeof document !== 'undefined') ? document.createElement('canvas') : null;
if (_lumCanvas) { _lumCanvas.width = _lumCanvas.height = 16; }
const _lumCtx = _lumCanvas ? _lumCanvas.getContext('2d', { willReadFrequently: true }) : null;
function _meanLuminance(img) {
    if (!_lumCtx) return 255;
    _lumCtx.clearRect(0, 0, 16, 16);
    _lumCtx.drawImage(img, 0, 0, 16, 16);
    const d = _lumCtx.getImageData(0, 0, 16, 16).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
    return sum / (256 * 3);   // 0..255; a real land/ocean tile is well above ~4
}

// Load one tile with retry. NEVER rejects — resolves to { img, failed }. A
// network error OR a near-black tile (when detectBlank) triggers a backoff
// retry with a cache-bust so a cached blank isn't just re-served.
async function _loadTileRobust(url, { detectBlank = false, attempts = 3 } = {}) {
    for (let a = 1; a <= attempts; a++) {
        const tryUrl = a === 1 ? url : `${url}${url.includes('?') ? '&' : '?'}vg1r=${a}`;
        try {
            const img = await loadRawImage(tryUrl);
            if (detectBlank && _meanLuminance(img) < 4) {
                if (a < attempts) { await _sleep(200 * a); continue; }
                return { img, failed: true };   // still blank after retries
            }
            return { img, failed: false };
        } catch (_) {
            if (a < attempts) { await _sleep(200 * a); continue; }
            return { img: null, failed: true };
        }
    }
    return { img: null, failed: true };
}

// Nearest successfully-loaded tile by grid (Manhattan) distance.
function _nearestGoodTile(idx, results, cols) {
    const c0 = idx % cols, r0 = Math.floor(idx / cols);
    let best = null, bestD = Infinity;
    for (let i = 0; i < results.length; i++) {
        if (!results[i].img || results[i].failed) continue;
        const c = i % cols, r = Math.floor(i / cols);
        const d = Math.abs(c - c0) + Math.abs(r - r0);
        if (d < bestD) { bestD = d; best = results[i]; }
    }
    return best;
}

export async function loadAndStitchTiles(urls, gridCols, gridRows, tag = 'tiles', opts = {}) {
    // Satellite colour tiles get blank-tile detection by default; DEM tiles do
    // NOT — a black terrarium pixel legitimately means sea level, not a failure.
    const detectBlank = opts.detectBlank ?? (tag === 'satellite');

    const tFetch = performance.now();
    const results = await Promise.all(urls.map(u => _loadTileRobust(u, { detectBlank })));
    mark(`fetch ${tag}`, { tiles: urls.length });
    const tStitch = performance.now();

    const firstGood = results.find(r => r.img);
    if (!firstGood) throw new Error(`loadAndStitchTiles(${tag}): every tile failed to load`);
    const tileW = firstGood.img.width;
    const tileH = firstGood.img.height;

    const canvas = document.createElement('canvas');
    canvas.width  = tileW * gridCols;
    canvas.height = tileH * gridRows;
    const ctx = canvas.getContext('2d');

    // Pass 1 — draw every good tile.
    const bad = [];
    for (let i = 0; i < results.length; i++) {
        const col = i % gridCols, row = Math.floor(i / gridCols);
        if (results[i].img && !results[i].failed) {
            ctx.drawImage(results[i].img, col * tileW, row * tileH);
        } else {
            bad.push(i);
        }
    }

    // Pass 2 — patch any bad tile from its nearest good neighbour so the mosaic
    // never bakes a black hole into the base colour cloud.
    if (bad.length) {
        console.warn(`[tiles] ${tag}: ${bad.length}/${urls.length} tile(s) failed or blank — patched from neighbours:`, bad);
        for (const i of bad) {
            const col = i % gridCols, row = Math.floor(i / gridCols);
            const src = _nearestGoodTile(i, results, gridCols);
            if (src && src.img) ctx.drawImage(src.img, col * tileW, row * tileH);
        }
    }

    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    // getImageData on a 4096² canvas is a known mobile stall point — time it separately.
    mark(`stitch+decode ${tag}`, { px: `${canvas.width}x${canvas.height}`, bufMB: +(data.byteLength / 1048576).toFixed(1), patched: bad.length });
    return { data, w: canvas.width, h: canvas.height };
}

export async function fetchWorldBorders() {
    const res = await fetch('https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_110m_admin_0_countries.geojson');
    return res.json();
}

export async function loadGEBCO(url = './gebco_terrarium.png') {
    // Strategy: try fetch → createImageBitmap first (avoids CORS preflight for
    // same-origin assets that simple dev servers won't CORS-enable).
    // If fetch fails (e.g. file:// origin), fall back to a plain <img> WITHOUT
    // crossOrigin — no CORS header needed, canvas isn't tainted for same-origin.
    const _decode = (canvas) => ({
        data: canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data,
        w: canvas.width,
        h: canvas.height,
    });

    // ── Path A: fetch (HTTP servers, recommended) ─────────────────────────────
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob   = await response.blob();
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width  = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        bitmap.close();
        const result = _decode(canvas);
        console.log(`[GEBCO] ✓ Loaded via fetch — ${result.w}×${result.h} bathymetry active`);
        return result;
    } catch (fetchErr) {
        console.warn('[GEBCO] fetch path failed, trying <img> fallback:', fetchErr.message);
    }

    // ── Path B: plain <img> without crossOrigin (file:// or CORS-free servers) ─
    return new Promise((resolve, reject) => {
        const img = new Image();
        // No crossOrigin attribute — same-origin canvas reads work without it.
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width  = img.width;
            canvas.height = img.height;
            canvas.getContext('2d').drawImage(img, 0, 0);
            try {
                const result = _decode(canvas);
                console.log(`[GEBCO] ✓ Loaded via <img> — ${result.w}×${result.h} bathymetry active`);
                resolve(result);
            } catch (e) {
                console.error('[GEBCO] canvas tainted — pixel read blocked:', e);
                reject(e);
            }
        };
        img.onerror = (e) => { console.error('[GEBCO] <img> load failed:', e); reject(new Error('GEBCO img onerror')); };
        img.src = url;
    });
}

export async function loadAllData(onProgress, opts = {}) {
    // ── Tile resolution scales with the chosen quality tier (passed from main.js
    // via quality.tileZoom()). This is THE load-time-vs-capability lever: a LOW
    // machine fetches far fewer/smaller tiles instead of the full 4096² payload.
    //   zoom 2 → 4×4 = 16 tiles/layer, 1024²   (LOW)
    //   zoom 3 → 8×8 = 64 tiles/layer, 2048²    (MEDIUM)
    //   zoom 4 → 16×16 = 256 tiles/layer, 4096² (HIGH / ULTRA)
    // 256×256 px tiles; GRID_SIZE = 2^ZOOM covers the whole world. All fetches run
    // in parallel so wall-clock ≈ slowest tile. Elevation/colour samplers read the
    // actual stitched image dimensions, so they adapt to whatever resolution loads.
    const ZOOM      = Math.max(2, Math.min(4, opts.zoom ?? 4));
    const GRID_SIZE = 1 << ZOOM;   // 2^ZOOM tiles per axis

    // ── Fully-open base map (2026-07-15) ──────────────────────────────────────
    // The base cloud is now built from token-free open data end to end:
    //   • Elevation: AWS Terrarium tiles (already open) — Copernicus/SRTM DEM.
    //   • Colour:    EOX Sentinel-2 cloudless — an open, CORS-readable, cloud-free
    //                global mosaic (verified 256² + pixel-readable), replacing
    //                ArcGIS World Imagery. Same WebMercator z/y/x tiling.
    // No Cesium/ArcGIS token anywhere in the floor. Flip BASE_COLOR_SOURCE back to
    // 'arcgis' to revert; bump the s2cloudless year as EOX publishes new mosaics.
    const BASE_COLOR_SOURCES = {
        eox:    (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/GoogleMapsCompatible/${z}/${y}/${x}.jpg`,
        arcgis: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    };
    const BASE_COLOR_SOURCE = 'eox';
    const colorUrlFor = BASE_COLOR_SOURCES[BASE_COLOR_SOURCE];

    const demUrls = [];
    const colorUrls = [];
    for (let y = 0; y < GRID_SIZE; y++) {
        for (let x = 0; x < GRID_SIZE; x++) {
            demUrls.push(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${ZOOM}/${x}/${y}.png`);
            colorUrls.push(colorUrlFor(ZOOM, x, y));
        }
    }

    if (onProgress) onProgress('DOWNLOADING REAL-WORLD DATA, BATHYMETRY & GEOPOLITICAL BORDERS...');

    mark('loadAllData start', { zoom: ZOOM, gridTilesPerAxis: GRID_SIZE, totalTiles: GRID_SIZE * GRID_SIZE * 2, skipGebco: !!opts.skipGebco });

    // GEBCO is a flat ~54 MB download that doesn't scale with tier. On LOW we skip
    // it entirely — the ocean floor falls back to the (coarser) Terrarium bathymetry
    // via getBestElevation, same as the "not found" path. Big win for weak machines.
    const gebcoPromise = opts.skipGebco
        ? Promise.resolve((onProgress && onProgress('GEBCO SKIPPED (LOW TIER) — TERRARIUM OCEAN FLOOR'), null))
        : loadGEBCO()
            .then(obj => {
                mark('GEBCO load+decode', { bufMB: obj ? +(obj.data.byteLength / 1048576).toFixed(1) : 0 });
                if (onProgress) onProgress('GEBCO BATHYMETRY LOADED — 8192×4096 OCEAN FLOOR ACTIVE');
                return obj;
            })
            .catch(err => {
                console.warn('[GEBCO] gebco_terrarium.png not found or failed to load — ocean floor will use Terrarium data.', err);
                if (onProgress) onProgress('GEBCO NOT FOUND — USING TERRARIUM OCEAN DATA');
                return null;
            });

    const [demObj, colorObj, worldBordersGeoJSON, gebcoObj] = await Promise.all([
        loadAndStitchTiles(demUrls, GRID_SIZE, GRID_SIZE, 'DEM'),
        loadAndStitchTiles(colorUrls, GRID_SIZE, GRID_SIZE, 'satellite'),
        fetchWorldBorders().then(b => { mark('fetch world borders'); return b; }),
        gebcoPromise,
    ]);

    return {
        demData: demObj.data, imgW: demObj.w, imgH: demObj.h,
        colorData: colorObj.data, colorW: colorObj.w, colorH: colorObj.h,
        worldBordersGeoJSON,
        gebcoData: gebcoObj ? gebcoObj.data : null,
        gebcoW:    gebcoObj ? gebcoObj.w    : 0,
        gebcoH:    gebcoObj ? gebcoObj.h    : 0,
    };
}