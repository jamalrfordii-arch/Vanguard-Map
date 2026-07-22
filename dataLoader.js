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

export async function loadAndStitchTiles(urls, gridCols, gridRows, tag = 'tiles') {
    const tFetch = performance.now();
    const images = await Promise.all(urls.map(loadRawImage));
    mark(`fetch ${tag}`, { tiles: urls.length });
    const tStitch = performance.now();
    const tileW = images[0].width;
    const tileH = images[0].height;
    const canvas = document.createElement('canvas');
    canvas.width = tileW * gridCols;
    canvas.height = tileH * gridRows;
    const ctx = canvas.getContext('2d');

    for (let i = 0; i < images.length; i++) {
        let col = i % gridCols;
        let row = Math.floor(i / gridCols);
        ctx.drawImage(images[i], col * tileW, row * tileH);
    }

    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    // getImageData on a 4096² canvas is a known mobile stall point — time it separately.
    mark(`stitch+decode ${tag}`, { px: `${canvas.width}x${canvas.height}`, bufMB: +(data.byteLength / 1048576).toFixed(1) });
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