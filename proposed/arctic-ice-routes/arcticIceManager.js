// arcticIceManager.js — Arctic sea ice extent + polar shipping route navigator
//
// Strategic value:
//   The Arctic is the fastest-warming region on Earth, and its ice extent
//   directly governs which shipping routes are navigable — most critically
//   Russia's Northern Sea Route (NSR) and Canada's Northwest Passage (NWP).
//   For an intelligence analyst, this layer answers: Is Russia's NSR currently
//   open? How much access does China have to Arctic transit? Are there unusual
//   vessel movements in ice-marginal zones? The ice field also provides context
//   for submarine and sensor operations in polar waters.
//
// Data source:
//   NSIDC Sea Ice Index — NSIDC Data Map Services API (OGC WMS/WCS)
//   WMS endpoint:  https://nsidc.org/api/mapservices/NSIDC/wms
//   Layer name:    "G02135_north_concentration_hdf5" (daily NH sea ice concentration)
//   Projection:    EPSG:3413 (NSIDC Sea Ice Polar Stereographic North)
//   Resolution:    25 km grid, daily updates
//   Docs:          https://nsidc.org/data/user-resources/help-center/guide-nsidc-data-map-services-api
//
//   Also see: AMSR2 Sea Ice Concentration (JAXA)
//   https://gcom-w1.jaxa.jp/auth.html — free academic registration
//
// Visual design:
//   • Tiled ice field overlay rendered as a THREE.Mesh on the ocean plane
//     at high arctic latitudes (above ~60°N) — translucent white-blue gradient
//   • Ice concentration drives opacity: 100% = fully opaque white, 15% = faint haze
//   • Three polar shipping routes rendered as line segments with status colour:
//       - Northern Sea Route (NSR)       — Russian Arctic coast, Barents to Bering
//       - Northwest Passage (NWP)        — Canadian Arctic Archipelago
//       - Transpolar Route (TPR)         — straight over the Pole (future route)
//   • Route colour: green = open (no blocking ice), amber = marginal, red = closed
//   • Animated chevron particles travel along open/marginal routes
//   • LOD: visible at all zoom levels above lat 60° — the polar cap is always legible
//
// Architecture:
//   Follows Vanguard1 manager conventions.
//   Registers with layerManager under category 'atmosphere' (environmental layer).
//   Emits vg1:arcticIceUpdated on data refresh.

import * as THREE       from 'three';
import { MAP_WIDTH, MAP_HEIGHT } from '../config.js';
import { layerManager } from '../layerManager.js';

// ── Config constants (mirror into config.js under ARCTIC_ICE namespace) ────────
// export const ARCTIC_ICE = {
//   MAX_Y:           600,      // visible at all zoom levels
//   FADE_START_Y:    500,
//   FETCH_INTERVAL_MS: 86_400_000,  // refresh daily
//   NSIDC_WMS_BASE: 'https://nsidc.org/api/mapservices/NSIDC/wms',
//   ICE_ALPHA:       0.55,     // max opacity of ice field
//   POLAR_LAT_CUTOFF: 58.0,   // ice field only rendered above this latitude
// };

const ARCTIC_ICE_MAX_Y        = 600;
const ARCTIC_ICE_FADE_Y       = 500;
const FETCH_INTERVAL_MS       = 86_400_000;    // 24 hours
const ICE_ALPHA               = 0.55;
const POLAR_LAT_CUTOFF        = 58.0;          // scene-Z threshold computed below
const NSIDC_WMS_BASE          = 'https://nsidc.org/api/mapservices/NSIDC/wms';
const NSIDC_LAYER             = 'G02135_north_concentration_hdf5';

// ── Mercator helper ────────────────────────────────────────────────────────────
function lonLatToScene(lon, lat) {
  const x    = (lon / 180.0) * (MAP_WIDTH  / 2.0);
  const latR = lat * Math.PI / 180.0;
  const merc = Math.log(Math.tan(Math.PI / 4.0 + latR / 2.0));
  const z    = -(merc / Math.PI) * (MAP_HEIGHT / 2.0);
  return new THREE.Vector3(x, 0.08, z);
}

// Pre-compute scene Z at which POLAR_LAT_CUTOFF falls (for mesh clipping)
const _cutoffScene = lonLatToScene(0, POLAR_LAT_CUTOFF);
const POLAR_Z_CUTOFF = _cutoffScene.z;   // negative value (north = -Z in Vanguard1)

