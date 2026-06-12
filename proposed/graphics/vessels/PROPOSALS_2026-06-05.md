# Vessel & Aircraft Design — Enhancement Proposals

*2026-06-05*

> Review carefully before applying. Shader patches must be tested in isolation.



# Vanguard1 Vessel & Aircraft Design Improvements

## Improvement 1: LOD-Aware Procedural Hull Overhaul with PBR Detail Materials

**TITLE:** Multi-LOD Procedural Hull System with Weathered PBR Materials

**VESSEL_CLASS:** ALL (CARGO, TANKER, PATROL, HOSTILE, FIGHTER, AWACS, DRONE, SUBMARINE, ORBITAL)

**VISUAL_EFFECT:** Each vessel class gets a distinct, recognizable silhouette built from shaped geometry rather than raw boxes. Cargo ships have a tapered bow, raised stern bridge, and container stacks with rust-streaked hulls. Patrol vessels get a sharp knife-bow, angled superstructure, and spinning radar dish. Submarines feature a proper teardrop hull with hydroplanes. Aircraft have swept wings, engine nacelles, and metallic finishes with panel-line detail. At distance (LOD2), vessels collapse to a single merged geometry with baked vertex colors. At medium range (LOD1), they use the full multi-mesh construction. At close range (LOD0), animated elements activate (radar rotation, propeller wash sprites, navigation lights) and a custom shader adds waterline rust streaks, antifouling boot-top paint bands, and hull panel weathering via triplanar projection.

**APPROACH:** Replace all shapeBuilders with a new `vesselGeometryFactory` that produces THREE.LOD objects. LOD0 is the full detailed group with animated sub-objects. LOD1 is a simplified merged BufferGeometry. LOD2 is a single oriented billboard sprite. A custom ShaderMaterial on the hull at LOD0 uses triplanar-projected procedural rust/weathering. Animated radar dishes and nav-light point emitters are toggled by LOD level.

**PERFORMANCE_NOTE:** LOD system *reduces* overall draw calls vs. current approach. At typical zoom showing 50+ vessels, most will be LOD2 (1 draw call each = sprite). Only 5-10 nearby vessels will be LOD0. Net effect: fewer draw calls than current system despite higher visual fidelity. Animated elements (radar rotation, light blink) are driven by a single shared uniform update per frame, not per-vessel. Estimated budget: 200 vessels × average 2.5 draw calls = 500 draw calls (down from current ~200 vessels × 4-6 meshes = 800-1200 draw calls).

**FREE_ASSETS:**
- Rust/weathering noise texture: generate procedurally (included in code) or use CC0 grunge from `https://ambientcg.com/view?id=Rust006`
- No external GLTF dependencies — fully procedural with optional GLTF upgrade path

**CODE:**

```javascript
// vesselGeometryFactory.js — LOD-aware procedural vessel geometry with PBR weathering
import * as THREE from 'three';

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1: Procedural Noise Texture for Hull Weathering
// ─────────────────────────────────────────────────────────────────────────────

let _rustNoiseTex = null;
function getRustNoiseTexture() {
    if (_rustNoiseTex) return _rustNoiseTex;
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(size, size);
    const data = imageData.data;

    // Multi-octave value noise for rust streaks
    function hash(x, y) {
        let h = (x * 374761393 + y * 668265263 + 1013904223) | 0;
        h = ((h >> 13) ^ h) * 1274126177;
        return ((h >> 16) ^ h) & 0xff;
    }

    function smoothNoise(x, y, scale) {
        const sx = x / scale;
        const sy = y / scale;
        const ix = Math.floor(sx);
        const iy = Math.floor(sy);
        const fx = sx - ix;
        const fy = sy - iy;
        const a = hash(ix, iy);
        const b = hash(ix + 1, iy);
        const c = hash(ix, iy + 1);
        const d = hash(ix + 1, iy + 1);
        const ab = a + (b - a) * fx;
        const cd = c + (d - c) * fx;
        return ab + (cd - ab) * fy;
    }

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            // R channel: large-scale rust patches
            const n1 = smoothNoise(x, y, 64) * 0.5 +
                        smoothNoise(x, y, 32) * 0.25 +
                        smoothNoise(x, y, 16) * 0.15 +
                        smoothNoise(x, y, 8) * 0.1;
            // G channel: vertical streak bias (gravity drip pattern)
            const streakBias = smoothNoise(x, y * 3, 24) * 0.6 +
                               smoothNoise(x, y * 2, 12) * 0.4;
            // B channel: fine grit/panel lines
            const fine = smoothNoise(x, y, 4) * 0.7 +
                         smoothNoise(x, y, 2) * 0.3;
            // A channel: waterline mask (stronger near bottom)
            const waterline = Math.max(0, 1.0 - (y / size) * 2.0);

            data[i]     = Math.min(255, n1);
            data[i + 1] = Math.min(255, streakBias);
            data[i + 2] = Math.min(255, fine);
            data[i + 3] = Math.min(255, waterline * 255);
        }
    }

    ctx.putImageData(imageData, 0, 0);
    _rustNoiseTex = new THREE.CanvasTexture(canvas);
    _rustNoiseTex.wrapS = _rustNoiseTex.wrapT = THREE.RepeatWrapping;
    return _rustNoiseTex;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2: Weathered Hull ShaderMaterial
// ─────────────────────────────────────────────────────────────────────────────

const weatheredHullVertexShader = /* glsl */ `#version 300 es
precision highp float;

