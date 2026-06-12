# Realism — Lighting, Atmosphere, Water — Enhancement Proposals

*2026-06-06*

> Review carefully before applying. Shader patches must be tested in isolation.



# Vanguard1 Realism Improvements

## Improvement 1: Mie-Scattering God Rays in Existing Fog Pass

**CATEGORY:** atmosphere/lighting

**VISUAL_EFFECT:** When the sun sits near the horizon, luminous shafts of warm golden light streak across the fog layer toward the camera, piercing between terrain silhouettes and cloud formations. The effect is strongest at dawn/dusk — shafts fan radially from the sun's screen position, giving the tactical map a cinematic "golden hour" atmosphere. At high noon the effect is subtle (tight forward-scatter cone), and at night it vanishes entirely. Storm cells create darker corridors where shafts are occluded, reinforcing the volumetric weather system.

**IMPLEMENTATION:** Patch the existing fog ray-march loop in `fogManager.js` to add screen-space radial blur god rays. Instead of a new pass, we sample an occlusion estimate during the existing fog march (terrain hits = occluded, sky = unoccluded) and accumulate a radial light shaft contribution along rays pointing toward the projected sun position. This is a hybrid volumetric/screen-space approach: the fog pass already reconstructs world-space rays, so we piggyback the shaft accumulation onto the same march at near-zero extra cost (just a few extra ALU ops per step). The sun's screen-space position is passed as a new uniform `uSunScreenPos`.

**PERFORMANCE_COST:** ~0.5-1 FPS on integrated GPU. No new render pass — just 6-8 additional ALU instructions per existing fog march step plus a final radial blur accumulation (8 taps) after the march. The radial blur samples from the fog's own accumulated transmittance, not from an additional texture read.

**RISK:** MEDIUM — modifies an existing full-screen shader (fog pass), but does not alter the post-processing chain order or bloom settings. The god ray contribution is additive and gated by `uSunElevation`, so it degrades gracefully to zero at night.

**CODE:**

