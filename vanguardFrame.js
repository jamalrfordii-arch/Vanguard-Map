// vanguardFrame.js — Modern naval CIC frame around the map
//
// First piece of intentional "frame" geometry added back after the strip-down
// pass. Implements the Modern Naval CIC mockup: a brushed-steel desk surface
// extending past the map's boundary, with a cyan trim line and four tactical
// corner brackets right at the world edge.
//
// Three layers, all parented to one group so they toggle/dispose together:
//
//   1. Steel desk plane   — large MeshBasic plane at Y=-30, ~2.5× map size.
//                           Visible only at oblique/tilted camera angles.
//                           From overhead it sits silently below everything.
//   2. Cyan perimeter trim — a LineLoop at Y=0.05 (just above sea level)
//                           tracing the exact rectangle X=±halfW, Z=±halfH.
//                           The "this is where the map ends" line.
//   3. Corner brackets     — four L-shaped lines at the corners, slightly
//                           inside the trim, in a brighter cyan.
//
// All visuals are lightweight (no shaders, no textures, ~3 draw calls total)
// so this frame costs essentially nothing on the GPU. Easy to delete later
// if the user changes their mind.

import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT } from './config.js';

const DESK_Y     = -30;       // sits below the deepest ocean floor
const DESK_SCALE = 2.5;       // multiplier on map size
const TRIM_Y     = 0.05;      // just above the water plane
const BRACKET_Y  = 0.10;      // slightly above trim
const BRACKET_LEN = 14;       // arm length of each corner L

export function createVanguardFrame(scene) {
    const group = new THREE.Group();
    group.name = 'vanguardFrame';

    const halfW = MAP_WIDTH  * 0.5;
    const halfH = MAP_HEIGHT * 0.5;

    // ── Layer 1: brushed-steel desk surface ──────────────────────────────────
    const deskW = MAP_WIDTH  * DESK_SCALE;
    const deskH = MAP_HEIGHT * DESK_SCALE;
    const deskGeo = new THREE.PlaneGeometry(deskW, deskH);
    deskGeo.rotateX(-Math.PI / 2);
    const deskMat = new THREE.MeshBasicMaterial({
        color:       0x1a2230,    // dark steel blue-gray
        depthWrite:  true,
    });
    const desk = new THREE.Mesh(deskGeo, deskMat);
    desk.position.y = DESK_Y;
    desk.renderOrder = -10;       // draw first so map sits on top
    group.add(desk);

    // ── Layer 2: cyan perimeter trim ─────────────────────────────────────────
    // LineLoop closes itself, no need to repeat the first point.
    const trimPts = new Float32Array([
        -halfW, TRIM_Y, -halfH,
         halfW, TRIM_Y, -halfH,
         halfW, TRIM_Y,  halfH,
        -halfW, TRIM_Y,  halfH,
    ]);
    const trimGeo = new THREE.BufferGeometry();
    trimGeo.setAttribute('position', new THREE.BufferAttribute(trimPts, 3));
    const trimMat = new THREE.LineBasicMaterial({
        color:       0x22c8ff,    // cyan glow
        transparent: true,
        opacity:     0.80,
        depthWrite:  false,
    });
    const trim = new THREE.LineLoop(trimGeo, trimMat);
    trim.renderOrder = 5;
    group.add(trim);

    // ── Layer 3: four tactical corner brackets ───────────────────────────────
    // Each bracket is a 3-point line: (corner + arm_along_X) → corner → (corner + arm_along_Z)
    // The brackets are slightly INSIDE the trim by INSET so they read as
    // tactical accents on top of, not extensions past, the world boundary.
    const INSET = 1.5;
    const brackets = [
        { x: -halfW + INSET, z: -halfH + INSET, sx:  1, sz:  1 },  // NW
        { x:  halfW - INSET, z: -halfH + INSET, sx: -1, sz:  1 },  // NE
        { x:  halfW - INSET, z:  halfH - INSET, sx: -1, sz: -1 },  // SE
        { x: -halfW + INSET, z:  halfH - INSET, sx:  1, sz: -1 },  // SW
    ];

    const bracketMat = new THREE.LineBasicMaterial({
        color:       0x5cd5ff,    // slightly brighter than trim
        transparent: true,
        opacity:     0.95,
        depthWrite:  false,
    });

    brackets.forEach(b => {
        const pts = new Float32Array([
            b.x + b.sx * BRACKET_LEN, BRACKET_Y, b.z,
            b.x,                       BRACKET_Y, b.z,
            b.x,                       BRACKET_Y, b.z + b.sz * BRACKET_LEN,
        ]);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
        const line = new THREE.Line(geo, bracketMat);
        line.renderOrder = 6;
        group.add(line);
    });

    scene.add(group);
    return group;
}
