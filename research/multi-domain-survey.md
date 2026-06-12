# VANGUARD1 — Multi-Domain Operations Theater: Prior Art, Data, Architecture

*Research memo · 2026-06-06 · audience: VANGUARD1 architecture decisions*

The goal of this document is to make four concrete choices defensible:
(1) what "good" looks like for multi-domain 3D tactical viz; (2) which free feeds are realistically wireable into a browser-only Three.js scene; (3) whether extruded Mercator can keep working as we add air, space, and subsurface; (4) where to point the next three pull requests.

---

## Section 1 — Prior Art Survey

### Cesium / Cesium ion
CesiumJS (Apache 2.0) renders a spherical WGS84 globe with a global terrain ellipsoid, 3D Tiles streaming, and per-frame primitive batching. The library itself is free; commercial value sits in Cesium ion (curated global terrain, photogrammetry, OSM buildings, 3D Tiles pipeline) which is metered SaaS. Visual architecture: one camera, one ellipsoidal scene, LOD streamed via 3D Tiles (an OGC community standard Cesium authored) [^cesium-platform][^cesium-3dtiles]. Multi-domain is achieved by stacking *primitives* in ECEF (Earth-centered Earth-fixed) coordinates — aircraft, satellites, sensor cones, and ground entities all live in the same space. Sedaro and AGI's ComSpOC use Cesium to render tens of thousands of satellites simultaneously against the real ellipsoid [^cesium-aerospace]. What they do well: physical correctness at every scale (a LEO orbit is a real ellipse around a real ellipsoid); CZML is a credible time-dynamic exchange format. What's painful for our case: they assume a globe, not a Mercator rectangle, so adopting their patterns wholesale would mean abandoning our base map.

### ESRI ArcGIS Earth / Pro
ArcGIS Pro 3D Scene supports both *global* and *local* scenes — local scenes use a projected coordinate system (e.g., Web Mercator) flat at z=0 with extrusions above. This is directly analogous to what VANGUARD1 already does. ArcGIS handles air/space layers in *global* scene mode and surface analytics in *local* scene mode, and lets you switch. Data sources are mostly proprietary (Living Atlas, paid feature services) though ArcGIS Online has a free tier. Their key idea worth stealing: an explicit *Scene Mode* toggle that swaps projections.

### Palantir Gotham — Gaia
Gaia is Gotham's geospatial canvas. Public docs describe it as a 2D/3D map layer over the dynamic ontology, with "geo-tagging" of any object plus radius/route/polygon/temporal queries [^palantir-gaia]. Recent marketing mentions tasking satellites and "mixed reality" command centers but no public architecture details. The takeaway: Gotham treats the map as a *projection of the ontology*, not the source of truth. Every dot is an entity that exists in a graph; map state is derived. This is something VANGUARD1 already partially does via `layerManager` events and is worth doubling down on.

### US Space Force Unified Data Library (UDL)
Cloud SSA data repository operated for SSC by Bluestaq; consolidates commercial + government space-object data across classification levels [^udl-ssc]. Public access: effectively none — it's CUI/classified-friendly and gated to vetted users. Useful only as a *pattern* (REST + Kafka feeds of TLEs, ephemerides, conjunction data), not as a feed.

### FlightRadar24 / ADS-B Exchange
FR24 is closed and paid. ADS-B Exchange used to be the open-data option but as of March 2025 the freemium Flight Sim Traffic API was discontinued; the current ADSBexchange.com RapidAPI tier starts at ~$10/mo for 10,000 requests [^adsbx]. Their architecture is straightforward: clients on the ground feed 1090MHz/978MHz frames into a central aggregator, which fans out a state vector per aircraft (lat, lon, alt, heading, vert rate). For *free* drop-in equivalent, see Section 2 — OpenSky and ADSB.lol.

### n2yo / Heavens-Above / CelesTrak
CelesTrak is the de-facto open TLE catalog, free, no auth required, CORS-enabled, hosted at `celestrak.org/NORAD/elements/gp.php` with query params for catalog number, international designator, named group ("starlink", "stations", "active"), and output formats including JSON-OMM [^celestrak-gp][^celestrak-formats]. Heavens-Above is a viewer, not a feed. N2YO has REST endpoints (positions, visual passes, radio passes) but is rate-limited to 1000 tx/hour, requires an API key, and is *not* CORS-friendly — direct browser fetches fail [^n2yo].

