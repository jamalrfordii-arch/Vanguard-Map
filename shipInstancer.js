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
//   2. Fixed orientation — main.js always sets `obj.rotation.y = Math.PI/2`
//      ("all vessel figures face east so hull length is always visible"),
//      never anything heading-derived. So unlike aircraft this instancer
//      uses one constant orientation quaternion, no per-instance heading.
import * as THREE from 'three';
import { AIS } from './config.js';
import { SHIP_CLASSES } from './entityBuilder.js';

const CAPACITY  = AIS.MAX_VESSELS; // per class, per part
const SHIP_SCALE = 0.08;            // matches the old shipGroup.scale.set(0.08,...)

// Scratch objects reused every call — never allocate inside update().
const _shipPos     = new THREE.Vector3();
const _shipQuat    = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0));
const _shipScaleVec = new THREE.Vector3(SHIP_SCALE, SHIP_SCALE, SHIP_SCALE);
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
    update(handle, position, visible) {
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
