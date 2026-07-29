// waterManager.js — Flat sea plane with a land mask and sea-state paint.
//
// The Gerstner wave injection this file was originally built around was removed
// on 2026-07-24. It had never rendered: the vertex shader failed to compile for
// its entire life (waveNormal used in the <beginnormal_vertex> hook, which three
// emits BEFORE the <begin_vertex> hook that declared it), so the sea silently
// fell back to a plain material. Once the compile was fixed the intended look
// turned out to be wrong for this map — animated swell, sun glitter and a hex
// grid competing with the land and traffic the map exists to show, at real fill
// cost over every ocean pixel. Removed rather than flagged off.
import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT } from './config.js';
import { getTrueElevation } from './terrainBuilder.js';

// 1×1 transparent default so the uSeaState sampler is always valid (waveFieldLayer
// swaps in the real equirectangular sea-state colour texture when its layer is on).
const _seaStateDefault = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
_seaStateDefault.needsUpdate = true;

// Global uniforms — updated from the main animation loop and SkyManager
export const waterUniforms = {
    uTime:             { value: 0.0 },
    uSunDir:           { value: new THREE.Vector3(0.0, 1.0, 0.0) },
    uSunElevation:     { value: 1.0 },
    // Decorative sea terms (hex grid, sun glitter, subsurface glow) are pinned to
    // zero. They are still referenced by the fragment shader, so the uniforms have
    // to exist — but nothing drives them any more and there is no toggle.
    uHexGridScale:     { value: 18.0 },
    uHexGridIntensity: { value: 0.0  },
    uGlitterStrength:  { value: 0.0  },
    uSSSStrength:      { value: 0.0  },
    // ── Sea-state paint (2026-06-17) — significant wave height into the surface ──
    uSeaState:         { value: _seaStateDefault }, // equirectangular sea-state colour texture
    uSeaStateStrength: { value: 0.0  }, // 0 = off (water unchanged); set by waveFieldLayer toggle
};

