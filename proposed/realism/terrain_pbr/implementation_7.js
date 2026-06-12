// ── DevTools examples ──

// Toggle PBR on/off
window.terrainPBR.u_pbrEnabled = 0;        // vertex colors only
window.terrainPBR.u_pbrEnabled = 1;        // PBR biomes

// Snow line (scene Y units — raise for less snow)
window.terrainPBR.u_snowLine = 22;         // default: 18
window.terrainPBR.u_snowBlend = 6;         // default: 4 (wider transition)

// Rock on slopes (lower = more rock on gentler slopes)
window.terrainPBR.u_slopeRockThreshold = 0.4; // default: 0.55
window.terrainPBR.u_slopeRockBlend = 0.2;     // default: 0.15

// Texture density (higher = smaller tiles, more detail)
window.terrainPBR.u_texScale = 0.05;          // default: 0.035

// Triplanar sharpness (higher = sharper projection transitions)
window.terrainPBR.u_triplanarSharpness = 6;   // default: 4

// Height-aware blend depth (lower = sharper biome edges)
window.terrainPBR.u_heightBlendDepth = 0.08;  // default: 0.15

// Normal map strength
window.terrainPBR.u_detailNormalStrength = 0.8; // default: 0.6
window.terrainPBR.u_macroNormalStrength = 1.0;  // default: 0.8

// Anti-tiling (0 = off, 1 = max rotation)
window.terrainPBR.u_antiTileStrength = 0.5;    // default: 0.3

// Satellite vs PBR color balance (0 = full PBR, 1 = full satellite)
window.terrainPBR.u_satColorMix = 0.5;         // default: 0.35