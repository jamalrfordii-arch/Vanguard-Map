// fftOceanCompute.js — GPU-based FFT ocean spectrum computation via ping-pong render targets
// Implements Tessendorf's iFFT ocean with JONSWAP spectrum, 2 cascades
// Outputs: displacement map (RGB=XYZ offset) + normal/foam map (RGB=normal, A=foam)
import * as THREE from 'three';

const FFT_SIZE = 256;
const LOG2_FFT = 8; // log2(256)
const CASCADE_COUNT = 2;

// Cascade parameters: [patchSize, windSpeed, windDirX, windDirZ, amplitude]
const CASCADE_PARAMS = [
    { patchSize: 256.0, windSpeed: 12.0, windDirX: 0.8, windDirZ: 0.6, amplitude: 0.0004 },  // large swell
    { patchSize: 32.0,  windSpeed: 6.0,  windDirX: -0.3, windDirZ: 0.9, amplitude: 0.0002 },  // detail chop
];

// Pre-allocated temporaries
const _orthoCamera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0.0, 1.0);

// ─── Fullscreen triangle helper ───
function createFullscreenMesh(material) {
    const geo = new THREE.BufferGeometry();
    // Single triangle covering clip space
    const verts = new Float32Array([-1, -1, 3, -1, -1, 3]);
    const uvs = new Float32Array([0, 0, 2, 0, 0, 2]);
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 2));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    return new THREE.Mesh(geo, material);
}

// ─── GLSL: Initial spectrum H0 (Tessendorf) ───
const H0_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const H0_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform float uFFTSize;
uniform float uPatchSize;
uniform float uWindSpeed;
uniform vec2  uWindDir;
uniform float uAmplitude;
uniform sampler2D uNoise; // gaussian noise RGBA

const float PI = 3.141592653589793;
const float G  = 9.81;
const float JONSWAP_GAMMA = 3.3;

// JONSWAP spectrum
float jonswap(float omega, float omegaPeak) {
    float sigma = omega <= omegaPeak ? 0.07 : 0.09;
    float r = exp(-pow(omega - omegaPeak, 2.0) / (2.0 * sigma * sigma * omegaPeak * omegaPeak));
    float gamma_r = pow(JONSWAP_GAMMA, r);

    float alpha = 0.0081;
    float pm = (alpha * G * G) / pow(omega, 5.0) * exp(-1.25 * pow(omegaPeak / omega, 4.0));
    return pm * gamma_r;
}

// Phillips directional spreading
float phillipsDir(vec2 k, vec2 windDir, float windSpeed) {
    float kLen = length(k);
    if (kLen < 0.0001) return 0.0;

    float L = windSpeed * windSpeed / G;
    float kDotW = dot(normalize(k), windDir);
    float phillips = exp(-1.0 / (kLen * L * kLen * L)) / (kLen * kLen * kLen * kLen);
    // Suppress waves opposite to wind direction
    phillips *= kDotW * kDotW;
    // Damping for very small waves
    float l = L * 0.001;
    phillips *= exp(-kLen * kLen * l * l);
    return phillips;
}

