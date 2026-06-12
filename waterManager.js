// waterManager.js — Injects Gerstner Wave mathematics into a standard material
import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT, WATER_OPACITY } from './config.js';

// Global uniforms — updated from the main animation loop and SkyManager
export const waterUniforms = {
    uTime:             { value: 0.0 },
    uSunDir:           { value: new THREE.Vector3(0.0, 1.0, 0.0) },
    uSunElevation:     { value: 1.0 },
    uHexGridScale:     { value: 18.0 }, // cell size — larger = smaller cells
    uHexGridIntensity: { value: 3.0  }, // master brightness, 0 = off
};

export function createDynamicSeaLevel(scene) {
    const seaLevelGroup = new THREE.Group();
    seaLevelGroup.name = 'dynamicSeaLevel';

    // 1. High-Resolution Ocean Mesh
    // 256×256 gives ~66k vertices — quarter the vertex count of 512×512 with
    // imperceptible loss of wave detail at any tactical viewing distance.
    const geo = new THREE.PlaneGeometry(MAP_WIDTH, MAP_HEIGHT, 256, 256);
    geo.rotateX(-Math.PI / 2);

    const mat = new THREE.MeshStandardMaterial({
        name:             'Water',
        color:            0x010e22,   // slightly deeper base — was 0x011a33
        roughness:        0.1,
        metalness:        0.8,
        transparent:      true,
        opacity:          WATER_OPACITY,
        // Emissive keeps the water visible at low ambient light.
        // Reduced from 0.75 → 0.38 so the ocean sits in a clearly darker
        // luminance band than the land terrain (figure-ground separation).
        emissive:         0x04213d,
        emissiveIntensity: 0.38,
    });

    // Inject GLSL directly into the Three.js Standard Shader
    mat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime             = waterUniforms.uTime;
        shader.uniforms.uSunDir           = waterUniforms.uSunDir;
        shader.uniforms.uSunElevation     = waterUniforms.uSunElevation;
        shader.uniforms.uHexGridScale     = waterUniforms.uHexGridScale;
        shader.uniforms.uHexGridIntensity = waterUniforms.uHexGridIntensity;
        
        shader.vertexShader = `
            uniform float uTime;
            varying float vWaveHeight;
            varying vec3  vWorldNormal;
            varying vec3  vWorldPos;

            // Gerstner Wave parameters: direction(x,y), steepness(z), wavelength(w)
            // Steepness tripled from original — makes crests clearly visible.
            // waveD adds short cross-chop for surface texture detail.
            vec4 waveA = vec4( 1.0,  0.5,  0.22, 15.0);  // primary swell
            vec4 waveB = vec4( 0.8,  0.6,  0.16, 25.0);  // secondary long swell
            vec4 waveC = vec4(-0.2, -0.6,  0.18, 10.0);  // counter-swell
            vec4 waveD = vec4(-0.6,  0.4,  0.10,  6.0);  // short cross-chop

            vec3 gerstnerWave(vec4 wave, vec3 p, inout vec3 tangent, inout vec3 binormal) {
                float steepness  = wave.z;
                float wavelength = wave.w;
                float k  = 2.0 * 3.14159 / wavelength;
                float c  = sqrt(9.8 / k);
                vec2  d  = normalize(wave.xy);
                float f  = k * (dot(d, p.xz) - c * uTime * 0.55); // 0.55 — slightly faster
                float a  = steepness / k;

                tangent += vec3(
                    -d.x * d.x * (steepness * sin(f)),
                     d.x *        (steepness * cos(f)),
                    -d.x * d.y * (steepness * sin(f))
                );
                binormal += vec3(
                    -d.x * d.y * (steepness * sin(f)),
                     d.y *        (steepness * cos(f)),
                    -d.y * d.y * (steepness * sin(f))
                );

                return vec3(
                    d.x * (a * cos(f)),
                    a   *       sin(f),
                    d.y * (a * cos(f))
                );
            }

            ${shader.vertexShader}
        `.replace(
            `#include <begin_vertex>`,
            `
            vec3 gridPoint = position;
            vec3 tangent  = vec3(1.0, 0.0, 0.0);
            vec3 binormal = vec3(0.0, 0.0, 1.0);
            vec3 p = gridPoint;

            p += gerstnerWave(waveA, gridPoint, tangent, binormal);
            p += gerstnerWave(waveB, gridPoint, tangent, binormal);
            p += gerstnerWave(waveC, gridPoint, tangent, binormal);
            p += gerstnerWave(waveD, gridPoint, tangent, binormal);

            // Pass the normalised crest height to the fragment stage.
            // waveA amplitude ≈ steepness/k = 0.22/(2π/15) ≈ 0.525 scene units;
            // four waves summed → max ~1.5 — divide by 1.5 to keep 0‥1 range.
            vWaveHeight = clamp(p.y / 1.5, 0.0, 1.0);

            vec3 transformed = p;

            vec3 waveNormal = normalize(cross(binormal, tangent));

            // World-space normal + position for Fresnel sky reflection in fragment.
            // mat3(modelMatrix) strips translation and handles the -90° rotateX baked
            // into the plane geometry, giving a correct upward-facing world normal.
            vWorldNormal = normalize(mat3(modelMatrix) * waveNormal);
            vWorldPos    = (modelMatrix * vec4(p, 1.0)).xyz;
            `
        ).replace(
            `#include <beginnormal_vertex>`,
            `
            vec3 objectNormal = waveNormal;
            `
        );

        // Inject FBM (fractal Brownian motion) noise into the vertex stage
        // so fine-scale ripple detail rides on top of the Gerstner waves.
        // Two octaves of scrolling hash noise perturb the surface normal in
        // the tangent plane — no extra displacement, just normal variance.
        // uTime * 0.18 keeps the micro-ripples slower than the main swell.
        shader.vertexShader = shader.vertexShader.replace(
            `vWorldNormal = normalize(mat3(modelMatrix) * waveNormal);`,
            `
            // ── FBM micro-ripple normal perturbation ──────────────────────
            // Two octaves of scrolling value-noise shift the wave normal in
            // the tangent plane, creating sub-wavelength capillary texture.
            vec2 fbmUV = p.xz * 0.18 + vec2(uTime * 0.18, uTime * 0.11);
            // Hash-based pseudo-noise (no texture required)
            vec2 fbmI  = floor(fbmUV);
            vec2 fbmF  = fract(fbmUV);
            fbmF       = fbmF * fbmF * (3.0 - 2.0 * fbmF);  // smoothstep
            float h00  = fract(sin(dot(fbmI + vec2(0,0), vec2(127.1, 311.7))) * 43758.5);
            float h10  = fract(sin(dot(fbmI + vec2(1,0), vec2(127.1, 311.7))) * 43758.5);
            float h01  = fract(sin(dot(fbmI + vec2(0,1), vec2(127.1, 311.7))) * 43758.5);
            float h11  = fract(sin(dot(fbmI + vec2(1,1), vec2(127.1, 311.7))) * 43758.5);
            float fbm1 = mix(mix(h00, h10, fbmF.x), mix(h01, h11, fbmF.x), fbmF.y);
            // Second octave — finer scale, scrolling orthogonally
            vec2 fbmUV2 = p.xz * 0.40 + vec2(-uTime * 0.09, uTime * 0.14);
            vec2 fbmI2  = floor(fbmUV2);
            vec2 fbmF2  = fract(fbmUV2);
            fbmF2       = fbmF2 * fbmF2 * (3.0 - 2.0 * fbmF2);
            float g00   = fract(sin(dot(fbmI2 + vec2(0,0), vec2(269.5, 183.3))) * 43758.5);
            float g10   = fract(sin(dot(fbmI2 + vec2(1,0), vec2(269.5, 183.3))) * 43758.5);
            float g01   = fract(sin(dot(fbmI2 + vec2(0,1), vec2(269.5, 183.3))) * 43758.5);
            float g11   = fract(sin(dot(fbmI2 + vec2(1,1), vec2(269.5, 183.3))) * 43758.5);
            float fbm2  = mix(mix(g00, g10, fbmF2.x), mix(g01, g11, fbmF2.x), fbmF2.y);
            // Combine: map [0,1] → [-1,1] then weight by 0.12 so Gerstner
            // normals still dominate and the effect stays physically plausible.
            vec2 microNorm  = (vec2(fbm1, fbm2) * 2.0 - 1.0) * 0.12;
            vec3 perturbedN = normalize(waveNormal
                + tangent  * microNorm.x
                + binormal * microNorm.y);
            vWorldNormal = normalize(mat3(modelMatrix) * perturbedN);`
        );

        // Foam in the fragment stage — runs after all Three.js lighting so
        // we blend on top of the lit ocean colour rather than under it.
        shader.fragmentShader = `
            uniform vec3  uSunDir;
            uniform float uSunElevation;
            uniform float uHexGridScale;
            uniform float uHexGridIntensity;
            varying float vWaveHeight;
            varying vec3  vWorldNormal;
            varying vec3  vWorldPos;
            ${shader.fragmentShader}
        `.replace(
            `#include <dithering_fragment>`,
            `#include <dithering_fragment>

            // ── Crest foam ────────────────────────────────────────────────────
            float crestFoam = smoothstep(0.25, 0.65, vWaveHeight);
            gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.65, 0.82, 1.0), crestFoam * 0.55);
            gl_FragColor.a   = min(1.0, gl_FragColor.a + crestFoam * 0.15);

            // ── Fresnel sky reflection ─────────────────────────────────────────
            vec3  viewDir  = normalize(cameraPosition - vWorldPos);
            float cosTheta = max(0.0, dot(viewDir, vWorldNormal));
            float fresnel  = 0.04 + 0.96 * pow(1.0 - cosTheta, 5.0);
            fresnel = clamp(fresnel * 0.55, 0.0, 0.38);

            vec3 reflDir = reflect(-viewDir, vWorldNormal);

            // ── Sun-driven sky palette ────────────────────────────────────────
            // uSunElevation: -1 = midnight, 0 = horizon, 1 = zenith
            float dayAmt   = clamp(uSunElevation * 2.0, 0.0, 1.0);
            float dawnAmt  = pow(max(0.0, 1.0 - abs(uSunElevation) * 3.5), 2.0);

            // Zenith: near-black at night, deep tactical navy at noon
            vec3 zenithNight = vec3(0.003, 0.005, 0.015);
            vec3 zenithDay   = vec3(0.010, 0.040, 0.140);
            vec3 zenithCol   = mix(zenithNight, zenithDay, dayAmt);

            // Horizon: black at night, blue at day, amber at dawn/dusk
            vec3 horizNight  = vec3(0.003, 0.005, 0.010);
            vec3 horizDay    = vec3(0.020, 0.090, 0.220);
            vec3 horizDawn   = vec3(0.200, 0.090, 0.025);
            vec3 horizCol    = mix(horizNight, horizDay, dayAmt);
            horizCol         = mix(horizCol, horizDawn, dawnAmt * 0.75);

            // Blend zenith / horizon by reflection elevation
            float skyT   = clamp(reflDir.y, 0.0, 1.0);
            vec3  skyCol = mix(horizCol, zenithCol, skyT);

            // Narrow horizon shimmer band
            float horizBand = pow(max(0.0, 1.0 - abs(reflDir.y)), 14.0);
            skyCol         += horizCol * horizBand * 0.55;

            // Sun specular highlight in the reflection — small disk, warm colour
            float sunSpec = pow(max(0.0, dot(reflDir, uSunDir)), 180.0);
            skyCol       += vec3(1.0, 0.85, 0.55) * sunSpec * clamp(uSunElevation, 0.0, 1.0) * 0.8;

            gl_FragColor.rgb = mix(gl_FragColor.rgb, skyCol, fresnel);

            // ── Hex Depth Grid ────────────────────────────────────────────────────
            // World UV in [-0.5, +0.5] across the 300-unit map
            vec2 hg_wUV = vWorldPos.xz / 300.0;

            // Two-octave value noise — simulates depth variation across the ocean.
            // No texture needed: pure hash math.
            vec2 hg_p1 = floor(hg_wUV * 5.0);
            vec2 hg_f1 = fract(hg_wUV * 5.0);
            hg_f1 = hg_f1 * hg_f1 * (3.0 - 2.0 * hg_f1);
            float hg_n1 = mix(
                mix(fract(sin(dot(hg_p1,              vec2(127.1,311.7)))*43758.5),
                    fract(sin(dot(hg_p1+vec2(1,0),    vec2(127.1,311.7)))*43758.5), hg_f1.x),
                mix(fract(sin(dot(hg_p1+vec2(0,1),    vec2(127.1,311.7)))*43758.5),
                    fract(sin(dot(hg_p1+vec2(1,1),    vec2(127.1,311.7)))*43758.5), hg_f1.x),
                hg_f1.y);

            vec2 hg_p2 = floor(hg_wUV * 11.0);
            vec2 hg_f2 = fract(hg_wUV * 11.0);
            hg_f2 = hg_f2 * hg_f2 * (3.0 - 2.0 * hg_f2);
            float hg_n2 = mix(
                mix(fract(sin(dot(hg_p2,              vec2(269.5,183.3)))*43758.5),
                    fract(sin(dot(hg_p2+vec2(1,0),    vec2(269.5,183.3)))*43758.5), hg_f2.x),
                mix(fract(sin(dot(hg_p2+vec2(0,1),    vec2(269.5,183.3)))*43758.5),
                    fract(sin(dot(hg_p2+vec2(1,1),    vec2(269.5,183.3)))*43758.5), hg_f2.x),
                hg_f2.y);

            float hg_depth = pow(hg_n1 * 0.65 + hg_n2 * 0.35, 1.4);

            // Faint depth-responsive teal lift on shallower regions
            gl_FragColor.rgb += vec3(0.0, 0.055, 0.08) * hg_depth * 0.6 * uHexGridIntensity;

            // Animated UV distortion — slow holographic wobble
            vec2 hg_uv = hg_wUV;
            hg_uv.x += sin(hg_wUV.y * 6.0 + uTime * 0.07) * 0.006;
            hg_uv.y += cos(hg_wUV.x * 5.0 + uTime * 0.05) * 0.006;
            hg_uv *= uHexGridScale;

            // Axial hex grid (equilateral, flat-top)
            // Fold space into one repeating hex cell, measure dist to edge.
            vec2 hg_r = vec2(1.7320508, 1.0);
            vec2 hg_a = mod(hg_uv,           hg_r) - hg_r * 0.5;
            vec2 hg_b = mod(hg_uv + hg_r * 0.5, hg_r) - hg_r * 0.5;
            // Pick whichever fold is closer to the hex centre — no ternary
            float hg_pickB = step(dot(hg_b, hg_b), dot(hg_a, hg_a));
            vec2  hg_g     = mix(hg_a, hg_b, hg_pickB);

            // Hexagonal Chebyshev distance to cell edge
            float hg_dist = max(abs(hg_g.x) * 0.866025 + abs(hg_g.y) * 0.5, abs(hg_g.y));

            // Thin grid line where dist approaches 0.5 (cell boundary)
            float hg_line = smoothstep(0.47, 0.44, hg_dist);

            // Faint node glow at hex vertices
            float hg_node = smoothstep(0.495, 0.48, hg_dist) * smoothstep(0.46, 0.48, hg_dist);

            float hg_lo = (0.04 + hg_depth * 0.04) * hg_line;
            float hg_no = (0.06 + hg_depth * 0.06) * hg_node;
            gl_FragColor.rgb += vec3(0.06, 0.42, 0.55) * (hg_lo + hg_no) * uHexGridIntensity;

            // ── Edge fade — kills the visible rectangle border ─────────────────
            // vUv is not declared in Three.js r184 for materials without texture
            // maps (USE_UV is not set), so we use vWorldPos.xz instead.
            // Fade zone: outer 15 units (~5% of 300-unit map) on all four sides.
            float ef_x = smoothstep( 0.0, 15.0, 150.0 - abs( vWorldPos.x ) );
            float ef_z = smoothstep( 0.0, 15.0, 150.0 - abs( vWorldPos.z ) );
            gl_FragColor.a *= ef_x * ef_z;
            `
        );
    };

    const seaMesh = new THREE.Mesh(geo, mat);
    seaMesh.position.y = -0.2; // Sit slightly below the land splats
    seaLevelGroup.add(seaMesh);

    // Dark wash plane REMOVED. It was a near-black PlaneGeometry at Y=-2.5
    // covering the full map extent, used to deepen the ocean into a lower-
    // luminance band so land read as figure against ocean ground. From low-
    // tilt camera angles its rectangular boundary showed as a visible dark
    // panel — same cover-up-creates-its-own-edge pattern the aquarium walls
    // had. Figure/ground separation will instead come from richer bathymetry
    // (real depth-gradient colour on the ocean-floor splats).

    // Polar grid overlay REMOVED. Was a PolarGridHelper at Y=2.0 with
    // camera-height-driven opacity (see deleted block in updateDynamicWater).
    // The concentric circles + radial lines were a command-center aesthetic
    // cue but cluttered the map at oblique angles.

    // Expose for live console tuning:
    //   window.waterUniforms.uHexGridIntensity.value = 5.0
    //   window.waterUniforms.uHexGridScale.value = 12.0
    window.waterUniforms = waterUniforms;

    scene.add(seaLevelGroup);
    return seaLevelGroup;
}

// Call this from the main animation loop.
// cameraY is accepted for API compatibility — previously drove polar-grid
// opacity, but the grid is gone now and cameraY is currently unused.
export function updateDynamicWater(time, _cameraY = 500) {
    waterUniforms.uTime.value = time;
}