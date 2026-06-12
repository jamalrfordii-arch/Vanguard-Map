// ibtracsManager.js — Last 30 days of recorded tropical cyclone tracks
//
// Visualises the trailing 30-day history of every tropical cyclone in every
// ocean basin: Atlantic, East/Central/West Pacific, North/South Indian, and
// the Australian / South Pacific regions. Each storm is drawn as a fading
// polyline of its recorded positions, coloured by the Saffir-Simpson category
// at each point, with a pulsing glow at its most recent location.
//
// Architecture template: gfsWindManager.js. Same contract:
//   • Synthetic placeholder shown immediately when toggled on.
//   • Cached live fetch (localStorage, 6h TTL).
//   • Polite single fetch with graceful CORS fallback to synthetic.
//   • Public API for cross-layer integration (getStormsNear).
//   • Verbose console diagnostics.
//
// Data source priorities:
//   1. NOAA NCEI IBTrACS last-3-years CSV (live, CORS-permitted on most days).
//   2. localStorage cache (6 h fresh).
//   3. Synthetic procedural tracks (always available; ensures the layer is
//      never empty during demos or offline development).

import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { Line2 }        from 'three/addons/lines/Line2.js';
import { MAP_WIDTH, MAP_HEIGHT } from './config.js';

// ── Constants ───────────────────────────────────────────────────────────────
const TRACK_Y           = 9.2;                  // above wind, below labels
const TRACK_WIDTH       = 2.4;
const MAX_AGE_DAYS      = 30;
const HEAD_RADIUS       = 3.2;                  // scene units
const HEAD_PULSE_RATE   = 1.4;                  // Hz
const REFRESH_MS        = 6 * 60 * 60 * 1000;
const CACHE_TTL_MS      = 6 * 60 * 60 * 1000;
const CACHE_KEY         = 'vg1.ibtracs.cache.v1';
const IBTRACS_CSV_URL   =
    'https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/ibtracs.last3years.list.v04r01.csv';

// ── Helpers ─────────────────────────────────────────────────────────────────
function lonLatToScene(lon, lat) {
    const x     = (lon / 180.0) * (MAP_WIDTH  / 2.0);
    const latR  = lat * (Math.PI / 180.0);
    const mercY = Math.log(Math.tan(Math.PI / 4.0 + latR / 2.0));
    const z     = -(mercY / Math.PI) * (MAP_HEIGHT / 2.0);
    return { x, z };
}

// Saffir-Simpson category from intensity (knots)
function categoryFromKnots(kt) {
    if (kt >= 137) return 5;
    if (kt >= 113) return 4;
    if (kt >=  96) return 3;
    if (kt >=  83) return 2;
    if (kt >=  64) return 1;
    if (kt >=  34) return 0;     // tropical storm
    return -1;                   // tropical depression
}

// Category color (R,G,B in 0..1) — saturation-boosted so values survive
// additive blending over bright base-map terrain.
function categoryColor(cat, out) {
    if      (cat >= 5) { out[0] = 1.00; out[1] = 0.18; out[2] = 0.85; } // magenta — Cat 5
    else if (cat >= 4) { out[0] = 1.00; out[1] = 0.22; out[2] = 0.30; } // red — Cat 4
    else if (cat >= 3) { out[0] = 1.00; out[1] = 0.40; out[2] = 0.15; } // deep orange
    else if (cat >= 2) { out[0] = 1.00; out[1] = 0.62; out[2] = 0.18; } // orange
    else if (cat >= 1) { out[0] = 1.00; out[1] = 0.85; out[2] = 0.32; } // yellow
    else if (cat >= 0) { out[0] = 0.45; out[1] = 0.88; out[2] = 1.00; } // cyan TS
    else               { out[0] = 0.55; out[1] = 0.65; out[2] = 0.80; } // grey TD
    // Saturation boost — multiply channels 1.4× and clamp. Keeps the hue
    // intact but pushes brightness so colours read clearly over bright land
    // textures even with additive blending.
    out[0] = Math.min(1, out[0] * 1.4);
    out[1] = Math.min(1, out[1] * 1.4);
    out[2] = Math.min(1, out[2] * 1.4);
}

