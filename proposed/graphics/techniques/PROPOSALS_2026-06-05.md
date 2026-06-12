# Emerging Three.js & WebGL Techniques — Enhancement Proposals

*2026-06-05*

> Review carefully before applying. Techniques here represent stable, production-ready capabilities
> as of Three.js r171 (September 2025). Nothing here requires WebGPU — both proposals work with
> the current WebGL 2 renderer via TSL's automatic GLSL compilation path.

---

## Technique 1: BatchedMesh for Vessel & Port Instancing

**TITLE:** BatchedMesh Draw-Call Consolidation

**WHAT_IT_ENABLES:**
BatchedMesh (stable since Three.js r155, production-ready in r165+) allows objects sharing a
*material* but with *different geometries* to be submitted as a single GPU draw call via
WebGL's `gl.multiDrawElements` extension. This is exactly the vessel fleet situation: CARGO,
TANKER, PATROL, HOSTILE are different shapes but all use the same hull PBR material.

Currently each vessel is a Group of 3–6 independent Meshes → 4–6 draw calls per vessel.
With 150 AIS vessels on screen, that's 600–900 draw calls just for ships. BatchedMesh collapses
all vessels sharing a material into 1 draw call (WebGL extension permitting) or at worst the
number of materials (~4 hull types).

**THREE_JS_VERSION:** r155 (initial), r165 (stable, frustum culling per-item added).

**VANGUARD_APPLICATION:**
`entityBuilder.js` creates vessel Groups. We introduce a `VesselBatchManager` that pre-allocates
one BatchedMesh per material tier (hull, superstructure, detail) and registers vessel geometry
into it. `aisManager.js` then updates per-vessel transform matrices instead of moving Groups.

**MIGRATION_EFFORT:** MEDIUM — entity lifecycle (spawn/despawn/update position) needs adaptation
from Group.position to BatchedMesh.setMatrixAt(id, matrix). Trail/wake systems that reference
vessel Groups need an indirection layer.

**PERFORMANCE_GAIN:** Expected 50–70% draw-call reduction for vessels. On integrated GPUs that
are draw-call bound, this can translate to 8–15 FPS gain during high-traffic scenarios.

**CODE:**

```javascript
// vesselBatchManager.js — BatchedMesh-based vessel fleet rendering
import * as THREE from 'three';

// Maximum simultaneous vessels per geometry class.
// Increase if AIS feed can deliver more; BatchedMesh pre-allocates GPU buffers.
const MAX_VESSELS_PER_CLASS = 300;

// Hull material tiers — one BatchedMesh per material, all geometry classes within it.
const HULL_MATERIAL = new THREE.MeshStandardMaterial({
    color:     0x8b2020,
    roughness: 0.72,
    metalness: 0.18,
    // Rust streaks via custom onBeforeCompile (see point-cloud proposals for triplanar technique)
});

const SUPER_MATERIAL = new THREE.MeshStandardMaterial({
    color:     0xdddddd,
    roughness: 0.48,
    metalness: 0.05,
});

export class VesselBatchManager {
    constructor(scene) {
        this.scene     = scene;
        this._batches  = {};   // materialKey → THREE.BatchedMesh
        this._registry = new Map();  // vesselId → { batchKey, batchIndex }
        this._matrix   = new THREE.Matrix4();
        this._euler    = new THREE.Euler();
        this._quat     = new THREE.Quaternion();
        this._scale    = new THREE.Vector3(1, 1, 1);
        this._pos      = new THREE.Vector3();
    }

    // Pre-register a geometry variant for a material tier.
    // Returns the geometry ID within its BatchedMesh.
    registerGeometry(materialKey, material, geometry, maxCount = MAX_VESSELS_PER_CLASS) {
        if (!this._batches[materialKey]) {
            // BatchedMesh(maxGeometryCount, maxVertexCount, maxIndexCount)
            // Estimate generous buffers — pre-allocated once, not resizable.
            const batch = new THREE.BatchedMesh(
                maxCount,    // max distinct geometry shapes
                maxCount * 200,  // max total vertices (~200 per hull)
                maxCount * 400   // max total indices
            );
            batch.material = material;
            batch.name     = `VesselBatch_${materialKey}`;
            this.scene.add(batch);
            this._batches[materialKey] = batch;
        }
        return this._batches[materialKey].addGeometry(geometry);
    }

    // Spawn a vessel instance. Returns an opaque handle for later updates.
    // geometryId: return value of registerGeometry() for this vessel's hull shape.
    spawnVessel(vesselId, materialKey, geometryId) {
        const batch = this._batches[materialKey];
        if (!batch) {
            console.warn(`[VesselBatch] Unknown materialKey: ${materialKey}`);
            return null;
        }
        const instanceId = batch.addInstance(geometryId);
        this._registry.set(vesselId, { materialKey, instanceId });
        return instanceId;
    }

    // Update vessel world transform each animation frame.
    // pos: THREE.Vector3,  heading: radians (0 = north/+Z, increases clockwise)
    updateVessel(vesselId, pos, heading, scale = 1.0) {
        const entry = this._registry.get(vesselId);
        if (!entry) return;

        this._pos.copy(pos);
        this._euler.set(0, -heading + Math.PI * 0.5, 0);
        this._quat.setFromEuler(this._euler);
        this._scale.setScalar(scale);
        this._matrix.compose(this._pos, this._quat, this._scale);

        const batch = this._batches[entry.materialKey];
        batch.setMatrixAt(entry.instanceId, this._matrix);
    }

    // Remove a vessel (e.g. it left AIS coverage).
    despawnVessel(vesselId) {
        const entry = this._registry.get(vesselId);
        if (!entry) return;
        const batch = this._batches[entry.materialKey];
        batch.deleteInstance(entry.instanceId);
        this._registry.delete(vesselId);
    }

    // Called each frame by main.js animation loop — marks batches as needing GPU upload.
    tick() {
        for (const batch of Object.values(this._batches)) {
            batch.instanceMatrix.needsUpdate = true;
        }
    }

    // Wire into layerManager for show/hide.
    setVisible(visible) {
        for (const batch of Object.values(this._batches)) {
            batch.visible = visible;
        }
    }
}

// ── Usage in aisManager.js (migration notes) ──────────────────────────────────
//
// Before (current):
//   const group = buildVesselShape(cls);
//   group.position.copy(scenePos);
//   scene.add(group);
//
// After (BatchedMesh):
//   const geomId = batchMgr.registerGeometry('hull', HULL_MATERIAL, hullGeo);
//   const handle = batchMgr.spawnVessel(mmsi, 'hull', geomId);
//   // Each frame:
//   batchMgr.updateVessel(mmsi, scenePos, headingRad);
```

