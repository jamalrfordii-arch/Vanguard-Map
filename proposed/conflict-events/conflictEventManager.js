/**
 * conflictEventManager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Vanguard1 — ACLED Armed Conflict Event Layer
 *
 * Data source: Armed Conflict Location & Event Data Project (ACLED)
 *   API: https://api.acleddata.com/acled/read
 *   Free registration: https://acleddata.com/register/
 *   Updates: daily (new events within 24–48 hours of occurrence)
 *   Coverage: global, since 1997, 200+ countries
 *
 * Event types covered:
 *   Battles, Explosions/Remote violence, Violence against civilians,
 *   Protests, Riots, Strategic developments
 *
 * Visual concept:
 *   Each conflict event is rendered as a vertical spike rising from the
 *   terrain surface, color-coded by event type. Spike height scales with
 *   fatality count. High-fatality events (>50 dead) pulse with a bloom halo.
 *   Events within the last 7 days glow brighter than older ones (30-day
 *   history is loaded on init).
 *
 * Architecture:
 *   - Registered with layerManager under 'conflict-events'
 *   - Uses InstancedMesh for the spike geometry (no per-event draw call)
 *   - Event type legend dispatched via 'vg1:conflictLegend' for uiController
 *   - Module-scope scratch vars; no allocation in update()
 *   - Fade: visible below camera.y = 200
 *
 * To activate (main.js):
 *   import { ConflictEventManager } from './conflictEventManager.js';
 *   const conflictManager = new ConflictEventManager();
 *   await conflictManager.init(scene);
 *   // In animation loop:
 *   conflictManager.update(camera, delta);
 */

import * as THREE from 'three';

// ── Config constants (copy these into config.js) ──────────────────────────────
// export const CONFLICT = {
//   ACLED_EMAIL:        'YOUR_EMAIL',       // ACLED registered email
//   ACLED_KEY:          'YOUR_API_KEY',     // From acleddata.com/register/
//   FETCH_INTERVAL_MS:  4 * 60 * 60 * 1000, // Re-fetch every 4 hours
//   DAYS_BACK:          30,                  // Load events from last N days
//   MAX_EVENTS:         2000,               // InstancedMesh capacity
//   SPIKE_BASE_HEIGHT:  0.5,               // Min spike height (scene units)
//   SPIKE_MAX_HEIGHT:   12.0,              // Max spike height (100+ fatalities)
//   FADE_START_Y:       160,
//   FADE_END_Y:         220,
// };

const ACLED_EMAIL       = 'YOUR_EMAIL';
const ACLED_KEY         = 'YOUR_API_KEY';
const FETCH_INTERVAL    = 4 * 60 * 60 * 1000;
const DAYS_BACK         = 30;
const MAX_EVENTS        = 2000;
const SPIKE_BASE_HEIGHT = 0.5;
const SPIKE_MAX_HEIGHT  = 12.0;
const FADE_START_Y      = 160;
const FADE_END_Y        = 220;
const MAP_WIDTH         = 300;
const MAP_HEIGHT        = 300;
const DEG_TO_RAD        = Math.PI / 180;

// ── Event type → color mapping ────────────────────────────────────────────────
const EVENT_COLORS = {
  'Battles':                       0xff2222,  // red
  'Explosions/Remote violence':    0xff6600,  // orange
  'Violence against civilians':    0xff00aa,  // magenta
  'Protests':                      0x00aaff,  // blue
  'Riots':                         0xffdd00,  // yellow
  'Strategic developments':        0x88ff88,  // green
};
const DEFAULT_COLOR = 0xffffff;

// ── Coordinate conversion ─────────────────────────────────────────────────────
function mercatorZ(lat) {
  const latRad = lat * DEG_TO_RAD;
  const y = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  const maxY = Math.log(Math.tan(Math.PI / 4 + 85 * DEG_TO_RAD / 2));
  return -(y / maxY) * (MAP_HEIGHT / 2);
}
function lonLatToScene(lon, lat) {
  return { x: (lon / 180) * (MAP_WIDTH / 2), z: mercatorZ(lat) };
}

// Fatalities → spike height (log scale)
function fatalitiesToHeight(f) {
  const fNum = parseInt(f, 10) || 0;
  if (fNum === 0) return SPIKE_BASE_HEIGHT;
  return Math.min(SPIKE_BASE_HEIGHT + Math.log10(fNum + 1) * 3.5, SPIKE_MAX_HEIGHT);
}

// ── Scratch vars ──────────────────────────────────────────────────────────────
const _mat   = new THREE.Matrix4();
const _pos   = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _quat  = new THREE.Quaternion();
const _color = new THREE.Color();

