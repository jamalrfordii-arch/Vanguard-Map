// selectionRing.js — Persistent vessel selection ring
// Initialised by main.js:  initSelectionRing(scene)
//
// Two concentric flat rings lock to a clicked vessel and follow it:
//   • Outer ring — steady, slowly rotates clockwise
//   • Inner ring — breathes (opacity + scale pulse)
//
// Color:
//   0x40c4ff (cyan)   — default, non-watchlisted vessel
//   0x00e87a (green)  — vessel is on the watchlist
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

// ── Ring geometry constants ───────────────────────────────────────────────────
// Ships render at scale 0.08 → hull ~0.28 scene units wide.
// Inner ring clears the hull cleanly; outer ring gives breathing room.
const OUTER_INNER_R = 2.50;
const OUTER_OUTER_R = 3.10;
const INNER_INNER_R = 1.55;
const INNER_OUTER_R = 2.00;
const SEGMENTS      = 64;

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

    // ── State ─────────────────────────────────────────────────────────────────
    let _target = null;
    const _pos  = new THREE.Vector3();

    // ── API ───────────────────────────────────────────────────────────────────
    const ring = {

        select(vesselObj, color = COLOR_DEFAULT) {
            _target = vesselObj;
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
            outerRing.visible = false;
            innerRing.visible = false;
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
        },

        // Snap both rings to the vessel's current world position
        _snap() {
            _target.getWorldPosition(_pos);
            outerRing.position.set(_pos.x, 0.18, _pos.z);
            innerRing.position.set(_pos.x, 0.22, _pos.z);
        },

        get target() { return _target; },

        // Convenience constants so callers don't hard-code hex values
        COLOR_DEFAULT,
        COLOR_WATCHLIST,
    };

    return ring;
}
