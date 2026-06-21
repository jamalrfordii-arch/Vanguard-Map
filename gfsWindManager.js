// gfsWindManager.js — Live global GFS wind field as flowing dot streaks
//
// What this draws: ~3 000 particles released into a real gridded wind field,
// each rendered as a string of 6 dots along its recent path. The newest dot
// is bright, older dots fade — the effect is a flowing streak that traces
// the streamline of the wind for ~2 seconds. Together the streaks form a
// flowing portrait of the planet's lower atmosphere: trade winds,
// westerlies, jet streams, cyclones.
//
// Why dots not lines:
//   THREE.LineBasicMaterial draws 1-device-pixel lines regardless of zoom,
//   which at global zoom is sub-pixel against the bright base map and
//   essentially invisible. THREE.Points with sizeAttenuation:false renders
//   guaranteed N-pixel sprites, visible at every camera distance.
//
// Data source:
//   Open-Meteo /v1/gfs — multi-location current 10 m wind. Free, no key,
//   CORS-friendly. Grid: 5° lat × 5° lon → 72 × 37 = 2 664 cells.
//   Batched 100 cells per request, 8-way parallel. Refresh every 6 h.
//
// Loading behavior:
//   The layer ALWAYS shows something the instant it's toggled on. A subtle
//   synthetic climatological field (trade winds, westerlies — speeds 4–10
//   m/s, never storm-strength) drives the streaks until the real GFS fetch
//   completes, at which point the field swaps over without interruption.

import * as THREE from 'three';
import { LineMaterial }         from 'three/addons/lines/LineMaterial.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineSegments2 }        from 'three/addons/lines/LineSegments2.js';
import { LineGeometry }         from 'three/addons/lines/LineGeometry.js';
import { Line2 }                from 'three/addons/lines/Line2.js';
import { MAP_WIDTH, MAP_HEIGHT } from './config.js';
import { legendManager } from './legendManager.js';   // unified collapsible MAP KEYS panel

// Synoptic-layer (jets / cyclones / ITCZ) heights & thresholds
const JET_Y          = 9.0;
const ITCZ_Y         = 8.6;
const CYCLONE_Y      = 9.4;
const JET_MIN_SPEED  = 8;     // m/s — ignore weak peaks
const CYCLONE_MIN_MS = 18;    // m/s — gale-plus for a feature to count
const CYCLONE_MAX_N  = 8;     // top N by intensity

// ── Grid resolution ──────────────────────────────────────────────────────────
// 1° everywhere → 360 × 181 = 65 160 cells. 24× more data than the previous
// 5° grid. Reveals real local wind features (sea breezes, mountain channeling,
// the actual jet-stream meander) that 5° averaging smoothed away. Cold start
// is ~45–60s on first load, then localStorage-cached for 6 h.
const GRID_RES_DEG   = 1;
const GRID_W         = Math.round(360 / GRID_RES_DEG);
const GRID_H         = Math.round(180 / GRID_RES_DEG) + 1;
const BATCH_SIZE     = 100;
const CONCURRENCY    = 8;
const REFRESH_MS     = 6 * 60 * 60 * 1000;

const PARTICLE_COUNT = 4500;        // dense detail — fine-grained wind structure readable
const TRAIL_DOTS     = 20;          // 20 history points → 19 segments per streak (richer ribbons)
const LINE_WIDTH_PX  = 2.0;         // slightly thinner so individual streaks read in dense clusters
const PARTICLE_Y     = 8.0;
const MAX_AGE        = 240;         // slightly longer life to match the longer trails
const STEP_GAIN      = 0.18;        // smaller steps × more segments = smooth ribbon

const STORM_WIND_MS  = 22;
const MAX_STORM_OUT  = 8;

// ── Fetch tuning (Open-Meteo free tier rate-limits aggressive bursts) ───────
// Higher resolution means ~652 batches at 100 cells each. Bumped concurrency
// 2 → 4 and shortened inter-batch gap to keep cold start under a minute while
// staying polite. Cache makes refreshes instant.
const FETCH_CONCURRENCY    = 4;
const FETCH_INTERBATCH_MS  = 200;
const FETCH_MAX_RETRIES    = 3;
const FETCH_RETRY_BASE_MS  = 1500;
const FETCH_ACCEPT_FRAC    = 0.20;
const CACHE_KEY            = 'vg1.gfs.windCache.v1';
const CACHE_TTL_MS         = 6 * 60 * 60 * 1000;

// ── Synthetic wind features ─────────────────────────────────────────────────
// Drifting procedural cyclones that wander the synthetic field, so the
// placeholder visualization has clear storm cells before any GFS data lands.
const DEMO_STORMS = [
    { lon: -45, lat:  22, vmax: 32, radius: 18, rotSpeed:  0.020 }, // Atlantic
    { lon: 145, lat:  18, vmax: 35, radius: 20, rotSpeed:  0.018 }, // W Pacific
    { lon:  88, lat: -14, vmax: 28, radius: 16, rotSpeed: -0.022 }, // Indian Ocean (SH)
];
let _demoT = 0;

