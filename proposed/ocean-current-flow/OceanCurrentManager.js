// oceanCurrentManager.js — Ocean Current Flow Field visualization
//
// GPGPU ping-pong particle advection with velocity DataTextures from NASA OSCAR.
// Tens of thousands of luminous particles trace real surface currents in 3D.
//
// Data sources:
//   • NASA OSCAR 0.25° via PO.DAAC Harmony API (primary, 5-day update)
//   • NOAA Global RTOFS GRIB2 (fallback, daily 72h forecast)
//   • Copernicus Marine CMEMS SST (supplementary, particle coloring)

import * as THREE from 'three';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  OCEAN_CURRENT_FLOW
} from './config.js';

// ── Config constants (expected in config.js) ──────────────────────────────────
// export const OCEAN_CURRENT_FLOW = {
//   PARTICLE_COUNT:      65536,
//   SPEED_SCALE:         0.0003,
//   PARTICLE_LIFETIME:   200,
//   FADE_OPACITY:        0.92,
//   TEXTURE_SIZE:        256,
//   VELOCITY_TEX_W:      1440,
//   VELOCITY_TEX_H:      720,
//   MIN_CAMERA_ALT:      50,
//   MAX_CAMERA_ALT:      8000,
//   FADE_IN_ALT:         100,
//   FADE_OUT_ALT:        6000,
//   FETCH_INTERVAL_MS:   5 * 24 * 60 * 60 * 1000,
//   Y_OFFSET:            0.05,
//   TRAIL_DECAY:         0.92,
//   SPAWN_JITTER:        0.001,
// };

const CFG = OCEAN_CURRENT_FLOW || {
  PARTICLE_COUNT:    65536,
  SPEED_SCALE:       0.0003,
  PARTICLE_LIFETIME: 200,
  FADE_OPACITY:      0.92,
  TEXTURE_SIZE:      256,
  VELOCITY_TEX_W:    1440,
  VELOCITY_TEX_H:    720,
  MIN_CAMERA_ALT:    50,
  MAX_CAMERA_ALT:    8000,
  FADE_IN_ALT:       100,
  FADE_OUT_ALT:      6000,
  FETCH_INTERVAL_MS: 5 * 24 * 60 * 60 * 1000,
  Y_OFFSET:          0.05,
  TRAIL_DECAY:       0.92,
  SPAWN_JITTER:      0.001,
};

// ── Module-scope scratch variables (no allocations in update loop) ─────────────
const _scratchVec3A = new THREE.Vector3();
const _scratchVec3B = new THREE.Vector3();
const _scratchColor = new THREE.Color();

// ── Coordinate helpers ────────────────────────────────────────────────────────
function lonLatToScene(lon, lat) {
  const x = (lon / 180.0) * (MAP_WIDTH / 2.0);
  const latR = lat * (Math.PI / 180.0);
  const mercY = Math.log(Math.tan(Math.PI / 4.0 + latR / 2.0));
  const z = -(mercY / Math.PI) * (MAP_HEIGHT / 2.0);
  return _scratchVec3A.set(x, CFG.Y_OFFSET, z);
}

function sceneToLonLat(x, z) {
  const lon = (x / (MAP_WIDTH / 2.0)) * 180.0;
  const mercY = -(z / (MAP_HEIGHT / 2.0)) * Math.PI;
  const lat = (2.0 * Math.atan(Math.exp(mercY)) - Math.PI / 2.0) * (180.0 / Math.PI);
  return { lon, lat };
}

// ── Simple deterministic PRNG for reproducible particle placement ─────────────
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ── GLSL Shaders ──────────────────────────────────────────────────────────────

// Advection compute shader — runs as a full-screen quad writing to FBO
const ADVECT_VERTEX = /* glsl */ `
precision highp float;
attribute vec2 position;
varying vec2 vUv;
void main() {
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const ADVECT_FRAGMENT = /* glsl */ `
precision highp float;

uniform sampler2D uPositions;      // current particle positions (RG = lon/lat normalized, B = age, A = speed)
uniform sampler2D uVelocity;       // OSCAR u/v velocity field
uniform sampler2D uBlueNoise;      // random seed for respawn
uniform float     uDt;
uniform float     uSpeedScale;
uniform float     uMaxAge;
uniform float     uTime;
uniform vec2      uVelTexSize;     // velocity texture dimensions

varying vec2 vUv;

