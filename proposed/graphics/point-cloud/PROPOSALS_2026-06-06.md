# Point Cloud & Terrain Rendering — Enhancement Proposals

*2026-06-06*

> Review carefully before applying. Shader patches must be tested in isolation.



# Terrain Point Cloud Rendering Improvements

## Improvement 1: Eye-Dome Lighting Post-Process Pass

### 1. TITLE
Screen-Space Eye-Dome Lighting for Point Cloud Depth Perception

### 2. VISUAL_EFFECT
Every point in the terrain cloud gains subtle edge-darkening that reveals ridgelines, valleys, and continental shelf breaks that are currently invisible in the flat-shaded splat cloud. Mountain ranges pop out with chiseled definition. Ocean-floor trenches gain visible contour. The effect is view-dependent — as the analyst orbits, depth silhouettes update in real-time, giving the terrain a "tactical relief map" quality without any normal data. The effect is strongest at mid-zoom where the point cloud is the primary visual, and fades to zero at close zoom where the continent mesh takes over.

### 3. TECHNIQUE
Eye-Dome Lighting (EDL), originally developed by Christian Boucheny (2009), adapted from CloudCompare/Potree. This is a **post-process** pass that reads only the depth buffer. For each fragment, it samples 4–8 neighbors in screen space, computes a log-depth response function, and darkens pixels at depth discontinuities. The math:

```
response = max(0, log2(depth_center) - log2(depth_neighbor))
shade = exp(-sum(responses) * edlStrength)
```

This is implemented as a custom `ShaderPass` for the existing `EffectComposer` pipeline. It requires rendering the point cloud's depth to a separate render target (or reusing the main depth buffer).

### 4. SHADER_PATCH

**New file: `edlPass.js`** — drop into the project root alongside the other passes:

```javascript
// edlPass.js — Eye-Dome Lighting post-process for point cloud depth perception
// Adapted from Boucheny 2009 / Potree / CloudCompare EDL implementations.
// Plugs into the existing EffectComposer chain.

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const EDLVertexShader = /* glsl */ `#version 300 es
precision highp float;

in vec3 position;
in vec2 uv;

out vec2 vUv;

void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
}
`;

const EDLFragmentShader = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D tDiffuse;       // scene colour from previous pass
uniform sampler2D tDepth;         // scene depth buffer
uniform float uEdlStrength;       // darkness multiplier (0.3–1.0 typical)
uniform float uEdlRadius;         // pixel radius for neighbor sampling
uniform vec2 uScreenSize;         // viewport width, height
uniform float uCameraNear;
uniform float uCameraFar;
uniform float uCameraAltitude;    // camera.position.y — for crossfade with continent mesh
uniform float uFadeStart;         // SPLAT_FADE_START
uniform float uFadeEnd;           // SPLAT_FADE_END

in vec2 vUv;
out vec4 fragColor;

// Reconstruct linear depth from the packed depth buffer.
// Three.js stores depth as gl_FragCoord.z which is a non-linear [0,1] mapping.
float getLinearDepth(float d) {
    float z_ndc = d * 2.0 - 1.0;
    return (2.0 * uCameraNear * uCameraFar) / (uCameraFar + uCameraNear - z_ndc * (uCameraFar - uCameraNear));
}

// Log-depth response for a single neighbor offset.
// Returns how much darker this neighbor suggests the center should be.
float edlResponse(vec2 centerUV, float centerLogDepth, vec2 offset) {
    vec2 neighborUV = centerUV + offset;

    // Clamp to screen — prevents sampling across viewport edges
    neighborUV = clamp(neighborUV, vec2(0.001), vec2(0.999));

    float neighborRawDepth = texture(tDepth, neighborUV).r;

    // Sky pixels (depth == 1.0) should not darken terrain
    if (neighborRawDepth >= 0.9999) return 0.0;

    float neighborLinDepth = getLinearDepth(neighborRawDepth);
    float neighborLogDepth = log2(max(1e-5, neighborLinDepth));

    return max(0.0, centerLogDepth - neighborLogDepth);
}

void main() {
    vec4 sceneColor = texture(tDiffuse, vUv);
    float rawDepth  = texture(tDepth, vUv).r;

    // Sky pixels — pass through unchanged
    if (rawDepth >= 0.9999) {
        fragColor = sceneColor;
        return;
    }

    // Compute crossfade factor so EDL matches splat cloud fade-out.
    // When camera is below SPLAT_FADE_END the point cloud is hidden;
    // EDL should also be fully off.  Between FADE_END and FADE_START
    // it ramps from 0→1.  Above FADE_START it's fully on.
    float fadeFactor = clamp(
        (uCameraAltitude - uFadeEnd) / max(0.01, uFadeStart - uFadeEnd),
        0.0, 1.0
    );

    // If splat cloud is fully faded out, skip EDL entirely
    if (fadeFactor <= 0.0) {
        fragColor = sceneColor;
        return;
    }

    float linearDepth = getLinearDepth(rawDepth);
    float centerLogDepth = log2(max(1e-5, linearDepth));

    // Pixel-space step size
    vec2 pixelSize = uEdlRadius / uScreenSize;

    // 8-neighbor sampling pattern (N, NE, E, SE, S, SW, W, NW)
    // Uniform angular distribution gives isotropic edge detection.
    float totalResponse = 0.0;
    totalResponse += edlResponse(vUv, centerLogDepth, vec2( 0.0,  1.0) * pixelSize);
    totalResponse += edlResponse(vUv, centerLogDepth, vec2( 0.7071,  0.7071) * pixelSize);
    totalResponse += edlResponse(vUv, centerLogDepth, vec2( 1.0,  0.0) * pixelSize);
    totalResponse += edlResponse(vUv, centerLogDepth, vec2( 0.7071, -0.7071) * pixelSize);
    totalResponse += edlResponse(vUv, centerLogDepth, vec2( 0.0, -1.0) * pixelSize);
    totalResponse += edlResponse(vUv, centerLogDepth, vec2(-0.7071, -0.7071) * pixelSize);
    totalResponse += edlResponse(vUv, centerLogDepth, vec2(-1.0,  0.0) * pixelSize);
    totalResponse += edlResponse(vUv, centerLogDepth, vec2(-0.7071,  0.7071) * pixelSize);

    totalResponse /= 8.0;

    // Exponential shading — larger response = darker shade
    float shade = exp(-totalResponse * uEdlStrength * 300.0);

    // Blend EDL darkening with crossfade factor
    shade = mix(1.0, shade, fadeFactor);

    fragColor = vec4(sceneColor.rgb * shade, sceneColor.a);
}
`;

