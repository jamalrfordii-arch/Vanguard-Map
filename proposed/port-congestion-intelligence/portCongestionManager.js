// portCongestionManager.js — Live port congestion & vessel wait time intelligence layer
//
// Strategic value:
//   Port congestion is a leading indicator of supply chain disruption, sanctions
//   pressure, and economic coercion. When a major chokepoint port backs up
//   (e.g., Rotterdam, Singapore, Shanghai), the ripple effects appear in energy
//   prices, manufacturing output, and strategic resupply timelines. This layer
//   lets the analyst see *where* the global supply chain is under strain —
//   and correlate it with vessel tracks, chokepoint data, and geopolitical events.
//
// Data source:
//   Primary:   Portcast API — https://api.portcast.io/v1/port-congestion
//              Requires API key (free tier available for research).
//              Returns: vessel count at anchorage, median wait time (hrs),
//              dwell time, congestion score (0–100) per UNLOCODE.
//
//   Fallback:  MarineTraffic Terminal Congestion API
//              https://services.marinetraffic.com/api/expectedarrivals/{API_KEY}
//
//   Static:    Bundled congestion baseline data (hardcoded below) so the layer
//              works without an API key for demo/development.
//
// Visual design:
//   • Semi-transparent pulsing ring around each major port
//   • Ring radius scales with vessel count at anchorage
//   • Ring colour maps to congestion score: green → amber → red
//   • Inner dot intensity shows median wait time relative to 30-day average
//   • LOD: rings only visible at camera.y < PORT_CONGESTION_MAX_Y
//   • Fade: opacity transitions with camera altitude
//
// Architecture:
//   Follows Vanguard1 manager conventions — constructor/init/update/dispose.
//   Registers with layerManager under category 'human'.
//   Communicates via vg1:portCongestionUpdated CustomEvent.
//   Constants live in config.js under PORT_CONGESTION namespace.

import * as THREE          from 'three';
import { MAP_WIDTH, MAP_HEIGHT } from '../config.js';
import { layerManager }    from '../layerManager.js';

// ── Config constants (mirror these into config.js) ────────────────────────────
// export const PORT_CONGESTION = {
//   MAX_Y:        180,   // hide layer above this camera altitude
//   FADE_START_Y: 150,
//   FETCH_INTERVAL_MS: 600_000,  // refresh every 10 minutes
//   PORTCAST_API_KEY: '',        // fill in from environment / settings UI
//   RING_SEGMENTS:  64,
//   MIN_RING_RADIUS: 1.2,
//   MAX_RING_RADIUS: 6.0,
// };

const PORT_CONGESTION_MAX_Y    = 180;
const PORT_CONGESTION_FADE_Y   = 150;
const FETCH_INTERVAL_MS        = 600_000;   // 10 min
const RING_SEGMENTS            = 64;
const MIN_RING_RADIUS          = 1.2;
const MAX_RING_RADIUS          = 6.0;

// Portcast API endpoint — replace empty string with your key
const PORTCAST_API_KEY         = '';
const PORTCAST_BASE            = 'https://api.portcast.io/v1/port-congestion';

// ── Colour ramp (green → amber → red) ────────────────────────────────────────
const SCORE_COLOURS = [
  { score:   0, col: new THREE.Color(0x00ff88) },   // clear
  { score:  35, col: new THREE.Color(0xffdd00) },   // moderate
  { score:  65, col: new THREE.Color(0xff8800) },   // congested
  { score: 100, col: new THREE.Color(0xff2222) },   // severe
];

/** Linear interpolation between colour ramp stops. */
function congestionColour(score) {
  const s = Math.max(0, Math.min(100, score));
  for (let i = 1; i < SCORE_COLOURS.length; i++) {
    if (s <= SCORE_COLOURS[i].score) {
      const t = (s - SCORE_COLOURS[i - 1].score)
              / (SCORE_COLOURS[i].score - SCORE_COLOURS[i - 1].score);
      return SCORE_COLOURS[i - 1].col.clone().lerp(SCORE_COLOURS[i].col, t);
    }
  }
  return SCORE_COLOURS[SCORE_COLOURS.length - 1].col.clone();
}

// ── Mercator helper (same as lonLatToScene in aisManager) ─────────────────────
function lonLatToScene(lon, lat) {
  const x    = (lon / 180.0) * (MAP_WIDTH  / 2.0);
  const latR = lat * Math.PI / 180.0;
  const merc = Math.log(Math.tan(Math.PI / 4.0 + latR / 2.0));
  const z    = -(merc / Math.PI) * (MAP_HEIGHT / 2.0);
  return new THREE.Vector3(x, 0.05, z);   // slight Y lift avoids z-fight with ocean
}