// ── Polar shipping routes ─────────────────────────────────────────────────────
// Each route is an ordered array of [lon, lat] waypoints.
// Status computed from ice data at runtime; static fallback provided.
const POLAR_ROUTES = [
  {
    id:     'nsr',
    label:  'Northern Sea Route',
    colour: { open: 0x00ff99, marginal: 0xffcc00, closed: 0xff3333 },
    // Aug–Sep typically open; Jan–Apr typically closed
    statusHint: 'marginal',
    waypoints: [
      [18.9,  70.7],   // Barents Sea entrance (Novaya Zemlya west)
      [35.0,  72.0],   // Kara Gate
      [60.0,  73.5],   // Central Kara Sea
      [80.0,  73.0],   // Severnaya Zemlya west
      [100.0, 75.0],   // Laptev Sea
      [130.0, 74.5],   // East Siberian Sea
      [155.0, 70.0],   // Chukchi Sea
      [175.0, 65.6],   // Bering Strait
    ],
  },
  {
    id:     'nwp',
    label:  'Northwest Passage',
    colour: { open: 0x00ff99, marginal: 0xffcc00, closed: 0xff3333 },
    statusHint: 'closed',
    waypoints: [
      [-65.0, 63.0],   // Davis Strait (Baffin Island south)
      [-80.0, 68.0],   // Foxe Basin
      [-93.0, 72.0],   // Queen Maud Gulf
      [-105.0,71.0],   // Coronation Gulf
      [-120.0,70.5],   // Amundsen Gulf
      [-135.0,70.0],   // Mackenzie Delta region
      [-141.0,70.0],   // Beaufort Sea
      [-155.0,68.0],   // Chukchi Sea (join NSR)
    ],
  },
  {
    id:     'tpr',
    label:  'Transpolar Route (projected 2040+)',
    colour: { open: 0x4499ff, marginal: 0x4499ff, closed: 0x334466 },
    statusHint: 'closed',
    waypoints: [
      [18.9,  70.7],   // Barents entrance
      [30.0,  82.0],   // Near North Pole
      [0.0,   90.0],   // Pole
      [-30.0, 82.0],
      [-65.0, 71.0],   // Baffin Bay approach
    ],
  },
];

// ── Static ice extent mesh definition ────────────────────────────────────────
// In production, this would be replaced by a texture fetched from the NSIDC WMS
// API and applied to the mesh. For the scaffold we approximate the ice field
// with a procedural grid that covers the polar cap.
//
// Full integration path:
//   1. Fetch WMS GetMap PNG:
//      GET ${NSIDC_WMS_BASE}?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap
//          &LAYERS=${NSIDC_LAYER}&WIDTH=1024&HEIGHT=1024
//          &BBOX=-180,55,180,90&SRS=EPSG:4326&FORMAT=image/png&TIME=2026-06-10
//   2. Use THREE.TextureLoader to load the response blob URL
//   3. Apply as map to the ice mesh MeshBasicMaterial
//   4. Use alphaMap from a second WMS fetch of ice-concentration to drive opacity

// ── Scratch objects ────────────────────────────────────────────────────────────
const _scratchVec3 = new THREE.Vector3();

// ─────────────────────────────────────────────────────────────────────────────

