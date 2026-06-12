// ── Add these uniforms to the splat cloud ShaderMaterial uniforms object ─────
// (alongside the existing uBrightness, uLandLift, etc.)

const biomeUniforms = {
    // Sun direction for ice specular — should match your scene's directional light
    uSunDirection:     { value: new THREE.Vector3(0.3, 0.7, 0.2).normalize() },
    // Latitude threshold where polar biome begins (degrees)
    uPolarLatitude:    { value: 60.0 },
    // Maximum latitude for desert biome detection (degrees)
    uDesertMaxLat:     { value: 35.0 },
    // Specular power for ice highlights (higher = sharper glint)
    uIceSpecularPower: { value: 24.0 },
};

// Merge into the existing uniforms object:
// const uniforms = { ...existingUniforms, ...biomeUniforms };