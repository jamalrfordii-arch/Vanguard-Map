// entityBuilder.js — Ship/aircraft geometry, spline routes, AIS entity spawning
import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT, prng, AIRCRAFT_TIME_SCALE } from './config.js';
import { getTrueElevation } from './terrainBuilder.js';

// ── Shared ground-shadow sprite texture ───────────────────────────────────────
// Created once at module load; shared across every vessel shadow instance.
// A radial gradient dark blob gives the "pool of shadow" look at sea level
// without any costly per-frame rendering — it's just a single sprite lookup.
let _vesselShadowTex = null;
function _getVesselShadowTex() {
    if (_vesselShadowTex) return _vesselShadowTex;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx  = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
    grad.addColorStop(0.0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(0.5, 'rgba(0,0,0,0.20)');
    grad.addColorStop(1.0, 'rgba(0,0,0,0.00)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(32, 32, 30, 0, Math.PI * 2);
    ctx.fill();
    _vesselShadowTex = new THREE.CanvasTexture(canvas);
    return _vesselShadowTex;
}

// ── Shared altitude-glow sprite texture ───────────────────────────────────────
// Created once at module load; shared across every aircraft's altitude glow.
// Soft white radial falloff — tinted per-aircraft via SpriteMaterial.color,
// additive blended so it reads as a glow rather than a flat dot.
let _altGlowTex = null;
function _getAltitudeGlowTexture() {
    if (_altGlowTex) return _altGlowTex;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx  = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0.0, 'rgba(255,255,255,1.0)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1.0, 'rgba(255,255,255,0.0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(32, 32, 32, 0, Math.PI * 2);
    ctx.fill();
    _altGlowTex = new THREE.CanvasTexture(canvas);
    return _altGlowTex;
}

// --- SHARED MATERIALS ---
const M = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...opts });
const realMaterials = {
    white:    M(0xeeeeee, { roughness: 0.5 }),
    grey:     M(0x555555),
    darkGrey: M(0x37474f),
    glass:    M(0x99bbdd, { roughness: 0.1, metalness: 0.7, transparent: true, opacity: 0.7 }),
    // Per-class hull tints (muted — the bright marker/trail colors live in SHIP_CLASSES).
    // Bright per-class hull colours (match SHIP_CLASSES.hex + the design sheet) so
    // each vessel reads its type at a glance instead of a muted grey.
    hullCARGO:     M(0xff5252),
    hullTANKER:    M(0xffab40),
    hullPASSENGER: M(0x42a5f5, { roughness: 0.4 }),
    hullHSC:       M(0x26c6da, { metalness: 0.3 }),
    hullFISHING:   M(0x66bb6a),
    hullTUG:       M(0xab47bc),
    hullDREDGER:   M(0x8d6e63),
    hullPILOT:     M(0xffee58),
    hullSAILING:   M(0x26a69a),
    hullPLEASURE:  M(0xec407a, { roughness: 0.4 }),
    hullSERVICE:   M(0x78909c),
    hullOTHER:     M(0x90a4ae),
};

// --- GEOMETRY HELPERS (shared by the civilian shape builders) ---
const box = (w, h, l, mat, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), mat); m.position.set(x, y, z); return m;
};
const cyl = (rt, rb, h, mat, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, 12), mat); m.position.set(x, y, z); return m;
};
// A hull box with a tapered bow (4-sided cone) at +Z. Returns an array of meshes.
const hullWithBow = (w, h, l, mat) => {
    const bow = new THREE.Mesh(new THREE.CylinderGeometry(0, Math.SQRT1_2 * w, w, 4), mat);
    bow.rotation.x = -Math.PI / 2; bow.rotation.y = Math.PI / 4; bow.position.set(0, 0, l / 2 + w / 2);
    return [box(w, h, l, mat), bow];
};

// --- SHAPE BUILDERS ---
const shapeBuilders = {
    // Container ship — long hull, aft bridge, stacked container blocks.
    CARGO: () => {
        const g = new THREE.Group();
        g.add(...hullWithBow(1.2, 0.8, 3.4, realMaterials.hullCARGO));
        g.add(box(1.0, 0.9, 0.6, realMaterials.white, 0, 0.85, -1.3));
        for (let i = 0; i < 4; i++)
            g.add(box(1.05, 0.5, 0.6, i % 2 ? realMaterials.grey : realMaterials.darkGrey, 0, 0.55, 0.9 - i * 0.62));
        return g;
    },
    // Tanker — long low hull, deck pipeline + manifold, aft accommodation.
    TANKER: () => {
        const g = new THREE.Group();
        g.add(...hullWithBow(1.25, 0.65, 3.9, realMaterials.hullTANKER));
        g.add(box(0.95, 0.85, 0.7, realMaterials.white, 0, 0.7, -1.6));
        const pipe = cyl(0.06, 0.06, 2.6, realMaterials.grey, 0, 0.4, 0.3); pipe.rotation.x = Math.PI / 2;
        g.add(pipe);
        g.add(box(0.5, 0.3, 0.4, realMaterials.darkGrey, 0, 0.55, 0.4));
        return g;
    },
    // Passenger / cruise / ferry — tall multi-deck white superstructure + funnel.
    PASSENGER: () => {
        const g = new THREE.Group();
        g.add(...hullWithBow(1.2, 0.7, 3.6, realMaterials.hullPASSENGER));
        g.add(box(1.0, 0.5, 2.6, realMaterials.white, 0, 0.6, -0.1));
        g.add(box(0.85, 0.45, 2.0, realMaterials.white, 0, 1.05, -0.2));
        g.add(box(0.7, 0.4, 1.3, realMaterials.white, 0, 1.45, -0.3));
        g.add(cyl(0.12, 0.12, 0.5, realMaterials.grey, 0, 1.8, -0.8));
        return g;
    },
    // High-speed craft — catamaran twin hull, low cabin, sharp bow.
    HSC: () => {
        const g = new THREE.Group();
        g.add(box(0.35, 0.4, 3.2, realMaterials.hullHSC, -0.45, 0, 0));
        g.add(box(0.35, 0.4, 3.2, realMaterials.hullHSC,  0.45, 0, 0));
        g.add(box(1.3, 0.25, 2.2, realMaterials.white, 0, 0.3, -0.1));
        g.add(box(0.9, 0.4, 1.0, realMaterials.glass, 0, 0.6, 0.4));
        const bow = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.8, 4), realMaterials.hullHSC);
        bow.rotation.x = -Math.PI / 2; bow.position.set(0, 0.1, 1.9); g.add(bow);
        return g;
    },
    // Fishing vessel — small hull, forward wheelhouse, aft gantry.
    FISHING: () => {
        const g = new THREE.Group();
        g.add(...hullWithBow(0.9, 0.6, 2.2, realMaterials.hullFISHING));
        g.add(box(0.7, 0.7, 0.7, realMaterials.white, 0, 0.6, 0.4));
        g.add(cyl(0.04, 0.04, 1.0, realMaterials.grey, 0, 0.7, -0.9));
        g.add(box(0.5, 0.05, 0.6, realMaterials.grey, 0, 1.1, -0.9));
        return g;
    },
    // Tug — short stout hull, tall wheelhouse, stack, low towing deck aft.
    TUG: () => {
        const g = new THREE.Group();
        g.add(...hullWithBow(1.0, 0.7, 1.8, realMaterials.hullTUG));
        g.add(box(0.8, 0.9, 0.9, realMaterials.white, 0, 0.75, 0.2));
        g.add(cyl(0.13, 0.15, 0.6, realMaterials.darkGrey, 0, 1.0, 0.3));
        g.add(box(0.9, 0.15, 0.6, realMaterials.grey, 0, 0.35, -0.7));
        return g;
    },
    // Dredger — hull, spoil hopper, derrick tower, aft bridge.
    DREDGER: () => {
        const g = new THREE.Group();
        g.add(...hullWithBow(1.2, 0.7, 3.0, realMaterials.hullDREDGER));
        g.add(box(1.0, 0.5, 1.0, realMaterials.darkGrey, 0, 0.55, 0.2));
        g.add(cyl(0.05, 0.05, 1.6, realMaterials.grey, 0, 1.0, 0.2));
        g.add(box(0.7, 0.6, 0.7, realMaterials.white, 0, 0.65, -1.1));
        return g;
    },
    // Pilot launch — small fast boat, wheelhouse, radar deck.
    PILOT: () => {
        const g = new THREE.Group();
        g.add(...hullWithBow(0.7, 0.5, 1.8, realMaterials.hullPILOT));
        g.add(box(0.55, 0.5, 0.8, realMaterials.white, 0, 0.45, 0.0));
        g.add(box(0.5, 0.06, 0.5, realMaterials.darkGrey, 0, 0.78, 0.0));
        return g;
    },
    // Sailing vessel — slim hull, tall mast, thin triangular sail.
    SAILING: () => {
        const g = new THREE.Group();
        g.add(...hullWithBow(0.55, 0.45, 2.2, realMaterials.hullSAILING));
        g.add(cyl(0.04, 0.04, 2.6, realMaterials.white, 0, 1.3, 0.0));
        const sail = new THREE.Mesh(new THREE.ConeGeometry(0.5, 2.2, 3), realMaterials.white);
        sail.position.set(0, 1.25, 0.1); sail.scale.set(0.18, 1, 1);
        g.add(sail);
        return g;
    },
    // Pleasure craft — small yacht, glass cabin, sun deck.
    PLEASURE: () => {
        const g = new THREE.Group();
        g.add(...hullWithBow(0.7, 0.45, 1.9, realMaterials.hullPLEASURE));
        g.add(box(0.55, 0.35, 1.0, realMaterials.glass, 0, 0.4, 0.1));
        g.add(box(0.5, 0.06, 0.8, realMaterials.white, 0, 0.62, 0.1));
        return g;
    },
    // Service / SAR / utility — hull, superstructure, deck crane.
    SERVICE: () => {
        const g = new THREE.Group();
        g.add(...hullWithBow(1.0, 0.6, 2.6, realMaterials.hullSERVICE));
        g.add(box(0.8, 0.7, 0.9, realMaterials.white, 0, 0.65, -0.7));
        g.add(cyl(0.04, 0.04, 1.2, realMaterials.grey, 0, 0.9, 0.5));
        g.add(box(0.05, 0.05, 1.0, realMaterials.grey, 0, 1.3, 0.9));
        return g;
    },
    // Unknown / other — generic hull + simple bridge.
    OTHER: () => {
        const g = new THREE.Group();
        g.add(...hullWithBow(1.0, 0.7, 2.8, realMaterials.hullOTHER));
        g.add(box(0.8, 0.7, 0.9, realMaterials.white, 0, 0.65, -0.8));
        return g;
    }
};