void main() {
    vec4 noise = texture2D(uNoise, vUv);
    // Convert noise from [0,1] to gaussian-like [-1,1] via Box-Muller stored in texture
    vec2 gauss1 = vec2(noise.r, noise.g);
    vec2 gauss2 = vec2(noise.b, noise.a);

    float n = floor(vUv.x * uFFTSize);
    float m = floor(vUv.y * uFFTSize);

    float halfN = uFFTSize * 0.5;
    vec2 k = vec2(
        (2.0 * PI * (n - halfN)) / uPatchSize,
        (2.0 * PI * (m - halfN)) / uPatchSize
    );

    float kLen = length(k);
    if (kLen < 0.0001) {
        gl_FragColor = vec4(0.0);
        return;
    }

    float omega = sqrt(G * kLen);
    float omegaPeak = 0.88 * G / uWindSpeed;

    float spectrum = jonswap(omega, omegaPeak);
    float dirSpread = phillipsDir(k, uWindDir, uWindSpeed);

    float h0 = sqrt(uAmplitude * spectrum * dirSpread / 2.0);

    // h0(k) and h0(-k) conjugate — store both in one texture
    // RG = h0(k) as complex, BA = h0(-k) as complex
    gl_FragColor = vec4(
        gauss1.x * h0,
        gauss1.y * h0,
        gauss2.x * h0,
        gauss2.y * h0
    );
}
`;

// ─── GLSL: Time-evolve spectrum ───
const SPECTRUM_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform float uTime;
uniform float uFFTSize;
uniform float uPatchSize;
uniform sampler2D uH0;

const float PI = 3.141592653589793;
const float G  = 9.81;

void main() {
    vec4 h0 = texture2D(uH0, vUv);
    vec2 h0k  = h0.rg; // h0(k)
    vec2 h0mk = h0.ba; // h0(-k)

    float n = floor(vUv.x * uFFTSize);
    float m = floor(vUv.y * uFFTSize);
    float halfN = uFFTSize * 0.5;

    vec2 k = vec2(
        (2.0 * PI * (n - halfN)) / uPatchSize,
        (2.0 * PI * (m - halfN)) / uPatchSize
    );

    float kLen = length(k);
    float omega = sqrt(G * max(kLen, 0.0001));

    // Dispersion
    float phase = omega * uTime;
    float cosP = cos(phase);
    float sinP = sin(phase);

    // h(k,t) = h0(k) * exp(i*omega*t) + conj(h0(-k)) * exp(-i*omega*t)
    // Complex multiplication
    vec2 ht;
    ht.x = h0k.x * cosP - h0k.y * sinP + h0mk.x * cosP + h0mk.y * sinP;
    ht.y = h0k.x * sinP + h0k.y * cosP - h0mk.x * sinP + h0mk.y * cosP;

    // Also compute dx, dz displacement components (choppy waves)
    vec2 kNorm = kLen > 0.0001 ? k / kLen : vec2(0.0);
    // dx = -i * kx/|k| * h(k,t)
    vec2 dx = vec2(ht.y * kNorm.x, -ht.x * kNorm.x);
    // dz = -i * kz/|k| * h(k,t)
    vec2 dz = vec2(ht.y * kNorm.y, -ht.x * kNorm.y);

    // Pack: RG = height (complex), BA = dx (complex)
    // We'll need a second pass for dz — pack in another target
    gl_FragColor = vec4(ht, dx);
}
`;

const SPECTRUM_DZ_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform float uTime;
uniform float uFFTSize;
uniform float uPatchSize;
uniform sampler2D uH0;

const float PI = 3.141592653589793;
const float G  = 9.81;

void main() {
    vec4 h0 = texture2D(uH0, vUv);
    vec2 h0k  = h0.rg;
    vec2 h0mk = h0.ba;

    float n = floor(vUv.x * uFFTSize);
    float m = floor(vUv.y * uFFTSize);
    float halfN = uFFTSize * 0.5;

    vec2 k = vec2(
        (2.0 * PI * (n - halfN)) / uPatchSize,
        (2.0 * PI * (m - halfN)) / uPatchSize
    );

    float kLen = length(k);
    float omega = sqrt(G * max(kLen, 0.0001));
    float phase = omega * uTime;
    float cosP = cos(phase);
    float sinP = sin(phase);

    vec2 ht;
    ht.x = h0k.x * cosP - h0k.y * sinP + h0mk.x * cosP + h0mk.y * sinP;
    ht.y = h0k.x * sinP + h0k.y * cosP - h0mk.x * sinP + h0mk.y * cosP;

    vec2 kNorm = kLen > 0.0001 ? k / kLen : vec2(0.0);
    vec2 dz = vec2(ht.y * kNorm.y, -ht.x * kNorm.y);

    // For Jacobian-based foam: store partial derivatives
    // dHx/dx and dHz/dz for Jacobian determinant
    vec2 dHx_dx = vec2(-ht.x * kNorm.x * kNorm.x, -ht.y * kNorm.x * kNorm.x);
    // Store dz (complex) in RG, Jacobian terms in BA
    gl_FragColor = vec4(dz, dHx_dx);
}
`;

// ─── GLSL: Butterfly FFT pass ───
const BUTTERFLY_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D uInput;
uniform float uStep;     // which butterfly stage (0..log2N-1)
uniform float uFFTSize;
uniform float uDirection; // 0.0 = horizontal, 1.0 = vertical

const float PI = 3.141592653589793;

vec2 complexMul(vec2 a, vec2 b) {
    return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

void main() {
    float N = uFFTSize;
    float stage = uStep;
    float span = pow(2.0, stage + 1.0);
    float halfSpan = span * 0.5;

    vec2 coord;
    if (uDirection < 0.5) {
        coord = vec2(gl_FragCoord.x, gl_FragCoord.y);
    } else {
        coord = vec2(gl_FragCoord.y, gl_FragCoord.x);
    }

    float idx = coord.x;
    float groupIdx = mod(idx, span);
    bool isTop = groupIdx < halfSpan;

    float partnerIdx;
    if (isTop) {
        partnerIdx = idx + halfSpan;
    } else {
        partnerIdx = idx - halfSpan;
    }

    vec2 selfUV, partnerUV;
    if (uDirection < 0.5) {
        selfUV = vec2(idx / N, gl_FragCoord.y / N);
        partnerUV = vec2(partnerIdx / N, gl_FragCoord.y / N);
    } else {
        selfUV = vec2(gl_FragCoord.x / N, idx / N);
        partnerUV = vec2(gl_FragCoord.x / N, partnerIdx / N);
    }

    vec4 selfVal = texture2D(uInput, selfUV);
    vec4 partnerVal = texture2D(uInput, partnerUV);

    float k = mod(idx, halfSpan);
    float twiddleAngle = -2.0 * PI * k / span;
    vec2 twiddle = vec2(cos(twiddleAngle), sin(twiddleAngle));

    // Apply butterfly to both complex pairs (RG and BA)
    vec2 tw_rg = complexMul(twiddle, partnerVal.rg);
    vec2 tw_ba = complexMul(twiddle, partnerVal.ba);

    if (isTop) {
        gl_FragColor = vec4(selfVal.rg + tw_rg, selfVal.ba + tw_ba);
    } else {
        gl_FragColor = vec4(selfVal.rg - tw_rg, selfVal.ba - tw_ba);
    }
}
`;

