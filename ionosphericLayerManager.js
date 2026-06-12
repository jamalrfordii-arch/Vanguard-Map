// ionosphericLayerManager.js — Ionospheric + Radiation Belt System
//
// GEOMETRY (two pipelines)
//   Ring  pipeline  → D and E layers: precision auroral oval rings at each pole
//   Slab  pipeline  → F1, F2: ghosted global slabs (side-view only)
//                  → Van Allen: equatorial-dominant slabs (torus read)
//
// PHYSICS
//   D  layer   ~75 km    Auroral oval ring — AE-driven, night-fading absorber
//   E  layer   ~120 km   Auroral oval ring — primary visible aurora source
//   F1 layer   ~200 km   Subtle global slab — daytime HF reflector
//   F2 layer   ~375 km   Subtle global slab — primary long-range HF reflector
//   Inner Van Allen ~3,000 km   Stable proton belt — equatorial only
//   Outer Van Allen ~17,500 km  Storm-sensitive electron belt — equatorial only
//
// AURORAL OVAL GEOMETRY
//   Real aurora is a ring at ~65–75° magnetic latitude, NOT a filled disc.
//   Each ring layer = two annular discs (N + S pole), band width ≈ 8° lat.
//   IGRF pole positions: North 80.7°N 72.7°W · South 64.3°S 137.9°E.
//   Ring UV:  x = 0 (inner edge) → 1 (outer edge)  |  y = 0→1 angular
//
// COUPLING (SpaceWeatherManager shared uniforms)
//   Kp          → ring deformation + slab storm warp + Chapman integrator
//   AE          → ring pulse synced to Birkeland flow (1.80 Hz base)
//   IMF Bz      → outer Van Allen brightening (southward = storm driver)
//   SW Pressure → outer Van Allen source injection

import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT } from './config.js';
import { sampleStrengthNormalized, sampleMagneticLatitude } from './igrf.js';

// ── Magnetic pole positions (IGRF-13 epoch 2020) ──────────────────────────────
// Scene mapping: x = lon / 180 × 150 · z = lat / 90 × 150
const POLE_NORTH_X = -72.7 / 180 * 150;   // ≈ −60.6
const POLE_NORTH_Z =  80.7 /  90 * 150;   // ≈  134.5
const POLE_SOUTH_X =  137.9 / 180 * 150;  // ≈  114.9
const POLE_SOUTH_Z = -64.3 /  90 * 150;   // ≈ −107.2

const DEG_TO_SCENE = 150.0 / 90.0;   // 1 geographic degree ≈ 1.667 scene units

