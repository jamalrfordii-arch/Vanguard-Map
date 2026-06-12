// continentMesh.js — Full-globe 512×512 terrain mesh with geographic 3D character
//
// Fades in at continent zoom (camera.y 200→120) providing a solid, richly-coloured
// terrain surface across every landmass on Earth.  Ocean fragments are discarded
// so the existing ocean floor mesh (with its depth-colour emissive) shows through.
//
// Geographic features rendered:
//   • Satellite base colour     — real-world biome differentiation
//   • Triplanar PBR biomes      — grass, rock, snow, soil with height-aware blending
//   • Slope-based rock tint     — steep cliff faces get triplanar rock texture
//   • Snow caps                 — peaks above snow line blend to snow biome
//   • Detail + macro normals    — per-biome detail normals + globe-scale normal map
//   • Anti-tiling               — hash-rotated UV prevents visible texture repetition
//   • 500 m / 2 500 m contours  — teal minor + amber major, matches point cloud
//   • Ridge / edge glow         — cyan→warm-white emissive on steep land faces
//   • Three.js PBR lighting     — scene directional + ambient lights drive day/night
//
// Vertex data is built entirely in continentWorker.js so the main thread stays
// responsive during the ~800 ms calculation.  The mesh appears transparently as
// soon as the worker posts its result and the camera is below y = 200.

import * as THREE from 'three';
import {
    MAP_WIDTH, MAP_HEIGHT,
    CONTINENT_MESH_SEGS, CONTINENT_FADE_START, CONTINENT_FADE_END,
} from './config.js';
import { createTerrainPBRMaterial, updateMacroNormalMap } from './terrainPBRMaterial.js';

// SEGS from config — do not change without reading CLAUDE.md (GPU budget implications)
const SEGS = CONTINENT_MESH_SEGS;

export class ContinentMesh {
    // normalMapTex: optional THREE.Texture from loadNormalMap() in terrainBuilder.js.
    // Pass null (or omit) if terrain_normals.png has not been generated yet —
    // the mesh still renders with vertex-normal lighting, just without the
    // high-frequency normal-map detail baked by generate_normals.py.
    constructor(scene, terrainData, normalMapTex = null) {
        this._scene        = scene;
        this._mesh         = null;
        this._mat          = null;
        this._geo          = null;
        this._ready        = false;
        this._normalMapTex = normalMapTex;

        this._build(scene, terrainData);
    }

    _build(scene, terrainData) {
        // Geometry starts empty — worker will populate it async
        const geo = new THREE.BufferGeometry();

        // ── Material: PBR terrain with triplanar biome splatting ─────────────
        const mat = createTerrainPBRMaterial({
            macroNormalMap: this._normalMapTex,
        });

        // ── onBeforeCompile additions for contours + ridge glow ─────────────
        // We need to chain onto the existing onBeforeCompile from terrainPBRMaterial.
        // Store the PBR compile hook and wrap it.
        const pbrCompileHook = mat.onBeforeCompile;

        mat.onBeforeCompile = (shader, renderer) => {
            // First run the PBR hook to set up all biome uniforms + injection
            pbrCompileHook(shader, renderer);

            // ── Add contour + ridge glow uniforms ──
            shader.uniforms.u_contourMinorInterval = { value: 500.0 };
            shader.uniforms.u_contourMajorInterval = { value: 2500.0 };
            shader.uniforms.u_contourLineWidth     = { value: 0.15 };
            shader.uniforms.u_contourMinorColor    = { value: new THREE.Color(0.0, 0.55, 0.55) };
            shader.uniforms.u_contourMajorColor    = { value: new THREE.Color(0.85, 0.55, 0.0) };
            shader.uniforms.u_contourOpacity       = { value: 0.5 };
            shader.uniforms.u_ridgeGlowStrength    = { value: 0.35 };
            shader.uniforms.u_ridgeColor1          = { value: new THREE.Color(0.0, 0.8, 0.85) };
            shader.uniforms.u_ridgeColor2          = { value: new THREE.Color(0.95, 0.9, 0.8) };

            // ── Contour + ridge fragment injection ──
            // Insert after our PBR main block (which was injected after roughnessmap_fragment)
            const contourGlsl = /* glsl */ `
// ── Contour lines ──
{
    // Real-world elevation stored in v_elevation (from vertex Y)
    // Scale: vertex Y is already in scene units mapped from DEM metres
    // For contours we want real-world metres — ContinentWorker encodes
    // vertex Y as:  y = trueElevation * VERT_SCALE  (typically 0.06)
    // So reverse: realElev = v_elevation / 0.06
    // However, the exact scale depends on the worker. We use v_elevation
    // directly and let the user tune the intervals in scene-space.

    float elev = v_elevation;
    float minorMod = mod(elev, u_contourMinorInterval);
    float majorMod = mod(elev, u_contourMajorInterval);

    float minorLine = 1.0 - smoothstep(0.0, u_contourLineWidth, min(minorMod, u_contourMinorInterval - minorMod));
    float majorLine = 1.0 - smoothstep(0.0, u_contourLineWidth * 1.5, min(majorMod, u_contourMajorInterval - majorMod));

    vec3 contourColor = mix(
        u_contourMinorColor * minorLine,
        u_contourMajorColor,
        majorLine
    );
    float contourMask = max(minorLine, majorLine) * u_contourOpacity;
    diffuseColor.rgb = mix(diffuseColor.rgb, contourColor, contourMask);
}

// ── Ridge / edge glow ──
{
    float ridgeFactor = smoothstep(0.35, 0.75, v_slope);
    vec3 ridgeColor = mix(u_ridgeColor1, u_ridgeColor2, smoothstep(0.5, 0.9, v_slope));
    // Add as emissive so it survives tonemapping and blooms at threshold 0.95
    // only if the ridge is very prominent
    float emissiveAmount = ridgeFactor * u_ridgeGlowStrength;
    // Scale down to avoid triggering bloom on non-extreme ridges
    totalEmissiveRadiance += ridgeColor * emissiveAmount * 0.4;
}
`;
            // Inject after the metalness_fragment (which comes after roughnessmap_fragment
            // and our PBR block)
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <emissivemap_fragment>',
                '#include <emissivemap_fragment>\n' + contourGlsl
            );

            // Store ref for external uniform updates
            mat.userData.shader = shader;
            mat.userData.contourUniforms = {
                u_contourMinorInterval: shader.uniforms.u_contourMinorInterval,
                u_contourMajorInterval: shader.uniforms.u_contourMajorInterval,
                u_contourLineWidth:     shader.uniforms.u_contourLineWidth,
                u_contourOpacity:       shader.uniforms.u_contourOpacity,
                u_ridgeGlowStrength:    shader.uniforms.u_ridgeGlowStrength,
            };
        };

