# Space Debris Conjunction Visualization — Research Notes

**Generated:** 2026-06-06
**Category:** space
**Manager:** DebrisConjunctionManager.js

## Strategic Value
Maps the collision risk environment threatening the satellite infrastructure that underpins all other intelligence layers — GPS, ISR, communications, and weather satellites. A single Kessler cascade event in the 700-1000km band could degrade global space-based capabilities for decades. Visualizing conjunction events (predicted close approaches) transforms abstract orbital mechanics into intuitive threat assessment, enabling analysts to understand which assets are at risk and when.

## Data Source
Space-Track.org GP API: https://www.space-track.org/basicspacedata/query/class/gp/ — returns TLE/OMM data for 45,000+ tracked objects in JSON/XML/CSV. Free account required (space-track.org/auth/createAccount). CelesTrak mirror: https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json for active satellites, ?GROUP=debris for debris. Client-side propagation via satellite.js (npm: satellite.js) implementing SGP4/SDP4. Conjunction Data Messages (CDMs) available via Space-Track CDM class for predicted close approaches with miss distance, probability of collision, and TCA (Time of Closest Approach).

## Visual Concept
Debris objects render as a dense instanced particle cloud in orbital shells, color-coded by altitude band (LEO green, MEO amber, GEO red). Active satellites from existing satelliteManager render at 3x debris particle size with distinct glow. Conjunction events render as pulsing red corridors — two converging trajectory arcs connected by a translucent red cylinder at TCA point, diameter proportional to miss distance uncertainty. A 'risk ring' at the TCA altitude band pulses when conjunction probability exceeds threshold. The 700-1000km critical band renders as a faint translucent red shell around the globe, intensity proportional to object density. Time scrubber propagates all objects forward/backward, showing the conjunction geometry evolve.

## Implementation Approach
Two-tier instanced rendering. Tier 1 (debris field): InstancedMesh with 45,000 capacity using tiny SphereGeometry(0.02, 4, 4) or point sprites via Points with custom ShaderMaterial. Per-instance position computed by satellite.js SGP4 propagation on a Web Worker (batch of 45K TLEs propagated every 1 second, double-buffered). Position attributes transferred via SharedArrayBuffer to main thread and uploaded to instanceMatrix. Tier 2 (conjunctions): LineSegments or TubeGeometry arcs for the two converging trajectories, computed from propagating both objects ±30 minutes from TCA. Miss distance sphere at TCA rendered as a transparent IcosahedronGeometry with red emissive pulsing. Altitude density: render a spherical shell using a custom ShaderMaterial on IcosahedronGeometry(earthRadius + altitude, 64, 64) with opacity driven by a 1D altitude-density texture computed from binning all object semi-major axes. Event dispatch: 'vg1:conjunctionAlert' fired when CDM probability > 1e-4, consumed by alertsManager. Data refresh: backend cron fetches GP catalog every 12 hours from Space-Track (rate limit: 30 req/min), CDMs every 6 hours. satellite.js runs entirely client-side — no server-side propagation needed.

## Research Notes
Space-Track.org is the authoritative source, operated by 18th Space Defense Squadron. As of 2025, catalog contains ~45,000 objects >10cm. CelesTrak (Dr. T.S. Kelso) provides convenient pre-grouped TLE files and supplemental GP data. satellite.js npm package is mature (v5.0+), implements SGP4/SDP4 per Vallado's 'Revisiting Spacetrack Report #3'. Performance: SGP4 propagation is ~0.01ms per object per timestep — 45K objects = ~450ms single-threaded, ~60ms on 8 Web Workers. For 60fps rendering, propagate at 1Hz and interpolate positions between propagations. Key debris events to highlight: Cosmos-Iridium collision (2009, 700km), Chinese ASAT test (2007, 865km), Russian ASAT test (2021, 480km). The 700-1000km band contains ~60% of tracked debris. CDM format follows CCSDS 508.0-B-1 standard. Space-Track API requires cookie-based auth — backend proxy handles session management. WebGPU compute (if available via innovation #7) could propagate all 45K objects on GPU at 60fps, eliminating the Web Worker bottleneck entirely. Three.js InstancedMesh handles 100K instances comfortably on modern GPUs.

## Next Steps
1. Open DebrisConjunctionManager.js and fill in `_fetchData()`
2. Register an API key for the data source above
3. Copy manager to project root and wire into main.js