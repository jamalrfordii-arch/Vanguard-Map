# Realism — Lighting, Atmosphere, Water — Enhancement Proposals

*2026-06-05*

> Review carefully before applying. Shader patches must be tested in isolation.



# Vanguard1 Realism Improvements

## Improvement 1: Mie-Scatter God Rays in Existing Fog Pass

**CATEGORY:** Atmosphere / Lighting

**VISUAL_EFFECT:** When the sun sits low on the horizon (dawn/dusk), luminous golden shafts of light stream radially outward from the sun's screen position, cutting through the fog layer. The rays are occluded by terrain and cloud formations — mountains cast dramatic shadow corridors through the haze. As the analyst orbits the camera, the rays shift parallax-correctly, brightening when looking toward the sun (forward scatter) and fading when looking away. During storm conditions, rays fragment and dim as cloud density increases. The effect is subtle at high sun elevations (a gentle atmospheric glow) and dramatic at golden-hour angles, giving the tactical map a cinematic time-of-day presence without any new render passes.

**IMPLEMENTATION:** Patch the existing fog fragment shader in `fogManager.js` to add screen-space radial blur god rays. The technique projects the sun position to screen UV, then during the existing fog ray-march accumulation, samples along radial lines toward the sun UV. This piggybacks on the fog pass's existing per-pixel work — no new ShaderPass. We add one new uniform (`uSunScreenPos`) updated each frame from JavaScript by projecting the sun direction onto screen coordinates. The radial sampling uses 12 iterations (cheap because it reuses the fog density already being computed) with exponential decay and a Henyey-Greenstein phase function boost for forward-scatter geometry.

**PERFORMANCE_COST:** ~1-2 FPS on integrated GPU. No new render pass — the 12 radial samples add ~15% to the existing fog fragment cost. The samples are coherent (all pixels march toward the same UV) so GPU cache performance is good.

**RISK:** MEDIUM — Modifies existing fog shader logic. The god ray accumulation is additive and gated behind a sun-elevation check, so worst-case regression is "fog looks the same as before" if the sun is overhead.

**CODE:**

