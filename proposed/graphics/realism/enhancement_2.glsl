// waterManager.js — Injects Gerstner Wave mathematics into a standard material
// with subsurface scattering approximation and Fresnel foam lines
import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT, WATER_OPACITY } from './config.js';

// Global uniforms — updated from the main animation loop and SkyManager
export const waterUniforms = {
    uTime:             { value: 0.0 },
    uSunDir:           { value: new THREE.Vector3(0.0, 1.0, 0.0) },
    uSunElevation:     { value: 1.0 },
    uHexGridScale:     { value: 18.0 },
    uHexGridIntensity: { value: 3.0  },
};

export function createDynamicSeaLevel(scene) {
    const seaLevelGroup = new THREE.Group();
    seaLevelGroup.name = 'dynamicSeaLevel';

    // 256×256 gives ~66k vertices — good balance of detail vs performance
    const geo = new THREE.PlaneGeometry(MAP_WIDTH, MAP_HEIGHT, 256, 256);
    geo.rotateX(-Math.PI / 2);

    const mat = new THREE.MeshStandardMaterial({
        name:             'Water',
        color:            0x010e22,
        roughness:        0.1,
        metalness:        0.8,
        transparent:      true,
        opacity:          WATER_OPACITY,
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

        // ── VERTEX SHADER INJECTION ────────────────────────────────────────
        // Gerstner wave displacement + export varyings for fragment SSS/foam

        const vertexPreamble = /* glsl */`
            uniform float uTime;

            // Gerstner wave parameters — 4 wave components
            // {dirX, dirZ, steepness, wavelength}
            const vec4 wave1 = vec4(0.6, 0.8,  0.22, 80.0);
            const vec4 wave2 = vec4(0.9, -0.4, 0.18, 55.0);
            const vec4 wave3 = vec4(-0.3, 0.7, 0.12, 120.0);
            const vec4 wave4 = vec4(-0.8, -0.6, 0.08, 200.0);

            varying vec3 vWorldPos;
            varying vec3 vWorldNormal;
            varying float vWaveHeight;   // normalized crest factor for foam
            varying float vWaveCurvature; // surface curvature for foam lines

            vec3 gerstnerWave(vec4 wave, vec3 p, inout vec3 tangent, inout vec3 binormal) {
                float steepness  = wave.z;
                float wavelength = wave.w;
                float k  = 6.28318 / wavelength;
                float c  = sqrt(9.81 / k);
                vec2  d  = normalize(wave.xy);
                float f  = k * (dot(d, p.xz) - c * uTime);
                float a  = steepness / k;

                tangent  += vec3(
                    -d.x * d.x * steepness * sin(f),
                     d.x * steepness * cos(f),
                    -d.x * d.y * steepness * sin(f)
                );
                binormal += vec3(
                    -d.x * d.y * steepness * sin(f),
                     d.y * steepness * cos(f),
                    -d.y * d.y * steepness * sin(f)
                );

                return vec3(
                    d.x * a * cos(f),
                    a * sin(f),
                    d.y * a * cos(f)
                );
            }
        `;

        const vertexDisplacement = /* glsl */`
            vec3 pos = transformed;

            vec3 tangent  = vec3(1.0, 0.0, 0.0);
            vec3 binormal = vec3(0.0, 0.0, 1.0);

            vec3 displacement = vec3(0.0);
            displacement += gerstnerWave(wave1, pos, tangent, binormal);
            displacement += gerstnerWave(wave2, pos, tangent, binormal);
            displacement += gerstnerWave(wave3, pos, tangent, binormal);
            displacement += gerstnerWave(wave4, pos, tangent, binormal);

            pos += displacement;
            transformed = pos;

            // Compute Gerstner normal
            vec3 gerstnerNormal = normalize(cross(binormal, tangent));
            objectNormal = gerstnerNormal;

            // Wave height: how far above rest position (for foam/crest detection)
            vWaveHeight = displacement.y;

            // Curvature estimate: second derivative approximation
            // High curvature = sharp crest = foam line candidate
            // Use the tangent/binormal divergence as a proxy
            float tangentLen = length(tangent);
            float binormalLen = length(binormal);
            vWaveCurvature = max(0.0, 2.0 - tangentLen - binormalLen);

            // Pass world-space position and normal to fragment
            vec4 worldPos4 = modelMatrix * vec4(pos, 1.0);
            vWorldPos = worldPos4.xyz;
            vWorldNormal = normalize((modelMatrix * vec4(gerstnerNormal, 0.0)).xyz);
        `;

        // Inject vertex preamble before main()
        shader.vertexShader = shader.vertexShader.replace(
            'void main() {',
            vertexPreamble + '\nvoid main() {'
        );

        // Inject displacement before the project_vertex chunk
        shader.vertexShader = shader.vertexShader.replace(
            '#include <project_vertex>',
            vertexDisplacement + '\n#include <project_vertex>'
        );

        // ── FRAGMENT SHADER INJECTION ──────────────────────────────────────
        // SSS approximation, Fresnel, foam lines

        const fragmentPreamble = /* glsl */`
            uniform float uTime;
            uniform vec3  uSunDir;
            uniform float uSunElevation;
            uniform float uHexGridScale;
            uniform float uHexGridIntensity;

            varying vec3  vWorldPos;
            varying vec3  vWorldNormal;
            varying float vWaveHeight;
            varying float vWaveCurvature;

            // ── Hex grid (existing tactical overlay) ───────────────────────
            float hexGrid(vec2 p, float scale) {
                p *= scale;
                vec2 h = vec2(1.0, sqrt(3.0));
                vec2 a = mod(p, h) - h * 0.5;
                vec2 b = mod(p + h * 0.5, h) - h * 0.5;
                vec2 g = (dot(a, a) < dot(b, b)) ? a : b;
                float d = max(abs(g.x), abs(g.y * 0.57735 + abs(g.x) * 0.5));
                return smoothstep(0.46, 0.5, d);
            }

            // ── Subsurface scattering approximation ────────────────────────
            // Based on GDC 2011 "Fast Subsurface Scattering" technique.
            // Light enters the wave from behind and exits toward the viewer
            // through thin water at the crest.
            vec3 waterSSS(vec3 viewDir, vec3 normal, vec3 sunDir, float waveHeight) {
                // Wrap the light direction around/through the surface
                vec3 H = normalize(sunDir + normal * 0.6);
                float VdotH = pow(clamp(dot(viewDir, -H), 0.0, 1.0), 3.0);

                // SSS color — deep teal with cyan highlight at crests
                vec3 sssColor = mix(
                    vec3(0.0, 0.06, 0.12),  // deep water interior
                    vec3(0.02, 0.28, 0.32),  // thin water at crest
                    clamp(waveHeight * 0.5 + 0.5, 0.0, 1.0)
                );

                // Thickness — thinner at crests (more light passes through)
                float thickness = clamp(1.0 - waveHeight * 0.4, 0.1, 1.0);
                float sssStrength = VdotH * (1.0 - thickness);

                return sssColor * sssStrength;
            }

            // ── Fresnel approximation (Schlick) ────────────────────────────
            float fresnelSchlick(float cosTheta, float F0) {
                return F0 + (1.0 - F0) * pow(1.0 - cosTheta, 5.0);
            }
        `;

        const fragmentSSS = /* glsl */`
            // ── View direction ─────────────────────────────────────────────
            vec3 viewDir = normalize(cameraPosition - vWorldPos);
            vec3 N = normalize(vWorldNormal);

            // ── Day/night factor ───────────────────────────────────────────
            float dayFactor = smoothstep(-0.05, 0.2, uSunElevation);

            // ── Subsurface scattering ──────────────────────────────────────
            vec3 sss = waterSSS(viewDir, N, uSunDir, vWaveHeight);
            sss *= dayFactor * 2.8; // scale for visual impact

            // ── Fresnel ────────────────────────────────────────────────────
            float NdotV = max(dot(N, viewDir), 0.0);
            float fresnel = fresnelSchlick(NdotV, 0.02);

            // ── Foam lines at wave crests ──────────────────────────────────
            // High curvature + positive wave height = crest foam
            float crestFactor = smoothstep(0.6, 1.8, vWaveHeight)
                              * smoothstep(0.05, 0.3, vWaveCurvature);

            // Add some noise variation to break up uniform foam lines
            float foamNoise = fract(sin(dot(vWorldPos.xz * 0.15, vec2(12.9898, 78.233))) * 43758.5453);
            crestFactor *= smoothstep(0.2, 0.6, foamNoise);

            // Foam color — bright white-blue, modulated by fresnel
            vec3 foamColor = vec3(0.6, 0.7, 0.8) * crestFactor * (0.3 + fresnel * 0.7);
            foamColor *= mix(0.15, 1.0, dayFactor); // visible but dim at night

            // ── Hex grid (tactical overlay) ────────────────────────────────
            float grid = hexGrid(vWorldPos.xz, uHexGridScale) * uHexGridIntensity * 0.06;
            vec3 gridColor = vec3(0.1, 0.4, 0.7) * grid;

            // ── Combine into emissive ──────────────────────────────────────
            // SSS + foam + hex grid all contribute to emissive channel
            vec3 additionalEmissive = sss + foamColor + gridColor;

            // Fresnel-based rim darkening for depth perception
            // Shallow angle = more reflective = slightly brighter emissive
            additionalEmissive += vec3(0.01, 0.03, 0.06) * fresnel * dayFactor;

            gl_FragColor.rgb += additionalEmissive;
        `;

        // Inject fragment preamble
        shader.fragmentShader = shader.fragmentShader.replace(
            'void main() {',
            fragmentPreamble + '\nvoid main() {'
        );

        // Inject SSS/foam/grid AFTER the standard material's output
        // This goes right before the closing brace of main()
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <dithering_fragment>',
            '#include <dithering_fragment>\n' + fragmentSSS
        );
    };

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name      = 'ocean';
    mesh.position.y = 0;
    mesh.receiveShadow = true;
    seaLevelGroup.add(mesh);

    scene.add(seaLevelGroup);
    return seaLevelGroup;
}

// ── Per-frame update (called from main loop) ──────────────────────────────────
export function updateWater(deltaTime) {
    waterUniforms.uTime.value += deltaTime;
}

// ── Sun state sync (called from SkyManager) ──────────────────────────────────
export function updateWaterSun(sunDir, sunElevation) {
    waterUniforms.uSunDir.value.copy(sunDir);
    waterUniforms.uSunElevation.value = sunElevation;
}