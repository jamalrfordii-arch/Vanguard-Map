# Vanguard — Technical Design Specification
**Version:** 0.1  
**Date:** May 2026  
**Status:** Working Draft

---

## 1. Project Vision

Vanguard is a real-time geospatial intelligence platform that layers atmospheric, geomagnetic, space, and electromagnetic warfare data on a 3D globe. Its distinguishing feature is the synthesis of publicly available OSINT feeds into a single coherent visual — combining what previously required separate tools from NOAA, CelesTrak, gpsjam.org, and ADS-B Exchange.

The platform operates in three modes:

**Live** — real-time data feeds, auto-refreshing layers, current satellite positions.  
**Historical replay** — scrubable timeline over named events (Carrington 1859, Halloween storms 2003, Quebec blackout 1989, Baltic cable cuts 2024).  
**Scenario modeling** — parameterized simulations: HEMP detonation cones, Carrington-class storm projection, Kessler cascade, SBSP-as-DEW dual-use argument.

The intended audience is researchers, journalists, policy analysts, and legal practitioners who need to make complex technical arguments legible to non-specialist audiences. The closest public analogues are Bellingcat's OSINT mapping tools and CSIS's Aerospace Security tracker — Vanguard occupies the intersection of both, with emphasis on the electromagnetic domain that neither covers well.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Vanguard Frontend                    │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  LayerMgr   │  │  SceneGraph  │  │  DataBroker   │  │
│  │             │  │  (Three.js)  │  │               │  │
│  │ 5 categories│  │ Globe shader │  │ Fetch / cache │  │
│  │ 12 layers   │  │ Atmosphere   │  │ SSE / WS      │  │
│  │ presets     │  │ Particles    │  │ Polling       │  │
│  └─────────────┘  └──────────────┘  └───────────────┘  │
│                            │                            │
│            ┌───────────────┴────────────────┐           │
│            │          TimeController        │           │
│            │  live / replay / scrub modes   │           │
│            └────────────────────────────────┘           │
└─────────────────────────────────────────────────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
         Live APIs     Static Data     Scenario
         (gpsjam,      (GEBCO bath,    Engine
         CelesTrak,    IGRF mag,       (HEMP,
         SWPC,         ACLED hist)     Carrington)
         Blitzortung)
