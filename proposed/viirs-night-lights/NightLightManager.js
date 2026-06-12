// NightLightManager.js — VIIRS Nighttime Vessel Light Detection
//
// Renders VIIRS Boat Detection (VBD) detections as additive-blended point-light
// sprites on the ocean surface. Detections are gated by the day/night terminator
// so lit fishing fleets only appear in the dark hemisphere. Supports individual
// detection mode (pulsing sprites) and aggregate heatmap mode (30-day density
// rendered to an offscreen RTT for waterManager emissive contribution).
//
// Data: Earth Observation Group VBD nightly CSVs or Global Fishing Watch 4Wings API.
// Backend proxy expected at /api/viirs-vbd/latest returning JSON array of detections.

import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT } from './config.js';

// ── Config constants ────────────────────────────────────────────────────────
export const VIIRS_NIGHT_LIGHTS = {
    MAX_INSTANCES:        10000,
    SPRITE_SIZE:          0.15,
    SPRITE_Y:             0.3,
    POLL_INTERVAL_MS:     60000,
    PULSE_DURATION:       2.0,
    HEATMAP_WIDTH:        2048,
    HEATMAP_HEIGHT:       1024,
    HEATMAP_WINDOW_DAYS:  30,
    FADE_IN_ALT:          2.0,
    FADE_OUT_ALT:         800.0,
    FULL_OPACITY_ALT:     5.0,
    MIN_RADIANCE:         0.5,
    MAX_RADIANCE:         300.0,
    SUN_DOT_THRESHOLD:    0.1,
    DATA_ENDPOINT:        '/api/viirs-vbd/latest',
    // Primary data source (backend fetches from here):
    // https://eogdata.mines.edu/products/vbd/
    // Alternative: Global Fishing Watch 4Wings API
    // https://gateway.api.globalfishingwatch.org/v3/4wings/report
};

// ── Module-scope scratch variables (no in-loop allocations) ─────────────────
const _scratchVec3    = new THREE.Vector3();
const _scratchVec3B   = new THREE.Vector3();
const _scratchMatrix  = new THREE.Matrix4();
const _scratchQuat    = new THREE.Quaternion();
const _scratchScale   = new THREE.Vector3(1, 1, 1);
const _scratchColor   = new THREE.Color();
const _scratchPos     = new THREE.Vector3();
const _sunDir         = new THREE.Vector3(0, 1, 0);
const _instanceNormal = new THREE.Vector3(0, 1, 0);

// ── Vertex shader ───────────────────────────────────────────────────────────
const vertexShader = /* glsl */ `
precision highp float;

attribute float aRadiance;
attribute float aAge;
attribute float aActive;

uniform vec3  uSunDir;
uniform float uSunDotThreshold;
uniform float uTime;
uniform float uOpacity;

varying float vRadiance;
varying float vAlpha;
varying vec2  vUv;

void main() {
    vUv = uv;
    vRadiance = aRadiance;

    // Compute world position of this instance
    vec4 worldPos = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);

    // Compute surface normal (pointing up from globe surface toward instance)
    vec3 surfaceNormal = normalize(worldPos.xyz);

    // Day/night gating: only visible in dark hemisphere
    float sunDot = dot(uSunDir, surfaceNormal);
    float nightMask = 1.0 - smoothstep(-0.05, uSunDotThreshold, sunDot);

    // Pulse on arrival: ramp from bright to steady over PULSE_DURATION
    float ageFactor = clamp(aAge, 0.0, 1.0);
    float pulse = mix(1.8, 1.0, ageFactor);

    // Subtle twinkle
    float twinkle = 0.9 + 0.1 * sin(uTime * 3.0 + worldPos.x * 10.0 + worldPos.z * 7.0);

    vAlpha = nightMask * pulse * twinkle * uOpacity * aActive;

    // Billboard: face camera
    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    mvPosition.xy += position.xy * vec2(
        length(vec3(instanceMatrix[0][0], instanceMatrix[0][1], instanceMatrix[0][2])),
        length(vec3(instanceMatrix[1][0], instanceMatrix[1][1], instanceMatrix[1][2]))
    );

    gl_Position = projectionMatrix * mvPosition;
}
`;

