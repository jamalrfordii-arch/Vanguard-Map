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

// --- SHARED MATERIALS ---
const realMaterials = {
    hullCargo:    new THREE.MeshStandardMaterial({ color: 0xa02020, roughness: 0.7 }),
    white:        new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.5 }),
    grey:         new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.7 }),
    navyGrey:     new THREE.MeshStandardMaterial({ color: 0x607d8b, roughness: 0.6, metalness: 0.3 }),
    subBlack:     new THREE.MeshStandardMaterial({ color: 0x212121, roughness: 0.8, metalness: 0.2 }),
    hostileGreen: new THREE.MeshStandardMaterial({ color: 0x4caf50, roughness: 0.8, metalness: 0.2 }),
    hostileDark:  new THREE.MeshStandardMaterial({ color: 0x2e7d32, roughness: 0.8 }),
    aeroGrey:     new THREE.MeshStandardMaterial({ color: 0xb0bec5, roughness: 0.4, metalness: 0.6 }),
    aeroDark:     new THREE.MeshStandardMaterial({ color: 0x455a64, roughness: 0.6, metalness: 0.4 })
};

// --- SHAPE BUILDERS ---
const shapeBuilders = {
    CARGO: () => {
        const group = new THREE.Group();
        const hull   = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.8, 3.5), realMaterials.hullCargo);
        const bridge = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.0, 0.6), realMaterials.white);
        bridge.position.set(0, 0.9, -1.2);
        const stack1 = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.6, 0.8), realMaterials.grey);
        stack1.position.set(0, 0.7, 0.0);
        const stack2 = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.6, 0.8), realMaterials.grey);
        stack2.position.set(0, 0.7, 1.0);
        group.add(hull, bridge, stack1, stack2);
        return group;
    },
    SUBMARINE: () => {
        const group = new THREE.Group();
        const hull  = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 4.0, 12), realMaterials.subBlack);
        hull.rotation.x = Math.PI / 2;
        const sail  = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.8, 0.8), realMaterials.subBlack);
        sail.position.set(0, 0.4, 0.5);
        const tailH = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.05, 0.4), realMaterials.subBlack);
        tailH.position.set(0, 0, -1.8);
        const tailV = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.2, 0.4), realMaterials.subBlack);
        tailV.position.set(0, 0, -1.8);
        group.add(hull, sail, tailH, tailV);
        return group;
    },
    PATROL: () => {
        const group  = new THREE.Group();
        const hull   = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.6, 3.0), realMaterials.navyGrey);
        const bow    = new THREE.Mesh(new THREE.CylinderGeometry(0, 0.4, 1.0, 4), realMaterials.navyGrey);
        bow.rotation.x = -Math.PI / 2;
        bow.rotation.y = Math.PI / 4;
        bow.position.set(0, 0, 2.0);
        const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 1.2), realMaterials.navyGrey);
        bridge.position.set(0, 0.65, -0.2);
        const mast   = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.2, 4), realMaterials.grey);
        mast.position.set(0, 1.4, -0.4);
        group.add(hull, bow, bridge, mast);
        return group;
    },
    HOSTILE: () => {
        const group    = new THREE.Group();
        const hullL    = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.5, 2.5), realMaterials.hostileGreen);
        hullL.position.set(-0.45, 0, 0);
        const hullR    = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.5, 2.5), realMaterials.hostileGreen);
        hullR.position.set(0.45, 0, 0);
        const deck     = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.2, 1.5), realMaterials.hostileGreen);
        deck.position.set(0, 0.35, -0.3);
        const launcher = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.4, 0.8), realMaterials.hostileDark);
        launcher.position.set(0, 0.6, 0.0);
        const radome   = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 8), realMaterials.white);
        radome.position.set(0, 0.6, -0.8);
        const ringGeo  = new THREE.RingGeometry(6.0, 6.2, 32);
        const ringMat  = new THREE.MeshBasicMaterial({ color: 0xff1744, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
        const ring     = new THREE.Mesh(ringGeo, ringMat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = -0.3;
        group.add(hullL, hullR, deck, launcher, radome, ring);
        return group;
    },
    FIGHTER: () => {
        const group    = new THREE.Group();
        const mat      = realMaterials.aeroGrey;
        const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.2, 2.0, 8), mat);
        fuselage.rotation.x = Math.PI / 2;
        const nose     = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.8, 8), mat);
        nose.rotation.x = Math.PI / 2;
        nose.position.set(0, 0, 1.4);
        const wingL    = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.05, 0.5), mat);
        wingL.position.set(-0.6, 0, -0.2);
        wingL.rotation.y = -Math.PI / 6;
        const wingR    = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.05, 0.5), mat);
        wingR.position.set(0.6, 0, -0.2);
        wingR.rotation.y = Math.PI / 6;
        const fin      = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.5, 0.5), mat);
        fin.position.set(0, 0.25, -0.8);
        const exhaustGeo = new THREE.ConeGeometry(0.12, 0.6, 8);
        exhaustGeo.translate(0, -0.3, 0);
        exhaustGeo.rotateX(Math.PI / 2);
        const exhaustMat = new THREE.MeshBasicMaterial({ color: 0xffb300, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending });
        const exhaust  = new THREE.Mesh(exhaustGeo, exhaustMat);
        exhaust.position.set(0, 0, -1.0);
        const strobe   = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 8), new THREE.MeshBasicMaterial({ color: 0xff1744 }));
        strobe.position.set(0, 0.35, -0.5);
        strobe.name = "strobe_light";
        group.add(fuselage, nose, wingL, wingR, fin, exhaust, strobe);
        return group;
    },
    AWACS: () => {
        const group      = new THREE.Group();
        const mat        = realMaterials.white;
        const fuselage   = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 4.0, 12), mat);
        fuselage.rotation.x = Math.PI / 2;
        const nose       = new THREE.Mesh(new THREE.SphereGeometry(0.25, 12, 12), mat);
        nose.position.set(0, 0, 2.0);
        const wings      = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.1, 0.8), mat);
        wings.position.set(0, 0, 0.2);
        const tailH      = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.1, 0.5), mat);
        tailH.position.set(0, 0, -1.8);
        const tailV      = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.8, 0.6), mat);
        tailV.position.set(0, 0.4, -1.8);
        const radomeStrut= new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.4), mat);
        radomeStrut.position.set(0, 0.3, -0.5);
        const radome     = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.1, 16), realMaterials.aeroDark);
        radome.position.set(0, 0.5, -0.5);
        radome.name = "awacs_radar";
        const strobe     = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 8), new THREE.MeshBasicMaterial({ color: 0xff1744 }));
        strobe.position.set(0, 0.6, 2.0);
        strobe.name = "strobe_light";
        group.add(fuselage, nose, wings, tailH, tailV, radomeStrut, radome, strobe);
        return group;
    },
    DRONE: () => {
        const group    = new THREE.Group();
        const mat      = realMaterials.aeroGrey;
        const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.1, 2.5, 8), mat);
        fuselage.rotation.x = Math.PI / 2;
        const nose     = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 8), mat);
        nose.position.set(0, 0.05, 1.25);
        const wings    = new THREE.Mesh(new THREE.BoxGeometry(5.0, 0.05, 0.3), mat);
        wings.position.set(0, 0, 0.2);
        const tailL    = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.05, 0.3), mat);
        tailL.position.set(-0.25, 0.2, -1.1);
        tailL.rotation.z = Math.PI / 4;
        const tailR    = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.05, 0.3), mat);
        tailR.position.set(0.25, 0.2, -1.1);
        tailR.rotation.z = -Math.PI / 4;
        const strobe   = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 8), new THREE.MeshBasicMaterial({ color: 0xff1744 }));
        strobe.position.set(0, 0.3, -1.0);
        strobe.name = "strobe_light";
        group.add(fuselage, nose, wings, tailL, tailR, strobe);
        return group;
    }
};