        // Force recompile
        mat.needsUpdate = true;

        // ── Create mesh ──
        const mesh = new THREE.Mesh(geo, mat);
        mesh.name = 'ContinentMesh';
        mesh.frustumCulled = false;
        mesh.renderOrder   = 1; // After ocean floor (0), before water (2)

        this._geo  = geo;
        this._mat  = mat;
        this._mesh = mesh;

        scene.add(mesh);
        mesh.visible = false; // Hidden until geometry arrives

        // ── Launch worker ──
        this._launchWorker(terrainData);
    }

    _launchWorker(terrainData) {
        const worker = new Worker('continentWorker.js');

        worker.onmessage = (e) => {
            const { positions, normals, colors, uvs, indices } = e.data;

            this._geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
            this._geo.setAttribute('normal',   new THREE.BufferAttribute(new Float32Array(normals), 3));
            this._geo.setAttribute('color',    new THREE.BufferAttribute(new Float32Array(colors), 3));
            this._geo.setAttribute('uv',       new THREE.BufferAttribute(new Float32Array(uvs), 2));
            if (indices) {
                this._geo.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
            }

            this._geo.computeBoundingSphere();
            this._ready = true;

            console.log(`[ContinentMesh] Geometry ready: ${(positions.length / 3) | 0} vertices`);
            worker.terminate();
        };

        worker.onerror = (err) => {
            console.error('[ContinentMesh] Worker error:', err);
            worker.terminate();
        };

        worker.postMessage(terrainData);
    }

    /**
     * Call once per frame from main.js animation loop.
     * @param {THREE.Camera} camera
     */
    update(camera) {
        if (!this._ready || !this._mesh) return;

        const camY = camera.position.y;

        // Fade opacity based on camera altitude
        if (camY < CONTINENT_FADE_START) {
            const t = Math.max(0, Math.min(1,
                (CONTINENT_FADE_START - camY) / (CONTINENT_FADE_START - CONTINENT_FADE_END)
            ));
            this._mat.opacity = t;
            this._mesh.visible = t > 0.001;
        } else {
            this._mat.opacity = 0;
            this._mesh.visible = false;
        }

        // Adjust PBR detail level based on distance — fade out detail normals at altitude
        if (this._mat.userData.pbrUniforms) {
            const detailFade = Math.max(0, Math.min(1, (150 - camY) / 100));
            this._mat.userData.pbrUniforms.u_detailNormalStrength.value = 0.6 * detailFade;
            // Increase sat color mix at distance (PBR detail less visible)
            this._mat.userData.pbrUniforms.u_satColorMix.value = 0.35 + (1 - detailFade) * 0.4;
        }
    }

    /**
     * Update macro normal map (called if terrain_normals.png loads async).
     * @param {THREE.Texture} tex
     */
    setMacroNormalMap(tex) {
        this._normalMapTex = tex;
        if (this._mat) {
            updateMacroNormalMap(this._mat, tex);
        }
    }

    /**
     * Get the mesh for external queries (raycasting, etc.)
     * @returns {THREE.Mesh|null}
     */
    getMesh() {
        return this._mesh;
    }

    dispose() {
        if (this._geo) this._geo.dispose();
        if (this._mat) this._mat.dispose();
        if (this._mesh && this._scene) this._scene.remove(this._mesh);
        this._mesh = null;
        this._ready = false;
    }
}