// ── Layer configuration ───────────────────────────────────────────────────────
const LAYER_CONFIG = [
    {
        id:                'iono-d',
        label:             'D Layer',
        realAltKm:         75,
        schematicY:        14,
        physicalThickness: 1.5,
        glowColor:         [0.65, 0.90, 1.00],   // pale ice blue — absorber, not emitter
        geometry:          'ring',
        ringInnerDeg:      12,                    // 12° from pole ≈ 20.0 scene units
        ringOuterDeg:      20,                    // 20° from pole ≈ 33.3 scene units
        glowIntensity:     0.65,                  // D absorbs — dimmer than E
        baseThickness:     0.0,
        polarGlowScale:    1.0,
        beltBoostScale:    0.0,
        subtleFactor:      1.0,
        equatorialMaskZ:   0.0,
        lossLambda:        1 / 1800,
        chapmanAlpha:      0.1,
        freqLabel:         'HF 3–10 MHz (absorbed)',
        rippleSpeed:       4.5,
        rippleAmp:         0.35,
        deformScale:       0.12,
        isNightLayer:      1.0,
        operationalNote:   'Absorbs HF signals daytime. Disappears at night — enables over-horizon HF comms after dark.',
    },
    {
        id:                'iono-e',
        label:             'E Layer',
        realAltKm:         120,
        schematicY:        22,
        physicalThickness: 3.0,
        glowColor:         [0.25, 0.82, 1.00],   // bright aurora cyan — primary visible source
        geometry:          'ring',
        ringInnerDeg:      14,                    // 14° from pole ≈ 23.3 scene units
        ringOuterDeg:      22,                    // 22° from pole ≈ 36.7 scene units
        glowIntensity:     1.0,                   // most dramatic — real visible aurora lives here
        baseThickness:     0.0,
        polarGlowScale:    0.85,
        beltBoostScale:    0.0,
        subtleFactor:      1.0,
        equatorialMaskZ:   0.0,
        lossLambda:        1 / 10800,
        chapmanAlpha:      0.3,
        freqLabel:         'MF/HF 0.3–3 MHz (reflected)',
        rippleSpeed:       3.0,
        rippleAmp:         0.50,
        deformScale:       0.18,
        isNightLayer:      0.6,
        operationalNote:   'Reflects medium frequencies. E-skip enables unexpected long-range interference.',
    },
    {
        id:                'iono-f1',
        label:             'F1 Layer',
        realAltKm:         200,
        schematicY:        31,
        physicalThickness: 5.0,
        glowColor:         [0.12, 0.72, 1.00],   // medium cyan-blue
        geometry:          'slab',
        ringInnerDeg:      0,
        ringOuterDeg:      0,
        glowIntensity:     1.0,
        baseThickness:     0.0,
        polarGlowScale:    0.0,
        beltBoostScale:    0.0,
        subtleFactor:      0.10,                  // ghosted — face near-invisible from above
        equatorialMaskZ:   0.0,
        lossLambda:        1 / 21600,
        chapmanAlpha:      0.8,
        freqLabel:         'HF 3–30 MHz (reflected, daytime)',
        rippleSpeed:       2.0,
        rippleAmp:         0.55,
        deformScale:       0.22,
        isNightLayer:      0.4,
        operationalNote:   'Daytime HF reflector. Merges into F2 at night. Key for tactical HF frequency planning.',
    },
    {
        id:                'iono-f2',
        label:             'F2 Layer',
        realAltKm:         375,
        schematicY:        42,
        physicalThickness: 7.0,
        glowColor:         [0.05, 0.65, 1.00],   // deep cyan-blue
        geometry:          'slab',
        ringInnerDeg:      0,
        ringOuterDeg:      0,
        glowIntensity:     1.0,
        baseThickness:     0.0,
        polarGlowScale:    0.0,
        beltBoostScale:    0.0,
        subtleFactor:      0.08,                  // deepest ghost — thickest but most subtle
        equatorialMaskZ:   0.0,
        lossLambda:        1 / 43200,
        chapmanAlpha:      1.8,
        freqLabel:         'HF 3–30 MHz (primary reflector)',
        rippleSpeed:       1.2,
        rippleAmp:         0.75,
        deformScale:       0.38,
        isNightLayer:      0.0,
        operationalNote:   'Primary global HF reflector. Most reactive ionospheric layer to geomagnetic storms.',
    },
    {
        id:                'van-allen-inner',
        label:             'Inner Van Allen Belt',
        realAltKm:         3000,
        schematicY:        58,
        physicalThickness: 12.0,
        glowColor:         [0.00, 0.88, 0.92],   // teal-cyan
        geometry:          'slab',
        ringInnerDeg:      0,
        ringOuterDeg:      0,
        glowIntensity:     1.0,
        baseThickness:     0.65,   // IGRF → 0 at 3000 km — floor prevents invisibility
        polarGlowScale:    0.0,
        beltBoostScale:    0.0,
        subtleFactor:      1.0,
        equatorialMaskZ:   35.0,   // ±35 scene units ≈ ±21° lat — equatorial torus
        lossLambda:        1 / 31536000,
        chapmanAlpha:      0.0,
        freqLabel:         'High-energy protons (MeV range)',
        rippleSpeed:       0.15,
        rippleAmp:         0.25,
        deformScale:       0.08,
        isNightLayer:      0.0,
        operationalNote:   'Stable proton radiation belt. Satellite-lethal zone. SAA brings it closest to surface.',
    },
    {
        id:                'van-allen-outer',
        label:             'Outer Van Allen Belt',
        realAltKm:         17500,
        schematicY:        78,
        physicalThickness: 22.0,
        glowColor:         [0.00, 1.00, 0.80],   // aurora cyan-green
        geometry:          'slab',
        ringInnerDeg:      0,
        ringOuterDeg:      0,
        glowIntensity:     1.0,
        baseThickness:     0.55,   // IGRF → 0 at 17500 km — floor prevents invisibility
        polarGlowScale:    0.0,
        beltBoostScale:    1.0,    // responds to IMF Bz + solar wind pressure
        subtleFactor:      1.0,
        equatorialMaskZ:   50.0,   // ±50 scene units ≈ ±30° lat — wider equatorial torus
        lossLambda:        1 / 864000,
        chapmanAlpha:      2.5,
        freqLabel:         'Electrons keV–MeV (ULF-driven)',
        rippleSpeed:       0.40,
        rippleAmp:         1.10,
        deformScale:       0.75,
        isNightLayer:      0.0,
        operationalNote:   'Most storm-sensitive belt. Primary threat to GPS and comms satellites.',
    },
];

// ── Geometry resolution ───────────────────────────────────────────────────────
const SEG_X       = 120;   // slab horizontal subdivisions
const SEG_Z       = 80;    // slab depth subdivisions
const RING_SEGS   = 128;   // ring: angular segments (smooth oval)
const RING_R_SEGS = 14;    // ring: radial segments across band width

// ═══════════════════════════════════════════════════════════════════════════════
// SLAB SHADERS  —  F1, F2, Van Allen inner/outer
// ═══════════════════════════════════════════════════════════════════════════════

