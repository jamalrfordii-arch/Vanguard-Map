// terrainTextures.js — Procedural biome texture generation for terrain PBR
// Generates albedo+height and normal textures for 4 biomes entirely in JS.
// No external image assets required — everything is deterministic and reproducible.

import * as THREE from 'three';

// ── Noise helpers ────────────────────────────────────────────────────────────

function _hash(x, y) {
    let h = (x * 374761393 + y * 668265263 + 1013904223) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h = h ^ (h >>> 16);
    return (h & 0x7fffffff) / 0x7fffffff; // 0..1
}

function _smootherstep(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
}

function _valueNoise(px, py) {
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    const fx = _smootherstep(px - ix);
    const fy = _smootherstep(py - iy);
    const a = _hash(ix, iy);
    const b = _hash(ix + 1, iy);
    const c = _hash(ix, iy + 1);
    const d = _hash(ix + 1, iy + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

function _fbm(px, py, octaves, lacunarity, gain) {
    let sum = 0, amp = 1, freq = 1, max = 0;
    for (let i = 0; i < octaves; i++) {
        sum += _valueNoise(px * freq, py * freq) * amp;
        max += amp;
        amp *= gain;
        freq *= lacunarity;
    }
    return sum / max;
}

// ── Texture generation ───────────────────────────────────────────────────────

const TEX_SIZE = 512;

/**
 * Generate a single biome texture pair: albedo+height (RGBA) and normal (RGB).
 * Returns { albedo: THREE.DataTexture, normal: THREE.DataTexture }
 *
 * @param {object} opts
 * @param {number[]} opts.baseColor  — [r, g, b] 0–1
 * @param {number[]} opts.tintColor  — [r, g, b] 0–1 variation colour
 * @param {number}   opts.tintAmount — 0–1 how much tint noise
 * @param {number}   opts.noiseScale — spatial frequency
 * @param {number}   opts.bumpScale  — height variation 0–1
 * @param {number}   opts.roughnessBase — for encoding in alpha as micro-height
 */
function _generateBiomeTex(opts) {
    const {
        baseColor, tintColor, tintAmount = 0.3,
        noiseScale = 8, bumpScale = 0.5, seed = 0,
    } = opts;

    const size = TEX_SIZE;
    const albedoData = new Uint8Array(size * size * 4);
    const normalData = new Uint8Array(size * size * 4);

    // First pass — generate height field for normal computation
    const heightField = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const px = (x / size) * noiseScale + seed * 17.31;
            const py = (y / size) * noiseScale + seed * 23.77;
            const h = _fbm(px, py, 6, 2.0, 0.5);
            heightField[y * size + x] = h;
        }
    }

    // Second pass — compute normals from height field and write albedo+height
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const idx = (y * size + x) * 4;
            const h = heightField[y * size + x];

            // ── Albedo ──
            const tintNoise = _fbm(
                (x / size) * noiseScale * 0.7 + seed * 5.13,
                (y / size) * noiseScale * 0.7 + seed * 7.91,
                4, 2.0, 0.45
            );
            const t = tintNoise * tintAmount;
            const detailNoise = _fbm(
                (x / size) * noiseScale * 3.0 + seed * 11.3,
                (y / size) * noiseScale * 3.0 + seed * 13.7,
                3, 2.0, 0.5
            );
            const detail = (detailNoise - 0.5) * 0.15;

            let r = baseColor[0] * (1 - t) + tintColor[0] * t + detail;
            let g = baseColor[1] * (1 - t) + tintColor[1] * t + detail;
            let b = baseColor[2] * (1 - t) + tintColor[2] * t + detail;

            albedoData[idx]     = Math.max(0, Math.min(255, (r * 255) | 0));
            albedoData[idx + 1] = Math.max(0, Math.min(255, (g * 255) | 0));
            albedoData[idx + 2] = Math.max(0, Math.min(255, (b * 255) | 0));
            // Alpha = micro-height for height-aware blending
            albedoData[idx + 3] = Math.max(0, Math.min(255, (h * bumpScale * 255) | 0));

            // ── Normal from height field (Sobel) ──
            const xm = x > 0 ? x - 1 : size - 1;
            const xp = x < size - 1 ? x + 1 : 0;
            const ym = y > 0 ? y - 1 : size - 1;
            const yp = y < size - 1 ? y + 1 : 0;

            const dhdx = (heightField[y * size + xp] - heightField[y * size + xm]) * bumpScale;
            const dhdy = (heightField[yp * size + x] - heightField[ym * size + x]) * bumpScale;

            // Tangent-space normal
            const scale = 2.0;
            let nx = -dhdx * scale;
            let ny = -dhdy * scale;
            let nz = 1.0;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            nx /= len; ny /= len; nz /= len;

            normalData[idx]     = ((nx * 0.5 + 0.5) * 255) | 0;
            normalData[idx + 1] = ((ny * 0.5 + 0.5) * 255) | 0;
            normalData[idx + 2] = ((nz * 0.5 + 0.5) * 255) | 0;
            normalData[idx + 3] = 255;
        }
    }

    const albedoTex = new THREE.DataTexture(albedoData, size, size, THREE.RGBAFormat);
    albedoTex.wrapS = albedoTex.wrapT = THREE.RepeatWrapping;
    albedoTex.minFilter = THREE.LinearMipmapLinearFilter;
    albedoTex.magFilter = THREE.LinearFilter;
    albedoTex.generateMipmaps = true;
    albedoTex.needsUpdate = true;

    const normalTex = new THREE.DataTexture(normalData, size, size, THREE.RGBAFormat);
    normalTex.wrapS = normalTex.wrapT = THREE.RepeatWrapping;
    normalTex.minFilter = THREE.LinearMipmapLinearFilter;
    normalTex.magFilter = THREE.LinearFilter;
    normalTex.generateMipmaps = true;
    normalTex.needsUpdate = true;

    return { albedo: albedoTex, normal: normalTex };
}

