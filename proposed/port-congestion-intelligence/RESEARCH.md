# Port Congestion Intelligence Layer — Research Notes

**Generated:** 2026-06-10
**Category:** human (supply chain / maritime economics)
**Manager:** portCongestionManager.js

## Strategic Value

Port congestion is a leading indicator for supply-chain disruption, sanctions enforcement effectiveness, and economic coercion. When a port backs up (e.g., Port Said during Red Sea diversions, Rotterdam during energy embargoes), the delay ripples through manufacturing output and military resupply timelines. Overlaid on Vanguard1's vessel tracks and chokepoint glyphs, a congestion layer lets an analyst instantly correlate vessel clustering near anchorages with geopolitical events — and flag anomalous queuing patterns (ships waiting longer than baseline may indicate sanctions inspection, port access denial, or labor action).

Real-world intelligence example: In 2023-2024, when Houthi Red Sea attacks rerouted vessels around the Cape of Good Hope, Port Said's congestion score dropped sharply (fewer transits) while Cape Town and Singapore surged — a pattern visible days before it appeared in shipping news.

## Data Source

**Portcast Port Congestion API**
- URL: `https://api.portcast.io/v1/port-congestion?api_key=YOUR_KEY`
- Free tier: available for research use
- Docs: https://portcast.io/blog/portcast-port-congestion-data-now-available-via-api
- Returns: vessel count at anchorage, median wait time (hrs), congestion score 0–100, port UNLOCODE

**Alternative — MarineTraffic Terminal Congestion API**
- URL: `https://services.marinetraffic.com/api/expectedarrivals/{API_KEY}/portid:1/protocol:jsono`
- Paid tier required for production
- Provides: expected arrivals, waiting times, terminal-level breakdown

**Fallback**
- GoComet real-time port congestion tracker covers 400+ seaports
- Safecube benchmarks congestion across 1,000+ global ports

## Visual Concept

Pulsing semi-transparent rings overlaid on each major port marker. Ring radius scales with the count of vessels at anchor. Ring colour follows a green → amber → red gradient keyed to congestion score. A soft glow disc behind each ring creates an aura effect, with intensity proportional to severity. Rings pulse at ~1.2 Hz with amplitude driven by congestion score — a severely congested port visually "throbs" on the map.

## Implementation Approach

- `THREE.RingGeometry` per port, rendered flat on the ocean plane (Y = 0.05 to avoid z-fighting)
- `THREE.CircleGeometry` soft glow disc behind each ring
- Material `MeshBasicMaterial` with transparency — no lighting needed
- Per-frame pulse via `Math.sin(phase)` driving opacity and scale
- Colour computed at build time via linear interpolation between SCORE_COLOURS ramp
- LOD: hide above camera.y = 180 (congestion only makes sense at regional/port zoom)
- API polling every 10 minutes via async `_fetchData()` — never blocks the animation loop

## Next Steps

1. Get a Portcast API key from https://portcast.io (free research tier)
2. Set `PORTCAST_API_KEY` constant in `portCongestionManager.js`
3. Copy manager to project root: `cp proposed/port-congestion-intelligence/portCongestionManager.js .`
4. Wire into `main.js` (see INNOVATION_REPORT)
5. Add `portCongestion` constants to `config.js` under `export const PORT_CONGESTION = { ... }`
6. Optional: wire `ring.userData` into `uiController.js` raycasting for hover tooltips