const VERT_PANE = /* glsl */`
    attribute float aThickness;
    attribute float aCornerDist;
    attribute vec2  aUV;
    attribute float aMagLat;

    varying float vThickness;
    varying float vCornerDist;
    varying vec2  vUV;
    varying float vMagLat;

    uniform float uTime;
    uniform float uKp;
    uniform float uRippleSpeed;
    uniform float uRippleAmp;
    uniform float uDeformScale;

    void main() {
        vThickness  = aThickness;
        vCornerDist = aCornerDist;
        vUV         = aUV;
        vMagLat     = aMagLat;

        vec3 pos = position;

        // ── Traveling wave ripple ─────────────────────────────────────────────
        float wA = sin(aUV.x * 9.0  + aUV.y * 3.0  - uTime * uRippleSpeed        ) * uRippleAmp;
        float wB = sin(aUV.x * 4.0  - aUV.y * 7.0  + uTime * uRippleSpeed * 0.55 ) * uRippleAmp * 0.38;
        pos.y += (wA + wB);

        // ── Kp-driven storm deformation ───────────────────────────────────────
        float kpNorm     = clamp(uKp / 9.0, 0.0, 1.0);
        float poleWt     = clamp((abs(aMagLat) - 45.0) / 30.0, 0.0, 1.0);
        float cornerMask = smoothstep(0.0, 0.35, aCornerDist);
        float deform     = sin(aUV.x * 6.28318 + uTime * 0.25)
                           * kpNorm * uDeformScale * (1.0 + poleWt * 1.8)
                           * cornerMask;
        pos.y += deform;

        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    }
`;

const FRAG_PANE = /* glsl */`
    varying float vThickness;
    varying float vCornerDist;
    varying vec2  vUV;
    varying float vMagLat;

    uniform float uTime;
    uniform float uOpacity;
    uniform float uKp;
    uniform float uAE;
    uniform float uSunLon;
    uniform float uIsNightLayer;
    uniform float uRippleSpeed;
    uniform float uDecayN;

    // Layer-specific controls
    uniform vec3  uGlowColor;
    uniform float uBaseThickness;     // Van Allen IGRF floor
    uniform float uBeltBoostScale;    // outer Van Allen IMF/pressure response
    uniform float uSubtleFactor;      // 1.0 = normal  ·  0.08–0.10 = F1/F2 ghost
    uniform float uEquatorialMaskZ;   // scene-unit half-width for equatorial belt mask

    // Solar wind coupling (outer Van Allen)
    uniform float uIMFBz;
    uniform float uSolarWindPressure;

    void main() {
        // ── Edge + corner fade ────────────────────────────────────────────────
        float cornerAlpha = smoothstep(0.0, 0.16, vCornerDist);
        float ex = smoothstep(0.0, 0.10, vUV.x) * smoothstep(1.0, 0.90, vUV.x);
        float ez = smoothstep(0.0, 0.10, vUV.y) * smoothstep(1.0, 0.90, vUV.y);
        float edgeAlpha   = ex * ez * cornerAlpha;

        // ── Day / night terminator ────────────────────────────────────────────
        float fragLon   = (vUV.x - 0.5) * 360.0;
        float lonDiff   = mod((fragLon - uSunLon) + 540.0, 360.0) - 180.0;
        float dayFrac   = clamp(cos(lonDiff * 0.01745329) * 0.5 + 0.5, 0.0, 1.0);
        float nightFade = mix(1.0, dayFrac, uIsNightLayer);

        // ── Equatorial mask — Van Allen torus shape ───────────────────────────
        // Fades glow at high latitudes so belts read as equatorial bands.
        float fragZ  = (vUV.y - 0.5) * 300.0;
        float eqFade = (uEquatorialMaskZ > 0.5)
            ? smoothstep(uEquatorialMaskZ * 1.4, uEquatorialMaskZ * 0.3, abs(fragZ))
            : 1.0;

        // ── Thickness with Van Allen base floor ───────────────────────────────
        float t = pow(max(uBaseThickness, vThickness), 1.8);

        // ── Base fill ─────────────────────────────────────────────────────────
        vec3  paneColor = uGlowColor * 0.06 + vec3(0.01, 0.02, 0.04);
        float paneAlpha = 0.08 * t * nightFade;

        // ── Shimmer ───────────────────────────────────────────────────────────
        float shimmer = 0.5 + 0.5 * sin(vUV.x * 11.0 + vUV.y * 6.5 - uTime * uRippleSpeed);

        // ── Core glow ─────────────────────────────────────────────────────────
        float glow = clamp(t * 0.55 * (0.80 + 0.20 * shimmer) * uDecayN, 0.0, 0.55);

        // ── Outer Van Allen: IMF Bz + solar wind pressure coupling ────────────
        // Southward Bz opens the magnetosphere → belt energizes
        // AE depletion then dims it as particles drain via Birkeland currents
        float bzStorm    = clamp(-uIMFBz / 20.0, 0.0, 1.0);
        float swPressNorm = clamp(uSolarWindPressure / 10.0, 0.0, 1.0);
        float aeIntensity = smoothstep(200.0, 800.0, uAE);
        float beltBoost  = (bzStorm * 0.45 + swPressNorm * 0.25) * (1.0 - aeIntensity * 0.65);
        glow = clamp(glow + beltBoost * uBeltBoostScale, 0.0, 0.90);

        // ── Kp global brightening ─────────────────────────────────────────────
        glow = clamp(glow + clamp(uKp / 9.0, 0.0, 1.0) * 0.12, 0.0, 0.82);

        // ── Apply equatorial mask and night fade ──────────────────────────────
        glow *= eqFade * nightFade;

        // ── Thin-region shimmer (SAA, equatorial gap) ─────────────────────────
        float thinFactor       = clamp(1.0 - vThickness * 3.0, 0.0, 1.0);
        float passThroughAlpha = thinFactor * 0.05
                                 * (0.5 + 0.5 * sin(vUV.y * 20.0 - uTime * 2.2));

        // ── Combine — subtleFactor scales the whole result ────────────────────
        float totalAlpha = clamp(
            (paneAlpha + glow * 1.25 + passThroughAlpha) * edgeAlpha * uOpacity * uSubtleFactor,
            0.0, 0.68
        );
        vec3 finalColor = mix(paneColor, uGlowColor, clamp(glow * 1.4, 0.0, 1.0));

        gl_FragColor = vec4(finalColor, totalAlpha);
    }
`;

