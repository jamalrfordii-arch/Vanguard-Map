// waveFieldManager.js — global sea-state data field (THREE components).
//
// PHASE A: data acquisition only — no rendering (that's a separate layer).
// Fetches Open-Meteo Marine on a COARSE global grid using the same batched
// multi-coordinate pattern as gfsWindManager (validated live: multi-coord returns
// an array of {current:{…}}, land cells come back null without breaking the batch,
// CORS works client-side, ~0.7 s per small req).
//
// Three scalar fields are fetched in ONE request (same cost as one):
//   • total — significant wave height (the combined sea, our original field)
//   • swell — energy that radiated in from distant storms (long-travelled)
//   • wind  — locally wind-generated chop (built right here, right now)
// NOTE: these do NOT sum linearly. Significant heights combine ~in quadrature
// (total² ≈ swell² + wind² + secondary swell), so treat each as its own field;
// never reconstruct one from the others.
//
// Coarse grid is fine: wave fields are smooth (storm/swell driven), and waveAt()
// bilinear-interpolates so the rendered field reads smooth from a coarse source.
// Fetch is LAZY — triggered on demand (layer toggle), not at boot, to respect load.
//
// Distributed-autonomy "arm": imports no other manager, talks via vg1: events,
// exposes window.vg1Waves. Console: vg1Waves.fetchField(), vg1Waves.waveAt(lon,lat,comp).

const GRID_RES_DEG = 5;                              // coarse global grid (~5°)
const GRID_W       = Math.round(360 / GRID_RES_DEG); // 72 cols (lon)
const GRID_H       = Math.round(180 / GRID_RES_DEG) + 1; // 37 rows (lat, incl. poles)
const REFRESH_MS   = 3 * 60 * 60 * 1000;             // waves update ~hourly; refresh every 3 h
const LS_KEY       = 'vg1_wave_field_v2';            // v2: three components (v1 = total only, ignored)
const ENDPOINT     = 'https://marine-api.open-meteo.com/v1/marine';
const BATCH        = 350;   // coords per request (400 confirmed safe; 350 keeps URL <5 KB)
const CONCURRENCY  = 2;      // parallel requests — gentle on the rate limiter
const INTERBATCH_MS = 400;   // small gap between waves of requests
const MAX_RETRIES  = 5;
// Open-Meteo's free tier enforces a PER-MINUTE call-unit budget. A 429 means
// "try again in one minute" (their words), so the backoff must be ~60 s, not ms.
const RATE_LIMIT_WAIT_MS = 62000;

// The three components and the API variable each maps to.
const COMPONENTS = ['total', 'swell', 'wind'];
const API_VAR = { total: 'wave_height', swell: 'swell_wave_height', wind: 'wind_wave_height' };

class WaveFieldManager {
    constructor() {
        // Raw grids (m); NaN = land/no-data. One per component.
        this._h      = { total: null, swell: null, wind: null };
        // Dense (nearest-fill) versions — no holes, cover every coast.
        this._filled = { total: null, swell: null, wind: null };
        for (const c of COMPONENTS) this._h[c] = new Float32Array(GRID_W * GRID_H).fill(NaN);
        this._haveData = false;
        this._inFlight = false;
        this._lastFetch = 0;
        this._loadCache();
        if (typeof window !== 'undefined') window.vg1Waves = this;
    }

    haveData() { return this._haveData; }

    // Bilinear sample of a component (m). Ignores NaN (land) corners and renormalizes,
    // so the field degrades gracefully toward coasts. NaN if no data. comp ∈ COMPONENTS.
    waveAt(lon, lat, comp = 'total') {
        const h = this._h[comp] || this._h.total;
        const fx = (((lon + 180) % 360 + 360) % 360) / GRID_RES_DEG;
        const fy = (lat + 90) / GRID_RES_DEG;
        const xf = Math.floor(fx), yf = Math.floor(fy);
        const x0 = ((xf % GRID_W) + GRID_W) % GRID_W, x1 = (x0 + 1) % GRID_W;
        const y0 = Math.max(0, Math.min(GRID_H - 1, yf)), y1 = Math.max(0, Math.min(GRID_H - 1, yf + 1));
        const tx = fx - xf, ty = fy - yf;
        let sum = 0, wsum = 0;
        const add = (v, w) => { if (!Number.isNaN(v)) { sum += v * w; wsum += w; } };
        add(h[y0 * GRID_W + x0], (1 - tx) * (1 - ty));
        add(h[y0 * GRID_W + x1], tx * (1 - ty));
        add(h[y1 * GRID_W + x0], (1 - tx) * ty);
        add(h[y1 * GRID_W + x1], tx * ty);
        return wsum > 0 ? sum / wsum : NaN;
    }