// Hash for additional randomness
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec4 particle = texture2D(uPositions, vUv);

  // particle.r = normalized longitude [0..1] mapping to [-180..180]
  // particle.g = normalized latitude  [0..1] mapping to [-90..90]
  // particle.b = age (frame count)
  // particle.a = accumulated speed (for brightness)

  float lon01 = particle.r;
  float lat01 = particle.g;
  float age   = particle.b;
  float speed = particle.a;

  // Check if particle needs respawn
  bool respawn = age >= uMaxAge || lon01 < 0.0 || lon01 > 1.0 || lat01 < 0.05 || lat01 > 0.95;

  if (respawn) {
    // Blue-noise seeded respawn position
    vec4 noise = texture2D(uBlueNoise, vUv + vec2(uTime * 0.001, uTime * 0.0007));
    float rLon = fract(noise.r + hash(vUv + uTime));
    float rLat = fract(noise.g + hash(vUv.yx + uTime * 1.3));

    // Bias towards ocean regions (roughly 70% of earth surface is ocean)
    // Simple rejection: start anywhere, the velocity texture will have zero on land
    lon01 = rLon;
    lat01 = 0.05 + rLat * 0.9; // avoid extreme poles

    age   = hash(vUv + vec2(uTime)) * uMaxAge * 0.5; // stagger ages
    speed = 0.0;
  }

  // Sample velocity field at particle's lon/lat position
  vec2 velUv = vec2(lon01, lat01);
  vec4 vel   = texture2D(uVelocity, velUv);

  float u = vel.r; // eastward velocity (m/s, scaled)
  float v = vel.g; // northward velocity (m/s, scaled)

  // Convert velocity from m/s to normalized lon/lat displacement per frame
  // 1 degree longitude ≈ 111320 * cos(lat) meters
  // 1 degree latitude  ≈ 110540 meters
  float latDeg = (lat01 - 0.5) * 180.0;
  float latRad = latDeg * 3.14159265 / 180.0;
  float cosLat = max(cos(latRad), 0.01);

  float dLon = (u * uSpeedScale * uDt) / (111320.0 * cosLat) / 360.0;
  float dLat = (v * uSpeedScale * uDt) / 110540.0 / 180.0;

  lon01 += dLon;
  lat01 += dLat;
  age   += 1.0;
  speed  = length(vec2(u, v));

  gl_FragColor = vec4(lon01, lat01, age, speed);
}
`;

// Particle render vertex shader — reads positions from FBO texture
const RENDER_VERTEX = /* glsl */ `
precision highp float;

uniform sampler2D uPositions;
uniform sampler2D uPrevPositions;
uniform sampler2D uSSTTexture;
uniform float     uMaxAge;
uniform float     uGlobalOpacity;
uniform float     uMapWidth;
uniform float     uMapHeight;
uniform float     uYOffset;
uniform float     uPointSize;
uniform bool      uHasSST;

attribute float   aIndex;

varying float     vAlpha;
varying vec3      vColor;
varying float     vSpeed;

// Mercator projection
vec3 lonLatToScene(float lon, float lat) {
  float x = (lon / 180.0) * (uMapWidth / 2.0);
  float latR = lat * 3.14159265 / 180.0;
  float mercY = log(tan(3.14159265 / 4.0 + latR / 2.0));
  float z = -(mercY / 3.14159265) * (uMapHeight / 2.0);
  return vec3(x, uYOffset, z);
}

void main() {
  // Compute texel UV from vertex index
  float texSize = ${CFG.TEXTURE_SIZE}.0;
  float row = floor(aIndex / texSize);
  float col = mod(aIndex, texSize);
  vec2 uv = (vec2(col, row) + 0.5) / texSize;

  vec4 particle = texture2D(uPositions, uv);

  float lon01 = particle.r;
  float lat01 = particle.g;
  float age   = particle.b;
  float speed = particle.a;

  // Convert normalized [0,1] to degrees
  float lon = (lon01 - 0.5) * 360.0;
  float lat = (lat01 - 0.5) * 180.0;

  vec3 pos = lonLatToScene(lon, lat);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);

  // Size based on speed
  float speedNorm = clamp(speed / 2.0, 0.0, 1.0); // max ~2 m/s for boundary currents
  gl_PointSize = mix(1.5, uPointSize, speedNorm);

  // Age-based fade: ramp in over first 10 frames, fade out over last 30
  float ageNorm = age / uMaxAge;
  float fadeIn  = smoothstep(0.0, 0.05, ageNorm);
  float fadeOut = 1.0 - smoothstep(0.85, 1.0, ageNorm);
  vAlpha = fadeIn * fadeOut * uGlobalOpacity * mix(0.3, 1.0, speedNorm);

  // Color: default speed-based thermal ramp, or SST-based if available
  if (uHasSST) {
    vec4 sst = texture2D(uSSTTexture, vec2(lon01, lat01));
    float temp = sst.r; // normalized SST [0..1]
    // Thermal ramp: cold blue → warm cyan → hot amber/red
    vColor = mix(
      mix(vec3(0.1, 0.2, 0.8), vec3(0.0, 0.9, 0.9), temp),
      mix(vec3(0.0, 0.9, 0.9), vec3(1.0, 0.6, 0.1), temp),
      step(0.5, temp)
    );
  } else {
    // Speed-based coloring: slow = dim blue, medium = cyan, fast = bright cyan-white
    vec3 slowColor = vec3(0.1, 0.3, 0.6);
    vec3 midColor  = vec3(0.0, 0.8, 0.9);
    vec3 fastColor = vec3(0.7, 0.95, 1.0);
    vColor = mix(slowColor, mix(midColor, fastColor, speedNorm), speedNorm);
  }

  vSpeed = speedNorm;
}
`;

const RENDER_FRAGMENT = /* glsl */ `
precision highp float;

