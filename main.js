// main.js — Orchestrator: boots the app, owns the animation loop
import * as THREE from 'three';
import {
    MAP_WIDTH, MAP_HEIGHT,
    BLOOM_STRENGTH_BASE, BLOOM_THREAT_RANGE,
    AMBIENT_INTENSITY_BASE, AMBIENT_INTENSITY_BONUS,
    DIR_LIGHT_INTENSITY_MAX,
    CAMERA, FLIGHT, THREAT_INTENSITY, REGIONS, CLUSTER, INTEGRITY, FLIGHT_INTEGRITY, CONFLICT,
} from './config.js';
import { loadAllData } from './dataLoader.js';
import { mark as bootMark, report as bootReport } from './bootProfiler.js';   // measurement-only
import {
    initScene, initControls, addLights, initPostProcessing,
    createBoardPlaneAndReticle, onWindowResize
} from './sceneSetup.js';
import {
    initTerrainData, createHighFidelityPointCloud,
    createSolidOceanFloor, createCountryBorders,
    loadNormalMap, updatePointCloud, createOceanBasinLabels, getTrueElevation
} from './terrainBuilder.js';
import {
    createFlightObject, createAISVesselObject,
    createDarkVesselMarker, createVesselDot,
} from './entityBuilder.js';
import { PortManager } from './portManager.js';
import { ClusterManager } from './clusterManager.js';
import { integrityManager, setElevationFn as setIntegrityElevation } from './integrityManager.js';
import { flightIntegrityManager } from './flightIntegrityManager.js';
import { waveField } from './waveFieldManager.js';   // global sea-state data field (Phase A; lazy fetch)
import { WaveFieldLayer } from './waveFieldLayer.js'; // global sea-state heatmap + contour render layer
import { FlightManager, lonLatAltToScene } from './flightManager.js';
import { aircraftInstancer } from './aircraftInstancer.js';
import { shipInstancer } from './shipInstancer.js';
import {
    setupUI, setupSettingsPanel, setupSectorSearch,
    onMouseMove, onDoubleClick, onClick, tickRaycasting,
    tickVesselDetail, refreshShipList, refreshFlightList,
    applySearchFilter, tickSearchVisibility, tickAlertZone,
    showVesselDetail, hideVesselDetail, initIntegrityBoard, initDiscoveryConsole, initAltitudeWatch
} from './uiController.js';
import { AISManager, lonLatToScene } from './aisManager.js';
import { simClock } from './simClock.js';
import { quality } from './qualityManager.js';
import { SyntheticAISSource, RecordedAISSource, AISRecorder } from './dataSource.js';
import { initArchivePanel } from './archiveManager.js';
import { rfIntel, initRFIntelPanel } from './rfIntelManager.js';
import { initVesselTab } from './vesselTab.js';
import { initWatchlist } from './watchlist.js';
import { initAlertsManager } from './alertsManager.js';
import { initFeedManager } from './feedManager.js';
import { initAviationNewsManager } from './aviationNewsManager.js';
import { initSitrepManager } from './sitrepManager.js';
import { initSelectionRing } from './selectionRing.js';
import { DayNightManager } from './dayNightManager.js';
import { createDynamicSeaLevel, updateDynamicWater } from './waterManager.js';
import { GFSWindManager }  from './gfsWindManager.js';
import { BeaufortWarningManager } from './beaufortWarningManager.js';
import { GFSUpperWindManager } from './gfsUpperWindManager.js';
import { AltitudeDeckManager } from './altitudeDeckManager.js';
import { ConflictManager } from './conflictManager.js';
import { SkyManager }    from './skyManager.js';
import { FogManager }    from './fogManager.js';
import { TrailManager }  from './trailManager.js';
import { WakeManager } from './wakeManager.js';
import { CityManager } from './cityManager.js';
import { ContinentMesh } from './continentMesh.js';
import * as terrainHeight from './terrainHeightSampler.js';
import { AICopilot, CHOKEPOINTS } from './aiCopilot.js';
import { DiscoveryManager } from './discoveryManager.js';
import { ChokepointManager } from './chokepointManager.js';
import { NavLightManager } from './navLightManager.js';
import { TileStreamManager } from './tileStreamManager.js';
import { contextCards } from './contextCardManager.js';
import { BuildingManager } from './buildingManager.js';
import { TransitionManager } from './transitionManager.js';
import { SpaceWeatherManager }     from './spaceWeatherManager.js';
import { IonosphericLayerManager } from './ionosphericLayerManager.js';
import { BirkelandManager }       from './birkelandManager.js';
import { IBTrACSManager }         from './ibtracsManager.js';
import { GpsJammingManager }      from './gpsJammingManager.js';

// ── Global ship registry ──────────────────────────────────────────────────────
// Kept on window so uiController, clusterManager, etc. can reach it without
// a circular import.
window.aisShips = [];

// ── Mutable app state (single source of truth) ────────────────────────────────
const state = {
    presentationMode:  false,
    isFlyingToTarget:  false,
    isPanningToTerrain: false,
    lockedShip:        null,
    hoveredShip:       null,
    flightTargetPos:   new THREE.Vector3(),
    terrainTargetPos:  new THREE.Vector3(),
};

// ── Altitude → colour (yellow = low, white = cruise, cyan = high) ─────────────
const _altCol = new THREE.Color();
function getAltColor(altM) {
    if (altM < FLIGHT.ALT_LOW_MAX) {
        return _altCol.set(0xffcc00);
    } else if (altM < FLIGHT.ALT_MID_MAX) {
        const t = (altM - FLIGHT.ALT_LOW_MAX) / (FLIGHT.ALT_MID_MAX - FLIGHT.ALT_LOW_MAX);
        return _altCol.setRGB(1, 0.8 + 0.19 * t, t * 0.94);
    } else if (altM < FLIGHT.ALT_CRUISE_MAX) {
        return _altCol.set(0xdde8f0);
    } else {
        const t = Math.min(1, (altM - FLIGHT.ALT_CRUISE_MAX) / 4000);
        return _altCol.setRGB(0.25 + 0.62 * (1 - t), 0.78 + 0.09 * (1 - t), 1.0);
    }
}

// ── Pre-load performance profile ────────────────────────────────────────────
// Shown ONCE (first visit) before the heavy data load, so the chosen quality tier
// governs how much terrain/tile detail loads — the load-time decision that must be
// made up front. AUTO keeps the auto-detected tier; a manual pick is remembered.
// Changeable later in Settings (which prompts a reload, since it's load-time).
function choosePerformanceTier() {
    return new Promise(resolve => {
        const info = quality.info();
        const det  = quality.detected;
        let selTier = quality.auto ? 'AUTO' : quality.tier;   // pre-select last choice
        let selFps  = quality.fpsCap();
        const desc = {
            AUTO:   `Auto-detected: ${det}`,
            LOW:    'Fastest · least detail',
            MEDIUM: 'Balanced detail and speed',
            HIGH:   'High detail',
            ULTRA:  'Maximum detail',
        };
        const overlay = document.createElement('div');
        overlay.id = 'perf-prompt';
        overlay.style.cssText = `position:fixed; inset:0; z-index:300; background:rgba(1,5,11,0.97);
            display:flex; flex-direction:column; justify-content:center; align-items:center;
            font-family:'Courier New',Courier,monospace; color:#cfe3f1;`;
        const pill = (g, v, label) => `<button class="perf-pill" data-group="${g}" data-val="${v}">${label}</button>`;
        overlay.innerHTML = `
            <style>
              #perf-prompt .perf-pill{ background:rgba(2,12,22,0.9); border:1px solid rgba(64,196,255,0.35);
                color:#9fc0d8; padding:8px 14px; font-family:inherit; font-size:12px; letter-spacing:1px; cursor:pointer; }
              #perf-prompt .perf-pill.sel{ border-color:#40c4ff; color:#fff; background:rgba(64,196,255,0.18);
                box-shadow:0 0 12px rgba(64,196,255,0.25); }
              #perf-prompt .perf-group{ display:flex; gap:6px; flex-wrap:wrap; justify-content:center; max-width:400px; }
              #perf-prompt .perf-label{ color:#8aabc4; font-size:10px; letter-spacing:2px; margin:16px 0 6px; }
            </style>
            <div style="color:#fff; font-size:15px; letter-spacing:3px; font-weight:800;">PERFORMANCE PROFILE</div>
            <div style="color:#40c4ff; font-size:10px; letter-spacing:1px; margin-top:4px; opacity:0.85;">
                GPU: ${info.gpu || 'unknown'} · ${info.cores || '?'} cores${info.mobile ? ' · mobile' : ''}</div>
            <div class="perf-label">QUALITY TIER</div>
            <div class="perf-group">
                ${pill('tier','AUTO','AUTO')}${pill('tier','LOW','LOW')}${pill('tier','MEDIUM','MED')}${pill('tier','HIGH','HIGH')}${pill('tier','ULTRA','ULTRA')}
            </div>
            <div id="perf-tier-desc" style="color:#6b8298; font-size:10px; margin-top:6px; height:13px;">${desc[selTier]}</div>
            <div class="perf-label">FPS CAP</div>
            <div class="perf-group">
                ${pill('fps','0','Uncapped')}${pill('fps','30','30')}${pill('fps','60','60')}${pill('fps','120','120')}
            </div>
            <button id="perf-launch" style="margin-top:24px; background:#0a2740; border:1px solid #40c4ff; color:#fff;
                padding:10px 32px; font-family:inherit; font-size:13px; letter-spacing:3px; font-weight:800; cursor:pointer;">LAUNCH ▸</button>`;
        document.body.appendChild(overlay);
        const mark = (g, v) => overlay.querySelectorAll(`.perf-pill[data-group="${g}"]`)
            .forEach(x => x.classList.toggle('sel', x.dataset.val === String(v)));
        mark('tier', selTier); mark('fps', selFps);
        overlay.querySelectorAll('.perf-pill').forEach(b => b.addEventListener('click', () => {
            const g = b.dataset.group;
            if (g === 'tier') { selTier = b.dataset.val; const d = document.getElementById('perf-tier-desc'); if (d) d.textContent = desc[selTier]; }
            else selFps = parseInt(b.dataset.val, 10);
            mark(g, g === 'tier' ? selTier : selFps);
        }));
        overlay.querySelector('#perf-launch').addEventListener('click', () => {
            if (selTier === 'AUTO') quality.resetAuto(); else quality.setTier(selTier);
            quality.setFpsCap(selFps);
            overlay.remove();
            resolve();
        });
    });
}

// ── Boot sequence ─────────────────────────────────────────────────────────────
async function start() {
    try {
        bootMark('boot start');
        await choosePerformanceTier();   // user picks tier BEFORE the heavy load
        const mapData = await loadAllData(msg => {
            const el = document.getElementById('loading-screen');
            if (el) el.innerHTML +=
                `<div style="font-size:10px;color:var(--cyan);margin-top:10px;">${msg}</div>`;
        }, { zoom: quality.tileZoom(), skipGebco: quality.tier === 'LOW' });   // tier → tile res + LOW skips GEBCO
        bootMark('all data loaded');

        initTerrainData(mapData);
        bootMark('terrain data indexed');
        await init(mapData);
        bootMark('init() complete');
        bootReport();   // auto-dump the breakdown once the map is up
    } catch (e) {
        console.error('[VANGUARD] Boot failed:', e);
        const el = document.getElementById('loading-screen');
        if (el) el.innerHTML =
            `<div style="color:var(--red);font-size:14px;margin-top:20px;">RESOURCES BLOCKED</div>
             <div style="color:var(--cyan);font-size:10px;margin-top:8px;">${e.message}</div>`;
    }
}

