# Vanguard — Bathymetry Design + Idea Generation
**Date:** May 2026  
**Status:** Working Document

---

## Part 1: Bathymetry — What It Is and Why It Comes First

Bathymetry is the measurement of ocean depth. The General Bathymetric Chart of the Oceans (GEBCO) is the authoritative global dataset — currently at its 2026 release, covering the entire ocean floor at 15 arc-second resolution (~450 meters per cell at the equator). It's the underwater equivalent of a terrain elevation model, and it's what every serious geospatial platform uses when it shows the ocean floor.

The reason bathymetry comes before other layers architecturally is that three of Vanguard's most important non-atmospheric layers relate directly to ocean depth:

- **Submarine cables** run along specific depth contours — avoiding steep continental slopes, following abyssal plains, surfacing at coastal landing stations.
- **Telluric currents** propagate differently through shallow vs. deep seawater (conductivity varies with temperature and salinity by depth).
- **Military sonar and submarine operations** are governed entirely by bathymetry — thermoclines, seamounts, submarine ridges all shape acoustic propagation.

Getting the ocean floor right visually also establishes the platform's credibility immediately. A serious intelligence visualization tool looks different from a toy one in the first second — deep ocean coloring rendered correctly is part of that signal.

---

## Part 2: The Data — GEBCO in Practice

### What you're actually working with

The GEBCO_2026 Grid (released April 23, 2026) is a two-dimensional array of elevation values in meters. Negative values are ocean depth; positive values are terrain elevation. Format: NetCDF (`.nc`) or GeoTIFF. The complete global file is approximately 7–10 GB. Tile downloads (8 tiles covering the globe) are available at `download.gebco.net`.

For integration, there are two practical paths:

**Path A — WMS tile service (lowest friction)**

GEBCO operates a live WMS endpoint. The URL structure is:

```
https://wms.gebco.net/2023/mapserv?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap
  &LAYERS=GEBCO_LATEST
  &BBOX={west},{south},{east},{north}
  &WIDTH=1024&HEIGHT=512
  &FORMAT=image/png
  &CRS=CRS:84
```

The `GEBCO_LATEST` layer is currently being updated to the 2025 grid (as of May 2026). This returns a pre-colored image tile using GEBCO's own shaded relief palette. Useful for a fast first integration — you're pulling rendered images rather than raw depth values, so no custom shader needed initially. The downside: you can't control the color palette, depth range mapping, or per-pixel depth value (needed for tooltips, telluric modeling, etc.).

**Path B — GeoTIFF download + custom texture (right long-term approach)**

Download one or more of the 8 GeoTIFF tiles. Convert to a 16-bit grayscale PNG (each pixel encodes depth in meters, scaled to 0–65535). Load this as a texture in the renderer. The shader reads pixel value, maps it through the depth color ramp, and outputs the final bathymetry color. This gives full control over the palette and makes per-pixel depth available for the field inspector (hover to see "4,287 m depth / Abyssal Plain / Weddell Basin").

The conversion from GeoTIFF to web-compatible texture is a one-time offline step, handled by GDAL:

```bash
# Example GDAL command (not to be run in the browser)
gdal_translate -ot UInt16 -scale -10920 8626 0 65535 gebco_2026_n0_s-90_w-180_e0.tif bathymetry_west.png
```

This produces a 10800×5400 pixel PNG for one quarter of the globe — manageable as a web texture at lower mip levels.

### Why OPeNDAP matters for scenarios

GEBCO 2026 also exposes an OPeNDAP endpoint, which allows you to query specific subregions and depth ranges programmatically. For scenario modeling (e.g., "show me all ocean floor below -6000m, which is the hadal zone") you can query just the hadal data rather than loading the entire globe.

---

## Part 3: The Color Palette

The oceanographic community has not fully standardized on a single color ramp, but there are three established palettes worth knowing:

**GMT_ocean** — the de facto standard in academic oceanography. Developed for GMT (Generic Mapping Tools). Goes from dark purple/black at hadal depths through a rich blue spectrum to light blue-green at the continental shelf, then transitions sharply to green/brown for land. The key feature: it uses a nonlinear mapping so that the continental shelf (0–200m) occupies more visual bandwidth than its proportional depth range would suggest — this is intentional, because the shelf is where almost all human activity occurs.

**ESRI Ocean** — ESRI's commercial basemap palette, widely recognized because it appears in ArcGIS products everywhere. Very similar to GMT_ocean in structure but softer and more muted. ESRI has published the color style as a free download.

**NOAA Bathymetric** — used in NOAA's official charts. More conservative, less saturated, optimized for print. Less appropriate for a dark-background digital platform.

