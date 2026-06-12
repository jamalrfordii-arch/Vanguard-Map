// cityManager.js — City terrain patch layer with dual military / business modes
//
// Visual layer per city:
//   • Close-zoom displaced mesh terrain patch (visible only at close zoom)
//
// Public API:
//   cityManager.update(camera)                 — call every frame (LOD visibility)
//   cityManager.setMode('military'|'business') — switch visual palette

import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT, prng } from './config.js';
import { getTrueElevation, getTrueColor } from './terrainBuilder.js';

// ── City dataset ──────────────────────────────────────────────────────────────
// pop:     approx population in millions
// density: number of building instances
// tier:    1 = megacity  2 = major hub  3 = regional
// style:   building height multiplier + scatter radius
export const CITIES = [
    // ── Tier 1 — Megacities (>10 M) ──────────────────────────────────────────
    { name: 'Tokyo',        lon:  139.6917, lat:  35.6895, pop: 37.4, density: 250, tier: 1, style: { heightMult: 1.5, spread: 1.0 } },
    { name: 'Delhi',        lon:   77.2090, lat:  28.6139, pop: 31.0, density: 200, tier: 1, style: { heightMult: 1.2, spread: 1.1 } },
    { name: 'Shanghai',     lon:  121.4737, lat:  31.2304, pop: 27.1, density: 200, tier: 1, style: { heightMult: 2.5, spread: 0.7 } },
    { name: 'São Paulo',    lon:  -46.6333, lat: -23.5505, pop: 22.0, density: 160, tier: 1, style: { heightMult: 1.1, spread: 1.3 } },
    { name: 'Mexico City',  lon:  -99.1332, lat:  19.4326, pop: 21.6, density: 150, tier: 1, style: { heightMult: 0.9, spread: 1.2 } },
    { name: 'Cairo',        lon:   31.2357, lat:  30.0444, pop: 21.3, density: 130, tier: 1, style: { heightMult: 0.6, spread: 1.0 } },
    { name: 'Mumbai',       lon:   72.8777, lat:  19.0760, pop: 20.7, density: 180, tier: 1, style: { heightMult: 1.0, spread: 1.2 } },
    { name: 'Beijing',      lon:  116.3912, lat:  39.9042, pop: 20.5, density: 180, tier: 1, style: { heightMult: 2.0, spread: 0.9 } },
    { name: 'New York',     lon:  -74.0060, lat:  40.7128, pop: 18.8, density: 150, tier: 1, style: { heightMult: 2.0, spread: 0.6 } },
    { name: 'Karachi',      lon:   67.0011, lat:  24.8607, pop: 16.1, density: 120, tier: 1, style: { heightMult: 0.7, spread: 1.0 } },
    { name: 'Lagos',        lon:    3.3792, lat:   6.5244, pop: 14.4, density: 110, tier: 1, style: { heightMult: 0.7, spread: 1.1 } },
    { name: 'Istanbul',     lon:   28.9784, lat:  41.0082, pop: 15.0, density: 120, tier: 1, style: { heightMult: 1.0, spread: 1.0 } },
    { name: 'Moscow',       lon:   37.6173, lat:  55.7558, pop: 12.5, density: 130, tier: 1, style: { heightMult: 1.4, spread: 0.9 } },
    { name: 'Kinshasa',     lon:   15.2663, lat:  -4.3217, pop: 14.0, density:  90, tier: 1, style: { heightMult: 0.5, spread: 1.0 } },
    { name: 'Dhaka',        lon:   90.4125, lat:  23.8103, pop: 14.5, density: 110, tier: 1, style: { heightMult: 0.8, spread: 0.9 } },
    // ── Tier 2 — Major cities (5–10 M) ───────────────────────────────────────
    { name: 'Los Angeles',  lon: -118.2437, lat:  34.0522, pop: 12.4, density: 100, tier: 2, style: { heightMult: 0.7, spread: 1.5 } },
    { name: 'London',       lon:   -0.1276, lat:  51.5072, pop:  9.0, density: 120, tier: 2, style: { heightMult: 0.8, spread: 0.9 } },
    { name: 'Seoul',        lon:  126.9780, lat:  37.5665, pop:  9.7, density: 100, tier: 2, style: { heightMult: 1.6, spread: 0.6 } },
    { name: 'Tehran',       lon:   51.3890, lat:  35.6892, pop:  9.3, density: 100, tier: 2, style: { heightMult: 1.0, spread: 0.9 } },
    { name: 'Jakarta',      lon:  106.8456, lat:  -6.2088, pop:  9.6, density: 100, tier: 2, style: { heightMult: 0.8, spread: 1.0 } },
    { name: 'Lima',         lon:  -77.0428, lat: -12.0464, pop:  9.8, density:  90, tier: 2, style: { heightMult: 0.7, spread: 1.0 } },
    { name: 'Paris',        lon:    2.3522, lat:  48.8566, pop:  7.0, density:  90, tier: 2, style: { heightMult: 0.5, spread: 1.1 } },
    { name: 'Bangkok',      lon:  100.5018, lat:  13.7563, pop:  6.7, density:  90, tier: 2, style: { heightMult: 1.3, spread: 0.7 } },
    { name: 'Riyadh',       lon:   46.7219, lat:  24.6877, pop:  7.7, density:  90, tier: 2, style: { heightMult: 1.5, spread: 0.8 } },
    { name: 'Bogotá',       lon:  -74.0721, lat:   4.7110, pop:  7.4, density:  80, tier: 2, style: { heightMult: 0.9, spread: 0.8 } },
    { name: 'Chicago',      lon:  -87.6298, lat:  41.8781, pop:  5.1, density:  80, tier: 2, style: { heightMult: 1.8, spread: 0.5 } },
    { name: 'Buenos Aires', lon:  -58.3816, lat: -34.6037, pop:  3.1, density:  80, tier: 2, style: { heightMult: 0.8, spread: 1.0 } },
    { name: 'Johannesburg', lon:   28.0473, lat: -26.2041, pop:  5.6, density:  70, tier: 2, style: { heightMult: 1.1, spread: 0.8 } },
    { name: 'Nairobi',      lon:   36.8219, lat:  -1.2921, pop:  4.6, density:  60, tier: 2, style: { heightMult: 0.9, spread: 0.7 } },
    { name: 'Baghdad',      lon:   44.4009, lat:  33.3406, pop:  7.5, density:  80, tier: 2, style: { heightMult: 0.7, spread: 0.9 } },
    // ── Tier 3 — Regional hubs ────────────────────────────────────────────────
    { name: 'Hong Kong',    lon:  114.1694, lat:  22.3193, pop:  7.5, density: 120, tier: 3, style: { heightMult: 2.5, spread: 0.4 } },
    { name: 'Singapore',    lon:  103.8198, lat:   1.3521, pop:  5.9, density: 140, tier: 3, style: { heightMult: 1.8, spread: 0.6 } },
    { name: 'Dubai',        lon:   55.2708, lat:  25.2048, pop:  3.5, density: 110, tier: 3, style: { heightMult: 3.0, spread: 0.4 } },
    { name: 'Sydney',       lon:  151.2093, lat: -33.8688, pop:  5.3, density:  80, tier: 3, style: { heightMult: 1.2, spread: 0.5 } },
    { name: 'Toronto',      lon:  -79.3832, lat:  43.6532, pop:  3.0, density:  70, tier: 3, style: { heightMult: 1.5, spread: 0.6 } },
    { name: 'Frankfurt',    lon:    8.6821, lat:  50.1109, pop:  0.8, density:  70, tier: 3, style: { heightMult: 1.4, spread: 0.3 } },
    { name: 'Taipei',       lon:  121.5654, lat:  25.0330, pop:  2.7, density:  80, tier: 3, style: { heightMult: 1.6, spread: 0.4 } },
    { name: 'Osaka',        lon:  135.5023, lat:  34.6937, pop:  2.7, density:  90, tier: 3, style: { heightMult: 1.2, spread: 0.6 } },
    { name: 'Melbourne',    lon:  144.9631, lat: -37.8136, pop:  5.1, density:  70, tier: 3, style: { heightMult: 1.0, spread: 0.6 } },
    { name: 'Kuala Lumpur', lon:  101.6869, lat:   3.1390, pop:  1.8, density:  70, tier: 3, style: { heightMult: 1.6, spread: 0.5 } },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function lonLatToXZ(lon, lat) {
    const x      = (lon / 180.0) * (MAP_WIDTH  / 2.0);
    const latRad = lat * (Math.PI / 180.0);
    const mercY  = Math.log(Math.tan(Math.PI / 4.0 + latRad / 2.0));
    const z      = -(mercY / Math.PI) * (MAP_HEIGHT / 2.0);
    return { x, z };
}

// ── CityManager ───────────────────────────────────────────────────────────────
export class CityManager {
    constructor(scene, normalMapTex = null) {
        this._scene        = scene;
        this._mode         = 'military';
        this._group        = new THREE.Group();
        this._group.name   = 'cities';
        this._normalMapTex = normalMapTex;

        this._terrainPatches = [];  // { mesh, mat, cx, cz }

        this._buildTerrainPatches();
        scene.add(this._group);
    }

    // ── Phase 3: Close-zoom displaced mesh terrain with geographic character ────
    //
    // When the camera enters ~50 scene units from a city this dense 64×64
    // PlaneGeometry replaces the point cloud's gappy surface with a solid,
    // continuously-lit mesh.  Beyond displacement by real DEM elevation it adds:
    //
    //   • Slope-based rock tinting  — steep faces shift from satellite colour
    //     toward a warm grey-brown (exposed terrain / scree) using central-
    //     difference gradient magnitude
    //   • Snow caps                 — linear blend to cool white above 3 000 m
    //   • Valley depth darkening    — areas below city-centre elevation receive
    //     an atmospheric blue-shadow tint for perceived depth
    //   • Topographic contour lines — 500 m minor (teal) / 2 500 m major (amber)
    //     injected via onBeforeCompile, matching the point cloud shader exactly
    //   • Ridge / edge glow         — steep slope attribute drives a cyan→warm-
    //     white emissive that matches the point cloud's ridgeAccent look
    //
    // Three.js's standard PBR pipeline handles lighting from the scene's ambient
    // + directional lights (day/night), so no extra uniforms are needed.
    _buildTerrainPatches() {
        CITIES.forEach(city => {
            const { x, z } = lonLatToXZ(city.lon, city.lat);

            // Patch footprint in scene units — 5–18 units depending on spread
            const patchSize = 12 * city.style.spread;
            const segs      = 64;   // 64×64 grid = 4 225 vertices, 8 192 triangles

            const geo = new THREE.PlaneGeometry(patchSize, patchSize, segs, segs);
            geo.rotateX(-Math.PI / 2);  // XY plane → XZ flat ground

            const pos        = geo.attributes.position;
            const colors     = new Float32Array(pos.count * 3);
            const slopes     = new Float32Array(pos.count);
            const trueElevs  = new Float32Array(pos.count);

            // Step size for central-difference slope estimate — ~0.7× quad size
            const step   = (patchSize / segs) * 0.75;
            // City-centre elevation used for valley-depth shading reference
            const cityHM = getTrueElevation(x, z);

            for (let i = 0; i < pos.count; i++) {
                const vx = x + pos.getX(i);
                const vz = z + pos.getZ(i);
                const hM = getTrueElevation(vx, vz);
                trueElevs[i] = hM;

                // ── Vertex elevation + globe curvature ────────────────────
                const gDist = Math.sqrt((vx / MAP_WIDTH) ** 2 + (vz / MAP_HEIGHT) ** 2);
                pos.setY(i, (hM > 0 ? hM / 1000 : 0) - Math.pow(gDist, 2) * 20.0);

                // ── Central-difference slope magnitude ────────────────────
                const dydx    = (getTrueElevation(vx + step, vz) - getTrueElevation(vx - step, vz)) / (2 * step * 1000);
                const dydz    = (getTrueElevation(vx, vz + step) - getTrueElevation(vx, vz - step)) / (2 * step * 1000);
                const slopeMag = Math.min(1, Math.sqrt(dydx * dydx + dydz * dydz) * 2.0);
                slopes[i] = slopeMag;

                // ── Satellite base colour ─────────────────────────────────
                const col = getTrueColor(vx, vz);
                let r = col.r * 0.78;
                let g = col.g * 0.84;
                let b = col.b * 0.76;

                // ── Slope → bare rock / scree tint ────────────────────────
                const rockBlend = Math.pow(slopeMag, 1.6) * 0.72;
                r = r * (1 - rockBlend) + 0.38 * rockBlend;
                g = g * (1 - rockBlend) + 0.31 * rockBlend;
                b = b * (1 - rockBlend) + 0.24 * rockBlend;

                // ── High elevation snow cap (> 3 000 m, full white 5 000 m) ─
                const snowT = THREE.MathUtils.clamp((hM - 3000) / 2000, 0, 1);
                r += (0.90 - r) * snowT;
                g += (0.93 - g) * snowT;
                b += (0.97 - b) * snowT;

                // ── Valley floor depth shadow ──────────────────────────────
                const below = THREE.MathUtils.clamp((cityHM - hM) / 900, 0, 0.40);
                r = Math.max(0, r - below * 0.28);
                g = Math.max(0, g - below * 0.20);
                b = Math.max(0, b - below * 0.08);

                colors[i * 3]     = Math.min(1, r);
                colors[i * 3 + 1] = Math.min(1, g);
                colors[i * 3 + 2] = Math.min(1, b);
            }

            pos.needsUpdate = true;

            // ── Save local 0-1 UVs before remapping ───────────────────────────
            // PlaneGeometry defaults to 0-1 UVs across the patch.  These are
            // needed for the edge fade in the fragment shader.  We store them as
            // a custom attribute before overwriting uv with global map coords.
            const localUVArray = new Float32Array(geo.attributes.uv.array);
            geo.setAttribute('aLocalUV', new THREE.BufferAttribute(localUVArray, 2));

            // ── Remap UVs to global map coordinates ───────────────────────────
            const uvAttr = geo.attributes.uv;
            for (let i = 0; i < pos.count; i++) {
                const vx = x + pos.getX(i);
                const vz = z + pos.getZ(i);
                uvAttr.setXY(
                    i,
                    vx / MAP_WIDTH  + 0.5,
                    0.5 - vz / MAP_HEIGHT
                );
            }
            uvAttr.needsUpdate = true;

            geo.computeVertexNormals();
            geo.setAttribute('color',     new THREE.BufferAttribute(colors,    3));
            geo.setAttribute('aSlope',    new THREE.BufferAttribute(slopes,    1));
            geo.setAttribute('aTrueElev', new THREE.BufferAttribute(trueElevs, 1));

            const mat = new THREE.MeshStandardMaterial({
                vertexColors:        true,
                roughness:           0.82,
                metalness:           0.04,
                transparent:         true,
                opacity:             0,
                depthWrite:          true,
                polygonOffset:       true,
                polygonOffsetFactor: -2,
                polygonOffsetUnits:  -2,
            });

            if (this._normalMapTex) {
                mat.normalMap   = this._normalMapTex;
                mat.normalScale = new THREE.Vector2(3.0, 3.0);
            }

            mat.onBeforeCompile = (shader) => {
                shader.vertexShader = `
                    attribute float aSlope;
                    attribute float aTrueElev;
                    attribute vec2  aLocalUV;
                    varying   float vSlope;
                    varying   float vTrueElev;
                    varying   vec2  vLocalUV;
                    ${shader.vertexShader}
                `.replace(
                    `#include <color_vertex>`,
                    `#include <color_vertex>
                     vSlope    = aSlope;
                     vTrueElev = aTrueElev;
                     vLocalUV  = aLocalUV;`
                );

                shader.fragmentShader = `
                    varying float vSlope;
                    varying float vTrueElev;
                    varying vec2  vLocalUV;
                    ${shader.fragmentShader}
                `.replace(
                    `#include <dithering_fragment>`,
                    `#include <dithering_fragment>

                    // ── Ocean discard — clip fragments over water ─────────
                    // vTrueElev is real-world metres from the DEM.
                    // -2.0 gives a small tidal buffer so beach edges aren't clipped.
                    if (vTrueElev < -2.0) discard;

                    // ── Topographic isolines ──────────────────────────────
                    float minorMod  = mod(abs(vTrueElev), 500.0);
                    float minorEdge = min(minorMod, 500.0  - minorMod);
                    float isMinor   = (1.0 - smoothstep(0.0, 22.0, minorEdge));

                    float majorMod  = mod(abs(vTrueElev), 2500.0);
                    float majorEdge = min(majorMod, 2500.0 - majorMod);
                    float isMajor   = (1.0 - smoothstep(0.0, 38.0, majorEdge));

                    gl_FragColor.rgb = mix(gl_FragColor.rgb,
                        gl_FragColor.rgb * 0.40 + vec3(0.05, 0.70, 0.90) * 0.9,
                        isMinor * 0.50);
                    gl_FragColor.rgb = mix(gl_FragColor.rgb,
                        gl_FragColor.rgb * 0.20 + vec3(1.00, 0.52, 0.08) * 1.1,
                        isMajor * 0.75);

                    // ── Ridge / edge glow ─────────────────────────────────
                    float ridgePow    = pow(vSlope, 2.2);
                    vec3  ridgeAccent = mix(vec3(0.18, 0.68, 1.00),
                                           vec3(1.00, 0.96, 0.82),
                                           ridgePow);
                    gl_FragColor.rgb  = mix(gl_FragColor.rgb,
                        gl_FragColor.rgb + ridgeAccent * 0.45,
                        ridgePow * 0.55);

                    // ── UV edge fade — soft blend at patch boundary ───────
                    // Uses local 0-1 UVs so the 12% fade width is consistent
                    // regardless of patch scale or global UV remapping.
                    vec2 ef = smoothstep(0.0, 0.12, vLocalUV)
                            * smoothstep(1.0, 0.88, vLocalUV);
                    gl_FragColor.a *= ef.x * ef.y;
                    `
                );
            };

            const mesh = new THREE.Mesh(geo, mat);
            mesh.visible     = false;
            mesh.renderOrder = 2;
            this._group.add(mesh);
            this._terrainPatches.push({ mesh, mat, cx: x, cz: z });
        });
    }

    // ── Per-frame update: terrain patch LOD visibility ────────────────────────
    update(camera) {
        const cam = camera.position;

        // Mesh terrain patches: fade in between dist 50 → 30.
        this._terrainPatches.forEach(({ mesh, mat, cx, cz }) => {
            // Height gate — patches are close-zoom only; never show at strategic
            // altitude. Without this, panning to a city at camera.y > 60 brings
            // the XZ distance below the 50-unit threshold and the patch activates
            // as a large floating tile overlay visible from far above.
            if (cam.y >= 60) {
                if (mesh.visible) { mesh.visible = false; mat.opacity = 0; }
                return;
            }
            const dx = cam.x - cx;
            const dz = cam.z - cz;
            const d  = Math.sqrt(dx * dx + dz * dz);
            const a  = THREE.MathUtils.clamp((50 - d) / 20, 0, 1);
            if (a > 0 !== mesh.visible) mesh.visible = a > 0;
            if (mesh.visible) mat.opacity = a;
        });
    }

    // ── Switch visual mode ────────────────────────────────────────────────────
    setMode(mode) {
        if (mode === this._mode) return;
        this._mode = mode;
    }

    // ── Dispose ───────────────────────────────────────────────────────────────
    dispose() {
        this._terrainPatches.forEach(({ mesh, mat }) => {
            this._group.remove(mesh);
            mesh.geometry.dispose();
            mat.dispose();
        });
        this._scene.remove(this._group);
    }
}