// ─── GLSL: Final assembly — combine FFT results into displacement + normal + foam ───
const ASSEMBLE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D uHeightDx; // cascade result: R=height, G=unused, B=dx.real, A=unused
uniform sampler2D uDzJacob;  // cascade result: R=dz.real, G=unused, B=jacobX, A=unused
uniform float uFFTSize;
uniform float uChoppiness;
uniform float uHeightScale;
uniform float uPatchSize;
uniform float uCascadeIndex;

const float PI = 3.141592653589793;

void main() {
    // Bit-reversal sign correction: (-1)^(x+y)
    float x = floor(vUv.x * uFFTSize);
    float y = floor(vUv.y * uFFTSize);
    float sign = mod(x + y, 2.0) < 0.5 ? 1.0 : -1.0;

    vec4 hDx = texture2D(uHeightDx, vUv);
    vec4 dzJ = texture2D(uDzJacob, vUv);

    float height = hDx.r * sign * uHeightScale;
    float dx = hDx.b * sign * uChoppiness;
    float dz = dzJ.r * sign * uChoppiness;

    // Jacobian for foam detection: J = (1 + dDx/dx)(1 + dDz/dz) - (dDx/dz)(dDz/dx)
    // Simplified: foam where Jacobian < threshold (wave folding)
    float jacobX = dzJ.b * sign * uChoppiness;
    float jacobian = 1.0 + jacobX; // simplified — full Jacobian needs cross terms

    // displacement: XYZ
    // foam: in alpha
    float foam = clamp(1.0 - jacobian, 0.0, 1.0);
    foam = smoothstep(0.0, 0.5, foam);

    gl_FragColor = vec4(dx, height, dz, foam);
}
`;

// ─── GLSL: Normal map generation from displacement ───
const NORMAL_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D uDisplacement0; // cascade 0
uniform sampler2D uDisplacement1; // cascade 1
uniform float uFFTSize;
uniform float uPatchSize0;
uniform float uPatchSize1;
uniform float uNormalStrength;

void main() {
    float texel0 = 1.0 / uFFTSize;
    float texel1 = 1.0 / uFFTSize;

    // Sample displacement neighbors — cascade 0
    float h0L = texture2D(uDisplacement0, vUv - vec2(texel0, 0.0)).g;
    float h0R = texture2D(uDisplacement0, vUv + vec2(texel0, 0.0)).g;
    float h0D = texture2D(uDisplacement0, vUv - vec2(0.0, texel0)).g;
    float h0U = texture2D(uDisplacement0, vUv + vec2(0.0, texel0)).g;

    // Sample displacement neighbors — cascade 1
    float h1L = texture2D(uDisplacement1, vUv - vec2(texel1, 0.0)).g;
    float h1R = texture2D(uDisplacement1, vUv + vec2(texel1, 0.0)).g;
    float h1D = texture2D(uDisplacement1, vUv - vec2(0.0, texel1)).g;
    float h1U = texture2D(uDisplacement1, vUv + vec2(0.0, texel1)).g;

    // Finite difference normals
    vec3 n0 = normalize(vec3(
        (h0L - h0R) * uNormalStrength * uFFTSize / uPatchSize0,
        1.0,
        (h0D - h0U) * uNormalStrength * uFFTSize / uPatchSize0
    ));

    vec3 n1 = normalize(vec3(
        (h1L - h1R) * uNormalStrength * uFFTSize / uPatchSize1 * 0.5,
        1.0,
        (h1D - h1U) * uNormalStrength * uFFTSize / uPatchSize1 * 0.5
    ));

    // Blend normals (UDN blending)
    vec3 n = normalize(vec3(n0.x + n1.x, n0.y * n1.y, n0.z + n1.z));

    // Foam: combine from both cascades
    float foam0 = texture2D(uDisplacement0, vUv).a;
    float foam1 = texture2D(uDisplacement1, vUv).a;
    float foam = clamp(foam0 + foam1 * 0.5, 0.0, 1.0);

    gl_FragColor = vec4(n * 0.5 + 0.5, foam);
}
`;

