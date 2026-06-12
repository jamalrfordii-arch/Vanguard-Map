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