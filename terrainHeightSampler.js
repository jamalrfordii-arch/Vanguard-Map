// terrainHeightSampler.js — Phase 2 of the splat-visual + mesh-data hybrid
//
// The continent mesh now lives silently in memory (continentMesh.js sets
// visible=false). Its geometry holds a 1537×1537 vertex grid of true terrain
// elevations across the entire planet. This module exposes that data as a
// global lookup so ANY system that needs to position something on terrain
// can ask "what's the elevation at (lon, lat)?" and get back a Y value.
//
// Used by:
//   • portManager.js  — port markers sit on coastline / inland river height
//   • cityManager.js  — city halos sit on actual terrain elevation
//   • buildingManager.js — extruded buildings start from terrain, not Y=0
//   • Any future system that places entities geographically
//
// Public API:
//   init(continentMeshInstance)      — wire up after continentMesh constructor
//   sampleTerrainHeight(lon, lat)    — primary lookup, returns Y in scene units
//   sampleTerrainHeightXZ(x, z)      — direct scene-XZ lookup
//   isReady()                        — true once the worker has populated geometry
//
// Polls every 200ms until the continent worker finishes (~800ms cold start).
// Falls back to Y=0 (sea level) if sampler not ready or out of bounds.

import { MAP_WIDTH, MAP_HEIGHT, CONTINENT_MESH_SEGS } from './config.js';

const SEGS    = CONTINENT_MESH_SEGS;
const VERTS_PER_ROW = SEGS + 1;
const halfW   = MAP_WIDTH * 0.5;
const halfH   = MAP_HEIGHT * 0.5;

let _continentMeshRef = null;
let _positions        = null;
let _readyAtMs        = 0;

/**
 * Wire up the sampler with the continent mesh instance. Call once at init.
 * The mesh's vertex data is populated by an off-thread worker (~800ms cold
 * start). This function polls every 200ms until the geometry is available.
 */
export function init(continentMeshInstance) {
    _continentMeshRef = continentMeshInstance;
    let pollCount = 0;
    const check = () => {
        if (!_continentMeshRef) return;
        const geo = _continentMeshRef.getGeometry?.();
        if (geo && geo.attributes?.position?.array?.length) {
            _positions = geo.attributes.position.array;
            _readyAtMs = performance.now();
            const verts = _positions.length / 3;
            console.info(`[TerrainHeight] Sampler ready — ${verts.toLocaleString()} vertices across ${SEGS}×${SEGS} grid`);
            return;
        }
        if (pollCount++ < 100) setTimeout(check, 200);
        else console.warn('[TerrainHeight] Continent mesh never reported geometry — sampler stays inactive');
    };
    check();
}

/**
 * Sample terrain height at scene-space XZ coordinates.
 * Returns Y (scene units) of the nearest grid vertex.
 * Returns 0 if sampler not ready or out of bounds (= sea level / map edge).
 */
export function sampleTerrainHeightXZ(sceneX, sceneZ) {
    if (!_positions) return 0;
    // Normalize to [0,1] across the map plane
    const u = (sceneX + halfW) / MAP_WIDTH;
    const v = (sceneZ + halfH) / MAP_HEIGHT;
    if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
    // Snap to nearest grid cell
    const gx = Math.min(SEGS, Math.max(0, Math.floor(u * SEGS)));
    const gz = Math.min(SEGS, Math.max(0, Math.floor(v * SEGS)));
    const vertIdx = gz * VERTS_PER_ROW + gx;
    // position attribute is [x,y,z, x,y,z, ...] — Y is at index*3+1
    const y = _positions[vertIdx * 3 + 1];
    return Number.isFinite(y) ? y : 0;
}

/**
 * Sample terrain height at a geographic (lon, lat). Uses the same Mercator
 * projection as the rest of the codebase.
 * Returns Y in scene units. 0 = sea level.
 */
export function sampleTerrainHeight(lon, lat) {
    const x     = (lon / 180.0) * halfW;
    const latR  = lat * (Math.PI / 180.0);
    const mercY = Math.log(Math.tan(Math.PI / 4.0 + latR / 2.0));
    const z     = -(mercY / Math.PI) * halfH;
    return sampleTerrainHeightXZ(x, z);
}

/**
 * Returns true once the sampler has live mesh data and can be queried.
 * Useful for entity managers that want to defer Y-positioning until terrain
 * data exists rather than placing entities at Y=0 and re-positioning later.
 */
export function isReady() { return _positions !== null; }

/**
 * Bilinearly-interpolated height sample at scene XZ. Slightly more expensive
 * than the nearest-neighbour version above; use for entities that need
 * sub-cell smoothness (large objects, hovering things). Most entities can
 * use sampleTerrainHeightXZ() directly.
 */
export function sampleTerrainHeightSmoothXZ(sceneX, sceneZ) {
    if (!_positions) return 0;
    const u = (sceneX + halfW) / MAP_WIDTH;
    const v = (sceneZ + halfH) / MAP_HEIGHT;
    if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
    const fx = u * SEGS;
    const fz = v * SEGS;
    const gx0 = Math.floor(fx), gx1 = Math.min(SEGS, gx0 + 1);
    const gz0 = Math.floor(fz), gz1 = Math.min(SEGS, gz0 + 1);
    const tx  = fx - gx0;
    const tz  = fz - gz0;
    const y00 = _positions[(gz0 * VERTS_PER_ROW + gx0) * 3 + 1];
    const y10 = _positions[(gz0 * VERTS_PER_ROW + gx1) * 3 + 1];
    const y01 = _positions[(gz1 * VERTS_PER_ROW + gx0) * 3 + 1];
    const y11 = _positions[(gz1 * VERTS_PER_ROW + gx1) * 3 + 1];
    const y0  = y00 * (1 - tx) + y10 * tx;
    const y1  = y01 * (1 - tx) + y11 * tx;
    return y0 * (1 - tz) + y1 * tz;
}
