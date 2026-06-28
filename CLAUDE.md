# VANGUARD1 — Claude Code Guide

Multi-domain 3D tactical intelligence map. Three.js + plain ES modules, no bundler.
Platform: browser, served locally. Entry point: `index.html` → `main.js`.

> **Read `memory/00-INDEX.md` first.** That folder is persistent memory ("the brain"):
> doctrine (the maritime OSINT cycle this codebase implements), standing decisions, scar
> tissue (gotchas), and how Jamal works. Read it at session start; update it at session end.

---

## Coordinate system

| Axis | Meaning | Range |
|------|---------|-------|
| X    | Longitude (east = +X) | −150 … +150 (MAP_WIDTH = 300) |
| Z    | Latitude via **Mercator** (south = +Z, north = −Z) | −150 … +150 (MAP_HEIGHT = 300) |
| Y    | Elevation / altitude (up = +Y) | terrain −5 … sky +550 |

All vessel/flight coordinates use `lonLatToScene()` in `aisManager.js` — Mercator, not linear.
The terrain grid (terrainWorker, continentWorker) uses linear XZ — slight mismatch at high latitudes is intentional.

---

## Module map

### Rendering pipeline
| File | Owns |
|------|------|
| `sceneSetup.js` | Renderer, camera, OrbitControls, post-processing chain |
| `terrainBuilder.js` | Point cloud (splat), ocean floor mesh, aquarium walls, country borders |
| `continentMesh.js` | High-res terrain mesh (land only), fades in below camera.y=25 |
| `waterManager.js` | Gerstner wave sea plane |
| `skyManager.js` | Sky shader (math only, mesh hidden), sun direction |
| `fogManager.js` | Post-process fog shader pass |
| `cloudManager.js` | Post-process cloud shader pass |
| `taaManager.js` | Temporal AA accumulation pass |
| `tileStreamManager.js` | Cesium Ion LOD tile terrain (streams in at camera.y < 200) |
| `dayNightManager.js` | Solar ephemeris, terminator line |

### Time & data sources
| File | Owns |
|------|------|
| `simClock.js` | Single source of sim time. **Managers must call `simClock.now()`/`.date()`, never `Date.now()`/`new Date()`, for anything time-of-world related.** Live mode = wall clock (default). Supports pause/scrub/rate. Emits `vg1:clockChanged`. `window.simClock` in DevTools. |
| `dataSource.js` | Pluggable AIS feeds: `SyntheticAISSource` (scenario JSON), `RecordedAISSource` (NDJSON replay), `CompositeSource`, `AISRecorder`. All emit AISStream-shaped messages into `aisManager.ingest()` — downstream cannot tell sources apart. Console API: `window.vg1Scenario` (main.js). Scenario files live in `scenarios/`. |
| `invariants.js` | Physics/logic invariant gate on every position report: IMPOSSIBLE_SPEED (reject — report does not move the vessel), EXCESSIVE_SPEED / SOG_MISMATCH / FUTURE_EVENT / STALE_EVENT / TIME_REGRESSION (flag). Dual timestamps: `vessel.lastEventTime` (when it happened, from msg `time_utc`) vs `vessel.lastSeen` (when we heard, sim time) — never conflate. Ledger: `window.vg1Invariants`. Emits `vg1:invariantViolation`. Tests: `node tests/invariants.test.mjs` — every new invariant needs a test that tries to fool it. |

### Data layers
| File | Owns |
|------|------|
| `aisManager.js` | Live AIS vessel objects, `lonLatToScene()`, `ingest()` entry point for all sources |
| `flightManager.js` | Live flight objects |
| `satelliteManager.js` / `instancedSatManager.js` | Satellite 3D objects |
| `satArcManager.js` | Satellite orbit arc lines |
| `submarineCables.js` | Cable network geometry |
| `portManager.js` | Port markers, LOD |
| `chokepointManager.js` | Chokepoint glyphs + flow data |
| `trailManager.js` | Vessel trail history lines |
| `wakeManager.js` | Wake particle effects |
| `navLightManager.js` | Running lights on vessels |
| `entityBuilder.js` | 3D vessel/aircraft model factories |
| `buildingManager.js` | OSM 3D building extrusion |
| `cityManager.js` | City terrain patches |

