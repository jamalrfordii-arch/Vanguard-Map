// vesselWaterPad.js — fjord/harbor coastline patch.
//
// The terrain DEM is too coarse to resolve narrow waterways (fjords, rivers,
// sounds, inner harbors), so it fills them as land. Real AIS vessels there —
// Norwegian fjord ferries, Puget Sound / Vancouver harbor traffic — correctly
// report water positions but render over land-COLORED terrain splats.
//
// Fix: when a vessel samples as land, lay a small ocean-colored disc beneath
// it so it reads as floating on a patch of water. The vessel IS on water in
// reality; this restores that locally without re-carving the global DEM (which
// would disturb the hand-tuned terrain look).
//
// Cheap: one shared geometry + material, one pooled mesh per affected vessel,
// created lazily. Real-ocean vessels never get a pad.
//
// Usage (main.js vessel loop): vesselWaterPads.update(ship, sampleFn)

import * as THREE from 'three';

const PAD_RADIUS   = 1.6;     // scene units — a little wider than a vessel hull
const LAND_THRESH  = 0.05;    // terrain height above which we consider it "land"

let _geo = null;
let _mat = null;
let _parent = null;

function ensureShared(parent) {
    _parent = parent;
    if (_geo) return;
    _geo = new THREE.CircleGeometry(PAD_RADIUS, 24);
    _geo.rotateX(-Math.PI / 2);
    // Tactical ocean tone — matches the shallow-water gradient in the palette.
    _mat = new THREE.MeshBasicMaterial({
        color: 0x0c1f38, transparent: true, opacity: 0.92,
        depthWrite: false, side: THREE.DoubleSide,
    });
}

export const vesselWaterPads = {
    // Call once at init with the group vessels live in (laneGroup).
    init(parent) { ensureShared(parent); },

    // Per-vessel, per-frame (or per-update). sampleFn(x, z) → terrain height.
    update(ship, sampleFn) {
        const p = ship.position;
        const h = sampleFn(p.x, p.z) ?? 0;
        const overLand = h > LAND_THRESH;

        let pad = ship.userData._waterPad;
        if (overLand) {
            if (!pad) {
                ensureShared(_parent);
                pad = new THREE.Mesh(_geo, _mat);
                pad.renderOrder = 3;        // above terrain splats, below vessel dot (4)
                _parent.add(pad);
                ship.userData._waterPad = pad;
            }
            // Sit the pad just above the local land surface so it hides the
            // land-colored splats the vessel would otherwise float over.
            pad.position.set(p.x, h + 0.03, p.z);
            pad.visible = true;
        } else if (pad) {
            pad.visible = false;
        }
    },

    // Cleanup when a vessel is removed.
    remove(ship) {
        const pad = ship.userData._waterPad;
        if (pad) {
            _parent?.remove(pad);
            ship.userData._waterPad = null;
        }
    },
};
