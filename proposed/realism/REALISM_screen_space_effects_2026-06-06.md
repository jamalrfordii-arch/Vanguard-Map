# Realism: Screen Space Effects (SSAO, SSR, SSGI)

*2026-06-06*

> UE5 Equivalent: Lumen (Screen Space), SSAO, Screen Space Reflections



# Implementation Report: Screen Space Effects (SSAO, SSR, SSGI)

## UE5 vs WebGL2 Comparison

| Feature | UE5 Lumen | WebGL2 / Three.js r184 | Gap |
|---|---|---|---|
| **SSAO** | GTAO + temporal accumulation, full-res, ~50 samples, denoised | N8AO half-res + depth-aware upscale, 16 samples, spatial denoise | ~70% quality achievable |
| **SSR** | Hi-Z traced, temporal reprojection, roughness-aware, fallback to Lumen probes | Custom screen-space raymarch, 16–32 steps, no fallback probe system | ~40% quality — major gap |
| **SSGI** | Full radiosity bounce, multi-bounce, denoised, temporal | AO color tinting as crude GI approximation | ~15% quality — honest gap |
| **Temporal stability** | TAA + temporal reprojection on all effects | TAA pass exists but effects are per-frame | Shimmer visible |
| **Performance** | GPU compute, async, variable rate shading | Fragment shader only, no compute, no VRS | 2–3× less efficient |

**Honest assessment:** We can get compelling SSAO that rivals UE5's at medium settings. SSR will be limited to the water plane and smooth surfaces. True SSGI is not feasible in WebGL2 fragment shaders at 60fps — we use AO color tinting as the approximation.

## Chosen Approach

1. **N8AO** for ambient occlusion — best available WebGL2 SSAO, temporal stability, half-res mode, artist-tunable
2. **Custom SSR ShaderPass** — screen-space raymarching against the depth buffer, applied selectively via stencil-like masking (water plane only), Fresnel-attenuated
3. **GI approximation** via N8AO's color tinting — sky-blue from above, warm bounce from terrain

## Performance Budget

| Effect | GPU Cost (1080p) | Draw Calls | Memory |
|---|---|---|---|
| N8AO (half-res, Medium) | ~2.0 ms | +0 (post-process) | ~8 MB (3 RTTs at half-res) |
| SSR (quarter-res, 24 steps) | ~1.5 ms | +0 (post-process) | ~4 MB (1 RTT at quarter-res) |
| **Total** | **~3.5 ms** | **+0** | **~12 MB** |

Leaves ~13 ms for scene render + bloom + fog + cloud + TAA at 60fps.

## Risk Assessment

1. **Bloom threshold/strength** — N8AO darkens occluded areas, which could shift bloom behavior. Mitigation: N8AO is inserted BEFORE bloom in the chain, so bloom sees AO-darkened pixels (correct).
2. **toneMappingExposure = 0.85** — NOT TOUCHED. N8AO operates in linear space before tone mapping.
3. **Existing EffectComposer chain** — Must insert N8AO and SSR in correct order: RenderPass → N8AO → SSR → Bloom → Fog → Cloud → TAA → Output.
4. **waterManager.js** — SSR needs the water plane to write a marker to identify reflective surfaces. We use a separate depth-normal pre-pass approach instead to avoid modifying water shaders.
5. **Performance on integrated GPUs** — halfRes mode is mandatory. We expose a kill switch.

---

## Complete Code

### File: `ssrPass.js` (NEW)