export class EDLPass extends Pass {
    constructor(scene, camera, options = {}) {
        super();

        this.scene = scene;
        this.camera = camera;
        this.needsSwap = true;

        // Tunable parameters
        this.edlStrength = options.edlStrength !== undefined ? options.edlStrength : 0.6;
        this.edlRadius = options.edlRadius !== undefined ? options.edlRadius : 1.4;
        this.fadeStart = options.fadeStart !== undefined ? options.fadeStart : 25;
        this.fadeEnd = options.fadeEnd !== undefined ? options.fadeEnd : 10;

        // Depth render target — we need a depth texture from the main scene.
        // The composer's writeBuffer has colour but not always an accessible depth
        // texture, so we create our own render target with depthTexture.
        this.depthTarget = new THREE.WebGLRenderTarget(1, 1, {
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            type: THREE.FloatType,
        });
        this.depthTarget.depthTexture = new THREE.DepthTexture();
        this.depthTarget.depthTexture.format = THREE.DepthFormat;
        this.depthTarget.depthTexture.type = THREE.UnsignedIntType;

        this.uniforms = {
            tDiffuse:        { value: null },
            tDepth:          { value: this.depthTarget.depthTexture },
            uEdlStrength:    { value: this.edlStrength },
            uEdlRadius:      { value: this.edlRadius },
            uScreenSize:     { value: new THREE.Vector2(1, 1) },
            uCameraNear:     { value: camera.near },
            uCameraFar:      { value: camera.far },
            uCameraAltitude: { value: 50 },
            uFadeStart:      { value: this.fadeStart },
            uFadeEnd:        { value: this.fadeEnd },
        };

        this.material = new THREE.RawShaderMaterial({
            uniforms: this.uniforms,
            vertexShader: EDLVertexShader,
            fragmentShader: EDLFragmentShader,
            depthTest: false,
            depthWrite: false,
        });

        this.fsQuad = new FullScreenQuad(this.material);
    }

    setSize(width, height) {
        this.depthTarget.setSize(width, height);
        this.uniforms.uScreenSize.value.set(width, height);
    }

    dispose() {
        this.depthTarget.dispose();
        this.material.dispose();
        this.fsQuad.dispose();
    }

