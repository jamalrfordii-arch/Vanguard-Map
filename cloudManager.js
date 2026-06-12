// cloudManager.js — Volumetric cloud layer via ray-marching
//
// Full-screen ShaderPass. Marches 4-octave fBm through cloud slab y∈[35,78].
// Clouds are always light grey→white — the tactical sky ambient is NOT used
// so they are never black regardless of sun angle.
//
// Console:
//   window.vg1_cloud_enabled  = false
//   window.vg1_cloud_coverage = 0.20   (0=clear, 1=overcast)
// Layer toggle: dispatches 'layerToggle' { layer:'clouds', on:bool }

import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const MAX_STORMS = 4;

const CLOUD_VERT = /* glsl */`
varying vec2 vUv;
void main() {
    vUv         = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const CLOUD_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform mat4  uProjMatrix;
uniform mat4  uViewMatrix;
uniform vec3  uCameraPos;
uniform vec3  uSunDir;
uniform float uSunElevation;
uniform float uTime;
uniform float uCoverage;
uniform float uCameraY;
uniform vec3  uStormPos[4];
uniform float uStormRadius[4];
uniform float uStormIntensity[4];
uniform int   uStormCount;

varying vec2 vUv;

float hash3(vec3 p) {
    p  = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.x + p.y) * p.z);
}
float valueNoise(vec3 p) {
    vec3 pi = floor(p); vec3 pf = fract(p);
    pf = pf * pf * (3.0 - 2.0 * pf);
    return mix(
        mix(mix(hash3(pi),             hash3(pi+vec3(1,0,0)), pf.x),
            mix(hash3(pi+vec3(0,1,0)), hash3(pi+vec3(1,1,0)), pf.x), pf.y),
        mix(mix(hash3(pi+vec3(0,0,1)), hash3(pi+vec3(1,0,1)), pf.x),
            mix(hash3(pi+vec3(0,1,1)), hash3(pi+vec3(1,1,1)), pf.x), pf.y),
        pf.z);
}
float fbm4(vec3 p) {
    float v = 0.0; float a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * valueNoise(p); p *= 2.07; a *= 0.48; }
    return v;
}
float phaseHG(float c, float g) {
    float g2 = g*g;
    return (1.0-g2) / (4.0*3.14159265*pow(1.0+g2-2.0*g*c, 1.5));
}
float phaseDual(float c) {
    return mix(phaseHG(c, -0.3), phaseHG(c, 0.8), 0.7);
}

float cloudDens(vec3 pos, float bot, float top) {
    float hFrac = clamp((pos.y - bot)/(top - bot), 0.0, 1.0);
    float vert  = smoothstep(0.0,0.15,hFrac) * smoothstep(1.0,0.6,hFrac);
    float shape = fbm4(pos*0.012 + vec3(uTime*0.4, 0.0, uTime*0.2));
    float thresh = 0.52 - uCoverage*0.25;
    float storm  = 0.0;
    for (int s = 0; s < 4; s++) {
        if (s >= uStormCount) break;
        float d = length(pos.xz - uStormPos[s].xz);
        float r = uStormRadius[s];
        storm += (1.0 - smoothstep(r*0.2, r*1.8, d)) * uStormIntensity[s] * 0.35 * step(d, r*1.8);
    }
    thresh -= storm;
    float dens = smoothstep(thresh, thresh+0.15, shape) * vert;
    dens -= valueNoise(pos*0.06 + vec3(uTime*0.8, uTime*0.3, 0.0)) * 0.15;
    return max(dens, 0.0);
}

float lightMarch(vec3 pos, float bot, float top) {
    float total = 0.0;
    float step  = (top - bot) * 0.25;
    for (int i = 0; i < 4; i++) {
        pos += uSunDir * step;
        if (pos.y > top || pos.y < bot) break;
        total += cloudDens(pos, bot, top) * step;
    }
    return exp(-total * 4.0);
}

void main() {
    vec4 scene = texture2D(tDiffuse, vUv);

    // Altitude fade — disappears as camera zooms in below y=120
    float altFade = smoothstep(50.0, 120.0, uCameraY);
    if (altFade < 0.005) { gl_FragColor = scene; return; }

    // Reconstruct world ray
    vec2  ndc  = vUv*2.0-1.0;
    float tanY = 1.0 / uProjMatrix[1][1];
    float tanX = 1.0 / uProjMatrix[0][0];
    vec3  vd   = normalize(vec3(ndc.x*tanX, ndc.y*tanY, -1.0));
    mat3  v2w  = transpose(mat3(uViewMatrix));
    vec3  wd   = normalize(v2w * vd);

    float bot = 35.0;
    float top = 78.0;
    for (int s = 0; s < 4; s++) {
        if (s >= uStormCount) break;
        if (uStormIntensity[s] > 0.3) top = max(top, 78.0 + uStormIntensity[s]*30.0);
    }

    float tEnt = 0.0; float tEx = 800.0;
    if (abs(wd.y) > 0.0001) {
        float t0 = (bot - uCameraPos.y)/wd.y;
        float t1 = (top - uCameraPos.y)/wd.y;
        if (t0 > t1) { float tmp=t0; t0=t1; t1=tmp; }
        tEnt = max(t0, 0.0);
        tEx  = min(t1, 800.0);
    } else if (uCameraPos.y < bot || uCameraPos.y > top) {
        gl_FragColor = scene; return;
    }
    if (tEnt >= tEx || tEx < 0.0) { gl_FragColor = scene; return; }

    float stepLen = (tEx - tEnt) / 48.0;
    float cosT    = dot(wd, uSunDir);
    float phase   = phaseDual(cosT);

    // ── Cloud lighting — always bright white base, never black ────────────────
    // Sun contribution: white at noon, warm orange at dawn/dusk
    float sunT   = clamp(uSunElevation * 4.0 + 0.6, 0.0, 1.0);
    vec3  sunLit = mix(vec3(0.95, 0.60, 0.30), vec3(1.0, 1.0, 1.0), sunT) * max(sunT * 2.0, 0.5);

    // Ambient — hardcoded bright grey floor, completely independent of sky ambient.
    // This ensures clouds are always visible white/grey regardless of scene lighting.
    float ambT = clamp(uSunElevation * 2.0 + 0.8, 0.1, 1.0);
    vec3  amb  = mix(vec3(0.45, 0.50, 0.62), vec3(0.85, 0.88, 0.92), ambT);

    float transm = 1.0;
    vec3  lum    = vec3(0.0);

    for (int i = 0; i < 48; i++) {
        if (transm < 0.01) break;
        vec3  pos  = uCameraPos + wd*(tEnt+(float(i)+0.5)*stepLen);
        float dens = cloudDens(pos, bot, top);
        if (dens < 0.001) continue;
        dens *= stepLen;

        float sunVis  = lightMarch(pos, bot, top);
        float hFrac   = clamp((pos.y-bot)/(top-bot), 0.0, 1.0);
        vec3  direct  = sunLit * sunVis * phase;
        vec3  ambL    = mix(amb * 0.6, amb, hFrac);
        ambL         += sunLit * 0.12 * (1.0-sunVis);

        // Powder sugar effect — bright edges on thin cloud faces
        float powder  = 1.0 - exp(-dens * 10.0);
        // Boost luminance multiplier significantly for white clouds
        vec3  stepLum = (direct * powder + ambL) * dens * 1.8;
        float stepT   = exp(-dens * 6.0);
        lum    += transm * stepLum;
        transm *= stepT;
    }

    // Aerial perspective
    float aerT = 1.0 - exp(-max(tEnt,0.0) * 0.0004);
    lum = mix(lum, vec3(0.7, 0.75, 0.82) * (1.0-transm), aerT * 0.3);

    // Composite with altitude fade
    float blendTransm = mix(1.0, transm, altFade);
    vec3  blendLum    = lum * altFade;
    vec3  final       = scene.rgb * blendTransm + blendLum;
    gl_FragColor = vec4(final, scene.a);
}
`;

