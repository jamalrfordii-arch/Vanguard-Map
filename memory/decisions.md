# Decisions — standing choices and their reasons (append-only)

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