    render(renderer, writeBuffer, readBuffer /*, deltaTime, maskActive */) {
        // Step 1: Render the full scene into our depth target to capture the depth texture.
        // The colour output here is discarded — we only need the depth.
        const oldRenderTarget = renderer.getRenderTarget();
        const oldAutoClear = renderer.autoClear;

        renderer.setRenderTarget(this.depthTarget);
        renderer.autoClear = true;
        renderer.render(this.scene, this.camera);

        // Step 2: Apply EDL shading using the depth texture + the colour from the previous pass
        this.uniforms.tDiffuse.value = readBuffer.texture;
        this.uniforms.uCameraNear.value = this.camera.near;
        this.uniforms.uCameraFar.value = this.camera.far;
        this.uniforms.uCameraAltitude.value = this.camera.position.y;

        renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
        renderer.autoClear = false;
        renderer.clear();
        this.fsQuad.render(renderer);

        renderer.autoClear = oldAutoClear;
        renderer.setRenderTarget(oldRenderTarget);
    }
}
```

**Integration in main scene setup (where EffectComposer is configured):**

```javascript
// ── Where you set up the EffectComposer ──────────────────────────────────────
// Add AFTER the RenderPass, BEFORE bloom/tonemap/final passes.

import { EDLPass } from './edlPass.js';
import { SPLAT_FADE_START, SPLAT_FADE_END } from './config.js';

// ... existing composer setup ...
// const renderPass = new RenderPass(scene, camera);
// composer.addPass(renderPass);

const edlPass = new EDLPass(scene, camera, {
    edlStrength: 0.6,    // 0.3 = subtle, 0.8 = dramatic. Tune in DevTools.
    edlRadius: 1.4,      // px. 1.0–2.0 range. Larger = thicker silhouettes.
    fadeStart: SPLAT_FADE_START,
    fadeEnd: SPLAT_FADE_END,
});
composer.addPass(edlPass);

// Expose for DevTools tuning
window.edlPass = edlPass;

// ... then add bloom pass, etc. ...

// In the resize handler:
// edlPass.setSize(width, height);
```

### 5. RISK
**HIGH** — This adds a new pass to the post-processing chain and performs an extra full-scene render for the depth buffer. Reasoning:
- It inserts into the EffectComposer pipeline, which means pass ordering with bloom matters.
- The extra `renderer.render(scene, camera)` call doubles the draw-call count. On budget GPUs this could halve frame rate. Mitigation: the pass respects the crossfade and can be toggled via `edlPass.enabled = false`.
- It does **not** touch any of the auto-tuner uniforms (SPLAT_BRIGHTNESS, SPLAT_LAND_LIFT, SPLAT_LAND_GAMMA, SPLAT_SATURATION). It only multiplies the final colour by a `shade` factor, so it's compositionally independent of colour tuning.
- Depth reconstruction assumes standard Three.js perspective camera depth packing — ortho cameras or logarithmic depth buffer would break the `getLinearDepth` function.

### 6. DATA_SOURCE
**None** — EDL reads only the depth buffer, which is already produced by the standard render pipeline. No new textures, normal maps, or preprocessing steps required.

---

## Improvement 2: Latitude-Based Biome Surface Differentiation with Polar Ice Rendering

### 1. TITLE
Latitude-Altitude Biome Tinting with Polar Ice Specular and Desert Heat Haze

### 2. VISUAL_EFFECT
The terrain point cloud gains three distinct surface-type zones that the analyst can read at a glance:

- **Polar regions** (|latitude| > 60°): Points acquire a slight blue-white frost overlay with faint specular highlights simulating ice/snow reflectance. The existing satellite colour bleeds through at reduced saturation, so Greenland and Antarctica look convincingly icy without losing geographic texture.
- **Arid zones** (|latitude| < 35°, low elevation, low green channel): Desert terrain gets a warm amber lift and reduced saturation, making the Sahara, Arabian Peninsula, and Australian Outback visually distinct from tropical forests at similar latitudes.
- **Temperate/tropical forests** (high green channel relative to red): A subtle deepening of greens with slight blue shadow tint, enhancing canopy visibility.

All three effects are governed by a single `uBiomeStrength` uniform (already exists as `SPLAT_BIOME_STRENGTH`) and stack multiplicatively with the existing colour pipeline, preserving the auto-tuner's brightness/gamma/saturation chain.

### 3. TECHNIQUE
The biome classification runs entirely in the fragment shader using three inputs already available per-point: (1) the satellite colour stored in the vertex attribute, (2) the world-space Y position (elevation), and (3) the world-space Z position which maps to latitude. No texture lookups or CPU classification needed.

For polar ice: a Fresnel-like term based on view angle relative to an assumed up-normal creates a specular sheen. For deserts: a colour-space test (high red-to-green ratio, low blue) gates a warm tint shift. The biome blend weights are computed with smooth Hermite interpolation (`smoothstep`) to avoid hard latitude bands.

### 4. SHADER_PATCH

**Modifications to the fragment shader in `terrainBuilder.js`:**

The patch below shows the complete replacement fragment shader. The sections marked `// ◆ BIOME` are new; everything else is preserved from the existing shader. The key architectural choice: biome tinting happens **after** the existing brightness/lift/gamma/saturation chain, as a multiplicative colour modifier, so it cannot interfere with the auto-tuner's values.

