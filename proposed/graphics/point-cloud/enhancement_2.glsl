// edlPass.js — Eye-Dome Lighting post-process for point cloud depth perception
// Adapted from Boucheny 2009 / Potree / CloudCompare EDL implementations.
// Plugs into the existing EffectComposer chain.

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const EDLVertexShader = /* glsl */ `#version 300 es
precision highp float;

in vec3 position;
in vec2 uv;

out vec2 vUv;

void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
}
`;

const EDLFragmentShader = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D tDiffuse;       // scene colour from previous pass
uniform sampler2D tDepth;         // scene depth buffer
uniform float uEdlStrength;       // darkness multiplier (0.3–1.0 typical)
uniform float uEdlRadius;         // pixel radius for neighbor sampling
uniform vec2 uScreenSize;         // viewport width, height
uniform float uCameraNear;
uniform float uCameraFar;
uniform float uCameraAltitude;    // camera.position.y — for crossfade with continent mesh
uniform float uFadeStart;         // SPLAT_FADE_START
uniform float uFadeEnd;           // SPLAT_FADE_END

in vec2 vUv;
out vec4 fragColor;

// Reconstruct linear depth from the packed depth buffer.
// Three.js stores depth as gl_FragCoord.z which is a non-linear [0,1] mapping.
float getLinearDepth(float d) {
    float z_ndc = d * 2.0 - 1.0;
    return (2.0 * uCameraNear * uCameraFar) / (uCameraFar + uCameraNear - z_ndc * (uCameraFar - uCameraNear));
}

// Log-depth response for a single neighbor offset.
// Returns how much darker this neighbor suggests the center should be.
float edlResponse(vec2 centerUV, float centerLogDepth, vec2 offset) {
    vec2 neighborUV = centerUV + offset;

    // Clamp to screen — prevents sampling across viewport edges
    neighborUV = clamp(neighborUV, vec2(0.001), vec2(0.999));

    float neighborRawDepth = texture(tDepth, neighborUV).r;

    // Sky pixels (depth == 1.0) should not darken terrain
    if (neighborRawDepth >= 0.9999) return 0.0;

    float neighborLinDepth = getLinearDepth(neighborRawDepth);
    float neighborLogDepth = log2(max(1e-5, neighborLinDepth));

    return max(0.0, centerLogDepth - neighborLogDepth);
}

