// buildingManager.js — OSM 3D building extrusion for tier-1 cities at close zoom
//
// How the coordinate math works
// ─────────────────────────────
// The app uses a Mercator projection where MAP_WIDTH=300 covers 360° of longitude,
// giving 1 scene unit ≈ 133 km.  Real building footprints (30–100 m) are
// sub-pixel at every zoom level if placed using the geographic projection.
//
// Instead this module uses a LOCAL coordinate frame centred on each city:
//   scene_delta = geographic_delta_metres × LOCAL_SCALE
//   LOCAL_SCALE = 0.002  →  1 m = 0.002 scene units
//   50 m building width  → 0.10 scene units  (≈15 px at camera Y=20)
//   100 m building height→ 0.20 scene units  (≈30 px at camera Y=20)
//   500 m cluster radius → 1.00 scene units  (fits inside city footprint ring)
//
// The visual result is architecturally proportioned buildings (wider CBD cores
// have taller, denser clusters) with correct relative shapes from real OSM data,
// just scaled to be perceptible at the app's tactical zoom levels.
//
// Overpass API
// ────────────
// On first close approach to each tier-1 city the module fires one POST to
// overpass-api.de, fetches ways tagged building=* within 500 m of the city
// centre, and merges all geometry into a single BufferGeometry per city.
// Results are cached for the session so re-zooming triggers no re-fetch.
//
// Integration
// ───────────
//   import { BuildingManager } from './buildingManager.js';
//   const buildingManager = new BuildingManager(scene);
//   // in animate():
//   buildingManager.update(camera, elapsed);

import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT, TERRAIN_VERTICAL_SCALE } from './config.js';
import { CITIES }               from './cityManager.js';
import { getTrueElevation }     from './terrainBuilder.js';

// ── Coordinate constants ──────────────────────────────────────────────────────
const LOCAL_SCALE    = 0.002;   // scene units per real metre (local frame)
const DEG2RAD        = Math.PI / 180;
const TWO_PI         = Math.PI * 2;

// ── Render config ─────────────────────────────────────────────────────────────
const SHOW_CAM_Y     = 28;      // start fading in below this camera height
const FULL_CAM_Y     = 18;      // fully opaque at this height
const SHOW_HORIZ     = 14;      // and within this horizontal scene-unit radius
const FADE_SPEED     = 0.04;    // lerp factor per frame (~0.04 ≈ 25 frames to fade)

// ── OSM fetch config ──────────────────────────────────────────────────────────
const FETCH_RADIUS_M = 500;     // Overpass around radius in metres
const MAX_BUILDINGS  = 300;     // hard cap per city
const MIN_HEIGHT_M   = 5;       // skip garden sheds / walls
const DEFAULT_HGT_M  = 14;      // fallback when tags absent
const LEVELS_TO_M    = 3.5;     // metres per building:levels
const OVERPASS       = 'https://overpass-api.de/api/interpreter';

// ── Mercator helpers (match cityManager.js lonLatToXZ) ────────────────────────
function lonLatToXZ(lon, lat) {
    const x      = (lon / 180.0) * (MAP_WIDTH / 2.0);
    const latRad = lat * DEG2RAD;
    const mercY  = Math.log(Math.tan(Math.PI / 4.0 + latRad / 2.0));
    const z      = -(mercY / Math.PI) * (MAP_HEIGHT / 2.0);
    return { x, z };
}

// Metres east/north of a reference lat/lon
function meterDelta(refLat, refLon, nodeLat, nodeLon) {
    const mPerDegLat = 111320;
    const mPerDegLon = 111320 * Math.cos(refLat * DEG2RAD);
    return {
        east:  (nodeLon - refLon) * mPerDegLon,
        north: (nodeLat - refLat) * mPerDegLat,
    };
}

