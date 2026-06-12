// birkelandManager.js — Birkeland Field-Aligned Current Streams
//
// Renders helical particle streams flowing from the outer Van Allen belt
// (schematicY = 78) down Earth's magnetic dipole field lines into the
// polar auroral zones (schematicY = 16, just above the D-layer).
//
// PHYSICS
//   Birkeland currents are field-aligned electric currents that connect the
//   magnetosphere to the ionosphere. They are the physical cause of auroras
//   and the quantity that the AE (Auroral Electrojet) index measures.
//   During Kp 5+ storms, vast currents pour down both magnetic poles and
//   energise the D and E layers — explaining the polar brightening visible
//   in the ionospheric pane system.
//
// ARCHITECTURE
//   4 strands per pole (8 total) — 2 pairs equally spaced in longitude,
//   mirroring the real Region-1 / Region-2 current sheet geometry.
//   Each strand is a THREE.Points cloud along a helical path that funnels
//   inward as it descends, matching dipole field-line convergence.
//
// ACTIVATION
//   Invisible below AE 200 nT. Smoothly ramps to full intensity at AE 800 nT.
//   Flow speed varies slightly per strand for natural visual variation.
//
// WIRING
//   - Instantiate: new BirkelandManager(scene, swm)
//     swm is a SpaceWeatherManager instance whose shared uniform objects
//     (swm.uKp, swm.uAE) are bound directly — zero duplicate fetching.
//   - Animation loop: birkelandManager.update(elapsed)
//   - Visibility: responds to vg1:layerChanged { id:'magnetic-field' }

import * as THREE from 'three';

// ── Magnetic pole positions in flat-map scene coordinates ────────────────────
// Geographic sources: IGRF-13 epoch 2020
//   North dip pole: 80.7°N, 72.7°W
//   South dip pole: 64.3°S, 137.9°E
// Scene mapping:  x = lon / 180 × 150   |   z = lat / 90 × 150
const POLES = [
    { x: -72.7 / 180 * 150,  z:  80.7 / 90 * 150,  label: 'north' },  // ≈ (−60.6, 134.5)
    { x:  137.9 / 180 * 150, z: -64.3 / 90 * 150,  label: 'south' },  // ≈ (114.9, −107.2)
];

// ── Geometry constants ────────────────────────────────────────────────────────
const STRANDS_PER_POLE   = 4;
const POINTS_PER_STRAND  = 280;
const Y_TOP              = 78;    // outer Van Allen belt schematicY
const Y_BOTTOM           = 16;    // just above D-layer (schematicY = 14)
const HELIX_TURNS        = 12;    // full revolutions from belt to pole
const HELIX_RADIUS_TOP   = 12.0;  // scene units — wide funnel at belt
const HELIX_RADIUS_BOTTOM =  3.0; // scene units — tight focus at footprint

// ── Vertex shader ─────────────────────────────────────────────────────────────
const VERT_BIRKELAND = /* glsl */`
    attribute float aProgress;   // 0 = outer belt top · 1 = D-layer footprint

    uniform float uTime;
    uniform float uAE;           // Auroral Electrojet index in nT
    uniform float uFlowSpeed;    // per-strand flow rate (slight variation)

    varying float vProgress;
    varying float vBrightness;

    void main() {
        vProgress = aProgress;

        // ── AE-driven activation ─────────────────────────────────────────────
        // Invisible below 200 nT, full at 800 nT
        float aeIntensity = smoothstep(200.0, 800.0, uAE);

        // ── Downward flowing energy bands ────────────────────────────────────
        // fract(aProgress * bands − time * speed) shifts bright bands toward
        // larger aProgress (downward) as time increases — energy flows to pole.
        float wave     = fract(aProgress * 7.0 - uTime * uFlowSpeed);
        float flowBand = sin(wave * 3.14159265);   // smooth [0, 1] band shape

        // ── Footprint discharge boost ────────────────────────────────────────
        // Where the current meets the D-layer, energy concentrates visibly.
        float discharge = smoothstep(0.72, 1.0, aProgress) * 1.5;

        vBrightness = (flowBand + discharge) * aeIntensity;

        // ── Point sizing ─────────────────────────────────────────────────────
        // Larger toward the footprint (current compresses into dense zone).
        // Perspective-scaled and clamped for WebGL max point size safety.
        float baseSize = mix(1.8, 5.5, aProgress) * max(aeIntensity, 0.05);
        vec4  mvPos    = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize   = clamp(baseSize * (280.0 / -mvPos.z), 0.5, 14.0);
        gl_Position    = projectionMatrix * mvPos;
    }
`;

