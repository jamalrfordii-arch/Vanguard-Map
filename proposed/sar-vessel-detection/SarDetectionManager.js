// SarDetectionManager.js — SAR Dark Vessel Detection Fusion
//
// Renders SAR vessel detections from Global Fishing Watch as diamond-shaped
// glyphs with three-state color coding:
//   GREEN  = AIS-matched (known vessel)
//   RED    = unmatched (dark vessel — highest alert)
//   AMBER  = low-confidence match (score < 0.7)
//
// Unmatched detections pulse with an expanding alert ring.
// Fusion view draws dashed lines connecting matched SAR detections to AIS positions.
//
// Data source:
//   Global Fishing Watch API v3
//   https://gateway.api.globalfishingwatch.org/v3/4wings/report
//   Dataset: 'public-global-sar-detections:latest'
//   Returns JSON with lat, lon, timestamp, matched, score, length_m, source
//   Free API token via https://globalfishingwatch.org/our-apis/
//   ~5-day data lag from Sentinel-1 acquisition
//
// Loading behavior:
//   Synthetic demo detections render immediately on toggle so the layer is
//   never empty. Real GFW data replaces them once fetched.

import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT } from './config.js';

// ---------------------------------------------------------------------------
// Config constants
// ---------------------------------------------------------------------------
export const SAR_VESSEL_DETECTION = {
  MAX_INSTANCES:        20000,
  FADE_START_ALT:       2.0,
  FADE_END_ALT:         0.3,
  FETCH_DEBOUNCE_MS:    500,
  REFRESH_INTERVAL_MS:  300000,       // 5 min
  MIN_GLYPH_SCALE:      0.1,
  MAX_GLYPH_SCALE:      0.5,
  MIN_VESSEL_LENGTH:    10,           // metres
  MAX_VESSEL_LENGTH:    400,          // metres
  PULSE_SPEED:          2.5,
  PULSE_RING_MAX:       2.0,
  COLOR_MATCHED:        [0.18, 0.80, 0.35],   // green
  COLOR_UNMATCHED:      [0.95, 0.15, 0.15],   // red
  COLOR_LOW_CONF:       [1.00, 0.75, 0.10],   // amber
  SCORE_LOW_THRESHOLD:  0.7,
  LINE_COLOR:           0x4488ff,
  LINE_DASH_SIZE:       0.15,
  LINE_GAP_SIZE:        0.08,
  API_ENDPOINT:         '/api/sar-detections',
  GFW_DIRECT_ENDPOINT:  'https://gateway.api.globalfishingwatch.org/v3/4wings/report',
  GFW_DATASET:          'public-global-sar-detections:latest',
};

// ---------------------------------------------------------------------------
// Module-scope scratch variables (zero in-loop allocations)
// ---------------------------------------------------------------------------
const _scratchVec3   = new THREE.Vector3();
const _scratchColor  = new THREE.Color();
const _scratchMat4   = new THREE.Matrix4();
const _scratchQuat   = new THREE.Quaternion();
const _scratchScale  = new THREE.Vector3();
const _scratchPos    = new THREE.Vector3();
const _dummyObj      = new THREE.Object3D();

// ---------------------------------------------------------------------------
// Coordinate helpers
// ---------------------------------------------------------------------------

/**
 * Convert longitude/latitude to scene coordinates.
 * @param {number} lon - Longitude in degrees [-180, 180]
 * @param {number} lat - Latitude in degrees [-90, 90]
 * @param {number} [y=0] - Y offset
 * @returns {THREE.Vector3} Position in scene space (written to _scratchVec3)
 */
function lonLatToScene(lon, lat, y = 0) {
  const x = ((lon + 180) / 360) * MAP_WIDTH  - MAP_WIDTH  / 2;
  const z = ((-lat + 90) / 180) * MAP_HEIGHT - MAP_HEIGHT / 2;
  _scratchVec3.set(x, y, z);
  return _scratchVec3;
}