```javascript
// ssrPass.js — Screen-Space Reflections post-processing pass
// Raymarches against the depth buffer to find reflections for water/reflective surfaces.
// Designed for Vanguard1's water plane (y ≈ 0) and smooth terrain.
// GLSL ES 3.00 compatible (WebGL2).

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const SSRShader = {
    name: 'SSRShader',

    uniforms: {
        tDiffuse:       { value: null },
        tDepth:         { value: null },
        tNormal:        { value: null },
        uResolution:    { value: new THREE.Vector2() },
        uProjection:    { value: new THREE.Matrix4() },
        uProjectionInv: { value: new THREE.Matrix4() },
        uViewMatrix:    { value: new THREE.Matrix4() },
        uViewMatrixInv: { value: new THREE.Matrix4() },
        uCameraNear:    { value: 1.0 },
        uCameraFar:     { value: 3000.0 },
        uMaxSteps:      { value: 24 },
        uStepSize:      { value: 0.15 },
        uThickness:     { value: 1.5 },
        uMaxDistance:    { value: 150.0 },
        uFadeEdge:      { value: 0.1 },
        uIntensity:     { value: 0.6 },
        uRoughnessCutoff: { value: 0.3 },
        uWaterY:        { value: 0.0 },
        uWaterTolerance: { value: 3.0 },
        uTime:          { value: 0.0 },
    },

    vertexShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,

    fragmentShader: /* glsl */ `
        precision highp float;
        precision highp sampler2D;

        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform sampler2D tNormal;
        uniform vec2 uResolution;
        uniform mat4 uProjection;
        uniform mat4 uProjectionInv;
        uniform mat4 uViewMatrix;
        uniform mat4 uViewMatrixInv;
        uniform float uCameraNear;
        uniform float uCameraFar;
        uniform int uMaxSteps;
        uniform float uStepSize;
        uniform float uThickness;
        uniform float uMaxDistance;
        uniform float uFadeEdge;
        uniform float uIntensity;
        uniform float uRoughnessCutoff;
        uniform float uWaterY;
        uniform float uWaterTolerance;
        uniform float uTime;

        varying vec2 vUv;

        float linearizeDepth(float d) {
            float z = d * 2.0 - 1.0;
            return (2.0 * uCameraNear * uCameraFar) / (uCameraFar + uCameraNear - z * (uCameraFar - uCameraNear));
        }

        vec3 screenToView(vec2 uv, float depth) {
            vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
            vec4 view = uProjectionInv * ndc;
            return view.xyz / view.w;
        }

        vec2 viewToScreen(vec3 viewPos) {
            vec4 clip = uProjection * vec4(viewPos, 1.0);
            vec2 ndc = clip.xy / clip.w;
            return ndc * 0.5 + 0.5;
        }

        bool isWaterSurface(vec3 worldPos, vec3 worldNormal) {
            // Check if this fragment is near the water plane
            // Water is at y ≈ uWaterY, with normals pointing mostly up
            float yDist = abs(worldPos.y - uWaterY);
            bool nearWater = yDist < uWaterTolerance;
            bool normalUp = worldNormal.y > 0.7;
            return nearWater && normalUp;
        }

        void main() {
            vec4 sceneColor = texture2D(tDiffuse, vUv);
            float rawDepth = texture2D(tDepth, vUv).r;

            // Skip sky pixels
            if (rawDepth >= 0.9999) {
                gl_FragColor = sceneColor;
                return;
            }

            // Reconstruct view-space position and normal
            vec3 viewPos = screenToView(vUv, rawDepth);
            vec3 viewNormal = texture2D(tNormal, vUv).xyz * 2.0 - 1.0;

            // If normal buffer is empty/zero, skip
            if (length(viewNormal) < 0.1) {
                gl_FragColor = sceneColor;
                return;
            }

            viewNormal = normalize(viewNormal);

            // Convert to world space for water test
            vec3 worldPos = (uViewMatrixInv * vec4(viewPos, 1.0)).xyz;
            vec3 worldNormal = normalize((uViewMatrixInv * vec4(viewNormal, 0.0)).xyz);

            // Only reflect on water-like surfaces
            if (!isWaterSurface(worldPos, worldNormal)) {
                gl_FragColor = sceneColor;
                return;
            }

            // Compute reflection direction in view space
            vec3 viewDir = normalize(viewPos);
            vec3 reflectDir = reflect(viewDir, viewNormal);

            // Fresnel — reflections stronger at grazing angles
            float NdotV = max(dot(-viewDir, viewNormal), 0.0);
            float fresnel = 0.04 + 0.96 * pow(1.0 - NdotV, 5.0);

            // Raymarch in view space
            vec3 rayOrigin = viewPos + viewNormal * 0.5; // offset to avoid self-intersection
            vec3 rayStep = reflectDir * uStepSize;

            vec2 hitUv = vec2(-1.0);
            float marchDist = 0.0;
            bool hit = false;

            // Adaptive step: start coarse, refine on hit
            vec3 currentPos = rayOrigin;
            float currentStepScale = 1.0;

            for (int i = 0; i < 48; i++) {
                if (i >= uMaxSteps) break;

                currentPos += rayStep * currentStepScale;
                marchDist += uStepSize * currentStepScale;

                if (marchDist > uMaxDistance) break;

                vec2 sampleUv = viewToScreen(currentPos);

                // Check bounds
                if (sampleUv.x < 0.0 || sampleUv.x > 1.0 ||
                    sampleUv.y < 0.0 || sampleUv.y > 1.0) break;

                float sampledDepth = texture2D(tDepth, sampleUv).r;
                vec3 sampledViewPos = screenToView(sampleUv, sampledDepth);

                float depthDelta = currentPos.z - sampledViewPos.z;

                // Hit: ray is behind surface but not too far behind (thickness test)
                if (depthDelta > 0.0 && depthDelta < uThickness) {
                    // Binary refinement — 4 steps
                    if (currentStepScale > 0.125) {
                        currentPos -= rayStep * currentStepScale;
                        marchDist -= uStepSize * currentStepScale;
                        currentStepScale *= 0.5;
                        continue;
                    }
                    hitUv = sampleUv;
                    hit = true;
                    break;
                }
            }

            if (!hit) {
                gl_FragColor = sceneColor;
                return;
            }

            // Fade at screen edges to avoid hard cuts
            vec2 edgeFade = smoothstep(vec2(0.0), vec2(uFadeEdge), hitUv) *
                            (1.0 - smoothstep(vec2(1.0 - uFadeEdge), vec2(1.0), hitUv));
            float edgeMask = edgeFade.x * edgeFade.y;

            // Distance fade
            float distFade = 1.0 - smoothstep(uMaxDistance * 0.5, uMaxDistance, marchDist);

            // Sample reflected color
            vec4 reflectedColor = texture2D(tDiffuse, hitUv);

            // Combine with Fresnel, edge fade, distance fade
            float alpha = fresnel * edgeMask * distFade * uIntensity;
            alpha = clamp(alpha, 0.0, 0.85);

            gl_FragColor = vec4(mix(sceneColor.rgb, reflectedColor.rgb, alpha), sceneColor.a);
        }
    `,
};

/**
 * SSR Pass — renders a normal+depth pre-pass, then raymarches for reflections.
 *
 * Insert into EffectComposer AFTER N8AO, BEFORE UnrealBloomPass.
 */
class SSRPass extends Pass {

    constructor(scene, camera, renderer, options = {}) {
        super();

        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.enabled = true;

        // Configuration
        this.intensity = options.intensity ?? 0.6;
        this.maxSteps = options.maxSteps ?? 24;
        this.stepSize = options.stepSize ?? 0.15;
        this.thickness = options.thickness ?? 1.5;
        this.maxDistance = options.maxDistance ?? 150.0;
        this.waterY = options.waterY ?? 0.0;
        this.waterTolerance = options.waterTolerance ?? 3.0;
        this.renderScale = options.renderScale ?? 0.5; // quarter-res by default

        // Pre-pass render target for normals
        const w = Math.floor(renderer.domElement.width * this.renderScale);
        const h = Math.floor(renderer.domElement.height * this.renderScale);

        this._normalTarget = new THREE.WebGLRenderTarget(w, h, {
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            format: THREE.RGBAFormat,
            type: THREE.HalfFloatType,
        });

        // Depth texture attached to the normal target
        this._normalTarget.depthTexture = new THREE.DepthTexture(w, h);
        this._normalTarget.depthTexture.format = THREE.DepthFormat;
        this._normalTarget.depthTexture.type = THREE.UnsignedIntType;

        // Normal pre-pass material — renders view-space normals
        this._normalMaterial = new THREE.MeshNormalMaterial();

        // SSR quad
        const shader = SSRShader;
        this._ssrMaterial = new THREE.ShaderMaterial({
            name: shader.name,
            uniforms: THREE.UniformsUtils.clone(shader.uniforms),
            vertexShader: shader.vertexShader,
            fragmentShader: shader.fragmentShader,
            depthWrite: false,
            depthTest: false,
        });

        this._fsQuad = new FullScreenQuad(this._ssrMaterial);

        // Reusable matrices to avoid per-frame allocation
        this._projInv = new THREE.Matrix4();
        this._viewInv = new THREE.Matrix4();

        // Time accumulator
        this._time = 0;
    }

    setSize(width, height) {
        const w = Math.floor(width * this.renderScale);
        const h = Math.floor(height * this.renderScale);
        this._normalTarget.setSize(w, h);
        this._ssrMaterial.uniforms.uResolution.value.set(width, height);
    }

    dispose() {
        this._normalTarget.dispose();
        this._normalTarget.depthTexture.dispose();
        this._normalMaterial.dispose();
        this._ssrMaterial.dispose();
        this._fsQuad.dispose();
    }

    render(renderer, writeBuffer, readBuffer, deltaTime /*, maskActive */) {
        this._time += deltaTime;

        // ── 1. Normal pre-pass ──
        // Override all scene materials to render view-space normals
        const prevOverrideMaterial = this.scene.overrideMaterial;
        const prevRenderTarget = renderer.getRenderTarget();
        const prevAutoClear = renderer.autoClear;

        this.scene.overrideMaterial = this._normalMaterial;
        renderer.setRenderTarget(this._normalTarget);
        renderer.autoClear = true;
        renderer.clear();
        renderer.render(this.scene, this.camera);
        this.scene.overrideMaterial = prevOverrideMaterial;

        // ── 2. SSR composite pass ──
        const uniforms = this._ssrMaterial.uniforms;
        uniforms.tDiffuse.value = readBuffer.texture;
        uniforms.tDepth.value = this._normalTarget.depthTexture;
        uniforms.tNormal.value = this._normalTarget.texture;
        uniforms.uCameraNear.value = this.camera.near;
        uniforms.uCameraFar.value = this.camera.far;
        uniforms.uMaxSteps.value = this.maxSteps;
        uniforms.uStepSize.value = this.stepSize;
        uniforms.uThickness.value = this.thickness;
        uniforms.uMaxDistance.value = this.maxDistance;
        uniforms.uIntensity.value = this.intensity;
        uniforms.uWaterY.value = this.waterY;
        uniforms.uWaterTolerance.value = this.waterTolerance;
        uniforms.uTime.value = this._time;

        // Matrix uniforms — reuse pre-allocated matrices
        uniforms.uProjection.value.copy(this.camera.projectionMatrix);
        this._projInv.copy(this.camera.projectionMatrix).invert();
        uniforms.uProjectionInv.value.copy(this._projInv);
        uniforms.uViewMatrix.value.copy(this.camera.matrixWorldInverse);
        this._viewInv.copy(this.camera.matrixWorld);
        uniforms.uViewMatrixInv.value.copy(this._viewInv);

        if (this.renderToScreen) {
            renderer.setRenderTarget(null);
        } else {
            renderer.setRenderTarget(writeBuffer);
        }
        renderer.autoClear = false;
        this._fsQuad.render(renderer);

        // Restore state
        renderer.autoClear = prevAutoClear;
        renderer.setRenderTarget(prevRenderTarget);
    }
}

export { SSRPass, SSRShader };
```