in vec3 position;
in vec3 normal;
in vec2 uv;

uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;

out vec3 vWorldPos;
out vec3 vWorldNormal;
out vec3 vLocalPos;
out vec2 vUv;
out vec3 vViewPos;

void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vWorldNormal = normalize(normalMatrix * normal);
    vLocalPos = position;
    vUv = uv;
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vViewPos = mvPos.xyz;
    gl_Position = projectionMatrix * mvPos;
}
`;

const weatheredHullFragmentShader = /* glsl */ `#version 300 es
precision highp float;

in vec3 vWorldPos;
in vec3 vWorldNormal;
in vec3 vLocalPos;
in vec2 vUv;
in vec3 vViewPos;

uniform vec3 uHullColor;
uniform vec3 uBootTopColor;       // antifouling paint below waterline
uniform vec3 uRustColor;
uniform float uWaterlineHeight;   // local Y where waterline sits
uniform float uWeathering;        // 0 = pristine, 1 = heavily rusted
uniform sampler2D uNoiseTex;
uniform float uTime;

// Simple directional light
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform vec3 uAmbientColor;

out vec4 fragColor;

// Triplanar sampling to avoid UV seam artifacts on hull geometry
vec4 triplanarSample(sampler2D tex, vec3 pos, vec3 normal, float scale) {
    vec3 blending = abs(normal);
    blending = normalize(max(blending, vec3(0.00001)));
    float b = blending.x + blending.y + blending.z;
    blending /= b;

    vec4 xaxis = texture(tex, pos.yz * scale);
    vec4 yaxis = texture(tex, pos.xz * scale);
    vec4 zaxis = texture(tex, pos.xy * scale);

    return xaxis * blending.x + yaxis * blending.y + zaxis * blending.z;
}