// Build a procedural cyclone glyph: spiral arms + dark eye + soft glow.
// `direction` = +1 for CCW (NH), -1 for CW (SH).
function makeSpiralTexture(direction) {
    const s = 128;
    const cvs = document.createElement('canvas');
    cvs.width = cvs.height = s;
    const ctx = cvs.getContext('2d');
    ctx.clearRect(0, 0, s, s);

    // Soft pink glow background
    const glow = ctx.createRadialGradient(s/2, s/2, 0, s/2, s/2, s/2);
    glow.addColorStop(0,    'rgba(255,120,170,0.55)');
    glow.addColorStop(0.55, 'rgba(255, 70,130,0.18)');
    glow.addColorStop(1,    'rgba(255, 70,130,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, s, s);

    // Four spiral arms
    ctx.strokeStyle = 'rgba(255,230,250,0.95)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (let arm = 0; arm < 4; arm++) {
        ctx.beginPath();
        const armOffset = (arm / 4) * Math.PI * 2;
        for (let t = 0; t <= 1.1; t += 0.012) {
            const r = t * (s / 2) * 0.82;
            const ang = direction * (armOffset + t * Math.PI * 3.0);
            const x = s / 2 + Math.cos(ang) * r;
            const y = s / 2 + Math.sin(ang) * r;
            if (t === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    // Dark eye centre
    const eye = ctx.createRadialGradient(s/2, s/2, 0, s/2, s/2, 10);
    eye.addColorStop(0, 'rgba(30,5,20,0.92)');
    eye.addColorStop(1, 'rgba(30,5,20,0)');
    ctx.fillStyle = eye;
    ctx.beginPath();
    ctx.arc(s/2, s/2, 10, 0, Math.PI * 2);
    ctx.fill();

    const tex = new THREE.CanvasTexture(cvs);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
}

function lonLatToScene(lon, lat) {
    const x     = (lon / 180.0) * (MAP_WIDTH  / 2.0);
    const latR  = lat * (Math.PI / 180.0);
    const mercY = Math.log(Math.tan(Math.PI / 4.0 + latR / 2.0));
    const z     = -(mercY / Math.PI) * (MAP_HEIGHT / 2.0);
    return { x, z };
}

function speedColor(spd, out) {
    let r, g, b;
    if      (spd > 30) { r = 1.00; g = 0.85; b = 1.00; }
    else if (spd > 22) { r = 1.00; g = 0.32; b = 0.52; }
    else if (spd > 15) { r = 1.00; g = 0.58; b = 0.20; }
    else if (spd > 10) { r = 1.00; g = 0.88; b = 0.38; }
    else if (spd >  5) { r = 0.55; g = 0.90; b = 1.00; }
    else               { r = 0.42; g = 0.75; b = 1.00; }
    out[0] = r; out[1] = g; out[2] = b;
}

// Build a realistic-looking synthetic wind field that exhibits proper
// dynamic range: equatorial trade winds, mid-latitude westerly jet streams,
// polar easterlies, an ITCZ calm belt, and a handful of wandering cyclones.
// Speeds span 0 to ~35 m/s, so every colour band in the legend lights up.
function synthesizeDemoField(u, v, tSeconds = 0) {
    // Update drifting storm positions
    for (const s of DEMO_STORMS) {
        s.lon += 0.25;
        if (s.lon > 180) s.lon -= 360;
    }

    for (let row = 0; row < GRID_H; row++) {
        const lat  = -90 + row * GRID_RES_DEG;
        const latR = lat * Math.PI / 180;
        for (let col = 0; col < GRID_W; col++) {
            const lon  = -180 + col * GRID_RES_DEG;
            const lonR = lon * Math.PI / 180;
            const i    = row * GRID_W + col;

            // ── Three-cell zonal circulation ────────────────────────────────
            // Hadley (0-30°): easterly trades
            // Ferrel (30-60°): westerly jet stream
            // Polar (60-90°): polar easterlies
            // Jet stream peaks at ~45° latitude, ~22 m/s westerly.
            const aLat   = Math.abs(lat);
            const trade  = -8  * Math.exp(-Math.pow((aLat - 15) / 12, 2));   // east-flow at 15°
            const jet    =  22 * Math.exp(-Math.pow((aLat - 45) / 12, 2));   // west-flow at 45°
            const polar  = -6  * Math.exp(-Math.pow((aLat - 75) / 10, 2));   // east-flow at 75°
            let uBase = trade + jet + polar;

            // Longitudinal wave pattern (Rossby-like meander) on the jet
            uBase += 4 * Math.sin(3 * lonR + latR * 2);

            // ITCZ calm belt ±3°
            const itczDamp = 1 - 0.85 * Math.exp(-(lat * lat) / 40);
            uBase *= itczDamp;

            // ── Meridional component ────────────────────────────────────────
            // Wavy poleward/equatorward flow following the jet meanders.
            let vBase = 3 * Math.sin(2 * lonR + latR) * Math.cos(latR * 2)
                      + 2 * Math.sin(4 * lonR);
            vBase *= itczDamp;

            // ── Drifting cyclones (Rankine vortex superposition) ────────────
            for (const s of DEMO_STORMS) {
                // Hemisphere-correct rotation (CCW in north, CW in south)
                const hemiSign = s.lat >= 0 ? 1 : -1;
                let dlon = lon - s.lon;
                if (dlon >  180) dlon -= 360;
                if (dlon < -180) dlon += 360;
                const dlat = lat - s.lat;
                // approximate horizontal distance in degrees
                const cosCenter = Math.cos(s.lat * Math.PI / 180);
                const dx = dlon * cosCenter;
                const dy = dlat;
                const r  = Math.sqrt(dx * dx + dy * dy);
                const R  = s.radius / 4;   // characteristic radius in degrees
                if (r > R * 3) continue;
                // tangential speed: rises linearly inside R, decays outside
                const tang = r < R
                    ? s.vmax * (r / R)
                    : s.vmax * (R / r) * Math.exp(-(r - R) * 0.25);
                // Unit tangent (perpendicular to radial), CCW
                const invR = 1 / (r + 1e-3);
                const tx   = -dy * invR;
                const ty   =  dx * invR;
                uBase += hemiSign * tang * tx;
                vBase += hemiSign * tang * ty;
            }

            u[i] = uBase;
            v[i] = vBase;
        }
    }
}

export class GFSWindManager {
    constructor(scene) {
        this.scene = scene;
        this.group = new THREE.Group();
        this.group.name    = 'gfsWindField';
        this.group.visible = false;
        scene.add(this.group);

        this._u = new Float32Array(GRID_W * GRID_H);
        this._v = new Float32Array(GRID_W * GRID_H);
        synthesizeDemoField(this._u, this._v);

        this._haveLiveData  = false;
        this._lastFetchMs   = 0;
        this._fetchInFlight = false;

        // ── Try localStorage cache first — instant warm-start, no API hit ────
        this._loadCache();

        // Refresh the synthetic field every 500ms so storms drift visibly
        // (only matters until live data arrives). Rebuild the synoptic
        // overlay every 6 s so jets/cyclones/ITCZ track the drifting field.
        this._demoTicks = 0;
        this._demoRefresh = setInterval(() => {
            if (this._haveLiveData) { clearInterval(this._demoRefresh); return; }
            synthesizeDemoField(this._u, this._v);
            this._demoTicks++;
            if (this._demoTicks % 12 === 0 && this._patternGroup) this._buildPatterns();
        }, 500);

        const N  = PARTICLE_COUNT;
        const TD = TRAIL_DOTS;
        this._N  = N;
        this._TD = TD;

        // History buffers — newest at slot 0
        this._histLon = new Float32Array(N * TD);
        this._histLat = new Float32Array(N * TD);
        this._age     = new Float32Array(N);
        this._maxAge  = new Float32Array(N);

        // Geometry: (TD-1) segments per particle, 6 floats per segment
        // (start.xyz + end.xyz, interleaved as Line2 expects).
        const SEGS_PER  = TD - 1;
        const totalSegs = N * SEGS_PER;
        this._segs      = SEGS_PER;
        const positions = new Float32Array(totalSegs * 6);
        const colors    = new Float32Array(totalSegs * 6);

        const geo = new LineSegmentsGeometry();
        geo.setPositions(positions);
        geo.setColors(colors);

        const mat = new LineMaterial({
            linewidth:    LINE_WIDTH_PX,    // pixels (screen-space)
            vertexColors: true,
            transparent:  true,
            opacity:      0.72,             // NormalBlending — colors preserved, no accumulation wash-out
            depthWrite:   false,
            depthTest:    false,
            blending:     THREE.NormalBlending,
            resolution:   new THREE.Vector2(
                window.innerWidth  * (window.devicePixelRatio || 1),
                window.innerHeight * (window.devicePixelRatio || 1),
            ),
        });

        this._lineMat = mat;
        this._lines   = new LineSegments2(geo, mat);
        this._lines.frustumCulled = false;
        this._lines.renderOrder   = 7;
        this.group.add(this._lines);

        // Keep direct refs to the InterleavedBuffer.array (shared backing store
        // for instanceStart + instanceEnd) so we can mutate in place every frame
        // instead of re-uploading via setPositions/setColors.
        this._positions = geo.attributes.instanceStart.data.array;
        this._colors    = geo.attributes.instanceColorStart.data.array;
        this._posAttr   = geo.attributes.instanceStart.data;
        this._colAttr   = geo.attributes.instanceColorStart.data;
        this._scratchC  = new Float32Array(3);

        // Keep LineMaterial's resolution in sync with the canvas.
        this._onResize = () => {
            const dpr = window.devicePixelRatio || 1;
            mat.resolution.set(window.innerWidth * dpr, window.innerHeight * dpr);
        };
        window.addEventListener('resize', this._onResize);

        for (let i = 0; i < N; i++) this._spawn(i, true);
        this._tick();
        this._buildPatterns();   // initial synoptic layer from synthetic field

        console.info(`[GFS] Initialised — ${N} streaks × ${TD-1} segments, ${LINE_WIDTH_PX}px Line2, synthetic field active. Live GFS loading…`);

        this._fetch();
        setInterval(() => this._fetch(), REFRESH_MS);
    }

    setVisible(on) {
        this.group.visible = on;
        if (on) legendManager.show('gfs-wind', 'GFS WIND · 10 m', this._legendHTML());
        else    legendManager.hide('gfs-wind');
        console.info(`[GFS] Wind field layer ${on ? 'ON' : 'OFF'} — ${this._haveLiveData ? 'LIVE GFS data' : 'synthetic placeholder, GFS still loading'}`);
        if (on && !this._haveLiveData && !this._fetchInFlight) this._fetch();
    }

    setWaveVisible(_on) { /* deprecated */ }

    get isConnected() { return this._haveLiveData; }
    clearKey() { /* no-op */ }
    async setKey(_key) { return this._fetch(); }

    getStormData() {
        if (!this._haveLiveData) return [];
        const storms = [];
        for (let row = 1; row < GRID_H - 1; row++) {
            for (let col = 0; col < GRID_W; col++) {
                const idx = row * GRID_W + col;
                const spd = Math.hypot(this._u[idx], this._v[idx]);
                if (spd < STORM_WIND_MS) continue;
                let isMax = true;
                for (let dy = -1; dy <= 1 && isMax; dy++) {
                    for (let dx = -1; dx <= 1 && isMax; dx++) {
                        if (!dx && !dy) continue;
                        const nc = (col + dx + GRID_W) % GRID_W;
                        const nr = row + dy;
                        const ni = nr * GRID_W + nc;
                        if (Math.hypot(this._u[ni], this._v[ni]) > spd) isMax = false;
                    }
                }
                if (!isMax) continue;
                const lat = -90 + row * GRID_RES_DEG;
                const lon = -180 + col * GRID_RES_DEG;
                const sc  = lonLatToScene(lon, lat);
                storms.push({
                    x: sc.x, z: sc.z,
                    radius:    12 + (spd - STORM_WIND_MS) * 0.6,
                    intensity: Math.min(1.6, 0.8 + (spd - STORM_WIND_MS) * 0.04),
                });
                if (storms.length >= MAX_STORM_OUT) return storms;
            }
        }
        return storms;
    }

    update(_delta) {
        if (!this.group.visible) return;
        this._tick();
        if (this._streamMesh && this._streamBaseColors) {
            this._animateStreamlines((performance.now() - this._streamT0) * 0.001);
        }
    }

    // ── Public helpers (used by uiController for vessel wind chips, etc.) ────

    /** Look up wind at lon/lat. Returns { speed, dirTo, u, v } in m/s + degrees. */
    windAt(lon, lat) {
        const uv = [0, 0];
        this._windAt(lon, lat, uv);
        const u = uv[0], v = uv[1];
        const speed = Math.hypot(u, v);
        // Direction TO which wind is moving (degrees clockwise from north).
        const dirTo = (Math.atan2(u, v) * 180 / Math.PI + 360) % 360;
        return { speed, dirTo, u, v };
    }

    /**
     * Relative wind for a moving target.
     * Returns:
     *   { speed:0, type:'calm' }                            if wind < 0.5 m/s
     *   { speed, dirTo, type:'headwind'|'tailwind'|'crosswind-port'|'crosswind-starboard',
     *     angleOff: signed degrees off the bow }
     *
     * heading is the target's degrees-from-north course-over-ground.
     */
    relativeWind(lon, lat, heading) {
        const w = this.windAt(lon, lat);
        if (w.speed < 0.5) return { speed: 0, dirTo: w.dirTo, type: 'calm', angleOff: 0 };
        // Wind blows TO dirTo. Target moves TO `heading`. The "apparent angle
        // off the bow" is (dirTo - heading) normalized to [-180, 180]. If the
        // wind is going in roughly the same direction as the target → tailwind.
        let angleOff = w.dirTo - heading;
        while (angleOff >  180) angleOff -= 360;
        while (angleOff < -180) angleOff += 360;
        const abs = Math.abs(angleOff);
        let type;
        if      (abs <  45) type = 'tailwind';
        else if (abs > 135) type = 'headwind';
        else                type = angleOff > 0 ? 'crosswind-starboard' : 'crosswind-port';
        return { speed: w.speed, dirTo: w.dirTo, type, angleOff };
    }

    _spawn(i, initial = false) {
        const lon = Math.random() * 360 - 180;
        // Skip the Mercator-stretched polar caps — particles past ~75° would
        // pile up visually without representing useful wind data anyway.
        const lat = Math.random() * 150 - 75;
        const base = i * this._TD;
        for (let s = 0; s < this._TD; s++) {
            this._histLon[base + s] = lon;
            this._histLat[base + s] = lat;
        }
        this._age[i]    = initial ? Math.random() * MAX_AGE : 0;
        this._maxAge[i] = MAX_AGE * (0.55 + Math.random() * 0.85);
    }

    _windAt(lon, lat, out) {
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
        out[0] = (this._u[i00] * (1 - tx) + this._u[i01] * tx) * (1 - ty)
              + (this._u[i10] * (1 - tx) + this._u[i11] * tx) * ty;
        out[1] = (this._v[i00] * (1 - tx) + this._v[i01] * tx) * (1 - ty)
              + (this._v[i10] * (1 - tx) + this._v[i11] * tx) * ty;
    }

    _tick() {
        const TD     = this._TD;
        const SEGS   = this._segs;       // TD - 1
        const pos    = this._positions;
        const col    = this._colors;
        const Y      = PARTICLE_Y;
        const uv     = [0, 0];
        const c      = this._scratchC;
        const N      = this._N;
        const HALF_W = MAP_WIDTH * 0.5;

        for (let i = 0; i < N; i++) {
            this._age[i] += 1;
            if (this._age[i] > this._maxAge[i]) this._spawn(i);

            const hBase = i * TD;
            // Shift history back one slot (drop oldest)
            for (let s = TD - 1; s > 0; s--) {
                this._histLon[hBase + s] = this._histLon[hBase + s - 1];
                this._histLat[hBase + s] = this._histLat[hBase + s - 1];
            }

            // Advect the head
            const headLon = this._histLon[hBase];
            const headLat = this._histLat[hBase];
            this._windAt(headLon, headLat, uv);
            const u = uv[0], v = uv[1];
            const cosLat = Math.max(0.18, Math.cos(headLat * Math.PI / 180));
            let nl = headLon + (u * STEP_GAIN) / (cosLat * 111);
            const newLat = headLat + (v * STEP_GAIN) / 111;
            if (nl >  180) nl -= 360;
            if (nl < -180) nl += 360;
            if (Math.abs(newLat) > 78) { this._spawn(i); continue; }
            this._histLon[hBase] = nl;
            this._histLat[hBase] = newLat;

            const spd = Math.hypot(u, v);
            speedColor(spd, c);
            const ageFade = Math.sin(this._age[i] / this._maxAge[i] * Math.PI);

            // Write SEGS segments per particle. Segment s connects
            // history[s+1] (older = start vertex) → history[s] (newer = end).
            // Layout: 6 floats per segment (sx, sy, sz, ex, ey, ez).
            const sBase = i * SEGS * 6;
            for (let s = 0; s < SEGS; s++) {
                const scOld = lonLatToScene(this._histLon[hBase + s + 1], this._histLat[hBase + s + 1]);
                const scNew = lonLatToScene(this._histLon[hBase + s    ], this._histLat[hBase + s    ]);

                // Collapse segments that would wrap across the dateline
                // (avoids drawing a horizontal scar across the whole map).
                let oldX = scOld.x, newX = scNew.x;
                if (Math.abs(newX - oldX) > HALF_W) oldX = newX;

                const o = sBase + s * 6;
                pos[o    ] = oldX; pos[o + 1] = Y; pos[o + 2] = scOld.z;
                pos[o + 3] = newX; pos[o + 4] = Y; pos[o + 5] = scNew.z;

                // Brightness ramp: end (newer) bright, start (older) dim.
                const wEnd   = (1.0 - s        / TD) * ageFade;
                const wStart = (1.0 - (s + 1)  / TD) * ageFade;
                col[o    ] = c[0] * wStart;
                col[o + 1] = c[1] * wStart;
                col[o + 2] = c[2] * wStart;
                col[o + 3] = c[0] * wEnd;
                col[o + 4] = c[1] * wEnd;
                col[o + 5] = c[2] * wEnd;
            }
        }

        this._posAttr.needsUpdate = true;
        this._colAttr.needsUpdate = true;
    }

    // ── localStorage cache ──────────────────────────────────────────────────

    _loadCache() {
        try {
            const raw = localStorage.getItem(CACHE_KEY);
            if (!raw) return;
            const obj = JSON.parse(raw);
            if (!obj || obj.w !== GRID_W || obj.h !== GRID_H) return;
            if (Date.now() - obj.ts > CACHE_TTL_MS) {
                console.info('[GFS] Cache expired — will refetch.');
                return;
            }
            const len = GRID_W * GRID_H;
            const u = new Float32Array(len);
            const v = new Float32Array(len);
            const ub = atob(obj.u);
            const vb = atob(obj.v);
            const uView = new Uint8Array(u.buffer);
            const vView = new Uint8Array(v.buffer);
            for (let i = 0; i < ub.length; i++) uView[i] = ub.charCodeAt(i);
            for (let i = 0; i < vb.length; i++) vView[i] = vb.charCodeAt(i);
            this._u = u;
            this._v = v;
            this._haveLiveData = true;
            this._lastFetchMs  = obj.ts;
            const ageMin = Math.round((Date.now() - obj.ts) / 60000);
            console.info(`[GFS] ✓ Loaded cached wind field (${ageMin} min old).`);
        } catch (e) {
            console.warn('[GFS] Cache load failed:', e.message);
        }
    }

    _saveCache(u, v) {
        try {
            const uStr = String.fromCharCode(...new Uint8Array(u.buffer));
            const vStr = String.fromCharCode(...new Uint8Array(v.buffer));
            localStorage.setItem(CACHE_KEY, JSON.stringify({
                w: GRID_W, h: GRID_H, ts: Date.now(),
                u: btoa(uStr), v: btoa(vStr),
            }));
        } catch (e) {
            console.warn('[GFS] Cache save failed:', e.message);
        }
    }

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
                const delay = FETCH_RETRY_BASE_MS * Math.pow(2, attempt);
                await new Promise(r => setTimeout(r, delay));
                return this._fetchBatch(url, attempt + 1);
            }
            throw e;
        }
    }

    async _fetch() {
        if (this._fetchInFlight) return;
        this._fetchInFlight = true;
        const startMs = performance.now();

        const lats = [];
        const lons = [];
        for (let row = 0; row < GRID_H; row++) {
            const lat = -90 + row * GRID_RES_DEG;
            for (let col = 0; col < GRID_W; col++) {
                const lon = -180 + col * GRID_RES_DEG;
                lats.push(lat);
                lons.push(lon);
            }
        }
        const total = lats.length;
        const u = new Float32Array(total);
        const v = new Float32Array(total);
        let ok = 0;

        const tasks = [];
        for (let i = 0; i < total; i += BATCH_SIZE) {
            const lsub = lats.slice(i, i + BATCH_SIZE);
            const osub = lons.slice(i, i + BATCH_SIZE);
            const url  =
                'https://api.open-meteo.com/v1/gfs' +
                '?latitude='  + lsub.map(x => x.toFixed(2)).join(',') +
                '&longitude=' + osub.map(x => x.toFixed(2)).join(',') +
                '&current=wind_speed_10m,wind_direction_10m' +
                '&wind_speed_unit=ms';
            tasks.push({ url, offset: i });
        }

        console.info(`[GFS] Fetching live wind field — ${tasks.length} batches x ${BATCH_SIZE} cells, ${FETCH_CONCURRENCY}-way parallel, ${FETCH_INTERBATCH_MS}ms gap, ${FETCH_MAX_RETRIES} retries on 429…`);

        let batchesDone = 0;
        let failedBatches = 0;
        for (let t = 0; t < tasks.length; t += FETCH_CONCURRENCY) {
            const slice = tasks.slice(t, t + FETCH_CONCURRENCY);
            const settled = await Promise.allSettled(slice.map(({ url }) => this._fetchBatch(url)));
            settled.forEach((res, k) => {
                batchesDone++;
                if (res.status !== 'fulfilled') {
                    failedBatches++;
                    console.warn(`[GFS] batch ${batchesDone}/${tasks.length} failed after retries:`, res.reason?.message ?? res.reason);
                    return;
                }
                const data   = res.value;
                const offset = slice[k].offset;
                const arr    = Array.isArray(data) ? data : [data];
                arr.forEach((d, j) => {
                    const c = d?.current;
                    if (!c) return;
                    const speed   = +c.wind_speed_10m     || 0;
                    const dirFrom = +c.wind_direction_10m || 0;
                    const dirTo   = (dirFrom + 180) % 360;
                    const rad     = dirTo * Math.PI / 180;
                    u[offset + j] = Math.sin(rad) * speed;
                    v[offset + j] = Math.cos(rad) * speed;
                    ok++;
                });
            });
            if (t + FETCH_CONCURRENCY < tasks.length) {
                await new Promise(r => setTimeout(r, FETCH_INTERBATCH_MS));
            }
        }

        const elapsed = ((performance.now() - startMs) / 1000).toFixed(1);

        if (ok < total * FETCH_ACCEPT_FRAC) {
            console.warn(`[GFS] only ${ok}/${total} cells received in ${elapsed}s (${failedBatches} failed batches) — keeping previous field.`);
            this._fetchInFlight = false;
            return;
        }

        // Fill missing cells from the synthetic field
        const synU = new Float32Array(total);
        const synV = new Float32Array(total);
        synthesizeDemoField(synU, synV);
        for (let i = 0; i < total; i++) {
            if (u[i] === 0 && v[i] === 0) { u[i] = synU[i]; v[i] = synV[i]; }
        }

        this._u = u;
        this._v = v;
        this._haveLiveData  = true;
        this._lastFetchMs   = Date.now();
        this._fetchInFlight = false;

        this._saveCache(u, v);

        // Rebuild the synoptic layer from real data now that we have it.
        this._buildPatterns();

        console.info(`[GFS] \u2713 Live wind field active \u2014 ${ok}/${total} cells in ${elapsed}s, grid ${GRID_W}x${GRID_H} @ ${GRID_RES_DEG}\u00b0.`);
        window.dispatchEvent(new CustomEvent('vg1:windDataReady', {
            detail: { gridded: true, w: GRID_W, h: GRID_H, resDeg: GRID_RES_DEG, ts: this._lastFetchMs }
        }));
    }

    // \u2500\u2500 Synoptic layer \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    // Reads the u/v grid and draws the macro-shapes of the wind so the eye
    // sees structure instead of noise: jet stream ribbons (per hemisphere),
    // cyclone glyphs (vorticity local maxima), and the ITCZ.

    _buildPatterns() {
        if (!this._patternGroup) {
            this._patternGroup = new THREE.Group();
            this._patternGroup.name = 'gfsSynoptic';
            this.group.add(this._patternGroup);
        }
        // Jet ribbons and direction-arrow grid both removed per user feedback.
        // Atmospheric structure is now expressed by speed-colored streamlines
        // (the dominant "shape" reader) plus the ITCZ as a faint anchor line.
        const itcz    = this._extractITCZ();
        const streams = this._buildStreamlines();
        this._renderITCZ(itcz);
        this._clearJets();   // ensure any old jet geometry is removed on rebuild
        console.info(`[GFS Patterns] Streamlines=${streams} seeds \u00b7 ITCZ=${itcz.length} pts`);
    }

    _extractJets() {
        const north = [];
        const south = [];
        for (let col = 0; col < GRID_W; col++) {
            const lon = -180 + col * GRID_RES_DEG;
            let nU = -Infinity, nLat = null;
            let sU = -Infinity, sLat = null;
            for (let row = 0; row < GRID_H; row++) {
                const lat = -90 + row * GRID_RES_DEG;
                const u = this._u[row * GRID_W + col];
                if (lat >= 25 && lat <= 65 && u > nU) { nU = u; nLat = lat; }
                if (lat >= -65 && lat <= -25 && u > sU) { sU = u; sLat = lat; }
            }
            if (nLat !== null && nU > JET_MIN_SPEED) north.push({ lon, lat: nLat, speed: nU });
            if (sLat !== null && sU > JET_MIN_SPEED) south.push({ lon, lat: sLat, speed: sU });
        }
        const smooth = (arr, w = 3) => {
            const out = [];
            for (let i = 0; i < arr.length; i++) {
                let lat = 0, spd = 0, n = 0;
                for (let k = -w; k <= w; k++) {
                    const j = i + k;
                    if (j >= 0 && j < arr.length) { lat += arr[j].lat; spd += arr[j].speed; n++; }
                }
                out.push({ lon: arr[i].lon, lat: lat / n, speed: spd / n });
            }
            return out;
        };
        return { north: smooth(north), south: smooth(south) };
    }

    _renderJets({ north, south }) {
        if (this._jetGroup) {
            this._patternGroup.remove(this._jetGroup);
            this._jetGroup.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
        }
        this._jetGroup = new THREE.Group();
        const buildLine = (pts) => {
            if (pts.length < 4) return null;
            const positions = [];
            const colors    = [];
            const cscratch  = new Float32Array(3);
            for (const p of pts) {
                const sc = lonLatToScene(p.lon, p.lat);
                positions.push(sc.x, JET_Y, sc.z);
                speedColor(p.speed, cscratch);
                colors.push(cscratch[0], cscratch[1], cscratch[2]);
            }
            const geo = new LineGeometry();
            geo.setPositions(positions);
            geo.setColors(colors);
            const dpr = window.devicePixelRatio || 1;
            const mat = new LineMaterial({
                linewidth:    5,
                vertexColors: true,
                transparent:  true,
                opacity:      0.85,
                depthWrite:   false,
                depthTest:    false,
                blending:     THREE.AdditiveBlending,
                resolution:   new THREE.Vector2(window.innerWidth * dpr, window.innerHeight * dpr),
            });
            const line = new Line2(geo, mat);
            line.frustumCulled = false;
            line.renderOrder = 8;
            return line;
        };
        const nLine = buildLine(north); if (nLine) this._jetGroup.add(nLine);
        const sLine = buildLine(south); if (sLine) this._jetGroup.add(sLine);
        this._patternGroup.add(this._jetGroup);
    }

    _extractCyclones() {
        const out = [];
        for (let row = 2; row < GRID_H - 2; row++) {
            const lat = -90 + row * GRID_RES_DEG;
            if (Math.abs(lat) < 8 || Math.abs(lat) > 60) continue;
            const cosLat = Math.cos(lat * Math.PI / 180);
            const dx = GRID_RES_DEG * 111 * cosLat * 1000;
            const dy = GRID_RES_DEG * 111 * 1000;
            for (let col = 0; col < GRID_W; col++) {
                const c = row * GRID_W + col;
                const u = this._u[c], v = this._v[c];
                const spd = Math.hypot(u, v);
                if (spd < CYCLONE_MIN_MS) continue;
                const colRight = (col + 1) % GRID_W;
                const colLeft  = (col - 1 + GRID_W) % GRID_W;
                const vR = this._v[row * GRID_W + colRight];
                const vL = this._v[row * GRID_W + colLeft];
                const uU = this._u[(row + 1) * GRID_W + col];
                const uD = this._u[(row - 1) * GRID_W + col];
                const vort = (vR - vL) / (2 * dx) - (uU - uD) / (2 * dy);
                const cyclonic = (lat > 0 && vort > 0) || (lat < 0 && vort < 0);
                if (!cyclonic) continue;
                let isMax = true;
                for (let dyR = -1; dyR <= 1 && isMax; dyR++) {
                    for (let dxC = -1; dxC <= 1 && isMax; dxC++) {
                        if (!dxC && !dyR) continue;
                        const nc = (row + dyR) * GRID_W + ((col + dxC + GRID_W) % GRID_W);
                        if (Math.hypot(this._u[nc], this._v[nc]) > spd) isMax = false;
                    }
                }
                if (!isMax) continue;
                out.push({
                    lon: -180 + col * GRID_RES_DEG,
                    lat,
                    speed: spd,
                    hemi: lat >= 0 ? 1 : -1,
                });
            }
        }
        out.sort((a, b) => b.speed - a.speed);
        return out.slice(0, CYCLONE_MAX_N);
    }

    _renderCyclones(storms) {
        if (this._cycloneGroup) {
            this._patternGroup.remove(this._cycloneGroup);
            this._cycloneGroup.traverse(o => {
                if (o.material?.map) o.material.map.dispose();
                o.material?.dispose();
            });
        }
        this._cycloneGroup = new THREE.Group();
        if (!this._spiralTexNH) {
            this._spiralTexNH = makeSpiralTexture( 1);
            this._spiralTexSH = makeSpiralTexture(-1);
        }
        for (const s of storms) {
            const sc  = lonLatToScene(s.lon, s.lat);
            const tex = s.hemi > 0 ? this._spiralTexNH : this._spiralTexSH;
            const spr = new THREE.Sprite(new THREE.SpriteMaterial({
                map: tex, color: 0xffaad0, transparent: true,
                opacity: 0.85, depthTest: false, depthWrite: false,
                blending: THREE.AdditiveBlending,
            }));
            const size = 9 + (s.speed - CYCLONE_MIN_MS) * 0.45;
            spr.scale.set(size, size, 1);
            spr.position.set(sc.x, CYCLONE_Y, sc.z);
            spr.renderOrder = 9;
            this._cycloneGroup.add(spr);
            const cvs = document.createElement('canvas');
            cvs.width = 96; cvs.height = 28;
            const ctx = cvs.getContext('2d');
            ctx.fillStyle = 'rgba(2,6,14,0.55)';
            ctx.beginPath();
            ctx.roundRect(0, 0, 96, 28, 4);
            ctx.fill();
            ctx.fillStyle = '#ffaad0';
            ctx.font = 'bold 14px ui-monospace, Consolas, monospace';
            ctx.textBaseline = 'middle';
            ctx.fillText(`${Math.round(s.speed)} m/s`, 8, 15);
            const ltex = new THREE.CanvasTexture(cvs);
            ltex.minFilter = THREE.LinearFilter;
            const lbl = new THREE.Sprite(new THREE.SpriteMaterial({
                map: ltex, transparent: true, depthTest: false, depthWrite: false,
            }));
            lbl.scale.set(7.2, 2.1, 1);
            lbl.position.set(sc.x + size * 0.55, CYCLONE_Y + 0.6, sc.z - size * 0.35);
            lbl.renderOrder = 10;
            this._cycloneGroup.add(lbl);
        }
        this._patternGroup.add(this._cycloneGroup);
    }

    _extractITCZ() {
        const pts = [];
        for (let col = 0; col < GRID_W; col++) {
            const lon = -180 + col * GRID_RES_DEG;
            let bestLat = null, bestAbsV = Infinity;
            for (let row = 1; row < GRID_H - 1; row++) {
                const lat = -90 + row * GRID_RES_DEG;
                if (Math.abs(lat) > 15) continue;
                const v = this._v[row * GRID_W + col];
                if (Math.abs(v) < bestAbsV) { bestAbsV = Math.abs(v); bestLat = lat; }
            }
            if (bestLat !== null) pts.push({ lon, lat: bestLat });
        }
        const out = [];
        const w = 6;
        for (let i = 0; i < pts.length; i++) {
            let lat = 0, n = 0;
            for (let k = -w; k <= w; k++) {
                const j = i + k;
                if (j >= 0 && j < pts.length) { lat += pts[j].lat; n++; }
            }
            out.push({ lon: pts[i].lon, lat: lat / n });
        }
        return out;
    }

    _renderITCZ(points) {
        if (this._itczMesh) {
            this._patternGroup.remove(this._itczMesh);
            this._itczMesh.geometry?.dispose();
            this._itczMesh.material?.dispose();
            this._itczMesh = null;
        }
        if (points.length < 4) return;
        const positions = [];
        for (const p of points) {
            const sc = lonLatToScene(p.lon, p.lat);
            positions.push(sc.x, ITCZ_Y, sc.z);
        }
        const geo = new LineGeometry();
        geo.setPositions(positions);
        const dpr = window.devicePixelRatio || 1;
        const mat = new LineMaterial({
            color: 0x66ccff, linewidth: 2,
            transparent: true, opacity: 0.55,
            depthWrite: false, depthTest: false,
            dashed: true, dashSize: 1.4, gapSize: 1.4,
            resolution: new THREE.Vector2(window.innerWidth * dpr, window.innerHeight * dpr),
        });
        const line = new Line2(geo, mat);
        line.computeLineDistances();
        line.frustumCulled = false;
        line.renderOrder = 8;
        this._itczMesh = line;
        this._patternGroup.add(line);
    }

    // ── Per-frame streamline animation ────────────────────────────────────────
    // Modulates the streamline colour buffer with a Gaussian "pulse" of
    // brightness that travels from the seed (t=0) to the terminal (t=1) of
    // each streamline. Each streamline has a different phase so they don't
    // all pulse together. Cost: ~3000 segments × ~10 float ops per frame.
    _animateStreamlines(elapsedSec) {
        const ts        = this._streamT;
        const phases    = this._streamSegPhase;
        const base      = this._streamBaseColors;
        const dataAttr  = this._streamMesh.geometry.attributes.instanceColorStart?.data;
        if (!ts || !phases || !base || !dataAttr) return;
        const col = dataAttr.array;

        const PULSE_SPEED = 0.22;   // cycles / second
        const PULSE_BOOST = 1.05;   // brightness multiplier at pulse centre
        const SIGMA_INV   = 1 / 0.012;

        const nSeg = phases.length;
        for (let s = 0; s < nSeg; s++) {
            const phase    = phases[s];
            const pulsePos = ((elapsedSec * PULSE_SPEED + phase) % 1 + 1) % 1;
            const tA = ts[s * 2];
            const tB = ts[s * 2 + 1];

            let dA = tA - pulsePos;
            if (dA < -0.5) dA += 1; else if (dA > 0.5) dA -= 1;
            let dB = tB - pulsePos;
            if (dB < -0.5) dB += 1; else if (dB > 0.5) dB -= 1;

            const brightA = 1 + PULSE_BOOST * Math.exp(-(dA * dA) * SIGMA_INV);
            const brightB = 1 + PULSE_BOOST * Math.exp(-(dB * dB) * SIGMA_INV);

            const co = s * 6;
            col[co    ] = base[co    ] * brightA;
            col[co + 1] = base[co + 1] * brightA;
            col[co + 2] = base[co + 2] * brightA;
            col[co + 3] = base[co + 3] * brightB;
            col[co + 4] = base[co + 4] * brightB;
            col[co + 5] = base[co + 5] * brightB;
        }
        dataAttr.needsUpdate = true;
    }

    // ── Sparse direction-arrow grid ──────────────────────────────────────────
    // At a coarse global grid (10° × 15°), draw a small chevron arrow oriented
    // along the wind vector at that location. Scaled by speed, colored by
    // speed via the legend ramp. Returns the number of arrows placed.
    _buildDirectionField() {
        if (this._arrowMesh) {
            this._patternGroup.remove(this._arrowMesh);
            this._arrowMesh.geometry?.dispose();
            this._arrowMesh.material?.dispose();
            this._arrowMesh = null;
        }

        const LAT_STEP        = 10;
        const LON_STEP        = 15;
        const LAT_MAX         = 75;
        const ARROW_Y         = 8.6;
        const MIN_SPEED       = 3;     // skip near-calm cells
        const ARROW_SCALE_BASE = 1.7;
        const ARROW_SCALE_GAIN = 0.18;

        // Pre-collect samples (avoids allocating an InstancedMesh too big)
        const samples = [];
        const uv = [0, 0];
        for (let lat = -LAT_MAX; lat <= LAT_MAX; lat += LAT_STEP) {
            for (let lon = -180; lon < 180; lon += LON_STEP) {
                this._windAt(lon, lat, uv);
                const speed = Math.hypot(uv[0], uv[1]);
                if (speed < MIN_SPEED) continue;
                samples.push({ lon, lat, u: uv[0], v: uv[1], speed });
            }
        }
        if (!samples.length) return 0;

        // Small chevron geometry: tip at +Z, two wings at -Z.
        const arrowGeo = new THREE.BufferGeometry();
        arrowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
            0,    0,  1.0,    // tip
           -0.45, 0, -0.55,    // left wing
            0.45, 0, -0.55,    // right wing
        ]), 3));
        arrowGeo.setIndex([0, 2, 1]);

        const arrowMat = new THREE.MeshBasicMaterial({
            transparent: true,
            opacity:     0.9,
            depthWrite:  false,
            depthTest:   false,
            side:        THREE.DoubleSide,
        });

        const mesh = new THREE.InstancedMesh(arrowGeo, arrowMat, samples.length);
        mesh.frustumCulled = false;
        mesh.renderOrder   = 7;

        const dummy   = new THREE.Object3D();
        const color   = new THREE.Color();
        const cscratch = new Float32Array(3);

        for (let i = 0; i < samples.length; i++) {
            const s = samples[i];
            const sc = lonLatToScene(s.lon, s.lat);
            dummy.position.set(sc.x, ARROW_Y, sc.z);
            dummy.rotation.set(0, Math.atan2(s.u, -s.v), 0);
            const sc1 = ARROW_SCALE_BASE + Math.min(s.speed, 35) * ARROW_SCALE_GAIN;
            dummy.scale.set(sc1, sc1, sc1 * 1.4);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);
            speedColor(s.speed, cscratch);
            color.setRGB(cscratch[0], cscratch[1], cscratch[2]);
            mesh.setColorAt(i, color);
        }

        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

        this._arrowMesh = mesh;
        this._patternGroup.add(mesh);
        return samples.length;
    }

    // ── Speed-coloured streamlines ────────────────────────────────────────────
    // Trace ~200 short curves through the wind field. Each vertex is coloured
    // by the LOCAL wind speed at that point, so the streamline network itself
    // becomes a heat-map of weather: cyan in trade winds, amber in jets,
    // magenta-white in storms. Direction reads from the bright-to-bright
    // gradient along the line plus the curvature.

    _buildStreamlines() {
        if (this._streamMesh) {
            this._patternGroup.remove(this._streamMesh);
            this._streamMesh.geometry?.dispose();
            this._streamMesh.material?.dispose();
            this._streamMesh = null;
        }

        const SEED_TARGET    = 450;    // denser streamline network for clearer pattern reading
        const SEED_MIN_DEG   = 8;      // tighter spacing for finer flow structure
        const MAX_STEPS      = 30;
        const STEP_ARCDEG    = 0.85;   // constant arc-length per step (degrees)
        const STREAM_Y       = 8.5;
        const MIN_SPEED      = 1.5;
        const HALF_W         = MAP_WIDTH * 0.5;

        const seeds = this._poissonSeeds(SEED_TARGET, SEED_MIN_DEG);
        if (!seeds.length) return 0;

        const positions = [];
        const colors    = [];
        const tVals     = [];   // per-vertex t (0..1) for pulse animation
        const segPhase  = [];   // per-segment phase offset (which streamline)
        const uv        = [0, 0];
        const cA        = new Float32Array(3);
        const cB        = new Float32Array(3);

        // One random phase per streamline so pulses don't all fire together
        let seedIdx = 0;
        const seedPhases = new Float32Array(seeds.length);
        for (let i = 0; i < seeds.length; i++) seedPhases[i] = Math.random();

        for (const seed of seeds) {
            const sPhase = seedPhases[seedIdx++];
            let lon = seed.lon, lat = seed.lat;
            const path = [];

            for (let step = 0; step < MAX_STEPS; step++) {
                this._windAt(lon, lat, uv);
                const speed = Math.hypot(uv[0], uv[1]);
                if (speed < MIN_SPEED) break;
                path.push({ lon, lat, speed });

                // Constant arc-length step — keeps every streamline the same
                // physical length regardless of wind speed.
                const cosLat = Math.max(0.18, Math.cos(lat * Math.PI / 180));
                const dlon = (uv[0] / speed) * STEP_ARCDEG / cosLat;
                const dlat = (uv[1] / speed) * STEP_ARCDEG;
                lon += dlon;
                lat += dlat;
                if (Math.abs(lat) > 72) break;
                if (lon >  180) lon -= 360;
                if (lon < -180) lon += 360;
            }

            if (path.length < 4) continue;

            // Emit one segment per consecutive pair, with per-endpoint colour
            // from local wind speed × brightness ramp along the streamline.
            for (let s = 1; s < path.length; s++) {
                const a  = path[s - 1];
                const b  = path[s];
                const sa = lonLatToScene(a.lon, a.lat);
                const sb = lonLatToScene(b.lon, b.lat);
                if (Math.abs(sb.x - sa.x) > HALF_W) continue;   // dateline collapse

                speedColor(a.speed, cA);
                speedColor(b.speed, cB);

                // Brightness ramp: dim at the seed, bright at the terminal.
                const tA = (s - 1) / path.length;
                const tB =  s      / path.length;
                const wA = 0.28 + tA * 0.72;
                const wB = 0.28 + tB * 0.72;

                positions.push(
                    sa.x, STREAM_Y, sa.z,
                    sb.x, STREAM_Y, sb.z,
                );
                colors.push(
                    cA[0] * wA, cA[1] * wA, cA[2] * wA,
                    cB[0] * wB, cB[1] * wB, cB[2] * wB,
                );
                tVals.push(tA, tB);
                segPhase.push(sPhase);
            }
        }

        if (!positions.length) return 0;

        const colorArr = new Float32Array(colors);
        const geo = new LineSegmentsGeometry();
        geo.setPositions(new Float32Array(positions));
        geo.setColors(colorArr);

        // Stash the baseline (un-pulsed) colour buffer + animation data so the
        // per-frame _animateStreamlines() pass can modulate without rebuilding.
        this._streamBaseColors = new Float32Array(colorArr);  // copy
        this._streamT          = new Float32Array(tVals);
        this._streamSegPhase   = new Float32Array(segPhase);
        if (this._streamT0 === undefined) this._streamT0 = performance.now();

        const dpr = window.devicePixelRatio || 1;
        const mat = new LineMaterial({
            linewidth:    1.6,
            vertexColors: true,
            transparent:  true,
            opacity:      0.78,             // NormalBlending preserves colour without saturating land
            depthWrite:   false,
            depthTest:    false,
            blending:     THREE.NormalBlending,
            resolution:   new THREE.Vector2(window.innerWidth * dpr, window.innerHeight * dpr),
        });

        this._streamMesh = new LineSegments2(geo, mat);
        this._streamMesh.frustumCulled = false;
        this._streamMesh.renderOrder   = 8;
        this._patternGroup.add(this._streamMesh);
        return seeds.length;
    }

    // Poisson-disk-ish sampling on the globe. Uses a seeded linear-
    // congruential generator (not Math.random()) so the SAME placements come
    // out every rebuild. Streamlines lock in their geographic positions and
    // only their integration paths + colours update when the wind field
    // changes. Result: streamlines read as stable features of the atmosphere
    // rather than re-sampled noise every refresh.
    _poissonSeeds(target, minDeg) {
        let lcg = 0x1a2b3c4d;
        const rng = () => {
            lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0;
            return lcg / 4294967296;
        };
        const seeds = [];
        const maxTries = target * 14;
        let tries = 0;
        while (seeds.length < target && tries < maxTries) {
            tries++;
            const lat = (rng() - 0.5) * 144;   // -72 to +72 — keeps streamlines out of stretched Mercator polar caps
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

    _clearJets() {
        if (this._jetGroup) {
            this._patternGroup.remove(this._jetGroup);
            this._jetGroup.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
            this._jetGroup = null;
        }
    }

    _legendHTML() {
        const bands = [
            { lbl: '&gt; 30 m/s&nbsp;&nbsp; hurricane', hex: '#ffd8ff' },
            { lbl: '&gt; 22 m/s&nbsp;&nbsp; gale',      hex: '#ff528a' },
            { lbl: '&gt; 15 m/s&nbsp;&nbsp; strong',    hex: '#ff9533' },
            { lbl: '&gt; 10 m/s&nbsp;&nbsp; moderate',  hex: '#ffe060' },
            { lbl: '&gt;&nbsp; 5 m/s&nbsp;&nbsp; light',     hex: '#8ce6ff' },
            { lbl: '&nbsp;&nbsp;&nbsp;calm',              hex: '#6bbfff' },
        ];
        let html = '';
        for (const b of bands) {
            html += `<div style="display:flex;align-items:center;gap:8px;padding:1px 0;">
                <span style="width:18px;height:7px;border-radius:1px;flex:0 0 auto;background:${b.hex};box-shadow:0 0 6px ${b.hex};"></span>
                <span>${b.lbl}</span></div>`;
        }
        html += `<div style="color:#4a6b84;margin-top:6px;font-size:9px;letter-spacing:0.04em;">NOAA GFS · streaklines = direction + speed</div>`;
        return html;
    }
}
