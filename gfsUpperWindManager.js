// gfsUpperWindManager.js — Multi-altitude GFS wind (850mb + 250mb)
//
// Companion to gfsWindManager.js (surface 10m). Renders two upper-air
// pressure levels as independent particle systems at proper Y heights so
// the scene has actual vertical extent:
//
//   Y =  8  surface  (10m, gfsWindManager)
//   Y = 22  low-level (850mb / ~1.5 km, this module)
//   Y = 65  jet stream (250mb / ~10 km, this module)
//
// Tilt the camera and the atmosphere reads as a stacked volume — surface
// flow below, low-level wind feeding into cyclones, the jet stream snaking
// high overhead.
//
// Data source: Open-Meteo /v1/gfs supports any pressure level via the
// `wind_speed_NhPa` + `wind_direction_NhPa` params in the same request.
// We pull all four params (speed+dir × 2 altitudes) in one batched call so
// per-request count is unchanged vs surface manager. Cache size 2×.
//
// Architecture template: gfsWindManager.js. Same contracts:
//   • Synthetic placeholder shown immediately when toggled on.
//   • Cached live fetch (localStorage, 6h TTL).
//   • Polite client (4-way concurrency, 200ms inter-batch, 429 retry).
//   • Public per-altitude setVisible toggles.

import * as THREE from 'three';
import { LineMaterial }         from 'three/addons/lines/LineMaterial.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineSegments2 }        from 'three/addons/lines/LineSegments2.js';
import { MAP_WIDTH, MAP_HEIGHT } from './config.js';

// ── Grid / fetch tuning (matches surface manager) ───────────────────────────
const GRID_RES_DEG       = 1;
const GRID_W             = Math.round(360 / GRID_RES_DEG);
const GRID_H             = Math.round(180 / GRID_RES_DEG) + 1;
const BATCH_SIZE         = 100;
const FETCH_CONCURRENCY  = 4;
const FETCH_INTERBATCH_MS = 200;
const FETCH_MAX_RETRIES  = 3;
const FETCH_RETRY_BASE_MS = 1500;
const FETCH_ACCEPT_FRAC  = 0.20;
const REFRESH_MS         = 6 * 60 * 60 * 1000;
const CACHE_KEY          = 'vg1.gfs.upperWind.v1';
const CACHE_TTL_MS       = 6 * 60 * 60 * 1000;

const MAX_AGE  = 220;
const STEP_GAIN = 0.22;          // slightly stronger than surface — upper winds are faster

// ── Altitude configurations ─────────────────────────────────────────────────
const ALT_LOW = {
    id:             'low',
    label:          '850mb',
    paramSpeed:     'wind_speed_850hPa',
    paramDir:       'wind_direction_850hPa',
    Y:              14,                 // compressed scale so altitudes stay readable when tilted
    particleCount:  1200,
    sizePx:         1.9,
    opacity:        0.70,
    speedScale:     1.0,
    streamSeeds:    150,                // Poisson-disk streamline seed count
    streamWidth:    1.4,                // px linewidth for streamlines
    colorPalette:   'low',
};
const ALT_JET = {
    id:             'jet',
    label:          '250mb',
    paramSpeed:     'wind_speed_250hPa',
    paramDir:       'wind_direction_250hPa',
    Y:              22,                 // jet sits above low-level, still close enough to read as atmosphere
    particleCount:  1500,
    sizePx:         2.2,
    opacity:        0.85,
    speedScale:     0.6,
    streamSeeds:    180,
    streamWidth:    1.6,
    colorPalette:   'jet',
};
const ALTITUDES = [ALT_LOW, ALT_JET];

// ── Mercator helper ─────────────────────────────────────────────────────────
function lonLatToScene(lon, lat) {
    const x     = (lon / 180.0) * (MAP_WIDTH  / 2.0);
    const latR  = lat * (Math.PI / 180.0);
    const mercY = Math.log(Math.tan(Math.PI / 4.0 + latR / 2.0));
    const z     = -(mercY / Math.PI) * (MAP_HEIGHT / 2.0);
    return { x, z };
}

