// skyManager.js — Physically-based analytic atmospheric scattering sky
//
// Implements Rayleigh + Mie scattering with a physical sun disk, producing
// an HDR sky background that integrates with Vanguard1's existing bloom,
// fog, and cloud pipeline.
//
// Technique: Analytic single-scattering integral along view rays through
// a spherical atmosphere shell. Approximates multiple scattering via an
// ambient inscatter term. No precomputed LUTs — everything computed
// per-pixel in the fragment shader.
//
// Public API (consumed by main.js, fogManager, cloudManager, waterManager):
//   skyManager.update(latRad, lonRad)    — call on 60-s cadence
//   skyManager.sunDirection              — THREE.Vector3 (unit, world space)
//   skyManager.sunElevation              — float [-1, 1]
//   skyManager.sunColor                  — THREE.Color (HDR, for directional light)
//   skyManager.ambientColor              — THREE.Color (sky ambient)
//   skyManager.bloomColor                — THREE.Color (bloom tint)
//
// The sky is rendered into scene.background via a PMREMGenerator-processed
// cube render target, giving correct reflections on water and materials.

import * as THREE from 'three';
import { waterUniforms } from './waterManager.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const EARTH_RADIUS    = 6371000.0;   // meters
const ATMO_HEIGHT     = 100000.0;    // top of atmosphere
const RAYLEIGH_H      = 8500.0;      // Rayleigh scale height
const MIE_H           = 1200.0;      // Mie scale height
const SUN_ANGULAR_R   = 0.00467;     // sun angular radius in radians (0.267°)

// Scattering coefficients at sea level (per meter)
const RAYLEIGH_BETA   = [5.5e-6, 13.0e-6, 22.4e-6]; // RGB — wavelength dependent
const MIE_BETA        = 21e-6;                         // wavelength independent
const MIE_G           = 0.76;                          // Henyey-Greenstein asymmetry

// ── Sky Shader ────────────────────────────────────────────────────────────────
const SKY_VERTEX = /* glsl */`
varying vec3 vWorldDir;

void main() {
    vWorldDir   = (modelMatrix * vec4(position, 0.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position.z = gl_Position.w; // push to far plane
}
`;