// ── Fragment shader ─────────────────────────────────────────────────────────
const fragmentShader = /* glsl */ `
precision highp float;

varying float vRadiance;
varying float vAlpha;
varying vec2  vUv;

uniform float uMaxRadiance;

void main() {
    // Radial distance from center of quad
    vec2 centered = vUv - 0.5;
    float r = length(centered) * 2.0;

    // Radial gradient falloff
    float glow = exp(-r * r * 8.0);

    // Discard fully transparent fragments
    if (glow * vAlpha < 0.001) discard;

    // Radiance-mapped color ramp: dim blue → cyan → bright white
    float t = clamp(vRadiance / uMaxRadiance, 0.0, 1.0);

    vec3 dimBlue   = vec3(0.1, 0.15, 0.4);
    vec3 midCyan   = vec3(0.2, 0.6, 0.9);
    vec3 brightWht = vec3(1.0, 1.0, 1.0);

    vec3 color;
    if (t < 0.5) {
        color = mix(dimBlue, midCyan, t * 2.0);
    } else {
        color = mix(midCyan, brightWht, (t - 0.5) * 2.0);
    }

    // Boost intensity for brighter detections
    float intensity = mix(0.6, 2.5, t);

    gl_FragColor = vec4(color * intensity * glow, glow * vAlpha);
}
`;

// ── Heatmap vertex shader ───────────────────────────────────────────────────
const heatmapVertexShader = /* glsl */ `
precision highp float;
attribute float aRadiance;
varying float vRad;
void main() {
    vRad = aRadiance;
    gl_Position = vec4(position.xy, 0.0, 1.0);
    gl_PointSize = 8.0;
}
`;

// ── Heatmap fragment shader ─────────────────────────────────────────────────
const heatmapFragmentShader = /* glsl */ `
precision highp float;
varying float vRad;
void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float glow = exp(-r * r * 4.0) * clamp(vRad / 100.0, 0.05, 1.0);
    gl_FragColor = vec4(glow, glow * 0.8, glow * 0.4, glow);
}
`;


/**
 * Convert longitude/latitude to scene XZ coordinates.
 * @param {number} lon - Longitude in degrees (-180 to 180)
 * @param {number} lat - Latitude in degrees (-90 to 90)
 * @param {THREE.Vector3} out - Output vector (reused to avoid allocation)
 * @returns {THREE.Vector3}
 */
function lonLatToScene(lon, lat, out) {
    out.x = ((lon + 180) / 360) * MAP_WIDTH - MAP_WIDTH / 2;
    out.y = VIIRS_NIGHT_LIGHTS.SPRITE_Y;
    out.z = ((90 - lat) / 180) * MAP_HEIGHT - MAP_HEIGHT / 2;
    return out;
}

/**
 * Compute camera altitude fade factor.
 * @param {number} camY - Camera Y position (altitude)
 * @returns {number} Opacity multiplier 0..1
 */
function altitudeFade(camY) {
    const cfg = VIIRS_NIGHT_LIGHTS;
    if (camY < cfg.FADE_IN_ALT) {
        return camY / cfg.FADE_IN_ALT;
    }
    if (camY > cfg.FADE_OUT_ALT) {
        return 0.0;
    }
    if (camY > cfg.FADE_OUT_ALT * 0.7) {
        return 1.0 - ((camY - cfg.FADE_OUT_ALT * 0.7) / (cfg.FADE_OUT_ALT * 0.3));
    }
    return 1.0;
}


/**
 * NightLightManager — VIIRS nighttime vessel light detection layer.
 *
 * Renders up to 10,000 VIIRS Boat Detection (VBD) points as additive-blended
 * billboard sprites gated by the day/night terminator. Supports individual
 * detection mode and aggregate 30-day heatmap mode.
 */