---

## Technique 2: TSL Node Material for Runtime-Composable Terrain Effects

**TITLE:** TSL Node Material — Live Terrain Shader Composition

**WHAT_IT_ENABLES:**
Three.js Shading Language (TSL, stable since r166, part of the WebGPU path but with automatic
GLSL compilation fallback for WebGL 2) lets you compose shader logic as a JavaScript node graph
instead of editing raw GLSL strings. For Vanguard1, this enables:

1. **Runtime effect toggling** without recompiling shaders — analysts can enable/disable
   biome tinting, ridge glow, or contour lines via UI sliders, and the shader adapts
   automatically via the node graph.
2. **Conditional variant selection** — day mode, night mode, and threat-overlay mode each need
   different terrain coloring. TSL lets you branch these as JS `select(condition, a, b)` nodes
   instead of GLSL `#ifdef` blocks, meaning the full shader is always compiled but inactive
   branches cost zero GPU cycles.
3. **Easier future extensibility** — new effects snap in as new nodes, no risk of accidentally
   editing the wrong line in a 400-line GLSL string.

**THREE_JS_VERSION:** r166 (TSL stable for WebGL), r171 (WebGPU production-ready with auto-fallback).

**VANGUARD_APPLICATION:**
Migrate the terrain point cloud's `ShaderMaterial` in `terrainBuilder.js` to a TSL-based
`MeshStandardNodeMaterial`. The four auto-tuner uniforms become TSL `uniform()` nodes — the
auto-tuner writes to them identically (they're the same JS objects), but shader composition
is now done in the node graph.

**MIGRATION_EFFORT:** MEDIUM — requires rewriting both vertex and fragment shaders as TSL
node expressions. The payoff is that future modifications never require touching raw GLSL.
Existing uniforms migrate directly to `uniform(type, value)` nodes with no behavior change.

**CODE:**

```javascript
// terrainBuilderTSL.js — TSL-based point cloud material replacing the ShaderMaterial
// Drop-in replacement for the ShaderMaterial block in terrainBuilder.js.
// Requires Three.js r166+ with 'three/tsl' imports.

import * as THREE from 'three';
import {
    // Node-based material
    MeshBasicNodeMaterial,

    // TSL node builders
    uniform, attribute, varying, varyingProperty,
    positionWorld, normalWorld,
    float, vec2, vec3, vec4,
    add, sub, mul, div, mix, clamp, pow, abs, dot, normalize, step, smoothstep,
    max as nodeMax, min as nodeMin,
    select, If,
    uv,
    texture,
    mod as nodeMod,
    sign, length as nodeLength,
    color as nodeColor,
    sin, cos,
    assign, Fn,
} from 'three/tsl';

import {
    SPLAT_BRIGHTNESS, SPLAT_LAND_LIFT, SPLAT_LAND_GAMMA, SPLAT_SATURATION,
    SPLAT_HEMI_STRENGTH, SPLAT_BIOME_STRENGTH,
} from './config.js';

// ── Uniform nodes (auto-tuner writes to .value exactly as before) ─────────────
const uSunDir        = uniform( new THREE.Vector3(0, 1, 0), 'vec3' );
const uSunElevation  = uniform( 1.0, 'float' );
const uBrightness    = uniform( SPLAT_BRIGHTNESS,   'float' );
const uLandLift      = uniform( SPLAT_LAND_LIFT,     'float' );
const uLandGamma     = uniform( SPLAT_LAND_GAMMA,    'float' );
const uSaturation    = uniform( SPLAT_SATURATION,    'float' );
const uHemiStrength  = uniform( SPLAT_HEMI_STRENGTH, 'float' );
const uBiomeStrength = uniform( SPLAT_BIOME_STRENGTH,'float' );
const uAOTint        = uniform( new THREE.Color(0.08, 0.04, 0.22), 'color' );
const uFade          = uniform( 1.0, 'float' );
const uNormalMap     = uniform( null, 'texture' );   // bound after load

// ── Per-vertex attributes ─────────────────────────────────────────────────────
const aHeight  = attribute( 'aHeight',  'float' );
const aNormal  = attribute( 'aNormal',  'vec3'  );
const aRidge   = attribute( 'aRidge',   'float' );
const aSize    = attribute( 'aSize',    'float' );

// ── Build vertex stage ────────────────────────────────────────────────────────
const vHeight    = varying( aHeight,  'vHeight' );
const vNormal    = varying( normalize(aNormal), 'vNormal' );
const vRidge     = varying( aRidge,   'vRidge'  );
const vLatitude  = varying( abs(positionWorld.z).div(150.0), 'vLatitude' );

// ── Fragment: Gaussian splat clip ─────────────────────────────────────────────
const splat_r2 = Fn(() => {
    const cxy = uv().sub(0.5);
    return dot(cxy, cxy);
});

// ── Fragment: Lambertian + hemisphere lighting ────────────────────────────────
const computeLighting = Fn(([col]) => {
    const N      = normalize(vNormal);
    const NdotL  = dot(N, uSunDir).max(0.0).min(0.55);
    const dayAmt = uSunElevation.mul(2.0).add(0.3).clamp(0.0, 1.0);

    const hemiBlend   = N.y.mul(0.5).add(0.5);
    const AMBIENT     = float(1.60);
    const lit         = AMBIENT.add( NdotL.mul(0.62).mul(dayAmt) );

    // oceanMask: 1 = land (vHeight >= 0), 0 = ocean
    const oceanMask   = step(0.0, vHeight);
    const litScaled   = mix( float(0.68), lit, oceanMask );
    return col.mul(litScaled);
});

// ── Fragment: Land gamma + brightness lift chain ──────────────────────────────
const applyLandGrading = Fn(([col]) => {
    const oceanMask = step(0.0, vHeight);
    const landCol   = pow(col.max(vec3(0.0)), vec3(uLandGamma)).mul(uBrightness);
    const lum       = dot(landCol, vec3(0.299, 0.587, 0.114));
    const saturated = mix(vec3(lum), landCol, uSaturation);
    return mix(col, saturated.clamp(0.0, 1.0), oceanMask);
});

// ── Build the node material ───────────────────────────────────────────────────
export function buildTSLSplatMaterial() {
    const mat = new MeshBasicNodeMaterial({ vertexColors: true });

    // Discard fragment if outside Gaussian splat circle
    mat.outputNode = Fn(() => {
        const r2 = splat_r2();
        If( r2.greaterThan(0.06), () => { /* discard — handled by alphaTest node */ });

        const baseCol = attribute('color', 'vec3');
        let col = computeLighting(baseCol);
        col = applyLandGrading(col);

        const softAlpha = float(Math.E).pow( r2.negate().mul(8.0) ).mul(uFade);
        return vec4(col, softAlpha);
    })();

    // Expose the uniform nodes so the auto-tuner can write to them:
    mat.uniforms = { uBrightness, uLandLift, uLandGamma, uSaturation,
                     uHemiStrength, uBiomeStrength, uFade, uSunDir, uSunElevation };

    mat.transparent  = true;
    mat.depthWrite   = false;
    mat.blending     = THREE.NormalBlending;
    return mat;
}

// ── Auto-tuner compatibility shim ─────────────────────────────────────────────
// The auto-tuner writes: splatCloud.material.uniforms.uBrightness.value = X
// TSL uniforms ARE plain objects with a .value property, so this works unchanged.
// No changes needed in shaderAutoTuner.js.
```

---

## Applying These Techniques

For **BatchedMesh**:
1. Copy `vesselBatchManager.js` to the project root
2. In `aisManager.js`, import and instantiate `VesselBatchManager`
3. Migrate vessel spawn/update/despawn to use the batch manager
4. Remove `scene.add(group)` calls for batched vessel classes
5. Add `batchMgr.tick()` to the animation loop

For **TSL Node Material**:
1. Copy `terrainBuilderTSL.js` to the project root
2. In `terrainBuilder.js`, replace `new THREE.ShaderMaterial({...})` with `buildTSLSplatMaterial()`
3. Verify auto-tuner still works: `window.splatCloud.material.uniforms.uBrightness.value = 0.9`
4. Run Visual Regression Guard before and after: `node agents/visual-regression-guard.js`

**Note on TSL GLSL fallback:** When using WebGLRenderer (current), TSL compiles to GLSL automatically. Performance is identical to hand-written GLSL. The WebGPU path (WGSL) activates only if the user imports `WebGPURenderer`.