// Dark perimeter outline — NormalBlending so it actually darkens the scene edge
const FRAG_OUTLINE = /* glsl */`
    varying float vCornerDist;
    varying vec2  vUV;

    uniform float uOpacity;
    uniform vec3  uGlowColor;
    uniform float uSubtleFactor;

    void main() {
        float edgeX    = min(vUV.x, 1.0 - vUV.x);
        float edgeZ    = min(vUV.y, 1.0 - vUV.y);
        float edgeDist = min(edgeX, edgeZ);
        float outline  = 1.0 - smoothstep(0.0, 0.032, edgeDist);
        float cornerA  = smoothstep(0.0, 0.12, vCornerDist);
        float alpha    = outline * cornerA * uOpacity * 0.50 * uSubtleFactor;
        if (alpha < 0.01) discard;
        vec3 darkColor = uGlowColor * 0.07 + vec3(0.005, 0.008, 0.012);
        gl_FragColor   = vec4(darkColor, alpha);
    }
`;

// ═══════════════════════════════════════════════════════════════════════════════
// RING SHADERS  —  D and E auroral oval layers
// ═══════════════════════════════════════════════════════════════════════════════

const VERT_RING = /* glsl */`
    // aUV.x = 0 (inner ring edge) → 1 (outer ring edge)
    // aUV.y = 0 → 1 angular position around the oval
    attribute vec2 aUV;

    varying vec2  vUV;
    varying float vBandCenter;   // sin curve: 1.0 at band midpoint, 0 at inner/outer edges

    uniform float uTime;
    uniform float uAE;
    uniform float uKp;
    uniform float uRippleSpeed;
    uniform float uRippleAmp;

    void main() {
        vUV        = aUV;
        // Peaks at 0.5 (band centre), zeros at 0 and 1 (inner/outer edges)
        vBandCenter = sin(aUV.x * 3.14159265);

        vec3 pos = position;

        // ── Aurora shimmer — vertical undulation along the oval ───────────────
        float shimA = sin(aUV.y * 13.0 - uTime * uRippleSpeed       ) * uRippleAmp;
        float shimB = sin(aUV.y *  7.0 + uTime * uRippleSpeed * 0.55) * uRippleAmp * 0.42;
        pos.y += (shimA + shimB) * vBandCenter;

        // ── AE-driven lift — active aurora ring rises slightly ────────────────
        float aeGate = smoothstep(200.0, 800.0, uAE);
        pos.y += aeGate * 1.2 * vBandCenter;

        // ── Kp storm deformation — warps the oval under geomagnetic stress ────
        float kpNorm = clamp(uKp / 9.0, 0.0, 1.0);
        pos.y += sin(aUV.y * 5.0 + uTime * 0.22) * kpNorm * 0.9 * vBandCenter;

        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    }
`;

const FRAG_RING = /* glsl */`
    varying vec2  vUV;
    varying float vBandCenter;

    uniform float uTime;
    uniform float uOpacity;
    uniform float uAE;
    uniform float uKp;
    uniform float uDecayN;
    uniform float uGlowIntensity;   // D = 0.65 (absorber)  ·  E = 1.0 (emitter)
    uniform vec3  uGlowColor;
    uniform float uRippleSpeed;

    void main() {
        // ── Radial band fade — smooth falloff at inner and outer ring edges ────
        float radFade = smoothstep(0.0, 0.22, vUV.x) * smoothstep(1.0, 0.78, vUV.x);

        // ── Aurora pulse — synced to Birkeland base flow speed (1.80 Hz) ──────
        float wave   = fract(uTime * 1.80);
        float pulse  = sin(wave * 3.14159265);
        float aeGate = smoothstep(200.0, 800.0, uAE);

        // ── Angular brightness variation — aurora is brighter in certain sectors
        float angVar = 0.62 + 0.38 * sin(vUV.y * 8.0 - uTime * uRippleSpeed * 0.55);

        // ── Fine-structure shimmer — fast local curtain flicker ───────────────
        float shimmer = 0.72 + 0.28 * sin(vUV.y * 26.0 + uTime * uRippleSpeed * 1.9)
                                    * sin(vUV.x * 10.0  - uTime * 1.5);

        // ── Core glow ─────────────────────────────────────────────────────────
        float glow = vBandCenter * radFade * angVar * shimmer;

        // Quiet baseline (always faintly visible) + strong AE-driven pulse
        float baseLevel  = 0.25 * uDecayN * uGlowIntensity;
        float stormLevel = aeGate * pulse * 1.75 * uDecayN * uGlowIntensity;
        glow *= (baseLevel + stormLevel);

        // ── Kp brightening ────────────────────────────────────────────────────
        float kpBoost = clamp(uKp / 9.0, 0.0, 1.0) * 0.35 * vBandCenter * radFade;
        glow = clamp(glow + kpBoost, 0.0, 1.0);

        float alpha = clamp(glow * uOpacity, 0.0, 0.82);
        if (alpha < 0.004) discard;

        // ── Color — warm white at peak brightness mimics real aurora intensification
        vec3 color = mix(uGlowColor,
                         uGlowColor + vec3(0.10, 0.08, 0.04),
                         clamp(glow * 2.2, 0.0, 1.0));
        gl_FragColor = vec4(color, alpha);
    }
`;

