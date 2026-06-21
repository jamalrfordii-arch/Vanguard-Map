// waveFieldLayer.js — global sea-state (significant wave height) RENDER layer.
//
// PHASE B: the visible field. Reads waveFieldManager's waveAt(lon,lat) and paints
// the world ocean as a translucent heatmap (calm blue → heavy-seas red) hovering a
// hair above the Gerstner water plane, with thin contour iso-lines on top at key
// wave-height thresholds. Land is masked transparent (waveAt → NaN).
//
// Data is fetched LAZILY on first enable (Open-Meteo Marine, ~2.3 min full populate,
// 3 h cache, rate-aware) and the field repaints progressively as batches land
// (listens for vg1:waveFieldProgress / vg1:waveFieldReady).
//
// Distributed-autonomy arm: imports no manager except the data field; talks via the
// vg1: event bus and layerManager. Console: window.vg1WaveLayer.
//
// DERIVED, NON-AUTHORITATIVE: significant wave height from a public forecast model
// (Open-Meteo Marine / MeteoFrance SMOC + wave models), not an official warning.

import * as THREE from 'three';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineSegments2 }        from 'three/addons/lines/LineSegments2.js';
import { LineMaterial }         from 'three/addons/lines/LineMaterial.js';
import { MAP_WIDTH, MAP_HEIGHT } from './config.js';
import { waveField } from './waveFieldManager.js';
import { waterUniforms } from './waterManager.js';   // paint sea-state INTO the ocean surface
import { legendManager } from './legendManager.js';  // unified collapsible MAP KEYS panel

// The sea mesh sits at scene y = -0.2 (waterManager). Sit the field a hair above it
// so it lies ON the ocean surface (not floating above continents). Over land the
// terrain rises above this and occludes the sheet; land is GEBCO-masked anyway.
const WAVE_Y   = -0.19;  // render height (scene units) — hugs the water mesh (y=-0.2), sits ON the sea
const SEA_LEVEL = 0.0;   // terrain elevation in METERS above which a point is LAND → masked
const LAT_LIM  = 85;     // Mercator pole clamp (≈ map edge) — contours reach the edges
const MESH_STEP = 1;     // heatmap vertex spacing (deg) — fine, for a crisp coastline outline
const CONT_STEP = 1.5;   // contour sampling resolution (deg) — finer; smoothed after chaining
// Boundaries BETWEEN sea-state bands (the legend thresholds): calm|light|moderate|rough|
// very-rough|high|very-high|phenomenal. Drawn as black lines so the field reads as
// isobands sectioned by wave strength.
const CONTOURS = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5.5, 7, 9];   // fine set incl. half-steps (reveals sub-3 m cascades)

function lonLatToScene(lon, lat) {
    const x = (lon / 180) * (MAP_WIDTH / 2);
    const l = Math.max(-LAT_LIM, Math.min(LAT_LIM, lat)) * Math.PI / 180;
    const mercY = Math.log(Math.tan(Math.PI / 4 + l / 2));
    const z = -(mercY / Math.PI) * (MAP_HEIGHT / 2);
    return [x, z];
}

// Wave-height (m) → RGB ramp. Calm deep-blue → cyan → green → yellow → orange → red.
// Tuned so the everyday 1–3 m band reads cool and the dangerous 6 m+ band reads hot.
// Off BOTH ocean-blue and land-green so the field reads only as a data overlay.
// Electric cyan (calm) → pale aqua → white → yellow → orange → red → magenta (extreme).
// No green band — green looked like land over the open ocean.
const RAMP = [
    [0.0, 0.16, 0.86, 0.94],   // glassy — electric cyan
    [1.0, 0.45, 0.93, 0.95],   // light — pale cyan
    [2.0, 0.80, 0.97, 0.94],   // moderate — pale aqua
    [3.0, 0.98, 0.98, 0.80],   // rough — warm white
    [4.0, 0.99, 0.90, 0.30],   // very rough — yellow
    [5.5, 0.99, 0.58, 0.17],   // high — orange
    [7.0, 0.94, 0.22, 0.15],   // very high — red
    [9.0, 0.88, 0.10, 0.52],   // phenomenal — magenta
];
function ramp(h, out) {
    if (h <= RAMP[0][0]) { out[0] = RAMP[0][1]; out[1] = RAMP[0][2]; out[2] = RAMP[0][3]; return; }
    for (let i = 1; i < RAMP.length; i++) {
        if (h <= RAMP[i][0]) {
            const a = RAMP[i - 1], b = RAMP[i];
            const t = (h - a[0]) / (b[0] - a[0]);
            out[0] = a[1] + (b[1] - a[1]) * t;
            out[1] = a[2] + (b[2] - a[2]) * t;
            out[2] = a[3] + (b[3] - a[3]) * t;
            return;
        }
    }
    const z = RAMP[RAMP.length - 1];
    out[0] = z[1]; out[1] = z[2]; out[2] = z[3];
}