varying float vAlpha;
varying vec3  vColor;
varying float vSpeed;

void main() {
  // Soft billboard circle
  vec2 cxy = 2.0 * gl_PointCoord - 1.0;
  float r = dot(cxy, cxy);
  if (r > 1.0) discard;

  float softEdge = 1.0 - smoothstep(0.3, 1.0, r);

  // Glow effect for fast particles
  float glow = mix(0.5, 1.0, vSpeed) * softEdge;

  gl_FragColor = vec4(vColor * glow, vAlpha * softEdge);
}
`;

// Trail line vertex shader
const TRAIL_VERTEX = /* glsl */ `
precision highp float;

uniform sampler2D uPositions;
uniform sampler2D uPrevPositions;
uniform float     uMaxAge;
uniform float     uGlobalOpacity;
uniform float     uMapWidth;
uniform float     uMapHeight;
uniform float     uYOffset;

attribute float aIndex;
attribute float aEnd; // 0.0 = current position, 1.0 = previous position

varying float vAlpha;
varying vec3  vColor;

vec3 lonLatToScene(float lon, float lat) {
  float x = (lon / 180.0) * (uMapWidth / 2.0);
  float latR = lat * 3.14159265 / 180.0;
  float mercY = log(tan(3.14159265 / 4.0 + latR / 2.0));
  float z = -(mercY / 3.14159265) * (uMapHeight / 2.0);
  return vec3(x, uYOffset, z);
}

void main() {
  float texSize = ${CFG.TEXTURE_SIZE}.0;
  float row = floor(aIndex / texSize);
  float col = mod(aIndex, texSize);
  vec2 uv = (vec2(col, row) + 0.5) / texSize;

  vec4 curr = texture2D(uPositions, uv);
  vec4 prev = texture2D(uPrevPositions, uv);

  vec4 particle = mix(curr, prev, aEnd);

  float lon = (particle.r - 0.5) * 360.0;
  float lat = (particle.g - 0.5) * 180.0;
  float age = curr.b;
  float speed = curr.a;

  vec3 pos = lonLatToScene(lon, lat);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);

  float ageNorm = age / uMaxAge;
  float fadeIn  = smoothstep(0.0, 0.05, ageNorm);
  float fadeOut = 1.0 - smoothstep(0.85, 1.0, ageNorm);
  float speedNorm = clamp(speed / 2.0, 0.0, 1.0);

  vAlpha = fadeIn * fadeOut * uGlobalOpacity * mix(0.15, 0.6, speedNorm) * (1.0 - aEnd * 0.5);

  vec3 slowColor = vec3(0.05, 0.15, 0.4);
  vec3 fastColor = vec3(0.0, 0.7, 0.85);
  vColor = mix(slowColor, fastColor, speedNorm);
}
`;

const TRAIL_FRAGMENT = /* glsl */ `
precision highp float;
varying float vAlpha;
varying vec3  vColor;