### File: `ssaoManager.js` (NEW)

```javascript
// ssaoManager.js — Manages N8AO ambient occlusion and SSR integration for Vanguard1
// Coordinates screen-space effects, exposes tuning API, handles quality adaptation.

import * as THREE from 'three';

/**
 * @typedef {Object} SSAOConfig
 * @property {number} aoRadius
 * @property {number} aoIntensity
 * @property {number} distanceFalloff
 * @property {number} aoSamples
 * @property {number} denoiseSamples
 * @property {number} denoiseRadius
 * @property {boolean} halfRes
 * @property {THREE.Color} aoColor
 */

/** @type {SSAOConfig} */
const DEFAULT_CONFIG = {
    aoRadius: 5.0,
    aoIntensity: 3.0,
    distanceFalloff: 1.0,
    aoSamples: 16,
    denoiseSamples: 8,
    denoiseRadius: 12,
    halfRes: true,
    aoColor: new THREE.Color(0.04, 0.04, 0.08), // slight blue tint for sky bounce GI approx
};

/** @type {Object} */
const SSR_DEFAULTS = {
    intensity: 0.55,
    maxSteps: 24,
    stepSize: 0.15,
    thickness: 1.5,
    maxDistance: 150.0,
    waterY: 0.0,
    waterTolerance: 3.0,
    renderScale: 0.5,
};

/**
 * Manages all screen-space lighting effects for Vanguard1.
 *
 * Usage:
 *   const mgr = new SSAOManager();
 *   const { n8aoPass, ssrPass } = await mgr.init(scene, camera, renderer, composer);
 *   // in animation loop:
 *   mgr.update(deltaTime, camera);
 */
class SSAOManager {

    constructor() {
        /** @type {import('n8ao').N8AOPass|null} */
        this.n8aoPass = null;

        /** @type {import('./ssrPass.js').SSRPass|null} */
        this.ssrPass = null;

        this._scene = null;
        this._camera = null;
        this._renderer = null;
        this._enabled = true;
        this._ssaoEnabled = true;
        this._ssrEnabled = true;
        this._adaptiveQuality = true;
        this._lastFrameTime = 0;
        this._frameTimes = new Float32Array(60);
        this._frameIdx = 0;
        this._currentQuality = 'Medium';
    }

    /**
     * Initialize SSAO and SSR passes.
     * N8AO is loaded dynamically so the main bundle doesn't break if it's unavailable.
     *
     * @param {THREE.Scene} scene
     * @param {THREE.PerspectiveCamera} camera
     * @param {THREE.WebGLRenderer} renderer
     * @param {import('three/addons/postprocessing/EffectComposer.js').EffectComposer} composer
     * @param {Object} [options]
     * @returns {Promise<{n8aoPass: object|null, ssrPass: object|null}>}
     */
    async init(scene, camera, renderer, composer, options = {}) {
        this._scene = scene;
        this._camera = camera;
        this._renderer = renderer;

        const width = renderer.domElement.width;
        const height = renderer.domElement.height;

        const config = { ...DEFAULT_CONFIG, ...options.ssao };
        const ssrConfig = { ...SSR_DEFAULTS, ...options.ssr };

        // ── N8AO ──
        try {
            const n8aoModule = await import('https://unpkg.com/n8ao@1.9.2/dist/N8AO.js');
            const N8AOPass = n8aoModule.N8AOPass;

            this.n8aoPass = new N8AOPass(scene, camera, width, height);

            // Apply configuration
            this.n8aoPass.configuration.aoRadius = config.aoRadius;
            this.n8aoPass.configuration.intensity = config.aoIntensity;
            this.n8aoPass.configuration.distanceFalloff = config.distanceFalloff;
            this.n8aoPass.configuration.color = config.aoColor;
            this.n8aoPass.configuration.screenSpaceRadius = false;
            this.n8aoPass.configuration.halfRes = config.halfRes;
            this.n8aoPass.configuration.gammaCorrection = false; // we handle gamma via OutputPass
            this.n8aoPass.configuration.aoSamples = config.aoSamples;
            this.n8aoPass.configuration.denoiseSamples = config.denoiseSamples;
            this.n8aoPass.configuration.denoiseRadius = config.denoiseRadius;

            this.n8aoPass.setQualityMode('Medium');

            console.log('[SSAOManager] N8AO initialized — halfRes:', config.halfRes);
        } catch (err) {
            console.warn('[SSAOManager] N8AO unavailable, falling back to GTAOPass:', err.message);
            await this._initGTAOFallback(scene, camera, renderer, width, height, config);
        }

        // ── SSR ──
        try {
            const { SSRPass } = await import('./ssrPass.js');
            this.ssrPass = new SSRPass(scene, camera, renderer, ssrConfig);
            console.log('[SSAOManager] SSR initialized — renderScale:', ssrConfig.renderScale);
        } catch (err) {
            console.warn('[SSAOManager] SSR unavailable:', err.message);
        }

        // ── Expose console tuning ──
        this._exposeDebugAPI();

        // ── Register with layerManager ──
        window.dispatchEvent(new CustomEvent('vg1:layer:register', {
            detail: {
                id: 'screenSpaceEffects',
                label: 'Screen Space Effects',
                enabled: true,
                onToggle: (on) => { this.setEnabled(on); },
                onOpacity: (v) => {
                    if (this.n8aoPass) this.n8aoPass.configuration.intensity = v * config.aoIntensity;
                    if (this.ssrPass) this.ssrPass.intensity = v * ssrConfig.intensity;
                },
            }
        }));

        return { n8aoPass: this.n8aoPass, ssrPass: this.ssrPass };
    }

    /**
     * Fallback: use Three.js built-in GTAOPass if N8AO CDN is unreachable.
     * @private
     */
    async _initGTAOFallback(scene, camera, renderer, width, height, config) {
        try {
            const { GTAOPass } = await import('three/addons/postprocessing/GTAOPass.js');
            const gtaoPass = new GTAOPass(scene, camera, width, height);
            gtaoPass.output = 0; // OUTPUT_DEFAULT — blended AO
            // GTAOPass doesn't have identical API, map what we can
            if (gtaoPass.updateGtaoMaterial) {
                gtaoPass.updateGtaoMaterial({
                    radius: config.aoRadius,
                    distanceExponent: 2,
                    thickness: config.distanceFalloff,
                    scale: config.aoIntensity,
                    samples: config.aoSamples,
                });
            }
            // Wrap in a compatible interface
            this.n8aoPass = gtaoPass;
            this.n8aoPass._isGTAO = true;
            console.log('[SSAOManager] GTAOPass fallback initialized');
        } catch (e2) {
            console.error('[SSAOManager] Both N8AO and GTAO failed:', e2.message);
        }
    }

    /**
     * Per-frame update. Call from the main animation loop.
     * Handles adaptive quality scaling based on frame time.
     *
     * @param {number} deltaTime — seconds since last frame
     * @param {THREE.PerspectiveCamera} camera
     */
    update(deltaTime, camera) {
        if (!this._enabled) return;

        // Track frame times for adaptive quality
        if (this._adaptiveQuality) {
            this._frameTimes[this._frameIdx] = deltaTime * 1000;
            this._frameIdx = (this._frameIdx + 1) % this._frameTimes.length;

            // Every 60 frames, check average
            if (this._frameIdx === 0) {
                this._adaptQuality();
            }
        }

        // Altitude-based intensity adjustment
        // At high altitude (>200), AO is barely visible — save GPU
        const cameraY = camera.position.y;
        if (this.n8aoPass && this._ssaoEnabled) {
            if (cameraY > 300) {
                this.n8aoPass.enabled = false;
            } else if (cameraY > 200) {
                this.n8aoPass.enabled = true;
                if (!this.n8aoPass._isGTAO) {
                    this.n8aoPass.configuration.intensity = 1.5;
                }
            } else {
                this.n8aoPass.enabled = true;
                if (!this.n8aoPass._isGTAO) {
                    this.n8aoPass.configuration.intensity = 3.0;
                }
            }
        }

        // SSR only visible when camera is low enough to see water reflections
        if (this.ssrPass && this._ssrEnabled) {
            if (cameraY > 200) {
                this.ssrPass.enabled = false;
            } else {
                this.ssrPass.enabled = true;
                // Fade SSR intensity with altitude
                const ssrFade = THREE.MathUtils.smoothstep(cameraY, 20, 150);
                this.ssrPass.intensity = THREE.MathUtils.lerp(0.6, 0.15, ssrFade);
            }
        }
    }

    /**
     * Adaptive quality — drop AO quality if frame time exceeds budget.
     * @private
     */
    _adaptQuality() {
        if (!this.n8aoPass || this.n8aoPass._isGTAO) return;

        let sum = 0;
        for (let i = 0; i < this._frameTimes.length; i++) sum += this._frameTimes[i];
        const avgMs = sum / this._frameTimes.length;

        const BUDGET_60FPS = 16.67;
        const BUDGET_MARGIN = 2.0;

        if (avgMs > BUDGET_60FPS + BUDGET_MARGIN && this._currentQuality !== 'Performance') {
            // Downgrade
            if (this._currentQuality === 'Ultra' || this._currentQuality === 'High') {
                this.n8aoPass.setQualityMode('Medium');
                this._currentQuality = 'Medium';
            } else if (this._currentQuality === 'Medium') {
                this.n8aoPass.setQualityMode('Low');
                this._currentQuality = 'Low';
            } else {
                this.n8aoPass.setQualityMode('Performance');
                this._currentQuality = 'Performance';
            }
            console.log(`[SSAOManager] Adaptive quality → ${this._currentQuality} (avg: ${avgMs.toFixed(1)}ms)`);
        } else if (avgMs < BUDGET_60FPS - 4.0 && this._currentQuality !== 'Medium') {
            // Upgrade if we have headroom
            if (this._currentQuality === 'Performance') {
                this.n8aoPass.setQualityMode('Low');
                this._currentQuality = 'Low';
            } else if (this._currentQuality === 'Low') {
                this.n8aoPass.setQualityMode('Medium');
                this._currentQuality = 'Medium';
            }
            console.log(`[SSAOManager] Adaptive quality → ${this._currentQuality} (avg: ${avgMs.toFixed(1)}ms)`);
        }
    }

    /**
     * Toggle all screen-space effects.
     * @param {boolean} on
     */
    setEnabled(on) {
        this._enabled = on;
        if (this.n8aoPass) this.n8aoPass.enabled = on && this._ssaoEnabled;
        if (this.ssrPass) this.ssrPass.enabled = on && this._ssrEnabled;
    }

    /**
     * Toggle individual effects.
     * @param {'ssao'|'ssr'} effect
     * @param {boolean} on
     */
    setEffectEnabled(effect, on) {
        if (effect === 'ssao') {
            this._ssaoEnabled = on;
            if (this.n8aoPass) this.n8aoPass.enabled = on && this._enabled;
        } else if (effect === 'ssr') {
            this._ssrEnabled = on;
            if (this.ssrPass) this.ssrPass.enabled = on && this._enabled;
        }
    }

    /**
     * Handle resize.
     * @param {number} width
     * @param {number} height
     */
    resize(width, height) {
        if (this.n8aoPass && this.n8aoPass.setSize) {
            this.n8aoPass.setSize(width, height);
        }
        if (this.ssrPass) {
            this.ssrPass.setSize(width, height);
        }
    }

    /**
     * Expose window.vg1SSE for DevTools live tuning.
     * @private
     */
    _exposeDebugAPI() {
        const self = this;
        window.vg1SSE = {
            get enabled() { return self._enabled; },
            set enabled(v) { self.setEnabled(v); },

            get ssaoEnabled() { return self._ssaoEnabled; },
            set ssaoEnabled(v) { self.setEffectEnabled('ssao', v); },

            get ssrEnabled() { return self._ssrEnabled; },
            set ssrEnabled(v) { self.setEffectEnabled('ssr', v); },

            get adaptiveQuality() { return self._adaptiveQuality; },
            set adaptiveQuality(v) { self._adaptiveQuality = v; },

            get quality() { return self._currentQuality; },
            set quality(v) {
                if (self.n8aoPass && !self.n8aoPass._isGTAO) {
                    self.n8aoPass.setQualityMode(v);
                    self._currentQuality = v;
                }
            },

            // N8AO direct tunables
            get aoRadius() { return self.n8aoPass?.configuration?.aoRadius ?? 0; },
            set aoRadius(v) { if (self.n8aoPass?.configuration) self.n8aoPass.configuration.aoRadius = v; },

            get aoIntensity() { return self.n8aoPass?.configuration?.intensity ?? 0; },
            set aoIntensity(v) { if (self.n8aoPass?.configuration) self.n8aoPass.configuration.intensity = v; },

            get aoColor() { return self.n8aoPass?.configuration?.color ?? null; },
            /** @param {number} hex — e.g. 0x0a0a14 */
            set aoColor(hex) { if (self.n8aoPass?.configuration) self.n8aoPass.configuration.color.set(hex); },

            get aoSamples() { return self.n8aoPass?.configuration?.aoSamples ?? 0; },
            set aoSamples(v) { if (self.n8aoPass?.configuration) self.n8aoPass.configuration.aoSamples = v; },

            get halfRes() { return self.n8aoPass?.configuration?.halfRes ?? true; },
            set halfRes(v) { if (self.n8aoPass?.configuration) self.n8aoPass.configuration.halfRes = v; },

            // SSR tunables
            get ssrIntensity() { return self.ssrPass?.intensity ?? 0; },
            set ssrIntensity(v) { if (self.ssrPass) self.ssrPass.intensity = v; },

            get ssrSteps() { return self.ssrPass?.maxSteps ?? 0; },
            set ssrSteps(v) { if (self.ssrPass) self.ssrPass.maxSteps = v; },

            get ssrThickness() { return self.ssrPass?.thickness ?? 0; },
            set ssrThickness(v) { if (self.ssrPass) self.ssrPass.thickness = v; },

            get ssrMaxDistance() { return self.ssrPass?.maxDistance ?? 0; },
            set ssrMaxDistance(v) { if (self.ssrPass) self.ssrPass.maxDistance = v; },

            get ssrWaterY() { return self.ssrPass?.waterY ?? 0; },
            set ssrWaterY(v) { if (self.ssrPass) self.ssrPass.waterY = v; },

            /** Print current GPU timing for N8AO */
            get aoGpuMs() { return self.n8aoPass?.lastTime ?? -1; },

            /** Print status */
            status() {
                console.table({
                    'SSAO enabled': self._ssaoEnabled,
                    'SSAO quality': self._currentQuality,
                    'SSAO halfRes': self.n8aoPass?.configuration?.halfRes ?? 'N/A',
                    'SSAO GPU ms': self.n8aoPass?.lastTime?.toFixed(2) ?? 'N/A',
                    'SSR enabled': self._ssrEnabled,
                    'SSR intensity': self.ssrPass?.intensity ?? 'N/A',
                    'SSR steps': self.ssrPass?.maxSteps ?? 'N/A',
                    'Adaptive': self._adaptiveQuality,
                });
            },
        };

        console.log('[SSAOManager] Debug API: window.vg1SSE — try vg1SSE.status()');
    }

    /**
     * Clean up all GPU resources.
     */
    dispose() {
        if (this.n8aoPass && this.n8aoPass.dispose) this.n8aoPass.dispose();
        if (this.ssrPass) this.ssrPass.dispose();
        delete window.vg1SSE;
    }
}

export { SSAOManager, DEFAULT_CONFIG, SSR_DEFAULTS };
```

