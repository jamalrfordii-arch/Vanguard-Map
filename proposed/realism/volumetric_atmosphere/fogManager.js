// fogManager.js — Volumetric atmospheric fog + aerial perspective via ray-marching
//
// A full-screen ShaderPass that integrates atmospheric density along each
// pixel's view ray, then composites the result over the scene colour.
//
// Features
// ────────
//   • Exponential height fog      — thickens toward sea level, clears above
//   • Aerial perspective          — distant objects fade toward sky color
//   • Animated turbulence         — analytic value noise, no texture needed
//   • Storm halos                 — denser fog caps around WeatherManager cells
//   • Mie forward scatter         — warm god-ray shaft toward the sun
//   • Rayleigh sky integration    — fog color shifts blue at distance, warm near sun
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
    uniform float uSunElevation;    // -1=night  0=horizon  1=zenith

    // Ambient sky color for aerial perspective
    uniform vec3  uAmbientColor;

    // Animated turbulence time
    uniform float uTime;

    // Storm contributors
    uniform vec3  uStormPos[4];
    uniform float uStormRadius[4];
    uniform float uStormIntensity[4];
    uniform int   uStormCount;

    varying vec2 vUv;

    // ── Analytic value noise — no texture fetch ───────────────────────────────
    float hash3(vec3 p) {
        p  = fract(p * vec3(0.1031, 0.1030, 0.0973));
        p += dot(p, p.yxz + 33.33);
        return fract((p.x + p.y) * p.z);
    }

    float valueNoise(vec3 p) {
        vec3 pi = floor(p);
        vec3 pf = fract(p);
        pf = pf * pf * (3.0 - 2.0 * pf);
        return mix(
            mix(mix(hash3(pi),               hash3(pi + vec3(1,0,0)), pf.x),
                mix(hash3(pi + vec3(0,1,0)), hash3(pi + vec3(1,1,0)), pf.x), pf.y),
            mix(mix(hash3(pi + vec3(0,0,1)), hash3(pi + vec3(1,0,1)), pf.x),
                mix(hash3(pi + vec3(0,1,1)), hash3(pi + vec3(1,1,1)), pf.x), pf.y),
            pf.z);
    }

    // 2-octave fBm — enough for fog turbulence, cheaper than cloud's 4-octave
    float fbm2(vec3 p) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 2; i++) {
            v += a * valueNoise(p);
            p *= 2.03;
            a *= 0.5;
        }
        return v;
    }

    // ── Henyey-Greenstein phase ───────────────────────────────────────────────
    float phaseHG(float cosTheta, float g) {
        float g2 = g * g;
        float denom = 1.0 + g2 - 2.0 * g * cosTheta;
        return (1.0 - g2) / (4.0 * 3.14159265 * pow(denom, 1.5));
    }

    // ── Rayleigh phase ───────────────────────────────────────────────────────
    float phaseRayleigh(float cosTheta) {
        return 3.0 / (16.0 * 3.14159265) * (1.0 + cosTheta * cosTheta);
    }

    void main() {
        vec4 sceneColor = texture2D(tDiffuse, vUv);

        // ── Reconstruct world-space view ray ──────────────────────────────────
        vec2 ndc = vUv * 2.0 - 1.0;
        float fovTanY = 1.0 / uProjMatrix[1][1];
        float fovTanX = 1.0 / uProjMatrix[0][0];
        vec3 viewDir  = normalize(vec3(ndc.x * fovTanX, ndc.y * fovTanY, -1.0));
        // View → world rotation (transpose of upper-left 3x3 of view matrix)
        mat3 viewToWorld = transpose(mat3(uViewMatrix));
        vec3 worldDir    = normalize(viewToWorld * viewDir);

        // ── Ray march parameters ──────────────────────────────────────────────
        // Fog lives in y ∈ [-5, 25] — from ocean floor to just above terrain peaks.
        // Beyond that, only aerial perspective (analytic, no march).
        float fogBottom    = -5.0;
        float fogTop       = 25.0;
        float maxDist      = 600.0;
        int   steps        = 24;

        // ── Determine ray start/end through fog slab ──────────────────────────
        float tEnter = 0.0;
        float tExit  = maxDist;

        // Slab intersection
        if (abs(worldDir.y) > 0.0001) {
            float t0 = (fogBottom - uCameraPos.y) / worldDir.y;
            float t1 = (fogTop    - uCameraPos.y) / worldDir.y;
            if (t0 > t1) { float tmp = t0; t0 = t1; t1 = tmp; }
            tEnter = max(t0, 0.0);
            tExit  = min(t1, maxDist);
        } else {
            // Ray is horizontal — only in slab if camera is in slab
            if (uCameraPos.y < fogBottom || uCameraPos.y > fogTop) {
                tEnter = maxDist + 1.0; // skip
            }
        }

        if (tEnter >= tExit) {
            // No fog intersection — still apply aerial perspective
            float dist = maxDist; // approximate
            float aerialT = 1.0 - exp(-dist * 0.0003);
            vec3 aerialColor = uAmbientColor * max(uSunElevation * 0.5 + 0.3, 0.05);
            gl_FragColor = vec4(mix(sceneColor.rgb, aerialColor, aerialT * 0.3), sceneColor.a);
            return;
        }

        float segLen = (tExit - tEnter) / float(steps);

        // ── Precompute sun scatter params ─────────────────────────────────────
        float cosTheta  = dot(worldDir, uSunDir);
        float miePhase  = phaseHG(cosTheta, 0.76);
        float rayPhase  = phaseRayleigh(cosTheta);

        // Sun-based fog brightness — dim at night, warm at sunset
        float sunFactor = max(uSunElevation, 0.0);
        vec3  fogLitColor;
        if (uSunElevation > 0.1) {
            fogLitColor = vec3(0.65, 0.70, 0.80); // daylight blue-grey
        } else if (uSunElevation > -0.05) {
            float t = (uSunElevation + 0.05) / 0.15;
            fogLitColor = mix(vec3(0.15, 0.12, 0.18), vec3(0.65, 0.70, 0.80), t);
            // Add sunset warmth
            fogLitColor += vec3(0.3, 0.1, 0.0) * (1.0 - t) * max(miePhase, 0.0);
        } else {
            fogLitColor = vec3(0.03, 0.04, 0.06); // night
        }

        // ── Ray march ─────────────────────────────────────────────────────────
        float totalDensity = 0.0;
        vec3  inscatter    = vec3(0.0);
        float transmittance = 1.0;

        for (int i = 0; i < 24; i++) {
            if (i >= steps) break;

            float t   = tEnter + (float(i) + 0.5) * segLen;
            vec3  pos = uCameraPos + worldDir * t;
            float h   = pos.y;

            // ── Height-based density ──────────────────────────────────────────
            // Exponential falloff from fogBottom, peaks at sea level (y=0)
            float heightFactor = exp(-max(h - fogBottom, 0.0) / 12.0);

            // ── Turbulence ────────────────────────────────────────────────────
            vec3 noiseCoord = pos * 0.015 + vec3(uTime * 0.3, 0.0, uTime * 0.15);
            float turb = fbm2(noiseCoord) * 0.6;

            // ── Storm density halos ───────────────────────────────────────────
            float stormDens = 0.0;
            for (int s = 0; s < 4; s++) {
                if (s >= uStormCount) break;
                float d = length(pos.xz - uStormPos[s].xz);
                float r = uStormRadius[s];
                if (d < r * 2.0) {
                    float falloff = 1.0 - smoothstep(r * 0.3, r * 2.0, d);
                    stormDens += falloff * uStormIntensity[s] * 1.5;
                }
            }

            // ── Combined density ──────────────────────────────────────────────
            float density = (0.08 + turb * 0.12 + stormDens) * heightFactor;
            density *= segLen;

            // ── Inscattering ──────────────────────────────────────────────────
            float extinction = density * 0.8;
            float stepTransmittance = exp(-extinction);

            // Mie forward scatter — warm shaft toward sun
            float mieContrib = miePhase * sunFactor * 0.6;
            // Rayleigh — slight blue scatter everywhere
            float rayContrib = rayPhase * sunFactor * 0.15;

            vec3 stepLight = fogLitColor * (1.0 + mieContrib + rayContrib);
            // Energy-conserving inscatter integration
            inscatter += transmittance * (1.0 - stepTransmittance) * stepLight;
            transmittance *= stepTransmittance;

            totalDensity += density;
        }

        // ── Aerial perspective (analytic, applied on top of fog march) ────────
        // Distant objects fade toward the ambient sky color.
        // Use the ray length through the fog slab as a proxy for view distance.
        float viewDist = tExit - tEnter;
        float aerialT  = 1.0 - exp(-viewDist * 0.0008);
        vec3  aerialCol = uAmbientColor * max(uSunElevation * 0.5 + 0.3, 0.05);

        // ── Composite ─────────────────────────────────────────────────────────
        // Fog inscatter is additive, aerial perspective is a blend
        vec3 fogged = sceneColor.rgb * transmittance + inscatter;
        vec3 final  = mix(fogged, aerialCol, aerialT * 0.25);

        gl_FragColor = vec4(final, sceneColor.a);
    }
