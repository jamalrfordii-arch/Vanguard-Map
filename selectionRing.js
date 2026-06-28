// selectionRing.js — Persistent vessel selection ring + heading compass
// Initialised by main.js:  initSelectionRing(scene)
//
// Two concentric flat rings lock to a clicked vessel and follow it:
//   • Outer ring — steady, slowly rotates clockwise
//   • Inner ring — breathes (opacity + scale pulse)
// Plus a compass face (added 2026-06-25 — see memory/decisions.md) that
// reads the vessel's live headingDeg:
//   • 12 tick marks around the rim, N/E/S/W longer than the 30°-interval minors
//   • A needle pointing the vessel's true heading
//   • A canvas-text degree readout floating above the ring
//
// Color:
//   0x40c4ff (cyan)   — ring default, non-watchlisted vessel
//   0x00e87a (green)  — ring, vessel is on the watchlist
//   0xe8f4ff (near-white) — compass elements (ticks/needle/label), fixed
//                           regardless of ring color so it reads as an
//                           instrument overlay rather than part of the
//                           watchlist-status color coding.
//
// Returns an object with:
//   .select(vesselObj, color?)  — lock ring to vessel Three.js object
//   .setColor(color)            — change ring color without deselecting
//   .clear()                    — hide ring, release target
//   .tick(delta, elapsed)       — call every frame from animation loop
//   .target                     — current Three.js object (null if none)

import * as THREE from 'three';

const COLOR_DEFAULT   = 0x40c4ff;  // cyan — scene UI colour
const COLOR_WATCHLIST = 0x00e87a;  // green — watchlisted
const COLOR_COMPASS    = 0xe8f4ff; // near-white — compass ticks/needle/label

// ── Ring geometry constants ───────────────────────────────────────────────────
// Ships render at scale 0.08 → hull ~0.28 scene units wide.
// Inner ring clears the hull cleanly; outer ring gives breathing room.
// Thinned 2026-06-25 (was 0.60 / 0.45 band width) so the compass ticks read
// as their own layer instead of merging into a thick ring band.
const OUTER_INNER_R = 2.65;
const OUTER_OUTER_R = 2.95;
const INNER_INNER_R = 1.70;
const INNER_OUTER_R = 1.95;
const SEGMENTS      = 64;

// ── Compass geometry constants ────────────────────────────────────────────────
const TICK_R_IN        = OUTER_OUTER_R + 0.05;
const TICK_R_OUT_MAJOR = TICK_R_IN + 0.45;   // N/E/S/W ticks
const TICK_R_OUT_MINOR = TICK_R_IN + 0.22;   // every-30° minor ticks
const NEEDLE_R_TIP     = TICK_R_IN + 0.05;   // needle reaches just past ticks
const NEEDLE_R_TAIL    = 0.35;               // short tail behind center
const COMPASS_Y        = 0.26;               // sits just above both rings

// Compass bearing (degrees, 0 = north, clockwise) → local XZ offset.
// Matches the headingLine convention used elsewhere (flightManager.js /
// main.js): north = -Z, east = +X, so a 0° heading points -Z exactly like
// every other heading indicator in this codebase — kept in lockstep
// deliberately so this never drifts out of sync with how vessels actually
// face on screen.
function bearingOffset(deg, r) {
    const rad = deg * Math.PI / 180;
    return { x: Math.sin(rad) * r, z: -Math.cos(rad) * r };
}

// ── Static tick-ring geometry (12 ticks, built once, just repositioned) ─────
function buildTicks() {
    const positions = [];
    for (let deg = 0; deg < 360; deg += 30) {
        const isCardinal = deg % 90 === 0;
        const rOut = isCardinal ? TICK_R_OUT_MAJOR : TICK_R_OUT_MINOR;
        const p1 = bearingOffset(deg, TICK_R_IN);
        const p2 = bearingOffset(deg, rOut);
        positions.push(p1.x, COMPASS_Y, p1.z, p2.x, COMPASS_Y, p2.z);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(positions), 3));
    const mat = new THREE.LineBasicMaterial({
        color:       COLOR_COMPASS,
        transparent: true,
        opacity:     0.85,
        depthWrite:  false,
        depthTest:   true,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.renderOrder = 4;
    lines.visible = false;
    return { mesh: lines, material: mat };
}

// ── Needle (heading indicator, geometry rewritten each tick) ─────────────────
function buildNeedle() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
    const mat = new THREE.LineBasicMaterial({
        color:       COLOR_COMPASS,
        transparent: true,
        opacity:     0.95,
        depthWrite:  false,
        depthTest:   true,
    });
    const line = new THREE.Line(geo, mat);
    line.renderOrder = 5;
    line.visible = false;
    return { mesh: line, material: mat };
}