// --- CLASS REGISTRY ---
const SHIP_CLASSES = [
    { type: "CARGO",     hex: "#ff5252", builder: shapeBuilders.CARGO },
    { type: "PATROL",    hex: "#90caf9", builder: shapeBuilders.PATROL },
    { type: "SUBMARINE", hex: "#bdbdbd", builder: shapeBuilders.SUBMARINE },
    { type: "HOSTILE",   hex: "#ff6d00", builder: shapeBuilders.HOSTILE },
    { type: "FIGHTER",   hex: "#ffb300", builder: shapeBuilders.FIGHTER },
    { type: "AWACS",     hex: "#81d4fa", builder: shapeBuilders.AWACS },
    { type: "DRONE",     hex: "#ccff90", builder: shapeBuilders.DRONE }
];

const AERO_TYPES = ["FIGHTER", "AWACS", "DRONE"];

// ── AIRLINER shape (real flight data) ─────────────────────────────────────────
function buildAirliner() {
    const group   = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xdde8f0, roughness: 0.3, metalness: 0.55 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x334455, roughness: 0.5, metalness: 0.4 });
    const glassMat= new THREE.MeshStandardMaterial({ color: 0x99bbdd, roughness: 0.1, metalness: 0.8, transparent: true, opacity: 0.7 });

    // Fuselage — tapered tube
    const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.17, 4.8, 12), bodyMat);
    fuselage.rotation.x = Math.PI / 2;

    // Nose cone
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.9, 12), bodyMat);
    nose.rotation.x = Math.PI / 2;
    nose.position.z = 2.85;

    // Cockpit windows
    const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), glassMat);
    cockpit.position.set(0, 0.16, 2.3);

    // Main swept wings
    const wingL = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.06, 0.9), bodyMat);
    wingL.position.set(-1.6, -0.06, 0.3);
    wingL.rotation.y =  Math.PI / 9;

    const wingR = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.06, 0.9), bodyMat);
    wingR.position.set( 1.6, -0.06, 0.3);
    wingR.rotation.y = -Math.PI / 9;

    // Winglets
    const wlL = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.42, 0.28), bodyMat);
    wlL.position.set(-3.15, 0.18, 0.1);
    const wlR = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.42, 0.28), bodyMat);
    wlR.position.set( 3.15, 0.18, 0.1);

    // Horizontal stabiliser
    const stabH = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.05, 0.5), bodyMat);
    stabH.position.set(0, 0.05, -2.2);
    stabH.rotation.y = Math.PI / 14;

    // Vertical stabiliser
    const stabV = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.9, 0.7), bodyMat);
    stabV.position.set(0, 0.5, -2.1);

    // Engines under wings (x2)
    const engGeo = new THREE.CylinderGeometry(0.17, 0.14, 0.95, 10);
    const engL = new THREE.Mesh(engGeo, darkMat);
    engL.rotation.x = Math.PI / 2;
    engL.position.set(-1.25, -0.28, 0.35);

    const engR = new THREE.Mesh(engGeo, darkMat);
    engR.rotation.x = Math.PI / 2;
    engR.position.set( 1.25, -0.28, 0.35);

    // Engine exhaust glow (additive blending)
    const glowMat = new THREE.MeshBasicMaterial({
        color: 0xff9900, transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false
    });
    const glowGeo = new THREE.ConeGeometry(0.12, 0.55, 8);
    const glowL = new THREE.Mesh(glowGeo, glowMat);
    glowL.rotation.x = -Math.PI / 2;
    glowL.position.set(-1.25, -0.28, -0.2);

    const glowR = new THREE.Mesh(glowGeo, glowMat);
    glowR.rotation.x = -Math.PI / 2;
    glowR.position.set( 1.25, -0.28, -0.2);

    // Navigation lights (red port, green starboard) — blinking handled in tick
    const navL = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 6, 6),
        new THREE.MeshBasicMaterial({ color: 0xff2222 })
    );
    navL.position.set(-3.15, 0, 0.1);
    navL.name = 'nav_red';

    const navR = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 6, 6),
        new THREE.MeshBasicMaterial({ color: 0x22ff44 })
    );
    navR.position.set(3.15, 0, 0.1);
    navR.name = 'nav_green';

    // Tail strobe (white)
    const tailStrobe = new THREE.Mesh(
        new THREE.SphereGeometry(0.1, 6, 6),
        new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    tailStrobe.position.set(0, 0.95, -2.1);
    tailStrobe.name = 'strobe_tail';

    // Mark structural body parts so altitude-colour coding knows what to tint.
    // Nav lights, glow cones, and glass are intentionally excluded.
    const bodyParts = [fuselage, nose, wingL, wingR, wlL, wlR, stabH, stabV];
    bodyParts.forEach(m => { m.userData.isBodyPart = true; });

    group.add(
        fuselage, nose, cockpit,
        wingL, wingR, wlL, wlR,
        stabH, stabV,
        engL, engR, glowL, glowR,
        navL, navR, tailStrobe
    );

    // Cache hot-path references directly on the group so the animate loop
    // never needs getObjectByName() or traverse() — both walk the full subtree.
    group.userData._bodyParts  = bodyParts;
    group.userData._navRed     = navL;
    group.userData._navGreen   = navR;
    group.userData._tailStrobe = tailStrobe;

    return group;
}

