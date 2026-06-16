# Decisions — standing choices and their reasons (append-only)

- **2026-06-14 — VANGUARD1's north star: a REAL ANALYTICAL TOOL, not just a 3D showcase.** Jamal's
  call after public feedback. The differentiator is **AIS Integrity / counter-spoofing** built on the
  existing `invariants.js` engine (surface it, don't reinvent) + new detections that reuse assets we
  already have (terrain `getTrueElevation` for on-land checks, MMSI MID vs flag, duplicate MMSI,
  loitering/STS). This is the Analysis phase of the OSINT doctrine paper. Aesthetics stay as the
  delivery vehicle, not the product. Open polish from feedback: projection mismatch (continents
  Mercator vs ocean-floor projection → black no-data gaps) and camera responsiveness (inertia/damping
  + the load-perf fixes the boot profiler points to).

- **2026-06-14 — Per-class 2D vessel map icons added (`vesselIcons.js`).** The 3D hull models only read
  up close; users expected a distinctive *icon* per type at map zoom. New canvas side-silhouette glyph
  per class (matches the vessel-class design sheet), cached as one THREE texture per class. Attached
  in `createAISVesselObject` as a camera-facing Sprite SIBLING in laneGroup (like the shadow, to dodge
  the 0.08 hull scale). main.js animate loop syncs position + shows it only at `28 < camera.y <= 150`
  (hidden up close so the hull takes over, hidden far where clusters represent vessels; also hidden
  when class-filtered or dark). Cluster diamonds left as-is (anomaly-ratio colour) per Jamal.

- **2026-06-14 — RF distress-beacon visuals removed entirely.** The red vertical beam columns were
  cluttering the map. Unwired `RFEmergencyBeaconManager` from `main.js` (import, instantiation,
  `rfBeacons.inspect` in onRawMessage, and `rfBeacons.tick`). KEPT the RF INTEL feed panel
  (`initRFIntelPanel`) — only the beacon detector+visuals were removed. `rfEmergencyBeaconManager.js`
  is now an orphaned file (no importers); safe to delete. NOTE: the dark-vessel laser-beam marker
  (`createDarkVesselMarker`) is a SEPARATE red-beam effect and was NOT touched.

- **2026-06-14 — Vessel taxonomy is civilian-only; military layer removed entirely.** Root bug:
  `aisTypeToClass` emitted 12 civilian classes but `entityBuilder.SHIP_CLASSES` only had CARGO +
  6 military shapes → every non-cargo vessel rendered as a red CARGO model. Fix: 12 bespoke civilian
  models (CARGO/TANKER/PASSENGER/HSC/FISHING/TUG/DREDGER/PILOT/SAILING/PLEASURE/SERVICE/OTHER), each
  with a distinct hull + marker color. Removed the dormant military layer (HOSTILE/PATROL/SUBMARINE/
  FIGHTER/AWACS/DRONE) across entityBuilder (shapes, materials, dead spawners), aiCopilot (threat
  score + composition order), chokepointManager (MILITARY_CLASSES), main.js (SITREP threat ladder now
  keys off darkCount; removed AWACS-spin/sub-tether/FIGHTER-trail anim), contextCardManager (cards),
  uiController, config.js (speed limits). Verified: every AIS code 0-99 maps to a class with a model.
  NOTE: this REVERSED the earlier "keep military for adversary modeling" lean — Jamal chose full removal.
  Real flight (AIRLINER) path left untouched per "only vessels".

- **2026-06-14 — Full Equasis dossier SHIPPED & confirmed working by Jamal.** Parser rewritten to
  mirror rhinonix/equasis-cli structure (row/col grid + tableLS/tableLSDD tables); fetches 3 tabs
  (ShipInfo, ShipInspection, ShipHistory). Card shows collapsible sections: PARTICULARS, MANAGEMENT
  & OWNERSHIP (every role), INSPECTIONS (per-PSC DETAINED/clear + detention count, auto-opens on a
  detention), SHIP HISTORY (former names/flags). Cache bumped to `equasis-cache-v2.json` (gitignored).
  Verified via fixture test (`/tmp/eqparse_test.mjs`). Pushed from Jamal's terminal (sandbox git unsafe).

- **2026-06-14 — Adopt the Nasr et al. OSINT cycle as VANGUARD1's stated doctrine.** The 5-phase
  cycle (Identification→Collection→Processing→Analysis→Dissemination) is now the lens for placing
  new capabilities. See `doctrine-osint-cycle.md`.
- **2026-06-14 — VANGUARD1 stays passive-OSINT only.** No active probing/scraping-for-attack
  features. Active techniques live only in adversary modeling. Ethics + legal (GDPR) guardrail.
- **2026-06-14 — Equasis dossier resolves IMO from vessel name automatically.** Manual IMO box kept
  only as an optional override. (Per Jamal: "I don't think we should have to enter in that number.")
- **2026-06-14 — Name→IMO matching uses confidence tiers and refuses to guess.** `pickBest` returns
  high (name+flag) / medium (exact name, flag unmappable) / low (flag-only or sole result) / none.
  On `none` (multiple namesakes, no flag agreement) it returns candidate IMOs instead of picking [0].
  AIS flag is ISO alpha-3; Equasis lists country names → `FLAG_NAMES` map bridges them. Card shows a
  ⚠ "verify this is the right ship" badge for anything below a clean name+flag match.
- **Earlier — License is proprietary, All-Rights-Reserved** (changed from MIT).
- **Earlier — Honest AIS vessel classifier.** Civilian taxonomy only (CARGO/TANKER/PASSENGER/…),
  no fabricated military classification.

_Append new decisions at the top with a date._