```

**Tech stack:** Three.js r165 + WebGL 2.0. No framework dependency — vanilla ES modules. Single HTML file during prototype phase; migrate to Vite build when layers exceed ~15 and bundling matters.

**Data layer:** All external feeds accessed via a thin `DataBroker` class that handles fetch, rate limiting, response caching (IndexedDB for offline replay), and normalisation into a common GeoJSON-like schema.

---

## 3. Layer System

Layers are organised into five categories reflecting physical altitude and domain. This grouping makes preset combinations natural — a user studying a solar storm turns on Geomagnetic + Space; a user studying GPS denial turns on Atmosphere + Human/Operational.

### 3.1 Category Definitions

| # | Category | Description |
|---|----------|-------------|
| 1 | **Surface** | Terrain, political borders, infrastructure (always-on base) |
| 2 | **Atmosphere** | Clouds, weather scalars, lightning, precipitation, GEC |
| 3 | **Geomagnetic** | Magnetic field lines, telluric currents, Schumann resonance shell |
| 4 | **Space** | Satellites, magnetosphere, Van Allen belts, solar wind/IMF |
| 5 | **Human / Operational** | EM warfare, GPS jamming, signals intel, infrastructure events |

### 3.2 Layer Inventory

| Layer | Category | Color | Data Source | Status |
|-------|----------|-------|-------------|--------|
| Terrain & Borders | Surface | #8B9D77 | NASA Blue Marble + Natural Earth | ✅ v0.1 |
| Bathymetry | Surface | #1A7AB5 | GEBCO 2023 | ✅ v0.1 (approx shader) |
| Cloud Cover | Atmosphere | #D4E8F0 | NOAA/GOES cloud composite | 🔲 v2 |
| Lightning | Atmosphere | #FFF080 | Blitzortung websocket | 🔲 v2 |
| Global Electric Circuit | Atmosphere | #A0D8EF | Schematic / WWLLN | 🔲 v3 |
| Magnetic Field Lines | Geomagnetic | #00C8C8 | IGRF-13 model | ✅ v0.1 (placeholder) |
| Telluric Currents | Geomagnetic | #F5A623 | GIC model + USGS obs | 🔲 v4 |
| Schumann / Ionosphere | Geomagnetic | #C840C8 | Schematic shell | 🔲 v4 |
| Satellite Tracks | Space | #B0B8C0 | CelesTrak TLE | 🔲 v6 |
| Magnetosphere | Space | #0A7FF5 | SWPC / Tsyganenko model | 🔲 v5 |
| GPS Jamming Zones | Human/Op | #FF3333 | gpsjam.org | ✅ v0.1 (static zones) |
| EM Warfare Overlay | Human/Op | #FF6633 | ACLED + OSINT | 🔲 v7 |

### 3.3 Color Discipline

One signature color per layer, two hues maximum. Colors are drawn from the rendering stack palette below — no two adjacent layers share a hue. All layers render at variable alpha; the base color is constant. This prevents the "Christmas tree" problem when multiple layers are active.

---

## 4. Rendering Stack

Layers render in physical altitude order, deepest first. Blending mode varies by layer type.

```
                 ─── SPACE ─────────────────────────────────────────
  ~50,000 km     Solar wind / IMF                    orange
  ~20,000 km     Satellites & debris                  light gray
   ~8,000 km     Outer magnetosphere                  deep cyan
                 Van Allen belts (toroidal)            blue-violet

                 ─── UPPER ENVELOPE ─────────────────────────────────
    ~500 km      Magnetic field lines (3D curves)      cyan
    ~100 km      Schumann / ionosphere shell            magenta  [additive]

                 ─── ATMOSPHERE ─────────────────────────────────────
     ~10 km      Cloud cover (textured shell)           white/neutral
      ~5 km      Precipitation scalars                  pale blue
      ~2 km      Lightning particles                    white-yellow [additive]
    surface      Global electric circuit                pale cyan

                 ═══ SURFACE (always on) ════════════════════════════
      0 km       Terrain + borders                      neutral
     -200 m      Bathymetry (ocean depth coloring)      blue ramp

                 ─── SUBSURFACE ─────────────────────────────────────
   -10 km        Telluric / GIC currents                amber [x-ray through surface]

                 ─── OVERLAY (altitude varies) ──────────────────────
   any            EM warfare / GPS jamming               red [additive]
```

### 4.1 Key Rendering Rules

**Subsurface layers** render below the terrain shell at reduced opacity. The globe shader exposes an x-ray pass — subsurface objects use depth-test disabled + low alpha to simulate "seeing through" the crust.

**Lightning** uses additive blending (`THREE.AdditiveBlending`) so flashes illuminate clouds from below without washing out the texture underneath.

**Magnetic field lines** are 3D curves generated from the IGRF-13 dipole model, drawn with depth-fade so distant field lines recede naturally. They extend from surface out to ~5 Earth radii.

**EM warfare overlay** sits at whatever physical altitude its phenomenon occupies: ground-based jamming renders at surface; ASAT events render in orbit; HEMP modeled at burst altitude (~400 km).

**Atmosphere glow** is a Fresnel-based shell at radius 1.025×R_earth, using additive blending. The limb brightens as viewing angle approaches 90°, and scales with sun-facing direction so the night limb stays dim.

### 4.2 Globe Shader Architecture

The globe uses a single custom `ShaderMaterial` with three texture inputs:

- `dayMap` — Earth daytime texture (NASA Blue Marble / earth_atmos_2048)
- `specMap` — Specular/ocean mask (white = ocean, black = land)
- `nightMap` — City lights for night hemisphere

The `bathyIntensity` uniform (0–1) controls how strongly the GEBCO-inspired depth colormap overrides the original ocean texture. At 0, the texture is unmodified. At 1, ocean pixels are fully replaced by the depth-derived color ramp.

The depth ramp maps luminance → depth: darker ocean areas in the source texture correspond to deeper water. This is a reasonable proxy until actual GEBCO tiled height data is wired in (planned for v3).

---

## 5. Data Source Catalog

### 5.1 Bathymetry — GEBCO

| Field | Value |
|-------|-------|
| URL | https://www.gebco.net |
| Format | NetCDF (.nc), GeoTIFF, Web Map Service (WMS) |
| Resolution | 15 arc-second grid (~450 m at equator) |
| Coverage | Global |
| License | Open, free for non-commercial and research |
| Update cadence | Annual release (GEBCO 2023 current) |
| Full dataset size | ~7 GB (use tile service for web) |
| WMS endpoint | `https://www.gebco.net/data_and_products/gebco_web_services/web_map_service/` |
| Integration plan | Phase 1: shader approximation (depth from luminance). Phase 3: load GEBCO GeoTIFF tiles as displacement texture. |

