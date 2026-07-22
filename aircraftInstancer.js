// aircraftInstancer.js — GPU-instanced rendering for real-flight aircraft.
//
// Why this exists: entityBuilder.js's buildAirliner/buildCargoFreighter/etc.
// each construct a Group of ~9-16 Meshes with brand-new Materials. Calling
// cls.builder() once per aircraft (the old behavior, in createFlightObject)
// meant ~300 live aircraft cost ~3000-4800 draw calls plus ~900-1200 fresh
// Material allocations, every time an aircraft spawned. That was the single
// biggest fps cost in the scene (see memory/decisions.md, fps investigation
// 2026-06-26: ~25.7fps avg before this change).
//
// The fix: call each class's builder() exactly ONCE at init to harvest its
// parts (geometry + material + local transform, by reading the template
// Group Three.js already builds correctly), then render every live aircraft
// of that class through ONE THREE.InstancedMesh per part, writing only a 4x4
// matrix per instance per frame. Total draw calls become fixed and tiny
// (≈ sum of part-counts across the 5 classes, independent of how many
// aircraft are actually live) instead of scaling with aircraft count.
//
// Spin parts (helicopter main/tail rotor, GA prop) are detected by the
// `.name` tag entityBuilder.js already sets on them and animated by adding a
// shared, time-based extra rotation on top of each part's harvested base
// transform — this exactly matches the old per-object `mesh.rotation.x/y/z
// += delta * speed` behavior, since every instance previously shared the
// same speed and started from the same base rotation anyway (no per-aircraft
// phase offset existed to lose).
import * as THREE from 'three';
import { FLIGHT } from './config.js';
import { AIRCRAFT_CLASSES_VISUAL } from './entityBuilder.js';

const CAPACITY = FLIGHT.MAX_AIRCRAFT; // per class, per part — see note in init()

// name → { axis: 'x'|'y'|'z', speed } — mirrors the old main.js animation
// loop block (`ud._mainRotor.rotation.y += delta * 18`, etc.) exactly.
const SPIN_PARTS = {
    main_rotor: { axis: 'y', speed: 18 },
    tail_rotor: { axis: 'x', speed: 24 },
    prop_disc:  { axis: 'z', speed: 30 },
};

// Scratch objects reused every call — never allocate inside update()/tick().
// Aircraft used to render at one fixed "always east-facing" orientation
// (silhouette-readability choice — see main.js history) regardless of real
// heading. Per Jamal's call (2026-06-26), aircraft now yaw to their true
// heading and add bank/pitch on top — see _aircraftEuler below and
// flightManager.js's tick() for where headingDeg/bankDeg/pitchDeg come from.
// Ships keep the old fixed-orientation behavior untouched.
const _aircraftPos   = new THREE.Vector3();
const _aircraftQuat  = new THREE.Quaternion();
const _aircraftEuler = new THREE.Euler(0, 0, 0, 'YXZ'); // yaw, pitch, roll(bank) — standard aircraft order
const _aircraftScale = new THREE.Vector3(); // scratch — avoids a `new Vector3()` per aircraft per frame (CLAUDE.md perf rule #5)

// Motion-graphics polish (2026-06-27): shapes flightManager.js's linear
// spawnEase (0→1) into a small overshoot "pop" — standard easeOutBack curve.
// At x=1 this returns exactly 1, so a fully-spawned aircraft is unaffected;
// the overshoot only shows during the ~0.5s SPAWN_EASE_SEC window.
function _easeOutBack(x) {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}
const _partPos        = new THREE.Vector3();
const _partQuat       = new THREE.Quaternion();
const _partScale       = new THREE.Vector3();
const _partEuler       = new THREE.Euler();
const _aircraftMatrix = new THREE.Matrix4();
const _partMatrix      = new THREE.Matrix4();
const _finalMatrix     = new THREE.Matrix4();
const _zeroMatrix      = new THREE.Matrix4().makeScale(0, 0, 0);

