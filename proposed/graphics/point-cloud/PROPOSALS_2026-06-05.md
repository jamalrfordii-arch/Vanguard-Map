# Point Cloud & Terrain Rendering — Enhancement Proposals

*2026-06-05*

> Review carefully before applying. Shader patches must be tested in isolation.



# Terrain Point Cloud Rendering Improvements

---

## Improvement 1: Normal-Based Directional Lighting with Hemisphere Fill

### 1. TITLE
**Splat Hemisphere Lighting**

### 2. VISUAL_EFFECT
Every terrain point receives subtle directional shading based on the underlying terrain slope. South-facing slopes catch warm sunlight; north-facing slopes and valleys receive cool ambient sky fill. Mountain ridges gain definition, valleys read as deeper, and flat deserts/plains remain evenly lit. The analyst sees terrain relief "pop" without any change to the existing color grading pipeline — the effect is purely multiplicative on top of the current brightness/gamma/saturation chain.

### 3. TECHNIQUE
Encode the precomputed terrain normal map into a `sampler2D` uniform on the point cloud material. In the fragment shader, after the existing color grading (brightness, lift, gamma, saturation), sample the normal map using the point's UV, reconstruct the world-space normal, and compute a hemisphere lighting term: `mix(groundColor, skyColor, dot(N, up) * 0.5 + 0.5)` multiplied by a directional `max(0, dot(N, sunDir))` key light. The lighting result is multiplied into the final color with a controllable `uNormalLightStrength` uniform (default 0.35) so it can be dialed to zero without touching the auto-tuner constants.

### 4. SHADER_PATCH

**A) New uniforms to add to the ShaderMaterial constructor in `terrainBuilder.js`:**

```javascript
// ── terrainBuilder.js — add these uniforms to the splat ShaderMaterial uniforms block ──
// Place alongside existing uBrightness, uLift, uGamma, uSaturation uniforms.

uNormalMap:          { value: null },  // set via loadNormalMap() result
uNormalLightStrength:{ value: 0.35 },  // 0 = off, 1 = full effect
uSunDirection:       { value: new THREE.Vector3(0.4, 0.7, -0.3).normalize() },
uSkyColor:           { value: new THREE.Color(0.55, 0.65, 0.80) },
uGroundColor:        { value: new THREE.Color(0.20, 0.18, 0.15) },
uSunColor:           { value: new THREE.Color(1.00, 0.95, 0.85) },
```

**B) Fragment shader — REPLACE the current fragment shader entirely:**

