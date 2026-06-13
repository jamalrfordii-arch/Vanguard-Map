// main.js — Orchestrator: boots the app, owns the animation loop
import * as THREE from 'three';
import {
    MAP_WIDTH, MAP_HEIGHT,
    BLOOM_STRENGTH_BASE, BLOOM_THREAT_RANGE,
    AMBIENT_INTENSITY_BASE, AMBIENT_INTENSITY_BONUS,
    DIR_LIGHT_INTENSITY_MAX,
    CAMERA, FLIGHT, THREAT_INTENSITY, REGIONS, CLUSTER,
} from './config.js';
import { loadAllData } from './dataLoader.js';
import {
    initScene, initControls, addLights, initPostProcessing,
    createBoardPlaneAndReticle, onWindowResize
} from './sceneSetup.js';
import {
    initTerrainData, createHighFidelityPointCloud,
    createSolidOceanFloor, createCountryBorders,
    loadNormalMap, updatePointCloud, createOceanBasinLabels
} from './terrainBuilder.js';
import {
    createFlightObject, createAISVesselObject,
    createDarkVesselMarker, createVesselDot,
} from './entityBuilder.js';
import { PortManager } from './portManager.js';
import { ClusterManager } from './clusterManager.js';
import { FlightManager, lonLatAltToScene } from './flightManager.js';
import {
    setupUI, setupSettingsPanel, setupSectorSearch,
    onMouseMove, onDoubleClick, onClick, tickRaycasting,
    tickVesselDetail, refreshShipList, refreshFlightList,
    applySearchFilter, tickSearchVisibility, tickAlertZone,
    showVesselDetail, hideVesselDetail
} from './uiController.js';
import { AISManager, lonLatToScene } from './aisManager.js';
import { simClock } from './simClock.js';
import { SyntheticAISSource, RecordedAISSource, AISRecorder } from './dataSource.js';
import { initArchivePanel } from './archiveManager.js';
import { rfIntel, initRFIntelPanel } from './rfIntelManager.js';
import { RFEmergencyBeaconManager } from './rfEmergencyBeaconManager.js';
import { initVesselTab } from './vesselTab.js';
import { initWatchlist } from './watchlist.js';
import { initAlertsManager } from './alertsManager.js';
import { initFeedManager } from './feedManager.js';
import { initSitrepManager } from './sitrepManager.js';
import { initSelectionRing } from './selectionRing.js';
import { DayNightManager } from './dayNightManager.js';
import { createDynamicSeaLevel, updateDynamicWater } from './waterManager.js';
import { GFSWindManager }  from './gfsWindManager.js';
import { GFSUpperWindManager } from './gfsUpperWindManager.js';
import { AltitudeDeckManager } from './altitudeDeckManager.js';
import { SkyManager }    from './skyManager.js';
import { FogManager }    from './fogManager.js';
import { TrailManager }  from './trailManager.js';
import { WakeManager } from './wakeManager.js';
import { CityManager } from './cityManager.js';
import { ContinentMesh } from './continentMesh.js';
import * as terrainHeight from './terrainHeightSampler.js';
import { AICopilot, CHOKEPOINTS } from './aiCopilot.js';
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

