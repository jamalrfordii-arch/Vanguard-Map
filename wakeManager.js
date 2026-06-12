// wakeManager.js — Kelvin V-wake shader for AIS surface vessels
//
// The Kelvin wake is mathematically universal: regardless of speed the wake
// always forms a V with half-angle arcsin(1/3) ≈ 19.47°.  Two components:
//   • Transverse waves  — perpendicular crests inside the V envelope
//   • Diverging waves   — running along the cusp arms themselves
//   • Central churn     — turbulent white water directly behind the hull
//
// One PlaneGeometry is shared across all vessels; each vessel carries its own
// ShaderMaterial so uSpeed / uOpacity can differ per entity.  A pivot Object3D
// handles world-position + heading rotation, keeping the mesh math clean.
//
// UV convention (after rotation.x = -PI/2 + position.z = -WAKE_LENGTH/2):
//   vUv.y = 0  →  at vessel stern  (bright, full pattern)
//   vUv.y = 1  →  far tip of wake  (faded out)
//   vUv.x = 0  →  port edge
//   vUv.x = 1  →  starboard edge

import * as THREE from 'three';

const WAKE_WIDTH  = 18;   // scene units, lateral spread
const WAKE_LENGTH = 50;   // scene units, trailing length

// ── Shaders ───────────────────────────────────────────────────────────────────
const WAKE_VERT = /* glsl */`
    varying vec2 vUv;
    void main() {
        vUv         = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const WAKE_FRAG = /* glsl */`
    uniform float uTime;
    uniform float uSpeed;    // normalised 0–1 (speedKts / 20)
    uniform float uOpacity;  // smoothly animated from speed

    varying vec2 vUv;

    // Kelvin universal cusp half-angle: arcsin(1/3) ≈ 19.47°, tan ≈ 0.35355
    const float KELVIN = 0.35355;
    const float W = ${WAKE_WIDTH.toFixed(1)};
    const float L = ${WAKE_LENGTH.toFixed(1)};

    void main() {
        // ── Wake coordinates ──────────────────────────────────────────────────
        // lon: 0 = stern (vessel), L = far tip of wake
        // lat: signed lateral distance from the centreline
        float lon    = vUv.y * L;
        float lat    = (vUv.x - 0.5) * W;
        float abslat = abs(lat);

        // Angle ratio — equals tan(θ) where θ is the angle from the heading
        float ratio  = abslat / max(lon, 0.3);

        // ── Kelvin envelope ───────────────────────────────────────────────────
        // Smoothly 1 inside the V-cone, 0 outside; transition at the cusp line
        float inV = 1.0 - smoothstep(KELVIN * 0.80, KELVIN * 1.08, ratio);

        // ── Transverse waves (cross-wake crests, inside the V) ────────────────
        // Wavenumber scales mildly with speed — faster vessels produce tighter
        // wave packing near the stern.
        float kT     = (0.85 + uSpeed * 0.45);
        float transv = sin(lon * kT - uTime * 3.2) * inV;

        // ── Diverging waves (along the cusp arms) ─────────────────────────────
        // Radial distance from stern drives phase; outside the V envelope.
        float r      = sqrt(lon * lon + lat * lat * 0.35);
        float diverg = sin(r * 0.70 - uTime * 2.3) * (1.0 - inV * 0.82);

        // ── Cusp-line foam ────────────────────────────────────────────────────
        // The most visually striking part of a real Kelvin wake — bright foam
        // exactly at the 19.47° arms, fading with distance from the hull.
        float cuspProx = exp(-abs(ratio - KELVIN) * 20.0);
        float cuspFade = 1.0 - smoothstep(0.0, 0.82, vUv.y);
        float cuspFoam = cuspProx * cuspFade;

        // ── Central turbulent churn (directly behind the hull) ────────────────
        float centerLine = exp(-abslat * abslat * 2.2);
        float centerFade = 1.0 - smoothstep(0.0, 0.20, vUv.y);
        float churn      = centerLine * centerFade;

        // ── Distance fade — quadratic roll-off from stern to tip ─────────────
        float nearFade = (1.0 - vUv.y) * (1.0 - vUv.y);

        // ── Composite ─────────────────────────────────────────────────────────
        float pattern = transv * 0.40 + diverg * 0.28 + cuspFoam * 0.95 + churn;
        // Max 0.52 — visible from tactical altitude without overwhelming the ocean.
        float alpha   = clamp(pattern * nearFade * 0.48, 0.0, 0.52) * uOpacity;

        // Wake colour — white foam to dark ocean blue
        vec3 foam  = vec3(0.80, 0.91, 1.00);
        vec3 ocean = vec3(0.03, 0.09, 0.22);
        vec3 color = mix(ocean, foam, clamp(pattern * nearFade, 0.0, 1.0));

        gl_FragColor = vec4(color, alpha);
    }