For Vanguard, the recommendation is a custom ramp derived from GMT_ocean but tuned for the dark space aesthetic — richer blues, higher contrast between depth bands, with the hadal zone rendered near-black to let it recede and make mid-ocean features pop. Here are the depth bands and target colors:

| Depth Range | Feature Name | Target Color | Hex |
|-------------|-------------|--------------|-----|
| 0 to –200 m | Continental shelf | Light teal-blue | `#5AAED4` |
| –200 to –1,000 m | Continental slope | Medium blue | `#2E7DB8` |
| –1,000 to –2,000 m | Upper abyssal slope | Steel blue | `#1A5A96` |
| –2,000 to –4,000 m | Abyssal plain | Deep navy | `#0D3D74` |
| –4,000 to –6,000 m | Lower abyssal | Dark navy | `#071F4A` |
| Below –6,000 m | Hadal zone | Near-black blue | `#030B22` |

The shelf/slope transition at –200m is the most important visual break — this is where the ocean floor drops away from the continental platform. It should be the most visually distinct step in the ramp. Named features that appear at this boundary: Grand Banks, Dogger Bank (now submerged), Northwest Australian Shelf, Sunda Shelf.

The secondary important break is –4,000m, which separates the mid-ocean ridge system (where ridges rise to 2,000–3,000m) from the abyssal plains. Rendering the ridges even slightly lighter than the surrounding plain makes the Mid-Atlantic Ridge and East Pacific Rise visible without labels.

---

## Part 4: Bathymetry's Relationships to Other Vanguard Layers

This is where the design gets interesting. Bathymetry is not just a visual base — it has analytical relationships to almost every other layer in the system.

### Submarine cables + bathymetry (the biggest unlock)

TeleGeography's Submarine Cable Map is free, regularly updated, and available as a JSON API:

```
https://www.submarinecablemap.com/api/v3/cable/cable-geo.json   — cable routes as GeoJSON LineStrings
https://www.submarinecablemap.com/api/v3/landing-point/landing-point-geo.json — landing stations
https://www.submarinecablemap.com/api/v3/cable/all.json         — cable metadata (owner, capacity, year)
```

Rendering cables on top of bathymetry immediately reveals several non-obvious facts:

**Cables hug the continental shelf edges.** Because laying cable on steep slopes is operationally risky and makes repairs difficult, cable routes follow the 200m isobath (the shelf edge) where possible before descending to the abyssal plain. On the bathymetry layer, these routes will visually track the teal-to-blue transition line.

**Chokepoints are visible.** The Red Sea route (SEA-ME-WE cables, FALCON, EIG) passes through the Bab-el-Mandeb strait — a 30km wide channel where water depth drops sharply. The Baltic cables cross the Danish straits at relatively shallow depths. Render the bathymetry, add the cables, and the vulnerability geography is immediately obvious without any labels or explanation.

**The 2024 cable cuts become interpretable.** The Balticconnector and several Baltic fiber cables severed in late 2024 by vessels (attributed to Chinese/Russian shadow fleet) were in relatively shallow water (<100m in the Gulf of Finland). On the bathymetry layer, these incidents map to the light-teal shelf zone — visible to any vessel, accessible by anchor drag. The Red Sea Houthi cable incidents were at slightly greater depth but still on the shelf. The visual argument writes itself.

**Interaction**: when the submarine cable layer is active, clicking a cable segment in the inspector should show: cable name, owners, capacity (Tbps), year laid, repair history, and the depth at that point from GEBCO.

### Telluric currents + bathymetry

Telluric currents (Earth-generated electrical currents flowing through the crust and ocean) interact with ocean depth because seawater conductivity varies with temperature, salinity, and depth. The ocean acts as a moving conductor in Earth's geomagnetic field, and the current density varies between shallow shelf water (warmer, saltier, more conductive) and deep abyssal water (cold, less saline, less conductive).

For Vanguard's purposes, this means the telluric current visualization should not be uniform over the ocean — it should be modulated by the bathymetry. Areas where the layer interacts directly: GIC (Geomagnetically Induced Current) risk is highest where you have both high telluric current density AND submarine cables or power interconnects. The North Atlantic (where Gulf Stream meets cold deep water) and the Arctic Ocean (shallow shelf ice) are both visible on GEBCO and also show elevated GIC risk.

### Aurora + bathymetry (indirect but visually compelling)

The NOAA OVATION Prime aurora oval is available at:

```
https://services.swpc.noaa.gov/json/ovation_aurora_latest.json
```

