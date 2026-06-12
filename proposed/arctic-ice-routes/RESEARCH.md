# Arctic Sea Ice & Polar Route Navigator — Research Notes

**Generated:** 2026-06-10
**Category:** atmosphere (environmental / strategic geography)
**Manager:** arcticIceManager.js

## Strategic Value

The Arctic is a rapidly evolving strategic theatre. Russia's Northern Sea Route (NSR) is a declared national priority — in ice-free months it cuts transit time between Europe and East Asia by ~30% vs. the Suez Canal. Tracking ice extent tells analysts:

- When the NSR is passable and how many vessels are using it (cross-reference aisManager)
- Whether China's "Polar Silk Road" ambitions are physically viable in any given season
- Anomalous vessel movements in ice-marginal zones (military, research, or dark vessels)
- Seasonal pattern changes indicating Arctic warming acceleration — climate as strategic intelligence

The NSIDC Sea Ice Index has recorded 2025 Arctic sea ice extent at near-record lows, meaning the NSR had its longest open season on record. Vanguard1 showing the ice boundary alongside live AIS vessel tracks gives a picture no single commercial tool currently provides.

## Data Source

**NSIDC Sea Ice Index — WMS API (free, no key required)**
- Base: `https://nsidc.org/api/mapservices/NSIDC/wms`
- Layer: `G02135_north_concentration_hdf5` (daily Northern Hemisphere ice concentration)
- Sample request: `?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=G02135_north_concentration_hdf5&BBOX=-180,55,180,90&WIDTH=1024&HEIGHT=512&SRS=EPSG:4326&FORMAT=image/png&TIME=2026-06-09`
- Returns: PNG where pixel brightness maps to ice concentration 0–100%
- Docs: https://nsidc.org/data/user-resources/help-center/guide-nsidc-data-map-services-api

**Alternative: JAXA AMSR2**
- URL: https://gcom-w1.jaxa.jp/auth.html
- Free with academic registration
- Higher resolution (6.25 km vs. 25 km for NSIDC)

**Note:** NSIDC's Sea Ice Today *web service* had reduced funding as of Oct 2025, but the WMS API endpoint for the Sea Ice Index dataset remains operational.

## Visual Concept

A translucent white-blue mesh overlays the polar cap (above ~58°N), fading from icy blue at the ice edge to bright white at the pole. Where ice concentration data is available, the mesh texture directly reflects satellite-measured concentration — dense pack ice appears opaque, open leads are nearly invisible. Three polar shipping routes are rendered as coloured lines over the ice:

- **Northern Sea Route** — green (open), amber (marginal ice), red (closed)
- **Northwest Passage** — same status colour coding
- **Transpolar Route** — shown in muted blue as a future/speculative route

Animated chevron dots flow along open/marginal routes, indicating directionality of vessel transit. The ice boundary acts as an implicit visual cue — where the ice edge cuts across a route, the status colour change tells the analyst which segments are navigable.

## Implementation Approach

- `THREE.PlaneGeometry` (64×32 segments) covering polar cap, tilted flat on ocean plane
- Vertex colour gradient (blue-white) for fallback when WMS fetch fails
- On successful WMS fetch: `THREE.TextureLoader` applies the satellite PNG as `material.map` and `material.alphaMap` — ice concentration drives both colour and transparency
- `THREE.Line` per route, colour set from status string at build time
- `THREE.Points` chevron particles per route, animated via phase offset each frame
- LOD: visible at all zoom levels but most useful at camera.y 30–200
- Daily fetch (86,400,000 ms interval) — ice changes slowly enough that daily is sufficient

## Next Steps

1. The NSIDC WMS API requires no key — try it immediately in the browser:
   `https://nsidc.org/api/mapservices/NSIDC/wms?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=G02135_north_concentration_hdf5&BBOX=-180,55,180,90&WIDTH=1024&HEIGHT=512&SRS=EPSG:4326&FORMAT=image/png`

2. Copy manager to project root: `cp proposed/arctic-ice-routes/arcticIceManager.js .`

3. Wire into main.js (see INNOVATION_REPORT)

4. For thick route lines (> 1px), add `LineMaterial` from `three/examples/jsm/lines/LineMaterial.js`

5. Optional enhancement: fetch Antarctic ice (BBOX -180,-90,180,-55) with the same WMS layer for a southern polar extension

6. Consider: cross-referencing active AIS vessel positions from aisManager via `vg1:arcticIceUpdated` event to flag vessels operating in ice-marginal zones