### 5.2 GPS Jamming — gpsjam.org

| Field | Value |
|-------|-------|
| URL | https://gpsjam.org |
| Author | John Wiseman |
| Source | Aircraft ADS-B telemetry — GPS reception quality inferred from position accuracy fields |
| Update cadence | Near-real-time (hours) |
| Format | Web map (no documented API; scrapable GeoJSON) |
| Coverage | Global, where ADS-B coverage exists |
| License | Free for non-commercial use |
| Integration plan | Phase 5: scrape GeoJSON every 6 hours; render as red heat zones |
| Key regions | Ukraine/Russia corridor, Black Sea, Kaliningrad, Eastern Mediterranean, Strait of Hormuz, Syria |

### 5.3 Aircraft / Route Anomalies — ADS-B Exchange

| Field | Value |
|-------|-------|
| URL | https://adsbexchange.com |
| API | Yes — `api.adsbexchange.com/v2/` |
| Auth | API key required (free tier available) |
| Format | JSON |
| Update cadence | Real-time (~1 second) |
| Key fields | `lat`, `lon`, `alt_baro`, `nav_qnh`, `nic` (navigation integrity), `rc` (radius of containment) |
| Integration plan | Phase 5: stream positions; flag routes with low NIC scores as GPS anomaly candidates; heatmap of route diversions |

### 5.4 Satellite Positions — CelesTrak

| Field | Value |
|-------|-------|
| URL | https://celestrak.org |
| Format | TLE (Two-Line Element sets), JSON |
| Auth | None |
| Update cadence | Daily; some catalogs updated more frequently |
| Key endpoints | Active satellites: `https://celestrak.org/SOCRATES/query.php`; All objects: catalog API |
| Propagator | SGP4 (standard for TLEs) — three.js port available |
| Integration plan | Phase 6: load active satellite TLEs, propagate with SGP4, render as moving points |
| Notable catalogs | Active satellites, debris, Starlink constellation, GPS constellation, inspector satellites |

### 5.5 Space Weather — NOAA SWPC

| Field | Value |
|-------|-------|
| URL | https://www.swpc.noaa.gov |
| Auth | None |
| Format | JSON |
| Key endpoints | |
| Kp index | `https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json` |
| Solar wind | `https://services.swpc.noaa.gov/products/solar-wind/plasma-1-minute.json` |
| Geomagnetic alerts | `https://services.swpc.noaa.gov/products/alerts.json` |
| Aurora oval | `https://services.swpc.noaa.gov/json/ovation_aurora_latest.json` |
| Update cadence | 1–5 minute resolution |
| Integration plan | Phase 4: Kp index drives magnetosphere shell opacity; aurora oval renders in upper atmosphere layer |

### 5.6 Lightning — Blitzortung

| Field | Value |
|-------|-------|
| URL | https://www.blitzortung.org |
| Transport | WebSocket (`ws://ws.blitzortung.org:808x`) |
| Format | JSON per-strike events: `{lat, lon, time, pol}` |
| Auth | None required (community network) |
| Update cadence | Real-time (<1 second) |
| License | Free for non-commercial use |
| Integration plan | Phase 2: WebSocket → particle system. Each strike spawns a billboard particle at strike lat/lon, altitude ~10 km. Additive blending. Fade in 0.8s. |

### 5.7 Conflict Events — ACLED

