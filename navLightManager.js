// navLightManager.js — AIS vessel navigation lights (port/stbd/masthead/stern)
//
// Maritime convention (COLREG Rule 21):
//   Port      = left side of vessel facing forward  → RED,   112.5° arc
//   Starboard = right side of vessel facing forward → GREEN, 112.5° arc
//   Masthead  = forward, highest of the four         → WHITE, 225° fwd arc
//   Sternlight = aft, lowest of the four              → WHITE, 135° aft arc
// (A second, higher aft masthead light is required for vessels >50m — not
// modeled here; four lights already covers the readable COLREG silhouette
// for a tactical map at this scale.)
//
// Lights are rendered as AdditiveBlending Points with a circular glow shader.
// They fade in as the sun sets (uNight → 1 when sunElevation < 0.10) and bloom
// through the UnrealBloomPass against the dark ocean — green clears the 0.65
// luminance threshold naturally; red is boosted to (1.8, 0.1, 0.05) and white
// to (1.6, 1.6, 1.5) to force bloom through ACESFilmic tone mapping.
//
// None of the four lights are angle-culled to their real COLREG arc (that
// would need per-fragment view-angle math against each vessel's heading) —
// same simplification the original port/stbd pair already made. They're
// always-visible-at-night point sprites; realism here is in count, color,
// and position (masthead forward+high, sternlight aft+low), not viewing arc.
//
// One pre-allocated Float32Array per color covers up to MAX_VESSELS positions;
// each frame we write only the live vessels and set the draw range accordingly —
// zero per-frame allocations after construction.

import * as THREE from 'three';
import { AIS } from './config.js';

const MAX_VESSELS = AIS.MAX_VESSELS + 100;  // safe headroom above AISManager cap
const SIDE_OFFSET = 0.14;  // scene units lateral from hull centerline
const HEIGHT      = 0.55;  // scene units above vessel position — port/stbd

const FWD_OFFSET   = 0.30;  // scene units forward of center — masthead
const AFT_OFFSET   = 0.32;  // scene units aft of center — sternlight
const MAST_HEIGHT  = 0.90;  // masthead sits above port/stbd (highest light)
const STERN_HEIGHT = 0.40;  // sternlight sits below port/stbd (lowest light)