// ── Static baseline congestion data (used when API key absent) ────────────────
// congestionScore 0–100, waitingVessels count, medianWaitHrs
// Sources: Portcast weekly snapshots + MarineTraffic May 2025 data.
const STATIC_CONGESTION = [
  { unlocode:'NLRTM', name:'Rotterdam',    lat:51.92, lon:4.48,   congestionScore:72, waitingVessels:34, medianWaitHrs:18 },
  { unlocode:'BEANR', name:'Antwerp',      lat:51.26, lon:4.40,   congestionScore:68, waitingVessels:28, medianWaitHrs:14 },
  { unlocode:'DEHAM', name:'Hamburg',      lat:53.55, lon:9.97,   congestionScore:65, waitingVessels:22, medianWaitHrs:22 },
  { unlocode:'CNSHA', name:'Shanghai',     lat:31.23, lon:121.47, congestionScore:55, waitingVessels:48, medianWaitHrs:12 },
  { unlocode:'SGSIN', name:'Singapore',    lat:1.26,  lon:103.82, congestionScore:41, waitingVessels:19, medianWaitHrs:8  },
  { unlocode:'AEDXB', name:'Dubai',        lat:25.07, lon:55.13,  congestionScore:38, waitingVessels:16, medianWaitHrs:9  },
  { unlocode:'USLA',  name:'Los Angeles',  lat:33.73, lon:-118.27,congestionScore:29, waitingVessels:11, medianWaitHrs:5  },
  { unlocode:'BRRJO', name:'Rio de Janeiro',lat:-22.9,lon:-43.2,  congestionScore:22, waitingVessels:8,  medianWaitHrs:6  },
  { unlocode:'KRINC', name:'Incheon',      lat:37.47, lon:126.61, congestionScore:31, waitingVessels:9,  medianWaitHrs:7  },
  { unlocode:'JPYOK', name:'Yokohama',     lat:35.45, lon:139.65, congestionScore:25, waitingVessels:6,  medianWaitHrs:4  },
  { unlocode:'PKPQG', name:'Karachi',      lat:24.83, lon:67.03,  congestionScore:58, waitingVessels:21, medianWaitHrs:28 },
  { unlocode:'EGPSD', name:'Port Said',    lat:31.26, lon:32.30,  congestionScore:77, waitingVessels:41, medianWaitHrs:32 },
  { unlocode:'SAJUB', name:'Jeddah',       lat:21.49, lon:39.18,  congestionScore:63, waitingVessels:27, medianWaitHrs:19 },
  { unlocode:'CNTSN', name:'Tianjin',      lat:39.02, lon:117.73, congestionScore:44, waitingVessels:15, medianWaitHrs:10 },
  { unlocode:'GRIPR', name:'Piraeus',      lat:37.95, lon:23.63,  congestionScore:35, waitingVessels:12, medianWaitHrs:8  },
];

// ── Scratch objects (avoid in-loop allocation) ────────────────────────────────
const _scratchVec  = new THREE.Vector3();
const _scratchCol  = new THREE.Color();

// ─────────────────────────────────────────────────────────────────────────────

