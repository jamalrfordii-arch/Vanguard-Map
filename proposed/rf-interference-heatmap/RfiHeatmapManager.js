// RfiHeatmapManager.js — Satellite RF Interference Heatmap
//
// Data sources:
//   • NASA SMAP L1B brightness temperatures with RFI flags
//     https://nsidc.org/data/spl1btb/versions/3
//   • Pre-processed 0.25°×0.25° RFI persistence maps
//     https://smap.jpl.nasa.gov/rfi/
//   • NASA CMR API for programmatic granule access
//     https://cmr.earthdata.nasa.gov/search/granules.json
//       ?collection_concept_id=C2531308461-NSIDC_ECS
//       &temporal=2024-01-01T00:00:00Z,2024-12-31T23:59:59Z
//   • Spire RF tasking API (commercial, complementary NRT data)
//     https://documentation.spire.com/
//
// Visual: translucent heatmap overlay at Y≈0.08, color ramp from transparent
// through cool blue → amber → angry red-orange for persistent RFI hotspots.
// Pulsing emission on high-intensity cells. Temporal scrubber for month-by-month
// animation. Additive blending for glow compositing.

import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT, prng } from './config.js';

// ── Configuration constants ───────────────────────────────────────────────────

export const RF_INTERFERENCE_HEATMAP = {
    RFI_HEATMAP_OPACITY_MAX:    0.6,
    RFI_HEATMAP_HIGH_THRESHOLD: 40.0,
    RFI_HEATMAP_PULSE_SPEED:    0.8,
    RFI_HEATMAP_COLOR_RAMP:     [0x000000, 0x1a3a5c, 0xd48a2e, 0xff2200],
    RFI_HEATMAP_ALTITUDE:       0.08,
    RFI_GRID_WIDTH:             1440,
    RFI_GRID_HEIGHT:            720,
    RFI_FADE_ALT_MIN:           5.0,
    RFI_FADE_ALT_MAX:           800.0,
    RFI_TEMPORAL_MONTHS:        12,
    RFI_FETCH_TIMEOUT_MS:       15000,
    CMR_COLLECTION_ID:          'C2531308461-NSIDC_ECS',
    CMR_BASE_URL:               'https://cmr.earthdata.nasa.gov/search/granules.json',
    EARTHDATA_TOKEN_URL:        'https://urs.earthdata.nasa.gov/',
    SMAP_RFI_INFO_URL:          'https://smap.jpl.nasa.gov/rfi/',
    NSIDC_DATASET_URL:          'https://nsidc.org/data/spl1btb/versions/3',
    SPIRE_API_URL:              'https://documentation.spire.com/',
};

// ── Module-scope scratch variables (zero allocations in update loop) ──────────

const _scratchVec3A   = new THREE.Vector3();
const _scratchVec3B   = new THREE.Vector3();
const _scratchColor   = new THREE.Color();
const _tmpUniforms    = {};

// ── Known persistent RFI hotspot regions (OSINT-documented) ──────────────────
// Each entry: { lat, lon, radius (degrees), intensity (0-100), label }
// Sources: SMAP RFI reports, EUROCONTROL NOTAMs, academic publications