// ── Main initialisation ───────────────────────────────────────────────────────
async function init(mapData) {
    // ── Scene fundamentals ────────────────────────────────────────────────────
    const { scene, clock, camera, renderer, isWebGPU } = await initScene();
    quality.attachRenderer(renderer);   // adaptive pixel ratio (runtime-tuned)
    console.info('[Quality] tier:', quality.tier, quality.auto ? '(auto)' : '(manual)');
    const controls = initControls(camera, renderer, state);
    window.controls = controls;   // expose for camera panel + any UI that needs orbit control
    window.camera   = camera;     // expose for layer click-to-inspect (IBTrACS, etc.)
    window.scene    = scene;      // expose for console debugging
    const { ambientLight, dirLight } = addLights(scene);

    // ── Selection ring ────────────────────────────────────────────────────────
    const selectionRing = initSelectionRing(scene);

    // ── Dead-reckoning visibility (prediction line + projected-point marker) ──
    // Added 2026-06-26. The line/marker themselves are built once per vessel in
    // entityBuilder.js (always exist, start hidden); this just decides who gets
    // to show theirs each moment. Default scope: selected vessel only. The
    // watchlist-mode toggle (WATCHLIST tab checkbox, watchlist.js) additionally
    // shows it for every watchlisted vessel regardless of selection.
    const LS_DR_WATCHLIST_MODE = 'vg1_dr_watchlist_mode';
    let _drWatchlistMode = (() => {
        try { return localStorage.getItem(LS_DR_WATCHLIST_MODE) === '1'; } catch { return false; }
    })();

    function _predictionEligible(obj) {
        if (!obj) return false;
        if (selectionRing.target === obj) return true;
        if (_drWatchlistMode && window.watchlist?.isWatched(String(obj.userData?.id))) return true;
        return false;
    }

    // Recomputes one vessel's prediction line + marker from its current
    // userData (speedKts/headingDeg) and live eligibility. Safe to call any
    // time — on AIS update, on selection change, on watchlist change.
    function _syncPredictionVisual(obj) {
        if (!obj) return;
        const ud   = obj.userData;
        const line = ud.predictionLine;
        if (!line) return;
        const marker = ud.predictionMarker;

        if (!_predictionEligible(obj) || ud.isDark) {
            line.visible = false;
            if (marker) marker.visible = false;
            return;
        }

        const speedKts = ud.speedKts ?? 0;
        const len = Math.min(speedKts * 0.12, 7);
        if (len > 0.15 && ud.headingDeg != null) {
            const hdgRad = ud.headingDeg * (Math.PI / 180);
            const dx = Math.sin(hdgRad) * len;
            const dz = -Math.cos(hdgRad) * len;
            const sp = obj.position;
            line.geometry.setFromPoints([
                new THREE.Vector3(sp.x, sp.y, sp.z),
                new THREE.Vector3(sp.x + dx, sp.y, sp.z + dz),
            ]);
            line.computeLineDistances();
            line.visible = true;
            if (marker) {
                marker.position.set(sp.x + dx, sp.y + 0.02, sp.z + dz);
                marker.visible = true;
            }
        } else {
            line.visible = false;
            if (marker) marker.visible = false;
        }
    }
    window._syncPredictionVisual = _syncPredictionVisual;

    // Re-syncs every live vessel — used when the watchlist-mode toggle flips,
    // since eligibility just changed for a whole set of vessels at once.
    function _syncAllPredictionVisuals() {
        window.aisShips.forEach(_syncPredictionVisual);
    }
    window._syncAllPredictionVisuals = _syncAllPredictionVisuals;

    window.addEventListener('vg1:drWatchlistModeChanged', e => {
        _drWatchlistMode = !!e.detail?.on;
        try { localStorage.setItem(LS_DR_WATCHLIST_MODE, _drWatchlistMode ? '1' : '0'); } catch {}
        _syncAllPredictionVisuals();
    });

    // Wrappers around selectionRing.select()/.clear() that also resync the
    // dead-reckoning line/marker for the outgoing and incoming selection —
    // selection changes happen between AIS polls, so the next onVesselUpdate
    // alone isn't fast enough to feel responsive.
    function _selectVesselRing(obj, color) {
        const prevTarget = selectionRing.target;
        selectionRing.select(obj, color);
        if (prevTarget && prevTarget !== obj) _syncPredictionVisual(prevTarget);
        _syncPredictionVisual(obj);
    }
    function _clearVesselRing() {
        const prevTarget = selectionRing.target;
        selectionRing.clear();
        if (prevTarget) _syncPredictionVisual(prevTarget);
    }
    window._selectVesselRing = _selectVesselRing;
    window._clearVesselRing  = _clearVesselRing;

    // ── Vessel card opener — single entry point for all code paths ────────────
    // Wraps uiController.showVesselDetail so the selection ring and watchlist
    // card state stay in sync whether the card is opened from the Vanguard Panel
    // or by clicking directly on a vessel in the 3D scene.
    window._openVesselDetail = (obj) => {
        showVesselDetail(obj, camera, controls, state);
        const mmsi = String(obj?.userData?.id || '');
        if (!mmsi) return;

        // Ring — only for vessels currently in the live AIS feed
        if (aisManager.vessels.has(mmsi)) {
            const ringColor = window.watchlist?.isWatched(mmsi)
                ? selectionRing.COLOR_WATCHLIST
                : selectionRing.COLOR_DEFAULT;
            _selectVesselRing(obj, ringColor);
        }

        // Watchlist card state — always update, even if vessel dropped off live feed.
        // A watchlisted vessel that went dark must still be removable.
        window.watchlist?.onCardOpen(mmsi);
    };

    // ── Post-processing ───────────────────────────────────────────────────────
    const { composer, ssaoPass, bloomPass, bokehPass, vTiltShiftPass, hTiltShiftPass } =
        initPostProcessing(renderer, scene, camera, isWebGPU);

    // ── Water / sea level ─────────────────────────────────────────────────────
    const seaLevelGroup = createDynamicSeaLevel(scene);

    // ── Hit planes + reticle ──────────────────────────────────────────────────
    const { boardPlane, hoverReticle } = createBoardPlaneAndReticle(scene);

    // ── Terrain layers ────────────────────────────────────────────────────────
    const splatCloud     = createHighFidelityPointCloud(scene);
    bootMark('point cloud built', { tier: quality.tier });
    // Expose for live shader tuning from DevTools console:
    //   window.splatCloud.material.uniforms.uBiomeStrength.value = 0.5
    //   window.splatCloud.material.uniforms.uHemiStrength.value  = 0.0
    window.splatCloud = splatCloud;

    // ── MeshLab radiance map — baked ridge curvature from Poisson mesh ────────
    // Loaded async so terrain renders immediately; the glow upgrades silently
    // when the texture arrives.  Falls back gracefully if file is absent.
    new THREE.TextureLoader().load(
        './terrain_radiance_baked.png',
        (tex) => {
            tex.colorSpace      = THREE.NoColorSpace;
            tex.wrapS           = THREE.ClampToEdgeWrapping;
            tex.wrapT           = THREE.ClampToEdgeWrapping;
            tex.minFilter       = THREE.LinearFilter;
            tex.magFilter       = THREE.LinearFilter;
            tex.generateMipmaps = false;
            splatCloud.material.uniforms.uRadianceMap.value  = tex;
            splatCloud.material.uniforms.uUseRadiance.value  = 1.0;
            splatCloud.material.needsUpdate = true;
            console.info('[RadianceMap] terrain_radiance_baked.png loaded — MeshLab ridge glow active');
        },
        undefined,
        () => {
            console.info('[RadianceMap] terrain_radiance_baked.png not found — using runtime Sobel ridge');
        }
    );

    const { oceanFloorMesh, aquariumWalls } = createSolidOceanFloor(scene);
    const bordersGroup      = createCountryBorders(scene, mapData.worldBordersGeoJSON);
    createOceanBasinLabels(scene);

    // ── Lane / entity group ───────────────────────────────────────────────────
    const laneGroup = new THREE.Group();
    laneGroup.name  = 'laneGroup';
    scene.add(laneGroup);

    // Route prediction lines (AIS vessels)
    const predGroup = new THREE.Group();
    predGroup.name  = 'predGroup';
    scene.add(predGroup);

    // ── Port markers (Phases 1–4 LOD system) ─────────────────────────────────
    const portManager      = new PortManager(scene);
    const portMarkersGroup = portManager.group;   // backward-compat ref for setupUI
    window.portManager     = portManager;         // console access

    // ── Day / night overlay ───────────────────────────────────────────────────
    const dayNightManager = new DayNightManager(scene);

    // Calm starfield backdrop — frames the board in quiet space.
    const { StarManager } = await import('./starManager.js');
    const starField = new StarManager(scene);
    window.starField = starField;

    // ── Sky (sun direction math, bloom colour) ────────────────────────────────
    const skyManager = new SkyManager(scene, renderer);

    // ── GPU trail ring-buffer ─────────────────────────────────────────────────
    const trailManager = new TrailManager(scene);
    window.trailManager = trailManager;   // expose for uiController timeline read-back

    // ── Cluster LOD ───────────────────────────────────────────────────────────
    const clusterManager = new ClusterManager(scene);

    // ── Transition orchestrator (Plan 02) ─────────────────────────────────────
    // Manages vignette, tilted zoom-out, and staggered cluster bloom.
    const transitionMgr = new TransitionManager(camera);
    transitionMgr.setClusterManager(clusterManager);
    transitionMgr.init();                       // binds #vessel-vignette DOM element
    window.transitionMgr = transitionMgr;       // exposed for uiController calls

    // ── Weather — live global GFS wind field (Open-Meteo / NOAA NCEP) ─────────
    // Animated particle streams driven by a real 5° gridded wind forecast.
    // Replaces the legacy wttr.in-backed WeatherManager and the procedural
    // GlobalWeatherLayer hurricane sim; both have been removed.
    const gfsWindManager = new GFSWindManager(scene);
    window.gfsWindManager = gfsWindManager;

    // Beaufort wind-warning contour layer — shares the GFS wind field.
    const beaufortWarnings = new BeaufortWarningManager(scene);
    beaufortWarnings.setWindSource(gfsWindManager);
    beaufortWarnings.initInteraction(camera, renderer);   // hover + pin cards
    window.vg1Warnings = beaufortWarnings;
    // Rebuild periodically while visible (wind refreshes every 6 h; cheap resample)
    setInterval(() => { if (beaufortWarnings.group.visible) beaufortWarnings.rebuild(); }, 180000);

    // Global sea-state field — significant wave height heatmap + contours.
    // Lazy: fetches Open-Meteo Marine on first enable, repaints as data streams in.
    const waveFieldLayer = new WaveFieldLayer(scene);
    waveFieldLayer.setElevationFn(getTrueElevation);   // GEBCO-backed land/ocean mask
    window.vg1WaveLayer = waveFieldLayer;

    // ── Upper-air wind (850mb low-level + 250mb jet stream) ──────────────────
    // Gives the scene actual vertical extent. Surface wind sits at Y=8,
    // 850mb at Y=22, jet stream at Y=65. Tilt the camera to see the
    // atmosphere as a stacked 3D volume.
    const gfsUpperWindManager = new GFSUpperWindManager(scene);
    window.gfsUpperWindManager = gfsUpperWindManager;

    // ── Altitude decks — flight-level reference grid ──────────────────────────
    // A small wireframe grid patch at real-world flight levels (FL180/FL290/
    // FL410), anchored under whichever aircraft is currently selected/clicked,
    // hidden the rest of the time. A full-map variant (toggled via a
    // layerManager.js layer) was tried and removed 2026-06-27 — at the zoom
    // level needed to see the whole map, the ~12-scene-unit spread between
    // flight levels is visually negligible (controls.maxDistance is 550), so
    // aircraft just looked like they were floating at one indistinct height
    // regardless of deck. Per-aircraft patches anchor the grid right where
    // you're already looking, which sidesteps that problem entirely; see the
    // Altitude Watch panel for the cross-aircraft picture full-map mode was
    // trying (and failing) to give.
    const altitudeDeckManager = new AltitudeDeckManager(scene);
    window.altitudeDeckManager = altitudeDeckManager;

    // ── Aerial conflict / proximity detection — TCAS-style CPA check across
    // every live aircraft pair. See conflictManager.js header for the math;
    // wiring (evaluate() timer + updateVisuals() per frame + alert hookup) is
    // further down, near the other live-data ticks.
    const conflictManager = new ConflictManager(scene);
    window.conflictManager = conflictManager;
    // Keep the legacy global name so any console scripts / settings panel
    // built against `window.weatherManager` continue to work — the new manager
    // exposes the same setVisible / setKey / isConnected / getStormData API.
    window.weatherManager = gfsWindManager;

    // ── IBTrACS — last 30 days of global tropical cyclones ───────────────────
    // Covers Atlantic, all Pacific basins, Indian, S. Hemisphere. Replaces
    // the previous NHC-only layer (NHC only covers Atlantic + E. Pacific and
    // only when storms are active; IBTrACS shows every recorded basin).
    const ibtracsManager = new IBTrACSManager(scene);
    window.ibtracsManager = ibtracsManager;

    // ── GPS jamming zones (OSINT) ─────────────────────────────────────────────
    const gpsJammingManager = new GpsJammingManager(scene);
    window.gpsJammingManager = gpsJammingManager;


    // ── Space weather data authority ──────────────────────────────────────────
    // Single source of truth for all NOAA SWPC real-time data: Kp, AE, solar
    // wind speed/density/pressure, and IMF Bz. Both managers receive the same
    // shared uniform objects — mutated in-place each 15-min poll, zero alloc.
    // Fires window 'vg1:spaceWeather' CustomEvent after every fetch cycle;
    // the HUD telemetry strip listens to keep the UI in sync.
    const spaceWeather = new SpaceWeatherManager();

    // ── Ionospheric / geomagnetic field panes — HIDDEN pending redesign ──────
    const ionosphericLayers = new IonosphericLayerManager(scene, spaceWeather);
    const birkelandLayers   = new BirkelandManager(scene, spaceWeather);
    ionosphericLayers.setVisible(false);
    birkelandLayers.setVisible(false);

    // Atmosphere passes REMOVED. The full-screen fog post-process pass was
    // ray-marching every pixel (including sky and void around the map) and
    // visually interrupted analyst readability. The map now reads as a clean
    // diorama in space — no atmospheric haze obscuring data. fogManager.js
    // is left in the codebase for reference but no longer instantiated.

    // Finalise pass order — tilt-shift lens blur then depth-of-field last
    composer.addPass(vTiltShiftPass);
    composer.addPass(hTiltShiftPass);
    composer.addPass(bokehPass);

    // ── Wake / wash ───────────────────────────────────────────────────────────
    const wakeManager = new WakeManager(scene);

    // ── Normal map (optional high-res terrain shading) ───────────────────────
    // Generated once by running tools/generate_normals.py.  If the file is
    // absent, loadNormalMap() resolves to null and both systems fall back to
    // smooth vertex normals — no visual regression, just less fine detail.
    // Skipped on LOW: it's a 17 MB blocking download, and LOW trades fine shading
    // for fast load (graceful null fallback to smooth normals).
    const normalMapTex = quality.tier === 'LOW' ? null : await loadNormalMap('./terrain_normals.png');
    bootMark(quality.tier === 'LOW' ? 'normal map skipped (LOW)' : 'normal map loaded (BLOCKING)');

    // ── Global continent terrain mesh — satellite + geographic 3D character ──
    // Built in continentWorker.js off-thread; fades in at continent zoom
    const continentMesh = new ContinentMesh(scene, mapData, normalMapTex);
    bootMark('continent mesh dispatched');
    // Phase 2 hybrid: continent mesh stays invisible (its render is disabled
    // in continentMesh.js) but its elevation data is exposed via the height
    // sampler so any entity manager can clamp its Y to real terrain.
    terrainHeight.init(continentMesh);
    window.terrainHeight = terrainHeight;

    // ── City system — glows, labels, instanced buildings ─────────────────────
    const cityManager = new CityManager(scene, normalMapTex);

    // Expose mode toggle globally — call from UI or console:
    //   window.setMapMode('military')   ← amber/cyan tactical palette
    //   window.setMapMode('business')   ← gold/white executive palette
    window.setMapMode = (mode) => cityManager.setMode(mode);

    // ── Nav lights (running lights on vessels) ────────────────────────────────
    const navLightManager = new NavLightManager(scene);

    // ── AI Co-Pilot ───────────────────────────────────────────────────────────
    const aiCopilot = new AICopilot();
    // Expose so the copilot-panel inline script can call requestSitrep()
    window.aiCopilot = aiCopilot;

    // ── AI Discovery — cross-domain pattern-finding, separate budget/cadence
    // from the per-event copilot above. Reads aiCopilot's event stream for
    // per-vessel narrative memory; acts back on the scene only through the
    // existing vg1:selectVessel bus event (see discoveryManager.js header).
    const discoveryManager = new DiscoveryManager();
    discoveryManager.bindCopilot(aiCopilot);
    window.vg1Discovery = discoveryManager; // console: vg1Discovery.stats

    // ── AIS live vessel manager ───────────────────────────────────────────────
    const aisManager = new AISManager();

    // One-time: harvests each ship class's parts from entityBuilder.js and
    // builds the shared InstancedMesh set. Must happen before any vessel
    // spawn. See shipInstancer.js header comment for the full rationale —
    // same pattern as aircraftInstancer.init() below.
    shipInstancer.init(scene);

    // AIS Integrity — evaluate every report (reuses the invariant violations) and
    // run the periodic loiter/decay pass. Both are cheap; see integrityManager.js.
    setIntegrityElevation(getTrueElevation);   // inject real terrain sampler
    aisManager.onPositionEvaluated = (vessel, violations, ctx) =>
        integrityManager.evaluate(vessel, violations, ctx);
    setInterval(() => integrityManager.tick(), INTEGRITY.TICK_MS);
    setInterval(() => flightIntegrityManager.tick(), FLIGHT_INTEGRITY.TICK_MS);

    // Aerial conflict detection — O(n²) CPA pairwise check, run on its own
    // timer (not every frame; see conflictManager.js). evaluate() returns
    // only the pairs that just became active so we fire one alert per
    // conflict, not one per tick for as long as it stays flagged.
    setInterval(() => {
        const newPairs = conflictManager.evaluate([...flightManager.aircraft.values()]);
        for (const rec of newPairs) {
            const labelA = rec.callsignA || rec.a;
            const labelB = rec.callsignB || rec.b;
            window.alertsManager?.addAlert({
                type: 'AIRCRAFT_CONFLICT', mmsi: rec.a, vesselName: labelA,
                message: `${labelA} / ${labelB} — CPA ${rec.horizontalNm.toFixed(1)}nm / ${Math.round(rec.verticalFt)}ft in ${Math.round(rec.etaSec)}s`,
            });
        }
    }, CONFLICT.TICK_MS);

    // Ship type arrived via the static message → rebuild the vessel with its real
    // class (correct hull shape + colour) instead of the grey OTHER placeholder.
    // Reuses the tested teardown + create paths; runs at most once per vessel.
    aisManager.onVesselReclassify = (mmsi, vesselData) => {
        aisManager.onVesselRemove(mmsi);
        aisManager.onVesselNew(mmsi, vesselData);
    };

    aisManager.onVesselNew = (mmsi, vesselData) => {
        const obj = createAISVesselObject(vesselData, scene, laneGroup, predGroup);
        vesselData.threeObject = obj;
        window.aisShips.push(obj);

        // Snap to current lat/lon. Vessels are ALWAYS at sea level relative
        // to the SPLAT SURFACE — which has Earth-curvature applied (see
        // terrainWorker.js: curveY = -dist² × 20). The water plane is flat
        // at Y=-0.2 but everything visible (land splats, ocean splats) is
        // pulled DOWN with this curvature. Without applying the same offset
        // to vessels, they float above the splat at off-center latitudes.
        // At the North Sea (dist≈0.2) that's ~0.8 units of unwanted lift.
        const sp = lonLatToScene(vesselData.lonDeg, vesselData.latDeg);
        const dN = Math.sqrt((sp.x / MAP_WIDTH) ** 2 + (sp.z / MAP_HEIGHT) ** 2);
        const curveY = -(dN * dN) * 20.0;
        sp.y = curveY;
        obj.position.set(sp.x, sp.y, sp.z);

        // Reserves this vessel an instanced-rendering slot for its class.
        // The hull/bridge/etc. is drawn entirely by shipInstancer.js's
        // shared InstancedMesh set; this writes the initial transform so
        // there's no one-frame flash at the origin (slots start zero-scaled).
        obj.userData.instanceHandle = shipInstancer.spawn(vesselData.class);
        shipInstancer.update(obj.userData.instanceHandle, obj.position, obj.visible);

        // Shadow sits just above the curved splat so it reads as touching
        // the water rather than the flat water plane below it.
        if (obj.userData.shadowSprite) {
            obj.userData.shadowSprite.position.set(sp.x, curveY + 0.04, sp.z);
        }

        // Seed all live userData fields so the detail panel is fully populated
        // on first click, even before the first onVesselUpdate fires.
        obj.userData.latDeg      = vesselData.latDeg;
        obj.userData.lonDeg      = vesselData.lonDeg;
        obj.userData.headingDeg  = vesselData.headingDeg;
        obj.userData.country     = vesselData.country;
        obj.userData.destination = vesselData.destination;
        obj.userData.eta         = vesselData.eta;
        obj.userData.imo         = vesselData.imo;

        // Seed position log with first known position
        if (vesselData.latDeg != null && vesselData.lonDeg != null) {
            const nowMs = Date.now();
            obj.userData.posLog      = [{ lat: vesselData.latDeg, lon: vesselData.lonDeg, ts: nowMs }];
            obj.userData.posLogLastMs = nowMs;
        }

        trailManager.register(obj, obj.userData.htmlColor ?? '#00ffcc');

        // Small dot beneath vessel — shows at close zoom. Reuse the curved
        // sp from above so the dot sits on the same surface as the ship.
        const dot0 = createVesselDot(sp, laneGroup);
        obj.userData.vesselDot = dot0;

        // Apply active filter to newly arrived vessel
        window._reapplyVesselFilter?.();
    };

    aisManager.onVesselUpdate = (mmsi, vesselData) => {
        const obj = vesselData.threeObject;
        if (!obj) return;

        // Sea level with Earth-curvature offset — see comment in onVesselNew.
        const sp = lonLatToScene(vesselData.lonDeg, vesselData.latDeg);
        const dN = Math.sqrt((sp.x / MAP_WIDTH) ** 2 + (sp.z / MAP_HEIGHT) ** 2);
        const curveY = -(dN * dN) * 20.0;
        sp.y = curveY;
        obj.position.set(sp.x, sp.y, sp.z);

        // Keep the shadow disc tracking the vessel on the curved splat surface.
        if (obj.userData.shadowSprite) {
            obj.userData.shadowSprite.position.set(sp.x, curveY + 0.04, sp.z);
        }

        // Fixed sideways profile — all vessel figures face east so the hull
        // length is always visible to the viewer rather than bow-on or stern-on.
        // (shipInstancer.js bakes this same fixed orientation into its shared
        // quaternion — this line is now a harmless no-op on the anchor itself,
        // kept so obj.rotation still reads correctly if anything inspects it.)
        obj.rotation.y = Math.PI / 2;

        // Writes the fresh position into this vessel's instanced hull slot.
        // The per-frame sync loop below also calls this every frame (to catch
        // clusterManager/filter visibility changes that don't go through
        // onVesselUpdate), so this call just avoids a one-frame lag on
        // position when a fresh AIS report lands.
        shipInstancer.update(obj.userData.instanceHandle, obj.position, obj.visible);

        // Push trail sample
        trailManager.pushPosition(obj, sp.x, sp.y, sp.z);

        // Sync live userData fields
        obj.userData.latDeg      = vesselData.latDeg;
        obj.userData.lonDeg      = vesselData.lonDeg;
        obj.userData.speedKts    = vesselData.speedKts;
        obj.userData.headingDeg  = vesselData.headingDeg;
        obj.userData.country     = vesselData.country;
        obj.userData.destination  = vesselData.destination;
        obj.userData.eta          = vesselData.eta;
        obj.userData.imo          = vesselData.imo;

        // ── Dead-reckoning line + projected-point marker ─────────────────────
        // Geometry/visibility recomputed from the fresh position + userData
        // above. Eligibility (selected vessel, or watchlisted vessel when
        // watchlist-mode is on) is decided inside _syncPredictionVisual —
        // see definition near initSelectionRing().
        _syncPredictionVisual(obj);

        // Plan 04 — throttled position log: record every 30 min, cap at 48 entries (24 h)
        if (vesselData.latDeg != null && vesselData.lonDeg != null) {
            const nowMs = Date.now();
            const LOG_INTERVAL_MS = 30 * 60 * 1000;
            if (nowMs - (obj.userData.posLogLastMs ?? 0) >= LOG_INTERVAL_MS) {
                const log = obj.userData.posLog ?? [];
                log.push({ lat: vesselData.latDeg, lon: vesselData.lonDeg, ts: nowMs });
                if (log.length > 48) log.shift();
                obj.userData.posLog      = log;
                obj.userData.posLogLastMs = nowMs;
            }
        }

        // Sync dot position with vessel — dot sits at waterline (sp.y +
        // tiny epsilon to avoid water-plane z-fighting), so the hull rises
        // above it and the dot reads as a halo UNDER the ship.
        if (obj.userData.vesselDot) {
            obj.userData.vesselDot.position.set(sp.x, sp.y + 0.02, sp.z);
        }
    };

    aisManager.onVesselRemove = (mmsi) => {
        integrityManager.remove(mmsi);
        const idx = window.aisShips.findIndex(s => s.userData.id === mmsi);
        if (idx === -1) return;
        const obj = window.aisShips[idx];
        trailManager.unregister(obj);
        // Releases this vessel's instanced-rendering slot — without this an
        // unused slot would sit degenerate-scaled forever (leaked) instead
        // of being recycled by the next spawn() of this class.
        shipInstancer.free(obj.userData.instanceHandle);
        // Remove ground shadow sibling
        if (obj.userData.shadowSprite) {
            laneGroup.remove(obj.userData.shadowSprite);
            obj.userData.shadowSprite.material.dispose();
            obj.userData.shadowSprite = null;
        }
        // Remove vessel dot
        if (obj.userData.vesselDot) {
            laneGroup.remove(obj.userData.vesselDot);
            obj.userData.vesselDot = null;
        }
        // Remove anomaly ring sibling
        if (obj.userData.anomalyRing) {
            laneGroup.remove(obj.userData.anomalyRing);
            if (obj.userData.anomalyRingMat) obj.userData.anomalyRingMat.dispose();
            obj.userData.anomalyRing = null;
        }
        // Remove sonar-ping ring sibling
        if (obj.userData.pingRing) {
            laneGroup.remove(obj.userData.pingRing);
            if (obj.userData.pingRingMat) obj.userData.pingRingMat.dispose();
            obj.userData.pingRing = null;
        }
        if (obj.userData.integrityRing) {
            laneGroup.remove(obj.userData.integrityRing);
            if (obj.userData.integrityRingMat) obj.userData.integrityRingMat.dispose();
            obj.userData.integrityRing = null;
        }
        laneGroup.remove(obj);
        scene.remove(obj);
        window.aisShips.splice(idx, 1);
    };

    aisManager.onVesselDark = (mmsi, vesselData) => {
        integrityManager.markDark(mmsi);          // dark = analytical signal (integrity penalty + SUSPECT ring)
        // Dark-vessel "laser beam" markers REMOVED (2026-06-17) — visual clutter
        // (hundreds of pink beams). The vessel stays visible and the dark state is
        // surfaced via the integrity engine (board / watchlist / violet ring) instead.
        const obj = vesselData.threeObject;
        if (obj) {
            obj.userData.darkMarker  = null;
            obj.userData.isDark      = true;
            obj.userData.darkSinceMs = vesselData.darkSince ?? Date.now();
        }
    };

    aisManager.onVesselReappear = (mmsi, vesselData) => {
        integrityManager.markReappear(mmsi);
        const obj = vesselData.threeObject;
        if (!obj) return;
        if (obj.userData.darkMarker) {
            laneGroup.remove(obj.userData.darkMarker);
            obj.userData.darkMarker = null;
        }
        obj.userData.isDark      = false;
        obj.userData.darkSinceMs = null;
        obj.visible = true;

        // Recreate green dot when vessel reappears
        const sp2 = lonLatToScene(vesselData.lonDeg, vesselData.latDeg);
        if (!obj.userData.vesselDot) {
            obj.userData.vesselDot = createVesselDot(sp2, laneGroup);
        }
    };

    // ── Flight live manager ───────────────────────────────────────────────────
    const flightManager = new FlightManager();

    // One-time: harvests each aircraft class's parts from entityBuilder.js and
    // builds the shared InstancedMesh set. Must happen before any aircraft
    // spawn. See aircraftInstancer.js header comment for the full rationale.
    aircraftInstancer.init(scene);

    // Every parsed ADS-B state, new or existing, before scene mutation —
    // see flightIntegrityManager.js (trust scoring, sibling of integrityManager
    // for AIS). Cheap, local, no fetch — runs on every poll for every aircraft.
    flightManager.onPositionEvaluated = (report) => flightIntegrityManager.evaluate(report);

    // Tracks which aircraft currently have an active EMERGENCY flag so the
    // alert fires once on onset, not every frame the flag stays set (the
    // ring/alert split mirrors the AIS DARK_VESSEL/REAPPEAR pattern: an
    // alert is an event, not a continuous state). Cleared when the flag
    // drops (cancelled squawk) or the aircraft is removed/landed.
    const emergencyAlerted = new Set();

    // Shared per-aircraft Three.js cleanup — used by reclassification (old
    // object), onAircraftLanded, and onAircraftRemove, so the emergency
    // ring doesn't have to be remembered/disposed in three separate places.
    function _disposeFlightObject(obj) {
        trailManager.unregister(obj);
        laneGroup.remove(obj);
        aircraftInstancer.free(obj.userData.instanceHandle);
        if (obj.userData.altitudeGlow) {
            laneGroup.remove(obj.userData.altitudeGlow);
            obj.userData.altitudeGlow.material.dispose();
        }
        if (obj.userData.emergencyRing) {
            laneGroup.remove(obj.userData.emergencyRing);
            obj.userData.emergencyRingMat.dispose();
        }
    }

    flightManager.onAircraftNew = (icao24, data) => {
        const obj = createFlightObject(data, scene, laneGroup);
        data.threeObject = obj;
        window.aisShips.push(obj);

        const sp = lonLatAltToScene(data.lonDeg, data.latDeg, data.altMeters);
        obj.position.set(sp.x, sp.y, sp.z);

        // Reserves this aircraft an instanced-rendering slot for its class.
        // The per-frame sync loop below writes the actual transform every
        // frame; this initial update avoids a one-frame flash at the origin
        // (instancer slots start zero-scaled/invisible until first written).
        obj.userData.instanceHandle = aircraftInstancer.spawn(data.aircraftClass);
        aircraftInstancer.update(obj.userData.instanceHandle, obj.position, obj.visible,
            data.currentHeadingDeg, data.bankDeg, data.pitchDeg, data.spawnEase);

        // Registered invisible — with hundreds/thousands of live aircraft,
        // drawing every contrail at once is unreadable clutter (the long
        // streaks seen across the ocean at zoomed-out views). Position
        // history still accumulates silently; the trail is revealed only for
        // whichever aircraft is currently selected, synced once per frame
        // below in the animation loop.
        const col = getAltColor(data.altMeters ?? 0);
        trailManager.register(obj, `#${col.getHexString()}`, false);
        // Altitude glow is a sibling sprite in laneGroup (not a child of
        // obj — obj's own scale would shrink it), so position is seeded
        // here and kept in sync every frame in the animation loop below.
        if (obj.userData.altitudeGlow) {
            obj.userData.altitudeGlow.material.color.copy(col);
            obj.userData.altitudeGlow.position.set(sp.x, sp.y, sp.z);
        }
    };

    flightManager.onAircraftUpdate = (icao24, data) => {
        let obj = data.threeObject;
        if (!obj) return;

        // Re-classification — the first ADS-B report for an aircraft often
        // lacks category/dbFlags (MLAT-derived or partial decode), so it gets
        // classified COMMERCIAL by default; a later poll can reveal it's
        // actually MILITARY/CARGO/etc. flightManager.js already re-runs
        // classifyAircraft() on every update, but the 3D model is normally
        // built once at creation — without this check the wrong shape/color
        // would stick forever. Only fires on an actual class change, so the
        // rebuild cost is paid rarely, not on every poll.
        if (obj.userData.class !== data.aircraftClass) {
            // Releases the old instanced-rendering slot, trail, altitude
            // glow, and emergency ring — see _disposeFlightObject above.
            _disposeFlightObject(obj);
            const idx = window.aisShips.indexOf(obj);
            if (idx !== -1) window.aisShips.splice(idx, 1);

            obj = createFlightObject(data, scene, laneGroup);
            data.threeObject = obj;
            window.aisShips.push(obj);
            obj.userData.instanceHandle = aircraftInstancer.spawn(data.aircraftClass);
            aircraftInstancer.update(obj.userData.instanceHandle, obj.position, obj.visible,
                data.currentHeadingDeg, data.bankDeg, data.pitchDeg, data.spawnEase);

            const col = getAltColor(data.altMeters ?? 0);
            // Registers hidden, same as onAircraftNew — this rebuilds a fresh
            // Object3D, so even if this aircraft was the selected one, the
            // per-frame lockedShip sync below will catch the new object on
            // the very next frame and re-show its trail (rare edge case:
            // reclassification happening on the one currently-selected aircraft).
            trailManager.register(obj, `#${col.getHexString()}`, false);
            if (obj.userData.altitudeGlow) obj.userData.altitudeGlow.material.color.copy(col);
        }

        const sp = lonLatAltToScene(data.lonDeg, data.latDeg, data.altMeters);
        // Position is NOT set here anymore — flightManager.tick()'s
        // currentPos (lerp toward this poll's target, then dead-reckoning
        // extrapolation from speed/heading) drives obj.position every frame
        // in the animation loop. Snapping straight to sp here would fight
        // that lerp: the object would jump to the new report immediately,
        // then the per-frame sync would yank it back toward the
        // still-in-progress currentPos, producing a visible stutter.

        // obj.rotation is NOT used for the visible airframe — the instanced
        // mesh's orientation is driven entirely by aircraftInstancer.update()'s
        // headingDeg/bankDeg/pitchDeg args (see flightManager.js tick()).
        // Aircraft used to be locked to a fixed east-facing yaw here for
        // silhouette readability; per Jamal's call (2026-06-26) they now yaw
        // to real heading with bank/pitch layered on top. obj.rotation itself
        // is left at identity since nothing reads it for aircraft anymore.

        // Altitude glow colour — only needs to change when altitude changes,
        // which happens at most once per poll. The glow is a sibling sprite
        // (not a child of obj), so its position is kept in sync separately
        // every frame in the animation loop, alongside obj.position.
        if (obj.userData.altitudeGlow) {
            obj.userData.altitudeGlow.material.color.copy(getAltColor(data.altMeters ?? 0));
            // MLAT/ADS-B can flip poll-to-poll (e.g. an aircraft moves into
            // ground-receiver range and gets a direct fix again) — re-apply
            // the fuzzy/dim-vs-tight/bright look set at creation in
            // entityBuilder.js rather than letting it stick to whichever
            // source the aircraft started on.
            if (obj.userData.positionSource !== data.positionSource) {
                obj.userData.positionSource = data.positionSource;
                const isMlat = data.positionSource === 'MLAT';
                obj.userData.altitudeGlow.material.opacity = isMlat ? 0.16 : 0.28;
                const s = isMlat ? 1.6 : 1.1;
                obj.userData.altitudeGlow.scale.set(s, s, 1);
            }
        }

        trailManager.pushPosition(obj, sp.x, sp.y, sp.z);

        // Sync userData
        obj.userData.latDeg    = data.latDeg;
        obj.userData.lonDeg    = data.lonDeg;
        obj.userData.altMeters = data.altMeters;
        obj.userData.speedKts  = data.speedKts;
        obj.userData.headingDeg = data.headingDeg;
        // verticalRateMs (climb/descent, m/s) — flightManager.js computes this
        // from the altitude delta since the last poll (see _handleData). Mirrored
        // into userData so other modules (Altitude Watch panel, uiController.js)
        // can read it off window.aisShips without needing a flightManager
        // reference of their own — same pattern as every other aircraft field here.
        obj.userData.verticalRateMs = data.verticalRateMs;
        // Registration/type/operator are effectively static per-aircraft, but
        // cheap to re-sync every poll since flightManager.js may decode them
        // late (a registration/type field arriving on a later report than the
        // first one seen) — same reasoning as the re-classification check above.
        obj.userData.registration = data.registration;
        obj.userData.typeCode     = data.typeCode;
        obj.userData.operator     = data.operator;
    };

    flightManager.onAircraftRemove = (icao24) => {
        // This path only fires after FLIGHT.STALE_MS of total silence with
        // no ground report ever seen — flightManager.js now intercepts
        // explicit landings separately (onAircraftLanded below), so by the
        // time we get here it's a genuine "the transponder/feed went dark
        // mid-flight" event, not a normal landing.
        flightIntegrityManager.markDark(icao24); // analytical signal, not a verdict
        emergencyAlerted.delete(icao24);
        const idx = window.aisShips.findIndex(s => s.userData.id === icao24);
        if (idx === -1) return;
        const obj = window.aisShips[idx];
        const callsign = obj.userData.displayName || icao24;
        window.alertsManager?.addAlert({
            type: 'AIRCRAFT_LOST_SIGNAL', mmsi: icao24, vesselName: callsign,
            message: `${callsign} signal lost mid-flight (no ground report)`,
        });
        _disposeFlightObject(obj);
        window.aisShips.splice(idx, 1);
    };

    // Fires when the feed explicitly reports the aircraft on the ground —
    // a real landing, not silence. Kept separate from onAircraftRemove so a
    // routine landing doesn't get logged/scored identically to losing the
    // signal mid-flight (see flightManager.js onAircraftLanded comment).
    flightManager.onAircraftLanded = (icao24, data) => {
        flightIntegrityManager.remove(icao24); // landed cleanly — no DARK penalty, just drop the record
        emergencyAlerted.delete(icao24);
        const idx = window.aisShips.findIndex(s => s.userData.id === icao24);
        if (idx === -1) return;
        const obj = window.aisShips[idx];
        const callsign = obj.userData.displayName || icao24;
        window.alertsManager?.addAlert({
            type: 'AIRCRAFT_LANDED', mmsi: icao24, vesselName: callsign,
            message: `${callsign} landed`,
        });
        _disposeFlightObject(obj);
        window.aisShips.splice(idx, 1);
    };

    // Bind managers to AI copilot (must happen after both are constructed)
    aiCopilot.bindAISManager(aisManager);
    aiCopilot.bindFlightManager(flightManager);

    // ── Vessel tab roster ─────────────────────────────────────────────────────
    initVesselTab(aisManager);

    // ── Watchlist — must run after initVesselTab so AIS callbacks are already wrapped
    initWatchlist(aisManager);

    // ── Alerts — must run after aiCopilot is constructed and bound to AIS
    initAlertsManager(aiCopilot, aisManager, discoveryManager);

    // ── Discovery console — live terminal log of every AI Discovery pass
    initDiscoveryConsole(discoveryManager);

    // ── Feed — RSS aggregation, two-section layout, tag/search filtering
    initFeedManager();

    // ── SITREP — situation report: auto-generated brief + analyst log
    initSitrepManager();

    // ── vg1:selectVessel — fired by vessel/watchlist tab row click ───────────
    // Single-click: pan camera to vessel + show selection ring.
    // Double-click: same + open stats card (openCard: true).
    // Camera pan requires live position data; card open does NOT — a watchlisted
    // vessel that dropped off the live feed can still have its card opened.
    window.addEventListener('vg1:selectVessel', e => {
        const { mmsi, openCard = false } = e.detail;
        const vessel = aisManager.vessels.get(String(mmsi));

        // Pan camera only when we have a valid live position
        if (vessel && vessel.latDeg != null) {
            const sp = lonLatToScene(vessel.lonDeg, vessel.latDeg);
            state.terrainTargetPos.set(sp.x, 0, sp.z);
            state.isPanningToTerrain = true;
            state.isFlyingToTarget   = false; // preserve camera height
        }

        // Always try to find the 3D object — even if vessel dropped off live feed
        // the Three.js mesh may still be in the scene (not yet GC'd)
        const obj = window.aisShips.find(s => String(s.userData.id) === String(mmsi));
        if (obj) {
            const ringColor = window.watchlist?.isWatched(mmsi)
                ? selectionRing.COLOR_WATCHLIST
                : selectionRing.COLOR_DEFAULT;
            _selectVesselRing(obj, ringColor);
        }

        // Stats card — only on double-click (openCard: true).
        // Works even without a live position; needs only the 3D object.
        if (openCard) {
            // Primary: found the Three.js object in the active ship list
            if (obj) {
                window._openVesselDetail(obj);
            } else {
                // Secondary: aisShips.find missed — check threeObject reference directly
                const liveVessel = aisManager.vessels.get(String(mmsi));
                const threeObj   = liveVessel?.threeObject;

                if (threeObj) {
                    // Real Three.js object found via vessel registry — use it
                    window._openVesselDetail(threeObj);
                } else {
                    // Tertiary: vessel not in 3D scene at all (dropped off or offline)
                    // Build richest possible synthetic from live data + name cache
                    const cachedName = window.watchlist?.getCachedName(mmsi) || mmsi;
                    const synthetic = {
                        userData: {
                            id:          mmsi,
                            displayName: liveVessel?.name && liveVessel.name !== 'UNKNOWN'
                                            ? liveVessel.name : cachedName,
                            class:       liveVessel?.class       || null,
                            speedKts:    liveVessel?.speedKts    ?? null,
                            headingDeg:  liveVessel?.headingDeg  ?? null,
                            latDeg:      liveVessel?.latDeg      ?? null,
                            lonDeg:      liveVessel?.lonDeg      ?? null,
                            country:     liveVessel?.country     || null,
                            destination: liveVessel?.destination || null,
                            eta:         liveVessel?.eta         || null,
                            isRealAIS:   !!liveVessel,
                        }
                    };
                    showVesselDetail(synthetic, camera, controls, state);
                    window.watchlist?.onCardOpen(mmsi);
                }
            }
        }
    });

    // ── Watchlist add/remove → update ring colour while vessel is selected ────
    window.addEventListener('vg1:watchlistChanged', e => {
        if (selectionRing.target) {
            const selectedMmsi = String(selectionRing.target.userData?.id || '');
            if (selectedMmsi === String(e.detail.mmsi)) {
                const color = e.detail.type === 'add'
                    ? selectionRing.COLOR_WATCHLIST
                    : selectionRing.COLOR_DEFAULT;
                selectionRing.setColor(color);
            }
        }

        // Dead-reckoning eligibility for this vessel just changed (added to or
        // removed from the watchlist) — resync its line/marker if it has a
        // live 3D object, regardless of whether it's currently selected.
        const changedObj = window.aisShips.find(s => String(s.userData.id) === String(e.detail.mmsi));
        if (changedObj) _syncPredictionVisual(changedObj);
    });

    // ── Clear ring + card when vessel detail close button is clicked ──────────
    document.getElementById('vd-close')?.addEventListener('click', () => {
        hideVesselDetail();
        _clearVesselRing();
    });

    // ── Start async data streams ───────────────────────────────────────────────
    // Promise.resolve() wraps both sync and async inits uniformly so .catch()
    // is always valid even when init() has no explicit return value.
    Promise.resolve(aisManager.init()).catch(e => console.warn('[AIS] init failed:', e.message));
    Promise.resolve(flightManager.init()).catch(e => console.warn('[Flights] init failed:', e.message));

    // ── SimClock + DataSource console API ─────────────────────────────────────
    // Scenario / replay / record controls, usable from DevTools (and later from
    // a HUD time-control panel). Live behavior is untouched until used.
    //   vg1Scenario.load('./scenarios/hormuz-demo.json')  — inject synthetic traffic
    //   vg1Scenario.record() / .save()                    — capture live AIS → NDJSON
    //   vg1Scenario.replay('./captures/x.ndjson')         — scrub clock + replay capture
    //   vg1Scenario.stopAll()                             — detach all non-live sources
    //   simClock.setTime(...) / setRate(...) / pause() / goLive()
    const aisRecorder = new AISRecorder();

    // ── RF Intelligence domain (Phase 1) ──────────────────────────────────────
    // RF INTEL feed panel. (Distress-beacon visuals + detector removed.)
    initRFIntelPanel({
        flyTo: (lat, lon) => {
            const p = lonLatToScene(lon, lat);
            controls.target.set(p.x, 0, p.z);
            camera.position.set(p.x, 38, p.z + 26);
            controls.update();
        }
    });
    // AIS Integrity triage board — same fly-to pattern as the RF panel.
    initIntegrityBoard({
        flyTo: (lat, lon) => {
            const p = lonLatToScene(lon, lat);
            controls.target.set(p.x, 0, p.z);
            camera.position.set(p.x, 38, p.z + 26);
            controls.update();
        }
    });
    // Altitude Watch — replaces the removed full-map altitude-deck grid.
    // Same fly-to pattern as Integrity/RF; reads window.aisShips on its own
    // 2s interval, no flightManager reference needed.
    initAltitudeWatch({
        flyTo: (lat, lon) => {
            const p = lonLatToScene(lon, lat);
            controls.target.set(p.x, 0, p.z);
            camera.position.set(p.x, 38, p.z + 26);
            controls.update();
        }
    });
    // Aviation news feed inside the same panel — task #13. Independent init,
    // independent poll loop (see aviationNewsManager.js) — no shared state
    // with the occupancy/transitions render loop above.
    initAviationNewsManager();

    const _recTap = aisRecorder.tap();
    aisManager.onRawMessage = (msg) => { _recTap(msg); };

    window.vg1Scenario = {
        async load(urlOrObj) {
            const scenario = typeof urlOrObj === 'string'
                ? await (await fetch(urlOrObj)).json()
                : urlOrObj;
            const src = new SyntheticAISSource(scenario);
            aisManager.attachSource(src);
            console.log(`[Scenario] "${scenario.name || 'unnamed'}" running — ${scenario.entities?.length ?? 0} entities`);
            return src;
        },
        async replay(url, { scrub = true } = {}) {
            const src = await RecordedAISSource.fromURL(url);
            if (scrub && src.firstTimestamp() != null) simClock.setTime(src.firstTimestamp());
            aisManager.attachSource(src);
            console.log(`[Scenario] replaying ${url} — ${src._records.length} records`);
            return src;
        },
        record() { aisRecorder.clear(); aisRecorder.start(); console.log('[Scenario] recording live AIS...'); },
        save(filename) { aisRecorder.stop(); aisRecorder.download(filename); },
        recorder: aisRecorder,
        stopAll() { aisManager.detachAllSources(); simClock.goLive(); console.log('[Scenario] all sources detached, clock live'); },
    };

    // Archive panel — session recorder: AIS stream + camera path, with
    // POV replay (mutes live feed, clears world, re-flies the camera).
    initArchivePanel({ aisManager, recorder: aisRecorder, camera, controls });

    // Demo mode (key prompt's "VIEW DEMO" button) — synthetic traffic, no key.
    window.addEventListener('vg1:demoMode', () => {
        window.vg1Scenario.load('./scenarios/hormuz-demo.json')
            .then(() => console.log('[Demo] Synthetic scenario running — Strait of Hormuz'))
            .catch(e => console.warn('[Demo] scenario load failed:', e.message));
    });

    // ── UI wiring ─────────────────────────────────────────────────────────────
    const tooltipEl = document.getElementById('tactical-tooltip');
    const raycaster = new THREE.Raycaster();
    // Initialize off-screen so tickRaycasting doesn't snap to a vessel at screen
    // center (NDC 0,0) before the user has moved their mouse — that was causing
    // the first click (e.g. the AIS key modal "CONNECT" button) to auto-lock
    // and fly the camera to whichever ship happened to be near the center.
    const mouse     = new THREE.Vector2(-9999, -9999);

    setupUI({
        splatCloud, laneGroup, seaLevelGroup: seaLevelGroup, oceanFloorMesh, aquariumWalls,
        bordersGroup, portMarkersGroup,
        ssaoPass, bloomPass, bokehPass,
        camera, controls,
        stateRef:       state,
        aisShipsRef:    window.aisShips,
        scene,
        dayNightManager,
        predGroup,
    });

    // ── Context card: chokepoint trigger via AI copilot event stream ──────────
    // Any event the copilot emits with a populated chokepoint field means a
    // vessel just triggered the proximity rule — that's the right moment to
    // explain what chokepoints are to a first-time user.
    aiCopilot.onEvent(evt => {
        if (evt.claudeContext?.chokepoint) contextCards.show('CHOKEPOINT');
    });

    // ── Copilot stream → HUD renderer ────────────────────────────────────────
    // All copilot events (anomalies, dark vessels, SITREPs) flow through the
    // global window.vanguardCopilotEvent handler defined in index.html.
    aiCopilot.onEvent(evt => window.vanguardCopilotEvent?.(evt));

    // Discovery findings use the SAME stream/handler — one feed, one place to
    // look, regardless of which layer (per-event vs cross-domain) produced it.
    discoveryManager.onEvent(evt => window.vanguardCopilotEvent?.(evt));

    // ── Input events ──────────────────────────────────────────────────────────
    const inputDeps = {
        mouse, raycaster, camera, controls,
        boardPlane, hoverReticle, tooltipEl,
        aisShips: window.aisShips,
        stateRef: state,
        // Getter so onClick / onDoubleClick can check interaction state
        hasInteracted: () => _userHasInteracted,
    };

    // ── User-interaction gate ─────────────────────────────────────────────────
    // Blocks all programmatic camera flying (lockedShip follow, isFlyingToTarget)
    // until the user has touched the map at least once.  Prevents any live AIS
    // event or startup condition from auto-zooming to a vessel on load.
    let _userHasInteracted = false;
    const _markInteracted = () => { _userHasInteracted = true; };
    window.addEventListener('pointerdown', _markInteracted, { once: true });
    window.addEventListener('wheel',       _markInteracted, { once: true });
    window.addEventListener('keydown',     _markInteracted, { once: true });

    window.addEventListener('resize',    () => { onWindowResize(camera, renderer, composer); waveFieldLayer.onResize(window.innerWidth, window.innerHeight); });
    window.addEventListener('mousemove', e => onMouseMove(e, inputDeps), false);

    // ── Click / dblclick on the CANVAS only ──────────────────────────────────
    // Listening on `renderer.domElement` rather than `window` ensures that clicks
    // on overlaid HTML elements (AIS modal, weather panel, HUD controls, etc.)
    // do NOT bubble through here and accidentally trigger vessel locking.
    //
    // Drag suppression: record the pointer-down position and compare it against
    // the click position.  If the pointer moved more than 6 px the user was
    // panning the map — suppress the click so it doesn't accidentally open the
    // 3D view or lock a vessel at the end of a pan gesture.
    let _pdX = 0, _pdY = 0;
    renderer.domElement.addEventListener('pointerdown', e => {
        _pdX = e.clientX;
        _pdY = e.clientY;
    }, false);

    renderer.domElement.addEventListener('click', e => {
        const moved = Math.hypot(e.clientX - _pdX, e.clientY - _pdY);
        if (moved > 6) return;   // was a drag/pan — ignore

        // ── Port label click check — runs before vessel click ─────────────────
        // portManager.checkClick uses screen-space proximity identical to hover.
        // If a port is clicked, show the port panel and stop propagation.
        const clickedPort = portManager.checkClick(inputDeps.mouse, camera);
        if (clickedPort) {
            _showPortPanel(clickedPort, camera, controls, state);
            return;
        }

        onClick(e, inputDeps);
    }, false);
    renderer.domElement.addEventListener('dblclick',  e => onDoubleClick(e, inputDeps), false);


    // ── Settings panel ────────────────────────────────────────────────────────
    setupSettingsPanel(gfsWindManager);

    // ── Sector search command palette ─────────────────────────────────────────
    setupSectorSearch(camera, controls, state);

    // ── Sprint 3 layer toggle wiring ──────────────────────────────────────────
    window.addEventListener('layerToggle', e => {
        const { layer, on } = e.detail;
        switch (layer) {
            case 'weather':      gfsWindManager.setVisible(on);      break;
            case 'wind-warnings': beaufortWarnings.setVisible(on);  break;
            case 'wind-low':     gfsUpperWindManager.setLowVisible(on); break;
            case 'wind-jet':     gfsUpperWindManager.setJetVisible(on); break;
            case 'sea-state':    waveFieldLayer.setVisible(on);       break;  // global wave-height field
            case 'storm-history': ibtracsManager.setVisible(on);     break;
            case 'gps-jamming':  gpsJammingManager.setVisible(on);   break;
            case 'fog':          window.vg1_fog_enabled   = on;       break;
            case 'ais-vessels':
                // Master switch for the vessel layer: hides/show all AIS vessels, their
                // dots/rings/trails, AND the cluster glyphs — so the map can show only
                // other features. Aircraft (aviation layer) are unaffected.
                window._aisLayerOff = !on;
                clusterManager.setShipsEnabled(on);
                if (window._reapplyVesselFilter) window._reapplyVesselFilter();
                // Chokepoint glyphs are vessel-density markers → hide them with the vessel layer.
                if (window.chokepointManager) window.chokepointManager.setVisible(on);
                break;
        }
    });

    // ── Vessel class filter ────────────────────────────────────────────────────
    // The clickable class-button bar (ALL/CARGO/TANKER/PASSENGER/FISHING/DARK)
    // was removed from the UI per Jamal's request (2026-06-27) — this block now
    // only keeps _applyVesselFilter/_reapplyVesselFilter alive, fixed at 'ALL',
    // because the ais-vessels layer toggle above still calls
    // window._reapplyVesselFilter to re-sync dark-vessel/dot/trail visibility
    // whenever that layer is switched on/off.
    {
        let _activeFilter = 'ALL';

        function _applyVesselFilter(filter) {
            window.aisShips.forEach(ship => {
                const ud     = ship.userData;
                const isDark = ud.isDark === true;

                // Does this vessel pass the current filter?
                let passes;
                if (filter === 'ALL')        passes = true;
                else if (filter === 'DARK')  passes = isDark;
                else                         passes = (ud.class === filter) && !isDark;

                // Master AIS-vessels layer switch — forces all vessels hidden when off
                // (aircraft, isRealAIS=false, are unaffected and keep their own layer).
                if (window._aisLayerOff && ud.isRealAIS) passes = false;

                // Persistent flag — the per-frame dot/visibility loops honor this
                // so the filter isn't stomped each frame by clustering/dot logic.
                ud._classHidden = !passes;

                // Dark vessels: main 3D object is ALWAYS hidden (model invisible);
                // only the dark marker dot/ring shows. Never set ship.visible = true
                // for a dark vessel — that would show a floating model at stale coords.
                if (isDark) {
                    ship.visible = false;
                    if (ud.darkMarker) ud.darkMarker.visible = passes;
                } else {
                    ship.visible = passes;
                    if (ud.vesselDot) ud.vesselDot.visible = passes;
                }

                // Trail always follows the same visibility as the vessel
                if (ud.trail) ud.trail.visible = passes;
            });

            // Dead-reckoning line/marker: independent of the class filter, EXCEPT
            // a filtered-out vessel shouldn't show its line even if selected —
            // re-sync everyone so _classHidden (just updated above) takes effect.
            window.aisShips.forEach(ship => {
                if (ship.userData._classHidden) {
                    if (ship.userData.predictionLine)   ship.userData.predictionLine.visible = false;
                    if (ship.userData.predictionMarker) ship.userData.predictionMarker.visible = false;
                } else {
                    window._syncPredictionVisual?.(ship);
                }
            });
        }

        // Re-apply filter when new vessels arrive so they respect current state
        window._reapplyVesselFilter = () => _applyVesselFilter(_activeFilter);
    }

    // ── Ionospheric layer toggle wiring — DISABLED pending redesign ──────────
    // UI controls removed from Central System panel; layers kept in scene but
    // invisible. Restore here when ionosphericLayerManager is rebuilt.
    /*
    {
        const _ioToggle = (id, fn) => {
            const el = document.getElementById(id);
            if (el) el.onchange = e => fn(e.target.checked);
        };
        _ioToggle('toggle-magnetic-field',   v => {
            ionosphericLayers.setVisible(v);
            birkelandLayers.setVisible(v);
        });
        _ioToggle('toggle-iono-d',           v => ionosphericLayers.setPaneVisible('iono-d', v));
        _ioToggle('toggle-iono-e',           v => ionosphericLayers.setPaneVisible('iono-e', v));
        _ioToggle('toggle-iono-f1',          v => ionosphericLayers.setPaneVisible('iono-f1', v));
        _ioToggle('toggle-iono-f2',          v => ionosphericLayers.setPaneVisible('iono-f2', v));
        _ioToggle('toggle-van-allen-inner',  v => ionosphericLayers.setPaneVisible('van-allen-inner', v));
        _ioToggle('toggle-van-allen-outer',  v => ionosphericLayers.setPaneVisible('van-allen-outer', v));
        window.addEventListener('layerToggle', e => {
            if (e.detail.layer === 'magnetic-field') {
                ionosphericLayers.setVisible(e.detail.on);
                birkelandLayers.setVisible(e.detail.on);
                const cb = document.getElementById('toggle-magnetic-field');
                if (cb) cb.checked = e.detail.on;
            }
        });
    }
    */

    // ── Chokepoint landmark system ────────────────────────────────────────────
    // 3D rings + name labels + live vessel counts at all 11 strategic chokepoints.
    // Reactive coloring: cyan (normal) → amber (4+ vessels) → red (8+ vessels).
    const chokepointManager = new ChokepointManager(scene, CHOKEPOINTS);
    // Expose hit meshes so uiController.onClick can detect chokepoint clicks.
    window.chokepointHitMeshes = chokepointManager.getHitMeshes();
    window.chokepointManager   = chokepointManager;   // console access

    // ── Tile-streaming LOD terrain ────────────────────────────────────────────
    const tileStreamManager = new TileStreamManager(scene);
    tileStreamManager.enabled = true;        // multi-level LOD: zoom 6 @ y<200, zoom 8 @ y<120, zoom 10 @ y<50
    window.tileStream = tileStreamManager;   // console access

    // ── 3D building extrusion (OSM, tier-1 cities) ────────────────────────────
    const buildingManager = new BuildingManager(scene);
    window.buildings = buildingManager;

    // ── Hide loading screen ───────────────────────────────────────────────────
    const loadEl = document.getElementById('loading-screen');
    if (loadEl) loadEl.style.display = 'none';

    // ── Splat shader uniforms (shorthand) ─────────────────────────────────────
    const splatUniforms = splatCloud.material.uniforms;

    // ── Dynamic status board ──────────────────────────────────────────────────
    // Updates "ON-SCREEN ASSETS" every 500 ms using a THREE.Frustum cull of
    // window.aisShips. Adds `.scanning` to .hud-panel while camera is moving.
    // NOTE: Threat level logic removed — threat strip was placeholder content
    // with no real data source. Will be replaced by the Alerts system.
    {
        const _frustum        = new THREE.Frustum();
        const _projScreen     = new THREE.Matrix4();
        const _lastCamPos     = new THREE.Vector3().copy(camera.position);
        const _nodeCountEl    = document.getElementById('node-count');
        const _hudEl          = document.querySelector('.hud-panel');
        let   _statusLastMs   = 0;
        let   _scanClearTimer = null;

        // Scratch vector for NDC projection — reused each tick to avoid GC
        const _ndcScratch = new THREE.Vector3();

        function _tickDynamicStatus(nowMs) {
            if (nowMs - _statusLastMs < 500) return;
            _statusLastMs = nowMs;

            // ── Camera movement → scanning pulse ─────────────────────────────
            const moved = _lastCamPos.distanceTo(camera.position) > 0.05;
            _lastCamPos.copy(camera.position);

            if (moved) {
                if (_hudEl && !_hudEl.classList.contains('scanning')) {
                    _hudEl.classList.add('scanning');
                }
                if (_scanClearTimer) { clearTimeout(_scanClearTimer); _scanClearTimer = null; }
                _scanClearTimer = setTimeout(() => {
                    if (_hudEl) _hudEl.classList.remove('scanning');
                    _scanClearTimer = null;
                }, 1800);
            }

            // ── NDC projection cull — count visible entities ──────────────────
            // Uses screen-space NDC projection rather than frustum.containsPoint()
            // because ships live inside named Groups whose local position != world
            // position when the group has a transform. NDC projection always uses
            // the correct world matrix regardless of scene graph depth.
            camera.updateMatrixWorld();

            let total = 0;
            const ships = window.aisShips;
            for (let i = 0, n = ships.length; i < n; i++) {
                if (!ships[i].visible) continue;
                _ndcScratch.setFromMatrixPosition(ships[i].matrixWorld);
                _ndcScratch.project(camera);
                // In front of camera (z ≤ 1) and within NDC viewport [-1, 1]
                if (_ndcScratch.z <= 1 &&
                    _ndcScratch.x >= -1 && _ndcScratch.x <= 1 &&
                    _ndcScratch.y >= -1 && _ndcScratch.y <= 1) {
                    total++;
                }
            }

            if (_nodeCountEl) _nodeCountEl.textContent = total;
        }

        window._tickDynamicStatus = _tickDynamicStatus;
    }

    // ── FOV mode system ───────────────────────────────────────────────────────
    // Three presets trading perspective distortion for tactical accuracy.
    //   CINEMATIC (55°) — wide, immersive, foreground-heavy distortion
    //   BALANCED  (35°) — current default, good all-round
    //   TACTICAL  (18°) — tight, near-orthographic, minimal distortion;
    //                     also tightens maxPolarAngle for a more isometric feel
    const FOV_PRESETS = CAMERA.FOV_PRESETS;
    let _fovIdx    = CAMERA.FOV_DEFAULT_IDX;
    let _targetFOV = camera.fov;  // inherit camera's current FOV (35)

    window._cycleFOVMode = function() {
        _fovIdx = (_fovIdx + 1) % FOV_PRESETS.length;
        const mode = FOV_PRESETS[_fovIdx];
        _targetFOV             = mode.fov;
        controls.maxPolarAngle = mode.maxPolar;

        const btn = document.getElementById('btn-fov');
        if (btn) {
            btn.textContent = mode.key;
            btn.title       = `Camera projection: ${mode.label}`;
            btn.classList.toggle('active', mode.key !== 'BAL');
        }
    };

    // ── Threat-level intensity system ────────────────────────────────────────
    // Smoothly drives bloom strength + vignette overlay opacity from the live
    // threat level so the scene literally darkens and glows when things escalate.
    //   LOW      → intensity 0.00 — bloom 0.25, vignette transparent
    //   MODERATE → intensity 0.18 — bloom 0.28, very faint red ring
    //   ELEVATED → intensity 0.50 — bloom 0.40, visible vignette pulse
    //   CRITICAL → intensity 1.00 — bloom 0.55, strong red vignette
    const _INTENSITY_MAP = THREAT_INTENSITY;
    window._targetThreatIntensity  = 0;
    let   _currentThreatIntensity  = 0;
    const _vignetteEl = document.getElementById('threat-vignette');

    // Feed the intensity target from _tickDynamicStatus each 500 ms cycle.
    // We do this by reading the threat-strip data-level attribute, which is
    // already maintained by _tickDynamicStatus — no additional DOM writes needed.
    function _syncThreatIntensity() {
        const stripEl = document.getElementById('threat-strip');
        const level   = stripEl?.dataset.level ?? 'LOW';
        window._targetThreatIntensity = _INTENSITY_MAP[level] ?? 0;
    }
    // Expose so _tickDynamicStatus can call it after updating the strip
    window._syncThreatIntensity = _syncThreatIntensity;

    // ── Off-screen anomaly edge indicators ────────────────────────────────────
    // When a notable entity (dark, hostile, flagged) is off-screen, a small
    // colored arrow appears at the viewport edge pointing toward it.
    // We maintain a registry of { ship, color } pairs fed by aiCopilot events.
    const _edgeTargets = new Map(); // mmsi/id → { ship, color, label }
    let   _edgeLastMs  = 0;

    // Pool of pre-allocated arrow elements (created once, reused each frame)
    const _edgeContainer = document.getElementById('edge-indicators');
    const _edgeArrows    = [];
    if (_edgeContainer) {
        for (let i = 0; i < 18; i++) {
            const el    = document.createElement('div');
            el.className = 'edge-arrow';
            const tri   = document.createElement('div');
            tri.className = 'ea-tri';
            const lbl   = document.createElement('span');
            lbl.className = 'ea-label';
            el.appendChild(tri);
            el.appendChild(lbl);
            _edgeContainer.appendChild(el);
            _edgeArrows.push({ el, tri, lbl });
        }
    }

    // Listen to aiCopilot events — register notable entities
    aiCopilot.onEvent(evt => {
        let mmsi  = evt.claudeContext?.vessel?.mmsi;
        let color = '#40c4ff';
        let label = '';

        if (evt.type === 'DARK_VESSEL') {
            color = '#ff1744'; label = 'DARK';
        } else if (evt.type === 'SPEED_ANOMALY' || evt.type === 'COURSE_CHANGE') {
            color = '#ffaa00'; label = 'ANOMALY';
        } else if (evt.type === 'CABLE_PROXIMITY') {
            color = '#ff6600'; label = 'CABLE';
        } else if (evt.type === 'REAPPEAR') {
            // Remove when vessel comes back
            if (mmsi) _edgeTargets.delete(String(mmsi));
            return;
        } else {
            return; // don't track CLUSTER / SITREP in edge system
        }

        if (!mmsi) return;
        const ship = window.aisShips.find(s => String(s.userData.mmsi ?? s.userData.id) === String(mmsi));
        if (ship) {
            _edgeTargets.set(String(mmsi), { ship, color, label });
        }
    });

    // NDC project + edge-clamp helper
    const _ndcVec  = new THREE.Vector3();
    function _projectToEdge(worldPos, vpW, vpH) {
        _ndcVec.copy(worldPos).project(camera);
        // On screen when all NDC coords are in [-1, 1] and in front (z <= 1)
        if (_ndcVec.z <= 1 &&
            _ndcVec.x >= -1 && _ndcVec.x <= 1 &&
            _ndcVec.y >= -1 && _ndcVec.y <= 1) return null;
        // Screen coords (0,0 = top-left)
        const sx = (_ndcVec.x *  0.5 + 0.5) * vpW;
        const sy = (_ndcVec.y * -0.5 + 0.5) * vpH;
        const margin = 44;
        const cx = vpW / 2, cy = vpH / 2;
        let dx = sx - cx, dy = sy - cy;
        // If behind camera, flip so arrow points generally backward
        if (_ndcVec.z > 1) { dx = -dx; dy = -dy; }
        const scl = Math.min(
            (vpW / 2 - margin) / (Math.abs(dx) || 1),
            (vpH / 2 - margin) / (Math.abs(dy) || 1)
        );
        return {
            x:     cx + dx * scl,
            y:     cy + dy * scl,
            angle: Math.atan2(dy, dx) + Math.PI / 2, // +90° so ▲ points toward target
        };
    }

    // ── SITREP: gather current scene state ────────────────────────────────────
    // Called by the ⬡ SITREP button in the copilot panel.  Uses a dedicated
    // frustum instance so it never interferes with the status board.
    {
        const _sitFrustum    = new THREE.Frustum();
        const _sitProjScreen = new THREE.Matrix4();

        // Reverse Mercator: scene x/z → geographic lon/lat
        function _sceneToLonLat(x, z) {
            const lon    = (x / (MAP_WIDTH  / 2)) * 180;
            const mercY  = -(z / (MAP_HEIGHT / 2)) * Math.PI;
            const latRad = 2 * Math.atan(Math.exp(mercY)) - Math.PI / 2;
            return { lon, lat: latRad * (180 / Math.PI) };
        }

        function _detectRegion(lon, lat) {
            for (const r of REGIONS) {
                if (lat > r.latMin && lat <= r.latMax && lon > r.lonMin && lon <= r.lonMax) return r.name;
            }
            return 'OPEN OCEAN';
        }

        window.gatherSceneContext = function() {
            camera.updateMatrixWorld();
            _sitProjScreen.multiplyMatrices(
                camera.projectionMatrix, camera.matrixWorldInverse
            );
            _sitFrustum.setFromProjectionMatrix(_sitProjScreen);

            const classCounts = {};
            let totalVisible  = 0;
            let darkCount     = 0;

            const ships = window.aisShips;
            for (let i = 0; i < ships.length; i++) {
                const s = ships[i];
                if (!_sitFrustum.containsPoint(s.position)) continue;
                totalVisible++;
                const cls = s.userData?.class ?? 'UNKNOWN';
                classCounts[cls] = (classCounts[cls] || 0) + 1;
                if (s.userData?.isDark === true)      darkCount++;
            }

            // Derive region from camera look-at target
            const { lon, lat } = _sceneToLonLat(controls.target.x, controls.target.z);
            const region = _detectRegion(lon, lat);

            // Same threat ladder as _tickDynamicStatus
            // Threat keys off AIS-dark vessels — the civilian anomaly signal.
            let threatLevel = 'LOW';
            if (darkCount      >= 1) threatLevel = 'MODERATE';
            if (darkCount      >= 3) threatLevel = 'ELEVATED';
            if (darkCount      >= 6) threatLevel = 'CRITICAL';

            return {
                region,
                totalVisible,
                totalAll:      ships.length,
                classCounts,
                darkCount,
                threatLevel,
                nearChokepoint: aiCopilot._nearChokepoint(lat, lon),
                cameraLat:     lat,
                cameraLon:     lon,
                cameraAlt:     camera.position.y,
                timestamp:     Date.now(),
            };
        };
    }

    // ── Animation loop ────────────────────────────────────────────────────────
    // ── FPS counter state ─────────────────────────────────────────────────────
    const _fpsEl = document.getElementById('fps-counter');
    const _msEl  = document.getElementById('ms-counter');
    let _fpsFrames = 0, _fpsLast = performance.now(), _fpsValue = 0;
    let _lastRenderMs = 0;

    function animate() {
        requestAnimationFrame(animate);

        // ── FPS cap (runtime frame limiter) ───────────────────────────────────
        // quality.fpsCap() = 0 means uncapped (run at display refresh). Otherwise
        // skip frames to hold the target. Can't exceed the monitor's refresh rate.
        const _cap = quality.fpsCap();
        if (_cap > 0) {
            const _nowMs = performance.now();
            if (_nowMs - _lastRenderMs < (1000 / _cap) - 1) return;   // too soon — skip this frame
            _lastRenderMs = _nowMs;
        }

        const delta   = clock.getDelta();
        const elapsed = clock.getElapsedTime();

        // ── FPS + frame-time update (once per second) ─────────────────────────
        _fpsFrames++;
        const _fpsNow = performance.now();
        const _fpsDt  = _fpsNow - _fpsLast;
        if (_fpsDt >= 1000) {
            _fpsValue  = Math.round(_fpsFrames * 1000 / _fpsDt);
            const ms   = (_fpsDt / _fpsFrames).toFixed(1);
            if (_fpsEl) {
                _fpsEl.textContent = _fpsValue;
                _fpsEl.style.color = _fpsValue >= 50 ? '#40c4ff'
                                   : _fpsValue >= 30 ? '#f5a623'
                                   : '#ff4444';
            }
            if (_msEl) _msEl.textContent = ms + ' ms';
            _fpsFrames = 0;
            _fpsLast   = _fpsNow;
        }

        controls.update();

        // ── FOV lerp — smooth transition between CINEMATIC / BALANCED / TACTICAL
        if (Math.abs(camera.fov - _targetFOV) > 0.08) {
            camera.fov = THREE.MathUtils.lerp(camera.fov, _targetFOV, delta * 2.5);
            camera.updateProjectionMatrix();
        }

        // ── Map boundary clamping ─────────────────────────────────────────────
        const boundX = MAP_WIDTH  / 2;
        const boundZ = MAP_HEIGHT / 2;
        const clampedX = Math.max(-boundX, Math.min(boundX, controls.target.x));
        const clampedZ = Math.max(-boundZ, Math.min(boundZ, controls.target.z));
        const diffX = clampedX - controls.target.x;
        const diffZ = clampedZ - controls.target.z;
        if (diffX !== 0 || diffZ !== 0) {
            controls.target.x    += diffX;  controls.target.z    += diffZ;
            camera.position.x    += diffX;  camera.position.z    += diffZ;
        }

        // ── Cinematic orbit ───────────────────────────────────────────────────
        if (state.presentationMode && !state.lockedShip) {
            scene.rotation.y += 0.001;
        }

        // ── Day / night + solar ephemeris ─────────────────────────────────────
        dayNightManager.tick(elapsed);
        skyManager.update(dayNightManager.sunLatRad, dayNightManager.sunLonRad);
        // skyManager.renderSky() removed — the atmospheric sky cube was
        // rendering a sunset horizon glow as scene.background that
        // interrupted analyst readability. The sun direction + elevation
        // are still computed above and consumed by the splat/water/light
        // pipeline below; only the visible sky background is disabled.

        const sunElev   = skyManager.sunElevation;          // -1 … 1
        const dayFactor = Math.max(0, sunElev);

        // Push sun direction + elevation into the splat cloud shader
        splatUniforms.uSunDir.value.copy(skyManager.sunDirection);
        splatUniforms.uSunElevation.value = Math.max(0.70, sunElev);

        // Day/night terminator — geographic sub-solar point for terrain dimming.
        // Follows simClock automatically (skyManager is fed from sim time).
        if (splatUniforms.uSubSolarLat) {
            splatUniforms.uSubSolarLat.value = skyManager.sunLatRad ?? 0;
            splatUniforms.uSubSolarLon.value = skyManager.sunLonRad ?? 0;
        }
        // Ridge pulse animation clock (seconds)
        if (splatUniforms.uTime) splatUniforms.uTime.value = elapsed;

        // Calm starfield drift + twinkle
        starField.update(elapsed, delta);

        // Adaptive quality — nudge pixel ratio from real frame time
        quality.tick(delta);

        // Drive scene lights from solar elevation.
        // Intensities tuned for Three.js r184 physically-correct lighting mode —
        // the same values that looked correct in r168 non-physical mode needed to be
        // divided by roughly 3 to avoid overexposing the continent MeshStandardMaterial.
        // PBR divides all light by π internally — values must be ~3× higher
        // than they look to achieve the desired brightness on-screen.
        dirLight.intensity     = Math.pow(dayFactor, 0.7) * DIR_LIGHT_INTENSITY_MAX;
        ambientLight.intensity = AMBIENT_INTENSITY_BASE + dayFactor * AMBIENT_INTENSITY_BONUS;

        // ── Clamp sun direction to min 30° elevation (Y ≥ 0.5 pre-normalise) ──
        // Near-horizon sun causes grazing illumination on flat coastal plains and
        // cliff walls → bright warm glow ring around every continent.
        // Clamping prevents this while keeping the sun's horizontal position
        // (north/south/east/west tracking) accurate for mountain shadow direction.
        dirLight.position
            .set(skyManager.sunDirection.x,
                 Math.max(0.50, skyManager.sunDirection.y),
                 skyManager.sunDirection.z)
            .normalize()
            .multiplyScalar(200);

        // ── Atmosphere / weather ──────────────────────────────────────────────
        // fogManager.update() removed alongside its post-process pass — no
        // longer needed to feed storm cells, sun direction, etc.
        const stormCells = (typeof gfsWindManager !== 'undefined' && gfsWindManager.getStormCells)
            ? gfsWindManager.getStormCells() : [];
        void stormCells;  // kept computed in case future weather visualisations consume it
        gfsWindManager.update(delta);
        beaufortWarnings.update(elapsed);
        gfsUpperWindManager.update(delta);
        ibtracsManager.update(delta);
        gpsJammingManager.update(delta);
        wakeManager.update(elapsed);
        // Aircraft trails register hidden (see flightManager.onAircraftNew) to
        // avoid drawing thousands of overlapping contrails at once. Reveal only
        // the currently selected/locked aircraft's trail, checked once per
        // frame here rather than at every lockedShip assignment site scattered
        // across uiController.js.
        {
            const locked = state.lockedShip;
            if (locked !== window._prevLockedTrailShip) {
                if (window._prevLockedTrailShip?.userData?.isRealFlight) {
                    trailManager.setVisible(window._prevLockedTrailShip, false);
                }
                if (locked?.userData?.isRealFlight) {
                    trailManager.setVisible(locked, true);
                }
                window._prevLockedTrailShip = locked;
            }
        }
        trailManager.tick();   // throttled GPU texture upload — every 3rd frame
        altitudeDeckManager.update(delta, state); // small flight-level grid patch anchored under the currently selected/clicked aircraft
        conflictManager.updateVisuals(flightManager.aircraft); // cheap — only moves lines for already-flagged pairs, no pairwise math here

        // ── Ionospheric / geomagnetic layers ─────────────────────────────────
        ionosphericLayers.update(elapsed, delta);
        birkelandLayers.update(elapsed);

        // ── Live data ticks ───────────────────────────────────────────────────
        aisManager.tick(delta);
        flightManager.tick(delta);

        // ── Real-flight position sync (client-side extrapolation) ────────────
        // flightManager.tick() above already advances each aircraft's
        // currentPos every frame — first by lerping prevPos→targetPos after a
        // poll lands, then by dead-reckoning from speed/heading once that
        // lerp finishes (see flightManager.js tick()). Until now nothing ever
        // read currentPos back onto the Object3D: onAircraftUpdate only sets
        // obj.position once per ADS-B poll (every 30s), so aircraft sat
        // frozen for most of each 30s window and then snapped. This loop
        // closes that gap — every frame, every real flight's mesh follows
        // currentPos, so movement reads as continuous even though fresh data
        // only arrives every 30s. The altitude glow is a sibling sprite, not
        // a child of the mesh (see entityBuilder.js createFlightObject — a
        // child would inherit the mesh's tiny cls.scale and shrink to
        // near-invisible), so its position is synced here too. The actual
        // airframe (fuselage/wings/rotors/etc.) is no longer a per-aircraft
        // Object3D — aircraftInstancer.update() writes this aircraft's
        // transform straight into its class's shared InstancedMesh set
        // (one draw call per part per class, not per aircraft; see
        // aircraftInstancer.js). obj.visible is still driven entirely by
        // clusterManager.js exactly as before — instancer.update() reads it
        // here and degenerate-scales the instance when hidden, replacing the
        // old "ship.visible=false hides its mesh children" behavior now that
        // there are no mesh children to hide.
        aircraftInstancer.tick(delta);
        flightManager.aircraft.forEach((a) => {
            const obj = a.threeObject;
            if (!obj) return;
            obj.position.set(a.currentPos.x, a.currentPos.y, a.currentPos.z);
            if (obj.userData.altitudeGlow) {
                obj.userData.altitudeGlow.position.set(a.currentPos.x, a.currentPos.y, a.currentPos.z);
            }

            // Emergency ring — pulsing red halo, mirrors the AIS
            // integrityRing pattern just above for vessels. Driven off
            // flightIntegrityManager's EMERGENCY flag (squawk 7500/7600/
            // 7700 or ADS-B emergency field), never set anywhere else.
            const eRing = obj.userData.emergencyRing;
            const eMat  = obj.userData.emergencyRingMat;
            if (eRing && eMat) {
                const emergency = obj.visible && flightIntegrityManager.getRecord(a.icao24)?.flags.has('EMERGENCY');
                eRing.visible = !!emergency;
                if (emergency) {
                    eRing.position.set(a.currentPos.x, a.currentPos.y, a.currentPos.z);
                    const p = (Math.sin(elapsed * 6.0) + 1) * 0.5;   // ~1 Hz pulse
                    eMat.opacity = 0.45 + p * 0.5;
                    const s = 1.0 + p * 0.2;
                    eRing.scale.set(s, s, s);

                    if (!emergencyAlerted.has(a.icao24)) {
                        emergencyAlerted.add(a.icao24);
                        const rec = flightIntegrityManager.getRecord(a.icao24);
                        const detail = rec?.flags.get('EMERGENCY')?.detail || 'emergency squawk';
                        window.alertsManager?.addAlert({
                            type: 'AIRCRAFT_EMERGENCY', mmsi: a.icao24, vesselName: obj.userData.displayName || a.icao24,
                            message: `${obj.userData.displayName || a.icao24} — ${detail}`,
                        });
                    }
                } else {
                    emergencyAlerted.delete(a.icao24);
                }
            }

            aircraftInstancer.update(obj.userData.instanceHandle, obj.position, obj.visible,
                a.currentHeadingDeg, a.bankDeg, a.pitchDeg, a.spawnEase);
        });

        // ── Selection ring ────────────────────────────────────────────────────
        selectionRing.tick(delta, elapsed);

        // ── Cluster LOD ───────────────────────────────────────────────────────
        clusterManager.tick(window.aisShips, camera, elapsed);

        // ── Real-AIS hull sync (instanced rendering) ──────────────────────────
        // Ships, unlike aircraft, snap directly to each fresh AIS position in
        // onVesselUpdate rather than lerping every frame — so this loop's main
        // job isn't position smoothing, it's catching every place obj.visible
        // changes without going through onVesselUpdate: clusterManager.tick()
        // just above, the class-filter bar, dark-vessel logic, and
        // onVesselReappear all toggle ship.visible directly. Placed AFTER
        // clusterManager.tick() so same-frame zoom-threshold visibility
        // changes are picked up immediately instead of lagging a frame.
        for (let i = 0, n = window.aisShips.length; i < n; i++) {
            const ship = window.aisShips[i];
            if (!ship.userData.isRealAIS) continue;
            shipInstancer.update(ship.userData.instanceHandle, ship.position, ship.visible);
        }

        // ── Transition orchestrator (Plan 02) ─────────────────────────────────
        transitionMgr.tick(state, camera);

        // ── Port LOD + hover + animation (Phases 1–4) ─────────────────────────
        portManager.tick(camera, mouse, delta);

        // First-encounter context card: explain cluster bubbles the first time
        // the camera zooms out far enough to see them (y > 160 = cluster visible)
        if (camera.position.y > 160 && window.aisShips.length > 0) {
            contextCards.show('CLUSTER');
        }

        // ── Nav lights ────────────────────────────────────────────────────────
        navLightManager.update(window.aisShips, sunElev);

        // ── Continent terrain mesh LOD + point cloud crossfade ───────────────
        continentMesh.update(camera);
        updatePointCloud(camera);

        // ── City LOD + label fade + glow pulse ────────────────────────────────
        cityManager.update(camera);

        // ── 3D building extrusion ─────────────────────────────────────────────
        buildingManager.update(camera);

        // ── Tile-streaming LOD terrain ────────────────────────────────────────
        tileStreamManager.update(camera);

        // ── AI Co-Pilot ───────────────────────────────────────────────────────
        aiCopilot.tick(delta);
        discoveryManager.tick(delta);

        // ── Chokepoint landmarks ──────────────────────────────────────────────
        chokepointManager.tick(delta, elapsed, window.aisShips);

        // ── Simulated (spline-driven) entities ────────────────────────────────
        window.aisShips.forEach(ship => {
            if (!ship.userData.curve) return; // skip real AIS / flights / sats

            ship.userData.progress += ship.userData.speed;
            if (ship.userData.progress > 1) {
                ship.userData.progress = 0;
                ship.userData.history  = [];
            }

            const pos = ship.userData.curve.getPointAt(ship.userData.progress);
            ship.position.copy(pos);

            // Fixed sideways profile — lock all simulated entities to a
            // constant eastward orientation so hull/fuselage length is always
            // visible from above rather than showing bow-on or stern-on.
            ship.rotation.set(0, Math.PI / 2, 0);

            // Legacy line trail (simulated entities)
            ship.userData.history.unshift(ship.position.clone());
            const maxHist = 20;
            if (ship.userData.history.length > maxHist) ship.userData.history.pop();
            if (ship.userData.history.length > 1 && ship.userData.trail) {
                // In-place buffer update — avoids the Three.js r184 warning
                // "Buffer size too small for points data" that fires when
                // setFromPoints() tries to grow a previously-smaller buffer.
                // The trail geometry is pre-allocated at MAX_TRAIL_PTS=41 in
                // createShipOnSpline so the Float32Array is always large enough.
                const geo  = ship.userData.trail.geometry;
                const attr = geo.attributes.position;
                const hist = ship.userData.history;
                const cnt  = Math.min(hist.length, attr.count);
                for (let j = 0; j < cnt; j++) {
                    attr.setXYZ(j, hist[j].x, hist[j].y, hist[j].z);
                }
                attr.needsUpdate = true;
                geo.setDrawRange(0, cnt);
            }

            // Push into GPU trail ring-buffer
            trailManager.pushPosition(ship, ship.position.x, ship.position.y, ship.position.z);

            // Strobe blink
            const strobe = ship.getObjectByName('strobe_light');
            if (strobe) {
                strobe.visible = (Math.floor(elapsed * 4 + ship.userData.progress * 100) % 2 === 0);
            }

        });

        // ── Dark-vessel halo blink ────────────────────────────────────────────
        // blinkOn hoisted here so the anomaly ring + ping animation sections
        // below can share the same 1.1 Hz square-wave without recomputing.
        const blinkOn = (elapsed % (1 / 1.1)) < (0.55 / 1.1);
        {
            window.aisShips.forEach(ship => {
                if (!ship.userData.isDark) return;
                const dm = ship.userData.darkMarker;
                if (!dm || !dm.userData._isDarkMarker) return;
                dm.userData._darkOuterMat.opacity = blinkOn ? 0.95 : 0.18;
                dm.userData._darkMidMat  && (dm.userData._darkMidMat.opacity  = blinkOn ? 0.55 : 0.04);
                dm.userData._darkCrossMat && (dm.userData._darkCrossMat.opacity = blinkOn ? 0.95 : 0.10);
                dm.userData._darkInnerMat && (dm.userData._darkInnerMat.opacity =
                    0.25 + 0.20 * Math.sin(elapsed * 2.8));

                // Rising motes — drift up the beam, recycling at the top
                const mo = dm.userData._darkMotes;
                if (mo) {
                    const arr = mo.geo.attributes.position.array;
                    for (let k = 0; k < mo.phase.length; k++) {
                        const t = (mo.phase[k] + elapsed * 0.18) % 1;
                        arr[k * 3 + 1] = t * mo.h;
                    }
                    mo.geo.attributes.position.needsUpdate = true;
                }
            });
        }

        // ── Vessel dot show/hide + dark marker overlap reduction ─────────────
        {
            // Show dots up to y=150 so they're visible at the mid-zoom level
            // where port labels appear. MARKER_CLOSE_ZOOM (80) was too restrictive.
            const showClose = camera.position.y <= 150;

            const darkPositions = [];
            window.aisShips.forEach(ship => {
                if (ship.userData.isDark && ship.userData.darkMarker)
                    darkPositions.push(ship.userData.darkMarker.position);
            });

            window.aisShips.forEach(ship => {
                // Show dot at close zoom for all tracked vessels.
                // Active = green (#00ff88). Dark = red (#ff1744) so the last
                // known position stays visible but clearly signals lost contact.
                const dot = ship.userData.vesselDot;
                if (dot) {
                    // Respect the class filter — hidden classes stay hidden.
                    dot.visible = showClose && !ship.userData._classHidden;
                    const mat = dot.userData._vesselDotMat;
                    if (mat) {
                        if (ship.userData.isDark) {
                            mat.color.setHex(0xff1744);  // red — lost contact
                            mat.opacity = 0.90;
                        } else {
                            mat.color.setHex(0x00ff88);  // green — live
                            mat.opacity = 0.80;
                        }
                    }
                }

                // Dark marker overlap opacity reduction
                const dm = ship.userData.darkMarker;
                if (!dm || !dm.userData._isDarkMarker) return;
                let nearbyCount = 0;
                for (const pos of darkPositions) {
                    if (pos === dm.position) continue;
                    const dx = dm.position.x - pos.x;
                    const dz = dm.position.z - pos.z;
                    if (Math.sqrt(dx * dx + dz * dz) < 4.0) nearbyCount++;
                }
                if (nearbyCount > 0) {
                    const f = Math.max(0.35, 1.0 - nearbyCount * 0.22);
                    dm.userData._darkOuterMat.opacity *= f;
                    dm.userData._darkMidMat  && (dm.userData._darkMidMat.opacity  *= f);
                    dm.userData._darkCrossMat && (dm.userData._darkCrossMat.opacity *= f);
                }
            });
        }

        // ── Ground shadow + anomaly ring sync (Plan 03 vessel state animations)
        // Four states per Plan 03:
        //   NORMAL       (level 0) — no ring
        //   FLAGGED      (level 1) — slow amber pulse, 2.5 s cycle
        //   ACTIVE       (level 2) — inner ring contracts on sonar-ping beat
        //   AIS-DARK     (isDark)  — blinks in sync with dark marker
        {
            const _PING_CYCLE = 1.2;   // ACTIVE state sonar-ping period (seconds)
            for (let i = 0, n = window.aisShips.length; i < n; i++) {
                const ship = window.aisShips[i];

                // Shadow sync — only show when zoomed in close enough to see the
                // vessel models. At far zoom the 5-unit black shadows pile up
                // (clustering doesn't hide the ships) and read as black holes on
                // the bright terrain, so gate them off above SHADOW_MAX_ZOOM.
                const shadow = ship.userData.shadowSprite;
                if (shadow) {
                    const showShadow = ship.visible && camera.position.y <= 70;
                    shadow.visible = showShadow;
                    if (showShadow) {
                        shadow.position.set(ship.position.x, 0.15, ship.position.z);
                    }
                }

                // Integrity ring — pulsing electric-violet halo on SUSPECT vessels only.
                const iRing = ship.userData.integrityRing;
                const iMat  = ship.userData.integrityRingMat;
                if (iRing && iMat) {
                    const suspect = ship.visible && integrityManager.tier(ship.userData.id) === 'SUSPECT';
                    iRing.visible = suspect;
                    if (suspect) {
                        iRing.position.set(ship.position.x, 0.3, ship.position.z);
                        const p = (Math.sin(elapsed * 6.0) + 1) * 0.5;   // ~1 Hz pulse
                        iMat.opacity = 0.45 + p * 0.5;                   // 0.45 → 0.95
                        const s = 1.0 + p * 0.15;
                        iRing.scale.set(s, s, s);
                    }
                }

                const ring = ship.userData.anomalyRing;
                const mat  = ship.userData.anomalyRingMat;
                if (!ring || !mat) continue;

                const isDark = ship.userData.isDark === true;
                const level  = isDark
                    ? 3
                    : aiCopilot.getVesselAnomalyLevel(ship.userData.mmsi ?? ship.userData.id);

                if (level > 0 && ship.visible) {
                    ring.visible = true;
                    ring.position.set(ship.position.x, 0.25, ship.position.z);

                    if (isDark) {
                        // AIS-DARK: blink in sync with dark marker, softer opacity
                        mat.color.setHex(0xff1744);
                        mat.opacity = blinkOn ? 0.58 : 0.06;
                        ring.scale.set(1, 1, 1);  // hold steady — bleed ring handles expansion

                    } else if (level === 2) {
                        // ACTIVE ANOMALY: inner ring contracts briefly each ping cycle
                        mat.color.setHex(0xff2244);
                        const phase = (elapsed % _PING_CYCLE) / _PING_CYCLE; // 0..1
                        if (phase < 0.15) {
                            // Contract inward during first 15% of cycle
                            const t = phase / 0.15;
                            const s = 1.0 - t * 0.15;
                            ring.scale.set(s, s, s);
                        } else {
                            // Recover to full size over remainder of cycle
                            const t = (phase - 0.15) / 0.85;
                            const s = 0.85 + t * 0.15;
                            ring.scale.set(s, s, s);
                        }
                        mat.opacity = 0.65;

                    } else {
                        // FLAGGED / level 1 or 3 non-dark: slow amber pulse 2.5 s
                        const col = level === 3 ? 0xff1744 : 0xff8c00;
                        mat.color.setHex(col);
                        const pulse = Math.sin((elapsed / 2.5) * Math.PI * 2);
                        mat.opacity = 0.30 + pulse * 0.20;  // 0.10 – 0.50
                        ring.scale.set(1, 1, 1);
                    }

                } else {
                    ring.visible = false;
                    ring.scale.set(1, 1, 1);
                }
            }
        }

        // ── Sonar-ping outer ring animation (Plan 03 — ACTIVE state) ─────────
        // Ping ring expands from scale 1→2.4 and fades on the 1.2 s cycle.
        // Driven separately from the inner anomaly ring so the two motions
        // (contraction + expansion) happen simultaneously on the same beat.
        {
            const _PING_CYCLE = 1.2;
            for (let i = 0, n = window.aisShips.length; i < n; i++) {
                const ship     = window.aisShips[i];
                const pingRing = ship.userData.pingRing;
                const pingMat  = ship.userData.pingRingMat;
                if (!pingRing || !pingMat) continue;

                const level = ship.userData.isDark
                    ? 0  // dark vessels use dark-bleed, not sonar-ping
                    : aiCopilot.getVesselAnomalyLevel(ship.userData.mmsi ?? ship.userData.id);

                if (level >= 2 && ship.visible) {
                    pingRing.visible = true;
                    pingRing.position.set(ship.position.x, 0.25, ship.position.z);
                    const phase = (elapsed % _PING_CYCLE) / _PING_CYCLE;
                    // Expand 1.0 → 2.4, fade 0.85 → 0
                    const s = 1.0 + phase * 1.4;
                    pingRing.scale.set(s, s, s);
                    pingMat.opacity = (1.0 - phase) * 0.85;
                } else {
                    pingRing.visible = false;
                }
            }
        }

        // ── Dark-bleed animation (Plan 03 — AIS-DARK, one-time) ─────────────
        // Bleed ring expands and fades over 2.4 s on vessel going dark.
        // animation-fill-mode: forwards — ring is hidden after completion.
        {
            const _BLEED_DURATION = 2.4;  // seconds
            for (let i = 0, n = window.aisShips.length; i < n; i++) {
                const ship = window.aisShips[i];
                if (!ship.userData.isDark) continue;
                const dm = ship.userData.darkMarker;
                if (!dm || !dm.userData._darkBleedMat) continue;

                const ageS = (performance.now() - dm.userData._bleedStartMs) / 1000;
                const bleedRing = dm.userData._darkBleedRing;
                const bleedMat  = dm.userData._darkBleedMat;
                if (!bleedRing) continue;

                if (ageS >= _BLEED_DURATION) {
                    bleedRing.visible = false;  // done — hide permanently
                    continue;
                }

                // Quadratic ease-out: fast start, slow finish
                const t    = ageS / _BLEED_DURATION;
                const ease = 1 - (1 - t) * (1 - t);

                bleedRing.visible = true;
                const s = 1.0 + ease * 3.5;   // scale 1 → 4.5
                bleedRing.scale.set(s, s, s);
                bleedMat.opacity = 0.65 * (1 - ease);   // 0.65 → 0
            }
        }

        // ── Camera lerp targets ───────────────────────────────────────────────
        // Guard: no programmatic camera movement until the user has interacted.
        // This prevents any AIS event or startup condition from auto-focusing
        // on a vessel (e.g. the first ship to arrive on the live feed).
        if (_userHasInteracted) {
            if (state.lockedShip) {
                controls.target.lerp(state.lockedShip.position, 0.08);
            } else if (state.isPanningToTerrain) {
                controls.target.lerp(state.terrainTargetPos, 0.08);
                if (controls.target.distanceTo(state.terrainTargetPos) < 0.5) {
                    state.isPanningToTerrain = false;
                }
            }

            if (state.isFlyingToTarget) {
                camera.position.lerp(state.flightTargetPos, 0.05);
                if (camera.position.distanceTo(state.flightTargetPos) < 1.0) {
                    state.isFlyingToTarget = false;
                }
            }
        }

        // ── UI ticks ──────────────────────────────────────────────────────────
        // Vessel hover — screen-space snap, shows name / class / speed tooltip
        tickRaycasting({ raycaster, mouse, camera, aisShips: window.aisShips, tooltipEl, stateRef: state });
        tickVesselDetail(state);
        tickSearchVisibility(window.aisShips);
        tickAlertZone(window.aisShips);
        window._tickDynamicStatus(performance.now());
        // Sync intensity target after threat level is updated
        window._syncThreatIntensity?.();

        // ── Threat intensity lerp — bloom + vignette ─────────────────────────
        // Smoothly transitions visual drama as threat level changes.
        const _tgtI = window._targetThreatIntensity ?? 0;
        if (Math.abs(_currentThreatIntensity - _tgtI) > 0.002) {
            _currentThreatIntensity = THREE.MathUtils.lerp(_currentThreatIntensity, _tgtI, delta * 0.7);
            bloomPass.strength      = BLOOM_STRENGTH_BASE + _currentThreatIntensity * BLOOM_THREAT_RANGE;
            if (_vignetteEl) _vignetteEl.style.opacity = String(_currentThreatIntensity * 0.80);
        }

        // ── Off-screen edge indicators ────────────────────────────────────────
        // Project flagged entities to NDC; show arrows at viewport edge when
        // they slip off-screen so the operator never loses track of threats.
        {
            const nowMs = performance.now();
            if (nowMs - _edgeLastMs > 80) {  // ~12 fps update rate — plenty for edge UI
                _edgeLastMs = nowMs;
                const vpW = window.innerWidth, vpH = window.innerHeight;
                let   idx = 0;

                _edgeTargets.forEach(({ ship, color, label }) => {
                    if (idx >= _edgeArrows.length) return;
                    if (!ship?.visible) return;

                    const edge = _projectToEdge(ship.position, vpW, vpH);
                    if (!edge) return;  // on screen — no arrow needed

                    const { el, tri, lbl } = _edgeArrows[idx++];
                    el.style.left      = `${edge.x}px`;
                    el.style.top       = `${edge.y}px`;
                    el.style.opacity   = '1';
                    tri.style.borderBottomColor = color;
                    tri.style.boxShadow = `0 0 6px ${color}`;
                    el.style.transform = `translate(-50%, -50%) rotate(${edge.angle}rad)`;
                    lbl.textContent    = label;
                    lbl.style.color    = color;
                });

                // Hide unused arrows
                for (let i = idx; i < _edgeArrows.length; i++) {
                    _edgeArrows[i].el.style.opacity = '0';
                }
            }
        }

        // ── Dynamic water animation ───────────────────────────────────────────
        updateDynamicWater(elapsed, camera.position.y);

        // ── Render ────────────────────────────────────────────────────────────
        composer.render();
        // Sea-state contour overlay — after post-processing so the thin black isobands
        // stay crisp. Pass `scene` so the overlay mirrors cinematic-orbit rotation.
        waveFieldLayer.renderOverlay(renderer, camera, scene);
    }

    animate();
}

