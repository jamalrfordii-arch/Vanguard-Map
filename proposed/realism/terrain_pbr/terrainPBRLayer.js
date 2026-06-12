// terrainPBRLayer.js — Register terrain PBR with layerManager
//
// Provides on/off toggle and parameter control through the standard layer system.
// Import this in main.js after both layerManager and continentMesh are initialized.

/**
 * Register the terrain PBR layer with the layer manager.
 * @param {import('./layerManager.js').default} layerManager
 * @param {import('./continentMesh.js').ContinentMesh} continentMesh
 */
export function registerTerrainPBRLayer(layerManager, continentMesh) {
    if (!layerManager || !continentMesh) return;

    layerManager.register('terrainPBR', {
        label: 'Terrain PBR Detail',
        category: 'rendering',
        defaultOn: true,
        onToggle(enabled) {
            const mat = continentMesh.getMesh()?.material;
            if (mat?.userData?.pbrUniforms) {
                mat.userData.pbrUniforms.u_pbrEnabled.value = enabled ? 1.0 : 0.0;
                console.log(`[TerrainPBR] ${enabled ? 'Enabled' : 'Disabled'}`);
            }
        },
        onOpacity(val) {
            const mat = continentMesh.getMesh()?.material;
            if (mat?.userData?.pbrUniforms) {
                // Use opacity to control PBR vs satellite color mix
                mat.userData.pbrUniforms.u_satColorMix.value = 1.0 - val;
            }
        },
    });
}