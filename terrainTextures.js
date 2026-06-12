// terrainTextures.js — Procedural biome texture generation
//
// Generates albedo+height and normal textures for 4 terrain biomes entirely
// in JavaScript — no external image assets required.
// Each texture is 512×512, deterministic, and reproducible.
//
// Usage:
//   import { generateTerrainTextures } from './terrainTextures.js';
//   const { grass, rock, snow, soil, noise } = generateTerrainTextures();
//   // Each biome: { albedo: DataTexture, normal: DataTexture }
//   // noise: DataTexture (256×256 for anti-tiling UV rotation)

import * as THREE from 'three';

// ── Noise helpers ─────────────────────────────────────────────────────────────

function _hash(x, y) {
    let h = (x * 374761393 + y * 668265263 + 1013904223) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h = h ^ (h >>> 16);
    return (h & 0x7fffffff) / 0x7fffffff;
}

function _smootherstep(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
}

function _valueNoise(px, py) {
    const ix = Math.floor(px), iy = Math.floor(py);
    const fx = _smootherstep(px - ix), fy = _smootherstep(py - iy);
    const a = _hash(ix, iy), b = _hash(ix + 1, iy);
    const c = _hash(ix, iy + 1), d = _hash(ix + 1, iy + 1);
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

// ── Texture generation ────────────────────────────────────────────────────────

const TEX_SIZE = 512;

function _generateBiomeTex(opts) {
    const {
        baseColor, tintColor,
        tintAmount = 0.3,
        noiseScale = 8,
        bumpScale  = 0.5,
        seed       = 0,
    } = opts;

    const S = TEX_SIZE;
    const albedoData = new Uint8Array(S * S * 4);
    const normalData  = new Uint8Array(S * S * 4);
    const heightField = new Float32Array(S * S);

    // Pass 1 — height field
    for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
            heightField[y * S + x] = _fbm(
                (x / S) * noiseScale + seed * 17.31,
                (y / S) * noiseScale + seed * 23.77,
                6, 2.0, 0.5
            );
        }
    }

    // Pass 2 — albedo + normals
    for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
            const idx = (y * S + x) * 4;
            const h   = heightField[y * S + x];

            // Albedo
            const tintN = _fbm(
                (x / S) * noiseScale * 0.7 + seed * 5.13,
                (y / S) * noiseScale * 0.7 + seed * 7.91,
                4, 2.0, 0.45
            );
            const t = tintN * tintAmount;
            const det = (_fbm(
                (x / S) * noiseScale * 3.0 + seed * 11.3,
                (y / S) * noiseScale * 3.0 + seed * 13.7,
                3, 2.0, 0.5
            ) - 0.5) * 0.15;

            albedoData[idx]     = Math.max(0, Math.min(255, ((baseColor[0] * (1-t) + tintColor[0] * t + det) * 255) | 0));
            albedoData[idx + 1] = Math.max(0, Math.min(255, ((baseColor[1] * (1-t) + tintColor[1] * t + det) * 255) | 0));
            albedoData[idx + 2] = Math.max(0, Math.min(255, ((baseColor[2] * (1-t) + tintColor[2] * t + det) * 255) | 0));
            albedoData[idx + 3] = Math.max(0, Math.min(255, (h * bumpScale * 255) | 0));  // micro-height

            // Normal (Sobel)
            const xm = x > 0 ? x - 1 : S - 1, xp = x < S - 1 ? x + 1 : 0;
            const ym = y > 0 ? y - 1 : S - 1, yp = y < S - 1 ? y + 1 : 0;
            const dhdx = (heightField[y * S + xp] - heightField[y * S + xm]) * bumpScale * 2.0;
            const dhdy = (heightField[yp * S + x] - heightField[ym * S + x]) * bumpScale * 2.0;
            const len  = Math.sqrt(dhdx*dhdx + dhdy*dhdy + 1);
            normalData[idx]     = ((-dhdx / len) * 0.5 + 0.5) * 255 | 0;
            normalData[idx + 1] = ((-dhdy / len) * 0.5 + 0.5) * 255 | 0;
            normalData[idx + 2] = ((1.0    / len) * 0.5 + 0.5) * 255 | 0;
            normalData[idx + 3] = 255;
        }
    }

    function makeTex(data) {
        const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.minFilter       = THREE.LinearMipmapLinearFilter;
        t.magFilter       = THREE.LinearFilter;
        t.generateMipmaps = true;
        t.needsUpdate     = true;
        return t;
    }

    return { albedo: makeTex(albedoData), normal: makeTex(normalData) };
}

function _generateNoiseTex() {
    const S = 256;
    const data = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
            const idx = (y * S + x) * 4;
            data[idx]     = (_hash(x,       y      ) * 255) | 0;
            data[idx + 1] = (_hash(x + 7919, y + 6271) * 255) | 0;
            data[idx + 2] = (_hash(x + 1303, y + 9377) * 255) | 0;
            data[idx + 3] = (_hash(x + 4219, y + 3571) * 255) | 0;
        }
    }
    const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter       = THREE.LinearMipmapLinearFilter;
    t.magFilter       = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate     = true;
    return t;
}

// ── Public API ────────────────────────────────────────────────────────────────

let _cache = null;

export function generateTerrainTextures() {
    if (_cache) return _cache;
    console.time('[TerrainTex] generate');

    const grass = _generateBiomeTex({
        baseColor: [0.22, 0.35, 0.12], tintColor: [0.30, 0.42, 0.15],
        tintAmount: 0.4, noiseScale: 10, bumpScale: 0.30, seed: 1,
    });
    const rock = _generateBiomeTex({
        baseColor: [0.38, 0.34, 0.30], tintColor: [0.32, 0.28, 0.24],
        tintAmount: 0.35, noiseScale: 6, bumpScale: 0.80, seed: 2,
    });
    const snow = _generateBiomeTex({
        baseColor: [0.85, 0.87, 0.92], tintColor: [0.78, 0.82, 0.88],
        tintAmount: 0.20, noiseScale: 12, bumpScale: 0.15, seed: 3,
    });
    const soil = _generateBiomeTex({
        baseColor: [0.18, 0.26, 0.10], tintColor: [0.28, 0.20, 0.10],
        tintAmount: 0.50, noiseScale: 8, bumpScale: 0.55, seed: 4,
    });
    const noise = _generateNoiseTex();

    console.timeEnd('[TerrainTex] generate');
    _cache = { grass, rock, snow, soil, noise };
    return _cache;
}

export function disposeTerrainTextures() {
    if (!_cache) return;
    for (const key of ['grass', 'rock', 'snow', 'soil']) {
        _cache[key].albedo.dispose();
        _cache[key].normal.dispose();
    }
    _cache.noise.dispose();
    _cache = null;
}