```glsl
#version 300 es
precision highp float;

// ── Varyings from vertex shader (unchanged) ──────────────────────────
in vec3  vColor;       // per-point satellite color (linear RGB)
in float vAlpha;       // camera-distance fade
in vec2  vUV;          // terrain UV (0–1 across map), passed from vertex shader

// ── Existing auto-tuner uniforms (READ ONLY — do not modify defaults) ─
uniform float uBrightness;  // SPLAT_BRIGHTNESS  = 0.86
uniform float uLift;        // SPLAT_LAND_LIFT   = 0.28
uniform float uGamma;       // SPLAT_LAND_GAMMA  = 0.70
uniform float uSaturation;  // SPLAT_SATURATION  = 2.10

// ── NEW: normal-based lighting uniforms ──────────────────────────────
uniform sampler2D uNormalMap;
uniform float     uNormalLightStrength;   // 0–1 blend factor
uniform vec3      uSunDirection;          // normalized world-space sun dir
uniform vec3      uSkyColor;              // hemisphere sky (cool fill)
uniform vec3      uGroundColor;           // hemisphere ground (warm fill)
uniform vec3      uSunColor;              // directional key light tint

out vec4 fragColor;

// ── Existing helper: saturation adjustment ───────────────────────────
vec3 adjustSaturation(vec3 color, float sat) {
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    return mix(vec3(luma), color, sat);
}

void main() {
    // ── Circular point discard (existing) ────────────────────────────
    vec2 pc = gl_PointCoord - vec2(0.5);
    if (dot(pc, pc) > 0.25) discard;

    // ── Existing color grading pipeline (UNTOUCHED) ──────────────────
    // This section must stay identical to preserve auto-tuner calibration.
    vec3 col = vColor * uBrightness;
    col = max(col, vec3(uLift));
    col = pow(col, vec3(1.0 / uGamma));
    col = adjustSaturation(col, uSaturation);
    col = clamp(col, 0.0, 1.0);

    // ── NEW: Normal-based hemisphere + directional lighting ──────────
    // Sample terrain normal map (tangent-space encoded as RGB 0–1).
    // Decode from [0,1] → [-1,1].  Normal map is Y-up (OpenGL convention).
    vec3 N = texture(uNormalMap, vUV).rgb * 2.0 - 1.0;
    N = normalize(N);
    // Normal map stores (X, Y, Z) where Y = up in tangent space.
    // Our world up is Y, so swizzle: world normal = (N.x, N.z, N.y)
    // to map tangent-Z (forward) → world-Y (up).
    vec3 worldNormal = normalize(vec3(N.x, N.z, N.y));

    // Hemisphere ambient: smooth blend between ground and sky color
    // based on how much the surface faces upward.
    float hemi = dot(worldNormal, vec3(0.0, 1.0, 0.0)) * 0.5 + 0.5;
    vec3 hemiLight = mix(uGroundColor, uSkyColor, hemi);

    // Directional key light: Lambertian, clamped.
    float NdotL = max(dot(worldNormal, uSunDirection), 0.0);
    vec3 directional = uSunColor * NdotL * 0.45; // 0.45 = key intensity

    // Combined lighting term, normalized so flat terrain ≈ 1.0
    // (flat terrain: hemi ≈ skyColor, NdotL ≈ 0.7 for our sun angle)
    vec3 lightTerm = hemiLight + directional;
    // Normalize so that a flat-up surface gets ≈ 1.0 multiplier,
    // meaning existing auto-tuner calibration is preserved.
    vec3 flatRef = uSkyColor + uSunColor * max(dot(vec3(0.0, 1.0, 0.0), uSunDirection), 0.0) * 0.45;
    lightTerm = lightTerm / max(flatRef, vec3(0.001));

    // Blend: at strength 0 the lighting term is 1.0 (no change).
    vec3 finalLight = mix(vec3(1.0), lightTerm, uNormalLightStrength);

    col *= finalLight;
    col = clamp(col, 0.0, 1.0);

    // ── Soft circular edge falloff (existing) ────────────────────────
    float r = length(pc) * 2.0;
    float edgeAlpha = 1.0 - smoothstep(0.85, 1.0, r);

    fragColor = vec4(col, vAlpha * edgeAlpha);
}
```

**C) Vertex shader — add vUV output (patch into existing vertex shader):**

```glsl
// ── Add to vertex shader outputs, alongside existing vColor / vAlpha ──
out vec2 vUV;

// ── Add to vertex shader main(), after position computation ──────────
// Compute terrain UV from world-space XZ position.
// MAP_WIDTH and MAP_HEIGHT are passed as uniforms (or hardcoded as 300.0).
vUV = vec2(
    position.x / 300.0 + 0.5,
    position.z / 300.0 + 0.5
);
```

**D) JavaScript hookup after splat cloud creation:**

```javascript
// ── terrainBuilder.js — after splatCloud is created, load and bind normal map ──
import { loadNormalMap } from './terrainBuilder.js';

loadNormalMap('./terrain_normals.png').then((normalTex) => {
    if (normalTex && _splatCloud) {
        _splatCloud.material.uniforms.uNormalMap.value = normalTex;
        console.log('[Terrain] Normal map bound to splat cloud.');
    }
});
```

### 5. RISK
**LOW**

