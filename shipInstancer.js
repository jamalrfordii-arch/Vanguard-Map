// shipInstancer.js — GPU-instanced rendering for real AIS vessels.
//
// Why this exists: entityBuilder.js's shapeBuilders.CARGO/TANKER/etc. each
// construct a Group of ~3-9 Meshes with brand-new Materials (well, materials
// are actually shared per-class via `realMaterials` — but the Mesh + Geometry
// pair is still fresh every call). Calling shipClass.builder() once per
// vessel (the old behavior, in createAISVesselObject) meant up to 500 live
// AIS vessels cost up to ~4500 draw calls, every time a vessel spawned or
// was reclassified. This mirrors the exact problem solved for real-flight
// aircraft in aircraftInstancer.js (see that file's header for the original
// fps investigation) — same fix, applied to ships.
//
// The fix: call each class's builder() exactly ONCE at init to harvest its
// parts (geometry + material + local transform, by reading the template
// Group Three.js already builds correctly), then render every live vessel
// of that class through ONE THREE.InstancedMesh per part, writing only a 4x4
// matrix per instance per frame. Total draw calls become fixed and tiny
// (sum of part-counts across the 12 ship classes) instead of scaling with
// vessel count.
//
// Two ship-specific details carried over from createAISVesselObject:
//   1. Waterline lift — each shape builder places its hull at a slightly
//      different Y offset. The old code computed a bounding-box lift per
//      LIVE vessel so the hull's lowest point sits at the group origin
//      (minus a ~25% "draft" submersion). That computation is deterministic
//      per class (same static geometry every time), so it's baked in ONCE
//      here at harvest time instead of once per vessel — identical result,
//      far fewer Box3 computations.
//   2. Heading orientation — the hull now rotates to match each vessel's
//      real COG/heading (task: "hull orientation should track true
//      heading", 2026-07-22). Every class's builder places its bow at local
//      +Z (see entityBuilder.js hullWithBow), so the world-space rotation
//      that points the bow toward true heading is rotation.y = PI - hdgRad
//      — the same convention wakeManager.js has documented in its header
//      since before this instancer existed (wakeManager reads
//      entity.rotation.y directly, so this fix also restores wake-heading
//      accuracy as a side effect). Previously this was a single shared
//      constant quaternion (fixed broadside-east); now it's recomputed per
//      vessel per frame — cheap (one Euler+Quaternion per live vessel,
//      capped at AIS.MAX_VESSELS) next to the matrix math already done here.
//      Vessels without a known heading yet (fresh spawn, no report received)
//      fall back to the old fixed broadside orientation rather than facing
//      an arbitrary default.
import * as THREE from 'three';
import { AIS, SHIP_RENDER } from './config.js';
import { vesselRenderScale, pixelsPerSceneUnit } from './vesselScale.js';
import { SHIP_CLASSES } from './entityBuilder.js';

const CAPACITY  = AIS.MAX_VESSELS; // per class, per part
// Fallback only — matches config.js SHIP_RENDER.BASELINE_SCALE. Real per-vessel
// scale (2026-07-23, true-scale rendering) is computed in aisManager.js's
// computeRenderScale() and passed into update() below; this constant only fires
// if a caller somehow doesn't pass one, so ships never silently render at 0 scale.
const SHIP_SCALE = 0.08;
const FALLBACK_ROTATION_Y = Math.PI / 2; // broadside-east, used only when heading is unknown

// Scratch objects reused every call — never allocate inside update().
const _shipPos     = new THREE.Vector3();
const _shipEuler   = new THREE.Euler();
const _shipQuat    = new THREE.Quaternion();
const _shipScaleVec = new THREE.Vector3(SHIP_SCALE, SHIP_SCALE, SHIP_SCALE); // mutated per-call via .setScalar() in update() — true-scale rendering, 2026-07-23

