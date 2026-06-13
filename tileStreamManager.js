// tileStreamManager.js — Multi-level adaptive terrain LOD via Cesium Quantized-Mesh
//
// Replaces Terrarium PNG tiles with Cesium Ion's binary Quantized-Mesh (QM) format.
// QM advantages over Terrarium PNG:
//   • Adaptive triangle density — mountains get thousands of tris, flat ocean gets ~10
//   • Exact shared edge vertices between tiles → zero cracks or gaps at tile seams
//   • Built-in edge vertex arrays → proper skirts that eliminate ALL coastal black walls
//   • Binary, so no canvas/pixel decode step — roughly 2× faster tile load
//
// Five zoom LOD tiers are unchanged from the previous version.  Only the tile
// fetch, decode, and mesh-build pipeline changes.
//
// ── HOW TO ENABLE ────────────────────────────────────────────────────────────────
//   1. Sign up free at cesium.com/ion (no credit card)
//   2. Go to Access Tokens → copy "My Default Token"
//   3. Paste it into CESIUM_TOKEN below
//   4. Reload Vanguard1 — terrain will stream at all zoom levels
// ─────────────────────────────────────────────────────────────────────────────────

import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT, TERRAIN_VERTICAL_SCALE } from './config.js';

// ── Cesium Ion credentials ────────────────────────────────────────────────────
// Token is NOT hardcoded (repo is public-ready). Get a free token at
// cesium.com/ion → Access Tokens, then run once in the DevTools console:
//   localStorage.setItem('vg1_cesium_token', 'YOUR_TOKEN')
// Without a token, tile streaming stays disabled and the map falls back to
// the point cloud at all zoom levels — everything else works normally.
const CESIUM_TOKEN = (typeof localStorage !== 'undefined' && localStorage.getItem('vg1_cesium_token')) || '';
if (!CESIUM_TOKEN) console.warn('[Tiles] No Cesium Ion token — tile streaming disabled. See tileStreamManager.js header.');

// Cesium World Terrain — asset ID 1, global coverage up to zoom 15.
// NOTE: Cesium tiles use TMS Y ordering (Y=0=south pole).
//       We flip the Y coordinate in _loadTile before fetching.
// QM_BASE is resolved dynamically via the Ion endpoint API — do NOT hardcode.
// TileStreamManager._init() fetches the real URL before any tile loading begins.

// ArcGIS World Imagery — unchanged from previous version.
// NOTE: ArcGIS uses {z}/{y}/{x} order (row before column).
const IMAGERY_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

// ── LOD tier configuration ────────────────────────────────────────────────────
// tileSeg is intentionally absent — QM provides adaptive mesh density itself.
const LOD_LEVELS = [
    { zoom:  6, showAlt: 200, fadeBand: 40, maxActive: 20, loadRadius: 2 },
    { zoom:  8, showAlt: 120, fadeBand: 30, maxActive: 25, loadRadius: 2 },
    { zoom: 10, showAlt:  50, fadeBand: 15, maxActive: 16, loadRadius: 1 },
    { zoom: 12, showAlt:  22, fadeBand:  6, maxActive: 12, loadRadius: 1 },
    { zoom: 13, showAlt:  12, fadeBand:  4, maxActive:  9, loadRadius: 1 },
];

const FADE_SPEED   = 2.0;    // opacity ramp rate (units per second)
const MAX_OPACITY  = 0.96;   // tile meshes are primary terrain at close range
const SKIRT_DEPTH  = -35;    // scene units below deepest ocean floor (~-18)

const DEG2RAD = Math.PI / 180;
const TWO_PI  = Math.PI * 2;

// ── Coordinate helpers ────────────────────────────────────────────────────────

/** Tile (tx, ty) northwest corner → { lat, lon } in degrees. */
function tileToLatLon(tx, ty, zoom) {
    const n   = Math.PI - TWO_PI * ty / (2 ** zoom);
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    const lon = tx / (2 ** zoom) * 360 - 180;
    return { lat, lon };
}

/** Longitude → scene X (matches lonLatToScene in aisManager.js). */
function lonToSceneX(lonDeg) {
    return lonDeg * (MAP_WIDTH / 360);
}