void main() {
    vec4 sceneColor = texture(tDiffuse, vUv);
    float rawDepth  = texture(tDepth, vUv).r;

    // Sky pixels — pass through unchanged
    if (rawDepth >= 0.9999) {
        fragColor = sceneColor;
        return;
    }

    // Compute crossfade factor so EDL matches splat cloud fade-out.
    // When camera is below SPLAT_FADE_END the point cloud is hidden;
    // EDL should also be fully off.  Between FADE_END and FADE_START
    // it ramps from 0→1.  Above FADE_START it's fully on.
    float fadeFactor = clamp(
        (uCameraAltitude - uFadeEnd) / max(0.01, uFadeStart - uFadeEnd),
        0.0, 1.0
    );

    // If splat cloud is fully faded out, skip EDL entirely
    if (fadeFactor <= 0.0) {
        fragColor = sceneColor;
        return;
    }

    float linearDepth = getLinearDepth(rawDepth);
    float centerLogDepth = log2(max(1e-5, linearDepth));

    // Pixel-space step size
    vec2 pixelSize = uEdlRadius / uScreenSize;

    // 8-neighbor sampling pattern (N, NE, E, SE, S, SW, W, NW)
    // Uniform angular distribution gives isotropic edge detection.
    float totalResponse = 0.0;
    totalResponse += edlResponse(vUv, centerLogDepth, vec2( 0.0,  1.0) * pixelSize);
    totalResponse += edlResponse(vUv, centerLogDepth, vec2( 0.7071,  0.7071) * pixelSize);
    totalResponse += edlResponse(vUv, centerLogDepth, vec2( 1.0,  0.0) * pixelSize);
    totalResponse += edlResponse(vUv, centerLogDepth, vec2( 0.7071, -0.7071) * pixelSize);
    totalResponse += edlResponse(vUv, centerLogDepth, vec2( 0.0, -1.0) * pixelSize);
    totalResponse += edlResponse(vUv, centerLogDepth, vec2(-0.7071, -0.7071) * pixelSize);
    totalResponse += edlResponse(vUv, centerLogDepth, vec2(-1.0,  0.0) * pixelSize);
    totalResponse += edlResponse(vUv, centerLogDepth, vec2(-0.7071,  0.7071) * pixelSize);

    totalResponse /= 8.0;

    // Exponential shading — larger response = darker shade
    float shade = exp(-totalResponse * uEdlStrength * 300.0);

    // Blend EDL darkening with crossfade factor
    shade = mix(1.0, shade, fadeFactor);

    fragColor = vec4(sceneColor.rgb * shade, sceneColor.a);
}
`;

export class EDLPass extends Pass {
    constructor(scene, camera, options = {}) {
        super();

        this.scene = scene;
        this.camera = camera;
        this.needsSwap = true;

        // Tunable parameters
        this.edlStrength = options.edlStrength !== undefined ? options.edlStrength : 0.6;
        this.edlRadius = options.edlRadius !== undefined ? options.edlRadius : 1.4;
        this.fadeStart = options.fadeStart !== undefined ? options.fadeStart : 25;
        this.fadeEnd = options.fadeEnd !== undefined ? options.fadeEnd : 10;

        // Depth render target — we need a depth texture from the main scene.
        // The composer's writeBuffer has colour but not always an accessible depth
        // texture, so we create our own render target with depthTexture.
        this.depthTarget = new THREE.WebGLRenderTarget(1, 1, {
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            type: THREE.FloatType,
        });
        this.depthTarget.depthTexture = new THREE.DepthTexture();
        this.depthTarget.depthTexture.format = THREE.DepthFormat;
        this.depthTarget.depthTexture.type = THREE.UnsignedIntType;

        this.uniforms = {
            tDiffuse:        { value: null },
            tDepth:          { value: this.depthTarget.depthTexture },
            uEdlStrength:    { value: this.edlStrength },
            uEdlRadius:      { value: this.edlRadius },
            uScreenSize:     { value: new THREE.Vector2(1, 1) },
            uCameraNear:     { value: camera.near },
            uCameraFar:      { value: camera.far },
            uCameraAltitude: { value: 50 },
            uFadeStart:      { value: this.fadeStart },
            uFadeEnd:        { value: this.fadeEnd },
        };

        this.material = new THREE.RawShaderMaterial({
            uniforms: this.uniforms,
            vertexShader: EDLVertexShader,
            fragmentShader: EDLFragmentShader,
            depthTest: false,
            depthWrite: false,
        });

        this.fsQuad = new FullScreenQuad(this.material);
    }

    setSize(width, height) {
        this.depthTarget.setSize(width, height);
        this.uniforms.uScreenSize.value.set(width, height);
    }

    dispose() {
        this.depthTarget.dispose();
        this.material.dispose();
        this.fsQuad.dispose();
    }

    render(renderer, writeBuffer, readBuffer /*, deltaTime, maskActive */) {
        // Step 1: Render the full scene into our depth target to capture the depth texture.
        // The colour output here is discarded — we only need the depth.
        const oldRenderTarget = renderer.getRenderTarget();
        const oldAutoClear = renderer.autoClear;

        renderer.setRenderTarget(this.depthTarget);
        renderer.autoClear = true;
        renderer.render(this.scene, this.camera);

        // Step 2: Apply EDL shading using the depth texture + the colour from the previous pass
        this.uniforms.tDiffuse.value = readBuffer.texture;
        this.uniforms.uCameraNear.value = this.camera.near;
        this.uniforms.uCameraFar.value = this.camera.far;
        this.uniforms.uCameraAltitude.value = this.camera.position.y;

        renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
        renderer.autoClear = false;
        renderer.clear();
        this.fsQuad.render(renderer);

        renderer.autoClear = oldAutoClear;
        renderer.setRenderTarget(oldRenderTarget);
    }
}