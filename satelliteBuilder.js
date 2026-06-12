// satelliteBuilder.js — 3D model builders for each satellite class
// Six visually distinct designs, kept small so they read well on the tactical map.
import * as THREE from 'three';

// ── Colour palette ────────────────────────────────────────────────────────────
export const SAT_COLORS = {
    STATION:  0x40ffaa,   // bright mint-green  — ISS
    STARLINK: 0x9988ff,   // soft violet        — Starlink
    GPS:      0xffcc00,   // gold               — GPS/GNSS
    GALILEO:  0xffcc00,   // gold               — Galileo (same look as GPS)
    WEATHER:  0x00ccff,   // sky-cyan           — weather satellites
    MILITARY: 0xff4444,   // threat-red         — military objects
    GENERIC:  0x999999,   // neutral grey       — everything else
};

export const SAT_HTML_COLORS = {
    STATION:  '#40ffaa',
    STARLINK: '#9988ff',
    GPS:      '#ffcc00',
    GALILEO:  '#ffcc00',
    WEATHER:  '#00ccff',
    MILITARY: '#ff4444',
    GENERIC:  '#999999',
};

// ── Shared materials (re-used across instances to save GPU memory) ─────────────
const _panelMat  = new THREE.MeshStandardMaterial({ color: 0x223488, roughness: 0.7, metalness: 0.2, transparent: true, opacity: 0.88 });
const _goldPanel = new THREE.MeshStandardMaterial({ color: 0xcc9900, roughness: 0.6, metalness: 0.5, transparent: true, opacity: 0.9  });
const _silverMat = new THREE.MeshStandardMaterial({ color: 0xd0d4d8, roughness: 0.4, metalness: 0.7 });
const _whiteMat  = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.5, metalness: 0.3 });
const _darkMat   = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.5, metalness: 0.6 });

function mark(mesh) { mesh.userData.isBodyPart = true; return mesh; }

// ── ISS — International Space Station ─────────────────────────────────────────
// Iconic cross layout: long Integrated Truss Structure + 4 solar array pairs + hab modules.
function buildISS() {
    const g = new THREE.Group();

    // Integrated Truss Structure — long horizontal spine
    const truss = mark(new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.10, 0.10), _silverMat));
    g.add(truss);

    // Solar Array Wings — 4 locations along the truss, panels on both Z sides
    const xPositions = [-1.35, -0.45, 0.45, 1.35];
    const panelGeo   = new THREE.BoxGeometry(0.65, 0.025, 0.95);
    xPositions.forEach(x => {
        [0.62, -0.62].forEach(z => {
            const panel = mark(new THREE.Mesh(panelGeo, _panelMat));
            panel.position.set(x, 0, z);
            g.add(panel);
        });
    });

    // Habitation / Lab modules — cylindrical segments along Z axis
    const habGeo = new THREE.CylinderGeometry(0.14, 0.14, 0.55, 8);
    const habMat = new THREE.MeshStandardMaterial({ color: 0xe8ede8, roughness: 0.5, metalness: 0.2 });
    [-0.55, 0, 0.55].forEach(z => {
        const hab = mark(new THREE.Mesh(habGeo, habMat));
        hab.rotation.x = Math.PI / 2;
        hab.position.set(0, 0, z);
        g.add(hab);
    });

    // Radiator panels — flanking the central truss segment, white
    const radGeo = new THREE.BoxGeometry(0.35, 0.025, 0.60);
    const radMat = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.8 });
    [-0.20, 0.20].forEach(x => {
        const rad = mark(new THREE.Mesh(radGeo, radMat));
        rad.position.set(x, 0.10, 0);
        g.add(rad);
    });

    return g;
}