const KNOWN_RFI_HOTSPOTS = [
    // Eastern Mediterranean / Middle East conflict zone
    { lat: 35.0, lon: 36.0,  radius: 4.0, intensity: 85, label: 'Syria/Lebanon RFI cluster' },
    { lat: 33.5, lon: 44.0,  radius: 3.0, intensity: 70, label: 'Iraq central RFI' },
    { lat: 32.0, lon: 35.0,  radius: 2.5, intensity: 80, label: 'Israel/Palestine RFI' },
    { lat: 36.5, lon: 53.0,  radius: 3.5, intensity: 65, label: 'Iran northern RFI corridor' },
    { lat: 27.0, lon: 50.0,  radius: 2.0, intensity: 55, label: 'Persian Gulf RFI' },

    // Ukraine conflict zone
    { lat: 48.5, lon: 37.5,  radius: 4.0, intensity: 92, label: 'Eastern Ukraine / Donbas RFI' },
    { lat: 45.0, lon: 34.0,  radius: 3.0, intensity: 88, label: 'Crimea RFI cluster' },
    { lat: 50.5, lon: 30.5,  radius: 2.0, intensity: 60, label: 'Kyiv area EW activity' },
    { lat: 46.5, lon: 32.0,  radius: 2.5, intensity: 75, label: 'Kherson / southern front RFI' },
    { lat: 55.7, lon: 37.6,  radius: 3.0, intensity: 50, label: 'Moscow area military EW' },
    { lat: 59.9, lon: 30.3,  radius: 2.0, intensity: 45, label: 'St. Petersburg RFI' },

    // South China Sea
    { lat: 16.5, lon: 112.0, radius: 3.5, intensity: 72, label: 'Paracel Islands RFI' },
    { lat: 10.0, lon: 114.0, radius: 3.0, intensity: 68, label: 'Spratly Islands RFI' },
    { lat: 18.2, lon: 109.5, radius: 2.0, intensity: 60, label: 'Hainan military RFI' },

    // Korean Peninsula
    { lat: 39.0, lon: 125.7, radius: 2.5, intensity: 78, label: 'North Korea EW / GPS jamming' },
    { lat: 37.5, lon: 127.0, radius: 1.5, intensity: 35, label: 'Seoul area interference' },

    // India – Pakistan border
    { lat: 32.0, lon: 74.0,  radius: 2.5, intensity: 55, label: 'Kashmir LOC RFI' },
    { lat: 26.0, lon: 69.0,  radius: 2.0, intensity: 45, label: 'Sindh border RFI' },

    // North Africa
    { lat: 32.0, lon: 13.0,  radius: 3.0, intensity: 60, label: 'Libya conflict RFI' },
    { lat: 15.5, lon: 32.5,  radius: 2.0, intensity: 50, label: 'Sudan RFI' },

    // East Asia military installations
    { lat: 36.0, lon: 140.0, radius: 1.5, intensity: 30, label: 'Japan JSDF installations' },
    { lat: 25.0, lon: 121.5, radius: 2.0, intensity: 55, label: 'Taiwan Strait RFI' },

    // European military
    { lat: 69.0, lon: 33.0,  radius: 2.5, intensity: 50, label: 'Kola Peninsula military RFI' },
    { lat: 54.5, lon: 20.5,  radius: 2.0, intensity: 55, label: 'Kaliningrad EW complex' },

    // Horn of Africa / Yemen
    { lat: 15.0, lon: 44.0,  radius: 3.0, intensity: 65, label: 'Yemen conflict RFI' },
    { lat: 12.5, lon: 43.0,  radius: 1.5, intensity: 50, label: 'Djibouti military RFI' },

    // Central Asia
    { lat: 38.5, lon: 69.0,  radius: 2.0, intensity: 40, label: 'Tajikistan border RFI' },

    // South America — radar installations
    { lat: -2.0,  lon: -60.0, radius: 2.0, intensity: 25, label: 'Amazon SIPAM radar RFI' },

    // Persistent civilian RFI — known SMAP contamination
    { lat: 40.0, lon: -74.0, radius: 1.5, intensity: 30, label: 'US East Coast cellular RFI' },
    { lat: 51.5, lon: 0.0,   radius: 1.5, intensity: 28, label: 'London area RFI' },
    { lat: 35.5, lon: 139.7, radius: 1.0, intensity: 25, label: 'Tokyo metro RFI' },
    { lat: 31.2, lon: 121.5, radius: 1.5, intensity: 35, label: 'Shanghai area RFI' },
    { lat: 39.9, lon: 116.4, radius: 1.5, intensity: 38, label: 'Beijing area RFI' },
    { lat: 23.1, lon: 113.3, radius: 1.5, intensity: 32, label: 'Guangzhou / PRD RFI' },
    { lat: 19.0, lon: 72.8,  radius: 1.5, intensity: 30, label: 'Mumbai area RFI' },
    { lat: 28.6, lon: 77.2,  radius: 1.5, intensity: 35, label: 'Delhi area RFI' },
];

// ── Coordinate conversion ─────────────────────────────────────────────────────

function _toScene(lon, lat) {
    const x     = (lon / 180.0) * (MAP_WIDTH / 2.0);
    const latR  = lat * (Math.PI / 180.0);
    const mercY = Math.log(Math.tan(Math.PI / 4.0 + latR / 2.0));
    const z     = -(mercY / Math.PI) * (MAP_HEIGHT / 2.0);
    return { x, z };
}

function _sceneToLonLat(sx, sz) {
    const lon   = (sx / (MAP_WIDTH / 2.0)) * 180.0;
    const mercY = -(sz / (MAP_HEIGHT / 2.0)) * Math.PI;
    const lat   = (2.0 * Math.atan(Math.exp(mercY)) - Math.PI / 2.0) * (180.0 / Math.PI);
    return { lon, lat };
}

// ── GLSL shaders ──────────────────────────────────────────────────────────────