Reasoning:
- Does **not** modify any of the four auto-tuner constants (`SPLAT_BRIGHTNESS`, `SPLAT_LAND_LIFT`, `SPLAT_LAND_GAMMA`, `SPLAT_SATURATION`). The existing grading pipeline runs identically; the lighting multiplier is applied *after* and is normalized so flat terrain produces a 1.0 multiplier.
- Does not touch post-processing chain or bloom settings.
- `uNormalLightStrength` defaults to 0.35 and can be set to 0.0 at runtime to completely disable the effect.
- Graceful degradation: if `uNormalMap` is null/unloaded, the texture sample returns (0.5, 0.5, 1.0) which decodes to straight-up normal → `lightTerm ≈ 1.0` → no visible change.

### 6. DATA_SOURCE
**`terrain_normals.png`** — already referenced by the existing `loadNormalMap()` function in `terrainBuilder.js`, generated by `tools/generate_normals.py`. No new data pipeline required.

---

## Improvement 2: Latitude-Based Biome Tinting with Elevation Blending

### 1. TITLE
**Biome-Aware Polar & Desert Tinting**

### 2. VISUAL_EFFECT
High-latitude terrain (above ~60°) acquires a subtle cool blue-white desaturation that makes ice sheets and tundra read as distinctly polar. Mid-latitude arid bands (~15°–30°) receive a warm amber push that differentiates Saharan/Arabian desert from temperate grassland. High-elevation points (>3000m) trend toward gray-white regardless of latitude, simulating snowcap and exposed rock. The transitions are smooth latitude/elevation gradients — no hard edges. The analyst sees the globe's major biome bands emerge from the point cloud without any new texture data; it uses only position and elevation already present in each vertex.

### 3. TECHNIQUE
Pass each point's world-space Y position (elevation) and Z position (latitude proxy) as varyings to the fragment shader. In the fragment, after the existing color grading chain, compute a biome tint using smoothstep latitude bands and an elevation snowline factor. The tint is applied as a desaturation + color shift blend, controlled by `uBiomeStrength` (default 0.30). The blend is multiplicative on luminance and additive on hue shift, ensuring it layers on top of the auto-tuner pipeline without altering its calibrated output when strength is 0.

### 4. SHADER_PATCH

**A) New uniforms to add to the ShaderMaterial constructor:**

```javascript
// ── terrainBuilder.js — add to splat ShaderMaterial uniforms block ────
uBiomeStrength:    { value: 0.30 },  // 0 = off, 1 = full biome tinting
uSnowlineBase:     { value: 3000.0 }, // elevation (meters) where snow tint begins
uSnowlineFull:     { value: 5500.0 }, // elevation where snow tint is 100%
uPolarLatitude:    { value: 0.72 },   // normalized |latitude| where polar tint begins (≈65°)
uAridLatLow:       { value: 0.18 },   // normalized |latitude| arid band start (≈16°)
uAridLatHigh:      { value: 0.35 },   // normalized |latitude| arid band end (≈32°)
uPolarTint:        { value: new THREE.Color(0.78, 0.85, 0.95) },  // cool ice-blue
uAridTint:         { value: new THREE.Color(0.92, 0.82, 0.60) },  // warm amber
uSnowTint:         { value: new THREE.Color(0.90, 0.90, 0.92) },  // high-altitude gray-white
```

**B) Vertex shader — add elevation varying (patch into existing vertex shader):**

```glsl
// ── Add to vertex shader outputs, alongside existing vColor / vAlpha ──
out float vElevation;   // world-space Y = terrain elevation in meters
out float vLatitude;    // normalized latitude: 0 = equator, 1 = pole

// ── Add to vertex shader main(), after position is computed ──────────
vElevation = position.y;  // raw elevation in scene units (meters)

// Latitude from Z position: Z ranges from -150 to +150 (MAP_HEIGHT/2).
// Normalize |Z| to 0–1 where 0 = equator, 1 = pole.
vLatitude = abs(position.z) / 150.0;
```

