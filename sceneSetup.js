// sceneSetup.js — Renderer, camera, OrbitControls, lights, post-processing
import * as THREE from 'three';
import { quality } from './qualityManager.js';
// viewport owns the MAP RECT. Before the bezel the canvas was the window, so
// window.innerWidth/Height happened to be right; with docked rails and a
// transient selection dock it is a sub-rect and every size below must come
// from here instead. See viewport.js header for the full rationale.
import viewport from './viewport.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { VerticalTiltShiftShader } from 'three/addons/shaders/VerticalTiltShiftShader.js';
import { HorizontalTiltShiftShader } from 'three/addons/shaders/HorizontalTiltShiftShader.js';
import {
    MAP_WIDTH, MAP_HEIGHT,
    BLOOM_STRENGTH_BASE, BLOOM_RADIUS, BLOOM_THRESHOLD,
    TONE_MAPPING_EXPOSURE,
} from './config.js';

export function initScene() {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x010409);

    const clock = new THREE.Clock();

    // near stays at 1: the post-processing chain (fog/bokeh/tilt-shift) reads
    // depth assuming this near plane — lowering it to 0.05 fogged the whole
    // world to black (2026-07-12). City-scale zoom needs a coordinated
    // near-plane + post-chain depth pass; see DEMO-PUNCHLIST.
    // Bind viewport to the container the renderer draws into BEFORE reading any
    // size from it. attach() measures immediately, so aspect below is correct on
    // the first frame rather than one resize behind.
    const canvasHost = document.getElementById('canvas-container');
    viewport.attach(canvasHost, { pixelCap: quality.pixelCap() });

    const camera = new THREE.PerspectiveCamera(35, viewport.aspect(), 1, 3000);
    camera.position.set(0, 250, 400);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    // Cap at 1.5 — on Retina / 4K screens devicePixelRatio = 2.0, which means
    // 4× the pixels to shade per frame.  1.5 cuts that by ~44% with imperceptible
    // quality loss at tactical-map viewing distances.
    // Pixel ratio is capped per quality tier (1.0 on low-end / mobile up to 2.0
    // on Ultra). The runtime monitor in main.js nudges it live from real FPS.
    renderer.setPixelRatio(quality.pixelCap());
    renderer.setSize(viewport.width(), viewport.height());
    renderer.toneMapping         = THREE.ACESFilmicToneMapping;
    // ACES Filmic preserves colour saturation under bright light and gives the
    // cinematic contrast that Reinhard washes out.  ACES has a built-in S-curve
    // so exposure sits lower than Reinhard's 1.6 — 0.85 prevents snow-cap and
    // mountain highlights from clipping to white under the directional light.
    renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
    canvasHost.appendChild(renderer.domElement);

    return { scene, clock, camera, renderer, isWebGPU: false };
}