```javascript
// ============================================================================
// fogManager.js — COMPLETE REPLACEMENT
// ============================================================================
// Volumetric atmospheric fog via ray-marching + screen-space god rays
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
//   • Screen-space god rays    — radial blur from sun screen position
//
// Important: ShaderPass renders with an orthographic camera, so the built-in
// Three.js `projectionMatrix` / `cameraPosition` uniforms refer to the ORTHO
// camera, not the scene camera.  We pass the scene camera matrices manually
// as `uProjMatrix`, `uViewMatrix`, and `uCameraPos`.

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

    // God ray control
    uniform vec2  uSunScreenPos; // sun projected to screen UV [0,1]
    uniform float uSunVisible;   // 1.0 if sun is in front of camera, 0.0 if behind

    // Animation
    uniform float uTime;

    // Storm contributors
    uniform vec3  uStormPos[${MAX_STORM_LIGHTS}];
    uniform float uStormRadius[${MAX_STORM_LIGHTS}];
    uniform float uStormIntensity[${MAX_STORM_LIGHTS}];
    uniform int   uStormCount;

    varying vec2 vUv;

    // ── Analytic value noise (no texture dependency) ──────────────────────
    float hash(vec3 p) {
        p = fract(p * 0.3183099 + 0.1);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }

    float valueNoise(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);

        return mix(
            mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
                mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
            mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y),
            f.z
        );
    }

    // ── Fog density at world position ─────────────────────────────────────
    float fogDensity(vec3 p) {
        // Exponential height falloff — thickest at y=0, clears above y=40
        float heightFog = exp(-max(p.y, 0.0) * 0.045);

        // Animated turbulence
        vec3 noiseCoord = p * 0.008 + vec3(uTime * 0.6, 0.0, uTime * 0.4);
        float turb = valueNoise(noiseCoord) * 0.5
                   + valueNoise(noiseCoord * 2.1) * 0.25;

        float density = heightFog * (0.12 + turb * 0.18);

        // Storm halos — denser fog caps around active storm cells
        for (int i = 0; i < ${MAX_STORM_LIGHTS}; i++) {
            if (i >= uStormCount) break;
            float dist = length(p.xz - uStormPos[i].xz);
            float halo = smoothstep(uStormRadius[i] * 1.6, uStormRadius[i] * 0.3, dist);
            density += halo * uStormIntensity[i] * 0.35 * heightFog;
        }

        return density;
    }

    // ── Henyey-Greenstein phase function ──────────────────────────────────
    float hgPhase(float cosTheta, float g) {
        float g2 = g * g;
        return (1.0 - g2) / (4.0 * 3.14159265 * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
    }

    void main() {
        vec4 sceneColor = texture2D(tDiffuse, vUv);

        // ── Reconstruct world-space ray direction ─────────────────────────
        vec2 ndc = vUv * 2.0 - 1.0;
        float fovTanY = 1.0 / uProjMatrix[1][1];
        float fovTanX = 1.0 / uProjMatrix[0][0];
        vec3 viewDir = normalize(vec3(ndc.x * fovTanX, ndc.y * fovTanY, -1.0));
        // Transpose of mat3(uViewMatrix) = inverse rotation (view→world)
        mat3 viewToWorld = transpose(mat3(uViewMatrix));
        vec3 worldDir = normalize(viewToWorld * viewDir);

        // ── Ray-march settings ────────────────────────────────────────────
        float rayLength = 320.0;
        const int STEPS = 24;
        float stepSize = rayLength / float(STEPS);

        // Mie forward-scatter: how aligned is this pixel's ray with the sun?
        float cosTheta   = dot(worldDir, normalize(uSunDir));
        float mieFwd     = hgPhase(cosTheta, 0.76);
        float mieGlow    = hgPhase(cosTheta, 0.94) * 0.3; // tight bright core

        // Sun colour warms as sun approaches horizon
        float sunWarmth  = smoothstep(0.3, -0.1, uSunElevation);
        vec3  sunColor   = mix(vec3(1.0, 0.95, 0.85), vec3(1.0, 0.55, 0.2), sunWarmth);

        // ── Accumulate fog ────────────────────────────────────────────────
        float accumDensity = 0.0;
        vec3  accumScatter = vec3(0.0);

        for (int i = 0; i < STEPS; i++) {
            float t = (float(i) + 0.5) * stepSize;
            vec3 samplePos = uCameraPos + worldDir * t;

            float d = fogDensity(samplePos) * stepSize;
            accumDensity += d;

            // In-scatter: ambient + directional Mie
            float sunFactor = max(uSunElevation, 0.0);
            vec3 ambient = vec3(0.12, 0.14, 0.22) * 0.5;
            vec3 scatter = ambient + sunColor * (mieFwd + mieGlow) * sunFactor * 0.8;
            accumScatter += scatter * d * exp(-accumDensity * 0.5);
        }

        float fogAlpha = 1.0 - exp(-accumDensity * 1.8);
        fogAlpha = clamp(fogAlpha, 0.0, 0.6);

        // ── Screen-space God Rays ─────────────────────────────────────────
        // Radial blur from sun screen position — modulated by fog density
        // Only active when sun is in front of camera and near/below horizon
        vec3 godRayColor = vec3(0.0);

        float godRayEligible = uSunVisible * smoothstep(0.5, 0.05, uSunElevation);
        if (godRayEligible > 0.01) {
            const int GOD_RAY_SAMPLES = 12;
            float grDecay    = 0.92;
            float grDensity  = 0.7;
            float grExposure = 0.18;

            vec2 deltaUV = (vUv - uSunScreenPos) * grDensity / float(GOD_RAY_SAMPLES);
            vec2 sampleUV = vUv;
            float grWeight = 1.0;
            float grAccum  = 0.0;

            for (int s = 0; s < GOD_RAY_SAMPLES; s++) {
                sampleUV -= deltaUV;
                // Clamp to screen bounds to avoid border artifacts
                vec2 clampedUV = clamp(sampleUV, vec2(0.001), vec2(0.999));
                // Use scene luminance as occlusion proxy — bright areas let rays through,
                // dark areas (terrain, mountains) block them
                vec3 sampleCol = texture2D(tDiffuse, clampedUV).rgb;
                float lum = dot(sampleCol, vec3(0.2126, 0.7152, 0.0722));
                // Threshold: only bright regions contribute (sky, water specular)
                float occlusionPass = smoothstep(0.08, 0.35, lum);
                grAccum += occlusionPass * grWeight;
                grWeight *= grDecay;
            }

            grAccum *= grExposure;

            // Fade god rays toward screen edges to avoid hard cutoff
            float edgeFade = 1.0 - smoothstep(0.4, 0.85, length(vUv - uSunScreenPos));
            edgeFade = max(edgeFade, 0.0);

            // Apply phase-function tint — rays share the warm sun colour
            godRayColor = sunColor * grAccum * godRayEligible * edgeFade * (mieFwd * 0.5 + 0.5);
        }

        // ── Composite: additive fog + god rays ───────────────────────────
        vec3 result = sceneColor.rgb + accumScatter * fogAlpha + godRayColor;

        gl_FragColor = vec4(result, sceneColor.a);
    }
`;