// --- CLASS REGISTRY ---
// Exported so shipInstancer.js can harvest each class's parts (geometry +
// material + local transform) ONCE at startup, the same pattern used for
// AIRCRAFT_CLASSES_VISUAL — instead of every individual vessel calling
// shipClass.builder() and allocating its own fresh meshes/materials.
export const SHIP_CLASSES = [
    { type: "CARGO",     hex: "#ff5252", builder: shapeBuilders.CARGO },
    { type: "TANKER",    hex: "#ffab40", builder: shapeBuilders.TANKER },
    { type: "PASSENGER", hex: "#42a5f5", builder: shapeBuilders.PASSENGER },
    { type: "HSC",       hex: "#26c6da", builder: shapeBuilders.HSC },
    { type: "FISHING",   hex: "#66bb6a", builder: shapeBuilders.FISHING },
    { type: "TUG",       hex: "#ab47bc", builder: shapeBuilders.TUG },
    { type: "DREDGER",   hex: "#8d6e63", builder: shapeBuilders.DREDGER },
    { type: "PILOT",     hex: "#ffee58", builder: shapeBuilders.PILOT },
    { type: "SAILING",   hex: "#26a69a", builder: shapeBuilders.SAILING },
    { type: "PLEASURE",  hex: "#ec407a", builder: shapeBuilders.PLEASURE },
    { type: "SERVICE",   hex: "#78909c", builder: shapeBuilders.SERVICE },
    { type: "OTHER",     hex: "#90a4ae", builder: shapeBuilders.OTHER },
];

// ── Window stripe helper ───────────────────────────────────────────────────────
// Two thin dark panels on the upper sides of the fuselage representing the
// passenger window strip. Positioned at ~45° above the equator so they're
// visible from both above and from an oblique tactical camera angle.
// `radius` = fuselage top radius, `len` = cabin section length.
// Returns [portStripe, stbdStripe] — both non-body parts (stay dark, no airline tint).
function _windowStripes(radius, len) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x1a2538, roughness: 0.8, metalness: 0.1 });
    const geo = new THREE.BoxGeometry(0.04, 0.07, len);
    const xOff = radius * 0.86;
    const yOff = radius * 0.35;
    const sL = new THREE.Mesh(geo, mat);
    sL.position.set(-xOff, yOff, -0.2); // -0.2 Z shifts stripe aft of cockpit
    const sR = new THREE.Mesh(geo, mat);
    sR.position.set( xOff, yOff, -0.2);
    return [sL, sR];
}

// ── Nose-window helper ────────────────────────────────────────────────────────
// Two angled windshield panels flanking the cockpit dome. glassMat is the
// caller's existing glass material so colour stays consistent per builder.
// `w/h` = panel width/height, `z` = forward position, `yOff/xOff` = mount offset.
// Both panels are NOT body parts — they stay glass-dark regardless of airline tint.
function _noseWindows(glassMat, w, h, z, yOff, xOff) {
    const geo = new THREE.BoxGeometry(w, h, 0.025);
    const wL = new THREE.Mesh(geo, glassMat);
    wL.position.set(-xOff, yOff, z);
    wL.rotation.y =  0.30;   // angled inward toward centreline
    wL.rotation.x = -0.22;   // raked back (windshield angle)
    const wR = new THREE.Mesh(geo, glassMat);
    wR.position.set( xOff, yOff, z);
    wR.rotation.y = -0.30;
    wR.rotation.x = -0.22;
    return [wL, wR];
}

// ── Belly-strobe helper ───────────────────────────────────────────────────────
// Adds a white anti-collision strobe on the fuselage underside. Named and cached
// on group.userData so blink logic can toggle it the same way _tailStrobe works.
function _addBellyStrobe(group, y, z) {
    const strobe = new THREE.Mesh(
        new THREE.SphereGeometry(0.07, 6, 4),
        new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    strobe.position.set(0, y, z);
    strobe.name = 'strobe_belly';
    group.add(strobe);
    group.userData._bellyStrobe = strobe;
}

// ── Engine pylon helper ───────────────────────────────────────────────────────
// Flat strut connecting wing underside to engine nacelle top.
//   x         — lateral position (same X as engine)
//   nacTopY   — top of nacelle = engineCenterY + nacelle_radius
//   wingBotY  — bottom of wing = wingCenterY - wing_half_thickness
//   z         — fore-aft position (engine Z)
//   mat       — body material (gets airline tint via isBodyPart)
function _pylon(x, nacTopY, wingBotY, z, mat) {
    const h  = Math.max(wingBotY - nacTopY, 0.02);
    const cy = (nacTopY + wingBotY) / 2;
    const m  = new THREE.Mesh(new THREE.BoxGeometry(0.055, h, 0.20), mat);
    m.position.set(x, cy, z);
    return m;
}

// ── Boeing-style smooth nose helper ──────────────────────────────────────────
// Replaces ConeGeometry nose with a LatheGeometry profile: rounded tip →
// gradual shoulder curve matching the fuselage radius.
//   baseR  — fuselage radius (matches top radius of adjacent CylinderGeometry)
//   length — overall nose cone length (same value used in ConeGeometry height)
// Position the returned mesh at the same z as the old ConeGeometry mesh.
function _smoothNose(baseR, length, mat, segs = 12) {
    const h = length / 2;
    const pts = [
        new THREE.Vector2(0.000,          h),           // closed tip
        new THREE.Vector2(baseR * 0.14,   h * 0.68),    // early sharp taper
        new THREE.Vector2(baseR * 0.54,   h * 0.22),    // mid-belly curve
        new THREE.Vector2(baseR,         -h),            // base → joins fuselage
    ];
    const m = new THREE.Mesh(new THREE.LatheGeometry(pts, segs), mat);
    m.rotation.x = Math.PI / 2;
    return m;
}

// ── Wing geometry helper ───────────────────────────────────────────────────────
// Creates a trapezoidal wing panel: wider chord at root, narrower at tip.
// Root is at local +X, tip at local -X. Pass isRight=true for the right wing —
// that reverses face winding so normals point outward on both sides.
// Caller places the mesh at X = ∓(span/2) and applies sweep via rotation.y.
function _taperedWingGeo(span, thickness, chordRoot, chordTip, isRight = false) {
    const hw = span / 2, ht = thickness / 2;
    const cr = chordRoot / 2, ct = chordTip / 2;
    const [rX, tX] = isRight ? [-hw, hw] : [hw, -hw]; // root X, tip X in local space

    const v = new Float32Array([
        // bottom (y = -ht)
        tX, -ht, -ct,  // 0 tip-leading
        tX, -ht,  ct,  // 1 tip-trailing
        rX, -ht,  cr,  // 2 root-trailing
        rX, -ht, -cr,  // 3 root-leading
        // top (y = +ht)
        tX,  ht, -ct,  // 4 tip-leading
        tX,  ht,  ct,  // 5 tip-trailing
        rX,  ht,  cr,  // 6 root-trailing
        rX,  ht, -cr,  // 7 root-leading
    ]);

    // CCW winding = outward normal. Right wing mirrors X → all face windings reverse.
    /* eslint-disable no-multi-spaces */
    const idx = isRight
        ? [0,1,2, 0,2,3,  4,6,5, 4,7,6,  3,6,7, 3,2,6,  0,4,5, 0,5,1,  0,7,3, 0,4,7,  1,6,2, 1,5,6]
        : [0,2,1, 0,3,2,  4,5,6, 4,6,7,  3,7,6, 3,6,2,  0,5,4, 0,1,5,  0,3,7, 0,7,4,  1,2,6, 1,6,5];
    /* eslint-enable no-multi-spaces */

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(v, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
}

// ── AIRLINER shape (real flight data) ─────────────────────────────────────────
function buildAirliner() {
    const group   = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.3, metalness: 0.55, emissive: 0xffffff, emissiveIntensity: 0.14 }); // base white — airline instance colour multiplies in; emissive ensures planes pop against bright terrain
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x334455, roughness: 0.5, metalness: 0.4 });
    const glassMat= new THREE.MeshStandardMaterial({ color: 0x99bbdd, roughness: 0.1, metalness: 0.8, transparent: true, opacity: 0.7 });

    // Fuselage — tapered tube
    const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.17, 4.8, 12), bodyMat);
    fuselage.rotation.x = Math.PI / 2;

    // Nose — Boeing-style smooth curve (LatheGeometry) instead of sharp cone
    const nose = _smoothNose(0.22, 0.60, bodyMat);
    nose.position.z = 2.70;   // fuselage end (2.4) + half nose (0.30)

    // Cockpit windows
    const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), glassMat);
    cockpit.position.set(0, 0.16, 2.1);

    // Nose windows — L/R windshield panels flanking cockpit dome
    const [nwL, nwR] = _noseWindows(glassMat, 0.14, 0.08, 2.18, 0.08, 0.09);

    // Main swept wings — tapered (root 1.0, tip 0.40), dihedral +5.6°
    const wingL = new THREE.Mesh(_taperedWingGeo(3.2, 0.06, 1.0, 0.40, false), bodyMat);
    wingL.position.set(-1.6, 0.097, 0.1);
    wingL.rotation.y =  Math.PI / 9;
    wingL.rotation.z = -Math.PI / 32;

    const wingR = new THREE.Mesh(_taperedWingGeo(3.2, 0.06, 1.0, 0.40, true), bodyMat);
    wingR.position.set( 1.6, 0.097, 0.1);
    wingR.rotation.y = -Math.PI / 9;
    wingR.rotation.z =  Math.PI / 32;

    // Winglets — placed at actual swept+dihedralled tip position
    const wlL = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.42, 0.28), bodyMat);
    wlL.position.set(-3.10, 0.24, 0.65);
    const wlR = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.42, 0.28), bodyMat);
    wlR.position.set( 3.10, 0.24, 0.65);

    // Horizontal stabiliser — split into L/R halves so each sweeps symmetrically.
    // A single mesh rotated around Y makes the whole stab yaw (crooked); two halves
    // with mirrored rotations produce the correct symmetric swept-back look.
    const stabHL = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.05, 0.48), bodyMat);
    stabHL.position.set(-0.475, 0.04, -2.2); stabHL.rotation.y =  Math.PI / 9;
    const stabHR = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.05, 0.48), bodyMat);
    stabHR.position.set( 0.475, 0.04, -2.2); stabHR.rotation.y = -Math.PI / 9;

    // Vertical stabiliser — slightly wider for readability at map zoom
    const stabV = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.9, 0.7), bodyMat);
    stabV.position.set(0, 0.5, -2.1);

    // Engines under wings (x2) — nacR=0.17, top = -0.28+0.17=-0.11
    // wing bottom = 0.097-0.03=0.067 → pylon height ≈ 0.177
    const engGeo = new THREE.CylinderGeometry(0.17, 0.14, 0.95, 10);
    const engL = new THREE.Mesh(engGeo, darkMat);
    engL.rotation.x = Math.PI / 2;
    engL.position.set(-1.25, -0.28, 0.15);

    const engR = new THREE.Mesh(engGeo, darkMat);
    engR.rotation.x = Math.PI / 2;
    engR.position.set( 1.25, -0.28, 0.15);

    // Inlet faces — dark discs at front of each nacelle (z + 0.475)
    const inletMat = new THREE.MeshStandardMaterial({ color: 0x080c10, roughness: 0.9, metalness: 0.1 });
    const inletL = new THREE.Mesh(new THREE.CircleGeometry(0.148, 10), inletMat);
    inletL.position.set(-1.25, -0.28, 0.625);
    const inletR = new THREE.Mesh(new THREE.CircleGeometry(0.148, 10), inletMat);
    inletR.position.set( 1.25, -0.28, 0.625);

    // Intake lip ring at nacelle mouth
    const lipMat = new THREE.MeshStandardMaterial({ color: 0xaabbcc, roughness: 0.25, metalness: 0.75 });
    const lipL = new THREE.Mesh(new THREE.TorusGeometry(0.17 * 0.94, 0.17 * 0.14, 5, 12), lipMat);
    lipL.rotation.x = Math.PI / 2; lipL.position.set(-1.25, -0.28, 0.625);
    const lipR = new THREE.Mesh(new THREE.TorusGeometry(0.17 * 0.94, 0.17 * 0.14, 5, 12), lipMat);
    lipR.rotation.x = Math.PI / 2; lipR.position.set( 1.25, -0.28, 0.625);

    // Engine pylons — flat struts wing underside → nacelle top
    const pylonL = _pylon(-1.25, -0.11, 0.067, 0.05, bodyMat);
    const pylonR = _pylon( 1.25, -0.11, 0.067, 0.05, bodyMat);

    // Engine exhaust glow (additive blending)
    const glowMat = new THREE.MeshBasicMaterial({
        color: 0xff9900, transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false
    });
    const glowGeo = new THREE.ConeGeometry(0.12, 0.55, 8);
    const glowL = new THREE.Mesh(glowGeo, glowMat);
    glowL.rotation.x = -Math.PI / 2;
    glowL.position.set(-1.25, -0.28, -0.4);

    const glowR = new THREE.Mesh(glowGeo, glowMat);
    glowR.rotation.x = -Math.PI / 2;
    glowR.position.set( 1.25, -0.28, -0.4);

    // Navigation lights (red port, green starboard) — blinking handled in tick
    const navL = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 6, 6),
        new THREE.MeshBasicMaterial({ color: 0xff2222 })
    );
    navL.position.set(-3.10, 0.24, 0.65);
    navL.name = 'nav_red';

    const navR = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 6, 6),
        new THREE.MeshBasicMaterial({ color: 0x22ff44 })
    );
    navR.position.set(3.10, 0.24, 0.65);
    navR.name = 'nav_green';

    // Tail strobe (white)
    const tailStrobe = new THREE.Mesh(
        new THREE.SphereGeometry(0.1, 6, 6),
        new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    tailStrobe.position.set(0, 0.95, -2.1);
    tailStrobe.name = 'strobe_tail';

    // stabV = vertical fin — gets airline TAIL colour (separate instancer layer).
    stabV.userData.isTailPart = true;
    // Mark structural body parts so altitude-colour coding knows what to tint.
    // Nav lights, glow cones, glass, lip rings, stripes, and the tail fin are excluded.
    const bodyParts = [fuselage, nose, wingL, wingR, wlL, wlR, stabHL, stabHR, pylonL, pylonR];
    bodyParts.forEach(m => { m.userData.isBodyPart = true; });

    // Window stripe — stays dark regardless of airline tint (not in bodyParts)
    const [stripeL, stripeR] = _windowStripes(0.22, 3.4);

    group.add(
        fuselage, nose, cockpit,
        wingL, wingR, wlL, wlR,
        stabHL, stabHR, stabV,
        pylonL, pylonR,
        engL, engR, glowL, glowR, inletL, inletR, lipL, lipR,
        navL, navR, tailStrobe,
        stripeL, stripeR,
        nwL, nwR
    );

    // Cache hot-path references directly on the group so the animate loop
    // never needs getObjectByName() or traverse() — both walk the full subtree.
    group.userData._bodyParts  = bodyParts;
    group.userData._navRed     = navL;
    group.userData._navGreen   = navR;
    group.userData._tailStrobe = tailStrobe;

    _addBellyStrobe(group, -0.22, 0.4);

    return group;
}

