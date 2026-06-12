// trailManager.js — GPU ring-buffer particle trails
//
// Replaces the per-entity CPU history[] + setFromPoints() pattern with a single
// DataTexture ring buffer. Each live entity occupies one row of the texture;
// only the newest position sample is written per frame (16 bytes per entity),
// vs the old approach which uploaded the entire trail on every tick.
//
// Architecture
// ─────────────
//   tTrailBuffer  RGBA float32  [MAX_TRAIL_LEN × MAX_ENTITIES]
//     row  = entity slot
//     col  = ring-buffer sample (x, y, z, valid)
//
//   tHeadPtrs     RGBA float32  [MAX_ENTITIES × 1]
//     .x = headPtr   (next write index, 0..MAX_TRAIL_LEN-1)
//     .y = fillCount (how many valid samples exist, caps at MAX_TRAIL_LEN)
//
//   tColors       RGBA float32  [MAX_ENTITIES × 1]
//     .rgb = trail colour per entity
//
//   Trail mesh: THREE.Points — one point vertex per ring-buffer cell.
//     Vertex shader reads world position directly from tTrailBuffer and fades
//     alpha by age (quadratic rolloff from newest → oldest sample).
//     Vertices for empty / invalid slots are moved off-screen.
//
// CPU cost per frame: O(activeEntities) float writes into the DataTexture
//   + ONE glTexImage2D upload for the whole buffer.
//   Old cost was O(entities × trailLen) buffer sub-data calls.

import * as THREE from 'three';

export const MAX_ENTITIES  = 256;  // enough for ~100 ships + ~80 aircraft + ~20 sats + margin
export const MAX_TRAIL_LEN = 96;   // covers ships(60), aircraft(80), sats(24), simulated(40)

// ── Vertex shader ─────────────────────────────────────────────────────────────
// Three.js injects: projectionMatrix, modelViewMatrix, position (attr).
// Custom uniforms/attrs declared here.
const TRAIL_VERT = /* glsl */`
    uniform sampler2D tTrailBuffer;
    uniform sampler2D tColors;
    uniform sampler2D tHeadPtrs;
    uniform float uMaxTrailLen;
    uniform float uMaxEntities;

    attribute float aEntityIdx;
    attribute float aSampleIdx;

    varying vec3  vColor;
    varying float vAlpha;

    void main() {
        float eid = aEntityIdx;
        float sid = aSampleIdx;

        // ── Read head / fill-count for this entity ────────────────────────────
        vec2 headUv    = vec2((eid + 0.5) / uMaxEntities, 0.5);
        vec4 hi        = texture2D(tHeadPtrs, headUv);
        float head      = hi.x;
        float fillCount = hi.y;

        // Cull: entity slot empty, or this sample is beyond fill count
        if (fillCount < 1.0 || sid >= fillCount) {
            gl_Position  = vec4(2.0, 2.0, 2.0, 1.0);
            gl_PointSize = 0.0;
            vAlpha       = 0.0;
            vColor       = vec3(0.0);
            return;
        }

        // ── Map sample-age-offset → ring-buffer column ────────────────────────
        // sid == 0 → the most-recently-written sample (head - 1, wrapped).
        // Multiply uMaxTrailLen by 4 to ensure mod argument stays positive.
        float ringIdx = mod(head - 1.0 - sid + uMaxTrailLen * 4.0, uMaxTrailLen);
        vec2  trailUv = vec2((ringIdx + 0.5) / uMaxTrailLen,
                             (eid    + 0.5) / uMaxEntities);
        vec4  samp    = texture2D(tTrailBuffer, trailUv);

        // Cull invalid (never-written) slots
        if (samp.w < 0.5) {
            gl_Position  = vec4(2.0, 2.0, 2.0, 1.0);
            gl_PointSize = 0.0;
            vAlpha       = 0.0;
            vColor       = vec3(0.0);
            return;
        }

        // ── Alpha: quadratic rolloff from newest → oldest ─────────────────────
        float t = sid / max(fillCount - 1.0, 1.0);   // 0 = newest, 1 = oldest
        vAlpha  = (1.0 - t) * (1.0 - t) * 0.72;

        // ── Entity colour ─────────────────────────────────────────────────────
        vec2 colorUv = vec2((eid + 0.5) / uMaxEntities, 0.5);
        vColor       = texture2D(tColors, colorUv).rgb;

        // ── Screen-space point size scales with view distance ─────────────────
        vec4  mvPos  = modelViewMatrix * vec4(samp.xyz, 1.0);
        float dist   = length(mvPos.xyz);
        gl_PointSize = max(0.5, (1.0 - t * 0.6) * 3.2 * (140.0 / max(dist, 5.0)));
        gl_Position  = projectionMatrix * mvPos;
    }
`;

// ── Fragment shader ────────────────────────────────────────────────────────────
const TRAIL_FRAG = /* glsl */`
    varying vec3  vColor;
    varying float vAlpha;

    void main() {
        if (vAlpha < 0.01) discard;

        // Soft-circle point sprite — radial fade toward edge
        vec2  uv = gl_PointCoord * 2.0 - 1.0;
        float r  = dot(uv, uv);
        if (r > 1.0) discard;

        gl_FragColor = vec4(vColor, vAlpha * (1.0 - r * 0.55));
    }
`;

