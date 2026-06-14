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

export async function loadAllData(onProgress) {
    // ── Zoom level 3 — 8×8 grid = 64 tiles = 2048×2048 source resolution ────────
    // Up from zoom 2 (4×4 = 1024×1024).  Each tile is still 256×256 px;
    // doubling the grid in each axis gives 4× the DEM and colour detail —
    // sharper ridgelines, finer river valleys, crisper coastlines.
    // Trade-off: 64 fetches vs 16 at startup.  All fetches run in parallel so
    // wall-clock cost ≈ slowest tile, not 4× longer.
    const ZOOM      = 4;
    const GRID_SIZE = 16;  // 2^ZOOM tiles per axis — 256 tiles, 4096×4096 resolution

    const demUrls = [];
    const colorUrls = [];
    for (let y = 0; y < GRID_SIZE; y++) {
        for (let x = 0; x < GRID_SIZE; x++) {
            demUrls.push(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${ZOOM}/${x}/${y}.png`);
            colorUrls.push(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${ZOOM}/${y}/${x}`);
        }
    }

    if (onProgress) onProgress('DOWNLOADING REAL-WORLD DATA, BATHYMETRY & GEOPOLITICAL BORDERS...');

    mark('loadAllData start', { zoom: ZOOM, gridTilesPerAxis: GRID_SIZE, totalTiles: GRID_SIZE * GRID_SIZE * 2 });
    const [demObj, colorObj, worldBordersGeoJSON, gebcoObj] = await Promise.all([
        loadAndStitchTiles(demUrls, GRID_SIZE, GRID_SIZE, 'DEM'),
        loadAndStitchTiles(colorUrls, GRID_SIZE, GRID_SIZE, 'satellite'),
        fetchWorldBorders().then(b => { mark('fetch world borders'); return b; }),
        loadGEBCO()
            .then(obj => {
                mark('GEBCO load+decode', { bufMB: obj ? +(obj.data.byteLength / 1048576).toFixed(1) : 0 });
                if (onProgress) onProgress('GEBCO BATHYMETRY LOADED — 8192×4096 OCEAN FLOOR ACTIVE');
                return obj;
            })
            .catch(err => {
                console.warn('[GEBCO] gebco_terrarium.png not found or failed to load — ocean floor will use Terrarium data.', err);
                if (onProgress) onProgress('GEBCO NOT FOUND — USING TERRARIUM OCEAN DATA');
                return null;
            })
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