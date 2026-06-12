/**
 * wildfireManager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Vanguard1 — Active Wildfire Hotspot Layer
 *
 * Data source: NASA FIRMS (Fire Information for Resource Management System)
 *   API: https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/VIIRS_SNPP_NRT/world/1
 *   Latency: ~50 seconds from satellite observation (VIIRS SNPP ultra-real-time)
 *   Free API key: https://firms.modaps.eosdis.nasa.gov/api/mapkey/
 *
 * Visual concept:
 *   Instanced glowing quads at each hotspot lat/lon, color-coded by Fire
 *   Radiative Power (FRP). Low-FRP fires glow amber; high-FRP fires pulse
 *   white-hot. A pulsing halo bloom effect is achieved through emissiveIntensity
 *   variation driven by the animation loop.
 *
 * Architecture:
 *   - New *Manager.js file — registered with layerManager
 *   - Communicates via window.dispatchEvent(new CustomEvent('vg1:…'))
 *   - Constants in config.js under export const WILDFIRE = { … }
 *   - No imports from other managers
 *   - Module-scope scratch vectors (no in-loop allocations)
 *   - Camera altitude fade: visible camera.y < 300, full opacity < 150
 *
 * To activate (main.js):
 *   import { WildfireManager } from './wildfireManager.js';
 *   const wildfireManager = new WildfireManager();
 *   await wildfireManager.init(scene);
 *   // In animation loop:
 *   wildfireManager.update(camera, delta);
 */

import * as THREE from 'three';

// ── Config constants (copy these into config.js) ──────────────────────────────
// export const WILDFIRE = {
//   FIRMS_MAP_KEY: 'YOUR_KEY_HERE',       // Get free key at firms.modaps.eosdis.nasa.gov
//   FETCH_INTERVAL_MS: 5 * 60 * 1000,    // Re-fetch every 5 minutes
//   MAX_HOTSPOTS: 8000,                   // InstancedMesh max count
//   FADE_START_Y: 300,                    // Start fading above this camera altitude
//   FADE_END_Y: 400,                      // Fully hidden above this altitude
//   BASE_SIZE: 0.8,                       // Base quad size in scene units
//   PULSE_SPEED: 2.0,                     // Pulse oscillation speed
// };

const FIRMS_MAP_KEY    = 'YOUR_KEY_HERE';
const FETCH_INTERVAL   = 5 * 60 * 1000;
const MAX_HOTSPOTS     = 8000;
const FADE_START_Y     = 300;
const FADE_END_Y       = 400;
const BASE_SIZE        = 0.8;
const PULSE_SPEED      = 2.0;
const MAP_WIDTH        = 300;
const MAP_HEIGHT       = 300;

// ── Coordinate helpers (mirrors aisManager.js lonLatToScene) ─────────────────
const DEG_TO_RAD = Math.PI / 180;

function mercatorZ(lat) {
  const latRad = lat * DEG_TO_RAD;
  const y = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  // Normalize to -150…+150 (MAP_HEIGHT/2)
  const maxY = Math.log(Math.tan(Math.PI / 4 + 85 * DEG_TO_RAD / 2));
  return -(y / maxY) * (MAP_HEIGHT / 2);
}

function lonLatToScene(lon, lat) {
  const x = (lon / 180) * (MAP_WIDTH / 2);
  const z = mercatorZ(lat);
  return { x, z };
}

// FRP (MW) → colour: amber at low end, white-hot at high end
function frpToColor(frp, target) {
  const t = Math.min(frp / 2000, 1); // 2000 MW = max
  target.setRGB(
    1.0,
    THREE.MathUtils.lerp(0.35, 1.0, t),
    THREE.MathUtils.lerp(0.0,  0.9, t),
  );
}

// ── Scratch vars (no in-loop allocation) ─────────────────────────────────────
const _mat    = new THREE.Matrix4();
const _pos    = new THREE.Vector3();
const _scale  = new THREE.Vector3();
const _quat   = new THREE.Quaternion();
const _color  = new THREE.Color();

// ── Manager ──────────────────────────────────────────────────────────────────
export class WildfireManager {
  constructor() {
    this._scene       = null;
    this._mesh        = null;
    this._hotspots    = [];   // [{x, y, z, frp}]
    this._active      = true;
    this._elapsed     = 0;
    this._fetchTimer  = 0;
    this._layerId     = 'wildfire-hotspots';
    this._count       = 0;
  }