### Intelligence / UI
| File | Owns |
|------|------|
| `aiCopilot.js` | Anomaly detection, Claude API calls (`localhost:8787`) |
| `feedManager.js` | News/intel feed |
| `alertsManager.js` | Alert log and notifications |
| `sitrepManager.js` | Auto-generated SITREP |
| `watchlist.js` | Vessel watchlist (localStorage) |
| `uiController.js` | HUD panels, raycasting, search, alert zones |
| `layerManager.js` | Central layer on/off/opacity registry |
| `directorManager.js` | Cinematic camera director |
| `transitionManager.js` | Scene transition orchestrator |
| `contextCardManager.js` | First-encounter context tooltips |

### Space / geomagnetic
| File | Owns |
|------|------|
| `spaceWeatherManager.js` | Kp, AE, solar wind data fetching |
| `magneticFieldManager.js` | Magnetic field line geometry |
| `birkelandManager.js` | Birkeland current particle arcs |
| `ionosphericLayerManager.js` | Ionospheric slab geometry |
| `igrf.js` | IGRF magnetic field math (pure, no THREE) |

---

## Visual ownership — DO NOT change these without full context

These values were tuned manually. Changing them breaks the look of the map.
They are the most common source of accidental regressions.

### Post-processing (sceneSetup.js → main.js)
```
renderer.toneMappingExposure = 0.85   ← ACES S-curve tuned for this scene. Do not touch.
bloomPass strength baseline  = 0.25   ← Set in main.js animation loop. Rises to 0.55 at max threat.
bloomPass radius             = 0.4    ← Do not touch.
bloomPass threshold          = 0.95   ← Only very bright pixels bloom. Lowering this breaks everything.
```
`bloomPass.strength` is the only bloom property the animation loop writes to. All other bloom
properties are set once in `sceneSetup.js` and must not be changed elsewhere.

### Lighting (main.js animation loop — driven by dayFactor = sunElevation clamped to 0..1)
```
ambientLight.intensity = 4.0 + dayFactor * 0.5   ← High because PBR divides by π internally.
dirLight.intensity     = pow(dayFactor, 0.7) * 2.0
```
**Never hardcode a light intensity** — they are recalculated every frame from solar elevation.
Adding a new light? Keep its intensity below 0.5 or it will wash out the continent mesh.

### Point cloud / splat shader (terrainBuilder.js)
```
uBrightness  = 0.90   ← Land brightness multiplier. Lower = darker terrain.
uLandLift    = 0.28   ← Additive floor for shadowed land. Do not lower below 0.15.
uLandGamma   = 0.65   ← Shadow lift curve. 1.0 = no lift. Do not raise above 0.85.
uSaturation  = 2.10   ← Colour vibrancy. Do not exceed 2.5 or tropics go neon.
uAOTint      = (0.08, 0.04, 0.22)  ← AO shadow colour (indigo). Tunable via console.
```
These uniforms are on `window.splatCloud.material.uniforms` — tunable live from DevTools.
**Do not add any code that writes these uniforms outside terrainBuilder.js.**

### Water (waterManager.js)
```
waterUniforms.uSunDir       ← written ONLY by skyManager.js
waterUniforms.uSunElevation ← written ONLY by skyManager.js
water opacity = 0.85
```
The Gerstner wave parameters are hardcoded inside the GLSL string in `waterManager.js`.
Do not change waveA/B/C/D steepness or wavelength — they were tuned to look physically correct.

### Terrain LOD thresholds (camera.position.y)
```
camera.y > 25    → point cloud fully visible, continent mesh hidden
camera.y 25→15   → crossfade: point cloud fades out, continent mesh fades in
camera.y < 15    → continent mesh fully visible, point cloud hidden
camera.y < 200   → tile stream LOD begins loading (zoom level 6)
camera.y < 120   → zoom level 8 tiles
camera.y < 50    → zoom level 10 tiles
camera.y < 22    → zoom level 12 tiles
camera.y < 12    → zoom level 13 tiles
```
These thresholds are the seams of the LOD system. Changing one without changing the adjacent
ones creates a gap or double-draw zone.

