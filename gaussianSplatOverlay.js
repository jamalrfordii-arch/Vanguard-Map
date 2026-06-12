// gaussianSplatOverlay.js — 3D Gaussian Splat overlays anchored to lat/lon
//
// Each overlay is a real-world 3DGS capture (.splat / .ply / .ksplat) pinned
// to a geographic coordinate on the Vanguard1 globe.  When the camera zooms
// close enough, the capture fades in and renders on top of the terrain using
// the DropInViewer from @mkkellogg/gaussian-splats-3d.
//
// ── How it works ─────────────────────────────────────────────────────────────
// DropInViewer extends THREE.Group and hooks into the existing Three.js render
// loop via onBeforeRender — no separate animation loop needed.  It depth-sorts
// the Gaussian splats every frame using the current camera position and renders
// them with alpha blending through the existing composer chain.
//
// ── Coordinate system ────────────────────────────────────────────────────────
// Vanguard1 scene: MAP_WIDTH = MAP_HEIGHT = 300 → 1 scene unit ≈ 133 km
// Typical 3DGS capture: 10–200 m radius in its own local frame
//
// Each capture is positioned at lonLatToXZ(lon, lat) + terrain elevation Y.
// The `sceneScale` parameter converts the capture's local metres to scene units:
//   sceneScale = desiredDiameterInSceneUnits / captureDiameterInMetres
//   e.g. a 100 m wide port terminal that should span ~0.3 scene units:
//        sceneScale = 0.3 / 100 = 0.003
//
// ── Where to get .splat files ────────────────────────────────────────────────
// 1. Luma AI  https://lumalabs.ai/captures
//    Search for "port", "harbor", "container terminal", "crane", etc.
//    Open a capture → Export → 3D Gaussian Splat (.splat) → save to splats/
//
// 2. Polycam  https://poly.cam/explore
//    Browse public captures → Download → Gaussian Splat
//
// 3. SuperSplat  https://superspl.at/editor
//    Upload a Luma .splat and optimize it → download as .ksplat (loads faster)
//
// 4. INRIA 3DGS datasets (academic, large):
//    https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/
//
// ── Usage ────────────────────────────────────────────────────────────────────
//   import { GaussianSplatOverlayManager } from './gaussianSplatOverlay.js';
//
//   const gsManager = new GaussianSplatOverlayManager(scene, camera, renderer);
//
//   gsManager.addOverlay({
//       name:        'Port of Rotterdam',
//       lat:          51.9226,
//       lon:           4.4792,
//       path:        './splats/rotterdam.splat',
//       sceneScale:    0.003,      // tune per capture — see above
//       yOffset:       0.5,        // lift above terrain surface (scene units)
//       rotation:    [0, 0, 0, 1], // quaternion [x,y,z,w] — tune per capture
//       showCamY:     25,          // start loading when cam Y < this
//       fullCamY:     10,          // fully visible when cam Y < this
//       showHorizDist: 8,          // and horiz distance < this (scene units)
//   });
//
//   // In animation loop:
//   gsManager.update(camera);

import * as THREE from 'three';
import * as GaussianSplats3D from './lib/gaussian-splats-3d.module.js';
import { MAP_WIDTH, MAP_HEIGHT } from './config.js';

const DEG2RAD = Math.PI / 180;

// ── Coordinate helpers ────────────────────────────────────────────────────────

function lonLatToXZ(lon, lat) {
    const x      = (lon / 180.0) * (MAP_WIDTH / 2.0);
    const latRad = lat * DEG2RAD;
    const mercY  = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
    const z      = -(mercY / Math.PI) * (MAP_HEIGHT / 2.0);
    return { x, z };
}

// ── Default overlay parameters ────────────────────────────────────────────────

const OVERLAY_DEFAULTS = {
    sceneScale:   0.003,      // scene units per metre of capture (tune per scene)
    yOffset:      0.5,        // scene units above terrain elevation
    rotation:     [0, 0, 0, 1], // identity quaternion
    showCamY:     25,
    fullCamY:     10,
    showHorizDist: 8,
    splatAlphaRemovalThreshold: 5,
};

// ── GaussianSplatOverlayManager ───────────────────────────────────────────────