`;

// ── WakeManager ───────────────────────────────────────────────────────────────
export class WakeManager {
    constructor(scene) {
        this._scene = scene;
        this._wakes = new Map(); // entity Object3D → { pivot, mat }

        // Shared read-only geometry — PlaneGeometry lies in the XY plane.
        // Each mesh instance applies rotation.x = -PI/2 to lay it flat,
        // then position.z = -WAKE_LENGTH/2 so the near edge sits at the pivot
        // origin (vessel stern) and the far edge trails WAKE_LENGTH behind.
        this._geo = new THREE.PlaneGeometry(WAKE_WIDTH, WAKE_LENGTH, 1, 8);
    }

    // ── Register ──────────────────────────────────────────────────────────────
    // Call from aisManager.onVesselNew for every surface vessel.
    register(entity) {
        if (this._wakes.has(entity)) return;

        const mat = new THREE.ShaderMaterial({
            uniforms: {
                uTime:    { value: 0 },
                uSpeed:   { value: 0 },
                uOpacity: { value: 0 }, // fades in once vessel moves
            },
            vertexShader:   WAKE_VERT,
            fragmentShader: WAKE_FRAG,
            transparent:    true,
            depthWrite:     false,
            side:           THREE.DoubleSide,
        });

        const mesh        = new THREE.Mesh(this._geo, mat);
        mesh.rotation.x   = -Math.PI / 2;     // lay flat on water plane
        mesh.position.z   = -WAKE_LENGTH / 2; // near edge at z=0, far at z=-L

        // Pivot owns world position + compass-heading rotation.
        // mesh.rotation.x (-PI/2) and pivot.rotation.y (heading) are on
        // separate objects so they compose without Euler-order issues.
        const pivot = new THREE.Object3D();
        pivot.add(mesh);
        this._scene.add(pivot);

        this._wakes.set(entity, { pivot, mat });
    }

    // ── Unregister ────────────────────────────────────────────────────────────
    // Call from aisManager.onVesselRemove.
    unregister(entity) {
        const w = this._wakes.get(entity);
        if (!w) return;
        this._scene.remove(w.pivot);
        w.mat.dispose();
        this._wakes.delete(entity);
    }

    // ── update ────────────────────────────────────────────────────────────────
    // Call every frame from the animation loop.
    update(elapsed) {
        this._wakes.forEach((w, entity) => {
            const speedKts = entity.userData.speedKts ?? 0;

            // Y = 1.5: sits above the max Gerstner crest (ocean base -0.2,
            // max wave amplitude ≈ 1.5 → max crest ≈ 1.3) so wave geometry
            // never clips through the wake plane in the depth buffer.
            w.pivot.position.set(entity.position.x, 1.5, entity.position.z);

            // Match vessel compass heading (rotation.y = PI - hdgRad convention)
            w.pivot.rotation.y = entity.rotation.y;

            // Smoothly fade opacity in above 2 kts; invisible when anchored
            const targetOpacity = Math.max(0, Math.min(1, (speedKts - 2) / 8));
            const u = w.mat.uniforms;
            u.uOpacity.value += (targetOpacity - u.uOpacity.value) * 0.05;
            u.uTime.value     = elapsed;
            u.uSpeed.value    = Math.min(1, speedKts / 20);
        });
    }

    dispose() {
        this._wakes.forEach((w) => {
            this._scene.remove(w.pivot);
            w.mat.dispose();
        });
        this._wakes.clear();
        this._geo.dispose();
    }
}
