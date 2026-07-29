# Decisions — standing choices and their reasons (append-only)

- **2026-07-25 — tile-point land colour retoned: saturation 1.40 → 1.15 + hue-aware shaping, and
  `elevToColor`'s land ramp stops treating altitude as aridity.** Jamal, from two close-up
  screenshots: "land mass colors look off here, you need to tone them to the proper colors." The
  render showed sunlit slopes as a uniform neon gold-ochre and shadowed hollows as vivid teal, with
  no green anywhere. Two independent causes, both in `tilePointsBuilder.js`:
  (1) **`POINT_SATURATION: 1.40` applied as a flat luminance-preserving chroma multiplier.** Wrong
  shape for satellite imagery, because orbital terrain imagery is split by its illuminant: sunlit
  ground carries the warm direct-sun cast, shadowed ground is lit almost entirely by blue skylight.
  A uniform multiplier amplifies *that split* rather than surface albedo, so it drives warm ground
  further orange and cool shadow further cyan — the exact two artefacts on screen. Measured on
  representative Cesium pixels: tan rock `#8c7861` → `#937656` (chroma 0.22 → 0.238, blue crushed);
  arid slope chroma 0.22 → 0.308, a 40% inflation; shadow `#1a212e` → `#172133`. Replaced with
  `POINT_SATURATION 1.15` plus two shaping terms — `POINT_WARM_TRIM 0.65` (withholds the boost in
  proportion to how orange/yellow-dominant a point is, so rock and sand keep their real colour while
  vegetation and water still gain vividness) and `POINT_SHADOW_DESAT 0.55` below a
  `POINT_SHADOW_L 0.20` luminance knee (below which the imagery's colour is skylight, not albedo).
  Both default-to-0 for a clean A/B. Also dropped the output clamp 1.15 → 1.0: the old ceiling sat
  *above* `bloomPass.threshold` (0.95), so saturated terrain measured 1.150 on all channels and
  bloomed. A previous author flagged this in a comment and deliberately left it because dimming the
  brightest points 13% while the gold cast remained would have read as a regression — with the cast
  gone that tradeoff reverses.
  **This was the third occurrence of one mistake at one value.** A 1.4× saturation boost was removed
  from IBTrACS `categoryColor()` on 2026-06-20 for shifting hues (Cat-2 orange → yellow), and
  `SPLAT_SATURATION` went 2.10 → 1.30 on 2026-07-13 for crushing real colour variation into uniform
  lime. Neither fix propagated to the tile path, which is the surface you actually see close up.
  `config.test.mjs` fenced `SPLAT_SATURATION` and nothing fenced its twin — see scar-tissue.
  (2) **`elevToColor` treated elevation as a biome map.** Every land band from 600 m up ran
  orange-brown, peaking at r0.54/g0.18/b0.12 — chroma **0.460**, a fully saturated desert ochre —
  for ground that at that altitude is forest across most of the planet. Green stopped leading red at
  ~300 m, which is where the cast began. Rewritten low-chroma (max **0.210**): green through the
  vegetated altitudes, warm *neutral* grey rock above treeline (the blue channel now rises into rock
  instead of falling), snow at the top. Elevation honestly predicts only treeline and snowline;
  biome colour comes from the imagery via `PHOTO_BLEND` (0.92 close-up), which actually knows. The
  low chroma matters even where imagery is present: the palette keeps an 8% share of every blended
  point, and at 0.46 that 8% dragged the whole surface warm *before* saturation amplified it.
  Now numerically guarded: C0-continuous at every band boundary (an early draft ended the alpine
  band at 0.72/0.73/0.75 against snow's 0.86/0.90/0.96, which would have drawn a visible contour
  line around every peak at 3800 m) and monotonic in luminance (two seams found this way, a −0.0008
  drift in the montane band and a −0.005 step at 1500 m — both invisible alone, both traps for the
  next person tuning it). 7 new checks in `config.test.mjs`; all 33 `tilePointsBuilder` tests still
  pass. **Not yet verified on screen by Jamal** — the values are deliberately A/B-able and should be
  confirmed live before they're treated as calibrated the way the 2026-07-13 splat pick was.
  Side finding: `TILESTREAM.POINT_BRIGHTNESS` is a **dead key** — nothing reads it. Left in place
  with a warning comment rather than deleted, since removal is a separate verifiable change.

- **2026-07-23 — Collection-lead feed-trust audit → 5 follow-on fixes (aircraft source tier,
  RF/FEED honesty copy, satellite RETIRED, stale review doc deleted).** A live audit (Jamal, from
  DevTools + network log) found that only AIS was fully trustworthy; several indicators said "LIVE"
  or "OFFLINE" for reasons that didn't match reality. Fixes:
  (1) **Aircraft source-tier indicator.** `/flights` was live but silently on the OpenSky `/states/all`
  FALLBACK tier (confirmed live: 0/200 sampled aircraft carry `r`/`t`, all `dbFlags:0` — the primary
  ADS-B mirrors airplanes.live/adsb.lol have been down since ~2026-06-26). The proxy exposed no source
  to the client, so the HUD read "LIVE // ANON" on either tier — a fidelity downgrade (esp. military
  classification, which needs `dbFlags`) was invisible. Now `flight-proxy.js acceptBody()` tags each
  payload `source: 'adsb' | 'opensky'` (and `'unavailable'` on the empty fallback); `flightManager`
  reads it → `LIVE // ADS-B` vs `LIVE // OPENSKY (REDUCED)`; status bar shows a 4th readout `REDUCED`
  (amber text, live dot — data flows, fidelity is down). **Needs proxy restart to surface the real tier**;
  until then the client defaults to ADS-B.
  (2) **RF empty-state honesty.** The RF pane's static placeholder claimed `SPECTRUM MONITORING ACTIVE`
  — false: zero detectors are wired to `rfIntel` (the only one, `rfEmergencyBeaconManager`, isn't imported;
  `gpsJammingManager` is static 2025 OSINT zones that don't feed rfIntel). Now reads `NO LIVE RF DETECTOR /
  GPS JAMMING ZONES ARE STATIC / OSINT REFERENCE (2025)`; runtime list empty = `NO RF EVENTS — NO LIVE
  DETECTOR CONNECTED` (and its clear-on-first-event guard was loosened to `startsWith` to match).
  (3) **FEED empty-state copy.** `FEED NOT CONFIGURED / … AFTER API SETUP` was misleading — the feed is
  keyless rss2json, needs no setup, and works (live: 45 articles, feeds return 10 items, 8/10 pass the
  maritime gate). The audit's "zero articles" was pre-first-refresh session lag — already fixed by the
  earlier #4 background-refresh change. Copy now `LOADING MARITIME NEWS… / OPEN THIS TAB IF EMPTY`.
  (4) **Satellite layer RETIRED (Jamal's call: "fix or remove").** The tracking feature was never wired
  into `main.js`. Deleted `satelliteManager.js`, `satelliteBuilder.js`, `satArcManager.js`,
  `instancedSatManager.js`; removed the SAT sys-panel row, the status-bar SAT segment + its mirror JS +
  `watchDot` + `#sat-dot.live` CSS, and the dead `satelliteManager` param in `uiController.setupUI`;
  dropped the sat rows from CLAUDE.md's module map. The TLE backend (`flight-proxy /satellites`) still
  works if it's ever rebuilt. (`satelliteCloudLayer.js` is a DIFFERENT thing — VIIRS night-cloud imagery
  — and was left alone.) This supersedes the earlier `NOT ENABLED` relabel.
  (5) **Deleted `ORPHANED_FILES_REVIEW.md`** — stale (2026-05-16), it listed `directorManager.js` and
  `gaussianSplatOverlay.js` as orphaned though both are wired now, and the auditor leaned on it as truth.
  Same docs-vs-shipped rot fixed with `layerManager`.
  All `node --check` clean; live-verified in-browser: SAT gone from HUD + status bar, RF/FEED copy correct,
  AIS/AIR/NEWS LIVE, app healthy. Space weather (real NOAA 503s) and AIS (trustworthy) needed no action.

- **2026-07-23 — RF intel panel fully REMOVED (Jamal: "if RF not live, remove it").** Confirmed dead:
  no live detector was ever wired to `rfIntel` (the only one, `rfEmergencyBeaconManager`, was never
  imported; `gpsJammingManager` is a separate static map layer that doesn't feed it). Deleted
  `rfIntelManager.js` + `rfEmergencyBeaconManager.js`; removed the main.js import + `initRFIntelPanel()`
  call, and the RF tab button + `vp-rf` pane from index.html. `discoveryManager.js` still reads
  `window.rfIntel` but behind a `typeof window.rfIntel` guard, so it now degrades to `rfEvents: []` —
  RF simply drops out of the cross-domain discovery snapshot. Live-verified: RF tab gone, `window.rfIntel`
  undefined, no console errors, app healthy. NOTE: `gpsJammingManager` (static 2025 OSINT jamming zones,
  a real map layer with a toggle) was intentionally LEFT — it's honest static reference, not the dead
  RF feed. SITREP and the ADS-B mirrors were both KEPT after Jamal confirmed: SITREP is functional
  (local synthesis from watchlist/alerts/feed + AI-copilot version) — kept, and only its misleading
  empty-state copy was fixed (`APPEAR AFTER API SETUP` → `OPEN THIS TAB TO GENERATE A SITUATION REPORT
  FROM LIVE SCENE DATA`). ADS-B mirrors kept — they're the PREFERRED full-fidelity aircraft source
  (currently blocked → on OpenSky fallback); removing them would permanently lock the feed to the
  degraded tier, and the new source-tier indicator already makes that downgrade visible.

- **2026-07-24 — Distance/bearing measurement tool + GeoJSON export.** Jamal asked "what if
  we want to do real life operations, or at least measure the map with complete accuracy?"
  Scoped via AskUserQuestion (re-asked once at Jamal's explicit request, same answer both
  times): all three offered options selected — measurement tool, coordinate export, AND an
  explanation of accuracy gaps (see below). Built the two capabilities; the accuracy
  explanation is a separate note, not code.
  **New `measureManager.js`** — two-click ruler using real great-circle math
  (`haversineNm` + newly-exported `bearingDeg`, both from `dataSource.js` — `bearingDeg` was
  already written for port-call distance checks but had never been exported). Deliberately
  pick-agnostic: does NOT import `uiController.js` (which owns `requestMapPick`/raycasting)
  because `uiController.js` needs to import measureManager for UI wiring — two-way imports
  would be a cycle, which CLAUDE.md's dependency policy explicitly forbids. Instead
  `uiController.js` drives the two clicks and calls `measureManager.submitPointA(pick)` /
  `.submitPointB(pick)`; measureManager owns only state + the in-scene line/markers/label
  (amber dashed line, ring markers, canvas-texture sprite reading "N.N NM · BRG NNN°").
  True singleton export (`export const measureManager = new MeasureManager()`), `window.vg1Measure`
  debug mirror only — same Tier 3 pattern as `portCallManager`.
  **New `geoExport.js`** — pure data module (no THREE, no scene access) producing standard
  GeoJSON: `measurementToGeoJSON()` (LineString + 2 Points, distance/bearing in properties),
  `vesselTrackToGeoJSON()` (reads a vessel's real `userData.posLog` — throttled ~30 min,
  capped 48 entries/24h — into a LineString + Point-per-fix; **deliberately returns `null`
  for zero recorded fixes and omits the LineString entirely for exactly one fix**, rather
  than fabricating a track from insufficient data), `downloadGeoJSON()` (Blob + temporary
  anchor). GeoJSON chosen over GPX/KML as simplest-to-hand-author-correctly and broadly
  interoperable (QGIS, geojson.io, Google Earth import).
  **UI**: new "📏 MEASURE" button (`.sector-btn`, full-width row like HOME/ALT.WATCH) in
  `#right-toolbar`'s Tools row; a floating `#measure-panel` (amber accent, matches the
  alert-zone-badge convention) shows the readout + EXPORT/CLEAR once both points are picked;
  new "⇩ EXPORT TRACK" button on the vessel-detail card under LOCK TRACK, wired in
  `setupUI()` next to the existing `vd-track` handler, using `_detailShip.userData`.
  **Verified live via Chrome MCP**, not just syntax-checked: clicked MEASURE, picked two
  real map points, confirmed `window.vg1Measure.current()` returned
  `{distanceNm: 6572.4, distanceKm: 12172.2, bearingDeg: 50.4}` for
  `(-22.56, 31.16) → (43.09, 127.22)` — cross-checked against an independent Node
  reimplementation of the same haversine/bearing formulas, exact match. Confirmed the
  dashed line rendered in-scene, the readout panel text, and CLEAR fully resetting state
  (`current() → null`, panel hidden, button text reset). Confirmed `vesselTrackToGeoJSON`
  against a real in-app vessel (1-fix log → single Point, no fabricated line) and a
  synthetic 3-fix log (correct LineString + 3 Points, correct `[lon, lat]` coordinate
  order, correct metadata). Zero console errors throughout.

- **2026-07-23 — Ship/vessel true-scale rendering.** Revisits a topic explicitly shelved
  earlier this session ("do neither at the moment") — Jamal asked again, and this time
  confirmed via AskUserQuestion he wanted "true scale + minimum-visible floor" specifically
  (not literal 1:1, not just a smaller flat multiplier). All ship classes previously
  rendered at one identical fixed scale (`shipInstancer.js`'s old `SHIP_SCALE=0.08`) — a
  fishing boat and a VLCC looked the same size, only hull shape/color differed by class.
  **Literal 1:1 scale was deliberately rejected, and this is disclosed, not hidden:**
  `MAP_WIDTH=300` spans the planet's full longitude circumference, so a real 300m tanker
  would render at ~0.002 scene units — sub-pixel at every zoom level. At true 1:1, EVERY
  vessel including the largest supertankers would collapse to the same invisible floor,
  destroying the exact proportional differences the feature exists to show. Instead: new
  `SHIP_RENDER` config namespace (`BASELINE_SCALE:0.08` = anchor matching the old fixed
  look, `REFERENCE_LENGTH_M:180` = the real length that renders at that anchor,
  `MIN_RENDER_SCALE:0.02` = floor, `TYPICAL_LENGTH_BY_CLASS` = coarse per-class fallback
  lengths, same idiom as `CARGO.MAX_DRAFT_BY_CLASS`). `aisManager.js` now captures real
  hull length from `ShipStaticData.Dimension.A + .B` (bow+stern distance from GPS antenna,
  meters; sanity-bounded `0 < length <= 500`, rejects garbled/absurd values) and computes
  `renderScale` via new `computeRenderScale()` — proportional to `REFERENCE_LENGTH_M`,
  floored, **always resolves to a real number** (unlike the cargo-estimate fields, there's
  no legitimate "unknown, render nothing" state for a 3D model's scale — falls back real
  length → class-typical length → reference length, in that order, computed immediately at
  vessel-spawn using any cached class from `typeCache` so it's never stuck at a generic
  default longer than necessary). Threaded `renderScale` through all three
  `shipInstancer.update()` call sites in `main.js` (`onVesselNew`, `onVesselUpdate`,
  the per-frame sync loop — the last one reads from `userData`, so `renderScale`/`lengthM`
  got added to the existing `userData` copy blocks alongside the cargo-intel fields).
  `shipInstancer.js`'s `update()` now takes a 5th `scale` param, mutates the existing
  scratch `_shipScaleVec` per-call via `.setScalar()` (no new allocation) instead of using
  a fixed module-level vector; falls back to the old `SHIP_SCALE` constant if a caller
  omits the param, so a missed call site degrades gracefully instead of zero-scaling.
  Verified two ways: (1) isolated Node script exercising `computeRenderScale` +
  Dimension-parsing against edge cases — the real 47m example from aisstream.io's own
  docs, a 330m synthetic VLCC, a 12m fishing boat, garbled 1800m data (correctly
  rejected), all-zero dimension (correctly rejected, a known real-world AIS data-quality
  issue), and no-dimension-at-all — every case matched expected math exactly, including
  the 330m/47m real vessels preserving their true ~7x length ratio as a ~7x render-scale
  ratio once neither hit the floor; (2) live in-browser 2026-07-23 — confirmed all 800
  live vessels got sensible class-fallback scales immediately (no real Dimension data
  happened to arrive this session — a known AIS quirk, not a bug, the fallback path is
  exactly what's supposed to cover this), then flew the camera to an identical relative
  distance from a PASSENGER vessel (scale 0.0978) and a TUG (floored at 0.02) and
  screenshotted both — the tug's hull visibly shrank to a small sliver next to the
  passenger ship filling much of the frame, matching the expected ~5x ratio, and never
  fully disappeared (floor working as intended).

- **2026-07-23 — Cargo intelligence, Phases 3 & 4: probable-cargo inference + chokepoint
  laden-flow aggregation.** Completes the roadmap in
  `research/vanguard1-cargo-intel-spec-2026-07-23.md`.
  **Phase 3 (vessel card):** new `_inferProbableCargo(shipClass, portType)` in
  `uiController.js` — pure, stateless, combines vessel class + laden state + the last
  completed departure port's free-text `type` (from `portManager.js`'s `PORTS`) into a
  label, confidence **hard-capped at MEDIUM** (never HIGH — this has no manifest behind
  it), dropping to LOW for genuinely ambiguous cases (a port serving both bulk and
  container traffic, for instance — the code can't disambiguate from draft alone and
  says so via the lower confidence rather than guessing harder). New `PROBABLE CARGO`
  row in `#vd-cargo-section`. **BALLAST vessels get an explicit "no cargo aboard"
  string, not a cargo guess** — showing a probable cargo for an empty ship would be
  actively wrong, not just uncertain, so it's handled as its own case rather than
  falling through the inference path.
  **Phase 4 (chokepoints):** `chokepointManager.js`'s existing per-tick vessel
  classification loop (already computing `count`/`darkCount`/`stoppedCount` per
  chokepoint box) now also tracks `ladenCount` from each vessel's Phase-1
  `ladenState`. New read API `laden(code)` / `all()` returns `{count, ladenCount,
  ladenFraction}` per chokepoint — **explicitly documented as an instantaneous
  snapshot** ("of the vessels here right now, what fraction are laden"), not a
  cumulative transit count or a flow rate; turning this into a real "barrels/day"
  metric would need the same time-windowed tracking `portCallManager.js` does for
  ports, which this does not attempt. `window.vg1Chokepoints` added as a debug
  mirror (constructor), matching the project's established convention.
  Live-verified in-browser 2026-07-23: chokepoint aggregation confirmed by calling
  `tick()` directly with 5 synthetic vessels placed inside Hormuz's box (3 laden, 1
  ballast, 1 unknown) — returned `{count:5, ladenCount:3, ladenFraction:0.6}` exactly
  as expected (no cleanup needed — `tick()` runs every animation-loop frame with real
  data, so the synthetic call was overwritten within one frame). Probable-cargo
  inference confirmed across five cases on real vessels: no data → `—`; BALLAST →
  "no cargo aboard"; TANKER + oil-specialized last port → "Crude / product oil
  (MEDIUM)"; CARGO + mixed bulk/container port → "Bulk or containerized goods (LOW)";
  CARGO + container-only port → "Containerized goods (MEDIUM)" — all test data
  removed from `portCallManager`'s log and vessel `userData` afterward.
  **This closes out the full four-phase cargo-intelligence roadmap** from the
  original spec: draft capture → port-call detection → probable-cargo + card
  surfacing → chokepoint laden-flow aggregation.

- **2026-07-23 — Cargo intelligence: LAST PORT / VOYAGE card fields + portCallManager
  singleton fix.** Jamal asked where the vessel card's cargo data actually comes from, which
  surfaced a real dependency-policy violation: `portCallManager` was only reachable via
  `window.vg1PortCalls` — a Tier-3 debug global being used as the real data path, exactly what
  `CLAUDE.md`'s dependency policy says not to do. Fixed by exporting it as a true singleton
  (`export const portCallManager = new PortCallManager();`, same pattern as `integrityManager.js`)
  so `main.js` and `uiController.js` both import it directly; `window.vg1PortCalls` (still set in
  the constructor) is now correctly just a debug mirror. Added two vessel-card fields to
  `#vd-cargo-section`: **LAST PORT** (prefers a live `IN_PORT` state — "AT SINGAPORE (1h 2m)" —
  over stale history, since that's more useful if the vessel is sitting in port right now; falls
  back to the most recent completed call, "SINGAPORE (1h 30m AGO)") and **VOYAGE**, which only
  ever renders `<last port> → <AIS destination>` when BOTH are actually known — rendering just one
  side would be presenting a guess as an inference, the same discipline as everything else in this
  feature. Live-verified in-browser 2026-07-23 on a real CARGO vessel (MMSI 255803470): confirmed
  both fields read `—` with no port-call data yet, confirmed the `IN_PORT` live-state rendering
  path, and confirmed the completed-call + known-destination path renders the full arrow — all via
  direct test injection into `portCallManager`'s state/log (real dwell takes 45 minutes, too slow
  to wait out live), with all test data removed from both memory and localStorage afterward.

- **2026-07-23 — Cargo intelligence, Phase 2: port-call detection.** New
  `portCallManager.js` (research/vanguard1-cargo-intel-spec-2026-07-23.md §5) — timer-driven
  state machine (`UNDERWAY → APPROACHING → IN_PORT → finalize back to UNDERWAY`, no lingering
  `DEPARTED` state) tracking every live AIS vessel against `portManager.js`'s `PORTS` centroids
  (now `export`ed — was module-private). Reused `dataSource.js`'s existing `haversineNm()` rather
  than writing a new one. New `CARGO` config constants: `PORT_CALL_RADIUS_NM: 12`,
  `DWELL_MIN_MS: 45min`, `STOPPED_SPEED_KTS: 1.5`, `TICK_MS: 10s`. Wired into `main.js` the same
  way `conflictManager` is — `new PortCallManager()` + `setInterval(() => portCallManager.tick(
  aisManager.vessels.values()), CARGO.TICK_MS)` — no per-frame half needed since this manager has
  no visuals, just state. On a completed call (`IN_PORT` → exits radius) it persists `{port,
  arrivedAt, departedAt, draughtOnArrival, draughtOnDeparture}` to a per-MMSI rolling log
  (localStorage, same debounced-flush/soft-cap shape as `typeCache.js`/`draughtCache.js`, key
  `vg1_port_call_log`) and fires `vg1:portCall`. Console: `window.vg1PortCalls` —
  `.current(mmsi)` (live state), `.history(mmsi)`/`.lastCall(mmsi)` (persisted completed calls).
  **Known approximation, by design:** ports are centroids with no harbor polygon, so a large
  port whose docks sit far from its centroid, or an offshore anchorage, can miscount — stated
  in the module header, not silently trusted.
  Live-verified in-browser 2026-07-23 with synthetic vessels dispatched straight through
  `tick()` (real vessels take up to 45 real minutes to dwell, too slow to wait out in-session):
  confirmed the `APPROACHING` transition fires immediately near a real port (ROTTERDAM) with
  the dwell timer starting `null` and only being set on the *next* tick (not the same tick as
  the state change — first-tick-per-transition, no telescoping); used `simClock.step()` to fast-
  forward past `DWELL_MIN_MS` and confirmed `IN_PORT`; then moved the same vessel far offshore
  and confirmed finalization — state reset to `UNDERWAY`, a correct completed record in
  `.history()`, and `vg1:portCall` firing with matching `port`/`arrivedAt`/`departedAt`/
  `draughtOnArrival`/`draughtOnDeparture`. (One test-methodology snag caught mid-verification,
  not a manager bug: `.current(mmsi)` returns the live object reference, not a copy — an early
  test captured it before `JSON.stringify`-snapshotting and read a since-mutated value; re-run
  with proper snapshotting at each step confirmed the state machine itself is correct.) Test
  MMSIs manually purged from localStorage + in-memory state afterward so no synthetic data
  lingers in the real persisted log. **Still not built:** cargo-label inference and vessel-card
  surfacing of `LAST PORT`/`INFERRED VOYAGE` (phase 3's remaining pieces — the draft/load-factor
  card fields already shipped ahead of this, see the entry below) and chokepoint laden-flow
  aggregation (phase 4).