/**
 * Map vessel length in metres to glyph scale factor.
 * @param {number} lengthM - Vessel length in metres
 * @returns {number}
 */
function lengthToScale(lengthM) {
  const t = THREE.MathUtils.clamp(
    (lengthM - SAR_VESSEL_DETECTION.MIN_VESSEL_LENGTH) /
    (SAR_VESSEL_DETECTION.MAX_VESSEL_LENGTH - SAR_VESSEL_DETECTION.MIN_VESSEL_LENGTH),
    0, 1
  );
  return THREE.MathUtils.lerp(SAR_VESSEL_DETECTION.MIN_GLYPH_SCALE, SAR_VESSEL_DETECTION.MAX_GLYPH_SCALE, t);
}

/**
 * Determine color category for a detection.
 * @param {boolean} matched
 * @param {number}  score
 * @returns {number[]} [r, g, b] in 0-1 range
 */
function detectionColor(matched, score) {
  if (!matched) return SAR_VESSEL_DETECTION.COLOR_UNMATCHED;
  if (score < SAR_VESSEL_DETECTION.SCORE_LOW_THRESHOLD) return SAR_VESSEL_DETECTION.COLOR_LOW_CONF;
  return SAR_VESSEL_DETECTION.COLOR_MATCHED;
}

// ---------------------------------------------------------------------------
// Diamond geometry — 4 vertices, 2 triangles forming a rotated square
// ---------------------------------------------------------------------------
function createDiamondGeometry() {
  const geo = new THREE.BufferGeometry();
  //       top (0,0,−1)
  //      / \
  //   (−1,0,0)  (1,0,0)
  //      \ /
  //     bottom (0,0,1)
  const positions = new Float32Array([
     0, 0, -1,   // top
     1, 0,  0,   // right
     0, 0,  1,   // bottom
    -1, 0,  0,   // left
  ]);
  const indices = new Uint16Array([
    0, 1, 2,
    0, 2, 3,
  ]);
  const uvs = new Float32Array([
    0.5, 1.0,
    1.0, 0.5,
    0.5, 0.0,
    0.0, 0.5,
  ]);
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------------
// Custom ShaderMaterial for diamond glyphs
// ---------------------------------------------------------------------------
function createDiamondMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTime:       { value: 0.0 },
      uGlobalFade: { value: 1.0 },
    },
    vertexShader: /* glsl */`
      // Per-instance attributes
      attribute vec3  instanceColorAttr;
      attribute float instancePulsePhase;
      attribute float instanceIsUnmatched;

      varying vec3  vColor;
      varying vec2  vUv;
      varying float vPulsePhase;
      varying float vIsUnmatched;

      void main() {
        vColor        = instanceColorAttr;
        vUv           = uv;
        vPulsePhase   = instancePulsePhase;
        vIsUnmatched  = instanceIsUnmatched;

        vec4 mvPos = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uTime;
      uniform float uGlobalFade;

      varying vec3  vColor;
      varying vec2  vUv;
      varying float vPulsePhase;
      varying float vIsUnmatched;

      void main() {
        // Diamond SDF in UV space: |x - 0.5| + |y - 0.5| <= 0.5
        float dx = abs(vUv.x - 0.5);
        float dy = abs(vUv.y - 0.5);
        float dist = dx + dy; // diamond distance in [0, 1]

        // Discard outside diamond
        if (dist > 0.5) discard;

        // Anti-aliased edge (2px equivalent via fwidth)
        float edgeW = fwidth(dist) * 2.0;
        float edgeAlpha = 1.0 - smoothstep(0.5 - edgeW, 0.5, dist);

        // Outline: brighter at edge
        float outlineMask = smoothstep(0.38, 0.42, dist);
        vec3 col = mix(vColor * 0.85, vColor * 1.3, outlineMask);

        // Pulse ring for unmatched detections
        float pulseAlpha = 0.0;
        if (vIsUnmatched > 0.5) {
          float phase = mod(uTime * 2.5 - vPulsePhase, 6.2832);
          float ring  = sin(phase) * 0.5 + 0.5; // 0→1 oscillation
          float ringDist = abs(dist - mix(0.3, 0.48, ring));
          float ringMask = 1.0 - smoothstep(0.0, 0.06, ringDist);
          pulseAlpha = ringMask * 0.6 * ring;
          col = mix(col, vec3(1.0, 0.3, 0.2), pulseAlpha);
        }

        float alpha = edgeAlpha * uGlobalFade;
        alpha = max(alpha, pulseAlpha * uGlobalFade);

        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
}

// ---------------------------------------------------------------------------
// SarDetectionManager
// ---------------------------------------------------------------------------
export default class SarDetectionManager {
  /**
   * Construct the SAR Detection manager.
   * Does NOT touch the scene — call init(scene) after construction.
   */
  constructor() {
    /** @type {THREE.Scene|null} */
    this._scene = null;
    /** @type {THREE.Group} */
    this._group = new THREE.Group();
    this._group.name = 'SarDetectionManager';
    this._group.visible = false;

    /** @type {THREE.InstancedMesh|null} */
    this._mesh = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._material = null;

    // Per-instance attribute buffers
    /** @type {Float32Array|null} */
    this._colorBuf      = null;
    /** @type {Float32Array|null} */
    this._pulsePhaseBuf = null;
    /** @type {Float32Array|null} */
    this._unmatchedBuf   = null;

    // Fusion dashed lines
    /** @type {THREE.LineSegments|null} */
    this._fusionLines       = null;
    /** @type {THREE.BufferGeometry|null} */
    this._fusionGeo         = null;
    /** @type {THREE.LineDashedMaterial|null} */
    this._fusionMat         = null;
    /** @type {boolean} */
    this._fusionViewEnabled = false;
    /** @type {Float32Array|null} */
    this._fusionPositions   = null;
    /** @type {number} */
    this._fusionPairCount   = 0;

    // Detection data store
    /** @type {Array<Object>} */
    this._detections = [];
    /** @type {number} */
    this._activeCount = 0;

    // Fetch debouncing
    /** @type {number|null} */
    this._fetchTimeout = null;
    /** @type {number} */
    this._lastFetchTime = 0;
    /** @type {AbortController|null} */
    this._fetchController = null;

    // State
    /** @type {boolean} */
    this._enabled = false;
    /** @type {boolean} */
    this._dataLoaded = false;
    /** @type {number} */
    this._elapsedTime = 0;

    // Bound listeners
    this._onLayerChanged    = this._handleLayerChanged.bind(this);
    this._onAisPositionReply = this._handleAisPositionReply.bind(this);
    this._onFusionToggle    = this._handleFusionToggle.bind(this);

    // Pending AIS position queries for fusion lines
    /** @type {Map<string, {sarX: number, sarY: number, sarZ: number}>} */
    this._pendingAisQueries = new Map();

    // AIS reply positions for fusion line rendering
    /** @type {Array<{sarX:number,sarY:number,sarZ:number,aisX:number,aisY:number,aisZ:number}>} */
    this._fusionPairs = [];
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Initialize the manager — build geometry, register layer, attach listeners.
   * @param {THREE.Scene} scene - The main Three.js scene
   */
  init(scene) {
    this._scene = scene;

    // ---- Build diamond InstancedMesh ------------------------------------
    const diamondGeo = createDiamondGeometry();
    this._material   = createDiamondMaterial();

    this._mesh = new THREE.InstancedMesh(
      diamondGeo,
      this._material,
      SAR_VESSEL_DETECTION.MAX_INSTANCES
    );
    this._mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._mesh.count = 0;
    this._mesh.frustumCulled = false;

    // Per-instance color attribute (vec3)
    this._colorBuf = new Float32Array(SAR_VESSEL_DETECTION.MAX_INSTANCES * 3);
    const colorAttr = new THREE.InstancedBufferAttribute(this._colorBuf, 3);
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    this._mesh.geometry.setAttribute('instanceColorAttr', colorAttr);

    // Per-instance pulse phase (float)
    this._pulsePhaseBuf = new Float32Array(SAR_VESSEL_DETECTION.MAX_INSTANCES);
    const pulseAttr = new THREE.InstancedBufferAttribute(this._pulsePhaseBuf, 1);
    pulseAttr.setUsage(THREE.DynamicDrawUsage);
    this._mesh.geometry.setAttribute('instancePulsePhase', pulseAttr);

    // Per-instance unmatched flag (float, 0 or 1)
    this._unmatchedBuf = new Float32Array(SAR_VESSEL_DETECTION.MAX_INSTANCES);
    const unmatchedAttr = new THREE.InstancedBufferAttribute(this._unmatchedBuf, 1);
    unmatchedAttr.setUsage(THREE.DynamicDrawUsage);
    this._mesh.geometry.setAttribute('instanceIsUnmatched', unmatchedAttr);

    this._group.add(this._mesh);

    // ---- Build fusion lines geometry ------------------------------------
    this._fusionMat = new THREE.LineDashedMaterial({
      color:       SAR_VESSEL_DETECTION.LINE_COLOR,
      dashSize:    SAR_VESSEL_DETECTION.LINE_DASH_SIZE,
      gapSize:     SAR_VESSEL_DETECTION.LINE_GAP_SIZE,
      transparent: true,
      opacity:     0.6,
      depthWrite:  false,
    });

    // Pre-allocate position buffer for fusion lines (2 verts per pair)
    const maxFusionPairs = SAR_VESSEL_DETECTION.MAX_INSTANCES;
    this._fusionPositions = new Float32Array(maxFusionPairs * 2 * 3);
    this._fusionGeo = new THREE.BufferGeometry();
    this._fusionGeo.setAttribute('position',
      new THREE.BufferAttribute(this._fusionPositions, 3).setUsage(THREE.DynamicDrawUsage)
    );

    this._fusionLines = new THREE.LineSegments(this._fusionGeo, this._fusionMat);
    this._fusionLines.frustumCulled = false;
    this._fusionLines.visible = false;
    this._fusionLines.computeLineDistances();
    this._group.add(this._fusionLines);

    // ---- Add group to scene ---------------------------------------------
    scene.add(this._group);

    // ---- Register with layer manager ------------------------------------
    if (typeof window.layerManager !== 'undefined' && window.layerManager.register) {
      window.layerManager.register({
        id:        'sar-detection',
        label:     'SAR Dark Vessel Detection',
        category:  'surface',
        defaultOn: false,
      });
    }

    // ---- Attach event listeners -----------------------------------------
    window.addEventListener('vg1:layerChanged', this._onLayerChanged);
    window.addEventListener('vg1:aisPositionReply', this._onAisPositionReply);
    window.addEventListener('vg1:sarFusionToggle', this._onFusionToggle);
  }

  /**
   * Per-frame update — animate pulse rings, fade by altitude, request data.
   * @param {THREE.Camera} camera - Active camera
   * @param {number}       dt     - Delta time in seconds
   */
  update(camera, dt) {
    if (!this._enabled || !this._mesh) return;

    this._elapsedTime += dt;

    // ---- Altitude-based fade --------------------------------------------
    const alt = camera.position.y;
    let fade = 1.0;
    if (alt > SAR_VESSEL_DETECTION.FADE_START_ALT) {
      fade = 0.0;
    } else if (alt > SAR_VESSEL_DETECTION.FADE_END_ALT) {
      fade = 1.0 - (alt - SAR_VESSEL_DETECTION.FADE_END_ALT) /
        (SAR_VESSEL_DETECTION.FADE_START_ALT - SAR_VESSEL_DETECTION.FADE_END_ALT);
    }
    fade = THREE.MathUtils.clamp(fade, 0, 1);

    this._material.uniforms.uTime.value       = this._elapsedTime;
    this._material.uniforms.uGlobalFade.value  = fade;
    this._group.visible = fade > 0.001;

    if (this._fusionMat) {
      this._fusionMat.opacity = 0.6 * fade;
    }

    // ---- Debounced data fetch on camera move -----------------------------
    if (!this._dataLoaded) {
      this._loadSyntheticData();
      this._scheduleFetch();
    }
  }

  /**
   * Dispose of all GPU resources, remove listeners.
   */
  dispose() {
    window.removeEventListener('vg1:layerChanged', this._onLayerChanged);
    window.removeEventListener('vg1:aisPositionReply', this._onAisPositionReply);
    window.removeEventListener('vg1:sarFusionToggle', this._onFusionToggle);

    if (this._fetchController) {
      this._fetchController.abort();
      this._fetchController = null;
    }
    if (this._fetchTimeout) {
      clearTimeout(this._fetchTimeout);
      this._fetchTimeout = null;
    }

    if (this._mesh) {
      this._mesh.geometry.dispose();
      this._mesh.dispose();
      this._mesh = null;
    }
    if (this._material) {
      this._material.dispose();
      this._material = null;
    }
    if (this._fusionGeo) {
      this._fusionGeo.dispose();
      this._fusionGeo = null;
    }
    if (this._fusionMat) {
      this._fusionMat.dispose();
      this._fusionMat = null;
    }
    if (this._fusionLines) {
      this._fusionLines = null;
    }
    if (this._scene && this._group) {
      this._scene.remove(this._group);
    }

    this._detections   = [];
    this._activeCount  = 0;
    this._fusionPairs  = [];
    this._pendingAisQueries.clear();
  }

  // =========================================================================
  // Event handlers
  // =========================================================================

  /**
   * Handle layer toggle events.
   * @param {CustomEvent} e
   * @private
   */
  _handleLayerChanged(e) {
    const { id, enabled } = e.detail || {};
    if (id !== 'sar-detection') return;

    this._enabled = enabled;
    this._group.visible = enabled;

    if (enabled) {
      if (!this._dataLoaded) {
        this._loadSyntheticData();
      }
      this._scheduleFetch();
    }
  }

  /**
   * Handle AIS position reply for fusion lines.
   * @param {CustomEvent} e - detail: { vesselId, x, y, z }
   * @private
   */
  _handleAisPositionReply(e) {
    const { vesselId, x, y, z } = e.detail || {};
    if (!vesselId) return;

    const sarPos = this._pendingAisQueries.get(vesselId);
    if (!sarPos) return;

    this._pendingAisQueries.delete(vesselId);
    this._fusionPairs.push({
      sarX: sarPos.sarX, sarY: sarPos.sarY, sarZ: sarPos.sarZ,
      aisX: x,           aisY: y,           aisZ: z,
    });

    this._rebuildFusionLines();
  }

  /**
   * Handle fusion view toggle.
   * @param {CustomEvent} e - detail: { enabled: boolean }
   * @private
   */
  _handleFusionToggle(e) {
    const { enabled } = e.detail || {};
    this._fusionViewEnabled = !!enabled;

    if (this._fusionLines) {
      this._fusionLines.visible = this._fusionViewEnabled && this._fusionPairs.length > 0;
    }

    if (this._fusionViewEnabled) {
      this._requestFusionPositions();
    }
  }

  // =========================================================================
  // Data fetching
  // =========================================================================

  /**
   * Schedule a debounced data fetch.
   * @private
   */
  _scheduleFetch() {
    if (this._fetchTimeout) clearTimeout(this._fetchTimeout);
    this._fetchTimeout = setTimeout(() => {
      this._fetchData();
    }, SAR_VESSEL_DETECTION.FETCH_DEBOUNCE_MS);
  }

  /**
   * Fetch SAR detection data from the backend proxy (or directly from GFW API).
   *
   * API integration notes:
   * ─────────────────────
   * Primary endpoint (backend proxy — recommended for production):
   *   GET /api/sar-detections?bbox=<west,south,east,north>&timerange=<start,end>
   *   The proxy caches GFW API responses and handles rate limiting (100 req/min).
   *
   * Direct GFW API (for development / reference):
   *   POST https://gateway.api.globalfishingwatch.org/v3/4wings/report
   *   Headers:
   *     Authorization: Bearer <GFW_API_TOKEN>
   *     Content-Type: application/json
   *   Body:
   *     {
   *       "datasets": ["public-global-sar-detections:latest"],
   *       "region": { "type": "Polygon", "coordinates": [[[w,s],[e,s],[e,n],[w,n],[w,s]]] },
   *       "dateRange": { "start": "2024-01-01", "end": "2024-01-31" },
   *       "format": "JSON"
   *     }
   *
   *   Response shape (each entry):
   *     {
   *       "lat": 12.345,
   *       "lon": -45.678,
   *       "timestamp": "2024-01-15T12:00:00Z",
   *       "matched": false,
   *       "score": 0.0,
   *       "length_m": 85,
   *       "source": "S1A"
   *     }
   *
   *   For presence heatmaps use dataset 'public-global-sar-presence:v3.0'.
   *   Vessel search: GET /v3/vessels/search?includes=SAR_DETECTIONS
   *   Python client: pip install gfw (released April 2025)
   *   Data lag: ~5 days from Sentinel-1 acquisition
   *   Free API token: https://globalfishingwatch.org/our-apis/
   *
   * @private
   * @returns {Promise<void>}
   */
  async _fetchData() {
    if (this._fetchController) {
      this._fetchController.abort();
    }
    this._fetchController = new AbortController();

    const now = Date.now();
    if (now - this._lastFetchTime < SAR_VESSEL_DETECTION.FETCH_DEBOUNCE_MS) return;
    this._lastFetchTime = now;

    try {
      // Build query params — in production, the camera frustum would
      // determine the visible bbox. Here we request global for demo.
      const url = `${SAR_VESSEL_DETECTION.API_ENDPOINT}?bbox=-180,-90,180,90&timerange=latest`;

      const response = await fetch(url, {
        signal: this._fetchController.signal,
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        console.warn(`[SarDetectionManager] API responded ${response.status}, keeping synthetic data`);
        return;
      }

      const data = await response.json();

      // Expected shape: { detections: [ { lat, lon, timestamp, matched, score, length_m, source }, ... ] }
      // Also accept flat array
      const detections = Array.isArray(data) ? data : (data.detections || data.entries || []);

      if (detections.length > 0) {
        this._detections = detections;
        this._rebuildInstances();
        this._dataLoaded = true;

        // Dispatch alert events for unmatched detections
        this._dispatchDarkVesselAlerts();

        // If fusion view is active, request AIS positions
        if (this._fusionViewEnabled) {
          this._requestFusionPositions();
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('[SarDetectionManager] Fetch failed, retaining current data:', err.message);
      }
    }
  }

  // =========================================================================
  // Synthetic fallback data
  // =========================================================================

  /**
   * Generate synthetic SAR detections so the layer is never empty on toggle.
   * These represent plausible patterns: dark vessels off West Africa,
   * matched traffic in shipping lanes, low-confidence contacts near EEZ borders.
   * @private
   */
  _loadSyntheticData() {
    if (this._dataLoaded && this._detections.length > 0) return;

    const synth = [];
    const rng = this._seededRandom(42);

    // ---- Dark vessel hotspot: Gulf of Guinea ----
    for (let i = 0; i < 45; i++) {
      synth.push({
        lat:       rng() * 8 - 2,          // -2 to 6
        lon:       rng() * 14 - 5,          // -5 to 9
        timestamp: Date.now() - rng() * 432000000,
        matched:   false,
        score:     0,
        length_m:  30 + rng() * 120,
        source:    rng() > 0.5 ? 'S1A' : 'S1B',
      });
    }

    // ---- South China Sea mixed traffic ----
    for (let i = 0; i < 80; i++) {
      const matched = rng() > 0.35;
      synth.push({
        lat:       rng() * 18 + 2,          // 2 to 20
        lon:       rng() * 20 + 105,        // 105 to 125
        timestamp: Date.now() - rng() * 432000000,
        matched:   matched,
        score:     matched ? 0.3 + rng() * 0.7 : 0,
        length_m:  20 + rng() * 300,
        source:    rng() > 0.5 ? 'S1A' : 'S1B',
      });
    }

    // ---- Mediterranean shipping lane ----
    for (let i = 0; i < 60; i++) {
      const matched = rng() > 0.2;
      synth.push({
        lat:       33 + rng() * 7,
        lon:       -5 + rng() * 40,
        timestamp: Date.now() - rng() * 432000000,
        matched:   matched,
        score:     matched ? 0.5 + rng() * 0.5 : 0,
        length_m:  50 + rng() * 250,
        source:    rng() > 0.5 ? 'S1A' : 'S1B',
      });
    }

    // ---- Dark fleet: Argentina EEZ boundary ----
    for (let i = 0; i < 35; i++) {
      synth.push({
        lat:       -42 + rng() * 8,
        lon:       -60 + rng() * 5,
        timestamp: Date.now() - rng() * 432000000,
        matched:   false,
        score:     0,
        length_m:  40 + rng() * 80,
        source:    rng() > 0.5 ? 'S1A' : 'S1B',
      });
    }

    // ---- Persian Gulf ----
    for (let i = 0; i < 50; i++) {
      const matched = rng() > 0.4;
      synth.push({
        lat:       24 + rng() * 6,
        lon:       48 + rng() * 8,
        timestamp: Date.now() - rng() * 432000000,
        matched:   matched,
        score:     matched ? 0.4 + rng() * 0.6 : 0,
        length_m:  80 + rng() * 280,
        source:    rng() > 0.5 ? 'S1A' : 'S1B',
      });
    }

    // ---- Scattered global ----
    for (let i = 0; i < 80; i++) {
      const matched = rng() > 0.3;
      synth.push({
        lat:       rng() * 140 - 70,
        lon:       rng() * 360 - 180,
        timestamp: Date.now() - rng() * 432000000,
        matched:   matched,
        score:     matched ? rng() : 0,
        length_m:  15 + rng() * 350,
        source:    rng() > 0.5 ? 'S1A' : 'S1B',
      });
    }

    this._detections = synth;
    this._rebuildInstances();
  }

  /**
   * Simple seeded PRNG (mulberry32).
   * @param {number} seed
   * @returns {function(): number} Returns values in [0, 1)
   * @private
   */
  _seededRandom(seed) {
    let s = seed | 0;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // =========================================================================
  // Instance mesh rebuild
  // =========================================================================

  /**
   * Rebuild all instanced mesh data from this._detections.
   * @private
   */
  _rebuildInstances() {
    if (!this._mesh) return;

    const count = Math.min(this._detections.length, SAR_VESSEL_DETECTION.MAX_INSTANCES);
    this._activeCount = count;

    const Y_OFFSET = 0.15; // slightly above map surface

    for (let i = 0; i < count; i++) {
      const det = this._detections[i];

      // Position
      lonLatToScene(det.lon, det.lat, Y_OFFSET);
      const px = _scratchVec3.x;
      const py = _scratchVec3.y;
      const pz = _scratchVec3.z;

      // Scale from vessel length
      const s = lengthToScale(det.length_m || 50);

      // Build instance matrix: translate + uniform scale
      // Diamond is in XZ plane, rotated 45° is the natural orientation
      _dummyObj.position.set(px, py, pz);
      _dummyObj.scale.set(s, s, s);
      _dummyObj.rotation.set(0, 0, 0);
      _dummyObj.updateMatrix();
      this._mesh.setMatrixAt(i, _dummyObj.matrix);

      // Color
      const col = detectionColor(det.matched, det.score || 0);
      this._colorBuf[i * 3 + 0] = col[0];
      this._colorBuf[i * 3 + 1] = col[1];
      this._colorBuf[i * 3 + 2] = col[2];

      // Pulse phase — stagger unmatched so they don't all pulse in sync
      this._pulsePhaseBuf[i] = det.matched ? 0 : (i * 0.37);

      // Unmatched flag
      this._unmatchedBuf[i] = det.matched ? 0.0 : 1.0;
    }

    this._mesh.count = count;
    this._mesh.instanceMatrix.needsUpdate = true;
    this._mesh.geometry.getAttribute('instanceColorAttr').needsUpdate  = true;
    this._mesh.geometry.getAttribute('instancePulsePhase').needsUpdate = true;
    this._mesh.geometry.getAttribute('instanceIsUnmatched').needsUpdate = true;
  }

  // =========================================================================
  // Fusion lines
  // =========================================================================

  /**
   * For each matched detection, request the AIS vessel position via custom event.
   * @private
   */
  _requestFusionPositions() {
    this._fusionPairs = [];
    this._pendingAisQueries.clear();

    const Y_OFFSET = 0.15;

    for (let i = 0; i < this._detections.length; i++) {
      const det = this._detections[i];
      if (!det.matched) continue;
      if (!det.vesselId && !det.vessel_id && !det.mmsi) continue;

      const vesselId = det.vesselId || det.vessel_id || det.mmsi || '';
      if (!vesselId) continue;

      lonLatToScene(det.lon, det.lat, Y_OFFSET);
      const sarPos = {
        sarX: _scratchVec3.x,
        sarY: _scratchVec3.y,
        sarZ: _scratchVec3.z,
      };

      this._pendingAisQueries.set(String(vesselId), sarPos);

      // Dispatch event requesting AIS position
      window.dispatchEvent(new CustomEvent('vg1:sarMatch', {
        detail: {
          sarPos: { x: sarPos.sarX, y: sarPos.sarY, z: sarPos.sarZ },
          aisVesselId: vesselId,
        },
      }));
    }
  }

  /**
   * Rebuild the fusion LineSegments geometry from accumulated pairs.
   * @private
   */
  _rebuildFusionLines() {
    if (!this._fusionGeo || !this._fusionPositions || !this._fusionLines) return;

    const pairCount = Math.min(this._fusionPairs.length, SAR_VESSEL_DETECTION.MAX_INSTANCES);
    this._fusionPairCount = pairCount;

    for (let i = 0; i < pairCount; i++) {
      const p = this._fusionPairs[i];
      const off = i * 6;
      this._fusionPositions[off + 0] = p.sarX;
      this._fusionPositions[off + 1] = p.sarY;
      this._fusionPositions[off + 2] = p.sarZ;
      this._fusionPositions[off + 3] = p.aisX;
      this._fusionPositions[off + 4] = p.aisY;
      this._fusionPositions[off + 5] = p.aisZ;
    }

    this._fusionGeo.setDrawRange(0, pairCount * 2);
    this._fusionGeo.getAttribute('position').needsUpdate = true;
    this._fusionLines.computeLineDistances();
    this._fusionLines.visible = this._fusionViewEnabled && pairCount > 0;
  }

  // =========================================================================
  // Alert dispatch
  // =========================================================================

  /**
   * Dispatch 'vg1:darkVesselAlert' for each unmatched detection,
   * consumed by alertsManager for notification display.
   * @private
   */
  _dispatchDarkVesselAlerts() {
    for (let i = 0; i < this._detections.length; i++) {
      const det = this._detections[i];
      if (det.matched) continue;

      window.dispatchEvent(new CustomEvent('vg1:darkVesselAlert', {
        detail: {
          lat:       det.lat,
          lon:       det.lon,
          timestamp: det.timestamp,
          length_m:  det.length_m,
          source:    det.source,
          score:     det.score || 0,
          index:     i,
        },
      }));
    }
  }
}