// ── Boot sequence ─────────────────────────────────────────────────────────────
async function start() {
    try {
        const mapData = await loadAllData(msg => {
            const el = document.getElementById('loading-screen');
            if (el) el.innerHTML +=
                `<div style="font-size:10px;color:var(--cyan);margin-top:10px;">${msg}</div>`;
        });

        initTerrainData(mapData);
        await init(mapData);
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
    const controls = initControls(camera, renderer, state);
    window.controls = controls;   // expose for camera panel + any UI that needs orbit control
    window.camera   = camera;     // expose for layer click-to-inspect (IBTrACS, etc.)
    window.scene    = scene;      // expose for console debugging
    const { ambientLight, dirLight } = addLights(scene);

    // ── Selection ring ────────────────────────────────────────────────────────
    const selectionRing = initSelectionRing(scene);

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
            selectionRing.select(obj, ringColor);
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

    // ── Simulated background entities ─────────────────────────────────────────
    // Submarine trenches disabled — not real live data.
    // Aerospace routes also removed — real flight data comes from FlightManager API.
    // createSubmarineTrenches(scene, laneGroup, window.aisShips);

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

    // ── Upper-air wind (850mb low-level + 250mb jet stream) ──────────────────
    // Gives the scene actual vertical extent. Surface wind sits at Y=8,
    // 850mb at Y=22, jet stream at Y=65. Tilt the camera to see the
    // atmosphere as a stacked 3D volume.
    const gfsUpperWindManager = new GFSUpperWindManager(scene);
    window.gfsUpperWindManager = gfsUpperWindManager;

    // ── Altitude decks — stratified altitude reference layer ─────────────────
    // Renders translucent wireframe grids at each registered Y altitude with
    // edge labels naming them. Visible only when camera tilts, so top-down
    // operational view stays clean and tilted view reveals the 3D structure.
    const altitudeDeckManager = new AltitudeDeckManager(scene, camera);
    window.altitudeDeckManager = altitudeDeckManager;
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
    const normalMapTex = await loadNormalMap('./terrain_normals.png');

    // ── Global continent terrain mesh — satellite + geographic 3D character ──
    // Built in continentWorker.js off-thread; fades in at continent zoom
    const continentMesh = new ContinentMesh(scene, mapData, normalMapTex);
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

    // ── AIS live vessel manager ───────────────────────────────────────────────
    const aisManager = new AISManager();

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
        obj.rotation.y = Math.PI / 2;

        // ── Speed vector arrow ────────────────────────────────────────────────
        // Solid line from vessel position in heading direction.
        // Length = speed (kts) × 0.12 scene units, capped at 7 units (~60 kts).
        // Gives an instant read on who is fast/slow/stopped without clicking.
        if (obj.userData.predictionLine) {
            const speedKts = vesselData.speedKts ?? 0;
            const len = Math.min(speedKts * 0.12, 7);
            if (len > 0.15 && vesselData.headingDeg != null) {
                const hdgRad = vesselData.headingDeg * (Math.PI / 180);
                // In scene space: X = east (+), Z = south (+), so north = -Z
                const dx = Math.sin(hdgRad) * len;
                const dz = -Math.cos(hdgRad) * len;
                obj.userData.predictionLine.geometry.setFromPoints([
                    new THREE.Vector3(sp.x, sp.y, sp.z),
                    new THREE.Vector3(sp.x + dx, sp.y, sp.z + dz),
                ]);
                obj.userData.predictionLine.computeLineDistances();
                obj.userData.predictionLine.visible = true;
            } else {
                obj.userData.predictionLine.visible = false;
            }
        }

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
        const idx = window.aisShips.findIndex(s => s.userData.id === mmsi);
        if (idx === -1) return;
        const obj = window.aisShips[idx];
        trailManager.unregister(obj);
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
        laneGroup.remove(obj);
        scene.remove(obj);
        window.aisShips.splice(idx, 1);
    };

    aisManager.onVesselDark = (mmsi, vesselData) => {
        // Show a dark-vessel marker at last known position
        const sp  = lonLatToScene(vesselData.lonDeg, vesselData.latDeg);
        const obj = vesselData.threeObject;
        if (obj) {
            const marker = createDarkVesselMarker(sp, laneGroup);
            obj.userData.darkMarker  = marker;
            obj.userData.isDark      = true;
            obj.userData.darkSinceMs = vesselData.darkSince ?? Date.now();
            obj.visible = false;

            // Remove green dot immediately when vessel goes dark
            if (obj.userData.vesselDot) {
                laneGroup.remove(obj.userData.vesselDot);
                obj.userData.vesselDot = null;
            }
        }
    };

    aisManager.onVesselReappear = (mmsi, vesselData) => {
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

    flightManager.onAircraftNew = (icao24, data) => {
        const obj = createFlightObject(data, scene, laneGroup);
        data.threeObject = obj;
        window.aisShips.push(obj);

        const sp = lonLatAltToScene(data.lonDeg, data.latDeg, data.altMeters);
        obj.position.set(sp.x, sp.y, sp.z);

        const col = getAltColor(data.altMeters ?? 0);
        trailManager.register(obj, `#${col.getHexString()}`);
    };

    flightManager.onAircraftUpdate = (icao24, data) => {
        const obj = data.threeObject;
        if (!obj) return;

        const sp = lonLatAltToScene(data.lonDeg, data.latDeg, data.altMeters);
        obj.position.set(sp.x, sp.y, sp.z);

        // Fixed sideways profile — aircraft figures are locked east-facing
        // so the fuselage and wings are always readable from above.
        obj.rotation.y = Math.PI / 2;

        // Heading vector line — computed directly from headingDeg so it still
        // points in the true travel direction even though the model is fixed.
        if (obj.userData.headingLine) {
            const hdgRad = -(data.headingDeg ?? 0) * (Math.PI / 180);
            const fwd = new THREE.Vector3(0, 0, -8)
                .applyEuler(new THREE.Euler(0, hdgRad, 0))
                .add(sp);
            obj.userData.headingLine.geometry.setFromPoints([sp, fwd]);
        }

        trailManager.pushPosition(obj, sp.x, sp.y, sp.z);

        // Sync userData
        obj.userData.latDeg    = data.latDeg;
        obj.userData.lonDeg    = data.lonDeg;
        obj.userData.altMeters = data.altMeters;
        obj.userData.speedKts  = data.speedKts;
        obj.userData.headingDeg = data.headingDeg;
    };

    flightManager.onAircraftRemove = (icao24) => {
        const idx = window.aisShips.findIndex(s => s.userData.id === icao24);
        if (idx === -1) return;
        const obj = window.aisShips[idx];
        trailManager.unregister(obj);
        if (obj.userData.headingLine) scene.remove(obj.userData.headingLine);
        laneGroup.remove(obj);
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
    initAlertsManager(aiCopilot, aisManager);

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
            selectionRing.select(obj, ringColor);
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
        if (!selectionRing.target) return;
        const selectedMmsi = String(selectionRing.target.userData?.id || '');
        if (selectedMmsi !== String(e.detail.mmsi)) return;
        const color = e.detail.type === 'add'
            ? selectionRing.COLOR_WATCHLIST
            : selectionRing.COLOR_DEFAULT;
        selectionRing.setColor(color);
    });

    // ── Clear ring + card when vessel detail close button is clicked ──────────
    document.getElementById('vd-close')?.addEventListener('click', () => {
        hideVesselDetail();
        selectionRing.clear();
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
    // Coordinator + feed panel + distress beacon detector. Beacons inspect every
    // raw message, so onRawMessage multiplexes recorder tap + RF inspection.
    const rfBeacons = new RFEmergencyBeaconManager(scene);
    initRFIntelPanel({
        flyTo: (lat, lon) => {
            const p = lonLatToScene(lon, lat);
            controls.target.set(p.x, 0, p.z);
            camera.position.set(p.x, 38, p.z + 26);
            controls.update();
        }
    });
    const _recTap = aisRecorder.tap();
    aisManager.onRawMessage = (msg) => { _recTap(msg); rfBeacons.inspect(msg); };

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

    window.addEventListener('resize',    () => onWindowResize(camera, renderer, composer));
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
            case 'wind-low':     gfsUpperWindManager.setLowVisible(on); break;
            case 'wind-jet':     gfsUpperWindManager.setJetVisible(on); break;
            case 'sea-state':    gfsWindManager.setWaveVisible(on);  break;  // deprecated, no-op
            case 'storm-history': ibtracsManager.setVisible(on);     break;
            case 'gps-jamming':  gpsJammingManager.setVisible(on);   break;
            case 'fog':          window.vg1_fog_enabled   = on;       break;
            case 'aviation':
                window.aisShips.forEach(s => {
                    if (!s.userData?.isRealFlight) return;
                    s.visible = on;
                    if (s.userData.headingLine) s.userData.headingLine.visible = on;
                });
                window._aviationLayerOn = on;
                break;
        }
    });

    // ── Vessel class filter bar ───────────────────────────────────────────────
    // Clicking a class button filters window.aisShips visibility.
    // 'DARK' is a special filter — matches vessels with isDark:true regardless of class.
    // Filtered-out vessels stay in the aisShips array so data/alerts still work.
    {
        let _activeFilter = 'ALL';
        const _filterBtns = document.querySelectorAll('.vf-btn');

        _filterBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                _activeFilter = btn.dataset.class;
                _filterBtns.forEach(b => b.classList.toggle('active', b === btn));
                _applyVesselFilter(_activeFilter);
            });
        });

        function _applyVesselFilter(filter) {
            window.aisShips.forEach(ship => {
                const ud     = ship.userData;
                const isDark = ud.isDark === true;

                // Does this vessel pass the current filter?
                let passes;
                if (filter === 'ALL')        passes = true;
                else if (filter === 'DARK')  passes = isDark;
                else                         passes = (ud.class === filter) && !isDark;

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
                    if (ud.predictionLine) ud.predictionLine.visible = passes;
                    if (ud.vesselDot)      ud.vesselDot.visible      = passes;
                }

                // Trail always follows the same visibility as the vessel
                if (ud.trail) ud.trail.visible = passes;
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

        const MILITARY_SIT = new Set(['HOSTILE','FIGHTER','AWACS','DRONE','SUBMARINE']);

        window.gatherSceneContext = function() {
            camera.updateMatrixWorld();
            _sitProjScreen.multiplyMatrices(
                camera.projectionMatrix, camera.matrixWorldInverse
            );
            _sitFrustum.setFromProjectionMatrix(_sitProjScreen);

            const classCounts = {};
            let totalVisible  = 0;
            let darkCount     = 0;
            let hostileCount  = 0;
            let militaryCount = 0;

            const ships = window.aisShips;
            for (let i = 0; i < ships.length; i++) {
                const s = ships[i];
                if (!_sitFrustum.containsPoint(s.position)) continue;
                totalVisible++;
                const cls = s.userData?.class ?? 'UNKNOWN';
                classCounts[cls] = (classCounts[cls] || 0) + 1;
                if (s.userData?.isDark === true)      darkCount++;
                if (cls === 'HOSTILE')                hostileCount++;
                if (MILITARY_SIT.has(cls))            militaryCount++;
            }

            // Derive region from camera look-at target
            const { lon, lat } = _sceneToLonLat(controls.target.x, controls.target.z);
            const region = _detectRegion(lon, lat);

            // Same threat ladder as _tickDynamicStatus
            let threatLevel = 'LOW';
            if (militaryCount  >= 1) threatLevel = 'MODERATE';
            if (darkCount      >= 2) threatLevel = 'ELEVATED';
            if (hostileCount   >= 3) threatLevel = 'CRITICAL';

            return {
                region,
                totalVisible,
                totalAll:      ships.length,
                classCounts,
                darkCount,
                hostileCount,
                militaryCount,
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

    function animate() {
        requestAnimationFrame(animate);
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

        // RF distress beacons — expanding-ring animation + stale cleanup
        rfBeacons.tick(elapsed, camera.quaternion);

        // Calm starfield drift + twinkle
        starField.update(elapsed, delta);

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
        gfsUpperWindManager.update(delta);
        ibtracsManager.update(delta);
        gpsJammingManager.update(delta);
        wakeManager.update(elapsed);
        trailManager.tick();   // throttled GPU texture upload — every 3rd frame

        // ── Ionospheric / geomagnetic layers ─────────────────────────────────
        ionosphericLayers.update(elapsed, delta);
        birkelandLayers.update(elapsed);

        // ── Live data ticks ───────────────────────────────────────────────────
        aisManager.tick(delta);
        flightManager.tick(delta);

        // ── Selection ring ────────────────────────────────────────────────────
        selectionRing.tick(delta, elapsed);

        // ── Cluster LOD ───────────────────────────────────────────────────────
        clusterManager.tick(window.aisShips, camera, elapsed);

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
            const maxHist = ship.userData.class === 'FIGHTER' ? 40 : 20;
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

            // AWACS radar dish spin
            const radar = ship.getObjectByName('awacs_radar');
            if (radar) radar.rotation.y += 0.05;

            // Strobe blink
            const strobe = ship.getObjectByName('strobe_light');
            if (strobe) {
                strobe.visible = (Math.floor(elapsed * 4 + ship.userData.progress * 100) % 2 === 0);
            }

            // Submarine depth tether
            if (ship.userData.class === 'SUBMARINE') {
                if (!ship.userData.tether) {
                    const tGeo = new THREE.BufferGeometry().setFromPoints([
                        new THREE.Vector3(), new THREE.Vector3()
                    ]);
                    const tMat = new THREE.LineDashedMaterial({
                        color: 0x00ff88, dashSize: 0.5, gapSize: 0.5,
                        transparent: true, opacity: 0.6,
                    });
                    ship.userData.tether = new THREE.Line(tGeo, tMat);
                    scene.add(ship.userData.tether);
                }
                const p    = ship.position;
                const dist = Math.sqrt((p.x / MAP_WIDTH) ** 2 + (p.z / MAP_HEIGHT) ** 2);
                const surfY = -Math.pow(dist, 2) * 20.0;
                const tPos  = ship.userData.tether.geometry.attributes.position;
                tPos.setXYZ(0, p.x, p.y, p.z);
                tPos.setXYZ(1, p.x, surfY, p.z);
                tPos.needsUpdate = true;
                ship.userData.tether.computeLineDistances();
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
