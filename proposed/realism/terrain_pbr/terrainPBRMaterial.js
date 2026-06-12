// terrainPBRMaterial.js — UE5-quality terrain PBR material via onBeforeCompile
//
// Injects triplanar PBR with height-aware biome splatting into MeshStandardMaterial.
// 4 biomes: grass (low flat), rock (steep/mid), snow (high peaks), soil/forest (mid flat).
// Anti-tiling via hash-rotated UV + dual-frequency sampling.
//
// Designed for continentMesh.js — replaces the plain vertexColors material with
// full PBR while preserving all existing behaviour (opacity fade, polygon offset,
// contour lines, ridge glow).

import * as THREE from 'three';
import { generateTerrainTextures } from './terrainTextures.js';
import { MAP_WIDTH, MAP_HEIGHT } from './config.js';

// ── Reusable GLSL snippets ──────────────────────────────────────────────────

const GLSL_COMMON = /* glsl */ `
// ── Terrain PBR uniforms ──
uniform sampler2D u_grassAlbedo;
uniform sampler2D u_grassNormal;
uniform sampler2D u_rockAlbedo;
uniform sampler2D u_rockNormal;
uniform sampler2D u_snowAlbedo;
uniform sampler2D u_snowNormal;
uniform sampler2D u_soilAlbedo;
uniform sampler2D u_soilNormal;
uniform sampler2D u_noiseTex;
uniform sampler2D u_macroNormal;
uniform float u_pbrEnabled;
uniform float u_triplanarSharpness;
uniform float u_texScale;
uniform float u_snowLine;
uniform float u_snowBlend;
uniform float u_slopeRockThreshold;
uniform float u_slopeRockBlend;
uniform float u_heightBlendDepth;
uniform float u_detailNormalStrength;
uniform float u_macroNormalStrength;
uniform float u_antiTileStrength;
uniform float u_satColorMix;
uniform vec2  u_mapSize;
`;

const GLSL_VERTEX_PARS = /* glsl */ `
// ── Terrain PBR varyings (vertex) ──
varying vec3 v_worldPos;
varying vec3 v_worldNormal;
varying vec2 v_terrainUV;
varying float v_elevation;
varying float v_slope;
`;

const GLSL_VERTEX_MAIN = /* glsl */ `
// ── Terrain PBR vertex outputs ──
v_worldPos = (modelMatrix * vec4(position, 1.0)).xyz;
v_worldNormal = normalize(normalMatrix * normal);
// UV spanning entire map for macro normal + splat lookup
v_terrainUV = vec2(
    position.x / u_mapSize.x + 0.5,
    position.z / u_mapSize.y + 0.5
);
v_elevation = position.y;
v_slope = 1.0 - abs(v_worldNormal.y);
`;

