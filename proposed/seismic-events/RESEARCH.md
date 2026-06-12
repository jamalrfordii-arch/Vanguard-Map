# Seismic Events — Research Notes

**Generated:** 2026-06-05
**Category:** surface
**Manager:** seismicManager.js

## Strategic Value

Real-time seismic data is an underutilized intelligence layer with multiple
strategic implications:

1. **Submarine cable vulnerability**: Major earthquakes near known cable routes
   are leading indicators of cable breaks (e.g., the 2006 Hengchun earthquake
   severed 9 cables off Taiwan). Overlaying seismic events with the existing
   `submarineCables.js` layer creates instant vulnerability assessment.

2. **Nuclear test proxy**: USGS seismic events at unusual depths with
   suspiciously round magnitudes near known test sites warrant analyst attention.
   The Vanguard1 AI copilot could correlate against known DPRK/other test site
   locations automatically.

3. **Infrastructure disruption**: Earthquakes near ports, airports, and
   chokepoints predict near-term maritime/aviation disruption — cross-reference
   with `chokepointManager.js` and `portManager.js`.

4. **Natural disaster early warning**: Large earthquakes in ocean trenches
   precede tsunamis. Combined with AIS vessel positions, this enables
   vessel-at-risk alerting.

## Data Source

**USGS Earthquake Hazards Program — GeoJSON Feeds**

No API key required. Completely free and open.

- Past hour (M2.5+): `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_hour.geojson`
- Past day (all): `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson`
- Past day (M4.5+): `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson`
- Past week (M2.5+): `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson`
- Update frequency: every 1 minute
- Format: GeoJSON FeatureCollection
- Documentation: https://earthquake.usgs.gov/earthquakes/feed/

## Visual Concept

Expanding ring ripples emanating from each epicentre, similar to a stone
dropped in water. Three concentric rings per event, staggered in time, create
a pulsing "shockwave" appearance. Rings scale with magnitude (a M7.0 produces
rings ~10× wider than a M4.0). Color coding:

- **Cyan** (M < 4.0): minor, background seismicity
- **Orange** (M 4.0–6.0): moderate, noteworthy
- **Red** (M ≥ 6.0): major — triggers alert via `alertsManager.js`

Rings use `THREE.AdditiveBlending` so they glow against the dark ocean floor
without occluding vessels or cable lines.

## Implementation Approach

Object pool of `RING_POOL_SIZE` (200) pre-allocated `THREE.Mesh` ring objects.
On new earthquake ingestion, available pool slots are claimed and animated.
When a ring completes its lifecycle (`RING_DURATION` = 18s), it returns to
the pool. This avoids geometry allocation at runtime.

The `RingGeometry` is rotated -90° on X axis to lie flat on the surface.
`scale.set(r, 1, r)` drives ring expansion without recreating geometry.

For very recent events (< 2 hours old), rings are spawned immediately.
Events older than 2 hours are recorded in `_events` for analytics but
don't spawn active rings (to avoid saturating the pool on initial load).

## Research Notes

- USGS API docs: https://earthquake.usgs.gov/fdsnws/event/1/
- Feed documentation: https://earthquake.usgs.gov/earthquakes/feed/
- Seismic WebGL example (Three.js globe, 120 years): https://www.webgpu.com/showcase/earthquake-pulse-map-seismic-activity-webgl-globe/

## Next Steps

1. Copy `seismicManager.js` to the project root (no API key needed)
2. Add SEISMIC constants block to `config.js`
3. In `main.js`: `import { SeismicManager } from './seismicManager.js';`
4. Wire `update(camera, delta)` into the animation loop
5. Optional: cross-reference epicentre lat/lon with `submarineCables.js`
   segment list to auto-generate "cable at risk" alerts in `alertsManager.js`
6. Optional: add M6+ events to the main intel feed via `feedManager.js`
