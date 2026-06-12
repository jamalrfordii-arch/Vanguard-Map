// ── Add after ContinentMesh construction ──
// Pre-generate biome textures (runs once, ~50ms)
generateTerrainTextures();

// ── Add after layerManager is initialized ──
registerTerrainPBRLayer(layerManager, continentMesh);