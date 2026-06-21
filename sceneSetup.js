// sceneSetup.js — Renderer, camera, OrbitControls, lights, post-processing
import * as THREE from 'three';
import { quality } from './qualityManager.js';
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

    const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 1, 3000);
    camera.position.set(0, 250, 400);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    // Cap at 1.5 — on Retina / 4K screens devicePixelRatio = 2.0, which means
    // 4× the pixels to shade per frame.  1.5 cuts that by ~44% with imperceptible
    // quality loss at tactical-map viewing distances.
    // Pixel ratio is capped per quality tier (1.0 on low-end / mobile up to 2.0
    // on Ultra). The runtime monitor in main.js nudges it live from real FPS.
    renderer.setPixelRatio(quality.pixelCap());
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping         = THREE.ACESFilmicToneMapping;
    // ACES Filmic preserves colour saturation under bright light and gives the
    // cinematic contrast that Reinhard washes out.  ACES has a built-in S-curve
    // so exposure sits lower than Reinhard's 1.6 — 0.85 prevents snow-cap and
    // mountain highlights from clipping to white under the directional light.
    renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
    document.getElementById('canvas-container').appendChild(renderer.domElement);

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
    controls.maxDistance = 550;
    controls.minDistance = 15;
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
        new THREE.Vector2(window.innerWidth, window.innerHeight),
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
    vTiltShiftPass.uniforms.v.value = bluriness / window.innerHeight;
    hTiltShiftPass.uniforms.h.value = bluriness / window.innerWidth;
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

export function createSeaLevel(scene) {
    const seaLevelGroup = new THREE.Group();
    scene.add(seaLevelGroup);

    // seaPlane REMOVED. It was a flat MeshBasicMaterial PlaneGeometry at
    // Y=0.3 covering MAP_WIDTH × MAP_HEIGHT with color #004488 and opacity
    // 0.80 — a "seal" for coastal-transition geometry that produced the
    // same hard rectangular edge the aquarium walls and washPlane had. The
    // wave-shader seaMesh in waterManager.js (Y=-0.2, has Gerstner waves
    // AND a built-in edge fade) is the real water surface and stays.

    const seaGrid = new THREE.GridHelper(MAP_WIDTH, 60, 0x40c4ff, 0x004488);
    seaGrid.position.y = 0.05;
    seaGrid.material.opacity = 0.11;
    seaGrid.material.transparent = true;
    seaLevelGroup.add(seaGrid);

    // Second polar grid (at Y=-15, opacity 0.11) REMOVED alongside the
    // waterManager polar grid — same concentric-circles-clutter rationale.

    return seaLevelGroup;
}

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

export function onWindowResize(camera, renderer, composer, vTiltShiftPass, hTiltShiftPass) {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);

    if (vTiltShiftPass && hTiltShiftPass) {
        const bluriness = 1.2;
        vTiltShiftPass.uniforms.v.value = bluriness / window.innerHeight;
        hTiltShiftPass.uniforms.h.value = bluriness / window.innerWidth;
    }
}