// ── Speed → colour, per altitude ────────────────────────────────────────────
// Surface uses the warm-to-magenta ramp. Upper altitudes shift cooler so the
// eye reads them as "higher / colder / less dense air" without needing labels.
// Low-level: cooler blue-cyan biased. Jet: white-tinted (icy upper atmosphere).
function speedColorLow(spd, out) {
    if      (spd > 25) { out[0] = 0.95; out[1] = 0.55; out[2] = 0.80; }   // gale rose
    else if (spd > 18) { out[0] = 0.95; out[1] = 0.75; out[2] = 0.55; }   // amber-pink
    else if (spd > 12) { out[0] = 0.65; out[1] = 0.95; out[2] = 0.75; }   // teal-green
    else if (spd >  7) { out[0] = 0.45; out[1] = 0.85; out[2] = 1.00; }   // cyan
    else if (spd >  3) { out[0] = 0.32; out[1] = 0.68; out[2] = 0.95; }   // mid-blue
    else               { out[0] = 0.25; out[1] = 0.50; out[2] = 0.80; }   // deep cool blue
}
function speedColorJet(spd, out) {
    // Jet stream visually reads as icy upper-troposphere air — bright whites
    // at high speed instead of warm reds.
    if      (spd > 40) { out[0] = 1.00; out[1] = 1.00; out[2] = 1.00; }   // peak ribbon white
    else if (spd > 30) { out[0] = 0.90; out[1] = 0.95; out[2] = 1.00; }   // very pale blue-white
    else if (spd > 20) { out[0] = 0.65; out[1] = 0.85; out[2] = 1.00; }   // pale cyan
    else if (spd > 12) { out[0] = 0.45; out[1] = 0.72; out[2] = 0.95; }   // sky blue
    else if (spd >  6) { out[0] = 0.35; out[1] = 0.55; out[2] = 0.80; }   // cool steel
    else               { out[0] = 0.28; out[1] = 0.40; out[2] = 0.62; }   // near-black at calm
}
function speedColor(spd, palette, out) {
    if (palette === 'jet') return speedColorJet(spd, out);
    return speedColorLow(spd, out);
}

// ── Synthetic field: 850mb ─────────────────────────────────────────────────
// Similar to surface but with stronger meridional inflow toward cyclones
// (low-level convergence). Speeds ~5–18 m/s typical, up to 35 in storms.
function synthesizeField850(u, v) {
    for (let row = 0; row < GRID_H; row++) {
        const lat  = -90 + row * GRID_RES_DEG;
        const latR = lat * Math.PI / 180;
        const aLat = Math.abs(lat);
        // Trade winds and westerlies, slightly stronger than surface
        const trade = -10 * Math.exp(-Math.pow((aLat - 15) / 12, 2));
        const jet   =  18 * Math.exp(-Math.pow((aLat - 45) / 12, 2));
        const polar = -8  * Math.exp(-Math.pow((aLat - 75) / 10, 2));
        for (let col = 0; col < GRID_W; col++) {
            const lon  = -180 + col * GRID_RES_DEG;
            const lonR = lon * Math.PI / 180;
            const i    = row * GRID_W + col;
            let uBase = trade + jet + polar
                      + 4 * Math.sin(3 * lonR + latR * 2);
            const itcz = 1 - 0.8 * Math.exp(-(lat * lat) / 40);
            uBase *= itcz;
            let vBase = 2.5 * Math.sin(2 * lonR + latR) * Math.cos(latR * 2)
                      + 1.5 * Math.sin(4 * lonR);
            vBase *= itcz;
            u[i] = uBase;
            v[i] = vBase;
        }
    }
}

// ── Synthetic field: 250mb (jet stream level) ───────────────────────────────
// Dominated by a strong westerly jet stream at mid-latitudes (50–70 m/s).
// Polar jet narrower and more meandering. Trade-wind influence minimal.
function synthesizeField250(u, v) {
    for (let row = 0; row < GRID_H; row++) {
        const lat  = -90 + row * GRID_RES_DEG;
        const latR = lat * Math.PI / 180;
        const aLat = Math.abs(lat);
        // Subtropical jet (~30°) and polar jet (~50°) blending into one strong westerly band
        const subtropicalJet = 35 * Math.exp(-Math.pow((aLat - 32) / 9, 2));
        const polarJet       = 55 * Math.exp(-Math.pow((aLat - 50) / 8, 2));
        for (let col = 0; col < GRID_W; col++) {
            const lon  = -180 + col * GRID_RES_DEG;
            const lonR = lon * Math.PI / 180;
            const i    = row * GRID_W + col;
            // Strong westerly with deep Rossby-wave meanders
            let uBase = (subtropicalJet + polarJet)
                      + 12 * Math.sin(3 * lonR + latR * 2)
                      + 6  * Math.sin(5 * lonR - latR);
            // Equatorial easterly aloft (TEJ — tropical easterly jet)
            const tej = -15 * Math.exp(-Math.pow(aLat / 15, 2));
            uBase += tej;
            // Strong meridional component from jet meandering
            let vBase = 10 * Math.sin(2 * lonR + latR * 3)
                      + 5  * Math.cos(4 * lonR);
            u[i] = uBase;
            v[i] = vBase;
        }
    }
}