/** Latitude → scene Z (Web Mercator, matches lonLatToScene). */
function latToSceneZ(latDeg) {
    const lr = Math.max(-1.48, Math.min(1.48, latDeg * DEG2RAD));
    const my = Math.log(Math.tan(Math.PI / 4 + lr / 2));
    return -my * (MAP_HEIGHT / TWO_PI);
}

/**
 * Earth-curvature Y offset — matches the formula in terrainWorker.js exactly
 * so tile meshes sit flush against the splat-cloud surface.
 */
function curveOffset(sceneX, sceneZ) {
    const dist = Math.sqrt((sceneX / MAP_WIDTH) ** 2 + (sceneZ / MAP_HEIGHT) ** 2);
    return -Math.pow(dist, 2) * 20.0;
}

// ── Tactical elevation colour palette ─────────────────────────────────────────
// Mirrors terrainWorker.js so tile geometry blends seamlessly with the base
// splat cloud at every transition altitude.
function elevToColor(elev) {
    let r, g, b;

    if (elev < -6000) {
        r = 0.01; g = 0.04; b = 0.15;
    } else if (elev < -2000) {
        const t = (elev + 6000) / 4000;
        r = 0.01 + t * 0.03; g = 0.04 + t * 0.10; b = 0.15 + t * 0.20;
    } else if (elev < -200) {
        const t = (elev + 2000) / 1800;
        r = 0.04 + t * 0.04; g = 0.14 + t * 0.16; b = 0.35 + t * 0.20;
    } else if (elev < 0) {
        const t = (elev + 200) / 200;
        r = 0.08 + t * 0.04; g = 0.30 + t * 0.10; b = 0.55 + t * 0.10;
    } else if (elev < 150) {
        const t = elev / 150;
        r = 0.16 + t * 0.10; g = 0.28 + t * 0.08; b = 0.10 + t * 0.02;
    } else if (elev < 600) {
        const t = (elev - 150) / 450;
        r = 0.26 + t * 0.08; g = 0.36 - t * 0.04; b = 0.12 - t * 0.02;
    } else if (elev < 1500) {
        const t = (elev - 600) / 900;
        r = 0.34 + t * 0.10; g = 0.32 - t * 0.08; b = 0.10 - t * 0.02;
    } else if (elev < 3000) {
        const t = (elev - 1500) / 1500;
        r = 0.44 + t * 0.10; g = 0.24 - t * 0.06; b = 0.08 + t * 0.04;
    } else if (elev < 4500) {
        const t = (elev - 3000) / 1500;
        r = 0.54 + t * 0.30; g = 0.18 + t * 0.58; b = 0.12 + t * 0.72;
    } else {
        r = 0.86; g = 0.90; b = 0.96;
    }

    return {
        r: Math.min(1, Math.max(0, r)),
        g: Math.min(1, Math.max(0, g)),
        b: Math.min(1, Math.max(0, b)),
    };
}

// ── TileCache — one per LOD level ─────────────────────────────────────────────
class TileCache {
    constructor(scene, cfg) {
        this._scene      = scene;
        this._cfg        = cfg;
        this._tiles      = new Map();   // key → { mesh, skirtMesh, opacity, lastAccess }
        this._loading    = new Set();   // keys currently in-flight
        this._lruOrder   = [];          // keys sorted oldest→newest access
        this._targetOpac  = 0;           // altitude-driven target opacity
        this._tileBase    = null;        // set by TileStreamManager after Ion endpoint resolves
        this._sessionToken = null;       // short-lived Ion session token (refreshed every 50 min)
    }

    setTargetOpacity(v)    { this._targetOpac  = v; }
    setTileBase(url)       { this._tileBase    = url; }
    setSessionToken(token) { this._sessionToken = token; }