    // Dense sample — same bilinear but on the nearest-filled grid (no holes), so the
    // render layer can paint every ocean point right up to the coastline. The GEBCO
    // mask (in the layer) decides land/ocean; this just guarantees a value exists.
    waveAtFilled(lon, lat, comp = 'total') {
        const h = this._filled[comp];
        if (!h) return this.waveAt(lon, lat, comp);
        const fx = (((lon + 180) % 360 + 360) % 360) / GRID_RES_DEG;
        const fy = (lat + 90) / GRID_RES_DEG;
        const xf = Math.floor(fx), yf = Math.floor(fy);
        const x0 = ((xf % GRID_W) + GRID_W) % GRID_W, x1 = (x0 + 1) % GRID_W;
        const y0 = Math.max(0, Math.min(GRID_H - 1, yf)), y1 = Math.max(0, Math.min(GRID_H - 1, yf + 1));
        const tx = fx - xf, ty = fy - yf;
        return h[y0 * GRID_W + x0] * (1 - tx) * (1 - ty)
             + h[y0 * GRID_W + x1] * tx * (1 - ty)
             + h[y1 * GRID_W + x0] * (1 - tx) * ty
             + h[y1 * GRID_W + x1] * tx * ty;
    }

    // Multi-source BFS: propagate the nearest real value into every empty cell
    // (incl. land cells — the layer masks those by GEBCO). Kills coastal/northern holes.
    _rebuildFilledFor(comp) {
        const W = GRID_W, H = GRID_H, src = this._h[comp];
        const filled = new Float32Array(W * H);
        const dist = new Int32Array(W * H).fill(0x7fffffff);
        const qx = [], qy = [];
        let any = false;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const i = y * W + x;
            if (!Number.isNaN(src[i])) { filled[i] = src[i]; dist[i] = 0; qx.push(x); qy.push(y); any = true; }
        }
        if (!any) { this._filled[comp] = null; return; }
        let head = 0;
        while (head < qx.length) {
            const x = qx[head], y = qy[head]; head++;
            const i = y * W + x, d = dist[i];
            const nbx = [(x + 1) % W, (x - 1 + W) % W, x, x];
            const nby = [y, y, y + 1, y - 1];
            for (let k = 0; k < 4; k++) {
                const nx = nbx[k], ny = nby[k];
                if (ny < 0 || ny >= H) continue;
                const ni = ny * W + nx;
                if (dist[ni] > d + 1) { dist[ni] = d + 1; filled[ni] = filled[i]; qx.push(nx); qy.push(ny); }
            }
        }
        this._filled[comp] = filled;
    }

    _rebuildFilled() { for (const c of COMPONENTS) this._rebuildFilledFor(c); }

    // Max value in a component field (for legend scaling). 0 if no data.
    maxHeight(comp = 'total') {
        const h = this._h[comp] || this._h.total;
        let m = 0;
        for (let i = 0; i < h.length; i++) { const v = h[i]; if (!Number.isNaN(v) && v > m) m = v; }
        return m;
    }

    // ── Lazy fetch (call on layer toggle) ─────────────────────────────────────
    async fetchField(force = false) {
        if (this._inFlight) return;
        if (!force && this._haveData && Date.now() - this._lastFetch < REFRESH_MS) return;
        this._inFlight = true;
        const t0 = performance.now();

        const lats = [], lons = [];
        for (let row = 0; row < GRID_H; row++) {
            const lat = -90 + row * GRID_RES_DEG;
            for (let col = 0; col < GRID_W; col++) {
                lats.push(lat); lons.push(-180 + col * GRID_RES_DEG);
            }
        }
        const total = lats.length;
        // Write progressively into fresh fields so the map fills in as data arrives.
        const next = { total: new Float32Array(total).fill(NaN),
                       swell: new Float32Array(total).fill(NaN),
                       wind:  new Float32Array(total).fill(NaN) };

        const currentVars = COMPONENTS.map(c => API_VAR[c]).join(',');
        const tasks = [];
        for (let i = 0; i < total; i += BATCH) {
            const ls = lats.slice(i, i + BATCH), os = lons.slice(i, i + BATCH);
            const url = ENDPOINT
                + '?latitude='  + ls.map(x => x.toFixed(2)).join(',')
                + '&longitude=' + os.map(x => x.toFixed(2)).join(',')
                + '&current=' + currentVars + '&length_unit=metric&cell_selection=sea';
            tasks.push({ url, offset: i });
        }

        console.info(`[Waves] Fetching sea-state (total+swell+wind) — ${tasks.length} batches × ${BATCH}, ${CONCURRENCY}-way, rate-aware (60 s backoff on 429)…`);
        let okCells = 0, failed = 0;
        const commit = () => { this._h = next; this._rebuildFilled(); this._haveData = true; };
        for (let t = 0; t < tasks.length; t += CONCURRENCY) {
            const slice = tasks.slice(t, t + CONCURRENCY);
            const settled = await Promise.allSettled(slice.map(({ url }) => this._getJSON(url)));
            let wroteThisWave = false;
            settled.forEach((res, k) => {
                if (res.status !== 'fulfilled' || !Array.isArray(res.value)) { failed++; return; }
                const off = slice[k].offset;
                res.value.forEach((entry, j) => {
                    const cur = entry?.current;
                    if (!cur) return;
                    const wh = cur.wave_height;
                    if (wh != null && !Number.isNaN(wh)) {
                        next.total[off + j] = wh; okCells++; wroteThisWave = true;
                        const sw = cur.swell_wave_height, wn = cur.wind_wave_height;
                        if (sw != null && !Number.isNaN(sw)) next.swell[off + j] = sw;
                        if (wn != null && !Number.isNaN(wn)) next.wind[off + j]  = wn;
                    }
                });
            });
            // Publish progressively so the ocean paints in as batches land.
            if (wroteThisWave) {
                commit();
                if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('vg1:waveFieldProgress', { detail: { okCells } }));
            }
            if (t + CONCURRENCY < tasks.length) await new Promise(r => setTimeout(r, INTERBATCH_MS));
        }

        if (okCells > 0) {
            commit();
            this._lastFetch = Date.now();
            this._saveCache();
            const ms = Math.round(performance.now() - t0);
            console.info(`[Waves] Field ready — ${okCells} ocean cells, ${failed} failed batches, ${(ms / 1000).toFixed(1)} s. max total ${this.maxHeight('total').toFixed(1)} m / swell ${this.maxHeight('swell').toFixed(1)} m / wind ${this.maxHeight('wind').toFixed(1)} m`);
            if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('vg1:waveFieldReady'));
        } else {
            console.warn('[Waves] No ocean cells returned — field not updated.');
        }
        this._inFlight = false;
    }

    async _getJSON(url, attempt = 0) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
            if (res.status === 429 && attempt < MAX_RETRIES) {
                // Per-minute budget hit — wait out the window (their reset is ~60 s) then retry.
                console.info(`[Waves] Rate limited; waiting ${Math.round(RATE_LIMIT_WAIT_MS / 1000)} s before retry ${attempt + 1}/${MAX_RETRIES}…`);
                await new Promise(r => setTimeout(r, RATE_LIMIT_WAIT_MS + Math.random() * 1000));
                return this._getJSON(url, attempt + 1);
            }
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const j = await res.json();
            // A 429/error body comes back as an object {error, reason}; treat as retryable.
            if (!Array.isArray(j)) {
                if (j && j.error && attempt < MAX_RETRIES) {
                    await new Promise(r => setTimeout(r, RATE_LIMIT_WAIT_MS + Math.random() * 1000));
                    return this._getJSON(url, attempt + 1);
                }
                throw new Error('non-array response: ' + (j && j.reason ? j.reason : typeof j));
            }
            return j;
        } catch (e) {
            if (attempt < MAX_RETRIES && e.name === 'AbortError') return this._getJSON(url, attempt + 1);
            throw e;
        }
    }

    // ── localStorage cache ────────────────────────────────────────────────────
    _saveCache() {
        try {
            // NaN → null for JSON; store grid dims + timestamp for validation.
            const enc = (g) => Array.from(g, v => (Number.isNaN(v) ? null : Math.round(v * 100) / 100));
            localStorage.setItem(LS_KEY, JSON.stringify({
                w: GRID_W, h: GRID_H, ts: this._lastFetch,
                total: enc(this._h.total), swell: enc(this._h.swell), wind: enc(this._h.wind),
            }));
        } catch (e) { /* quota — in-memory only */ }
    }
    _loadCache() {
        try {
            const o = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
            if (!o || o.w !== GRID_W || o.h !== GRID_H || !Array.isArray(o.total)) return;
            // Load cache even if STALE — old wave data is still useful and shows instantly;
            // setVisible()'s fetchField() refreshes in the background (lastFetch=cache ts keeps
            // it "stale" so the non-forced fetch proceeds). Avoids an empty field on toggle.
            const dec = (arr, g) => { if (!Array.isArray(arr)) return; for (let i = 0; i < arr.length && i < g.length; i++) g[i] = (arr[i] == null ? NaN : arr[i]); };
            dec(o.total, this._h.total);
            dec(o.swell, this._h.swell);
            dec(o.wind,  this._h.wind);
            this._rebuildFilled();
            this._haveData = true;
            this._lastFetch = o.ts || 0;
            const ageMin = Math.round((Date.now() - (o.ts || 0)) / 60000);
            console.info(`[Waves] Loaded cached sea-state field (${ageMin} min old${ageMin > 180 ? ' — will refresh' : ''}).`);
        } catch (e) { /* ignore */ }
    }
}

export const waveField = new WaveFieldManager();
