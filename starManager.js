// starManager.js — Calm starfield surrounding the board.
//
// A large point-cloud sphere of stars sits far beyond the map, giving the
// scene a quiet "board floating in space" backdrop that frames the action and
// draws the eye inward. Deliberately subtle per the project aesthetic
// ("dark default; glow earns attention") — no bright points that compete with
// the map's own glow, just a soft field with gentle parallax as you orbit and
// an almost-imperceptible drift.
//
// Cheap: one THREE.Points, one draw call, no per-frame allocation. The slow
// rotation is optional life — the field looks right even static.

import * as THREE from 'three';

const STAR_COUNT  = 2600;
const RADIUS_MIN  = 700;    // beyond the sky dome (550) and aquarium
const RADIUS_MAX  = 1100;
const DRIFT_RATE  = 0.0008; // radians/sec — barely-there rotation

// Brightness/size bumped up 2026-06-28 per Jamal (wanted a more noticeable
// starfield) — was 0.35-0.80 brightness / 1.3px-1.3px size / 6% brighter
// anchors at 2.4px. Still safely under the 0.95 bloom threshold.

export class StarManager {
    constructor(scene) {
        this.group = new THREE.Group();
        this.group.name = 'starfield';
        scene.add(this.group);

        const pos   = new Float32Array(STAR_COUNT * 3);
        const col   = new Float32Array(STAR_COUNT * 3);
        const sizes = new Float32Array(STAR_COUNT);

        // Cool default with occasional warm/blue variation — calm, not festive.
        const palette = [
            [0.85, 0.90, 1.00],  // cool white (most common)
            [0.85, 0.90, 1.00],
            [0.85, 0.90, 1.00],
            [0.70, 0.80, 1.00],  // faint blue
            [1.00, 0.92, 0.80],  // faint warm
        ];

        for (let i = 0; i < STAR_COUNT; i++) {
            // Uniform direction on a sphere, biased gently upward so the field
            // reads strongest above the horizon (less under the opaque board).
            const u = Math.random();
            const v = Math.random();
            const theta = 2 * Math.PI * u;
            let   phi   = Math.acos(2 * v - 1);
            phi = phi * 0.85;  // pull slightly toward the top hemisphere

            const r = RADIUS_MIN + Math.random() * (RADIUS_MAX - RADIUS_MIN);
            const sinPhi = Math.sin(phi);
            pos[i * 3]     = r * sinPhi * Math.cos(theta);
            pos[i * 3 + 1] = r * Math.cos(phi);        // mostly +Y (above)
            pos[i * 3 + 2] = r * sinPhi * Math.sin(theta);

            const c = palette[(Math.random() * palette.length) | 0];
            // Vary brightness so the field has depth; keep the ceiling low so
            // nothing rivals the map (and stays under the 0.95 bloom threshold).
            const b = 0.55 + Math.random() * 0.45;
            col[i * 3]     = c[0] * b;
            col[i * 3 + 1] = c[1] * b;
            col[i * 3 + 2] = c[2] * b;

            sizes[i] = Math.random() < 0.12 ? 3.2 : 1.8;  // a few brighter anchors
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));
        geo.setAttribute('aSize',    new THREE.BufferAttribute(sizes, 1));

        const mat = new THREE.ShaderMaterial({
            transparent: true, depthWrite: false, depthTest: true,
            blending: THREE.AdditiveBlending,
            uniforms: { uTime: { value: 0 } },
            vertexShader: /* glsl */`
                attribute float aSize;
                varying vec3 vColor;
                varying float vTw;
                uniform float uTime;
                void main() {
                    vColor = color;
                    // Gentle per-star twinkle — slow, low amplitude (calming).
                    vTw = 0.85 + 0.15 * sin(uTime * 0.5 + position.x * 0.05 + position.z * 0.03);
                    vec4 mv = modelViewMatrix * vec4(position, 1.0);
                    gl_PointSize = aSize;
                    gl_Position  = projectionMatrix * mv;
                }`,
            fragmentShader: /* glsl */`
                varying vec3 vColor;
                varying float vTw;
                void main() {
                    // Round soft point
                    vec2 d = gl_PointCoord - 0.5;
                    float a = smoothstep(0.5, 0.0, length(d));
                    gl_FragColor = vec4(vColor * vTw, a);
                }`,
            vertexColors: true,
        });

        this.points = new THREE.Points(geo, mat);
        this.points.renderOrder = -10;        // behind everything
        this.points.frustumCulled = false;
        this.group.add(this.points);
        this._mat = mat;
    }

    // elapsed seconds — drives the slow drift + twinkle. Safe to skip frames.
    update(elapsed, delta) {
        this._mat.uniforms.uTime.value = elapsed;
        this.group.rotation.y += DRIFT_RATE * (delta ?? 0.016);
    }
}