const GLSL_FRAGMENT_PARS = /* glsl */ `
// ── Terrain PBR varyings (fragment) ──
varying vec3 v_worldPos;
varying vec3 v_worldNormal;
varying vec2 v_terrainUV;
varying float v_elevation;
varying float v_slope;

// ── Anti-tiling: hash-based UV rotation ──
vec2 terrainAntiTileUV(vec2 uv, float scale) {
    vec2 tileID = floor(uv * scale);
    // Deterministic rotation per tile
    float angle = texture2D(u_noiseTex, tileID * 0.0073).r * 6.2832 * u_antiTileStrength;
    float c = cos(angle);
    float s = sin(angle);
    vec2 center = (tileID + 0.5) / scale;
    vec2 d = uv - center;
    return center + vec2(c * d.x - s * d.y, s * d.x + c * d.y);
}

// ── Triplanar sampling with anti-tiling ──
vec4 triplanarSample(sampler2D tex, vec3 worldPos, vec3 blendWeights, float scale) {
    vec2 uvX = worldPos.zy * scale;
    vec2 uvY = worldPos.xz * scale;
    vec2 uvZ = worldPos.xy * scale;

    // Anti-tile on the dominant projection only for perf
    uvY = terrainAntiTileUV(uvY, 1.0 / (scale * 4.0));

    vec4 sX = texture2D(tex, uvX);
    vec4 sY = texture2D(tex, uvY);
    vec4 sZ = texture2D(tex, uvZ);
    return sX * blendWeights.x + sY * blendWeights.y + sZ * blendWeights.z;
}

// ── Standard UV sampling with anti-tiling (for flat terrain) ──
vec4 flatSample(sampler2D tex, vec3 worldPos, float scale) {
    vec2 uv = worldPos.xz * scale;
    uv = terrainAntiTileUV(uv, 1.0 / (scale * 4.0));

    // Dual-frequency sampling to reduce tiling
    vec4 s1 = texture2D(tex, uv);
    vec4 s2 = texture2D(tex, uv * 3.17); // Irrational scale avoids Moiré
    return mix(s1, s2, 0.25);
}

// ── Height-aware blend between two biome layers ──
// Uses alpha channel as micro-height for depth-based transitions
float heightBlend(float h1, float a1, float h2, float a2, float depth) {
    float ma = max(h1 + a1, h2 + a2) - depth;
    float b1 = max(h1 + a1 - ma, 0.0);
    float b2 = max(h2 + a2 - ma, 0.0);
    float sum = b1 + b2;
    return sum > 0.001 ? b1 / sum : (a1 > a2 ? 1.0 : 0.0);
}

// ── Sample a biome: albedo.rgb + micro-height from albedo.a ──
struct BiomeSample {
    vec3 albedo;
    vec3 normal;
    float height;
};

BiomeSample sampleBiome(
    sampler2D albedoTex, sampler2D normalTex,
    vec3 worldPos, vec3 triWeights, float useTriplanar, float scale
) {
    BiomeSample bs;
    if (useTriplanar > 0.5) {
        vec4 a = triplanarSample(albedoTex, worldPos, triWeights, scale);
        vec4 n = triplanarSample(normalTex, worldPos, triWeights, scale);
        bs.albedo = a.rgb;
        bs.height = a.a;
        bs.normal = n.rgb * 2.0 - 1.0;
    } else {
        vec4 a = flatSample(albedoTex, worldPos, scale);
        vec4 n = flatSample(normalTex, worldPos, scale);
        bs.albedo = a.rgb;
        bs.height = a.a;
        bs.normal = n.rgb * 2.0 - 1.0;
    }
    return bs;
}
`;