export class CloudManager {
    constructor() {
        const u = {
            tDiffuse:        { value: null },
            uProjMatrix:     { value: new THREE.Matrix4() },
            uViewMatrix:     { value: new THREE.Matrix4() },
            uCameraPos:      { value: new THREE.Vector3() },
            uSunDir:         { value: new THREE.Vector3(0, 1, 0) },
            uSunElevation:   { value: 0.5 },
            uTime:           { value: 0 },
            uCoverage:       { value: 0.20 },
            uCameraY:        { value: 200.0 },
            uStormPos:       { value: new Array(MAX_STORMS).fill(null).map(() => new THREE.Vector3()) },
            uStormRadius:    { value: new Float32Array(MAX_STORMS) },
            uStormIntensity: { value: new Float32Array(MAX_STORMS) },
            uStormCount:     { value: 0 },
        };
        this._pass = new ShaderPass({ uniforms: u, vertexShader: CLOUD_VERT, fragmentShader: CLOUD_FRAG });
        this._pass.needsSwap = true;
        window.vg1_cloud_enabled  = true;
        window.vg1_cloud_coverage = 0.20;
    }

    get pass() { return this._pass; }

    update(camera, sunDir, sunElevation, elapsed, stormCells) {
        if (!window.vg1_cloud_enabled) { this._pass.enabled = false; return; }
        this._pass.enabled = true;
        const u = this._pass.uniforms;
        u.uProjMatrix.value.copy(camera.projectionMatrix);
        u.uViewMatrix.value.copy(camera.matrixWorldInverse);
        u.uCameraPos.value.copy(camera.position);
        u.uSunDir.value.copy(sunDir);
        u.uSunElevation.value = sunElevation;
        u.uTime.value     = elapsed;
        u.uCameraY.value  = camera.position.y;
        u.uCoverage.value = window.vg1_cloud_coverage !== undefined ? window.vg1_cloud_coverage : 0.20;
        const count = stormCells ? Math.min(stormCells.length, MAX_STORMS) : 0;
        u.uStormCount.value = count;
        for (let i = 0; i < count; i++) {
            const s = stormCells[i];
            u.uStormPos.value[i].set(s.x, s.y || 0, s.z);
            u.uStormRadius.value[i]    = s.radius    || 30;
            u.uStormIntensity.value[i] = s.intensity || 0.5;
        }
    }
}