// Shared nav-light + strobe rig — every powered aircraft carries red/green
// wingtip lights and a white tail strobe; only the mount points differ.
function _navLights(group, halfSpan, tailZ, tailY = 0.5) {
    const navL = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 6), new THREE.MeshBasicMaterial({ color: 0xff2222 }));
    navL.position.set(-halfSpan, 0, 0.1);
    navL.name = 'nav_red';
    const navR = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 6), new THREE.MeshBasicMaterial({ color: 0x22ff44 }));
    navR.position.set(halfSpan, 0, 0.1);
    navR.name = 'nav_green';
    const tailStrobe = new THREE.Mesh(new THREE.SphereGeometry(0.1, 6, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    tailStrobe.position.set(0, tailY, tailZ);
    tailStrobe.name = 'strobe_tail';
    group.add(navL, navR, tailStrobe);
    group.userData._navRed     = navL;
    group.userData._navGreen   = navR;
    group.userData._tailStrobe = tailStrobe;
}

// Engine pod + additive exhaust glow cone + inlet face disc + intake lip ring.
// Returns [eng, glow, inlet, lip] — callers must add all four to the group.
function _engineWithGlow(x, y, z, mat, scale = 1, glowColor = 0xff9900) {
    const nacR = 0.17 * scale;
    const eng = new THREE.Mesh(new THREE.CylinderGeometry(nacR, 0.14 * scale, 0.95 * scale, 10), mat);
    eng.rotation.x = Math.PI / 2;
    eng.position.set(x, y, z);

    // Dark intake disc at the forward (nose-facing) end of the nacelle.
    const inletMat = new THREE.MeshStandardMaterial({ color: 0x080c10, roughness: 0.9, metalness: 0.1 });
    const inlet = new THREE.Mesh(new THREE.CircleGeometry(0.148 * scale, 10), inletMat);
    inlet.position.set(x, y, z + 0.476 * scale);

    // Intake lip ring — TorusGeometry around the nacelle mouth; the chamfered ring
    // that distinguishes a real turbofan from a plain cylinder at close zoom.
    const lipMat = new THREE.MeshStandardMaterial({ color: 0xaabbcc, roughness: 0.25, metalness: 0.75 });
    const lip = new THREE.Mesh(new THREE.TorusGeometry(nacR * 0.94, nacR * 0.14, 5, 12), lipMat);
    lip.rotation.x = Math.PI / 2;
    lip.position.set(x, y, z + 0.476 * scale);

    const glowMat = new THREE.MeshBasicMaterial({
        color: glowColor, transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const glow = new THREE.Mesh(new THREE.ConeGeometry(0.12 * scale, 0.55 * scale, 8), glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(x, y, z - 0.75 * scale);
    return [eng, glow, inlet, lip];
}

// ── CARGO shape — boxier fuselage, no winglets, twin engines, white base (tinted per-instance) ──
function buildCargoFreighter() {
    const group   = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.4, metalness: 0.5, emissive: 0xffffff, emissiveIntensity: 0.12 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x334455, roughness: 0.5, metalness: 0.4 });

    const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.22, 5.4, 12), bodyMat);
    fuselage.rotation.x = Math.PI / 2;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.27, 0.8, 12), bodyMat);
    nose.rotation.x = Math.PI / 2;
    nose.position.z = 3.3;

    const wingL = new THREE.Mesh(_taperedWingGeo(3.6, 0.07, 1.05, 0.45, false), bodyMat);
    wingL.position.set(-1.8, 0.096, 0.1); wingL.rotation.y = Math.PI / 11; wingL.rotation.z = -Math.PI / 32;
    const wingR = new THREE.Mesh(_taperedWingGeo(3.6, 0.07, 1.05, 0.45, true), bodyMat);
    wingR.position.set(1.8, 0.096, 0.1); wingR.rotation.y = -Math.PI / 11; wingR.rotation.z =  Math.PI / 32;

    // Split L/R stab halves
    const stabHL = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.05, 0.53), bodyMat);
    stabHL.position.set(-0.525, 0.04, -2.5); stabHL.rotation.y =  Math.PI / 9;
    const stabHR = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.05, 0.53), bodyMat);
    stabHR.position.set( 0.525, 0.04, -2.5); stabHR.rotation.y = -Math.PI / 9;
    const stabV = new THREE.Mesh(new THREE.BoxGeometry(0.09, 1.0, 0.8), bodyMat);
    stabV.position.set(0, 0.55, -2.4);

    const [eng1, glow1, inlet1, lip1] = _engineWithGlow(-1.5, -0.32, 0.2, darkMat, 1.1);
    const [eng2, glow2, inlet2, lip2] = _engineWithGlow( 1.5, -0.32, 0.2, darkMat, 1.1);

    // Pylons: nacR=0.17*1.1=0.187, nacTopY=-0.32+0.187=-0.133
    // wingBotY=0.096-0.035=0.061
    const cpylonL = _pylon(-1.5, -0.133, 0.061, 0.1, bodyMat);
    const cpylonR = _pylon( 1.5, -0.133, 0.061, 0.1, bodyMat);

    const bodyParts = [fuselage, nose, wingL, wingR, stabHL, stabHR, stabV, cpylonL, cpylonR];
    bodyParts.forEach(m => { m.userData.isBodyPart = true; });
    group.userData._bodyParts = bodyParts;

    group.add(fuselage, nose, wingL, wingR, stabHL, stabHR, stabV, cpylonL, cpylonR, eng1, eng2, glow1, glow2, inlet1, inlet2, lip1, lip2);
    _navLights(group, 3.5, -2.4, 0.95);
    return group;
}

// ── MILITARY shape — slim fuselage, swept delta wings, twin tails, afterburner glow ──
function buildMilitaryJet() {
    const group   = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x6b7a5e, roughness: 0.55, metalness: 0.45, emissive: 0x667744, emissiveIntensity: 0.12 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x263238, roughness: 0.5, metalness: 0.5 });
    const glassMat= new THREE.MeshStandardMaterial({ color: 0x4a5a66, roughness: 0.1, metalness: 0.8, transparent: true, opacity: 0.75 });

    const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.10, 3.6, 10), bodyMat);
    fuselage.rotation.x = Math.PI / 2;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.13, 1.1, 10), bodyMat);
    nose.rotation.x = Math.PI / 2; nose.position.z = 2.35;
    const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.10, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), glassMat);
    cockpit.position.set(0, 0.10, 1.5);

    // Swept delta wings, set well aft
    const wingL = new THREE.Mesh(new THREE.ConeGeometry(0.95, 2.4, 3), bodyMat);
    wingL.rotation.z = Math.PI / 2; wingL.rotation.y = Math.PI / 2.2;
    wingL.position.set(-0.9, -0.02, -0.5); wingL.scale.set(1, 1, 0.16);
    const wingR = new THREE.Mesh(new THREE.ConeGeometry(0.95, 2.4, 3), bodyMat);
    wingR.rotation.z = -Math.PI / 2; wingR.rotation.y = -Math.PI / 2.2;
    wingR.position.set(0.9, -0.02, -0.5); wingR.scale.set(1, 1, 0.16);

    // Twin canted vertical tails
    const tailL = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.65, 0.55), darkMat);
    tailL.position.set(-0.18, 0.35, -1.55); tailL.rotation.z = Math.PI / 10;
    const tailR = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.65, 0.55), darkMat);
    tailR.position.set(0.18, 0.35, -1.55); tailR.rotation.z = -Math.PI / 10;

    const [eng, glow, inlet, lip] = _engineWithGlow(0, -0.05, -1.7, darkMat, 1.3, 0xff5500);

    const bodyParts = [fuselage, nose, wingL, wingR, tailL, tailR];
    bodyParts.forEach(m => { m.userData.isBodyPart = true; });
    group.userData._bodyParts = bodyParts;

    group.add(fuselage, nose, cockpit, wingL, wingR, tailL, tailR, eng, glow, inlet, lip);
    _navLights(group, 1.0, -1.55, 0.6);
    return group;
}