| Field | Value |
|-------|-------|
| URL | https://acleddata.com |
| Auth | Free registration for research |
| Format | CSV, JSON, REST API |
| Coverage | Global armed conflict events |
| Update cadence | Weekly |
| Integration plan | Phase 7: filter for events with EM/EW tags; render as event markers with timeline |

### 5.8 Maritime Spoofing — Global Fishing Watch / MarineTraffic

| Field | Value |
|-------|-------|
| GFW URL | https://globalfishingwatch.org |
| Auth | API key (free for research) |
| Format | JSON |
| Anomaly signals | Vessels with impossible positions, port-while-at-sea, teleporting tracks |
| Integration plan | Phase 7: flag AIS anomalies, render as orange spoofing-suspect markers |

---

## 6. UX Design Patterns

### 6.1 Story Presets

Pre-configured layer bundles so users don't need to know which toggles to flip:

| Preset | Layers Active |
|--------|--------------|
| Quiet Sky | Terrain, Bathymetry |
| Severe Weather | Terrain, Clouds, Lightning, GEC |
| Solar Storm | Terrain, Bathymetry, Magnetic Field, Telluric, Schumann, Magnetosphere |
| Active Conflict / GPS Denial | Terrain, Clouds, Satellites, GPS Jamming, EM Warfare |
| Grid Vulnerability | Terrain, Bathymetry, GEC, Magnetic Field, Telluric |
| SBSP Scenario | Terrain, Satellites, Magnetic Field, EM Warfare |

Each preset is a saved dictionary of `{ layer: boolean }` pairs. Users can modify and save custom presets (Phase 3 UX feature).

### 6.2 Two-Layer Opacity Guard

When a user toggles a third layer on, all non-active layers dim to ~40% opacity unless the user has explicitly set opacity. Prevents "Christmas tree mode." Implemented in `LayerManager.onLayerChange()`.

### 6.3 Focus Mode (Field Inspector)

When clicking a point on the globe, the inspector panel opens and all layers dim to ~30% except the 2–3 most relevant to the clicked phenomenon. Click a GPS jamming zone → Human/Operational and Space stay bright. Click a lightning strike → Atmosphere and Geomagnetic stay bright.

Relevance mapping:

```js
const focusRelevance = {
  gpsjam:      ['gpsjam', 'satellites', 'emwarfare'],
  lightning:   ['lightning', 'gec', 'clouds'],
  magfield:    ['magfield', 'telluric', 'schumann', 'magnetosphere'],
  satellites:  ['satellites', 'magnetosphere', 'gpsjam'],
};
```

### 6.4 Per-Layer Time Resolution

| Layer | Native resolution | Master slider behavior |
|-------|------------------|----------------------|
| Lightning | 1 second | Show density/heatmap when zoomed out |
| Satellites | 30 seconds | Propagate TLE to slider time |
| GPS Jamming | 6 hours | Show nearest snapshot |
| Magnetic Field | 1 minute | IGRF + Kp perturbation |
| Cloud Cover | 1 hour | GOES composite |
| ACLED events | 1 day | Filter by date |

### 6.5 Color Discipline

Rules applied globally:
- One signature hue per layer
- Maximum two hues per layer (main + accent)
- No layer uses more than 50% alpha at full visibility
- Additive blending layers (lightning, GEC) never exceed 30% alpha per particle to prevent blowout

---

## 7. Build Sequence

### Phase 1 — Globe Foundation ✅ *current*
Three.js globe. Custom GLSL shader: terrain + bathymetry + day/night. Atmospheric Fresnel glow. Starfield. Layer toggle panel (UI only). Story presets. Mouse-to-coordinates. Orbit controls with damping.

### Phase 2 — Atmosphere: Lightning + Clouds
Real GOES cloud composite texture (16-bit PNG, hourly). Blitzortung WebSocket → particle system for lightning strikes. `DataBroker` class with cache and error handling. Basic time slider (live / -24 hr).

### Phase 3 — Field Inspector + Saved Presets
Click-to-inspect on globe surface. Focus mode opacity logic. Custom preset save/load (localStorage). True GEBCO bathymetry via tiled GeoTIFF (replace shader approximation). Cloud opacity control.