export class WaveFieldLayer {
    constructor(scene) {
        this.scene = scene;
        this.group = new THREE.Group();
        this.group.name = 'waveField';
        this.group.visible = false;
        this.group.renderOrder = 60;       // above water, below wind streaks/HUD
        scene.add(this.group);

        this._heat = null;       // heatmap mesh
        // Contour lines render in a SEPARATE overlay scene AFTER post-processing (main.js),
        // so they bypass the tilt-shift/fog/blur that greys thin in-scene lines → true crisp
        // black. (Caveat: can slide during the operational-theatre cinematic orbit.)
        this._overlayScene = new THREE.Scene();
        this._contourGroup = new THREE.Group();
        this._overlayScene.add(this._contourGroup);
        this._contMats = [];
        this._opacity = 0.62;    // heatmap translucency (live-tunable)
        this._component = 'total';  // which sea-state component to paint: total | swell | wind
        this._built = false;
        this._legendEl = null;
        this._elev = null;       // getTrueElevation(x,z) — GEBCO-backed land/ocean mask
        this._maskBuilt = false; // coastline mask texture built lazily on first enable
        this._waterStrength = 0.82; // how strongly the sea-state recolours the water (0..1)
        this._seaTex = null; this._seaTexData = null; // equirectangular sea-state colour texture

        this._buildHeatGeometry();   // positions never change; colours refresh with data

        // Repaint as data streams in / refreshes.
        if (typeof window !== 'undefined') {
            window.addEventListener('vg1:waveFieldProgress', () => { if (this.group.visible) this.refresh(); });
            window.addEventListener('vg1:waveFieldReady',    () => { if (this.group.visible) this.refresh(); });
            window.vg1WaveLayer = this;
        }
    }

    // GEBCO-backed terrain sampler (scene x,z → elevation in metres). Used to build a
    // per-pixel land/ocean mask texture so the field clips crisply to the real coastline.
    setElevationFn(fn) { this._elev = fn; }

    setVisible(on) {
        this.group.visible = !!on;
        if (on) legendManager.show('sea-state', this._legendTitle(), this._legendHTML());
        else    legendManager.hide('sea-state');
        if (on) {
            this._ensureMask();       // per-pixel coastline mask (clean outlines)
            waveField.fetchField();   // lazy: no-op if fresh data already cached
            this.refresh();
        }
        waterUniforms.uSeaStateStrength.value = 0.0;   // option-3 path dormant
        // The cyan seafloor depth contours (terrainBuilder ocean-floor shader, uShowContours)
        // are a SEPARATE bathymetry layer that clutters the sea-state read. Hide them while
        // Sea State is on so only the black wave isobands show; restore when off.
        this._setBathymetryContours(on ? 0 : 1);
    }

    _setBathymetryContours(v) {
        if (!this.scene) return;
        this.scene.traverse(o => {
            let mats = o.material; if (!mats) return; if (!Array.isArray(mats)) mats = [mats];
            for (const m of mats) if (m && m.userData && m.userData.showContours) m.userData.showContours.value = v;
        });
    }

    // Live tuning: vg1WaveLayer.setWaterStrength(0.9) — experimental water-paint path
    setWaterStrength(v) { this._waterStrength = Math.max(0, Math.min(1, v)); if (this.group.visible) waterUniforms.uSeaStateStrength.value = this._waterStrength; }

    // ── Component selector: total | swell | wind ──────────────────────────────
    // The same renderer (ramp, mask, fades, contours) repaints from whichever scalar
    // field is selected. Total is the original tuned view; swell/wind are decompositions.
    // Wired to the buttons in the legend card via inline onclick → window.vg1WaveLayer.
    setComponent(comp) {
        if (comp !== 'total' && comp !== 'swell' && comp !== 'wind') comp = 'total';
        if (comp === this._component) return;
        this._component = comp;
        // Refresh the legend card (title + active button highlight) and repaint the field.
        legendManager.show('sea-state', this._legendTitle(), this._legendHTML());
        if (this.group.visible) this.refresh();
    }