This returns a 360×181 grid of aurora probability percentages, updated every 5 minutes. The aurora is visible primarily at high latitudes. GEBCO at high latitudes shows the Arctic Ocean floor — the Lomonosov Ridge, the Gakkel Ridge (the world's slowest-spreading mid-ocean ridge), and the broad Eurasian Basin. Rendering the aurora oval on top of the bathymetry over the Arctic creates one of the more striking views available: the aurora shimmering above the ocean floor topology.

The connection isn't just aesthetic — during geomagnetic storms, the aurora and the GIC (geomagnetically induced currents) are concurrent phenomena. The same solar event that makes the aurora visible over Scandinavia also drives GIC through the submarine cables crossing the North Atlantic and Arctic seafloor. Showing both layers together makes the causal chain visible.

### Bathymetry + SBSP scenario

When modeling an SBSP downlink beam (2.45 GHz), the beam footprint over the ocean can be related to the bathymetry below. The key insight: the rectenna receiving an SBSP beam needs a clear, flat receiving area. Coastal zones (continental shelf, ~0–50m) are the most likely deployment sites for offshore SBSPs. Rendering the beam footprint over the shelf zone on the bathymetry layer immediately shows how close to shipping lanes, cable routes, and other infrastructure such a footprint would be. The military/DEW version of the same beam pointed elsewhere — but the footprint geometry is the same. Bathymetry provides the geographic and logistical context for this scenario.

---

## Part 5: New Ideas Generated by the Research

### Idea 1: The Chokepoint Layer

Derived from the intersection of submarine cable data + bathymetry + shipping lane density (available from Global Fishing Watch/MarineTraffic AIS data), a Chokepoint Layer would highlight the world's most strategically vulnerable underwater infrastructure nodes. Not the cables themselves — the *places* where depth, geography, and cable concentration create single points of failure.

The handful of locations that emerge from this intersection: Luzon Strait (Philippines), Bab-el-Mandeb, Danish Straits, Lombok Strait, the waters northwest of Ireland (where Atlantic cables converge before heading to the US coast). These don't require classified knowledge — they fall directly out of the public data.

Clicking a chokepoint shows: cables crossing, minimum depth (how accessible to surface vessels), historic incidents, proximity to military bases.

### Idea 2: Ice Age Exposed Shelf Mode

At the Last Glacial Maximum (~20,000 years ago), sea level was approximately 120m lower than today. That means all continental shelf area shallower than 120m was dry land. On the GEBCO depth ramp, this is approximately the lightest blue band — the 0–120m shelf.

A toggle that recolors this zone from ocean blue to exposed land color (brown/green) shows: the Dogger Bank as a large landmass in the North Sea, Beringia connecting Alaska and Siberia, Sundaland connecting mainland Southeast Asia to Borneo/Java, the shallow shelf between Ireland and the UK. Land bridges that explain human migration patterns, extinct ecosystems, and, interestingly, the location of some of the most important cable routes.

This is a relatively low-effort feature — it's just a depth threshold applied to the existing bathymetry texture — but it creates a striking, memorable view that no current EM warfare tool offers.

### Idea 3: Depth-Correlated Cable Repair Accessibility

Submarine cable repairs are constrained by water depth. Cable ships can repair cables in depths up to approximately 8,000m in principle, but practically, deep repairs (>2,000m) are significantly more expensive and time-consuming. A repair accessibility overlay, derived from the bathymetry, would color cables by how quickly they could be repaired: green for shallow-water cables (days), yellow for mid-depth (weeks), red for deep-water cables (months).

The strategic implication is immediate: a red cable in a contested region represents a long-term degradation of communications, not a temporary one. The Baltic cables cut in 2024 were green — repaired in weeks. A cut in the Luzon Strait or north of Iceland would be red.

### Idea 4: Bathymetric Resonance for HEMP Scenarios

The HEMP (High-Altitude Electromagnetic Pulse) scenario modeling gains additional nuance when paired with bathymetry. The E3 (long-wave) component of a HEMP propagates through the ground and through seawater. Its effect on buried and undersea cables depends on the conductivity of the medium — which correlates with water depth and sediment type. This is documented in DOD technical reports (publicly available through Federation of American Scientists and the EMP Commission).

Adding a bathymetry-modulated E3 effect to the HEMP scenario layer — rather than showing uniform ground-level effect — would be technically more accurate and visually more interesting. Deep ocean areas would show reduced coupling (cold deep water, lower conductivity). Shallow coastal and shelf areas would show higher coupling. Continental areas show the full E3 effect through soil.

### Idea 5: The Suez/Panama Counterfactual

A scenario: block the Suez Canal (as the Ever Given did briefly in 2021, as Houthi attacks effectively did more durably in 2024). Ships reroute around the Cape of Good Hope. Show the rerouted paths on the bathymetry layer. Show which cable routes they parallel. Show which cable routes they potentially threaten by anchor drag in the rerouted corridor. The 2024 Red Sea situation produced exactly this kind of risk — vessels routing around the Cape, anchor-dragging in new areas. 

This scenario is buildable entirely from public data: MarineTraffic or Global Fishing Watch AIS for vessel density, TeleGeography for cables, GEBCO for depth at each point.

---

## Part 6: Data Source Reference (Verified Endpoints)

The following endpoints were verified in May 2026 research:

### GEBCO

| Item | URL/Note |
|------|----------|
| Download app | `https://download.gebco.net/` |
| WMS (2023 grid) | `https://wms.gebco.net/2023/mapserv?` |
| WMS latest | `GEBCO_LATEST` layer; being updated to 2025 grid as of May 2026 |
| OPeNDAP | Available for GEBCO_2026; check gebco.net for endpoint |
| License | Open, free for non-commercial and research use |
| Format | NetCDF (global), GeoTIFF (8 tiles), Esri ASCII |
| Resolution | 15 arc-second / ~450m at equator |

### CelesTrak

| Item | URL |
|------|-----|
| All active satellites (JSON) | `https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json` |
| Starlink (JSON) | `https://celestrak.org/NORAD/ELEMENTS/table.php?GROUP=starlink&FORMAT=json-pretty` |
| GPS constellation | `https://celestrak.org/NORAD/elements/gp.php?GROUP=gps-ops&FORMAT=json` |
| Update cadence | Every 2 hours; do not poll more frequently |
| Format | OMM (Orbit Mean Motion) standard; fields include EPOCH, MEAN_MOTION, ECCENTRICITY, INCLINATION, etc. |
| Note | 6-digit catalog numbers arriving ~July 2026 (catalog overflowing 69999) |

### NOAA SWPC (Space Weather)

| Product | URL |
|---------|-----|
| Kp index (24-hour) | `https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json` |
| Solar wind plasma | `https://services.swpc.noaa.gov/products/solar-wind/plasma-1-minute.json` |
| Solar wind mag field | `https://services.swpc.noaa.gov/products/solar-wind/mag-1-minute.json` |
| Aurora oval (OVATION) | `https://services.swpc.noaa.gov/json/ovation_aurora_latest.json` |
| Geomagnetic alerts | `https://services.swpc.noaa.gov/products/alerts.json` |
| Update cadence | Kp: 3-hour; solar wind: 1-minute; aurora: 5-minute |

### TeleGeography Submarine Cables

| Item | URL |
|------|-----|
| Cable routes (GeoJSON) | `https://www.submarinecablemap.com/api/v3/cable/cable-geo.json` |
| Landing stations (GeoJSON) | `https://www.submarinecablemap.com/api/v3/landing-point/landing-point-geo.json` |
| Cable metadata | `https://www.submarinecablemap.com/api/v3/cable/all.json` |
| License | Free for non-commercial use; commercial license available |
| Update | Regularly updated by TeleGeography |

### gpsjam.org

| Item | Note |
|------|------|
| Public API | None documented |
| Data cadence | Updated daily at midnight UTC |
| Source | ADS-B Exchange NACp field (navigation accuracy) |
| Metric | `percent_bad = 100 * (bad - 1) / (good + bad)` per H3 hexagon |
| Color thresholds | Green < 2%, Yellow 2–10%, Red > 10% |
| Archive | Goes back to 2022-02-14 |
| Integration approach | Inspect network requests in browser to find data URL; or proxy the daily map image and re-render as heat layer |

### Blitzortung (Lightning)

| Item | Note |
|------|------|
| Transport | WebSocket |
| npm package | `@simonschick/blitzortungapi` |
| License | Non-commercial only; restricted from high-traffic sites |
| Alternative | Vaisala (commercial), WWLLN (academic, requires contact) |
| Data | Per-strike events: lat, lon, timestamp, polarity |
| Latency | Near real-time (<1 second) |

---

## Part 7: Revised Build Priority

Given the research, the submarine cable layer should move up in the build sequence — it is the highest signal-to-effort ratio feature after bathymetry itself, and it directly serves the legal/analytical purpose (cable cut incidents, chokepoint vulnerability, SBSP landing zone proximity). The revised top of the sequence:

1. **Bathymetry** — GEBCO WMS for fast first integration; replace with GeoTIFF texture for full control. Color ramp as specified in Part 3 above.
2. **Submarine cables** — TeleGeography GeoJSON API. Render as colored lines on the bathymetry surface. Click to inspect cable metadata + depth at point.
3. **GPS jamming** — gpsjam.org daily hex grid. Render as red heat zones. Click to inspect percentage, date, known conflict context.
4. **Aurora oval** — NOAA OVATION JSON. Render as translucent colored shell at ionosphere altitude (~100 km). Driven by live Kp index.
5. **Satellite tracks** — CelesTrak JSON + SGP4 propagation. Start with GPS and Starlink constellations; add inspector satellites from documented list.
6. **Lightning** — Blitzortung WebSocket → particle system. This is the most computationally intensive layer and should come after the data pipeline is stable.