export function initControls(camera, renderer, stateRef) {
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    // Higher dampingFactor = less inertial glide = more responsive. The old 0.04
    // was very floaty ("momentum makes it feel less responsive" — feedback). 0.12
    // tracks input closely while keeping a touch of smoothing. User-tunable via the
    // Camera Feel control in Settings (persisted).
    controls.dampingFactor = (() => { try { return parseFloat(localStorage.getItem('vg1_cam_damping')) || 0.12; } catch (_) { return 0.12; } })();
    // ZOOM-OUT CAP (2026-07-29): locked to the initial load height so the camera
    // can never pull further out than the view the map loads at. The load view is
    // camera.position (0,250,400) → radius = hypot(250,400) = 471.699, which frames
    // the full 300-unit map (visible vertical extent 2*d*tan(17.5deg) = 297.5 ≈ 300).
    // 472 sits a hair above the load radius so the first frame doesn't clamp-snap.
    // Raise this back toward 550 to allow zooming further out again.
    controls.maxDistance = 472;
    // minDistance 2 → 0.08 (2026-07-13 near-plane surgery): the near plane is
    // now altitude-dynamic in main.js (near=1 up high — tuned look unchanged;
    // near→0.02 down low), so the camera may descend to a ~15 km-wide view.
    // Post-chain audit: fog/clouds/tilt-shift are depth-free; the optional
    // bokeh pass gets nearClip synced per-frame. Terrain collision clamp in
    // main.js keeps the camera out of the rock.
    // ZOOM-IN CAP (2026-07-18): locked to the tile-stream's z9 satellite level —
    // we don't currently need to dive closer than this, and z9 is the deepest LOD
    // (z10-z12 disabled in tileStreamManager). Raising minDistance from 0.08 to 2.3
    // stops the camera descending past the height where z9 imagery fills the view.
    // To re-enable deep dives later: restore this to ~0.08 and re-enable z10-z12.
    // 2.3 → 1.15 (2026-07-24): z10 is enabled again, and its showAlt is 2.3 — the
    // camera has to be able to descend BELOW that or the level can never activate.
    // 1.15 gives a real dive into z10 without pushing so close that z10 itself
    // starts being magnified. Lower further only alongside z11.
    // 1.15 → 0.60 → 0.35 (2026-07-25, z11 then z12). A level only becomes the
    // DOMINANT surface once effective altitude drops below showAlt - fadeBand:
    //     z11  1.30 - 0.35 = 0.95
    //     z12  0.70 - 0.22 = 0.48
    // This constant has silently capped every deep rung added so far — z10's showAlt
    // and the old minDistance were both 2.3, so z10 could never light at all. Check
    // it whenever a level is added: at 0.60, z12 would have reached only 45% opacity.
    // 0.35 clears z12 with headroom. There is no z13 to prepare for — the Ion origin
    // 404s at that level everywhere probed.
    controls.minDistance = 0.35;
    // Polar angle limits — prevent the two failure modes:
    //   minPolarAngle > 0  → can't go fully top-down (3D depth cues would vanish)
    //   maxPolarAngle < π/2 → can't dip to horizon (terrain occludes vessels at close zoom)
    // 1.35 rad ≈ 77° from vertical — allows dramatic tilt without sub-horizon viewing.
    // The FOV TACTICAL mode tightens this further to 1.20 for a more isometric feel.
    controls.minPolarAngle = 0.04;
    controls.maxPolarAngle = 1.35;
    controls.enablePan = true;
    controls.screenSpacePanning = false;
    controls.mouseButtons = {
        LEFT: THREE.MOUSE.PAN,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.ROTATE
    };
    controls.listenToKeyEvents(window);
    controls.keyPanSpeed = 25.0;

    controls.addEventListener('start', () => {
        stateRef.isFlyingToTarget = false;
        stateRef.isPanningToTerrain = false;
    });

    return controls;
}

export function addLights(scene) {
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(100, 200, 50);
    scene.add(dirLight);

    const backLight = new THREE.DirectionalLight(0x40c4ff, 0.5);
    backLight.position.set(-100, 50, -50);
    scene.add(backLight);

    return { ambientLight, dirLight, backLight };
}

