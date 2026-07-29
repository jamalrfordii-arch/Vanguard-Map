// tileCoverageScanner.js — global QM terrain-coverage scanner ("where do tiles
// not exist?").
//
// WHY THIS EXISTS
// ───────────────
// The detail levels z9–z12 stream Cesium World Terrain quantized-mesh (QM) tiles
// from the Ion origin and render them as point clouds. Where a QM tile 404s the
// source data simply DOES NOT EXIST there — the tile is negative-cached and the
// map keeps showing the coarser level's sparser points. That is the "zoom in and
// it's just sparse dots" symptom. It is already known to happen across much of
// Africa at z12 (~40% 404 over flat ground, see tileStreamManager.js) and
// everywhere north of 60°N (SRTM's limit, see terrainCoverage.js) — but nobody
// has ever measured the WHOLE map. This does.
//
// WHAT IT DOES
// ────────────
// Probes the real Ion QM endpoint directly (no camera flying, no rendering — just
// the fetches, reading HTTP status and cancelling the body) across every land
// tile on Earth, z9 → z12, and records every 404. It exploits two loss-free facts
// so "exhaustive" is actually feasible:
//
//   1. LAND ONLY. Ocean tiles return a flat 200 mesh the sea plane already draws;
//      the user cares about land detail. tileLandMask gates the seed level.
//   2. COVERAGE NESTS. Cesium's high-res source is hierarchical: if a tile 404s,
//      every finer tile under its footprint 404s too (z12 404s MORE than z11, not
//      less). So a 404 subtree is pruned — we never probe under a hole. This
//      discards ZERO real coverage; it only skips provably-absent tiles.
//
// Unit of resumable work is one z9 tile + its ≤85-tile subtree (z10×4, z11×16,
// z12×64). Completed seeds are checkpointed to IndexedDB, so a multi-hour run
// survives a tab reload and resumes where it stopped. Even a partial run yields a
// valid (partial) heatmap.
//
// Console API (run in the LIVE app — needs the Ion token + land mask on window):
//   await vg1CoverageScan.estimate()          → seed count + rough request order, no scan
//   await vg1CoverageScan.run()               → full exhaustive z9–z12 over all land
//   await vg1CoverageScan.run({ maxZoom: 10 })            → shallower first pass
//   await vg1CoverageScan.run({ bbox:[w,s,e,n] })         → one region
//   vg1CoverageScan.stop()                    → abort the running scan
//   vg1CoverageScan.heatmap()                 → render + download PNG per level
//   vg1CoverageScan.exportJSON()              → download the hole manifest
//   vg1CoverageScan.clearCheckpoint()         → forget saved progress, start clean
//
// It reuses the SAME token flow the app uses (localStorage 'vg1_cesium_token' →
// Ion asset-1 endpoint → short-lived session token), refreshed every 50 min, so
// the numbers are apples-to-apples with what the map itself fetches.

import { tileLandMask } from './tileLandMask.js';

// ── Grid math (Cesium GeographicTilingScheme, EPSG:4326 TMS) ──────────────────
// Must match tileStreamManager.js _gridTx/_gridTy EXACTLY or the probed tile is
// not the tile the map fetches. 2^(z+1) columns × 2^z rows; ty=0 is the SOUTH
// pole; both axes are LINEAR in geographic degrees (NOT Mercator — the scene is
// Mercator, the tile grid is not).
const TPX = (z) => 2 ** (z + 1);
const TPY = (z) => 2 ** z;

/** West/south/east/north degrees of tile (z,tx,ty). */
function tileBounds(z, tx, ty) {
    const wSpan = 360 / TPX(z);
    const hSpan = 180 / TPY(z);
    const west  = -180 + tx * wSpan;
    const south =  -90 + ty * hSpan;
    return { west, south, east: west + wSpan, north: south + hSpan };
}

/** The four z+1 children of a tile — standard quadtree, valid because TPX and
 *  TPY both double per level. */
function childrenOf(tx, ty) {
    const x0 = tx * 2, y0 = ty * 2;
    return [
        [x0,     y0],
        [x0 + 1, y0],
        [x0,     y0 + 1],
        [x0 + 1, y0 + 1],
    ];
}

