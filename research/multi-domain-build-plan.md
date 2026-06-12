# VANGUARD1 — Multi-Domain Build Plan + Innovation Extensions

*Research memo · 2026-06-06 · audience: VANGUARD1 implementation decisions over the next ~12 working sessions*

This memo sits on top of `multi-domain-survey.md` (prior-art + data catalog + Y-axis decision) and `3d-space-innovations.md` (what the empty 3D space is for). Both are assumed as context. Where they made calls, this document does not re-litigate them. It uses them.

The shape of this doc: **build it**, **share what should only be built once**, **find the value in cross-domain correlation**, **layer creative ideas on top**, **sequence the work**, **flag the traps**.

---

## Section 1 — How to actually build the multi-domain platform

The maritime domain is already shipped. The other three (air, space, subsurface) are the new work. Each follows the **gfsWindManager pattern**: one self-contained `*Manager.js` module that owns its fetch loop, cache, geometry, layer registration, and update tick. No cross-module imports between managers — communication goes through `window.dispatchEvent('vg1:...')` and the layerManager singleton.

The Y-axis allocation from `multi-domain-survey.md` is the contract every manager honors. Don't override altitudes inside a manager — register a deck via `altitudeDeckManager.addDeck()` and lift the manager's entities to that Y.

### 1.1 Air domain — `airTrafficManager.js`

**Why it goes second after maritime.** Air is the lowest-friction domain to add: positions are real-time, the deck (cruise, Y=22) is already drawn, and the audience instinctively understands what an aircraft over a vessel means. The existing `flightManager.js` is a starting skeleton (airplanes.live polling) but it does not implement instancing, the OAuth2 flow, or trail integration — those have to be added.

**File structure.**

```
airTrafficManager.js
├── lonLatAltToScene(lon, lat, baroAltM)        — Y from altitude-deck formula
├── class AirTrafficManager
│   ├── init()                                  — start OpenSky polling + WebSocket fallback
│   ├── _fetchStateVectors()                    — proxy-mediated OpenSky /states/all
│   ├── _handleStates(states)                   — diff against last frame, fire onAircraftNew/Update/Remove
│   ├── _writeInstanceMatrices()                — write to InstancedMesh per frame
│   ├── setVisible(on)                          — layer toggle
│   ├── getAircraftNear(lon, lat, nm)           — cross-domain query API
│   ├── getAircraftAt(time)                     — historical replay (Section 2)
│   └── update(delta)                           — interpolate positions, blink lost-signal
└── exports: AirTrafficManager, lonLatAltToScene
```

**Data wiring.** OpenSky `https://opensky-network.org/api/states/all` via `localhost:8787/opensky/states` proxy. Anon access still works as of the survey but is deprioritised; register a free OpenSky account, store `client_id`/`client_secret` in the proxy's `.env`, exchange for a Bearer at `/opensky/token`, cache 30 min. Browser fetches `localhost:8787/opensky/states?bbox=lamin,lamax,lomin,lomax` and gets back `{ time, states: [...] }`. Cadence: 5 s with auth, 10 s without. Bounding-box requests when zoomed in (camera.y < 80) to avoid pulling 8k aircraft every tick.

**Visualization.** `THREE.InstancedMesh` of a small dart geometry (cone + delta wing — ~30 verts, no shading), capacity 5000. Heading rotates per-instance via `mesh.setMatrixAt(i, m)` where `m = makeRotationY(-heading) · makeTranslation(x,y,z)`. Lost-signal aircraft (no update in 30s) pulse alpha for 10s then drop. Ground-state aircraft (`on_ground=true`) snap to Y=2.5 (just above runway terrain) with a different color.

**Per-aircraft intel layer — beyond positions.**

| Source | What it adds | Endpoint |
|---|---|---|
| OurAirports `airports.csv` | Origin/destination labels, runway alignment | static CSV |
| Hexdb.io `/api/v1/aircraft/<icao24>` | Owner/operator, type, registration history | per-aircraft REST, CORS-friendly |
| ADS-B Exchange operator DB | Military/government/sanctioned-operator tagging | mirrored CSV |
| `aiCopilot.js` | News mentions of tail number, operator, type | already integrated for vessels |
| OpenStreetMap `aeroway=aerodrome` Overpass | Military airfields, restricted airports | Overpass API |