// ── HELICOPTER shape — boxy cabin, tail boom, spinning main + tail rotor ─────
function buildHelicopter() {
    const group   = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x40c4ff, roughness: 0.4, metalness: 0.5, emissive: 0x1a6080, emissiveIntensity: 0.18 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x263238, roughness: 0.5, metalness: 0.4 });
    const glassMat= new THREE.MeshStandardMaterial({ color: 0x99bbdd, roughness: 0.1, metalness: 0.7, transparent: true, opacity: 0.7 });

    const cabin = new THREE.Mesh(new THREE.SphereGeometry(0.4, 12, 10), bodyMat);
    cabin.scale.set(1, 0.85, 1.3);
    cabin.position.set(0, 0, 0.3);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.32, 10, 8, 0, Math.PI * 2, 0, Math.PI / 1.6), glassMat);
    nose.position.set(0, -0.02, 0.75);

    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.03, 1.7, 8), bodyMat);
    boom.rotation.x = Math.PI / 2; boom.position.set(0, 0.05, -1.05);

    const tailFin = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.45, 0.35), darkMat);
    tailFin.position.set(0, 0.25, -1.85);

    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.3, 8), darkMat);
    mast.position.set(0, 0.5, 0.1);

    const rotorMat = new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
    const mainRotor = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.02, 0.12), rotorMat);
    mainRotor.position.set(0, 0.66, 0.1);
    mainRotor.name = 'main_rotor'; // spun in main.js animation loop

    const tailRotor = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.02, 0.03), rotorMat);
    tailRotor.position.set(0.05, 0.25, -1.85);
    tailRotor.rotation.z = Math.PI / 2;
    tailRotor.name = 'tail_rotor';

    const skidMat = new THREE.MeshStandardMaterial({ color: 0x37474f, roughness: 0.6 });
    const skidL = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.3, 6), skidMat);
    skidL.rotation.z = Math.PI / 2; skidL.position.set(-0.35, -0.42, 0.1);
    const skidR = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.3, 6), skidMat);
    skidR.rotation.z = Math.PI / 2; skidR.position.set(0.35, -0.42, 0.1);

    const bodyParts = [cabin, boom, tailFin];
    bodyParts.forEach(m => { m.userData.isBodyPart = true; });
    group.userData._bodyParts = bodyParts;
    group.userData._mainRotor = mainRotor;
    group.userData._tailRotor = tailRotor;

    group.add(cabin, nose, boom, tailFin, mast, mainRotor, tailRotor, skidL, skidR);
    _navLights(group, 0.45, -1.85, 0.3);
    return group;
}

// ── GA shape — small single-engine prop, straight wings, no jet glow ────────
function buildGA() {
    const group   = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xd9b3ff, roughness: 0.4, metalness: 0.3, emissive: 0x7040aa, emissiveIntensity: 0.15 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x37474f, roughness: 0.6 });
    const glassMat= new THREE.MeshStandardMaterial({ color: 0x99bbdd, roughness: 0.1, metalness: 0.6, transparent: true, opacity: 0.7 });

    const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.08, 1.9, 10), bodyMat);
    fuselage.rotation.x = Math.PI / 2;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.10, 0.35, 10), bodyMat);
    nose.rotation.x = Math.PI / 2; nose.position.z = 1.05;
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), glassMat);
    canopy.position.set(0, 0.10, 0.55);

    // Straight, unswept high wing
    const wing = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.025, 0.32), bodyMat);
    wing.position.set(0, 0.10, 0.05);

    const stabH = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.02, 0.2), bodyMat);
    stabH.position.set(0, 0.02, -0.9);
    const stabV = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.32, 0.24), bodyMat);
    stabV.position.set(0, 0.18, -0.9);

    // Spinning prop disc — translucent like the helicopter's rotor
    const propMat = new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.45, side: THREE.DoubleSide });
    const prop = new THREE.Mesh(new THREE.CircleGeometry(0.18, 16), propMat);
    prop.position.set(0, 0, 1.22);
    prop.name = 'prop_disc';

    const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.1, 8), darkMat);
    spinner.rotation.x = Math.PI / 2; spinner.position.set(0, 0, 1.25);

    const bodyParts = [fuselage, nose, wing, stabH, stabV];
    bodyParts.forEach(m => { m.userData.isBodyPart = true; });
    group.userData._bodyParts = bodyParts;
    group.userData._propDisc  = prop;

    group.add(fuselage, nose, canopy, wing, stabH, stabV, prop, spinner);
    _navLights(group, 0.95, -0.9, 0.25);
    return group;
}

// ── NARROWBODY shape — slim single-aisle (A320 / B737 family) ────────────────
// Most common commercial airliner. Slightly slimmer than the generic COMMERCIAL
// fallback, sharklet winglets, moderate wing sweep. Scale 0.13.
function buildNarrowbody() {
    const group   = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.25, metalness: 0.60, emissive: 0xffffff, emissiveIntensity: 0.14 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x2a3a4a, roughness: 0.50, metalness: 0.40 });
    const glassMat= new THREE.MeshStandardMaterial({ color: 0x88aacc, roughness: 0.10, metalness: 0.85, transparent: true, opacity: 0.70 });

    const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.15, 4.4, 12), bodyMat);
    fuselage.rotation.x = Math.PI / 2;

    // Nose — smooth Boeing-style LatheGeometry curve (0.60 long)
    const nose = _smoothNose(0.19, 0.60, bodyMat);
    nose.position.z = 2.50;   // fuselage end (2.2) + half nose (0.30)

    const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), glassMat);
    cockpit.position.set(0, 0.14, 1.95);

    const [nwL, nwR] = _noseWindows(glassMat, 0.12, 0.07, 2.02, 0.07, 0.08);

    const wingL = new THREE.Mesh(_taperedWingGeo(2.8, 0.055, 0.82, 0.32, false), bodyMat);
    wingL.position.set(-1.4, 0.082, 0.05); wingL.rotation.y = Math.PI / 10; wingL.rotation.z = -Math.PI / 32;
    const wingR = new THREE.Mesh(_taperedWingGeo(2.8, 0.055, 0.82, 0.32, true), bodyMat);
    wingR.position.set( 1.4, 0.082, 0.05); wingR.rotation.y = -Math.PI / 10; wingR.rotation.z =  Math.PI / 32;

    // Sharklets — placed at actual swept+dihedralled tip position
    const wlL = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.52, 0.24), bodyMat);
    wlL.position.set(-2.73, 0.21, 0.48);
    const wlR = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.52, 0.24), bodyMat);
    wlR.position.set( 2.73, 0.21, 0.48);

    // Split L/R stab halves — symmetric sweep instead of single-mesh yaw
    const stabHL = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.045, 0.43), bodyMat);
    stabHL.position.set(-0.425, 0.04, -2.0); stabHL.rotation.y =  Math.PI / 9;
    const stabHR = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.045, 0.43), bodyMat);
    stabHR.position.set( 0.425, 0.04, -2.0); stabHR.rotation.y = -Math.PI / 9;
    const stabV = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.85, 0.65), bodyMat);
    stabV.position.set(0, 0.46, -1.95);

    // LEAP-1A / CFM56 engines — large diameter on A320neo/737MAX, scale=1.3
    // 737 has distinctive flat-bottom nacelles (low ground clearance) → scale.y=0.88
    const [engL, glowL, inletL, lipL] = _engineWithGlow(-1.1, -0.33, 0.1, darkMat, 1.3);
    const [engR, glowR, inletR, lipR] = _engineWithGlow( 1.1, -0.33, 0.1, darkMat, 1.3);
    engL.scale.y = 0.88; engR.scale.y = 0.88;  // flat-bottom nacelle (737 signature)

    // Pylons: nacR=0.17*1.3=0.221, nacTopY=-0.33+0.221=-0.109
    // wingBotY=0.082-0.0275=0.0545
    const pylonL = _pylon(-1.1, -0.109, 0.0545, 0.05, bodyMat);
    const pylonR = _pylon( 1.1, -0.109, 0.0545, 0.05, bodyMat);

    stabV.userData.isTailPart = true;
    const bodyParts = [fuselage, nose, wingL, wingR, wlL, wlR, stabHL, stabHR, pylonL, pylonR];
    bodyParts.forEach(m => { m.userData.isBodyPart = true; });
    group.userData._bodyParts = bodyParts;

    const [stripeL, stripeR] = _windowStripes(0.19, 3.0);
    group.add(fuselage, nose, cockpit, wingL, wingR, wlL, wlR, stabHL, stabHR, stabV,
              pylonL, pylonR,
              engL, engR, glowL, glowR, inletL, inletR, lipL, lipR,
              stripeL, stripeR, nwL, nwR);
    _navLights(group, 2.73, -1.95, 0.85);
    _addBellyStrobe(group, -0.19, 0.3);
    return group;
}

// ── WIDEBODY shape — large twin-aisle (B777 / A330 / B787 family) ─────────────
// Noticeably fatter fuselage, longer wingspan, bigger engines, raked wingtips
// (no winglets — 777/787 style). Scale 0.18 makes it visibly larger than the
// narrowbody at the same map position.
function buildWidebody() {
    const group   = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.22, metalness: 0.62, emissive: 0xffffff, emissiveIntensity: 0.14 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x2a3a4a, roughness: 0.50, metalness: 0.40 });
    const glassMat= new THREE.MeshStandardMaterial({ color: 0x88aacc, roughness: 0.08, metalness: 0.85, transparent: true, opacity: 0.70 });

    // Fat fuselage — double-aisle cross-section
    const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.26, 6.0, 14), bodyMat);
    fuselage.rotation.x = Math.PI / 2;

    // Nose — smooth Boeing-style LatheGeometry curve (0.70 long)
    const nose = _smoothNose(0.31, 0.70, bodyMat, 14);
    nose.position.z = 3.35;   // fuselage end (3.0) + half nose (0.35)

    const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), glassMat);
    cockpit.position.set(0, 0.20, 2.7);

    const [nwL, nwR] = _noseWindows(glassMat, 0.18, 0.11, 2.80, 0.11, 0.12);

    // Long wings with wider chord
    const wingL = new THREE.Mesh(_taperedWingGeo(4.2, 0.08, 1.25, 0.50, false), bodyMat);
    wingL.position.set(-2.1, 0.126, 0.0); wingL.rotation.y = Math.PI / 8; wingL.rotation.z = -Math.PI / 32;
    const wingR = new THREE.Mesh(_taperedWingGeo(4.2, 0.08, 1.25, 0.50, true), bodyMat);
    wingR.position.set( 2.1, 0.126, 0.0); wingR.rotation.y = -Math.PI / 8; wingR.rotation.z =  Math.PI / 32;

    // Raked wingtips (777X / 787 style) — placed at actual swept+dihedralled tip position
    const rtL = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.35), bodyMat);
    rtL.position.set(-4.03, 0.32, 0.80); rtL.rotation.z =  Math.PI / 8;
    const rtR = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.35), bodyMat);
    rtR.position.set( 4.03, 0.32, 0.80); rtR.rotation.z = -Math.PI / 8;

    // Split L/R stab halves
    const stabHL = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.06, 0.58), bodyMat);
    stabHL.position.set(-0.6, 0.04, -2.8); stabHL.rotation.y =  Math.PI / 9;
    const stabHR = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.06, 0.58), bodyMat);
    stabHR.position.set( 0.6, 0.04, -2.8); stabHR.rotation.y = -Math.PI / 9;
    const stabV = new THREE.Mesh(new THREE.BoxGeometry(0.10, 1.10, 0.85), bodyMat);
    stabV.position.set(0, 0.60, -2.7);

    // Large twin engines — GE9X / Trent 1000 scale, scale=1.35
    const [engL, glowL, inletL, lipL] = _engineWithGlow(-1.6, -0.38, 0.1, darkMat, 1.35);
    const [engR, glowR, inletR, lipR] = _engineWithGlow( 1.6, -0.38, 0.1, darkMat, 1.35);

    // Pylons: nacR=0.17*1.35=0.2295, nacTopY=-0.38+0.2295=-0.1505
    // wingBotY=0.126-0.04=0.086
    const pylonL = _pylon(-1.6, -0.1505, 0.086, 0.05, bodyMat);
    const pylonR = _pylon( 1.6, -0.1505, 0.086, 0.05, bodyMat);

    stabV.userData.isTailPart = true;
    const bodyParts = [fuselage, nose, wingL, wingR, rtL, rtR, stabHL, stabHR, pylonL, pylonR];
    bodyParts.forEach(m => { m.userData.isBodyPart = true; });
    group.userData._bodyParts = bodyParts;

    const [stripeL, stripeR] = _windowStripes(0.31, 4.4);
    group.add(fuselage, nose, cockpit, wingL, wingR, rtL, rtR, stabHL, stabHR, stabV,
              pylonL, pylonR,
              engL, engR, glowL, glowR, inletL, inletR, lipL, lipR,
              stripeL, stripeR, nwL, nwR);
    _navLights(group, 4.03, -2.7, 1.1);
    _addBellyStrobe(group, -0.31, 0.5);
    return group;
}

