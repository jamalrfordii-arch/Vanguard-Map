# AI Discover — Data Scope & Options-Card Design

*Research memo · 2026-07-21 · audience: scoping decision for the "AI proposes options" feature*

Triggered by: what should the options-card feature actually cover — vessel behavior only, traffic flow, aircraft, political events? What does VANGUARD1 currently map, what does XRF map, and where's the real gap to build into.

---

## 1. What VANGUARD1 actually maps today

Audited directly from the codebase, not from what's planned. "In the snapshot" means it's already visible to `discoveryManager.js`'s cross-domain reasoning — i.e. Claude can see it today. Everything else exists on the map but the AI layer is blind to it.

| Domain | Real or synthetic-capable | Behavior/trait detection that exists | In the AI snapshot? |
|---|---|---|---|
| **Vessels (AIS)** | Real (aisstream.io) + synthetic (scenario JSON) | Dark/reappear, loitering, on-land, false-flag, invalid MMSI (`integrityManager.js`); impossible/excessive speed, SOG mismatch, future/stale event, time regression (`invariants.js`) | Yes — `developingStories`, `integrityFlagged`, `invariantViolations` |
| **Chokepoint traffic flow** | Real (derived from live vessel positions in a strait's box) | Per-strait state machine: dormant → active → alert → closure, driven by count/dark-count/stopped-count | Yes — `chokepointActivity`, now with per-vessel MMSI (today's fix) |
| **RF intel** | Real, but narrow | Distress beacon detection only (AIS-SART/MOB/EPIRB MMSI prefixes + safety broadcasts). Jamming/spoofing detection is referenced in a comment as planned but nothing implements it yet | Yes — `rfEvents` |
| **Aircraft** | Real (airplanes.live via proxy) | Military/widebody classification, but no anomaly/behavior detection layer at all | **No** — flightManager runs entirely outside discoveryManager |
| **Satellites** | Real (Celestrak TLE + SGP4 propagation) | None — pure visualization, no maneuver/anomaly detection (that's "idea 5" in `six-ideas-roadmap.md`, not built) | **No** |
| **Submarine cables** | Real (static geometry) | None | **No** |
| **Maritime news/intel feed** | Real (RSS, maritime-gated keyword filter) | Tagging only (sanctions/incident/chokepoint), no correlation to live entities | **No** — `feedManager.js` is a display panel, disconnected from the reasoning layer |
| **Political events (general)** | **Does not exist** | — | — |
| **Space weather** | Real (SWPC) | Feeds satellite manager visuals only | **No** |

The honest summary: the AI reasoning layer currently sees one domain well (vessels, including chokepoint traffic flow) and touches a second narrowly (RF, but only distress beacons). Aircraft, satellites, cables, news, and space weather are all real data already flowing into the map, and all invisible to Claude. There is no political-event tracking anywhere in the codebase — not stubbed, not planned.

## 2. What XRF actually maps

Checked xrf.ai's homepage, `/defense`, and `/industry` pages directly rather than relying on the earlier read of `/emergencies` alone.

XRF is **asset-centric**, not **traffic-centric**. Their three verticals:

- **Defense** (`XRF.sandbox` + `XRF.apolo`): command-and-control for a unit's own assets — deployed brigades, UXVs (drones), tactical networks, NATO APP-6/STANAG symbology, VBS4 simulation integration. The core pitch is literally "AI-Driven Courses of Action" — *"XRF leverages AI to suggest and compare possible courses of action helping commanders anticipate outcomes and choose the optimal path under pressure."* That's the same feature the user asked about here, confirmed as a named product differentiator, not just a demo flourish.
- **Industry**: critical-infrastructure/site security — cameras, sensors, patrol units, drones, access control, validated at the Port of Valencia. Port-adjacent, but it's asset/perimeter security, not vessel-traffic analysis.
- **Emergencies**: fire/disaster response and crisis training/simulation (previously reviewed).

Nowhere on their site is there evidence of ocean-wide AIS vessel tracking, open aircraft feed monitoring, or any political/OSINT event layer. Their data model is "things we deployed and control" (drones, patrol units, sensors they own), not "the ambient global traffic picture," which is VANGUARD1's actual foundation.

**This is the real strategic distinction, not a feature gap.** VANGUARD1 is a passive, open-source multi-domain awareness picture (real AIS + real ADS-B + real RF + real satellite feeds, no assets of your own required). XRF is an active asset-C2 platform (your drones, your units, your cameras). Both use "AI proposes options" as the payoff feature, but XRF's options are about *tasking your own assets*; VANGUARD1's options would be about *interpreting what you're passively observing*. Worth stating plainly so the feature doesn't get built toward the wrong analogy — chasing "give me a drone to send" isn't the fit here; "tell me what this activity most likely is" is.

## 3. Answering the specific questions

**Ships next to each other, or other behaviors too?** Both, already. The four escalation triggers in `discoveryRules.js` aren't just the STS-pair case — one is a single vessel with multiple different anomaly types, one is cross-domain co-occurrence (RF + chokepoint + AIS story + loitering), one is multiple vessels developing stories at once. The options-card menus discussed earlier map to all four, not just the pair case.

**Traffic flow in straits and oceans?** Straits: yes, already built (`chokepointManager.js`'s dormant/active/alert/closure state, now MMSI-enriched). Open ocean: no — there's no basin-wide density/flow analysis, only the eleven hardcoded chokepoint boxes. Extending traffic-flow reasoning to open ocean would be new work, not a snapshot-field fix.

**Planes?** Real data is already flowing (airplanes.live), but zero behavior detection and zero snapshot integration. This is a real, buildable gap — not because the data's missing, but because nobody's written the aircraft equivalent of `integrityManager.js` yet (unexpected squawk changes, military aircraft loitering near a chokepoint, etc.).

**Political events?** Doesn't exist in any form. Building it would mean either wiring the existing maritime news feed into the snapshot (cheapest — the RSS/tagging infrastructure already exists, just needs to stop being display-only) or standing up a genuinely new general-OSINT ingestion pipeline (expensive, and arguably outside what a maritime/multi-domain tactical map should be doing).

**Can we use both our data and XRF's approach?** Not directly — XRF's differentiator is asset tasking, which requires owning the assets (drones, patrol units) being tasked. VANGUARD1 doesn't have that and building it would be a different product. What *is* directly reusable is the framing: "AI-powered options" as the payoff moment, and the underlying discipline of grounding every option in a concrete trigger condition rather than free text — which is exactly the design from the last conversation.

## 4. Recommended scope for the options-card feature

Build on what's real and already in the snapshot; treat everything else as a named future phase rather than silently scoping it in.

**Phase 1 (build now) — vessel-only, using the existing four triggers.** This is zero new data plumbing: STS-pair, multi-signal vessel, cross-domain co-occurrence, coordinated multi-vessel. Chokepoint traffic-flow state is already an input to the cross-domain trigger via today's MMSI fix.

**Phase 2 (real gap, buildable) — aircraft behavior detection.** Port the `integrityManager.js` pattern to `flightManager.js`'s live feed (loitering near a chokepoint, unexpected squawk/altitude changes, military aircraft shadowing a vessel) and add an `aircraftFlagged` field to the snapshot. This is the most defensible next expansion because the raw data already exists — it's pure detection-logic work, no new feed integration.

**Phase 3 (deliberate, not urgent) — maritime news correlation.** Wire `feedManager.js`'s already-tagged articles (sanctions/incident/chokepoint) into the snapshot as a fifth domain, so a chokepoint closure that coincides with a breaking sanctions article becomes a cross-domain trigger instead of two things a human has to notice separately.

**Not recommended — general political events and open-ocean traffic-flow.** Both are real projects (new ingestion pipeline; new basin-wide analytics), not "wire up what's already there." Worth a future research memo of their own if there's a specific reason to want them, but they'd meaningfully change what this product is rather than sharpen what it already does.

## Sources

- Direct codebase read: `discoveryManager.js`, `discoveryRules.js`, `integrityManager.js`, `invariants.js`, `chokepointManager.js`, `rfIntelManager.js`, `rfEmergencyBeaconManager.js`, `flightManager.js`, `satelliteManager.js`, `feedManager.js`
- `research/six-ideas-roadmap.md` (2026-06-12) — prior feature planning, confirms aircraft/satellite anomaly detection were never built
- `research/multi-domain-survey.md` (2026-06-06) — confirms satellite tracking has since shipped ahead of that memo's Phase 2 recommendation
- [xrf.ai](https://www.xrf.ai/) — homepage, product overview
- [xrf.ai/defense](https://www.xrf.ai/defense) — "AI-Driven Courses of Action" as named feature, NATO APP-6/STANAG, VBS4, UXV integration
- [xrf.ai/industry](https://www.xrf.ai/industry) — Port of Valencia site-security case, asset/perimeter monitoring model