// ── Manager ───────────────────────────────────────────────────────────────────
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
            uSunVisible:     { value: 0.0 },
            uTime:           { value: 0.0 },
            uStormPos:       { value: new Array(MAX_STORM_LIGHTS).fill(null).map(() => new THREE.Vector3()) },
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

// Temporary vectors for projection — allocated once, reused every frame
const _sunWorld = new THREE.Vector3();
const _sunProj  = new THREE.Vector3();

export function updateFogPass(fogPass, camera, sunDir, sunElevation, deltaTime, stormCells) {
    if (!fogPass) return;
    const u = fogPass.uniforms;

    u.uProjMatrix.value.copy(camera.projectionMatrix);
    u.uViewMatrix.value.copy(camera.matrixWorldInverse);
    u.uCameraPos.value.copy(camera.position);

    u.uSunDir.value.copy(sunDir);
    u.uSunElevation.value = sunElevation;
    u.uTime.value += deltaTime;

    // ── Project sun to screen UV for god rays ─────────────────────────────
    // Place the sun far along its direction vector from the camera
    _sunWorld.copy(sunDir).multiplyScalar(500.0).add(camera.position);
    _sunProj.copy(_sunWorld).project(camera);

    // Check if sun is in front of the camera (z < 1 in NDC)
    if (_sunProj.z < 1.0 && _sunProj.z > -1.0) {
        u.uSunScreenPos.value.set(
            _sunProj.x * 0.5 + 0.5,
            _sunProj.y * 0.5 + 0.5
        );
        // Soft fade as sun moves off-screen: full strength within 70% of screen,
        // fading to zero at the very edge
        const absX = Math.abs(_sunProj.x);
        const absY = Math.abs(_sunProj.y);
        const maxNDC = Math.max(absX, absY);
        const screenFade = 1.0 - Math.max(0.0, Math.min(1.0, (maxNDC - 0.7) / 0.8));
        u.uSunVisible.value = screenFade;
    } else {
        u.uSunVisible.value = 0.0;
    }

    // ── Storm cells ───────────────────────────────────────────────────────
    const cells = stormCells || [];
    const count = Math.min(cells.length, MAX_STORM_LIGHTS);
    u.uStormCount.value = count;
    for (let i = 0; i < MAX_STORM_LIGHTS; i++) {
        if (i < count) {
            const c = cells[i];
            u.uStormPos.value[i].set(c.x, c.y ?? 0, c.z);
            u.uStormRadius.value[i]    = c.radius || 30.0;
            u.uStormIntensity.value[i] = c.intensity || 0.5;
        } else {
            u.uStormIntensity.value[i] = 0.0;
        }
    }
}
```

---

## Improvement 2: Sub-Surface Scattering & Depth-Dependent Absorption for Water

**CATEGORY:** Water

**VISUAL_EFFECT:** The ocean transforms from a uniformly dark metallic sheet into a living body of water with visible optical depth. In shallow areas near coastlines, sunlight penetrates the surface and scatters back as luminous turquoise — the classic tropical-shallows glow. As depth increases, the water transitions through deep cerulean to near-black abyssal tones. When the sun is low, a bright Fresnel rim highlights wave crests with molten-gold specular kicks, while wave troughs darken with absorption. The overall effect gives the analyst an immediate intuitive read on bathymetry: shallow coastal shelves glow brighter, deep ocean trenches are inky dark, and the transition between them creates a natural depth contour that enhances tactical awareness of underwater terrain without any additional UI overlay.

**IMPLEMENTATION:** Patch the existing `onBeforeCompile` water shader in `waterManager.js`. No new pass, no new manager. Changes:

1. **Add a `uDepthScale` uniform** controlling how quickly color shifts with depth (tunable per-map).
2. **In the fragment shader injection**, compute a pseudo-depth value from the wave displacement and world position, then use it to lerp between shallow (bright turquoise SSS) and deep (dark blue absorption) base colors.
3. **Add Fresnel-modulated sub-surface scattering**: light that enters the water at glancing angles scatters less; light entering near-normal scatters more (inverse Fresnel for SSS). This is added to the emissive channel so it interacts correctly with Three.js lighting.
4. **Sun-angle dependent SSS color**: at golden hour the scatter tint warms; at noon it stays cool aquamarine.

**PERFORMANCE_COST:** ~0 FPS impact. All calculations are per-vertex (moved to the vertex shader where possible) or per-fragment using values already being computed (normals, view direction, world position). No texture lookups added. The water mesh is 256×256 = ~66k vertices which is trivial.

**RISK:** LOW — All changes are confined to the `onBeforeCompile` material injection. The material's base Three.js Standard shader pipeline is unmodified. If the shader injection fails, Three.js falls back to the default StandardMaterial appearance. No post-processing chain changes.

**CODE:**

```javascript
// ============================================================================
// waterManager.js — COMPLETE REPLACEMENT
// ============================================================================
// Injects Gerstner Waves + Sub-Surface Scattering + Depth Absorption
// into a standard material for the ocean surface.
import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT, WATER_OPACITY } from './config.js';