### Modifications to `sceneSetup.js`

The composer chain must be modified to insert the SSAO and SSR passes. Here is the section to change:

**FIND** the existing composer setup section (after `initPostProcessing` or equivalent). Replace the composer construction with:

```javascript
// ── In sceneSetup.js — initPostProcessing function ──
// REPLACE the existing composer chain assembly with this:

export function initPostProcessing(scene, camera, renderer) {
    const width = window.innerWidth;
    const height = window.innerHeight;

    const composer = new EffectComposer(renderer);

    // 1. Scene render
    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);

    // 2. N8AO and SSR are inserted dynamically by ssaoManager.init()
    //    They go here in the chain — after render, before bloom.
    //    ssaoManager.init() returns the pass objects; caller inserts them:
    //
    //    const { n8aoPass, ssrPass } = await ssaoManager.init(scene, camera, renderer, composer);
    //    if (n8aoPass) composer.insertPass(n8aoPass, 1);  // after RenderPass
    //    if (ssrPass)  composer.insertPass(ssrPass, n8aoPass ? 2 : 1);

    // 3. Bloom — unchanged, DO NOT modify these values
    const bloomPass = new UnrealBloomPass(
        new THREE.Vector2(width, height),
        BLOOM_STRENGTH_BASE,
        BLOOM_RADIUS,
        BLOOM_THRESHOLD
    );
    composer.addPass(bloomPass);

    // 4–6. Fog, Cloud, TAA passes added by their respective managers (unchanged)

    return { composer, renderPass, bloomPass };
}
```