    update(camX, camZ, delta) {
        if (this._targetOpac <= 0 && this._tiles.size === 0) return;

        const TPAX = 2 ** this._cfg.zoom;

        const camLon = (camX / MAP_WIDTH) * 360;
        const camTx  = Math.floor(((camLon + 180) / 360) * TPAX) % TPAX;
        const camTy  = this._sceneToCamTileY(camZ, TPAX);

        const R = this._cfg.loadRadius;
        const candidates = [];
        for (let dy = -R; dy <= R; dy++) {
            for (let dx = -R; dx <= R; dx++) {
                const tx = ((camTx + dx) % TPAX + TPAX) % TPAX;
                const ty = Math.max(0, Math.min(TPAX - 1, camTy + dy));
                candidates.push({ tx, ty, d2: dx * dx + dy * dy });
            }
        }
        candidates.sort((a, b) => a.d2 - b.d2);

        for (const { tx, ty } of candidates) {
            const key = `${this._cfg.zoom}/${tx}/${ty}`;
            if (!this._tiles.has(key) && !this._loading.has(key) && this._targetOpac > 0) {
                this._loadTile(tx, ty);
            }
            const entry = this._tiles.get(key);
            if (entry) {
                this._touchLRU(key);
                entry.opacity = Math.min(this._targetOpac, entry.opacity + FADE_SPEED * delta);
                entry.mesh.visible = entry.opacity > 0.001;
                entry.mesh.material.opacity = entry.opacity;
                if (entry.skirtMesh) {
                    entry.skirtMesh.visible  = entry.mesh.visible;
                    entry.skirtMesh.material.opacity = entry.opacity;
                }
            }
        }

        const visKeys = new Set(candidates.map(c => `${this._cfg.zoom}/${c.tx}/${c.ty}`));
        this._tiles.forEach((entry, key) => {
            if (visKeys.has(key)) return;
            entry.opacity = Math.max(0, entry.opacity - FADE_SPEED * delta * 2.5);
            entry.mesh.material.opacity = entry.opacity;
            if (entry.skirtMesh) {
                entry.skirtMesh.material.opacity = entry.opacity;
                entry.skirtMesh.visible = entry.opacity > 0.001;
            }
            if (entry.opacity <= 0.001) entry.mesh.visible = false;
        });

        while (this._lruOrder.length > this._cfg.maxActive) {
            this._evict(this._lruOrder[0]);
        }
    }