// ── 256×256 blue noise texture for anti-tiling ──
function _generateNoiseTex() {
    const size = 256;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const idx = (y * size + x) * 4;
            data[idx]     = (_hash(x, y) * 255) | 0;
            data[idx + 1] = (_hash(x + 7919, y + 6271) * 255) | 0;
            data[idx + 2] = (_hash(x + 1303, y + 9377) * 255) | 0;
            data[idx + 3] = (_hash(x + 4219, y + 3571) * 255) | 0;
        }
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
}

// ── Public API ───────────────────────────────────────────────────────────────

let _textureSet = null;

/**
 * Generate all terrain biome textures. Call once during init.
 * Returns { grass, rock, snow, soil, noise }
 * Each biome entry has { albedo, normal } as THREE.DataTexture.
 */
export function generateTerrainTextures() {
    if (_textureSet) return _textureSet;

    console.time('[TerrainTex] generate');

    const grass = _generateBiomeTex({
        baseColor:  [0.22, 0.35, 0.12],
        tintColor:  [0.30, 0.42, 0.15],
        tintAmount: 0.4,
        noiseScale: 10,
        bumpScale:  0.3,
        seed: 1,
    });

    const rock = _generateBiomeTex({
        baseColor:  [0.38, 0.34, 0.30],
        tintColor:  [0.32, 0.28, 0.24],
        tintAmount: 0.35,
        noiseScale: 6,
        bumpScale:  0.8,
        seed: 2,
    });

    const snow = _generateBiomeTex({
        baseColor:  [0.85, 0.87, 0.92],
        tintColor:  [0.78, 0.82, 0.88],
        tintAmount: 0.2,
        noiseScale: 12,
        bumpScale:  0.15,
        seed: 3,
    });

    const soil = _generateBiomeTex({
        baseColor:  [0.18, 0.26, 0.10],
        tintColor:  [0.28, 0.20, 0.10],
        tintAmount: 0.5,
        noiseScale: 8,
        bumpScale:  0.55,
        seed: 4,
    });

    const noise = _generateNoiseTex();

    console.timeEnd('[TerrainTex] generate');

    _textureSet = { grass, rock, snow, soil, noise };
    return _textureSet;
}

/**
 * Dispose all generated textures.
 */
export function disposeTerrainTextures() {
    if (!_textureSet) return;
    for (const key of ['grass', 'rock', 'snow', 'soil']) {
        _textureSet[key].albedo.dispose();
        _textureSet[key].normal.dispose();
    }
    _textureSet.noise.dispose();
    _textureSet = null;
}