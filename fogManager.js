// fogManager.js — Volumetric atmospheric fog + aerial perspective
//
// Full-screen ShaderPass that ray-marches atmospheric density along each
// pixel's view ray and composites additive inscatter over the scene.
//
// Features:
//   • Exponential height fog    — thickens toward sea level
//   • Animated turbulence       — analytic noise, no texture
//   • Storm halos               — denser caps around weather cells
//   • Mie forward scatter       — warm shaft toward the sun
//   • Aerial perspective        — distant objects fade to sky colour
//
// ShaderPass uses its own ortho camera — we pass the scene camera manually.
// Console: window.vg1_fog_enabled = false  (disable for perf comparison)

import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const MAX_STORMS = 4;

const FOG_VERT = /* glsl */`
varying vec2 vUv;
void main() {
    vUv         = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FOG_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform mat4  uProjMatrix;
uniform mat4  uViewMatrix;
uniform vec3  uCameraPos;
uniform vec3  uSunDir;
uniform float uSunElevation;
uniform vec3  uAmbientColor;
uniform float uTime;
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
float fbm2(vec3 p) {
    float v = 0.0; float a = 0.5;
    for (int i = 0; i < 2; i++) { v += a * valueNoise(p); p *= 2.03; a *= 0.5; }
    return v;
}
float phaseHG(float c, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * 3.14159265 * pow(1.0 + g2 - 2.0*g*c, 1.5));
}
float phaseR(float c) { return 3.0 / (16.0*3.14159265) * (1.0 + c*c); }

void main() {
    vec4 scene = texture2D(tDiffuse, vUv);

    // Reconstruct world-space ray
    vec2  ndc  = vUv * 2.0 - 1.0;
    float tanY = 1.0 / uProjMatrix[1][1];
    float tanX = 1.0 / uProjMatrix[0][0];
    vec3  vd   = normalize(vec3(ndc.x*tanX, ndc.y*tanY, -1.0));
    mat3  v2w  = transpose(mat3(uViewMatrix));
    vec3  wd   = normalize(v2w * vd);

    // Fog slab y in [-5, 25]
    float tEnt = 0.0;
    float tEx  = 600.0;
    if (abs(wd.y) > 0.0001) {
        float t0 = (-5.0 - uCameraPos.y) / wd.y;
        float t1 = (25.0 - uCameraPos.y) / wd.y;
        if (t0 > t1) { float tmp = t0; t0 = t1; t1 = tmp; }
        tEnt = max(t0, 0.0);
        tEx  = min(t1, 600.0);
    } else if (uCameraPos.y < -5.0 || uCameraPos.y > 25.0) {
        float aerT = 1.0 - exp(-600.0 * 0.0003);
        vec3  aerC = uAmbientColor * max(uSunElevation*0.5+0.3, 0.05);
        gl_FragColor = vec4(mix(scene.rgb, aerC, aerT*0.3), scene.a);
        return;
    }

    if (tEnt >= tEx) {
        float aerT = 1.0 - exp(-600.0 * 0.0003);
        vec3  aerC = uAmbientColor * max(uSunElevation*0.5+0.3, 0.05);
        gl_FragColor = vec4(mix(scene.rgb, aerC, aerT*0.3), scene.a);
        return;
    }

    float segLen = (tEx - tEnt) / 24.0;
    float cosT   = dot(wd, uSunDir);
    float mieP   = phaseHG(cosT, 0.76);
    float rayP   = phaseR(cosT);
    float sunF   = max(uSunElevation, 0.0);

    vec3 litCol;
    if (uSunElevation > 0.1) {
        litCol = vec3(0.65, 0.70, 0.80);
    } else if (uSunElevation > -0.05) {
        float t = (uSunElevation + 0.05) / 0.15;
        litCol  = mix(vec3(0.15,0.12,0.18), vec3(0.65,0.70,0.80), t);
        litCol += vec3(0.3,0.1,0.0) * (1.0-t) * max(mieP, 0.0);
    } else {
        litCol = vec3(0.03, 0.04, 0.06);
    }

    float transmit = 1.0;
    vec3  scatter  = vec3(0.0);

    for (int i = 0; i < 24; i++) {
        vec3  pos  = uCameraPos + wd * (tEnt + (float(i)+0.5)*segLen);
        float hFog = exp(-max(pos.y+5.0, 0.0) / 12.0);
        float turb = fbm2(pos * 0.015 + vec3(uTime*0.3, 0.0, uTime*0.15)) * 0.6;

        float stormD = 0.0;
        for (int s = 0; s < 4; s++) {
            if (s >= uStormCount) break;
            float d = length(pos.xz - uStormPos[s].xz);
            float r = uStormRadius[s];
            stormD += (1.0 - smoothstep(r*0.3, r*2.0, d)) * uStormIntensity[s] * 1.5
                    * step(d, r*2.0);
        }

        float dens  = (0.025 + turb*0.04 + stormD*0.3) * hFog * segLen;
        float stepT = exp(-dens * 0.8);
        vec3  light = litCol * (1.0 + mieP*sunF*0.6 + rayP*sunF*0.15);
        scatter    += transmit * (1.0 - stepT) * light;
        transmit   *= stepT;
    }

    // Aerial perspective
    float aerT = 1.0 - exp(-(tEx - tEnt) * 0.0008);
    vec3  aerC = uAmbientColor * max(uSunElevation*0.5+0.3, 0.05);
    vec3  fogged = mix(scene.rgb * transmit + scatter, aerC, aerT * 0.08);

    // Altitude fade — fog fully dissolves as camera zooms into terrain.
    // Full at cameraY >= 80, gone at cameraY <= 25.
    float fogAltFade = smoothstep(25.0, 80.0, uCameraPos.y);
    vec3  final = mix(scene.rgb, fogged, fogAltFade);

    gl_FragColor = vec4(final, scene.a);
}
`;

export class FogManager {
    constructor() {
        const u = {
            tDiffuse:        { value: null },
            uProjMatrix:     { value: new THREE.Matrix4() },
            uViewMatrix:     { value: new THREE.Matrix4() },
            uCameraPos:      { value: new THREE.Vector3() },
            uSunDir:         { value: new THREE.Vector3(0, 1, 0) },
            uSunElevation:   { value: 0.5 },
            uAmbientColor:   { value: new THREE.Vector3(0.1, 0.15, 0.25) },
            uTime:           { value: 0 },
            uStormPos:       { value: new Array(MAX_STORMS).fill(null).map(() => new THREE.Vector3()) },
            uStormRadius:    { value: new Float32Array(MAX_STORMS) },
            uStormIntensity: { value: new Float32Array(MAX_STORMS) },
            uStormCount:     { value: 0 },
        };
        this._pass = new ShaderPass({ uniforms: u, vertexShader: FOG_VERT, fragmentShader: FOG_FRAG });
        this._pass.needsSwap = true;
        window.vg1_fog_enabled = true;
    }

    get pass() { return this._pass; }

    update(camera, sunDir, sunElevation, ambientColor, elapsed, stormCells) {
        if (!window.vg1_fog_enabled) { this._pass.enabled = false; return; }
        this._pass.enabled = true;
        const u = this._pass.uniforms;
        u.uProjMatrix.value.copy(camera.projectionMatrix);
        u.uViewMatrix.value.copy(camera.matrixWorldInverse);
        u.uCameraPos.value.copy(camera.position);
        u.uSunDir.value.copy(sunDir);
        u.uSunElevation.value = sunElevation;
        if (ambientColor) u.uAmbientColor.value.set(ambientColor.r, ambientColor.g, ambientColor.b);
        u.uTime.value = elapsed;
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