const VERTEX_SHADER = /* glsl */`
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const FRAGMENT_SHADER = /* glsl */`
    precision highp float;

    uniform sampler2D uRfiTexCurrent;
    uniform sampler2D uRfiTexNext;
    uniform float     uLerpFactor;
    uniform float     uOpacityMax;
    uniform float     uHighThreshold;
    uniform float     uPulseSpeed;
    uniform float     uTime;
    uniform float     uAltitudeFade;
    uniform vec3      uColorRamp[4];

    varying vec2 vUv;

    // Attempt smooth color ramp interpolation across 4 stops
    vec3 colorRamp(float t) {
        // t in [0, 1] maps across 4 color stops at 0.0, 0.333, 0.666, 1.0
        float scaled = clamp(t, 0.0, 1.0) * 3.0;
        int idx = int(floor(scaled));
        float frac = fract(scaled);

        if (idx >= 3) return uColorRamp[3];

        vec3 cA = (idx == 0) ? uColorRamp[0] : (idx == 1) ? uColorRamp[1] : uColorRamp[2];
        vec3 cB = (idx == 0) ? uColorRamp[1] : (idx == 1) ? uColorRamp[2] : uColorRamp[3];

        return mix(cA, cB, frac);
    }

    void main() {
        // Sample current and next month RFI textures, lerp between them
        float rfiCurrent = texture2D(uRfiTexCurrent, vUv).r;
        float rfiNext    = texture2D(uRfiTexNext, vUv).r;
        float rfi        = mix(rfiCurrent, rfiNext, uLerpFactor);

        // rfi is persistence percentage 0–100, normalize to 0–1 for color ramp
        float norm = clamp(rfi / 100.0, 0.0, 1.0);

        // Apply color ramp
        vec3 color = colorRamp(norm);

        // Base alpha proportional to RFI intensity
        float alpha = norm * uOpacityMax;

        // Pulsing emission for high-intensity cells
        float highMask = smoothstep(uHighThreshold / 100.0 - 0.05, uHighThreshold / 100.0 + 0.05, norm);
        float pulse = 0.5 + 0.5 * sin(uTime * uPulseSpeed * 6.28318);
        // Boost alpha and add emission for high-RFI cells
        alpha += highMask * 0.15 * pulse;
        color += highMask * pulse * 0.3 * uColorRamp[3];

        // Altitude-based fade
        alpha *= uAltitudeFade;

        // Discard near-zero alpha fragments for performance
        if (alpha < 0.002) discard;

        gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
    }