// ── Class ───────────────────────────────────────────────────────────────────
export class GFSUpperWindManager {
    constructor(scene) {
        this.scene = scene;
        this._fetchInFlight = false;
        this._haveLiveData  = false;
        this._lastFetchMs   = 0;
        this._t0            = performance.now();

        // Per-altitude state, all parallel
        this._alts = ALTITUDES.map(cfg => this._initAltitude(cfg));

        // Try cache → instant warm-start
        this._loadCache();
        // Always start with synthetic visible; live data swaps in when it arrives
        for (const alt of this._alts) {
            if (!alt.live) (alt.cfg.id === 'low' ? synthesizeField850 : synthesizeField250)(alt.u, alt.v);
            this._respawnAll(alt);
            this._tick(alt);     // populate buffers
        }

        this._fetch();
        setInterval(() => this._fetch(), REFRESH_MS);

        // (No scene fog — it was muting the very particles we want to see
        // when the camera tilts low. Atmospheric depth is communicated by
        // altitude stratification + colour palette differences instead.)
    }

    _initAltitude(cfg) {
        const N = cfg.particleCount;
        const group = new THREE.Group();
        group.name = `gfsUpper_${cfg.id}`;
        group.visible = false;
        this.scene.add(group);

        const positions = new Float32Array(N * 3);
        const colors    = new Float32Array(N * 3);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('color',    new THREE.BufferAttribute(colors,    3));
        geo.attributes.position.setUsage(THREE.DynamicDrawUsage);
        geo.attributes.color.setUsage(THREE.DynamicDrawUsage);

        const mat = new THREE.PointsMaterial({
            size:            cfg.sizePx,
            sizeAttenuation: false,
            vertexColors:    true,
            transparent:     true,
            opacity:         cfg.opacity,
            depthWrite:      false,
            depthTest:       false,
            blending:        THREE.NormalBlending,  // preserve colour over land
        });
        const points = new THREE.Points(geo, mat);
        points.frustumCulled = false;
        points.renderOrder = 7;
        group.add(points);

        return {
            cfg,
            group,
            points,
            geometry: geo,
            positions,
            colors,
            u: new Float32Array(GRID_W * GRID_H),
            v: new Float32Array(GRID_W * GRID_H),
            lon: new Float32Array(N),
            lat: new Float32Array(N),
            age: new Float32Array(N),
            maxAge: new Float32Array(N),
            live: false,
            streamMesh:    null,
            streamRebuilt: false,
        };
    }

    // ── Public ──────────────────────────────────────────────────────────────

    setLowVisible(on)  {
        this._alts[0].group.visible = on;
        if (on && !this._alts[0].streamRebuilt) this._buildStreamlines(this._alts[0]);
        this._maybeFetchOnShow(on);
    }
    setJetVisible(on)  {
        this._alts[1].group.visible = on;
        if (on && !this._alts[1].streamRebuilt) this._buildStreamlines(this._alts[1]);
        this._maybeFetchOnShow(on);
    }

    update(_delta) {
        for (const alt of this._alts) {
            if (alt.group.visible) this._tick(alt);
        }
    }

    // ── Particle advection ──────────────────────────────────────────────────

    _respawnAll(alt) {
        for (let i = 0; i < alt.cfg.particleCount; i++) this._spawn(alt, i, true);
    }

    _spawn(alt, i, initial = false) {
        alt.lon[i] = Math.random() * 360 - 180;
        alt.lat[i] = Math.random() * 144 - 72;     // same polar exclusion as surface
        alt.age[i] = initial ? Math.random() * MAX_AGE : 0;
        alt.maxAge[i] = MAX_AGE * (0.6 + Math.random() * 0.8);
    }