// ── Shaders ───────────────────────────────────────────────────────────────────
const NAV_VERT = /* glsl */`
    uniform float uNight;     // 0 = full day, 1 = full night
    uniform float uCameraY;   // camera altitude in scene units
    varying  float vNight;

    void main() {
        vNight = uNight;

        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);

        // Perspective-correct point size: larger close up, shrinks with distance.
        float dist     = max(1.0, -mvPos.z);
        float baseSize = 220.0 / dist;

        // Scale down at low camera altitudes so lights don't overpower terrain.
        // Uses sqrt for a gentle curve: at y=100 → 1.0, y=25 → 0.5, y=6 → 0.25, y=1 → 0.1.
        float altScale = clamp(sqrt(uCameraY / 100.0), 0.10, 1.0);

        gl_PointSize   = min(uNight * baseSize * altScale, 12.0);
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
        this._portBuf  = new Float32Array(MAX_VESSELS * 3);
        this._stbdBuf  = new Float32Array(MAX_VESSELS * 3);
        this._mastBuf  = new Float32Array(MAX_VESSELS * 3);
        this._sternBuf = new Float32Array(MAX_VESSELS * 3);

        // Shared uniforms — updated once per frame
        this._uNight   = { value: 0.0 };
        this._uCameraY = { value: 100.0 };

        // ── Port lights (RED) ─────────────────────────────────────────────────
        // Boosted red (>1 R channel) so ACESFilmic tone-mapping still clips it
        // warm-red above the bloom threshold rather than grey.
        const portGeo = this._makeGeo(this._portBuf);
        const portMat = new THREE.ShaderMaterial({
            uniforms: {
                uColor:   { value: new THREE.Color(1.8, 0.10, 0.05) },
                uNight:   this._uNight,
                uCameraY: this._uCameraY,
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
                uColor:   { value: new THREE.Color(0.05, 1.6, 0.20) },
                uNight:   this._uNight,
                uCameraY: this._uCameraY,
            },
            vertexShader:   NAV_VERT,
            fragmentShader: NAV_FRAG,
            transparent:    true,
            depthWrite:     false,
            blending:       THREE.AdditiveBlending,
        });

        // ── Masthead + sternlight (WHITE) ─────────────────────────────────────
        // Boosted like the port light — plain (1,1,1) white clears bloom but
        // reads flat; nudging toward (1.6,1.6,1.5) keeps it a crisp warm-white
        // point rather than blowing out to a featureless disc.
        const whiteColor = () => new THREE.Color(1.6, 1.6, 1.5);

        const mastGeo = this._makeGeo(this._mastBuf);
        const mastMat = new THREE.ShaderMaterial({
            uniforms: { uColor: { value: whiteColor() }, uNight: this._uNight, uCameraY: this._uCameraY },
            vertexShader: NAV_VERT, fragmentShader: NAV_FRAG,
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        });

        const sternGeo = this._makeGeo(this._sternBuf);
        const sternMat = new THREE.ShaderMaterial({
            uniforms: { uColor: { value: whiteColor() }, uNight: this._uNight, uCameraY: this._uCameraY },
            vertexShader: NAV_VERT, fragmentShader: NAV_FRAG,
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        });

        this._portPoints  = new THREE.Points(portGeo, portMat);
        this._stbdPoints  = new THREE.Points(stbdGeo, stbdMat);
        this._mastPoints  = new THREE.Points(mastGeo, mastMat);
        this._sternPoints = new THREE.Points(sternGeo, sternMat);

        // Render after terrain + ocean so lights composite on top correctly
        this._portPoints.renderOrder   = 15;
        this._stbdPoints.renderOrder   = 15;
        this._mastPoints.renderOrder   = 15;
        this._sternPoints.renderOrder  = 15;
        this._portPoints.frustumCulled  = false;
        this._stbdPoints.frustumCulled  = false;
        this._mastPoints.frustumCulled  = false;
        this._sternPoints.frustumCulled = false;

        scene.add(this._portPoints);
        scene.add(this._stbdPoints);
        scene.add(this._mastPoints);
        scene.add(this._sternPoints);
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
    update(vessels, sunElevation, cameraY) {
        // Night factor: fade in through civil twilight (sun 0° → -9°)
        // smoothstep(0.15, -0.15, elev) → 0 at sun=0.15, 1 at sun=-0.15
        const night = Math.max(0, Math.min(1, (0.15 - sunElevation) / 0.30));
        this._uNight.value = night;
        this._uCameraY.value = cameraY ?? 100;

        if (night < 0.005) {
            // Nothing visible — skip position writes
            this._portPoints.geometry.setDrawRange(0, 0);
            this._stbdPoints.geometry.setDrawRange(0, 0);
            this._mastPoints.geometry.setDrawRange(0, 0);
            this._sternPoints.geometry.setDrawRange(0, 0);
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
            const fx = Math.sin(hdgRad);
            const fz = -Math.cos(hdgRad);

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

            // Masthead — forward and highest of the four
            this._mastBuf[idx * 3    ] = px + fx * FWD_OFFSET;
            this._mastBuf[idx * 3 + 1] = v.currentPos.y + MAST_HEIGHT;
            this._mastBuf[idx * 3 + 2] = pz + fz * FWD_OFFSET;

            // Sternlight — aft and lowest of the four
            this._sternBuf[idx * 3    ] = px - fx * AFT_OFFSET;
            this._sternBuf[idx * 3 + 1] = v.currentPos.y + STERN_HEIGHT;
            this._sternBuf[idx * 3 + 2] = pz - fz * AFT_OFFSET;

            idx++;
        });

        this._portPoints.geometry.setDrawRange(0, idx);
        this._stbdPoints.geometry.setDrawRange(0, idx);
        this._mastPoints.geometry.setDrawRange(0, idx);
        this._sternPoints.geometry.setDrawRange(0, idx);
        this._portPoints.geometry.attributes.position.needsUpdate  = true;
        this._stbdPoints.geometry.attributes.position.needsUpdate  = true;
        this._mastPoints.geometry.attributes.position.needsUpdate  = true;
        this._sternPoints.geometry.attributes.position.needsUpdate = true;
    }

    dispose() {
        this._scene.remove(this._portPoints);
        this._scene.remove(this._stbdPoints);
        this._scene.remove(this._mastPoints);
        this._scene.remove(this._sternPoints);
        this._portPoints.geometry.dispose();
        this._stbdPoints.geometry.dispose();
        this._mastPoints.geometry.dispose();
        this._sternPoints.geometry.dispose();
        this._portPoints.material.dispose();
        this._stbdPoints.material.dispose();
        this._mastPoints.material.dispose();
        this._sternPoints.material.dispose();
    }
}
