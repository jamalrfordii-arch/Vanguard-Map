# Decisions — standing choices and their reasons (append-only)

- **2026-06-14 — AIS Integrity feature COMPLETE (engine + all 4 UI surfaces).** Watchlist integrity
  column added (chip per row: faint green ● when TRUSTED, tier-coloured score when flagged) — verified
  live (TRUSTED=green ●, SUSPECT=violet "40"). Unified the tier palette to ONE language everywhere:
  TRUSTED #7ad97a / QUESTIONABLE #ffa726 / SUSPECT #d500f9 (violet) across card, board, map ring,
  watchlist (SUSPECT was red in the panel — changed to violet to match the map ring, since red is
  taken on the map). Full feature surfaces: (1) card AIS INTEGRITY section, (2) Vanguard Panel
  INTEGRITY triage board, (3) pulsing violet SUSPECT map ring, (4) watchlist column. Engine =
  integrityManager.js (event-driven scoring, on-land tuned to weak signal, tested). DONE.

- **2026-06-14 — Integrity Phase 4: pulsing electric-violet map ring for SUSPECT vessels.** Reserved
  hue **#d500f9** (NOT red — red is triple-booked: dark-vessel marker, CARGO hull, ping ring; amber =
  tanker/anomaly). Ring shown ONLY for tier SUSPECT (QUESTIONABLE stays in card/board to keep the map
  calm); severity reads via fast ~1 Hz pulse. Built in entityBuilder (sibling ring like ping/anomaly) +
  driven in main.js animate loop by `integrityManager.tier()`. Verified: ring created on all vessels +
  tier detection works; live pulse not screenshot-verified because the automation tab is backgrounded
  (rAF paused — known gotcha) — renders on a focused tab. REMAINING: watchlist integrity column (last
  bit of the integrity UI).

- **2026-06-14 — Integrity UI Phase 3 (triage board) shipped + verified.** New "INTEGRITY" Vanguard
  Panel tab + `#vp-integrity` pane (index.html); `initIntegrityBoard({flyTo})` in uiController (wired in
  main.js with the RF panel's fly-to). Lists `integrityManager.flagged()` worst-first — name, tier·score,
  class, top reason (+N), click-to-fly + opens card; tab badge = flagged count; live-updates on
  `vg1:integrityChanged`; clean empty-state on benign data. Verified live (synthetic SUSPECT rendered).
  Remaining Phase 4: tier-coloured map ring on flagged vessels + integrity column in the watchlist.

- **2026-06-14 — Integrity UI Phase 2 (vessel card) shipped + on-land detector tuned.** Card now has an
  "AIS INTEGRITY" section (`vd-integrity-section` in index.html, `renderIntegrity` in uiController) —
  tier badge + score + plain-language flags, refreshes live on `vg1:integrityChanged`. Verified on the
  live map. On-land detector recalibrated (see scar-tissue): neighborhood guard + weight 40→15 → false
  flags 182→0 on benign data, on-land now an informative weak signal. NEXT in Phase 3-4: INTEGRITY
  triage board (Vanguard Panel tab), tier-coloured map ring, watchlist integrity column.

- **2026-06-14 — Vessel classification fixed + bright hull colours + type cache.** Three linked fixes so
  vessels show their type instead of a grey fleet: (1) static handler reads `static_.Type` → updates
  class + rebuilds model (`onVesselReclassify`); (2) hull materials in entityBuilder use the BRIGHT
  SHIP_CLASSES colours (were muted → everything read grey/white); (3) NEW `typeCache.js` persists learned
  MMSI→class in localStorage (debounced, soft-capped 20k) and applies it at vessel creation, so
  previously-seen vessels render typed instantly instead of waiting ~6 min for the next static broadcast.
  Verified live: on reload, 19/19 cached vessels came up typed immediately; cache persists + grows.
  Brand-new/never-seen vessels still start OTHER (grey) until their first type broadcast — honest AIS.

- **2026-06-14 — Vessel type-icon sprites (vesselIcons.js) REMOVED; live AIS kept ON.** The grey/white
  "icons" Jamal wanted gone were the 2D type-icon sprites I'd added (all grey because of the OTHER-class
  bug). Removed them from entityBuilder + main.js. `vesselIcons.js` is now orphaned (no importers) —
  safe to delete. NOTE: I briefly over-corrected and disabled the whole live AIS layer
  (`AIS.LIVE_ENABLED=false`); Jamal clarified he only wanted the icons gone, so it's back to
  `LIVE_ENABLED=true` (verified: 500 vessels render, 0 with icons). The `LIVE_ENABLED` flag still exists
  as a reversible master switch if ever needed. The 3D vessel MODELS are the thing Jamal wants to keep
  developing.

- **2026-06-14 — AIS Integrity engine (Phase 1) BUILT + tested.** `integrityManager.js` — per-vessel
  0–100 trust score from flags: ON_LAND (terrain cross-ref), MMSI_INVALID, kinematic (reused from
  invariants: IMPOSSIBLE/EXCESSIVE_SPEED, SOG_MISMATCH, TIME_REGRESSION), DARK, LOITERING (STS). Tiers
  TRUSTED≥80 / QUESTIONABLE≥50 / SUSPECT<50; weights+thresholds in `config.js` INTEGRITY. Event-driven
  via `aisManager.onPositionEvaluated` (reuses invariant violations, O(1)/msg) + `tick()` timer for
  loiter/decay; render loop only reads. Engine is PURE (elevation injected via `setElevationFn`, wired
  in main.js to `getTrueElevation`) → node-testable. `tests/integrity.test.mjs` (10 cases, all pass).
  Spec in `INTEGRITY_SPEC.md`. NEXT: UI surfaces (Phase 2-4) — card section, Vanguard Panel INTEGRITY
  board, tier-coloured map ring, watchlist integrity column. Then Equasis false-flag cross-check (v1.5).

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