    _legendTitle() {
        const sub = this._component === 'swell' ? 'SWELL'
                  : this._component === 'wind'  ? 'WIND-WAVE'
                  : 'TOTAL · SIG. HEIGHT';
        return 'SEA STATE · ' + sub;
    }

    // Build the land/ocean mask texture once, on first enable.
    _ensureMask() {
        if (this._maskBuilt || !this._elev || !this._heat) return;
        this._buildLandMask();
        this._maskBuilt = true;
    }

    // Equirectangular land/ocean mask sampled from GEBCO terrain. Linear-filtered so the
    // shader gets a smooth, crisp coastline at any zoom — independent of mesh density.
    _buildLandMask() {
        const W = 2048, H = 1024;
        const data = new Uint8Array(W * H * 4);
        for (let y = 0; y < H; y++) {
            const lat = -90 + (y + 0.5) / H * 180;
            for (let x = 0; x < W; x++) {
                const lon = -180 + (x + 0.5) / W * 360;
                const [sx, sz] = lonLatToScene(lon, lat);
                const e = this._elev(sx, sz);
                const v = (typeof e === 'number' && e > SEA_LEVEL) ? 0 : 255;  // land 0, ocean 255
                const o = (y * W + x) * 4;
                data[o] = data[o + 1] = data[o + 2] = v; data[o + 3] = 255;
            }
        }
        const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
        tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
        tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;
        const u = this._heat.material.uniforms;
        if (u.uLandMask.value) u.uLandMask.value.dispose();
        u.uLandMask.value = tex;
        u.uMaskOn.value = 1;
    }

    // Live tuning from DevTools: vg1WaveLayer.setOpacity(0.6); vg1WaveLayer.setHeight(2.0)
    setOpacity(v) { this._opacity = Math.max(0, Math.min(1, v)); if (this._heat) this._heat.material.uniforms.uOpacity.value = this._opacity; }
    // Grazing-angle fade window: below lo the field is gone (horizon), above hi it's full (top-down).
    setFade(lo, hi) { if (this._heat) { this._heat.material.uniforms.uFadeLo.value = lo; this._heat.material.uniforms.uFadeHi.value = hi; } }
    setHeight(y)  { this.group.position.y = y - WAVE_Y; }