// ── Fragment shader ───────────────────────────────────────────────────────────
const FRAG_BIRKELAND = /* glsl */`
    uniform float uOpacity;

    varying float vProgress;
    varying float vBrightness;

    void main() {
        // ── Disc shape ───────────────────────────────────────────────────────
        vec2  pc   = gl_PointCoord - 0.5;
        float dist = length(pc);
        if (dist > 0.5) discard;

        // ── Radial glow — soft, concentrated at centre ───────────────────────
        float glow = pow(1.0 - dist * 2.0, 2.2);

        // ── Color ramp: aurora cyan-green at belt → orange-red at footprint ──
        // The colour shift mirrors the real energy conversion: high-energy
        // electrons (blue-green) excite oxygen to emit red-orange at low alt.
        vec3 beltColor = vec3(0.00, 1.00, 0.55);    // aurora cyan-green
        vec3 footColor = vec3(1.00, 0.28, 0.08);    // discharge orange-red
        vec3 color     = mix(beltColor, footColor, smoothstep(0.60, 1.0, vProgress));

        gl_FragColor = vec4(color, glow * vBrightness * uOpacity);
    }
`;

// ── Geometry builder ──────────────────────────────────────────────────────────
// Generates a tapered helix descending from the outer belt to the polar
// footprint. Each strand starts at a different longitude offset so the
// four strands are equally spaced around the magnetic pole axis.
function _buildHelixGeometry(pole, strandIndex) {
    const positions = new Float32Array(POINTS_PER_STRAND * 3);
    const progress  = new Float32Array(POINTS_PER_STRAND);

    const lonOffset = (strandIndex / STRANDS_PER_POLE) * Math.PI * 2.0;

    for (let i = 0; i < POINTS_PER_STRAND; i++) {
        const t      = i / (POINTS_PER_STRAND - 1);   // 0 = top, 1 = bottom
        const y      = Y_TOP + (Y_BOTTOM - Y_TOP) * t;
        const radius = HELIX_RADIUS_TOP + (HELIX_RADIUS_BOTTOM - HELIX_RADIUS_TOP) * t;
        const angle  = lonOffset + t * Math.PI * 2.0 * HELIX_TURNS;

        positions[i * 3    ] = pole.x + Math.cos(angle) * radius;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = pole.z + Math.sin(angle) * radius;
        progress[i]          = t;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position',  new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aProgress', new THREE.BufferAttribute(progress,  1));
    return geo;
}

// ── Main class ────────────────────────────────────────────────────────────────
export class BirkelandManager {
    constructor(scene, swm = null) {
        this._scene   = scene;
        this._group   = new THREE.Group();
        this._group.visible = false;
        scene.add(this._group);

        // ── Time + opacity uniforms — owned by this manager ───────────────────
        this._uTime    = { value: 0   };
        this._uOpacity = { value: 1.0 };

        // ── Kp + AE uniforms — sourced from SpaceWeatherManager if provided ───
        // When swm is supplied the uniform objects are shared by reference:
        // SpaceWeatherManager mutates .value in-place each poll cycle, and
        // every strand's ShaderMaterial sees the update automatically.
        // Fallback own-objects are used only if no swm is available (e.g. tests).
        if (swm) {
            this._uKp = swm.uKp;
            this._uAE = swm.uAE;
        } else {
            this._uKp = { value: 1.0  };
            this._uAE = { value: 50.0 };
            console.warn('[BirkelandManager] No SpaceWeatherManager provided — running without live data.');
        }

        this._strands = [];

        this._buildStrands();

        // ── Central System layer toggle ───────────────────────────────────────
        // Birkeland currents share the magnetic-field master toggle with
        // the ionospheric pane system — they are part of the same phenomenon.
        window.addEventListener('vg1:layerChanged', (e) => {
            const { id, on, opacity } = e.detail;
            if (id === 'magnetic-field') {
                this._group.visible  = on;
                this._uOpacity.value = opacity;
            }
        });
    }

    // ── Build all 8 strands (4 per pole) ─────────────────────────────────────
    _buildStrands() {
        for (const pole of POLES) {
            for (let si = 0; si < STRANDS_PER_POLE; si++) {
                const geo = _buildHelixGeometry(pole, si);

                // Stagger flow speed per strand — subtle desynchronisation
                // prevents all strands pulsing in lockstep, which looks mechanical
                const flowSpeed = 1.8 + si * 0.18;

                const mat = new THREE.ShaderMaterial({
                    vertexShader:   VERT_BIRKELAND,
                    fragmentShader: FRAG_BIRKELAND,
                    uniforms: {
                        uTime:      this._uTime,
                        uAE:        this._uAE,
                        uKp:        this._uKp,
                        uOpacity:   this._uOpacity,
                        uFlowSpeed: { value: flowSpeed },
                    },
                    transparent: true,
                    depthWrite:  false,
                    blending:    THREE.AdditiveBlending,
                });

                const points = new THREE.Points(geo, mat);
                this._group.add(points);
                this._strands.push({ points, mat });
            }
        }
    }

    // ── Per-frame update ──────────────────────────────────────────────────────
    // Call from main.js animation loop: birkelandManager.update(elapsed)
    update(elapsed) {
        this._uTime.value = elapsed;
    }

    // ── External control ──────────────────────────────────────────────────────
    setVisible(on)  { this._group.visible  = on; }
    setOpacity(v)   { this._uOpacity.value = Math.max(0, Math.min(1, v)); }

    // ── Cleanup ───────────────────────────────────────────────────────────────
    dispose() {
        this._strands.forEach(s => {
            s.points.geometry.dispose();
            s.mat.dispose();
        });
        this._scene.remove(this._group);
    }
}