const SKY_FRAGMENT = /* glsl */`
precision highp float;

uniform vec3  uSunDir;         // normalized direction TO the sun
uniform float uSunElevation;   // -1 to 1

varying vec3 vWorldDir;

// ── Constants ───────────────────────────────────────────────────────────────
const float EARTH_R      = 6371000.0;
const float ATMO_R       = 6471000.0;  // EARTH_R + 100km
const float RAYLEIGH_H   = 8500.0;
const float MIE_H        = 1200.0;
const vec3  RAYLEIGH_B   = vec3(5.5e-6, 13.0e-6, 22.4e-6);
const float MIE_B        = 21.0e-6;
const float MIE_G        = 0.76;
const float SUN_ANGULAR  = 0.00467;
const float PI           = 3.14159265359;
const int   SCATTER_STEPS = 16;
const int   OPTICAL_STEPS = 8;

// Solar irradiance (pre-atmosphere, in scene-relative HDR units)
const vec3 SUN_INTENSITY = vec3(20.0);

// ── Ray-sphere intersection ─────────────────────────────────────────────────
// Returns distances to two intersection points with sphere of given radius.
// Origin is assumed at (0, EARTH_R, 0) — observer on surface.
vec2 raySphere(vec3 ro, vec3 rd, float r) {
    float b = dot(ro, rd);
    float c = dot(ro, ro) - r * r;
    float d = b * b - c;
    if (d < 0.0) return vec2(-1.0);
    d = sqrt(d);
    return vec2(-b - d, -b + d);
}

// ── Henyey-Greenstein phase function ────────────────────────────────────────
float phaseHG(float cosTheta, float g) {
    float g2 = g * g;
    float denom = 1.0 + g2 - 2.0 * g * cosTheta;
    return (1.0 - g2) / (4.0 * PI * pow(denom, 1.5));
}

// ── Rayleigh phase function ─────────────────────────────────────────────────
float phaseRayleigh(float cosTheta) {
    return 3.0 / (16.0 * PI) * (1.0 + cosTheta * cosTheta);
}

// ── Main scattering integral ────────────────────────────────────────────────
vec3 atmosphere(vec3 rayDir, vec3 sunDir) {
    // Observer position: on Earth surface
    vec3 ro = vec3(0.0, EARTH_R, 0.0);

    // Intersect atmosphere shell
    vec2 atmoHit = raySphere(ro, rayDir, ATMO_R);
    if (atmoHit.y < 0.0) return vec3(0.0);

    // Clamp near intersection to 0 (we start on surface)
    float tMin = max(atmoHit.x, 0.0);
    float tMax = atmoHit.y;

    // Check ground intersection — if ray hits Earth, shorten the march
    vec2 groundHit = raySphere(ro, rayDir, EARTH_R);
    if (groundHit.x > 0.0) {
        tMax = min(tMax, groundHit.x);
    }

    float segLen = (tMax - tMin) / float(SCATTER_STEPS);
    float cosTheta = dot(rayDir, sunDir);

    float phaseR = phaseRayleigh(cosTheta);
    float phaseM = phaseHG(cosTheta, MIE_G);

    vec3  sumR = vec3(0.0);
    vec3  sumM = vec3(0.0);
    float opticalR = 0.0;
    float opticalM = 0.0;

    for (int i = 0; i < SCATTER_STEPS; i++) {
        float t = tMin + (float(i) + 0.5) * segLen;
        vec3  samplePos = ro + rayDir * t;
        float h = length(samplePos) - EARTH_R;

        // Density at this height
        float densR = exp(-h / RAYLEIGH_H) * segLen;
        float densM = exp(-h / MIE_H)      * segLen;

        opticalR += densR;
        opticalM += densM;

        // Sun optical depth from this sample point
        vec2 sunHit = raySphere(samplePos, sunDir, ATMO_R);
        float sunSegLen = sunHit.y / float(OPTICAL_STEPS);
        float sunOptR = 0.0;
        float sunOptM = 0.0;

        bool shadowed = false;
        for (int j = 0; j < OPTICAL_STEPS; j++) {
            float tSun = (float(j) + 0.5) * sunSegLen;
            vec3  sunSample = samplePos + sunDir * tSun;
            float hSun = length(sunSample) - EARTH_R;
            if (hSun < 0.0) { shadowed = true; break; }
            sunOptR += exp(-hSun / RAYLEIGH_H) * sunSegLen;
            sunOptM += exp(-hSun / MIE_H)      * sunSegLen;
        }

        if (!shadowed) {
            vec3 tau = RAYLEIGH_B * (opticalR + sunOptR)
                     + MIE_B      * (opticalM + sunOptM) * 1.1; // 1.1 = extinction/scatter ratio
            vec3 attenuation = exp(-tau);
            sumR += densR * attenuation;
            sumM += densM * attenuation;
        }
    }

    vec3 scatter = SUN_INTENSITY * (sumR * RAYLEIGH_B * phaseR + sumM * MIE_B * phaseM);

    // ── Multiple scattering approximation ──────────────────────────────────
    // Second-order scatter adds ~15% luminance to shadow areas.
    // Approximate as isotropic ambient proportional to sun elevation.
    float ambientStrength = max(sunDir.y, 0.0) * 0.15;
    vec3  ambient = ambientStrength * SUN_INTENSITY * RAYLEIGH_B * opticalR
                  * exp(-RAYLEIGH_B * opticalR * 0.5);
    scatter += ambient;

    return scatter;
}

// ── Sun disk with limb darkening ────────────────────────────────────────────
vec3 sunDisk(vec3 rayDir, vec3 sunDir) {
    float cosAngle = dot(rayDir, sunDir);
    float angle    = acos(clamp(cosAngle, -1.0, 1.0));

    if (angle > SUN_ANGULAR * 1.5) return vec3(0.0);

    // Smooth edge
    float edge = 1.0 - smoothstep(SUN_ANGULAR * 0.85, SUN_ANGULAR * 1.1, angle);

    // Limb darkening — center-to-limb variation
    float mu = cos(angle / SUN_ANGULAR * 1.5707963);
    float limb = 0.4 + 0.6 * pow(max(mu, 0.0), 0.4);

    // HDR sun luminance — tuned so peak is ~1.2 after tone mapping
    // This sits just above bloomThreshold 0.95 for a subtle glow
    // without blowing out the scene
    return vec3(1.2) * edge * limb;
}

void main() {
    vec3 rd = normalize(vWorldDir);

    // Flip if looking below horizon — render a dark ground
    vec3 skyDir = rd;
    float belowHorizon = 0.0;
    if (rd.y < 0.0) {
        // Below horizon: mirror the ray and darken heavily
        // This creates a dark ground plane effect
        skyDir = vec3(rd.x, -rd.y * 0.1, rd.z);
        skyDir = normalize(skyDir);
        belowHorizon = 1.0;
    }

    vec3 color = atmosphere(skyDir, uSunDir);

    // Add sun disk (only above horizon)
    if (belowHorizon < 0.5) {
        color += sunDisk(rd, uSunDir);
    } else {
        // Ground: very dark, absorb light
        color *= 0.02;
    }

    // Night sky base — prevent pure black
    float nightBlend = smoothstep(-0.1, 0.05, -uSunDir.y);
    vec3  nightColor = vec3(0.001, 0.002, 0.004);
    color = mix(color, max(color, nightColor), nightBlend);

    gl_FragColor = vec4(color, 1.0);
}
`;