export function createDynamicSeaLevel(scene) {
    const seaLevelGroup = new THREE.Group();
    seaLevelGroup.name = 'dynamicSeaLevel';

    // 1. High-Resolution Ocean Mesh
    // 256×256 gives ~66k vertices — quarter the vertex count of 512×512 with
    // imperceptible loss of wave detail at any tactical viewing distance.
    const geo = new THREE.PlaneGeometry(MAP_WIDTH, MAP_HEIGHT, 256, 256);
    geo.rotateX(-Math.PI / 2);   // bakes the rotation into the vertex buffer — position.x/z below are already final world coords

    // ── Land mask (2026-07-20, re-attempt) ────────────────────────────────
    // The sea plane has no land exclusion — it relies entirely on ordinary
    // depth-testing (opaque land sits above/in front of water) to stay
    // hidden under continents. That breaks at low, grazing angles over
    // near-sea-level land (real coastal basins/sabkha, sampled as low as
    // y=-0.96 in the reported case): the flat plane, further lifted locally
    // by Gerstner wave displacement, can rise in front of land barely above
    // y=0, occluding it entirely. Confirmed via live A/B — toggling the sea
    // mesh's `.visible` off revealed the land rendering completely correctly
    // underneath (see memory/decisions.md). Same masking technique already
    // proven in this codebase (waveFieldLayer.setElevationFn /
    // memory/scar-tissue.md): sample real GEBCO-backed elevation per vertex,
    // baked once at construction (static — coastlines don't move).
    {
        const posAttr = geo.attributes.position;
        const landMask = new Float32Array(posAttr.count);
        for (let i = 0; i < posAttr.count; i++) {
            const elev = getTrueElevation(posAttr.getX(i), posAttr.getZ(i));
            landMask[i] = elev > 0 ? 1.0 : 0.0;
        }
        geo.setAttribute('aLandMask', new THREE.BufferAttribute(landMask, 1));
    }

    const mat = new THREE.MeshStandardMaterial({
        name:             'Water',
        // ── Ocean colour (2026-07-24) ────────────────────────────────────
        // Matched live against a reference screenshot Jamal picked, then baked in.
        // 0x010e22 was tuned for a sea lit by glitter/SSS/hex-grid; with those
        // removed it read as a near-black void. metalness 0.8 / roughness 0.1 was
        // the other half of the problem — a mirror-like surface reflecting a dark
        // sky. Low metalness + high roughness gives a flat, evenly-lit blue that
        // stays readable at every sun angle, which is what a map wants.
        // Tune live: window.vg1Water.material.color.setHex(0x1b4fa0)
        color:            0x1b4fa0,
        roughness:        0.85,
        metalness:        0.10,
        transparent:      true,
        // 0.82 rather than WATER_OPACITY (0.96): some transparency lets the
        // ocean-floor bathymetry read through as depth shading near coasts and
        // over ridges, which is real data and the main reason the sea is worth
        // drawing at all.
        opacity:          0.82,
        // Emissive keeps the water visible at low ambient light.
        // Reduced from 0.75 → 0.38 so the ocean sits in a clearly darker
        // luminance band than the land terrain (figure-ground separation).
        emissive:         0x1747a0,
        // The emissive is what keeps the sea readable on the night side and at
        // low sun angles now that nothing else lights it.
        emissiveIntensity: 0.60,
    });

    // Inject GLSL directly into the Three.js Standard Shader
    mat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime             = waterUniforms.uTime;
        shader.uniforms.uSunDir           = waterUniforms.uSunDir;
        shader.uniforms.uSunElevation     = waterUniforms.uSunElevation;
        shader.uniforms.uHexGridScale     = waterUniforms.uHexGridScale;
        shader.uniforms.uHexGridIntensity = waterUniforms.uHexGridIntensity;
        shader.uniforms.uGlitterStrength  = waterUniforms.uGlitterStrength;
        shader.uniforms.uSSSStrength      = waterUniforms.uSSSStrength;
        shader.uniforms.uSeaState         = waterUniforms.uSeaState;
        shader.uniforms.uSeaStateStrength = waterUniforms.uSeaStateStrength;

        shader.vertexShader = `
            uniform float uTime;
            attribute float aLandMask;
            varying float vWaveHeight;
            varying vec3  vWorldNormal;
            varying vec3  vWorldPos;
            varying float vLandMask;

            ${shader.vertexShader}
        `.replace(
            // ── ORDER MATTERS (fixed 2026-07-24) ──────────────────────────────
            // three emits <beginnormal_vertex> BEFORE <begin_vertex>. All the wave
            // maths therefore has to live HERE, in the earlier hook, or `waveNormal`
            // is referenced before its declaration and the entire vertex shader
            // fails to compile:
            //     ERROR: 'waveNormal' : undeclared identifier
            //     ERROR: '=' : cannot convert from 'const highp float' to
            //                  'highp 3-component vector of float'
            // The material then silently renders wrong rather than erroring
            // visibly — almost certainly the unexplained "water changes colour"
            // and "onBeforeCompile edit produced no effect" entries in
            // memory/scar-tissue.md. `transformed` is still declared in the
            // begin_vertex hook below, where three expects it.
            `#include <beginnormal_vertex>`,
            `
            // ── FLAT SEA (2026-07-24) ────────────────────────────────────
            // The Gerstner swell was removed outright rather than left behind a
            // flag. It had never actually rendered (the vertex shader failed to
            // compile — see git history / memory), and once fixed it was clear
            // animated waves are decoration that competes with the data this map
            // exists to show, and cost fill rate across every ocean pixel.
            //
            // What remains here is what the FRAGMENT stage genuinely needs:
            // vLandMask (discards water over land), vWorldPos/vWorldNormal
            // (Fresnel + sea-state sampling). Those are data, not decoration.
            vec3 p = position;
            vWaveHeight  = 0.0;
            vec3 objectNormal = vec3(0.0, 1.0, 0.0);
            vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
            vWorldPos    = (modelMatrix * vec4(p, 1.0)).xyz;
            vLandMask    = aLandMask;
            `
        ).replace(
            // Runs AFTER the block above, so `p` is already in scope here.
            `#include <begin_vertex>`,
            `
            vec3 transformed = p;
            `
        );

        // (The FBM micro-ripple injection was removed with the waves — it perturbed
        // the Gerstner normal, which no longer exists.)

        // Foam in the fragment stage — runs after all Three.js lighting so
        // we blend on top of the lit ocean colour rather than under it.
        shader.fragmentShader = `
            uniform vec3  uSunDir;
            uniform float uSunElevation;
            // Declared in BOTH stages: vertex and fragment compile as separate
            // programs, and uTime is used in each. Missing here gave
            // "ERROR: 'uTime' : undeclared identifier" (2026-07-24).
            uniform float uTime;
            uniform float uHexGridScale;
            uniform float uHexGridIntensity;
            uniform float uGlitterStrength;
            uniform float uSSSStrength;
            uniform sampler2D uSeaState;
            uniform float uSeaStateStrength;
            varying float vWaveHeight;
            varying vec3  vWorldNormal;
            varying vec3  vWorldPos;
            varying float vLandMask;
            ${shader.fragmentShader}
        `.replace(
            `#include <dithering_fragment>`,
            `#include <dithering_fragment>

            // ── Land mask (2026-07-20) ──────────────────────────────────────────
            // Baked per-vertex from real GEBCO elevation (see geometry setup in
            // createDynamicSeaLevel). Discard early so masked land pixels skip
            // all the per-pixel sea-state/foam/fresnel/glitter/hex-grid work
            // below. Hard cutoff (matches waveFieldLayer's masking technique) —
            // the 256×256 grid (~1.17 scene units/cell) keeps the coastline
            // reasonably crisp at map scale.
            if (vLandMask > 0.5) discard;

            // ── Sea-state paint — significant wave height INTO the ocean ───────
            // Recolour the base water FIRST so foam / fresnel / sun-glitter / SSS
            // below layer on top, making the sea-state read as the water itself
            // (not a flat overlay). Scene z is Web-Mercator (matches vessels +
            // terrain); invert to true latitude so the equirectangular sea-state
            // texture aligns with the coastlines. Land needs no mask — the opaque
            // terrain occludes the water, so the coastline is pixel-perfect.
            if (uSeaStateStrength > 0.001) {
                float ss_lon   = (vWorldPos.x / 150.0) * 180.0;
                float ss_mercY = -vWorldPos.z * 3.14159265 / 150.0;
                float ss_lat   = degrees(2.0 * atan(exp(ss_mercY)) - 1.57079633);
                vec2  ss_uv    = vec2((ss_lon + 180.0) / 360.0, (ss_lat + 90.0) / 180.0);
                vec4  ss       = texture2D(uSeaState, ss_uv);
                gl_FragColor.rgb = mix(gl_FragColor.rgb, ss.rgb, clamp(ss.a * uSeaStateStrength, 0.0, 1.0));
            }

            // ── Crest foam ────────────────────────────────────────────────────
            float crestFoam = smoothstep(0.25, 0.65, vWaveHeight);
            gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.65, 0.82, 1.0), crestFoam * 0.55);
            gl_FragColor.a   = min(1.0, gl_FragColor.a + crestFoam * 0.15);

            // ── Fresnel sky reflection ─────────────────────────────────────────
            vec3  viewDir  = normalize(cameraPosition - vWorldPos);
            float cosTheta = max(0.0, dot(viewDir, vWorldNormal));
            float fresnel  = 0.04 + 0.96 * pow(1.0 - cosTheta, 5.0);
            // ── Fresnel DISABLED (2026-07-24) ─────────────────────────────────
            // Was clamp(fresnel * 0.55, 0.0, 0.38). Fresnel is view-angle
            // dependent: ~0.04 where you look straight down at the water and
            // ~0.38 at grazing angles. On a map viewed obliquely that paints a
            // visible horizontal seam across every ocean — flat lighter water
            // toward the horizon, darker water in the foreground, with a hard
            // transition between them. Physically correct for a photoreal sea,
            // wrong for a chart, where the ocean should read as one uniform
            // surface whose only variation is real bathymetry showing through.
            //
            // The block below is left intact rather than deleted because
            // viewDir/reflDir are still referenced further down; with the mix
            // weight at zero none of it reaches the framebuffer.
            fresnel = 0.0;

            vec3 reflDir = reflect(-viewDir, vWorldNormal);

            // ── Sun-driven sky palette ────────────────────────────────────────
            // uSunElevation: -1 = midnight, 0 = horizon, 1 = zenith
            float dayAmt   = clamp(uSunElevation * 2.0, 0.0, 1.0);
            float dawnAmt  = pow(max(0.0, 1.0 - abs(uSunElevation) * 3.5), 2.0);

            // Zenith: near-black at night, deep tactical navy at noon
            vec3 zenithNight = vec3(0.003, 0.005, 0.015);
            vec3 zenithDay   = vec3(0.010, 0.040, 0.140);
            vec3 zenithCol   = mix(zenithNight, zenithDay, dayAmt);

            // Horizon: black at night, blue at day, amber at dawn/dusk
            vec3 horizNight  = vec3(0.003, 0.005, 0.010);
            vec3 horizDay    = vec3(0.020, 0.090, 0.220);
            vec3 horizDawn   = vec3(0.200, 0.090, 0.025);
            vec3 horizCol    = mix(horizNight, horizDay, dayAmt);
            horizCol         = mix(horizCol, horizDawn, dawnAmt * 0.75);

            // Blend zenith / horizon by reflection elevation
            float skyT   = clamp(reflDir.y, 0.0, 1.0);
            vec3  skyCol = mix(horizCol, zenithCol, skyT);

            // Narrow horizon shimmer band
            float horizBand = pow(max(0.0, 1.0 - abs(reflDir.y)), 14.0);
            skyCol         += horizCol * horizBand * 0.55;

            // Sun specular highlight in the reflection — small disk, warm colour
            float sunSpec = pow(max(0.0, dot(reflDir, uSunDir)), 180.0);
            skyCol       += vec3(1.0, 0.85, 0.55) * sunSpec * clamp(uSunElevation, 0.0, 1.0) * 0.8;

            gl_FragColor.rgb = mix(gl_FragColor.rgb, skyCol, fresnel);

            float dayLit = clamp(uSunElevation, 0.0, 1.0);

            // ── Photoreal: sun glitter path ───────────────────────────────────
            // Real water sparkles because micro-facets catch the sun per-pixel.
            // Jitter the surface normal with scrolling hash noise and take a very
            // tight specular lobe — dense sparkle near the sun line, scattered
            // glints further out. A broad warm lobe (pow 36) underlays the path.
            vec2  gUV   = vWorldPos.xz * 7.0 + vec2(uTime * 0.6, -uTime * 0.4);
            float gHash = fract(sin(dot(floor(gUV), vec2(12.9898, 78.233))) * 43758.5453);
            vec3  gN    = normalize(vWorldNormal + vec3(gHash - 0.5, 0.0, fract(gHash * 7.31) - 0.5) * 0.10);
            vec3  gRefl = reflect(-viewDir, gN);
            float sparkle  = pow(max(0.0, dot(gRefl, uSunDir)), 700.0);
            float broadPath= pow(max(0.0, dot(reflDir, uSunDir)), 36.0);
            gl_FragColor.rgb += (vec3(1.0, 0.93, 0.72) * sparkle * 1.6
                               + vec3(0.55, 0.45, 0.28) * broadPath * 0.10)
                               * dayLit * uGlitterStrength;

            // ── Photoreal: crest translucency (fake subsurface scattering) ────
            // Looking toward the sun, wave crests glow teal as light passes
            // through the thin water — strongest on high crests at low sun.
            float sssGeom = pow(max(0.0, dot(viewDir, -uSunDir) * 0.5 + 0.5), 3.0);
            float sssAmt  = sssGeom * smoothstep(0.10, 0.60, vWaveHeight) * dayLit;
            gl_FragColor.rgb += vec3(0.02, 0.17, 0.15) * sssAmt * uSSSStrength;

            // ── Hex Depth Grid ────────────────────────────────────────────────────
            // World UV in [-0.5, +0.5] across the 300-unit map
            vec2 hg_wUV = vWorldPos.xz / 300.0;

            // Two-octave value noise — simulates depth variation across the ocean.
            // No texture needed: pure hash math.
            vec2 hg_p1 = floor(hg_wUV * 5.0);
            vec2 hg_f1 = fract(hg_wUV * 5.0);
            hg_f1 = hg_f1 * hg_f1 * (3.0 - 2.0 * hg_f1);
            float hg_n1 = mix(
                mix(fract(sin(dot(hg_p1,              vec2(127.1,311.7)))*43758.5),
                    fract(sin(dot(hg_p1+vec2(1,0),    vec2(127.1,311.7)))*43758.5), hg_f1.x),
                mix(fract(sin(dot(hg_p1+vec2(0,1),    vec2(127.1,311.7)))*43758.5),
                    fract(sin(dot(hg_p1+vec2(1,1),    vec2(127.1,311.7)))*43758.5), hg_f1.x),
                hg_f1.y);

            vec2 hg_p2 = floor(hg_wUV * 11.0);
            vec2 hg_f2 = fract(hg_wUV * 11.0);
            hg_f2 = hg_f2 * hg_f2 * (3.0 - 2.0 * hg_f2);
            float hg_n2 = mix(
                mix(fract(sin(dot(hg_p2,              vec2(269.5,183.3)))*43758.5),
                    fract(sin(dot(hg_p2+vec2(1,0),    vec2(269.5,183.3)))*43758.5), hg_f2.x),
                mix(fract(sin(dot(hg_p2+vec2(0,1),    vec2(269.5,183.3)))*43758.5),
                    fract(sin(dot(hg_p2+vec2(1,1),    vec2(269.5,183.3)))*43758.5), hg_f2.x),
                hg_f2.y);

            float hg_depth = pow(hg_n1 * 0.65 + hg_n2 * 0.35, 1.4);

            // Faint depth-responsive teal lift on shallower regions
            gl_FragColor.rgb += vec3(0.0, 0.055, 0.08) * hg_depth * 0.6 * uHexGridIntensity;

            // Animated UV distortion — slow holographic wobble
            vec2 hg_uv = hg_wUV;
            hg_uv.x += sin(hg_wUV.y * 6.0 + uTime * 0.07) * 0.006;
            hg_uv.y += cos(hg_wUV.x * 5.0 + uTime * 0.05) * 0.006;
            hg_uv *= uHexGridScale;

            // Axial hex grid (equilateral, flat-top)
            // Fold space into one repeating hex cell, measure dist to edge.
            vec2 hg_r = vec2(1.7320508, 1.0);
            vec2 hg_a = mod(hg_uv,           hg_r) - hg_r * 0.5;
            vec2 hg_b = mod(hg_uv + hg_r * 0.5, hg_r) - hg_r * 0.5;
            // Pick whichever fold is closer to the hex centre — no ternary
            float hg_pickB = step(dot(hg_b, hg_b), dot(hg_a, hg_a));
            vec2  hg_g     = mix(hg_a, hg_b, hg_pickB);

            // Hexagonal Chebyshev distance to cell edge
            float hg_dist = max(abs(hg_g.x) * 0.866025 + abs(hg_g.y) * 0.5, abs(hg_g.y));

            // Thin grid line where dist approaches 0.5 (cell boundary)
            float hg_line = smoothstep(0.47, 0.44, hg_dist);

            // Faint node glow at hex vertices
            float hg_node = smoothstep(0.495, 0.48, hg_dist) * smoothstep(0.46, 0.48, hg_dist);

            float hg_lo = (0.04 + hg_depth * 0.04) * hg_line;
            float hg_no = (0.06 + hg_depth * 0.06) * hg_node;
            gl_FragColor.rgb += vec3(0.06, 0.42, 0.55) * (hg_lo + hg_no) * uHexGridIntensity;

            // ── Edge fade — kills the visible rectangle border ─────────────────
            // vUv is not declared in Three.js r184 for materials without texture
            // maps (USE_UV is not set), so we use vWorldPos.xz instead.
            // Fade zone: outer 15 units (~5% of 300-unit map) on all four sides.
            float ef_x = smoothstep( 0.0, 15.0, 150.0 - abs( vWorldPos.x ) );
            float ef_z = smoothstep( 0.0, 15.0, 150.0 - abs( vWorldPos.z ) );
            gl_FragColor.a *= ef_x * ef_z;
            `
        );
    };

    const seaMesh = new THREE.Mesh(geo, mat);
    seaMesh.position.y = -0.2; // Sit slightly below the land splats
    seaLevelGroup.add(seaMesh);

    // Dark wash plane REMOVED. It was a near-black PlaneGeometry at Y=-2.5
    // covering the full map extent, used to deepen the ocean into a lower-
    // luminance band so land read as figure against ocean ground. From low-
    // tilt camera angles its rectangular boundary showed as a visible dark
    // panel — same cover-up-creates-its-own-edge pattern the aquarium walls
    // had. Figure/ground separation will instead come from richer bathymetry
    // (real depth-gradient colour on the ocean-floor splats).

    // Polar grid overlay REMOVED. Was a PolarGridHelper at Y=2.0 with
    // camera-height-driven opacity (see deleted block in updateDynamicWater).
    // The concentric circles + radial lines were a command-center aesthetic
    // cue but cluttered the map at oblique angles.

    // Expose for live console tuning:
    //   window.waterUniforms.uHexGridIntensity.value = 5.0
    //   window.waterUniforms.uHexGridScale.value = 12.0
    window.waterUniforms = waterUniforms;

    // ── SEA PLANE HIDDEN BY DEFAULT (2026-07-24) ─────────────────────────────
    // Jamal's call, and it is the right one: the real ocean in this map is the
    // BATHYMETRY on the ocean-floor mesh — depth-shaded, with shelves, ridges and
    // trenches that are actual data. This plane is a flat tinted sheet laid on top
    // of it, and no amount of colour tuning stops it flattening that detail into
    // one uniform blue. Hiding it is what finally matched the reference look.
    //
    // The mesh is still built rather than deleted: it carries the baked land mask
    // and is the surface waveFieldLayer paints significant-wave-height onto, so
    // that layer can show it when it needs it. Nothing else should.
    //   window.vg1Water.visible = true   // to see it again
    seaMesh.visible = false;

    // Debug handle (Tier 3 per CLAUDE.md — debug only, never a data path).
    if (typeof window !== 'undefined') window.vg1Water = seaMesh;

    scene.add(seaLevelGroup);
    return seaLevelGroup;
}

// ── Sea surface: flat and blue (2026-07-24) ──────────────────────────────────
// Animated swell, sun glitter, subsurface glow and the hex grid have all been
// removed — not disabled behind a flag, removed. They were decoration on a map
// whose job is showing land and traffic, and they cost fill rate over every
// ocean pixel at world view where they conveyed nothing.
//
// The one piece of history worth keeping: none of it had ever rendered. The
// water vertex shader failed to compile for its whole life (waveNormal was used
// in the <beginnormal_vertex> hook, which three emits BEFORE the <begin_vertex>
// hook where it was declared), so the sea had silently fallen back to a plain
// material. CLAUDE.md's "waveA/B/C/D were tuned to look physically correct" was
// describing something nobody had seen. Fixing the compile is what finally made
// the design question answerable, and the answer was no.
//
// uSeaState / uSeaStateStrength are NOT decoration and remain wired: that is
// waveFieldLayer painting real significant-wave-height data onto the surface.
export function updateDynamicWater(time, _cameraY = 500) {
    // Still advanced so the fragment-side sea-state sampling stays live.
    waterUniforms.uTime.value = time;
}