- **2026-07-23 — Cargo intelligence: vessel-card surfacing (done ahead of port-call detection,
  by request).** Extends the phase-1 draft-capture entry below — Jamal asked to see the
  already-captured draft/load-factor/laden-state data on the vessel card before building
  port-call detection, so this jumps the original spec's phase 3 ahead of phase 2. `main.js`'s
  `onVesselNew`/`onVesselUpdate` now copy `draughtM`/`maxDraughtM`/`loadFactor`/`ladenState` from
  `vesselData` onto `obj.userData`, same manual-copy pattern already used for `destination`/`eta`/
  `imo`. New `#vd-cargo-section` in `index.html` (dashed amber border, distinct from the cyan/
  orange used elsewhere, to visually read as "estimate" rather than fact) with a permanent
  `ESTIMATED — NOT VERIFIED` tag — not decorative, this is the same honesty constraint from the
  phase-1 entry, carried into the UI. `uiController.js`'s `showVesselDetail()` shows the section
  for `ud.isRealAIS && class in {CARGO, TANKER}` (matching `config.js`'s `CARGO.MAX_DRAFT_BY_CLASS`
  keys) — shown even before a static message arrives, rendering "—" placeholders, so the section's
  presence itself signals "this vessel type gets an estimate" rather than popping in unannounced
  once data lands. Live-verified in-browser 2026-07-23 via `vg1:selectVessel` dispatch: (1) a real
  TANKER (MMSI 538010878, no draught yet) showed the section with all three fields as `—`; (2) the
  same vessel with a manually-injected draught (14.2m/88.75%/LADEN, display-layer only, doesn't
  touch `aisManager`'s real record or `draughtCache`) rendered `14.2m`/`89%`/`LADEN` correctly;
  (3) a PASSENGER-class vessel and (4) an aircraft both correctly hid the section entirely.
  **Still not surfaced:** probable-cargo label, last-port, inferred voyage — all depend on
  port-call detection (phase 2, not yet built, see spec for the reordering note).

- **2026-07-23 — Cargo intelligence, Phase 1: draft-based load estimate (draft capture only).**
  Full roadmap in `research/vanguard1-cargo-intel-spec-2026-07-23.md` (draft capture → port-call
  detection → cargo inference/UI → chokepoint laden-flow aggregation); this entry covers phase 1
  only. Added `CARGO` namespace to `config.js` (`LADEN_THRESHOLD: 0.85`, `BALLAST_THRESHOLD: 0.55`,
  `MAX_DRAFT_BY_CLASS: { CARGO: 12, TANKER: 16 }` — coarse fleet-average seeds, deliberately rough
  since AIS ship-type can't distinguish bulk/container/RoRo within CARGO). New `draughtCache.js`
  (mirrors `typeCache.js`'s debounced-flush/soft-cap localStorage pattern, console
  `window.vg1DraughtCache`) persists each vessel's highest-ever-observed draught as a per-MMSI
  proxy for its true loaded reference, since there's no hull/DWT database wired in — the field
  only ever raises, never lowers, on the theory that a lighter reading later is a real ballast
  trip, not evidence the vessel's full draught is shallower than previously seen.
  `aisManager.js`'s `ShipStaticData` handler now captures `static_.MaximumStaticDraught` into
  `existing.draughtM` — **verified against aisstream.io's live API docs that this is the correct
  field name** (their JSON API uses `MaximumStaticDraught`, not the AIS-spec name `Draught` the
  original spec draft assumed, and confirmed via their published examples — e.g. `4.5`, `3.3` —
  that it already arrives in meters, no decimeter scaling needed). New `computeCargoEstimate()`
  derives `maxDraughtM`/`loadFactor`/`ladenState` (LADEN/BALLAST/PARTIAL) — **every field reads
  `null` if draught or a usable max-draught reference is unknown, never guesses a state from
  missing data**, same honesty principle as `aisTypeToClass()`'s no-fabricated-military-class rule
  and the reason this phase exists in the first place (the recent audit's fabricated-`TRUSTED`
  badge bug is exactly the mistake this must not repeat). Vessel object gets four new fields
  (`draughtM`, `maxDraughtM`, `loadFactor`, `ladenState`), all `null` until a static message
  arrives. **Scope note:** this phase is aisManager.js's internal data model only — `window.
  aisShips[i].userData` and the vessel-detail card do NOT yet show these fields (main.js's
  `onVesselNew`/`onVesselUpdate` copy specific fields onto `userData` manually and haven't been
  extended yet; that's phase 3 in the spec). Verified: `node --check` clean on all three touched/
  new files; live-verified in-browser 2026-07-23 — `window.vg1DraughtCache.size()` went from 0 to
  4 real observations within seconds of reload (`210607000: 6.5m`, `232017193: 2.3m`,
  `244730643: 1.4m`, `257223700: 3.2m`), confirming the field is really present on live AISStream
  messages and the capture path works end-to-end; `computeCargoEstimate` logic double-checked
  against those real values plus synthetic edge cases (no-seed class, never-reported draught) in
  an isolated Node script — thresholds and null-handling both behave as designed.

- **2026-07-23 — Trust-indicator honesty punchlist (5 items): feed indicators must distinguish
  "slow", "not wired", and "stale" from "dead".** Jamal's throughline: a status pill that says
  OFFLINE for three different reasons is worthless to a collection lead. Fixes:
  (1) **AIR false-negative fixed at the root.** `/flights` upstream returns a GLOBAL list (~10k+
  aircraft, several MB); the client only keeps `FLIGHT.MAX_AIRCRAFT` (300) after its own filtering,
  so transferring the whole planet is what made a real response take 13s+ and trip the client
  timeout — reported identically to a dead proxy. Added a **server-side cap** in `flight-proxy.js`
  (`FLIGHTS_MAX_AIRCRAFT`, default 1200, env-overridable, 0=disable) applied in `acceptBody()` before
  cache/serve — bounds payload ~87% so a real response is always fast. Cap sits above the client's
  300 for filtering headroom; truncation is by upstream array order (same arbitrary selection the
  client already did, just moved server-side). AND `flightManager._poll` now splits failure modes:
  `TimeoutError` → `'FEED SLOW'` (feed likely alive but slow ≠ dead), everything else → `'PROXY
  OFFLINE'`; client timeout 15s→20s. Status bar (`index.html mirrorStatus`) renders AIR as three
  states LIVE/SLOW/OFFLINE (green/amber-pulse/red, new `.sb-dot-slow`).
  (2) **`layerManager.js` removed — it was dead code.** Never imported by `main.js`, nothing
  dispatched its `vg1:layerChanged`. The real, shipped layer path is `.lp-row[data-layer]` (index.html)
  → `layerToggle` CustomEvent → `switch` in `main.js` calling each manager's `setVisible(on)`.
  `layerCoordinator.js` is unrelated (terrain-detail LOD). Deleted the file + its orphan `LAYER`
  config block; corrected CLAUDE.md's module map + architecture-boundary rows + added an authoritative
  "Layer toggling" note. Inert leftovers NOT touched (single-source-of-truth in CLAUDE.md instead):
  stale header comments in `magneticFieldManager`/`oceanCurrentManager`/`waveFieldLayer`, and the
  `window.layerManager?.register` guards in `lightning`/`oceanCurrent` + `vg1:layerChanged` listeners
  in `birkeland`/`ionospheric`/`lightning` — all fire against something nothing sets. That's the
  honest TODO if geomagnetic layers ever need real toggles: wire them to `layerToggle` like the rest.
  (3) **SAT indicator relabeled `NOT ENABLED` (not OFFLINE).** `satelliteManager.js` is never imported
  in `main.js` (TLE backend proven live, client just not running), so `sat-status` never updates.
  Changed the default in the sys panel + status bar to `NOT ENABLED` (dim `.sb-dot-idle`, muted, no
  pulse) so "not wired up" reads differently from "feed went dark". If the manager is ever wired,
  `_updateStatus('LIVE // n TRACKED')` overwrites it and the mirror flips to LIVE automatically.
  (4) **NEWS now refreshes in the background.** `feedManager`'s poll was gated on the FEED pane being
  visible, so the status-bar LIVE flag (from `_lastFetch`) could read "fresh" against weeks-old cached
  articles just because the tab was never opened. Dropped the `vp-active` gate on the poll (kept it on
  `_render`, which safely no-ops when the shell isn't built — `_renderSection` guards missing DOM).
  (5) **RF empty-state copy:** `NO DETECTORS REGISTERED` → `NO DETECTOR SOURCE CONNECTED` (rfIntelManager)
  — a standing state since the 2026-06-14 beacon-detector removal, not a momentary lull.
  All syntax-checked (`node --check`), proxy booted + answered HTTP, cap logic unit-tested. **Live-verified
  in-browser 2026-07-23** (localhost:3000, via Chrome): SAT reads `NOT ENABLED` (sys panel + status bar,
  idle dot); RF empty state reads `NO DETECTOR SOURCE CONNECTED`; NEWS flipped `STALE → LIVE` on its own
  WITHOUT the FEED tab ever being opened (confirms the background-refresh fix, #4); AIR resolved LIVE with
  300 on map; no console import/module errors after the `layerManager.js` deletion. **Server-side cap (#1)
  confirmed live after proxy restart**: `/flights` went from 9020 aircraft / ~20s (pre-restart, the exact
  slow-but-real regime that read as OFFLINE) to **1200 / 6ms** (3ms cached) — a bounded, effectively-instant
  response; AIR stayed LIVE with the client still filling its full 300, confirming the cap headroom (1200 >
  300) was sized right. SLOW pill only surfaces if a poll actually exceeds the 20s timeout (didn't need to
  in normal operation). All 5 punchlist items done and live-verified. Cap observable in proxy logs (`N → capped 1200`).

- **2026-07-23 — Clamped animation-loop delta to fix aircraft "moving backwards."** Jamal
  spotted aircraft occasionally snapping backward live. Root cause: `main.js`'s main loop
  computed `delta = clock.getDelta()` with no upper bound. A backgrounded/throttled tab
  (alt-tab, screen lock, a GC pause) hands the next frame a multi-second delta; every
  per-frame dead-reckoning step that scales distance by delta (most visibly
  `flightManager.js`'s aircraft position extrapolation in `tick()`) then over-extrapolates
  an aircraft way past its true position in that one frame. The next live poll (30s
  cadence) corrects back to real GPS truth — and if the overshoot exceeds the existing
  "+10s forward" dead-reckoning buffer (added 2026-06-28 for a related but narrower
  snap-back bug), the correction is visibly backward. Fix: `const delta = Math.min(clock.
  getDelta(), 0.1)` — caps any single frame at ~6 frames' worth of travel at 60fps, well
  within normal frame-rate variance but short enough that no frame can extrapolate more
  than a fraction of a second of real movement. `elapsed` (absolute clock reading, used for
  shader/animation phase) is deliberately left unclamped. `node --check` clean; not yet
  live-verified against an actual tab-backgrounding event (hard to force one deterministically
  — will hold as confirmed once nobody reports another backward snap for a while).
  Also answered a second question from the same screenshot: the red line connecting two
  aircraft is `conflictManager.js`'s TCAS-style closest-point-of-approach check (red =
  CRITICAL severity, orange = advisory); the red ring around one aircraft is a *separate*
  system, `flightIntegrityManager`'s EMERGENCY flag (squawk 7500/7600/7700) — they just
  happen to share the same red (`0xff1744`), which is why they read as one connected thing.

- **2026-07-23 — `flight-proxy.js` converted from CommonJS to ESM — it was never actually
  runnable as written.** Jamal hit `ReferenceError: require is not defined in ES module
  scope` on `node flight-proxy.js` — `package.json` declares `"type": "module"` (matching
  every other file in the repo) but `flight-proxy.js`, `equasis-lookup.js`, and
  `memoryStore.js` were all still CommonJS (`require`/`module.exports`/`__dirname`), so the
  server could never have started under this project's config. Converted all three:
  `require(...)` → `import`, `module.exports = {...}` → `export default {...}` (kept the
  same object shape so call sites like `equasis.lookup(...)` / `memoryStore.appendEvent(...)`
  needed zero changes), `__dirname` → `path.dirname(fileURLToPath(import.meta.url))` in each
  file that used it for cache/log file paths. Verified: `node --check` clean on all three,
  then actually booted the server (`node flight-proxy.js`) and confirmed it listens on 8787,
  picks up `ANTHROPIC_API_KEY` from `.env`, and answers a real HTTP request (404 on an unknown
  path, as expected) before being killed. This also finally unblocks live end-to-end
  verification of task #67 (flightIntegrityManager → discoveryManager snapshot wiring,
  code-complete since earlier the same day but never confirmed against the real backend).

- **2026-07-22 — Vessel/ship subsystem code audit (research/vanguard1-ship-subsystem-audit.md) →
  three follow-up fixes, all syntax-checked (not yet live-verified in-browser).**
  Audit covered tracking (`aisManager.js`), trails (`trailManager.js`), 3D model design
  (`entityBuilder.js`/`shipInstancer.js`), and supporting features (wake, nav lights, waterline
  patch, clustering) — overall assessment: most mature subsystem in the codebase, two real gaps
  found and fixed same session:
  (1) **FALSE_FLAG implemented.** The weight (25 pts) had sat in `INTEGRITY.WEIGHTS` since the
  2026-06-14 integrity engine build ("then Equasis false-flag cross-check (v1.5)") but nothing ever
  set the flag — Equasis is an external paid dossier lookup never actually integrated. Implemented
  a lighter, self-contained version instead: `aisCountries.js` gains a new `CALLSIGN_PREFIX_TO_COUNTRY`
  table (ITU Appendix 42 call-sign series — a separate allocation from the MID table) and
  `callsignToCountry()`; `aisManager.js` now captures `CallSign` off `ShipStaticData` onto
  `existing.callsign`; `integrityManager.js` compares it against the vessel's already-computed
  `vessel.country` (MID-derived) and flags `FALSE_FLAG` on mismatch. Table coverage is deliberately
  partial (flag-of-convenience states + a handful of unambiguous direct-registry blocks) — an
  unmapped prefix clears the flag rather than guessing, so it can only under-report, never
  false-positive from missing coverage. Real Equasis integration (actual registered-flag lookup,
  not a callsign-prefix proxy) is still open if ever wanted.
  (2) **Hull orientation now tracks true heading.** Previously every vessel rendered broadside,
  fixed facing east (`obj.rotation.y = Math.PI/2` in `main.js`, baked into a shared constant
  quaternion in `shipInstancer.js`) — a deliberate 2026-06 legibility choice, but it meant the map
  never visually showed a vessel's real heading, and as an unnoticed side effect it had also frozen
  `wakeManager.js`'s wake direction (which reads `entity.rotation.y` and has documented a
  `rotation.y = PI - hdgRad` convention in its own header since before the instancer existed).
  Restored that exact convention: `shipInstancer.update()` now takes a `headingDeg` param and
  computes a per-vessel quaternion each frame instead of one shared constant (cheap — one
  Euler+Quaternion per live vessel, capped at `AIS.MAX_VESSELS`); `main.js`'s three call sites
  (`onVesselNew`, `onVesselUpdate`, the per-frame sync loop) now pass real heading through. Vessels
  with no heading yet (fresh spawn) fall back to the old fixed broadside orientation. Wake direction
  is correct again as a side effect of this fix, not a separate change.
  (3) **Masthead + sternlight added.** `navLightManager.js` had only port/starboard (2 of the 3-5
  COLREG running lights). Added white masthead (forward, highest, `MAST_HEIGHT=0.90`) and white
  sternlight (aft, lowest, `STERN_HEIGHT=0.40`) as two more pooled `THREE.Points` sets, positioned
  off the same per-vessel forward vector `(sin(hdg), 0, -cos(hdg))` the header comment had already
  documented but the code never used. Same simplification as the original pair: no per-fragment
  view-angle culling to the real COLREG arcs (225°/135°) — always-visible-at-night point sprites,
  realism is in count/color/position not viewing arc. A second, higher aft masthead light (required
  for vessels >50m under COLREG) is still not modeled — noted as a known remaining gap, not
  attempted this pass.
  **Not yet done**: live browser verification of all three (need a live AIS feed with vessels that
  actually have callsigns + varied headings to visually confirm) — flagged to Jamal as the next
  step before calling this closed.

- **2026-07-22 — Fixed four gaps found by a Method-1 persona walkthrough (research/vanguard1-method1-walkthrough-findings.md), all live-verified.**
  (1) **Options-card decision gap**: options-mode actions used to auto-execute on the model's own
  top-ranked hypothesis before a human read the ranked menu — the UI implied "you choose," the code
  did "I already chose." Fixed in `discoveryManager.js`: options-mode actions now sit in a new
  `_pendingActions` map keyed by `passId` and are only run via new public `confirmActions(passId)`/
  `dismissActions(passId)`, called from a new Confirm/Dismiss strip on the card (`uiController.js` +
  `index.html` `.disc-pending` CSS). Assessment-mode (no ranked options) still auto-executes —
  there's no menu implying a choice there. Live-verified: a real testOptionsMode pass showed the
  pending strip, Confirm ran the actions and flipped to "✓ CONFIRMED — ACTIONS EXECUTED".
  (2) **Feed staleness only visible for AIS/AIR**: added SAT/NEWS/WX segments to the bottom status
  bar. SAT mirrors the already-existing (but never surfaced) `sat-status` element; NEWS is new —
  `feedManager.js` now exports `getFeedHealth()` and broadcasts `vg1:feedHealth` after each refresh,
  judged stale after 2 poll cycles (30 min); WX listens to the existing `vg1:spaceWeather` broadcast,
  stale if no endpoint reported 'ok' in ~20 min. Live-verified all three render and update.
  (3) **ALERTS tab noise**: a feed outage could flood the log with near-identical WARNING-tier
  entries (e.g. 198× "AIRCRAFT LOST SIGNAL") at the same visual weight as rare CRITICAL ones.
  `alertsManager.js` now collapses runs of 3+ consecutive same-type non-CRITICAL entries into one
  expandable summary row; CRITICAL severity never groups, by design, since burying that is the exact
  failure this fixes. Live-verified a real 198× group collapsing/expanding correctly.
  (4) **MMSI-only references**: RULE lines and options reasoning named vessels by MMSI with no way
  to jump to them. `uiController.js` now linkifies bare 9-digit numbers (`.disc-mmsi-link`) in
  DISCOVERY body text, headlines, and option labels/reasoning, firing the same `vg1:selectVessel`
  event the AI's own `selectVessel` tool already uses. Live-verified the link renders and dispatches
  correctly (a synthetic test-fixture MMSI has no live 3D vessel to fly to, so the visual effect is
  a no-op there — expected, not a bug; real MMSIs use the same path already proven with YASMIN
  earlier in this session).

- **2026-07-21 — Fixed a real black-hole bug found via a live 25-location world sweep: an empty
  (0-point) tile was still claiming coverage, hiding the correct base splat cloud underneath.**
  Location sweep purpose: regression-test everything fixed today plus catch anything missed, by
  visiting diverse terrain (coasts, desert, jungle, poles, mid-ocean, antimeridian, farmland, etc.).
  Over Kansas farmland (lon -99, lat 39), tile `7/57/90` rendered as a solid black square that did
  NOT resolve with waiting (unlike several other locations' transient loading flashes — see below).
  Root cause, confirmed by direct inspection: the tile's built geometry had `position.count === 0`
  — every vertex in this tile's QM data apparently read below `OCEAN_MARGIN_M` despite the real
  Terrarium DEM at this exact spot reading 397-750m (genuine Kansas plains). Most likely trigger:
  the existing `_flatQM` decoder-overrun fallback (used for near-flat ground — exactly what
  farmland is) sets all 4 vertices to the same `minHeight`, and for this tile that value read
  negative — exact reason not fully pinned down (possibly a bad header read on a malformed
  response), but the effect is clear: today's 2026-07-20/21 ocean-exclusion filters correctly zeroed
  out every sample, leaving nothing to draw. The real bug this exposed: an empty tile was still
  being registered in `_tiles` at full opacity, and `hasCoverageAt()`/`solidCoverage()` only check
  opacity, never point count — so they told the base splat cloud (which has correct real elevation
  here) "this spot is covered, fade out," while the tile itself drew nothing. Net result: true black
  hole over real land. Fix in `tileStreamManager.js`'s points branch of `_loadTile`: if the built
  geometry has zero points, dispose it, don't register it in `_tiles`, and blacklist the key in
  `_unavailable` (same treatment as a 404) so it isn't retried every frame — the base cloud (or a
  coarser tile level) correctly remains visible as backstop instead. Verified via direct point-count/
  opacity inspection after a fresh reload at the exact same coordinates: no more 0-point tiles
  registered, `_unavailable` correctly grows to include such keys.
  **Investigated but ruled out as a separate bug**: additional dark/black squares seen during
  testing at this same location were chased hard (raycasting, toggling the water plane's
  visibility on/off with `window.__seaMesh` to rule out water-over-land occlusion, checking baked
  `aLandMask` values directly). Conclusion: these were NOT the water plane (hiding it made no
  difference) and NOT additional 0-point tiles (point counts were full, 26-34k) — they were tiles
  genuinely still mid-fade (opacity 0.6-ish) that, given enough real wall-clock time (up to ~20-30s
  in one case), settled into normal, fully-covered, correctly-colored terrain with no further
  action. This looks like ordinary — if occasionally slow — tile/imagery load latency, most visible
  precisely because my test method teleports the camera instantly, which is far more abrupt than
  how a real user gradually navigates in. Not treated as a bug; noted here in case a similar report
  comes in from real usage, to help distinguish "still loading, wait" from "actually broken."

- **2026-07-21 — Trimmed individual tile points that hung off the coast over open water
  ("tiles that hang off into the ocean").** Screenshot showed a translucent blue rectangular
  patch extending from the coastline out over clearly deeper water. Root cause: the 2026-07-20
  triangle-level ocean exclusion in `_buildPoints` only drops a triangle if ALL THREE vertices are
  past `OCEAN_MARGIN_M`. A triangle with one shore vertex and two far-out sea-floor vertices —
  common at z6/z7's coarse Cesium triangulation, where one large triangle can span from the coast
  across a wide, relatively flat seabed — still counted as "eligible" and got its full area-weighted
  point budget, with every sample across that triangle (including deep into its ocean side) still
  emitted, clamped to y=0, and coloured dark blue via `elevToColor`. That produced a solid-looking
  shelf of points hovering at sea level well past the real coastline. Fix: added a per-SAMPLE
  rejection inside the barycentric sampling loop — after computing each sample's interpolated
  elevation, skip it outright (no point emitted) if it's past the same `OCEAN_MARGIN_M` (-20m),
  even inside an otherwise-eligible straddling triangle. Shoreline-side samples of that same
  triangle still come through normally. Verified live at the Atacama coast dive used for the two
  fixes above: reproduced the exact overhang first (fresh dive, same camera position/angle as the
  reported screenshot), applied the fix, cleared cache, redived — clean coastline with land tiles
  stopping right at the water's edge, no translucent shelf, checked at both an early-load state and
  a later, more-settled state. No console errors.

- **2026-07-21 — Pure-ocean tiles are now never fetched at all in `tileStreamManager.js`
  (Jamal's explicit ask: "leave the ocean with no tiles").** Previously, the 2026-07-20 fix
  excluded open-ocean TRIANGLES from a tile's point budget after fetching it — correct, but still
  paid full QM + imagery fetch cost for a tile that could end up entirely empty. Added
  `TileCache._isPureOceanTile(tx, ty, key)`: before ever calling `_loadTile`, sample a 7×7 grid
  (49 points, cheap sync array lookups, no network) across the tile's real geographic bounds using
  the same low-res DEM already loaded for the base terrain/water-mask (`getTrueElevation`, imported
  from `terrainBuilder.js`). If EVERY sample reads below a conservative -60m margin (deeper than
  the ±20m per-point margins used elsewhere, specifically to avoid ever writing off a tile that has
  a real sliver of coastline), the tile is cached in a per-level `_pureOcean` Set and skipped for
  good — no QM fetch, no imagery fetch, ever, for that key. Checked `hasCoverageAt()`/
  `solidCoverage()` (main.js's gate for fading the base splat cloud) before shipping this: both
  already treat "no tile loaded here" as "keep the base cloud + water plane as backstop," which is
  exactly correct for genuinely-skipped ocean — no code changes needed there, the existing
  fallback design already covers this case. Verified live: at the Atacama coast (mixed land/ocean,
  same dive used for the load-speed fix), 19 of 49 candidate z7 tiles were correctly classified
  pure-ocean and skipped (`qmFetchCount` 30 instead of 49), coastline still rendered clean, and
  `stableAt` dropped slightly further (2.3s → 2.06s) from the reduced queue contention. At a
  genuinely deep mid-Pacific point (lon -150, lat 0), confirmed **zero** QM fetches fired in 5
  seconds after diving there (`performance.getEntriesByType('resource')` filtered on `.terrain`
  came back empty) while 68 candidate tiles got correctly pre-classified as ocean — clean water
  rendering via the base cloud, no black holes, no console errors, FPS 73-134 throughout testing.

- **2026-07-21 — Decoupled points-mode tile geometry from imagery in `tileStreamManager.js`'s
  `_loadTile()` — the real tile-load-speed fix, live-verified with an actual visible/focused tab.**
  The previous session's attempt was blocked by an environment issue (see scar-tissue.md — the
  automation tab was `document.hidden`, so `requestAnimationFrame` never fired and nothing
  load-related could be measured). With a real visible tab, a timed cold-cache dive
  (lon -71.5, lat -20, camY 8) gave real numbers: QM terrain fetches average ~163ms (max 275ms,
  98 tiles) — fast, healthy. ArcGIS imagery fetches average ~1.5s median / 2.8s p90 (max 3.85s),
  throttled to `IMG_MAX_CONCURRENT=20` concurrent slots. The points-mode branch of `_loadTile()`
  was `await`-ing the imagery fetch before building ANY geometry and before leaving the `_loading`
  set — so a tile's fast, ready geometry sat invisible for however long its imagery took, and with
  ~98 tiles funneled through 20 imagery slots, that's ~5 sequential waves — measured
  `stableAt` (all active-level tiles finished) at **10.0s**. Fix: build the point geometry
  immediately with `imgData=null` (the existing `elevToColor` palette fallback — never blank),
  store/show it right away, and remove it from `_loading` as soon as geometry-only build finishes.
  Imagery keeps fetching in the background (the parallel-fetch `imgPromise` from the 2026-07-20 fix
  was already in flight); when it resolves, rebuild the SAME tile's points a second time with real
  photo colour and swap the mesh in place (dispose the old one, carry over opacity/visibility/
  renderOrder so the swap doesn't pop). This mirrors the pattern `_buildMesh`/`_applyImagery`
  already used for mesh mode — "show now, drape later" — just adapted for points, which have no
  separate material.map to swap, so the fix rebuilds geometry instead (cheap: ~2.5ms/tile,
  previously measured) and relies on the deterministic per-tile RNG seed to guarantee identical
  point positions between the two builds, so only colour changes, not shape. Re-measured
  post-fix: **stableAt (geometry-only) dropped to ~2.3s** for a 49-tile single-level batch (not
  perfectly apples-to-apples tile-count-wise vs the 98-tile/10s baseline, but the qualitative
  result is unambiguous — completion is now gated on the fast terrain fetch, not the slow,
  concurrency-limited imagery fetch). Verified: no console errors, no visible pop/flicker on the
  palette→photo swap across two screenshots ~6s apart, FPS stayed 110+, imagery request count
  climbed from 20→98 in the background confirming it kept flowing unblocked. Left the earlier
  preconnect hints in place too (still a real, zero-risk assist on top of this).

- **2026-07-21 — Added `preconnect`/`dns-prefetch` hints for the Cesium/ArcGIS tile hosts in
  `index.html` as the first move on the deprioritized "tile load speed" item.** `tileStreamManager.js`'s
  own comments already establish the fetch itself is the dominant cost of a dive (~1.5-1.7s/tile,
  measured), and the very first request to a host in a session also pays cold DNS + TLS handshake
  on top of that. Added `<link rel="preconnect">` (+ `dns-prefetch` fallback) for `api.cesium.com`
  (Ion endpoint/session token), `assets.ion.cesium.com` (actual QM tile fetches), and
  `server.arcgisonline.com` (imagery export) so that handshake happens at page load, off the
  critical path, instead of on the first real tile request during a dive. Zero behavior risk —
  pure resource hint, not logic. **Not fully verified live**: attempted to live-measure an actual
  dive's tile-load timing before/after, but the automation tab was `document.hidden = true` for
  the whole session (see scar-tissue.md) — `requestAnimationFrame` never fired, so
  `tileStreamManager`'s `update()`/`_loadTile()` never ran regardless of camera position or wait
  time. Confirmed via a raw rAF counter (0 frames in 20s) and `document.visibilityState`. This
  means the preconnect change is verified SAFE (page loads, no console errors) but NOT verified
  FAST — that needs a real, foregrounded tab. Bigger, riskier ideas considered but not attempted
  without live verification: ramping `loadRadius` up from a small first pass instead of fetching
  the full radius immediately (would improve "time to any coverage" without changing total tiles
  eventually fetched), and raising `QM_MAX_CONCURRENT`/`IMG_MAX_CONCURRENT` further — left alone
  since the existing 48/20 caps were already live-tuned on 2026-07-15 with documented reasoning
  (throttling to 8 cut throughput 15×; 48 "keeps it flowing"), and there's no new evidence pushing
  higher would help rather than just add contention.

- **2026-07-20 — Coastal-fill pass added to `terrainWorker.js`'s land generation to close
  point-density gaps at coastlines ("the blue comes thru" — sparse land points over the now-
  correctly-masked water, visible after the water land-mask fix).** Same technique as the
  existing Antarctic ice-shelf fill, generalized: cells within `COASTAL_BAND_M` (8m) below sea
  level are rendered as sea-level land fill instead of being skipped as "ocean," closing gaps in
  the sparse land-point coastline band. Tuning history matters here — first tried 60m and
  live-verified it was WRONG: sampling `aHeight` on the actual output buffer showed the ocean
  point fraction dropped from a baseline ~0.297 to 0.248, meaning it was converting real, wide,
  gentle continental-shelf sea areas to flat "land" fill, not just thin coastlines. Dropped to 8m,
  fraction recovered to ~0.261 — a much more contained effect. Also had to raise `MAX_ALLOC`
  21M→24M with real headroom: the coastal fill pushed total candidates to ~21.3M, right at the
  old cap, which would have silently truncated ocean points again (the exact bug this session
  already fixed once) — caught via the `aHeight` sampling method, NOT via the worker's
  `console.warn`, which doesn't reliably surface through the browser-automation console reader
  (see memory/scar-tissue.md). Verified live: no truncation, no console errors, coastlines look
  solid and clean at both top-down and moderate-oblique views on the South America west coast
  (the reported location) after the fix, versus the scattered-dots-over-blue pattern before.
  **Known limitation, not fully solved**: extreme near-vertical elevation drops (the Andes/
  Peru-Chile trench specifically) can jump from strongly negative to strongly positive between
  adjacent LAND_GRID samples (~6.7km spacing) with nothing landing inside even an 8m band —
  a real fix for that specific case needs finer, coastline-adaptive sampling near steep gradients,
  not a wider band (proven a wider band just eats shelves instead). This fix helps ordinary and
  moderate coastlines, which is most of the world's coasts.

- **2026-07-20 — Cliff-coast fill added to `terrainWorker.js` to close the Andes/Peru-Chile
  trench gap the 8m coastal-fill band couldn't reach.** The 8m depth-band only catches coasts
  where the real elevation profile passes THROUGH a shallow depth on the way down; cliff coasts
  (this one: +4000m to -5000m inside ~1-2 grid cells) skip straight over that band, so the point
  still drops out. Depth alone can't tell "deep ocean next to a cliff" from "deep ocean in the
  open Pacific" — adjacency can. For any cell the depth-band pass would still skip (ocean,
  `hMeters < 0`), the land pass now samples the 4 neighbouring grid cells' real elevation
  (`getTrueElevation` at `x±cellW_L`, `z±cellH_L`); if any neighbour is land (`>0`), a coastline
  boundary crosses right here, so this cell fills at sea level regardless of how deep it actually
  reads. Cost is bounded — 4 extra elevation lookups per still-skipped ocean cell, i.e.
  proportional to remaining coastline length, not total grid area. Verified live at the exact
  reported coordinates (lon -71.5, lat -20, via `aisManager.lonLatToScene`, checked against
  known points first — origin, NYC, Santiago — to confirm the mapping before trusting it): solid
  continuous coastal point mass with a clean cliff edge into water, no scattered-dots-over-blue
  pattern, at both close and pulled-back oblique views. Point count landed at 20,419,151 (up
  ~200k from the 8m-only fix, ~1%) — comfortably under the 24M `MAX_ALLOC`, no truncation, no
  console errors. Ocean fraction sampled via `aHeight` at 0.273 (baseline ~0.297, previous 8m-only
  fix measured 0.261) — still a contained effect, not the runaway shelf-eating the 60m band caused.
  This is believed to close the specific case flagged as an open limitation in the coastal-fill
  entry above; if a similarly extreme cliff coast elsewhere still shows a gap, the adjacency check
  radius (currently just the 4 immediate grid neighbours) is the next knob to widen.

- **2026-07-20 — Raised LAND_GRID jitter amplitude 0.2→0.9 in `terrainWorker.js` to fix a
  moiré/crosshatch pattern at top-down, mid-high altitude (whole-continent) views.** Reported
  live over the Sahara: a fan/radiating streak pattern from one angle, a clean crosshatch grid
  from directly overhead. Root cause: land points sit on a regular `LAND_GRID` (6000×6000) lattice
  with only ±10% of a cell width of random jitter — close enough to a perfect grid that its spatial
  frequency beats against the screen's pixel grid at certain camera distances, classic point-cloud
  aliasing. `mulberry32` (the PRNG) is a solid, non-correlated generator, so this was an amplitude
  problem, not a bad-random-source one. Raised the jitter fraction from 0.2 to 0.9 of cell width
  (±0.45 of a cell — big enough to break the grid's regularity, still shy of 0.5 so points never
  cross into a neighbouring cell). Left the existing latitude taper ratio alone (1.0 at equator →
  0.20 at poles, same shape, scaled up from the new higher base) — that taper exists because
  scene-space X is linear longitude while real-world distance per degree of longitude shrinks near
  the poles, so equal fractional jitter is already proportionally smaller there. Verified live: the
  Sahara crosshatch is gone, replaced by ordinary fine point-cloud grain (expected, much less
  visually objectionable than a periodic pattern); re-checked at a high-latitude Siberia view (lat
  65) to confirm the taper still reads fine with the new base amplitude — no new grid artifact
  there either. No console errors.

- **2026-07-20 — Excluded open-ocean triangles from `tileStreamManager.js`'s points-mode
  tile budget ("tile extends to the ocean and I can still see the ocean through the tiles").**
  `_buildPoints()` was giving every QM triangle its area-weighted share of the per-tile point
  budget, land or sea alike — ocean triangles just clamp to `elevY=0`. Coarse-to-mid tiles (z6-z9)
  can span a long stretch of open water alongside a sliver of coast, and every point spent on that
  water was wasted: sparse (a few thousand points over a whole tile), sitting right at y=0 near the
  real water plane (y=-0.2), never fusing into a surface — so instead of solid ocean you got a faint
  scatter of dots hovering above the correctly-rendered water, letting it show through between them,
  while the adjacent land sub-tile read as a "floating" patch disconnected from it. Fix: triangles
  with all 3 vertices below `OCEAN_MARGIN_M` (-20m) get zero budget — excluded from the area sum
  entirely, so their share goes to land/coastal triangles instead. Also guarded the fully-oceanic-tile
  case (`totalArea === 0`) to skip the sampling loop instead of dividing to NaN. Verified live at the
  same Atacama-coast trench location used for the cliff-coast fix above: z9 tiles now land at
  ~28,000/34,000 budget (the missing ~18% is the excluded open-ocean share, confirming the exclusion
  is firing), no NaN positions, no console errors, and a zoomed crop of the loaded tile shows only
  terrain-shadow black cracks (real valley relief) with no blue ocean color bleeding through. The
  large dark gap between the near, fully-loaded tile and the distant background in these test
  screenshots is unrelated — that's normal unlit open-ocean rendering at distance/low light, not a
  coverage hole (no blue bleed-through was visible within any solid tile patch after the fix).

- **2026-07-20 — Water land-mask fix (re-attempt): CONFIRMED working live.** Re-implemented the
  same per-vertex elevation-based mask on `dynamicSeaLevel` (discard water fragments where
  `getTrueElevation(x,z) > 0`) after the first attempt was reverted alongside two unrelated
  regressions. This time: cleared the `vg1-code-v1`/`vg1-tiles-v2` service-worker caches AND did
  a full page reload before testing (see scar-tissue.md — suspected cause of the earlier
  no-visible-effect mystery). Live-verified at the exact previously-broken scenario
  (daytime-pinned, camY≈5-6, tilt≈0.78, Libya/Mediterranean coast): no black voids, no water
  bleeding onto land, coastline renders cleanly. Cross-checked with the water-hidden A/B test —
  land coverage and coastline shape match between "mask on" and "water fully hidden," confirming
  the mask discards in the right places. FPS stable ~64-69 at the test scenario, ~59 at a second
  unrelated location (Argentina, night) — no performance regression from the added discard.
  No console errors on load. This is the SAME code as the first attempt — the fix itself was
  correct all along; only the verification method was the problem last time.

- **2026-07-20 — Reverted all three of this session's unverified terrain/tile/water changes
  (tile forward-shift anchor, point-size obliqueGapFix, water land-mask) after Jamal reported
  live regressions ("pitch black" terrain and "tiles landing in the ocean").** Root cause of the
  tile regression: the forward-shifted load anchor (`loadX`/`loadZ` in `tileStreamManager.js`,
  shifted from the true look-at point along the camera's look direction, proportional to tilt)
  changed WHICH real-world tile got fetched for a given screen position — at oblique angles near
  a coastline this could shift the fetch anchor past the coastline into open water, landing
  correctly-georeferenced-but-wrong-for-the-view tiles where land was expected. This wasn't
  caught by the earlier FPS-only live test (confirmed no FPS collapse, never checked whether the
  loaded tiles were the RIGHT ones for a range of camera positions, not just the one reported
  scenario). Also rolled back the point-size shader change (never fixed the reported bleed — the
  water-plane occlusion was the real cause, found later the same session) and the water land-mask
  fix itself (implemented and logically verified via direct function invocation, but never got a
  live visual confirmation due to what looks like a stale WebGL program issue in the automated
  browser — see memory/scar-tissue.md — so it couldn't be ruled out as a contributor to the
  "pitch black" report and was pulled rather than left in unverified). Post-revert, live-verified
  the exact previously-broken scenario (daytime-pinned, low oblique angle, Libya/Mediterranean
  coast): terrain renders correctly, no black voids, no water-over-land, tile/point-cloud
  coverage looks consistent — confirms the revert genuinely restored the known-good baseline.
  **Both underlying problems (tile coverage depending on camera angle not altitude, water
  occluding low-lying land) are still real and still open** — the fixes just need to be
  redesigned and verified more carefully before shipping again, not abandoned.

- **2026-07-20 — Found the real cause of "blue bleeding onto point-cloud terrain": the water
  plane has no land mask and can render IN FRONT of low-lying land, not a point-density gap.**
  Started from the assumption (matching the earlier "ocean visible through the point cloud"
  report) that this was sparse base-cloud coverage letting the ocean floor show through at
  distance, and shipped a tilt+distance-gated point-size boost (`obliqueGapFix` in
  `terrainBuilder.js`'s splat vertex shader — kept, harmless, gated so it only touches oblique
  mid-distance splats, doesn't affect the tuned top-down/close-up sizing) on that theory. Live
  A/B (`window.scene.traverse` to find and toggle `dynamicSeaLevel` visibility off/on at the exact
  reported camera position) proved that theory wrong: with the water plane hidden, the land
  point-cloud and tile-mesh render CORRECTLY and completely underneath — nothing missing, no
  gaps. The "blue" was the literal Gerstner-wave sea-level plane occluding real, present, correctly-
  colored land geometry, confirmed by directly sampling `splatCloud.geometry.attributes.color` at
  the affected (x,z) coordinates (real tan/gold RGB values, not black/missing).
  **Root cause:** `waterManager.js`'s `createDynamicSeaLevel()` builds ONE flat `PlaneGeometry`
  covering the full `MAP_WIDTH × MAP_HEIGHT` with no land exclusion/mask of any kind — it relies
  entirely on land elevation normally sitting safely above y=0 so ordinary depth-testing hides the
  plane under continents. That assumption breaks in real near-sea-level flat terrain (sampled
  vertex y-values here were -0.3 to -0.96, i.e. AT/BELOW y=0 — this is a real coastal
  sabkha/basin near the Libya/Suez area) combined with Gerstner wave vertical displacement, which
  can locally lift the water surface above such land when viewed at a grazing (oblique, low-
  altitude) angle.
  **Not fixed yet** — this is a bigger, riskier change than anticipated: it needs a real land mask
  (e.g. sampling terrain elevation, now exposed as `getSceneGroundY()` from `terrainBuilder.js`
  since the 2026-07-20 reticle fix, into the water fragment shader to discard/fade over land) and
  `waterManager.js` is explicitly flagged in CLAUDE.md as manually-tuned (wave steepness/
  wavelength are protected, "do not change without full context"). Surfaced to Jamal for a
  scope/risk decision before implementing rather than unilaterally reworking a protected system.
  Separately confirmed (day/night side-quest during this investigation): `simClock.setTime()`
  must be paired with `simClock.pause()` — without `.pause()`, even several `requestAnimationFrame`
  ticks later the clock snaps back to live wall-clock time. Real current UTC (04:43) was correctly
  rendering Africa/Europe as night — an early "black continents" scare during this investigation
  was NOT a bug, just genuine live night-time; ruled out by reverting the shader edit and
  confirming the same blackout persisted (see scar-tissue.md for the isolation method).

- **2026-07-20 — Fixed a real tile-load speed bug: points-mode tiles were fetching geometry and
  imagery SEQUENTIALLY instead of in parallel, for no reason.** Jamal reported loading felt too
  slow after the coverage-widening fix (expected — more tiles now load per dive) plus a black
  square appearing amid loaded tiles. Investigated `tileStreamManager.js`'s `_loadTile()`: for
  `renderAs === 'points'` (the active style), the code did `await fetchTerrain(...)` (QM geometry,
  throttled 48 concurrent) to FULL completion, and only then `await fetchImagery(...)` (throttled
  20 concurrent) — but `imgUrl` depends only on tx/ty/zoom, not on the QM result, so there was
  never a real dependency between the two fetches. This serialized two independent ~1-1.5s fetches
  into one ~2-3s critical path PER TILE. Fixed: kick off `fetchImagery` immediately (same throttled
  queue, same priority behavior) alongside the QM fetch, only `await` the already-in-flight promise
  when the points branch needs it later — gated specifically to points mode (`renderMode ===
  'points'`) so mesh mode's existing separate un-awaited imagery fetch isn't duplicated. Live-
  measured at the same test spot: the active (z8) level fully resolved (0 tiles still loading) in
  ~2.0s vs ~3.5s before — the level under the cursor, which matters most for perceived speed.
  Investigated the black-square report separately: live query at a settled state found ZERO dark
  (<0.05 avg brightness) or `_unavailable`-cached tiles — the design (`_buildPoints`: photoBlend=0
  when imagery is missing, falls back to elevation palette, never black) doesn't produce black
  tiles once built. Conclusion: very likely a transient artifact of the LOADING window itself (a
  grid cell not yet reached by the load queue, momentarily occluding the base-cloud backstop
  without drawing anything) — not a persistent bug. This fix directly shrinks that window; flagged
  to Jamal to confirm it's gone rather than assuming it from live testing alone (couldn't force a
  live repro of the black tile to verify the fix against it directly).

- **2026-07-20 — Closed the "two types of terrain" gap (base cloud vs tile-stream panels) with
  a mix of wider real tile coverage + base-cloud density give-back, per Jamal's call.** Follows
  the corrected diagnosis above (it was never a color-grading mismatch — verified live). Real
  cause: `tileStreamManager.js`'s adaptive coverage radius explicitly excluded ANY level with
  zoom<8 from widening to match the view (`if (cfg.zoom < 8) return`), but the parent backdrop
  level (`i === active-1`) is zoom<8 in most real altitude bands (active=z7→parent=z6, active=
  z8→parent=z7) — so the backdrop meant to fill gaps around the active tiles almost never
  actually adapted, staying at a static loadRadius=2 footprint. Fixed: a level now adapts if it's
  currently the parent (`i === active-1`) regardless of its own zoom, not just if zoom≥8; loadRadius
  ceiling 5→6; active/parent ptsBudget cap 24000→28000 (still under each level's own BASE_BUDGET).
  Paired with `SPLAT_LAND_GRID` 5500→6000 (partial give-back from the earlier FPS-focused trim,
  since Jamal found the base cloud visibly grainy where it's still a substantial backdrop) and
  `terrainWorker.js` `MAX_ALLOC` 20M→21M to match (new real total ~20.15M, confirmed live at
  20,146,429 points, ocean fraction 26.24% — ocean pass still fully intact, not re-truncated).
  Live-tested at the exact reported scenario, camera pinned to hold steady (see scar-tissue: this
  session discovered position-set drift without repeated re-assertion — see that entry): clean
  steady-state reading was 58-62fps (avg 60.3), down from 70.3fps before this change but landing
  right at the 60fps target discussed rather than below it — the ~10fps of headroom got spent
  roughly as planned. Some later readings dipped much lower (single digits) intermittently, most
  likely automation/background-tab rAF artifacts (a documented gotcha, see scar-tissue) compounded
  by tiles still fetching over the network for the newly-widened radius — not conclusively ruled
  out as a real regression, worth a normal (non-automated) FPS check by Jamal. Screenshotted
  before/after: before, one crisp tile "panel" surrounded by visibly banded/grainy base cloud
  filling most of the frame; after, the entire visible ground reads as one consistent textured
  surface, matching the panel style, with only a couple of small real Cesium data-gap holes
  remaining (not new). If more headroom is needed later, `SPLAT_FX.SCALE`/`POINT_SMOOTH` (point-size/
  blending, cheaper than more points) was the reserved third lever, not used this session.

- **2026-07-20 — Fixed the mouse-hover ground reticle (`sceneSetup.js` hoverReticle): now scales
  with camera altitude and sits on real terrain elevation, not a flat sea-level plane.** Jamal
  flagged it live: at close zoom over hilly ground (Siberia test spot) the reticle was a
  screen-dominating ring, and not visually grounded. Root cause, confirmed live via
  `scene.traverse` (not guessed): the reticle is a fixed `RingGeometry(1.2,1.8)` with `scale`
  hardcoded to `[1,1,1]` forever — `selectionRing.js` got a zoom-altitude scale curve on
  2026-07-15 for this exact reason, the hover reticle never did. Also, its Y position came from a
  raycast against `boardPlane` (a flat sea-level helper plane used for consistent mouse-to-world
  picking), not the real rendered terrain surface. Fix (`uiController.js` onMouseMove): (1) same
  `clamp((camY/90)^1.5, 0.025, 1.15)` zoom curve as the selection ring, applied via `hoverReticle.
  scale.setScalar()`; (2) exported `terrainBuilder.js`'s border-ground-height helper (was
  `_borderGroundY`, internal-only) as `getSceneGroundY(x,z)` — the exact formula the terrain
  worker itself uses to place points — and used it for the reticle's Y instead of the flat plane.
  Verified live: before, `scale:[1,1,1]`, worldY≈0.5 regardless of terrain; after, at camY=5.4,
  `scale:[0.025,0.025,0.025]` (correctly hits the floor) and worldY=-2.78 (real elevation-driven,
  not the flat constant) — screenshotted, reticle now reads as a small dot on the ground instead
  of a ring dominating the screen.

- **2026-07-20 — Investigated a reported "two types of terrain" rectangular seam at the zoom7/
  zoom8 tile-stream LOD boundary; INITIAL diagnosis was wrong, corrected before shipping a fix.**
  First theory (from reading `config.js`'s TILESTREAM comments): the FAR/close color-grading
  split at "z≥8 vivid vs z<8 muted" landed exactly on the always-simultaneously-rendered active/
  parent backdrop pair (zoom8 active, zoom7 parent, per the 2026-07-12 crossfade design) — seemed
  like a clean root cause. It's wrong: `tileStreamManager.js` line 747 actually reads `_deep =
  this._cfg.zoom >= 6` (changed 2026-07-18, per that line's own inline comment) — config.js's
  TILESTREAM block comment describing "z≥8" was never updated to match and is stale. Verified
  live by sampling actual vertex-color averages from both levels at the exact reported camera
  position: zoom7 (parent) avgRGB (0.187,0.271,0.049) sat 0.855 vs zoom8 (active) avgRGB
  (0.184,0.258,0.044) sat 0.857 — statistically identical, no color-grading mismatch exists.
  **Lesson repeated from scar-tissue: a source comment describing "how a system works" can go
  stale the moment the code changes and nobody updates the prose next to it — verify behavior
  against the live data, not the comment, especially when the comment and an inline code comment
  disagree (as they did here).** Real cause not yet confirmed — leading candidate is point-density/
  smoothness contrast (zoom8 tiles sampled ~2.4x denser than zoom7 in the same live query,
  independent of color) rather than a hue/saturation problem, but not verified to the same
  standard as the color check. NOT fixed this session — the config.js TILESTREAM comment should
  at minimum be corrected to say z≥6 either way. Do not implement the "move the palette boundary"
  fix that was floated earlier in conversation — it was based on the wrong premise.

- **2026-07-20 — Fixed the real cause of oblique-angle base-cloud FPS: a silent typed-array
  truncation, not just "too many points." `SPLAT_LAND_GRID` 7500→5500, `terrainWorker.js`
  `MAX_ALLOC` 18,000,000→20,000,000.** Started from the tilt-aware-fade follow-up (base cloud
  as backstop ~35-70fps at oblique angles). Live investigation (console queries against
  `window.splatCloud`, not guesswork) found the actual bug: `terrainWorker.js` pre-allocates
  Float32Arrays sized `MAX_ALLOC=18,000,000`, but at `SPLAT_LAND_GRID=7500` the land pass alone
  generates ~23M candidates (measured true land fraction of the Mercator grid is ~0.413, not the
  ~0.30 the old comments assumed — high latitudes are area-inflated). Land pass runs first and
  fills the entire buffer before the ocean pass ever starts; out-of-bounds typed-array writes are
  silent no-ops with no error. Result, confirmed by sampling 131,387 live points for negative
  elevation (ocean's signature): **zero** — the entire `SPLAT_OCEAN_GRID` tuning line (bumped
  1195→3000, see the 2026-07-1x ocean-density entries) had never rendered a single point since
  whenever this imbalance was introduced. Also: `MAX_SPLAT_BUDGET=4_000_000` in config.js is dead
  — never passed to the worker, never used to sample anything. Live A/B via `geometry.
  setDrawRange()` on the already-loaded cloud (no reload needed) at the reported oblique angle
  confirmed point count genuinely drives FPS (18M ≈ 57-60fps with stutter dips into the high-30s,
  6M ≈ 85fps, 3M ≈ 93fps) — validating that a real trim (not the 6000-6500 range first floated,
  which would have stayed clamped at the same 18M) was the right direction. Chose 5500 because at
  the measured 0.413 land fraction it lands land+ocean at ~17.8M — under the (raised) cap with
  headroom, small enough to matter, and small enough to finally let the ocean pass through.
  Verified live post-reload: `window.splatCloud` reports exactly 17,773,320 points (matches
  prediction almost exactly), ocean fraction sampled at 29.75% (matches predicted 0.297), stable
  63fps at the exact oblique camera position that showed 34-44fps before (with real stutter, now
  none), and 65-72fps at a pure-backstop grazing angle (uFade=1, no tile coverage) with no visible
  voids — screenshotted both. Added a `console.warn` overflow guard in both worker passes so this
  class of bug (config change silently changes nothing, or silently kills a whole pass) can't go
  undetected again. `MAX_SPLAT_BUDGET` left in place but commented as dead — actually wiring it
  in (real reservoir sampling instead of grid-size arithmetic indirectly landing under an
  allocation cap) is the more robust long-term fix, not done this session.

- **2026-07-20 — "Two layers of tile" (coverage depends on camera tilt, not altitude): reverted a
  naive radius increase, shipped a forward-shifted load anchor instead — same tile budget,
  repositioned.** Root cause: `tileStreamManager.js`'s adaptive coverage radius (`viewSpan = 1.4 *
  camY`) sizes a SYMMETRIC CIRCLE around the look-at point, sized by altitude only — a top-down
  assumption. At oblique angles the visible ground is a forward-stretched wedge, not a disc
  centered on the target, so tiles ran out near the horizon while the near ground was
  over-covered. First attempt: grow the radius at oblique angles (`obliqueBoost` multiplier on
  `viewSpan`, `loadRadius` ceiling 6→8). Live-tested at the reported Mediterranean coastal-
  mountain scenario (camY≈6-7.7, tilt≈0.757-0.781): FPS collapsed 48→7-8. Root issue diagnosed via
  a systematic altitude/tilt sweep (requested by Jamal explicitly: "do the test first... then
  touch the code") — even a TOP-DOWN view at this altitude already wants `loadRadius~8` from the
  raw tileSpanU math before any tilt is considered, so the radius=6 ceiling was already a tight
  budget for ANY angle; growing it further is expensive regardless of tilt. Bigger circle was the
  wrong fix. Sweep also surfaced `sceneSetup.js`'s `maxPolarAngle=1.35` — hard-caps real-world
  achievable tilt at ≈0.781, which bounded how extreme the real fix needs to handle.
  **Shipped fix:** kept `loadRadius` at the known-good ceiling of 6 (reverted the 8), and instead
  shifted WHERE that fixed-size disc is centered — a new `loadX`/`loadZ` anchor, forward-biased
  from the true look-at point along the camera's horizontal look direction, scaled by
  `tileTilt * camY * 1.5`. This anchor feeds ONLY the `TileCache.update()` fetch/evict calls;
  `hasCoverageAt()` fade-gating (crossfade timing, the fast-dive ladder) intentionally stays on
  the true look-at point (`camX`/`camZ`), untouched, so the carefully-tuned 2026-07-12 crossfade
  behavior isn't disturbed. Zero extra tile cost — same budget, better placement. Live-verified at
  the exact regressed scenario (camY≈6.5, tilt≈0.781, pinned via direct camera/controls override):
  **53fps average, no collapse** (vs. 48fps baseline before any of this work — within noise).
  Visual confirmation of tile-coverage improvement at that exact synthetic coordinate was
  inconclusive — teleporting the camera via JS to an arbitrary lon/lat produced zero tile fetches
  (no network requests at all, confirmed via `read_network_requests`), a test-harness artifact
  distinct from real navigation (scroll+drag reliably showed tiles loading and rendering at other
  points this session). The FPS-regression check — the specific, quantified failure this fix
  targets — is the part that's been directly verified.

- **2026-07-13 — "Deep stage" ocean adopted (map-artist mission 3, accepted by Jamal).** The ocean
  now recedes so data leads: bathymetry bands ~25% darker (shelf 0.78→0.60 max blue, continuity
  preserved through slope/abyss/hadal — bands MUST stay identical in terrainWorker AND
  terrainBuilder), floor emissive 0.70→0.45, depth contours recolored from electric cyan
  (0.22,0.72,0.95 @ 0.72α) to steel blue (0.14,0.46,0.64 @ 0.38α). Rationale: the old ocean was
  the same cyan family as the UI accent/vessel/alert colors — the background was competing with
  the intelligence. Also part of the answer to the public "too cluttered" feedback.

- **2026-07-13 — Deserts render as SAND, not grey (map-artist mission 2, accepted by Jamal).**
  Four stacked causes, all fixed: (1) terrainWorker warm coefficients too timid for the nearly
  achromatic source mosaic → blend toward explicit sand target (0.78,0.63,0.42) gated on bright ×
  low-chroma × desert-belt; (2) desertBelt's equatorward gate at 0.14 mercator-normalized ≈ 25°N
  excluded the southern half of the Sahara → widened to 0.05 (≈9°); (3) additive nudges can't
  manufacture chroma — pull, don't push; (4) THE REAL VILLAIN: the splat shader's adaptive ice
  ceiling did per-channel min() which flattened every bright WARM pixel to khaki-grey (sand
  0.98/0.80/0.42 → 0.68/0.68/0.42). Replaced with luminance-preserving scale — same anti-blowout
  values/trigger, hue survives. NOTE: this touched the protected shader family; Jamal verified
  visually. Debug lesson for scar-tissue: when vertex colors are right but the screen is wrong,
  paint a test box red and binary-search the SHADER, not the data.

- **2026-07-13 — "Natural Earth" land palette adopted (map-artist mission 1).** SPLAT_SATURATION
  2.10 → 1.30, SPLAT_BRIGHTNESS 0.86 → 0.95, picked by Jamal in a live A/B/baseline flip at the
  fixed global view. Reason: 2.1× saturation crushed the satellite data's real color variation
  into uniform lime ("video-game green"); at 1.30 the olives/tans/ochres return and biomes
  differentiate — accuracy-as-aesthetics. Open follow-ups from the same critique, NOT yet done:
  (a) grey deserts read as missing data → warm sand tones (terrainWorker whiteSuppression path);
  (b) ocean brightness/cyan contours compete with data colors → calmer, darker stage (bathymetry
  palette + contour styling). The map-artist agent definition lives in map-artist.md (move to
  .claude/agents/ — session couldn't write there directly).

- **2026-07-12 — Terrain architecture settled: the point cloud IS the product; Cesium Ion feeds
  it, never replaces it (Jamal's call after a full day of alternatives).** Streamed Cesium World
  Terrain (quantized-mesh, EPSG:4326/TMS grid, zig-zag delta decode — both previously broken, see
  scar-tissue) is sampled into dense area-weighted points, colored per-point from ArcGIS satellite
  imagery (bbox export), and layered OVER the always-visible base splat as an altitude-laddered
  LOD (z3–z10, denser + finer + better-colored as you descend). Rejected on the way here, with
  reasons: (a) photoreal textured-mesh close zoom — style break with the map's identity, and the
  base-splat fade it required left black holes over patchy coverage; (b) CesiumJS/XRF-style globe
  adoption — a rewrite that discards the tuned aesthetic. Camera floor lowered 15 → 2
  (~300 km view). True city-scale zoom remains blocked ONLY by camera.near=1 (post-chain reads
  depth assuming it — lowering it fogs the world black); that rework is punchlisted.

- **2026-07-12 — City terrain patches DISABLED (Jamal's call, via option prompt).** The
  cityManager close-zoom terrain patches were behind the long-standing "ghost/wrong terrain"
  reports twice over: (1) a missing `mesh.position.set(x,0,z)` stacked all ~36 patches at
  Null Island (fixed — see scar-tissue), and (2) even correctly placed and gated to low
  camera.y, they read as a tan mud smudge over the point cloud at oblique angles (reproduced
  at Lagos and Durban). Tile-stream terrain (y<22, zoom 12–13) already covers close-zoom
  ground detail, so the layer is redundant. `_buildTerrainPatches()` call commented out in
  cityManager's constructor; build code kept intact for a future restyle. The position fix
  and the tightened close-zoom gate are also in the file so re-enabling starts from a sane
  baseline. Verified live: patchesBuilt=0, oblique + strategic + close views clean.

- **2026-07-10 — Zone recorder: armed, zone-scoped ship+plane capture with a sim-time window.**
  Jamal: "we should have this mechanism be able to set a time and record specific movement for
  zones of ships or planes." Scope chosen via AskUserQuestion: both domains, armable window
  (start/end, auto start/stop), click-to-place + panel UI. Built as a layer on the machinery that
  already existed (simClock, AISRecorder, RecordedAISSource, ARCHIVE panel) rather than parallel
  systems. New `zoneRecorder.js` — pure module (no THREE/DOM, node-testable), state machine
  IDLE→ARMED→RECORDING→DONE driven by simClock (never Date.now), circular zone filtered by TRUE
  haversine (test includes the corner trap: inside the bounding box, outside the circle → ignored).
  Records tagged `{t, d:'ais'|'flt', msg}`; NDJSON export with a `vg1-zone-capture` manifest line.
  DISARM vs STOP semantics: stopping mid-recording keeps the capture (→DONE); disarm while ARMED
  cancels. Flights made recordable for the first time: `flightManager.onRawAircraft` tap (mirrors
  aisManager.onRawMessage, fired on the raw wire state before any filtering so ground reports are
  captured and replayed landings look real), plus `setLivePaused()`, `ingest(states)`, `clearAll()`
  for replay parity with the AIS side. Replay: `ZoneRecordedSource` in dataSource.js dispatches ais
  records through the normal attachSource sink and batches flt records to `flightManager.ingest` —
  scrub-safe (rewinds cursor like RecordedAISSource). UI lives INSIDE the existing ARCHIVE panel
  (new ◎ ZONE RECORD section, cyan #40c4ff zone disc — deliberately not the alert zone's #ff4400),
  zone captures join the same IndexedDB archive list tagged ◎ ZONE and replay via the same REPLAY
  button; LIVE now also unpauses/clears flights. Added generic `requestMapPick(cb)` one-shot
  click-to-place helper in uiController (reusable by any future panel; passed to archiveManager via
  deps from main.js, not cross-imported). Config: new `ZONE_REC` block. Console: `window.vg1ZoneRec`.
  Tests: `tests/zoneRecorder.test.mjs` (18 cases, all pass; invariants suite unaffected).
  NOT yet live-verified in the browser — needs Jamal's visual check before push (per convention).

- **2026-06-27 — Fixed flight position "slow motion then snap" bug; rebuilt altitudeDeckManager.js
  contextual to selection with real flight levels; closed task #46.** Jamal observed live: "there is
  slow motion of the planes and then it snaps to another position." Root cause in
  `flightManager.js _handleData()`: on a new poll, `existing.prevPos.copy(existing.targetPos)` reset
  the lerp's start point to the *previous* poll's target — but `tick()`'s dead-reckoning branch had
  been walking `currentPos` past that stale target for up to a full `POLL_INTERVAL` (30s), so the new
  lerp opened by snapping backward to the stale point before crawling forward again. Fixed by reading
  `existing.prevPos.copy(existing.currentPos)` instead — lerp now always starts from wherever the
  aircraft visually is. Verified by reproducing the exact jump (0.6627 scene units) with the old line
  and confirming zero jump with the fix, both via direct synthetic `tick()` calls (see scar-tissue.md
  for why: the automation browser tab gets OS-backgrounded, which pauses `requestAnimationFrame`
  entirely).

  Separately, Jamal asked whether altitude/"the sky" should render more grid-like and whether
  aircraft positions should snap to a grid, having seen several aircraft visually bunched on screen.
  Live pairwise-separation analysis across all 300 tracked aircraft found only one pair within both
  10nm and 1500ft (9.3nm / 25ft — two GA aircraft sharing a pattern, normal) — confirming the bunching
  was a rendering artifact (steep/top-down camera angle foreshortens the exaggerated Y-axis altitude
  scale to near-zero screen displacement) and not a real proximity issue. Declined to literally snap
  real ADS-B-reported positions to a synthetic grid — that would mean displaying a fabricated
  altitude, contrary to how the rest of the app treats data fidelity (dual timestamps, invariant
  gating). Instead rebuilt `altitudeDeckManager.js` (which already existed half-wired from an earlier,
  undocumented pass — see scar-tissue.md) as a contextual flight-level grid: three real-world decks
  (FL180 transition altitude, FL290 RVSM floor/hemispheric-rule start, FL410 RVSM ceiling) rendered as
  a small local grid patch anchored under whichever aircraft is selected (`state.lockedShip` with
  `userData.isRealFlight`), highlighting whichever deck the aircraft's actual altitude is nearest to.
  Hidden the rest of the time and for ship selections — deliberately not a permanent full-map overlay
  (rejected for both visual noise over empty ocean and unnecessary draw cost). Verified via direct
  `update()` calls with synthetic locked-aircraft/ship objects: shows + anchors + highlights FL290
  correctly for a 30,500ft aircraft, hides on deselect, never shows for a ship lock. Task #46 marked
  completed; the "heading ticks / air corridors" half of its original title was explicitly left out of
  scope as a separate follow-up.

- **2026-06-26 — Added OpenSky Network as the primary flight-proxy ADS-B source, ahead of the
  anonymous airplanes.live/adsb.lol mirrors.** Root incident: aircraft stopped appearing because
  both anonymous mirrors were rejecting every request simultaneously (airplanes.live → 403,
  adsb.lol → 420/rate-limited) — a compound failure the existing fallback chain was never designed
  to survive, since it assumes at least one anonymous source is up. Jamal: "well we don't want our
  planes to constantly cut out. so we need a live reliable feed." Chose OpenSky's free *registered*
  tier (OAuth2 client-credentials flow, opensky-network.org → Account → API Client) over (a) a paid
  commercial API (ADSBExchange/FlightAware — better freshness/coverage but real ongoing cost, only
  worth it if zero-downtime becomes a hard requirement) and (b) running physical feeder hardware for
  a free airplanes.live/adsb.lol key (wrong coverage model — only covers aircraft in local radio
  range, not the whole map). Implementation in `flight-proxy.js`: `OPENSKY_CLIENT_ID`/
  `OPENSKY_CLIENT_SECRET` read from `.env` (skips OpenSky entirely if unset — zero behavior change
  for anyone who hasn't registered yet); `getOpenSkyToken()` does the client-credentials exchange
  and caches the bearer token (30 min lifetime, refreshed 60s early); `fetchOpenSkyStates()` calls
  `/states/all` and maps OpenSky's positional state-vector array onto the exact same
  `{ac:[{hex,flight,lon,lat,alt_baro,gs,track,squawk,emergency,category,dbFlags}]}` shape the
  ADSBExchange-compatible mirrors already return, via `OPENSKY_CATEGORY_MAP` (OpenSky's numeric
  emitter-category enum → the A*/B* string codes `config.js AIRCRAFT_CLASSES.CATEGORY_MAP` expects)
  — so `flightManager.js`'s `classifyAircraft()` needed zero changes. Known tradeoff: OpenSky's
  `/states/all` has no military-registry flag (`dbFlags` is always 0 for this source), so military
  classification for OpenSky-sourced aircraft falls back to category A6 only, not the dbFlags bit
  airplanes.live exposes — slightly less reliable military tagging than the old primary source, not
  considered a blocker. `proxyFlightsCached()` restructured: tries OpenSky first when configured,
  falls straight through to the existing airplanes.live → adsb.lol → stale-cache → empty chain on
  any failure (unset credentials, expired/bad token, non-200, malformed body) — the original
  fallback logic is fully intact as a safety net, just demoted to second priority. **Action item for
  Jamal, not done by Claude (account creation is off-limits for me):** register a free account at
  opensky-network.org, create an API client under Account → API Client, and add
  `OPENSKY_CLIENT_ID=...` / `OPENSKY_CLIENT_SECRET=...` to `flight-proxy.js`'s `.env`, then restart
  the proxy.

- **2026-06-23 — Added `tests/discoveryRules.test.mjs`, a pure-node unit suite for the local
  rule engine, before testing the LLM escalation path.** Jamal: "naw we first need to test the
  analysis process for the discoveryRules and configure its template correctly for data" — in
  response to a request to map the `/ai-discover` architecture, he redirected to verifying the
  free local rule engine itself rather than jumping straight to a live paid-call test. Distinct
  from `tests/discovery-eval.mjs` (an *integration* test that calls a running proxy + a real LLM
  to check for hallucination) — this is a pure unit test, no fetch, no proxy required, following
  the `invariants.test.mjs` pattern ("every new invariant needs a test that tries to fool it").
  20 cases across three concerns: (1) DECISION correctness — every heuristic in `discoveryRules.js`
  fires exactly at its `config.js DISCOVERY_RULES` threshold and not one off (e.g. 2 loitering
  vessels templates as STS, 3 escalates instead; 2 distinct event types on one vessel escalates,
  3 same-type events don't); (2) TEMPLATE correctness — when a rule fires, the rendered string is
  asserted verbatim, including singular/plural ("1 dark vessel" vs "2 dark vessels") and optional
  suffixes (RF finding text changes shape when `vessel` is null vs present) — a rule can decide
  correctly while still rendering "undefined" into the console, which decision-only tests would
  never catch; (3) SHAPE CONTRACT — a `REAL_SHAPED_SNAPSHOT` fixture copies
  `discoveryManager.js _buildSnapshot()`'s field names verbatim (`rfEvents[].severity/.summary/
  .vessel`, `chokepointActivity[].dark/.name/.count/.state`, `integrityFlagged[].tier/.flags/
  .mmsi/.score`, `developingStories[].mmsi/.events[].type`), so a future rename in the snapshot
  builder breaks this test loudly instead of the rule engine silently going quiet with no error
  (the existing failure mode for this kind of bug — no exception is ever thrown on a field-name
  mismatch, findings just stop appearing). All 20 assertions passed on first run. This is purely
  local — `runDiscoveryRules()` is a pure function, no THREE, no DOM, no fetch — so it complements
  rather than replaces the still-outstanding live-proxy verification of the actual `/ai-discover`
  paid call, which remains untested end-to-end (see prior monitoring entry below).

- **2026-06-21 — Added rule-engine monitoring (durable log + live UI stats) so analysts can audit
  consistency over time.** Jamal: "if we want to monitor this system for some time how do we do that?
  because I'm sure analysts will want this to work consistently." Chose both a persistent log AND a
  live stats panel (user picked both when offered log/UI/scheduled-report as options) rather than
  either alone — the log survives reloads and outlives any one browser tab, the panel gives an
  at-a-glance check without opening a file. New persistent log: `memory/discovery/ruleEngine.jsonl`
  via `memoryStore.appendRulePass()`, written through a new free (no-LLM) `POST /memory/log-pass`
  endpoint in flight-proxy.js — one entry per discoveryManager tick, gated or not, tagging the
  outcome (`nothing` | `rule-handled` | `escalated-ok` | `escalated-error` | `cooldown`), finding
  count, and escalation reasons. `memoryStore.summarizeRulePasses(hours)` rolls this up into
  escalation rate / Claude error rate for a `GET /memory/rule-stats?hours=N` health-check endpoint.
  discoveryManager.js calls `_logPass()` fire-and-forget at every return branch — deliberately never
  awaited, never throws, so a down proxy degrades monitoring only, never the discovery loop itself.
  Expanded `discoveryManager.stats` with `ticks`/`ruleFindings`/`escalations`/`ruleOnlySaves`/
  `claudeErrors`/`startedAt` (kept the original `passes`/`claudeCalls`/`actionsExecuted` for backward
  compat) and added `getStatsSummary()`. UI: a small `#vp-discovery-stats` bar above the console log
  (uiController.js `renderStats()`, called on every discovery event + a 5s interval) showing ticks,
  rule findings, rule-only saves (the number that matters most — Claude calls avoided), escalations,
  and Claude ok/error counts. Live-verified the in-memory path end-to-end in the running browser tab
  (fake SUSPECT vessel → forced rule-only pass → ticks 0→1, ruleFindings 0→1, ruleOnlySaves 0→1,
  stats bar text matched exactly) and cleaned up the test record afterward. Could NOT live-verify the
  persistent JSONL path or the two new proxy endpoints this session — flight-proxy.js (port 8787) is
  not currently running on Jamal's machine (confirmed via a direct navigate to localhost:8787 showing
  a connection error), the same pre-existing blocker noted in earlier sessions. `_logPass` is designed
  to fail silently in that case, which is what happened — no errors surfaced in the console, the rule
  engine and UI panel worked anyway. Next session: once the proxy is started, re-verify `ruleEngine.jsonl`
  gets entries and `GET /memory/rule-stats` returns sane numbers.

  **Update, same day, proxy now running:** re-verified the persistent half directly against the live
  proxy. `POST /memory/log-pass` returned `{ok:true, id:"rule_..."}` and actually wrote to
  `ruleEngine.jsonl`; `GET /memory/rule-stats?hours=1` correctly rolled that single entry up into
  `totalTicks:1, ruleFindings:1, ruleOnlySaves:1, escalations:0`; `GET /memory/recent` still answers
  fine alongside the new endpoints (nothing regressed). Both monitoring paths — in-memory/live UI and
  persistent JSONL/proxy — are now fully verified end-to-end. Closed out.

- **2026-06-21 — Built a local rule-engine pre-filter (discoveryRules.js) for DISCOVERY instead of
  spending a Claude call on every tick.** Jamal's framing: "needing tokens to have live intelligence
  is really bugging me... it holds back the discovery program," then explicitly asked for analyst-
  tradecraft filters that can "use several pieces of information to make discoveries" before paying
  for an LLM call. Replaced the old blunt gate (`_hasEnoughToWarrantACall`: any 3 new timeline
  entries, regardless of type) with a pure, zero-cost rule engine that runs every tick on the same
  snapshot discoveryManager already builds: RF ALERT, chokepoint dark-vessel transit, SUSPECT-tier
  vessels with ≥2 corroborating integrity flags, and exactly-two-vessel loitering pairs ("possible
  STS transfer") all template directly as confident findings — the underlying flags already explain
  themselves, so a Claude sentence would add nothing. Only genuinely ambiguous or cross-signal cases
  escalate to `/ai-discover`: >2 vessels loitering together, ≥2 *distinct* event types on one
  vessel's developing story (signal diversity, not volume — three repeats of the same event is noise),
  ≥3 domains (RF/chokepoint/AIS-story/loitering) active at once, or ≥3 vessels with developing
  stories simultaneously. `discoveryManager._maybeRunDiscoveryPass()` now builds the snapshot and
  runs rules unconditionally (free), emits all confident findings regardless of the old gate, and
  only spends a fetch when `rules.escalate` is true (or the operator hits RUN NOW). Rule-engine
  console lines are tagged "◆ RULE ENGINE" / amber (`.disc-rule` in index.html, `DISCOVERY_RULE` in
  uiController.js's PREFIX/CLASS maps) — deliberately never disguised as "◈ AI DISCOVERY" violet
  findings, so an analyst can always tell template from genuine model reasoning. Thresholds tunable
  in `config.js`'s new `DISCOVERY_RULES` block. `tests/discovery-eval.mjs` (server-side, tests
  `/ai-discover` directly) is unaffected — verified the rule engine's six core scenarios (RF+chokepoint
  correlation, isolated/empty no-op, 2-vessel STS auto-finding, 3-vessel STS escalation, SUSPECT
  auto-finding) in an isolated node run before wiring it in.

- **2026-06-21 — Fixed the Antarctica grey-shape bug with two targeted changes in terrainWorker.js
  rather than touching the ocean floor mesh, aquarium walls, or any post-process pass.** Live
  binary-searched the running scene (hide candidate, screenshot, compare) and isolated the culprit
  to the splat point cloud, not the previously-suspected ocean floor mesh — hiding the ocean floor
  left the grey shape untouched; hiding the splat removed it entirely. Root cause had two parts:
  (1) `whiteSuppression` in the per-point land color pipeline dims bright pixels to fight satellite
  glare, but its `polarIce` relief term didn't engage until `|latNorm|>0.74`, so a band of genuinely
  bright Antarctic ice (verified RGB 231-255 by fetching the actual ArcGIS tile in-page and reading
  pixels) got dimmed ~22% into dull grey before relief kicked in — widened the ramp to start at 0.60.
  (2) Removing the aquarium walls (an earlier, separate decision) exposed the point cloud's raw
  rectangular boundary with no falloff, so the southern edge cut off as a hard flat wall instead of
  fading into the void — added a smoothstep `edgeFade()` (dist 0.40→0.50) applied to both the land
  and ocean passes. Chose this over re-adding aquarium walls or clipping geometry because it's the
  minimal change that fixes both the color bug and the exposed-edge bug without resurrecting
  geometry the project deliberately removed. See `CLAUDE.md` Common failure modes and
  `memory/scar-tissue.md` for the live-debugging method (`.visible` gets stomped by per-frame LOD
  code — use `geometry.setDrawRange(0,0)` to test visibility instead).

- **2026-06-21 — Added a shared call-budget guard to callLLM() instead of switching AI providers.**
  After fixing the CORS bug above, the DISCOVERY console's first real round trip surfaced a second,
  unrelated problem: Gemini free-tier quota exhausted ("You exceeded your current quota") — Jamal
  doesn't have an Anthropic key and doesn't want to pay for one, so the fix had to work within the
  free tier rather than swap providers. Root cause: `/ai-assess`, `/ai-discover`, `/ai-query`, and
  the phase-2 tool-use round trip all funnel through one `callLLM()` but had zero shared rate
  limiting — `DISCOVERY.MIN_CALL_INTERVAL` only gated the autonomous pass, and `/ai-query` had no
  budget at all, so a few minutes of console testing (each tool-use call being a SECOND request)
  was enough to exhaust the daily quota. Fixed by wrapping `callLLM()` itself with three guards, in
  order: (1) ~8s hard minimum interval between any call across all endpoints, (2) a 60s response
  cache keyed on `(systemPrompt, userMsg)` so an identical question against an unchanged snapshot
  doesn't spend a new call, (3) a 5min cooldown that trips the moment a quota-exhausted error comes
  back, so retries stop compounding the problem. No endpoint code changed — same pattern as
  `AI_PROVIDER` swapping, the guard lives entirely inside `callLLM()`. Logged in `scar-tissue.md` too.

- **2026-06-21 — Fixed flight-proxy.js CORS preflight blocking all POST endpoints.** Discovered
  while verifying Discovery AI phase 2 (searchHistory tool-use + conversational memory, entry
  below): the DISCOVERY console's query box showed instant "Failed to fetch" on every question,
  with no corresponding log line in the proxy terminal at all. Root cause: `Access-Control-Allow-
  Methods` was hardcoded to `'GET, OPTIONS'` and there was no `Access-Control-Allow-Headers` for
  `Content-Type` — so any POST request with a JSON body (`/ai-discover`, `/ai-query`, `/ai-assess`)
  failed its browser CORS preflight before the real request was ever sent. This was a pre-existing
  bug, not something introduced by the phase 2 work — it would have silently affected every POST
  endpoint since whichever commit first hardcoded that header. Fixed: `Access-Control-Allow-
  Methods` → `'GET, POST, OPTIONS'`, added `Access-Control-Allow-Headers: Content-Type`. Logged in
  `memory/scar-tissue.md` too, since the symptom ("proxy isn't running") is misleading — the
  terminal shows the proxy alive and serving GET endpoints fine, the POST just never arrives.

- **2026-06-21 — Discovery AI phase 2: searchHistory tool-use + conversational memory for /ai-query.**
  Closes the two "next steps, not started" items logged in the persistent-memory entry above.
  Neither `callAnthropic` nor `callGemini` use native tool-calling APIs — kept the project's
  existing minimal text-in/text-out convention instead of adopting a new protocol: a new
  `callLLMWithTools()` wrapper in `flight-proxy.js` calls the model once normally, and if the raw
  reply is exactly `{"toolCall": {"name": "searchHistory", "args": {...}}}` (per a new TOOL section
  in both `DISCOVERY_SYSTEM` and `QUERY_SYSTEM`), runs `memoryStore.searchHistory(mmsi, days)`
  server-side and calls the model exactly once more with the result appended, then returns that as
  the final raw text. Deliberately capped at one round trip — these are bounded read-only lookups,
  not an open-ended agent loop, so no max-iterations guard was needed. `searchHistory()` (new,
  `memoryStore.js`) scans `events.jsonl` for snapshots mentioning the given mmsi within the lookback
  window across all four domains (developingStories, integrityFlagged, invariantViolations,
  rfEvents), and separately returns any `findings.jsonl` entries that mention the mmsi in their own
  text — labeled `priorFindings`, kept apart from `hits` so the model can't mistake a past guess for
  ground truth (same rule as the rest of this file).
  Conversational memory: `DiscoveryManager` now keeps `_queryHistory` (last `DISCOVERY.
  MAX_QUERY_HISTORY` = 6 turns, i.e. 3 Q&A pairs), sent as `history` on every `/ai-query` call and
  folded into the prompt as a "PRIOR CONVERSATION" block above the question — `QUERY_SYSTEM` was
  updated to say this resolves follow-ups ("that vessel", "what about it now") but must never be
  treated as a new fact; every claim still has to ground in the current snapshot or a tool result.
  Both endpoints unchanged in their public shape from the operator's side — `discoveryManager.js`'s
  `query()` and the autonomous pass still just get back `{answer}` / `{assessment, actions}`; the
  tool round trip is invisible to the caller except for an extra `[proxy] → discovery tool call:
  searchHistory(...)` log line.
- **2026-06-21 — Maritime Boundaries (EEZ) / ArcGIS Living Atlas feature scrapped, fully removed.**
  After shipping, Jamal reported the layer "does not work." Live diagnosis (via direct browser
  testing, not assumption) found the real root cause: the Living Atlas service queried
  (`World_Exclusive_Economic_Zone_Boundaries/FeatureServer/0`) is despite its name a
  boundary-LINES layer (`esriGeometryPolyline`, single field `LINE_NAME`), not an EEZ
  polygon/area layer — `outFields=ISO_TER1,TERRITORY1,UNION,POL_TYPE` (polygon-layer fields)
  don't exist on it, causing every request to fail with a generic "Unable to complete
  operation." Fixed to `outFields=LINE_NAME`, added `resultOffset` pagination (2349 features,
  Esri's 2000-record `maxRecordCount` cap), and rewrote the geometry parser for open polylines
  (`paths`) instead of closed polygon `rings`. Despite this being the technically correct fix,
  Jamal reported it "didn't really work" afterward and chose to scrap the feature entirely
  rather than keep debugging — also noting the underlying reason: sea lines like this can be
  built directly from data rather than depending on a third-party Esri service with this kind of
  schema mismatch risk. Confirmed via AskUserQuestion: full removal, not just disabling.
  Removed entirely: `maritimeBoundariesManager.js` (deleted), the ArcGIS OAuth token exchange
  (`getArcgisToken`, `arcgisTokenCache`) and both `/arcgis-token-test` and `/arcgis/eez` endpoints
  from `flight-proxy.js`, the `MARITIME_BOUNDARIES` block from `config.js`, the
  `maritime-boundaries` registration from `layerManager.js`, the layer-panel row from
  `index.html`, and the import/instantiation/switch-case from `main.js`. `ARCGIS_CLIENT_ID`/
  `ARCGIS_CLIENT_SECRET` left as-is in `.env` (gitignored, harmless, unused) — not raised with
  Jamal as worth a separate decision. If sea lines/EEZ boundaries are revisited, build from owned
  data rather than re-wiring this Esri service.

- **2026-06-21 — ArcGIS Living Atlas wired in via OAuth app credentials; first layer is Maritime Boundaries (EEZ).**
  Jamal has ArcGIS access through his law school org (50,000 credits). The old standalone
  `developers.arcgis.com` developer dashboard is retired — credentials are now created as items
  inside the org portal (Content → New Item → Developer credentials). Direct "API key
  credentials" are admin-gated for this org; "OAuth 2.0 — App authentication" credentials are not,
  so that's what we used: app-usage type "Private application with selected privileges and
  access" (not full account impersonation), "No item access" (script only needs public Esri
  services, not Jamal's own content), privilege scoped to "Location services → Basemaps" only,
  referrer URL set to `http://localhost:8787` to match `flight-proxy.js`'s port.
  `ARCGIS_CLIENT_ID`/`ARCGIS_CLIENT_SECRET` live in `.env` (gitignored, same convention as
  `ANTHROPIC_API_KEY`/`GEMINI_API_KEY`). `flight-proxy.js` added `getArcgisToken()`, which does
  its own `client_credentials` exchange against `https://www.arcgis.com/sharing/rest/oauth2/token`
  and caches the resulting access token (~2h, refreshed automatically) — the one-time "temp token"
  ArcGIS shows in the credential wizard is never used; it's a UI artifact, not meant to be
  long-lived. Verified live via `/arcgis-token-test`.
  First Living Atlas pull: World Exclusive Economic Zone Boundaries (item
  `9c707fa7131b4462a08b8bf2e06bf4ad`, owner `esri`, data from Flanders Marine Institute /
  marineregions.org), served via new `/arcgis/eez` endpoint (24h in-memory cache — it's a static
  dataset, no need to re-spend the token on every page load). Rendered by the new
  `maritimeBoundariesManager.js` as a single merged `THREE.LineSegments` (one draw call for ~280
  territories, per the performance rule on merging geometry) sitting just above the sea-level
  plane — deliberately NOT terrain-following like `submarineCables.js`, since an EEZ line is an
  abstract legal boundary, not a seabed feature. Pure overlay: touches no shared uniforms
  (terrain splat, water, lighting, post-processing).
  Wiring note for future layers: `layerManager.js` documents itself as the "central layer
  registry," and I registered `maritime-boundaries` there for bookkeeping consistency with other
  layers — but it is NOT what the live Map Layers panel actually uses. The real wiring is
  `index.html`'s inline script (`.lp-row[data-layer]` click → `window.layerStates[key]` +
  `window.dispatchEvent(new CustomEvent('layerToggle', {...}))`), handled centrally by a `switch`
  in `main.js` (~line 1001). `maritimeBoundariesManager.js` follows that real pattern, not
  `layerManager.js`'s `vg1:layerChanged` event, which nothing currently listens for. Also
  discovered in passing: `submarineCables.js` exists and is documented in `CLAUDE.md`'s module map
  but is not actually imported/called anywhere in `main.js` — it's dead code today, not a bug
  introduced by this change, just worth knowing if "the cable layer doesn't show up" comes up
  later.
  Not yet built: world ports (was the other Living Atlas candidate, deferred); bathymetry was
  explicitly flagged as risky (continuous color ramp could visually compete with the point-cloud
  terrain) and is on hold pending a deliberate decision, not an oversight.

- **2026-06-21 — Discovery memory made persistent, with ground-truth/inference kept strictly separate.**
  Jamal asked how to keep the Discovery AI "principled" and able to "keep learning" given a
  nonstop world, without going astray. Answer was conceptual first (no fine-tuning — there is no
  training pipeline and none is planned; "principled" here means structural: strict grounding
  rules in `DISCOVERY_SYSTEM`/`QUERY_SYSTEM`, a deliberately tiny tool registry in
  `discoveryManager.js`, and this file as the audit trail for prompt changes), then built:
  `memoryStore.js` is a new append-only JSONL store with two files under `memory/discovery/`:
  `events.jsonl` (ground truth — the exact snapshot shown to the model on every pass/query,
  written BEFORE the LLM call) and `findings.jsonl` (inference — what the model said, tagged with
  the `sourceEventId` of the event it was grounded in). The split is load-bearing: a past finding
  must never be read back into a future snapshot as if it were a verified fact, or the system
  would start agreeing with its own earlier guesses instead of the live map — a hallucination
  feedback loop. `flight-proxy.js`'s `/ai-discover` and `/ai-query` handlers now call
  `appendEvent()`/`appendFinding()` around the existing `callLLM()` calls; a new read-only
  `GET /memory/recent?kind=events|findings&limit=N` exposes the log for tooling (nothing can write
  through this endpoint — only the two POST handlers write, both server-side).
  Also added `tests/discovery-eval.mjs`, the discovery-pipeline equivalent of
  `tests/invariants.test.mjs`'s "every new invariant needs a test that tries to fool it." It's an
  integration test (real HTTP calls to a running proxy + real LLM, since hallucination can't be
  checked without actually calling the model) with three fixtures — a real two-source correlation,
  an isolated single-source event, and an empty snapshot — and asserts the model never cites an
  MMSI absent from its input and never fabricates a finding from nothing. Run it after any change
  to `DISCOVERY_SYSTEM`/`QUERY_SYSTEM`: `node flight-proxy.js` in one terminal, then
  `node tests/discovery-eval.mjs` in another.
  Not yet built (next steps, not started): tool-use (model calls a `searchHistory(mmsi, days)`
  function against `memoryStore.readRecent()`/`getEventById()` instead of only seeing a pushed
  snapshot) and conversational memory (passing prior Q&A turns into `/ai-query`). Both depend on
  this persistent store existing first, which it now does.

- **2026-06-21 — Discovery layer made cross-domain, interactive, and self-explaining.**
  Jamal correctly identified three gaps after the DISCOVERY console shipped: (1) the autonomous
  pass could go silent indefinitely with zero visible reason — `_maybeRunDiscoveryPass()` had two
  early `return`s (activity gate, call-budget cooldown) that emitted nothing; fixed by emitting a
  heartbeat scan line on every gated tick, stating exactly what it's waiting on
  (`waiting — N/3 new entries, no integrity flags or RF alerts yet (next check in 90s)`). (2) There
  was no way to trigger a pass on demand — added `DiscoveryManager.forcePass()` (bypasses the
  gates, still serializes against `_isProcessing`) wired to a `RUN NOW` button in `#vp-discovery`.
  (3) The "cross-domain" snapshot was actually AIS-only (timeline + invariants + integrity) — RF
  intel (`window.rfIntel`) and chokepoint vessel density (`window.chokepointHitMeshes`) existed
  elsewhere on the map but were never read into `_buildSnapshot()`. Added both; `DISCOVERY_SYSTEM`
  and the new `buildDiscoverySummary()` sections updated to match, and an RF ALERT now also counts
  toward `_hasEnoughToWarrantACall()`. Also added genuine two-way interaction: `DiscoveryManager.
  query(question)` + a new `/ai-query` endpoint (`QUERY_SYSTEM` prompt, same snapshot, same
  grounding discipline — refuses to invent vessels/events not present in the data) + an input line
  in the console pane. Important honesty note for future-me: none of this is a trained or
  fine-tuned model. It's a general-purpose LLM (Claude Haiku or Gemini Flash, per `AI_PROVIDER`)
  given a structured text snapshot and a strict system prompt. No training/fine-tuning has
  happened or is planned — that would need a labeled dataset of "good correlation" examples we
  don't have. The "intelligence" here is entirely prompt + context engineering, not model
  specialization. Worth being upfront about this distinction if asked again.

- **2026-06-20 — Council note (Kay).** You have a `simClock` that decouples sim-time from
  wall-clock, invariant detectors that flag impossible speeds and stale events, a Claude API wired
  in via `aiCopilot.js`. You have, sitting right there, the raw material for a meta-medium — an
  instrument the viewer can use to reason about the world.

- **2026-06-20 — AI Discovery layer: cross-domain snapshot + tool-use actions, separate from aiCopilot's per-event enrichment.**
  `discoveryManager.js` is a new, independent manager (not a replacement for `aiCopilot.js`).
  It keeps a rolling per-MMSI timeline fed read-only off `aiCopilot.onEvent()` (temporal memory —
  "developing stories" of 2+ events on the same entity), and periodically builds ONE cross-domain
  snapshot (timeline + `window.vg1Invariants.recent()` + `window.vg1Integrity.flagged()`) and POSTs
  it to a new `/ai-discover` endpoint on `flight-proxy.js`. Claude's response is JSON
  `{assessment, actions}`; assessment surfaces through `alertsManager.js` as a new `DISCOVERY` alert
  type; `actions` run through a small extensible tool registry (`registerTool(name, fn)`) — built-in
  tool `selectVessel` reuses the existing `vg1:selectVessel` event bus (already wired to camera-fly +
  vessel card) so Claude can act on the scene with zero new manager coupling. New features plug in by
  calling `discoveryManager.registerTool(...)` — no edits to this file required. `DISCOVERY_SYSTEM`
  prompt requires 2+ correlated pieces of evidence and a citation for every claim (anti-hallucination
  guardrail, per `research/six-ideas-roadmap.md`'s "Anomaly-Gated Recaps" pattern) — empty assessment
  if nothing actually correlates. `aiCopilot.js`'s debounce/dedup was NOT touched — it still only
  suppresses repeat alerts; the new `_timeline` Map in `discoveryManager.js` is the separate mechanism
  that makes temporal narrative-building possible. Wired in `main.js` (`discoveryManager.tick()` in
  the animation loop) and `alertsManager.js` (new `DISCOVERY` type/rule). Requires
  `ANTHROPIC_API_KEY` set and `flight-proxy.js` restarted (Node require-cache) before `/ai-discover`
  is live.

- **2026-06-21 — DISCOVERY tab: terminal-style live console for every AI Discovery pass, not just hits.**
  New `#vp-discovery` pane in `index.html` (monospace, dark, auto-scrolling, blinking-cursor footer) plus
  `initDiscoveryConsole(discoveryManager)` in `uiController.js`, called from `main.js` right after
  `initAlertsManager`. Subscribes to the SAME `discoveryManager.onEvent()` stream `alertsManager.js`
  already uses — no new event bus. Root problem this solves: `discoveryManager.js` previously only
  `_emit()`'d on an actual finding, so there was no visible sign it was running at all between hits.
  Fixed by adding three new event types it now emits on every pass: `DISCOVERY_SCAN` (idle/skip or
  "N stories, N flagged, N violations" before calling the model, plus "no correlation found" after),
  `DISCOVERY_ACTION` (a tool actually ran, e.g. `selectVessel(...)`), `DISCOVERY_ERROR` (non-2xx
  response or thrown error, surfaced instead of only `console.warn`'d). `alertsManager.js`'s existing
  listener already filtered to `evt.type === 'DISCOVERY'` only, so the new types don't spam the Alerts
  panel — verified before adding them, not after. The Alerts panel stays "things needing attention";
  the Discovery console is "watch it think," append-only, capped at 300 lines.

- **2026-06-21 — Gemini added as a free-tier alternative to Anthropic for /ai-assess and /ai-discover.**
  `flight-proxy.js` now has two interchangeable LLM backends behind one function, `callLLM(systemPrompt,
  userMsg, maxTokens)` — `callAnthropic()` (existing) and `callGemini()` (new, `generativelanguage.
  googleapis.com`, model `gemini-2.0-flash` by default). Selection is automatic: `AI_PROVIDER` env var
  wins if set, otherwise Anthropic wins if `ANTHROPIC_API_KEY` is present, else Gemini if
  `GEMINI_API_KEY` is present, else no provider (`/ai-assess`/`/ai-discover` return 503). Both endpoints
  were rewritten to call `callLLM()` instead of building their own `https.request` to Anthropic directly
  — adding a third provider later means adding one `callX()` function, not touching the endpoints.
  Reason: local LLMs (Ollama/Llama 3/Mistral) were considered for a zero-cost, zero-account path for
  users without a Claude key, but ruled impractical on modest hardware (8-12GB RAM, no confirmed
  dedicated GPU) — too slow for a live periodic discovery pass. Gemini's free tier (no card required)
  is the practical zero-cost option instead; local LLM remains a possible future fallback, not built yet.

- **2026-06-20 — Sea-state layer is now THREE components (total / swell / wind-wave), flat selector.**
  Phases 1+2 of the wave-decomposition feature. `waveFieldManager` fetches `wave_height`,
  `swell_wave_height`, `wind_wave_height` in ONE Open-Meteo Marine request (same rate cost as one);
  stored as `_h{total,swell,wind}` + `_filled{...}`; accessors take a `comp='total'` arg
  (`waveAt`/`waveAtFilled`/`maxHeight`). Cache key bumped **`vg1_wave_field`→`vg1_wave_field_v2`**
  (3-array shape; old v1 ignored → one fresh fetch on upgrade). `waveFieldLayer` gained `setComponent()`
  + a 3-button selector inside the sea-state legend card (inline onclick → `window.vg1WaveLayer`);
  same renderer (RAMP, land mask, fades, contours) repaints from the chosen field. **Default = `total`
  everywhere, so the tuned look is byte-identical with no interaction** (Jamal was protective of the
  hard-won sea-state tuning — kept it untouched). Components do NOT sum linearly (Hs combine in
  quadrature: total² ≈ swell² + wind² + secondary) — never reconstruct one from the others. Verified
  live: total 11.2 m / swell 6.7 m / wind 10.7 m, three visibly distinct fields, same style.
  PHASE 3 (3D "explode" anatomy) — ATTEMPTED 2026-06-20, then DELETED at Jamal's call. Built standalone
  `wave3DLayer.js` (read waveField, never touched the flat layer; three stacked height-field sheets,
  relief = wave height, explode pulled swell+wind downward, opaque + normal-lit relief, auto-framed low
  oblique camera). VERDICT: didn't read. Root problem is geometric, not tuning — **stacked HORIZONTAL
  sheets occlude each other**: from any above-horizon angle the opaque top sheet hides the two below, so
  "all three at once" is impossible; making them translucent turns it into unreadable colour-mud (Jamal's
  word: "mud"). The only way to show all three would be a lateral exploded-diagram fan-out, which breaks
  the geographic alignment Jamal wanted. So the whole feature was removed (file deleted; main.js import/
  ctor/toggle/tick + index.html row reverted). **Do not re-attempt stacked-sheet 3D.** If 3D ever
  returns, it'd have to be ONE relief surface for the selected component (no stacking) — but not planned.
  KEPT instead: the flat Total/Swell/Wind selector (phases 1+2 above), which delivers the decomposition.

- **2026-06-20 — Unified collapsible legend ("MAP KEYS"): one panel, one card per active layer.**
  `legendManager.js` singleton (top-left, persisted per-card collapse + master minimize; `show(id,
  title,html)` / `hide(id)`; `swatchRows()` helper; `window.legendManager`). Replaced the old per-layer
  floating legend divs (which overlapped). Migrated: sea-state, GFS wind, Beaufort storm-warnings
  (id `wind-warnings`), IBTrACS cyclones (id `ibtracs`, title "CYCLONE TRACKS · SAFFIR-SIMPSON" — was
  never given a legend before). GPS-jamming has no legend; IBTrACS hover popup is separate, untouched.

- **2026-06-20 — Legend/marker colour PARITY: the map must render the exact swatch hue.** Two fixes
  after Jamal flagged mismatches. (1) Beaufort: the `core` line colour differed from the legend
  (`glow`) colour, and additive blending shows the core → set core===glow===legend hue per tier
  (magenta #ff2aa0 / orange #ff9e2a / blue #9fd0ff). (2) IBTrACS tracks: `categoryColor()` applied a
  1.4× saturation boost that SHIFTED hues (Cat-2 orange → yellow) and the track points used
  AdditiveBlending → washed to white over bright terrain. Removed the boost; switched track points to
  **NormalBlending** (the cyclone-spiral already did, for this reason); added `CATEGORY_HEX` as the
  single palette both the legend and `categoryColor` draw from. GOTCHA worth remembering: **additive
  blending over the bright base map washes colours toward white — use NormalBlending when a marker's
  literal hue must match a key.**

- **2026-06-17 — BACKLOG (Jamal's sidenote): build a real elevation map for the map.** Context: while
  styling the sea-state contours to look like a topographic chart, Jamal noted we should build an
  elevation map. Two reads, both worth it: (a) a land topography/relief layer with its own contour lines
  (true topo look — the rich fine detail in a real topo map comes from high-res elevation data, which our
  coarse 5° wave field can't mimic); (b) more broadly, a proper elevation model the map can sample
  (we already have GEBCO bathymetry + Terrarium DEM + getTrueElevation, so the pieces exist — this would
  be unifying/exposing them as a first-class elevation layer, possibly with contours). Not started.

- **2026-06-14 — GUIDING ARCHITECTURE PRINCIPLE: "distributed autonomy under central intent."** Jamal's
  call — build systems this way in general. Octopus model: a central reasoner holds intent + delegates;
  semi-autonomous "arms" (managers, tools, sub-agents) handle their own domain and report back; automatic
  "reflexes" (e.g. invariants.js) bypass the center; a "nervous system" (the `vg1:` event bus — managers
  communicate by events, never importing each other) decouples them; memory (`memory/`) persists/grows.
  Rationale: it stays connected to a living/changing reality. Apply to new features: prefer event-driven
  decoupling + local autonomy over centralized micromanagement.
- **2026-06-14 — Detention → alert.** New `DETENTION` alert type + default rule (enabled) in
  alertsManager (⚓, WARNING, amber). uiController raises it via `window.alertsManager.addAlert` when an
  Equasis dossier returns `detentions > 0`, deduped per MMSI for the session; click-to-focus works via
  the existing alert→`vg1:selectVessel` path. Surfaces a PSC detention beyond the card as a flagged event.
  Verified: rule merges in, alert renders correct meta. (Real trigger needs flight-proxy running.)

- **2026-06-14 — Camera responsiveness fix (feedback: "momentum makes it feel less responsive").**
  OrbitControls `dampingFactor` was 0.04 (very floaty/glidey). Raised default to 0.12 (responsive, light
  smoothing) in sceneSetup `initControls`, loaded from localStorage `vg1_cam_damping`. Added a "Camera
  Feel" control in Settings: Smooth 0.06 / Balanced 0.12 / Snappy 0.22 — live + persisted. Verified:
  default 0.12, buttons set+persist+sync. Higher = less glide.

- **2026-06-14 — Performance step 2: pre-load PERFORMANCE screen, shown EVERY load (Jamal's call).**
  `choosePerformanceTier()` in main.js `await`s before `loadAllData` (load gated behind it — verified).
  Two controls: QUALITY TIER (AUTO/LOW/MED/HIGH/ULTRA) + FPS CAP (Uncapped/30/60/120) + LAUNCH button;
  pre-selects last choice. AUTO→`resetAuto()`, manual→`setTier`; always applies `setFpsCap`. NOT
  first-run-gated anymore — appears on every load by design. Settings also has tier+FPS selectors for
  mid-session. Verified: every-load overlay, both controls apply (MEDIUM+60), load gated. STEP 3 DONE
  (the real load-time payoff): `quality.tileZoom()` (LOW=2/MED=3/HIGH=ULTRA=4) → `loadAllData(opts.zoom)`,
  GRID_SIZE=2^zoom. Verified: LOW downloads 32 tiles @1024² vs HIGH 512 @4096². Performance feature
  (FPS cap + pre-load tier screen + tier→tiles) COMPLETE. Remaining lever: GEBCO 54MB doesn't scale with
  tier (skip on LOW — graceful Terrarium fallback exists). See performance-load.md.

- **2026-06-14 — Performance feature, step 1: FPS cap (runtime).** Frame limiter in main.js animate loop
  driven by `quality.fpsCap()` (0=uncapped; skips frames to hold target — can't exceed display refresh).
  Settings-panel buttons (Uncapped/30/60/120), persisted via `qualityManager` (localStorage `vg1_fps_cap`).
  Made `quality.tick()` cap-aware: pixel-ratio auto-tune judges "slow" against the cap's frame budget
  (×1.4 slow / ×0.85 fast) so capping FPS doesn't blur the map. Verified: button → cap value + persist +
  active-state. Steps 2-3 NEXT: pre-load quality-TIER screen (load-time; user instinct "set before load"
  is correct for the tier), then wire the tier into the tile download (close the load-time-vs-capability
  gap — tile zoom currently hardcoded regardless of tier, see performance-load.md).

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

## 2026-07-21 — flatQM fallback wrong elevation → false "water" on dry land (Egypt Western Desert)

**Found via:** live location sweep, diving to (28.5317°E, 27.6197°N), Western Desert, Egypt.
**Symptom:** A sharp-edged, real-point-cloud-textured (not flat-shaded) patch rendered solid
blue in the middle of clearly dry desert, at both z7 and z8 tile levels. Distinct from the
Kansas bug (2026-07-21, task #15) — that one was ZERO points; this tile had healthy point
counts (18k-28k), just colour-mapped wrong.

**Root cause:** `_flatQM()` (the fallback used when Cesium's real QM decoder throws mid-parse
on a valid 200 response — near-flat tiles like farmland/desert/plains trip this) reads
`minHeight` from byte offset 24 of the raw buffer. Confirmed live via raycast + direct
`position.getY()` sampling on the actual tile mesh: every vertex in the affected tiles sat at
~-0.23 to -0.26 scene-Y (i.e. minHeight near/below 0, sea level) when the real Western Desert
terrain here is well above sea level. Since this fallback path is only reached AFTER the real
decoder has already thrown — meaning something about the buffer doesn't match the documented
layout — byte offset 24 isn't reliably still `minHeight` for every response that lands here.
`elevToColor` paints anything at/below sea level as water, so the whole flat quad rendered as
a convincing fake lake.

**Fix:** `_flatQM(buffer, tx, ty)` now cross-checks the raw header read against
`getTrueElevation(centerX, centerZ)` — the same coarse-DEM lookup already used for pure-ocean
tile classification (2026-07-20/21). If the two disagree by more than 5m, the DEM value wins.
Cheap (DEM already loaded), and immune to whatever corrupted the specific buffer that triggers
this fallback in the first place.

**Verified live:** service worker + cache cleared, fresh reload, re-dove to the exact same
coordinates — tile now renders correct tan desert imagery, no blue. A second nearby blue patch
was checked and ruled NOT a bug: `getTrueElevation` there returns -44m, which is the real
Qattara Depression (a genuine below-sea-level basin in this exact region) — correctly rendered
as below-sea-level colour, not a data error.

## 2026-07-21 — FPS drop on camera angle change (rotate-drag stutter)

**Found via:** user report ("the FPS is pretty slow when I change the angle"), confirmed
live with rAF frame-time instrumentation during a scripted rotate-drag sequence at Gibraltar
(a tile-dense coastal view): baseline p50 ~18ms, but worst frames spiked to 73-84ms during
rotation, with ZERO new network activity in that window (checked via
`performance.getEntriesByType('resource')`) — ruling out network/fetch as the cause.

**Root cause:** `_buildPoints()` (converts a fetched QM tile into the point-cloud geometry —
barycentric sampling at 26k-34k points/tile, each with FBM procedural relief, colour blend,
and optional imagery sampling) measured live at ~40ms/call — 16x the ~2.5ms this file's own
older comments assumed. That assumption is now stale: `ptsBudget` was doubled by the
"DENSITY PASS" tuning pass, and both ocean-margin trims (triangle-level and per-sample,
2026-07-20/21) and the moiré jitter fix added more per-point work, all after the 2.5ms number
was measured, without re-checking it. `_loadTile` called this synchronously and immediately
the instant a tile's fetch resolved, with no throttle — unlike QM/imagery fetches, which
already go through `_qmQueue`/`_imgQueue` priority-concurrency limiters. A fast camera
ROTATION sweeps the forward-shifted load anchor across a much wider arc than pan/zoom does,
so it surfaces many more brand-new candidate tiles within 1-2 real frames — several ~40ms
synchronous builds landing inside a single rAF callback is exactly what produced the spikes.

**Fix:** added `_buildQueue`/`_pumpBuildQueue`/`_queueBuild` — a frame-budgeted (6ms/frame),
nearest-first-priority queue (same priority convention as `_qmQueue`) that all three
`_buildPoints`/`_buildMesh` call sites now route through (initial points build, the
imagery-swap rebuild, and the mesh-mode build). A self-driving `requestAnimationFrame` loop
drains it every real frame regardless of how many `TileCache.update()` calls happen that
frame. This changes WHEN a tile's geometry gets built, never what it looks like once built.

**Verified live:** same rotate-drag sequence, same location, settled/idle-network
precondition both times for a fair comparison. Before: avg frame 18.6ms, worst10 all in the
38-84ms range (many stacked builds). After: avg frame 16.7ms, p90 18.7ms, worst10 mostly
25-37ms with only 2 residual spikes near 76-79ms (down from the previous many). Total
`_buildPoints` cost per tile is unchanged (~40-42ms) — this is a scheduling fix, not a
per-tile speedup — but spreading builds across frames instead of stacking them removed the
worst of the stutter. A real per-tile speedup (lower point budgets, or moving the build into
a Web Worker per the CLAUDE.md pattern) would be the next lever if further smoothing is
wanted.

## 2026-07-21 — Unbounded _loading backlog under network throttle + rapid movement

**Found via:** the throttled-network test, run immediately after fixing the FPS-on-rotate
build queue. Simulated a slow connection (window.fetch wrapper adding 3.5s delay to Cesium
QM requests, 10.5s to ArcGIS imagery — the latter exceeding the app's own IMG_TIMEOUT_MS) and
repeated the same 30-location rapid-teleport thrash used for the earlier memory-leak test.
Result: one LOD level's `_loading` Set held **1022 unique stuck entries** — for a level whose
loadRadius caps real candidates at 25. A second round (compounding on the first) pushed it to
**2421**.

**Root cause:** the build-queue fix earlier today (frame-budgeted `_buildPoints`/`_buildMesh`
scheduling) only bounded ONE stage of the pipeline. `_loading.add(key)` (in `_loadTile`)
happens BEFORE any of that — before the tile's QM fetch even starts — and stays held for the
tile's entire journey: queued in `_qmQueue` → fetched → queued in the build queue → built.
`_qmQueue` (and `_imgQueue`) turned out to have the exact same unbounded-growth flaw the build
queue had: no size cap, and each job's `priority` is a snapshot frozen at enqueue time, never
re-scored against where the camera actually is by the time its turn comes up. Under heavy
candidate churn (rapid movement, amplified by a slow connection stretching out how long each
job occupies a slot), thousands of stale jobs for long-abandoned locations can pile up ahead
of genuinely current ones.

**Fix:** applied the identical cap-and-evict pattern used for the build queue to `_qmQueue`
(`MAX_QM_QUEUE = 400`) and `_imgQueue` (`MAX_IMG_QUEUE = 400`, FIFO so oldest is evicted
rather than worst-priority). `_qmQueue` evictions reject the job's promise with a generic
"cancelled" error, which `_loadTile`'s existing catch block already treats as transient (not
a 404/parse failure) — no permanent blacklist, `finally` still clears `_loading`, and the tile
is free to be requested again if it becomes relevant later. `_imgQueue` evictions resolve with
`null`, the same value a genuine fetch failure already produces — every caller already
handles that.

**Verified live:** identical throttled-thrash sequence, same 30 locations, same artificial
delays. Before: `_loading` reached 2421 at one level. After: peaked around 289, then drained
to 110 and continued falling over the following 20s with no further movement — bounded and
recovering, not runaway. This is the kind of bug that's invisible in normal use (a single
user moving at a normal pace) but would make the app feel "broken" — tiles that just never
load, or take a very long time to show up after the user stops moving — for anyone on a slow
connection or anyone who pans/rotates a lot. Good thing to have caught via the stress-test
pass rather than a real user report.

## 2026-07-21 — Tile LOD tier changing with camera TILT instead of zoom

**Found via:** user report with screenshots (Germany/Poland night view) — "I don't like how
the land loads into smaller tiles if I turn the angle. the smaller tiles should become
apparent once I zoom in more, not when I shift my angle." Screenshots showed a patchwork of
clearly different-detail tile patches after rotating, not after zooming.

**Root cause:** `TileStreamManager.update()` (and `solidCoverage()`, `coverageFraction()`,
`closeCoverage()` — four separate call sites) all computed `camY = camera.position.y` (raw
world-space height) as the sole input to LOD tier selection (`LOD_LEVELS.forEach((cfg,i)) =>
{ if (camY < cfg.showAlt) active = i; })`. That's only equivalent to "how zoomed in are you"
for a straight-down view. OrbitControls orbits at a FIXED DISTANCE from `controls.target` —
rotating/tilting the view doesn't change that distance, but tilting toward the horizon at that
same distance still drops `camera.position.y` (y = radius·cos(polarAngle)), since more of the
fixed-length camera-to-target vector is now horizontal rather than vertical. LIVE-CONFIRMED: at
a constant 10-unit orbit radius, tilting from 5° to 65° polar angle dropped
`camera.position.y` from 9.6 to 3.9 — enough under the old logic to skip past TWO LOD tiers
(z7 straight to z9), with the actual "zoom" (orbit distance) never changing.

**Fix:** added `_effectiveAltitude(camera, lookAt)` — returns
`camera.position.distanceTo(lookAt)` when an anchor is given (angle-invariant by construction,
since OrbitControls holds that distance fixed while orbiting), falling back to raw
`camera.position.y` only when no anchor is available (matching the existing camX/camZ
fallback pattern already used throughout this file). Replaced all four `camY =
camera.position.y` call sites with this.

**Verified live:** (1) code-level — same 10-unit-radius tilt test as the diagnosis, before vs
after: `update()` now reports the SAME active tier (z7, targetOpac 0.69) at both 5° and 65°
polar angle, instead of jumping tiers. (2) Visual — reloaded, positioned at the user's
reported coordinates (11.2°E, 51.79°N), did two successive large rotate/tilt drags matching
the reported scenario. Terrain detail stayed visually uniform across the whole view after each
drag — no patchwork of mismatched tile sizes, FPS stayed healthy (175-197) throughout.

Note: `continentMesh.js`'s point-cloud/mesh crossfade (documented in CLAUDE.md as thresholds
`CONTINENT_FADE_START=25`/`CONTINENT_FADE_END=15` on `camera.position.y`) uses the same raw-
altitude pattern and could in principle have an analogous tilt sensitivity — not reported by
the user and not touched here, but worth keeping in mind if a similar "changes with angle, not
zoom" report comes in for that system.

## 2026-07-21 — AI Discovery layer switched on (Anthropic key, was Gemini quota=0)

**Context:** discoveryManager.js/discoveryRules.js already implement a full cross-domain AI
"planning" layer (free local rule engine every tick — STS-transfer pairs, dark vessels at
chokepoints, multi-signal single-vessel stories, cross-domain co-occurrence — escalates to
Claude only when genuinely ambiguous, plus a tool registry so Claude can act back on the scene,
plus a conversational /ai-query mode). It was built but never turned on:
`DISCOVERY.AI_ENABLED = false` in config.js, comment: "flip to true once a provider key with
real quota is configured."

**Diagnosis:** tested the backend (flight-proxy.js, the actual localhost:8787 server —
misleadingly named after its original flight-data-proxy purpose, now also hosts /ai-assess,
/ai-discover, /ai-query) directly from the live app's browser context. `.env` had
`GEMINI_API_KEY` set and `AI_PROVIDER=gemini`, `ANTHROPIC_API_KEY` empty. Direct POST to
/ai-query returned a 502 with a Gemini error: "Quota exceeded... limit: 0... free_tier_requests"
— the key was never actually provisioned for real usage (not merely exhausted), which is
exactly why the kill switch was correctly left off.

**Fix:** user set `ANTHROPIC_API_KEY` (real key) and `AI_PROVIDER=anthropic` in `.env`,
restarted flight-proxy.js. Re-tested the same direct POST to /ai-query — clean `{"answer":
"PONG"}` at HTTP 200. Flipped `DISCOVERY.AI_ENABLED = true` in config.js.

**Verified live, end-to-end, through the real app code (not just raw fetch):**
`window.vg1Discovery.forcePass()` — correctly ran the free rule engine, correctly found nothing
to escalate in the current (empty, no active scenario) scene, did NOT call Claude — proves the
cost-gating logic still works with AI on. `window.vg1Discovery.query(...)` — a real freeform
question round-tripped through the actual DiscoveryManager class to Claude and back: "I am
VANGUARD's AI Discovery layer, tasked with analyzing cross-domain maritime intelligence
snapshots and answering operator questions by grounding claims in vessel data, RF events, and
chokepoint activity." — correctly self-aware of its actual role and data sources per the real
system prompt, not a canned response.

**Not yet checked:** whether a live scenario with real anomalies actually escalates to Claude
and renders a DISCOVERY assessment in the visible UI feed panel (current test was on the empty
global view, 0 vessels loaded, so nothing to escalate) — worth a follow-up pass with an active
scenario running.

## 2026-07-24 — Adaptive quality controller was silently pinning the map to its lowest resolution

**Report:** "how do I make things less fuzzy and more clear and HD" — whole-world view looked
soft, coastlines undefined, HUD text slightly blurred.

**First (wrong) read:** blamed `SPLAT_FX.SCALE = 1.40` and the point-cloud splat inflation.
That is a real contributor but second-order. Also mis-cleared `qualityManager` as a suspect
early, because `vg1Quality.info()` reported `livePixelRatio: 2` — see the reporting bug below.

**Actual cause:** `quality.tick(delta)` is fed `delta = Math.min(clock.getDelta(), 0.1)` from
main.js's animate loop. That clamp exists for a completely different reason — it stops
dead-reckoning (flightManager extrapolation, wakes, trails) from overshooting after a stall.
As a *performance signal* it is actively wrong: a 3-second boot frame arrives at the controller
as exactly 100ms and reads as a plausible 10fps sample. A cold boot feeds several hundred of
those in, the controller ratchets pixel ratio down 0.1 per 90-frame cooldown until it hits the
0.6 floor, and then effectively never recovers (climbing back needs EMA < 15ms, four steps,
120-frame cooldowns). Net effect: the map renders at 36% of native pixels and upscales, for the
entire session, on hardware that doesn't need it. One `delta` value cannot serve both purposes.

**Measured (RTX 5060, dpr=1, whole-world camera, JS time via a wrapped rAF callback):**

| pixelRatio | frame | fps | JS |
|---|---|---|---|
| 0.6 | 13.5 ms | 74 | 4.7 ms |
| 1.0 | 13.0 ms | 77 | 4.1 ms |
| 1.5 | 14.1 ms | 71 | 4.9 ms |
| 2.0 | 15.1 ms | 66 | 6.2 ms |

The whole 0.6→2.0 sweep costs **1.6 ms**. This scene is not fill-rate bound; 0.6 was giving up
64% of the pixels to buy ~1ms and measured *slower* than 1.0 (the upscale blit costs more than
it saves). JS is 4-5ms of a 13ms frame — the animation loop is not the problem, and the "20+
manager updates per frame" worry in CLAUDE.md is not currently costing anything measurable.

**Fixes (qualityManager.js):** reject frame-time samples > `SAMPLE_MAX_MS` (50ms) outright
rather than clamping them into the EMA; seed the EMA from the first accepted sample instead of
averaging away a 16.7 guess while already acting on it; gate all pixel-ratio changes behind
`WARMUP_FRAMES` (120) accepted samples; raise the floor `PR_FLOOR` 0.6 → 0.85, clamped to never
exceed `pixelCap()`. Tests: `node tests/qualityManager.test.mjs` (11 cases; 7 of them fail
against the old implementation, verified by reverting it in a scratch copy).

**Also changed:** `SPLAT_FX.SCALE` 1.40 → 1.15 (config.js). A/B'd on one frame at pixel ratio
1.0: 1.40 = soft blobby coastlines, 1.00 = sharp edges but visible inter-point mottling, 1.15 =
continuous surface *and* sharp coast. Note the original 1.15→1.40 bump (2026-07-18) was made
while the controller was pinning pixel ratio to 0.6 — that comparison was run at 36% of native
resolution, so the "grainy speckle" it was fighting was partly an upscaling artifact rather
than splat density. Worth re-checking other look tuning done in that period for the same reason.

**Not done / open:** measurements were taken with 0 vessels and the ADS-B feed offline, so the
per-frame `entityStore.all().forEach` passes were iterating almost nothing. The 4ms JS figure
is a floor, not a guarantee — re-run the sweep with live traffic before concluding the loop is
cheap. Also: `pixelCap()` clamps to `devicePixelRatio`, so ULTRA's `pixelCap: 2.0` is
unreachable on a dpr=1 display and the map can never supersample. Lifting that deliberately
(render above native, downsample) is the remaining real "HD" lever and is untried.

## 2026-07-24 — Mid-zoom softness was a coarse LOD layer drawn OVER a finer base cloud

**Asked:** raise the global base mosaic past zoom 4 (4096²) to lift the "base texture ceiling".
**Answer: don't** — the base texture was never what you were looking at in the band that
actually looked soft, and raising it would have cost >1GB of buffers to fix nothing.

**What's actually true.** Streamed LOD levels render as POINTS on top of the base splat cloud,
and `solidCoverage()` deliberately never fades the base under points levels (uFade stays 1,
confirmed live). So a coarse level isn't a backdrop filling a hole — it's a coarser image
composited at 92% opacity over a sharper one. Comparing EFFECTIVE resolution,
`max(point spacing, texel size)` in scene units:

| | spacing | texel | effective | vs base |
|---|---|---|---|---|
| base cloud | 0.050 | 0.073 | **0.073** | — |
| z3 | 0.242 | 0.073 | 0.242 | 3.3× worse |
| z4 | 0.121 | 0.037 | 0.121 | 1.7× worse |
| z5 | 0.049 | 0.009 | 0.049 | 1.5× better |
| z6 | 0.021 | 0.005 | 0.021 | 3.5× better |

z3's imagery (imgSize 256 over an 18.75u tile) is 0.073 u/texel — *identical* to the global
mosaic. So z3 added exactly zero colour detail while subtracting point detail, and z3 is the
active level across effective altitude 37–200. That whole band was being actively degraded.

**Fix (tileStreamManager.js):** `LEVEL_BEATS_BASE` — a points level only paints if its
effective resolution beats the base cloud's by `BEATS_BASE_MARGIN` (1.05). Both sides are
computed from the live quality tier, so weak machines (sparser base cloud, coarser mosaic)
correctly qualify more levels. Mesh levels are exempt — they're not competing on point density
and the base *does* fade under them. Verified live: at effective altitude 100 and 50, z3/z4
sit at opacity 0 with **0 tiles loaded**; at 30, z5 comes in at 0.64 with 73 tiles.

**Bonus, verified not assumed:** `TileCache.update()` only fetches when `_targetOpac > 0`, so
gated levels stop *downloading* as well as drawing — z3/z4 previously held 45 and 94 tiles at
those altitudes. Real cold-boot bandwidth saving, free.

**Watch item:** the fast-dive ladder reads `hasCoverageAt()` from these caches, so gated levels
can no longer serve as its backdrop. Safe today only because the base cloud doesn't fade in
that band (`updatePointCloud`'s `closeness` is 0 until camera.y < SPLAT_FADE_TILES_START). If
the base fade band is ever raised to overlap a gated level, this needs revisiting.

**Design lesson worth keeping:** the first version of this gate compared point spacing alone
and marked z5 SKIP at 0.99× parity. That was wrong — the base cloud's points *oversample* a
coarse mosaic (adjacent points share a texel) while z5's points each carry a distinct 512px
sample, so at equal point density z5 is the sharper image. A layer can't resolve finer than its
point spacing OR finer than its imagery, hence `max()` of the two on both sides.

**Still open:** visual A/B of the band was not completed — the harness tab kept going
background (rAF pauses, tiles stop loading; see scar-tissue 2026-07-21). The numbers are
verified; the eyeball check is Jamal's.

## 2026-07-24 — Supersampling enabled; and the pixel-ratio system was never connected

**Built:** an explicit `Render Scale` setting (Native / 1.25× / 1.5× / 2×) in Settings, next to
Quality Tier. `qualityManager.setRenderScale()` — persisted, applies live, defaults to 1.0 so
the auto-tier can never stumble into it. `pixelCap()` split: `autoCap()` never exceeds
devicePixelRatio (unchanged automatic behaviour), `pixelCap()` multiplies by the user's opt-in
and is bounded by `RENDER_SCALE_MAX = 2.0` (pixel count is quadratic). The controller's 1.0
floor means it surrenders supersampling under load but never renders below native.

**Found while building it — the bigger item.** `EffectComposer` stores
`renderer.getPixelRatio()` once in its constructor and multiplies every `setSize()` by that
copy. Nothing in this codebase ever called `composer.setPixelRatio()`. So every pixel-ratio
change resized the canvas while the entire post chain kept shading at the construction-time
resolution — a resample of a full-res composite into a differently-sized canvas. **The adaptive
downscale system has therefore never saved any GPU work; it only ever added blur.** Fixed: all
writes go through `_applyPixelRatio()`, which emits `vg1:pixelRatioChanged`; main.js listens and
calls `composer.setPixelRatio()`. (Tier 1 event — qualityManager must not know about the
composer.) Also fixed in passing: main.js's resize handler called `onWindowResize` without the
tilt-shift passes, so those uniforms were never updated on a window resize.

**This invalidates earlier numbers in this log.** The 2026-07-24 sweep (0.6/1.0/1.5/2.0 →
13.5/13.0/14.1/15.1 ms) did NOT vary render resolution, only final-blit size. So "this scene is
not fill-rate bound" is unproven, and "supersampling costs 2ms" is void. The entry above about
the quality controller stands on its own evidence (boot frames poisoning the EMA is real and
independently tested) — but its performance table should be read as measuring blit cost, not
shading cost.

**NOT YET MEASURED — the open question.** Real cost of 1.5× and 2× with the composer actually
resizing. The harness tab kept backgrounding mid-boot and never finished loading, so this went
unverified. It could be bad: if the scene IS fill-rate bound, 2× is 4× the shading work. Load
the map, set Render Scale, watch the FPS counter. Tests (18 cases in
`tests/qualityManager.test.mjs`) cover the logic, not the GPU cost.

### 2026-07-24 (same day, follow-up) — supersampling measured; and a second device-pixel bug

**Composer fix verified.** With `composer.setPixelRatio()` wired up, render targets demonstrably
resize: 2560×1249 → 3840×1873 → 5120×2498, and the bloom mip chain scales with them (confirmed
by patching `renderer.setRenderTarget` to record every target bound during a frame — worth
reusing as a technique).

**Second bug, found only by LOOKING at the output.** The first 2× screenshot was darker and
sparser than native, not sharper. Cause: `gl_PointSize` is in DEVICE pixels, and the splat
shader's size constants (`lodMin` 1.5-2.0, `maxSize` 3.0-4.5) were tuned at dpr=1. At pixel
ratio 2 every splat kept its device size = HALF its on-screen size, opening gaps in the cloud.
Confirmed decisively by doubling `uSplatScale` at 2× and watching density return, then fixed
properly with a `uPixelRatio` uniform driven from `vg1:pixelRatioChanged`. three's own
`PointsMaterial` already handles this via its internal `scale` uniform, which is why the
tile-stream point layers needed no change — only the hand-written splat shader did.
**This also means the map has always rendered splats at half size on retina (dpr=2) displays.**
The fix corrects that too, so the look on hidpi machines will change — for the better, but it
is a change.

**Visual result at 2× (verified, same camera + crop):** per-point speckle across the Sahara is
gone, coastlines and the Nile/Red Sea edges are clean, map labels are legible. This is the
sharpness win the whole session was looking for.

**Cost: NOT RESOLVED.** Eight interleaved A/B samples (native vs 2×, 5s each, alternating to
cancel drift) gave native 13.38/18.95/19.41/14.49 ms and 2× 14.30/18.80/15.33/14.17 ms. The
distributions overlap almost entirely and the medians came out with 2× nominally *faster*,
which is physically impossible — so the noise floor (±3ms, from tile streaming, GC and other
per-frame managers) simply swamps the GPU difference. What can be said honestly: **across
repeated interleaved runs 2× showed no systematic penalty on an RTX 5060 at this camera, and
JS is ~9-10ms of a ~15ms frame, so the GPU has real slack.** What CANNOT be said is a specific
cost figure. Anyone wanting one needs a quiet scene (no tile streaming in flight) and GPU
timer queries (`EXT_disjoint_timer_query_webgl2`), not wall-clock frame deltas.

**Caveats on all of the above:** one camera position, 0 vessels, ADS-B offline. A loaded
tactical scene will shift the CPU/GPU balance.

**Known remaining device-pixel issue, not fixed:** WebGL line width is always 1 device pixel,
so country borders and trails get visually thinner as render scale rises (clearly visible at
2× — the borders nearly vanish). Fixing this needs fat lines (`Line2`/`LineMaterial`), which is
a real change to every line layer. Flagged, not attempted.

## 2026-07-24 — hitchRecorder.js added; first evidence says the stalls are NOT ours

**Built** `hitchRecorder.js` — records any frame gap over 50ms and reports which CUMULATIVE
counters moved across it. Probes register themselves (`registerProbe(name, fill)`), fill
pre-allocated objects, and are diffed via a ping-pong pair, so the normal-frame cost is one
timestamp subtraction plus a few number writes — no allocation, no DOM, safe to leave on.
Console: `window.vg1Hitch` (`.summary() .worst() .list() .clear() .setThreshold()`).
Probes so far: `renderer` (programs/geometries/textures/calls — discriminates shader compile
vs texture upload vs geometry build), `tiles` (builds, cumulative build ms, worst build,
over-budget pumps, all three queue depths), `loop` (ms spent inside animate()).
GPU time via `EXT_disjoint_timer_query_webgl2` around `composer.render()`.
Tests: `node tests/hitchRecorder.test.mjs` (15 cases).

**First live run — 48 hitches provoked by scripted flying through the LOD bands:**

| cause | count | worst | avg |
|---|---|---|---|
| **(nothing moved)** | **34** | **328ms** | **152ms** |
| renderer.geometries | 7 | 214ms | 119ms |
| everything else (tile builds, programs, textures) | 7 | 101ms | <101ms |

Worst single hitch: **505.6ms, nothing moved**.

**GPU time was flat at ~16.1-16.5ms on every hitch, including the 505ms one.** So these are
not GPU stalls; the main thread was blocked or rAF simply was not called. Combined with 34/48
moving no counter at all, the leading hypothesis is that the blocking work is OUTSIDE our
render loop — another rAF callback (note `_pumpBuildQueue` self-schedules its own rAF,
independent of `animate()`), a browser task, or GC of the large typed arrays. The `loop`
probe + `inFrameMs`/`outsideMs` split was added specifically to settle this and has NOT yet
been run live (harness tab kept backgrounding mid-boot).

**Also confirmed while instrumenting:** `_pumpBuildQueue` checks its 6ms budget only BETWEEN
jobs, never inside one, and a single `job.run()` is ~40ms by this file's own measurements. So
the budget bounds how many builds START, not how long the pump takes. Now counted
(`overBudgetPumps`) rather than left to be rediscovered.

**Next, once a foregrounded tab is available:** fly, then read `vg1Hitch.summary()`. If
`outsideOurLoopMs` dominates `insideOurLoopMs`, stop instrumenting managers — the cause is not
in them, and the next suspects are GC (large ArrayBuffers from the mosaic/GEBCO path) and the
independent `_pumpBuildQueue` rAF.

### 2026-07-24 (same day) — the hitches are NOT the renderer. Two setInterval callbacks, 18% of wall clock.

**Chain of measurement, each step ruling out a class of cause:**

1. `insideOurLoopMs` **976-1375** vs `outsideOurLoopMs` **5165-5555** across three clean runs
   (`discardedWhileHidden: 0`, verified foreground). ~80% of stall time is not in `animate()`.
2. GPU timer flat at **16-18ms** on every hitch including a 505ms one → not the GPU.
3. Heap probe: big stalls showed heap *growing* (+5 to +10MB), not dropping → **not GC**.
   (Real GC events did appear — 6 of them, all small, 50-58ms.)
4. **Camera held completely still**: still 13 long tasks / 25s, worst 235ms, same signature →
   not tile streaming, not LOD, not camera movement. A periodic background task.
5. `clearInterval` across the whole timer id space → **zero long tasks in 20s**. Confirmed a timer.
6. Patched `setInterval` at page load to record registration stacks and time every invocation.

**Named, with numbers (30s sample, 300 real aircraft loaded):**

| source | every | calls | avg | worst | total |
|---|---|---|---|---|---|
| `conflictManager.evaluate()` (main.js:691, `CONFLICT.TICK_MS`) | 3000ms | 25 | **85.2ms** | **197.1ms** | 2129ms |
| `gfsWindManager` demo field refresh (gfsWindManager.js:255) | 500ms | 158 | **21.2ms** | 67.7ms | 3344ms |
| everything else combined | — | — | <4ms | 5.5ms | ~190ms |

**5473ms of 30000ms — 18% of all wall-clock time — blocked in two timers, neither of which is
the renderer.** That is the stutter, and it is why the ±3ms noise floor made the supersampling
cost unmeasurable earlier.

**conflictManager** is O(n²) CPA over all aircraft: 300 aircraft = 44,850 pairs, synchronously,
every 3s. Its header notes it runs "on a timer, NOT every frame" — the right instinct, but that
only MOVED the cost, it never bounded it. A 197ms synchronous burst every 3s is worse for
perceived smoothness than ~3ms every frame would be. Real fix is a broad-phase spatial grid
(aircraft can only conflict within HORIZONTAL_NM=5, so all-pairs is almost entirely wasted);
cheap fix is chunking the pair loop across frames with a per-frame budget.

**gfsWindManager's 500ms refresh is DEMO/FALLBACK code** — it clears itself once
`_haveLiveData` is true, which never happened this session. So 11% of wall clock went to
regenerating a synthetic wind field that exists only until live GFS data arrives. Whatever is
wrong with the live GFS fetch is therefore also a performance bug, not just a data one.

**Method note worth keeping:** the `clearInterval`-the-whole-id-space test (step 5) is crude but
took one call and eliminated every other hypothesis at once. Reach for it before instrumenting
individual subsystems.

### 2026-07-24 (same day) — grazing-angle speckle: a coverage bug, not a resolution one

**Report:** low oblique view over Chad — black speckle peppering the desert, densest toward the
horizon; noisy far ocean.

**Live state at that camera (effective altitude 146.6):** EVERY tile level at opacity 0 — z3/z4
suppressed by the new `LEVEL_BEATS_BASE` gate, z5-z9 out of band (though holding 265 loaded
tiles). So the base splat cloud was carrying the entire view alone, and it was tearing.

**First diagnosis was wrong and worth recording.** The obvious read is "my gate removed the
layer that was filling, so relax the gate." But tilt does not change the RELATIVE resolution of
two point layers — both stretch on screen by the same 1/cos(incidence). What actually differs is
POINT SIZE: the base cloud's `gl_PointSize` is clamped in DEVICE PIXELS (lodMin 1.5-2.0,
maxSize 3.0-4.5) and does not grow with obliquity, while the tile layers use
`THREE.PointsMaterial` with world-space `size` + sizeAttenuation, which does. A points cloud
covers ground only while point size >= on-screen neighbour spacing, so the base cloud tears at
grazing angles and the tile layers do not. z3 was masking a base-cloud defect, not supplying
resolution the base lacked.

Corollary worth remembering: **adding points cannot fix this.** Doubling density halves spacing
but also halves point size at a given distance. Size is the only lever.

**Fix:** `SPLAT_FX.TILT_COVERAGE = 2.4`, applied in the splat VERTEX shader as
`tiltCover = 1 + uTilt² · (TILT_COVERAGE - 1)`. uTilt already existed and was being written every
frame by `updatePointCloud`, but only the FRAGMENT shader used it (brightness). Squared so
near-nadir and gently-tilted framing are untouched (boost ≈ 1) and it ramps in only where the
cloud genuinely tears. 2.4 ≈ the 1/cos stretch at ~65° from vertical. Live-tunable:
`window.splatCloud.material.uniforms.uTiltCoverage.value`; 1.0 restores previous behaviour.

**The gate was deliberately NOT relaxed** — it is doing the right thing (z3 adds no colour
detail and 4.8× worse point spacing) and the tearing it exposed was a pre-existing base-cloud
bug that would have shown up anywhere the base carried a view alone. If the coverage fix proves
insufficient at extreme obliquity, relaxing the gate is the fallback, not the first move.

**NOT VERIFIED LIVE** — harness tab kept backgrounding through the reload. A/B is one line each
way at any oblique camera; that check is outstanding.

**Also observed and unexplained:** `renderScale: 2` but `livePixelRatio: 1` at that camera —
the conflictManager/gfsWindManager timer hitches had driven the adaptive controller to its
floor, so the reported screenshot had NO supersampling active. The timer work (above) is
therefore a prerequisite for the sharpness work actually reaching the screen.

### 2026-07-24 — the black/olive rectangles: ArcGIS answers rate limits with HTTP 200 + a solid image

**Report:** "does not look better" — close oblique view (camY 1.6, effAlt 2.3) with black speckle
AND two solid rectangles, one black, one olive.

**First correction: the tilt-coverage fix was irrelevant to this screenshot.** At effAlt 2.3 the
base splat cloud is not drawn at all (`splatVisible:false`, `uFade:0.169`) — the view is z8+z9
tile point layers. The previous fix targeted a view at effAlt 146 where the base cloud carried
everything. Two different systems; generalising from one screenshot to the next was the mistake.

**Diagnosis of the rectangles, by measurement not inspection.** Sampled per-tile vertex colour
statistics across all 242 active tiles. Bimodal, with a clean gap:

| tile | mean luminance | **sd** | min–max |
|---|---|---|---|
| z9 564/321 (stuck) | 0.233 | **0.0014** | 0.230–0.237 |
| z9 567/315 (stuck) | 0.235 | **0.0014** | 0.231–0.239 |
| healthy neighbour | 0.582 | **0.1016** | 0.106–0.729 |

70× less colour variance — the rectangles are a *uniform fill*, RGB ≈ (0.35, 0.33, 0.02).
`_imgFailures` was empty and `getStuckImageryTiles()` returned `[]`: the existing diagnostics
reported perfect health.

**Root cause, reproduced live.** Re-fetched the imagery URL for both stuck tiles AND a healthy
one: all three returned **HTTP 200, 7795 bytes, a solid black JPEG (mean 0, sd 0)**. The ArcGIS
export endpoint answers rate limiting with a valid-looking solid image, not an error. The
2026-07-21 retry-with-backoff fix treats anything that decodes as success — so a solid fill
applies cleanly, clears `_imgFailures`, and is baked into the tile permanently with nothing
recording that it happened. The healthy tile simply won the race and fetched during a
cooperative window.

**Fix:** `_isBlankImagery()` in tileStreamManager — samples the decoded imagery and returns
false from `applyPointsImagery` if luminance sd < 1.5/255, routing it into the retry path that
already exists. Threshold is far below anything real (open ocean and blank desert both carry
JPEG noise well above it). Worst case for genuinely uniform imagery is MAX_ATTEMPTS retries and
then being RECORDED as stuck — still strictly better than a silent flat block.
Not added to the mesh path: it drapes the bitmap as a texture without reading pixels, so the
check would cost an OffscreenCanvas readback per tile, and every LOD level is currently
render:'points' so that path is unreachable.

**Bigger follow-up this exposes:** tile imagery still depends on ArcGIS, which rate-limits under
exactly the load this app generates. The BASE mosaic was already moved off ArcGIS to EOX
s2cloudless on 2026-07-15 for token/openness reasons (see dataLoader.js) — moving tile imagery
to the same source would remove the rate-limit failure mode entirely rather than detecting it.
That is the real fix; `_isBlankImagery` is the seatbelt.

**Still unexplained:** the fine black speckle across the terrain in the same screenshot. It is
NOT the base cloud (not drawn at this altitude), so it is something in the z8/z9 point layers —
individual points sampling black. Separate investigation; do not assume it shares a cause with
the rectangles.

## 2026-07-24 — conflictManager broad phase: 44,850 pairs → 4

**Framing that matters:** this is filed as a CLARITY fix, not a perf fix. Supersampling was
measured live at `renderScale: 2` / `livePixelRatio: 1.9` and then observed stepping back down,
because the adaptive controller reads frame time and the conflict timer's 197ms bursts pushed
the EMA past its 22ms slow gate. The sharpest image the renderer can produce was being clawed
back by an O(n²) loop that has nothing to do with rendering.

**Fix:** `forEachCandidatePair()` in conflictMath.js (pure, no THREE/DOM — testable in node).
Bound: minimum possible separation at any t is `sep(0) - (speedA + speedB)·t`, so a conflict
needs `sep(0) < HORIZONTAL_NM + (speedA + speedB)·LOOKAHEAD_HR`. Strict lower bound ⇒ the test
is conservative: it can admit pairs that turn out fine, it can never reject a real conflict.
Sort by latitude once, sweep with a `break` (not `continue`) once a partner is beyond the widest
possible gap, then a per-pair circular reject before the CPA math.

Deliberately mirrors `toLocalNm()`'s unwrapped longitude so antimeridian behaviour is unchanged —
that projection doesn't wrap either, so both reject such pairs. Fixing it means fixing toLocalNm;
the bound will follow automatically. Not silently "improved" here, because that would have
changed detection behaviour under cover of a performance change.

**Verified:** `tests/conflictBroadPhase.test.mjs` (10 cases). The load-bearing one is
differential — brute-force vs broad-phase over 400 randomised fleets, including clusters packed
tight enough to generate 50+ genuine conflicts (a fuzz over random global traffic would pass
vacuously, since random aircraft almost never conflict) and pairs placed at 98% of the bound.
Result sets identical every time. On realistic 300-aircraft global traffic: **4 candidate pairs
vs 44,850 all-pairs**.

**Measured live, same camera, 25s samples:**

| | before | after |
|---|---|---|
| stall time OUTSIDE animate() | ~5165ms | **1134ms** |
| hitches | 48 / 20s | 22 / 25s |
| frameMs (controller EMA) | 44.4 | **23.1** |

**Not yet good enough, and by a hair:** the controller's slow gate is 22ms and the EMA is 23.1,
so supersampling is still being surrendered (`livePixelRatio: 1`). One more improvement of ~2ms
tips it under and lets 2× hold.

**What's left, in order:**
1. `gfsWindManager` demo field refresh — 21ms every 500ms (4.2% of wall clock) for a synthetic
   field that only exists until live GFS arrives. Biggest remaining item and it is DEAD WORK.
2. Tile geometry churn inside animate(): one hitch showed `renderer.geometries +92` with
   `inFrameMs: 147`. TileCache.update() creates meshes on the animate() path.
3. GC — heap sits at **1350MB of a 4192MB limit**, and 9 of 36 hitches showed 20-26MB drops.
   The mosaic buffers being copied rather than transferred to the worker is the likely bulk.

### 2026-07-24 — GFS demo timer fixed; supersampling now reaches 2.0; next wall is the splat cloud's 935MB

**GFS fix.** Root cause of "live data never arrives" found and it is self-inflicted: `_fetch()`
asks Open-Meteo for a 1° global grid = 65,160 points batched 100-at-a-time = **651 HTTP requests
per fetch, once per page load**. Free tier is ~10k/day, so ~15 loads exhausts the daily quota.
Confirmed with a direct probe: `{"reason":"Daily API request limit exceeded"}`. So the synthetic
fallback is the STEADY STATE, not the exception — which is why making it cheap mattered.
Two guards added: skip synthesis entirely when the wind layer is hidden (it was animating an
invisible field), and split the grid into 4 latitude bands at 125ms instead of one 21ms spike
every 500ms. Same total work, no spike — the controller judges frame time, so the spike was the
part that hurt. Storm positions advance only on band 0 so the field can't shear between bands.
Quota fixes documented on `_fetch()` (5° fetch grid + interpolate ≈ 24× fewer requests; or a
gridded source instead of point queries).

**Measured result — supersampling now REACHES 2.0**, which it never did before:

| | before today | after conflict fix | after GFS fix |
|---|---|---|---|
| pixel ratio | pinned 1.0 | 1.0 | **starts 2.0**, decays to ~1.4 |
| frameMs | 44.4 | 23.1 | 10.7 at rest, 19-26 under load |

**But it still decays, and the cause is now GC, not timers.** With the camera parked and
**zero tiles loaded** (`t=0` on every LOD), 40 of 53 hitches correlate with `heap.usedMB` alone,
avg 93ms, worst 369ms. Allocation rate is only 0.9 MB/s — so this is not allocation churn, it is
the SIZE of the live heap: GC cost scales with what it has to scan.

**Where the heap is: 935MB of the 1342MB total is the splat cloud's six vertex attributes**, all
at 20,419,012 points:

| attribute | itemSize | MB |
|---|---|---|
| position | 3 × f32 | 233.7 |
| color | 3 × f32 | 233.7 |
| aNormal | 3 × f32 | 233.7 |
| aHeight | 1 × f32 | 77.9 |
| aSize | 1 × f32 | 77.9 |
| aRidge | 1 × f32 | 77.9 |

Not over-allocation — allocated == drawn. Genuinely 20.4M points. Savings available with **no
visual change**:
  • **aRidge (78MB) is dead weight** — `SPLAT_FX.RIDGE_PULSE` has been 0.0 since 2026-07-18.
    A per-point attribute feeding a disabled effect. Make it conditional.
  • **color → Uint8 normalized** (3 bytes vs 12): saves ~175MB. three handles normalized
    attributes transparently.
  • **aNormal → Int8/Int16 normalized**: saves ~175MB.
  • aHeight/aSize could drop to Float16/Uint8 for another ~100MB.

Total ~430MB recoverable, taking the heap from ~1342MB to ~910MB. That is the next lever for
holding 2× supersampling, and unlike reducing SPLAT_LAND_GRID it costs nothing visually.

## 2026-07-24 — tile point building moved to a worker pool

**Done in two stages on purpose.** Stage 1 was a pure extraction of
`tileStreamManager._buildPoints`'s maths into `tilePointsBuilder.js` (no THREE, no
DOM — sibling of conflictMath.js/igrf.js), with the main thread still calling it
synchronously. Stage 2 added `tilePointsWorker.js` + `tilePointsPool.js`.

Staging paid for itself immediately: the extraction test caught two real bugs that
would otherwise have gone straight into the worker and been debugged through a
black map — `TERRAIN_VERTICAL_SCALE` was never imported, and `curveOffset()` (the
earth-curvature offset that makes tiles sit flush against the splat cloud) was left
behind in the old file. Both invisible to `node --check`.

**Design constraint that made this safe:** the worker owns NO logic. It imports the
same `buildTilePoints()` the main thread does, so there is one implementation and
it cannot drift. The pool falls back to calling that same function synchronously
when Workers are unavailable (CSP, file://, old browser) — again, no second code
path. The pool keeps the two behaviours `_queueBuild` had and that callers depend
on: nearest-first PRIORITY, and EVICTION resolving with `null` (the
`if (built === null) return;` guards already handle it).

**qmData/imgData are CLONED into the worker, never transferred** — qmData is reused
by the caller for the imagery rebuild pass, and transferring would neuter it on the
main thread, silently producing a blank tile on the second build.

**Measured, same fresh close-in view (250 tiles), before → after:**

| | before | after |
|---|---|---|
| first tiles visible | — | **0.5 s** |
| fully settled | ~10 s | **4.6 s** |
| hitches during fill | 22-96 | **2** |
| stall time outside animate() | 1134-5555 ms | **29 ms** |
| pixel ratio during fill | fell to 1.0 | **holds 1.7** |
| FPS | ~30 with stalls | **110** |

That last row is the point of the whole thread: supersampling had been getting
clawed back by main-thread stalls all session. With building off-thread it holds.

**Tests:** `tests/tilePointsBuilder.test.mjs` (13) pins the extraction — most
importantly DETERMINISM, since tiles are evicted and rebuilt constantly and the PRNG
is seeded from tile coords so a rebuild looks identical rather than shimmering; a
worker port producing *valid but different* points would pass a screenshot and fail
here. `tests/tilePointsPool.test.mjs` (5) pins the queueing contract and proves the
fallback path is byte-identical to a direct call. Suite: 18 files, all green.

**Left undone:** `_queueBuild` still exists for `_buildMesh` (unreachable today —
every LOD level is render:'points'). Frustum-shaped footprint and the ~36%
off-screen tile waste are still open, and are now the largest remaining lever.

## 2026-07-24 — water: shader fixed, then the whole effect removed

**Two GLSL bugs, both silent.** (1) `waveNormal` was used in the
`<beginnormal_vertex>` hook, which three emits BEFORE the `<begin_vertex>` hook
that declared it — the vertex shader had therefore never compiled, for the entire
life of the file. (2) `uTime` was declared only in the vertex prelude but used in
the fragment shader. Both fixed.

**This closes two open scar-tissue entries.** The 2026-07-20 note describing a
`waterManager` `onBeforeCompile` edit that "produced no effect and no console
output", verified correct by manual invocation and filed as a suspected Three.js
program-cache bug, was never a cache bug: the shader was failing to compile, so no
edit to it could take effect. The "water changes colour" entry is plausibly the
same root cause.

**It also invalidated a CLAUDE.md instruction.** "Do not change waveA/B/C/D
steepness or wavelength — they were tuned to look physically correct" cannot have
been true; nobody had ever seen them render. CLAUDE.md corrected in place.

**Then the effect was removed, at Jamal's call.** Fixing the compile is what made
the design question answerable, and the answer was no — animated swell, sun
glitter, subsurface glow and a hex grid are decoration competing with the land and
traffic the map exists to show, at real fill cost over every ocean pixel. Removed
outright rather than flagged off. Also disabled: the **Fresnel sky reflection**,
which is view-angle dependent (~0.04 looking straight down, ~0.38 at grazing) and
so painted a hard horizontal seam across every ocean on an obliquely-viewed map.

**Final state: the sea plane is HIDDEN (`seaMesh.visible = false`).** The real
ocean here is the BATHYMETRY on the ocean-floor mesh — depth-shaded, with shelves,
ridges and trenches, all actual data. The plane is a flat tinted sheet on top of
it, and no colour value stops it flattening that detail into uniform blue. Three
rounds were spent tuning the sheet's colour before recognising the sheet itself
was the problem — the lesson being that "wrong colour" and "shouldn't be there"
look identical in a screenshot.

The mesh is still constructed: it carries the baked land mask and is the surface
`waveFieldLayer` paints significant-wave-height onto. `window.vg1Water.visible =
true` restores it.

**Method note:** four separate bugs this session were "shader compiles but is
wrong" — a stray backtick inside a GLSL template literal (which `node --check`
cannot see, because the wreckage is still valid JS), and three cross-stage uniform
declaration misses (`uFade`, `waveNormal`, `uTime`). Two guards would catch the
entire class in under a second at `npm test`: reject backticks inside shader
template spans, and check every uniform referenced in a stage is declared in that
stage. Both have been hand-run repeatedly and pass; neither is a real test yet.
That is the highest-value remaining work in this area.

---

## 2026-07-25 — Tile fetching is gated on LAND, from a baked coastline, not on DEPTH

**Reported:** streamed tiles stacked over open water around the Indonesian islands,
"unnecessary and wasting energy," seen at four zoom levels from one spot on the
Sunda Shelf (HUD read `DEP: -3 M`).

**Root cause, and it was one mistake made twice: depth was standing in for land.**
`tileStreamManager._isPureOceanTile` skipped a tile only when all 49 samples of the
2048x1024 baked DEM read deeper than -60 m, and the point builder's three trims
(`OCEAN_MARGIN_M` per-triangle, per-sample, and `LAND_MASK_MARGIN_M`) all called
anything shallower than -20 m land. Shelf depth and land are independent facts, so
both thresholds fail wherever the sea is shallow — which is most of the sea that
anyone looks at.

**Measured at z10 before the change:**

| region | fetched | near land | |
|---|---|---|---|
| Sunda / Indonesia | 69.1% | 63.4% | shelf is shallower than 60 m everywhere |
| North Sea | 70.1% | 53.1% | |
| Yellow / E. China Sea | 67.5% | 63.2% | |
| Persian Gulf | 99.3% | 92.2% | |
| open Pacific | 0.0% | 0.0% | the gate only ever worked in deep water |

Inside the Sunda box, 13.4% of the ocean AREA reads shallower than -20 m, so the
builder drew a full points budget of land-coloured dots across it. That, not the
fetch count, is what was actually visible in the screenshots.

**The same threshold failed in the OPPOSITE direction, and nobody had noticed.**
A DEM pixel is ~19 km, so a small island averages into the deep water around it and
the tile reads as open ocean. The gate was skipping the tiles containing **Malta,
Bermuda, Guam, Nassau, Key West, Male, Nauru, Diego Garcia, St Helena, Funafuti,
Kiritimati and Palau — 12 of 17 real islands sampled.** Those islands were getting
no streamed terrain at all. Finding this changed the shape of the fix: the job was
never "fetch less," it was "fetch the right tiles," and the two failures share one
cause.

**Decision: bake the answer offline from a real coastline.** `tools/build_tile_land_mask.py`
unions GSHHG (~0.9 km, via the `global-land-mask` package) with GEBCO and with the
baked DEM itself, reduces onto the exact geographic TMS grid the manager uses,
dilates by one tile ring, and emits `data/tile-land-mask.bin` — one bit per tile,
z3-z10, 341 KB. `tileLandMask.js` reads it as an O(1) lookup and **fails open**:
absent or still loading, every query answers "fetch," so a missing optional asset
can never blank ground. The DEM heuristic survives only as that fallback.

**Why baked and not a better runtime heuristic.** No threshold on a 19 km DEM can
separate a 2 km island from the water around it — the information is not in the
raster. Raising resolution at runtime means shipping a bigger DEM and sampling it
per tile; baking answers the question once, at higher resolution than either DEM,
and ships 341 KB.

**Net effect at z10:** 21,664 tiles no longer fetched, 42,588 tiles containing real
land now fetched for the first time. Globally that is slightly MORE fetching; in the
shelf regions where the complaint originated it is 8-24% less. Reported plainly
because "we made it faster" would be the wrong summary — the honest one is that the
fetch budget stopped being spent in the wrong places.

**Also split one constant into two named ones** (`TILESTREAM.LAND_MARGIN_M` = 0,
`TILESTREAM.SHORELINE_EPSILON_M` = -5). The -20 m value was doing two unrelated
jobs: "where is land" and "how much quantised-mesh height noise to absorb at the
waterline." Only the second is legitimately a margin.

**Verified by** `tests/tileLandMask.test.mjs` (fail-open, bit addressing, longitude
wrap, level nesting, and 28 named places that must survive the cull plus 6 open-ocean
basins that must not) and `tests/tileLandMaskCoverage.test.mjs`, which audits every
port, city and airport in the repo's own data — 396 locations, 1,980 lookups, zero
culled — by scraping the data files, so new entries extend the test automatically.

---

## 2026-07-25 — Terrain height unified: the map drew land at two different scales

**The defect.** The map draws land TWICE and the two copies disagreed about height
by ~3x. The base splat cloud (`terrainWorker.js`) used `elevation / 650`, tapering
to `/1100` above 2000 m; the streamed tiles (`tilePointsBuilder.js`) used `/2000`.
Both then applied the same `TERRAIN_VERTICAL_SCALE` and the same `curveOffset`, so
the discrepancy was purely the divisor. At 1000 m the base cloud's surface sat
0.208 scene units ABOVE the tile surface.

**Why it mattered.** The base cloud never fades under the all-points LOD ladder
(`solidCoverage` only fades the base for MESH levels, and there are none). It is
meant to be a BACKSTOP *behind* the tiles. Sitting 3x too high it was not behind
them — it was in front, and its points punched through the photographic tile
surface and won the depth test.

**This is almost certainly the "random splat dots floating around"** reported live
on 2026-07-21 from a close oblique view over solidly-tiled ground. That was
diagnosed as a FADE problem and patched with `TILT_FADE_FLOOR`, which made the dots
fainter. They were never floating because they were too opaque. They were floating
because they were computed at the wrong height. Symptom treated, cause missed.

**The decision — FLAT.** Both formulas are heavy vertical exaggeration; the choice
was never realistic-vs-stylised, only how much. At Everest, 1 scene unit = 133.58 km:

| | scene units | vs reality |
|---|---|---|
| true to life | 0.066 | 1x |
| tiles `/2000` | 0.885 | **13x** |
| base `/650-1100` | 1.609 | **24x** |

Jamal flew all three modes and chose FLAT: the base cloud drops to meet the tiles.
It adopts the more honest exaggeration, and it is what the close-up photographic
terrain already used — which matters because satellite imagery is flat and true,
so hanging 24x geometry under it makes mountains read as spires. Cost accepted
knowingly: the world view softens, partly undoing the 2026-07-15 `TERRAIN_VSCALE_LAND`
bump that had been made to restore land relief.

**The structural fix is the durable part.** `terrainHeight.js` is now the single
source of truth, imported by BOTH the worker and the tile builder. Two independent
copies of the same maths was the actual defect; picking a number was the easy half.
`resolveMode()` deliberately does NOT fall back to LEGACY — that is the one mode
where the surfaces disagree, so nothing may land there by typo.

**Verified live**, not just by unit test: switching to FLAT moved median land height
by exactly 3.08x (= 2000/650) and peak height by exactly 1.82x (= 2000/1100), with
identical sample counts. Those are the divisor ratios to three significant figures,
including the high-altitude taper.

**Escape hatch:** `window.vg1TerrainMode('legacy'|'tall'|'flat')` — reloads, since
the base cloud's ~20M heights are baked into a GPU buffer by the worker.

---

## 2026-07-25 — The loading-pipeline overhaul: four verified layers

One session rebuilt how tiles reach the screen. Each layer was measured before and
after; every number below is from a live run, not an estimate.

**The problem, quantified first.** A cold close view fired ~455 imagery requests
and ~650 tile builds; imagery arrived one-by-one over ~19s (Lisbon: 0% of tiles
photographic at 3s, 37% at 12s); a fast dive spent 67% of all loading (435/653
tiles) on altitude bands dominant <700ms each that settled invisible; and z8/z9
loaded simultaneously at equal priority, halving the visible level's bandwidth.

**Layer 1 — level-weighted queue priority.** `priority = d2 + (1-targetOpac)*100`.
A/B: dominant level complete in ~6s vs still-loading at 20s. Flag:
`vg1LevelPriority=false`.

**Layer 2 — progressive imagery.** Deep levels (z>10) fetch own imagery only
within 3 rings of the look-at; fringe borrows the parent photo. Two corrections
were required to make it work: parents must be fetched EXPLICITLY at the z10 grid
(`_ensureSourceImagery` — at deep zoom z10 is dark and loads nothing, so the
pyramid had no base; hit rate was 0.1% until this), and source images store at
native 512 (a 128-cached grandparent is an effective 32px smear for a z12 child).
Cold Perth: 78% photographic by 9s in ONE wave, vs the one-at-a-time crawl.

**Layer 3 — built-geometry cache** (`tileGeometryCache.js`, IndexedDB). Caches
buildTilePoints OUTPUT keyed by a fingerprint of everything that changes bytes +
SCHEMA_VERSION. Warm revisit: 231/231 tiles at the first sample vs a ~10s cold
ramp. Two shipped bugs found by verification: eviction was only reachable from
the quota-error path (store hit 525MB/512MB with evicted:0 and stalled the build
pipeline — a budget nothing enforces is not a budget), and stats.bytes had to be
recomputed after trim or the trigger fires forever.

**Layer 4 — dwell gate.** A level must be continuously wanted 800ms before it
may LOAD (fades untouched). Measured transit waste 435 → 260 (-40%). NOT the 84%
first reported — that interim number came from a hidden-tab-distorted run and was
retracted. Known slack: the gate keys on "wanted" (op>0.05) which lasts much
longer than dominance; keying tighter is the follow-up. Flag: `vg1DwellGate=false`.

**Also this session:** z11+z12 enabled (each required lowering
`controls.minDistance` — a level is only DOMINANT below showAlt−fadeBand, and the
old floor silently capped every deep rung; this trap fired three times: z10@2.3,
z11@1.15, z12@0.60); point-size clamp (z12 overlap 39x→6x, frame 36→19ms);
ACTIVE_PTS_CAP 14k→40k (0.36→~2 pts/screen-pixel — the audit standard);
fill-bound detector re-arms every ~1800 frames (pixelRatio verified back at 2.0
after being stuck at 1); tile land mask baked to z12 (5.5MB, +labelled-places
force-keep after the extended audit caught Malé culled); background tile warmer
(mechanism verified — tiles genuinely warm during idle; end-to-end cold-vs-warmed
A/B never completed, honestly UNVERIFIED); mesh rendering tried and REJECTED by
Jamal on look — point cloud is the identity; the surfaced applyMeshImagery race
fix was kept.

**Standing failure mode to respect:** the imagery/loading subsystem punished
plausible reasoning FIVE times today (concurrency, shared ancestor LRU,
uniform ring gate, colour-variance metric, interim dwell numbers). Measure a
baseline before changing anything here, and verify with the app's own counters,
never with inferred metrics.


## 2026-07-28 — Mid-zoom clarity: z7/z8 to 512px; geoid-ocean gate + land-mask v2

Jamal picked "mid-zoom sharpness (z8/z9)" as the clarity target. Measured live:
the mid-zoom band is drawn by exactly z7+z8, the ladder's last 256px-imagery
levels (everything adjacent is 512). Fix: imgSize 256→512 on both (zero
per-frame GPU cost — same point count, truer colour per point; fingerprint
includes imgSize so stale cache entries rebuild themselves). Verified live over
Tokyo; matches the 2026-07-13 z5/z6 precedent.

Second fix, found chasing "ocean checkerboard": the geoid-flat ocean gate +
tile-land-mask v2 (fetch plane vs land plane). Full mechanism and its traps in
scar-tissue.md (2026-07-28 entry). Asset rebaked z3–z12 (10.9 MB, fetch
fractions unchanged from v1). isGeoidFlatOcean() predicate in tilePointsBuilder
(tested); gate in _buildPoints covers BOTH the real-QM branch and the
_flatQM-rescue branch. hasLand() fails SAFE (v1 asset / unloaded → no
suppression). 34/34 test files green.

Known residual, deliberately deferred: land-BEARING coastal tiles still paint
their water fraction (per-sample carve against the land plane is the follow-up
if Jamal wants the last rectangles gone). And the LIGHTING ONLY scrub state
persists across reloads — flying at night-lit hours can read as "map got dark";
check the clock chip before diagnosing colour.


## 2026-07-28 (later) — Per-sample water carve + surf ring

Jamal: "I want them gone" (the coastal water rectangles). Shipped the per-sample
carve: manager builds a ≤32×32 carve grid per tile from the baked LAND plane's
finest useful ancestor (~4.9 km cells), threads it through pool→worker→
buildTilePoints (new trailing geoCarve param, cloned not transferred), and the
builder skips samples in water cells ONLY when the height sits inside the geoid
envelope — real relief always survives, so unmapped islands keep their
mountains. Geometry-cache SCHEMA_VERSION bumped 1→2 (all v1 records stale by
construction; warmth re-accumulates on revisit).

THE SURF RING, learned live within minutes of the first carve: carved water
must keep ~one 9.8 km DEM texel clear of any land cell. The base cloud's
coastline comes from that coarse DEM and bleeds land seaward; on tile handoff
the base fades there, and if the (much tighter, GSHHG-based) carve also removes
tile points in the strip, NOBODY paints it — jagged black wedges hugging the
Boso coast. _carveFor now samples an expanded (n+2r)² grid (neighbor tiles
included; out-of-range fails safe to land) and dilates land by ring cells
before cropping. Two coastline authorities must always OVERLAP, never abut.

Verified live at Tokyo: open-ocean rectangles gone, coastal fringe painted,
41 builder tests incl. 3 new carve tests, 34/34 files green. Remaining known
aesthetics, deferred: ArcGIS abyssal imagery is near-black and the painted surf
fringe inherits it off deep coasts (a colour treatment question, not a hole);
and whether day-side land brightness at local noon is right is still an open
thread (terminator shading of tile points was never separately verified).


## 2026-07-28 (later still) — Surf-fringe colour treatment

The painted surf ring inherited ArcGIS's near-black abyssal imagery off deep
coasts (Boso/Japan Trench) — black borders around coastlines. Fix: the carve
grid now carries three values (0 water-carved / 1 land / 2 SURF), and the
builder blends surf samples' colour toward elevToColor(SURF_DEPTH_M −80 m),
keeping SURF_PHOTO_BLEND (0.45) of the photo so reefs/harbours stay
photographic while abyssal black lifts to the floor mesh's bathymetric blue.
Surf samples also skip the procedural land relief/colour noise (geoid height
is not ground). Cache SCHEMA_VERSION 2→3. Two new builder tests (tint fires
on surf+dark imagery, never on real relief); 34/34 files green. Verified live
at the Boso coast: fringe reads as stepped blue shallows.

OPEN (pre-existing, not from tonight's work): sharp BLACK TRIANGULAR WEDGES at
steep coastal drops (Boso east ~140.6E/35.4N, south coast) — present in every
screenshot since before the 512px/carve changes. Raycast shows the same
geometry stack under wedges and healthy ocean (picking plane at y=0, water
shader at −0.19, #1b4fa0 backing at −0.2; floor mesh not raycastable), so it
is a floor-mesh/shading question at trench faces, not a tile hole. Next
session: probe the ocean-floor mesh's shading/normals at those faces.