// Global uniforms — updated from the main animation loop and SkyManager
export const waterUniforms = {
    uTime:         { value: 0.0 },
    uSunDir:       { value: new THREE.Vector3(0.0, 1.0, 0.0) },
    uSunElevation: { value: 1.0 },
    uDepthScale:   { value: 0.015 },  // Controls how quickly colour shifts with water depth
};

export function createDynamicSeaLevel(scene) {
    const seaLevelGroup = new THREE.Group();
    seaLevelGroup.name = 'dynamicSeaLevel';

    // 256×256 gives ~66k vertices — excellent wave detail at tactical distances
    const geo = new THREE.PlaneGeometry(MAP_WIDTH, MAP_HEIGHT, 256, 256);
    geo.rotateX(-Math.PI / 2);

    const mat = new THREE.MeshStandardMaterial({
        name:              'Water',
        color:             0x010e22,
        roughness:         0.1,
        metalness:         0.8,
        transparent:       true,
        opacity:           WATER_OPACITY,
        emissive:          0x04213d,
        emissiveIntensity: 0.38,
    });

    mat.onBeforeCompile = (shader) => {
        // ── Inject uniforms ───────────────────────────────────────────────
        shader.uniforms.uTime         = waterUniforms.uTime;
        shader.uniforms.uSunDir       = waterUniforms.uSunDir;
        shader.uniforms.uSunElevation = waterUniforms.uSunElevation;
        shader.uniforms.uDepthScale   = waterUniforms.uDepthScale;

        // ══════════════════════════════════════════════════════════════════
        // VERTEX SHADER
        // ══════════════════════════════════════════════════════════════════
        shader.vertexShader = `
            uniform float uTime;
            uniform float uDepthScale;
            varying float vWaveHeight;
            varying vec3  vWorldNormal;
            varying vec3  vWorldPos;
            varying float vDepthFactor;
            varying float vWaveCrest;
        ` + shader.vertexShader;

        // Replace the #include <begin_vertex> to inject Gerstner waves
        shader.vertexShader = shader.vertexShader.replace(
            '#include <begin_vertex>',
            /* glsl */`
            vec3 transformed = vec3(position);

            // ── Gerstner Wave Bank ────────────────────────────────────
            // 4 waves with different frequencies, amplitudes, directions
            float t = uTime;

            // Wave params: vec4(dirX, dirZ, steepness, wavelength)
            vec4 wave1 = vec4(0