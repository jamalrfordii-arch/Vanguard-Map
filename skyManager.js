// skyManager.js — Physically-based analytic atmospheric scattering sky
//
// Replaces the previous Three.js Sky shader with a proper per-pixel
// Rayleigh + Mie scattering integral, a physical sun disk with limb
// darkening, and an HDR cube map background that feeds reflections on
// the water and terrain materials.
//
// Public API (unchanged from previous skyManager — drop-in replacement):
//   skyManager.update(latRad, lonRad)    — call on 60-s cadence
//   skyManager.sunDirection              — THREE.Vector3 (unit, world space)
//   skyManager.sunElevation              — float [-1, 1]
//   skyManager.sunColor                  — THREE.Color (HDR)
//   skyManager.ambientColor              — THREE.Color (sky ambient)
//   skyManager.bloomColor                — THREE.Color (bloom tint)

import * as THREE from 'three';
import { waterUniforms } from './waterManager.js';
import { simClock } from './simClock.js';

// ── Physical constants ────────────────────────────────────────────────────────
const EARTH_RADIUS  = 6371000.0;
const RAYLEIGH_BETA = [5.5e-6, 13.0e-6, 22.4e-6]; // per-meter, RGB

// ── Sky Vertex ────────────────────────────────────────────────────────────────
const SKY_VERTEX = /* glsl */`
varying vec3 vWorldDir;
void main() {
    vWorldDir   = (modelMatrix * vec4(position, 0.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position.z = gl_Position.w; // push to far plane
}
`;

// ── Sky Fragment — analytic single-scatter Rayleigh + Mie ────────────────────
const SKY_FRAGMENT = /* glsl */`
precision highp float;

uniform vec3  uSunDir;
uniform float uSunElevation;

varying vec3 vWorldDir;

const float EARTH_R    = 6371000.0;
const float ATMO_R     = 6471000.0;
const float RAYLEIGH_H = 8500.0;
const float MIE_H      = 1200.0;
const vec3  RAYLEIGH_B = vec3(5.5e-6, 13.0e-6, 22.4e-6);
const float MIE_B      = 21.0e-6;
const float MIE_G      = 0.76;
const float SUN_ANG    = 0.00467;
const float PI         = 3.14159265359;
const int   STEPS      = 16;
const int   LIGHT_STEPS = 8;
const vec3  SUN_I      = vec3(20.0);

vec2 raySphere(vec3 ro, vec3 rd, float r) {
    float b = dot(ro, rd);
    float c = dot(ro, ro) - r * r;
    float d = b * b - c;
    if (d < 0.0) return vec2(-1.0);
    d = sqrt(d);
    return vec2(-b - d, -b + d);
}

float phaseHG(float cosT, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosT, 1.5));
}

float phaseRayleigh(float cosT) {
    return 3.0 / (16.0 * PI) * (1.0 + cosT * cosT);
}

vec3 atmosphere(vec3 rd, vec3 sun) {
    vec3 ro = vec3(0.0, EARTH_R, 0.0);
    vec2 atmo = raySphere(ro, rd, ATMO_R);
    if (atmo.y < 0.0) return vec3(0.0);

    float tMin = max(atmo.x, 0.0);
    float tMax = atmo.y;
    vec2 ground = raySphere(ro, rd, EARTH_R);
    if (ground.x > 0.0) tMax = min(tMax, ground.x);

    float segLen = (tMax - tMin) / float(STEPS);
    float cosT   = dot(rd, sun);
    float phR    = phaseRayleigh(cosT);
    float phM    = phaseHG(cosT, MIE_G);

    vec3  sumR = vec3(0.0);
    vec3  sumM = vec3(0.0);
    float optR = 0.0, optM = 0.0;

    for (int i = 0; i < STEPS; i++) {
        vec3  p  = ro + rd * (tMin + (float(i) + 0.5) * segLen);
        float h  = length(p) - EARTH_R;
        float dR = exp(-h / RAYLEIGH_H) * segLen;
        float dM = exp(-h / MIE_H)      * segLen;
        optR += dR; optM += dM;

        vec2 sunHit = raySphere(p, sun, ATMO_R);
        float sLen  = sunHit.y / float(LIGHT_STEPS);
        float sR = 0.0, sM = 0.0;
        bool shadow = false;
        for (int j = 0; j < LIGHT_STEPS; j++) {
            vec3 sp = p + sun * ((float(j) + 0.5) * sLen);
            float sh = length(sp) - EARTH_R;
            if (sh < 0.0) { shadow = true; break; }
            sR += exp(-sh / RAYLEIGH_H) * sLen;
            sM += exp(-sh / MIE_H)      * sLen;
        }
        if (!shadow) {
            vec3 tau  = RAYLEIGH_B * (optR + sR) + MIE_B * (optM + sM) * 1.1;
            vec3 atten = exp(-tau);
            sumR += dR * atten;
            sumM += dM * atten;
        }
    }

    vec3 scatter = SUN_I * (sumR * RAYLEIGH_B * phR + sumM * MIE_B * phM);

    // Approximate second-order scatter as ambient lift
    float ambStr = max(sun.y, 0.0) * 0.15;
    scatter += ambStr * SUN_I * RAYLEIGH_B * optR * exp(-RAYLEIGH_B * optR * 0.5);

    return scatter;
}

vec3 sunDisk(vec3 rd, vec3 sun) {
    float angle = acos(clamp(dot(rd, sun), -1.0, 1.0));
    if (angle > SUN_ANG * 1.5) return vec3(0.0);
    float edge = 1.0 - smoothstep(SUN_ANG * 0.85, SUN_ANG * 1.1, angle);
    float mu   = cos(angle / SUN_ANG * 1.5707963);
    float limb = 0.4 + 0.6 * pow(max(mu, 0.0), 0.4);
    return vec3(1.2) * edge * limb;
}

void main() {
    vec3 rd = normalize(vWorldDir);

    vec3 skyDir = rd;
    float below = 0.0;
    if (rd.y < 0.0) {
        skyDir = normalize(vec3(rd.x, -rd.y * 0.1, rd.z));
        below  = 1.0;
    }

    vec3 color = atmosphere(skyDir, uSunDir);
    if (below < 0.5) color += sunDisk(rd, uSunDir);
    else             color *= 0.02;

    // Night base
    float night = smoothstep(-0.1, 0.05, -uSunDir.y);
    color = mix(color, max(color, vec3(0.001, 0.002, 0.004)), night);

    gl_FragColor = vec4(color, 1.0);
}
`;

