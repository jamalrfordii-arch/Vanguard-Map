# VIIRS Nighttime Vessel Light Detection — Research Notes

**Generated:** 2026-06-06
**Category:** surface
**Manager:** NightLightManager.js

## Strategic Value
Reveals the 85%+ of global fishing vessels that never broadcast AIS or VMS — the definitive 'dark fleet' detection capability. Provides physics-based, unspoofable evidence of maritime activity in regions where cooperative tracking is absent or deliberately disabled. When fused with existing AIS data, the gap between lit vessels and tracked vessels becomes the single most powerful indicator of illegal, unreported, and unregulated activity.

## Data Source
Earth Observation Group VIIRS Boat Detection (VBD) product: https://eogdata.mines.edu/products/vbd/ — nightly global CSVs with lat, lon, radiance (nanowatts), timestamp, QF flag per detection. Also available via Global Fishing Watch 4Wings API: https://gateway.api.globalfishingwatch.org/v3/4wings/report with dataset public-global-all-vessels:v3.0 filtered to VIIRS source. Free registration required for EOG; GFW requires API token (free).

## Visual Concept
Each VIIRS detection renders as a point-light sprite positioned just above the water surface (Y=0.3), with radiance mapped to glow radius and intensity via an additive-blended billboard. Detections only render inside the dark hemisphere — gated by the existing dayNightManager terminator position — creating a 'cities on the ocean' effect where lit fishing fleets emerge as the terminator sweeps across the globe. In aggregate mode, a heatmap texture accumulates detection density over 30-day windows, revealing persistent fishing grounds as luminous patches on dark water. Individual detections pulse once on arrival then decay to a steady glow over 2 seconds.

## Implementation Approach
InstancedMesh with ~10,000 capacity using PlaneGeometry(0.15, 0.15) and a custom ShaderMaterial with additive blending (THREE.AdditiveBlending). Vertex shader reads per-instance attributes: position (vec3), radiance (float), age (float). Fragment shader renders a radial gradient falloff (exp(-r*r*8.0)) multiplied by radiance-mapped color ramp (dim blue → bright white). Each frame, CPU updates instance matrix positions via lonLatToScene() and sets a uniform for the sun direction vector from dayNightManager — instances with dot(sunDir, instanceNormal) > 0.1 get alpha forced to 0. Heatmap mode: render detection positions to an offscreen RTT (WebGLRenderTarget, 2048x1024 equirectangular) with additive blending, then sample that texture in the waterManager's fragment shader as an emissive contribution. Backend: Node cron fetches nightly VBD CSV (~50KB compressed), parses to JSON array, serves via REST endpoint. Frontend polls every 60 seconds for new data.

## Research Notes
EOG/VIIRS Boat Detection is the gold standard for dark vessel detection from space. The VIIRS Day/Night Band on Suomi NPP and NOAA-20 satellites detects visible light emissions at night with ~750m resolution. The VBD algorithm filters out lunar glint, gas flares, aurora, and lightning to isolate vessel lights. Key paper: Elvidge et al. 'Automatic Boat Identification System for VIIRS Low Light Imaging Data' (Remote Sensing, 2015). GFW's 2024 Nature paper ('Satellite mapping reveals extensive industrial activity at sea') used VIIRS+SAR fusion to show 72-76% of fishing vessels are publicly untracked. VBD data available from 2012-present. Nightly latency ~12 hours from observation. Squid jigger fleets (using 100+ kW lighting arrays) are particularly bright and detectable — major IUU indicator in Argentine EEZ, North Korean waters, and Galapagos. Format: CSV columns include id_Key, Lat_DNB, Lon_DNB, Date_Mscan, RadHI, RadMI, RadLI, QF_Detect. Typical nightly global count: 5,000-15,000 detections.

## Next Steps
1. Open NightLightManager.js and fill in `_fetchData()`
2. Register an API key for the data source above
3. Copy manager to project root and wire into main.js