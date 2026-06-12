// ── terrainBuilder.js — after splatCloud is created, load and bind normal map ──
import { loadNormalMap } from './terrainBuilder.js';

loadNormalMap('./terrain_normals.png').then((normalTex) => {
    if (normalTex && _splatCloud) {
        _splatCloud.material.uniforms.uNormalMap.value = normalTex;
        console.log('[Terrain] Normal map bound to splat cloud.');
    }
});