// Build a soft radial gradient texture in the storm's category color.
// Used for wind-field footprint discs — communicates "this whole area
// is in the storm's wind field" rather than a point glyph.
function makeWindFieldTexture(rgb, intensity) {
    const s = 256;
    const cvs = document.createElement('canvas');
    cvs.width = cvs.height = s;
    const ctx = cvs.getContext('2d');
    const r = Math.round(rgb[0] * 255);
    const g = Math.round(rgb[1] * 255);
    const b = Math.round(rgb[2] * 255);
    const a0 = 0.55 * intensity;
    const a1 = 0.30 * intensity;
    const a2 = 0.12 * intensity;
    const grad = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0,    `rgba(${r},${g},${b},${a0})`);
    grad.addColorStop(0.45, `rgba(${r},${g},${b},${a1})`);
    grad.addColorStop(0.85, `rgba(${r},${g},${b},${a2})`);
    grad.addColorStop(1,    `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, s, s);
    const t = new THREE.CanvasTexture(cvs);
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    return t;
}

// Build a procedural satellite-IR-style cyclone cloud texture. White/grey
// cloud-arm blobs warped into a hemisphere-correct spiral; bright eyewall
// ring and a dark eye for hurricane-strength storms. Used as the immediate
// placeholder before the async NASA Worldview snapshot lands, and as the
// permanent texture when fetch fails (offline, CORS, missing imagery).
function makeProceduralCycloneTexture(category, hemiSign) {
    const s   = 256;
    const cvs = document.createElement('canvas');
    cvs.width = cvs.height = s;
    const ctx = cvs.getContext('2d');
    const cx  = s / 2, cy = s / 2;
    const maxR = s * 0.46;

    // Cloud arms in three depth layers — outer thin, inner dense.
    for (let layer = 0; layer < 3; layer++) {
        const armCount  = 3 + layer;
        const baseAlpha = 0.34 - layer * 0.07;
        const tightness = 2.4 + Math.max(0, category) * 0.22 + layer * 0.35;
        for (let arm = 0; arm < armCount; arm++) {
            const armOff = (arm / armCount) * Math.PI * 2;
            for (let t = 0.05; t < 1; t += 0.0065) {
                const r   = t * maxR * (1 - layer * 0.10);
                const ang = hemiSign * (armOff + t * Math.PI * tightness);
                const x   = cx + Math.cos(ang) * r;
                const y   = cy + Math.sin(ang) * r;
                const blobR = 3.5 + Math.random() * 7.5;
                const alpha = baseAlpha * (1 - t * 0.55) * (0.6 + Math.random() * 0.4);
                const grad = ctx.createRadialGradient(x, y, 0, x, y, blobR);
                grad.addColorStop(0, `rgba(245,248,255,${alpha})`);
                grad.addColorStop(1, `rgba(245,248,255,0)`);
                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.arc(x, y, blobR, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }

    // Eyewall + eye — only for hurricane-strength.
    if (category >= 1) {
        const eyeR = 9 + category * 1.4;
        const ewGrad = ctx.createRadialGradient(cx, cy, eyeR, cx, cy, eyeR * 2.3);
        ewGrad.addColorStop(0,   `rgba(255,255,255,${0.42 + category * 0.07})`);
        ewGrad.addColorStop(0.6, `rgba(240,245,250,0.28)`);
        ewGrad.addColorStop(1,   `rgba(220,225,240,0)`);
        ctx.fillStyle = ewGrad;
        ctx.beginPath();
        ctx.arc(cx, cy, eyeR * 2.3, 0, Math.PI * 2);
        ctx.fill();

        const eyeGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, eyeR);
        eyeGrad.addColorStop(0,   'rgba(6,10,20,0.90)');
        eyeGrad.addColorStop(0.7, 'rgba(18,28,45,0.38)');
        eyeGrad.addColorStop(1,   'rgba(30,40,60,0)');
        ctx.fillStyle = eyeGrad;
        ctx.beginPath();
        ctx.arc(cx, cy, eyeR, 0, Math.PI * 2);
        ctx.fill();
    }

    const tex = new THREE.CanvasTexture(cvs);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
}

// Fetch a NASA Worldview snapshot of the cyclone's current region. Returns
// a THREE.Texture on success or null on failure. CORS-enabled; falls back
// silently so the procedural placeholder stays in place if the network
// blocks or the imagery is missing for the requested day.
function fetchCycloneSnapshot(head) {
    const dateStr = new Date(head.ts).toISOString().split('T')[0];
    const range   = 6;                         // ±6° box around storm centre
    const west    = (head.lon - range).toFixed(2);
    const south   = (head.lat - range).toFixed(2);
    const east    = (head.lon + range).toFixed(2);
    const north   = (head.lat + range).toFixed(2);
    const url =
        'https://wvs.earthdata.nasa.gov/api/v1/snapshot?REQUEST=GetSnapshot' +
        `&TIME=${dateStr}` +
        `&BBOX=${west},${south},${east},${north}` +
        '&CRS=EPSG:4326' +
        '&LAYERS=MODIS_Aqua_CorrectedReflectance_TrueColor' +
        '&FORMAT=image/jpeg' +
        '&WIDTH=512&HEIGHT=512';
    return new Promise(resolve => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            const tex = new THREE.Texture(img);
            tex.needsUpdate = true;
            tex.minFilter = THREE.LinearFilter;
            tex.magFilter = THREE.LinearFilter;
            resolve(tex);
        };
        img.onerror = () => resolve(null);
        img.src = url;
    });
}

// Great-circle distance in km
function gcDistKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const dφ = (lat2 - lat1) * Math.PI / 180;
    const dλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dφ/2)**2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ/2)**2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Synthetic 30-day track generator ────────────────────────────────────────
// Produces 5–7 plausible procedural cyclone tracks across multiple basins so
// the layer is informative immediately on toggle, before any fetch completes.
function synthesizeTracks() {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const presets = [
        // Atlantic Cape Verde recurver — common late-summer pattern
        { id: 'SYN_AL01', name: 'ARLENE',  basin: 'NA', startLon: -25, startLat: 12,
          driftLon: -0.8, driftLat: 0.45, peakKt: 105, daysAgo: 18, lengthDays: 14, recurve: true },
        // West Pacific powerful typhoon
        { id: 'SYN_WP01', name: 'KOMPASU', basin: 'WP', startLon: 152, startLat: 13,
          driftLon: -1.1, driftLat: 0.30, peakKt: 130, daysAgo: 14, lengthDays: 12, recurve: true },
        // East Pacific straight-tracker
        { id: 'SYN_EP01', name: 'CALVIN',  basin: 'EP', startLon: -112, startLat: 14,
          driftLon: -1.4, driftLat: 0.15, peakKt: 75,  daysAgo: 10, lengthDays: 8, recurve: false },
        // Indian Ocean (SH) clockwise
        { id: 'SYN_SI01', name: 'FREDDY',  basin: 'SI', startLon: 75, startLat: -12,
          driftLon: -1.0, driftLat: -0.30, peakKt: 90,  daysAgo: 22, lengthDays: 16, recurve: true },
        // Bay of Bengal
        { id: 'SYN_NI01', name: 'BIPARJOY', basin: 'NI', startLon: 88, startLat: 8,
          driftLon: -0.2, driftLat: 0.65, peakKt: 55,  daysAgo: 6, lengthDays: 5, recurve: false },
        // South Pacific
        { id: 'SYN_SP01', name: 'KEVIN',   basin: 'SP', startLon: 168, startLat: -16,
          driftLon: 0.6,  driftLat: -0.35, peakKt: 100, daysAgo: 25, lengthDays: 11, recurve: false },
    ];

    const out = [];
    for (const p of presets) {
        const positions = [];
        // 6-hourly cadence — standard NHC advisory rhythm
        const steps = p.lengthDays * 4;
        for (let s = 0; s < steps; s++) {
            const t = s / (steps - 1);
            // Intensity arc: ramps up, peaks at ~60%, then weakens
            const arc = Math.sin(t * Math.PI);
            const kt  = Math.max(15, p.peakKt * arc * (0.85 + 0.3 * Math.sin(t * 7)));
            // Position: drift × t plus subtle wobble; recurve adds NE/NW turn
            let lon = p.startLon + p.driftLon * t * p.lengthDays;
            let lat = p.startLat + p.driftLat * t * p.lengthDays;
            if (p.recurve) {
                const r = Math.max(0, (t - 0.55)) * 1.7;
                lon += r * (p.basin === 'WP' ? 8 : 4);
                lat += r * 3.5 * (p.basin === 'SI' || p.basin === 'SP' ? -1 : 1);
            }
            // Small wobble for realism
            lon += 0.3 * Math.sin(t * 11 + s);
            lat += 0.2 * Math.sin(t * 9 + s * 0.5);

            const ts = now - (p.daysAgo - t * p.lengthDays) * dayMs;
            positions.push({ ts, lat, lon, kt, cat: categoryFromKnots(kt) });
        }
        out.push({
            id:        p.id,
            name:      p.name,
            basin:     p.basin,
            positions,
            synthetic: true,
        });
    }
    return out;
}

// ── Tiny CSV row parser ─────────────────────────────────────────────────────
// IBTrACS CSV has quoted strings, commas inside text. Minimal correct parser.
function parseCSVLine(line) {
    const out = [];
    let i = 0, cur = '';
    let inQ = false;
    while (i < line.length) {
        const c = line[i];
        if (inQ) {
            if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 2; continue; }
            if (c === '"') { inQ = false; i++; continue; }
            cur += c; i++;
        } else {
            if (c === ',') { out.push(cur); cur = ''; i++; continue; }
            if (c === '"') { inQ = true; i++; continue; }
            cur += c; i++;
        }
    }
    out.push(cur);
    return out;
}

// ── Class ───────────────────────────────────────────────────────────────────
export class IBTrACSManager {
    constructor(scene) {
        this.scene = scene;
        this.group = new THREE.Group();
        this.group.name    = 'ibtracsTracks';
        this.group.visible = false;
        scene.add(this.group);

        this._tracks         = [];
        this._haveLiveData   = false;
        this._lastFetchMs    = 0;
        this._fetchInFlight  = false;
        this._headT0         = performance.now();
        this._headObjects    = [];

        // Particle system state (rebuilt by _build whenever tracks change).
        this._trackPoints      = null;
        this._trackData        = null;
        this._trackPositions   = null;
        this._trackColors      = null;
        this._cyclonePoints    = null;
        this._cycloneData      = null;
        this._cyclonePositions = null;
        this._cycloneColors    = null;

        // Click-to-inspect popup
        this._popupEl = null;
        this._installPopup();
        this._attachClickHandler();

        // Load cached snapshot — instant warm-start.
        this._loadCache();

        // If no cache, kick the synthetic placeholder so the user sees data on toggle.
        if (!this._tracks.length) {
            this._tracks = synthesizeTracks();
            console.info(`[IBTrACS] Synthetic ${this._tracks.length} tracks active. Live fetch starting…`);
        }
        this._build();

        // Try live fetch immediately (synthetic stays up if it fails).
        this._fetch();
        setInterval(() => this._fetch(), REFRESH_MS);

        // Resize listener for LineMaterial resolution uniform.
        this._onResize = () => {
            const dpr = window.devicePixelRatio || 1;
            for (const obj of this.group.children) {
                if (obj.material && obj.material.resolution) {
                    obj.material.resolution.set(
                        window.innerWidth  * dpr,
                        window.innerHeight * dpr,
                    );
                }
            }
        };
        window.addEventListener('resize', this._onResize);
    }

    setVisible(on) {
        this.group.visible = on;
        console.info(`[IBTrACS] Layer ${on ? 'ON' : 'OFF'} — ${this._tracks.length} tracks, ${this._haveLiveData ? 'LIVE' : 'synthetic'} data`);
        if (on && !this._haveLiveData && !this._fetchInFlight) this._fetch();
    }

    update(_delta) {
        if (!this.group.visible) return;
        const t = (performance.now() - this._headT0) * 0.001;

        // Track particles flow forward along each storm's recorded path.
        if (this._trackPoints && this._trackData) {
            const pos = this._trackPositions;
            const col = this._trackColors;
            const cs  = this._scratchColor;
            for (let i = 0; i < this._trackData.length; i++) {
                const d = this._trackData[i];
                if (!d) continue;
                d.age   += 1;
                d.pathT += d.speed;
                if (d.pathT > 1) { d.pathT = 0; d.age = 0; }
                const storm = this._tracks[d.stormIdx];
                if (!storm || storm.positions.length < 2) continue;
                const pp = storm.positions;
                const ft  = d.pathT * (pp.length - 1);
                const idx = Math.floor(ft);
                const fr  = ft - idx;
                const a = pp[idx];
                const b = pp[Math.min(idx + 1, pp.length - 1)];
                const lon = a.lon * (1 - fr) + b.lon * fr;
                const lat = a.lat * (1 - fr) + b.lat * fr;
                const sc  = lonLatToScene(lon, lat);
                const o = i * 3;
                pos[o    ] = sc.x;
                pos[o + 1] = TRACK_Y;
                pos[o + 2] = sc.z;
                categoryColor(a.cat, cs);
                // Floor the fade at 0.45 so track particles are always
                // visible — they pulse 0.45 → 1.0 → 0.45 over their lifetime
                // instead of disappearing entirely.
                const fade = 0.45 + 0.55 * Math.sin((d.age / d.maxAge) * Math.PI);
                col[o    ] = cs[0] * fade;
                col[o + 1] = cs[1] * fade;
                col[o + 2] = cs[2] * fade;
            }
            this._trackPoints.geometry.attributes.position.needsUpdate = true;
            this._trackPoints.geometry.attributes.color.needsUpdate    = true;
        }

        // Cyclone spiral particles rotate around each storm's current head.
        if (this._cyclonePoints && this._cycloneData) {
            const pos = this._cyclonePositions;
            const col = this._cycloneColors;
            const cs  = this._scratchColor;
            for (let i = 0; i < this._cycloneData.length; i++) {
                const d = this._cycloneData[i];
                if (!d) continue;
                const storm = this._tracks[d.stormIdx];
                if (!storm) continue;
                const head  = storm.positions[storm.positions.length - 1];
                const sc    = lonLatToScene(head.lon, head.lat);
                // Angular velocity scales with intensity (storm "spin")
                const angVel = 0.6 + (head.kt || 0) * 0.018;
                const theta  = d.theta + d.hemi * t * angVel;
                pos[i * 3    ] = sc.x + Math.cos(theta) * d.r;
                pos[i * 3 + 1] = TRACK_Y + 0.3;
                pos[i * 3 + 2] = sc.z + Math.sin(theta) * d.r;
                categoryColor(head.cat, cs);
                const bright = 0.55 + 0.45 * Math.sin(t * 3.2 + d.flick) * d.brightT;
                col[i * 3    ] = cs[0] * bright;
                col[i * 3 + 1] = cs[1] * bright;
                col[i * 3 + 2] = cs[2] * bright;
            }
            this._cyclonePoints.geometry.attributes.position.needsUpdate = true;
            this._cyclonePoints.geometry.attributes.color.needsUpdate    = true;
        }

        // Cyclone sprite — slow hemisphere-correct rotation + subtle pulse so
        // the cyclone reads as active weather rather than a static decal.
        if (this._cycloneSprites) {
            for (const spr of this._cycloneSprites) {
                spr.material.rotation = spr.userData.rotInit + spr.userData.hemiSign * t * 0.06;
                const pulse = 0.85 + 0.12 * Math.sin(t * 0.85 + spr.userData.pulsePhase);
                spr.material.opacity = pulse;
            }
        }

        // Head ring pulse — soft breathing glow around each cyclone centre.
        for (const h of this._headObjects) {
            const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * HEAD_PULSE_RATE + h.phase);
            h.mesh.material.opacity = 0.55 + 0.4 * pulse;
            const s = 0.85 + 0.30 * pulse;
            h.mesh.scale.set(s, 1, s);
        }
    }

    // ── Public API ──────────────────────────────────────────────────────────

    /** Returns tracks whose most-recent position is within radiusKm of (lon, lat). */
    getStormsNear(lon, lat, radiusKm = 500) {
        const out = [];
        for (const t of this._tracks) {
            const last = t.positions[t.positions.length - 1];
            if (!last) continue;
            const d = gcDistKm(lat, lon, last.lat, last.lon);
            if (d <= radiusKm) {
                out.push({
                    id:    t.id,
                    name:  t.name,
                    basin: t.basin,
                    peakKt:  t.positions.reduce((m, p) => Math.max(m, p.kt), 0),
                    distKm: Math.round(d),
                    lastTs: last.ts,
                });
            }
        }
        out.sort((a, b) => a.distKm - b.distKm);
        return out;
    }

    /** Returns the full list of currently-tracked storms. */
    getAllStorms() { return this._tracks.slice(); }

    // ── Geometry build ──────────────────────────────────────────────────────

    _build() {
        // Dispose previous geometry
        while (this.group.children.length) {
            const c = this.group.children.pop();
            c.geometry?.dispose();
            c.material?.dispose();
        }
        this._headObjects      = [];
        this._trackPoints      = null;
        this._cyclonePoints    = null;
        this._scratchColor     = this._scratchColor || new Float32Array(3);

        if (!this._tracks.length) return;

        // Filter each storm's positions to the last MAX_AGE_DAYS window in place.
        const now = Date.now();
        const cutoff = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
        for (const s of this._tracks) {
            s.recent = s.positions.filter(p => (now - p.ts) <= cutoff);
        }
        const renderable = this._tracks.filter(s => s.recent && s.recent.length >= 2);
        if (!renderable.length) {
            console.info('[IBTrACS] No tracks within 30-day window.');
            return;
        }

        // Use only renderable for this build cycle (caller keeps full this._tracks).
        // We temporarily mirror this._tracks for the particle indices below so
        // index mapping stays valid; everything reads from .recent.
        this._renderableIdx = renderable.map(s => this._tracks.indexOf(s));

        this._buildTrackParticles(renderable);
        this._buildCycloneSprites(renderable);
        this._buildHeadRings(renderable);

        console.info(`[IBTrACS] Rendered ${renderable.length}/${this._tracks.length} cyclones with flowing particles + rotating glyphs.`);
    }

    // ── Live fetch ──────────────────────────────────────────────────────────

    async _fetch() {
        if (this._fetchInFlight) return;
        this._fetchInFlight = true;
        const startMs = performance.now();

        try {
            const res = await fetch(IBTRACS_CSV_URL, { signal: AbortSignal.timeout(60_000) });
            if (!res.ok) {
                console.warn(`[IBTrACS] NCEI returned HTTP ${res.status}. Keeping synthetic/cached.`);
                this._fetchInFlight = false;
                return;
            }
            const csv = await res.text();
            const tracks = this._parseCSV(csv);
            const elapsed = ((performance.now() - startMs) / 1000).toFixed(1);
            if (tracks.length === 0) {
                console.warn(`[IBTrACS] Parsed CSV in ${elapsed}s but found no recent tracks. Keeping synthetic.`);
                this._fetchInFlight = false;
                return;
            }
            this._tracks = tracks;
            this._haveLiveData = true;
            this._lastFetchMs = Date.now();
            this._saveCache();
            this._build();
            console.info(`[IBTrACS] ✓ Live ${tracks.length} tracks from NCEI in ${elapsed}s.`);
        } catch (e) {
            console.warn(`[IBTrACS] Fetch failed (likely CORS or network): ${e.message}. Keeping synthetic/cached.`);
        } finally {
            this._fetchInFlight = false;
        }
    }

    _parseCSV(csv) {
        const lines = csv.split('\n');
        if (lines.length < 4) return [];
        const header = parseCSVLine(lines[0]);
        const colSID    = header.indexOf('SID');
        const colName   = header.indexOf('NAME');
        const colBasin  = header.indexOf('BASIN');
        const colISO    = header.indexOf('ISO_TIME');
        const colLat    = header.indexOf('LAT');
        const colLon    = header.indexOf('LON');
        const colWind   = header.indexOf('USA_WIND');
        if ([colSID, colISO, colLat, colLon, colWind].some(i => i < 0)) {
            console.warn('[IBTrACS] CSV header missing expected columns.');
            return [];
        }
        const stormMap = new Map();
        const cutoff   = Date.now() - MAX_AGE_DAYS * 86400000;

        // Skip header + units row (line 1 has a units description line in IBTrACS).
        for (let li = 2; li < lines.length; li++) {
            const line = lines[li];
            if (!line) continue;
            const f = parseCSVLine(line);
            const iso = f[colISO];
            if (!iso) continue;
            const ts = Date.parse(iso.replace(' ', 'T') + 'Z');
            if (!Number.isFinite(ts) || ts < cutoff) continue;
            const lat = parseFloat(f[colLat]);
            const lon = parseFloat(f[colLon]);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
            const kt = parseFloat(f[colWind]) || 0;
            const sid = f[colSID];
            let s = stormMap.get(sid);
            if (!s) {
                s = {
                    id: sid,
                    name:  (f[colName] || 'UNNAMED').trim(),
                    basin: f[colBasin] || '',
                    positions: [],
                };
                stormMap.set(sid, s);
            }
            s.positions.push({ ts, lat, lon, kt, cat: categoryFromKnots(kt) });
        }
        const out = [];
        for (const s of stormMap.values()) {
            if (s.positions.length >= 2) {
                s.positions.sort((a, b) => a.ts - b.ts);
                out.push(s);
            }
        }
        return out;
    }

    // ── Cache ───────────────────────────────────────────────────────────────

    _loadCache() {
        try {
            const raw = localStorage.getItem(CACHE_KEY);
            if (!raw) return;
            const obj = JSON.parse(raw);
            if (!obj?.tracks || !obj.ts) return;
            if (Date.now() - obj.ts > CACHE_TTL_MS) {
                console.info('[IBTrACS] Cache expired — will refetch.');
                return;
            }
            this._tracks = obj.tracks;
            this._haveLiveData = true;
            this._lastFetchMs = obj.ts;
            const ageMin = Math.round((Date.now() - obj.ts) / 60000);
            console.info(`[IBTrACS] ✓ Loaded cached ${this._tracks.length} tracks (${ageMin} min old).`);
        } catch (e) {
            console.warn(`[IBTrACS] Cache load failed: ${e.message}`);
        }
    }

    _saveCache() {
        try {
            // Keep cache compact — strip position fields we can re-derive.
            const slim = this._tracks.map(t => ({
                id: t.id, name: t.name, basin: t.basin,
                positions: t.positions.map(p => ({
                    ts: p.ts, lat: p.lat, lon: p.lon, kt: p.kt, cat: p.cat,
                })),
            }));
            localStorage.setItem(CACHE_KEY, JSON.stringify({
                ts: Date.now(),
                tracks: slim,
            }));
        } catch (e) {
            console.warn(`[IBTrACS] Cache save failed: ${e.message}`);
        }
    }

    // ── Wind-field footprint discs ────────────────────────────────────────────
    // Two translucent radial-gradient discs beneath each cyclone showing the
    // geographic AREA affected:
    //   • Outer disc → tropical-storm-force radius (R34, winds ≥34 kt)
    //   • Inner disc → hurricane-force radius     (R64, winds ≥64 kt)
    // Sizes scale with intensity. Communicates "this whole region is in the
    // storm's wind field" rather than just marking the centre point.
    _buildWindFieldDiscs(renderable) {
        const cs = new Float32Array(3);
        for (const storm of renderable) {
            const head = storm.recent[storm.recent.length - 1];
            const sc   = lonLatToScene(head.lon, head.lat);
            const kt   = head.kt || 0;
            categoryColor(head.cat, cs);

            // Outer disc — TS-force radius scaled by intensity.
            // 4 scene units floor + 0.1 per knot up to ~13 units for a Cat 5.
            const r34 = 4 + Math.min(10, kt * 0.10);
            const tex34 = makeWindFieldTexture(cs, 0.55);
            const g34   = new THREE.CircleGeometry(r34, 48);
            g34.rotateX(-Math.PI / 2);
            const m34   = new THREE.MeshBasicMaterial({
                map:         tex34,
                transparent: true,
                depthWrite:  false,
                depthTest:   false,
                side:        THREE.DoubleSide,
                blending:    THREE.AdditiveBlending,
            });
            const d34 = new THREE.Mesh(g34, m34);
            d34.position.set(sc.x, TRACK_Y - 0.6, sc.z);
            d34.renderOrder = 16;
            this.group.add(d34);

            // Inner disc — hurricane-force core (only for ≥Cat 1).
            if (kt >= 64) {
                const r64 = 1.4 + Math.min(4.5, (kt - 64) * 0.06);
                const tex64 = makeWindFieldTexture(cs, 1.0);
                const g64   = new THREE.CircleGeometry(r64, 36);
                g64.rotateX(-Math.PI / 2);
                const m64   = new THREE.MeshBasicMaterial({
                    map:         tex64,
                    transparent: true,
                    depthWrite:  false,
                    depthTest:   false,
                    side:        THREE.DoubleSide,
                    blending:    THREE.AdditiveBlending,
                });
                const d64 = new THREE.Mesh(g64, m64);
                d64.position.set(sc.x, TRACK_Y - 0.4, sc.z);
                d64.renderOrder = 17;
                this.group.add(d64);
            }
        }
    }

    // ── Track particle system ─────────────────────────────────────────────────
    // For each storm, allocate N particles that march along the recorded path
    // from oldest to newest. Each frame _tick advances the particles forward;
    // when a particle reaches the end it respawns at the start. The result
    // looks like a satellite loop of the storm's motion over the past month.
    _buildTrackParticles(renderable) {
        const PER_STORM = 36;
        const total = renderable.length * PER_STORM;
        this._trackPositions = new Float32Array(total * 3);
        this._trackColors    = new Float32Array(total * 3);
        this._trackData      = new Array(total);

        let i = 0;
        for (let s = 0; s < renderable.length; s++) {
            for (let p = 0; p < PER_STORM; p++) {
                this._trackData[i++] = {
                    stormIdx: this._renderableIdx[s],
                    pathT:    Math.random(),
                    age:      Math.random() * 80,
                    maxAge:   90 + Math.random() * 50,
                    speed:    0.0035 + Math.random() * 0.0022,
                };
            }
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(this._trackPositions, 3));
        geo.setAttribute('color',    new THREE.BufferAttribute(this._trackColors,    3));
        geo.attributes.position.setUsage(THREE.DynamicDrawUsage);
        geo.attributes.color.setUsage(THREE.DynamicDrawUsage);
        const mat = new THREE.PointsMaterial({
            size:           2.8,
            sizeAttenuation: false,
            vertexColors:   true,
            transparent:    true,
            opacity:        1.0,
            depthWrite:     false,
            depthTest:      false,
            blending:       THREE.AdditiveBlending,
        });
        this._trackPoints = new THREE.Points(geo, mat);
        this._trackPoints.renderOrder   = 18;
        this._trackPoints.frustumCulled = false;
        this.group.add(this._trackPoints);
    }

    // ── Cyclone glyph particle system ─────────────────────────────────────────
    // For each storm, lay out particles around the most recent position on
    // multiple spiral arms. Rotation is hemisphere-correct (CCW north, CW
    // south) and angular velocity scales with the storm's current intensity.
    _buildCycloneParticles(renderable) {
        const PER_STORM = 90;
        const ARM_COUNT = 4;
        const total = renderable.length * PER_STORM;
        this._cyclonePositions = new Float32Array(total * 3);
        this._cycloneColors    = new Float32Array(total * 3);
        this._cycloneData      = new Array(total);

        let i = 0;
        for (let s = 0; s < renderable.length; s++) {
            const storm = renderable[s];
            const head  = storm.recent[storm.recent.length - 1];
            const hemi  = head.lat >= 0 ? 1 : -1;
            const intensity = head.kt || 0;
            // Bigger spiral for stronger storms (Cat 5 ~3 scene units)
            const baseR = 0.6 + Math.min(intensity / 50, 1.6) * 1.6;

            for (let p = 0; p < PER_STORM; p++) {
                const armIdx   = p % ARM_COUNT;
                const tAlong   = Math.floor(p / ARM_COUNT) / (PER_STORM / ARM_COUNT);
                const armBase  = (armIdx / ARM_COUNT) * Math.PI * 2;
                const r        = baseR * (0.2 + tAlong * 0.95);
                // Spiral twist along arm (Archimedean-ish)
                const twist    = tAlong * Math.PI * 2.8;
                this._cycloneData[i++] = {
                    stormIdx: this._renderableIdx[s],
                    theta:    armBase + hemi * twist,
                    r,
                    hemi,
                    flick:    Math.random() * Math.PI * 2,
                    brightT:  0.6 + tAlong * 0.4,
                };
            }
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(this._cyclonePositions, 3));
        geo.setAttribute('color',    new THREE.BufferAttribute(this._cycloneColors,    3));
        geo.attributes.position.setUsage(THREE.DynamicDrawUsage);
        geo.attributes.color.setUsage(THREE.DynamicDrawUsage);
        const mat = new THREE.PointsMaterial({
            size:           3.4,
            sizeAttenuation: false,
            vertexColors:   true,
            transparent:    true,
            opacity:        0.95,
            depthWrite:     false,
            depthTest:      false,
            // NormalBlending preserves the category colour over bright base-
            // map terrain (additive washes out to white over land).
            blending:       THREE.NormalBlending,
        });
        this._cyclonePoints = new THREE.Points(geo, mat);
        this._cyclonePoints.renderOrder   = 20;
        this._cyclonePoints.frustumCulled = false;
        this.group.add(this._cyclonePoints);
    }

    // ── Satellite-imagery sprite at each cyclone head ─────────────────────────
    // Each storm gets a single THREE.Sprite at its current position. The
    // texture starts as a procedurally-painted satellite-IR-style cloud
    // spiral (always available) and asynchronously upgrades to a real NASA
    // Worldview MODIS Aqua snapshot of the region if the network permits.
    // Size scales with intensity so a Cat 5 occupies the geographic area
    // its wind footprint would on a real synoptic chart.
    _buildCycloneSprites(renderable) {
        if (this._cycloneSprites) {
            for (const s of this._cycloneSprites) {
                this.group.remove(s);
                s.material?.map?.dispose();
                s.material?.dispose();
            }
        }
        this._cycloneSprites = [];

        for (const storm of renderable) {
            const head = storm.recent[storm.recent.length - 1];
            const sc   = lonLatToScene(head.lon, head.lat);
            const hemi = head.lat >= 0 ? 1 : -1;
            const kt   = head.kt || 0;
            // Size in scene units: ~6 for a Tropical Storm, ~16 for a Cat 5.
            const size = 6 + Math.min(kt / 50, 1.5) * 10;

            const placeholderTex = makeProceduralCycloneTexture(head.cat, hemi);
            const mat = new THREE.SpriteMaterial({
                map:         placeholderTex,
                transparent: true,
                opacity:     0.95,
                depthWrite:  false,
                depthTest:   false,
                blending:    THREE.NormalBlending,
            });
            const spr = new THREE.Sprite(mat);
            spr.scale.set(size, size, 1);
            spr.position.set(sc.x, TRACK_Y + 0.5, sc.z);
            spr.renderOrder = 19;
            spr.userData.hemiSign   = hemi;
            spr.userData.pulsePhase = Math.random() * Math.PI * 2;
            spr.userData.rotInit    = Math.random() * Math.PI * 2;
            spr.userData.usingLive  = false;
            this.group.add(spr);
            this._cycloneSprites.push(spr);

            // Live MODIS Aqua imagery is intentionally disabled. At world
            // zoom each storm occupies ~10-20 px and MODIS's afternoon-only
            // passes routinely return dark-ocean captures that look like
            // grey blocks. The procedural cloud-spiral texture above reads
            // more cleanly as "this is a cyclone." Re-enable by uncommenting
            // a fetchCycloneSnapshot(head).then(...) block if/when we add a
            // GOES-East/West/Himawari per-basin imagery pipeline.
        }
    }

    // ── Head ring — soft pulsing halo at each storm's current position ──────
    _buildHeadRings(renderable) {
        const cs = new Float32Array(3);
        for (const storm of renderable) {
            const head = storm.recent[storm.recent.length - 1];
            const sc   = lonLatToScene(head.lon, head.lat);
            categoryColor(head.cat, cs);
            const ringGeo = new THREE.RingGeometry(HEAD_RADIUS * 0.65, HEAD_RADIUS, 32);
            ringGeo.rotateX(-Math.PI / 2);
            const ringMat = new THREE.MeshBasicMaterial({
                color:       new THREE.Color(cs[0], cs[1], cs[2]),
                transparent: true,
                opacity:     0.8,
                depthWrite:  false,
                depthTest:   false,
                side:        THREE.DoubleSide,
                blending:    THREE.AdditiveBlending,
            });
            const ring = new THREE.Mesh(ringGeo, ringMat);
            ring.position.set(sc.x, TRACK_Y + 0.2, sc.z);
            ring.renderOrder = 11;
            this.group.add(ring);
            this._headObjects.push({ mesh: ring, phase: Math.random() * Math.PI * 2 });
        }
    }

    // ── Click-to-inspect popup ────────────────────────────────────────────────

    _installPopup() {
        if (document.getElementById('ibtracs-popup')) return;
        const el = document.createElement('div');
        el.id = 'ibtracs-popup';
        el.style.cssText = [
            'position:fixed', 'z-index:100', 'display:none',
            'min-width:220px', 'padding:10px 12px',
            'background:rgba(2,6,14,0.92)',
            'border:1px solid #ff8c5a', 'border-radius:5px',
            'font:11px/1.4 ui-monospace,Consolas,monospace',
            'color:#ffd5b8', 'letter-spacing:0.04em',
            'box-shadow:0 4px 16px rgba(0,0,0,0.55)',
            'backdrop-filter:blur(8px)', '-webkit-backdrop-filter:blur(8px)',
            'pointer-events:auto', 'user-select:text',
        ].join(';');
        document.body.appendChild(el);
        this._popupEl = el;
        // Click on the popup itself doesn't close it
        el.addEventListener('click', e => e.stopPropagation());
        // Click anywhere else closes it
        document.addEventListener('click', e => {
            if (el.style.display !== 'none' && e.target !== el && !el.contains(e.target)) {
                this._hidePopup();
            }
        });
    }

    _attachClickHandler() {
        if (this._clickHandler) return;
        this._clickHandler = (e) => {
            if (!this.group.visible) return;
            const cam = window.camera;
            if (!cam) return;
            const W = window.innerWidth;
            const H = window.innerHeight;
            const v = new THREE.Vector3();
            let nearest = null;
            let nearestDist = 28;   // pixels
            for (let s = 0; s < this._tracks.length; s++) {
                const storm = this._tracks[s];
                const recent = storm.recent || storm.positions;
                if (!recent || recent.length === 0) continue;
                const head = recent[recent.length - 1];
                const sc = lonLatToScene(head.lon, head.lat);
                v.set(sc.x, TRACK_Y + 0.2, sc.z).project(cam);
                if (v.z < -1 || v.z > 1) continue;
                const sx = (v.x + 1) * 0.5 * W;
                const sy = (1 - v.y) * 0.5 * H;
                const dx = sx - e.clientX;
                const dy = sy - e.clientY;
                const d  = Math.sqrt(dx * dx + dy * dy);
                if (d < nearestDist) { nearestDist = d; nearest = storm; }
            }
            if (nearest) {
                this._showPopup(nearest, e.clientX, e.clientY);
                e.stopPropagation();
            }
        };
        // Capture phase so we intercept before vessel-click handlers.
        window.addEventListener('click', this._clickHandler, true);
    }

    _showPopup(storm, x, y) {
        const el = this._popupEl;
        if (!el) return;
        const positions = storm.recent || storm.positions;
        const head = positions[positions.length - 1];
        const peakKt = positions.reduce((m, p) => Math.max(m, p.kt), 0);
        const peakCat = categoryFromKnots(peakKt);
        const catLabel = (c) => c >= 1 ? `CAT ${c}` : c === 0 ? 'TROPICAL STORM' : 'TROPICAL DEPRESSION';
        const peakLabel = catLabel(peakCat);
        const headLabel = catLabel(head.cat);
        const firstTs = positions[0].ts;
        const daysActive = ((head.ts - firstTs) / 86400000).toFixed(1);
        const ageHrs    = ((Date.now() - head.ts) / 3600000).toFixed(0);
        const basinName = {
            'NA': 'NORTH ATLANTIC',
            'EP': 'EASTERN PACIFIC',
            'WP': 'WESTERN PACIFIC',
            'NI': 'NORTH INDIAN',
            'SI': 'SOUTH INDIAN',
            'SP': 'SOUTH PACIFIC',
            'CP': 'CENTRAL PACIFIC',
            'AS': 'AUSTRALIAN',
        }[storm.basin] || (storm.basin || 'UNKNOWN');

        el.innerHTML =
            `<div style="color:#ff8c5a;font-weight:800;letter-spacing:1.5px;font-size:13px;margin-bottom:4px;">` +
            `&#10800; ${storm.name || 'UNNAMED'}` +
            `</div>` +
            `<div style="color:#7fb6cf;letter-spacing:0.1em;margin-bottom:6px;">${basinName}</div>` +
            `<div>PEAK: <span style="color:#ffd95a;">${peakLabel}</span> &middot; ${Math.round(peakKt)} kt</div>` +
            `<div>LAST: <span style="color:#ffd95a;">${headLabel}</span> &middot; ${Math.round(head.kt)} kt</div>` +
            `<div>POSITION: ${Math.abs(head.lat).toFixed(1)}&deg;${head.lat >= 0 ? 'N' : 'S'}, ` +
            `${Math.abs(head.lon).toFixed(1)}&deg;${head.lon >= 0 ? 'E' : 'W'}</div>` +
            `<div>ACTIVE: ${daysActive} days &middot; LAST PING: ${ageHrs}h ago</div>` +
            (storm.synthetic
                ? `<div style="color:#666;margin-top:5px;font-size:9px;letter-spacing:0.15em;">SYNTHETIC PLACEHOLDER &mdash; LIVE FETCH PENDING</div>`
                : `<div style="color:#5be3a4;margin-top:5px;font-size:9px;letter-spacing:0.15em;">&#10003; NOAA NCEI IBTrACS</div>`);

        el.style.left = Math.min(window.innerWidth - 260, x + 12) + 'px';
        el.style.top  = Math.min(window.innerHeight - 180, y + 12) + 'px';
        el.style.display = 'block';
    }

    _hidePopup() {
        if (this._popupEl) this._popupEl.style.display = 'none';
    }
}