**C) Fragment shader — add biome tinting block AFTER the existing color grading, BEFORE final output:**

```glsl
// ── Add to fragment shader inputs ────────────────────────────────────
in float vElevation;
in float vLatitude;

// ── Add these uniforms to the fragment shader uniform block ──────────
uniform float uBiomeStrength;
uniform float uSnowlineBase;
uniform float uSnowlineFull;
uniform float uPolarLatitude;
uniform float uAridLatLow;
uniform float uAridLatHigh;
uniform vec3  uPolarTint;
uniform vec3  uAridTint;
uniform vec3  uSnowTint;

// ══════════════════════════════════════════════════════════════════════
// INSERT THIS BLOCK after `col = clamp(col, 0.0, 1.0);` in the existing
// color grading pipeline (or after the normal lighting block from
// Improvement 1), BEFORE the final fragColor assignment.
// ══════════════════════════════════════════════════════════════════════

// ── Biome tinting ────────────────────────────────────────────────────
// All three factors are independent 0–1 masks that blend additively.
// Each applies a desaturation + tint shift to the graded color.

// 1) Polar regions: high-latitude ice/tundra desaturation
//    Ramp from 0 at uPolarLatitude to 1.0 at latitude 1.0 (the pole).
float polarMask = smoothstep(uPolarLatitude - 0.08, uPolarLatitude + 0.08, vLatitude);
//    Stronger effect at low elevation (ice sheets are at sea level).
//    Reduce polar tint above 2000m where mountains have their own look.
polarMask *= 1.0 - smoothstep(500.0, 2500.0, vElevation);
polarMask = clamp(polarMask, 0.0, 1.0);

// 2) Arid band: subtropical desert warmth
//    Bell-shaped mask centered on the arid latitude band.
float aridCenter = (uAridLatLow + uAridLatHigh) * 0.5;
float aridWidth  = (uAridLatHigh - uAridLatLow) * 0.5;
float aridDist   = abs(vLatitude - aridCenter) / max(aridWidth, 0.001);
float aridMask   = 1.0 - smoothstep(0.0, 1.4, aridDist);
//    Only apply to low-elevation terrain (deserts are lowland).
aridMask *= 1.0 - smoothstep(800.0, 2000.0, vElevation);
//    Reduce in areas that are already very green (forests in the band).
//    Use green channel dominance as a vegetation proxy.
float greenDominance = col.g - max(col.r, col.b);
aridMask *= 1.0 - smoothstep(0.0, 0.08, greenDominance);
aridMask = clamp(aridMask, 0.0, 1.0);

// 3) High-altitude snow/rock: elevation-based gray-out
float snowMask = smoothstep(uSnowlineBase, uSnowlineFull, vElevation);
snowMask = clamp(snowMask, 0.0, 1.0);

// Apply each biome tint as partial desaturation + color shift.
// Helper: per-biome luminance-preserving blend.
float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));

// Polar: desaturate toward cool blue-white
vec3 polarResult = mix(col, uPolarTint * luma * 1.6, polarMask * 0.65);

// Arid: warm shift — less desaturation, more hue push
vec3 aridResult = mix(polarResult, mix(polarResult, uAridTint * luma * 1.5, 0.45), aridMask);

// Snow: strong desaturation toward gray-white
vec3 snowResult = mix(aridResult, uSnowTint * luma * 1.4, snowMask * 0.75);

// Final blend controlled by global strength uniform
col = mix(col, snowResult, uBiomeStrength);
col = clamp(col, 0.0, 1.0);
```

**D) Complete fragment shader with both improvements integrated (for reference):**