    _windAt(alt, lon, lat, out) {
        const fx = (((lon + 180) % 360 + 360) % 360) / GRID_RES_DEG;
        const fy = (lat + 90) / GRID_RES_DEG;
        const x0 = Math.floor(fx) % GRID_W;
        const x1 = (x0 + 1) % GRID_W;
        const y0 = Math.max(0, Math.min(GRID_H - 1, Math.floor(fy)));
        const y1 = Math.max(0, Math.min(GRID_H - 1, y0 + 1));
        const tx = fx - Math.floor(fx);
        const ty = fy - y0;
        const i00 = y0 * GRID_W + x0, i01 = y0 * GRID_W + x1;
        const i10 = y1 * GRID_W + x0, i11 = y1 * GRID_W + x1;
        const u   = (alt.u[i00] * (1 - tx) + alt.u[i01] * tx) * (1 - ty)
                  + (alt.u[i10] * (1 - tx) + alt.u[i11] * tx) * ty;
        const v   = (alt.v[i00] * (1 - tx) + alt.v[i01] * tx) * (1 - ty)
                  + (alt.v[i10] * (1 - tx) + alt.v[i11] * tx) * ty;
        out[0] = u; out[1] = v;
    }

    _tick(alt) {
        const N    = alt.cfg.particleCount;
        const Y    = alt.cfg.Y;
        const scl  = alt.cfg.speedScale;
        const uv   = [0, 0];
        const c    = new Float32Array(3);
        const pos  = alt.positions;
        const col  = alt.colors;

        for (let i = 0; i < N; i++) {
            alt.age[i] += 1;
            if (alt.age[i] > alt.maxAge[i]) this._spawn(alt, i);

            this._windAt(alt, alt.lon[i], alt.lat[i], uv);
            const u = uv[0], v = uv[1];
            const cosLat = Math.max(0.18, Math.cos(alt.lat[i] * Math.PI / 180));
            alt.lon[i] += (u * STEP_GAIN) / (cosLat * 111);
            alt.lat[i] += (v * STEP_GAIN) / 111;
            if (alt.lon[i] >  180) alt.lon[i] -= 360;
            if (alt.lon[i] < -180) alt.lon[i] += 360;
            if (Math.abs(alt.lat[i]) > 72) { this._spawn(alt, i); }

            const sc  = lonLatToScene(alt.lon[i], alt.lat[i]);
            const o = i * 3;
            pos[o    ] = sc.x;
            pos[o + 1] = Y;
            pos[o + 2] = sc.z;

            const spd = Math.hypot(u, v) * scl;   // rescale for colour ramp
            speedColor(spd, alt.cfg.colorPalette, c);
            const life = alt.age[i] / alt.maxAge[i];
            const fade = Math.sin(life * Math.PI);
            col[o    ] = c[0] * fade;
            col[o + 1] = c[1] * fade;
            col[o + 2] = c[2] * fade;
        }
        alt.geometry.attributes.position.needsUpdate = true;
        alt.geometry.attributes.color.needsUpdate    = true;
    }

    _maybeFetchOnShow(on) {
        if (on && !this._haveLiveData && !this._fetchInFlight) this._fetch();
    }

    // ── Cache (base64 packed float buffers) ─────────────────────────────────

    _loadCache() {
        try {
            const raw = localStorage.getItem(CACHE_KEY);
            if (!raw) return;
            const obj = JSON.parse(raw);
            if (!obj || obj.w !== GRID_W || obj.h !== GRID_H) return;
            if (Date.now() - obj.ts > CACHE_TTL_MS) return;
            const len = GRID_W * GRID_H;
            for (let a = 0; a < ALTITUDES.length; a++) {
                const altObj = obj.alts?.[a];
                if (!altObj) continue;
                const u = new Float32Array(len);
                const v = new Float32Array(len);
                const ub = atob(altObj.u);
                const vb = atob(altObj.v);
                const uView = new Uint8Array(u.buffer);
                const vView = new Uint8Array(v.buffer);
                for (let i = 0; i < ub.length; i++) uView[i] = ub.charCodeAt(i);
                for (let i = 0; i < vb.length; i++) vView[i] = vb.charCodeAt(i);
                this._alts[a].u = u;
                this._alts[a].v = v;
                this._alts[a].live = true;
            }
            this._haveLiveData = true;
            this._lastFetchMs  = obj.ts;
            const ageMin = Math.round((Date.now() - obj.ts) / 60000);
            console.info(`[GFS-Upper] ✓ Loaded cached upper-level wind (${ageMin} min old)`);
        } catch (e) {
            console.warn('[GFS-Upper] Cache load failed:', e.message);
        }
    }