  /**
   * Initialise the manager — call once after scene creation.
   * @param {THREE.Scene} scene
   */
  async init(scene) {
    this._scene = scene;

    // ── Geometry: billboard quad facing +Y ───────────────────────────────────
    const geo = new THREE.PlaneGeometry(BASE_SIZE, BASE_SIZE);
    geo.rotateX(-Math.PI / 2); // lay flat on the sea/land surface

    // ── Material: emissive, additive blend for glow ───────────────────────────
    const mat = new THREE.MeshBasicMaterial({
      color: 0xff6600,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    this._mesh = new THREE.InstancedMesh(geo, mat, MAX_HOTSPOTS);
    this._mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._mesh.count = 0;
    this._mesh.renderOrder = 5;
    this._mesh.frustumCulled = false;
    this._mesh.name = 'wildfireHotspots';
    scene.add(this._mesh);

    // ── Layer registration ────────────────────────────────────────────────────
    if (window.layerManager) {
      window.layerManager.register({
        id:        this._layerId,
        label:     'Wildfire Hotspots',
        category:  'surface',
        defaultOn: true,
        icon:      '🔥',
      });
    }

    window.addEventListener('vg1:layerChanged', (e) => {
      if (e.detail?.id === this._layerId) {
        this._active = e.detail.visible;
        this._mesh.visible = this._active;
      }
    });

    // ── Initial fetch ─────────────────────────────────────────────────────────
    await this._fetchData();
    this._buildInstances();
  }

  /**
   * Fetch active fire hotspots from NASA FIRMS.
   * Swap the URL below for MODIS_NRT for longer history, or VIIRS_NOAA20_NRT
   * for the second VIIRS satellite.
   */
  async _fetchData() {
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${FIRMS_MAP_KEY}/VIIRS_SNPP_NRT/world/1`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`FIRMS HTTP ${res.status}`);
      const csv = await res.text();
      this._hotspots = this._parseCsv(csv);
      console.log(`[WildfireManager] ${this._hotspots.length} hotspots loaded`);
      window.dispatchEvent(new CustomEvent('vg1:wildfireUpdated', {
        detail: { count: this._hotspots.length },
      }));
    } catch (err) {
      console.warn('[WildfireManager] Fetch failed:', err);
    }
  }

  /**
   * Parse FIRMS CSV into scene-space hotspot objects.
   * Expected columns: latitude, longitude, bright_ti4, scan, track, acq_date,
   * acq_time, satellite, instrument, confidence, version, bright_ti5, frp, daynight
   */
  _parseCsv(csv) {
    const lines = csv.trim().split('\n');
    if (lines.length < 2) return [];
    const header = lines[0].split(',');
    const latIdx  = header.indexOf('latitude');
    const lonIdx  = header.indexOf('longitude');
    const frpIdx  = header.indexOf('frp');
    const confIdx = header.indexOf('confidence');

    const result = [];
    for (let i = 1; i < lines.length && result.length < MAX_HOTSPOTS; i++) {
      const cols = lines[i].split(',');
      const lat  = parseFloat(cols[latIdx]);
      const lon  = parseFloat(cols[lonIdx]);
      const frp  = parseFloat(cols[frpIdx])  || 0;
      const conf = cols[confIdx]?.trim();
      if (isNaN(lat) || isNaN(lon)) continue;
      if (conf === 'l') continue; // skip low-confidence detections
      const { x, z } = lonLatToScene(lon, lat);
      result.push({ x, y: 0.3, z, frp });
    }
    return result;
  }

  /** Rebuild the InstancedMesh matrices and colors from _hotspots. */
  _buildInstances() {
    const count = Math.min(this._hotspots.length, MAX_HOTSPOTS);
    this._count = count;
    this._mesh.count = count;

    for (let i = 0; i < count; i++) {
      const h = this._hotspots[i];
      _pos.set(h.x, h.y, h.z);
      _scale.setScalar(1 + Math.min(h.frp / 500, 4)); // larger for bigger fires
      _quat.identity();
      _mat.compose(_pos, _quat, _scale);
      this._mesh.setMatrixAt(i, _mat);

      frpToColor(h.frp, _color);
      this._mesh.setColorAt(i, _color);
    }

    this._mesh.instanceMatrix.needsUpdate = true;
    if (this._mesh.instanceColor) this._mesh.instanceColor.needsUpdate = true;
  }

  /**
   * Per-frame update — called from the main animation loop.
   * @param {THREE.Camera} camera
   * @param {number} dt  Delta time in seconds
   */
  update(camera, dt) {
    if (!this._mesh || !this._active) return;

    this._elapsed    += dt;
    this._fetchTimer += dt * 1000;

    // ── Camera altitude fade ──────────────────────────────────────────────────
    const camY = camera.position.y;
    let opacity = 0;
    if (camY < FADE_START_Y) {
      opacity = camY < FADE_START_Y - 50
        ? 0.9
        : THREE.MathUtils.mapLinear(camY, FADE_START_Y - 50, FADE_END_Y, 0.9, 0);
    }
    this._mesh.material.opacity = Math.max(0, opacity);
    this._mesh.visible = this._active && opacity > 0;

    // ── Pulse emissive scale (simulate flickering heat) ───────────────────────
    const pulse = 1 + 0.25 * Math.sin(this._elapsed * PULSE_SPEED);
    for (let i = 0; i < this._count; i++) {
      this._mesh.getMatrixAt(i, _mat);
      _mat.decompose(_pos, _quat, _scale);
      const h = this._hotspots[i];
      const base = 1 + Math.min(h.frp / 500, 4);
      _scale.setScalar(base * pulse);
      _mat.compose(_pos, _quat, _scale);
      this._mesh.setMatrixAt(i, _mat);
    }
    this._mesh.instanceMatrix.needsUpdate = true;

    // ── Periodic re-fetch ─────────────────────────────────────────────────────
    if (this._fetchTimer >= FETCH_INTERVAL) {
      this._fetchTimer = 0;
      this._fetchData().then(() => this._buildInstances());
    }
  }

  /** Tear down all scene objects and event listeners. */
  dispose() {
    if (this._mesh) {
      this._scene?.remove(this._mesh);
      this._mesh.geometry.dispose();
      this._mesh.material.dispose();
      this._mesh = null;
    }
    window.removeEventListener('vg1:layerChanged', this._onLayerChanged);
  }
}