// ─── Gaussian noise texture (CPU-generated once) ───
function createGaussianNoiseTexture(size) {
    const data = new Float32Array(size * size * 4);
    for (let i = 0; i < size * size; i++) {
        // Box-Muller transform for gaussian distribution
        const u1 = Math.max(Math.random(), 1e-6);
        const u2 = Math.random();
        const u3 = Math.max(Math.random(), 1e-6);
        const u4 = Math.random();

        const r1 = Math.sqrt(-2.0 * Math.log(u1));
        const r2 = Math.sqrt(-2.0 * Math.log(u3));

        data[i * 4 + 0] = r1 * Math.cos(2.0 * Math.PI * u2);
        data[i * 4 + 1] = r1 * Math.sin(2.0 * Math.PI * u2);
        data[i * 4 + 2] = r2 * Math.cos(2.0 * Math.PI * u4);
        data[i * 4 + 3] = r2 * Math.sin(2.0 * Math.PI * u4);
    }

    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return tex;
}

// ─── Bit-reversal permutation texture ───
function bitReverse(x, bits) {
    let result = 0;
    for (let i = 0; i < bits; i++) {
        result = (result << 1) | (x & 1);
        x >>= 1;
    }
    return result;
}

function createBitReversalTexture(size) {
    const data = new Float32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
        data[i] = bitReverse(i, bits);
    }
    return data;
}

// ═══════════════════════════════════════════════════════════════════
// FFTOceanCompute class
// ═══════════════════════════════════════════════════════════════════
export class FFTOceanCompute {
    constructor(renderer) {
        this.renderer = renderer;
        this.size = FFT_SIZE;
        this.logSize = LOG2_FFT;

        // Output textures (consumed by waterManager)
        this.displacementTextures = []; // one per cascade
        this.normalFoamTexture = null;  // combined normal + foam

        // Internal render targets
        this._h0Targets = [];
        this._spectrumTargets = [];   // height+dx
        this._spectrumDzTargets = []; // dz+jacobian
        this._pingPong = [null, null];
        this._assembleTargets = [];

        // Shared fullscreen geometry
        this._scene = new THREE.Scene();

        this._initRenderTargets();
        this._initMaterials();
        this._computeH0(); // one-time initial spectrum
    }

    _createRT(width, height) {
        return new THREE.WebGLRenderTarget(width || this.size, height || this.size, {
            type: THREE.FloatType,
            format: THREE.RGBAFormat,
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            wrapS: THREE.RepeatWrapping,
            wrapT: THREE.RepeatWrapping,
            depthBuffer: false,
            stencilBuffer: false,
            generateMipmaps: false,
        });
    }

    _initRenderTargets() {
        // Per-cascade targets
        for (let c = 0; c < CASCADE_COUNT; c++) {
            this._h0Targets.push(this._createRT());
            this._spectrumTargets.push(this._createRT());
            this._spectrumDzTargets.push(this._createRT());
            this._assembleTargets.push(this._createRT());
            this.displacementTextures.push(null); // filled after first compute
        }

        // Ping-pong for FFT butterfly
        this._pingPong[0] = this._createRT();
        this._pingPong[1] = this._createRT();

        // Combined normal+foam output
        this._normalFoamTarget = this._createRT();
    }