// ── REGIONAL shape — small regional jet (E175 / CRJ9 family) ─────────────────
// Shorter, narrower fuselage, less wing sweep, smaller engines, no winglets.
// Visibly smaller than the narrowbody at the same map zoom.
function buildRegional() {
    const group   = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.30, metalness: 0.55, emissive: 0xffffff, emissiveIntensity: 0.14 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x2a3a4a, roughness: 0.50, metalness: 0.40 });
    const glassMat= new THREE.MeshStandardMaterial({ color: 0x88aacc, roughness: 0.12, metalness: 0.80, transparent: true, opacity: 0.70 });

    const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.11, 3.2, 10), bodyMat);
    fuselage.rotation.x = Math.PI / 2;

    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.75, 10), bodyMat);
    nose.rotation.x = Math.PI / 2;
    nose.position.z = 2.05;

    const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), glassMat);
    cockpit.position.set(0, 0.10, 1.65);

    const [nwL, nwR] = _noseWindows(glassMat, 0.09, 0.06, 1.71, 0.06, 0.06);

    // Shorter, less-swept wings — regional jets have relatively straight wings
    const wingL = new THREE.Mesh(_taperedWingGeo(2.1, 0.040, 0.58, 0.25, false), bodyMat);
    wingL.position.set(-1.05, 0.063, 0.15); wingL.rotation.y = Math.PI / 13; wingL.rotation.z = -Math.PI / 32;
    const wingR = new THREE.Mesh(_taperedWingGeo(2.1, 0.040, 0.58, 0.25, true), bodyMat);
    wingR.position.set( 1.05, 0.063, 0.15); wingR.rotation.y = -Math.PI / 13; wingR.rotation.z =  Math.PI / 32;

    // Split L/R stab halves
    const stabHL = new THREE.Mesh(new THREE.BoxGeometry(0.625, 0.035, 0.33), bodyMat);
    stabHL.position.set(-0.315, 0.03, -1.5); stabHL.rotation.y =  Math.PI / 9;
    const stabHR = new THREE.Mesh(new THREE.BoxGeometry(0.625, 0.035, 0.33), bodyMat);
    stabHR.position.set( 0.315, 0.03, -1.5); stabHR.rotation.y = -Math.PI / 9;
    const stabV = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.70, 0.55), bodyMat);
    stabV.position.set(0, 0.38, -1.45);

    const [engL, glowL, inletL, lipL] = _engineWithGlow(-0.85, -0.22, 0.05, darkMat, 0.75);
    const [engR, glowR, inletR, lipR] = _engineWithGlow( 0.85, -0.22, 0.05, darkMat, 0.75);

    // Pylons: nacR=0.17*0.75=0.1275, nacTopY=-0.22+0.1275=-0.0925
    // wingBotY=0.063-0.02=0.043
    const pylonL = _pylon(-0.85, -0.0925, 0.043, 0.05, bodyMat);
    const pylonR = _pylon( 0.85, -0.0925, 0.043, 0.05, bodyMat);

    stabV.userData.isTailPart = true;
    const bodyParts = [fuselage, nose, wingL, wingR, stabHL, stabHR, pylonL, pylonR];
    bodyParts.forEach(m => { m.userData.isBodyPart = true; });
    group.userData._bodyParts = bodyParts;

    const [stripeL, stripeR] = _windowStripes(0.14, 2.2);
    group.add(fuselage, nose, cockpit, wingL, wingR, stabHL, stabHR, stabV,
              pylonL, pylonR,
              engL, engR, glowL, glowR, inletL, inletR, lipL, lipR,
              stripeL, stripeR, nwL, nwR);
    _navLights(group, 2.05, -1.45, 0.70);
    _addBellyStrobe(group, -0.14, 0.2);
    return group;
}