export default class NightLightManager {

    /**
     * Create the manager. Does not touch the scene until init().
     */
    constructor() {
        /** @type {THREE.Scene|null} */
        this._scene = null;

        /** @type {THREE.InstancedMesh|null} */
        this._mesh = null;

        /** @type {THREE.ShaderMaterial|null} */
        this._material = null;

        /** @type {boolean} */
        this._visible = false;

        /** @type {boolean} */
        this._disposed = false;

        /** @type {number} */
        this._clock = 0;

        /** @type {number} */
        this._pollTimer = 0;

        /** @type {Array<Object>} Raw detection records */
        this._detections = [];

        /** @type {number} Active instance count */
        this._activeCount = 0;

        /** @type {Float32Array} Per-instance radiance attribute */
        this._radianceArray = null;

        /** @type {Float32Array} Per-instance age (0=new, 1=settled) */
        this._ageArray = null;

        /** @type {Float32Array} Per-instance active flag */
        this._activeArray = null;

        /** @type {Float32Array} Arrival timestamps for pulse calculation */
        this._arrivalTimes = null;

        // ── Heatmap RTT ──
        /** @type {THREE.WebGLRenderTarget|null} */
        this._heatmapRT = null;

        /** @type {THREE.Scene|null} */
        this._heatmapScene = null;

        /** @type {THREE.OrthographicCamera|null} */
        this._heatmapCamera = null;

        /** @type {THREE.Points|null} */
        this._heatmapPoints = null;

        /** @type {boolean} */
        this._heatmapDirty = false;

        /** @type {boolean} */
        this._heatmapMode = false;

        /** @type {THREE.WebGLRenderer|null} */
        this._renderer = null;

        // ── Event binding ──
        this._onLayerChanged = this._onLayerChanged.bind(this);
        this._onSunUpdate = this._onSunUpdate.bind(this);
        this._onHeatmapToggle = this._onHeatmapToggle.bind(this);
    }

