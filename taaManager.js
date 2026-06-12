// taaManager.js — Proper TAA accumulation for the WebGPU render path
//
// The WebGL path already uses Three.js TAARenderPass (multi-sample accumulate).
// The WebGPU path was only doing Halton sub-pixel jitter and discarding the
// history — this module adds the missing accumulation step.
//
// Algorithm:
//   1. Jitter the projection matrix with a 16-frame Halton(2,3) sequence.
//   2. Render the jittered scene → rtScene (HDR half-float).
//   3. Neighbourhood-clamp history to prevent extreme ghosting.
//   4. Blend  mix(history, current, blendFactor) → rtAccum.
//   5. Copy accumulation to screen via a second renderer.render() call.
//   6. Ping-pong: swap rtAccum ↔ rtHistory for next frame.
//
// Adaptive blend factor:
//   • Camera moving  → 0.40 (lean toward current frame, less ghosting)
//   • Camera still   → 0.08 (lean toward history, smooth convergence)
import * as THREE from 'three';

// ── Blend shader ──────────────────────────────────────────────────────────────
// Neighbourhood clamping: clamp history colour to ±CLAMP_WINDOW of current
// to prevent ghosting on fast-moving or newly-revealed geometry.
const BLEND_VERT = /* glsl */`
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
    }
`;

const BLEND_FRAG = /* glsl */`
    uniform sampler2D tCurrent;
    uniform sampler2D tHistory;
    uniform float     uBlend;       // weight of current frame: 0.08–0.40
    varying vec2 vUv;

    // Luminance (Rec. 709)
    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    void main() {
        vec4 curr = texture2D(tCurrent, vUv);
        vec4 hist = texture2D(tHistory, vUv);

        // Neighbourhood AABB clamping — prevents severe ghosting without
        // a full velocity buffer. Uses a fixed tolerance in colour space.
        // Tighter window = less ghosting but more shimmer when still.
        const float WINDOW = 0.18;
        hist = clamp(hist, curr - WINDOW, curr + WINDOW);

        // Variance-based blend: if current and history differ greatly
        // (disocclusion, fast motion) lean more toward current frame.
        float diff = abs(luma(curr.rgb) - luma(hist.rgb));
        float adaptiveBlend = mix(uBlend, min(uBlend * 3.0, 0.6), diff * 2.0);

        gl_FragColor = mix(hist, curr, adaptiveBlend);
    }
`;

// ── Halton sequence ───────────────────────────────────────────────────────────
function halton(index, base) {
    let f = 1, r = 0, i = index;
    while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
    return r;
}

// ── TAAManager ────────────────────────────────────────────────────────────────
export class TAAManager {
    constructor(renderer, width, height) {
        this._renderer  = renderer;
        this._frame     = 0;
        this._firstFrame = true;

        const opts = {
            type:            THREE.HalfFloatType,
            format:          THREE.RGBAFormat,
            minFilter:       THREE.LinearFilter,
            magFilter:       THREE.LinearFilter,
            generateMipmaps: false,
            depthBuffer:     true,
            stencilBuffer:   false,
        };

        // rtScene  — receives the jittered scene render each frame
        // rtPing / rtPong — ping-pong accumulation pair
        this._rtScene = new THREE.WebGLRenderTarget(width, height, opts);
        this._rtPing  = new THREE.WebGLRenderTarget(width, height, { ...opts, depthBuffer: false });
        this._rtPong  = new THREE.WebGLRenderTarget(width, height, { ...opts, depthBuffer: false });

        // rtHistory always holds last frame's accumulated output
        this._rtHistory = this._rtPing;
        this._rtAccum   = this._rtPong;

        // ── Fullscreen quad for blend pass ────────────────────────────────────
        // Using a triangle that covers the clip space (-1→1) instead of a quad
        // avoids the diagonal seam artefact some GPUs show on PlaneGeometry.
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(
            new Float32Array([-1, -1, 0,  3, -1, 0,  -1,  3, 0]), 3
        ));
        geo.setAttribute('uv', new THREE.BufferAttribute(
            new Float32Array([0, 0,  2, 0,  0, 2]), 2
        ));