    // ── Heatmap geometry (built once) ─────────────────────────────────────────
    _buildHeatGeometry() {
        const cols = Math.round(360 / MESH_STEP) + 1;
        const rows = 320;                                  // z-uniform rows → full map coverage
        const HALF_W = MAP_WIDTH / 2, HALF_H = MAP_HEIGHT / 2;
        const N = cols * rows;
        const pos = new Float32Array(N * 3);
        const col = new Float32Array(N * 3);   // vertex colour
        const alp = new Float32Array(N);        // vertex alpha (0 = no wave data)
        const ll  = new Float32Array(N * 2);    // per-vertex lon/lat → land-mask UV in the shader
        const wh  = new Float32Array(N);        // per-vertex wave height (m) → per-fragment band posterize

        // Rows are uniform in scene-Z so the field covers the ENTIRE map rectangle
        // (edge to edge, including the poles) with no gap; latitude per row comes from
        // inverse Mercator so the data + land mask still sample correctly.
        for (let r = 0; r < rows; r++) {
            const z = -HALF_H + (r / (rows - 1)) * MAP_HEIGHT;            // -150 … +150 (full map)
            const mercY = -z * Math.PI / HALF_H;
            const lat = (2 * Math.atan(Math.exp(mercY)) - Math.PI / 2) * 180 / Math.PI;
            for (let c = 0; c < cols; c++) {
                const lon = -180 + c * MESH_STEP;
                const i = r * cols + c;
                pos[i * 3] = (lon / 180) * HALF_W; pos[i * 3 + 1] = 0; pos[i * 3 + 2] = z;
                ll[i * 2] = lon; ll[i * 2 + 1] = lat;
            }
        }
        const idx = [];
        for (let r = 0; r < rows - 1; r++) {
            for (let c = 0; c < cols - 1; c++) {
                const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
                idx.push(a, d, b, b, d, e);
            }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('vcol', new THREE.BufferAttribute(col, 3));
        geo.setAttribute('valpha', new THREE.BufferAttribute(alp, 1));
        geo.setAttribute('lonlat', new THREE.BufferAttribute(ll, 2));
        geo.setAttribute('wh', new THREE.BufferAttribute(wh, 1));
        geo.setIndex(idx);

        const mat = new THREE.ShaderMaterial({
            uniforms: {
                uOpacity: { value: this._opacity }, uFadeLo: { value: 0.18 }, uFadeHi: { value: 0.5 },
                uLandMask: { value: null }, uMaskOn: { value: 0 },
            },
            transparent: true, depthWrite: false, depthTest: true,
            side: THREE.DoubleSide,
            vertexShader: `
                attribute vec3 vcol; attribute float valpha; attribute vec2 lonlat; attribute float wh;
                varying vec3 vC; varying float vA; varying vec3 vViewPos; varying vec3 vViewN; varying vec2 vUV; varying float vWH;
                void main(){
                    vC = vcol; vA = valpha; vWH = wh;
                    vUV = vec2((lonlat.x + 180.0) / 360.0, (lonlat.y + 90.0) / 180.0);
                    vec4 mv = modelViewMatrix * vec4(position, 1.0);
                    vViewPos = mv.xyz;
                    vViewN   = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));
                    gl_Position = projectionMatrix * mv;
                }`,
            // Two effects: (1) per-pixel land mask (equirectangular, linear-filtered) clips the
            // field crisply to the real coastline regardless of mesh density → clean outlines.
            // (2) grazing-angle fade so the flat field never reads as a floating horizon ceiling.
            fragmentShader: `
                precision mediump float;
                varying vec3 vC; varying float vA; varying vec3 vViewPos; varying vec3 vViewN; varying vec2 vUV; varying float vWH;
                uniform float uOpacity; uniform float uFadeLo; uniform float uFadeHi;
                uniform sampler2D uLandMask; uniform float uMaskOn;
                // Discrete band base colour per sea-state level (matches the legend).
                vec3 bandColor(float h){
                    if (h < 1.0) return vec3(0.16, 0.86, 0.94);   // calm
                    if (h < 2.0) return vec3(0.45, 0.93, 0.95);   // light
                    if (h < 3.0) return vec3(0.80, 0.97, 0.94);   // moderate
                    if (h < 4.0) return vec3(0.98, 0.98, 0.80);   // rough
                    if (h < 5.5) return vec3(0.99, 0.90, 0.30);   // very rough
                    if (h < 7.0) return vec3(0.99, 0.58, 0.17);   // high
                    if (h < 9.0) return vec3(0.94, 0.22, 0.15);   // very high
                    return vec3(0.88, 0.10, 0.52);                // phenomenal
                }
                void main(){
                    if (vA < 0.02) discard;
                    float sea = 1.0;
                    if (uMaskOn > 0.5) {
                        float m = texture2D(uLandMask, vUV).r;     // 1 = ocean, 0 = land (linear-filtered → smooth coast)
                        sea = smoothstep(0.42, 0.58, m);
                        if (sea < 0.02) discard;
                    }
                    // Hybrid posterize: flat per-band colour with a faint smooth-gradient nuance
                    // (vC) mixed in, so each sea-state level reads as its own region but isn't dead-flat.
                    vec3 col = mix(bandColor(vWH), vC, 0.18);
                    vec3 vd = normalize(-vViewPos);
                    float graze = abs(dot(vd, normalize(vViewN)));
                    float fade = smoothstep(uFadeLo, uFadeHi, graze);
                    // Pole clamp: fade the field out past ~±80° so the Mercator-stretched
                    // polar caps (empty ice/ocean) don't dominate. vUV.y → latitude.
                    float latAbs = abs(vUV.y * 180.0 - 90.0);
                    float poleFade = 1.0 - smoothstep(60.0, 70.0, latAbs);
                    float a = vA * uOpacity * fade * sea * poleFade;
                    if (a < 0.012) discard;
                    gl_FragColor = vec4(col, a);
                }`,
        });

        this._heat = new THREE.Mesh(geo, mat);
        this._heat.position.y = WAVE_Y;
        this._heat.frustumCulled = false;
        this._heat.renderOrder = 60;
        // NOTE (2026-06-17): Option 3 (painting sea-state INTO the Gerstner water) proved
        // invisible — the ocean colour is drawn by the point-cloud splat + sea-floor mesh,
        // NOT the water surface, so tinting the water has no effect. Reverted to this overlay
        // mesh (visible), which renders on top and is clipped to the coast per-pixel by the
        // land-mask texture. Water-shader hooks (uSeaState*) left dormant in waterManager.
        this._cols = cols; this._rows = rows;
        this.group.add(this._heat);
    }

    // ── Repaint overlay vertex colours from the current field + rebuild contours ──
    // Land masking is per-PIXEL via the land-mask texture (crisp coastlines), so the
    // mesh just carries colour everywhere there's wave data.
    refresh() {
        if (!this._heat || !waveField.haveData()) return;
        const colAttr = this._heat.geometry.getAttribute('vcol');
        const alpAttr = this._heat.geometry.getAttribute('valpha');
        const whAttr  = this._heat.geometry.getAttribute('wh');
        const llArr   = this._heat.geometry.getAttribute('lonlat').array;
        const rgb = [0, 0, 0];
        const N = alpAttr.count;
        for (let i = 0; i < N; i++) {
            const h = waveField.waveAtFilled(llArr[i * 2], llArr[i * 2 + 1], this._component);
            if (Number.isNaN(h)) { alpAttr.array[i] = 0; whAttr.array[i] = 0; continue; }
            ramp(h, rgb);
            colAttr.array[i * 3] = rgb[0]; colAttr.array[i * 3 + 1] = rgb[1]; colAttr.array[i * 3 + 2] = rgb[2];
            whAttr.array[i] = h;
            alpAttr.array[i] = 1;
        }
        colAttr.needsUpdate = true; alpAttr.needsUpdate = true; whAttr.needsUpdate = true;
        this._built = true;
        this._buildContours();
    }

    // Equirectangular sea-state colour texture sampled by the water shader. Low-res is
    // fine — the wave field is smooth and the texture is linear-filtered. Land needs no
    // mask: the opaque terrain occludes the water, so the coastline is pixel-perfect.
    _updateSeaTex() {
        const W = 512, H = 256;
        if (!this._seaTexData) this._seaTexData = new Uint8Array(W * H * 4);
        const data = this._seaTexData, rgb = [0, 0, 0];
        for (let y = 0; y < H; y++) {
            const lat = -90 + (y + 0.5) / H * 180;
            for (let x = 0; x < W; x++) {
                const lon = -180 + (x + 0.5) / W * 360;
                const h = waveField.waveAtFilled(lon, lat);
                const o = (y * W + x) * 4;
                if (Number.isNaN(h)) { data[o] = data[o + 1] = data[o + 2] = data[o + 3] = 0; continue; }
                ramp(h, rgb);
                data[o] = (rgb[0] * 255) | 0; data[o + 1] = (rgb[1] * 255) | 0; data[o + 2] = (rgb[2] * 255) | 0; data[o + 3] = 255;
            }
        }
        if (!this._seaTex) {
            this._seaTex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
            this._seaTex.minFilter = THREE.LinearFilter; this._seaTex.magFilter = THREE.LinearFilter;
            this._seaTex.wrapS = THREE.RepeatWrapping; this._seaTex.wrapT = THREE.ClampToEdgeWrapping;
            this._seaTex.generateMipmaps = false;
        }
        this._seaTex.needsUpdate = true;
        waterUniforms.uSeaState.value = this._seaTex;
    }

    // ── Contour iso-lines (marching squares on a sampled grid) ────────────────
    _buildContours() {
        // clear
        while (this._contourGroup.children.length) {
            const ch = this._contourGroup.children.pop();
            ch.geometry?.dispose?.(); ch.material?.dispose?.();
        }
        this._contMats = [];

        const cc = Math.round(360 / CONT_STEP) + 1;
        const rr = Math.round((2 * LAT_LIM) / CONT_STEP) + 1;
        const grid = new Float32Array(cc * rr);
        const elev = this._elev;
        for (let r = 0; r < rr; r++) {
            const lat = -LAT_LIM + r * CONT_STEP;
            for (let c = 0; c < cc; c++) {
                const lon = -180 + c * CONT_STEP;
                let h = waveField.waveAtFilled(lon, lat, this._component);
                if (Math.abs(lat) > 66) h = NaN;          // pole clamp — no contours past the storm belt
                // GEBCO land → NaN. _contour skips any cell touching NaN, so iso-lines
                // never hug the coastline; they read as open-ocean "elevation" contours.
                if (!Number.isNaN(h) && elev) {
                    const [x, z] = lonLatToScene(lon, lat);
                    const e = elev(x, z);
                    if (typeof e === 'number' && e > SEA_LEVEL) h = NaN;
                }
                grid[r * cc + c] = h;
            }
        }

        const resW = (typeof window !== 'undefined') ? window.innerWidth : 1920;
        const resH = (typeof window !== 'undefined') ? window.innerHeight : 1080;
        // Outline EVERY band boundary in BLACK, weighted by severity:
        //   sub-3 m (0.5–2.5 m): thin black — visible (not a faint hairline), reveals calm cascades
        //   rough … very-high (3–5.5 m): bold black — defined storm zones
        //   danger (7, 9 m): heaviest black + a thin light core (black alone vanishes on dark cores)
        // Each line is the closed perimeter enclosing seas ≥ threshold (marching squares),
        // chained into continuous polylines and Chaikin-smoothed so they flow, not stair-step.
        // Land/coast cells are skipped upstream, so outlines never trace the continents.
        for (const thr of CONTOURS) {
            const segs = this._contourSegs(grid, cc, rr, thr);
            if (segs.length < 2) continue;
            const polys = this._chainSegments(segs);
            const pos = [];
            const elev = this._elev;
            for (const poly of polys) {
                const sm = poly.length >= 3 ? this._chaikin(poly, 2) : poly;
                for (let i = 0; i < sm.length - 1; i++) {
                    if (Math.abs(sm[i][0] - sm[i + 1][0]) > 180) continue;   // skip dateline span
                    const a = lonLatToScene(sm[i][0], sm[i][1]);
                    const b = lonLatToScene(sm[i + 1][0], sm[i + 1][1]);
                    // Per-segment land guard: the coarse contour grid can let a line creep
                    // onto a coast, or a smoothed segment bridge a strait over land. Sample
                    // elevation at the endpoints AND midpoint; drop the segment if any is land.
                    if (elev) {
                        const mLon = (sm[i][0] + sm[i + 1][0]) * 0.5, mLat = (sm[i][1] + sm[i + 1][1]) * 0.5;
                        const [mx, mz] = lonLatToScene(mLon, mLat);
                        const ea = elev(a[0], a[1]), eb = elev(b[0], b[1]), em = elev(mx, mz);
                        if ((typeof ea === 'number' && ea > SEA_LEVEL) ||
                            (typeof eb === 'number' && eb > SEA_LEVEL) ||
                            (typeof em === 'number' && em > SEA_LEVEL)) continue;   // crosses land
                    }
                    pos.push(a[0], WAVE_Y + 0.012, a[1], b[0], WAVE_Y + 0.012, b[1]);
                }
            }
            if (pos.length < 6) continue;
            const geo = new LineSegmentsGeometry();
            geo.setPositions(pos);

            // Topographic hierarchy, all SOLID black:
            //   intermediate (0.5/1.5/2.5 m): fine thin lines
            //   standard (1/2 m): a touch heavier
            //   index (3/4/5.5 m): bold "index" contours that define the storm zones
            //   danger (7/9 m): heaviest + light core
            const danger       = thr >= 7;
            const index        = thr >= 3 && thr < 7;
            const intermediate = thr < 3 && (thr % 1 !== 0);
            const lw = danger ? 1.8 : index ? 1.3 : intermediate ? 0.6 : 1.0;   // thin fine topo weight
            const op = 1.0;                       // fully opaque — solid like a topo sheet

            // depthTest:false + very high renderOrder → the black lines paint LAST, on top of
            // the translucent fill AND the baked-in base bathymetry lines, so nothing tints them.
            const baseMat = new LineMaterial({ color: 0x000000, linewidth: lw, transparent: true, opacity: op, depthWrite: false, depthTest: false });
            baseMat.resolution.set(resW, resH);
            const base = new LineSegments2(geo, baseMat); base.computeLineDistances(); base.renderOrder = 100;
            this._contourGroup.add(base); this._contMats.push(baseMat);

            if (danger) {
                // Thin light core only where pure black would vanish (dark red/magenta cores).
                const coreMat = new LineMaterial({ color: 0xeef6ff, linewidth: 1.0, transparent: true, opacity: 0.85, depthWrite: false, depthTest: false });
                coreMat.resolution.set(resW, resH);
                const core = new LineSegments2(geo, coreMat); core.computeLineDistances(); core.renderOrder = 101;
                this._contourGroup.add(core); this._contMats.push(coreMat);
            }
        }
    }

    // Marching squares → array of [[lon,lat],[lon,lat]] segments (unprojected, so we can
    // chain + smooth in lon/lat before projecting to the scene).
    _contourSegs(grid, cols, rows, t) {
        const out = [];
        const at = (r, c) => grid[r * cols + c];
        const f = (a, b) => { const d = b - a; return Math.abs(d) < 1e-6 ? 0.5 : Math.max(0, Math.min(1, (t - a) / d)); };
        const push = (p1, p2) => {
            if (Math.abs(p1[0] - p2[0]) > 180) return;   // skip dateline wrap
            out.push([[p1[0], p1[1]], [p2[0], p2[1]]]);
        };
        for (let r = 0; r < rows - 1; r++) {
            const lat0 = -LAT_LIM + r * CONT_STEP, lat1 = lat0 + CONT_STEP;
            for (let c = 0; c < cols - 1; c++) {
                const lon0 = -180 + c * CONT_STEP, lon1 = lon0 + CONT_STEP;
                const TL = at(r, c), TR = at(r, c + 1), BR = at(r + 1, c + 1), BL = at(r + 1, c);
                // Skip any cell touching land — no iso-lines along coastlines.
                if (Number.isNaN(TL) || Number.isNaN(TR) || Number.isNaN(BR) || Number.isNaN(BL)) continue;
                let k = 0;
                if (TL > t) k |= 8; if (TR > t) k |= 4; if (BR > t) k |= 2; if (BL > t) k |= 1;
                if (k === 0 || k === 15) continue;
                const T = [lon0 + CONT_STEP * f(TL, TR), lat0];
                const R = [lon1, lat0 + CONT_STEP * f(TR, BR)];
                const B = [lon0 + CONT_STEP * f(BL, BR), lat1];
                const L = [lon0, lat0 + CONT_STEP * f(TL, BL)];
                switch (k) {
                    case 1: push(L, B); break;       case 2: push(B, R); break;
                    case 3: push(L, R); break;       case 4: push(T, R); break;
                    case 5: push(L, T); push(B, R); break;
                    case 6: push(T, B); break;       case 7: push(T, L); break;
                    case 8: push(T, L); break;       case 9: push(T, B); break;
                    case 10: push(T, R); push(L, B); break;
                    case 11: push(T, R); break;      case 12: push(L, R); break;
                    case 13: push(B, R); break;      case 14: push(L, B); break;
                }
            }
        }
        return out;
    }

    // Greedily connect marching-squares segments into continuous polylines by shared
    // endpoints (quantized), so each band perimeter becomes one flowing line.
    _chainSegments(segs) {
        const key = (p) => Math.round(p[0] * 1000) + ',' + Math.round(p[1] * 1000);
        const ptMap = new Map();
        segs.forEach((s, i) => {
            for (const e of [0, 1]) {
                const k = key(s[e]);
                if (!ptMap.has(k)) ptMap.set(k, []);
                ptMap.get(k).push({ i, e });
            }
        });
        const used = new Array(segs.length).fill(false);
        const polys = [];
        for (let i = 0; i < segs.length; i++) {
            if (used[i]) continue;
            used[i] = true;
            const poly = [segs[i][0], segs[i][1]];
            let grow = true;
            while (grow) {                                   // extend from the tail
                grow = false;
                for (const { i: j, e } of (ptMap.get(key(poly[poly.length - 1])) || [])) {
                    if (used[j]) continue;
                    poly.push(segs[j][1 - e]); used[j] = true; grow = true; break;
                }
            }
            grow = true;
            while (grow) {                                   // extend from the head
                grow = false;
                for (const { i: j, e } of (ptMap.get(key(poly[0])) || [])) {
                    if (used[j]) continue;
                    poly.unshift(segs[j][1 - e]); used[j] = true; grow = true; break;
                }
            }
            polys.push(poly);
        }
        return polys;
    }

    // Chaikin corner-cutting → smooth flowing curves from the chained polyline.
    _chaikin(poly, iters) {
        if (poly.length < 3) return poly;
        const closed = Math.abs(poly[0][0] - poly[poly.length - 1][0]) < 1e-6 &&
                       Math.abs(poly[0][1] - poly[poly.length - 1][1]) < 1e-6;
        let p = poly;
        for (let it = 0; it < iters; it++) {
            const out = [];
            if (!closed) out.push(p[0]);
            for (let i = 0; i < p.length - 1; i++) {
                const a = p[i], b = p[i + 1];
                out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
                out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
            }
            if (!closed) out.push(p[p.length - 1]); else out.push(out[0]);
            p = out;
        }
        return p;
    }

    onResize(w, h) { for (const m of this._contMats) m.resolution.set(w, h); }

    // Called from main.js AFTER composer.render(): paints the contour overlay on top of the
    // post-processed image so the thin black isobands stay crisp (no fog/blur greying).
    renderOverlay(renderer, camera, mainScene) {
        if (!this.group.visible || !this._overlayScene) return;
        // Cinematic orbit spins the whole main scene (scene.rotation.y). Mirror that transform
        // onto the overlay scene so the contour lines rotate WITH the map, not stay fixed.
        if (mainScene) {
            this._overlayScene.rotation.copy(mainScene.rotation);
            this._overlayScene.position.copy(mainScene.position);
            this._overlayScene.scale.copy(mainScene.scale);
        }
        const prevAutoClear = renderer.autoClear;
        renderer.autoClear = false;
        renderer.clearDepth();
        renderer.render(this._overlayScene, camera);   // camera as-is (matches composer's frame)
        renderer.autoClear = prevAutoClear;
    }

    // ── Legend HTML for the unified MAP KEYS panel ────────────────────────────
    _legendHTML() {
        const bands = [
            { label: 'Phenomenal&nbsp; 9 m+', hex: '#e01a85' },
            { label: 'Very high&nbsp;&nbsp;&nbsp;7 m',  hex: '#f03826' },
            { label: 'High&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;5.5 m', hex: '#fc9429' },
            { label: 'Very rough&nbsp; 4 m',  hex: '#fce64d' },
            { label: 'Rough&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;3 m',  hex: '#fafad0' },
            { label: 'Moderate&nbsp;&nbsp; 2 m',  hex: '#ccf7f0' },
            { label: 'Light&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;1 m',  hex: '#73edf2' },
            { label: 'Calm&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;0 m',  hex: '#29dbf0' },
        ];
        // Component selector — three small toggle buttons (Total / Swell / Wind-wave).
        // Inline onclick → window.vg1WaveLayer.setComponent(); active one is highlighted.
        const mkBtn = (id, lbl) => {
            const active = this._component === id;
            const bg = active ? 'rgba(80,150,210,0.55)' : 'rgba(120,180,220,0.10)';
            const bd = active ? 'rgba(150,200,240,0.85)' : 'rgba(120,180,220,0.30)';
            const fg = active ? '#eaf4ff' : '#9bbdd6';
            return `<button onclick="window.vg1WaveLayer&&window.vg1WaveLayer.setComponent('${id}')"
                style="flex:1;cursor:pointer;padding:3px 4px;font:inherit;font-size:9px;letter-spacing:0.04em;
                color:${fg};background:${bg};border:1px solid ${bd};border-radius:4px;">${lbl}</button>`;
        };
        let html = `<div style="display:flex;gap:4px;margin:2px 0 7px;">
            ${mkBtn('total', 'TOTAL')}${mkBtn('swell', 'SWELL')}${mkBtn('wind', 'WIND')}</div>`;
        const note = this._component === 'swell' ? 'long-travelled energy from distant storms'
                   : this._component === 'wind'  ? 'locally wind-generated chop'
                   : 'combined sea — swell + wind-wave';
        html += `<div style="color:#6f93ac;margin:-3px 0 6px;font-size:9px;letter-spacing:0.03em;">${note}</div>`;
        for (const b of bands) {
            html += `<div style="display:flex;align-items:center;gap:8px;padding:1px 0;">
                <span style="width:18px;height:7px;border-radius:1px;flex:0 0 auto;background:${b.hex};"></span>
                <span>${b.label}</span></div>`;
        }
        html += `<div style="color:#4a6b84;margin-top:6px;font-size:9px;letter-spacing:0.04em;">Open-Meteo Marine · derived, non-authoritative</div>`;
        return html;
    }
}