    _initMaterials() {
        const noiseTextures = [];
        for (let c = 0; c < CASCADE_COUNT; c++) {
            noiseTextures.push(createGaussianNoiseTexture(this.size));
        }

        // H0 materials (one per cascade, different noise + params)
        this._h0Materials = [];
        for (let c = 0; c < CASCADE_COUNT; c++) {
            const p = CASCADE_PARAMS[c];
            this._h0Materials.push(new THREE.ShaderMaterial({
                vertexShader: H0_VERT,
                fragmentShader: H0_FRAG,
                uniforms: {
                    uFFTSize:   { value: this.size },
                    uPatchSize: { value: p.patchSize },
                    uWindSpeed: { value: p.windSpeed },
                    uWindDir:   { value: new THREE.Vector2(p.windDirX, p.windDirZ) },
                    uAmplitude: { value: p.amplitude },
                    uNoise:     { value: noiseTextures[c] },
                },
                depthTest: false,
                depthWrite: false,
            }));
        }

        // Spectrum evolution materials
        this._spectrumMaterials = [];
        this._spectrumDzMaterials = [];
        for (let c = 0; c < CASCADE_COUNT; c++) {
            const p = CASCADE_PARAMS[c];
            this._spectrumMaterials.push(new THREE.ShaderMaterial({
                vertexShader: H0_VERT,
                fragmentShader: SPECTRUM_FRAG,
                uniforms: {
                    uTime:      { value: 0 },
                    uFFTSize:   { value: this.size },
                    uPatchSize: { value: p.patchSize },
                    uH0:        { value: null }, // set at render time
                },
                depthTest: false,
                depthWrite: false,
            }));
            this._spectrumDzMaterials.push(new THREE.ShaderMaterial({
                vertexShader: H0_VERT,
                fragmentShader: SPECTRUM_DZ_FRAG,
                uniforms: {
                    uTime:      { value: 0 },
                    uFFTSize:   { value: this.size },
                    uPatchSize: { value: p.patchSize },
                    uH0:        { value: null },
                },
                depthTest: false,
                depthWrite: false,
            }));
        }

        // Butterfly FFT material (shared, uniforms swapped per pass)
        this._butterflyMaterial = new THREE.ShaderMaterial({
            vertexShader: H0_VERT,
            fragmentShader: BUTTERFLY_FRAG,
            uniforms: {
                uInput:     { value: null },
                uStep:      { value: 0 },
                uFFTSize:   { value: this.size },
                uDirection: { value: 0 },
            },
            depthTest: false,
            depthWrite: false,
        });

        // Assembly materials (per cascade)
        this._assembleMaterials = [];
        for (let c = 0; c < CASCADE_COUNT; c++) {
            const p = CASCADE_PARAMS[c];
            this._assembleMaterials.push(new THREE.ShaderMaterial({
                vertexShader: H0_VERT,
                fragmentShader: ASSEMBLE_FRAG,
                uniforms: {
                    uHeightDx:     { value: null },
                    uDzJacob:      { value: null },
                    uFFTSize:      { value: this.size },
                    uChoppiness:   { value: 1.5 },
                    uHeightScale:  { value: 1.0 },
                    uPatchSize:    { value: p.patchSize },
                    uCascadeIndex: { value: c },
                },
                depthTest: false,
                depthWrite: false,
            }));
        }

        // Normal generation material
        this._normalMaterial = new THREE.ShaderMaterial({
            vertexShader: H0_VERT,
            fragmentShader: NORMAL_FRAG,
            uniforms: {
                uDisplacement0: { value: null },
                uDisplacement1: { value: null },
                uFFTSize:       { value: this.size },
                uPatchSize0:    { value: CASCADE_PARAMS[0].patchSize },
                uPatchSize1:    { value: CASCADE_PARAMS[1].patchSize },
                uNormalStrength: { value: 2.0 },
            },
            depthTest: false,
            depthWrite: false,
        });

        // Fullscreen quad
        this._mesh = createFullscreenMesh(this._h0Materials[0]);
        this._scene.add(this._mesh);
    }

    _renderPass(material, target) {
        this._mesh.material = material;
        const prevTarget = this.renderer.getRenderTarget();
        this.renderer.setRenderTarget(target);
        this.renderer.render(this._scene, _orthoCamera);
        this.renderer.setRenderTarget(prevTarget);
    }