// ── SkyManager Class ──────────────────────────────────────────────────────────
export class SkyManager {
    constructor(scene, renderer) {
        this._scene    = scene;
        this._renderer = renderer;

        // ── Public state consumed by other managers ──────────────────────────
        this.sunDirection = new THREE.Vector3(0, 1, 0);
        this.sunElevation = 0.5;
        this.sunColor     = new THREE.Color(1.0, 0.95, 0.85);
        this.ambientColor = new THREE.Color(0.1, 0.15, 0.25);
        this.bloomColor   = new THREE.Color(1, 1, 1);

        // ── Reusable objects (no allocations in update loop) ─────────────────
        this._tmpColor  = new THREE.Color();
        this._tmpTarget = new THREE.Vector3();

        // ── Sky cube render target ──────────────────────────────────────────
        // We render the sky shader onto a cube map, then set it as
        // scene.background. This gives correct reflections on water.
        this._cubeSize = 256;
        this._cubeRT   = new THREE.WebGLCubeRenderTarget(this._cubeSize, {
            format: THREE.RGBAFormat,
            type:   THREE.HalfFloatType,
            generateMipmaps: true,
            minFilter: THREE.LinearMipmapLinearFilter,
        });

        // ── Sky material ────────────────────────────────────────────────────
        this._skyMaterial = new THREE.ShaderMaterial({
            vertexShader:   SKY_VERTEX,
            fragmentShader: SKY_FRAGMENT,
            uniforms: {
                uSunDir:       { value: new THREE.Vector3(0, 1, 0) },
                uSunElevation: { value: 0.5 },
            },
            side:       THREE.BackSide,
            depthWrite: false,
            depthTest:  false,
        });

        // ── Sky mesh — large sphere, rendered into the cube render target ───
        this._skyMesh = new THREE.Mesh(
            new THREE.IcosahedronGeometry(1, 3),
            this._skyMaterial
        );
        this._skyScene = new THREE.Scene();
        this._skyScene.add(this._skyMesh);

        // ── Cube camera for rendering sky to cube map ───────────────────────
        this._cubeCamera = new THREE.CubeCamera(0.1, 10, this._cubeRT);

        // ── Frame counter — only re-render sky cube every N frames ──────────
        this._frameCount    = 0;
        this._updateEvery   = 60;  // re-render sky every 60 frames (~1s at 60fps)
        this._needsUpdate   = true;

        // ── Compute initial sun position ────────────────────────────────────
        const now   = new Date();
        const start = new Date(now.getFullYear(), 0, 0);
        const doy   = Math.floor((now - start) / 86400000);
        const decRad = -23.45 * (Math.PI / 180) * Math.cos(2 * Math.PI * (doy + 10) / 365.25);
        const utcH   = now.getUTCHours() + now.getUTCMinutes() / 60;
        const sunLon = ((12 - utcH) / 24) * 2 * Math.PI;
        this.update(decRad, sunLon);

        // ── Console tuning ──────────────────────────────────────────────────
        window.vg1_sky_cubeUpdateInterval = this._updateEvery;
        window.vg1_sky_cubeSize           = this._cubeSize;
    }