// ── STARLINK — SpaceX Starlink constellation ───────────────────────────────────
// Very flat rectangular bus with a single large solar panel cantilevered to one side.
function buildStarlink() {
    const g = new THREE.Group();

    // Satellite bus — thin flat plate
    const busMat = new THREE.MeshStandardMaterial({ color: 0xdde0e8, roughness: 0.5, metalness: 0.6 });
    const bus = mark(new THREE.Mesh(new THREE.BoxGeometry(0.70, 0.06, 0.40), busMat));
    g.add(bus);

    // Single large solar panel off to one side (+X)
    const panel = mark(new THREE.Mesh(new THREE.BoxGeometry(0.80, 0.022, 0.50), _panelMat));
    panel.position.set(0.76, 0, 0);
    g.add(panel);

    // Phased array antenna face — slightly darker square on bottom of bus
    const antMat = new THREE.MeshStandardMaterial({ color: 0x1a1a2e, roughness: 0.9 });
    const ant = mark(new THREE.Mesh(new THREE.BoxGeometry(0.60, 0.01, 0.35), antMat));
    ant.position.y = -0.036;
    g.add(ant);

    return g;
}

// ── GPS — Global Positioning System satellite ──────────────────────────────────
// Distinctive hexagonal body with symmetric gold solar wings and navigation antennae.
function buildGPS() {
    const g = new THREE.Group();

    // Hexagonal main body
    const body = mark(new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.20, 0.38, 6), _silverMat));
    g.add(body);

    // Two symmetric gold solar wings
    const wingGeo = new THREE.BoxGeometry(0.90, 0.022, 0.40);
    [-0.60, 0.60].forEach(x => {
        const wing = mark(new THREE.Mesh(wingGeo, _goldPanel));
        wing.position.set(x, 0, 0);
        g.add(wing);
    });

    // Navigation antenna dish (flat circle on bottom)
    const dishGeo = new THREE.CylinderGeometry(0.14, 0.14, 0.03, 12);
    const dish    = mark(new THREE.Mesh(dishGeo, _whiteMat));
    dish.position.y = -0.24;
    g.add(dish);

    return g;
}

// ── WEATHER — Polar / geostationary weather satellite ─────────────────────────
// Box bus (GOES/NOAA-style) with a single solar panel and a parabolic dish.
function buildWeather() {
    const g = new THREE.Group();

    // Square bus body
    const busMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.6, metalness: 0.2 });
    const bus = mark(new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.45, 0.45), busMat));
    g.add(bus);

    // Solar panel (single, extending to +X)
    const panel = mark(new THREE.Mesh(new THREE.BoxGeometry(1.10, 0.022, 0.35), _panelMat));
    panel.position.set(0.78, 0, 0);
    g.add(panel);

    // Parabolic imaging dish — open cylinder approximation
    const dishGeo = new THREE.CylinderGeometry(0.18, 0.08, 0.22, 10, 1, true);
    const dishMat = new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide, roughness: 0.8 });
    const dish    = mark(new THREE.Mesh(dishGeo, dishMat));
    dish.position.y = 0.36;
    g.add(dish);

    // Dish support strut
    const strutGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.22, 4);
    const strut    = mark(new THREE.Mesh(strutGeo, _silverMat));
    strut.position.y = 0.26;
    g.add(strut);

    return g;
}

// ── MILITARY — Reconnaissance / signals intelligence satellite ─────────────────
// Elongated body (KH/Lacrosse style) with small asymmetric panels and a sensor dome.
function buildMilitary() {
    const g = new THREE.Group();

    // Long rectangular body — oriented along Z
    const body = mark(new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.28, 1.10), _darkMat));
    g.add(body);

    // Small asymmetric solar panels — one on each side but staggered
    const panelGeo = new THREE.BoxGeometry(0.50, 0.022, 0.24);
    const milPanel = new THREE.MeshStandardMaterial({ color: 0x1a2e3d, roughness: 0.6, metalness: 0.3, transparent: true, opacity: 0.9 });

    const p1 = mark(new THREE.Mesh(panelGeo, milPanel));
    p1.position.set( 0.40, 0, -0.20);
    g.add(p1);

    const p2 = mark(new THREE.Mesh(panelGeo, milPanel));
    p2.position.set(-0.40, 0,  0.10);
    g.add(p2);

    // Sensor dome / camera housing at front
    const domeGeo = new THREE.SphereGeometry(0.16, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    const domeMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.3, metalness: 0.8 });
    const dome    = mark(new THREE.Mesh(domeGeo, domeMat));
    dome.rotation.x = Math.PI / 2;
    dome.position.z = -0.60;
    g.add(dome);

    // Short stabiliser fin
    const finGeo = new THREE.BoxGeometry(0.40, 0.28, 0.03);
    const fin    = mark(new THREE.Mesh(finGeo, _darkMat));
    fin.position.z = 0.40;
    g.add(fin);

    return g;
}