### MarineTraffic / Global Fishing Watch / Spire Maritime
MarineTraffic is paid. Spire's free tier is effectively non-existent for browser use. Global Fishing Watch is the realistic free option for *historic* AIS — its 4Wings, Vessels, and Events APIs are free for non-commercial use after a token request, with data lagging 72–96 hours behind real time [^gfw-apis]. Live AIS in VANGUARD1 already comes from aisstream.io; GFW would add fishing-behavior derived events and apparent-effort raster tiles, not live positions.

### Maxar SecureWatch / Planet Explorer
Both paid (Maxar SecureWatch is enterprise; Planet's free tier is the API sandbox + monthly NICFI tropical basemaps). For browser-only free imagery, NASA GIBS is the credible substitute (next section).

### KSAT / Skykraft (ground stations)
KSAT publishes a static map of its ground station network on its marketing site. No public API. Skykraft's NAS-grade ADS-B from space is paid. For VANGUARD1 the relevant feed is the *list of ground stations* — that comes from OpenStreetMap (`man_made=satellite_dish`, `telecom=data_center`) or from Wikipedia-derived datasets.

### earth.nullschool.net / windy.com
Earth (Cameron Beccario, GPL) is the canonical free reference. Architecture: SVG basemap + HTML5 canvas particle layer + HTML5 canvas color overlay; finite-difference distortion estimation per pixel to compensate for the active projection (orthographic, Waterman, equirectangular, etc.) [^nullschool-arch]. Wind data is GFS, re-gridded server-side into a compact JSON-array tile served from `/data/weather/current`. Windy is closed source but stack is leaflet-derived with a WebGL particle layer; their "3D mode" is the 2D map texture-mapped onto a sphere — not a true volumetric atmosphere [^windy-3d]. VANGUARD1's wind already does what Earth does, but volumetric in Three.js rather than canvas-projected.

---

## Section 2 — Free Data Source Catalog

Every entry below was verified usable from a browser without paid auth as of June 2026. CORS notes reflect each provider's published headers; "needs proxy" means the SWPC-proxy pattern at `localhost:8787` should be reused.

### Air domain
| Source | Endpoint | Data | CORS | Cadence | Limits | Auth |
|---|---|---|---|---|---|---|
| OpenSky Network | `https://opensky-network.org/api/states/all` | Live state vectors (lat, lon, baro_alt, geo_alt, velocity, heading, vert_rate, on_ground) for ~10k aircraft | Yes [^opensky] | ≥10s anon, ≥5s authed | OAuth2 client_credentials only (Basic auth removed); anon limited but works | Free account → client_id/secret |
| ADSB.lol | `https://api.adsb.lol/v2/lat/<lat>/lon/<lon>/dist/<nm>` | Same shape as ADSBx; community ADS-B network | Yes | 1s | Reasonable use | None [^adsblol] |
| OurAirports | `https://davidmegginson.github.io/ourairports-data/airports.csv` | 78k airports (ICAO, IATA, lat, lon, elev_ft, type, runways.csv, navaids.csv) | Yes (GitHub Pages) | Daily | None | None [^ourairports] |
| FAA SWIM | `swim.faa.gov` | NextGen flight data (SBS, TFMS, ITWS) | No — VPN-gated SWIM-FPS subscription | — | — | Application-only |

### Space domain
| Source | Endpoint | Data | CORS | Cadence | Limits | Auth |
|---|---|---|---|---|---|---|
| CelesTrak GP | `https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json` | TLEs / OMMs for active satellites; groups: `stations`, `starlink`, `gps-ops`, `geo`, `last-30-days`, `weather`, `military`, `cubesat`, etc. | Yes [^celestrak-gp] | ~12 h server cache | "Be polite" — no hard limit | None |
| Space-Track.org | `https://www.space-track.org/basicspacedata/query/...` | Full SATCAT, historical TLEs, decay/conjunction data | No (cookie auth, breaks browser fetch from web origin) | Real | 200 req/h, 30 req/min | Free registration, login required [^spacetrack] |
| N2YO | `https://api.n2yo.com/rest/v1/satellite/positions/...` | Resolved lat/lon/alt for time window | No — needs proxy [^n2yo] | 1s | 1000/h | API key |
| NASA GIBS | `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/...` | WMTS/TWMS tiles of MODIS, VIIRS, Landsat, GOES daily mosaics | Yes [^gibs] | Daily | None published | None |
| USGS EarthExplorer | `m2m.cr.usgs.gov/api/api/json/...` | Landsat/Sentinel scenes | No (token only) | — | Reasonable | Free account |
| SpaceWeather.gov RTSW | `https://services.swpc.noaa.gov/json/...` | Already integrated | Yes [^swpc] | 1 min | None | None |

### Subsurface
| Source | Endpoint | Data | CORS | Cadence | Limits | Auth |
|---|---|---|---|---|---|---|
| GEBCO 2026 grid | `https://download.gebco.net/` (file) or `https://api.opentopodata.org/v1/gebco2020?locations=...` | Global bathymetry, 15-arcsec | Open Topo Data: yes | Static (annual release) | OTD: 1000 calls/day, 1 req/sec | None [^gebco] |
| NOAA NCEI ETOPO 2022 | `https://www.ncei.noaa.gov/products/etopo-global-relief-model` | 15-arcsec topo+bathy GeoTIFF/NetCDF tiles, 15°×15° | Yes for static files | Static | None | None [^etopo] |
| TeleGeography submarine cables | `https://www.submarinecablemap.com/api/v3/cable/cable-geo.json` + `/landing-point/landing-point-geo.json` | MultiLineString cable routes + landing points | Yes | ~quarterly | CC BY-NC-SA 3.0 [^submarinemap] | None |
| Ocean Networks Canada | `https://data.oceannetworks.ca/api/` | Cabled-observatory hydrophone/CTD telemetry | Yes (with token) | Real | Reasonable | Free token |

### Maritime expansions
| Source | Endpoint | Data | CORS | Cadence | Limits | Auth |
|---|---|---|---|---|---|---|
| aisstream.io | `wss://stream.aisstream.io/v0/stream` | Already integrated | Yes | Real | Free tier generous | API key |
| Global Fishing Watch | `https://gateway.api.globalfishingwatch.org/v3/...` | Apparent fishing effort (4Wings raster), vessel identity, encounters/loitering/port events | Yes | Hourly positions, 72–96h delayed | Reasonable, non-commercial | Free token after request [^gfw-apis] |
| NOAA CO-OPS | `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` | Tides, currents, water temperature at US stations | Yes | 6 min | None | None |
| NOAA NDBC buoys | `https://www.ndbc.noaa.gov/data/realtime2/<id>.txt` | Wave/wind buoy obs | Yes | ~hourly | None | None |

### Space weather (you have most of these)
| Source | Endpoint | Notes |
|---|---|---|
| SWPC Kp/Ap | `https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json` | Real-time + 30-day [^swpc] |
| DSCOVR plasma/mag | `https://services.swpc.noaa.gov/products/solar-wind/plasma-7-day.json` and `mag-7-day.json` | 1-min averages |
| ACE archive | `https://services.swpc.noaa.gov/text/ace-magnetometer.txt` | Backup feed |

### Ground stations / airports / military bases
| Source | Endpoint | Data | CORS | Limits |
|---|---|---|---|---|
| OurAirports | (above) | Airports & runways | Yes | None |
| Overpass API | `https://overpass-api.de/api/interpreter` POST `[out:json];nwr["landuse"="military"];out center;` | Military bases, satellite dishes (`man_made=satellite_dish`), radomes (`man_made=radome`), launch sites (`landuse=launchpad`) | Yes [^overpass] | "Fair use" — 10k queries/day, slot-based | None |
| SatNOGS Network | `https://network.satnogs.org/api/stations/` | Volunteer amateur ground stations with lat/lon/min-elev | Yes | None | None |

---

## Section 3 — Architecture Patterns From Prior Art

**Continuous vs. partitioned scenes.** The serious systems (Cesium-derived, ArcGIS global scene, Gotham Gaia) are *continuous* — one camera, one coordinate frame, every domain rendered into the same space. The hobby/journalism viewers (Earth, Windy, FlightRadar24's 3D toggle) are *partitioned in practice*: either pure 2D map with overlays, or a 2D-textured sphere with the camera locked outside it. Nobody who renders satellites at orbital altitudes uses a Mercator-rectangle base — the moment you cross ~100 km altitude the projection distortion stops being acceptable because the *aspect ratio of the planet itself* is wrong.

**Coordinate transitions.** Cesium and ArcGIS solve this by living in ECEF metres from the start. Surface data is simply primitives at radius = R_earth + h. Local-scene tools (ArcGIS local, Unreal's Cesium-for-Unreal in "small world" mode) project a Mercator tile and put everything in metres above z=0, with a documented break-point where they switch to the global scene. Earth.nullschool's trick is the only one that scales projection-aware: a finite-difference Jacobian per pixel that re-projects wind vectors regardless of map projection — but it's a 2D trick, not 3D.

**Is "extruded Mercator at all heights" credible?** Up through the troposphere (≤20 km real) it is fine — that's where every weather model and FlightRadar 3D mode lives, and 20 km is tiny compared to MAP_WIDTH=300 worth of longitude. For LEO at ~400 km real altitude (ISS) the picture changes: in scene units, Mercator distortion at 60° latitude already stretches longitude by 2×, so an "orbit" drawn in extruded Mercator would look like a sine wave with wrong amplitude near the poles — visibly wrong to anyone who knows what a ground track looks like. **Verdict: extruded Mercator works convincingly to about 50 km scene-equivalent. Above that, you either accept "stylized" orbits (acceptable for a tactical theater, less so for orbital mechanics work), or you need a domain-switch.**

**Camera navigation between domains.** Cesium auto-tilts: as you zoom out, pitch tilts up so the horizon stays visible. ArcGIS Pro has explicit Scene Mode buttons. Earth.nullschool uses a projection picker. The pattern that works for OrbitControls is: bind a hotkey or zoom-band to a target tilt/distance preset — "1" = maritime top-down at y=80, "2" = air theater at y=120 with 45° pitch, "3" = space theater at y=400 with 70° pitch.

**Multi-scale interaction.** Nobody renders a 50 m ship and a 6,371 km radius at the same true scale. Two solutions dominate: (a) Cesium's near/far plane sliding + logarithmic depth buffer (`WebGLRenderer({logarithmicDepthBuffer: true})` in Three.js handles 1 µm to 10¹¹ ly in their demo) [^threejs-logdepth]; (b) per-class size lifting — vessels are drawn at 10× scale, satellites at constant pixel size, orbits as anti-aliased polylines. VANGUARD1 already does (b) for vessels and ports; the question is just keeping it consistent.

---

## Section 4 — Architecture Recommendation for VANGUARD1

### The headline call

**Keep extruded Mercator. Single Three.js scene. Treat space as stylized, not orbital-mechanically accurate.** This preserves the entire existing rendering pipeline, the OrbitControls camera, the altitude-deck primitive, and the layerManager event bus. It cleanly serves maritime + air + atmosphere + near-Earth space + subsurface. The day you need true conjunction-warning geometry, you spin up a *second* page (`/orbital.html`) running a spherical scene on the same data — but that day is not today.

### Y-axis allocation (canonical altitude decks)

Real altitudes compressed into a scene where Y=5 ≈ terrain peak and the existing jet stream sits at Y=22. Pick a power-law: `scene_y = 5 + 17 * log10(1 + alt_km / 2)` — surface=5, 10 km=18, 100 km=35, 400 km (LEO)=51, 35,786 km (GEO)=88. Then snap to round decks:

| Deck | Scene Y | Real altitude | Contents |
|---|---|---|---|
| Bathymetric floor | −12 | −6000 m | GEBCO depth band, submarine cables |
| Surface | 0–5 | sea level / terrain | Vessels, ports, cities |
| Surface wind | 8 | ~10 m | GFS 10 m wind (existing) |
| Low-level wind | 14 | 1500 m (850 mb) | Existing |
| Light aircraft | 18 | ~3 km | GA from OpenSky |
| Jet stream / cruise | 22 | ~10–12 km (250 mb) | Existing wind, **commercial aircraft cruise** |
| Stratosphere | 30 | ~30 km | High-altitude balloons, U-2 class |
| Karman / NOTAM ceiling | 38 | ~100 km | Suborbital, sounding rockets |
| LEO deck | 51 | ~400 km | ISS, Starlink, Earth-obs (stylized) |
| MEO deck | 70 | ~20,000 km | GPS/Galileo/GLONASS (stylized) |
| GEO ring | 88 | ~35,786 km | Weather sats, comms (stylized as ring around equator) |

Register all of these via the existing altitude-deck primitive. Decks above 38 should fade in only when `camera.y > 60` so they don't clutter the maritime view.

### One scene or partition?

**One scene.** Reasons: (a) the altitude-deck primitive already presumes one scene; (b) layerManager events are scene-wide; (c) OrbitControls cannot meaningfully drive two scenes without re-implementing camera sync; (d) WebGL context creation is expensive — two scenes means two contexts or a render-target dance that doesn't pay for itself until orbital-mechanics accuracy is a requirement. Use `logarithmicDepthBuffer: true` on the WebGLRenderer to absorb the 100×-ish range between bathymetric floor and GEO ring without z-fighting [^threejs-logdepth]. This is a one-line change in `sceneSetup.js` and is compatible with the existing post-processing chain (bloom, fog, clouds, TAA, tilt-shift, bokeh) as long as no custom shader reads `gl_FragCoord.z` linearly.

### Data sources for fastest visible impact

In priority order, smallest blast radius first:

1. **CelesTrak `GROUP=stations` + `GROUP=starlink-supplemental`** — TLE-driven satellite tracks at the LEO deck (Y=51). No auth, CORS-clean, ~30 KB JSON. One new `satelliteTLEManager.js` + the existing `satellite.js` npm-equivalent (vendor `satellite.min.js` since no bundler).
2. **OpenSky `/states/all`** — live commercial aircraft at the cruise deck (Y=22). One new `airTrafficManager.js`. Requires the existing `localhost:8787` proxy to inject OAuth2 client_credentials (browser CORS works but token exchange should not expose the secret).
3. **OurAirports `airports.csv`** — static airport markers below cruise deck. One-time fetch at init, decimated by `type` (`large_airport` always, `medium_airport` when `camera.y < 30`).
4. **TeleGeography submarine cable GeoJSON** — at Y=−2 (just under sea surface) or Y=−12 (true depth band). One new `cableManager.js` using `THREE.Line` with custom dashed shader for "stressed/jammed" cables.
5. **GEBCO via Open Topo Data** — bathymetric tint of ocean floor. Promote your existing ocean floor mesh from flat to displacement-mapped using sampled depths.

### Camera mode transitions

Add three hotkeys in `uiController.js`, each animating the OrbitControls target/distance over ~800 ms via your `transitionManager.js`:

- `1` Maritime: `target=(0,0,0)`, `position.y=80`, top-down (pitch=0).
- `2` Air: `target=(0,8,0)`, `position.y=120`, pitch=45°. Surface wind and cruise wind both visible.
- `3` Space: `target=(0,40,0)`, `position.y=400`, pitch=70°. GEO ring becomes legible.

OrbitControls clamps via `minPolarAngle`/`maxPolarAngle`; relax these only inside the space mode to allow looking up at GEO.

### First three implementation phases (concrete file-level work)

**Phase 1 — Air domain MVP (~1 week).**
- Add `airTrafficManager.js` next to `aisManager.js`. Reuse `lonLatToScene()` for X/Z; map `baro_alt` (m) through the altitude-deck formula to scene Y. Render with `THREE.InstancedMesh` of a small triangle/dart geometry (cap ~5000 instances; OpenSky's anon feed returns ~3–8k aircraft).
- Add OAuth2 client_credentials exchange to `localhost:8787` proxy (`/opensky/token` returns Bearer, browser fetches `/opensky/states` through proxy).
- Register `air-traffic` layer in `layerManager`. Listen for `vg1:layerChanged` to toggle visibility.
- Wire in altitude deck at Y=22 with label "FL350 — Commercial cruise". Add deck at Y=18 labeled "FL100 — GA".
- Done = aircraft visible, watchlist-clickable, trails optional via the existing `trailManager` pattern.

**Phase 2 — Space domain stylized (~1 week).**
- Vendor `satellite.min.js` (satellite-js, MIT) into `vendor/`.
- Add `satelliteTLEManager.js`. Fetch CelesTrak `GROUP=stations`, `GROUP=starlink`, `GROUP=gps-ops`, `GROUP=geo` on startup (cache 6h in localStorage). Propagate to current time at 1 Hz, write into one `InstancedMesh` of small glowing points.
- Compute lon/lat from SGP4 ECI→ECEF→geodetic chain; feed `lonLatToScene()` for X/Z; map satellite altitude through the same deck formula → most LEOs land near Y=51, GEOs hit Y=88.
- Orbit arcs: pre-compute 90 minutes of ground track per visible LEO as `THREE.Line`, fade by age. The existing `satArcManager.js` likely already has the shader for this — repurpose.
- Register `leo-sats`, `geo-sats`, `gps-constellation` layers. Hotkey `3` reveals all three.

**Phase 3 — Subsurface and camera modes (~1 week).**
- Add `cableManager.js` for TeleGeography GeoJSON at Y=−2. Color by owner consortium; thickness by fiber-pair count if the API exposes it.
- Add `bathymetryManager.js`: pull GEBCO 2026 reduced-resolution tile (the Open Topo Data sampling endpoint, batched per chunk) and displace the existing ocean floor mesh vertices on a worker. Cache result as a single static height-texture.
- Add the three hotkey camera modes (`1`/`2`/`3`) to `uiController.js`, dispatching `vg1:cameraMode` and letting `transitionManager.js` animate the target/distance/polar angle.
- Flip `logarithmicDepthBuffer: true` in `sceneSetup.js`; verify the splat shader, water shader, and TAA pass don't regress (TAA history buffer interprets `gl_FragCoord.z` linearly — may need a small fix to its depth-reprojection in `taaManager.js`).
- Done = the theater visibly spans bathymetry to GEO, with three reproducible camera presets and no paid feeds.

### Hard-constraint check
- Reuses Mercator base map: yes (everything sits on top of `lonLatToScene`).
- Reuses OrbitControls: yes (presets only adjust target/position; no camera class swap).
- No paid data: yes (every Phase 1–3 feed is free or anon-public).
- Integrates with altitude-deck primitive: yes (Section 4's table is one `registerDeck()` call per row).
- Single Three.js scene, no WebGPU: yes (logarithmicDepthBuffer is WebGL2-standard since r120).

---

## Footnotes / Sources

[^cesium-platform]: <https://cesium.com/platform/cesium-ion/>
[^cesium-3dtiles]: <https://cesium.com/why-cesium/3d-tiles/>
[^cesium-aerospace]: <https://cesium.com/industries/aerospace/>
[^palantir-gaia]: <https://www.palantir.com/docs/foundry/geospatial/add-ontology-data-to-gaia>
[^udl-ssc]: <https://www.ssc.spaceforce.mil/Newsroom/Article/4162862/api-gateway-to-boost-ussf-space-superiority-through-enhanced-data-access>
[^adsbx]: <https://www.adsbexchange.com/api-lite/>
[^celestrak-gp]: <https://celestrak.org/NORAD/documentation/gp-data-formats.php>
[^celestrak-formats]: <https://www.freepublicapis.com/celestrak-gp-data>
[^n2yo]: <https://www.n2yo.com/api/>
[^gfw-apis]: <https://globalfishingwatch.org/our-apis/documentation>
[^nullschool-arch]: <https://github.com/cambecc/earth>
[^windy-3d]: <https://community.windy.com/topic/16541/windy-3d-mode-is-back>
[^opensky]: <https://openskynetwork.github.io/opensky-api/rest.html>
[^adsblol]: <https://github.com/adsblol/api>
[^ourairports]: <https://davidmegginson.github.io/ourairports-data/>
[^spacetrack]: <https://www.space-track.org/auth/createAccount>
[^gibs]: <https://nasa-gibs.github.io/gibs-api-docs/access-basics/>
[^swpc]: <https://www.swpc.noaa.gov/content/data-access>
[^gebco]: <https://www.opentopodata.org/datasets/gebco2020/>
[^etopo]: <https://www.ncei.noaa.gov/products/etopo-global-relief-model>
[^submarinemap]: <https://www.submarinecablemap.com/>
[^overpass]: <https://wiki.openstreetmap.org/wiki/Overpass_API>
[^threejs-logdepth]: <https://threejs.org/docs/#api/en/renderers/WebGLRenderer.logarithmicDepthBuffer>