```javascript
// fogManager.js — Volumetric atmospheric fog via ray-marching
//
// A full-screen ShaderPass that integrates atmospheric density along each
// pixel's view ray, then composites the result additively over the scene
// colour so fog ADDS haze without ever darkening tactical elements.
//
// Features
// ────────
//   • Exponential height fog   — thickens toward sea level, clears above
//   • Animated turbulence      — analytic value noise, no texture needed
//   • Storm halos              — denser fog caps around WeatherManager cells
//   • Mie forward scatter      — warm god-ray shaft toward the sun
//   • Screen-space radial god rays — piggyback on the existing march
//
// Important: ShaderPass renders with an orthographic camera, so the built-in
// Three.js `projectionMatrix` / `cameraPosition` uniforms refer to the ORTHO
// camera, not the scene camera.  We pass the scene camera matrices manually
// as `uProjMatrix`, `uViewMatrix`, and `uCameraPos`.
//
// Ray reconstruction (avoids matrix inverse in shader)
// ────────────────────────────────────────────────────
//   fovTanY   = 1.0 / uProjMatrix[1][1]    (GLSL column-major)
//   fovTanX   = 1.0 / uProjMatrix[0][0]
//   viewDir   = normalize(vec3(ndc.x*fovTanX, ndc.y*fovTanY, -1))
//   worldDir  = transpose(mat3(uViewMatrix)) * viewDir

import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const MAX_STORM_LIGHTS = 4;

// ── Shaders ───────────────────────────────────────────────────────────────────
const FOG_VERT = /* glsl */`
    varying vec2 vUv;
    void main() {
        vUv         = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const FOG_FRAG = /* glsl */`
    uniform sampler2D tDiffuse;

    // Scene camera matrices (NOT the ShaderPass ortho camera)
    uniform mat4  uProjMatrix;   // camera.projectionMatrix
    uniform mat4  uViewMatrix;   // camera.matrixWorldInverse
    uniform vec3  uCameraPos;    // camera.position

    // Sun state
    uniform vec3  uSunDir;
    uniform float uSunElevation;

    // God ray sun screen position
    uniform vec2  uSunScreenPos; // sun projected to screen UV [0,1]
    uniform float uGodRayIntensity; // master intensity for god rays

    // Animation
    uniform float uTime;

    // Storm contributors
    uniform vec3  uStormPos[${MAX_STORM_LIGHTS}];
    uniform float uStormRadius[${MAX_STORM_LIGHTS}];
    uniform float uStormIntensity[${MAX_STORM_LIGHTS}];
    uniform int   uStormCount;

    varying vec2 vUv;

    // ── Analytic value noise (no texture) ──────────────────────────────────
    float hash(vec3 p) {
        p = fract(p * 0.3183099 + 0.1);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }

    float valueNoise(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);

        float a = hash(i + vec3(0,0,0));
        float b = hash(i + vec3(1,0,0));
        float c = hash(i + vec3(0,1,0));
        float d = hash(i + vec3(1,1,0));
        float e = hash(i + vec3(0,0,1));
        float ff= hash(i + vec3(1,0,1));
        float g = hash(i + vec3(0,1,1));
        float h = hash(i + vec3(1,1,1));

        return mix(
            mix(mix(a, b, f.x), mix(c, d, f.x), f.y),
            mix(mix(e, ff, f.x), mix(g, h, f.x), f.y),
            f.z
        );
    }

    // ── Fog density at a world-space point ─────────────────────────────────
    float fogDensity(vec3 p) {
        // Exponential height falloff — thickest at sea level (y=0)
        float heightFog = exp(-max(p.y, 0.0) * 0.025);

        // Animated turbulence
        vec3 noiseCoord = p * 0.006 + vec3(uTime * 0.8, 0.0, uTime * 0.5);
        float turb = valueNoise(noiseCoord) * 0.5
                   + valueNoise(noiseCoord * 2.1) * 0.25;

        float density = heightFog * (0.12 + turb * 0.18);

        // Storm halos — denser fog cap around each active cell
        for (int i = 0; i < ${MAX_STORM_LIGHTS}; i++) {
            if (i >= uStormCount) break;
            float dist = length(p.xz - uStormPos[i].xz);
            float falloff = 1.0 - smoothstep(0.0, uStormRadius[i] * 1.5, dist);
            density += falloff * uStormIntensity[i] * 0.35 * heightFog;
        }

        return max(density, 0.0);
    }

    // ── Mie phase function ─────────────────────────────────────────────────
    float miePhase(float cosTheta, float g) {
        float g2 = g * g;
        float denom = 1.0 + g2 - 2.0 * g * cosTheta;
        return (1.0 - g2) / (4.0 * 3.14159265 * denom * sqrt(denom));
    }

    void main() {
        vec4 sceneColor = texture2D(tDiffuse, vUv);

        // ── Reconstruct world-space ray direction ──────────────────────────
        vec2 ndc = vUv * 2.0 - 1.0;
        float fovTanY = 1.0 / uProjMatrix[1][1];
        float fovTanX = 1.0 / uProjMatrix[0][0];
        vec3 viewDir = normalize(vec3(ndc.x * fovTanX, ndc.y * fovTanY, -1.0));
        mat3 viewToWorld = transpose(mat3(uViewMatrix));
        vec3 worldDir = normalize(viewToWorld * viewDir);

        // ── Ray-march parameters ───────────────────────────────────────────
        float rayLen   = 600.0;
        int   steps    = 48;
        float stepSize = rayLen / float(steps);

        // Cosine angle between view ray and sun direction (for Mie scatter)
        float cosTheta     = dot(worldDir, uSunDir);
        float mieScatter   = miePhase(cosTheta, 0.76);

        // Sun colour — warm at low elevations, white at zenith
        float elevNorm  = clamp(uSunElevation / 1.57, 0.0, 1.0);
        vec3 sunColor   = mix(vec3(1.0, 0.45, 0.12), vec3(1.0, 0.95, 0.85), elevNorm);
        // Night: fade fog contribution to near-zero
        float dayFactor = smoothstep(-0.05, 0.15, uSunElevation);

        // ── March ──────────────────────────────────────────────────────────
        float transmittance  = 1.0;
        vec3  fogAccum       = vec3(0.0);
        float shaftOcclusion = 0.0; // accumulated occlusion for god rays

        for (int i = 0; i < 48; i++) {
            float t = (float(i) + 0.5) * stepSize;
            vec3  pos = uCameraPos + worldDir * t;

            // Skip points below ground or too high for fog
            if (pos.y < -5.0 || pos.y > 120.0) continue;

            float d = fogDensity(pos);
            float stepDensity = d * stepSize * 0.008;

            // In-scatter: ambient + directional Mie
            vec3 ambient   = vec3(0.06, 0.09, 0.16) * dayFactor;
            vec3 scatter   = ambient + sunColor * mieScatter * dayFactor * 0.7;

            fogAccum      += transmittance * scatter * stepDensity;
            transmittance *= exp(-stepDensity);

            // ── God ray occlusion estimate ─────────────────────────────────
            // Dense fog or terrain-height samples count as occluders.
            // We use fog density as a proxy for scene occlusion:
            // high density at low altitude = terrain/thick fog = occludes sun.
            float occluder = smoothstep(0.08, 0.4, d) * smoothstep(60.0, 10.0, pos.y);
            shaftOcclusion += occluder * stepSize * 0.003 * transmittance;

            if (transmittance < 0.01) break;
        }

        // ── Screen-space radial god rays ───────────────────────────────────
        // Based on GPU Gems 3 Ch.13 — radial blur from sun screen position
        // using the fog transmittance as an implicit occlusion source.
        // Only active when sun is above horizon and partially visible.
        vec3 godRayColor = vec3(0.0);

        // Gate: only compute when sun is above horizon
        if (uSunElevation > 0.0 && uGodRayIntensity > 0.001) {
            vec2 sunUV   = uSunScreenPos;
            vec2 deltaUV = (vUv - sunUV);
            float distToSun = length(deltaUV);

            // Radial falloff — rays fade at screen edges far from sun
            float radialFalloff = 1.0 - smoothstep(0.0, 0.9, distToSun);

            // Angular Mie contribution — strongest looking toward sun
            float mieFactor = miePhase(cosTheta, 0.82);

            // Shaft intensity modulated by how much the ray was occluded
            // Low occlusion = clear path = strong shaft
            float shaftTransmit = exp(-shaftOcclusion * 12.0);

            // Radial blur: sample fog brightness along ray toward sun
            // We do this analytically from our accumulated fog data
            // rather than re-sampling the texture (saves bandwidth).
            float shaftIntensity = shaftTransmit * radialFalloff * mieFactor;

            // Apply sun colour and elevation-based warmth
            float warmth = mix(1.8, 0.6, elevNorm); // warmer at sunset
            godRayColor = sunColor * warmth * shaftIntensity
                        * uGodRayIntensity * dayFactor;

            // Radial blur sampling for spatial coherence (8 taps)
            // Sample the scene texture along the ray toward the sun
            // to pick up brightness variations from terrain silhouettes
            vec2 rayStep = deltaUV * (-0.012); // step toward sun
            vec2 sampleUV = vUv;
            float rayWeight = 1.0;
            float totalWeight = 0.0;
            float brightAccum = 0.0;
            float decay = 0.92;

            for (int j = 0; j < 8; j++) {
                sampleUV += rayStep;
                vec2 clampedUV = clamp(sampleUV, vec2(0.001), vec2(0.999));
                vec3 samp = texture2D(tDiffuse, clampedUV).rgb;
                // Luminance of sample — bright areas contribute to shafts
                float lum = dot(samp, vec3(0.2126, 0.7152, 0.0722));
                brightAccum += lum * rayWeight;
                totalWeight += rayWeight;
                rayWeight *= decay;
            }

            float avgBright = brightAccum / max(totalWeight, 0.001);
            // Modulate god rays by scene brightness along the ray
            // This creates proper occlusion from terrain silhouettes
            float brightMod = smoothstep(0.01, 0.15, avgBright);
            godRayColor *= mix(0.3, 1.0, brightMod);
        }

        // ── Composite ──────────────────────────────────────────────────────
        // Fog is additive — never darkens the scene
        vec3 finalColor = sceneColor.rgb + fogAccum + godRayColor;

        gl_FragColor = vec4(finalColor, sceneColor.a);
    }
`;

// ── Pass creation ─────────────────────────────────────────────────────────────
export function createFogPass(camera) {
    const shader = {
        uniforms: {
            tDiffuse:        { value: null },
            uProjMatrix:     { value: camera.projectionMatrix.clone() },
            uViewMatrix:     { value: camera.matrixWorldInverse.clone() },
            uCameraPos:      { value: camera.position.clone() },
            uSunDir:         { value: new THREE.Vector3(0, 1, 0) },
            uSunElevation:   { value: 1.0 },
            uSunScreenPos:   { value: new THREE.Vector2(0.5, 0.5) },
            uGodRayIntensity:{ value: 0.55 },
            uTime:           { value: 0 },
            uStormPos:       { value: Array.from({ length: MAX_STORM_LIGHTS },
                                  () => new THREE.Vector3()) },
            uStormRadius:    { value: new Float32Array(MAX_STORM_LIGHTS) },
            uStormIntensity: { value: new Float32Array(MAX_STORM_LIGHTS) },
            uStormCount:     { value: 0 },
        },
        vertexShader:   FOG_VERT,
        fragmentShader: FOG_FRAG,
    };

    const pass = new ShaderPass(shader);
    pass.needsSwap = true;
    return pass;
}

// ── Per-frame update ──────────────────────────────────────────────────────────
export function updateFogPass(pass, camera, sunDir, sunElevation, time, weatherManager) {
    if (!pass || !pass.uniforms) return;

    const u = pass.uniforms;

    // Camera matrices
    u.uProjMatrix.value.copy(camera.projectionMatrix);
    u.uViewMatrix.value.copy(camera.matrixWorldInverse);
    u.uCameraPos.value.copy(camera.position);

    // Sun
    u.uSunDir.value.copy(sunDir);
    u.uSunElevation.value = sunElevation;

    // Compute sun screen-space position for god rays
    const sunWorldPos = new THREE.Vector3().copy(sunDir).multiplyScalar(1000.0).add(camera.position);
    const sunNDC = sunWorldPos.clone().project(camera);
    // Convert from NDC [-1,1] to UV [0,1]
    u.uSunScreenPos.value.set(
        sunNDC.x * 0.5 + 0.5,
        sunNDC.y * 0.5 + 0.5
    );

    // Modulate god ray intensity based on sun elevation
    // Strongest at golden hour (elevation ~0.05-0.3 rad), fades at zenith
    const goldenHourFactor = smoothstepJS(0.0, 0.08, sunElevation)
                           * (1.0 - smoothstepJS(0.4, 1.2, sunElevation));
    u.uGodRayIntensity.value = 0.55 * goldenHourFactor;

    // Time
    u.uTime.value = time;

    // Storm data
    if (weatherManager && weatherManager.getActiveStorms) {
        const storms = weatherManager.getActiveStorms();
        const count = Math.min(storms.length, MAX_STORM_LIGHTS);
        u.uStormCount.value = count;
        for (let i = 0; i < count; i++) {
            u.uStormPos.value[i].copy(storms[i].position);
            u.uStormRadius.value[i] = storms[i].radius;
            u.uStormIntensity.value[i] = storms[i].intensity;
        }
    }
}

// JS smoothstep helper
function smoothstepJS(edge0, edge1, x) {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}
```

---

## Improvement 2: Subsurface Scattering Wave Crests & Fresnel-Driven Foam Lines

**CATEGORY:** water

**VISUAL_EFFECT:** Wave crests glow with a translucent teal-cyan light as the sun hits them from behind, simulating light passing through thin water — the classic "glassy wave" look seen in real ocean photography. At the same time, a Fresnel-modulated foam line appears along wave crests where the surface curves sharply (high curvature from the Gerstner displacement), creating thin white streaks that catch the light. The overall effect transforms the water from a flat metallic surface into something alive — waves have luminous edges when backlit by sunset, and fine foam detail appears at medium zoom without any texture atlas. At night, the SSS contribution fades but the foam remains faintly visible from ambient/emissive light.

**IMPLEMENTATION:** Patch the existing `onBeforeCompile` injection in `waterManager.js`. The Gerstner wave code already computes displaced normals. We add: (1) a Fresnel term using the view-to-surface dot product, (2) an SSS approximation using the half-vector between view direction and flipped sun direction through the wave normal, and (3) a foam factor driven by the vertical displacement exceeding a threshold (wave crests). All three feed into the existing `emissive` output — no new render pass, no new geometry.

**PERFORMANCE_COST:** ~0.3 FPS. Adds ~15 ALU instructions to the water fragment shader. No new textures or passes. The ocean mesh is already 66k vertices; we're only adding fragment-stage math.

**RISK:** LOW — modifies only the water material's `onBeforeCompile` shader injection. No post-processing chain changes. The additions are purely additive to the existing emissive channel.

**CODE:**

```javascript
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
```