### Integration into `main.js`

Add these lines to main.js — exact insertion points marked:

```javascript
// ── main.js — IMPORTS (add at top with other imports) ──
import { SSAOManager } from './ssaoManager.js';

// ── main.js — INITIALIZATION (after initPostProcessing, before animation loop) ──
const ssaoManager = new SSAOManager();

// After composer is created and renderPass/bloomPass are set up:
(async () => {
    const { n8aoPass, ssrPass } = await ssaoManager.init(
        scene, camera, renderer, composer,
        {
            ssao: {
                aoRadius: 5.0,
                aoIntensity: 3.0,
                distanceFalloff: 1.0,
                halfRes: true,
                aoColor: new THREE.Color(0.04, 0.04, 0.08),
            },
            ssr: {
                intensity: 0.55,
                maxSteps: 24,
                renderScale: 0.5,
                waterY: 0.0,
            },
        }
    );

    // Insert into composer chain — AFTER RenderPass (index 0), BEFORE BloomPass
    // EffectComposer.insertPass(pass, index) shifts existing passes forward
    if (n8aoPass) {
        composer.insertPass(n8aoPass, 1);
    }
    if (ssrPass) {
        const ssrIdx = n8aoPass ? 2 : 1;
        composer.insertPass(ssrPass, ssrIdx);
    }

    console.log('[main] Screen-space effects chain ready');
})();

// ── main.js — ANIMATION LOOP (add inside the animate() function, before composer.render()) ──
// After controls.update() and before composer.render():
ssaoManager.update(delta, camera);

// ── main.js — RESIZE HANDLER (add inside the window resize listener) ──
ssaoManager.resize(window.innerWidth, window.innerHeight);
```