// ── createFlightObject ─────────────────────────────────────────────────────────
// Builds a Three.js Group for a real OpenSky aircraft.
export function createFlightObject(aircraftData, scene, laneGroup) {
    const group = buildAirliner();
    group.scale.set(0.13, 0.13, 0.13);

    // Store base materials for hover reset
    group.children.forEach(child => {
        child.userData.baseMaterial = child.material;
    });

    // Contrail — white, semi-transparent
    const trailMat  = new THREE.LineBasicMaterial({ color: 0xd0e8ff, transparent: true, opacity: 0.40 });
    const trailLine = new THREE.Line(new THREE.BufferGeometry(), trailMat);
    scene.add(trailLine);

    // Heading vector line — cyan, additive blending so it burns over terrain
    const hdgLineMat = new THREE.LineBasicMaterial({
        color: 0x40c4ff, transparent: true, opacity: 0.90, depthWrite: false,
        blending: THREE.AdditiveBlending,
    });
    const hdgLineGeo = new THREE.BufferGeometry();
    hdgLineGeo.setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1)]);
    const headingLine = new THREE.Line(hdgLineGeo, hdgLineMat);
    headingLine.visible = false; // hidden by default — clutters map in clusters
    scene.add(headingLine);

    group.userData = {
        id:          aircraftData.icao24,
        displayName: aircraftData.callsign,
        class:       'AIRLINER',
        htmlColor:   '#e0f0ff',
        speedKts:    aircraftData.speedKts,
        headingDeg:  aircraftData.headingDeg,
        latDeg:      aircraftData.latDeg,
        lonDeg:      aircraftData.lonDeg,
        altMeters:   aircraftData.altMeters,
        country:     aircraftData.country,
        destination: null,
        eta:         null,
        isRealAIS:    false,
        isRealFlight: true,
        trail:        trailLine,
        headingLine:  headingLine,
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
    const shipGroup = shipClass.builder();

    // ── Normalise the hull to the waterline ─────────────────────────────────
    // Each shape builder places its hull at a slightly different Y offset, so
    // ships rendered side-by-side at the same scenePos.y don't actually share
    // a waterline. Compute the bounding box of the structural meshes only
    // (skipping flat surface markers like the HOSTILE alert ring) and shift
    // all children so the hull's lowest point lands at the group's origin.
    // A small "draft" submersion then seats the hull realistically in water
    // instead of perching it on top.
    const hullBox = new THREE.Box3();
    let measured = false;
    shipGroup.children.forEach(c => {
        if (c.geometry instanceof THREE.RingGeometry) return; // alert ring, etc.
        hullBox.expandByObject(c);
        measured = true;
    });
    if (measured && isFinite(hullBox.min.y)) {
        const hullHeight = Math.max(0.01, hullBox.max.y - hullBox.min.y);
        const draftFrac  = 0.25;            // ~25% of hull below waterline
        const lift       = -hullBox.min.y - hullHeight * draftFrac;
        shipGroup.children.forEach(child => { child.position.y += lift; });
    }

    shipGroup.scale.set(0.08, 0.08, 0.08);

    // Store base materials for hover-highlight reset
    shipGroup.children.forEach(child => {
        child.userData.baseMaterial = child.material;
    });

    // Trail line
    const trailMat  = new THREE.LineBasicMaterial({ color: parseInt(shipClass.hex.slice(1), 16), transparent: true, opacity: 0.38 });
    const trailLine = new THREE.Line(new THREE.BufferGeometry(), trailMat);
    scene.add(trailLine);

    // Prediction line — dashed orange, projects forward along heading
    // Added to predGroup so the layer toggle can hide/show all at once.
    const predMat  = new THREE.LineDashedMaterial({
        color: 0xffa726, transparent: true, opacity: 0.85,
        dashSize: 0.35, gapSize: 0.2
    });
    const predLine = new THREE.Line(new THREE.BufferGeometry(), predMat);
    if (predGroup) predGroup.add(predLine);
    else scene.add(predLine);

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

    laneGroup.add(shipGroup);
    return shipGroup;
}

