# VANGUARD1 — Vessel/Ship Subsystem Review
**2026-07-22 · code-based audit, `design:design-system` template adapted for a non-UI component**

Scope: how commercial vessels are tracked, how their paths render, whether the 3D models are realistic, and what else is built around them. Read in full: `aisManager.js`, `trailManager.js`, `navLightManager.js`, `wakeManager.js`, `shipInstancer.js`, `vesselWaterPad.js`, `clusterManager.js`, `integrityManager.js`, plus the relevant `entityBuilder.js` and `config.js` sections.

## Summary

**Files reviewed:** 9 | **Findings:** 11 (7 strengths, 3 gaps, 1 open question) | **Overall:** the vessel subsystem is the most mature layer in the codebase — real physics-informed touches throughout, one deliberate and well-documented realism trade-off, and no correctness bugs found.

## Tracking (aisManager.js)

Live positions come from `aisstream.io` over WebSocket, normalized through a `dataSource.js` abstraction so synthetic scenarios, NDJSON replay, and live AIS all funnel through the same `ingest()` call — downstream code can't tell the difference. Every incoming `PositionReport` is checked against `invariants.js` (teleport-grade speed jumps, timestamp regressions) before it's allowed to move a vessel — bad data gets rejected rather than silently plotted. Two separate timestamps are tracked per vessel: `lastEventTime` (when the position actually happened, from the message) versus `lastSeen` (when the client heard about it) — this distinction is what lets `integrityManager.js` catch replay/lag anomalies without confusing "stale" and "spoofed."

Vessel classification uses the real ITU-R M.1371 Annex 8 ship-type codes, and the code is explicit that it cannot detect warships — naval vessels don't broadcast AIS, so self-declared "military"/"law enforcement" codes fold into a generic OTHER bucket rather than implying a detection capability that doesn't exist. That's an honest design choice, not a gap.

**Gap:** MMSI validity checking (`integrityManager.js`) only tests the numeric MID range (201–775) once per vessel. It doesn't cross-check the flag implied by the MID against a `ShipStaticData` callsign prefix beyond the one `FALSE_FLAG` weight already reserved for it (currently unimplemented — `FALSE_FLAG: 25` exists in the weight table but nothing in `aisManager.js` or `integrityManager.js` ever sets that flag). This is scoped as "v1.5" in a comment, so it's a known, tracked gap rather than an oversight.

## Paths (trailManager.js)

Trails use a shared GPU ring-buffer: three `DataTexture`s (position history, per-entity head pointer, per-entity color/alpha) sized once from a single pooled `MAX_ENTITIES` slot count (`TRAIL_POOL` in config.js — currently `MAX_VESSELS(500) + MAX_AIRCRAFT + 150` margin), reused across ships, aircraft, and satellites. The vertex shader reads world position directly from the texture per ring-buffer cell and computes a quadratic age-based alpha rolloff, so older trail segments fade rather than cutting off hard. Upload is throttled to every 6th frame. This is a genuinely good pattern — one draw call's worth of GPU state serves every trackable entity type on the map regardless of count, and it scales without new allocations per vessel.

## 3D model design (entityBuilder.js, shipInstancer.js)

Twelve ship classes (CARGO, TANKER, PASSENGER, HSC, FISHING, TUG, DREDGER, PILOT, SAILING, PLEASURE, SERVICE, OTHER), each with a bespoke low-poly builder function — container stacks on CARGO, a deck pipeline/manifold on TANKER, a stepped tiered superstructure and funnel on PASSENGER, a twin-hull catamaran shape for HSC, a mast and triangular sail on SAILING, etc. Hulls get a bright, saturated, class-specific tint (`realMaterials`) rather than a uniform grey — the file is explicit that this is intentional: "each vessel reads its type at a glance instead of a muted grey." That's a documented departure from literal photorealism in favor of legibility, the same logic behind military symbology (NATO APP-6) rather than a simulator's asset pack. Given this is a tactical intelligence map meant to be read at a glance from altitude, that's the right trade-off, not a shortcut.

Rendering is GPU-instanced (`shipInstancer.js`): each class's builder runs once at init to harvest its parts, then every live vessel of that class is one matrix write per part per frame into a shared `InstancedMesh`. This replaced a prior per-vessel `builder()` call that cost up to ~4500 draw calls at 500 vessels — draw call count is now fixed regardless of vessel count. Waterline placement (hull's lowest point at the origin, minus a ~25% draft submersion) is baked in once per class at harvest time rather than recomputed per vessel.

**Open question, not a bug:** all vessel models render broadside-on, facing a fixed east orientation (`main.js` line 764, `obj.rotation.y = Math.PI/2`), regardless of the vessel's actual COG/heading. This is explicit and documented in both `main.js` and `shipInstancer.js`: "all vessel figures face east so the hull length is always visible to the viewer rather than bow-on or stern-on." The real heading is still tracked correctly and used by trail direction, wake orientation, and nav-light positioning — only the hull mesh itself doesn't rotate to match it. This is a legibility choice (a bow-on cargo ship silhouette is nearly unreadable at tactical zoom) but it does mean a vessel's facing on the map never visually confirms its true heading. Worth flagging to Jamal as a known trade-off in case a future feature (e.g., collision-course visualization) needs the hull to actually point the right way.

## Other commercial-vessel features

**Wake (`wakeManager.js`):** a shader-driven Kelvin wake — transverse waves, diverging waves along the cusp arms, and central churn, composited with the mathematically-correct universal Kelvin half-angle (arcsin(1/3) ≈ 19.47°) baked in as a shader constant. Opacity fades in smoothly above 2 kts and off when anchored; wave tightness scales mildly with speed. This is more physically grounded than most tactical-map wake effects, which usually fake a static V-sprite.

**Navigation lights (`navLightManager.js`):** COLREG-correct port (red) / starboard (green) running lights, positioned per-vessel via true heading with a perpendicular offset, gated by a day/night factor computed from solar elevation (invisible in daylight, fades in at dusk — matches how nav lights actually work). One real gap: only port/starboard are implemented. A fully COLREG-compliant vessel also shows a forward masthead light and a stern light; those aren't modeled. Given the deliberate red-channel boost already needed just to clear the ACES bloom threshold, adding two more lights is a small, contained follow-up if maritime-light realism becomes a priority.

**Waterline patch (`vesselWaterPad.js`):** a clever, narrowly-scoped fix — the terrain DEM is too coarse to resolve fjords/narrow harbors, so vessels correctly reporting water positions there would otherwise render over land-colored terrain. Rather than re-carving the hand-tuned global DEM, a small ocean-toned disc renders under the hull only when the vessel samples as land. Cheap (shared geometry/material, one pooled mesh per affected vessel, lazy-created) and doesn't touch the terrain owned by `terrainBuilder.js`.

**Clustering (`clusterManager.js`):** three-tier LOD by camera altitude — combined counts far out, dark/active split at mid zoom, individual markers close in. Cluster color temperature and pulse rate both encode anomaly significance (cyan→red by flagged-vessel ratio, pulse rate rising with recency), so a watch analyst scanning from altitude sees threat concentration before zooming in. This reuses the same region-bucketing for both ships and aircraft.

## Priority follow-ups

1. Implement the `FALSE_FLAG` check that the weight table already reserves 25 points for — currently dead weight in `integrityManager.js` with no code path that ever sets it.
2. Decide whether hull orientation should track true heading (bow-on/stern-on visible) for any zoom level or feature, given it currently never does.
3. Add masthead + stern lights to `navLightManager.js` if full COLREG compliance becomes a stated goal — currently only 2 of the 3-5 lights a real vessel shows are modeled.