`;

// ── FogManager Class ──────────────────────────────────────────────────────────
export class FogManager {
    constructor() {
        this._pass = new ShaderPass({
            uniforms: {
                tDiffuse:        { value: null },
                uProjMatrix:     { value: new THREE.Matrix4() },
                uViewMatrix:     { value: new THREE.Matrix4() },
                uCameraPos:      { value: new THREE.Vector3() },
                uSunDir:         { value: new THREE.Vector3(0, 1, 0) },
                uSunElevation:   { value: 0.5 },
                uAmbientColor:   { value: new THREE.Vector3(0.1, 0.15, 0.25) },
                uTime:           { value: 0 },
                uStormPos:       { value: [] },
                uStormRadius:    { value: [] },
                uStormIntensity: { value: [] },
                uStormCount:     { value: 0 },
            },
            vertexShader:   FOG_VERT,
            fragmentShader: FOG_FRAG,
        });

        // Pre-allocate storm uniform arrays
        const u = this._pass.uniforms;
        u.uStormPos.value       = new Array(MAX_STORM_LIGHTS).fill(null).map(() => new THREE.Vector3());
        u.uStormRadius.value    = new Float32Array(MAX_STORM_LIGHTS);
        u.uStormIntensity.value = new Float32Array(MAX_STORM_LIGHTS);

        // Console tuning
        window.vg1_fog_enabled = true;
    }

    get pass() { return this._pass; }

    // ── update ────────────────────────────────────────────────────────────────
    // Called every frame from main.js animation loop.
    update(camera, sunDir, sunElevation, ambientColor, elapsed, stormCells) {
        if (!window.vg1_fog_enabled) {
            this._pass.enabled = false;
            return;
        }
        this._pass.enabled = true;

        const u = this._pass.uniforms;
        u.uProjMatrix.value.copy(camera.projectionMatrix);
        u.uViewMatrix.value.copy(camera.matrixWorldInverse);
        u.uCameraPos.value.copy(camera.position);
        u.uSunDir.value.copy(sunDir);
        u.uSunElevation.value = sunElevation;

        if (ambientColor) {
            u.uAmbientColor.value.set(ambientColor.r, ambientColor.g, ambientColor.b);
        }

        u.uTime.value = elapsed;

        // Storm cells
        const count = stormCells ? Math.min(stormCells.length, MAX_STORM_LIGHTS) : 0;
        u.uStormCount.value = count;
        for (let i = 0; i < count; i++) {
            const s = stormCells[i];
            u.uStormPos.value[i].set(s.x, s.y || 0, s.z);
            u.uStormRadius.value[i]    = s.radius || 30;
            u.uStormIntensity.value[i] = s.intensity || 0.5;
        }
    }
}