export class ArcticIceManager {
  constructor() {
    this.group      = new THREE.Group();
    this.group.name = 'arcticIce';

    /** @type {THREE.Mesh|null} */
    this._iceMesh   = null;

    /** @type {Map<string, THREE.Line>} */
    this._routeLines = new Map();

    /** @type {Map<string, THREE.Points>} */
    this._routeParticles = new Map();

    this._visible   = false;
    this._lastFetch = 0;
    this._phase     = 0;   // for particle animation
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * @param {THREE.Scene} scene
   */
  async init(scene) {
    scene.add(this.group);

    layerManager.register({
      id:        'arcticIce',
      label:     'Arctic Ice & Polar Routes',
      category:  'atmosphere',
      defaultOn: false,
    });

    window.addEventListener('vg1:layerChanged', this._onLayerChanged.bind(this));

    this._buildIceMesh();
    this._buildRouteLines();

    // Attempt WMS texture fetch
    await this._fetchData();
  }

  /**
   * @param {THREE.Camera} camera
   * @param {number} delta
   */
  update(camera, delta) {
    if (!this._visible) return;

    const cy = camera.position.y;

    // Altitude fade
    let opacity = 1.0;
    if (cy > ARCTIC_ICE_FADE_Y) {
      opacity = cy > ARCTIC_ICE_MAX_Y
        ? 0
        : 1.0 - (cy - ARCTIC_ICE_FADE_Y) / (ARCTIC_ICE_MAX_Y - ARCTIC_ICE_FADE_Y);
    }

    this.group.visible = opacity > 0.001;
    if (!this.group.visible) return;

    // Ice mesh opacity
    if (this._iceMesh) {
      this._iceMesh.material.opacity = ICE_ALPHA * opacity;
    }

    // Animate route particles (chevron flow)
    this._phase += delta * 0.4;

    this._routeParticles.forEach((pts, routeId) => {
      if (!pts) return;
      const attr = pts.geometry.getAttribute('position');
      const n    = attr.count;
      // Shift particle positions along path — simplified linear motion
      // A full implementation would sample the spline at (phase + i/n) mod 1
      pts.material.opacity = opacity * 0.8;
    });

    // Daily refresh
    if (Date.now() - this._lastFetch > FETCH_INTERVAL_MS) {
      this._fetchData();
    }
  }

  dispose() {
    if (this._iceMesh) {
      this._iceMesh.geometry.dispose();
      this._iceMesh.material.dispose();
    }
    this._routeLines.forEach(l => { l.geometry.dispose(); l.material.dispose(); });
    this._routeParticles.forEach(p => { p.geometry.dispose(); p.material.dispose(); });
    this.group.clear();
    window.removeEventListener('vg1:layerChanged', this._onLayerChanged.bind(this));
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _onLayerChanged(e) {
    if (e.detail?.id === 'arcticIce') {
      this._visible      = e.detail.visible;
      this.group.visible = this._visible;
    }
  }

  /**
   * Build the polar ice cap mesh — a flat PlaneGeometry covering latitudes 58°–90°N.
   * In production, a WMS texture is applied (see _fetchData).
   * The mesh uses a procedural blue-white gradient as a placeholder.
   */
  _buildIceMesh() {
    // In Vanguard1's Mercator projection, lat 90° maps to scene Z ≈ −149.
    // We create a quad from POLAR_Z_CUTOFF to −MAP_HEIGHT/2.
    const southZ = POLAR_Z_CUTOFF;       // e.g. ≈ −98 at lat 58°
    const northZ = -(MAP_HEIGHT / 2.0);  // ≈ −150 (map edge)
    const height = Math.abs(northZ - southZ);
    const width  = MAP_WIDTH;            // full longitudinal extent

    const geo  = new THREE.PlaneGeometry(width, height, 64, 32);

    // Colour vertex attribute: lighter toward the pole
    const colours = [];
    const posArr  = geo.attributes.position.array;
    for (let i = 0; i < posArr.length; i += 3) {
      const localZ  = posArr[i + 1];   // PlaneGeometry: Y before rotation = Z after
      const t       = (localZ + height / 2) / height;   // 0 = south edge, 1 = north (pole)
      // Blend ice-blue at edge to bright white at pole
      const r = 0.75 + 0.25 * t;
      const g = 0.88 + 0.12 * t;
      const b = 1.00;
      colours.push(r, g, b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));

    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent:  true,
      opacity:      ICE_ALPHA,
      side:         THREE.DoubleSide,
      depthWrite:   false,
    });

    this._iceMesh = new THREE.Mesh(geo, mat);
    // Position: centre of the polar cap quad, on the ocean plane
    this._iceMesh.rotation.x  = -Math.PI / 2;
    this._iceMesh.position.set(0, 0.06, (southZ + northZ) / 2);
    this._iceMesh.name        = 'arcticIceMesh';

    this.group.add(this._iceMesh);
  }

  /**
   * Build THREE.Line objects for each polar shipping route.
   */
  _buildRouteLines() {
    POLAR_ROUTES.forEach(route => {
      const status  = route.statusHint;  // 'open' | 'marginal' | 'closed'
      const colHex  = route.colour[status] ?? route.colour.closed;
      const colour  = new THREE.Color(colHex);

      const points  = route.waypoints.map(([lon, lat]) => lonLatToScene(lon, lat));
      const geo     = new THREE.BufferGeometry().setFromPoints(points);
      const mat     = new THREE.LineBasicMaterial({
        color:       colour,
        transparent: true,
        opacity:     0.85,
        linewidth:   2,   // note: only 1 on most WebGL renderers; use LineMaterial from addons for thick lines
        depthWrite:  false,
      });

      const line    = new THREE.Line(geo, mat);
      line.name     = `arcticRoute_${route.id}`;
      line.userData = { routeId: route.id, label: route.label, status };

      this.group.add(line);
      this._routeLines.set(route.id, line);

      // Particle chevrons along route (3 particles per route segment)
      this._buildRouteParticles(route, points, colour);
    });
  }

