# Active Wildfire Hotspots — Research Notes

**Generated:** 2026-06-05
**Category:** surface
**Manager:** wildfireManager.js

## Strategic Value

Active wildfire data provides critical environmental intelligence for the
operational picture. Fires near military installations, critical infrastructure,
or shipping ports signal near-term disruption risk. Large-scale fires in grain
belt regions correlate with food security crises and mass migration events.
The ~50-second latency from satellite observation makes this one of the
fastest open-source ground-truth feeds available.

Secondary intelligence value: wildfires visible from space can serve as a
proxy for conflict (deliberate burning), land-clearing operations, or
industrial accidents. Anomalous fires near strategic sites warrant follow-up
with SAR imagery.

## Data Source

**NASA FIRMS (Fire Information for Resource Management System)**

- Primary endpoint: `https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/VIIRS_SNPP_NRT/world/1`
- MODIS fallback: `https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/MODIS_NRT/world/1`
- NOAA-20 VIIRS: `https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/VIIRS_NOAA20_NRT/world/1`
- Free API key registration: https://firms.modaps.eosdis.nasa.gov/api/mapkey/
- Latency: VIIRS ~50 seconds, MODIS ~25 seconds from satellite observation
- Coverage: global
- Format: CSV with lat/lon/frp/confidence columns
- Rate limit: generous for free tier (check TOS for production use)

## Visual Concept

Instanced glowing quad sprites at each hotspot's lat/lon position, sitting
at y=0.3 above terrain. Each quad is:

- **Color**: amber (low FRP) → white-hot (high FRP, >2000 MW)
- **Scale**: proportional to FRP (Fire Radiative Power) — bigger = hotter
- **Pulse**: sinusoidal scale oscillation at 2 Hz to simulate fire flicker
- **Blend**: THREE.AdditiveBlending for natural glow accumulation
- Low-confidence detections (`conf === 'l'`) are filtered out

At the hotspot scale of a typical fire season (6,000–8,000 global hotspots),
the instanced mesh renders efficiently within the existing pipeline.

## Implementation Approach

`THREE.InstancedMesh` with `PlaneGeometry` quads lying flat (rotated -90° on X).
Additive blending creates the bloom-without-shader appearance. The pulse loop
writes scale back into instance matrices each frame — this is the only per-frame
write, so GC pressure is minimal.

For a higher-fidelity version, a custom GLSL point shader with radial gradient
and alpha falloff would look better, but the instanced quad approach
integrates cleanly with the existing post-process bloom pass.

## Research Notes

- FIRMS homepage: https://www.earthdata.nasa.gov/data/tools/firms
- API documentation: https://firms.modaps.eosdis.nasa.gov/api/
- Ultra-real-time announcement: https://www.earthdata.nasa.gov/news/feature-articles/firms-adds-ultra-real-time-data-from-modis-viirs
- NOAA GOES-19 replaced GOES-16 as GOES-East on 2025-04-07 (data reflected in FIRMS)
- FEDS fire tracking now available for North America via OGC API from Jan 1 2025

## Next Steps

1. Get a free FIRMS MAP KEY at https://firms.modaps.eosdis.nasa.gov/api/mapkey/
2. Replace `YOUR_KEY_HERE` in `wildfireManager.js` and add to `config.js`
3. Copy `wildfireManager.js` to the project root
4. In `main.js`: `import { WildfireManager } from './wildfireManager.js';`
5. Add WILDFIRE constants block to `config.js`
6. Wire `update(camera, delta)` into the animation loop
7. Optional: add a FIRMS alert threshold to `alertsManager.js` for fires
   near known port locations (cross-reference with `portManager.js` data)