// ── Altitude-aware vessel sizing (2026-07-25) ────────────────────────────────
// Longest axis of the hull template at scale 1. MEASURED off the live instanced
// geometry (3.4), not assumed — an earlier estimate that took it for 1.0 put the
// exaggeration at 36x when it is actually 192x, which is the difference between
// "a bit large" and "38 kilometres long". If the hull model is ever re-authored,
// re-measure: window.scene.traverse(o => o.isInstancedMesh && ...boundingBox).
const HULL_UNITS = 3.4;
// Vessels never render shorter than this on screen. The single tunable — see
// vesselScale.js for why it is expressed in pixels rather than as a multiplier.
const DEFAULT_MIN_PX = 12;
let _view = null;   // { cameraPos, viewportH, fovDeg, minPx } — null until setView

/**
 * Per-frame camera context for altitude-aware sizing. Call once per frame before
 * the update() sweep; omit entirely and sizing reverts to the pre-2026-07-25
 * fixed-exaggeration behaviour.
 */
export function setShipViewContext(cameraPos, viewportH, fovDeg, minPx = DEFAULT_MIN_PX) {
    if (!cameraPos || !(viewportH > 0)) { _view = null; return; }
    _view = { cameraPos, viewportH, fovDeg, minPx };
}
const _partQuat     = new THREE.Quaternion();
const _shipMatrix  = new THREE.Matrix4();
const _partMatrix   = new THREE.Matrix4();
const _finalMatrix  = new THREE.Matrix4();
const _zeroMatrix   = new THREE.Matrix4().makeScale(0, 0, 0);
const _hullBox      = new THREE.Box3();

class ShipInstancer {
    constructor() {
        this.classes = {}; // classType -> { parts: [...], freeSlots: [], nextSlot: 0 }
        this._initialized = false;
    }

    // Builds the InstancedMesh set. Call once, after `scene` exists.
    init(scene) {
        if (this._initialized) return;
        this._initialized = true;

        for (const cls of SHIP_CLASSES) {
            const template = cls.builder(); // built once, never added to the scene

            // ── Waterline lift (baked in once per class) ────────────────────
            // Same computation createAISVesselObject used to run per-vessel:
            // measure the structural meshes' bounding box (skip rings/markers
            // — none exist on this template since it's a fresh builder() call
            // with no selection-ring siblings attached) and shift children so
            // the hull's lowest point sits at the origin, minus a ~25% draft.
            _hullBox.makeEmpty();
            let measured = false;
            template.children.forEach(c => {
                if (c.geometry instanceof THREE.RingGeometry) return;
                _hullBox.expandByObject(c);
                measured = true;
            });
            if (measured && isFinite(_hullBox.min.y)) {
                const hullHeight = Math.max(0.01, _hullBox.max.y - _hullBox.min.y);
                const draftFrac  = 0.25;
                const lift       = -_hullBox.min.y - hullHeight * draftFrac;
                template.children.forEach(child => { child.position.y += lift; });
            }

            const parts = [];
            template.children.forEach(child => {
                if (!child.isMesh) return;
                child.updateMatrix();

                const position = child.position.clone();
                const rotation = child.rotation.clone();
                const scale    = child.scale.clone();

                const mesh = new THREE.InstancedMesh(child.geometry, child.material, CAPACITY);
                mesh.count = CAPACITY;
                mesh.frustumCulled = false; // instances spread across the whole map
                mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
                for (let i = 0; i < CAPACITY; i++) mesh.setMatrixAt(i, _zeroMatrix);
                mesh.instanceMatrix.needsUpdate = true;
                scene.add(mesh);

                parts.push({ mesh, position, rotation, scale });
            });

            this.classes[cls.type] = { parts, freeSlots: [], nextSlot: 0 };
        }
    }

    // Allocates a slot for a new vessel of this class. Returns a handle to
    // pass to update()/free(), or null if somehow at capacity (shouldn't
    // happen — AIS.MAX_VESSELS already caps total live vessels at CAPACITY).
    spawn(classType) {
        const cls = this.classes[classType] || this.classes.OTHER;
        if (!cls) return null;
        const resolvedType = this.classes[classType] ? classType : 'OTHER';
        const slot = cls.freeSlots.length ? cls.freeSlots.pop() : cls.nextSlot++;
        if (slot >= CAPACITY) return null;
        return { classType: resolvedType, slot };
    }

