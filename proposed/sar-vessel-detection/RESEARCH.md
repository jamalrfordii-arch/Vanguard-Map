# SAR Dark Vessel Detection Fusion — Research Notes

**Generated:** 2026-06-06
**Category:** surface
**Manager:** SarDetectionManager.js

## Strategic Value
Synthetic Aperture Radar detects vessel hulls regardless of weather, darkness, or AIS cooperation — it sees the physical object, not a broadcast signal. GFW's deep learning pipeline matches SAR detections against AIS tracks, producing the critical 'matched vs unmatched' classification. Unmatched detections represent vessels deliberately evading identification — the highest-priority intelligence targets for sanctions enforcement, IUU fishing interdiction, and dark fleet tracking in contested waters.

## Data Source
Global Fishing Watch API v3: https://gateway.api.globalfishingwatch.org/v3/4wings/report — dataset 'public-global-sar-presence:v3.0' for presence heatmaps, 'public-global-sar-detections:latest' for individual detections. Returns JSON with lat, lon, timestamp, matched (boolean), score, length_m, source (S1A/S1B). Free API token via https://globalfishingwatch.org/our-apis/. Python client: pip install gfw (released April 2025). Typical query: GET /v3/vessels/search with includes=SAR_DETECTIONS. ~5-day data lag from Sentinel-1 acquisition.

## Visual Concept
SAR detections render as diamond-shaped glyphs (rotated 45° squares) to visually distinguish from AIS vessel circles. Three-state color coding: green = AIS-matched (known vessel), red = unmatched (dark vessel — highest alert), amber = low-confidence match (score < 0.7). Unmatched detections pulse with an alert ring animation. A toggle enables 'fusion view' where matched detections snap-connect to their AIS counterpart with a thin dashed line, while unmatched detections stand alone — visually isolating the dark fleet. Vessel length maps to glyph size. Time slider scrubs through detection history, revealing patterns of dark vessel congregation.

## Implementation Approach
InstancedMesh with capacity 20,000 using a BufferGeometry diamond (4 vertices, 2 triangles forming a rotated square). Per-instance attributes: position (vec3 from lonLatToScene), color (vec3 — green/red/amber based on match status), scale (float from length_m mapped to 0.1-0.5 range), pulsePhase (float for unmatched alert animation). ShaderMaterial fragment shader: diamond outline with 2px anti-aliased edge, fill color from instance attribute, pulse ring for unmatched (sin(time - pulsePhase) * 0.5 + 0.5 drives an expanding ring opacity). Fusion lines: on match, emit a custom event 'vg1:sarMatch' with {sarPos, aisVesselId} — aisManager listens and returns vessel position. LineSegments geometry connects pairs with a DashedLineMaterial. Data flow: backend proxy caches GFW API responses (rate-limited to 100 req/min), serves via /api/sar-detections?bbox=&timerange=. Frontend requests visible bbox on camera move (debounced 500ms). Alert integration: unmatched detections within watched regions dispatch 'vg1:darkVesselAlert' consumed by alertsManager.

## Research Notes
GFW's 2024 Nature paper (doi:10.1038/s41586-023-06825-8) is the landmark study: analyzed 2 billion km² of satellite imagery using deep learning on Sentinel-1 SAR data fused with AIS. Found 72-76% of industrial fishing vessels and 21-30% of transport/energy vessels are publicly untracked. SAR detection works through clouds, at night, in all weather — Sentinel-1 C-band (5.4 GHz) reflects off metallic hulls. GFW's model classifies detections as fishing/non-fishing with ~90% accuracy. API launched publicly 2023, Python package April 2025. Key limitation: Sentinel-1B failed December 2021, reducing revisit time until Sentinel-1C launch (December 2024). Current revisit: ~6 days at equator, ~1-2 days at high latitudes. SAR detections are point locations (centroid of vessel return), not tracks — temporal correlation needed to build movement patterns. The matched/unmatched ratio by region is itself an intelligence product: South China Sea shows ~60% unmatched, indicating massive dark fleet operations.

## Next Steps
1. Open SarDetectionManager.js and fill in `_fetchData()`
2. Register an API key for the data source above
3. Copy manager to project root and wire into main.js