// ── SkyManager ────────────────────────────────────────────────────────────────
export class SkyManager {
    constructor(scene, renderer) {
        this._scene    = scene;
        this._renderer = renderer;

        // Public state — consumed by main.js, fogManager, cloudManager, waterManager
        this.sunDirection = new THREE.Vector3(0, 1, 0);
        this.sunElevation = 0.5;
        this.sunColor     = new THREE.Color(1.0, 0.95, 0.85);
        this.ambientColor = new THREE.Color(0.1, 0.15, 0.25);
        this.bloomColor   = new THREE.Color(1, 1, 1);

        // Sky cube render target — updated every ~60 frames
        this._cubeRT = new THREE.WebGLCubeRenderTarget(256, {
            format:          THREE.RGBAFormat,
            type:            THREE.HalfFloatType,
            generateMipmaps: true,
            minFilter:       THREE.LinearMipmapLinearFilter,
        });

        this._skyMat = new THREE.ShaderMaterial({
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

        this._skyMesh   = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 3), this._skyMat);
        this._skyScene  = new THREE.Scene();
        this._skyScene.add(this._skyMesh);
        this._cubeCamera = new THREE.CubeCamera(0.1, 10, this._cubeRT);

        this._frame      = 0;
        this._needsUpdate = true;

        // Compute initial sun position from current UTC time (sim time aware)
        const now   = simClock.date();
        const doy   = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
        const decRad = -23.45 * (Math.PI / 180) * Math.cos(2 * Math.PI * (doy + 10) / 365.25);
        const utcH   = now.getUTCHours() + now.getUTCMinutes() / 60;
        this.update(decRad, ((12 - utcH) / 24) * 2 * Math.PI);
    }

    update(latRad, lonRad) {
        const cosLat = Math.cos(latRad);
        this.sunDirection.set(
            cosLat * Math.sin(lonRad),
            Math.sin(latRad),
            cosLat * Math.cos(lonRad)
        ).normalize();

        this.sunElevation = this.sunDirection.y;

        this._skyMat.uniforms.uSunDir.value.copy(this.sunDirection);
        this._skyMat.uniforms.uSunElevation.value = this.sunElevation;

        // Sun color — atmospheric extinction along air mass path
        const alt      = Math.max(this.sunElevation, -0.05);
        const airMass  = Math.min(1.0 / (alt + 0.15 * Math.pow(3.885 + alt, -1.253)), 40);
        this.sunColor.setRGB(
            Math.exp(-airMass * RAYLEIGH_BETA[0] * EARTH_RADIUS * 0.01),
            Math.exp(-airMass * RAYLEIGH_BETA[1] * EARTH_RADIUS * 0.01),
            Math.exp(-airMass * RAYLEIGH_BETA[2] * EARTH_RADIUS * 0.01)
        ).multiplyScalar(Math.max(0, this.sunElevation) * 2.5 + 0.1);

        // Ambient — blue-shifted sky light, kept dim for tactical readability
        const a = Math.max(0.02, this.sunElevation * 0.15 + 0.05);
        this.ambientColor.setRGB(
            0.02 + a * 0.08,
            0.03 + a * 0.12,
            0.06 + a * 0.20
        );

        // Bloom color
        const e = this.sunElevation;
        if      (e > 0.15)  this.bloomColor.setRGB(1, 1, 1);
        else if (e > -0.05) { const t = (e + 0.05) / 0.20; this.bloomColor.setRGB(1, 0.6 + 0.4 * t, 0.3 + 0.7 * t); }
        else                 this.bloomColor.setRGB(0.4, 0.5, 0.8);

        // Push to water shader (only if the uniform exists)
        if (waterUniforms.uSunDir)       waterUniforms.uSunDir.value.copy(this.sunDirection);
        if (waterUniforms.uSunElevation) waterUniforms.uSunElevation.value = this.sunElevation;

        this._needsUpdate = true;
    }

    // Called every frame from animation loop
    renderSky() {
        this._frame++;
        const interval = window.vg1_sky_cubeInterval || 60;
        if (!this._needsUpdate && this._frame % interval !== 0) return;
        this._needsUpdate = false;
        this._cubeCamera.update(this._renderer, this._skyScene);
        this._scene.background = this._cubeRT.texture;
    }

    dispose() {
        this._cubeRT.dispose();
        this._skyMat.dispose();
        this._skyMesh.geometry.dispose();
    }
}