// ── TrailManager ──────────────────────────────────────────────────────────────
export class TrailManager {
    constructor(scene) {
        this._scene      = scene;

        // Free slot stack — entities take a slot on register, return it on unregister
        this._freeSlots  = [];
        for (let i = MAX_ENTITIES - 1; i >= 0; i--) this._freeSlots.push(i);

        this._entityMap  = new Map();                        // Object3D → slotIdx
        this._headPtrs   = new Float32Array(MAX_ENTITIES);   // next-write ring index
        this._fillCounts = new Float32Array(MAX_ENTITIES);   // valid samples so far

        // Upload throttle — textures are dirty-flagged by pushPosition but only
        // uploaded to the GPU every 6th frame via tick().  Ships move slowly
        // enough that 6-frame trail sampling (~10 Hz at 60 fps) is visually
        // imperceptible while reducing GPU texture traffic by ~83 %.
        this._frameCount  = 0;
        this._trailDirty  = false;
        this._headDirty   = false;

        // ── Ring-buffer DataTexture ───────────────────────────────────────────
        this._trailData = new Float32Array(MAX_TRAIL_LEN * MAX_ENTITIES * 4);
        this._trailTex  = new THREE.DataTexture(
            this._trailData, MAX_TRAIL_LEN, MAX_ENTITIES,
            THREE.RGBAFormat, THREE.FloatType
        );
        this._trailTex.magFilter = THREE.NearestFilter;
        this._trailTex.minFilter = THREE.NearestFilter;
        this._trailTex.needsUpdate = true;

        // ── Head-pointer DataTexture (MAX_ENTITIES × 1) ───────────────────────
        this._headData = new Float32Array(MAX_ENTITIES * 4);
        this._headTex  = new THREE.DataTexture(
            this._headData, MAX_ENTITIES, 1,
            THREE.RGBAFormat, THREE.FloatType
        );
        this._headTex.magFilter = THREE.NearestFilter;
        this._headTex.minFilter = THREE.NearestFilter;
        this._headTex.needsUpdate = true;

        // ── Per-entity colour DataTexture (MAX_ENTITIES × 1) ─────────────────
        this._colorData = new Float32Array(MAX_ENTITIES * 4);
        this._colorTex  = new THREE.DataTexture(
            this._colorData, MAX_ENTITIES, 1,
            THREE.RGBAFormat, THREE.FloatType
        );
        this._colorTex.magFilter = THREE.NearestFilter;
        this._colorTex.minFilter = THREE.NearestFilter;
        this._colorTex.needsUpdate = true;

        this._buildMesh();
    }

