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
| `tileLandMask.js` | Baked land/water bitmask (`data/tile-land-mask.bin`, 341 KB, z3–z10, one bit per tile). `shouldFetch(zoom,tx,ty)` gates every tile fetch. **Fails open** — unloaded or absent, it answers "fetch," so the map can never go blank because an optional asset is missing. Rebuild with `python3 tools/build_tile_land_mask.py --report`. Tests: `node tests/tileLandMask.test.mjs` and `node tests/tileLandMaskCoverage.test.mjs`. Debug: `window.vg1TileMask`. |
| `dayNightManager.js` | Solar ephemeris, terminator line |

### Time & data sources
| File | Owns |
|------|------|
| `simClock.js` | Single source of sim time. **Managers must call `simClock.now()`/`.date()`, never `Date.now()`/`new Date()`, for anything time-of-world related.** Live mode = wall clock (default). Supports pause/scrub/rate. Emits `vg1:clockChanged`. `window.simClock` in DevTools. |
| `dataSource.js` | Pluggable AIS feeds: `SyntheticAISSource` (scenario JSON), `RecordedAISSource` (NDJSON replay), `ZoneRecordedSource` (mixed ship+plane zone captures), `CompositeSource`, `AISRecorder`. All emit AISStream-shaped messages into `aisManager.ingest()` — downstream cannot tell sources apart. Console API: `window.vg1Scenario` (main.js). Scenario files live in `scenarios/`. |
| `zoneRecorder.js` | Armed, zone-scoped ship+plane capture: circular zone (true haversine) + sim-time window, IDLE→ARMED→RECORDING→DONE, driven by simClock. Taps `aisManager.onRawMessage` + `flightManager.onRawAircraft`. STOP keeps the capture, DISARM discards. UI: ◎ ZONE RECORD section in the ARCHIVE panel. Console: `window.vg1ZoneRec`. Tests: `node tests/zoneRecorder.test.mjs`. |
| `invariants.js` | Physics/logic invariant gate on every position report: IMPOSSIBLE_SPEED (reject — report does not move the vessel), EXCESSIVE_SPEED / SOG_MISMATCH / FUTURE_EVENT / STALE_EVENT / TIME_REGRESSION (flag). Dual timestamps: `vessel.lastEventTime` (when it happened, from msg `time_utc`) vs `vessel.lastSeen` (when we heard, sim time) — never conflate. Ledger: `window.vg1Invariants`. Emits `vg1:invariantViolation`. Tests: `node tests/invariants.test.mjs` — every new invariant needs a test that tries to fool it. |