// ISO date string for N days ago
function dateNDaysAgo(n) {
  const d = new Date(Date.now() - n * 86400 * 1000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// ── Manager ──────────────────────────────────────────────────────────────────
export class ConflictEventManager {
  constructor() {
    this._scene      = null;
    this._mesh       = null;
    this._events     = [];
    this._active     = true;
    this._elapsed    = 0;
    this._fetchTimer = 0;
    this._layerId    = 'conflict-events';
    this._count      = 0;
  }

  /**
   * Initialise the manager — call once after scene creation.
   * @param {THREE.Scene} scene
   */
  async init(scene) {
    this._scene = scene;

    // ── Spike geometry: thin box standing upright ─────────────────────────────
    const geo = new THREE.BoxGeometry(0.3, 1, 0.3);
    // Shift pivot to bottom so Y=0 is the base of the spike
    geo.translate(0, 0.5, 0);

    // ── Material: emissive-style with additive blending ───────────────────────
    const mat = new THREE.MeshBasicMaterial({
      color: 0xff2222,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this._mesh = new THREE.InstancedMesh(geo, mat, MAX_EVENTS);
    this._mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._mesh.count = 0;
    this._mesh.renderOrder = 7;
    this._mesh.frustumCulled = false;
    this._mesh.name = 'conflictEvents';
    scene.add(this._mesh);

    // ── Layer registration ────────────────────────────────────────────────────
    if (window.layerManager) {
      window.layerManager.register({
        id:        this._layerId,
        label:     'Conflict Events (ACLED)',
        category:  'human',
        defaultOn: false, // off by default — analyst opt-in
        icon:      '⚔️',
      });
    }

    window.addEventListener('vg1:layerChanged', (e) => {
      if (e.detail?.id === this._layerId) {
        this._active = e.detail.visible;
        this._mesh.visible = this._active;
      }
    });

    await this._fetchData();
    this._buildInstances();

    // Broadcast legend to uiController
    window.dispatchEvent(new CustomEvent('vg1:conflictLegend', {
      detail: { colors: EVENT_COLORS },
    }));
  }

  /**
   * Fetch ACLED events for the past DAYS_BACK days.
   * ACLED API supports page-based pagination; this fetches page 1 (500 events).
   * For full coverage, implement multi-page fetch in _fetchData.
   */
  async _fetchData() {
    const since = dateNDaysAgo(DAYS_BACK);
    // ACLED REST API
    const url = `https://api.acleddata.com/acled/read?` +
      `email=${encodeURIComponent(ACLED_EMAIL)}` +
      `&key=${encodeURIComponent(ACLED_KEY)}` +
      `&event_date=${since}` +
      `&event_date_where=BETWEEN` +
      `&event_date_end=${dateNDaysAgo(0)}` +
      `&limit=${MAX_EVENTS}` +
      `&fields=event_date|event_type|latitude|longitude|fatalities|country|location`;

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`ACLED HTTP ${res.status}`);
      const json = await res.json();
      const data = json.data || [];
      this._events = this._parseEvents(data);
      console.log(`[ConflictEventManager] ${this._events.length} conflict events loaded`);
      window.dispatchEvent(new CustomEvent('vg1:conflictUpdated', {
        detail: { count: this._events.length },
      }));
    } catch (err) {
      console.warn('[ConflictEventManager] Fetch failed:', err);
    }
  }

  /** Parse ACLED data array into internal format. */
  _parseEvents(data) {
    const now   = Date.now();
    const result = [];
    for (const d of data) {
      const lat  = parseFloat(d.latitude);
      const lon  = parseFloat(d.longitude);
      if (isNaN(lat) || isNaN(lon)) continue;
      const { x, z } = lonLatToScene(lon, lat);
      const h    = fatalitiesToHeight(d.fatalities);
      const col  = EVENT_COLORS[d.event_type] ?? DEFAULT_COLOR;
      const ts   = new Date(d.event_date).getTime();
      const ageDays = (now - ts) / (86400 * 1000);
      // Recent events (< 7 days) glow brighter
      const brightness = ageDays < 7 ? 1.0 : 0.5;
      result.push({ x, z, h, col, brightness, label: d.location, type: d.event_type });
    }
    return result;
  }

  /** Rebuild InstancedMesh from event list. */
  _buildInstances() {
    const count = Math.min(this._events.length, MAX_EVENTS);
    this._count = count;
    this._mesh.count = count;

    for (let i = 0; i < count; i++) {
      const ev = this._events[i];
      _pos.set(ev.x, 0, ev.z);
      _scale.set(1, ev.h, 1);
      _quat.identity();
      _mat.compose(_pos, _quat, _scale);
      this._mesh.setMatrixAt(i, _mat);

      _color.setHex(ev.col);
      _color.multiplyScalar(ev.brightness);
      this._mesh.setColorAt(i, _color);
    }

    this._mesh.instanceMatrix.needsUpdate = true;
    if (this._mesh.instanceColor) this._mesh.instanceColor.needsUpdate = true;
  }

  /**
   * Per-frame update.
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
    if (camY < FADE_END_Y) {
      opacity = camY < FADE_START_Y
        ? 0.85
        : THREE.MathUtils.mapLinear(camY, FADE_START_Y, FADE_END_Y, 0.85, 0);
    }
    this._mesh.material.opacity = Math.max(0, opacity);
    this._mesh.visible = this._active && opacity > 0;

    // ── Pulse high-casualty events ────────────────────────────────────────────
    const pulse = 1 + 0.15 * Math.sin(this._elapsed * 1.5);
    for (let i = 0; i < this._count; i++) {
      const ev = this._events[i];
      if (ev.h < SPIKE_MAX_HEIGHT * 0.7) continue; // only pulse large events
      this._mesh.getMatrixAt(i, _mat);
      _mat.decompose(_pos, _quat, _scale);
      _scale.y = ev.h * pulse;
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

  /** Tear down. */
  dispose() {
    if (this._mesh) {
      this._scene?.remove(this._mesh);
      this._mesh.geometry.dispose();
      this._mesh.material.dispose();
      this._mesh = null;
    }
  }
}