        this._blendMat = new THREE.ShaderMaterial({
            uniforms: {
                tCurrent: { value: null },
                tHistory: { value: null },
                uBlend:   { value: 0.08 },
            },
            vertexShader:   BLEND_VERT,
            fragmentShader: BLEND_FRAG,
            depthTest:  false,
            depthWrite: false,
        });

        this._blendQuad   = new THREE.Mesh(geo, this._blendMat);
        this._blendScene  = new THREE.Scene();
        this._blendCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this._blendScene.add(this._blendQuad);

        // Camera velocity tracking for adaptive blend
        this._prevCamPos  = new THREE.Vector3(Infinity, 0, 0);
        this._prevCamQuat = new THREE.Quaternion();

        // Cached renderer state
        this._origClearColor = new THREE.Color();
        this._origClearAlpha = 1;
    }

    // ── render ────────────────────────────────────────────────────────────────
    // Drop-in replacement for `renderer.render(scene, camera)` on WebGPU path.
    render(scene, camera) {
        const renderer = this._renderer;
        this._frame++;

        // ── 1. Halton sub-pixel jitter ────────────────────────────────────────
        const idx = (this._frame % 16) + 1;
        const jx  = (halton(idx, 2) - 0.5) / renderer.domElement.width;
        const jy  = (halton(idx, 3) - 0.5) / renderer.domElement.height;
        const pm  = camera.projectionMatrix.elements;
        const e8  = pm[8]; const e9 = pm[9];
        pm[8] += jx * 2;
        pm[9] += jy * 2;

        // ── 2. Render jittered scene → rtScene ───────────────────────────────
        renderer.setRenderTarget(this._rtScene);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);

        // Restore projection matrix — must happen before any other render
        pm[8] = e8; pm[9] = e9;

        // ── 3. Adaptive blend factor from camera velocity ─────────────────────
        const moved =
            this._firstFrame ||
            camera.position.distanceToSquared(this._prevCamPos) > 0.04 ||
            camera.quaternion.angleTo(this._prevCamQuat) > 0.004;

        const blendFactor = moved ? 0.40 : 0.08;
        this._prevCamPos.copy(camera.position);
        this._prevCamQuat.copy(camera.quaternion);

        // ── 4. Blend: mix(history, current, blend) → rtAccum ─────────────────
        this._blendMat.uniforms.tCurrent.value = this._rtScene.texture;
        this._blendMat.uniforms.tHistory.value = this._firstFrame
            ? this._rtScene.texture       // no history yet → use current
            : this._rtHistory.texture;
        this._blendMat.uniforms.uBlend.value = blendFactor;

        renderer.setRenderTarget(this._rtAccum);
        renderer.render(this._blendScene, this._blendCamera);

        // ── 5. Blit accumulated result to screen ──────────────────────────────
        renderer.setRenderTarget(null);
        renderer.render(this._blendScene, this._blendCamera);

        // ── 6. Ping-pong swap ─────────────────────────────────────────────────
        const tmp         = this._rtHistory;
        this._rtHistory   = this._rtAccum;
        this._rtAccum     = tmp;
        this._firstFrame  = false;
    }

    // ── Resize all render targets (call from onWindowResize) ──────────────────
    setSize(width, height) {
        this._rtScene.setSize(width, height);
        this._rtPing.setSize(width, height);
        this._rtPong.setSize(width, height);
    }

    dispose() {
        this._rtScene.dispose();
        this._rtPing.dispose();
        this._rtPong.dispose();
        this._blendMat.dispose();
        this._blendQuad.geometry.dispose();
        this._blendScene.remove(this._blendQuad);
    }
}