void main() {
    // Triplanar noise lookup
    vec4 noise = triplanarSample(uNoiseTex, vLocalPos, vWorldNormal, 0.5);

    float rustNoise = noise.r / 255.0;
    float streakNoise = noise.g / 255.0;

    // Waterline band: boot-top antifouling paint region
    float waterlineDist = vLocalPos.y - uWaterlineHeight;
    float bootTopMask = smoothstep(-0.15, 0.05, waterlineDist);
    // Below waterline = antifouling color, above = hull color
    vec3 baseColor = mix(uBootTopColor, uHullColor, bootTopMask);

    // Rust concentration: heavier near waterline and on vertical streaks
    float waterlineRust = 1.0 - smoothstep(-0.1, 0.6, waterlineDist);
    float rustIntensity = uWeathering * (
        rustNoise * 0.4 +
        streakNoise * waterlineRust * 0.4 +
        waterlineRust * 0.2
    );
    rustIntensity = clamp(rustIntensity, 0.0, 1.0);

    // Blend rust into base color
    vec3 finalAlbedo = mix(baseColor, uRustColor, rustIntensity);

    // Roughness increases with rust
    float roughness = mix(0.5, 0.9, rustIntensity);

    // Simple Lambertian + Fresnel rim for metallic sheen
    vec3 N = normalize(vWorldNormal);
    vec3 L = normalize(uLightDir);
    vec3 V = normalize(-vViewPos);
    float NdotL = max(dot(N, L), 0.0);

    // Fresnel-Schlick approximation for rim lighting
    float fresnel = pow(1.0 - max(dot(N, V), 0.0), 3.0) * 0.15;

    vec3 diffuse = finalAlbedo * (uAmbientColor + uLightColor * NdotL);
    vec3 rim = uLightColor * fresnel * (1.0 - roughness);

    fragColor = vec4(diffuse + rim, 1.0);
}
`;

function createWeatheredHullMaterial(hullColor, options = {}) {
    const {
        bootTopColor = new THREE.Color(0x8b0000),  // dark red antifouling
        rustColor = new THREE.Color(0x8b4513),
        waterlineHeight = -0.1,
        weathering = 0.4
    } = options;

    return new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: weatheredHullVertexShader,
        fragmentShader: weatheredHullFragmentShader,
        uniforms: {
            uHullColor:       { value: new THREE.Color(hullColor) },
            uBootTopColor:    { value: new THREE.Color(bootTopColor) },
            uRustColor:       { value: new THREE.Color(rustColor) },
            uWaterlineHeight: { value: waterlineHeight },
            uWeathering:      { value: weathering },
            uNoiseTex:        { value: getRustNoiseTexture() },
            uTime:            { value: 0.0 },
            uLightDir:        { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
            uLightColor:      { value: new THREE.Color(0xffeedd) },
            uAmbientColor:    { value: new THREE.Color(0x334455) }
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3: Shared Materials (enhanced from original)
// ─────────────────────────────────────────────────────────────────────────────

const materials = {
    // Standard PBR materials for non-hull parts
    white:        new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.4, metalness: 0.1 }),
    grey:         new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.6, metalness: 0.2 }),
    navyGrey:     new THREE.MeshStandardMaterial({ color: 0x607d8b, roughness: 0.5, metalness: 0.3 }),
    subBlack:     new THREE.MeshStandardMaterial({ color: 0x212121, roughness: 0.8, metalness: 0.2 }),
    hostileGreen: new THREE.MeshStandardMaterial({ color: 0x4caf50, roughness: 0.7, metalness: 0.2 }),
    hostileDark:  new THREE.MeshStandardMaterial({ color: 0x2e7d32, roughness: 0.8 }),
    aeroGrey:     new THREE.MeshStandardMaterial({ color: 0xb0bec5, roughness: 0.3, metalness: 0.7 }),
    aeroDark:     new THREE.MeshStandardMaterial({ color: 0x455a64, roughness: 0.5, metalness: 0.5 }),
    glass:        new THREE.MeshStandardMaterial({
        color: 0x88ccff, roughness: 0.1, metalness: 0.9,
        transparent: true, opacity: 0.6
    }),
    radarDish:    new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.3, metalness: 0.8 }),
    antenna:      new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.9 }),
    navLightRed:  new THREE.MeshBasicMaterial({ color: 0xff0000 }),
    navLightGreen: new THREE.MeshBasicMaterial({ color: 0x00ff00 }),
    navLightWhite: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    exhaust:      new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.9 })
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4: Animated Components
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a rotating radar dish assembly.
 * The returned group has a `userData.animate` function called each frame.
 */
function createRadarAssembly(radius = 0.3, height = 0.6) {
    const group = new THREE.Group();

    // Mast
    const mast = new THREE.Mesh(
        new THREE.CylinderGeometry(0.03, 0.03, height, 6),
        materials.antenna
    );
    mast.position.y = height / 2;
    group.add(mast);

    // Rotating dish pivot
    const pivot = new THREE.Group();
    pivot.position.y = height;

    // Dish — flat disc
    const dishGeo = new THREE.CircleGeometry(radius, 12);
    const dish = new THREE.Mesh(dishGeo, materials.radarDish);
    dish.rotation.y = Math.PI / 2;
    pivot.add(dish);

    // Feed horn
    const hornGeo = new THREE.CylinderGeometry(0.02, 0.02, radius * 0.6, 4);
    const horn = new THREE.Mesh(hornGeo, materials.antenna);
    horn.rotation.z = Math.PI / 2;
    horn.position.x = radius * 0.3;
    pivot.add(horn);

    group.add(pivot);

    // Store rotation speed (radians/sec) and pivot reference
    const rotSpeed = 1.5 + Math.random() * 1.0; // vary per instance
    group.userData.animate = (deltaTime) => {
        pivot.rotation.y += rotSpeed * deltaTime;
    };
    group.userData.animatedPivot = pivot;

    return group;
}

/**
 * Creates navigation lights (port red, starboard green, masthead white).
 * Lights blink at different rates.
 */
function createNavLights(beamWidth, mastHeight) {
    const group = new THREE.Group();
    const lightGeoSmall = new THREE.SphereGeometry(0.04, 4, 4);

    // Port (red) — left side
    const portLight = new THREE.Mesh(lightGeoSmall, materials.navLightRed);
    portLight.position.set(-beamWidth / 2, 0.2, 0);
    group.add(portLight);

    // Starboard (green) — right side
    const starboardLight = new THREE.Mesh(lightGeoSmall, materials.navLightGreen);
    starboardLight.position.set(beamWidth / 2, 0.2, 0);
    group.add(starboardLight);

    // Masthead (white) — top
    const mastheadLight = new THREE.Mesh(lightGeoSmall, materials.navLightWhite);
    mastheadLight.position.set(0, mastHeight, 0.3);
    group.add(mastheadLight);

    // Stern light (white)
    const sternLight = new THREE.Mesh(lightGeoSmall, materials.navLightWhite);
    sternLight.position.set(0, 0.3, -beamWidth);
    group.add(sternLight);

    const blinkPhase = Math.random() * Math.PI * 2;
    group.userData.animate = (deltaTime, elapsed) => {
        // Masthead blinks at ~1Hz
        const blink = Math.sin(elapsed * 3.0 + blinkPhase) > 0.3 ? 1 : 0;
        mastheadLight.visible = !!blink;
        sternLight.visible = !!blink;
    };

    return group;
}

/**
 * Creates a propeller wash sprite that scales with speed.
 */
let _washTex = null;
function getWashTexture() {
    if (_washTex) return _washTex;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
    grad.addColorStop(0.0, 'rgba(180,220,255,0.6)');
    grad.addColorStop(0.3, 'rgba(200,230,255,0.3)');
    grad.addColorStop(0.7, 'rgba(220,240,255,0.1)');
    grad.addColorStop(1.0, 'rgba(255,255,255,0.0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(32, 32, 30, 0, Math.PI * 2);
    ctx.fill();
    _washTex = new THREE.CanvasTexture(c);
    return _washTex;
}

function createPropWash() {
    const spriteMat = new THREE.SpriteMaterial({
        map: getWashTexture(),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending
    });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(0.8, 0.8, 1);

    sprite.userData.animate = (deltaTime, elapsed) => {
        const pulse = 0.8 + Math.sin(elapsed * 5.0) * 0.15;
        sprite.scale.set(pulse, pulse * 0.5, 1);
        sprite.material.opacity = 0.3 + Math.sin(elapsed * 3.0) * 0.1;
    };

    return sprite;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5: Tapered Hull Geometry Generator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a ship hull with tapered bow and flat stern.
 * Cross-section is roughly rectangular with optional keel rounding.
 *
 * @param {number} length  - hull length along Z
 * @param {number} beam    - hull width (X)
 * @param {number} depth   - hull height (Y)
 * @param {number} bowTaper - 0..1, how much the bow narrows (1 = full knife bow)
 * @param {number} sternTaper - 0..1, how much the stern narrows
 * @returns {THREE.BufferGeometry}
 */
function createTaperedHullGeometry(length, beam, depth, bowTaper = 0.7, sternTaper = 0.15) {
    const segments = 12; // lengthwise
    const radialSegs = 8; // around cross-section

    const vertices = [];
    const normals = [];
    const uvs = [];
    const indices = [];

    // Generate cross-section rings from stern (-length/2) to bow (+length/2)
    for (let i = 0; i <= segments; i++) {
        const t = i / segments; // 0 = stern, 1 = bow
        const z = -length / 2 + t * length;

        // Taper factor: 1 at midship, narrowing at bow and stern
        let taper = 1.0;
        if (t > 0.65) {
            // Bow taper
            const bowT = (t - 0.65) / 0.35;
            taper = 1.0 - bowTaper * bowT * bowT;
        } else if (t < 0.2) {
            // Stern taper
            const sternT = 1.0 - t / 0.2;
            taper = 1.0 - sternTaper * sternT * sternT;
        }

        const halfBeam =