`;

// ── Main Manager ──────────────────────────────────────────────────────────────

export default class RfiHeatmapManager {

    /**
     * Construct the RFI Heatmap Manager.
     * Prepares internal state; does not touch the scene until init().
     */
    constructor() {
        /** @type {THREE.Scene|null} */
        this._scene    = null;
        /** @type {THREE.Group|null} */
        this._group    = null;
        /** @type {THREE.Mesh|null} */
        this._mesh     = null;
        /** @type {THREE.ShaderMaterial|null} */
        this._material = null;

        /** @type {Float32Array[]} Monthly RFI grids (12 months) */
        this._monthlyGrids   = [];
        /** @type {THREE.DataTexture[]} Monthly data textures */
        this._monthlyTextures = [];

        /** @type {number} Current temporal month index (0-11) */
        this._currentMonth   = 0;
        /** @type {number} Lerp factor between current and next month (0-1) */
        this._lerpFactor     = 0.0;

        /** @type {boolean} Whether this layer is visible */
        this._visible = false;

        /** @type {boolean} Whether data has been loaded */
        this._dataReady = false;

        /** @type {number} Accumulated time for shader animations */
        this._elapsed = 0.0;

        /** @type {Function|null} Bound event handler reference for cleanup */
        this._onLayerChanged = null;

        /** @type {Function|null} Bound event handler for temporal scrubber */
        this._onTemporalScrub = null;
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    /**
     * Initialize the manager: build geometry, register layer, bind events.
     * @param {THREE.Scene} scene - The Three.js scene to add visuals to.
     * @returns {Promise<void>}
     */
    async init(scene) {
        this._scene = scene;
        this._group = new THREE.Group();
        this._group.name = 'rfi-heatmap-layer';
        this._group.visible = false;
        this._scene.add(this._group);

        // Register with layer manager
        if (typeof window !== 'undefined' && window.layerManager) {
            window.layerManager.register({
                id:        'rfi-heatmap',
                label:     'Satellite RF Interference Heatmap',
                category:  'atmosphere',
                defaultOn: false,
            });
        }

        // Listen for layer toggle events
        this._onLayerChanged = this._handleLayerChanged.bind(this);
        window.addEventListener('vg1:layerChanged', this._onLayerChanged);

        // Listen for temporal scrubber events
        this._onTemporalScrub = this._handleTemporalScrub.bind(this);
        window.addEventListener('vg1:rfi-heatmap:set-month', this._onTemporalScrub);

        // Fetch data (async, non-blocking for init)
        await this._fetchData();

        // Build visuals once data is available
        if (this._dataReady) {
            this._buildHeatmap();
        }
    }

    /**
     * Per-frame update. Animates pulse, handles altitude fade, temporal lerp.
     * @param {THREE.Camera} camera - Active camera for altitude calculation.
     * @param {number} dt - Delta time in seconds.
     */
    update(camera, dt) {
        if (!this._visible || !this._dataReady || !this._material) return;

        this._elapsed += dt;

        // ── Altitude fade ─────────────────────────────────────────────────
        const altY = camera.position.y;
        const cfg  = RF_INTERFERENCE_HEATMAP;
        const fadeMin = cfg.RFI_FADE_ALT_MIN;
        const fadeMax = cfg.RFI_FADE_ALT_MAX;

        let altFade;
        if (altY <= fadeMin) {
            altFade = 1.0;
        } else if (altY >= fadeMax) {
            altFade = 0.0;
        } else {
            // Smooth inverse — intensifies on zoom, fades when far
            const t = (altY - fadeMin) / (fadeMax - fadeMin);
            altFade = 1.0 - t * t; // quadratic ease-out
        }

        // ── Update uniforms (no allocations) ──────────────────────────────
        const uniforms = this._material.uniforms;
        uniforms.uTime.value         = this._elapsed;
        uniforms.uAltitudeFade.value = altFade;
        uniforms.uLerpFactor.value   = this._lerpFactor;
    }

    /**
     * Clean up all GPU resources and event listeners.
     */
    dispose() {
        window.removeEventListener('vg1:layerChanged', this._onLayerChanged);
        window.removeEventListener('vg1:rfi-heatmap:set-month', this._onTemporalScrub);

        if (this._mesh) {
            if (this._mesh.geometry) this._mesh.geometry.dispose();
            this._mesh = null;
        }

        if (this._material) {
            this._material.dispose();
            this._material = null;
        }

        for (let i = 0; i < this._monthlyTextures.length; i++) {
            if (this._monthlyTextures[i]) {
                this._monthlyTextures[i].dispose();
            }
        }
        this._monthlyTextures = [];
        this._monthlyGrids    = [];

        if (this._group && this._scene) {
            this._scene.remove(this._group);
        }
        this._group   = null;
        this._scene   = null;
    }

    // ── Data Fetching ─────────────────────────────────────────────────────────

    /**
     * Fetch SMAP RFI persistence data.
     *
     * Production integration path:
     *   1. Register at https://urs.earthdata.nasa.gov/ (free NASA Earthdata account)
     *   2. Generate bearer token for API access
     *   3. Query NASA CMR API for SMAP L1B RFI granules:
     *      GET https://cmr.earthdata.nasa.gov/search/granules.json
     *        ?collection_concept_id=C2531308461-NSIDC_ECS
     *        &temporal=2024-01-01T00:00:00Z,2024-12-31T23:59:59Z
     *        &page_size=100
     *      Response contains download URLs for HDF5 granules
     *   4. Download HDF5 granule files from NSIDC DAAC (https://nsidc.org/data/spl1btb/versions/3)
     *   5. Extract RFI flag arrays from HDF5 datasets:
     *      /Brightness_Temperature/tb_qual_flag_v (bit 0 = RFI detected)
     *   6. Aggregate into 0.25°×0.25° grid (1440×720) per 4-week window:
     *      RFI persistence (%) = (RFI-flagged-passes / total-passes) × 100
     *   7. Pre-processed RFI maps also available at: https://smap.jpl.nasa.gov/rfi/
     *
     *   For near-real-time complementary data:
     *     Spire RF tasking API (https://documentation.spire.com/)
     *     - Provides targeted RF environment collections
     *     - Formats: IQ samples, JSON metadata, CSV
     *     - Commercial contract required
     *
     * Current implementation: generates realistic synthetic data seeded from
     * documented OSINT RFI hotspot locations until live pipeline is connected.
     *
     * @private
     * @returns {Promise<void>}
     */
    async _fetchData() {
        const cfg   = RF_INTERFERENCE_HEATMAP;
        const W     = cfg.RFI_GRID_WIDTH;
        const H     = cfg.RFI_GRID_HEIGHT;
        const MONTHS = cfg.RFI_TEMPORAL_MONTHS;

        // ── Attempt live data fetch ───────────────────────────────────────
        // Uncomment the following block when NASA Earthdata credentials are configured:
        //
        // const EARTHDATA_TOKEN = window.VG1_EARTHDATA_TOKEN || '';
        // if (EARTHDATA_TOKEN) {
        //     try {
        //         const cmrUrl = `${cfg.CMR_BASE_URL}?collection_concept_id=${cfg.CMR_COLLECTION_ID}` +
        //                        `&temporal=2024-01-01T00:00:00Z,2024-12-31T23:59:59Z` +
        //                        `&page_size=12&sort_key