export class GaussianSplatOverlayManager {
    /**
     * @param {THREE.Scene}    scene
     * @param {THREE.Camera}   camera   — Vanguard1's main camera
     * @param {THREE.Renderer} renderer — Vanguard1's WebGLRenderer
     */
    constructor(scene, camera, renderer) {
        this._scene    = scene;
        this._camera   = camera;
        this._renderer = renderer;
        this._overlays = [];  // array of OverlayEntry
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Register a 3DGS capture and pin it to a lat/lon.
     * The capture loads lazily when the camera gets close.
     *
     * @param {object} opts — see header comment for full parameter list
     */
    addOverlay(opts) {
        const cfg = { ...OVERLAY_DEFAULTS, ...opts };

        const { x: cx, z: cz } = lonLatToXZ(cfg.lon, cfg.lat);

        const entry = {
            cfg,
            cx, cz,
            viewer:    null,
            loaded:    false,
            loading:   false,
            visible:   false,
        };

        this._overlays.push(entry);
        return entry;
    }

    /**
     * Call every animation frame.
     * @param {THREE.Camera} camera
     */
    update(camera) {
        for (const entry of this._overlays) {
            const dx    = camera.position.x - entry.cx;
            const dz    = camera.position.z - entry.cz;
            const hDist = Math.sqrt(dx * dx + dz * dz);
            const camY  = camera.position.y;
            const { showCamY, showHorizDist } = entry.cfg;

            const inRange = camY < showCamY && hDist < showHorizDist;

            // Trigger lazy load on first close approach
            if (inRange && !entry.loaded && !entry.loading) {
                this._loadOverlay(entry);
            }

            // Show / hide based on range
            if (entry.viewer) {
                const shouldShow = inRange && entry.loaded;
                if (entry.viewer.visible !== shouldShow) {
                    entry.viewer.visible = shouldShow;
                    entry.visible        = shouldShow;
                }
            }
        }
    }

    dispose() {
        for (const entry of this._overlays) {
            if (entry.viewer) {
                this._scene.remove(entry.viewer);
                // DropInViewer disposes its own GPU resources
                entry.viewer.viewer?.dispose?.();
            }
        }
        this._overlays = [];
    }

    // ── Private: load ─────────────────────────────────────────────────────────

    async _loadOverlay(entry) {
        entry.loading = true;
        const { cfg, cx, cz } = entry;

        this._setStatus(`Loading ${cfg.name}…`);
        console.info(`[3DGS] Loading ${cfg.name} from ${cfg.path}`);

        try {
            // DropInViewer extends THREE.Group — can be added to any scene
            const viewer = new GaussianSplats3D.DropInViewer({
                gpuAcceleratedSort:          true,
                halfPrecisionCovariances:    true,   // saves GPU memory
                dynamicScene:                false,  // static capture
                logLevel:                    GaussianSplats3D.LogLevel.None,
            });

            // Position and scale the group at the geographic anchor point
            // Y = 0 puts base of capture at the scene origin for this XZ;
            // yOffset lifts it above the terrain splat layer.
            viewer.position.set(cx, cfg.yOffset, cz);
            viewer.scale.setScalar(cfg.sceneScale);

            // Apply per-capture rotation (compensates for orientation drift
            // during 3DGS training — tune the quaternion in addOverlay config)
            const q = cfg.rotation;
            viewer.quaternion.set(q[0], q[1], q[2], q[3]);

            viewer.visible = false;   // hidden until loaded
            this._scene.add(viewer);
            entry.viewer = viewer;

            // Load the splat scene — supports .splat, .ply (3DGS), .ksplat
            await viewer.addSplatScene(cfg.path, {
                showLoadingUI:               false,
                splatAlphaRemovalThreshold:  cfg.splatAlphaRemovalThreshold,
                progressiveLoad:             false,   // full load → better sort
            });

            entry.loaded  = true;
            entry.loading = false;
            this._setStatus('');
            console.info(`[3DGS] ${cfg.name} loaded ✓`);

        } catch (err) {
            entry.loading = false;
            entry.loaded  = true;   // don't retry
            this._setStatus('');
            console.warn(`[3DGS] ${cfg.name} failed to load:`, err.message);
            console.warn(`[3DGS] Make sure ${cfg.path} exists in your Vanguard1 folder.`);
            console.warn(`[3DGS] Get .splat files from https://lumalabs.ai/captures`);
        }
    }

    // ── HUD status ────────────────────────────────────────────────────────────
    _setStatus(msg) {
        const el = document.getElementById('gs-status');
        if (!el) return;
        el.textContent  = msg;
        el.style.opacity = msg ? '1' : '0';
    }
}

// ── Preset locations ──────────────────────────────────────────────────────────
// Pre-configured lat/lon anchors for high-value War Room targets.
// Add your .splat file to Vanguard1/splats/ with the matching filename,
// then pass one of these to gsManager.addOverlay().

export const SPLAT_LOCATIONS = {

    // ── Europe ──────────────────────────────────────────────────────────────
    PORT_ROTTERDAM: {
        name:        'Port of Rotterdam',
        lat:          51.9226,
        lon:           4.4792,
        path:        './splats/rotterdam.splat',
        sceneScale:    0.003,
        yOffset:       0.4,
        showCamY:     22,
        fullCamY:      8,
        showHorizDist: 7,
    },
    STRAIT_OF_DOVER: {
        name:        'Strait of Dover',
        lat:          51.12,
        lon:           1.43,
        path:        './splats/dover.splat',
        sceneScale:    0.005,
        yOffset:       0.3,
    },

    // ── Middle East ──────────────────────────────────────────────────────────
    STRAIT_HORMUZ: {
        name:        'Strait of Hormuz',
        lat:          26.58,
        lon:          56.25,
        path:        './splats/hormuz.splat',
        sceneScale:    0.005,
        yOffset:       0.3,
    },
    PORT_JEBEL_ALI: {
        name:        'Jebel Ali Port',
        lat:          25.01,
        lon:          55.06,
        path:        './splats/jebel_ali.splat',
        sceneScale:    0.003,
        yOffset:       0.4,
    },

    // ── Asia ─────────────────────────────────────────────────────────────────
    PORT_SINGAPORE: {
        name:        'Port of Singapore',
        lat:           1.265,
        lon:         103.82,
        path:        './splats/singapore_port.splat',
        sceneScale:    0.003,
        yOffset:       0.4,
    },
    STRAIT_MALACCA: {
        name:        'Strait of Malacca',
        lat:           2.5,
        lon:         101.5,
        path:        './splats/malacca.splat',
        sceneScale:    0.005,
        yOffset:       0.3,
    },

    // ── Pacific ──────────────────────────────────────────────────────────────
    PORT_LONG_BEACH: {
        name:        'Port of Long Beach',
        lat:          33.754,
        lon:        -118.216,
        path:        './splats/long_beach.splat',
        sceneScale:    0.003,
        yOffset:       0.4,
    },

    // ── Generic placeholder: swap any .splat in here for quick testing ───────
    CUSTOM: {
        name:        'Custom Capture',
        lat:           0,
        lon:           0,
        path:        './splats/custom.splat',
        sceneScale:    0.003,
        yOffset:       0.5,
        showCamY:     30,
        showHorizDist: 10,
    },
};