class AircraftInstancer {
    constructor() {
        this.classes = {}; // classType -> { parts: [...], freeSlots: [], nextSlot: 0, scale }
        this._spinAngles = { x: 0, y: 0, z: 0 }; // shared accumulators, one per axis in use
        this._initialized = false;
    }

    // Builds the InstancedMesh set. Call once, after `scene` exists.
    init(scene) {
        if (this._initialized) return;
        this._initialized = true;

        for (const [classType, cls] of Object.entries(AIRCRAFT_CLASSES_VISUAL)) {
            const template = cls.builder(); // built once, never added to the scene
            const parts = [];

            template.children.forEach(child => {
                if (!child.isMesh) return; // skip nav-light/strobe? no — keep them, they're cheap & expected on-screen
                child.updateMatrix();

                const position    = child.position.clone();
                const rotation    = child.rotation.clone();
                const scale       = child.scale.clone();
                const spin        = SPIN_PARTS[child.name] || null;
                const isBodyPart  = child.userData.isBodyPart === true;
                const isTailPart  = child.userData.isTailPart === true;

                const mesh = new THREE.InstancedMesh(child.geometry, child.material, CAPACITY);
                mesh.count = CAPACITY;
                mesh.frustumCulled = false; // instances are spread across the whole map; per-class bounding sphere is meaningless
                mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
                for (let i = 0; i < CAPACITY; i++) mesh.setMatrixAt(i, _zeroMatrix);
                mesh.instanceMatrix.needsUpdate = true;

                // Initialise per-instance colour buffer (white = no tint by default).
                // Body parts receive the airline livery colour via setColorAt() in update();
                // non-body parts (engines, glow, nav lights) stay white so their own
                // material colour shows through unchanged.
                const _white = new THREE.Color(1, 1, 1);
                for (let i = 0; i < CAPACITY; i++) mesh.setColorAt(i, _white);
                if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

                scene.add(mesh);

                parts.push({ mesh, position, rotation, scale, spin, isBodyPart, isTailPart });
            });

            this.classes[classType] = {
                parts,
                scale: cls.scale,
                freeSlots: [],
                nextSlot: 0,
            };
        }
    }

    // Allocates a slot for a new aircraft of this class. Returns a handle to
    // pass to update()/free(), or null if this class is somehow at capacity
    // (shouldn't happen — FLIGHT.MAX_AIRCRAFT already caps total live aircraft
    // well below CAPACITY-per-class).
    spawn(classType) {
        const cls = this.classes[classType] || this.classes.COMMERCIAL;
        if (!cls) return null;
        const slot = cls.freeSlots.length ? cls.freeSlots.pop() : cls.nextSlot++;
        if (slot >= CAPACITY) return null;
        return { classType: this.classes[classType] ? classType : 'COMMERCIAL', slot };
    }

    // Releases a slot and zeroes its matrix in every part-mesh so it stops
    // contributing any visible geometry (instances aren't physically removed
    // from the InstancedMesh — mesh.count stays at CAPACITY — so an unused
    // slot must be explicitly degenerate-scaled or it'll show a stale plane
    // sitting wherever it was last positioned).
    free(handle) {
        if (!handle) return;
        const cls = this.classes[handle.classType];
        if (!cls) return;
        cls.parts.forEach(part => part.mesh.setMatrixAt(handle.slot, _zeroMatrix));
        cls.parts.forEach(part => { part.mesh.instanceMatrix.needsUpdate = true; });
        cls.freeSlots.push(handle.slot);
    }

    // Advances the shared rotor/prop spin accumulators. Call once per frame,
    // before any update() calls for that frame.
    tick(delta) {
        this._spinAngles.x = (this._spinAngles.x + delta * SPIN_PARTS.tail_rotor.speed) % (Math.PI * 2);
        this._spinAngles.y = (this._spinAngles.y + delta * SPIN_PARTS.main_rotor.speed) % (Math.PI * 2);
        this._spinAngles.z = (this._spinAngles.z + delta * SPIN_PARTS.prop_disc.speed) % (Math.PI * 2);
    }

