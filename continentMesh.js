// continentMesh.js — Data-only terrain mesh (HYBRID MODE)
//
// Originally a full-globe 512×512 PBR-shaded continent surface that crossfaded
// in at close zoom. Now stripped down to a silent data object: the worker
// builds a 1537×1537 vertex grid of true terrain elevations and that's all.
// Nothing in this module renders.
//
// Why this still exists at all:
//   • terrainHeightSampler.js reads geo.attributes.position to provide
//     sampleTerrainHeight(lon, lat) for entity placement (ports, chokepoints,
//     and any future surface-bound layer).
//   • The aTrueElev + aSlope attributes are preserved on the geometry so a
//     future splat shader (or any other system) can sample real metres /
//     slope values per vertex without recomputing the DEM.
//
// What was removed in Step 4 of the hybrid migration:
//   • MeshStandardMaterial + the onBeforeCompile PBR shader injection
//   • ArcGIS Clarity satellite texture loader (~64 tile fetches at boot)
//   • generateTerrainTextures() biome textures + window.terrainPBR tuning
//   • THREE.Mesh creation, scene.add, renderOrder, polygon offset
//   • computeVertexNormals + computeBoundingSphere (rendering-only)
//
// Result: ~330 lines of dead render code gone, satellite fetch + biome
// texture generation no longer run at boot, GPU never allocates material/
// shader for an invisible mesh.

import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT, CONTINENT_MESH_SEGS } from './config.js';

const SEGS = CONTINENT_MESH_SEGS;

export class ContinentMesh {
    // Signature kept compatible with the original (scene, terrainData,
    // normalMapTex) so main.js doesn't need to change. scene + normalMapTex
    // are now unused but accepted silently.
    constructor(scene, terrainData, _normalMapTex = null) {
        this._scene = scene;
        this._geo   = null;
        this._ready = false;

        this._build(terrainData);
    }

    _build(terrainData) {
        // Empty BufferGeometry — the worker fills it asynchronously.
        // No material, no mesh, never added to the scene.
        const geo = new THREE.BufferGeometry();
        this._geo = geo;

        // ── Launch the worker to populate vertex data ────────────────────────
        const worker = new Worker(
            new URL('./continentWorker.js', import.meta.url),
            { type: 'module' }
        );

        worker.onmessage = ({ data }) => {
            const { positions, slopes, trueElevs } = data;

            // Only the attributes any non-render consumer cares about:
            //   position  → terrainHeightSampler (Y lookup at lon/lat)
            //   aTrueElev → future systems that want elevation in metres
            //   aSlope    → future systems that want terrain steepness
            // Colors, UVs, indices, normals all skipped — they were used
            // only by the deleted render path.
            geo.setAttribute('position',  new THREE.BufferAttribute(positions, 3));
            geo.setAttribute('aTrueElev', new THREE.BufferAttribute(trueElevs, 1));
            geo.setAttribute('aSlope',    new THREE.BufferAttribute(slopes,    1));

            this._ready = true;
            console.log(
                '[ContinentMesh] Data-only terrain ready —',
                (positions.length / 3).toLocaleString(), 'vertices'
            );
            worker.terminate();
        };

        worker.onerror = err => {
            console.error('[ContinentMesh] Worker error:', err.message);
            worker.terminate();
        };

        // Structured-clone just the DEM into the worker. The satellite colour
        // array (~16MB) used to be cloned too for the now-removed colour pass.
        worker.postMessage({
            demData: terrainData.demData,
            imgW:    terrainData.imgW,
            imgH:    terrainData.imgH,
            MAP_WIDTH,
            MAP_HEIGHT,
            SEGS,
        });
    }

    // No-op kept so main.js's per-frame `continentMesh.update(camera)` call
    // doesn't need to change. Nothing renders; nothing to update.
    update(_camera) { /* intentionally empty — hybrid data-only mode */ }

    // Public accessor — terrainHeightSampler reads from this each poll until
    // the position attribute is populated.
    getGeometry() { return this._geo; }

    dispose() {
        if (this._geo) this._geo.dispose();
        this._geo = null;
    }
}