// ── BIZJET shape — sleek business jet (Citation / Gulfstream family) ──────────
// Three distinguishing features vs. the airliner shapes:
//   1. REAR-mounted engines on the aft fuselage (not under the wings)
//   2. T-tail — horizontal stab sits on TOP of the vertical stab
//   3. Highly swept, thin wings (more delta-ish planform)
function buildBizjet() {
    const group   = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.20, metalness: 0.70, emissive: 0xffffff, emissiveIntensity: 0.14 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x2a3a4a, roughness: 0.50, metalness: 0.40 });
    const glassMat= new THREE.MeshStandardMaterial({ color: 0x88aacc, roughness: 0.08, metalness: 0.85, transparent: true, opacity: 0.65 });

    // Slim, sleek fuselage
    const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.08, 3.4, 10), bodyMat);
    fuselage.rotation.x = Math.PI / 2;

    // Pointed nose — more streamlined than a commercial airliner
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.11, 1.0, 10), bodyMat);
    nose.rotation.x = Math.PI / 2;
    nose.position.z = 2.2;

    const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), glassMat);
    cockpit.position.set(0, 0.09, 1.8);

    const [nwL, nwR] = _noseWindows(glassMat, 0.07, 0.05, 1.86, 0.05, 0.05);

    // Highly swept wings
    const wingL = new THREE.Mesh(_taperedWingGeo(2.2, 0.035, 0.55, 0.18, false), bodyMat);
    wingL.position.set(-1.1, 0.073, 0.0); wingL.rotation.y =  Math.PI / 6; wingL.rotation.z = -Math.PI / 32;
    const wingR = new THREE.Mesh(_taperedWingGeo(2.2, 0.035, 0.55, 0.18, true), bodyMat);
    wingR.position.set( 1.1, 0.073, 0.0); wingR.rotation.y = -Math.PI / 6; wingR.rotation.z =  Math.PI / 32;

    // Winglets (common on Gulfstream / Citation X) — placed at swept+dihedralled tip
    const wlL = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.38, 0.18), bodyMat);
    wlL.position.set(-2.05, 0.17, 0.55);
    const wlR = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.38, 0.18), bodyMat);
    wlR.position.set( 2.05, 0.17, 0.55);

    // Vertical stab — tall
    const stabV = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.0, 0.55), bodyMat);
    stabV.position.set(0, 0.55, -1.6);

    // T-tail: split L/R halves so each sweeps symmetrically at the vertical stab apex.
    // A single mesh rotated around Y yaws the whole stab; two halves with mirrored Y
    // rotations produce the correct symmetric swept look (same pattern as main stabs).
    const stabHL = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.035, 0.35), bodyMat);
    stabHL.position.set(-0.325, 1.05, -1.65); stabHL.rotation.y =  Math.PI / 9;
    const stabHR = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.035, 0.35), bodyMat);
    stabHR.position.set( 0.325, 1.05, -1.65); stabHR.rotation.y = -Math.PI / 9;

    // REAR-mounted engines on aft fuselage sides (most distinctive bizjet feature)
    const engGeo = new THREE.CylinderGeometry(0.095, 0.075, 0.72, 8);
    const engL = new THREE.Mesh(engGeo, darkMat);
    engL.rotation.x = Math.PI / 2;
    engL.position.set(-0.22, 0.04, -0.8);
    const engR = new THREE.Mesh(engGeo, darkMat);
    engR.rotation.x = Math.PI / 2;
    engR.position.set( 0.22, 0.04, -0.8);

    // Inlet faces — front of nacelle at z + 0.36 (half of 0.72 height)
    const bjInletMat = new THREE.MeshStandardMaterial({ color: 0x080c10, roughness: 0.9, metalness: 0.1 });
    const inletL = new THREE.Mesh(new THREE.CircleGeometry(0.083, 8), bjInletMat);
    inletL.position.set(-0.22, 0.04, -0.44);
    const inletR = new THREE.Mesh(new THREE.CircleGeometry(0.083, 8), bjInletMat);
    inletR.position.set( 0.22, 0.04, -0.44);

    const glowMat = new THREE.MeshBasicMaterial({
        color: 0xff9900, transparent: true, opacity: 0.50,
        blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const glowGeo = new THREE.ConeGeometry(0.07, 0.38, 8);
    const glowL = new THREE.Mesh(glowGeo, glowMat);
    glowL.rotation.x = -Math.PI / 2;
    glowL.position.set(-0.22, 0.04, -1.2);
    const glowR = new THREE.Mesh(glowGeo, glowMat.clone());
    glowR.rotation.x = -Math.PI / 2;
    glowR.position.set( 0.22, 0.04, -1.2);

    stabV.userData.isTailPart = true;
    const bodyParts = [fuselage, nose, wingL, wingR, wlL, wlR, stabHL, stabHR];
    bodyParts.forEach(m => { m.userData.isBodyPart = true; });
    group.userData._bodyParts = bodyParts;

    const [stripeL, stripeR] = _windowStripes(0.11, 2.4);
    group.add(fuselage, nose, cockpit, wingL, wingR, wlL, wlR, stabV, stabHL, stabHR, engL, engR, glowL, glowR, inletL, inletR, stripeL, stripeR, nwL, nwR);
    _navLights(group, 2.05, -1.6, 1.05);  // nav at wingtips, strobe at T-tail apex
    _addBellyStrobe(group, -0.11, 0.3);
    return group;
}

// --- AIRCRAFT CLASS REGISTRY (mirrors SHIP_CLASSES) ──────────────────────────
// Exported so aircraftInstancer.js can harvest each class's parts (geometry +
// material + local transform) ONCE at startup, instead of every individual
// aircraft calling cls.builder() and allocating its own fresh meshes/materials.
export const AIRCRAFT_CLASSES_VISUAL = {
    // Generic fallback — catches anything the typeCode lookup misses.
    // Kept identical to the old single-class setup so unclassified aircraft
    // look exactly as they always did.
    COMMERCIAL: { hex: '#e0f0ff', scale: 0.13, builder: buildAirliner },

    // Type-code-driven subclasses — picked by typeCodeToVisualClass() in
    // flightManager.js before the emitter-category fallback runs.
    NARROWBODY: { hex: '#d8e8f4', scale: 0.13, builder: buildNarrowbody },  // A320/B737 — cool aluminium
    WIDEBODY:   { hex: '#e4ddd4', scale: 0.18, builder: buildWidebody },    // B777/A330 — warm white, clearly bigger
    REGIONAL:   { hex: '#c4d8ee', scale: 0.10, builder: buildRegional },    // E175/CRJ9 — cooler blue, smaller
    BIZJET:     { hex: '#d4d4e8', scale: 0.10, builder: buildBizjet },      // Citation/Gulfstream — silver-grey

    CARGO:      { hex: '#9aa0a8', scale: 0.15, builder: buildCargoFreighter },
    MILITARY:   { hex: '#8aff80', scale: 0.10, builder: buildMilitaryJet },
    HELICOPTER: { hex: '#40c4ff', scale: 0.11, builder: buildHelicopter },
    GA:         { hex: '#d9b3ff', scale: 0.08, builder: buildGA },
};

// ── createFlightObject ─────────────────────────────────────────────────────────
// Builds a Three.js Group for a real airplanes.live aircraft. Picks a visual
// model from aircraftData.aircraftClass (set in flightManager.js from ADS-B
// category/dbFlags/callsign) — falls back to the commercial airliner shape
// for anything unclassified, matching the old single-model behavior.
export function createFlightObject(aircraftData, scene, laneGroup) {
    const cls = AIRCRAFT_CLASSES_VISUAL[aircraftData.aircraftClass] || AIRCRAFT_CLASSES_VISUAL.COMMERCIAL;

    // `group` is now a lightweight anchor only — NOT the visual airframe.
    // The actual airplane shape (fuselage/wings/engines/etc.) is drawn by
    // aircraftInstancer.js via one shared InstancedMesh per part per class,
    // keyed off this anchor's position/rotation every frame. Building a full
    // multi-mesh Group per aircraft (as the old cls.builder() call did here)
    // meant ~10-16 draw calls and ~3-4 brand-new Material allocations PER
    // AIRCRAFT — with ~300 live aircraft that was the single biggest cost in
    // the whole render loop. The anchor still does real work: it's what
    // selection/hover/tooltip/cluster-visibility/watchlist code in
    // uiController.js and clusterManager.js operates on (all of that is
    // already position- and userData-driven, not geometry-driven — see
    // uiController.js tickRaycasting Stage 1 — so removing the body meshes
    // doesn't break any of it). main.js spawns this aircraft's instancer slot
    // separately (aircraftInstancer.spawn(aircraftClass)) and stores the
    // handle on group.userData.instanceHandle.
    const group = new THREE.Group();

    // Contrail — white, semi-transparent
    const trailMat  = new THREE.LineBasicMaterial({ color: 0xd0e8ff, transparent: true, opacity: 0.40 });
    const trailLine = new THREE.Line(new THREE.BufferGeometry(), trailMat);
    scene.add(trailLine);

    // Altitude glow — small additive halo centered on the aircraft,
    // colour-coded by altitude tier. Replaces the old directional heading
    // line: same altitude-colour cue, no streak across the map. Added
    // directly to laneGroup as a sibling, NOT a child of `group` — `group`
    // is scaled down by cls.scale (0.08-0.15) for the aircraft model, so a
    // child sprite would inherit that shrink and render at a fraction of
    // its intended size (this was tried and made the glow invisible).
    // Mirrors the vessel shadowSprite pattern (see _getVesselShadowTex
    // usage above): absolute world-space size, position synced manually
    // each frame in main.js / the animation loop, at the same y as the
    // aircraft itself so the glow's center sits on the plane, not above it.
    //
    // MLAT vs ADS-B: a multilaterated position (no direct ADS-B fix, just
    // timing triangulation from ground receivers) is materially less
    // precise. Rather than add new geometry per-aircraft (cost — see
    // CLAUDE.md perf rules), MLAT aircraft reuse this same sprite but
    // bigger and dimmer, reading as "fuzzy/uncertain" instead of a clean
    // point fix. ADS-B keeps the original tight, brighter halo.
    const isMlat = aircraftData.positionSource === 'MLAT';
    const altGlowMat = new THREE.SpriteMaterial({
        map: _getAltitudeGlowTexture(), color: 0x40c4ff, transparent: true,
        opacity: 0.05, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const altitudeGlow = new THREE.Sprite(altGlowMat);
    const glowScale = isMlat ? 1.2 : 1.1;
    altitudeGlow.scale.set(glowScale, glowScale, 1);
    altitudeGlow.renderOrder = 9;
    laneGroup.add(altitudeGlow);

    // Emergency ring — pulsing red halo, mirrors the AIS anomalyRing/
    // integrityRing pattern (entityBuilder.js createAISVesselObject).
    // Sibling of `group` for the same scale-inheritance reason as the
    // altitude glow above. Driven visible/invisible + pulsed from main.js
    // off flightIntegrityManager's EMERGENCY flag (squawk 7500/7600/7700
    // or ADS-B emergency field) — never set directly here.
    const emergencyRingGeo = new THREE.RingGeometry(1.6, 2.1, 40);
    const emergencyRingMat = new THREE.MeshBasicMaterial({
        color: 0xff1744, transparent: true, opacity: 0.0,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const emergencyRing = new THREE.Mesh(emergencyRingGeo, emergencyRingMat);
    emergencyRing.rotation.x = -Math.PI / 2;
    emergencyRing.renderOrder = 10;
    emergencyRing.visible = false;
    laneGroup.add(emergencyRing);

    group.userData = {
        id:          aircraftData.icao24,
        displayName: aircraftData.callsign,
        class:       aircraftData.aircraftClass || 'COMMERCIAL',
        htmlColor:   cls.hex,
        speedKts:    aircraftData.speedKts,
        headingDeg:  aircraftData.headingDeg,
        latDeg:      aircraftData.latDeg,
        lonDeg:      aircraftData.lonDeg,
        altMeters:   aircraftData.altMeters,
        country:     aircraftData.country,
        positionSource: aircraftData.positionSource || 'ADSB',
        registration: aircraftData.registration || null,
        typeCode:     aircraftData.typeCode || null,
        operator:     aircraftData.operator || null,
        destination: null,
        eta:         null,
        isRealAIS:    false,
        isRealFlight: true,
        trail:        trailLine,
        altitudeGlow: altitudeGlow,
        emergencyRing:    emergencyRing,
        emergencyRingMat: emergencyRingMat,
        history:      [],
        curve: null, progress: 0, speed: 0  // no-ops so existing loops don't crash
    };

    laneGroup.add(group);
    return group;
}

// Converts [lon, lat] to scene Vector3 (Mercator)
function lonLatToVec3(lon, lat, y = 0) {
    const x = (lon / 180.0) * (MAP_WIDTH / 2.0);
    const latRad = lat * (Math.PI / 180.0);
    const mercatorY = Math.log(Math.tan((Math.PI / 4.0) + (latRad / 2.0)));
    const z = -(mercatorY / Math.PI) * (MAP_HEIGHT / 2.0);
    return new THREE.Vector3(x, y, z);
}

// ── createAISVesselObject ─────────────────────────────────────────────────────
// Builds and returns a Three.js Group for a real AIS vessel.
// vesselData is the live object from AISManager.vessels.
// The caller (main.js) is responsible for setting vesselData.threeObject.
export function createAISVesselObject(vesselData, scene, laneGroup, predGroup) {
    const shipClass = SHIP_CLASSES.find(c => c.type === vesselData.class) || SHIP_CLASSES[0];

    // `shipGroup` is now a lightweight anchor only — NOT the visual hull.
    // The actual ship shape (hull/bridge/containers/etc.) is drawn by
    // shipInstancer.js via one shared InstancedMesh per part per class,
    // keyed off this anchor's position every frame. This eliminates ~3-9
    // fresh Mesh + Material allocations and draw calls per vessel (up to
    // ~500 live vessels × ~9 meshes ≈ 4500 draw calls before this change).
    // The waterline-lift normalisation that used to run here (shifting each
    // ship's children so the hull's lowest point sits on the waterline) is
    // now baked into shipInstancer.js's harvest step — it's deterministic
    // per class (same geometry every time), so computing it once per class
    // at init is identical to computing it once per vessel here.
    // uiController.js's Stage 1 raycasting is position-driven, not
    // geometry-driven (see tickRaycasting "Screen-space proximity"), so
    // removing the body meshes does not break selection/hover/tooltips —
    // confirmed by the same pattern already applied to real-flight aircraft.
    const shipGroup = new THREE.Group();

    // Trail line
    const trailMat  = new THREE.LineBasicMaterial({ color: parseInt(shipClass.hex.slice(1), 16), transparent: true, opacity: 0.38 });
    const trailLine = new THREE.Line(new THREE.BufferGeometry(), trailMat);
    scene.add(trailLine);

    // Prediction line — dashed orange, projects forward along heading.
    // Visibility is gated in main.js to the selected vessel (and, when the
    // watchlist dead-reckoning mode is on, watchlisted vessels) — see
    // _syncPredictionVisual(). Added to predGroup so the old class-filter-wide
    // toggle still works as a master kill switch.
    const predMat  = new THREE.LineDashedMaterial({
        color: 0xffa726, transparent: true, opacity: 0.85,
        dashSize: 0.35, gapSize: 0.2
    });
    const predLine = new THREE.Line(new THREE.BufferGeometry(), predMat);
    predLine.visible = false; // selection-gated now, not always-on
    if (predGroup) predGroup.add(predLine);
    else scene.add(predLine);

    // Projected-point marker — small ring sitting at the dead-reckoning
    // line's far end, same orange as the line. Added 2026-06-26.
    const predMarkerGeo = new THREE.RingGeometry(0.10, 0.17, 20);
    predMarkerGeo.rotateX(-Math.PI / 2);
    const predMarkerMat = new THREE.MeshBasicMaterial({
        color: 0xffa726, transparent: true, opacity: 0.90,
        depthWrite: false, side: THREE.DoubleSide,
    });
    const predMarker = new THREE.Mesh(predMarkerGeo, predMarkerMat);
    predMarker.visible = false;
    predMarker.renderOrder = 4;
    if (predGroup) predGroup.add(predMarker);
    else scene.add(predMarker);

    // userData matches the shape expected by main.js animation loop and uiController
    shipGroup.userData = {
        id:             vesselData.mmsi,
        displayName:    vesselData.name,
        class:          vesselData.class,
        htmlColor:      shipClass.hex,
        speedKts:       vesselData.speedKts,
        isRealAIS:      true,   // ← flag tells animation loop to use lerp, not spline
        trail:          trailLine,
        predictionLine: predLine,
        predictionMarker: predMarker,
        isDark:         false,  // set true by onVesselDark callback in main.js
        darkSinceMs:    null,   // epoch ms when declared dark
        darkRing:       null,   // Three.js group created on dark event
        history:        [],
        // Plan 04 — position history for 24h timeline strip
        posLog:         [],     // [{ lat, lon, ts }] — up to 48 entries @ 30 min each
        posLogLastMs:   0,
        // Kept as no-ops so uiController raycasting never crashes on these fields
        curve:    null,
        progress: 0,
        speed:    0
    };

    // ── Ground shadow sprite ──────────────────────────────────────────────────
    // Sits as a sibling (not child) of the vessel group so it can be placed at
    // a fixed world-space y without inheriting the group's scale (0.08).
    // Position is synced each frame in main.js via userData.shadowSprite.
    const shadowMat = new THREE.SpriteMaterial({
        map:         _getVesselShadowTex(),
        transparent: true,
        opacity:     0.65,
        depthWrite:  false,
        depthTest:   true,   // occluded by terrain — vanishes under mountains
    });
    const shadowSprite = new THREE.Sprite(shadowMat);
    shadowSprite.scale.set(5, 5, 1);   // ~5 scene-unit diameter at sea level
    shadowSprite.renderOrder = -1;     // renders before vessel, vessel overdraw it
    shadowSprite.userData.isShadow = true;
    laneGroup.add(shadowSprite);
    shipGroup.userData.shadowSprite = shadowSprite;

    // ── Anomaly ring ──────────────────────────────────────────────────────────
    // Steady inner ring — level 1 pulses slow amber, level 2 contracts on the
    // sonar-ping beat, level 3/dark blinks with the dark marker.
    const anomalyRingGeo = new THREE.RingGeometry(0.9, 1.1, 32);
    const anomalyRingMat = new THREE.MeshBasicMaterial({
        color: 0xffcc00, transparent: true, opacity: 0.0,
        side: THREE.DoubleSide, depthWrite: false,
    });
    const anomalyRing = new THREE.Mesh(anomalyRingGeo, anomalyRingMat);
    anomalyRing.rotation.x = -Math.PI / 2;
    anomalyRing.renderOrder = 2;
    anomalyRing.visible = false;
    laneGroup.add(anomalyRing);
    shipGroup.userData.anomalyRing    = anomalyRing;
    shipGroup.userData.anomalyRingMat = anomalyRingMat;

    // ── Sonar-ping ring (Plan 03 — ACTIVE ANOMALY state) ─────────────────────
    // Outer ring: expands from scale 1→2.4 and fades on a 1.2 s cycle.
    // Only visible when anomaly level ≥ 2. Additive blending = glows into bloom.
    const pingRingGeo = new THREE.RingGeometry(2.0, 2.8, 48);
    const pingRingMat = new THREE.MeshBasicMaterial({
        color: 0xff2244, transparent: true, opacity: 0.0,
        side: THREE.DoubleSide, depthWrite: false,
        blending: THREE.AdditiveBlending,
    });
    const pingRing = new THREE.Mesh(pingRingGeo, pingRingMat);
    pingRing.rotation.x = -Math.PI / 2;
    pingRing.renderOrder = 3;
    pingRing.visible = false;
    laneGroup.add(pingRing);
    shipGroup.userData.pingRing    = pingRing;
    shipGroup.userData.pingRingMat = pingRingMat;

    // ── Integrity ring (counter-spoofing) ────────────────────────────────────
    // Pulsing electric-violet halo shown ONLY for SUSPECT vessels. Violet is
    // reserved for integrity — distinct from the red dark-vessel marker, the red
    // CARGO hull, and the amber anomaly ring — so it reads unambiguously as
    // "this AIS broadcast can't be trusted". Driven from main.js by the tier.
    const integRingGeo = new THREE.RingGeometry(1.8, 2.2, 48);
    const integRingMat = new THREE.MeshBasicMaterial({
        color: 0xd500f9, transparent: true, opacity: 0.0,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const integRing = new THREE.Mesh(integRingGeo, integRingMat);
    integRing.rotation.x = -Math.PI / 2;
    integRing.renderOrder = 4;
    integRing.visible = false;
    laneGroup.add(integRing);
    shipGroup.userData.integrityRing    = integRing;
    shipGroup.userData.integrityRingMat = integRingMat;

    laneGroup.add(shipGroup);
    return shipGroup;
}

// (Removed: createShipOnSpline / createSubmarineTrenches / createAerospaceRoutes —
//  simulated military submarine & aircraft spawners. Dead code from the old
//  fabricated-military taxonomy; no callers. Live entities come only from real
//  AIS and flight feeds.)

// --- ORBITAL ASSET BUILDERS ---

function _buildKennenSatellite() {
    const group = new THREE.Group();
    const bodyGeo = new THREE.CylinderGeometry(0.8, 0.8, 4, 16);
    bodyGeo.rotateX(Math.PI / 2);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.9, roughness: 0.2 });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    const panelGeo = new THREE.PlaneGeometry(8, 2.5);
    const panelMat = new THREE.MeshBasicMaterial({ color: 0x40c4ff, side: THREE.DoubleSide, wireframe: true, transparent: true, opacity: 0.8 });
    const panel1 = new THREE.Mesh(panelGeo, panelMat);
    panel1.position.set(4.5, 0, 0);
    const panel2 = new THREE.Mesh(panelGeo, panelMat);
    panel2.position.set(-4.5, 0, 0);
    const armGeo = new THREE.CylinderGeometry(0.15, 0.15, 10, 8);
    armGeo.rotateZ(Math.PI / 2);
    const arm = new THREE.Mesh(armGeo, bodyMat);
    group.add(body, panel1, panel2, arm);
    return { group, color: 0xffffff, prefix: "KH-11 KENNEN" };
}

function _buildLacrosseSatellite() {
    const group = new THREE.Group();
    const bodyGeo = new THREE.CylinderGeometry(0.5, 0.9, 3.5, 12);
    bodyGeo.rotateX(Math.PI / 2);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x607d8b, metalness: 0.7, roughness: 0.4 });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    const dishGeo = new THREE.SphereGeometry(1.2, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2.5);
    const dishMat = new THREE.MeshBasicMaterial({ color: 0xff5e00, side: THREE.DoubleSide, wireframe: true, transparent: true, opacity: 0.7 });
    const dish = new THREE.Mesh(dishGeo, dishMat);
    dish.position.z = 1.8;
    dish.rotation.x = -Math.PI / 2;
    group.add(body, dish);
    return { group, color: 0xff5e00, prefix: "LACROSSE" };
}

function _buildStarshieldSatellite() {
    const group = new THREE.Group();
    const bodyGeo = new THREE.BoxGeometry(1.5, 0.3, 1.5);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x424242, metalness: 0.6, roughness: 0.5 });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    const antennaGeo = new THREE.CylinderGeometry(0.05, 0.05, 1.2, 6);
    const antennaMat = new THREE.MeshBasicMaterial({ color: 0xccff90 });
    const antenna = new THREE.Mesh(antennaGeo, antennaMat);
    antenna.position.y = 0.6;
    const panelGeo = new THREE.PlaneGeometry(3.5, 1.0);
    const panelMat = new THREE.MeshBasicMaterial({ color: 0xccff90, side: THREE.DoubleSide, wireframe: true, transparent: true, opacity: 0.6 });
    const panel1 = new THREE.Mesh(panelGeo, panelMat);
    panel1.position.set(2.5, 0, 0);
    const panel2 = new THREE.Mesh(panelGeo, panelMat);
    panel2.position.set(-2.5, 0, 0);
    group.add(body, antenna, panel1, panel2);
    return { group, color: 0xccff90, prefix: "STARSHIELD" };
}

function _buildOrbitCurve(peakY, inclinationRad, phaseOffsetRad = 0) {
    const points = [];
    const segments = 64;
    const radiusX = MAP_WIDTH * 0.95;
    const radiusZ = MAP_HEIGHT * 0.95;

    for (let i = 0; i <= segments; i++) {
        const t = (i / segments) * Math.PI * 2 + phaseOffsetRad;
        let x = Math.cos(t) * radiusX;
        let z = Math.sin(t) * radiusZ;
        let y = Math.sin(t) * peakY * 0.5 + peakY * 0.5;
        const cosI = Math.cos(inclinationRad);
        const sinI = Math.sin(inclinationRad);
        const xRot = x * cosI - y * sinI;
        const yRot = x * sinI + y * cosI;
        const finalY = Math.max(yRot, 70);  // raised from 25 — prevents orbit lines clipping through continents at poles
        points.push(new THREE.Vector3(xRot, finalY, z));
    }

    return new THREE.CatmullRomCurve3(points, true);
}

export function createOrbitalAssets(scene, laneGroup, aisShips) {
    const planes = [
        { inclination: 0,            peakY: 110, builder: _buildKennenSatellite },
        { inclination: Math.PI / 4,  peakY: 95,  builder: _buildLacrosseSatellite },
        { inclination: -Math.PI / 6, peakY: 85,  builder: _buildStarshieldSatellite }
    ];

    planes.forEach((plane, planeIdx) => {
        const orbitCurve = _buildOrbitCurve(plane.peakY, plane.inclination);
        const orbitGeo = new THREE.BufferGeometry().setFromPoints(orbitCurve.getPoints(200));
        const sample = plane.builder();
        const orbitMat = new THREE.LineDashedMaterial({ color: sample.color, dashSize: 3, gapSize: 4, opacity: 0.2, transparent: true });
        const orbitLine = new THREE.Line(orbitGeo, orbitMat);
        orbitLine.computeLineDistances();
        orbitLine.visible = false;  // hidden — full-map-radius rings overlay continents at all altitudes
        laneGroup.add(orbitLine);

        for (let i = 0; i < 2; i++) {
            const built = plane.builder();
            const satGroup = built.group;

            satGroup.children.forEach(child => {
                child.userData.baseMaterial = child.material;
            });

            const trailMat = new THREE.LineBasicMaterial({ color: built.color, transparent: true, opacity: 0.5 });
            const trailLine = new THREE.Line(new THREE.BufferGeometry(), trailMat);
            scene.add(trailLine);

            let baseSpeed = 0.0012;
            if (built.prefix === "STARSHIELD") baseSpeed = 0.0020;
            if (built.prefix === "LACROSSE")   baseSpeed = 0.0014;

            satGroup.userData = {
                id: `${built.prefix}-${Math.floor(prng() * 9000 + 1000)}`,
                class: "ORBITAL",
                htmlColor: "#" + built.color.toString(16).padStart(6, "0"),
                speedKts: 17500,
                isRealAIS: false,
                progress: i * 0.5 + planeIdx * 0.15,
                speed: baseSpeed,
                curve: orbitCurve,
                history: [],
                trail: trailLine
            };

            satGroup.scale.set(2.0, 2.0, 2.0);
            laneGroup.add(satGroup);
            aisShips.push(satGroup);
        }
    });
}

// ── Port Markers ──────────────────────────────────────────────────────────────
const MAJOR_PORTS = [
    { name: 'ROTTERDAM',     lat: 51.92,  lon:  4.48  },
    { name: 'ANTWERP',       lat: 51.26,  lon:  4.40  },
    { name: 'HAMBURG',       lat: 53.55,  lon:  9.97  },
    { name: 'FELIXSTOWE',    lat: 51.96,  lon:  1.35  },
    { name: 'PIRAEUS',       lat: 37.95,  lon: 23.63  },
    { name: 'ISTANBUL',      lat: 41.02,  lon: 28.97  },
    { name: 'BARCELONA',     lat: 41.35,  lon:  2.15  },
    { name: 'ALGECIRAS',     lat: 36.13,  lon: -5.45  },
    { name: 'VALENCIA',      lat: 39.44,  lon: -0.32  },
    { name: 'MARSEILLE',     lat: 43.30,  lon:  5.37  },
    { name: 'GENOA',         lat: 44.41,  lon:  8.92  },
    { name: 'PORT SAID',     lat: 31.26,  lon: 32.30  },
    { name: 'JEDDAH',        lat: 21.49,  lon: 39.18  },
    { name: 'DUBAI',         lat: 25.07,  lon: 55.13  },
    { name: 'SINGAPORE',     lat:  1.26,  lon: 103.82 },
    { name: 'PORT KLANG',    lat:  3.00,  lon: 101.39 },
    { name: 'SHANGHAI',      lat: 31.23,  lon: 121.47 },
    { name: 'HONG KONG',     lat: 22.29,  lon: 114.16 },
    { name: 'TIANJIN',       lat: 39.02,  lon: 117.73 },
    { name: 'QINGDAO',       lat: 36.07,  lon: 120.37 },
    { name: 'BUSAN',         lat: 35.10,  lon: 129.04 },
    { name: 'TOKYO',         lat: 35.65,  lon: 139.77 },
    { name: 'KAOHSIUNG',     lat: 22.62,  lon: 120.27 },
    { name: 'JAKARTA',       lat: -6.10,  lon: 106.83 },
    { name: 'HO CHI MINH',   lat: 10.78,  lon: 106.70 },
    { name: 'MUMBAI',        lat: 18.93,  lon: 72.84  },
    { name: 'COLOMBO',       lat:  6.95,  lon: 79.85  },
    { name: 'SYDNEY',        lat:-33.85,  lon: 151.21 },
    { name: 'MELBOURNE',     lat:-37.82,  lon: 144.90 },
    { name: 'LOS ANGELES',   lat: 33.73,  lon:-118.27 },
    { name: 'SEATTLE',       lat: 47.60,  lon:-122.33 },
    { name: 'VANCOUVER',     lat: 49.29,  lon:-123.12 },
    { name: 'NEW YORK',      lat: 40.64,  lon: -74.04 },
    { name: 'HOUSTON',       lat: 29.73,  lon: -95.00 },
    { name: 'NEW ORLEANS',   lat: 29.95,  lon: -90.07 },
    { name: 'SANTOS',        lat:-23.95,  lon: -46.33 },
    { name: 'BUENOS AIRES',  lat:-34.62,  lon: -58.37 },
    { name: 'DURBAN',        lat:-29.87,  lon: 31.04  },
    { name: 'CAPE TOWN',     lat:-33.92,  lon: 18.42  },
    { name: 'LAGOS',         lat:  6.43,  lon:  3.41  },
    { name: 'SUEZ',          lat: 29.97,  lon: 32.55  },
];

// Manual rounded-rect helper — avoids ctx.roundRect() browser-compat concerns
function _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function _makePortLabelSprite(name) {
    const canvas = document.createElement('canvas');
    canvas.width  = 256;
    canvas.height = 48;
    const ctx     = canvas.getContext('2d');

    // Measure text first so the pill is always a snug fit
    ctx.font = 'bold 14px Courier New';
    const tw  = ctx.measureText(name).width;
    const pad = 9;
    const bx  = Math.max(0, 128 - tw / 2 - pad);
    const bw  = Math.min(256, tw + pad * 2);

    // Dark pill background with a dim cyan border
    _roundRect(ctx, bx, 7, bw, 34, 5);
    ctx.fillStyle   = 'rgba(1, 10, 20, 0.80)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(64, 196, 255, 0.50)';
    ctx.lineWidth   = 1;
    ctx.stroke();

    // Glow pass — soft cyan halo behind the text
    ctx.shadowColor  = '#40c4ff';
    ctx.shadowBlur   = 7;
    ctx.fillStyle    = 'rgba(64, 196, 255, 0.95)';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, 128, 25);

    // Crisp pass on top — sharpens the glow centre
    ctx.shadowBlur = 0;
    ctx.fillText(name, 128, 25);

    const texture = new THREE.CanvasTexture(canvas);
    const mat     = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite  = new THREE.Sprite(mat);
    sprite.scale.set(10, 2, 1);
    sprite.renderOrder = 998;
    return sprite;
}