```glsl
#version 300 es
precision highp float;

in vec3  vColor;
in float vAlpha;
in vec2  vUV;
in float vElevation;
in float vLatitude;

// ── Auto-tuner uniforms (DO NOT MODIFY DEFAULTS) ────────────────────
uniform float uBrightness;
uniform float uLift;
uniform float uGamma;
uniform float uSaturation;

// ── Improvement 1: Normal lighting ───────────────────────────────────
uniform sampler2D uNormalMap;
uniform float     uNormalLightStrength;
uniform vec3      uSunDirection;
uniform vec3      uSkyColor;
uniform vec3      uGroundColor;
uniform vec3      uSunColor;

// ── Improvement 2: Biome tinting ─────────────────────────────────────
uniform float uBiomeStrength;
uniform float uSnowlineBase;
uniform float uSnowlineFull;
uniform float uPolarLatitude;
uniform float uAridLatLow;
uniform float uAridLatHigh;
uniform vec3  uPolarTint;
uniform vec3  uAridTint;
uniform vec3  uSnowTint;

out vec4 fragColor;

vec3 adjustSaturation(vec3 color, float sat) {
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    return mix(vec3(luma), color, sat);
}

void main() {
    vec2 pc = gl_PointCoord - vec2(0.5);
    if (dot(pc, pc) > 0.25) discard;

    // ── Existing color grading (PRESERVED EXACTLY) ───────────────────
    vec3 col = vColor * uBrightness;
    col = max(col, vec3(uLift));
    col = pow(col, vec3(1.0 / uGamma));
    col = adjustSaturation(col, uSaturation);
    col = clamp(col, 0.0, 1.0);

    // ── Improvement 1: normal-based lighting ─────────────────────────
    vec3 N = texture(uNormalMap, vUV).rgb * 2.0 - 1.0;
    N = normalize(N);
    vec3 worldNormal = normalize(vec3(N.x, N.z, N.y));

    float hemi = dot(worldNormal, vec3(0.0, 1.0, 0.0)) * 0.5 + 0.5;
    vec3 hemiLight = mix(uGroundColor, uSkyColor, hemi);
    float NdotL = max(dot(worldNormal, uSunDirection), 0.0);
    vec3 directional = uSunColor * NdotL * 0.45;
    vec3 lightTerm = hemiLight + directional;
    vec3 flatRef = uSkyColor + uSunColor * max(dot(vec3(0.0, 1.0, 0.0), uSunDirection), 0.0) * 0.45;
    lightTerm = lightTerm / max(flatRef, vec3(0.001));
    vec3 finalLight = mix(vec3(1.0), lightTerm, uNormalLightStrength);
    col *= finalLight;
    col = clamp(col, 0.0, 1.0);

    // ── Improvement 2: biome tinting ─────────────────────────────────
    float polarMask = smoothstep(uPolarLatitude - 0.08, uPolarLatitude + 0.08, vLatitude);
    polarMask *= 1.0 - smoothstep(500.0, 2500.0, vElevation);
    polarMask = clamp(polarMask, 0.0, 1.0);

    float aridCenter = (uAridLatLow + uAridLatHigh) * 0.5;
    float aridWidth  = (uAridLatHigh - uAridLatLow) * 0.5;
    float aridDist   = abs(vLatitude - aridCenter) / max(aridWidth, 0.001);
    float aridMask   = 1.0 - smoothstep(0.0, 1.4, aridDist);
    aridMask *= 1.0 - smoothstep(800.0, 2000.0, vElevation);
    float greenDominance = col.g - max(col.r, col.b);
    aridMask *= 1.0 - smoothstep(0.0, 0.08, greenDominance);
    aridMask = clamp(aridMask, 0.0, 1.0);

    float snowMask = smoothstep(uSnowlineBase, uSnowlineFull, vElevation);
    snowMask = clamp(snowMask, 0.0, 1.0);

    float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
    vec3 polarResult = mix(col, uPolarTint * luma * 1.6, polarMask * 0.65);
    vec3 aridResult  = mix(polarResult, mix(polarResult, uAridTint * luma * 1.5, 0.45), aridMask);
    vec3 snowResult  = mix(aridResult,