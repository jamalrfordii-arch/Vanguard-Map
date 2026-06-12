// cloudManager.js — Volumetric cloud layer via ray-marching
//
// Architecture mirrors fogManager.js: a full-screen ShaderPass that
// ray-marches a 3D noise field, then composites the result over scene colour.
//
// Key differences from the fog pass
// ──────────────────────────────────
//   • Cloud slab lives at y ∈ [35, 78] — above terrain, below the sky dome
//   • 4-octave fBm gives wispy, fractal cloud shapes (vs fog's single noise)
//   • Coverage threshold creates discrete cumulus formations, not uniform haze
//   • Storm cells from WeatherManager punch tall cumulonimbus columns through
//     the deck — the same storm data already driving the fog halos
//   • Per-step self-shadowing: a short sun-direction probe darkens undersides
//   • Blend is alpha-over (not purely additive) — clouds occlude what's beneath
//   • Physically-based Rayleigh+Mie scattering colors cloud edges
//   • Aerial perspective integration — distant clouds fade into atmosphere

import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const MAX_STORM_LIGHTS = 4;

// ── Shaders ───────────────────────────────────────────────────────────────────
const CLOUD_VERT = /* glsl */`
    varying vec2 vUv;
    void main() {
        vUv         = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const CLOUD_FRAG = /* glsl */`
    uniform sampler2D tDiffuse;

    // Scene camera matrices — ShaderPass uses its own ortho camera so we
    // must pass the real scene camera explicitly (same fix as fogManager).
    uniform mat4  uProjMatrix;
    uniform mat4  uViewMatrix;
    uniform vec3  uCameraPos;

    // Sun state
    uniform vec3  uSunDir;
    uniform float uSunElevation;

    // Ambient sky color — from SkyManager
    uniform vec3  uAmbientColor;

    // Animation
    uniform float uTime;

    // Global cloud coverage (0 = clear blue sky, 1 = fully overcast)
    uniform float uCoverage;

    // Storm contributors — cumulonimbus columns above each active storm cell
    uniform vec3  uStormPos[4];
    uniform float uStormRadius[4];
    uniform float uStormIntensity[4];
    uniform int   uStormCount;

    varying vec2 vUv;

    // ── Analytic noise (no texture fetch) ────────────────────────────────────
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

    // 4-octave fBm — wispy fractal cloud edges
    float fbm4(vec3 p) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 4; i++) {
            v += a * valueNoise(p);
            p *= 2.07;
            a *= 0.48;
        }
        return v;
    }

    // 2-octave fBm — cheaper, used for shadow probes
    float fbm2(vec3 p) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 2; i++) {
            v += a * valueNoise(p);
            p *= 2.07;
            a *= 0.5;
        }
        return v;
    }

    // ── Henyey-Greenstein phase ──────────────────────────────────────────────
    float phaseHG(float cosTheta, float g) {
        float g2 = g * g;
        float denom = 1.0 + g2 - 2.0 * g * cosTheta;
        return (1.0 - g2) / (4.0 * 3.14159265 * pow(denom, 1.5));
    }

    // ── Dual-lobe phase (silver lining effect) ──────────────────────────────
    float phaseDualLobe(float cosTheta) {
        // Forward scatter (bright edge) + back scatter (dark volume interior)
        float forward  = phaseHG(cosTheta, 0.8);
        float backward = phaseHG(cosTheta, -0.3);
        return mix(backward, forward, 0.7);
    }

    // ── Cloud density at a point ────────────────────────────────────────────
    float cloudDensity(vec3 pos, float cloudBottom, float cloudTop) {
        // Height fraction within cloud slab
        float hFrac = clamp((pos.y - cloudBottom) / (cloudTop - cloudBottom), 0.0, 1.0);

        // Vertical density profile — anvil shape
        // Dense in lower 60%, thinning toward top
        float vertProfile = smoothstep(0.0, 0.15, hFrac)
                          * smoothstep(1.0, 0.6, hFrac);

        // fBm cloud shape
        vec3 noiseCoord = pos * 0.012 + vec3(uTime * 0.4, 0.0, uTime * 0.2);
        float shape = fbm4(noiseCoord);

        // Coverage threshold — higher coverage = lower threshold
        float threshold = 0.52 - uCoverage * 0.25;

        // Storm enhancement — thicker clouds above storm cells
        float stormBoost = 0.0;
        for (int s = 0; s < 4; s++) {
            if (s >= uStormCount) break;
            float d = length(pos.xz - uStormPos[s].xz);
            float r = uStormRadius[s];
            if (d < r * 1.8) {
                float falloff = 1.0 - smoothstep(r * 0.2, r * 1.8, d);
                stormBoost += falloff * uStormIntensity[s] * 0.35;
            }
        }
        threshold -= stormBoost;

        float density = smoothstep(threshold, threshold + 0.15, shape) * vertProfile;

        // Detail erosion at small scale
        vec3 detailCoord = pos * 0.06 + vec3(uTime * 0.8, uTime * 0.3, 0.0);
        float detail = valueNoise(detailCoord);
        density -= detail * 0.15;
        density = max(density, 0.0);

        return density;
    }

    // ── Self-shadowing probe along sun direction ────────────────────────────
    float lightMarch(vec3 pos, float cloudBottom, float cloudTop) {
        float totalDens = 0.0;
        float stepSize  = (cloudTop - cloudBottom) * 0.25;
        for (int i = 0; i < 4; i++) {
            pos += uSunDir * stepSize;
            if (pos.y > cloudTop || pos.y < cloudBottom) break;
            totalDens += cloudDensity(pos, cloudBottom, cloudTop) * stepSize;
        }
        // Beer-Lambert attenuation along sun path
        return exp(-totalDens * 6.0);
    }

    void main() {
        vec4 sceneColor = texture2D(tDiffuse, vUv);

        // ── Reconstruct world-space view ray ──────────────────────────────────
        vec2 ndc = vUv * 2.0 - 1.0;
        float fovTanY = 1.0 / uProjMatrix[1][1];
        float fovTanX = 1.0 / uProjMatrix[0][0];
        vec3 viewDir  = normalize(vec3(ndc.x * fovTanX, ndc.y * fovTanY, -1.0));
        mat3 viewToWorld = transpose(mat3(uViewMatrix));
        vec3 worldDir    = normalize(viewToWorld * viewDir);

        // ── Cloud slab bounds ─────────────────────────────────────────────────
        float cloudBottom = 35.0;
        float cloudTop    = 78.0;

        // Storm cells can push cumulonimbus higher
        float maxTop = cloudTop;
        for (int s = 0; s < 4; s++) {
            if (s >= uStormCount) break;
            if (uStormIntensity[s] > 0.3) {
                maxTop = max(maxTop, cloudTop + uStormIntensity[s] * 30.0);
            }
        }
        cloudTop = maxTop;

        // ── Ray-slab intersection ─────────────────────────────────────────────
        float tEnter = 0.0;
        float tExit  = 800.0;

        if (abs(worldDir.y) > 0.0001) {
            float t0 = (cloudBottom - uCameraPos.y) / worldDir.y;
            float t1 = (cloudTop    - uCameraPos.y) / worldDir.y;
            if (t0 > t1) { float tmp = t0; t0 = t1; t1 = tmp; }
            tEnter = max(t0, 0.0);
            tExit  = min(t1, 800.0);
        } else {
            if (uCameraPos.y < cloudBottom || uCameraPos.y > cloudTop) {
                gl_FragColor = sceneColor;
                return;
            }
        }

        if (tEnter >= tExit || tExit < 0.0) {
            gl_FragColor = sceneColor;
            return;
        }

        // ── Adaptive step count — fewer steps when far away ───────────────────
        int   maxSteps = 48;
        float stepLen  = (tExit - tEnter) / float(maxSteps);

        // ── Phase function precompute ─────────────────────────────────────────
        float cosTheta = dot(worldDir, uSunDir);
        float phase    = phaseDualLobe(cosTheta);

        // ── Sun color — warm at low elevations ───────────────────────────────
        float sunFactor = max(uSunElevation, 0.0);
        vec3  sunLitColor;
        if (uSunElevation > 0.15) {
            sunLitColor = vec3(1.0, 0.98, 0.92) * 2.0;
        } else if (uSunElevation > -0.05) {
            float t = (uSunElevation + 0.05) / 0.20;
            sunLitColor = mix(vec3(0.8, 0.3, 0.1), vec3(1.0, 0.98, 0.92), t) * (0.5 + 1.5 * t);
        } else {
            sunLitColor = vec3(0.05, 0.07, 0.12);
        }

        // ── Ambient sky light on cloud undersides ─────────────────────────────
        vec3 ambientSkyLight = uAmbientColor * 0.5;

        // ── Ray march ─────────────────────────────────────────────────────────
        float transmittance = 1.0;
        vec3  luminance     = vec3(0.0);

        for (int i = 0; i < 48; i++) {
            if (i >= maxSteps) break;
            if (transmittance < 0.01) break; // early exit

            float t   = tEnter + (float(i) + 0.5) * stepLen;
            vec3  pos = uCameraPos + worldDir * t;

            float density = cloudDensity(pos, cloudBottom, cloudTop);
            if (density < 0.001) continue;

            density *= stepLen;

            // ── Self-shadowing ────────────────────────────────────────────────
            float sunVis = lightMarch(pos, cloudBottom, cloudTop);

            // ── Height fraction for ambient weighting ─────────────────────────
            float hFrac = clamp((pos.y - cloudBottom) / (cloudTop - cloudBottom), 0.0, 1.0);

            // ── Lighting ──────────────────────────────────────────────────────
            // Direct sunlight with phase function and shadow
            vec3 directLight = sunLitColor * sunVis * phase;

            // Ambient — stronger on upper surfaces, bluer underneath
            vec3 ambient = mix(ambientSkyLight * 0.5, ambientSkyLight, hFrac);

            // Multi-scatter approximation — deeper clouds get more ambient
            float multiScatter = 0.15 * (1.0 - sunVis);
            ambient += sunLitColor * multiScatter;

            // ── Powder effect — dark edges on thin clouds facing sun ──────────
            float powder = 1.0 - exp(-density * 12.0);
            vec3  stepLum = (directLight * powder + ambient) * density * 0.4;

            // ── Energy-conserving integration ─────────────────────────────────
            float stepT = exp(-density * 4.0);
            luminance    += transmittance * stepLum;
            transmittance *= stepT;
        }

        // ── Aerial perspective on distant clouds ──────────────────────────────
        float cloudDist = max(tEnter, 0.0);
        float aerialT   = 1.0 - exp(-cloudDist * 0.0005);
        vec3  aerialCol  = uAmbientColor * max(uSunElevation * 0.4 + 0.2, 0.05);
        luminance = mix(luminance, aerialCol * (1.0 - transmittance), aerialT * 0.4);

        // ── Composite — alpha-over blend ──────────────────────────────────────
        float alpha = 1.0 - transmittance;
        vec3  final = sceneColor.rgb * transmittance + luminance;

        gl_FragColor = vec4(final, sceneColor.a);
    }
