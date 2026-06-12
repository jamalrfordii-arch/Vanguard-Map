// instancedSatManager.js — GPU-instanced rendering for satellite constellations
//
// Architecture
// ────────────
//   • One InstancedMesh per satellite TYPE (STARLINK, GPS, GALILEO, WEATHER,
//     MILITARY, GENERIC) — one draw call per constellation instead of one per
//     satellite.  400 Starlinkâ¤†→â†' 1 draw call; ~600 total satellites â†' ~6 calls.
//
//   • Each satellite gets a tiny invisible hit-sphere (4-face SphereGeometry)
//     that lives in the scene and carries the usual userData.  This proxy is
//     pushed into window.aisShips so all existing raycasting/tooltip/detail
//     panel code works unchanged.
//
//   • STATION (ISS) returns null from acquire() — caller falls back to
//     createSatelliteObject() for that single high-fidelity model.
//
// Performance headroom
// ────────────────────
//   Each pool is pre-allocated at MAX size.  Unused slots get scale(0,0,0)
//   so they're invisible but don't cause draw-call overhead.  Slots are
//   reused via a free-list stack (O(1) acquire/release).
//
// Public API
// ──────────
//   instSatManager.acquire(data, scene)  →  proxyMesh | null
//   instSatManager.updatePosition(proxy, x, y, z, headingDeg)
//   instSatManager.release(proxy)
//   instSatManager.dispose()
import * as THREE from 'three';
import { SAT_COLORS, SAT_HTML_COLORS } from './satelliteBuilder.js';

// ── Pool configuration ────────────────────────────────────────────────────────
// geo: factory fn returning the primary body geometry for instancing.
// The geometry is intentionally simple — at tactical-map scale, sub-unit detail
// is invisible and wastes vertex budget.
const TYPE_CONFIG = {
    STARLINK: {
        max: 400,
        geo: () => new THREE.BoxGeometry(0.70, 0.06, 0.40),
    },
    GPS: {
        max:  60,
        geo: () => new THREE.CylinderGeometry(0.20, 0.20, 0.38, 6),
    },
    GALILEO: {
        max:  40,
        geo: () => new THREE.CylinderGeometry(0.20, 0.20, 0.38, 6),
    },
    WEATHER: {
        max:  40,
        geo: () => new THREE.BoxGeometry(0.45, 0.45, 0.45),
    },
    MILITARY: {
        max:  30,
        geo: () => new THREE.BoxGeometry(0.28, 0.28, 1.10),
    },
    GENERIC: {
        max: 200,
        geo: () => new THREE.BoxGeometry(0.38, 0.38, 0.38),
    },
};

// ── Reusable temporaries (avoid per-frame allocation) ─────────────────────────
const _pos   = new THREE.Vector3();
const _quat  = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _scaleZero = new THREE.Vector3(0, 0, 0);
const _mat4  = new THREE.Matrix4();
const _axis  = new THREE.Vector3(0, 1, 0);

// ── InstancedSatManager ───────────────────────────────────────────────────────
export class InstancedSatManager {
    constructor(scene) {
        this._scene  = scene;
        this._pools  = {};            // type → { mesh, free[] }
        this._slotOf = new Map();     // proxy → { type, index }

        for (const [type, cfg] of Object.entries(TYPE_CONFIG)) {
            const geo = cfg.geo();

            // MeshStandardMaterial with emissive so satellites stay visible at
            // low ambient (the tactical night-side has 0.12 ambient intensity).
            const color = SAT_COLORS[type] ?? 0x999999;
            const mat = new THREE.MeshStandardMaterial({
                color,
                roughness:         0.40,
                metalness:         0.65,
                emissive:          color,
                emissiveIntensity: 0.20,
            });

            const mesh = new THREE.InstancedMesh(geo, mat, cfg.max);
            mesh.count = 0;   // high-water mark — raised as slots are acquired
            mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            mesh.name  = `instSat_${type}`;
            mesh.frustumCulled = false;  // dome-sized pooling — never frustum-cull

            // Initialise all slots as invisible (scale 0)
            _mat4.makeScale(0, 0, 0);
            for (let i = 0; i < cfg.max; i++) mesh.setMatrixAt(i, _mat4);
            mesh.instanceMatrix.needsUpdate = true;

            scene.add(mesh);

            // Free-list: highest index first (stack-pop = low latency)
            this._pools[type] = {
                mesh,
                free: Array.from({ length: cfg.max }, (_, i) => cfg.max - 1 - i),
            };
        }
    }