export function initPostProcessing(renderer, scene, camera) {
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));

    const bloomPass = new UnrealBloomPass(
        new THREE.Vector2(viewport.width(), viewport.height()),
        BLOOM_STRENGTH_BASE, BLOOM_RADIUS, BLOOM_THRESHOLD
    );
    composer.addPass(bloomPass);

    // TiltShift + Bokeh are added LAST by main.js after fog/cloud passes,
    // so we build them here but do NOT add them to the composer yet.
    // main.js calls composer.addPass(vTiltShiftPass) etc. after atmosphere.
    const vTiltShiftPass = new ShaderPass(VerticalTiltShiftShader);
    const hTiltShiftPass = new ShaderPass(HorizontalTiltShiftShader);

    // bluriness reduced (3.0 → 1.2) and r widened (0.5 → 0.78) so the
    // entire map plane reads sharp; cinematic softening is reserved for
    // the outer edges where deep space / background sit.
    const bluriness = 1.2;
    vTiltShiftPass.uniforms.v.value = bluriness / viewport.height();
    hTiltShiftPass.uniforms.h.value = bluriness / viewport.width();
    vTiltShiftPass.uniforms.r.value = 0.78;
    hTiltShiftPass.uniforms.r.value = 0.78;

    // Depth-of-field — starts disabled; HUD toggle-optics enables it.
    // maxblur tightened slightly (0.004 → 0.003) so the interface layer
    // stays readable even when bokeh is user-enabled.
    const bokehPass = new BokehPass(scene, camera, {
        focus:    200.0,
        aperture: 0.00002,
        maxblur:  0.003,
    });
    bokehPass.enabled = false;

    // ssaoPass not available in this WebGL2 pipeline — expose null so
    // setupUI's optional guard handles it cleanly.
    const ssaoPass = null;

    // NOTE: vTiltShiftPass, hTiltShiftPass, bokehPass are intentionally NOT
    // added to composer here — main.js inserts them after fog/cloud passes
    // so the final render order is correct:
    //   RenderPass → Bloom → Fog → Clouds → TiltShift → Bokeh
    return { composer, bloomPass, bokehPass, ssaoPass, vTiltShiftPass, hTiltShiftPass };
}

// ── createSeaLevel() — REMOVED 2026-07-27 ────────────────────────────────────
// Deleted along with its last remaining child, a
// THREE.GridHelper(MAP_WIDTH, 60, 0x40c4ff, 0x004488) at y=0.05, opacity 0.11.
//
// EXPORTED BUT NEVER CALLED — nothing imported it, so the grid never rendered.
// (Do not confuse this with waterManager.createDynamicSeaLevel(), which builds
// the REAL 256×256 Gerstner ocean mesh and is the group actually named
// 'dynamicSeaLevel' in the scene. That one stays.)
//
// Removed on principle as well as hygiene: GridHelper is a THREE *debug* helper.
// Shipping one as scenery is the scaffolding becoming the aesthetic — and it was
// drawn in the same 0x40c4ff cyan that was retired from the UI chrome in the
// token sweep. This function was already the last survivor of a cleanup in
// progress: its own comments record a seaPlane and two PolarGridHelpers removed
// earlier for "concentric-circles-clutter". This finishes that job.

export function createBoardPlaneAndReticle(scene) {
    const boardPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(MAP_WIDTH, MAP_HEIGHT),
        new THREE.MeshBasicMaterial()
    );
    boardPlane.rotation.x = -Math.PI / 2;
    boardPlane.visible = false;  // Object3D-level hide — bloom pass respects this; material.visible does not
    scene.add(boardPlane);

    const reticleGeo = new THREE.RingGeometry(1.2, 1.8, 32);
    reticleGeo.rotateX(-Math.PI / 2);
    const reticleMat = new THREE.MeshBasicMaterial({
        color: 0x00ff88, transparent: true, opacity: 0.8, side: THREE.DoubleSide
    });
    const hoverReticle = new THREE.Mesh(reticleGeo, reticleMat);
    hoverReticle.visible = false;
    scene.add(hoverReticle);

    return { boardPlane, hoverReticle };
}

/**
 * Resize the render chain to the CURRENT MAP RECT.
 *
 * Named onWindowResize for history, but the window is no longer the trigger:
 * viewport.onChange() fires this for BOTH a real window resize AND a layout
 * change (selection dock opening / closing, cinematic mode), neither of which
 * the other emits. See main.js for the wiring.
 *
 * Cost note: composer.setSize() reallocates render targets for the whole chain
 * (Render → Bloom → Fog → Clouds → TiltShift×2 → Bokeh). viewport debounces so
 * this runs ONCE at the end of a layout transition rather than ~17× across it.
 */
export function onWindowResize(camera, renderer, composer, vTiltShiftPass, hTiltShiftPass) {
    const w = viewport.width();
    const h = viewport.height();

    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);

    if (vTiltShiftPass && hTiltShiftPass) {
        const bluriness = 1.2;
        vTiltShiftPass.uniforms.v.value = bluriness / h;
        hTiltShiftPass.uniforms.h.value = bluriness / w;
    }
}