    // Releases a slot and zeroes its matrix in every part-mesh. Instances
    // aren't physically removed from the InstancedMesh (mesh.count stays at
    // CAPACITY), so an unused slot must be explicitly degenerate-scaled or
    // it'll show a stale hull sitting wherever it was last positioned.
    free(handle) {
        if (!handle) return;
        const cls = this.classes[handle.classType];
        if (!cls) return;
        cls.parts.forEach(part => {
            part.mesh.setMatrixAt(handle.slot, _zeroMatrix);
            part.mesh.instanceMatrix.needsUpdate = true;
        });
        cls.freeSlots.push(handle.slot);
    }

    // Writes this vessel's current world position into every part-mesh's
    // instance matrix for its slot. `visible=false` degenerate-scales it —
    // used when clusterManager hides individual vessels at far/mid zoom, or
    // when the class filter / dark-vessel logic hides one — matching the old
    // `ship.visible = false` behavior visually with zero per-consumer branching.
    // `headingDeg` (0-360, compass convention) orients the hull to match true
    // heading; null/undefined falls back to the fixed broadside orientation.
    // `scale` (2026-07-23, true-scale rendering) sets this vessel's real-
    // proportional size — see aisManager.js's computeRenderScale() for how it's
    // derived. Falls back to the old fixed SHIP_SCALE if omitted/invalid, so a
    // missed call site degrades to the pre-true-scale look instead of vanishing.
    update(handle, position, visible, headingDeg, scale) {
        if (!handle) return;
        const cls = this.classes[handle.classType];
        if (!cls) return;

        if (!visible) {
            cls.parts.forEach(part => {
                part.mesh.setMatrixAt(handle.slot, _zeroMatrix);
                part.mesh.instanceMatrix.needsUpdate = true;
            });
            return;
        }

        const rotY = (headingDeg != null)
            ? Math.PI - (headingDeg * Math.PI / 180)
            : FALLBACK_ROTATION_Y;
        _shipEuler.set(0, rotY, 0);
        _shipQuat.setFromEuler(_shipEuler);

        let resolvedScale = (scale != null && scale > 0) ? scale : SHIP_SCALE;
        // ── Altitude-aware sizing (2026-07-25) ───────────────────────────────
        // `scale` above is the real-proportional size from aisManager, which is
        // exaggerated ~192x so the fleet is legible at world zoom (necessary: a
        // real ship is 0.0015 scene units). That exaggeration is fine at altitude
        // and absurd at z10, where a median vessel renders 38 KM long — across a
        // whole island. setView() supplies the camera context that lets this shrink
        // toward true scale as you descend, bottoming out at a pixel floor.
        //
        // Applied HERE rather than at the three update() call sites so there is one
        // implementation and no chance of a caller being missed. When setView has
        // not been called (headless, pre-first-frame) _view stays null and this is
        // a no-op — the pre-2026-07-25 look, not a vanished fleet.
        if (_view) {
            // Recover hull length from the scale we were handed rather than
            // widening update()'s signature across three call sites: aisManager
            // built it as BASELINE_SCALE * (lengthM / REFERENCE_LENGTH_M), so this
            // inverts exactly. Lossy only for craft small enough to have hit
            // MIN_RENDER_SCALE — and for those the pixel floor binds anyway, so the
            // recovered length never reaches the result.
            const lengthM = SHIP_RENDER.REFERENCE_LENGTH_M
                          * (resolvedScale / SHIP_RENDER.BASELINE_SCALE);
            resolvedScale = vesselRenderScale(
                resolvedScale, lengthM,
                pixelsPerSceneUnit(_view.viewportH, _view.fovDeg, position.distanceTo(_view.cameraPos)),
                _view.minPx, HULL_UNITS);
        }
        _shipScaleVec.setScalar(resolvedScale);

        _shipPos.copy(position);
        _shipMatrix.compose(_shipPos, _shipQuat, _shipScaleVec);

        cls.parts.forEach(part => {
            _partQuat.setFromEuler(part.rotation);
            _partMatrix.compose(part.position, _partQuat, part.scale);
            _finalMatrix.copy(_shipMatrix).multiply(_partMatrix);
            part.mesh.setMatrixAt(handle.slot, _finalMatrix);
            part.mesh.instanceMatrix.needsUpdate = true;
        });
    }
}

export const shipInstancer = new ShipInstancer();
