/**
 * seismicManager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Vanguard1 — Real-Time Seismic / Earthquake Layer
 *
 * Data source: USGS Earthquake Hazards Program — GeoJSON feeds
 *   Past hour:  https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson
 *   Past day:   https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson
 *   Past week:  https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_week.geojson
 *   Updates every 1 minute. No API key required.
 *
 * Visual concept:
 *   Each earthquake renders as a ring/ripple that expands outward from the
 *   epicentre and then fades — simulating a seismic shockwave propagating
 *   across the surface. Multiple rings per event (like ripples in water).
 *   Ring diameter and duration scale with magnitude. Color: cyan for minor
 *   (M<4), orange for moderate (M4–6), red for major (M>6).
 *
 * Architecture:
 *   - Registered with layerManager under 'seismic-events'
 *   - Uses a pool of THREE.Mesh ring objects, recycled as events age out
 *   - Module-scope scratch vars; no allocation in update()
 *   - Fade threshold: visible below camera.y = 400
 *
 * To activate (main.js):
 *   import { SeismicManager } from './seismicManager.js';
 *   const seismicManager = new SeismicManager();
 *   await seismicManager.init(scene);
 *   // In animation loop:
 *   seismicManager.update(camera, delta);
 */

import * as THREE from 'three';

// ── Config constants (copy these into config.js) ──────────────────────────────
// export const SEISMIC = {
//   FEED_URL:          'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
//   FETCH_INTERVAL_MS: 60 * 1000,    // USGS updates every minute
//   MAX_EVENTS:        500,           // cap for the day feed
//   RING_POOL_SIZE:    200,           // number of reusable ring meshes
//   RING_DURATION:     18.0,          // seconds each ring lives before recycling
//   RING_RINGS_PER_QUAKE: 3,          // how many concentric ripples per event
//   FADE_START_Y:      350,
//   FADE_END_Y:        450,
//   MIN_MAG:           2.0,           // ignore micro-quakes below this magnitude
// };

const FEED_URL        = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';
const FETCH_INTERVAL  = 60 * 1000;
const MAX_EVENTS      = 500;
const RING_POOL_SIZE  = 200;
const RING_DURATION   = 18.0;
const RINGS_PER_QUAKE = 3;
const FADE_START_Y    = 350;
const FADE_END_Y      = 450;
const MIN_MAG         = 2.0;
const MAP_WIDTH       = 300;
const MAP_HEIGHT      = 300;
const DEG_TO_RAD      = Math.PI / 180;

// ── Coordinate conversion ─────────────────────────────────────────────────────
function mercatorZ(lat) {
  const latRad = lat * DEG_TO_RAD;
  const y = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  const maxY = Math.log(Math.tan(Math.PI / 4 + 85 * DEG_TO_RAD / 2));
  return -(y / maxY) * (MAP_HEIGHT / 2);
}

function lonLatToScene(lon, lat) {
  return {
    x: (lon / 180) * (MAP_WIDTH / 2),
    z: mercatorZ(lat),
  };
}

// Magnitude → ring color
function magToColor(mag) {
  if (mag >= 6.0) return new THREE.Color(0xff2200); // major — red
  if (mag >= 4.0) return new THREE.Color(0xff8800); // moderate — orange
  return new THREE.Color(0x00ddff);                  // minor — cyan
}

// Magnitude → max ring radius in scene units
function magToMaxRadius(mag) {
  return Math.max(1.5, Math.pow(10, (mag - 2) * 0.5));
}

// ── Scratch vars ──────────────────────────────────────────────────────────────
const _color = new THREE.Color();

// ── Ring pool entry ───────────────────────────────────────────────────────────
class RingInstance {
  constructor(material) {
    const geo = new THREE.RingGeometry(0.5, 1.0, 32);
    geo.rotateX(-Math.PI / 2); // lay flat
    this.mesh     = new THREE.Mesh(geo, material.clone());
    this.mesh.renderOrder  = 6;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.active   = false;
    this.age      = 0;
    this.duration = RING_DURATION;
    this.maxRadius = 5;
    this.x = 0; this.z = 0;
    this.color    = new THREE.Color(0x00ddff);
    this.delay    = 0; // stagger for concentric rings
  }

  activate(x, z, maxRadius, color, delay) {
    this.x = x; this.z = z;
    this.maxRadius = maxRadius;
    this.color.copy(color);
    this.delay  = delay;
    this.age    = -delay;
    this.active = true;
    this.mesh.visible = false;
  }

  tick(dt) {
    this.age += dt;
    if (this.age < 0) return; // delay hasn't elapsed

    const t = Math.min(this.age / this.duration, 1.0);
    const r = this.maxRadius * t;
    const innerR = Math.max(r - 0.5, 0.01);
    const alpha  = 1.0 - t;

    this.mesh.visible = true;
    this.mesh.position.set(this.x, 0.2, this.z);
    this.mesh.scale.set(r, 1, r);
    this.mesh.material.opacity = alpha * 0.85;
    _color.copy(this.color);
    this.mesh.material.color.copy(_color);
    this.mesh.material.needsUpdate = false;

    if (t >= 1.0) {
      this.active = false;
      this.mesh.visible = false;
    }
  }
}