### Data layers
| File | Owns |
|------|------|
| `entityStore.js` | **Owner of the live entity collection** (vessels + real flights + sats). Stable-reference `all()`, typed `ships()`/`flights()`/`satellites()`/`byId()`, and the ONLY sanctioned mutators `add`/`removeById`/`removeRef`/`clear`. Replaced the load-bearing `window.aisShips` global. `window.aisShips` now aliases `entityStore.all()` as a read-only debug mirror. Tests: `node tests/entityStore.test.mjs`. |
| `aisManager.js` | Live AIS vessel objects, `lonLatToScene()`, `ingest()` entry point for all sources |
| `flightManager.js` | Live flight objects |
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
| `uiController.js` | HUD panels, raycasting, search, alert zones. Layer panel (`.lp-row`) lives here + in `index.html`. |
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
uBrightness  = 0.95   ← Land brightness multiplier. Lower = darker terrain.
uLandLift    = 0.28   ← Additive floor for shadowed land. Do not lower below 0.15.
uLandGamma   = 0.70   ← Shadow lift curve. 1.0 = no lift. Do not raise above 0.85.
uSaturation  = 1.30   ← "Natural Earth" palette (2026-07-13, Jamal's pick via live A/B).
                        Do not exceed 2.5 or tropics go neon; at 2.1 they read lime.
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
~~Do not change waveA/B/C/D steepness or wavelength — they were tuned to look physically correct.~~
**CORRECTED 2026-07-24.** That claim was false. The water vertex shader had never
compiled — `waveNormal` was referenced in the `<beginnormal_vertex>` hook, which three
emits *before* the `<begin_vertex>` hook where it was declared, so the material silently
failed and fell back. Nobody had ever seen these waves on screen, so they cannot have been
visually tuned. (This also explains the two unresolved waterManager entries in
memory/scar-tissue.md: an `onBeforeCompile` edit that "produced no effect and no console
output" wasn't a Three.js program-cache bug — the shader was simply never compiling, so no
edit to it could take effect.)

With the compile fixed the sea came back badly over-driven — whole oceans blown to white
specular. `updateDynamicWater()` now damps glitter / SSS / hex-grid by camera altitude
(calm at world view, full detail close up). The wave steepness/wavelength constants are
still untouched and are now genuinely **un**tuned: they are the first thing to adjust if
the sea looks wrong close up, not the last.

### Tile-point colour (config.js → TILESTREAM) — 2026-07-25
```
POINT_SATURATION   = 1.15   ← was 1.40. MUST stay ≤ SPLAT_SATURATION (1.30) or tiles read more
                              vivid than the base cloud they cross-fade into. Asserted in
                              tests/config.test.mjs.
POINT_WARM_TRIM    = 0.65   ← withholds the boost from orange/yellow-dominant points
POINT_SHADOW_DESAT = 0.55   ← removes chroma below the POINT_SHADOW_L (0.20) luminance knee
```
A **flat** chroma multiplier is the wrong shape here. Satellite terrain imagery is split by its
illuminant — sunlit ground warm, shadowed ground lit by blue skylight — so a uniform boost
amplifies that split instead of surface colour: warm ground goes neon gold *and* shadow goes teal,
simultaneously. That was the live-reported "land mass colors look off" (2026-07-25), and it was the
**third** appearance of a 1.4× boost already fixed twice elsewhere (IBTrACS `categoryColor`
2026-06-20, `SPLAT_SATURATION` 2026-07-13) and never propagated here. If you change a saturation
value, grep every other surface with the same knob and fence them in the same commit.

`elevToColor()` in `tilePointsBuilder.js` is **not a biome map** and must stay low-chroma (≤0.26,
asserted). Elevation predicts treeline and snowline; it does not predict whether 900 m is Sahara or
Bavaria. The old ramp hit chroma 0.460 and painted every montane region desert-ochre. Biome colour
comes from the imagery via `PHOTO_BLEND`. The ramp must also stay C0-continuous at band boundaries
(a step draws a contour line around all terrain at that altitude) and monotonic in luminance.

### Land / water thresholds (config.js → TILESTREAM) — 2026-07-25
```
LAND_MARGIN_M       =  0   ← elevation at/above which the DEM says LAND and the tile
                             builder may draw points. Sea level. Making this negative
                             paints continental shelves as ground (at −20 m it covered
                             13.4% of the Sunda box's ocean area in land-coloured dots).
SHORELINE_EPSILON_M = -5   ← how far below sea level a Cesium QM triangle may sit and
                             still count as coastal. This absorbs quantised-mesh height
                             noise at the waterline. It is an error bar, NOT a coastal
                             band — do not grow it to fix a coastline gap.
```
**Depth is not land.** These two constants were one −20 m value doing both jobs, and the
same confusion in `_isPureOceanTile` (−60 m) both over-fetched every shelf and skipped the
tiles containing 12 of 17 real islands sampled. Land/water is now answered by the baked
`tileLandMask`, not by a depth threshold — see memory/scar-tissue.md before reintroducing one.

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
| Add a new data layer (ships, planes, etc.) | New `*Manager.js` exposing `setVisible(on)`; add a `.lp-row[data-layer="…"]` in `index.html` and a `case` in `main.js`'s `layerToggle` handler. If the layer produces per-entity 3D objects that others must see, register/read them via `entityStore` (`add`/`removeById`/`removeRef`, `all`/`ships`/`flights`/`byId`) — never a new `window.*` array. |
| Add a new visual effect | New post-processing pass OR new `THREE.Points`/`Mesh` in its own manager |
| Add a new UI panel | `index.html` (CSS + DOM) + handler in `uiController.js` |
| Add a new config constant | `config.js` — use a namespace group (e.g. `export const MYMODULE = { KEY: value }`). Never hardcode in a manager. |
| Add country code for MMSI lookup | `aisCountries.js` — the MID_TO_COUNTRY table |
| Add a new space/geomagnetic layer | Follow pattern of `birkelandManager.js` — separate file, add a `.lp-row` + `layerToggle` case in `main.js`. |
| Communicate between managers | See the **Dependency policy** below — it's tiered, not "events only". |

> **Layer toggling (2026-07-23):** there is NO central layer registry at runtime. The
> old `layerManager.js` (a `register()`/`vg1:layerChanged` registry) was **dead code** —
> never imported by `main.js`, nothing dispatched its event — and was removed. The real,
> shipped path is: `.lp-row[data-layer]` rows in `index.html` → a `layerToggle` CustomEvent
> → a `switch` in `main.js` that calls the owning manager's `setVisible(on)`. `layerCoordinator.js`
> is unrelated (terrain-detail LOD hand-off, not on/off state). Some managers
> (`birkeland`/`ionospheric`/`lightning`) still listen for `vg1:layerChanged` and/or probe
> `window.layerManager` — those branches are inert (nothing sets either) and are the honest
> TODO if those geomagnetic layers ever need real toggles; wire them to `layerToggle` like the rest.

---

## Dependency policy — how modules may reach each other (2026-07-23)

The old rule ("never import one manager into another — use events") was aspirational,
and the code already votes against it: ~14 manager→manager imports exist and *state*
travels through `window.*` globals, not events. Here is the real, tiered policy. Prefer
the lowest tier that works.

**Tier 1 — CustomEvents (`vg1:*`) for cross-domain *notifications*.** Use when a change
in one domain should let unrelated domains react and the sender should not know or care
who listens (`vg1:clockChanged`, `vg1:invariantViolation`, `vg1:selectVessel`,
`layerToggle`). 21 `vg1:*` events exist. This is for "something happened," **not** for
"give me the current value."

**Tier 2 — direct `import` for a true build dependency inside one pipeline.** Allowed
when module A cannot construct its geometry without B, and the two are in the same
rendering pipeline. This is already the shipped reality and it's fine:
`skyManager → waterManager`, `waterManager`/`tileStream`/`cityManager`/`buildingManager
→ terrainBuilder`. Rule of thumb: if the dependency is a compile-time "needs the mesh,"
import it; if it's a runtime "wants to be told when," use an event. Do **not** create
import cycles.

**Tier 3 — `window.*` for DEBUG HANDLES ONLY, never as the data path.** `window.simClock`,
`window.vg1Invariants`, `window.splatCloud`, etc. exist so you can poke them from DevTools.
That is a legitimate use. What is **not** legitimate is load-bearing shared *state* on
`window`. The former worst offender — `window.aisShips`, a raw mutable array read by 8
modules with no owner or schema — was **fixed 2026-07-23**: `entityStore.js` now owns that
collection, all readers import it, and `window.aisShips` survives only as a read-only debug
mirror of `entityStore.all()`. **Do not add new load-bearing globals.** When you need shared
current-state, give it an owning module with getters (follow `entityStore.js`) and keep any
`window.*` alias as a debug mirror only.

Quick test when adding a dependency: *notification* → Tier 1 event. *Needs the object to
build itself* → Tier 2 import. *Wants to read current shared state* → owning module, not a
new global.

---

## Known issues (do not attempt to fix without the full diagnosis)

1. **Continent mesh visible at far zoom** — the fade thresholds in `continentMesh.js`
   may have drifted from the point cloud's inverse thresholds. Investigate before changing
   any LOD values.

2. **Antarctica grey shape — FIXED 2026-07-13** (three stacked causes: ice-shelf holes
   exposing the sea plane, desert warm-term bleed via miscalibrated mercator-normalized
   latitude gates, late polarIce ramp). See memory/scar-tissue.md for the latitude-conversion
   trap and memory/decisions.md for the full diagnosis chain. The 2026-06-21 theory addressed
   only the smallest of the three causes — which is why that fix appeared not to work.