// ── BuildingManager ───────────────────────────────────────────────────────────
export class BuildingManager {
    /**
     * @param {THREE.Scene} scene
     */
    constructor(scene) {
        this._scene  = scene;
        this._cities = new Map();   // name → CityEntry

        // Only load buildings for tier-1 cities
        for (const city of CITIES.filter(c => c.tier === 1)) {
            const { x: cx, z: cz } = lonLatToXZ(city.lon, city.lat);
            this._cities.set(city.name, {
                city,
                cx, cz,
                group:    null,
                loaded:   false,
                loading:  false,
                opacity:  0,
                targetOp: 0,
            });
        }
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Call every animation frame.
     * @param {THREE.Camera} camera
     */
    update(camera) {
        this._cities.forEach(entry => {
            const dx    = camera.position.x - entry.cx;
            const dz    = camera.position.z - entry.cz;
            const hDist = Math.sqrt(dx * dx + dz * dz);
            const camY  = camera.position.y;

            // Determine target opacity
            const inRange  = camY < SHOW_CAM_Y && hDist < SHOW_HORIZ;
            const fullShow = camY < FULL_CAM_Y  && hDist < SHOW_HORIZ * 0.7;

            if (!inRange) {
                // ── Immediate snap to hidden — no fade-out ───────────────────────
                // Buildings sit below the ocean surface for edge-of-map cities due
                // to the curvature correction. A slow lerp-out leaves them visible
                // below the map plane for ~80 frames from any camera angle.
                // Snapping opacity + visibility to 0 instantly prevents this.
                entry.targetOp = 0;
                entry.opacity  = 0;
                if (entry.group) entry.group.visible = false;
            } else if (fullShow) {
                entry.targetOp = 1;
            } else {
                // Partial — blend on both axes (fade-in only)
                const yFactor = 1 - Math.max(0, camY - FULL_CAM_Y) / (SHOW_CAM_Y - FULL_CAM_Y);
                const dFactor = 1 - Math.max(0, hDist - SHOW_HORIZ * 0.7) / (SHOW_HORIZ * 0.3);
                entry.targetOp = Math.min(yFactor, dFactor);
            }

            // Trigger load on first approach
            if (inRange && !entry.loaded && !entry.loading) {
                this._loadCity(entry);
            }

            // Lerp opacity (fade-in only — fade-out is instant, handled above)
            entry.opacity = THREE.MathUtils.lerp(entry.opacity, entry.targetOp, FADE_SPEED);

            // Apply to geometry
            if (entry.group) {
                const vis = entry.opacity > 0.005;
                entry.group.visible = vis;
                if (vis) {
                    entry.group.traverse(obj => {
                        if (!obj.material) return;
                        const base = obj.userData.isWireframe ? 0.75 : 0.88;
                        obj.material.opacity = entry.opacity * base;
                    });
                }
            }
        });
    }

    dispose() {
        this._cities.forEach(entry => {
            if (entry.group) {
                entry.group.traverse(obj => {
                    obj.geometry?.dispose();
                    obj.material?.dispose();
                });
                this._scene.remove(entry.group);
            }
        });
    }

    // ── Private: data fetch ───────────────────────────────────────────────────

    async _loadCity(entry) {
        entry.loading = true;
        const { city } = entry;

        // Show HUD status
        this._setStatus(`Loading ${city.name} buildings…`);

        const query = `[out:json][timeout:28];
(
  way["building"](around:${FETCH_RADIUS_M},${city.lat},${city.lon});
  way["building:part"](around:${FETCH_RADIUS_M},${city.lat},${city.lon});
);
(._;>;);
out body qt;`;

        try {
            const res = await fetch(OVERPASS, {
                method:  'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body:    'data=' + encodeURIComponent(query),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();

            const group = this._buildSceneGroup(json, entry);
            entry.group = group;
            entry.loaded = true;
            this._scene.add(group);

            console.info(`[Buildings] ${city.name}: ${group.userData.count} buildings rendered`);
            this._setStatus('');
        } catch (err) {
            // Graceful degradation — splat/ring layer still shows
            console.warn(`[Buildings] ${city.name} fetch failed:`, err.message);
            entry.loaded = true;   // don't retry on error
            this._setStatus('');
        } finally {
            entry.loading = false;
        }
    }

    // ── Private: geometry ─────────────────────────────────────────────────────

    _buildSceneGroup(osmJson, entry) {
        const { city, cx, cz } = entry;

        // Index nodes: id → {lat, lon}
        const nodeMap = new Map();
        for (const el of osmJson.elements) {
            if (el.type === 'node') nodeMap.set(el.id, { lat: el.lat, lon: el.lon });
        }

        // Base Y at city centre — must match terrainBuilder rawY formula exactly:
        //   rawY = hMeters/1000 + curveY - 0.2
        // Previously used hM * ELEV_SCALE(5.0) / 1000 which sent high-altitude
        // cities (Mexico City ~2240m → +9 units, São Paulo ~760m → +3 units)
        // flying above the map surface as giant ghost towers visible from any angle.
        const hM     = getTrueElevation(cx, cz);
        const dist2  = (cx / MAP_WIDTH) ** 2 + (cz / MAP_HEIGHT) ** 2;
        const curveY = -dist2 * 20.0;
        const baseY  = (hM > 0 ? hM / 1000.0 : 0) * TERRAIN_VERTICAL_SCALE + curveY - 0.2 + 0.05;

        // Buffers for merged geometry
        const wallPos  = [];   // solid building walls + roofs
        const wallNorm = [];
        const wallCol  = [];   // vertex colours (altitude tint)
        const edgePos  = [];   // roofline wireframe edges

        let count = 0;

        for (const el of osmJson.elements) {
            if (el.type !== 'way') continue;
            if (!el.tags) continue;
            const hasBuilding = el.tags.building || el.tags['building:part'];
            if (!hasBuilding) continue;
            if (!el.nodes || el.nodes.length < 4) continue;
            if (count >= MAX_BUILDINGS) break;

            // Resolve nodes → local scene XZ
            const pts = [];
            for (const nid of el.nodes) {
                const n = nodeMap.get(nid);
                if (!n) continue;
                const { east, north } = meterDelta(city.lat, city.lon, n.lat, n.lon);
                pts.push({
                    x: cx + east  * LOCAL_SCALE,
                    z: cz - north * LOCAL_SCALE,   // north = -Z
                });
            }
            // Remove duplicate last point (OSM closes polygons)
            if (pts.length < 3) continue;
            const poly = pts[pts.length - 1].x === pts[0].x &&
                         pts[pts.length - 1].z === pts[0].z
                ? pts.slice(0, -1)
                : pts;
            if (poly.length < 3) continue;

            // Derive height
            let heightM = DEFAULT_HGT_M;
            const tags  = el.tags;
            if (tags.height) {
                const h = parseFloat(tags.height);
                if (!isNaN(h) && h > 0) heightM = h;
            } else if (tags['building:levels']) {
                const lvl = parseFloat(tags['building:levels']);
                if (!isNaN(lvl) && lvl > 0) heightM = lvl * LEVELS_TO_M;
            } else if (tags.building === 'yes' || tags.building === 'residential') {
                heightM = 10;
            }
            if (heightM < MIN_HEIGHT_M) continue;

            // Apply city density multiplier for visual drama
            heightM *= (city.style?.heightMult ?? 1.0);
            const h = heightM * LOCAL_SCALE;   // scene-space height

            // Altitude colour: low buildings warm grey, tall buildings teal-white
            const t   = Math.min(1, heightM / 180);
            const cr  = 0.08 + t * 0.25;
            const cg  = 0.15 + t * 0.50;
            const cb  = 0.18 + t * 0.55;

            const n   = poly.length;
            const ry  = baseY + h;  // roof Y

            // ── Walls ─────────────────────────────────────────────────────────
            for (let i = 0; i < n; i++) {
                const a = poly[i];
                const b = poly[(i + 1) % n];

                const edx  = b.x - a.x;
                const edz  = b.z - a.z;
                const elen = Math.hypot(edx, edz) || 1e-9;
                const nx   =  edz / elen;   // outward normal
                const nz   = -edx / elen;

                // Two triangles per wall quad
                // tri 1: a-bot, b-bot, b-top
                wallPos.push( a.x, baseY, a.z,  b.x, baseY, b.z,  b.x, ry, b.z );
                wallNorm.push( nx,0,nz,  nx,0,nz,  nx,0,nz );
                wallCol.push( cr,cg,cb,  cr,cg,cb,  cr,cg*1.15,cb*1.15 );
                // tri 2: a-bot, b-top, a-top
                wallPos.push( a.x, baseY, a.z,  b.x, ry, b.z,  a.x, ry, a.z );
                wallNorm.push( nx,0,nz,  nx,0,nz,  nx,0,nz );
                wallCol.push( cr,cg,cb,  cr*1.1,cg*1.1,cb*1.1,  cr*1.1,cg*1.1,cb*1.1 );

                // Roofline wireframe edge
                edgePos.push( a.x, ry, a.z,  b.x, ry, b.z );
            }

            // ── Roof (triangulate polygon) ─────────────────────────────────────
            const shape2D = poly.map(p => new THREE.Vector2(p.x, p.z));
            let tris;
            try { tris = THREE.ShapeUtils.triangulateShape(shape2D, []); }
            catch (_) { tris = []; }

            for (const [i0, i1, i2] of tris) {
                const p0 = poly[i0], p1 = poly[i1], p2 = poly[i2];
                wallPos.push( p0.x, ry, p0.z,  p1.x, ry, p1.z,  p2.x, ry, p2.z );
                wallNorm.push( 0,1,0, 0,1,0, 0,1,0 );
                wallCol.push(
                    cr*1.3, cg*1.5, cb*1.6,
                    cr*1.3, cg*1.5, cb*1.6,
                    cr*1.3, cg*1.5, cb*1.6,
                );
            }

            count++;
        }

        // ── Assemble group ────────────────────────────────────────────────────
        const group = new THREE.Group();
        group.name         = `buildings-${city.name}`;
        group.userData.count = count;

        if (wallPos.length > 0) {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position',
                new THREE.BufferAttribute(new Float32Array(wallPos),  3));
            geo.setAttribute('normal',
                new THREE.BufferAttribute(new Float32Array(wallNorm), 3));
            geo.setAttribute('color',
                new THREE.BufferAttribute(new Float32Array(wallCol),  3));

            const mat = new THREE.MeshStandardMaterial({
                vertexColors: true,
                roughness:    0.85,
                metalness:    0.08,
                transparent:  true,
                opacity:      0,
                depthWrite:   true,
                side:         THREE.DoubleSide,
            });

            const mesh = new THREE.Mesh(geo, mat);
            mesh.renderOrder = 5;
            group.add(mesh);
        }

        // ── Roofline wireframe overlay ─────────────────────────────────────────
        if (edgePos.length > 0) {
            const wGeo = new THREE.BufferGeometry();
            wGeo.setAttribute('position',
                new THREE.BufferAttribute(new Float32Array(edgePos), 3));

            const wMat = new THREE.LineBasicMaterial({
                color:      0x40c4ff,
                transparent: true,
                opacity:     0,
                depthWrite:  false,
                blending:    THREE.AdditiveBlending,
            });

            const wLine = new THREE.LineSegments(wGeo, wMat);
            wLine.renderOrder          = 6;
            wLine.userData.isWireframe = true;
            group.add(wLine);
        }

        group.visible = false;
        return group;
    }

    // ── HUD status ────────────────────────────────────────────────────────────
    _setStatus(msg) {
        const el = document.getElementById('buildings-status');
        if (!el) return;
        el.textContent = msg;
        el.style.opacity = msg ? '1' : '0';
    }
}