    _computeH0() {
        for (let c = 0; c < CASCADE_COUNT; c++) {
            this._renderPass(this._h0Materials[c], this._h0Targets[c]);
        }
    }

    _runFFT(inputTarget, outputTarget) {
        // Horizontal passes
        let readTarget = inputTarget;
        for (let step = 0; step < this.logSize; step++) {
            const writeIdx = step % 2;
            const writeTarget = this._pingPong[writeIdx];

            this._butterflyMaterial.uniforms.uInput.value = readTarget.texture;
            this._butterflyMaterial.uniforms.uStep.value = step;
            this._butterflyMaterial.uniforms.uDirection.value = 0.0;

            this._renderPass(this._butterflyMaterial, writeTarget);
            readTarget = writeTarget;
        }

        // Vertical passes
        for (let step = 0; step < this.logSize; step++) {
            const isLast = step === this.logSize - 1;
            const writeTarget = isLast ? outputTarget : this._pingPong[step % 2];

            this._butterflyMaterial.uniforms.uInput.value = readTarget.texture;
            this._butterflyMaterial.uniforms.uStep.value = step;
            this._butterflyMaterial.uniforms.uDirection.value = 1.0;

            this._renderPass(this._butterflyMaterial, writeTarget);
            readTarget = writeTarget;
        }
    }

    /**
     * Called each frame from main animation loop.
     * @param {number} time — elapsed time in seconds
     */
    update(time) {
        for (let c = 0; c < CASCADE_COUNT; c++) {
            // 1. Evolve spectrum in time
            this._spectrumMaterials[c].uniforms.uTime.value = time;
            this._spectrumMaterials[c].uniforms.uH0.value = this._h0Targets[c].texture;
            this._renderPass(this._spectrumMaterials[c], this._spectrumTargets[c]);

            this._spectrumDzMaterials[c].uniforms.uTime.value = time;
            this._spectrumDzMaterials[c].uniforms.uH0.value = this._h0Targets[c].texture;
            this._renderPass(this._spectrumDzMaterials[c], this._spectrumDzTargets[c]);

            // 2. Run iFFT on height+dx
            this._runFFT(this._spectrumTargets[c], this._pingPong[0]);

            // 3. Run iFFT on dz+jacobian
            this._runFFT(this._spectrumDzTargets[c], this._pingPong[1]);

            // 4. Assemble displacement
            this._assembleMaterials[c].uniforms.uHeightDx.value = this._pingPong[0].texture;
            this._assembleMaterials[c].uniforms.uDzJacob.value = this._pingPong[1].texture;
            this._renderPass(this._assembleMaterials[c], this._assembleTargets[c]);

            this.displacementTextures[c] = this._assembleTargets[c].texture;
        }

        // 5. Generate combined normal + foam map
        this._normalMaterial.uniforms.uDisplacement0.value = this.displacementTextures[0];
        this._normalMaterial.uniforms.uDisplacement1.value = this.displacementTextures[1];
        this._renderPass(this._normalMaterial, this._normalFoamTarget);
        this.normalFoamTexture = this._normalFoamTarget.texture;
    }

    dispose() {
        // Dispose all render targets
        for (const rt of [
            ...this._h0Targets,
            ...this._spectrumTargets,
            ...this._spectrumDzTargets,
            ...this._assembleTargets,
            ...this._pingPong,
            this._normalFoamTarget,
        ]) {
            if (rt) rt.dispose();
        }

        // Dispose materials
        for (const m of [
            ...this._h0Materials,
            ...this._spectrumMaterials,
            ...this._spectrumDzMaterials,
            ...this._assembleMaterials,
            this._butterflyMaterial,
            this._normalMaterial,
        ]) {
            if (m) m.dispose();
        }

        // Dispose mesh geometry
        if (this._mesh) this._mesh.geometry.dispose();
    }
}

// ─── Tuning exposure via window ───
window.fftOceanParams = {
    get choppiness()   { return CASCADE_PARAMS[0].amplitude; },
    set choppiness(v)  { CASCADE_PARAMS[0].amplitude = v; },
    get windSpeed()    { return CASCADE_PARAMS[0].windSpeed; },
    set windSpeed(v)   { CASCADE_PARAMS[0].windSpeed = v; },
    get detailChop()   { return CASCADE_PARAMS[1].amplitude; },
    set detailChop(v)  { CASCADE_PARAMS[1].amplitude = v; },
};