// ── GENERIC — Small commercial / debris satellite ──────────────────────────────
// Simple cube bus with symmetric panels and a thin antenna mast.
function buildGeneric() {
    const g = new THREE.Group();

    // Cube bus
    const busMat = new THREE.MeshStandardMaterial({ color: 0xb0b4b8, roughness: 0.55, metalness: 0.5 });
    const bus    = mark(new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.38, 0.38), busMat));
    g.add(bus);

    // Symmetric solar panels
    const panelGeo = new THREE.BoxGeometry(0.58, 0.020, 0.28);
    [-0.48, 0.48].forEach(x => {
        const panel = mark(new THREE.Mesh(panelGeo, _panelMat));
        panel.position.set(x, 0, 0);
        g.add(panel);
    });

    // Antenna mast
    const mastGeo = new THREE.CylinderGeometry(0.016, 0.016, 0.32, 4);
    const mast    = mark(new THREE.Mesh(mastGeo, _silverMat));
    mast.position.y = 0.35;
    g.add(mast);

    return g;
}

// ── createSatelliteObject ─────────────────────────────────────────────────────
// Main factory — called by main.js when SatelliteManager fires onSatelliteNew.
export function createSatelliteObject(data, scene) {
    let group;
    switch (data.type) {
        case 'STATION':  group = buildISS();      break;
        case 'STARLINK': group = buildStarlink();  break;
        case 'GPS':
        case 'GALILEO':  group = buildGPS();       break;
        case 'WEATHER':  group = buildWeather();   break;
        case 'MILITARY': group = buildMilitary();  break;
        default:         group = buildGeneric();   break;
    }

    // ISS is the one truly large object; everything else kept tight
    const scaleMap = { STATION: 1.0, STARLINK: 0.65, GPS: 0.80, GALILEO: 0.80, WEATHER: 0.75, MILITARY: 0.80 };
    group.scale.setScalar(scaleMap[data.type] ?? 0.70);

    // Slowly rotate satellites around Y to show they're live objects
    group.userData.rotSpeed = (Math.random() - 0.5) * 0.004;

    // Standard userData fields expected by the raycaster / detail panel
    group.userData.id          = data.id;
    group.userData.displayName = data.name;
    group.userData.class       = data.type;
    group.userData.isSatellite     = true;
    group.userData.isRealSatellite = true;
    group.userData.htmlColor   = SAT_HTML_COLORS[data.type] ?? '#999999';
    group.userData.speedKts    = 0;         // filled each tick
    group.userData.altKm       = data.altKm;
    group.userData.latDeg      = data.latDeg;
    group.userData.lonDeg      = data.lonDeg;
    group.userData.history     = [];

    // Orbital trail — short, faint, additive-blended
    const trailGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3()]);
    const trailMat = new THREE.LineBasicMaterial({
        color:       SAT_COLORS[data.type] ?? 0x999999,
        transparent: true,
        opacity:     0.35,
        depthWrite:  false,
    });
    const trail = new THREE.Line(trailGeo, trailMat);
    scene.add(trail);
    group.userData.trail = trail;

    scene.add(group);
    return group;
}