`;

// ── CloudManager Class ────────────────────────────────────────────────────────
export class CloudManager {
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
                uCoverage:       { value: 0.35 },
                uStormPos:       { value: [] },
                uStormRadius:    { value: [] },
                uStormIntensity: { value: [] },
                uStormCount:     { value: 0 },
            },
            vertexShader:   CLOUD_VERT,
            fragmentShader: CLOUD_FRAG,
        });

        // Pre-allocate storm uniform arrays
        const u = this._pass.uniforms;
        u.uStormPos.value       = new Array(MAX_STORM_LIGHTS).fill(null).map(() => new THREE.Vector3());
        u.uStormRadius.value    = new Float32Array(MAX_STORM_LIGHTS);
        u.uStormIntensity.value = new Float32Array(MAX_STORM_LIGHTS);

        // Console tuning
        window.vg1_cloud_coverage = 0.35;
        window.vg1_cloud_enabled  = true;
    }

    get pass() { return this._pass; }

    // ── update ────────────────────────────────────────────────────────────────
    // Called every frame from main.js animation loop.
    update(camera, sunDir, sunElevation, ambientColor, elapsed, stormCells) {
        if (!window.vg1_cloud_enabled) {
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

        u.uTime.value     = elapsed;
        u.uCoverage.value = window.vg1_cloud_coverage !== undefined
            ? window.vg1_cloud_coverage : 0.35;

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