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