// ── createDarkVesselMarker ─────────────────────────────────────────────────────
// Creates a pulsing "last known position" marker for a vessel that has gone
// silent. Added to the darkGroup in main.js so it animates independently of
// the vessel object.
export function createDarkVesselMarker(position, parentGroup) {
    const group = new THREE.Group();
    const BEAM_H = 6.0;   // beam height in scene units

    // ── Vertical signal beam (the "laser") — anchored at the waterline ───────
    // A slim cylinder rising from y=0; a height-fading shader keeps the base
    // bright and the tip dissolving into air, so it reads as an emission
    // column rather than a solid bar. Grounded — base sits exactly on water.
    const beamGeo = new THREE.CylinderGeometry(0.07, 0.14, BEAM_H, 12, 1, true);
    beamGeo.translate(0, BEAM_H / 2, 0);   // base at y=0
    const beamMat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: { uOpacity: { value: 0.95 }, uColor: { value: new THREE.Color(0xff1744) } },
        vertexShader: `
            varying float vH;
            void main() {
                vH = position.y / ${BEAM_H.toFixed(1)};
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
        fragmentShader: `
            uniform float uOpacity; uniform vec3 uColor; varying float vH;
            void main() {
                float fade = pow(1.0 - vH, 1.6);       // bright base → faint tip
                gl_FragColor = vec4(uColor, fade * uOpacity);
            }`,
    });
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.renderOrder = 6;
    group.add(beam);

    // ── Footprint ring — flat on the water, grounds the beam to a location ───
    const segs = 48, ringPts = [];
    for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        ringPts.push(new THREE.Vector3(Math.cos(a) * 1.0, 0.02, Math.sin(a) * 1.0));
    }
    const ringMat = new THREE.LineBasicMaterial({
        color: 0xff1744, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPts), ringMat);
    ring.renderOrder = 5;
    group.add(ring);

    // ── Rising motes — sparse points drifting up the beam (animated in main) ─
    const MOTES = 9;
    const moteArr = new Float32Array(MOTES * 3);
    const motePhase = new Float32Array(MOTES);
    for (let i = 0; i < MOTES; i++) {
        motePhase[i] = i / MOTES;
        moteArr[i * 3] = 0; moteArr[i * 3 + 1] = motePhase[i] * BEAM_H; moteArr[i * 3 + 2] = 0;
    }
    const moteGeo = new THREE.BufferGeometry();
    moteGeo.setAttribute('position', new THREE.BufferAttribute(moteArr, 3));
    const moteMat = new THREE.PointsMaterial({
        color: 0xff5a78, size: 0.5, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    const motes = new THREE.Points(moteGeo, moteMat);
    motes.renderOrder = 7;
    group.add(motes);

    // userData — keep the keys the animation loop expects. The beam shader's
    // uOpacity stands in for the old _darkOuterMat.opacity (a setter shim);
    // unused ring slots are null and guarded with && in main.js.
    group.userData._darkOuterMat = { set opacity(v) { beamMat.uniforms.uOpacity.value = v; },
                                     get opacity()  { return beamMat.uniforms.uOpacity.value; } };
    group.userData._darkInnerMat = ringMat;
    group.userData._darkMidMat   = null;
    group.userData._darkCrossMat = null;
    group.userData._isDarkMarker = true;
    group.userData._darkMotes    = { geo: moteGeo, phase: motePhase, h: BEAM_H };

    group.userData._darkBleedMat  = null;
    group.userData._darkBleedRing = null;
    group.userData._bleedStartMs  = 0;

    // Ground the whole marker at the waterline (ignore any vessel deck height).
    group.position.set(position.x, 0, position.z);
    parentGroup.add(group);
    return group;
}

// ── createVesselDot ────────────────────────────────────────────────────────────
// Tiny green dot beneath a non-dark vessel — minimal, clean, just enough
// to confirm a tracked vessel is present at close zoom.
export function createVesselDot(position, parentGroup) {
    const geo = new THREE.CircleGeometry(0.22, 16);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
        color:       0x00ff88,
        transparent: true,
        opacity:     0.80,
        depthWrite:  false,
        blending:    THREE.AdditiveBlending,
        side:        THREE.DoubleSide,
    });
    const dot        = new THREE.Mesh(geo, mat);
    // Sit the dot AT the ship's waterline (its group origin Y). The hull
    // rises above this point, so the dot reads as a halo UNDER the ship
    // when viewed from oblique angles instead of over its deck.
    // Tiny 0.02 lift avoids z-fighting with the water plane.
    dot.position.set(position.x, (position.y ?? 0) + 0.02, position.z);
    dot.renderOrder  = 4;
    dot.userData._vesselDotMat = mat;
    dot.userData._isVesselDot  = true;
    parentGroup.add(dot);
    return dot;
}

export function createPortMarkers(scene) {
    const group      = new THREE.Group();
    group.name       = 'portMarkers';

    const diamondGeo = new THREE.OctahedronGeometry(0.55, 0);
    const diamondMat = new THREE.MeshStandardMaterial({
        color:             0x40c4ff,
        emissive:          0x40c4ff,
        emissiveIntensity: 1.4,  // was 0.6 — drives a strong self-lit neon glow
        transparent:       true,
        opacity:           0.92,
    });
    const ringGeo = new THREE.RingGeometry(1.0, 1.25, 16);
    const ringMat = new THREE.MeshBasicMaterial({
        color:       0x40c4ff,
        transparent: true,
        opacity:     0.55,       // was 0.35 — ring pops more against terrain
        side:        THREE.DoubleSide,
    });

    // All diamonds + rings collapsed into 2 draw calls via InstancedMesh.
    // Labels stay as individual sprites — they carry unique text so can't
    // be instanced, but they're lightweight SpriteMaterials.
    const numPorts         = MAJOR_PORTS.length;
    const instancedDiamond = new THREE.InstancedMesh(diamondGeo, diamondMat, numPorts);
    const instancedRing    = new THREE.InstancedMesh(ringGeo,    ringMat,    numPorts);
    const dummy = new THREE.Object3D();

    MAJOR_PORTS.forEach((port, i) => {
        const pos = lonLatToVec3(port.lon, port.lat, 0.4);

        // Diamond pip matrix
        dummy.position.copy(pos);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        instancedDiamond.setMatrixAt(i, dummy.matrix);

        // Flat ring on sea surface
        dummy.position.set(pos.x, 0.1, pos.z);
        dummy.rotation.set(-Math.PI / 2, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        instancedRing.setMatrixAt(i, dummy.matrix);

        // Canvas label sprite above the pip — unique text, stays per-instance
        const label = _makePortLabelSprite(port.name);
        label.position.set(pos.x, pos.y + 3.2, pos.z);
        group.add(label);
    });

    instancedDiamond.instanceMatrix.needsUpdate = true;
    instancedRing.instanceMatrix.needsUpdate    = true;

    group.add(instancedDiamond, instancedRing);
    scene.add(group);
    return group;
}