    // ── update ────────────────────────────────────────────────────────────────
    // Called by main.js on the same 60-s cadence as DayNightManager.
    // latRad: sub-solar latitude in radians (declination)
    // lonRad: sub-solar longitude in radians
    update(latRad, lonRad) {
        // ── Sun direction in world space ────────────────────────────────────
        // Convention: Y = up, sun position on unit sphere from lat/lon
        const cosLat = Math.cos(latRad);
        this.sunDirection.set(
            cosLat * Math.sin(lonRad),
            Math.sin(latRad),
            cosLat * Math.cos(lonRad)
        ).normalize();

        this.sunElevation = this.sunDirection.y; // -1 to 1

        // ── Push to sky shader uniforms ─────────────────────────────────────
        this._skyMaterial.uniforms.uSunDir.value.copy(this.sunDirection);
        this._skyMaterial.uniforms.uSunElevation.value = this.sunElevation;

        // ── Compute sun color (extinction along path through atmosphere) ────
        // At low elevations, longer path = more Rayleigh extinction = warm color
        const sunAlt     = Math.max(this.sunElevation, -0.05);
        const airMass    = 1.0 / (sunAlt + 0.15 * Math.pow(3.885 + sunAlt, -1.253));
        const clampedAM  = Math.min(airMass, 40.0);
        const tauR       = clampedAM * 0.1;
        const tauG       = clampedAM * 0.05;
        const tauB       = clampedAM * 0.025;
        this.sunColor.setRGB(
            Math.exp(-tauR * RAYLEIGH_BETA[0] * EARTH_RADIUS * 0.01),
            Math.exp(-tauG * RAYLEIGH_BETA[1] * EARTH_RADIUS * 0.01),
            Math.exp(-tauB * RAYLEIGH_BETA[2] * EARTH_RADIUS * 0.01)
        );

        // ── Sun intensity scaling ───────────────────────────────────────────
        // Directional light intensity should drop toward horizon
        const sunIntensity = Math.max(0, this.sunElevation) * 2.5 + 0.1;
        this.sunColor.multiplyScalar(sunIntensity);

        // ── Ambient color — blue-shifted sky light ──────────────────────────
        const ambStr = Math.max(0.05, this.sunElevation * 0.3 + 0.1);
        this.ambientColor.setRGB(
            0.05 + ambStr * 0.15,
            0.08 + ambStr * 0.25,
            0.15 + ambStr * 0.40
        );

        // ── Bloom color — warm at sunrise/sunset, white at noon, blue at night
        if (this.sunElevation > 0.15) {
            this.bloomColor.setRGB(1.0, 1.0, 1.0);
        } else if (this.sunElevation > -0.05) {
            const t = (this.sunElevation + 0.05) / 0.20;
            this.bloomColor.setRGB(1.0, 0.6 + 0.4 * t, 0.3 + 0.7 * t);
        } else {
            this.bloomColor.setRGB(0.4, 0.5, 0.8);
        }

        // ── Water reflection uniforms ───────────────────────────────────────
        if (waterUniforms && waterUniforms.sunDirection) {
            waterUniforms.sunDirection.value.copy(this.sunDirection);
        }

        // ── Flag for cube map re-render ─────────────────────────────────────
        this._needsUpdate = true;
    }

    // ── renderSky ─────────────────────────────────────────────────────────────
    // Called every frame from main.js animation loop. Only re-renders the
    // cube map when _needsUpdate is true or on the periodic interval.
    renderSky() {
        // Check console-tunable interval
        this._updateEvery = window.vg1_sky_cubeUpdateInterval || 60;

        this._frameCount++;
        if (!this._needsUpdate && (this._frameCount % this._updateEvery !== 0)) {
            return;
        }
        this._needsUpdate = false;

        // Render sky scene into cube map
        this._cubeCamera.update(this._renderer, this._skyScene);

        // Set as scene background
        this._scene.background = this._cubeRT.texture;
    }

    // ── dispose ───────────────────────────────────────────────────────────────
    dispose() {
        this._cubeRT.dispose();
        this._skyMaterial.dispose();
        this._skyMesh.geometry.dispose();
    }
}