    _saveCache() {
        try {
            const alts = this._alts.map(a => ({
                u: btoa(String.fromCharCode(...new Uint8Array(a.u.buffer))),
                v: btoa(String.fromCharCode(...new Uint8Array(a.v.buffer))),
            }));
            localStorage.setItem(CACHE_KEY, JSON.stringify({
                w: GRID_W, h: GRID_H, ts: Date.now(), alts,
            }));
        } catch (e) {
            console.warn('[GFS-Upper] Cache save failed:', e.message);
        }
    }

    // ── Live fetch ──────────────────────────────────────────────────────────

    async _fetchBatch(url, attempt = 0) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
            if (res.status === 429 && attempt < FETCH_MAX_RETRIES) {
                const delay = FETCH_RETRY_BASE_MS * Math.pow(2, attempt) + Math.random() * 500;
                await new Promise(r => setTimeout(r, delay));
                return this._fetchBatch(url, attempt + 1);
            }
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return await res.json();
        } catch (e) {
            if (attempt < FETCH_MAX_RETRIES && e.name === 'AbortError') {
                await new Promise(r => setTimeout(r, FETCH_RETRY_BASE_MS * Math.pow(2, attempt)));
                return this._fetchBatch(url, attempt + 1);
            }
            throw e;
        }
    }

    async _fetch() {
        if (this._fetchInFlight) return;
        this._fetchInFlight = true;
        const startMs = performance.now();

        const lats = [], lons = [];
        for (let row = 0; row < GRID_H; row++) {
            const lat = -90 + row * GRID_RES_DEG;
            for (let col = 0; col < GRID_W; col++) {
                lats.push(lat);
                lons.push(-180 + col * GRID_RES_DEG);
            }
        }
        const total = lats.length;
        // One buffer per altitude
        const newU = ALTITUDES.map(() => new Float32Array(total));
        const newV = ALTITUDES.map(() => new Float32Array(total));
        let ok = 0;

        const paramList = ALTITUDES.flatMap(a => [a.paramSpeed, a.paramDir]).join(',');

        const tasks = [];
        for (let i = 0; i < total; i += BATCH_SIZE) {
            const lsub = lats.slice(i, i + BATCH_SIZE);
            const osub = lons.slice(i, i + BATCH_SIZE);
            const url =
                'https://api.open-meteo.com/v1/gfs' +
                '?latitude='  + lsub.map(x => x.toFixed(2)).join(',') +
                '&longitude=' + osub.map(x => x.toFixed(2)).join(',') +
                '&current=' + paramList +
                '&wind_speed_unit=ms';
            tasks.push({ url, offset: i });
        }

        console.info(`[GFS-Upper] Fetching 850mb + 250mb wind — ${tasks.length} batches.`);

        let batchesDone = 0;
        for (let t = 0; t < tasks.length; t += FETCH_CONCURRENCY) {
            const slice = tasks.slice(t, t + FETCH_CONCURRENCY);
            const settled = await Promise.allSettled(slice.map(({ url }) => this._fetchBatch(url)));
            settled.forEach((res, k) => {
                batchesDone++;
                if (res.status !== 'fulfilled') return;
                const data   = res.value;
                const offset = slice[k].offset;
                const arr    = Array.isArray(data) ? data : [data];
                arr.forEach((d, j) => {
                    const c = d?.current;
                    if (!c) return;
                    for (let a = 0; a < ALTITUDES.length; a++) {
                        const speed   = +c[ALTITUDES[a].paramSpeed] || 0;
                        const dirFrom = +c[ALTITUDES[a].paramDir]   || 0;
                        const dirTo   = (dirFrom + 180) % 360;
                        const rad     = dirTo * Math.PI / 180;
                        newU[a][offset + j] = Math.sin(rad) * speed;
                        newV[a][offset + j] = Math.cos(rad) * speed;
                        if (a === 0) ok++;   // count once per grid cell
                    }
                });
            });
            if (t + FETCH_CONCURRENCY < tasks.length) {
                await new Promise(r => setTimeout(r, FETCH_INTERBATCH_MS));
            }
        }

        const elapsed = ((performance.now() - startMs) / 1000).toFixed(1);

        if (ok < total * FETCH_ACCEPT_FRAC) {
            console.warn(`[GFS-Upper] only ${ok}/${total} cells received in ${elapsed}s — keeping previous field.`);
            this._fetchInFlight = false;
            return;
        }

        // Fill gaps with synthetic so missing cells don't snap to (0,0).
        const synU = [new Float32Array(total), new Float32Array(total)];
        const synV = [new Float32Array(total), new Float32Array(total)];
        synthesizeField850(synU[0], synV[0]);
        synthesizeField250(synU[1], synV[1]);
        for (let a = 0; a < ALTITUDES.length; a++) {
            for (let i = 0; i < total; i++) {
                if (newU[a][i] === 0 && newV[a][i] === 0) {
                    newU[a][i] = synU[a][i];
                    newV[a][i] = synV[a][i];
                }
            }
            this._alts[a].u = newU[a];
            this._alts[a].v = newV[a];
            this._alts[a].live = true;
        }

        this._haveLiveData = true;
        this._lastFetchMs  = Date.now();
        this._fetchInFlight = false;
        this._saveCache();

        // Rebuild streamlines for any altitude currently visible.
        for (const alt of this._alts) {
            if (alt.group.visible) this._buildStreamlines(alt);
        }

        console.info(`[GFS-Upper] Live 850mb + 250mb winds active. ${ok}/${total} cells in ${elapsed}s.`);
    }

    // Streamlines per altitude. Same constant-arc-length integration as
    // gfsWindManager. Seeds via deterministic LCG so positions stay stable.
    _buildStreamlines(alt) {
        if (alt.streamMesh) {
            alt.group.remove(alt.streamMesh);
            alt.streamMesh.geometry?.dispose();
            alt.streamMesh.material?.dispose();
            alt.streamMesh = null;
        }
        const SEED_MIN_DEG = 10;
        const MAX_STEPS    = 28;
        const STEP_ARCDEG  = 0.95;
        const Y            = alt.cfg.Y;
        const MIN_SPEED    = 1.5;
        const HALF_W       = MAP_WIDTH * 0.5;

        const seedConst = alt.cfg.id === 'jet' ? 0x5a7c8e1f : 0x2b3c4d5e;
        const seeds = this._poissonSeeds(alt.cfg.streamSeeds, SEED_MIN_DEG, seedConst);
        if (!seeds.length) return;

        const positions = [];
        const colors    = [];
        const uv        = [0, 0];
        const cA        = new Float32Array(3);
        const cB        = new Float32Array(3);
        const scl       = alt.cfg.speedScale;

        for (const seed of seeds) {
            let lon = seed.lon, lat = seed.lat;
            const path = [];
            for (let step = 0; step < MAX_STEPS; step++) {
                this._windAt(alt, lon, lat, uv);
                const speed = Math.hypot(uv[0], uv[1]);
                if (speed < MIN_SPEED) break;
                path.push({ lon, lat, speed: speed * scl });
                const cosLat = Math.max(0.18, Math.cos(lat * Math.PI / 180));
                lon += (uv[0] / speed) * STEP_ARCDEG / cosLat;
                lat += (uv[1] / speed) * STEP_ARCDEG;
                if (Math.abs(lat) > 72) break;
                if (lon >  180) lon -= 360;
                if (lon < -180) lon += 360;
            }
            if (path.length < 4) continue;
            for (let s = 1; s < path.length; s++) {
                const a = path[s - 1], b = path[s];
                const sa = lonLatToScene(a.lon, a.lat);
                const sb = lonLatToScene(b.lon, b.lat);
                if (Math.abs(sb.x - sa.x) > HALF_W) continue;
                speedColor(a.speed, alt.cfg.colorPalette, cA);
                speedColor(b.speed, alt.cfg.colorPalette, cB);
                const tA = (s - 1) / path.length;
                const tB =  s      / path.length;
                const wA = 0.30 + tA * 0.70;
                const wB = 0.30 + tB * 0.70;
                positions.push(sa.x, Y, sa.z, sb.x, Y, sb.z);
                colors.push(
                    cA[0] * wA, cA[1] * wA, cA[2] * wA,
                    cB[0] * wB, cB[1] * wB, cB[2] * wB,
                );
            }
        }
        if (!positions.length) { alt.streamRebuilt = true; return; }

        const geo = new LineSegmentsGeometry();
        geo.setPositions(new Float32Array(positions));
        geo.setColors(new Float32Array(colors));

        const dpr = window.devicePixelRatio || 1;
        const mat = new LineMaterial({
            linewidth:    alt.cfg.streamWidth,
            vertexColors: true,
            transparent:  true,
            opacity:      0.80,
            depthWrite:   false,
            depthTest:    false,
            blending:     THREE.NormalBlending,
            resolution:   new THREE.Vector2(window.innerWidth * dpr, window.innerHeight * dpr),
        });
        const lines = new LineSegments2(geo, mat);
        lines.frustumCulled = false;
        lines.renderOrder   = 8;
        alt.group.add(lines);
        alt.streamMesh    = lines;
        alt.streamRebuilt = true;
        console.info(`[GFS-Upper] Streamlines at ${alt.cfg.label}: ${seeds.length} seeds.`);
    }

    _poissonSeeds(target, minDeg, seedConst) {
        let lcg = seedConst >>> 0;
        const rng = () => {
            lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0;
            return lcg / 4294967296;
        };
        const seeds = [];
        const maxTries = target * 14;
        let tries = 0;
        while (seeds.length < target && tries < maxTries) {
            tries++;
            const lat = (rng() - 0.5) * 144;
            const lon = (rng() - 0.5) * 360;
            let ok = true;
            for (let i = 0; i < seeds.length; i++) {
                const s = seeds[i];
                let dlon = s.lon - lon;
                if (dlon >  180) dlon -= 360;
                if (dlon < -180) dlon += 360;
                const cosLatMean = Math.cos(((s.lat + lat) / 2) * Math.PI / 180);
                const d = Math.hypot(s.lat - lat, dlon * cosLatMean);
                if (d < minDeg) { ok = false; break; }
            }
            if (ok) seeds.push({ lon, lat });
        }
        return seeds;
    }

    _loadCache() {
        try {
            const raw = localStorage.getItem(CACHE_KEY);
            if (!raw) return;
            const obj = JSON.parse(raw);
            if (!obj || obj.w !== GRID_W || obj.h !== GRID_H) return;
            if (Date.now() - obj.ts > CACHE_TTL_MS) return;
            const len = GRID_W * GRID_H;
            for (let a = 0; a < ALTITUDES.length; a++) {
                const altObj = obj.alts?.[a];
                if (!altObj) continue;
                const u = new Float32Array(len);
                const v = new Float32Array(len);
                const ub = atob(altObj.u);
                const vb = atob(altObj.v);
                const uView = new Uint8Array(u.buffer);
                const vView = new Uint8Array(v.buffer);
                for (let i = 0; i < ub.length; i++) uView[i] = ub.charCodeAt(i);
                for (let i = 0; i < vb.length; i++) vView[i] = vb.charCodeAt(i);
                this._alts[a].u = u;
                this._alts[a].v = v;
                this._alts[a].live = true;
            }
            this._haveLiveData = true;
            this._lastFetchMs  = obj.ts;
            const ageMin = Math.round((Date.now() - obj.ts) / 60000);
            console.info(`[GFS-Upper] Loaded cached upper-level wind (${ageMin} min old).`);
        } catch (e) {
            console.warn('[GFS-Upper] Cache load failed:', e.message);
        }
    }

    _saveCache() {
        try {
            const alts = this._alts.map(a => ({
                u: btoa(String.fromCharCode(...new Uint8Array(a.u.buffer))),
                v: btoa(String.fromCharCode(...new Uint8Array(a.v.buffer))),
            }));
            localStorage.setItem(CACHE_KEY, JSON.stringify({
                w: GRID_W, h: GRID_H, ts: Date.now(), alts,
            }));
        } catch (e) {
            console.warn('[GFS-Upper] Cache save failed:', e.message);
        }
    }
}