// ── Known, non-bug coverage limit (SRTM northern edge) ────────────────────────
// Cesium's high-res terrain is SRTM-derived and SRTM never imaged above 60°N, so
// z9+ is guaranteed 404 there. It is a data limit, not a hole to fix. We CLASSIFY
// these separately and, by default, skip probing them (they are the ~150 doomed
// round-trips the app itself avoids). Mirrors terrainCoverage.js exactly. Gate on
// the tile's SOUTH edge, since a tile straddling 60°N still returns 200.
const SRTM_NORTH_LIMIT_DEG   = 60.0;
const SRTM_FIRST_LIMITED_ZOOM = 9;
function isKnownNorthGap(z, ty) {
    if (z < SRTM_FIRST_LIMITED_ZOOM) return false;
    return tileBounds(z, 0, ty).south >= SRTM_NORTH_LIMIT_DEG;
}

// ── Config ────────────────────────────────────────────────────────────────────
const LEVELS_ALL      = [9, 10, 11, 12];
const ION_ENDPOINT    = (tok) => `https://api.cesium.com/v1/assets/1/endpoint?access_token=${tok}`;
const TOKEN_REFRESH_MS = 50 * 60 * 1000;      // Ion session token lives ~1h; refresh at 50m
const DEFAULT_CONCURRENCY = 24;               // Ion origin is HTTP/2 and tolerant
const MAX_ATTEMPTS    = 4;                     // per-tile retry on 429/5xx/network
const BACKOFF_BASE_MS = 400;
const COARSE_DEG      = 1.0;                    // heatmap / manifest cell size (degrees)
const CHECKPOINT_EVERY = 500;                  // flush progress to IndexedDB every N seeds

const IDB_NAME = 'vg1-coverage-scan';
const IDB_STORE = 'state';

// Status buckets a probe resolves to.
const OK = 'ok', HOLE = 'hole', KNOWN = 'known', ERR = 'err';

// ── Tiny IndexedDB wrapper (resumable checkpoint) ─────────────────────────────
function idbOpen() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}
async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
        const t = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
        t.onsuccess = () => resolve(t.result);
        t.onerror   = () => reject(t.error);
    });
}
async function idbPut(key, val) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
        const t = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(val, key);
        t.onsuccess = () => resolve();
        t.onerror   = () => reject(t.error);
    });
}
async function idbClear() {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
        const t = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).clear();
        t.onsuccess = () => resolve();
        t.onerror   = () => reject(t.error);
    });
}

// ── Coarse accumulator: per-level hole/probe counts on a COARSE_DEG grid ──────
// This is what the heatmap and JSON read. We never keep per-tile holes (Africa
// alone has millions at z12) — only a fixed ~720×360 grid of counters per level,
// which is a few MB and renders directly.
class CoarseGrid {
    constructor() {
        this.cols = Math.round(360 / COARSE_DEG);
        this.rows = Math.round(180 / COARSE_DEG);
        // per level: Int32Array of probed and holes, cols*rows each
        this.probed = {};
        this.holes  = {};
        for (const z of LEVELS_ALL) {
            this.probed[z] = new Int32Array(this.cols * this.rows);
            this.holes[z]  = new Int32Array(this.cols * this.rows);
        }
    }
    _idx(lon, lat) {
        let cx = Math.floor((lon + 180) / COARSE_DEG);
        let cy = Math.floor((lat + 90)  / COARSE_DEG);
        cx = Math.max(0, Math.min(this.cols - 1, cx));
        cy = Math.max(0, Math.min(this.rows - 1, cy));
        return cy * this.cols + cx;
    }
    record(z, tx, ty, isHole) {
        const b = tileBounds(z, tx, ty);
        const i = this._idx((b.west + b.east) / 2, (b.south + b.north) / 2);
        this.probed[z][i]++;
        if (isHole) this.holes[z][i]++;
    }
    // Serialisable snapshot for the checkpoint.
    dump() {
        const o = { cols: this.cols, rows: this.rows, probed: {}, holes: {} };
        for (const z of LEVELS_ALL) {
            o.probed[z] = Array.from(this.probed[z]);
            o.holes[z]  = Array.from(this.holes[z]);
        }
        return o;
    }
    load(o) {
        if (!o || o.cols !== this.cols || o.rows !== this.rows) return;
        for (const z of LEVELS_ALL) {
            if (o.probed[z]) this.probed[z] = Int32Array.from(o.probed[z]);
            if (o.holes[z])  this.holes[z]  = Int32Array.from(o.holes[z]);
        }
    }
}