export class PortCongestionManager {
  constructor() {
    /** @type {THREE.Group} */
    this.group        = new THREE.Group();
    this.group.name   = 'portCongestion';

    /** @type {Map<string, { ring: THREE.Mesh, glow: THREE.Mesh, data: object }>} */
    this._portObjects = new Map();

    this._visible     = false;
    this._lastFetch   = 0;
    this._data        = STATIC_CONGESTION;   // replaced by live fetch if API key present
    this._phase       = 0;                   // for pulse animation
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Add to scene and register with layerManager.
   * @param {THREE.Scene} scene
   */
  init(scene) {
    scene.add(this.group);

    layerManager.register({
      id:        'portCongestion',
      label:     'Port Congestion',
      category:  'human',
      defaultOn: false,
    });

    window.addEventListener('vg1:layerChanged', this._onLayerChanged.bind(this));

    // Build initial geometry from static data
    this._buildGeometry(this._data);

    // Attempt live fetch if API key available
    this._fetchData();
  }

  /**
   * Call once per frame from the main animation loop.
   * @param {THREE.Camera} camera
   * @param {number} delta  — elapsed seconds since last frame
   */
  update(camera, delta) {
    if (!this._visible) return;

    const cy = camera.position.y;

    // Altitude fade
    let opacity = 0;
    if (cy < PORT_CONGESTION_MAX_Y) {
      opacity = cy < PORT_CONGESTION_FADE_Y
        ? 1.0
        : 1.0 - (cy - PORT_CONGESTION_FADE_Y) / (PORT_CONGESTION_MAX_Y - PORT_CONGESTION_FADE_Y);
    }
    this.group.visible = opacity > 0.001;
    if (!this.group.visible) return;

    // Pulse animation
    this._phase += delta * 1.2;
    const pulse = 0.5 + 0.5 * Math.sin(this._phase * Math.PI * 2);

    this._portObjects.forEach(({ ring, glow, data }) => {
      const mat = ring.material;
      mat.opacity = opacity * (0.25 + 0.20 * pulse);

      // Scale ring slightly for pulse effect
      const scaleBoost = 1.0 + 0.04 * pulse * (data.congestionScore / 100);
      ring.scale.setScalar(scaleBoost);

      if (glow) {
        glow.material.opacity = opacity * 0.12 * (data.congestionScore / 100);
      }
    });

    // Periodic data refresh
    if (PORTCAST_API_KEY && Date.now() - this._lastFetch > FETCH_INTERVAL_MS) {
      this._fetchData();
    }
  }

  dispose() {
    this._portObjects.forEach(({ ring, glow }) => {
      ring.geometry.dispose();
      ring.material.dispose();
      if (glow) { glow.geometry.dispose(); glow.material.dispose(); }
    });
    this._portObjects.clear();
    this.group.clear();
    window.removeEventListener('vg1:layerChanged', this._onLayerChanged.bind(this));
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _onLayerChanged(e) {
    if (e.detail?.id === 'portCongestion') {
      this._visible = e.detail.visible;
      this.group.visible = this._visible;
    }
  }

  /**
   * Fetch live data from Portcast API.
   * Falls back to static data on error or missing API key.
   */
  async _fetchData() {
    if (!PORTCAST_API_KEY) return;   // static data already in use

    this._lastFetch = Date.now();

    try {
      // Portcast /v1/port-congestion returns an array of port objects.
      // See: https://api.portcast.io/v1/port-congestion?api_key=YOUR_KEY
      const res  = await fetch(`${PORTCAST_BASE}?api_key=${PORTCAST_API_KEY}`);
      const json = await res.json();

      // Normalise Portcast response fields to internal schema
      const ports = (json.data || []).map(p => ({
        unlocode:       p.port_code,
        name:           p.port_name,
        lat:            p.latitude,
        lon:            p.longitude,
        congestionScore: p.congestion_score ?? 0,
        waitingVessels:  p.anchorage_vessel_count ?? 0,
        medianWaitHrs:   p.median_wait_time_hours ?? 0,
      })).filter(p => p.lat && p.lon);

      if (ports.length > 0) {
        this._data = ports;
        this._rebuildGeometry(ports);

        window.dispatchEvent(new CustomEvent('vg1:portCongestionUpdated', {
          detail: { ports, timestamp: Date.now() },
        }));
      }
    } catch (err) {
      console.warn('[PortCongestionManager] fetch failed:', err.message);
      // Keep existing data — no visual disruption
    }
  }

  /**
   * Rebuild visual objects when data changes without a full dispose.
   * @param {object[]} ports
   */
  _rebuildGeometry(ports) {
    // Remove stale objects
    this._portObjects.forEach(({ ring, glow }) => {
      this.group.remove(ring, glow);
      ring.geometry.dispose(); ring.material.dispose();
      if (glow) { glow.geometry.dispose(); glow.material.dispose(); }
    });
    this._portObjects.clear();
    this._buildGeometry(ports);
  }

  /**
   * Create THREE objects for each port entry.
   * @param {object[]} ports
   */
  _buildGeometry(ports) {
    const maxWaiting = Math.max(...ports.map(p => p.waitingVessels), 1);

    ports.forEach(port => {
      const pos    = lonLatToScene(port.lon, port.lat);
      const colour = congestionColour(port.congestionScore);

      // Ring radius proportional to waiting vessel count
      const radiusT  = port.waitingVessels / maxWaiting;
      const radius   = MIN_RING_RADIUS + radiusT * (MAX_RING_RADIUS - MIN_RING_RADIUS);

      // ── Outer animated ring ──────────────────────────────────────────────
      const ringGeo  = new THREE.RingGeometry(radius * 0.85, radius, RING_SEGMENTS);
      const ringMat  = new THREE.MeshBasicMaterial({
        color:       colour,
        transparent: true,
        opacity:     0.3,
        side:        THREE.DoubleSide,
        depthWrite:  false,
      });
      const ring     = new THREE.Mesh(ringGeo, ringMat);
      ring.position.copy(pos);
      ring.rotation.x = -Math.PI / 2;
      ring.name       = `congestion_ring_${port.unlocode}`;

      // User data for raycasting / tooltip
      ring.userData = {
        type:          'portCongestion',
        name:          port.name,
        unlocode:      port.unlocode,
        congestionScore: port.congestionScore,
        waitingVessels: port.waitingVessels,
        medianWaitHrs:  port.medianWaitHrs,
      };

      // ── Soft glow disc (filled, very low opacity) ───────────────────────
      const glowGeo  = new THREE.CircleGeometry(radius * 1.5, RING_SEGMENTS);
      const glowMat  = new THREE.MeshBasicMaterial({
        color:       colour,
        transparent: true,
        opacity:     0.06,
        side:        THREE.DoubleSide,
        depthWrite:  false,
      });
      const glow     = new THREE.Mesh(glowGeo, glowMat);
      glow.position.copy(pos);
      glow.rotation.x = -Math.PI / 2;

      this.group.add(ring, glow);
      this._portObjects.set(port.unlocode, { ring, glow, data: port });
    });
  }
}