// ── Port detail panel ─────────────────────────────────────────────────────────
// Populated on port label click. Fetches live weather from Open-Meteo (no key)
// and derives in-port vessels from the live AIS feed.
async function _showPortPanel(portData, camera, controls, stateRef) {
    const panel = document.getElementById('port-detail-panel');
    if (!panel) return;

    // Close button — bind here (idempotent onclick) so the × actually dismisses
    // the panel. Previously unbound, so the panel could not be closed.
    const _pdpClose = document.getElementById('pdp-close');
    if (_pdpClose) _pdpClose.onclick = () => { panel.style.display = 'none'; };

    // ── Static fields ──────────────────────────────────────────────────────────
    document.getElementById('pdp-name').textContent    = portData.name;
    document.getElementById('pdp-region').textContent  = portData.region;
    document.getElementById('pdp-coords').textContent  =
        `${Math.abs(portData.lat).toFixed(2)}°${portData.lat >= 0 ? 'N' : 'S'}  ` +
        `${Math.abs(portData.lon).toFixed(2)}°${portData.lon >= 0 ? 'E' : 'W'}`;

    const rankEl = document.getElementById('pdp-rank');
    rankEl.textContent = portData.teuRank
        ? `#${portData.teuRank} Global TEU`
        : '';

    document.getElementById('pdp-type').textContent       = portData.type ?? '';
    document.getElementById('pdp-max-vessel').textContent =
        portData.maxVessel ? `Max vessel: ${portData.maxVessel}` : '';

    // Serves list
    const servesEl = document.getElementById('pdp-serves');
    servesEl.innerHTML = (portData.serves ?? [])
        .map(s => `<div class="pdp-serves-item">${s}</div>`)
        .join('');

    // ── Vessels in port — AIS proximity: within 4 scene units, speed < 1 kts ──
    // _toScene equivalent using Mercator
    const _px = (portData.lon / 180.0) * 150;
    const _pr = portData.lat * (Math.PI / 180.0);
    const _pz = -(Math.log(Math.tan(Math.PI / 4.0 + _pr / 2.0)) / Math.PI) * 150;
    const PORT_RADIUS = 5.0; // scene units

    const inPort = window.aisShips.filter(ship => {
        if (!ship.userData.isRealAIS) return false;
        const dx = ship.position.x - _px;
        const dz = ship.position.z - _pz;
        const dist = Math.sqrt(dx * dx + dz * dz);
        return dist < PORT_RADIUS && (ship.userData.speedKts ?? 99) < 1.5;
    });

    document.getElementById('pdp-vessel-count').textContent = inPort.length;

    // Class breakdown chips
    const classCounts = {};
    inPort.forEach(s => {
        const cls = s.userData.class ?? 'OTHER';
        classCounts[cls] = (classCounts[cls] || 0) + 1;
    });
    const breakdownEl = document.getElementById('pdp-vessel-breakdown');
    breakdownEl.innerHTML = Object.entries(classCounts)
        .map(([cls, n]) => `<span class="pdp-class-chip">${cls} ${n}</span>`)
        .join('');

    // Watchlisted vessels in port
    const watched = inPort.filter(s =>
        window.watchlist?.isWatched(String(s.userData.id ?? s.userData.mmsi))
    );
    const watchEl  = document.getElementById('pdp-watchlisted');
    const watchList = document.getElementById('pdp-watch-list');
    if (watched.length > 0) {
        watchEl.style.display = 'block';
        watchList.innerHTML = watched.map(s => {
            const ud   = s.userData;
            const name = ud.displayName ?? ud.id;
            const dest = ud.destination ? `→ ${ud.destination}` : '';
            const spd  = ud.speedKts != null ? `${ud.speedKts} kn` : '';
            return `<div class="pdp-watch-row">
                <span class="pdp-watch-name">${name}</span>
                <span class="pdp-watch-dest">${dest}</span>
                <span>${spd}</span>
            </div>`;
        }).join('');
    } else {
        watchEl.style.display = 'none';
    }

    // ── Show panel immediately with static data ────────────────────────────────
    panel.style.display = 'block';

    // Fly camera to port
    const { flyToSector } = await import('./uiController.js');
    flyToSector(portData.lon, portData.lat, camera, controls, stateRef, 35);

    // ── Weather fetch — Open-Meteo (no API key) ────────────────────────────────
    const weatherEl = document.getElementById('pdp-weather-val');
    weatherEl.textContent = 'Fetching…';
    try {
        const url = `https://api.open-meteo.com/v1/forecast` +
            `?latitude=${portData.lat}&longitude=${portData.lon}` +
            `&current=wind_speed_10m,wind_direction_10m,weather_code,wave_height` +
            `&wind_speed_unit=kn&timezone=UTC&models=gfs_seamless`;
        const res  = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        const data = await res.json();
        const c    = data.current;
        if (c) {
            const dirNames = ['N','NE','E','SE','S','SW','W','NW','N'];
            const dirIdx   = Math.round((c.wind_direction_10m ?? 0) / 45) % 8;
            const dirName  = dirNames[dirIdx];
            const spd      = Math.round(c.wind_speed_10m ?? 0);
            const wvH      = c.wave_height != null ? ` \u00b7 Wave ${c.wave_height.toFixed(1)}m` : '';
            const wCode    = c.weather_code ?? 0;
            const cond     = wCode >= 95 ? 'Thunderstorm'
                           : wCode >= 80 ? 'Rain showers'
                           : wCode >= 51 ? 'Drizzle / Rain'
                           : wCode >= 45 ? 'Fog'
                           : wCode >=  3 ? 'Cloudy'
                           : wCode >=  1 ? 'Partly cloudy' : 'Clear';
            weatherEl.textContent = `${spd} kn ${dirName} \u00b7 ${cond}${wvH}`;
        } else {
            weatherEl.textContent = 'Unavailable';
        }
    } catch (e) {
        weatherEl.textContent = 'Unavailable';
    }
}

window.onload = start;
