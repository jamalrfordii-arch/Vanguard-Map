// navLightManager.js — AIS vessel navigation lights (port red / starboard green)
//
// Maritime convention:
//   Port      = left side of vessel facing forward  → RED
//   Starboard = right side of vessel facing forward → GREEN
//
// Lights are rendered as AdditiveBlending Points with a circular glow shader.
// They fade in as the sun sets (uNight → 1 when sunElevation < 0.10) and bloom
// through the UnrealBloomPass against the dark ocean — green clears the 0.65
// luminance threshold naturally; red is boosted to (1.8, 0.1, 0.05) to force
// bloom through ACESFilmic tone mapping.
//
// One pre-allocated Float32Array per color covers up to MAX_VESSELS positions;
// each frame we write only the live vessels and set the draw range accordingly —
// zero per-frame allocations after construction.

import * as THREE from 'three';
import { AIS } from './config.js';

const MAX_VESSELS = AIS.MAX_VESSELS + 100;  // safe headroom above AISManager cap
const SIDE_OFFSET = 0.14;  // scene units lateral from hull centerline
const HEIGHT      = 0.55;  // scene units above vessel position

// ── Shaders ───────────────────────────────────────────────────────────────────
const NAV_VERT = /* glsl */`
    uniform float uNight;     // 0 = full day, 1 = full night
    varying  float vNight;

    void main() {
        vNight = uNight;

        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);

        // Perspective-correct point size: larger close up, shrinks with distance.
        // 220.0 is a scene-unit calibration constant — tweak if too large/small.
        float dist     = max(1.0, -mvPos.z);
        gl_PointSize   = uNight * (220.0 / dist);
        gl_Position    = projectionMatrix * mvPos;
    }
`;

const NAV_FRAG = /* glsl */`
    uniform vec3  uColor;
    varying float vNight;

    void main() {
        if (vNight < 0.01) discard;

        // Circular soft glow — hard edge at radius 1.0
        vec2  ctr  = gl_PointCoord - 0.5;
        float d    = length(ctr) * 2.0;
        if (d > 1.0) discard;

        float glow = pow(1.0 - d, 1.6);
        gl_FragColor = vec4(uColor * glow, glow * vNight);
    }
`;

// ── NavLightManager ───────────────────────────────────────────────────────────
export class NavLightManager {
    constructor(scene) {
        this._scene = scene;

        // Pre-allocated CPU buffers
        this._portBuf = new Float32Array(MAX_VESSELS * 3);
        this._stbdBuf = new Float32Array(MAX_VESSELS * 3);

        // Shared night uniform — updated once per frame
        this._uNight = { value: 0.0 };

        // ── Port lights (RED) ─────────────────────────────────────────────────
        // Boosted red (>1 R channel) so ACESFilmic tone-mapping still clips it
        // warm-red above the bloom threshold rather than grey.
        const portGeo = this._makeGeo(this._portBuf);
        const portMat = new THREE.ShaderMaterial({
            uniforms: {
                uColor: { value: new THREE.Color(1.8, 0.10, 0.05) },
                uNight: this._uNight,
            },
            vertexShader:   NAV_VERT,
            fragmentShader: NAV_FRAG,
            transparent:    true,
            depthWrite:     false,
            blending:       THREE.AdditiveBlending,
        });

        // ── Starboard lights (GREEN) ──────────────────────────────────────────
        // Luminance of (0.05, 1.6, 0.2) ≈ 0.05*0.21 + 1.6*0.72 + 0.2*0.07 ≈ 1.17
        // Well above the 0.65 bloom threshold → natural green halo at night.
        const stbdGeo = this._makeGeo(this._stbdBuf);
        const stbdMat = new THREE.ShaderMaterial({
            uniforms: {
                uColor: { value: new THREE.Color(0.05, 1.6, 0.20) },
                uNight: this._uNight,
            },
            vertexShader:   NAV_VERT,
            fragmentShader: NAV_FRAG,
            transparent:    true,
            depthWrite:     false,
            blending:       THREE.AdditiveBlending,
        });

        this._portPoints = new THREE.Points(portGeo, portMat);
        this._stbdPoints = new THREE.Points(stbdGeo, stbdMat);

        // Render after terrain + ocean so lights composite on top correctly
        this._portPoints.renderOrder   = 15;
        this._stbdPoints.renderOrder   = 15;
        this._portPoints.frustumCulled = false;
        this._stbdPoints.frustumCulled = false;

        scene.add(this._portPoints);
        scene.add(this._stbdPoints);
    }

    _makeGeo(buffer) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(buffer, 3));
        geo.setDrawRange(0, 0); // nothing drawn until first update()
        return geo;
    }

    // ── update ────────────────────────────────────────────────────────────────
    // Call every frame from main.js.
    //   vessels      — AISManager.vessels  (Map<mmsi, vesselData>)
    //   sunElevation — SkyManager.sunElevation  (-1 to 1)
    update(vessels, sunElevation) {
        // Night factor: fade in through civil twilight (sun 0° → -9°)
        // smoothstep(0.15, -0.15, elev) → 0 at sun=0.15, 1 at sun=-0.15
        const night = Math.max(0, Math.min(1, (0.15 - sunElevation) / 0.30));
        this._uNight.value = night;

        if (night < 0.005) {
            // Nothing visible — skip position writes
            this._portPoints.geometry.setDrawRange(0, 0);
            this._stbdPoints.geometry.setDrawRange(0, 0);
            return;
        }

        let idx = 0;

        vessels.forEach(v => {
            if (idx >= MAX_VESSELS) return;
            if (!v.currentPos) return;

            const hdgRad = (v.headingDeg ?? 0) * (Math.PI / 180);

            // Perpendicular directions in XZ plane:
            //   Forward: ( sin(hdg),  0, -cos(hdg) )
            //   RIGHT (starboard): ( cos(hdg), 0,  sin(hdg) )
            //   LEFT  (port):      (-cos(hdg), 0, -sin(hdg) )
            const cx = Math.cos(hdgRad);
            const sz = Math.sin(hdgRad);

            const px = v.currentPos.x;
            const py = v.currentPos.y + HEIGHT;
            const pz = v.currentPos.z;

            // Port — offset to the left
            this._portBuf[idx * 3    ] = px - cx * SIDE_OFFSET;
            this._portBuf[idx * 3 + 1] = py;
            this._portBuf[idx * 3 + 2] = pz - sz * SIDE_OFFSET;

            // Starboard — offset to the right
            this._stbdBuf[idx * 3    ] = px + cx * SIDE_OFFSET;
            this._stbdBuf[idx * 3 + 1] = py;
            this._stbdBuf[idx * 3 + 2] = pz + sz * SIDE_OFFSET;

            idx++;
        });

        this._portPoints.geometry.setDrawRange(0, idx);
        this._stbdPoints.geometry.setDrawRange(0, idx);
        this._portPoints.geometry.attributes.position.needsUpdate = true;
        this._stbdPoints.geometry.attributes.position.needsUpdate = true;
    }

    dispose() {
        this._scene.remove(this._portPoints);
        this._scene.remove(this._stbdPoints);
        this._portPoints.geometry.dispose();
        this._stbdPoints.geometry.dispose();
        this._portPoints.material.dispose();
        this._stbdPoints.material.dispose();
    }
}