void main() {
  gl_FragColor = vec4(vColor, vAlpha);
}
`;

// ── OceanCurrentManager ───────────────────────────────────────────────────────

export default class OceanCurrentManager {
  /**
   * Constructs the Ocean Current Flow Field manager.
   * Sets up internal state but does not touch the scene or GL context.
   */
  constructor() {
    this._scene = null;
    this._renderer = null;
    this._group = new THREE.Group();
    this._group.name = 'oceanCurrentFlowField';
    this._visible = false;
    this._ready = false;
    this._disposed = false;

    // GPGPU state
    this._positionFBOs = [null, null]; // ping-pong
    this._currentFBO = 0;
    this._prevPositionFBO = null;
    this._advectScene = null;
    this._advectCamera = null;
    this._advectMaterial = null;
    this._advectMesh = null;

    // Velocity data texture (u/v)
    this._velocityTexture = null;
    this._sstTexture = null;
    this._blueNoiseTexture = null;
    this._hasSST = false;

    // Render meshes
    this._particleMesh = null;
    this._trailMesh = null;
    this._particleMaterial = null;
    this._trailMaterial = null;

    // Timing
    this._frameCount = 0;
    this._globalOpacity = 1.0;
    this._lastFetchTime = 0;

    // Event binding
    this._onLayerChanged = this._onLayerChanged.bind(this);
  }

  /**
   * Initialize the manager: set up GPGPU pipeline, create geometries,
   * register with layerManager, fetch data.
   * @param {THREE.Scene} scene - The main Three.js scene
   * @param {THREE.WebGLRenderer} renderer - The WebGL renderer (needed for GPGPU)
   */
  init(scene, renderer) {
    this._scene = scene;
    this._renderer = renderer;

    // Register with layer manager
    if (window.layerManager) {
      window.layerManager.register({
        id: 'ocean-currents',
        label: 'Ocean Current Flow Field',
        category: 'surface',
        defaultOn: false,
      });
    }

    // Listen for layer toggle events
    window.addEventListener('vg1:layerChanged', this._onLayerChanged);

    // Build GPGPU pipeline
    this._initBlueNoise();
    this._initVelocityTexture();
    this._initPositionFBOs();
    this._initAdvectPass();
    this._initParticleGeometry();
    this._initTrailGeometry();

    // Add group to scene (hidden by default)
    this._group.visible = false;
    scene.add(this._group);

    // Fetch real data
    this._fetchData();
  }

  /**
   * Per-frame update: run GPGPU advection, update render state, fade by altitude.
   * @param {THREE.Camera} camera - The active camera
   * @param {number} dt - Delta time in seconds
   */
  update(camera, dt) {
    if (!this._visible || !this._ready || this._disposed) return;

    // ── Altitude fade ──────────────────────────────────────────────────────
    const altitude = camera.position.y;
    if (altitude < CFG.MIN_CAMERA_ALT || altitude > CFG.MAX_CAMERA_ALT) {
      this._group.visible = false;
      return;
    }
    this._group.visible = true;

    // Smooth fade in/out based on altitude
    let opacity = 1.0;
    if (altitude < CFG.FADE_IN_ALT) {
      opacity = THREE.MathUtils.smoothstep(altitude, CFG.MIN_CAMERA_ALT, CFG.FADE_IN_ALT);
    } else if (altitude > CFG.FADE_OUT_ALT) {
      opacity = 1.0 - THREE.MathUtils.smoothstep(altitude, CFG.FADE_OUT_ALT, CFG.MAX_CAMERA_ALT);
    }
    this._globalOpacity = opacity;

    // ── GPGPU advection pass ───────────────────────────────────────────────
    this._runAdvection(dt);

    // ── Update render uniforms ─────────────────────────────────────────────
    const readFBO = this._positionFBOs[this._currentFBO];
    const prevFBO = this._prevPositionFBO;

    if (this._particleMaterial) {
      this._particleMaterial.uniforms.uPositions.value = readFBO.texture;
      this._particleMaterial.uniforms.uPrevPositions.value = prevFBO.texture;
      this._particleMaterial.uniforms.uGlobalOpacity.value = this._globalOpacity;
      this._particleMaterial.uniforms.uHasSST.value = this._hasSST;
      if (this._hasSST && this._sstTexture) {
        this._particleMaterial.uniforms.uSSTTexture.value = this._sstTexture;
      }
    }

    if (this._trailMaterial) {
      this._trailMaterial.uniforms.uPositions.value = readFBO.texture;
      this._trailMaterial.uniforms.uPrevPositions.value = prevFBO.texture;
      this._trailMaterial.uniforms.uGlobalOpacity.value = this._globalOpacity;
    }

    this._frameCount++;

    // ── Periodic data refresh ──────────────────────────────────────────────
    const now = Date.now();
    if (now - this._lastFetchTime > CFG.FETCH_INTERVAL_MS) {
      this._fetchData();
    }
  }

  /**
   * Clean up all GPU resources, event listeners, and scene objects.
   */
  dispose() {
    this._disposed = true;
    window.removeEventListener('vg1:layerChanged', this._onLayerChanged);

    // Dispose FBOs
    if (this._positionFBOs[0]) this._positionFBOs[0].dispose();
    if (this._positionFBOs[1]) this._positionFBOs[1].dispose();
    if (this._prevPositionFBO) this._prevPositionFBO.dispose();

    // Dispose textures
    if (this._velocityTexture) this._velocityTexture.dispose();
    if (this._sstTexture) this._sstTexture.dispose();
    if (this._blue