class CoverageScanner {
    constructor() {
        this._tileBase = null;
        this._token    = null;
        this._tokenTimer = null;
        this._running  = false;
        this._abort    = false;
        this.grid      = new CoarseGrid();
        this.totals    = {};                 // per level {probed, holes, known, err}
        for (const z of LEVELS_ALL) this.totals[z] = { probed: 0, holes: 0, known: 0, err: 0 };
        this._doneSeeds = new Set();          // "tx/ty" of z9 seeds fully processed
        this._lastParams = null;
    }

    // ── Ion token (same flow as tileStreamManager._init) ──────────────────────
    async _resolveToken() {
        const key = (typeof localStorage !== 'undefined' && localStorage.getItem('vg1_cesium_token')) || '';
        if (!key) throw new Error("No Cesium token — run localStorage.setItem('vg1_cesium_token','YOUR_TOKEN') first.");
        const res = await fetch(ION_ENDPOINT(key), { mode: 'cors' });
        if (!res.ok) throw new Error(`Ion endpoint HTTP ${res.status}`);
        const data = await res.json();
        if (!data.url || !data.accessToken) throw new Error('Ion endpoint response missing url/accessToken');
        this._tileBase = data.url.endsWith('/') ? data.url : data.url + '/';
        this._token    = data.accessToken;
    }
    _startTokenRefresh() {
        clearInterval(this._tokenTimer);
        this._tokenTimer = setInterval(() => {
            this._resolveToken().catch(e => console.warn('[CoverageScan] token refresh failed:', e.message));
        }, TOKEN_REFRESH_MS);
    }