// ── Simulated ship helper (used by submarine & aerospace spawners) ─────────────
export function createShipOnSpline(curve, forcedClass, scene, laneGroup, aisShips) {
    let shipClass;
    if (forcedClass) {
        shipClass = SHIP_CLASSES.find(c => c.type === forcedClass);
    } else {
        const surfaceClasses = SHIP_CLASSES.filter(c => !AERO_TYPES.includes(c.type) && c.type !== "SUBMARINE");
        const rand = prng();
        shipClass = surfaceClasses[0];
        if (rand > 0.6) shipClass = surfaceClasses[1];
        if (rand > 0.9) shipClass = surfaceClasses[2];
    }

    const shipGroup = shipClass.builder();
    const scaleVal = AERO_TYPES.includes(shipClass.type) ? 0.35 : 0.25;
    shipGroup.scale.set(scaleVal, scaleVal, scaleVal);

    shipGroup.children.forEach(child => {
        child.userData.baseMaterial = child.material;
    });

    let simSpeed = 0.00002 + (prng() * 0.00004);
    let kts = Math.floor(prng() * 25 + 10);

    if (shipClass.type === "FIGHTER") {
        simSpeed = (0.001 + (prng() * 0.0005)) * AIRCRAFT_TIME_SCALE;
        kts = Math.floor(prng() * 400 + 400);
    } else if (shipClass.type === "AWACS") {
        simSpeed = (0.0005 + (prng() * 0.0003)) * AIRCRAFT_TIME_SCALE;
        kts = Math.floor(prng() * 100 + 300);
    } else if (shipClass.type === "DRONE") {
        simSpeed = (0.0003 + (prng() * 0.0002)) * AIRCRAFT_TIME_SCALE;
        kts = Math.floor(prng() * 50 + 150);
    }

    const isAero = AERO_TYPES.includes(shipClass.type);
    shipGroup.userData = {
        id: (isAero ? "AF-" : "VSL-") + Math.floor(prng() * 9000 + 1000),
        class: shipClass.type,
        htmlColor: shipClass.hex,
        speedKts: kts,
        isRealAIS: false,
        curve,
        progress: prng(),
        speed: simSpeed,
        history: []
    };

    const trailMat = new THREE.LineBasicMaterial({
        color: isAero ? parseInt(shipClass.hex.slice(1), 16) : 0xffffff,
        transparent: true,
        opacity: isAero ? 0.38 : 0.28   // bumped up from 0.25 / 0.15
    });

    // Pre-allocate trail buffer at the maximum history length so Three.js r184's
    // setFromPoints never warns "Buffer size too small — use .dispose() and create
    // a new geometry."  maxHist in the animate loop is 40 (FIGHTER) or 20 (others);
    // 41 gives one element of headroom.  The draw range starts at 0 and grows as
    // history fills; the in-place update path in main.js writes directly into this
    // pre-sized Float32Array without allocating a new one each frame.
    const MAX_TRAIL_PTS = 41;
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position',
        new THREE.BufferAttribute(new Float32Array(MAX_TRAIL_PTS * 3), 3));
    trailGeo.setDrawRange(0, 0);
    const trailLine = new THREE.Line(trailGeo, trailMat);
    scene.add(trailLine);
    shipGroup.userData.trail = trailLine;

    laneGroup.add(shipGroup);
    aisShips.push(shipGroup);
}