---

## Performance rules

1. **Every new geometry** added to the scene costs draw calls. Use `instancedMesh` or merge
   geometry when adding more than ~20 objects of the same type.
2. **Every new post-processing pass** costs a full-screen texture sample per frame.
   The current chain is: Render → Bloom → Fog → Clouds → TiltShift×2 → Bokeh.
   Adding another pass will drop ~5 fps on integrated GPUs.
3. **The animation loop already calls 20+ manager `.update()` / `.tick()` methods per frame.**
   New managers must be fast — no DOM queries, no new geometry per frame, no synchronous fetch.
4. **Workers exist for a reason.** `terrainWorker.js` and `continentWorker.js` do heavy math
   off the main thread. New terrain/field calculations should follow this pattern.
5. **`new THREE.Vector3()` inside a loop** allocates GC pressure. Reuse scratch vectors
   declared at module scope.

---

## Common failure modes

### Water changes colour
Cause: Something changed `waterUniforms.uSunElevation` or the `color`/`emissive` on the
sea plane material. Only `skyManager.update()` should write water uniforms.

### Point cloud gets too bright / too dark
Cause: `ambientLight.intensity` was changed directly, or `uBrightness`/`uLandLift` was
modified. Check those four values first.

### Bloom explodes (entire scene white)
Cause: `bloomPass.threshold` was lowered below 0.90, or a new emissive material was added
with emissiveIntensity > 1.0. The bloom threshold is a hairpin — a tiny change to a bright
material will push it over the edge.

### FPS drops on map load
Cause: A new manager is creating geometry in its `update()` loop instead of once at init,
or a `new THREE.BufferGeometry()` is being allocated per frame. Profile with Chrome's
Performance tab — look for repeated GC pauses.

### Continent mesh visible at wrong zoom
Cause: The fade thresholds in `continentMesh.js update()` were changed. Thresholds must
stay paired: `CONTINENT_FADE_START=25`, `CONTINENT_FADE_END=15`. The point cloud uses the
inverse: `(camera.y - 10) / 15`.

---

## Architecture boundaries — what goes where

| You want to... | Right place |
|----------------|-------------|
| Add a new data layer (ships, planes, etc.) | New `*Manager.js`, register with `layerManager` |
| Add a new visual effect | New post-processing pass OR new `THREE.Points`/`Mesh` in its own manager |
| Add a new UI panel | `index.html` (CSS + DOM) + handler in `uiController.js` |
| Add a new config constant | `config.js` — use a namespace group (e.g. `export const MYMODULE = { KEY: value }`). Never hardcode in a manager. |
| Add country code for MMSI lookup | `aisCountries.js` — the MID_TO_COUNTRY table |
| Add a new space/geomagnetic layer | Follow pattern of `birkelandManager.js` — separate file, register with layerManager, listen to `vg1:layerChanged` |
| Communicate between managers | `window.dispatchEvent(new CustomEvent('vg1:...'))` — never import one manager into another |

---

## Known issues (do not attempt to fix without the full diagnosis)

1. **Continent mesh visible at far zoom** — the fade thresholds in `continentMesh.js`
   may have drifted from the point cloud's inverse thresholds. Investigate before changing
   any LOD values.

2. **Antarctica grey shape** — a flat grey, multi-faceted shape appears on the south edge
   of the map near Antarctica. Root cause previously diagnosed as two compounding issues in
   `terrainWorker.js` (a too-late-engaging `polarIce` ramp inside `whiteSuppression`, and no
   falloff treatment for the point cloud's exposed raw rectangular boundary after the aquarium
   walls were removed — see `terrainBuilder.js createSolidOceanFloor`). A fix was implemented
   and verified 2026-06-21, then fully reverted at Jamal's request the same day. Diagnosis
   notes still apply if revisiting — see `memory/decisions.md` and `memory/scar-tissue.md`.