// ── Degree readout (canvas-text sprite, redrawn only when the rounded
//    degree value actually changes — not every frame) ────────────────────────
function buildLabel() {
    const W = 76, H = 32;
    const cvs = document.createElement('canvas');
    cvs.width = W; cvs.height = H;
    const tex = new THREE.CanvasTexture(cvs);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({
        map:        tex,
        transparent:true,
        depthWrite: false,
        depthTest:  false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(2.1, 0.88, 1);
    sprite.renderOrder = 6;
    sprite.visible = false;
    return { sprite, canvas: cvs, texture: tex };
}

function drawLabel(cvs, tex, text) {
    const ctx = cvs.getContext('2d');
    const W = cvs.width, H = cvs.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(2, 8, 20, 0.60)';
    ctx.beginPath();
    ctx.roundRect(0, 0, W, H, 5);
    ctx.fill();
    ctx.strokeStyle = '#e8f4ff';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.roundRect(0.65, 0.65, W - 1.3, H - 1.3, 5);
    ctx.stroke();
    ctx.fillStyle = '#e8f4ff';
    ctx.font = 'bold 16px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, W / 2, H / 2 + 1);
    tex.needsUpdate = true;
}

export function initSelectionRing(scene) {

    // ── Outer ring — rotates, steady opacity ─────────────────────────────────
    const outerMat = new THREE.MeshBasicMaterial({
        color:       COLOR_DEFAULT,
        transparent: true,
        opacity:     0.50,
        side:        THREE.DoubleSide,
        depthWrite:  false,
        depthTest:   true,
    });
    const outerRing = new THREE.Mesh(
        new THREE.RingGeometry(OUTER_INNER_R, OUTER_OUTER_R, SEGMENTS),
        outerMat
    );
    outerRing.rotation.x = -Math.PI / 2;
    outerRing.renderOrder = 2;
    outerRing.visible     = false;
    scene.add(outerRing);

    // ── Inner ring — breathes ─────────────────────────────────────────────────
    const innerMat = new THREE.MeshBasicMaterial({
        color:       COLOR_DEFAULT,
        transparent: true,
        opacity:     0.80,
        side:        THREE.DoubleSide,
        depthWrite:  false,
        depthTest:   true,
    });
    const innerRing = new THREE.Mesh(
        new THREE.RingGeometry(INNER_INNER_R, INNER_OUTER_R, SEGMENTS),
        innerMat
    );
    innerRing.rotation.x = -Math.PI / 2;
    innerRing.renderOrder = 3;
    innerRing.visible     = false;
    scene.add(innerRing);

    // ── Compass elements ─────────────────────────────────────────────────────
    const ticks  = buildTicks();
    const needle = buildNeedle();
    const label  = buildLabel();
    scene.add(ticks.mesh, needle.mesh, label.sprite);

    // ── State ─────────────────────────────────────────────────────────────────
    let _target      = null;
    let _lastLabelDeg = null;
    const _pos  = new THREE.Vector3();

    // ── API ───────────────────────────────────────────────────────────────────
    const ring = {

        select(vesselObj, color = COLOR_DEFAULT) {
            _target = vesselObj;
            _lastLabelDeg = null; // force label redraw for the new vessel
            ring.setColor(color);
            ring._snap();
            outerRing.visible = true;
            innerRing.visible = true;
        },

        setColor(color) {
            outerMat.color.setHex(color);
            innerMat.color.setHex(color);
        },

        clear() {
            _target = null;
            outerRing.visible  = false;
            innerRing.visible  = false;
            ticks.mesh.visible  = false;
            needle.mesh.visible = false;
            label.sprite.visible = false;
        },

        tick(delta, elapsed) {
            if (!_target) return;
            ring._snap();

            // Outer ring — slow clockwise drift
            outerRing.rotation.z -= delta * 0.30;

            // Inner ring — breathe opacity + very subtle scale
            const t      = elapsed * 2.0;
            const breath = Math.sin(t);                               // -1 … 1
            innerMat.opacity = 0.55 + 0.28 * breath;
            const scl    = 1.0 + 0.045 * Math.sin(t * 0.8);
            innerRing.scale.setScalar(scl);

            // ── Compass — only drawn when the target reports a heading ──────
            const heading = _target.userData?.headingDeg;
            if (heading == null || Number.isNaN(heading)) {
                ticks.mesh.visible  = false;
                needle.mesh.visible = false;
                label.sprite.visible = false;
                return;
            }

            // All compass geometry is built with its COMPASS_Y offset already
            // baked into the vertex data (see buildTicks/buildNeedle), so the
            // mesh's own position.y only needs to add the vessel's actual
            // world-space Y (_pos.y, e.g. terrain-following curveY) — not 0.
            // Using 0 here is what caused the ring/compass to float above
            // ships sitting above sea level on the curved splat surface.
            ticks.mesh.position.set(_pos.x, _pos.y, _pos.z);
            ticks.mesh.visible = true;

            const tail = bearingOffset(heading, -NEEDLE_R_TAIL);
            const tip  = bearingOffset(heading,  NEEDLE_R_TIP);
            const posAttr = needle.mesh.geometry.attributes.position;
            posAttr.array[0] = tail.x; posAttr.array[1] = COMPASS_Y; posAttr.array[2] = tail.z;
            posAttr.array[3] = tip.x;  posAttr.array[4] = COMPASS_Y; posAttr.array[5] = tip.z;
            posAttr.needsUpdate = true;
            needle.mesh.position.set(_pos.x, _pos.y, _pos.z);
            needle.mesh.visible = true;

            const deg = Math.round(((heading % 360) + 360) % 360);
            if (deg !== _lastLabelDeg) {
                drawLabel(label.canvas, label.texture, String(deg).padStart(3, '0') + '°');
                _lastLabelDeg = deg;
            }
            label.sprite.position.set(_pos.x, _pos.y + COMPASS_Y + 0.9, _pos.z);
            label.sprite.visible = true;
        },

        // Snap both rings to the vessel's current world position
        _snap() {
            _target.getWorldPosition(_pos);
            outerRing.position.set(_pos.x, _pos.y + 0.18, _pos.z);
            innerRing.position.set(_pos.x, _pos.y + 0.22, _pos.z);
        },

        get target() { return _target; },

        // Convenience constants so callers don't hard-code hex values
        COLOR_DEFAULT,
        COLOR_WATCHLIST,
        COLOR_COMPASS,
    };

    return ring;
}