    dispose() {
        [...this._tiles.keys()].forEach(k => this._evict(k));
        this._loading.clear();
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    _sceneToCamTileY(sceneZ, tpax) {
        try {
            const my  = -sceneZ * TWO_PI / MAP_HEIGHT;
            const lat = 2 * Math.atan(Math.exp(my)) - Math.PI / 2;
            const sec = 1 / Math.cos(lat);
            const ty  = Math.floor(
                (1 - Math.log(Math.tan(lat) + sec) / Math.PI) / 2 * tpax
            );
            return Math.max(0, Math.min(tpax - 1, ty));
        } catch {
            return Math.floor(tpax / 2);
        }
    }

    async _loadTile(tx, ty) {
        const key = `${this._cfg.zoom}/${tx}/${ty}`;
        if (this._loading.has(key) || this._tiles.has(key)) return;
        if (!this._tileBase) return;   // endpoint not resolved yet — skip silently
        this._loading.add(key);

        // Cesium tiles use TMS Y ordering where Y=0 is the south pole.
        // Standard Web Mercator tiles have Y=0 at the north pole.
        // Flip: cesiumY = (tiles per axis - 1) - webY
        const tpax    = 1 << this._cfg.zoom;
        const cesiumY = tpax - 1 - ty;

        // _tileBase comes from the Ion endpoint API — already has trailing slash
        const qmUrl  = `${this._tileBase}${this._cfg.zoom}/${tx}/${cesiumY}.terrain?v=1.2.0`;
        const imgUrl = IMAGERY_URL
            .replace('{z}', this._cfg.zoom)
            .replace('{y}', ty)
            .replace('{x}', tx);

        try {
            const [qmRes, imgResRaw] = await Promise.all([
                fetch(qmUrl, {
                    headers: {
                        // Use the short-lived session token from the Ion endpoint response,
                        // NOT the main API key — Cesium tile servers validate the session token.
                        'Authorization': `Bearer ${this._sessionToken}`,
                        'Accept': 'application/vnd.quantized-mesh,application/octet-stream;q=0.9,*/*;q=0.01',
                    },
                    mode: 'cors',
                }),
                fetch(imgUrl, { mode: 'cors' }).catch(() => null),
            ]);

            if (!qmRes.ok) throw new Error(`QM HTTP ${qmRes.status}`);

            const buffer   = await qmRes.arrayBuffer();
            const qmData   = this._parseQM(buffer);

            let imageryBmp = null;
            if (imgResRaw && imgResRaw.ok) {
                imageryBmp = await createImageBitmap(await imgResRaw.blob());
            }

            const { mesh, skirtMesh } = this._buildMesh(tx, ty, qmData, imageryBmp);
            this._tiles.set(key, { mesh, skirtMesh, opacity: 0, lastAccess: performance.now() });
            this._lruOrder.push(key);

        } catch (err) {
            console.debug(`[TileStream z${this._cfg.zoom}] ${key} failed:`, err.message);
        } finally {
            this._loading.delete(key);
        }
    }

    // ── Quantized-Mesh binary decoder ─────────────────────────────────────────
    //
    // Format overview:
    //   [0..87]   88-byte header  (center ECEF, minHeight, maxHeight, bounding sphere, HOP)
    //   [88]      uint32 vertexCount
    //   [92]      uint16[vertexCount] u         (0-32767, west→east)
    //             uint16[vertexCount] v         (0-32767, south→north)
    //             uint16[vertexCount] height    (0-32767, minHeight→maxHeight)
    //   [align]   pad to 4-byte boundary if necessary
    //             uint32 triangleCount
    //             uint16[triangleCount*3] or uint32[triangleCount*3] indices
    //             (high-watermark encoded — see _decodeHWM)
    //   [edge]    4× { uint32 count, uint16[count] indices } for W/S/E/N edges
    //
    _parseQM(buffer) {
        const view = new DataView(buffer);

        // ── Header ──────────────────────────────────────────────────────────
        // Bytes 0-23:  center ECEF (3×float64) — not needed for our projection
        // Bytes 24-27: minHeight (float32)
        // Bytes 28-31: maxHeight (float32)
        // Bytes 32-87: bounding sphere + horizon occlusion — not needed
        const minHeight = view.getFloat32(24, true);
        const maxHeight = view.getFloat32(28, true);
        let off = 88;

        // ── Vertex arrays ────────────────────────────────────────────────────
        const vertexCount = view.getUint32(off, true);
        off += 4;

        const uBuf = new Uint16Array(vertexCount);
        const vBuf = new Uint16Array(vertexCount);
        const hBuf = new Uint16Array(vertexCount);

        for (let i = 0; i < vertexCount; i++) { uBuf[i] = view.getUint16(off + i * 2, true); }
        off += vertexCount * 2;
        for (let i = 0; i < vertexCount; i++) { vBuf[i] = view.getUint16(off + i * 2, true); }
        off += vertexCount * 2;
        for (let i = 0; i < vertexCount; i++) { hBuf[i] = view.getUint16(off + i * 2, true); }
        off += vertexCount * 2;

        // ── 4-byte alignment ─────────────────────────────────────────────────
        // The index section must start on a 4-byte boundary.
        if (off % 4 !== 0) off += 2;

        // ── Triangle indices (high-watermark encoded) ─────────────────────────
        const triangleCount = view.getUint32(off, true);
        off += 4;

        // Tiles with > 65536 vertices use 32-bit indices (extremely rare in practice)
        const use32      = vertexCount > 65536;
        const indexCount = triangleCount * 3;

        const rawIndices = new Uint32Array(indexCount);
        if (use32) {
            for (let i = 0; i < indexCount; i++) {
                rawIndices[i] = view.getUint32(off + i * 4, true);
            }
            off += indexCount * 4;
        } else {
            for (let i = 0; i < indexCount; i++) {
                rawIndices[i] = view.getUint16(off + i * 2, true);
            }
            off += indexCount * 2;
        }

        // High-watermark decode: if code===0 → emit highWaterMark then advance it;
        //                        else        → emit highWaterMark - code
        const indices = new Uint32Array(indexCount);
        let hwm = 0;
        for (let i = 0; i < indexCount; i++) {
            const code = rawIndices[i];
            if (code === 0) { indices[i] = hwm++; }
            else            { indices[i] = hwm - code; }
        }

        // ── Edge vertex index arrays (west, south, east, north) ───────────────
        // Each edge's vertices share exact positions with the adjacent tile's
        // corresponding edge — this is what gives QM its crack-free seams.
        const readEdge = () => {
            const count = view.getUint32(off, true); off += 4;
            const arr = new Array(count);
            if (use32) {
                for (let i = 0; i < count; i++) { arr[i] = view.getUint32(off, true); off += 4; }
            } else {
                for (let i = 0; i < count; i++) { arr[i] = view.getUint16(off, true); off += 2; }
            }
            return arr;
        };

        const west  = readEdge();
        const south = readEdge();
        const east  = readEdge();
        const north = readEdge();

        return {
            vertexCount,
            uBuf, vBuf, hBuf,
            minHeight, maxHeight,
            indices,
            edgeIndices: { west, south, east, north },
        };
    }

    // ── Mesh builder — converts QM vertices to Three.js BufferGeometry ────────
    _buildMesh(tx, ty, qmData, imageryBmp = null) {
        // ── Tile geographic bounds ────────────────────────────────────────────
        const nw = tileToLatLon(tx,     ty,     this._cfg.zoom);
        const se = tileToLatLon(tx + 1, ty + 1, this._cfg.zoom);

        // Scene-space bounds of this tile
        const x0 = lonToSceneX(nw.lon);   // west edge
        const x1 = lonToSceneX(se.lon);   // east edge
        const z0 = latToSceneZ(nw.lat);   // north edge (more negative Z)
        const z1 = latToSceneZ(se.lat);   // south edge

        const { vertexCount, uBuf, vBuf, hBuf, minHeight, maxHeight, indices, edgeIndices } = qmData;

        const positions = new Float32Array(vertexCount * 3);
        const colors    = new Float32Array(vertexCount * 3);
        const uvs       = new Float32Array(vertexCount * 2);

        for (let i = 0; i < vertexCount; i++) {
            // QM: u=0→west, u=32767→east, v=0→south, v=32767→north
            const tileU = uBuf[i] / 32767;   // 0=west, 1=east
            const tileV = vBuf[i] / 32767;   // 0=south, 1=north

            // Map u/v → scene X/Z
            // Note: z0 is north (more negative), z1 is south.
            // tileV=0 → south=z1, tileV=1 → north=z0, so Z = z1 + tileV*(z0-z1)
            const sceneX = x0 + tileU * (x1 - x0);
            const sceneZ = z1 + tileV * (z0 - z1);

            // Decode height in meters
            const elev = minHeight + (hBuf[i] / 32767) * (maxHeight - minHeight);

            // ── Elevation Y ───────────────────────────────────────────────────
            // Ocean vertices are clamped to exactly y=0 (sea level).  This
            // prevents the near-vertical coastal faces that appear as black walls
            // when deep ocean polygons connect to elevated land vertices.  The
            // sea plane at y=0 covers the transition seamlessly.
            // Vertex colour still uses actual depth via elevToColor, so the ocean
            // colour gradient (shallow teal → deep navy) is preserved.
            let elevY;
            if (elev <= 0) {
                elevY = 0;                          // clamp ocean to sea level
            } else if (elev < 15) {
                elevY = (elev / 2000.0) * (elev / 15); // taper: 0m→0, 15m→full
            } else {
                elevY = elev / 2000.0;              // land
            }
            elevY *= TERRAIN_VERTICAL_SCALE;

            const curve = curveOffset(sceneX, sceneZ);

            // Positions are in absolute scene space; mesh.position stays at origin
            positions[i * 3]     = sceneX;
            positions[i * 3 + 1] = elevY + curve;
            positions[i * 3 + 2] = sceneZ;

            // UV for satellite texture
            // ArcGIS tile row 0 = north.  flipY=true maps image row 0 → V=1.
            // So: texV = 1 - tileV (1=north=top of image)
            uvs[i * 2]     = tileU;
            uvs[i * 2 + 1] = 1.0 - tileV;

            const { r, g, b } = elevToColor(elev);
            colors[i * 3]     = r;
            colors[i * 3 + 1] = g;
            colors[i * 3 + 2] = b;
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
        geo.setAttribute('uv',       new THREE.BufferAttribute(uvs, 2));
        geo.setIndex(new THREE.BufferAttribute(indices, 1));
        geo.computeVertexNormals();
        geo.computeBoundingSphere();

        // ── Satellite imagery texture (best-effort) ───────────────────────────
        let imageryTex = null;
        if (imageryBmp) {
            imageryTex = new THREE.Texture(imageryBmp);
            imageryTex.colorSpace      = THREE.SRGBColorSpace;
            imageryTex.minFilter       = THREE.LinearMipmapLinearFilter;
            imageryTex.magFilter       = THREE.LinearFilter;
            imageryTex.generateMipmaps = true;
            imageryTex.needsUpdate     = true;
        }

        // polygonOffset scales with zoom — higher zoom tiles need a stronger push
        // to avoid z-fighting with lower-zoom tiles beneath them.
        const zoomOffset = this._cfg.zoom * 0.5;

        const mat = new THREE.MeshStandardMaterial({
            map:                 imageryTex || null,
            vertexColors:        !imageryTex,
            roughness:           0.85,
            metalness:           0.02,
            transparent:         true,
            opacity:             0,
            depthWrite:          true,
            side:                THREE.DoubleSide,
            polygonOffset:       true,
            polygonOffsetFactor: -zoomOffset,
            polygonOffsetUnits:  -zoomOffset,
        });

        // Mesh sits at scene origin — positions are already in world space
        const mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = 3 + (this._cfg.zoom - 6);
        mesh.position.set(0, 0, 0);
        mesh.visible = false;
        this._scene.add(mesh);

        // ── Skirt — built from QM's own edge vertex arrays ────────────────────
        // Each edge list contains vertex indices in order around that tile edge.
        // Adjacent tiles share these exact vertices, so no gap ever opens between
        // tiles.  The skirt hangs each edge segment down to SKIRT_DEPTH, hiding
        // any sub-sea-level geometry from the viewer.
        const skirtMesh = this._buildSkirt(positions, colors, edgeIndices, zoomOffset);
        skirtMesh.renderOrder = mesh.renderOrder;
        skirtMesh.visible = false;
        this._scene.add(skirtMesh);

        return { mesh, skirtMesh };
    }

    // ── Skirt builder — uses QM edge vertex index arrays ─────────────────────
    _buildSkirt(positions, colors, edgeIndices, zoomOffset) {
        const { west, south, east, north } = edgeIndices;
        // Process all 4 edges in order
        const allEdges = [north, south, west, east];

        const skirtPos    = [];
        const skirtColors = [];
        const skirtIdx    = [];
        let vi = 0;

        for (const edge of allEdges) {
            for (let i = 0; i < edge.length - 1; i++) {
                const i0 = edge[i];
                const i1 = edge[i + 1];

                const x0 = positions[i0 * 3],     y0 = positions[i0 * 3 + 1], z0 = positions[i0 * 3 + 2];
                const x1 = positions[i1 * 3],     y1 = positions[i1 * 3 + 1], z1 = positions[i1 * 3 + 2];

                // Darken skirt to read as shadow/depth
                const r = colors[i0 * 3]     * 0.35;
                const g = colors[i0 * 3 + 1] * 0.35;
                const b = colors[i0 * 3 + 2] * 0.35;

                const base = vi;
                // Four vertices: top-left, top-right, bottom-left, bottom-right
                skirtPos.push(x0, y0, z0,  x1, y1, z1,  x0, SKIRT_DEPTH, z0,  x1, SKIRT_DEPTH, z1);
                skirtColors.push(
                    r,       g,       b,
                    r,       g,       b,
                    r * 0.5, g * 0.5, b * 0.5,
                    r * 0.5, g * 0.5, b * 0.5
                );
                // Two triangles (DoubleSide handles both face directions)
                skirtIdx.push(base, base + 2, base + 1,  base + 1, base + 2, base + 3);
                vi += 4;
            }
        }

        const skirtGeo = new THREE.BufferGeometry();
        skirtGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(skirtPos),    3));
        skirtGeo.setAttribute('color',    new THREE.BufferAttribute(new Float32Array(skirtColors), 3));
        skirtGeo.setIndex(skirtIdx);
        skirtGeo.computeVertexNormals();
        skirtGeo.computeBoundingSphere();

        const skirtMat = new THREE.MeshStandardMaterial({
            vertexColors:        true,
            roughness:           0.95,
            metalness:           0.0,
            transparent:         true,
            opacity:             0,
            depthWrite:          true,
            side:                THREE.DoubleSide,
            polygonOffset:       true,
            polygonOffsetFactor: -(zoomOffset + 0.5),
            polygonOffsetUnits:  -(zoomOffset + 0.5),
        });

        return new THREE.Mesh(skirtGeo, skirtMat);
    }