### Phase 4 — Geomagnetic Category
IGRF-13 field line computation (replace placeholder geometry with proper dipole+secular variation). Kp index from SWPC → field line distortion and aurora oval. Schumann resonance illustrative shell. GIC risk overlay on transmission infrastructure.

### Phase 5 — GPS Jamming (Live)
`gpsjam.org` data fetch every 6 hours → red heat zones on globe. ADS-B Exchange anomaly detection → route diversion heatmap. Field inspector shows jam zone metadata on click.

### Phase 6 — Space Category
CelesTrak TLE load + SGP4 propagation. Starlink, GPS, and inspector satellite constellations. Conjunction warnings. ASAT event markers from historical timeline. Van Allen belt toroidal mesh.

### Phase 7 — Historical Scenarios + EM Warfare Expansion
Named scenario timeline: Quebec 1989, Halloween 2003, Starfish Prime 1962, Ukraine grid attack 2015, May 2024 G5 storm, Baltic cable cuts 2024. ACLED event markers. Maritime spoofing flags. HEMP cone modeling tool. Carrington-class projection.

### Phase 8 — SBSP Dual-Use Visualization
Orbital SBSP rectenna footprint. Transmitter beam retargeting simulation. EM signature comparison (SBSP vs DEW). Direct link to the legal argument: identical EM profiles, governance void.

---

## 8. Tech Decisions

**Why Three.js over CesiumJS:** CesiumJS is better out of the box for GIS-accurate tiled terrain and satellite orbit visualization, but it imposes a rendering pipeline that makes custom shader effects (the batyhmetry, atmospheric glow, additive lightning, and EM warfare overlay) significantly harder to control. Three.js gives full GLSL access. The trade-off is building satellite propagation and tile loading from scratch — but both are solved problems with clean JS implementations.

**Why single HTML file in v0.1:** The fastest path to a shareable prototype. Zero build step, open in browser, works offline. Migrating to a Vite project when the codebase exceeds ~600 lines of JS is a one-afternoon refactor.

**Why no framework (React etc.):** The UI is a thin overlay over a WebGL canvas. Framework overhead adds complexity without benefit. Vanilla DOM event handling is sufficient and keeps the file self-contained.

**CORS note for local textures:** GEBCO GeoTIFF data loaded from disk requires a local HTTP server (not `file://`). Run `npx serve .` or Python's `http.server` during development. The CDN textures used in v0.1 are not subject to this restriction.

---

## 9. EM Warfare Expansion — Analytical Framing

This section captures the distinctive analytical layer that makes Vanguard different from general geospatial tools.

The data inputs are all publicly available OSINT. The synthesis is analytical. The product is interpretive. This positions Vanguard in the same category as Bellingcat, CSIS Aerospace Security, Aviation Week's Ares blog, and the Stimson Center — research, journalism, policy analysis, and education. Not an operational system.

The SBSP-as-DEW argument (from the accompanying article) becomes visually demonstrable: render an SBSP transmitter's beam pattern and a hypothetical directed-energy weapon's beam pattern on the same globe. The EM signatures are functionally identical from a ground-sensor perspective. That visual is the legal argument made legible.

The ICL/command-responsibility work gets a supply-chain overlay: where autonomous weapons components originate, transit, and are deployed. The electricity law work gets GIC risk tied to specific named transmission assets. These connections make Vanguard not just a visualization tool but an evidence display system for the underlying legal and policy arguments.

---

## 10. Speculative Scenario Parameters

| Scenario | Key Parameters | Data Basis |
|----------|---------------|------------|
| HEMP modeling | Burst altitude 400 km, yield 1 MT, EMP cone geometry | DOD/EMP Commission public reports |
| Carrington-class storm | Dst index −1760 nT (1859 estimate), GIC model on modern grid | Lloyd's 2013 report, Pulkkinen et al. |
| Kessler cascade | Initiating collision altitude, debris cloud propagation | ESA MASTER-8 model, public literature |
| SBSP-as-DEW | 2.45 GHz downlink beam, power density at surface, retargeting time | NASA SSP Reference System Report |
| Cable cut scenario | Named cables, traffic redistribution, latency impacts | TeleGeography cable map, BGP data |

---

*Specification version 0.1 — subject to revision as build progresses.*