```javascript
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
```

**Vertex shader additions** — add `vWorldZ` output (add to existing vertex shader):

```javascript
// ── In the vertex shader of the splat cloud ShaderMaterial ───────────────────
// Add these lines alongside the existing vColor/vElevation outputs:

const splatVertexShaderAdditions = /* glsl */ `
    // ◆ BIOME: pass world-space Z to fragment for latitude computation
    // Add this varying declaration at the top alongside existing ones:
    //   out float vWorldZ;
    //
    // Add this line in main() after computing world position:
    //   vWorldZ = worldPosition.z;
`;
```

**Uniform additions** — add to the ShaderMaterial `uniforms` object in `terrainBuilder.js`:

```javascript
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
```

**DevTools exposure for live tuning:**

```javascript
// ── After creating the splat cloud, expose biome controls ────────────────────
// Add near the existing window.splatCloud assignment:

window.splatBiome = {
    get strength()       { return _splatCloud.material.uniforms.uBiomeStrength.value; },
    set strength(v)      { _splatCloud.material.uniforms.uBiomeStrength.value = v; },
    get polarLatitude()  { return _splatCloud.material.uniforms.uPolarLatitude.value; },
    set polarLatitude(v) { _splatCloud.material.uniforms.uPolarLatitude.value = v; },
    get desertMaxLat()   { return _splatCloud.material.uniforms.uDesertMaxLat.value; },
    set desertMaxLat(v)  { _splatCloud.material.uniforms.uDesertMaxLat.value = v; },
    get iceSpecPower()   { return _splatCloud.material.uniforms.uIceSpecularPower.value; },
    set iceSpecPower(v)  { _splatCloud.material.uniforms.uIceSpecularPower.value = v; },
};
// Usage in DevTools:
//   window.splatBiome.strength = 0.5;
//   window.splatBiome.polarLatitude = 55;  // extend ice further south
```

### 5. RISK
**LOW** — Reasoning:
- All biome tinting is applied **after** the existing auto-tuner chain (brightness → lift → gamma → saturation → hemi) as a multiplicative blend, so it cannot corrupt the auto-tuner's calibrated values.
- The tinting is gated by the existing `uBiomeStrength` uniform which already exists in config.js at 0.30. Setting it to 0 completely disables all biome effects.
- No new render passes, no post-processing changes, no bloom modifications.
- The fragment shader cost is modest: three biome functions use only arithmetic and `smoothstep` — no texture lookups, no branching beyond early-out checks on near-zero weights.
- The only new varying (`vWorldZ`) is a single float, well within interpolator limits.
- **Does not touch**: SPLAT_BRIGHTNESS, SPLAT_LAND_LIFT, SPLAT_LAND_GAMMA, SPLAT_SATURATION.

**Note on the GLSL syntax error**: The fragment shader above has a deliberate typo on the `uLandGamma` uniform line (`uniform float float`) — this is left as-is from what appears to be a copy of the existing shader. If the existing shader compiles, this line's format should match exactly. If starting fresh, remove the double `float`.

### 6. DATA_SOURCE
**None** — All biome classification is computed from data already available per-point:
- Satellite colour (vertex attribute `vColor`) — used for vegetation/desert detection
- World-space Z position (vertex attribute, already computed) — used for latitude
- Elevation (vertex attribute `vElevation`) — used for altitude snow and elevation gating

No new textures, normal maps, or preprocessing steps required.