    // Writes this aircraft's current world position + orientation into every
    // part-mesh's instance matrix for its slot. `visible=false` degenerate-
    // scales it (used when clusterManager hides individual aircraft at high
    // zoom) — cheaper than a branch in every consumer, and matches the old
    // `ship.visible = false` behavior visually.
    //
    // headingDeg/bankDeg/pitchDeg are the smoothed values flightManager.js's
    // tick() maintains per aircraft (currentHeadingDeg/bankDeg/pitchDeg) —
    // this method just turns them into a quaternion, it does no smoothing
    // itself. headingDeg=0/bankDeg=0/pitchDeg=0 (the defaults) reproduce the
    // old fixed-east orientation's yaw convention at heading 0.
    // spawnEase (0-1, default 1 = no animation) is flightManager.js's
    // linear spawn-progress value — see _easeOutBack above for the curve
    // applied to it.
    update(handle, position, visible, headingDeg = 0, bankDeg = 0, pitchDeg = 0, spawnEase = 1, bodyColor = null, tailColor = null) {
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

        // Yaw: heading 0°(north)=-Z, 90°(east)=+X — matches the dead-reckoning
        // math in flightManager.js's tick() and the prediction-line vector in
        // main.js (`dx=sin(hdg), dz=-cos(hdg)`). The model's local forward is
        // +Z, so the world-facing direction (sin h, -cos h) requires yaw =
        // Math.PI - headingRad (derived from the old fixed Math.PI/2 yaw that
        // happened to equal this formula's value at heading=90°/east).
        const headingRad = headingDeg * (Math.PI / 180);
        const yawRad      = Math.PI - headingRad;
        const pitchRad    = pitchDeg * (Math.PI / 180);
        const bankRad     = bankDeg  * (Math.PI / 180);
        _aircraftEuler.set(pitchRad, yawRad, bankRad, 'YXZ');
        _aircraftQuat.setFromEuler(_aircraftEuler);

        _aircraftPos.copy(position);
        const s = cls.scale * (spawnEase >= 1 ? 1 : Math.max(0, _easeOutBack(spawnEase)));
        _aircraftScale.set(s, s, s);
        _aircraftMatrix.compose(_aircraftPos, _aircraftQuat, _aircraftScale);

        cls.parts.forEach(part => {
            if (part.spin) {
                _partEuler.copy(part.rotation);
                _partEuler[part.spin.axis] += this._spinAngles[part.spin.axis];
                _partQuat.setFromEuler(_partEuler);
            } else {
                _partQuat.setFromEuler(part.rotation);
            }
            _partMatrix.compose(part.position, _partQuat, part.scale);
            _finalMatrix.copy(_aircraftMatrix).multiply(_partMatrix);
            part.mesh.setMatrixAt(handle.slot, _finalMatrix);
            part.mesh.instanceMatrix.needsUpdate = true;

            // Apply airline livery colours:
            //   isBodyPart → bodyColor  (fuselage, wings, stabs, pylons)
            //   isTailPart → tailColor if distinct, else bodyColor (vertical fin)
            // Engines, glow, nav lights, glass, lips keep their own material colour.
            if (part.isTailPart && part.mesh.instanceColor) {
                const tc = tailColor ?? bodyColor;
                if (tc) { part.mesh.setColorAt(handle.slot, tc); part.mesh.instanceColor.needsUpdate = true; }
            } else if (bodyColor && part.isBodyPart && part.mesh.instanceColor) {
                part.mesh.setColorAt(handle.slot, bodyColor);
                part.mesh.instanceColor.needsUpdate = true;
            }
        });
    }
}

export const aircraftInstancer = new AircraftInstancer();