// ── Manager ──────────────────────────────────────────────────────────────────
export class SeismicManager {
  constructor() {
    this._scene       = null;
    this._pool        = [];
    this._events      = [];
    this._active      = true;
    this._fetchTimer  = 0;
    this._layerId     = 'seismic-events';
    this._group       = new THREE.Group();
    this._group.name  = 'seismicEvents';
  }

  /**
   * Initialise the manager — call once after scene creation.
   * @param {THREE.Scene} scene
   */
  async init(scene) {
    this._scene = scene;

    // ── Shared ring material template ─────────────────────────────────────────
    this._ringMat = new THREE.MeshBasicMaterial({
      color: 0x00ddff,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    // ── Build ring pool ───────────────────────────────────────────────────────
    for (let i = 0; i < RING_POOL_SIZE; i++) {
      const ring = new RingInstance(this._ringMat);
      this._pool.push(ring);
      this._group.add(ring.mesh);
    }

    scene.add(this._group);

    // ── Layer registration ────────────────────────────────────────────────────
    if (window.layerManager) {
      window.layerManager.register({
        id:        this._layerId,
        label:     'Seismic Events',
        category:  'surface',
        defaultOn: true,
        icon:      '📡',
      });
    }

    window.addEventListener('vg1:layerChanged', (e) => {
      if (e.detail?.id === this._layerId) {
        this._active = e.detail.visible;
        this._group.visible = this._active;
      }
    });

    await this._fetchData();
  }

  /** Fetch USGS GeoJSON earthquake feed. */
  async _fetchData() {
    try {
      const res = await fetch(FEED_URL);
      if (!res.ok) throw new Error(`USGS HTTP ${res.status}`);
      const json = await res.json();
      this._ingestFeatures(json.features || []);
      console.log(`[SeismicManager] ${this._events.length} seismic events loaded`);
      window.dispatchEvent(new CustomEvent('vg1:seismicUpdated', {
        detail: { count: this._events.length },
      }));
    } catch (err) {
      console.warn('[SeismicManager] Fetch failed:', err);
    }
  }

  /**
   * Convert GeoJSON features to seismic event records and spawn rings.
   * @param {Array} features
   */
  _ingestFeatures(features) {
    const now = Date.now();
    this._events = [];

    for (const f of features) {
      if (this._events.length >= MAX_EVENTS) break;
      const mag  = f.properties?.mag;
      const time = f.properties?.time;
      if (!mag || mag < MIN_MAG) continue;
      const [lon, lat] = f.geometry.coordinates;
      const { x, z }   = lonLatToScene(lon, lat);
      const ageSeconds  = (now - time) / 1000;

      this._events.push({ x, z, mag, ageSeconds });

      // Only spawn rings for events within last 2 hours
      if (ageSeconds < 7200) {
        this._spawnRings(x, z, mag);
      }
    }
  }

  /** Activate pool rings for a quake event. */
  _spawnRings(x, z, mag) {
    const maxR = magToMaxRadius(mag);
    const col  = magToColor(mag);
    let spawned = 0;

    for (const ring of this._pool) {
      if (spawned >= RINGS_PER_QUAKE) break;
      if (!ring.active) {
        ring.activate(x, z, maxR, col, spawned * (RING_DURATION / RINGS_PER_QUAKE));
        spawned++;
      }
    }
  }

  /**
   * Per-frame update.
   * @param {THREE.Camera} camera
   * @param {number} dt  Delta time in seconds
   */
  update(camera, dt) {
    if (!this._group || !this._active) return;

    this._fetchTimer += dt * 1000;

    // ── Camera fade ───────────────────────────────────────────────────────────
    const camY = camera.position.y;
    const visible = camY < FADE_END_Y && this._active;
    this._group.visible = visible;
    if (!visible) return;

    const globalOpacity = camY > FADE_START_Y
      ? THREE.MathUtils.mapLinear(camY, FADE_START_Y, FADE_END_Y, 1, 0)
      : 1;

    // ── Tick all active rings ─────────────────────────────────────────────────
    for (const ring of this._pool) {
      if (!ring.active) continue;
      ring.tick(dt);
      if (ring.mesh.material) {
        ring.mesh.material.opacity = (ring.mesh.material.opacity || 0) * globalOpacity;
      }
    }

    // ── Periodic re-fetch ─────────────────────────────────────────────────────
    if (this._fetchTimer >= FETCH_INTERVAL) {
      this._fetchTimer = 0;
      this._fetchData();
    }
  }

  /** Tear down. */
  dispose() {
    this._scene?.remove(this._group);
    for (const ring of this._pool) {
      ring.mesh.geometry.dispose();
      ring.mesh.material.dispose();
    }
    this._pool = [];
  }
}