export function createSubmarineTrenches(scene, laneGroup, aisShips) {
    const numSubs = 25;
    let attempts = 0, subsSpawned = 0;

    while (subsSpawned < numSubs && attempts < 2000) {
        attempts++;
        let startX = (prng() - 0.5) * MAP_WIDTH;
        let startZ = (prng() - 0.5) * MAP_HEIGHT;
        if (getTrueElevation(startX, startZ) > -2000) continue;

        let points = [];
        let curX = startX, curZ = startZ;
        let dirX = (prng() - 0.5) * 8;
        let dirZ = (prng() - 0.5) * 8;
        let validRoute = true;

        for (let p = 0; p < 6; p++) {
            if (getTrueElevation(curX, curZ) > -500) { validRoute = false; break; }
            let dist = Math.sqrt((curX / MAP_WIDTH) ** 2 + (curZ / MAP_HEIGHT) ** 2);
            let curveY = -Math.pow(dist, 2) * 20.0;
            points.push(new THREE.Vector3(curX, -2.0 + curveY, curZ));
            curX += dirX + (prng() - 0.5) * 3;
            curZ += dirZ + (prng() - 0.5) * 3;
        }

        if (validRoute && points.length >= 4) {
            const curve = new THREE.CatmullRomCurve3(points);
            const lineMaterial = new THREE.LineBasicMaterial({ color: 0x00ff88, transparent: true, opacity: 0.15 });
            laneGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(50)), lineMaterial));
            createShipOnSpline(curve, "SUBMARINE", scene, laneGroup, aisShips);
            subsSpawned++;
        }
    }
}