## Console Tuning API

All properties are live-tunable from browser DevTools:

```javascript
// ── DevTools Console Commands ──

// Full status report
vg1SSE.status()

// Toggle effects
vg1SSE.enabled = false          // kill all screen-space effects
vg1SSE.ssaoEnabled = false      // kill only SSAO
vg1SSE.ssrEnabled = false       // kill only SSR

// SSAO tuning
vg1SSE.aoRadius = 8.0           // larger radius = softer, wider AO
vg1SSE.aoIntensity = 4.0        // darkness of AO shadows
vg1SSE.aoColor = 0x0a0a14       // tint color (GI approximation)
vg1SSE.aoSamples = 32           // more samples = cleaner but slower
vg1SSE.halfRes = false          // full-res AO (2× slower, sharper)
vg1SSE.quality = 'Ultra'        // 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra'

// SSR tuning
vg1SSE.ssrIntensity = 0.8       // reflection strength
vg1SSE.ssrSteps = 32            // more steps = longer rays, more GPU
vg1SSE.ssrThickness = 2.0       // depth tolerance for hits
vg1SSE.ssrMaxDistance = 200.0   // max ray travel distance in view space
vg1SSE.ssrWaterY = 0.5          // adjust if water plane Y changes

// Performance monitoring
vg1SSE.aoGpuMs                  // N8AO GPU time in ms (updated each frame)
vg1SSE.adaptiveQuality = false  // disable auto quality scaling

// Recommended presets:
// HIGH QUALITY (< 30fps acceptable):
vg1SSE.quality = 'Ultra'; vg1SSE.halfRes = false; vg1SSE.ssrSteps = 48;

// BALANCED (target 60fps):
vg1SSE.quality = 'Medium'; vg1SSE.halfRes = true; vg1SSE.ssrSteps = 24;

// PERFORMANCE (integrated GPU):
vg1SSE.quality = 'Performance'; vg1SSE.halfRes = true; vg1SSE.ssrSteps = 12;
```