    // ── One QM probe → OK | HOLE | ERR ────────────────────────────────────────
    async _probe(z, tx, ty) {
        const url = `${this._tileBase}${z}/${tx}/${ty}.terrain?v=1.2.0`;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                const res = await fetch(url, {
                    headers: { Authorization: `Bearer ${this._token}` },
                    mode: 'cors',
                    cache: 'reload',              // bypass the service worker (sw.js) + negative cache
                });
                // We only need the status line; don't download the mesh body.
                try { res.body && res.body.cancel(); } catch (_) {}
                if (res.status === 404) return HOLE;
                if (res.ok)             return OK;
                if (res.status === 429 || res.status >= 500) {
                    await this._sleep(BACKOFF_BASE_MS * attempt + Math.random() * 200);
                    continue;                     // transient — retry
                }
                if (res.status === 401 || res.status === 403) {
                    // session token likely expired mid-run — refresh once and retry
                    await this._resolveToken();
                    continue;
                }
                return ERR;                        // some other status — record, don't crash
            } catch (_) {
                await this._sleep(BACKOFF_BASE_MS * attempt + Math.random() * 200);
            }
        }
        return ERR;
    }

    _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ── Process ONE z9 seed's whole subtree (depth-first, prune under holes) ──
    async _scanSeed(seedTx, seedTy, minZoom, maxZoom) {
        // stack of tiles to probe at the seed level and below
        const stack = [[minZoom, seedTx, seedTy]];
        while (stack.length) {
            if (this._abort) return;
            const [z, tx, ty] = stack.pop();

            if (isKnownNorthGap(z, ty)) { this.totals[z].known++; continue; }

            const r = await this._probe(z, tx, ty);
            if (r === OK) {
                this.totals[z].probed++;
                this.grid.record(z, tx, ty, false);
                if (z < maxZoom) {
                    for (const [cx, cy] of childrenOf(tx, ty)) stack.push([z + 1, cx, cy]);
                }
            } else if (r === HOLE) {
                this.totals[z].probed++;
                this.totals[z].holes++;
                this.grid.record(z, tx, ty, true);
                // COVERAGE NESTS — do NOT descend. Every child is a guaranteed 404.
            } else {
                this.totals[z].err++;
                // Unknown error: descend anyway so an isolated network blip on a
                // parent doesn't silently drop a covered subtree from the map.
                if (z < maxZoom) {
                    for (const [cx, cy] of childrenOf(tx, ty)) stack.push([z + 1, cx, cy]);
                }
            }
        }
    }

    // ── Enumerate z9 land seeds inside bbox ───────────────────────────────────
    _enumerateSeeds(bbox) {
        const z = 9;
        const cols = TPX(z), rows = TPY(z);
        const seeds = [];
        const [w, s, e, n] = bbox || [-180, -90, 180, 90];
        for (let ty = 0; ty < rows; ty++) {
            const b = tileBounds(z, 0, ty);
            if (b.north <= s || b.south >= n) continue;           // outside bbox lat
            if (isKnownNorthGap(z, ty)) continue;                  // whole row is SRTM gap
            for (let tx = 0; tx < cols; tx++) {
                const bx = tileBounds(z, tx, ty);
                if (bx.east <= w || bx.west >= e) continue;        // outside bbox lon
                if (tileLandMask.ready && !tileLandMask.shouldFetch(z, tx, ty)) continue; // ocean
                seeds.push([tx, ty]);
            }
        }
        return seeds;
    }

    async estimate(opts = {}) {
        await this._ensureMask();
        const seeds = this._enumerateSeeds(opts.bbox);
        const perSeedWorst = ({ 9: 1, 10: 5, 11: 21, 12: 85 })[opts.maxZoom || 12];
        console.log(`[CoverageScan] ${seeds.length.toLocaleString()} z9 land seeds in scope. ` +
            `Worst-case ≈ ${(seeds.length * perSeedWorst).toLocaleString()} requests ` +
            `(far fewer in practice — hole subtrees are pruned). ` +
            `At ${DEFAULT_CONCURRENCY} concurrent ≈ ${Math.round(seeds.length * perSeedWorst / DEFAULT_CONCURRENCY / 40)} s upper bound.`);
        return { seeds: seeds.length, worstCaseRequests: seeds.length * perSeedWorst };
    }

    async _ensureMask() {
        if (!tileLandMask.ready) {
            try { await tileLandMask.load(); } catch (_) {}
        }
        if (!tileLandMask.ready) {
            console.warn('[CoverageScan] land mask not loaded — scan will include OCEAN tiles ' +
                '(vastly larger + mostly flat 200s). Strongly recommend loading the mask or passing a bbox.');
        }
    }

    // ── The scan ──────────────────────────────────────────────────────────────
    async run(opts = {}) {
        if (this._running) { console.warn('[CoverageScan] already running — call stop() first.'); return; }
        const minZoom = opts.minZoom || 9;
        const maxZoom = opts.maxZoom || 12;
        const concurrency = opts.concurrency || DEFAULT_CONCURRENCY;
        const useCheckpoint = opts.checkpoint !== false;
        this._lastParams = { minZoom, maxZoom, bbox: opts.bbox || null, concurrency };

        this._running = true;
        this._abort   = false;
        try {
            await this._resolveToken();
            this._startTokenRefresh();
            await this._ensureMask();

            if (useCheckpoint) await this._loadCheckpoint();

            const allSeeds = this._enumerateSeeds(opts.bbox);
            const seeds = allSeeds.filter(([tx, ty]) => !this._doneSeeds.has(`${tx}/${ty}`));
            const total = allSeeds.length, already = allSeeds.length - seeds.length;
            console.log(`[CoverageScan] ${total.toLocaleString()} seeds in scope, ${already.toLocaleString()} already done → ${seeds.length.toLocaleString()} to scan. z${minZoom}–z${maxZoom}.`);

            const t0 = performance.now();
            let cursor = 0, completed = already, sinceFlush = 0;
            const reportEvery = Math.max(50, Math.floor(seeds.length / 200));

            const worker = async () => {
                while (!this._abort) {
                    const i = cursor++;
                    if (i >= seeds.length) return;
                    const [tx, ty] = seeds[i];
                    await this._scanSeed(tx, ty, minZoom, maxZoom);
                    this._doneSeeds.add(`${tx}/${ty}`);
                    completed++; sinceFlush++;
                    if (useCheckpoint && sinceFlush >= CHECKPOINT_EVERY) {
                        sinceFlush = 0;
                        await this._saveCheckpoint();
                    }
                    if (completed % reportEvery === 0 || completed === total) {
                        const el = (performance.now() - t0) / 1000;
                        const rate = (completed - already) / Math.max(el, 0.01);
                        const eta = rate > 0 ? Math.round((total - completed) / rate) : 0;
                        const probed = LEVELS_ALL.reduce((s, z) => s + this.totals[z].probed, 0);
                        const holes  = LEVELS_ALL.reduce((s, z) => s + this.totals[z].holes, 0);
                        console.log(`[CoverageScan] seeds ${completed.toLocaleString()}/${total.toLocaleString()} ` +
                            `(${(100 * completed / total).toFixed(1)}%) · ${probed.toLocaleString()} tiles probed · ` +
                            `${holes.toLocaleString()} holes · ETA ~${eta}s`);
                    }
                }
            };
            await Promise.all(Array.from({ length: concurrency }, worker));

            if (useCheckpoint) await this._saveCheckpoint();
            const summary = this._summary(this._abort, (performance.now() - t0) / 1000);
            console.table(summary.perLevel);
            console.log(this._abort
                ? '[CoverageScan] STOPPED — progress checkpointed. Re-run to resume; heatmap()/exportJSON() work on partial data.'
                : `[CoverageScan] DONE in ${summary.elapsedSec}s. heatmap() to see the map, exportJSON() for the hole list.`);
            return summary;
        } finally {
            this._running = false;
            clearInterval(this._tokenTimer);
        }
    }

    stop() { this._abort = true; console.log('[CoverageScan] stopping after in-flight seeds…'); }

    _summary(stopped, elapsedSec) {
        const perLevel = LEVELS_ALL.map(z => {
            const t = this.totals[z];
            return {
                zoom: z,
                probed: t.probed,
                holes: t.holes,
                holePct: t.probed ? +(100 * t.holes / t.probed).toFixed(2) : 0,
                knownNorthGap: t.known,
                errors: t.err,
            };
        });
        return { stopped, elapsedSec: Math.round(elapsedSec), params: this._lastParams, perLevel };
    }

    // ── Checkpoint ────────────────────────────────────────────────────────────
    async _saveCheckpoint() {
        try {
            await idbPut('progress', {
                doneSeeds: Array.from(this._doneSeeds),
                totals: this.totals,
                grid: this.grid.dump(),
                params: this._lastParams,
            });
        } catch (e) { console.warn('[CoverageScan] checkpoint save failed:', e.message); }
    }
    async _loadCheckpoint() {
        try {
            const p = await idbGet('progress');
            if (!p) return;
            this._doneSeeds = new Set(p.doneSeeds || []);
            if (p.totals) for (const z of LEVELS_ALL) if (p.totals[z]) this.totals[z] = p.totals[z];
            if (p.grid) this.grid.load(p.grid);
            console.log(`[CoverageScan] resumed checkpoint — ${this._doneSeeds.size.toLocaleString()} seeds already done.`);
        } catch (e) { console.warn('[CoverageScan] checkpoint load failed:', e.message); }
    }
    async clearCheckpoint() {
        this._doneSeeds = new Set();
        this.grid = new CoarseGrid();
        for (const z of LEVELS_ALL) this.totals[z] = { probed: 0, holes: 0, known: 0, err: 0 };
        await idbClear();
        console.log('[CoverageScan] checkpoint cleared.');
    }

    // ── Heatmap ───────────────────────────────────────────────────────────────
    // One equirectangular canvas per level. Each COARSE_DEG cell coloured by hole
    // fraction: deep green (0%) → yellow → red (100%); untested cells (ocean / not
    // reached) stay dark. Downloads a PNG and drops a viewer overlay in the page.
    heatmap(level) {
        const levels = level ? [level] : LEVELS_ALL;
        const out = [];
        for (const z of levels) out.push(this._renderLevel(z));
        this._showOverlay(out);
        return out.map(o => ({ zoom: o.zoom, cellsWithHoles: o.cellsWithHoles }));
    }

    _renderLevel(z) {
        const { cols, rows } = this.grid;
        const SCALE = Math.max(1, Math.floor(1440 / cols));
        const canvas = document.createElement('canvas');
        canvas.width = cols * SCALE; canvas.height = rows * SCALE;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#05070d'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        let cellsWithHoles = 0;
        const probed = this.grid.probed[z], holes = this.grid.holes[z];
        for (let cy = 0; cy < rows; cy++) {
            for (let cx = 0; cx < cols; cx++) {
                const i = cy * cols + cx;
                const p = probed[i];
                if (!p) continue;                         // untested → leave dark
                const frac = holes[i] / p;
                if (holes[i] > 0) cellsWithHoles++;
                ctx.fillStyle = this._holeColor(frac);
                // equirect: row 0 = south, so flip Y for a north-up image
                const py = (rows - 1 - cy) * SCALE;
                ctx.fillRect(cx * SCALE, py, SCALE, SCALE);
            }
        }
        // label
        ctx.fillStyle = '#e6edf3'; ctx.font = '16px monospace';
        ctx.fillText(`VANGUARD tile coverage — z${z} — red = missing QM (sparse-point holes)`, 10, 22);
        const dataURL = canvas.toDataURL('image/png');
        this._download(dataURL, `vg1-coverage-z${z}.png`);
        return { zoom: z, canvas, dataURL, cellsWithHoles };
    }

    _holeColor(frac) {
        // 0 → green (46,160,67), 0.5 → amber (210,153,34), 1 → red (218,54,51)
        const lerp = (a, b, t) => Math.round(a + (b - a) * t);
        let r, g, b;
        if (frac < 0.5) { const t = frac / 0.5; r = lerp(46,210,t); g = lerp(160,153,t); b = lerp(67,34,t); }
        else            { const t = (frac-0.5)/0.5; r = lerp(210,218,t); g = lerp(153,54,t); b = lerp(34,51,t); }
        return `rgb(${r},${g},${b})`;
    }

    _showOverlay(rendered) {
        let host = document.getElementById('vg1-coverage-overlay');
        if (host) host.remove();
        host = document.createElement('div');
        host.id = 'vg1-coverage-overlay';
        host.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(2,4,9,.94);' +
            'overflow:auto;padding:24px;box-sizing:border-box;font-family:monospace;color:#e6edf3';
        const close = document.createElement('button');
        close.textContent = '✕ close';
        close.style.cssText = 'position:fixed;top:16px;right:16px;z-index:100000;padding:6px 12px;' +
            'background:#21262d;color:#e6edf3;border:1px solid #444;border-radius:6px;cursor:pointer';
        close.onclick = () => host.remove();
        host.appendChild(close);
        for (const r of rendered) {
            r.canvas.style.cssText = 'display:block;max-width:100%;margin:12px 0 28px;border:1px solid #30363d';
            host.appendChild(r.canvas);
        }
        document.body.appendChild(host);
    }

    // ── JSON manifest ─────────────────────────────────────────────────────────
    exportJSON() {
        const { cols, rows } = this.grid;
        const cells = [];
        const fullyMissing = { 9: [], 10: [], 11: [], 12: [] };
        for (let cy = 0; cy < rows; cy++) {
            for (let cx = 0; cx < cols; cx++) {
                const i = cy * cols + cx;
                const lon = -180 + (cx + 0.5) * COARSE_DEG;
                const lat =  -90 + (cy + 0.5) * COARSE_DEG;
                const rec = { lon: +lon.toFixed(3), lat: +lat.toFixed(3) };
                let anyHole = false;
                for (const z of LEVELS_ALL) {
                    const p = this.grid.probed[z][i]; if (!p) continue;
                    const h = this.grid.holes[z][i];
                    rec[`z${z}`] = { probed: p, holes: h, holePct: +(100 * h / p).toFixed(1) };
                    if (h > 0) anyHole = true;
                    if (h === p) fullyMissing[z].push({ lon: rec.lon, lat: rec.lat, tiles: p });
                }
                if (anyHole) cells.push(rec);
            }
        }
        const manifest = {
            generatedAt: new Date().toISOString(),
            note: 'QM terrain coverage holes. holePct=100 means no detail tiles exist there → map shows only sparse coarse points on zoom-in. z9+ north of 60°N is a known SRTM data limit and is excluded, not listed as a hole.',
            params: this._lastParams,
            coarseCellDegrees: COARSE_DEG,
            summary: this._summary(false, 0).perLevel,
            fullyMissingRegions: fullyMissing,
            cellsWithHoles: cells,
        };
        this._download('data:application/json,' + encodeURIComponent(JSON.stringify(manifest, null, 2)),
            'vg1-coverage-manifest.json');
        console.log(`[CoverageScan] manifest: ${cells.length.toLocaleString()} 1°-cells with holes exported.`);
        return manifest;
    }

    _download(href, name) {
        const a = document.createElement('a');
        a.href = href; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
    }
}

export const coverageScanner = new CoverageScanner();