export function createAerospaceRoutes(scene, laneGroup, aisShips) {
    const flightTypes = ["FIGHTER", "AWACS", "DRONE"];
    const flightColors = { FIGHTER: 0xffb300, AWACS: 0x81d4fa, DRONE: 0xccff90 };

    for (let i = 0; i < 25; i++) {
        const type = flightTypes[Math.floor(prng() * flightTypes.length)];
        const startX = (prng() > 0.5 ? 1 : -1) * (MAP_WIDTH / 2) * prng();
        const startZ = (prng() > 0.5 ? 1 : -1) * (MAP_HEIGHT / 2);
        const endX   = (prng() > 0.5 ? 1 : -1) * (MAP_WIDTH / 2);
        const endZ   = (prng() > 0.5 ? 1 : -1) * (MAP_HEIGHT / 2) * prng();
        const apexHeight = type === "DRONE" ? 15 + prng() * 10 : type === "AWACS" ? 25 + prng() * 10 : 40 + prng() * 20;
        const midX = (startX + endX) / 2;
        const midZ = (startZ + endZ) / 2;

        const curve = new THREE.QuadraticBezierCurve3(
            new THREE.Vector3(startX, 0, startZ),
            new THREE.Vector3(midX, apexHeight, midZ),
            new THREE.Vector3(endX, 0, endZ)
        );

        const lineMaterial = new THREE.LineBasicMaterial({ color: flightColors[type], transparent: true, opacity: 0.15 });
        laneGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(50)), lineMaterial));
        createShipOnSpline(curve, type, scene, laneGroup, aisShips);
    }
}

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