    /**
     * Initialize the manager: build geometry, material, instanced mesh,
     * register with layerManager, bind events, and kick off first data fetch.
     * @param {THREE.Scene} scene - The main scene
     * @param {THREE.WebGLRenderer} [renderer] - Renderer for heatmap RTT
     */
    init(scene, renderer) {
        this._scene = scene;
        this._renderer = renderer || null;

        const cfg = VIIRS_NIGHT_LIGHTS;

        // ── Geometry: simple quad billboard ──────────────────────────────────
        const geo = new THREE.PlaneGeometry(cfg.SPRITE_SIZE, cfg.SPRITE_SIZE);

        // ── ShaderMaterial with additive blending ───────────────────────────
        this._material = new THREE.ShaderMaterial({
            vertexShader,
            fragmentShader,
            uniforms: {
                uSunDir:           { value: new THREE.Vector3(0, 1, 0) },
                uSunDotThreshold:  { value: cfg.SUN_DOT_THRESHOLD },
                uTime:             { value: 0 },
                uOpacity:          { value: 1.0 },
                uMaxRadiance:      { value: cfg.MAX_RADIANCE },
            },
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
        });

        // ── InstancedMesh ───────────────────────────────────────────────────
        this._mesh = new THREE.InstancedMesh(geo, this._material, cfg.MAX_INSTANCES);
        this._mesh.frustumCulled = false;
        this._mesh.visible = false;
        this._mesh.renderOrder = 900;

        // Initialize all instance matrices to zero scale (invisible)
        _scratchScale.set(0, 0, 0);
        _scratchQuat.identity();
        _scratchPos.set(0, 0, 0);
        _scratchMatrix.compose(_scratchPos, _scratchQuat, _scratchScale);
        for (let i = 0; i < cfg.MAX_INSTANCES; i++) {
            this._mesh.setMatrixAt(i, _scratchMatrix);
        }
        this._mesh.instanceMatrix.needsUpdate = true;
        this._mesh.count = 0;

        // ── Per-instance attributes ─────────────────────────────────────────
        this._radianceArray = new Float32Array(cfg.MAX_INSTANCES);
        this._ageArray      = new Float32Array(cfg.MAX_INSTANCES);
        this._activeArray   = new Float32Array(cfg.MAX_INSTANCES);
        this._arrivalTimes  = new Float32Array(cfg.MAX_INSTANCES);

        const radianceAttr = new THREE.InstancedBufferAttribute(this._radianceArray, 1);
        const ageAttr      = new THREE.InstancedBufferAttribute(this._ageArray, 1);
        const activeAttr   = new THREE.InstancedBufferAttribute(this._activeArray, 1);

        radianceAttr.setUsage(THREE.DynamicDrawUsage);
        ageAttr.setUsage(THREE.DynamicDrawUsage);
        activeAttr.setUsage(THREE.DynamicDrawUsage);

        this._mesh.geometry.setAttribute('aRadiance', radianceAttr);
        this._mesh.geometry.setAttribute('aAge', ageAttr);
        this._mesh.geometry.setAttribute('aActive', activeAttr);

        scene.add(this._mesh);

        // ── Heatmap RTT setup ───────────────────────────────────────────────
        this._initHeatmap();

        // ── Register with layer system ──────────────────────────────────────
        if (typeof window !== 'undefined' && window.layerManager) {
            window.layerManager.register({
                id: 'viirs-night-lights',
                label: 'VIIRS Vessel Lights',
                category: 'surface',
                defaultOn: false,
            });
        }

        // ── Event listeners ─────────────────────────────────────────────────
        window.addEventListener('vg1:layerChanged', this._onLayerChanged);
        window.addEventListener('vg1:sunDirection', this._onSunUpdate);
        window.addEventListener('vg1:viirsHeatmapToggle', this._onHeatmapToggle);

        // ── Generate fallback/synthetic data so layer is visible immediately ─
        this._generateSyntheticData();
        this._applyDetections();

        // ── Start live data fetch ───────────────────────────────────────────
        this._fetchData();
    }