These attach to the aircraft entity (Section 2's entity registry) — when an analyst clicks a dart, the panel shows owner, last 7 flights from Hexdb, recent news mentions of the tail number, and military-airfield proximity.

**Deck integration.** Register `addDeck({ id: 'cruise', label: 'FL350 · 10–12 km', y: 22, ... })` and `addDeck({ id: 'ga', label: 'FL100 · 3 km', y: 18, ... })`. The 250 mb wind deck is already at Y=22 — both share the deck; the cruise deck is the dominant visual.

**Performance.** Single InstancedMesh keeps draw calls flat. 5000 instances × 30 verts = 150k tris — well within budget alongside the existing scene. The hot path is `setMatrixAt` × 5000 per frame; reuse one `THREE.Matrix4` scratch (no `new` in the loop — the CLAUDE.md rule). Interpolate between OpenSky polls so movement is smooth at 60 fps even though data is 5–10 s.

**Testing.** Manual: toggle the layer with no OpenSky token → demo data path renders 40 simulated cruise aircraft so the layer is never empty. With token → live count appears in the HUD status bar. Automated: a `agents/air-traffic-smoke.js` script that polls the proxy and asserts >100 aircraft when daylight is over CONUS or Europe.

### 1.2 Space domain — `satelliteTLEManager.js` (LEO+MEO) and `geoRingManager.js` (GEO)

**Why split into two managers.** LEO is fast-moving propagation work (SGP4 every second per visible satellite). GEO is essentially a static ring at Y=88 — different geometry, different update rate, different camera-mode visibility. Keeping them separate honors the gfsWindManager pattern (one manager = one data semantic).

**File structure for the LEO/MEO manager.**

```
satelliteTLEManager.js
├── import satellitejs from './vendor/satellite.min.js'  — SGP4 propagator
├── const TLE_GROUPS = ['stations','starlink','gps-ops','active-military', ...]
├── class SatelliteTLEManager
│   ├── init()                              — fetch all groups, cache 6 h
│   ├── _propagateAll(jsDate)               — SGP4 → ECI → ECEF → geodetic → scene
│   ├── _writeInstances()                   — single InstancedMesh of glow sprites
│   ├── _buildGroundTrack(satId, minutes)   — pre-compute polyline for visible LEO
│   ├── setGroupVisible(group, on)          — fine-grained layer toggles
│   ├── getSatellitesOverlapping(lon, lat, radiusKm, time)  — cross-domain query
│   ├── getSatellitePassesOver(lon, lat, fromTs, toTs)      — imaging-pass query
│   └── update(delta)                       — propagate at 1 Hz, ground tracks at 0.2 Hz
```

**Data wiring.** CelesTrak `gp.php?GROUP=<group>&FORMAT=json` per group. Cache each group's TLE set in localStorage with a 6 h TTL. Vendor `satellite.min.js` (satellite-js MIT, ~75 KB) into `vendor/` — no bundler, just a `<script>` tag preceding `main.js`. Propagation runs on a Web Worker (`satWorker.js`) so the main thread sees a `postMessage` of `{ id, lon, lat, altKm }` per satellite at 1 Hz. This follows the existing terrainWorker / continentWorker pattern that CLAUDE.md calls out.

**Visualization.**

- LEO satellites (alt < 2000 km) → InstancedMesh of glowing point sprites at Y=51, colored by group (stations=cyan, starlink=white, military=red, weather=teal).
- MEO (2000–20000 km) → Y=70, fewer points, slightly larger.
- GEO is `geoRingManager.js` — a `THREE.Line` ring at Y=88 around the equator (Z=0) with named sprites at the longitudes of major comms/weather sats.
- Ground tracks: per-satellite `Line2` pre-computed for the next 90 min, faded by time-to-now. Only render ground tracks when (a) the satellite is selected or (b) camera.y > 60 (space mode).
- Orbit arcs above the deck: a thin curve from each LEO point up to a stylized apoapsis marker — purely decorative but it sells the verticality.

**Per-satellite intel layer.**

| Source | What it adds | Endpoint |
|---|---|---|
| CelesTrak SATCAT | Owner, launch date, decay date, orbit type | `satcat.php?CATNR=<id>&FORMAT=json` |
| SpaceTrack (proxy) | Detailed catalog, conjunction warnings | `space-track.org/basicspacedata/...` via proxy |
| N2YO transits | Visual passes over a lat/lon | proxy required |
| Wikipedia / aiCopilot | "What is COSMOS 2558 known for?" | already integrated |
| Launch Library 2 | Upcoming launches, payload manifests | `ll.thespacedevs.com/2.2.0/launch/upcoming/` CORS-friendly |
| CelesTrak `last-30-days` | Recent launches, recent decays | `gp.php?GROUP=last-30-days` |

Click a satellite, the panel shows owner, mission, launch date, next pass over a watched vessel, and any conjunction warnings. This is the *intel* part of the space domain — the part that makes it more than a CelesTrak demo.

**Deck integration.** Register LEO (Y=51), MEO (Y=70), GEO (Y=88) as decks. These auto-fade at top-down per the existing `tiltVisibility()` curve — they only appear when the analyst tilts toward space view.

**Performance.** SGP4 on the main thread for 8000 Starlinks would freeze the page. The worker pattern is mandatory. Pre-computing the next 90 min of ground track for every visible LEO every 5 min is ~30 ms of worker time — invisible to the user. Only render ground tracks for selected/watchlisted satellites by default.

**Testing.** Predict ISS position via TLE for a known timestamp, assert lon/lat within 50 km of NASA's published ephemeris. Visual: ISS passes overhead in real time and the ground track sweeps across the map every ~93 min.

### 1.3 Subsurface domain — `cableManager.js`, `bathymetryManager.js`, `subsurfaceFeedManager.js`

**Why three managers.** Cables are static geometry with rich intel. Bathymetry is a static height field affecting the ocean floor mesh. Subsurface events (cable anomalies, sonar hits, submarine sightings) are a feed. Each lives in its own file.

**File structure.**

```
cableManager.js
├── async _fetchGeoJSON()                — TeleGeography cable-geo + landing-point-geo
├── _buildCableLines()                   — LineSegments2 per cable, color by consortium
├── _renderLandingPoints()               — Sprite per landing station
├── setCableStress(cableId, level)       — recolor a single cable for events
├── getCablesNear(lon, lat, km)          — cross-domain query
└── update(delta)                        — pulse stressed cables, ambient flow shimmer

bathymetryManager.js
├── _loadGEBCO()                          — once at init, on a worker
├── _displaceOceanFloor()                 — modify existing ocean-floor-mesh vertices
└── (no per-frame update — static)

subsurfaceFeedManager.js
├── _pollOceanNetworks()                  — Ocean Networks Canada cabled hydrophones
├── _pollCableNews()                      — aiCopilot RSS scan for "cable cut"
├── _emit(event)                          — dispatch vg1:subsurfaceEvent
└── update(delta)                         — fade event glyphs
```

**Data wiring.**

- TeleGeography: `https://www.submarinecablemap.com/api/v3/cable/cable-geo.json` + `/landing-point/landing-point-geo.json`. CORS-clean, ~2 MB, cache 7 days.
- GEBCO via Open Topo Data: batched `https://api.opentopodata.org/v1/gebco2020?locations=lat,lon|lat,lon...` — sample on a coarse grid (1° spacing in deep ocean, 0.25° on continental shelves), bake into a 2048×1024 height texture, displace ocean floor vertices.
- Ocean Networks Canada: free token, `https://data.oceannetworks.ca/api/scalardata` — hydrophone amplitude spikes are the closest thing to "live undersea events."
- News scan for cable cuts: this is the aiCopilot pattern already in use — keyword search "submarine cable cut" against feed sources, emit synthetic events at the cable's centroid.

**Visualization.**

- Cables at Y = −2 (just under sea surface so they read against bathymetry without intersecting it). Thin `LineSegments2` lines, colored by consortium (SEA-ME-WE = orange, FLAG = teal, etc.). Width = log(fiber-pairs) if the data exposes it.
- Stressed/anomaly cables pulse in red, width animates 2.5× → 1× at 0.5 Hz.
- Landing points as small ground-truth squares with a thin vertical line connecting to the cable centroid — analysts can see "here's the landfall."
- Bathymetry: the existing ocean floor mesh gets a displacement; deep trenches (Mariana, Tonga) become visible when camera tilts and water opacity is reduced.
- Submarines (if a feed materializes — STRATCOM mandates rule out live boomer tracking, so this stays simulated) as silhouettes at Y = −4 to −8, no transponder, single source of truth from manual analyst input.

**Per-cable intel layer.**

| Source | What it adds |
|---|---|
| TeleGeography "Industry" reports | Consortium, RFS date, length, fiber-pair count |
| Submarine Telecoms Forum | Incident reports, planned maintenance |
| TeleGeography news desk | Cable cut events with date |
| aiCopilot RSS | News mentions of named cables |
| Overpass `man_made=cable_landing_station` | OSM-verified landing-point details |

**Deck integration.** Subsurface deck at Y = −2 (cable plane). Bathymetric floor at Y = −12 (visualized as the displaced ocean floor mesh itself). Both fade in only when camera.y < 60 and water layer is dimmed (a new toggle "Reveal subsurface" that drops water opacity 0.85 → 0.25 for inspection).

**Performance.** TeleGeography GeoJSON has ~470 cables totaling ~50k line vertices. Merge into one or two `LineSegments2` per color band — single draw call. Bathymetry displacement happens once at startup on a worker; the textures get reused as long as the ocean floor mesh doesn't change. Subsurface event glyphs are at most a handful — no perf concern.

**Testing.** Visual smoke: TPE cables (Trans-Pacific Express) should run from California to Japan and dive deep through the Mariana area; the displacement should show that. Cable-cut simulation: dispatch `vg1:subsurfaceEvent` with a known cable ID, the line should pulse for 10s.

---

## Section 2 — Shared infrastructure that should be built ONCE

The domains will collapse into one-off siloes if each reinvents time, identity, intel, and correlation. Build these five primitives **before** wiring the air domain, not after. Phase 0 of Section 5 is exactly this work.

### 2.1 `timeScrubber.js` — global time axis

The single most leveraged piece of infrastructure in the entire roadmap. Without it, "multi-domain replay" is a brochure phrase.

```
class TimeScrubber {
    constructor() {
        this.mode      = 'LIVE';        // 'LIVE' | 'HISTORICAL' | 'PAUSED'
        this.nowTs     = Date.now();    // current "scene time" — what every manager reads
        this.realTs    = Date.now();    // wall clock
        this.rate      = 1.0;           // playback rate; negative = reverse
        this.windowMs  = 7 * 86400e3;   // history depth (7 days default)
    }
    setMode(mode)                  // emits vg1:timeModeChanged
    seek(ts)                       // jump to absolute time; emits vg1:timeSeek
    setRate(r)                     // 0.25, 0.5, 1, 2, 4, 8, 16x; emits vg1:timeRateChanged
    tick(delta)                    // called by main loop; advances nowTs by rate*delta
    isLive()                       // managers check this in their update tick
    getNow()                       // canonical current time for all managers
}
export const timeScrubber = new TimeScrubber();
```

Every manager's `update(delta)` reads `timeScrubber.getNow()` instead of `Date.now()`. In LIVE mode the two are identical. In HISTORICAL mode, managers look up positions from their replay buffer rather than the live feed. Managers that don't have a replay buffer (the wind field, decks) ignore time mode entirely — they just always show "now."

The UI is a thin bar at the bottom of the screen with a draggable handle, rate buttons (1/4×, 1/2×, 1×, 2×, 4×, 8×), and a "RETURN TO LIVE" pulse. Visually inspired by Minority Report's drag-through-air time scrub from the prior research — it has a direction, you walk along it.

Persistence: scrubber state is *not* saved across sessions; refresh always boots to LIVE. Saving past-time state on refresh would confuse analysts coming back to the tool.

### 2.2 `entityRegistry.js` — cross-domain entity interface

Every domain's manager today owns its own map of entities. The aiCopilot already needs to query "is there a vessel here, an aircraft here, a satellite here?" Today that means it imports three managers. That's the import-spaghetti CLAUDE.md tells us to avoid.

```
class Entity {
    id              // domain-prefixed: 'ais:211461430', 'air:a8d3e1', 'sat:25544'
    domain          // 'maritime' | 'air' | 'space' | 'subsurface'
    kind            // 'vessel' | 'aircraft' | 'satellite' | 'cable' | 'submarine'
    lon, lat, y     // current scene position
    headingDeg      // optional
    speedKt         // optional, in domain-appropriate units
    label           // display name
    flag            // ISO country code (vessels, aircraft); null otherwise
    operator        // owner string (sats, aircraft)
    classification  // tags: ['MILITARY','SANCTIONED','DARK_VESSEL','LOITERING']
    lastUpdateTs
    sourceManager   // which manager owns this entity (for callbacks)
    intel           // { news:[], events:[], dossier:{} } — populated by feed manager
}

class EntityRegistry {
    upsert(entity)                          // managers call this; emits vg1:entityChanged
    remove(id)                              // emits vg1:entityRemoved
    get(id)
    near(lon, lat, km, opts={domains, kinds, classifications})
    inBbox(lonMin, latMin, lonMax, latMax, opts)
    inAltitudeBand(yMin, yMax, opts)
    all(opts)
}
export const entityRegistry = new EntityRegistry();
```

Each manager mirrors its entities into the registry. Cross-domain consumers (aiCopilot, the correlation engine, vesselTab, the dossier extensions in Section 4) query the registry, never the managers. This is the Gotham-Gaia pattern from the survey: *the map is a projection of the ontology, not the source of truth.*

### 2.3 `intelFeedManager.js` — unified news + intel pipeline

Today `aiCopilot.js` does vessel-targeted news scanning. Once aircraft, satellites, and cables also need news mentions, the right answer is a single pipeline that takes an entity and returns intel.

```
class IntelFeedManager {
    register(source)                        // { id, kind, fetch(), match(entity, item) }
    pollAll()                               // fans out fetches, normalizes results
    intelFor(entityId, opts)                // returns { news, events, dossier }
    intelNear(lon, lat, km, opts)           // returns intel attached to *any* entity near a point
    on(eventName, cb)
}
```

Sources at launch:

- aiCopilot existing RSS scan → `kind: 'news'`
- Sanctions lists (OFAC SDN, UK OFSI, EU consolidated) → `kind: 'sanctions'`, matched by entity name/IMO/MMSI
- Wikipedia summary lookup → `kind: 'dossier'`, matched by entity name
- Marine Notices / NOTAM / NOTMAR scan → `kind: 'advisory'`, matched by lon/lat
- IBTrACS storm proximity → `kind: 'weather-event'`, matched by lon/lat

The registry calls `intelFeedManager.intelFor(entity.id)` on selection. Result is cached in `entity.intel`. The dossier panel renders it generically — same component for vessels, aircraft, satellites.

### 2.4 `correlationEngine.js` — cross-domain pattern detection

This is the brain. It subscribes to entityRegistry events and the time scrubber, runs rules across domains, and emits `vg1:correlationDetected` events that the UI surfaces as alerts.

```
class CorrelationEngine {
    addRule(rule)                           // { id, label, domains, window, fn }
    evaluate()                              // called at 0.5 Hz
    on(eventName, cb)
    getActive()                             // currently triggered correlations
    explain(correlationId)                  // text for analyst panel
}
```

The seed rules (more in Section 3):

- **aircraftLoiterOverVessel**: aircraft circling (turn rate > X) within N nm of a watchlisted vessel for > T minutes.
- **satelliteImagingOverDarkRendezvous**: a passing imaging-sat (Earth-obs group) within ground-track footprint of a dark-vessel rendezvous within ± 5 min of the rendezvous start.
- **cableAnomalyWithSurfaceAnchor**: a subsurface cable event (news, hydrophone) within K km of an anchored vessel in the last 6 h.
- **multiDomainChokepointPressure**: > N abnormal events of any kind within a 200 km radius of a known chokepoint in the last 24 h.

Rules are pure functions of `(entityRegistry, timeScrubber.getNow())`. They can be authored by hand or generated by aiCopilot suggesting hypotheses for analysts.

### 2.5 `geoCorrelation.js` — spatial-temporal nearest-neighbor primitive

The thing every rule and every dossier query needs: "what entities of any kind were within X km of (lon,lat) at time T?" Today this would require scanning every manager. The right answer is one spatial index, updated as the registry changes.

```
class GeoCorrelation {
    near(lon, lat, km, atTs, opts)          // returns entities near a point at a time
    along(polyline, km, atTs, opts)         // for cable corridors, ground tracks, flight legs
    intersect(polylineA, polylineB, opts)   // detect crossings, important for cross-domain
    timeWindow(entityId, span)              // recall an entity's trajectory in a window
}
```

Internally: a moving grid index keyed by (lon-bin, lat-bin) of all live entities, plus per-entity ring buffers of position history (lean on the existing `trailManager` ring buffer — it's already a near-perfect substrate; just expose a read API). Time-stamped position lookups become O(1) per entity.

### 2.6 `cameraMode.js` — scale-aware camera presets

The survey already specified hotkeys 1/2/3 for Maritime/Air/Space. Generalize into a registry of named modes so each new domain can register its own and the camera-mode panel auto-populates.

```
class CameraModeManager {
    register(mode)                          // { id, label, hotkey, target, position, polarMin, polarMax, durationMs }
    setMode(id)                             // animates via transitionManager.js
    current()                               // emits vg1:cameraModeChanged
}
```

Seed modes: `maritime` (Y=80, top-down), `air` (Y=120, 45° pitch), `space` (Y=400, 70° pitch, polarMax relaxed to look up), `subsurface` (Y=40 pitched at 70° downward, water opacity dropped). The mode emits an event; managers can respond by raising/lowering opacity (subsurface drops water; space dims ground clouds).

---

## Section 3 — Where multi-domain cross-correlation becomes the value

The pitch isn't "we show vessels and aircraft." Anyone shows both. The pitch is *we make questions answerable that involve all of them at once*. These twelve patterns are the questions VANGUARD1 should make trivial to ask. Each describes the analyst question, the data correlation required, the visual treatment, and why single-domain tools fail at it.

### 3.1 Did this aircraft loiter over a vessel of interest?

**Question.** A patrol aircraft is over the Strait of Hormuz. Is it shadowing a specific tanker?

**Correlation.** Aircraft trajectory turn-rate + ground-speed pattern (loitering) ∩ entity registry near() ∩ vessel watchlist. Time window: rolling 30 min.

**Visual.** Aircraft dart sprouts a downward translucent cone showing its ground footprint at its altitude. When the cone intersects a watchlisted vessel for > 5 min, both glow amber and a thin tether line connects them. Tether grows thicker the longer the loiter persists.

**Why painful in single-domain.** Maritime tools see vessels but don't tell you what's overhead. Flight trackers see aircraft but don't know which surface targets matter. Joining them by hand means two windows and a stopwatch.

### 3.2 Which satellites had imaging passes over a dark-fleet rendezvous?

**Question.** Two tankers met in the South Atlantic, both AIS-dark for 4 hours. Did anyone get a picture?

**Correlation.** Dark rendezvous event (existing aisManager logic) → time window → for each imaging-sat (Earth-obs group), did its ground track plus swath width intersect the rendezvous point during the window?

**Visual.** A glowing "tasking column" rises from the rendezvous point. Satellites that passed overhead during the window are highlighted with their ground tracks drawn in over the rendezvous. A small badge on each: "PLANET 11:42 UTC", "SENTINEL-2 12:08 UTC" — the analyst then knows which imagery to request.

**Why painful in single-domain.** This is the *exact* job of Section 7-style space-tasking tools (UDL, Maxar tasking), which are gated to vetted users. VANGUARD1 can do the *pre-task* hypothesis for free — telling the analyst which scenes are worth asking for.

### 3.3 Is this cable anomaly correlated with surface activity?

**Question.** Hydrophone amplitude on the SEA-ME-WE-5 cable spiked at 03:14 UTC. Was anything on the surface nearby?

**Correlation.** Subsurface event → geoCorrelation.along(cable, 5km, eventTs) → returns vessels within the cable corridor in the window. Filters by "anchoring" or "loitering" classification.

**Visual.** The cable pulses red at the anomaly point. A vertical pillar rises through the water column; surface vessels within the corridor at the anomaly time are lifted off the surface into the pillar, displaying their AIS gaps and headings.

**Why painful in single-domain.** Cable-monitoring tools (TeleGeography, NEC) don't have AIS. AIS tools don't show cable corridors. The 2023 Baltic incident reporting took weeks of by-hand cross-referencing.

### 3.4 What's the intel narrative around this chokepoint over time?

**Question.** The Strait of Hormuz over the last 7 days — what happened?

**Correlation.** All domains + time scrubber + intelFeedManager.intelNear(chokepoint, 200km, last 7 days). Aggregate into a daily timeline of events.

**Visual.** Vertical event pillar at the chokepoint (the prior research's #7 idea, generalized cross-domain). Each domain gets its own color band on the pillar; events at correct timestamps. Scrub time → events brighten as the cursor passes them.

**Why painful in single-domain.** Every domain has its own time scale and event log. The cross-domain narrative requires a human to manually splice four logs.

### 3.5 Did this vessel's predictive cone intersect a satellite ground track?

**Question.** This sanctioned tanker's 24-hour forecast cone — does any imaging satellite pass through it?

**Correlation.** Predictive cone (prior research #2) ∩ pre-computed satellite ground tracks for next 24 h. Time-resolved intersection.

**Visual.** The cone gains striped overlays where ground tracks intersect it, each labeled with the satellite name and pass time. The analyst sees "tomorrow at 14:22, SENTINEL-1 will overfly the 70% likelihood envelope."

**Why painful in single-domain.** Trajectory prediction is maritime work. Orbital pass prediction is space work. The intersection has been a multi-person spreadsheet workflow.

### 3.6 Which dark vessels are operating in GPS-jammed zones?

**Question.** GPS jamming is active over the Black Sea. Which surface vessels are AIS-spoofing within it?

**Correlation.** gpsJammingManager zones ∩ AIS spoofing detector (existing in aisManager) ∩ entity classification = DARK_VESSEL.

**Visual.** Jamming zones become tall translucent red columns rather than flat discs (their normal mode). Dark vessels inside light up with a red corona. A side-panel widget enumerates the matches.

**Why painful in single-domain.** GPS jamming is an EW concern (no AIS context). Dark-vessel hunting is a maritime concern (no EW context).

### 3.7 Which aircraft diverted around a forming cyclone — and which didn't?

**Question.** IBTrACS shows a Cat-3 building over the Bay of Bengal. Which scheduled flights diverted, and which are still on path?

**Correlation.** Cyclone track + cyclone wind radius → all aircraft state vectors → which are still inside the wind radius and which have diverted? Compare flight plan (from OpenSky callsign or FlightAware) to actual track.

**Visual.** Cyclone gets a hatched "exclusion volume" extruded upward into the cruise deck. Aircraft inside or near it color by deviation: green = diverted (deviation > 50 nm from expected great-circle), amber = approaching, red = inside the volume.

**Why painful in single-domain.** Weather tools don't track flight diversions. Flight trackers don't model storm exclusion volumes. The "is this aircraft in danger?" answer needs both.

### 3.8 Is this submarine cable's traffic anomaly correlated with surface anchor drift?

**Question.** TeleGeography reports a fiber-pair drop on the cable between Mumbai and Marseille. Were any anchored vessels nearby in the prior 48 h?

**Correlation.** Cable event + geoCorrelation.along(cable, 10 km, last 48 h) ∩ entity classification = ANCHORED (existing in aisManager) ∩ entity speed < 1 kt.

**Visual.** The cable's segment fades red where the fault was. A timeline strip beneath the chart shows vessels that visited the corridor; clicking one zooms to its trajectory in time.

**Why painful in single-domain.** Cable operators monitor cables. Maritime watchstanders monitor vessels. The 2024 Red Sea Houthi cable cuts ran through this exact workflow gap.

### 3.9 Which satellites were directly overhead a port at the moment a sanctioned vessel docked?

**Question.** A sanctioned tanker docked at Tartus at 09:12 UTC. Was anyone watching from space?

**Correlation.** Port arrival event → geoCorrelation.near(port lon/lat, 100 km, eventTs ± 30 min) filtered to imaging-sats.

**Visual.** Camera fly-up animation (Section 4's domain-jump idea) — chart tilts, camera rises to LEO altitude, the relevant satellites pulse with their ground tracks rendered over the port. Each satellite has a "tasking confidence" badge based on swath width and pass time.

**Why painful in single-domain.** Port tracking is maritime ops. Satellite overpass planning is geospatial-intel ops. Coupling them after-the-fact requires a separate tool stack.

### 3.10 Where does the wind aloft conflict with an aircraft's reported track?

**Question.** This military transport is flying against the jet stream — is it on a non-standard route, or is the wind data wrong?

**Correlation.** Aircraft heading × ground-speed × altitude band ∩ GFS upper wind at the same lon/lat/Y → residual headwind/tailwind. Flag aircraft whose tracks imply they're fighting > 100 kt of headwind, which often means a recent course change or a redirect.

**Visual.** A small wind-residual arrow at each aircraft's tail. Red when fighting wind aggressively. Hover for "experienced 120 kt headwind component at FL370."

**Why painful in single-domain.** Wind tools show wind. Flight tools show tracks. The residual — the *story* — needs both.

### 3.11 What does this region look like when you remove all civilian noise?

**Question.** Strip out commercial cargo, scheduled flights, weather. What's left over this region?

**Correlation.** Cross-domain classifier filter — show only entities tagged MILITARY, SANCTIONED, DARK, or UNKNOWN-OPERATOR.

**Visual.** A "Tactical Filter" mode that dims all benign entities to 10% opacity. The remaining 5–10% pop. Used heavily at watch supervisor briefings.

**Why painful in single-domain.** Each domain tool has its own classification taxonomy. Coordinating filters across tools means filtering each one separately.

### 3.12 What's the cross-domain timeline of a single named incident?

**Question.** "Reconstruct the MV STAR CENTURION incident, from anchor drag to cable cut to coast guard response, across all domains."

**Correlation.** Named incident → time window → all entities ever within the geographic envelope during the window, across all domains. Plus all news mentions.

**Visual.** Time scrubber jumps to the incident start. Camera animates through a director-managed sequence (the existing `directorManager.js` already exists for this). All domain layers temporarily restricted to that envelope. The user scrubs forward and watches: anchor drag at minute 0, cable damage at minute 23, coast guard scramble at minute 47, satellite imagery overhead at minute 51. This is the platform's ultimate **demo moment** — and the one that requires every other piece in this plan.

**Why painful in single-domain.** Reconstructing a multi-domain incident from raw tools is what intel teams currently do in PowerPoint. VANGUARD1 makes it the native artifact.

---

## Section 4 — Innovations to layer on top of multi-domain

The Section 3 patterns are *correlation as a service*. This section is *what becomes visually possible when correlation lives natively in the scene*. The prior research's #1, #2, #3 (Wake Tunnels, Predictive Cones, Sphere of Context) are the foundation. These extend them into the cross-domain era.

### 4.1 Vertical Event Correlation Pillars

At any lat/lon worth watching, a vertical pillar stacks domain events by their natural altitude.

**Visual.** Pillar is invisible by default; appears on hover over a chokepoint or after a correlation rule fires. Glyphs sit at correct Y: subsurface cable event at Y=−2, surface vessel anchor at Y=0, aircraft loiter at Y=22, satellite pass at Y=51. A thin time strip on one face of the pillar shows the event timestamps over the last 24 h.

**Interaction.** Orbit the pillar to read it. Click a glyph to jump time + camera to that event. The pillar is the single most "I get it" visual in the whole platform.

**Why multi-domain.** A pillar with only one band is a list. With four bands it's a story.

### 4.2 Time-Synchronized Multi-Domain Replay

Scrubbing time replays every domain at once. The cyclone forms while aircraft divert, while the sanctions vessel goes dark, while the satellite catches the moment.

**Visual.** All managers honor `timeScrubber.getNow()`. The HUD shows "T-04:23 (HISTORICAL)". The time strip pulses. The wind field doesn't replay (it's expensive and the wind doesn't matter much) — but cyclones, vessels, aircraft, satellites, cable events, GPS-jam zones do.

**Why multi-domain.** Replay of one stream is a video. Replay of synchronized streams is forensic reconstruction.

### 4.3 Domain-Jump Camera Animation

When the aiCopilot says "see related satellite pass," the camera doesn't just teleport. It animates: ground level → aircraft cruise deck → LEO altitude over ~1500 ms, the relevant satellite already pulsing on arrival.

**Visual.** transitionManager animates target/position/polarAngle. Along the way, altitude decks light up briefly as the camera passes through them (cruise deck flashes at Y=22, ionospheric F2 at Y=375 km equivalent, then LEO ring). This is the *altitude-as-narrative* idea — the move itself teaches the analyst the multi-domain hierarchy.

**Why multi-domain.** A single-domain tool has nowhere to fly to.

### 4.4 Threat-Surface Columns (alert zones by altitude)

Alert zones today are flat discs. Promote them to columns whose **height** encodes which domains they affect.

**Visual.** Strait of Hormuz alert affecting maritime + air + space gets a column from Y=0 to Y=88. A local fishing dispute is a 3-unit-tall disc. The column has banded coloring per domain (blue = surface, white = air, orange = space). A column you can't ignore at any zoom — it pokes through every deck.

**Why multi-domain.** The visualization itself communicates the breadth of the threat.

### 4.5 Domain-Correlated Entity Dossiers

Click a Russian-flagged vessel. The panel now extends downward as you scroll:

```
SURFACE        — MV STAR CENTURION — IMO 9347xxx — Liberia flag
                  Trailing 14 d positions [waterfall]
AIR            — 3 aircraft transited within 50 nm [list with proximity]
SPACE          — 5 imaging satellites passed overhead in last 24 h [list]
SUBSURFACE     — 2 submarine cables within 10 nm of recent track [list]
INTEL          — 8 news mentions, 2 sanctions flags, 1 OFAC alert [feed]
CORRELATION    — Loitered near gas platform on 03 Jun (auto-detected)
```

Each row links into the scene — clicking the aircraft row spawns a faint trail from the vessel up to where that aircraft was at the time of nearest approach.

**Why multi-domain.** Dossiers in single-domain tools are flat lists. Here every line is a portal to a different domain's evidence.

### 4.6 Predictive Cone Across Domains

The vessel's 24 h predictive cone already shows where she'll be. Extend it to show what air corridors and satellite ground tracks she'll cross.

**Visual.** The cone gains striped overlays. Where flight corridors cross the cone, a faint dashed line; where satellite ground tracks intersect, a brighter solid line with the sat name. The analyst sees the entire 24 h cross-domain horizon at once.

**Why multi-domain.** Forecasting one domain is weather. Forecasting interactions between domains is intelligence.

### 4.7 Sphere of Context — extended vertically into the air column

The prior research's Sphere of Context dome lifted *surface* context into 3D. Extend it: when a vessel is selected, the dome becomes a *cylinder* extending up through cruise deck and LEO. Now the dome contains aircraft within radius, the column of air above, and any satellite passes scheduled for the next hour.

**Visual.** A faint cylinder instead of a dome. The cylinder's top is at LEO (Y=51). Inside it: aircraft at correct altitudes, ports/chokepoints at surface, satellites with their imminent ground tracks. Outside: dimmed scene.

**Why multi-domain.** A dome answers "what's near me at sea level." A cylinder answers "what's above me, watching, or about to pass over."

### 4.8 Wake Tunnels — extended cross-domain

The Temporal Wake Tunnels feature lifts vessel history off the surface. Aircraft, satellites, and cyclones all have history too. Make the Wake Tunnel feature *cross-domain*: turn it on, and every domain's history lifts off its native deck, color-banded by domain.

**Visual.** Vessel ribbons rise from Y=0 upward. Aircraft ribbons rise from Y=22 upward. Satellite ground tracks lift from Y=51 upward (or downward to the surface as a "ground swath" cone). When two ribbons from different domains touch, the intersection glows — that's where you should be looking.

**Why multi-domain.** Crossing trails across domains is the most powerful pattern-of-life signal there is.

### 4.9 "What's at this column right now?" — vertical picker tool

A new HUD button. Click it, then click anywhere on the map. A skinny vertical column appears at that point, and every entity within 30 km of that lon/lat at any altitude flies into the column for inspection — vessels at the bottom, aircraft mid-column, satellites at top.

**Visual.** The column itself is faint. The entities arrange themselves at correct Y, with thin tether lines back to their true position so the analyst doesn't lose ground truth.

**Interaction.** Drag the column around like a fishing rod. Releases when re-clicked.

**Why multi-domain.** Spatial query across all domains as a single gesture. No tool in this market has this.

### 4.10 Domain-Synchronized Threat Weather

The prior research's "Volumetric Threat Weather" idea but layered. Surface threat is one cloud band. Air-domain threat (jamming, military airspace activity) is a different cloud band. Space threat (anti-sat events, conjunctions) is a third. Stack them vertically.

**Visual.** Three soft volumetric layers at different Y. Bad days in the South China Sea look like multi-decker storms.

**Why multi-domain.** A flat threat map tells you where; a stacked one tells you which dimensions of the problem are loud.

### 4.11 Cross-Domain Anomaly Constellation

The prior research's "Dark Fleet Constellation" used distant points to encode accumulated maritime memory. Extend to all domains: dark-vessel events become blue stars, lost-signal aircraft become amber stars, unannounced satellite maneuvers become orange stars, cable anomalies become red stars. The constellation grows over months.

**Visual.** A glacial drifting field behind the chart. Each star is one historical event. Color-coded by domain. Veterans read the cluster patterns.

**Why multi-domain.** A single-domain memory is a log. A multi-domain memory is a map of the world's noise floor.

### 4.12 Director-Managed Multi-Domain Briefings

The existing `directorManager.js` already supports cinematic camera sequences. Extend it to author multi-domain briefings: a saved sequence that walks through a multi-day incident — cyclone forms, vessels diverted, satellite tasked, intel report filed — synchronizing time scrubber, camera path, and domain visibility.

**Visual.** A briefing UI that lets analysts record a sequence (key frames of time, camera, visible layers, narration) and play it back. Output is shareable.

**Why multi-domain.** Single-domain tools can record a flight or a track. Only a multi-domain tool can record a *story*.

### 4.13 Cross-Domain "Tap" Sound Design

(Less visual, more sensory.) Each domain gets its own ambient sound signature — a low subtle hum for surface, a higher swept tone when aircraft cluster, a slow pulse when satellites pass. When all three peak simultaneously (Section 3.4 "chokepoint pressure"), the room feels different even before the analyst looks. The "Watch Room" idea from prior research, audible.

**Why multi-domain.** Ambient cross-modal cues only work when you have multiple domains to differentiate.

---

## Section 5 — The implementation roadmap (sequencing)

Twelve sessions, sequenced so each phase unblocks the next. Build infrastructure before features. Build correlation *after* you have two domains to correlate.

### Phase 0 — Shared infrastructure (1 session)

**Build.** `timeScrubber.js`, `entityRegistry.js`, `intelFeedManager.js`, `geoCorrelation.js`, `cameraMode.js`. (correlationEngine.js comes in Phase 3 — pointless until air is live.)

**Deliverable.** Five new modules, all empty of features but with their public APIs and event contracts in place. Maritime manager (`aisManager.js`) updated to mirror vessels into the entity registry and to read `timeScrubber.getNow()` in its update tick. Time scrubber UI bar at the bottom of the screen, in LIVE mode by default.

**Success criteria.** Hit the time scrubber to pause AIS updates and verify vessels freeze. Query `entityRegistry.near(lon, lat, 100)` from the console and get back the live AIS vessels.

**Demo moment.** "Pause the world" — scrub time backward, watch existing vessel trails replay in reverse. Sells the time axis instantly.

### Phase 1 — Air domain (2–3 sessions)

**Session 1.** `airTrafficManager.js` skeleton with the OpenSky proxy round trip, InstancedMesh, basic dart geometry, layer registration. Aircraft visible at Y=22 with no intel.

**Session 2.** Aircraft → entityRegistry mirror. Hexdb operator lookup. OurAirports load for origin/destination context. Click an aircraft → side panel with operator + tail + recent flights.

**Session 3.** Cruise + GA altitude decks registered with `altitudeDeckManager.addDeck()`. Camera-mode `air` registered at hotkey "2". Trail integration via `trailManager`.

**File list.** New: `airTrafficManager.js`, `airIntelSources.js`. Modified: `flight-proxy.js` (OAuth2 token exchange), `layerManager.js` (`air-traffic` layer), `altitudeDeckManager.js` (cruise + GA decks), `uiController.js` (camera mode hotkey).

**Success criteria.** 3000+ aircraft visible. Hot regions (CONUS, Europe) cluster realistically. Click a tail, see the operator name within 500 ms.

**Demo moment.** Hit "2" — camera tilts into air mode, aircraft fade in as decks appear. Click a B-52 callsign, see "USAF Air Mobility Command — operating from Minot AFB."

### Phase 2 — Space domain (2–3 sessions)

**Session 1.** `satelliteTLEManager.js` skeleton + SGP4 worker (`satWorker.js`) + CelesTrak fetch for `stations`, `gps-ops`, `geo`. InstancedMesh at LEO/MEO decks. GEO ring at Y=88.

**Session 2.** Ground-track pre-computation. Satellite-near-vessel query in entity registry. Click satellite → owner / mission / next pass over watchlisted vessels.

**Session 3.** Camera mode `space` at hotkey "3". Altitude decks for LEO/MEO/GEO. Launch Library 2 integration for upcoming launches as a feed item.

**File list.** New: `satelliteTLEManager.js`, `satWorker.js`, `geoRingManager.js`, `vendor/satellite.min.js`. Modified: layerManager (space layers un-reserved), altitudeDeckManager (3 new decks), cameraMode (space mode).

**Success criteria.** ISS visible passing over correct lat/lon at correct time (verifiable against NASA's "spot the station"). Starlink trains visible as instanced point clouds. GEO weather sats labeled.

**Demo moment.** Hit "3" — camera rises, LEO swarm comes into view. The ISS sweeps across visibly in real time, ground track trailing.

### Phase 3 — Cross-domain correlation (2–3 sessions)

**Session 1.** `correlationEngine.js` + the first three rules: aircraft loiter, satellite-over-rendezvous, cable + surface anchor. UI panel listing active correlations.

**Session 2.** Vertical Event Correlation Pillars (Section 4.1). Threat-Surface Columns (Section 4.4). Domain-Correlated Entity Dossiers (Section 4.5).

**Session 3.** Domain-Jump Camera Animation (Section 4.3). Predictive Cone Across Domains (Section 4.6).

**File list.** New: `correlationEngine.js`, `correlationRules.js`, `eventPillarManager.js`, `threatColumnManager.js`. Modified: vesselTab (extended dossier), aiCopilot (proposes correlation hypotheses).

**Success criteria.** A scripted scenario (one watchlisted vessel, one orbiting aircraft) fires the loiter correlation within 30 s of starting.

**Demo moment.** Set the time scrubber to 04:00 UTC, drag forward to 04:30 UTC. Watch a vertical pillar form over the Strait of Hormuz as a vessel anchors, an aircraft loiters, a satellite passes overhead. Each event lights up at correct Y, correct time. This is *the* moment the product becomes irreducibly multi-domain.

### Phase 4 — Subsurface (2–3 sessions)

**Session 1.** `cableManager.js` with TeleGeography geometry + landing points. Layer registration. Camera mode `subsurface` (dims water).

**Session 2.** `bathymetryManager.js` displaces ocean floor mesh. `subsurfaceFeedManager.js` polls cable news and Ocean Networks Canada.

**Session 3.** Cable anomaly correlation rule (Section 3.3). Vertical event pillars get a subsurface band. Cable corridor near-search in geoCorrelation.

**File list.** New: `cableManager.js`, `bathymetryManager.js`, `subsurfaceFeedManager.js`. Modified: terrainBuilder (or ocean floor mesh exposure), layerManager (subsurface layers un-reserved).

**Success criteria.** All ~470 cables visible. Click TPE cable, see "12 fiber pairs · NEC/SubCom 2018." Trigger a fake cut → cable pulses red.

**Demo moment.** Subsurface mode reveals what's under the water. The cable network blanket reads at-a-glance.

### Phase 5 — Innovation experiments (ongoing)

Pull from Section 4 in order of confidence. Suggested first: Wake Tunnels extended cross-domain (4.8), then the vertical picker tool (4.9), then Director-Managed Briefings (4.12). Cross-Domain Anomaly Constellation (4.11) is the long-term feature — turn it on early so it accumulates memory while other features ship.

---

## Section 6 — Honest pitfalls

### Pitfall 1 — The browser can't hold everything

5000 aircraft + 8000 satellites + 10000 vessels + 500 cables + 50 storm tracks + GFS wind + ground tracks per LEO = the GPU starts to sweat. CLAUDE.md already warns about this. **Mitigation:** every domain ships with an LOD strategy from day one. Satellites at top-down camera render only LEO + GEO. Aircraft only render in the visible bbox + 50 nm beyond. Wake Tunnels render only watched entities by default. Build a `perfBudget.js` that exposes a single "quality" knob — high/medium/low — that managers honor.

### Pitfall 2 — Some feeds are real-time, some are 96 h delayed

OpenSky is 5 s. CelesTrak TLEs propagate cleanly but TLE epoch is hours old. Global Fishing Watch is 72–96 h delayed. IBTrACS is 6 h delayed. Submarine cable news is days behind. **Mitigation:** every entity in the registry carries a `lastUpdateTs` and a `dataLatencyClass: 'realtime' | 'minutes' | 'hours' | 'days'`. The HUD draws a small tick mark on the time scrubber bar showing each domain's current data freshness. When you scrub into a window beyond a domain's freshness, the domain's icons gray out — the analyst is told *we don't have data for this window yet*.

### Pitfall 3 — Cognitive overload

Maritime alone is dense. Add air, the analyst sees fireworks. Add space, the screen is unreadable. **Mitigation:** the camera-mode primitive is also a *visibility* primitive. Maritime mode hides space layers by default. Air mode dims satellites to 30%. Space mode dims surface to 20%. The mode communicates intent. Layer toggles remain available — the modes set sensible defaults, they don't lock anything.

### Pitfall 4 — The demo trap

It is tempting to build the Cross-Domain Anomaly Constellation (Section 4.11) first because it looks gorgeous. It would also be useless for the first three months — no accumulated memory, no events to read. **Mitigation:** every feature in Section 4 has to answer "what does it do on day one with no data?" before it ships. The phasing in Section 5 puts foundational, immediately-useful features first.

### Pitfall 5 — The 3D scale problem

A 50 m vessel and a 400 km LEO orbit altitude differ by 10000×. Drawing both in true scale means one is invisible. **Mitigation:** the survey's recommendation — `logarithmicDepthBuffer: true` + per-class size lifting — is the answer. Vessels are 10× scale, aircraft are 4× scale, satellites are constant-pixel-size sprites, ground tracks are anti-aliased polylines. Don't try to "fix" the scale problem by abandoning Mercator — accept the stylization and label it as such in the corner ("stylized altitudes — not orbital-mechanically accurate"). Honesty about the convention is a feature.

### Pitfall 6 — Cross-manager imports

The temptation as more managers exist will be for one to import another to query state. Resist. The `entityRegistry` exists exactly so `aiCopilot` doesn't need to import `airTrafficManager`. Enforce via the existing `agents/architecture-compliance.js` — add a rule that disallows manager-to-manager imports.

### Pitfall 7 — Time scrubber correctness

Replay across multiple domains will reveal every time-axis bug latent in the codebase. Some managers (the wind, the decks, the day/night terminator) read `Date.now()` directly. Some are framerate-coupled. **Mitigation:** Phase 0 includes an explicit audit pass — `grep "Date.now"` across all managers and mark which ones should switch to `timeScrubber.getNow()`. Wind and decks are exempt; everything else with a temporal semantic is not.

### Pitfall 8 — Proxy proliferation

OpenSky needs OAuth. SpaceTrack needs cookies. N2YO needs API keys. Each becomes another endpoint in `localhost:8787`. The proxy will sprawl. **Mitigation:** single `auth.js` inside the proxy that abstracts token caching for all three. One config file. One endpoint convention (`/<provider>/<resource>`). Document the auth flows in the proxy's README.

### Pitfall 9 — Data licensing

Free does not mean unrestricted. TeleGeography submarine cable data is CC BY-NC-SA — non-commercial. Global Fishing Watch is non-commercial. CelesTrak asks you to be polite. **Mitigation:** an `attribution.html` that lists every feed and its license. Surface attribution in the HUD's "About data" panel. Don't ship commercial without auditing.

---

## If you only do one thing first, do this

**Build Phase 0 — the shared infrastructure — even though it has no visible features.** Specifically, ship `timeScrubber.js` and `entityRegistry.js` before any new domain manager. Every section of this document — the air domain, the space domain, the cross-domain correlation, the Wake Tunnels, the Predictive Cone, the Briefing Director — collapses without those two primitives. They are the load-bearing wall. The temptation will be to build OpenSky integration first because aircraft are visible and exciting. Don't. The day you ship aircraft *and* the time scrubber works on both vessels and aircraft simultaneously is the day VANGUARD1 becomes a multi-domain platform rather than a multi-tab one. That is the difference the entire product strategy is built on.