    _touchLRU(key) {
        const idx = this._lruOrder.indexOf(key);
        if (idx !== -1) this._lruOrder.splice(idx, 1);
        this._lruOrder.push(key);
        const e = this._tiles.get(key);
        if (e) e.lastAccess = performance.now();
    }

    _evict(key) {
        const entry = this._tiles.get(key);
        if (!entry) return;
        entry.mesh.geometry.dispose();
        if (entry.mesh.material.map) entry.mesh.material.map.dispose();
        entry.mesh.material.dispose();
        this._scene.remove(entry.mesh);
        if (entry.skirtMesh) {
            entry.skirtMesh.geometry.dispose();
            entry.skirtMesh.material.dispose();
            this._scene.remove(entry.skirtMesh);
        }
        this._tiles.delete(key);
        const idx = this._lruOrder.indexOf(key);
        if (idx !== -1) this._lruOrder.splice(idx, 1);
    }
}

// ── TileStreamManager — public API ────────────────────────────────────────────
export class TileStreamManager {
    constructor(scene) {
        this._scene   = scene;
        this._caches  = LOD_LEVELS.map(cfg => new TileCache(scene, cfg));
        this._enabled = true;
        this._ready   = false;   // true once Ion endpoint resolves
        this._init();
    }

    // ── Cesium Ion endpoint lookup ─────────────────────────────────────────────
    // The Ion endpoint API returns:
    //   • data.url          — real tile root (e.g. assets.ion.cesium.com/…)
    //   • data.accessToken  — short-lived session token (~1 hour) for tile fetches
    // The session token is different from the main API key and MUST be used when
    // fetching individual terrain tiles.  We refresh it every 50 minutes.
    async _init() {
        if (!CESIUM_TOKEN) { this._enabled = false; return; } // no token → layer off, no failed fetch
        const ENDPOINT = `https://api.cesium.com/v1/assets/1/endpoint?access_token=${CESIUM_TOKEN}`;
        try {
            const res = await fetch(ENDPOINT, { mode: 'cors' });
            if (!res.ok) throw new Error(`Ion endpoint HTTP ${res.status}`);

            const data = await res.json();
            if (!data.url)         throw new Error('Ion endpoint response missing "url"');
            if (!data.accessToken) throw new Error('Ion endpoint response missing "accessToken"');

            // Ensure URL ends with '/' so we can safely concatenate zoom/x/y
            let tileBase = data.url;
            if (!tileBase.endsWith('/')) tileBase += '/';

            // Push resolved URL + session token into every TileCache
            this._caches.forEach(c => {
                c.setTileBase(tileBase);
                c.setSessionToken(data.accessToken);
            });
            this._ready = true;

            // Session token expires in ~1 hour — refresh at 50 minutes to stay ahead
            setTimeout(() => this._init(), 50 * 60 * 1000);

            console.log('[TileStream] Cesium Ion endpoint resolved →', tileBase);
        } catch (err) {
            console.warn(
                '[TileStream] Cesium Ion endpoint failed — tile streaming disabled.\n' +
                '  Reason:', err.message, '\n' +
                '  Check network access to api.cesium.com and that the token is valid.'
            );
            this._enabled = false;
        }
    }

    set enabled(v) {
        this._enabled = v;
        if (!v) {
            this._caches.forEach(c => {
                c.setTargetOpacity(0);
                c.update(0, 0, 999);
            });
        }
    }
    get enabled() { return this._enabled; }

    update(camera) {
        if (!this._enabled || !this._ready) return;

        const camY  = camera.position.y;
        const camX  = camera.position.x;
        const camZ  = camera.position.z;
        const delta = 1 / 60;

        LOD_LEVELS.forEach((cfg, i) => {
            let target = 0;
            if (camY < cfg.showAlt) {
                const t = Math.min(1, (cfg.showAlt - camY) / cfg.fadeBand);
                target  = MAX_OPACITY * t;
            }
            this._caches[i].setTargetOpacity(target);
            this._caches[i].update(camX, camZ, delta);
        });
    }

    dispose() {
        this._caches.forEach(c => c.dispose());
    }
}
