// ── In terrainBuilder.js, replace the fragmentShader string in the splat cloud
//    ShaderMaterial definition ─────────────────────────────────────────────────

const splatFragmentShader = /* glsl */ `#version 300 es
precision highp float;

// Varyings from vertex shader (unchanged)
in vec3 vColor;          // satellite RGB, already in linear space
in float vElevation;     // world-space Y (metres, Terrarium-decoded)
in float vWorldZ;        // world-space Z (maps to latitude)
in float vDistToCamera;  // for distance-based point fade

// Existing auto-tuner uniforms — READ ONLY, do not modify defaults here
uniform float uBrightness;    // SPLAT_BRIGHTNESS  (0.86)
uniform float uLandLift;      // SPLAT_LAND_LIFT   (0.28)
uniform float float uLandGamma;    // SPLAT_LAND_GAMMA  (0.70)
uniform float uSaturation;    // SPLAT_SATURATION  (2.10)
uniform float uHemiStrength;  // SPLAT_HEMI_STRENGTH (0.35)
uniform float uBiomeStrength; // SPLAT_BIOME_STRENGTH (0.30)

// Camera uniforms for LOD crossfade
uniform float uFadeStart;
uniform float uFadeEnd;
uniform float uCameraAltitude;

// ◆ BIOME: new uniforms for biome differentiation
uniform vec3  uSunDirection;       // directional light (normalized), default (0.3, 0.7, 0.2)
uniform float uPolarLatitude;      // latitude threshold for polar start, default 60.0
uniform float uDesertMaxLat;       // max latitude for desert detection, default 35.0
uniform float uIceSpecularPower;   // sharpness of ice glint, default 24.0

out vec4 fragColor;

// ── Utility: RGB ↔ HSL for saturation adjustment (existing) ──────────────────
vec3 adjustSaturation(vec3 color, float sat) {
    float grey = dot(color, vec3(0.2126, 0.7152, 0.0722));
    return mix(vec3(grey), color, sat);
}

// ── Utility: smoothstep-based latitude band ──────────────────────────────────
// Maps world-space Z to approximate latitude in degrees.
// MAP_HEIGHT = 300 scene units spans ~180° of Mercator latitude.
// Z = -150 → ~90°S,  Z = 0 → equator,  Z = +150 → ~90°N
// (In practice the Mercator projection compresses poles, but for biome
//  tinting a linear approximation is sufficient and avoids transcendentals.)
float worldZToLatitude(float z) {
    // MAP_HEIGHT / 2 = 150.  Latitude ≈ z / 150 * 90.
    return (z / 150.0) * 90.0;
}

// ◆ BIOME: Polar ice overlay ─────────────────────────────────────────────────
// Returns a vec4: rgb = ice tint colour, a = blend weight [0,1]
vec4 computePolarIce(float latitude, vec3 baseColor, float elevation) {
    float absLat = abs(latitude);

    // Polar onset: smoothstep from uPolarLatitude to 80°
    float polarWeight = smoothstep(uPolarLatitude, 80.0, absLat);

    // High-altitude snow: above 3500m, snow appears even at lower latitudes
    // (Himalayas, Andes, Alps).  This blends with a wider latitude range.
    float altitudeSnow = smoothstep(3500.0, 5500.0, elevation);
    // Only apply altitude snow between 20°–70° latitude (not at equator over ocean)
    float altSnowLatGate = smoothstep(20.0, 30.0, absLat) * (1.0 - smoothstep(70.0, 80.0, absLat));
    float snowWeight = max(polarWeight, altitudeSnow * altSnowLatGate * 0.6);

    // Ice base colour: pale blue-white
    vec3 iceColor = vec3(0.85, 0.90, 0.97);

    // Desaturate the base satellite colour and blend toward ice
    vec3 desatBase = adjustSaturation(baseColor, 0.2);
    vec3 blended = mix(desatBase, iceColor, 0.4);

    return vec4(blended, snowWeight);
}

// ◆ BIOME: Desert warm tint ──────────────────────────────────────────────────
// Returns a vec4: rgb = desert tint, a = blend weight [0,1]
vec4 computeDesertTint(float latitude, vec3 baseColor, float elevation) {
    float absLat = abs(latitude);

    // Desert band: 10°–35° latitude (Sahara, Arabian, Sonoran, Kalahari)
    float latWeight = smoothstep(5.0, 15.0, absLat) * (1.0 - smoothstep(uDesertMaxLat - 5.0, uDesertMaxLat, absLat));

    // Colour-space desert detection: high R relative to G, low B
    // This prevents tropical forests (high G) from being tinted.
    float rg_ratio = baseColor.r / max(0.01, baseColor.g);
    float desertness = smoothstep(1.05, 1.4, rg_ratio) * (1.0 - smoothstep(0.35, 0.5, baseColor.b));

    // Exclude ocean (elevation < 0) and high mountains
    float elevGate = smoothstep(0.0, 50.0, elevation) * (1.0 - smoothstep(2000.0, 3000.0, elevation));

    float weight = latWeight * desertness * elevGate;

    // Warm amber tint
    vec3 desertTint = baseColor * vec3(1.08, 1.02, 0.88);
    // Slightly desaturate
    desertTint = adjustSaturation(desertTint, 0.7);

    return vec4(desertTint, weight);
}

// ◆ BIOME: Forest deepening ─────────────────────────────────────────────────
// Returns a vec4: rgb = forest colour, a = blend weight [0,1]
vec4 computeForestDeepen(float latitude, vec3 baseColor, float elevation) {
    float absLat = abs(latitude);

    // Green-dominant pixels: likely vegetation
    float greenDominance = baseColor.g - max(baseColor.r, baseColor.b);
    float vegWeight = smoothstep(0.0, 0.06, greenDominance);

    // Only in vegetated latitude bands (0°–60°) and low-mid elevation
    float latGate = 1.0 - smoothstep(55.0, 65.0, absLat);
    float elevGate = smoothstep(0.0, 100.0, elevation) * (1.0 - smoothstep(3000.0, 4000.0, elevation));

    float weight = vegWeight * latGate * elevGate;

    // Deepen greens, add subtle cool shadow
    vec3 forestColor = baseColor * vec3(0.92, 1.06, 0.95);

    return vec4(forestColor, weight);
}

// ◆ BIOME: Polar specular highlight ──────────────────────────────────────────
// Fakes a Fresnel ice glint using the camera-relative view direction.
// Since points don't have normals, we assume an up-facing surface normal.
float computeIceSpecular(float polarWeight, vec3 worldPos, vec3 cameraPos) {
    if (polarWeight < 0.01) return 0.0;

    vec3 viewDir = normalize(cameraPos - worldPos);
    vec3 fakeNormal = vec3(0.0, 1.0, 0.0);

    // Half-vector specular (Blinn-Phong with assumed up-normal)
    vec3 halfVec = normalize(uSunDirection + viewDir);
    float NdotH = max(0.0, dot(fakeNormal, halfVec));
    float spec = pow(NdotH, uIceSpecularPower);

    // Fresnel: ice reflects more at grazing angles
    float NdotV = max(0.0, dot(fakeNormal, viewDir));
    float fresnel = 0.04 + 0.96 * pow(1.0 - NdotV, 5.0);

    return spec * fresnel * polarWeight * 0.25;
}

void main() {
    // ── Circular point (existing) ────────────────────────────────────────────
    vec2 pc = gl_PointCoord * 2.0 - 1.0;
    float dist = dot(pc, pc);
    if (dist > 1.0) discard;

    // ── LOD crossfade (existing) ─────────────────────────────────────────────
    float fade = clamp(
        (uCameraAltitude - uFadeEnd) / max(0.01, uFadeStart - uFadeEnd),
        0.0, 1.0
    );
    if (fade <= 0.0) discard;

    // ── Base colour pipeline (existing — auto-tuner controlled) ──────────────
    vec3 col = vColor;

    // Brightness
    col *= uBrightness;

    // Land lift (shadow floor)
    col = max(col, vec3(uLandLift * 0.15));

    // Gamma (mid-tone lift)
    col = pow(max(col, vec3(0.0)), vec3(uLandGamma));

    // Saturation
    col = adjustSaturation(col, uSaturation);

    // Hemisphere lighting (existing)
    float hemiTerm = 0.5 + 0.5 * (vElevation / 8848.0); // normalize to Everest height
    hemiTerm = clamp(hemiTerm, 0.0, 1.0);
    vec3 hemiColor = mix(vec3(0.10, 0.10, 0.14), vec3(0.95, 0.92, 0.85), hemiTerm);
    col = mix(col, col * hemiColor, uHemiStrength);

    // ── ◆ BIOME TINTING (NEW — applied after auto-tuner chain) ──────────────
    float latitude = worldZToLatitude(vWorldZ);

    // Compute each biome contribution
    vec4 polar  = computePolarIce(latitude, col, vElevation);
    vec4 desert = computeDesertTint(latitude, col, vElevation);
    vec4 forest = computeForestDeepen(latitude, col, vElevation);

    // Blend biomes — priority: polar > desert > forest
    // Each blend is gated by uBiomeStrength so the whole system can be
    // dialled down or disabled without touching individual weights.
    vec3 biomeCol = col;
    biomeCol = mix(biomeCol, forest.rgb, forest.a * uBiomeStrength);
    biomeCol = mix(biomeCol, desert.rgb, desert.a * uBiomeStrength);
    biomeCol = mix(biomeCol, polar.rgb,  polar.a  * uBiomeStrength);

    // ◆ BIOME: Ice specular highlight
    // We need the camera position — pass via a uniform or reconstruct.
    // Using uCameraAltitude as a proxy: assume camera is roughly above center.
    // For a proper implementation, pass cameraPosition as a uniform.
    vec3 approxWorldPos = vec3(0.0, vElevation * 0.01, vWorldZ);
    vec3 approxCamPos   = vec3(0.0, uCameraAltitude, 0.0);
    float iceSpec = computeIceSpecular(polar.a * uBiomeStrength, approxWorldPos, approxCamPos);
    biomeCol += vec3(iceSpec);

    col = biomeCol;

    // ── Soft edge and final output (existing) ────────────────────────────────
    float edgeAlpha = 1.0 - smoothstep(0.6, 1.0, dist);
    float finalAlpha = fade * edgeAlpha;

    // Clamp to prevent bloom blow-out
    col = min(col, vec3(1.2));

    fragColor = vec4(col, finalAlpha);
}
`;