// Dark ring borders at inner + outer edges — gives each oval crisp definition
const FRAG_RING_OUTLINE = /* glsl */`
    varying vec2  vUV;
    varying float vBandCenter;

    uniform float uOpacity;
    uniform vec3  uGlowColor;

    void main() {
        float innerEdge = 1.0 - smoothstep(0.0, 0.10, vUV.x);
        float outerEdge = 1.0 - smoothstep(0.90, 1.0, vUV.x);
        float outline   = max(innerEdge, outerEdge);

        float alpha = outline * uOpacity * 0.50;
        if (alpha < 0.008) discard;

        vec3 darkColor = uGlowColor * 0.06 + vec3(0.004, 0.006, 0.010);
        gl_FragColor   = vec4(darkColor, alpha);
    }
`;

// ═══════════════════════════════════════════════════════════════════════════════
// GEOMETRY BUILDERS
// ═══════════════════════════════════════════════════════════════════════════════

// ── Ring geometry ─────────────────────────────────────────────────────────────
// Horizontal annular disc centred on `pole` in the XZ plane.
// aUV.x = 0 (inner) → 1 (outer)  |  aUV.y = 0–1 angular
function _buildRingGeometry(pole, innerRadius, outerRadius, yBase, yOffset) {
    const vCount    = (RING_SEGS + 1) * (RING_R_SEGS + 1);
    const positions = new Float32Array(vCount * 3);
    const uvArr     = new Float32Array(vCount * 2);

    let vi = 0;
    for (let si = 0; si <= RING_SEGS; si++) {
        const angle = (si / RING_SEGS) * Math.PI * 2.0;
        const cosA  = Math.cos(angle);
        const sinA  = Math.sin(angle);

        for (let ri = 0; ri <= RING_R_SEGS; ri++) {
            const t = ri / RING_R_SEGS;
            const r = innerRadius + (outerRadius - innerRadius) * t;

            positions[vi * 3    ] = pole.x + cosA * r;
            positions[vi * 3 + 1] = yBase + yOffset;
            positions[vi * 3 + 2] = pole.z + sinA * r;

            uvArr[vi * 2    ] = t;               // radial: 0 = inner, 1 = outer
            uvArr[vi * 2 + 1] = si / RING_SEGS;  // angular: 0 → 1 around oval

            vi++;
        }
    }

    const indexCount = RING_SEGS * RING_R_SEGS * 6;
    const indices    = new Uint32Array(indexCount);
    let   ii         = 0;
    for (let si = 0; si < RING_SEGS; si++) {
        for (let ri = 0; ri < RING_R_SEGS; ri++) {
            const a = si * (RING_R_SEGS + 1) + ri;
            const b = a + 1;
            const c = (si + 1) * (RING_R_SEGS + 1) + ri;
            const d = c + 1;
            indices[ii++] = a;  indices[ii++] = c;  indices[ii++] = b;
            indices[ii++] = b;  indices[ii++] = c;  indices[ii++] = d;
        }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aUV',      new THREE.BufferAttribute(uvArr,     2));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    return geo;
}

// ── Slab geometry ─────────────────────────────────────────────────────────────
// Full-map rectangular face with IGRF thickness, magnetic-lat, and corner data.
// yOffset = ±physicalThickness/2 → top or bottom face.
function _buildPaneMesh(cfg, yOffset = 0) {
    const vCount     = (SEG_X + 1) * (SEG_Z + 1);
    const positions  = new Float32Array(vCount * 3);
    const thickness  = new Float32Array(vCount);
    const cornerDist = new Float32Array(vCount);
    const uvArr      = new Float32Array(vCount * 2);
    const magLatArr  = new Float32Array(vCount);

    const halfW = MAP_WIDTH  / 2;
    const halfH = MAP_HEIGHT / 2;

    let vi = 0;
    for (let iz = 0; iz <= SEG_Z; iz++) {
        for (let ix = 0; ix <= SEG_X; ix++) {
            const u   = ix / SEG_X;
            const v   = iz / SEG_Z;
            const x   = -halfW + u * MAP_WIDTH;
            const z   = -halfH + v * MAP_HEIGHT;
            const lat  = (z / halfH) * 90.0;
            const lon  = (x / halfW) * 180.0;
            const mLat = sampleMagneticLatitude(lat, lon);

            const eqProx  = 1.0 - Math.abs(mLat) / 90.0;
            const eqBulge = eqProx * 2.2;

            const dC = Math.min(
                Math.hypot(u,     v    ),
                Math.hypot(1 - u, v    ),
                Math.hypot(u,     1 - v),
                Math.hypot(1 - u, 1 - v)
            );
            const cNorm    = Math.min(1.0, dC / 0.25);
            const cDepress = (1.0 - cNorm) * (1.0 - cNorm) * -3.2;

            const y = cfg.schematicY + yOffset + eqBulge + cDepress;

            positions[vi * 3    ] = x;
            positions[vi * 3 + 1] = y;
            positions[vi * 3 + 2] = z;

            thickness[vi]        = sampleStrengthNormalized(lat, lon, cfg.realAltKm);
            cornerDist[vi]       = cNorm;
            uvArr[vi * 2    ]    = u;
            uvArr[vi * 2 + 1]    = v;
            magLatArr[vi]        = mLat;
            vi++;
        }
    }

    const indexCount = SEG_X * SEG_Z * 6;
    const indices    = new Uint32Array(indexCount);
    let   ii         = 0;
    for (let iz = 0; iz < SEG_Z; iz++) {
        for (let ix = 0; ix < SEG_X; ix++) {
            const a = iz * (SEG_X + 1) + ix;
            const b = a + 1;
            const c = a + (SEG_X + 1);
            const d = c + 1;
            indices[ii++] = a;  indices[ii++] = c;  indices[ii++] = b;
            indices[ii++] = b;  indices[ii++] = c;  indices[ii++] = d;
        }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position',    new THREE.BufferAttribute(positions,  3));
    geo.setAttribute('aThickness',  new THREE.BufferAttribute(thickness,  1));
    geo.setAttribute('aCornerDist', new THREE.BufferAttribute(cornerDist, 1));
    geo.setAttribute('aUV',         new THREE.BufferAttribute(uvArr,      2));
    geo.setAttribute('aMagLat',     new THREE.BufferAttribute(magLatArr,  1));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    return geo;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function _sunLongitude() {
    const now  = new Date();
    const utcH = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
    return (utcH - 12.0) * 15.0;
}

function clamp01(v) { return Math.max(0.0, Math.min(1.0, v)); }

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class IonosphericLayerManager {

    constructor(scene, swm = null) {
        this._scene = scene;
        this._swm   = swm;

        this._group         = new THREE.Group();
        this._group.visible = false;
        scene.add(this._group);

        // ── Owned uniforms ────────────────────────────────────────────────────
        this._uTime    = { value: 0 };
        this._uOpacity = { value: 1.0 };
        this._uSunLon  = { value: _sunLongitude() };

        // ── Space weather uniforms — bind to SWM or own fallback ──────────────
        if (swm) {
            this._uKp                = swm.uKp;
            this._uAE                = swm.uAE;
            this._uIMFBz             = swm.uIMFBz;
            this._uSolarWindPressure = swm.uSolarWindPressure;
        } else {
            this._uKp                = { value: 1.0  };
            this._uAE                = { value: 50.0 };
            this._uIMFBz             = { value: 0.0  };
            this._uSolarWindPressure = { value: 2.0  };
            this._fetchNOAA();   // fallback: own fetch cycle
        }

        // ── Pole position uniforms (slab shaders only) ────────────────────────
        this._uPoleNX = { value: POLE_NORTH_X };
        this._uPoleNZ = { value: POLE_NORTH_Z };
        this._uPoleSX = { value: POLE_SOUTH_X };
        this._uPoleSZ = { value: POLE_SOUTH_Z };

        this._panes = [];
        this._buildPanes();

        // ── Layer toggle ──────────────────────────────────────────────────────
        window.addEventListener('vg1:layerChanged', (e) => {
            const { id, on, opacity } = e.detail;
            if (id === 'magnetic-field') {
                this._group.visible  = on;
                this._uOpacity.value = opacity;
            }
        });
    }

    // ── Route each layer to its geometry pipeline ─────────────────────────────
    _buildPanes() {
        for (const cfg of LAYER_CONFIG) {
            cfg.geometry === 'ring'
                ? this._buildRingLayer(cfg)
                : this._buildSlabLayer(cfg);
        }
    }

    // ── Ring layer — D and E auroral ovals ────────────────────────────────────
    // Two annular ring pairs (N + S pole), 8 meshes total per layer.
    // All meshes in a layer share one glow material and one outline material —
    // updating uDecayN.value on the shared uniforms updates all 8 simultaneously.
    _buildRingLayer(cfg) {
        const half   = cfg.physicalThickness / 2;
        const innerR = cfg.ringInnerDeg * DEG_TO_SCENE;
        const outerR = cfg.ringOuterDeg * DEG_TO_SCENE;
        const [gr, gg, gb] = cfg.glowColor;

        // Single uDecayN — shared by reference across all meshes in this layer
        const uDecayN = { value: 1.0 };

        const glowUniforms = {
            uTime:          this._uTime,
            uOpacity:       this._uOpacity,
            uAE:            this._uAE,
            uKp:            this._uKp,
            uDecayN,
            uGlowIntensity: { value: cfg.glowIntensity },
            uGlowColor:     { value: new THREE.Color(gr, gg, gb) },
            uRippleSpeed:   { value: cfg.rippleSpeed },
            uRippleAmp:     { value: cfg.rippleAmp   },
        };

        // Outline vertex shader (VERT_RING) uses uRippleAmp — zero it for static frame
        const outlineUniforms = {
            uTime:        this._uTime,
            uAE:          this._uAE,
            uKp:          this._uKp,
            uRippleSpeed: { value: cfg.rippleSpeed },
            uRippleAmp:   { value: 0.0 },   // no warp on outline
            uOpacity:     this._uOpacity,
            uGlowColor:   { value: new THREE.Color(gr, gg, gb) },
        };

        const glowMat = new THREE.ShaderMaterial({
            vertexShader:   VERT_RING,
            fragmentShader: FRAG_RING,
            uniforms:       glowUniforms,
            transparent:    true,
            depthWrite:     false,
            side:           THREE.DoubleSide,
            blending:       THREE.AdditiveBlending,
        });

        const outlineMat = new THREE.ShaderMaterial({
            vertexShader:   VERT_RING,
            fragmentShader: FRAG_RING_OUTLINE,
            uniforms:       outlineUniforms,
            transparent:    true,
            depthWrite:     false,
            side:           THREE.DoubleSide,
            blending:       THREE.NormalBlending,
        });

        const poles = [
            { x: POLE_NORTH_X, z: POLE_NORTH_Z },
            { x: POLE_SOUTH_X, z: POLE_SOUTH_Z },
        ];

        const meshes = [];
        for (const pole of poles) {
            const topGeo = _buildRingGeometry(pole, innerR, outerR, cfg.schematicY, +half);
            const botGeo = _buildRingGeometry(pole, innerR, outerR, cfg.schematicY, -half);

            // Glow + outline share the same geometry per face (geometry is read-only)
            const topGlow    = new THREE.Mesh(topGeo, glowMat);
            const botGlow    = new THREE.Mesh(botGeo, glowMat);
            const topOutline = new THREE.Mesh(topGeo, outlineMat);
            const botOutline = new THREE.Mesh(botGeo, outlineMat);

            topOutline.renderOrder = 1;
            botOutline.renderOrder = 1;

            this._group.add(topGlow, botGlow, topOutline, botOutline);
            meshes.push(topGlow, botGlow, topOutline, botOutline);
        }

        this._panes.push({
            config:   cfg,
            meshes,
            uniforms: glowUniforms,   // _updateParticleDecay targets uDecayN here
            N:        1.0,
        });
    }

    // ── Slab layer — F1, F2, Van Allen ────────────────────────────────────────
    _buildSlabLayer(cfg) {
        const half = cfg.physicalThickness / 2;
        const topGeo = _buildPaneMesh(cfg, +half);
        const botGeo = _buildPaneMesh(cfg, -half);
        const [gr, gg, gb] = cfg.glowColor;

        const sharedUniforms = {
            uTime:              this._uTime,
            uOpacity:           this._uOpacity,
            uSunLon:            this._uSunLon,
            uKp:                this._uKp,
            uAE:                this._uAE,
            uIMFBz:             this._uIMFBz,
            uSolarWindPressure: this._uSolarWindPressure,
            uPoleNX:            this._uPoleNX,
            uPoleNZ:            this._uPoleNZ,
            uPoleSX:            this._uPoleSX,
            uPoleSZ:            this._uPoleSZ,
            uRippleSpeed:       { value: cfg.rippleSpeed    },
            uRippleAmp:         { value: cfg.rippleAmp      },
            uDeformScale:       { value: cfg.deformScale    },
            uIsNightLayer:      { value: cfg.isNightLayer   },
            uDecayN:            { value: 1.0                },
            uGlowColor:         { value: new THREE.Color(gr, gg, gb) },
            uBaseThickness:     { value: cfg.baseThickness  },
            uBeltBoostScale:    { value: cfg.beltBoostScale },
            uSubtleFactor:      { value: cfg.subtleFactor   },
            uEquatorialMaskZ:   { value: cfg.equatorialMaskZ },
        };

        // Outline: no ripple warp, outline slightly more visible than face on F1/F2
        const outlineUniforms = {
            ...sharedUniforms,
            uRippleAmp:    { value: 0.0 },
            uDeformScale:  { value: 0.0 },
            uGlowColor:    { value: new THREE.Color(gr, gg, gb) },
            uSubtleFactor: { value: Math.max(0.35, cfg.subtleFactor) },
        };

        const glowMat = new THREE.ShaderMaterial({
            vertexShader:   VERT_PANE,
            fragmentShader: FRAG_PANE,
            uniforms:       sharedUniforms,
            transparent:    true,
            depthWrite:     false,
            side:           THREE.DoubleSide,
            blending:       THREE.AdditiveBlending,
        });

        const outlineMat = new THREE.ShaderMaterial({
            vertexShader:   VERT_PANE,
            fragmentShader: FRAG_OUTLINE,
            uniforms:       outlineUniforms,
            transparent:    true,
            depthWrite:     false,
            side:           THREE.DoubleSide,
            blending:       THREE.NormalBlending,
        });

        const topGlow    = new THREE.Mesh(topGeo, glowMat);
        const botGlow    = new THREE.Mesh(botGeo, glowMat);
        const topOutline = new THREE.Mesh(topGeo, outlineMat);
        const botOutline = new THREE.Mesh(botGeo, outlineMat);

        topOutline.renderOrder = 1;
        botOutline.renderOrder = 1;

        this._group.add(topGlow, botGlow, topOutline, botOutline);

        this._panes.push({
            config:   cfg,
            meshes:   [topGlow, botGlow, topOutline, botOutline],
            uniforms: sharedUniforms,
            N:        1.0,
        });
    }

    // ── Fallback NOAA fetching (used only when no SpaceWeatherManager provided)
    async _fetchNOAA() {
        await Promise.allSettled([this._fetchKp(), this._fetchAE()]);
        setTimeout(() => this._fetchNOAA(), 15 * 60 * 1000);
    }
    async _fetchKp() {
        try {
            const r = await fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json');
            const d = await r.json();
            if (Array.isArray(d) && d.length > 1) {
                const kp = parseFloat(d[d.length - 1][1]);
                if (!isNaN(kp)) this._uKp.value = kp;
            }
        } catch (_) {}
    }
    async _fetchAE() {
        try {
            const r = await fetch('https://services.swpc.noaa.gov/products/kyoto-ae.json');
            const d = await r.json();
            if (Array.isArray(d) && d.length > 1) {
                const ae = parseFloat(d[d.length - 1][1]);
                if (!isNaN(ae)) this._uAE.value = Math.max(0, ae);
            }
        } catch (_) {}
    }

    // ── Per-frame update ──────────────────────────────────────────────────────
    update(elapsed, dt) {
        this._uTime.value   = elapsed;
        this._uSunLon.value = _sunLongitude();
        for (const pane of this._panes) {
            this._updateParticleDecay(pane, dt);
        }
    }

    // ── Analytical Chapman integrator ─────────────────────────────────────────
    // dN/dt = Q − λN  →  N(t) = N₀·e^(−λt) + (Q/λ)·(1 − e^(−λt))
    // Works for both ring and slab panes — just targets pane.uniforms.uDecayN.
    _updateParticleDecay(pane, dt) {
        const cfg    = pane.config;
        const safeDt = Math.min(dt, 3600.0);

        const swBoost = (cfg.id === 'van-allen-outer')
            ? clamp01(this._uSolarWindPressure.value / 10.0) * 0.000035 : 0.0;
        const Q = 0.00008 * (1.0 + this._uKp.value * 0.35) + swBoost;

        const kpNorm        = Math.min(this._uKp.value, 9.0) / 9.0;
        const lambdaDynamic = cfg.lossLambda * (1.0 + cfg.chapmanAlpha * kpNorm * kpNorm);
        const stormExtra    = (cfg.id === 'van-allen-outer') ? this._uKp.value * 0.000025 : 0.0;
        const aeExtra       = (cfg.id === 'van-allen-outer')
            ? clamp01(this._uAE.value / 800.0) * 0.000040 : 0.0;
        const lambda = lambdaDynamic + stormExtra + aeExtra;

        const expTerm = Math.exp(-lambda * safeDt);
        let   nextN   = pane.N * expTerm + (Q / lambda) * (1.0 - expTerm);
        if (!isFinite(nextN) || nextN < 0.0) nextN = 0.0;
        pane.N = Math.min(1.0, nextN);
        pane.uniforms.uDecayN.value = pane.N;
    }

    // ── Visibility ────────────────────────────────────────────────────────────
    setVisible(on)  { this._group.visible  = on; }
    setOpacity(v)   { this._uOpacity.value = Math.max(0, Math.min(1, v)); }

    setPaneVisible(id, on) {
        const pane = this._panes.find(p => p.config.id === id);
        if (!pane) return;
        pane.meshes.forEach(m => { m.visible = on; });
    }

    // ── Layer info for HUD / edge cards ──────────────────────────────────────
    getLayers() {
        return this._panes.map(p => ({
            id:              p.config.id,
            label:           p.config.label,
            realAltKm:       p.config.realAltKm,
            schematicY:      p.config.schematicY,
            freqLabel:       p.config.freqLabel,
            operationalNote: p.config.operationalNote,
            currentN:        p.N,
            currentKp:       this._uKp.value,
            currentAE:       this._uAE.value,
        }));
    }

    // ── Cleanup ───────────────────────────────────────────────────────────────
    // Ring layers share materials across poles — use Sets to avoid double-dispose.
    dispose() {
        const disposedGeos = new Set();
        const disposedMats = new Set();
        this._panes.forEach(p => {
            p.meshes.forEach(m => {
                if (!disposedGeos.has(m.geometry)) {
                    m.geometry.dispose();
                    disposedGeos.add(m.geometry);
                }
                if (!disposedMats.has(m.material)) {
                    m.material.dispose();
                    disposedMats.add(m.material);
                }
            });
        });
        this._scene.remove(this._group);
    }
}