const GLSL_FRAGMENT_MAIN = /* glsl */ `
// ── Terrain PBR main fragment logic ──
if (u_pbrEnabled > 0.5) {
    // ── Triplanar blend weights ──
    vec3 absNorm = abs(v_worldNormal);
    float sharpness = u_triplanarSharpness;
    vec3 triWeights = pow(absNorm, vec3(sharpness));
    triWeights /= (triWeights.x + triWeights.y + triWeights.z + 0.0001);

    float useTriplanar = step(0.45, v_slope);
    float texScale = u_texScale;

    // ── Sample all 4 biomes ──
    BiomeSample grassS = sampleBiome(u_grassAlbedo, u_grassNormal, v_worldPos, triWeights, useTriplanar, texScale);
    BiomeSample rockS  = sampleBiome(u_rockAlbedo,  u_rockNormal,  v_worldPos, triWeights, useTriplanar, texScale * 0.8);
    BiomeSample snowS  = sampleBiome(u_snowAlbedo,  u_snowNormal,  v_worldPos, triWeights, useTriplanar, texScale * 1.2);
    BiomeSample soilS  = sampleBiome(u_soilAlbedo,  u_soilNormal,  v_worldPos, triWeights, useTriplanar, texScale * 0.9);

    // ── Biome weights from elevation + slope ──
    // Slope → rock
    float slopeT = v_slope;
    float rockWeight = smoothstep(
        u_slopeRockThreshold - u_slopeRockBlend,
        u_slopeRockThreshold + u_slopeRockBlend,
        slopeT
    );

    // Elevation → snow
    float snowWeight = smoothstep(
        u_snowLine - u_snowBlend,
        u_snowLine + u_snowBlend,
        v_elevation
    ) * (1.0 - rockWeight * 0.6); // Less snow on cliffs

    // Base biome: grass at low elevation, soil/forest at mid
    float soilWeight = smoothstep(1.0, 5.0, v_elevation) * smoothstep(15.0, 8.0, v_elevation);
    soilWeight *= (1.0 - rockWeight) * (1.0 - snowWeight);

    float grassWeight = max(0.0, 1.0 - rockWeight - snowWeight - soilWeight);

    // ── Height-aware blending ──
    float depth = u_heightBlendDepth;

    // Step 1: blend grass + soil
    float gs = heightBlend(grassS.height, grassWeight, soilS.height, soilWeight, depth);
    vec3 gsAlbedo  = mix(soilS.albedo,  grassS.albedo,  gs);
    vec3 gsNormal  = mix(soilS.normal,  grassS.normal,  gs);
    float gsHeight = mix(soilS.height,  grassS.height,  gs);
    float gsWeight = grassWeight + soilWeight;

    // Step 2: blend (grass+soil) with rock
    float gr = heightBlend(gsHeight, gsWeight, rockS.height, rockWeight, depth);
    vec3 grAlbedo  = mix(rockS.albedo,  gsAlbedo,  gr);
    vec3 grNormal  = mix(rockS.normal,  gsNormal,  gr);
    float grHeight = mix(rockS.height,  gsHeight,  gr);
    float grWeight = gsWeight + rockWeight;

    // Step 3: blend with snow
    float finalBlend = heightBlend(grHeight, grWeight, snowS.height, snowWeight, depth);
    vec3 finalAlbedo = mix(snowS.albedo, grAlbedo, finalBlend);
    vec3 finalNormal = mix(snowS.normal, grNormal, finalBlend);

    // ── Macro normal map ──
    vec3 macroN = texture2D(u_macroNormal, v_terrainUV).rgb * 2.0 - 1.0;
    macroN.xy *= u_macroNormalStrength;

    // ── Combine detail + macro normals (UDN blending) ──
    vec3 detailN = finalNormal * vec3(u_detailNormalStrength, u_detailNormalStrength, 1.0);
    vec3 combinedN = normalize(vec3(
        macroN.x + detailN.x,
        macroN.y + detailN.y,
        macroN.z
    ));

    // ── Mix PBR albedo with original satellite vertex color ──
    vec3 satColor = diffuseColor.rgb;
    diffuseColor.rgb = mix(finalAlbedo, satColor, u_satColorMix);

    // ── Apply roughness variation from biome ──
    // Rock is rougher, snow is smoother
    float roughnessVar = mix(0.0, 0.15, rockWeight) - mix(0.0, 0.1, snowWeight);
    roughnessFactor = clamp(roughnessFactor + roughnessVar, 0.05, 1.0);

    // ── Perturb geometric normal with combined normal map ──
    // We work in tangent space approximation — for mostly-Y-up terrain this is sufficient
    // Build TBN from world normal
    vec3 N = normalize(v_worldNormal);
    vec3 T = normalize(cross(N, vec3(0.0, 0.0, 1.0)));
    if (length(T) < 0.001) T = normalize(cross(N, vec3(1.0, 0.0, 0.0)));
    vec3 B = cross(N, T);
    mat3 TBN = mat3(T, B, N);

    vec3 perturbedNormal = normalize(TBN * combinedN);
    // Inject into Three.js lighting pipeline
    normal = perturbedNormal;
}
`;

// ── Material creation ────────────────────────────────────────────────────────

/**
 * Create a terrain PBR material based on MeshStandardMaterial.
 *
 * @param {object} opts
 * @param {THREE.Texture|null} opts.macroNormalMap — from loadNormalMap() or null
 * @returns {THREE.MeshStandardMaterial} — enhanced with terrain PBR
 */