    /**
     * Initialize offscreen heatmap render target and scene.
     * @private
     */
    _initHeatmap() {
        const cfg = VIIRS_NIGHT_LIGHTS;

        this._heatmapRT = new THREE.WebGLRenderTarget(cfg.HEATMAP_WIDTH, cfg.HEATMAP_HEIGHT, {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat,
            type: THREE.HalfFloatType,
        });

        this._heatmapScene = new THREE.Scene();
        this._heatmapCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

        // Points geometry for heatmap (filled on data update)
        const heatGeo = new THREE.BufferGeometry();
        heatGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(cfg.MAX_INSTANCES * 3), 3));
        heatGeo.setAttribute('aRadiance', new THREE.Float32BufferAttribute(new Float32Array(cfg.MAX_INSTANCES), 1));

        const heatMat = new THREE.ShaderMaterial({
            vertexShader: heatmapVertexShader,
            fragmentShader: heatmapFragmentShader,
            transparent: true,
            depthWrite: false,
            depthTest: false,
            blending: THREE.AdditiveBlending,
        });

        this._heatmapPoints = new THREE.Points(heatGeo, heatMat);
        this._heatmapScene.add(this._heatmapPoints);
    }

    /**
     * Generate synthetic detection data so the layer shows something
     * immediately on toggle. Mimics known fishing fleet concentrations.
     * @private
     */
    _generateSyntheticData() {
        const syntheticHotspots = [
            // East China Sea / Yellow Sea fishing fleet
            { lonC: 124, latC: 30, spread: 6, count: 800, radMin: 2, radMax: 80 },
            // South China Sea
            { lonC: 112, latC: 14, spread: 8, count: 600, radMin: 1, radMax: 60 },
            // Southeast Asia (Gulf of Thailand, Strait of Malacca)
            { lonC: 102, latC: 8, spread: 5, count: 400, radMin: 1, radMax: 40 },
            // Sea of Japan / East Sea
            { lonC: 133, latC: 38, spread: 4, count: 350, radMin: 2, radMax: 70 },
            // Argentine shelf (squid fleet)
            { lonC: -58, latC: -44, spread: 4, count: 500, radMin: 5, radMax: 150 },
            // West Africa (Mauritania/Senegal)
            { lonC: -17, latC: 18, spread: 3, count: 300, radMin: 2, radMax: 50 },
            // Bay of Bengal
            { lonC: 87, latC: 16, spread: 4, count: 250, radMin: 1, radMax: 35 },
            // North Sea
            { lonC: 3, latC: 56, spread: 3, count: 200, radMin: 1, radMax: 30 },
            // Persian Gulf
            { lonC: 52, latC: 26, spread: 2, count: 200, radMin: 1, radMax: 25 },
            // Sea of Okhotsk
            { lonC: 148, latC: 52, spread: 5, count: 300, radMin: 2, radMax: 60 },
            // Peru/Chile squid fleet
            { lonC: -80, latC: -14, spread: 3, count: 350, radMin: 3, radMax: 100 },
            // Indian Ocean (Maldives/Sri Lanka)
            { lonC: 76, latC: 7, spread: 3, count: 200, radMin: 1, radMax: 30 },
            // Mediterranean
            { lonC: 18, latC: 38, spread: 5, count: 200, radMin: 1, radMax: 25 },
            // Gulf of Guinea
            { lonC: 2, latC: 4, spread: 3, count: 200, radMin: 1, radMax: 30 },
            // Northwest Pacific (Japanese squid)
            { lonC: 150, latC: 42, spread: 5, count: 400, radMin: 5, radMax: 120 },
        ];

        const detections = [];
        const now = Date.now();

        for (const hs of syntheticHotspots) {
            for (let i = 0; i < hs.count; i++) {
                // Gaussian-ish distribution around center
                const angle = Math.random() * Math.PI * 2;
                const dist = (Math.random() + Math.random() + Math.random()) / 3 * hs.spread;
                const lon = hs.lonC + Math.cos(angle) * dist;
                const lat = hs.latC + Math.sin(angle) * dist * 0.7; // compress latitude slightly

                // Clamp to valid ranges
                const clampedLon = Math.max(-180, Math.min(180, lon));
                const clampedLat = Math.max(-85, Math.min(85, lat));

                const radiance = hs.radMin + Math.random() * (hs.radMax - hs.radMin);

                detections.push({
                    lon: clampedLon,
                    lat: clampedLat,
                    radiance: radiance,
                    timestamp: now - Math.random() * 86400000, // random within last 24h
                    qf: 1,
                    synthetic: true,
                });
            }
        }

        this._detections = detections;
    }

    /**
     * Apply current detections array to instanced mesh attributes.
     * @private
     */
    _applyDetections() {
        const cfg = VIIRS_NIGHT_LIGHTS;
        const count = Math.min(this._detections.length, cfg.MAX_INSTANCES);
        const now = this._clock;

        _scratchScale.set(1, 1, 1);
        _scratchQuat.identity();

        for (let i = 0; i < count; i++) {
            const det = this._detections[i];

            // Convert lon/lat to scene position
            lonLatToScene(det.lon, det.lat, _scratchPos);

            // Scale by radiance — larger sprites for brighter detections
            const radNorm = Math.min(det.radiance / cfg.MAX_RADIANCE, 1.0);
            const s = 0.6 + radNorm * 1.8;
            _scratchScale.set(s, s, s);

            _scratchMatrix.compose(_scratchPos, _scratchQuat, _scratchScale);
            this._mesh.setMatrixAt(i, _scratchMatrix);

            this._radianceArray[i] = det.radiance;
            this._activeArray[i] = 1.0;
            this._arrivalTimes[i] = det._arrivalTime !== undefined ? det._arrivalTime : now;
            this._ageArray[i] = 1.0; // Start fully settled for synthetic data
        }

        // Zero out remaining instances
        _scratchScale.set(0, 0, 0);
        _scratchMatrix.compose(_scratchPos, _scratchQuat, _scratchScale);
        for (let i = count; i < cfg.MAX_INSTANCES; i++) {
            this._mesh.setMatrixAt(i, _scratchMatrix);
            this._radianceArray[i] = 0;
            this._ageArray[i] = 1.0;
            this._activeArray[i] = 0.0;
        }

        this._activeCount = count;
        this._mesh.count = count;
        this._mesh.instanceMatrix.needsUpdate = true;

        this._mesh.geometry.getAttribute('aRadiance').needsUpdate = true;
        this._mesh.geometry.getAttribute('aAge').needsUpdate = true;
        this._mesh.geometry.getAttribute('aActive').needsUpdate = true;

        this._heatmapDirty = true;
    }

    /**
     * Fetch live VIIRS VBD data from backend proxy.
     *
     * Backend is expected to:
     * 1. Nightly cron: download VBD CSV from EOG:
     *    https://eogdata.mines.edu/products/vbd/
     *    Files are organized by date, e.g.:
     *    https://eogdata.mines.edu/products/vbd/v30/nightly/VBD_npp_d{YYYYMMDD}_noaa_ops_v30.csv.gz
     *
     *    CSV columns: id_Key, Lat_DNB, Lon_DNB, Date_Mscan, RadHI, RadSI,
     *                 Temp_BB, QF_Detect, ... etc.
     *    Filter: QF_Detect == 1 (high-confidence boat detection)
     *    Extract: lat=Lat_DNB, lon=Lon_DNB, radiance=RadHI (nanowatts/cm²/sr)
     *
     * 2. Alternative source — Global Fishing Watch 4Wings API:
     *    POST https://gateway.api.globalfishingwatch.org/v3/4wings/report
     *    Headers: Authorization: Bearer <GFW_API_TOKEN>
     *    Body: {
     *      "datasets": ["public-global-all-vessels:v3.0"],
     *      "filters": ["source = 'VIIRS'"],
     *      "dateRange": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
     *      "spatialResolution": "low",
     *      "temporalResolution": "daily",
     *      "groupBy": ["lat", "lon"]
     *    }
     *
     * 3. Serve parsed JSON at GET /api/viirs-vbd/latest:
     *    [{ lon, lat, radiance, timestamp, qf }, ...]
     *
     * @private
     * @returns {Promise<void>}
     */
    async _fetchData() {
        const cfg = VIIRS_NIGHT_LIGHTS;

        try {
            const response = await fetch(cfg.DATA_ENDPOINT, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                signal: AbortSignal.timeout(15000),
            });

            if (!response.ok) {
                console.warn(`[NightLightManager] Data fetch failed: ${response.status}. Keeping synthetic data.`);
                return;
            }

            const data = await response.json();

            if (!Array.isArray(data) || data.length === 0) {
                console.warn('[NightLightManager] Empty response from VBD endpoint. Keeping synthetic data.');
                return;
            }

            // Parse and validate detections
            const now = this._clock;
            const parsed = [];

            for (let i = 0; i < data.length && parsed.length < cfg.MAX_INSTANCES; i++) {
                const d = data[i];
                const lon = parseFloat(d.lon);
                const lat = parseFloat(d.lat);
                const radiance = parseFloat(d.radiance);

                // Validate
                if (isNaN(lon) || isNaN(lat) || isNaN(radiance)) continue;
                if (lon < -180 || lon > 180 || lat < -90 || lat > 90) continue;
                if (radiance < cfg.MIN_RADIANCE) continue;

                // Quality flag: accept only high-confidence detections if available
                const qf = d.qf !== undefined ? parseInt(d.qf, 10) : 1;
                if (qf !== 1 && qf !== 2) continue; // QF 1 = boat, 2 = possible boat

                parsed.push({
                    lon: lon,
                    lat: lat,
                    radiance: Math.min(radiance, cfg.MAX_RADIANCE),
                    timestamp: d.timestamp ? new Date(d.timestamp).getTime() : Date.now(),
                    qf: qf,
                    synthetic: false,
                    _arrivalTime: now, // mark as new for pulse animation
                });
            }

            if (parsed.length > 0) {
                console.log(`[NightLightManager] Loaded ${parsed.length} live VIIRS detections.`);
                this._detections = parsed;
                this._applyDetections();

                // Mark new detections for pulse animation
                for (let i = 0; i < this._activeCount; i++) {
                    this._ageArray[i] = 0.0; // Will ramp to 1.0 over PULSE_DURATION
                    this._arrivalTimes[i] = now;
                }
                this._mesh.geometry.getAttribute('aAge').needsUpdate = true;
            }
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.warn('[NightLightManager] Fetch error:', err.message, '— keeping current data.');
            }
        }
    }

    /**
     * Handle layer toggle events.
     * @private
     * @param {CustomEvent} e
     */
    _onLayerChanged(e) {
        if (!e.detail || e.detail.id !== 'viirs-night-lights') return;
        this._visible = !!e.detail.enabled;
        if (this._mesh) {
            this._mesh.visible = this._visible;
        }
    }

    /**
     * Receive sun direction updates from dayNightManager.
     * @private
     * @param {CustomEvent} e - expects e.detail = { x, y, z }
     */
    _onSunUpdate(e) {
        if (!e.detail) return;
        _sunDir.set(
            e.detail.x || 0,
            e.detail.y || 1,
            e.detail.z || 0
        ).normalize();

        if (this._material) {
            this._material.uniforms.uSunDir.value.copy(_sunDir);
        }
    }

    /**
     * Toggle heatmap aggregate mode.
     * @private
     * @param {CustomEvent} e - expects e.detail = { enabled: boolean }
     */
    _onHeatmapToggle(e) {
        if (!e.detail) return;
        this._heatmapMode = !!e.detail.enabled;
        if (this._heatmapMode) {
            this._renderHeatmap();
        }
    }

    /**
     * Render detection density to offscreen heatmap RTT.
     * The resulting texture can be read by waterManager as emissive contribution:
     *   window.dispatchEvent(new CustomEvent('vg1:viirsHeatmap', { detail: { texture: rt.texture } }))
     * @private
     */
    _renderHeatmap() {
        if (!this._renderer || !this._heatmapRT || !this._heatmapPoints) return;

        const posAttr = this._heatmapPoints.geometry.getAttribute('position');
        const radAttr = this._heatmapPoints.geometry.getAttribute('aRadiance');
        const posArr = posAttr.array;
        const radArr = radAttr.array;

        const count = this._activeCount;

        for (let i = 0; i < count; i++) {
            const det = this._detections[i];
            if (!det) break;

            // Map lon/lat to NDC (-1..1) for equirectangular projection
            posArr[i * 3]     = (det.lon + 180) / 360 * 2 - 1;
            posArr[i * 3 + 1] = (det.lat + 90) / 180 * 2 - 1;
            posArr[i * 3 + 2] = 0;

            radArr[i] = det.radiance;
        }

        this._heatmapPoints.geometry.setDrawRange(0, count);
        posAttr.needsUpdate = true;
        radAttr.needsUpdate = true;

        // Render to RTT
        const oldTarget = this._renderer.getRenderTarget();
        this._renderer.setRenderTarget(this._heatmapRT);
        this._renderer.setClearColor(0x000000, 0);
        this._renderer.clear();
        this._renderer.render(this._heatmapScene, this._heatmapCamera);
        this._renderer.setRenderTarget(oldTarget);

        // Broadcast heatmap texture to waterManager
        window.dispatchEvent(new CustomEvent('vg1:viirsHeatmap', {
            detail: { texture: this._heatmapRT.texture }
        }));

        this._heatmapDirty = false;
    }

    /**
     * Per-frame update. Animates pulse ages, handles data polling, adjusts
     * opacity based on camera altitude.
     * @param {THREE.Camera} camera - Active camera
     * @param {number} dt - Delta time in seconds
     */
    update(camera, dt) {
        if (this._disposed || !this._mesh) return;

        this._clock += dt;
        this._pollTimer += dt;

        // ── Data polling ────────────────────────────────────────────────────
        const cfg = VIIRS_NIGHT_LIGHTS;
        if (this._pollTimer * 1000 >= cfg.POLL_INTERVAL_MS) {
            this._pollTimer = 0;
            this._fetchData();
        }

        if (!this._visible) return;

        // ── Camera altitude fade ────────────────────────────────────────────
        const camAlt = camera.position ? camera.position.y : 100;
        const fade = altitudeFade(camAlt);

        this._material.uniforms.uOpacity.value = fade;
        this._material.uniforms.uTime.value = this._clock;

        if (fade < 0.001) return;

        // ── Update per-instance age for pulse animation ─────────────────────
        let ageChanged = false;
        const pulseDur = cfg.PULSE_DURATION;

        for (let i = 0; i < this._activeCount; i++) {
            if (this._ageArray[i] < 1.0) {
                const elapsed = this._clock - this._arrivalTimes[i];
                const newAge = Math.min(elapsed / pulseDur, 1.0);
                if (newAge !== this._ageArray[i]) {
                    this._ageArray[i] = newAge;
                    ageChanged = true;
                }
            }
        }

        if (ageChanged) {
            this._mesh.geometry.getAttribute('aAge').needsUpdate = true;
        }

        // ── Render heatmap if dirty and in heatmap mode ─────────────────────
        if (this._heatmapMode && this._heatmapDirty) {
            this._renderHeatmap();
        }
    }

    /**
     * Get the heatmap render target texture. Useful for other managers
     * (e.g. waterManager) to sample as emissive contribution.
     * @returns {THREE.Texture|null}
     */
    getHeatmapTexture() {
        return this._heatmapRT ? this._heatmapRT.texture : null;
    }

    /**
     * Get current active detection count.
     * @returns {number}
     */
    getActiveCount() {
        return this._activeCount;
    }

    /**
     * Check if data is synthetic (fallback) or live.
     * @returns {boolean} True if all detections are synthetic
     */
    isSyntheticData() {
        return this._detections.length > 0 && this._detections[0].synthetic === true;
    }

    /**
     * Dispose all GPU resources, remove event listeners, clean up.
     */
    dispose() {
        this._disposed = true;
        this._visible = false;

        window.removeEventListener('vg1:layerChanged', this._onLayerChanged);
        window.removeEventListener('vg1:sunDirection', this._onSunUpdate);
        window.removeEventListener('vg1:viirsHeatmapToggle', this._onHeatmapToggle);

        if (this._mesh) {
            if (this._scene) {
                this._scene.remove(this._mesh);
            }
            this._mesh.geometry.dispose();
            this._mesh.dispose();
            this._mesh = null;
        }

        if (this._material) {
            this._material.dispose();
            this._material = null;
        }

        if (this._heatmapRT) {
            this._heatmapRT.dispose();
            this._heatmapRT = null;
        }

        if (this._heatmapPoints) {
            this._heatmapPoints.geometry.dispose();
            this._heatmapPoints.material.dispose();
            this._heatmapPoints = null;
        }

        this._heatmapScene = null;
        this._heatmapCamera = null;

        this._detections = [];
        this._radianceArray = null;
        this._ageArray = null;
        this._activeArray = null;
        this._arrivalTimes = null;
        this._scene = null;
        this._renderer = null;
    }
}