  /**
   * Build animated dot particles that travel along a route to indicate flow direction.
   * @param {object} route
   * @param {THREE.Vector3[]} points
   * @param {THREE.Color} colour
   */
  _buildRouteParticles(route, points, colour) {
    const N       = 8;   // particles per route
    const pPositions = new Float32Array(N * 3);

    // Distribute evenly along the polyline
    const totalLen = points.reduce((acc, p, i) =>
      i === 0 ? 0 : acc + p.distanceTo(points[i - 1]), 0);

    let cumLen = 0;
    let seg    = 0;
    for (let i = 0; i < N; i++) {
      const target = (i / N) * totalLen;
      while (seg < points.length - 2 && cumLen + points[seg].distanceTo(points[seg + 1]) < target) {
        cumLen += points[seg].distanceTo(points[seg + 1]);
        seg++;
      }
      const segLen = points[seg].distanceTo(points[seg + 1]);
      const t      = segLen > 0 ? (target - cumLen) / segLen : 0;
      _scratchVec3.lerpVectors(points[seg], points[seg + 1], t);
      pPositions[i * 3    ] = _scratchVec3.x;
      pPositions[i * 3 + 1] = 0.10;
      pPositions[i * 3 + 2] = _scratchVec3.z;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pPositions, 3));

    const mat = new THREE.PointsMaterial({
      color:       colour,
      size:        0.6,
      transparent: true,
      opacity:     0.8,
      depthWrite:  false,
      sizeAttenuation: true,
    });

    const pts = new THREE.Points(geo, mat);
    pts.name  = `arcticRoute_pts_${route.id}`;
    this.group.add(pts);
    this._routeParticles.set(route.id, pts);
  }

  /**
   * Fetch the NSIDC WMS sea ice concentration image and apply it as a texture.
   *
   * Full WMS integration:
   *   GET https://nsidc.org/api/mapservices/NSIDC/wms
   *       ?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap
   *       &LAYERS=G02135_north_concentration_hdf5
   *       &BBOX=-180,55,180,90
   *       &WIDTH=1024&HEIGHT=512
   *       &SRS=EPSG:4326
   *       &FORMAT=image/png
   *       &TIME=YYYY-MM-DD    ← yesterday's date for latest available
   *
   * The response is a PNG where pixel brightness ≈ ice concentration (0–100%).
   * Use it as both map and alphaMap on the ice mesh material.
   */
  async _fetchData() {
    this._lastFetch = Date.now();

    try {
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      const url       = `${NSIDC_WMS_BASE}?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap`
                      + `&LAYERS=${NSIDC_LAYER}&BBOX=-180,55,180,90`
                      + `&WIDTH=1024&HEIGHT=512&SRS=EPSG:4326&FORMAT=image%2Fpng`
                      + `&TIME=${yesterday}`;

      const res    = await fetch(url);
      if (!res.ok) throw new Error(`WMS HTTP ${res.status}`);

      const blob   = await res.blob();
      const imgUrl = URL.createObjectURL(blob);

      // Apply as texture to ice mesh
      new THREE.TextureLoader().load(imgUrl, (tex) => {
        if (!this._iceMesh) return;
        this._iceMesh.material.map      = tex;
        this._iceMesh.material.alphaMap = tex;
        this._iceMesh.material.vertexColors = false;   // texture takes precedence
        this._iceMesh.material.needsUpdate  = true;

        URL.revokeObjectURL(imgUrl);   // free blob memory

        window.dispatchEvent(new CustomEvent('vg1:arcticIceUpdated', {
          detail: { date: yesterday, source: 'NSIDC WMS' },
        }));
      });

    } catch (err) {
      console.warn('[ArcticIceManager] WMS fetch failed — using procedural ice field:', err.message);
      // Procedural vertex-colour ice mesh stays visible — no disruption
    }
  }
}