    // ── acquire ───────────────────────────────────────────────────────────────
    // Returns a tiny invisible THREE.Mesh that:
    //   - Has the full userData set that tooltips / detail panels expect
    //   - Can be raycasted by the existing intersectObjects(aisShips, true) call
    //   - Internally maps to a slot in the InstancedMesh for visual rendering
    //
    // Returns null for STATION (ISS) — caller uses full createSatelliteObject().
    acquire(data, scene) {
        const type = data.type;
        if (!this._pools[type]) return null;   // STATION or unknown

        const pool = this._pools[type];
        if (pool.free.length === 0) {
            console.warn(`[InstSat] Pool exhausted for type ${type} — falling back`);
            return null;
        }

        const slotIndex = pool.free.pop();

        // Extend the draw-call high-water mark if this slot is beyond it
        if (slotIndex >= pool.mesh.count) pool.mesh.count = slotIndex + 1;

        // ── Hit-sphere proxy ──────────────────────────────────────────────────
        // 4 segments = 8 tris — cheapest possible raycasting target.
        // material.visible = false → not rendered, only used for raycasting.
        const hitGeo  = new THREE.SphereGeometry(0.9, 4, 2);
        const hitMat  = new THREE.MeshBasicMaterial({ visible: false });
        const proxy   = new THREE.Mesh(hitGeo, hitMat);

        proxy.userData = {
            id:              data.id,
            displayName:     data.name,
            class:           type,
            htmlColor:       SAT_HTML_COLORS[type] ?? '#999999',
            isRealSatellite: true,
            isSatellite:     true,
            speedKts:        0,
            altKm:           data.altKm   ?? 400,
            latDeg:          data.latDeg  ?? 0,
            lonDeg:          data.lonDeg  ?? 0,
            history:         [],
            trail:           null,     // registered by caller via trailManager
            // Internal instancing bookmarks (used by updatePosition / release)
            _instType:  type,
            _instIndex: slotIndex,
        };

        scene.add(proxy);
        this._slotOf.set(proxy, { type, index: slotIndex });
        return proxy;
    }

    // ── updatePosition ────────────────────────────────────────────────────────
    // Moves both the hit-sphere (raycasting) and the InstancedMesh slot (visual).
    // headingDeg may be null/undefined — falls back to no rotation.
    updatePosition(proxy, x, y, z, headingDeg) {
        if (!proxy) return;

        // Hit-sphere — keeps the raycaster + tooltip in sync
        proxy.position.set(x, y, z);

        const slot = this._slotOf.get(proxy);
        if (!slot) return;

        const pool = this._pools[slot.type];
        if (!pool) return;

        _pos.set(x, y, z);

        if (headingDeg != null) {
            _quat.setFromAxisAngle(_axis, -headingDeg * (Math.PI / 180));
        } else {
            _quat.identity();
        }

        _mat4.compose(_pos, _quat, _scale);
        pool.mesh.setMatrixAt(slot.index, _mat4);
        pool.mesh.instanceMatrix.needsUpdate = true;
    }

    // ── release ───────────────────────────────────────────────────────────────
    // Hides the slot (scale 0) and returns it to the free-list.
    release(proxy) {
        if (!proxy) return;

        const slot = this._slotOf.get(proxy);
        if (!slot) return;

        const pool = this._pools[slot.type];
        if (pool) {
            _mat4.makeScale(0, 0, 0);
            pool.mesh.setMatrixAt(slot.index, _mat4);
            pool.mesh.instanceMatrix.needsUpdate = true;
            pool.free.push(slot.index);
        }

        this._scene.remove(proxy);
        proxy.geometry.dispose();
        proxy.material.dispose();
        this._slotOf.delete(proxy);
    }

    // ── dispose ───────────────────────────────────────────────────────────────
    dispose() {
        for (const pool of Object.values(this._pools)) {
            pool.mesh.geometry.dispose();
            pool.mesh.material.dispose();
            this._scene.remove(pool.mesh);
        }
        this._pools  = {};
        // Release all proxies still in the map
        for (const proxy of this._slotOf.keys()) {
            this._scene.remove(proxy);
            proxy.geometry.dispose();
            proxy.material.dispose();
        }
        this._slotOf.clear();
    }
}