export function createTerrainPBRMaterial(opts = {}) {
    const textures = generateTerrainTextures();

    // Dummy 1×1 white texture for macro normal when not available
    const defaultNormal = new THREE.DataTexture(
        new Uint8Array([128, 128, 255, 255]), 1, 1, THREE.RGBAFormat
    );
    defaultNormal.needsUpdate = true;

    const macroNormal = opts.macroNormalMap || defaultNormal;

    const uniforms = {
        u_grassAlbedo:         { value: textures.grass.albedo },
        u_grassNormal:         { value: textures.grass.normal },
        u_rockAlbedo:          { value: textures.rock.albedo },
        u_rockNormal:          { value: textures.rock.normal },
        u_snowAlbedo:          { value: textures.snow.albedo },
        u_snowNormal:          { value: textures.snow.normal },
        u_soilAlbedo:          { value: textures.soil.albedo },
        u_soilNormal:          { value: textures.soil.normal },
        u_noiseTex:            { value: textures.noise },
        u_macroNormal:         { value: macroNormal },
        u_pbrEnabled:          { value: 1.0 },
        u_triplanarSharpness:  { value: 4.0 },
        u_texScale:            { value: 0.035 },
        u_snowLine:            { value: 18.0 },
        u_snowBlend:           { value: 4.0 },
        u_slopeRockThreshold:  { value: 0.55 },
        u_slopeRockBlend:      { value: 0.15 },
        u_heightBlendDepth:    { value: 0.15 },
        u_detailNormalStrength: { value: 0.6 },
        u_macroNormalStrength:  { value: 0.8 },
        u_antiTileStrength:    { value: 0.3 },
        u_satColorMix:         { value: 0.35 },
        u_mapSize:             { value: new THREE.Vector2(MAP_WIDTH, MAP_HEIGHT) },
    };

    const mat = new THREE.MeshStandardMaterial({
        name:            'ContinentMeshPBR',
        vertexColors:    true,
        roughness:       0.82,
        metalness:       0.04,
        transparent:     true,
        opacity:         0,
        depthWrite:      true,
        polygonOffset:       true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits:  -1,
    });

    mat.onBeforeCompile = (shader) => {
        // Merge our uniforms into the shader program
        for (const [key, val] of Object.entries(uniforms)) {
            shader.uniforms[key] = val;
        }

        // ── Vertex shader injection ──
        shader.vertexShader = shader.vertexShader.replace(
            '#include <common>',
            '#include <common>\n' + GLSL_COMMON + '\n' + GLSL_VERTEX_PARS
        );
        shader.vertexShader = shader.vertexShader.replace(
            '#include <begin_vertex>',
            '#include <begin_vertex>\n' + GLSL_VERTEX_MAIN
        );

        // ── Fragment shader injection ──
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <common>',
            '#include <common>\n' + GLSL_COMMON + '\n' + GLSL_FRAGMENT_PARS
        );

        // Inject AFTER the normal_fragment_maps chunk so we can override `normal`
        // and AFTER the color_fragment chunk so diffuseColor.rgb has vertex color
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <roughnessmap_fragment>',
            '#include <roughnessmap_fragment>\n' + GLSL_FRAGMENT_MAIN
        );

        // Store shader ref so we can update uniforms later
        mat.userData.shader = shader;
    };

    // Expose uniforms for external control
    mat.userData.pbrUniforms = uniforms;

    // Expose tuning API on window for DevTools
    _exposeConsoleTuning(uniforms);

    return mat;
}

/**
 * Update the macro normal map after async load.
 * @param {THREE.MeshStandardMaterial} mat
 * @param {THREE.Texture} normalTex
 */
export function updateMacroNormalMap(mat, normalTex) {
    if (mat.userData.pbrUniforms) {
        mat.userData.pbrUniforms.u_macroNormal.value = normalTex;
    }
}

// ── Console tuning ──────────────────────────────────────────────────────────

function _exposeConsoleTuning(uniforms) {
    const tuning = {};

    const props = [
        'u_pbrEnabled', 'u_triplanarSharpness', 'u_texScale',
        'u_snowLine', 'u_snowBlend', 'u_slopeRockThreshold', 'u_slopeRockBlend',
        'u_heightBlendDepth', 'u_detailNormalStrength', 'u_macroNormalStrength',
        'u_antiTileStrength', 'u_satColorMix',
    ];

    for (const prop of props) {
        Object.defineProperty(tuning, prop, {
            get() { return uniforms[prop].value; },
            set(v) {
                uniforms[prop].value = v;
                console.log(`[TerrainPBR] ${prop} = ${v}`);
            },
        });
    }

    window.terrainPBR = tuning;
    console.log('[TerrainPBR] Console tuning: window.terrainPBR.u_snowLine = 20, etc.');
}