    // ── _buildMesh ────────────────────────────────────────────────────────────
    // One vertex per ring-buffer cell: entity × MAX_TRAIL_LEN vertices.
    // The vertex shader retrieves the world position from the DataTexture.
    _buildMesh() {
        const totalVerts = MAX_ENTITIES * MAX_TRAIL_LEN;
        const aEntity    = new Float32Array(totalVerts);
        const aSample    = new Float32Array(totalVerts);
        const dummyPos   = new Float32Array(totalVerts * 3); // all zero — overridden by shader

        for (let e = 0; e < MAX_ENTITIES; e++) {
            for (let s = 0; s < MAX_TRAIL_LEN; s++) {
                const v    = e * MAX_TRAIL_LEN + s;
                aEntity[v] = e;
                aSample[v] = s;
            }
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position',   new THREE.BufferAttribute(dummyPos, 3));
        geo.setAttribute('aEntityIdx', new THREE.BufferAttribute(aEntity,  1));
        geo.setAttribute('aSampleIdx', new THREE.BufferAttribute(aSample,  1));

        this._mat = new THREE.ShaderMaterial({
            uniforms: {
                tTrailBuffer: { value: this._trailTex  },
                tColors:      { value: this._colorTex  },
                tHeadPtrs:    { value: this._headTex   },
                uMaxTrailLen: { value: MAX_TRAIL_LEN   },
                uMaxEntities: { value: MAX_ENTITIES    },
            },
            vertexShader:   TRAIL_VERT,
            fragmentShader: TRAIL_FRAG,
            transparent:    true,
            depthWrite:     false,
            blending:       THREE.AdditiveBlending,
        });

        this._mesh              = new THREE.Points(geo, this._mat);
        this._mesh.frustumCulled = false;
        this._mesh.renderOrder  = 8;   // after solid geometry, before HUD overlays
        this._scene.add(this._mesh);
    }

    // ── register ──────────────────────────────────────────────────────────────
    // Call once when an entity enters the scene.
    // color: CSS string '#rrggbb' or numeric 0xRRGGBB.
    register(entity, color) {
        if (this._entityMap.has(entity)) return;
        if (this._freeSlots.length === 0) {
            console.warn('[TrailManager] no free entity slots');
            return;
        }

        const idx = this._freeSlots.pop();
        this._entityMap.set(entity, idx);
        this._headPtrs[idx]   = 0;
        this._fillCounts[idx] = 0;

        // Colour
        const c  = new THREE.Color(color);
        const ci = idx * 4;
        this._colorData[ci]   = c.r;
        this._colorData[ci+1] = c.g;
        this._colorData[ci+2] = c.b;
        this._colorData[ci+3] = 1.0;
        this._colorTex.needsUpdate = true;

        // Clear any stale ring-buffer data for this slot
        const offset = idx * MAX_TRAIL_LEN * 4;
        this._trailData.fill(0, offset, offset + MAX_TRAIL_LEN * 4);
        const hi = idx * 4;
        this._headData[hi] = this._headData[hi+1] = 0;
        this._trailTex.needsUpdate = true;
        this._headTex.needsUpdate  = true;
    }

    // ── unregister ────────────────────────────────────────────────────────────
    // Call when the entity is removed from the scene.
    unregister(entity) {
        const idx = this._entityMap.get(entity);
        if (idx === undefined) return;

        // Zero out the slot so its vertices are culled next frame
        const offset = idx * MAX_TRAIL_LEN * 4;
        this._trailData.fill(0, offset, offset + MAX_TRAIL_LEN * 4);
        const hi = idx * 4;
        this._headData[hi] = this._headData[hi+1] = 0;
        this._fillCounts[idx] = 0;
        this._headPtrs[idx]   = 0;

        this._trailTex.needsUpdate = true;
        this._headTex.needsUpdate  = true;

        this._freeSlots.push(idx);
        this._entityMap.delete(entity);
    }

    // ── pushPosition ──────────────────────────────────────────────────────────
    // Hot path — call every frame (or on a throttled cadence for slow entities).
    // Writes one (x, y, z, 1) sample to the ring buffer and advances the head.
    pushPosition(entity, x, y, z) {
        const idx = this._entityMap.get(entity);
        if (idx === undefined) return;

        const head   = this._headPtrs[idx];
        const offset = (idx * MAX_TRAIL_LEN + head) * 4;

        this._trailData[offset]   = x;
        this._trailData[offset+1] = y;
        this._trailData[offset+2] = z;
        this._trailData[offset+3] = 1.0;  // valid flag

        const next = (head + 1) % MAX_TRAIL_LEN;
        this._headPtrs[idx] = next;
        if (this._fillCounts[idx] < MAX_TRAIL_LEN) this._fillCounts[idx]++;

        // Sync head texture
        const hi = idx * 4;
        this._headData[hi]   = next;
        this._headData[hi+1] = this._fillCounts[idx];

        // Mark dirty — actual GPU upload is deferred to tick() every 3 frames.
        this._trailDirty = true;
        this._headDirty  = true;
    }

    // ── tick ──────────────────────────────────────────────────────────────────
    // Call once per animation frame (main.js animate loop).
    // Uploads dirty DataTextures to the GPU every 6th frame (~10 Hz at 60 fps),
    // reducing texture traffic by ~83 % with no perceptible visual change.
    tick() {
        this._frameCount = (this._frameCount + 1) % 6;
        if (this._frameCount !== 0) return;

        if (this._trailDirty) {
            this._trailTex.needsUpdate = true;
            this._trailDirty = false;
        }
        if (this._headDirty) {
            this._headTex.needsUpdate = true;
            this._headDirty = false;
        }
    }

    // ── Accessors ─────────────────────────────────────────────────────────────
    get mesh() { return this._mesh; }

    // Returns true when the entity has at least one sample pushed
    hasTrail(entity) {
        const idx = this._entityMap.get(entity);
        return idx !== undefined && this._fillCounts[idx] > 0;
    }

    /**
     * CPU read-back of the trail ring-buffer for a given entity.
     * Returns positions in chronological order (oldest → newest).
     * Each entry is { x, z } in scene coordinates.
     * Returns [] if the entity is not registered or has no samples.
     */
    getPositions(entity) {
        const idx = this._entityMap.get(entity);
        if (idx === undefined) return [];

        const fillCount = this._fillCounts[idx];
        if (fillCount === 0) return [];

        const head    = this._headPtrs[idx];
        const results = [];

        // age 0 = newest, age fillCount-1 = oldest
        // iterate oldest-first for chronological output
        for (let age = fillCount - 1; age >= 0; age--) {
            const ringIdx = (head - 1 - age + MAX_TRAIL_LEN * 4) % MAX_TRAIL_LEN;
            const off     = (idx * MAX_TRAIL_LEN + ringIdx) * 4;
            if (this._trailData[off + 3] >= 0.5) {   // valid flag
                results.push({ x: this._trailData[off], z: this._trailData[off + 2] });
            }
        }

        return results;
    }

    dispose() {
        this._scene.remove(this._mesh);
        this._mesh.geometry.dispose();
        this._mat.dispose();
        this._trailTex.dispose();
        this._headTex.dispose();
        this._colorTex.dispose();
    }
}
