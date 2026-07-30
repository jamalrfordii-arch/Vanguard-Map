# Scar Tissue — gotchas that cost real time. Read before debugging.

- **2026-07-25 — a flat saturation multiplier amplifies the ILLUMINANT, not the surface; and a
  guard on one coloured surface but not its twin is how the same bug ships three times.** Two
  lessons from the tile-point gold/teal cast (full account in decisions.md).
  **(a) The diagnostic tell.** If boosting saturation makes warm areas go *more* orange AND dark
  areas go *more* teal at the same time, the multiplier is not making the image more colourful —
  it is exaggerating the difference between direct sun (warm) and skylight-filled shadow (blue).
  Both artefacts are one cause with opposite signs, so they look like two unrelated bugs and get
  chased separately. The fix is hue- and luminance-aware shaping, not a smaller multiplier alone.
  Corollary: **the eye reads an over-saturated neutral as the wrong hue, not as "too colourful"** —
  which is why this was reported as "colors look off" rather than "too saturated."
  **(b) The propagation failure.** The 1.4× hue-shifting boost was found and removed from IBTrACS
  `categoryColor()` (2026-06-20), then found again as `SPLAT_SATURATION 2.10 → 1.30` (2026-07-13),
  and was *still sitting at 1.40 in the tile path* — the surface you actually see close up — for
  weeks after both. `config.test.mjs` had a regression fence on `SPLAT_SATURATION` and none on
  `TILESTREAM.POINT_SATURATION`. **When you fix a colour-pipeline value, grep for every other
  surface that has the same knob and fence them together in the same commit.** A test on one of
  two twins is worse than no test, because it creates the impression the class of bug is covered.
  (The two also disagreed *across the LOD crossfade* — tiles at 1.40 blending into a cloud at 1.30
  means the surface changes vividness as you descend. Now asserted: tiles ≤ splat.)
  **(c) Don't trust a "do not touch, hand-tuned" comment over arithmetic.** The 1.15 output clamp
  carried a comment explaining it sat above the 0.95 bloom threshold and was being left alone
  deliberately. That reasoning was sound *while the cast existed* and became wrong once it didn't.
  Re-derive the tradeoff a protective comment describes; conditions it assumed may have changed.
  Same shape as the `waterManager` shader that "had been visually tuned" but had never compiled.

- **2026-07-25 — a depth threshold is not a land test, and the failure is silent in both
  directions.** Three places in the tile pipeline used "shallower than −20/−60 m" to mean
  "land." On continental shelves (Sunda, North Sea, Yellow Sea, the Gulf — most of the sea
  anyone flies over) that is true across open water, so tiles were fetched and painted with
  land-coloured points over the ocean. On small islands the SAME threshold failed the other
  way: one baked-DEM pixel is ~19 km, so Malta, Bermuda, Guam, Nassau, Key West, Malé,
  Nauru, Diego Garcia, St Helena, Funafuti, Kiritimati and Palau all averaged into the deep
  water around them and their tiles were SKIPPED — 12 of 17 islands sampled, getting no
  streamed terrain, and nothing reported it. **Only the over-fetch was ever noticed, because
  extra tiles are visible and missing ones just look like ocean.** When a heuristic is
  reported wrong in one direction, test the other direction before tuning the constant; and
  when the underlying raster is coarser than the thing being classified, no constant is the
  answer. Fix: `tools/build_tile_land_mask.py` → `data/tile-land-mask.bin`, read by
  `tileLandMask.js`.

- **2026-07-25 — `global_land_mask.globe._mask` is the OCEAN mask, not the land mask**
  (`is_land()` returns `logical_not` of it). Reducing it directly bakes the exact inverse
  of what you want, and the giveaway is subtle: the first bake reported "68.1% land tiles"
  — very close to the real 71% OCEAN fraction — and a mask that kept 99.9% of the globe.
  Sanity-check any global land statistic against ~29-35%, and against a few named
  coordinates, before trusting a bake.

- **2026-07-24 — `EffectComposer` caches `renderer.getPixelRatio()` in its CONSTRUCTOR, so
  `renderer.setPixelRatio()` alone silently does nothing to the post chain.** `setSize()`
  multiplies by that stored `_pixelRatio`; only `composer.setPixelRatio()` or `reset()` updates
  it, and Vanguard1 called neither. So every runtime pixel-ratio change resized the CANVAS while
  the whole chain (RenderPass → Bloom → Fog → Clouds → TiltShift×2) kept shading at the
  construction-time resolution — the final pass then blitted a full-resolution composite into a
  differently-sized canvas. All of the resample blur, none of the cost change. The adaptive
  quality controller had therefore never saved a single millisecond of GPU work in its life; it
  only ever added a resample. Fixed by routing all pixel-ratio writes through
  `qualityManager._applyPixelRatio()`, which emits `vg1:pixelRatioChanged`; main.js listens and
  calls `composer.setPixelRatio()`.
  **The expensive part of this lesson:** a pixel-ratio sweep run BEFORE the fix (0.6/1.0/1.5/2.0
  → 13.5/13.0/14.1/15.1 ms) was used to conclude "this scene is not fill-rate bound" and "2×
  supersampling costs 2ms". Both conclusions were void — the sweep never varied the resolution
  anything was rendered at, only the size of the final blit. **When a knob measures as nearly
  free, suspect the knob isn't connected before concluding the system is insensitive to it.**
  Confirm the thing you think you're varying actually changed (here: read back the composer's
  render-target dimensions, not just `renderer.getPixelRatio()`).

- **2026-07-24 — the same "reports intent, not state" bug twice in one file.**
  `QualityManager.info()` returned `this._pr` (seeded in the constructor to the tier cap, an
  optimistic value the renderer may never adopt) instead of `renderer.getPixelRatio()`. It read
  `livePixelRatio: 2` on a dpr=1 display where the cap could only ever be 1.0, which cleared the
  real culprit from suspicion for an hour. Fixed once — then the fix's own fallback branch
  reintroduced it for the pre-attach case, reporting the seed again before a renderer existed.
  Now returns `null` / "no renderer attached yet", and `info()` additionally surfaces
  `autoCap`, `pixelCap`, `renderScale` and `devicePixelRatio` so the dpr clamp is visible. **A diagnostic that reports intent instead of
  state is worse than no diagnostic. When there is no measurement, say so; don't substitute a
  plan for a reading.**

- **2026-07-24 — One `delta` value cannot serve both dead-reckoning and performance
  measurement.** `main.js` clamps `delta = Math.min(clock.getDelta(), 0.1)` to stop position
  extrapolation overshooting after a stall — correct for that purpose. The same value is then
  handed to `quality.tick()`, where the clamp turns every multi-second boot frame into a
  plausible-looking 100ms/10fps sample and drives the controller to its floor permanently.
  Both uses are individually reasonable; sharing the value is the bug. **When a clamped or
  smoothed value crosses into a second consumer, check whether the clamp still means the same
  thing there** — full diagnosis and measurements in decisions.md.

- **2026-07-24 — Look tuning done while the quality controller was pinned to 0.6 was tuned
  against upscaling artifacts, not against the thing it claimed to fix.** `SPLAT_FX.SCALE` was
  raised 1.15→1.40 on 2026-07-18 to kill "grainy speckle" at world zoom; that A/B was run at
  36% of native resolution. Re-A/B'd at pixel ratio 1.0 and reverted to 1.15. Any other visual
  constant tuned by eye between roughly 2026-07-18 and 2026-07-24 deserves the same re-check.
  **Before trusting a by-eye visual comparison, verify the renderer is actually at the pixel
  ratio you think it is** (`renderer.getPixelRatio()`, not `info()`).

- **2026-07-21 — The Claude-in-Chrome MCP tab can be `document.hidden = true` (backgrounded)
  for the whole session, which fully stops `requestAnimationFrame` — no tile loading, no
  animation, nothing that depends on the main loop, even though `Page.captureScreenshot`-style
  tools still return fresh-looking images.** Discovered while trying to live-measure tile-stream
  load speed: `camera`/`controls` teleports worked (screenshots showed the new position), but
  `window.tileStream`'s caches stayed at `targetOpac: 0, tiles: 0` indefinitely — no fetches ever
  fired — even minutes after setting the camera well within a tile LOD's `showAlt` band. A raw
  `requestAnimationFrame` counter confirmed **zero frames fired in 20 real seconds**, and
  `document.hidden`/`document.visibilityState` read `true`/`"hidden"`. Screenshots still look
  live because the capture path forces its own paint independent of the page's own rAF loop —
  this is what makes the tab LOOK responsive while its actual JS game loop is fully stalled.
  Net effect: **anything gated behind the main `animate()`/`requestAnimationFrame` loop (tile
  fetch triggering, fade timers, per-frame manager `.update()` calls) cannot be reliably
  live-tested through this harness** — only static, one-shot, or worker-driven behavior (splat
  cloud generation, geometry edits, shader edits verified via direct buffer/state inspection)
  can be trusted from automated screenshots alone. If a fix specifically targets frame-loop-gated
  behavior (like tile load speed), say so plainly instead of reporting a measurement that was
  never actually real — ask the user to verify on their end with a real, focused tab.
  **Resolved same day**: once the user made the tab actually visible/focused (`document.hidden`
  → `false`, confirmed via a raw rAF counter actually incrementing), `tileStream` immediately
  started loading normally and real timing measurements became possible — see the tile-load-speed
  fix in decisions.md. The lesson stands for future sessions: check `document.hidden` /
  a live rAF counter FIRST before trusting any timing or frame-loop-dependent live test.

- **2026-07-20 — A service worker (`vg1-code-v1` cache, `vg1-tiles-v2`) can silently serve stale
  JS across reloads — `mcp__claude-in-chrome__navigate` alone is not a reliable "get fresh code"
  guarantee for this app.** Found while debugging why a `waterManager.js` edit produced zero
  visible or logged effect after several full page reloads. `caches.keys()` from the console
  revealed the SW-managed cache; unregistering it (`navigator.serviceWorker.getRegistrations()`
  → `.unregister()`) and clearing all caches (`caches.keys()` → `caches.delete()`) is the first
  thing to try when an edit "isn't taking effect" and the served raw file (verified via
  `fetch(url, {cache:'reload'})`) already contains the change.
  **Still unresolved after clearing the SW**: a `waterManager.js` material's `onBeforeCompile`
  edit continued to produce no visible effect and no console output, across multiple full
  reloads — even though (a) the raw served file contained the edit, (b) the live material's
  `onBeforeCompile.toString()` contained the edit, and (c) manually invoking
  `mat.onBeforeCompile(fakeShaderObj)` from the console correctly produced the new shader text.
  Also tried `material.needsUpdate = true` to force WebGLRenderer to recompile — no change. This
  smells like a Three.js WebGL program-cache issue (a stale linked GPU program being reused
  despite the JS-level function being current) or something specific to the automated
  browser/GPU-process environment, not a bug in the edited code itself — the manual-invocation
  test is strong evidence the CODE is correct. If this recurs: try fully disposing and recreating
  the mesh/material/geometry (not just `needsUpdate`), or verify in a real (non-automated) browser
  window with a genuine hard refresh (Ctrl+Shift+R) before concluding a fix doesn't work.
  **Practical lesson: when a change to Claude in Chrome via any MCP tool "does nothing" visually
  AND produces no console output at all (not even deliberately-added debug logs), suspect the
  render/compile pipeline isn't picking up the change before suspecting the change's logic —
  verify with a manual function-invocation test before spending more time doubting the code.**
  **RESOLVED on a later re-attempt**: clearing the SW caches + unregistering, THEN doing a second
  full reload (not just one reload right after clearing) worked — the water land-mask fix showed
  up correctly and was confirmed live. Unclear whether the extra reload was the actual fix or
  just additional settling time; if this recurs, try clear-cache-then-reload-twice before
  escalating further.

- **2026-07-20 — `console.warn`/`console.log` calls INSIDE a Web Worker (e.g. `terrainWorker.js`)
  don't reliably show up in `read_console_messages`.** Added a coastal-fill pass to the worker's
  point budget and expected its existing `MAX_ALLOC` overflow `console.warn` to fire if the
  budget was blown — it never appeared, even with console tracking freshly armed before a reload.
  But the budget WAS blown: sampling the actual output buffer (`geometry.attributes.aHeight`,
  checking what fraction reads negative/ocean) showed real truncation, ocean fraction dropped from
  a healthy ~0.297 to 0.248/0.236 depending on the exact overfill. **Don't trust console silence
  to mean "no problem" for anything that runs in a worker — verify via the actual data (sample
  the output buffer/geometry directly) instead of the log.**

- **2026-07-20 — `simClock.setTime()` alone doesn't stick — pair it with `.pause()` or it snaps
  back to live wall-clock within moments.** Tried to pin a guaranteed-daytime UTC hour to test
  lighting; without `.pause()`, even after 60 `requestAnimationFrame` ticks the clock had reverted
  to live real time, which happened to be legitimate night-time (04:43 UTC) for the region under
  test — briefly looked like a catastrophic "entire continents render black" regression. Isolated
  by reverting the unrelated code change under test and reproducing the same blackout on a clean
  reload — proved it wasn't the code, then found the real explanation (live clock + real
  nighttime) via `new Date().toISOString()` vs `simClock.date().toISOString()`. **When testing
  lighting/time-of-day, always call both `setTime()` AND `pause()`, and verify with
  `simClock.isPaused()` before trusting the render.**

- **2026-07-20 — "Blue bleeding through the point cloud" was the water plane rendering IN FRONT
  of land, not sparse point-cloud coverage — verify occlusion vs. density by toggling the
  suspected occluder's `.visible`, don't assume from the visual alone.** The bug looked exactly
  like a coverage/gap problem (solid blue in the same region where a bright, complete point cloud
  had rendered minutes earlier), which led first to a plausible-but-wrong point-size fix. The
  actual test that settled it: `window.scene.traverse()` to find the water object by name
  (`dynamicSeaLevel`), set `.visible = false`, screenshot — land appeared completely intact
  underneath. That one toggle was more conclusive than any amount of reasoning about point density,
  distance, or shader math. **When something "should be there but isn't showing," check whether
  something else is drawn in front of it before assuming it isn't being drawn at all.**

- **2026-07-20 — Setting `camera.position`/`controls.target` once from the console doesn't hold
  — something re-perturbs it over the next several seconds, even with zero simulated input.**
  Observed testing the tile-coverage fix: set camera to a fixed spot, waited passively, and camY
  drifted from 6 to 2.34 (near the minDistance floor) over 12s of pure `sleep()` with no clicks,
  drags, or scrolls in between. `directorManager.js`'s `CinematicDirector` ("cinematic auto-camera
  when idle") looked like the obvious suspect but is DEAD CODE — exported, never imported or
  instantiated anywhere (grepped the whole repo, zero hits outside its own file) — so it wasn't
  that. Root cause not conclusively identified (candidate: OrbitControls damping/momentum
  interacting with a stale internal spherical state after a direct `.position.set()`, though that
  doesn't fully square with standard OrbitControls behavior either). **Practical fix that worked:**
  re-assert `camera.position.set(...)` + `controls.target.set(...)` + `controls.update()` every
  ~500ms in a loop for several seconds until `camera.position.y` reads stable across consecutive
  checks, THEN measure/screenshot — don't trust a single set-and-wait. If this needs a real fix
  later (not just a testing workaround), start by checking OrbitControls' internal damping state
  right after an external position set, not the director (confirmed a dead end).
  **RESOLVED (same day, later session):** it was exactly the suspected candidate —
  `controls.enableDamping`. With damping on, OrbitControls smooths toward its own internal
  spherical target each frame; a direct `.position.set()` doesn't update that internal state, so
  damping visibly "drags" the camera back toward wherever the internal state still thinks it
  should be, for as long as damping keeps applying (which reads as multi-second "drift" from a
  one-time set). Setting `controls.enableDamping = false` before a direct position override makes
  a single `.set()` + `.update()` hold exactly, no re-assertion loop needed. Only a testing-console
  fix — do not disable damping in the shipped app, it's part of the normal-use feel.

- **2026-07-20 — Teleporting the camera via a direct JS `.position.set()` to an arbitrary lon/lat
  can produce ZERO tile network requests, even after 8+ seconds settled.** Tried to reproduce the
  exact reported oblique tile-coverage scenario by computing scene X/Z from lon/lat with a
  hand-rolled Mercator formula and jumping the camera straight there. Result: `_lruOrder` on the
  deeper LOD caches slowly grew (30-181 entries) but `_tiles` and `_loading` stayed at 0
  indefinitely, and `read_network_requests` showed no Cesium requests fired at all — confirmed via
  the network tool, not inferred. Real navigation (scroll to zoom, drag to pan) at other points in
  the same session reliably triggered visible tile fetches and imagery rendering, so the dispatch
  path itself works. Root cause not identified (candidates: the hand-rolled lon/lat→scene formula
  doesn't match the app's real `lonLatToScene()` convention closely enough and lands somewhere
  degenerate; or an instantaneous large-distance jump trips some equality/epsilon check that skips
  a fetch dispatch that incremental movement wouldn't). **Practical implication: don't trust a
  synthetic JS camera teleport to validate tile-loading behavior — use real scroll/drag navigation
  (or drive it through the app's own search/lock-target UI) when the thing under test is whether
  tiles actually fetch, not just camera math or FPS.**

- **2026-07-20 — This app's OrbitControls has non-default mouse button mapping: LEFT drag = PAN,
  RIGHT drag = ROTATE (tilt), MIDDLE = DOLLY (zoom).** (`controls.mouseButtons = {LEFT: 2, MIDDLE:
  1, RIGHT: 0}`, i.e. THREE.MOUSE.PAN/DOLLY/ROTATE respectively — inverted from the THREE.js
  default of LEFT=ROTATE.) A left-drag in a test script will pan the view, not tilt it, and won't
  change `tiltActual` at all. Automated testing tools that only expose left-button drag can
  temporarily swap `controls.mouseButtons.LEFT = 0` to rotate instead — remember to restore it to
  `2` afterward so real mouse input isn't left broken for the user.

- **2026-07-20 — A source comment can drift from the code sitting right next to it, not just
  from a different file.** Diagnosed a tile-stream color seam by reading `config.js`'s TILESTREAM
  comment block ("z≥8 vivid vs z<8 muted") and built a theory on it — wrong. The consuming code
  in `tileStreamManager.js` had been changed to `zoom >= 6` on 2026-07-18, WITH an inline comment
  noting the change, but the block comment in `config.js` describing the same system was never
  touched. Caught only because the fix was verified against live vertex-color data before
  shipping (averages were statistically identical between the two levels, contradicting the
  theory) rather than shipped on the strength of the comment. **When a comment describes system
  behavior, trust the line of code actually executing over the prose next to the constant it
  reads — and check whether OTHER files reference the same constant with a comment that could
  have drifted independently.**

- **2026-07-20 — A config density knob can be a complete no-op and you'd never know: check the
  REAL uploaded GPU buffer size, not the grid constant.** `terrainWorker.js` pre-allocates fixed
  Float32Arrays (`MAX_ALLOC`) before generating points; if `LAND_GRID`/`OCEAN_GRID` produce more
  candidates than that allocation, writes past the array bounds are SILENT no-ops (no error, no
  warning) — and since the land pass runs first, it can eat the entire buffer before the ocean
  pass writes a single point. This was live for an unknown number of sessions: `SPLAT_OCEAN_GRID`
  had been deliberately tuned (1195→3000) and documented as a win ("ocean now reads as
  point-cloud"), but the ocean splat pass rendered ZERO points the whole time — whatever looked
  like ocean point-cloud was the separate `createSolidOceanFloor` mesh. Also caught: a documented
  "sampled to budget" comment (`MAX_SPLAT_BUDGET`) describing behavior that was never actually
  wired into the code — the comment was aspirational, not real. **Lesson: when a hand-tuned
  density/budget constant's effect is in question, don't trust the source comment or the config
  value — query the live buffer directly** (`window.splatCloud.geometry.attributes.position.count`,
  and sample an attribute for a signature only one code path writes, e.g. negative elevation =
  ocean-only) to see what actually reached the GPU. Added `console.warn` overflow guards in both
  worker passes so a future config change can't silently repeat this.
  **Also useful for future point-cloud FPS tuning: `geometry.setDrawRange(0, N)` lets you A/B test
  FPS-vs-point-count on the ALREADY-LOADED cloud with no reload** — much faster than editing
  config + reloading for every candidate value, since regenerating the cloud requires a full page
  reload (grid resolution is baked at worker-build time, not live-tunable like the shader
  uniforms). Reset with `setDrawRange(0, Infinity)`.

- **2026-07-13 — Mercator-normalized latAbs is NOT a latitude fraction.** terrainWorker's
  `latNorm = -z/(MAP_HEIGHT/2)` is mercY/π: 0.42→60°, 0.64→74.7°, 0.74→78.5°. Every latitude
  gate written as if 0.64≈"57°" was actually operating deep inside the polar circle — which is
  how the desert belt painted the Antarctic coast tan. CONVERT before reasoning:
  lat = 2·atan(e^(latAbs·π)) − 90°. Also from the same hunt: the Antarctica "grey shape" was
  THREE stacked causes (ice-shelf holes showing the sea plane, warm-term bleed, late polarIce
  ramp) — when a fix for a visual bug "doesn't work," suspect multiple causes with one symptom.

- **2026-07-12 — Cesium World Terrain is EPSG:4326/TMS, NOT Web-Mercator.** tileStreamManager
  indexed tiles on a mercator 2^z×2^z grid since it was written; CWT's layer.json declares
  `projection: EPSG:4326, scheme: tms` — 2^(z+1) columns × 2^z rows, ty=0 at the SOUTH pole.
  Consequence: nearly every deep-zoom request 404'd, and the few tiles that "loaded" were index
  collisions serving terrain from the WRONG latitude, silently drawn in the right place. Proof
  method (keep this): fetch `layer.json` from the Ion tile base and test your computed index
  against its `available` ranges — mercator canyon index (772/1607) absent + 404; geographic
  (1545/2868) present + HTTP 200. Fixed by regridding update/coverage/mesh-bounds/fetch URL and
  switching imagery to ArcGIS `export?bbox=…&bboxSR=4326`. LESSON: when a tile server 404s
  tiles that "must exist," check the layer manifest's projection/scheme before debugging math.
  ALSO from the same hunt: anchor tile loading on controls.target, not camera.position — the
  oblique camera sits ~4° of latitude behind the look-at (≈40 tiles at z12), and altitude-based
  fade-outs must gate on ACTUAL loaded coverage or fast zooms outrun the network → black ground.

- **2026-07-12 — Ghost terrain at Null Island (0°,0°) = a mesh whose position was never set.**
  The long-standing "wrong terrain at far zoom" report (CLAUDE.md known issue #1, blamed on
  continentMesh) was actually cityManager: patches baked world-sampled colors/UVs into LOCAL
  geometry and relied on `mesh.position` to translate them — but position was never set, so all
  ~36 city patches rendered stacked at scene origin (Gulf of Guinea, south of Lagos). Two lessons:
  (1) anything unexplained appearing near scene (0,0,0) → suspect an unpositioned object first;
  (2) binary-test by `scene.remove(group)`, NOT `mesh.visible=false` — per-frame manager
  `update()` loops overwrite `visible` and make the test lie (this cost two false negatives
  before the group removal isolated it). Also: continentMesh is data-only (never renders) —
  don't re-suspect it.

- **`altitudeDeckManager.js` existed half-built and silently dead before 2026-06-27, with no
  record anywhere.** It was imported, instantiated, and exposed on `window` in `main.js`, but its
  `setVisible()` was never called and its `update()` was never wired into the animation loop — so the
  whole layer just sat invisible, permanently. It also disagreed with `config.js`'s `ALTITUDE_DECKS`
  block (different deck lists; the manager hardcoded its own `DECKS` and never imported the config
  export at all) and used full-map camera-tilt-based fade rather than anything selection-driven. Task
  #46 still showed `pending`/"paused for discussion" the whole time, which was the only signal
  anything was unfinished — `memory/` had nothing. Rebuilt from scratch 2026-06-27 (see decisions.md)
  rather than patched, since the design itself (full-map, camera-tilt) didn't match what was wanted.
  **Lesson: a manager being imported + instantiated + exposed on `window` is not evidence a feature
  is live — check whether `update()`/`setVisible()` are actually called from the render loop before
  assuming a half-finished module reflects current behavior.**

- **The sandbox bash mount of Vanguard1 (`mcp__workspace__bash`, `/sessions/.../mnt/Vanguard1/`) can
  lag behind real edits made with the Read/Edit/Write tools — confirmed 2026-06-21.** After editing
  `config.js` with the Edit tool, `bash`'s own `wc -l`/`git diff`/`node --check` on the mounted path
  showed the file truncated mid-array (missing ~30 lines that exist on the real file, e.g. the
  `REGIONS` tail + `mulberry32`), and a `node --input-type=module -e "import('./config.js')"` in
  bash threw `Unexpected end of input` — looked like the Edit had corrupted the file. It hadn't: the
  Read tool (which goes through the real file path, not the mount) showed the file complete and
  syntactically valid the whole time. The mount is a stale snapshot for files edited mid-session; it
  doesn't refresh on access (`sync`+`sleep` didn't help). **Don't trust bash-based syntax/diff checks
  against the mount right after editing a file with Edit/Write — re-`Read` the file directly to
  confirm, and if you need `node --check` or a live unit test, copy the *content you have in context*
  into `/tmp` inside the sandbox and run it there instead of pointing at the mounted path.**

- **Toggling `obj.visible=false` to isolate a culprit in the live scene doesn't work for anything
  governed by the LOD code (point cloud, continent mesh) — it gets stomped back to `true` on the
  very next frame by the per-frame LOD update in main.js's animation loop, before your screenshot
  ever captures the change.** This burned a round trip while binary-searching the Antarctica
  grey-shape bug: hiding the splat cloud via `.visible=false` produced an unchanged screenshot,
  which looked like "this isn't the culprit" but was actually "the toggle never stuck." Fix: use
  `geometry.setDrawRange(0, 0)` instead (and restore with `setDrawRange(0, originalCount)`) — draw
  range isn't touched by the LOD code, so the override survives the next frame.

- **Chrome freezes `requestAnimationFrame` in non-foreground tabs — confirmed again 2026-06-21.**
  Driving the live VANGUARD tab via Claude in Chrome MCP while it wasn't the foregrounded tab
  produced three different-looking failures in a row (a host-permission error on screenshot, then a
  CDP `clip.scale` deserialization error after a forced reload, then a `zoom` call reporting a 0x0
  viewport) plus `javascript_tool` reporting `window.scene`/`window.controls` as `undefined` despite
  `document.readyState==='complete'`. All three are the same root cause, not three bugs — bringing
  the tab to the foreground fixed every one of them immediately. The 0x0 viewport from `zoom` is the
  fastest tell if you're not sure which symptom you're looking at.

- **The boot sequence has a blocking PERFORMANCE PROFILE / quality-tier picker screen that must be
  clicked through (LAUNCH button) before `window.scene` exists.** A page reload alone won't get you
  back into the live scene — `window.scene && window.controls && scene.children.length > 5` will sit
  false indefinitely with `document.readyState` already `'complete'` until LAUNCH is clicked.

- **Gemini free-tier quota exhausts fast once /ai-discover, /ai-query, and /ai-assess are all live.**
  All three endpoints (plus the phase-2 tool-use round trip, which is a SECOND call per request)
  share one API key, so testing the DISCOVERY console for a few minutes can burn through the
  free-tier quota and every subsequent call returns a 502 with a Gemini "you exceeded your current
  quota" body. No Anthropic key / no billing on this project (2026-06-21 decision) — so the fix had
  to work within the free tier rather than switching providers. Fixed by adding a shared call-budget
  wrapper around `callLLM()`: ~8s minimum interval between ANY LLM call (all three endpoints share
  one clock), a 60s response cache keyed on `(systemPrompt, userMsg)` so repeating the same question
  against an unchanged snapshot doesn't spend a new call, and a 5min cooldown that kicks in the
  moment a quota-exhausted error is seen (so failed calls stop compounding the problem — a failed
  request can itself count against quota). If queries start returning "AI quota exhausted — cooling
  down Ns," that's the breaker tripped, not a new bug — wait it out.

- **flight-proxy.js POST endpoints silently CORS-failing → browser fetch() throws "Failed to fetch"
  with ZERO proxy-side log line.** `Access-Control-Allow-Methods` was hardcoded to `'GET, OPTIONS'`
  (no POST) and there was no `Access-Control-Allow-Headers` for `Content-Type` — any POST request
  with a JSON body (`/ai-discover`, `/ai-query`, `/ai-assess`) triggers a browser CORS preflight
  that the server's OPTIONS response then fails, so the browser never even sends the real request.
  Symptom is misleading: looks exactly like "proxy isn't running," but the terminal shows the proxy
  alive and serving other (GET) endpoints fine, just never logging the failed POST at all — the
  request died in the browser before reaching the server. Fixed 2026-06-21: `Access-Control-Allow-
  Methods` → `'GET, POST, OPTIONS'`, added `Access-Control-Allow-Headers: Content-Type`. If a POST
  endpoint "does nothing" with no server-side trace, check this first before suspecting the handler
  logic.

- **Mount-sync lag (sandbox bash).** The Linux bash mount frequently serves a stale/truncated
  copy of files just written via Edit/Write → false `node --check` "Unexpected end of input"
  syntax errors (e.g. equasis-lookup.js showed 139 lines in bash vs 207 real). The Read/Edit/Write
  tools read the REAL disk and are the source of truth. Don't trust bash file reads right after a write.

- **⚠ DO NOT `git commit`/`push` from the sandbox after editing.** Git in bash reads the working
  tree from the SAME stale mount, so it will commit truncated/old file contents (observed:
  `git diff --numstat` showed NO change for equasis-lookup.js despite a full rewrite, because the
  mount served a 129-line stale copy). Pushing from here can publish broken code. Verify logic with
  inline `/tmp` tests, but do the actual `git add/commit/push` from Jamal's real terminal where the
  file tools' writes are intact. Safe push: `git add -A && git commit -m "..." && git push`.

- **Background-tab pause.** Chrome freezes `requestAnimationFrame` in non-foreground tabs. Any
  verification that depends on the render loop fails silently in automation. Check
  `document.visibilityState === 'visible'` first.

- **Service worker is network-first.** New ES modules require a hard refresh to load; otherwise the
  old cached module runs and edits appear to "do nothing."

- **Bloom threshold is a hairpin.** `bloomPass.threshold = 0.95`. Lowering below ~0.90, or adding an
  emissive material with emissiveIntensity > 1.0, makes the whole scene bloom white. Only
  `bloomPass.strength` is written by the animation loop; everything else is set once in sceneSetup.js.

- **Never hardcode light intensities.** `ambientLight`/`dirLight` are recomputed every frame from
  solar elevation. New lights must stay < 0.5 intensity or they wash out the continent mesh.

- **Mercator, not linear.** Vessel/flight coords use `lonLatToScene()` (Mercator). Terrain workers use
  linear XZ — the high-latitude mismatch is intentional. Don't "fix" it.

- **The two terrain assets are in DIFFERENT projections — sample accordingly.** DEM + satellite tiles
  (`elevation-tiles-prod/terrarium`, ArcGIS World_Imagery) are **Web Mercator** (4096² square); the
  GEBCO bathymetry PNG is **equirectangular** (8192×4096, 2:1, linear in latitude). Scene z is
  Web-Mercator (matches vessels). So linear `v=(z/MAP_HEIGHT+0.5)·H` is CORRECT for the Mercator DEM
  but WRONG for GEBCO. `getGEBCOElevation` now converts z→lat (inverse Mercator)→equirectangular row.
  Bug fixed 2026-06-14 (was ≈22° latitude error at 60° → the continent/ocean-floor "black gap" seam a
  reviewer caught). If you add any new equirectangular asset, reproject the same way.

- **Hover (mousemove) is bound to `window`, not the canvas — gate it on `event.target`.** So it fires
  over UI panels too, and vessel hover/tooltips leak through open windows. Fix (2026-06-14): onMouseMove
  sets `stateRef.overUI = event.target.tagName !== 'CANVAS'`; `tickRaycasting` bails (clears hover, hides
  tooltip) when overUI. Clicks are already canvas-only (renderer.domElement), so they were fine. Keep
  windows "solid": any new full-screen overlay must use `pointer-events:none` or it'll block map hover.

- **simClock, not wall clock.** Anything time-of-world must call `simClock.now()`/`.date()`, never
  `Date.now()`/`new Date()`. Live mode = wall clock by default but supports pause/scrub/rate.

- **AIS ship TYPE only comes from the static (type-5) message — NOT position reports.** (Durable fact.)
  Position reports have no ShipType → `aisTypeToClass(0)` → OTHER. FIXED 2026-06-14: the
  `ShipStaticData` handler now reads `static_.Type`, and if it maps to a real class, sets
  `existing.class` and fires `onVesselReclassify` (main.js rebuilds the vessel via the remove+new
  paths → correct hull shape + colour). Verified live: vessels convert OTHER→typed as static arrives
  (~every 6 min/vessel). Field is `Type` (confirmed — same AISStream schema as the working `ImoNumber`).
  Note: `window.aisManager` is NOT a global — don't try to reach it from the console; use `aisShips`,
  `vg1Integrity`, `vg1Scenario`, etc.

- **Integrity ON_LAND is a WEAK signal — tuned 2026-06-14 (was 182 false flags → 0).** The zoom-4 DEM
  can't tell inland WATER (Rhine, Great Lakes, Danube, Detroit R., Dutch canals) from land, and coarse
  coastlines mis-sample port vessels. Two-part fix in integrityManager/config: (1) `_isOnLand()`
  neighborhood guard — only "inland" if centre AND all 8 neighbours at `ON_LAND_MARGIN` (~30 km) are
  land (killed coastal noise, 195→41); (2) dropped `WEIGHTS.ON_LAND` 40→15 so a lone on-land hit stays
  TRUSTED (the residual 41 are legit inland-waterway vessels). On-land now only matters in combination
  with real anomalies. Lesson: validate any integrity signal against live data before trusting it —
  most "anomalies" were legitimate traffic the coarse basemap mislabels.

- **Open-Meteo free tier has a PER-MINUTE call-unit budget — back off ~60 s, not ms.** Multi-location
  requests cost units roughly proportional to the number of coordinates, so a full global grid
  (e.g. waveFieldManager's 5° = 2664 cells) blows the minute budget in a burst → HTTP 429
  `{error:true, reason:"Minutely API request limit exceeded. Please try again in one minute."}`.
  An error body comes back as an OBJECT, not the usual array — `Array.isArray(j)` is the success guard.
  Fix (2026-06-17, waveFieldManager): 429/error-object → wait `RATE_LIMIT_WAIT_MS≈62 s` then retry;
  fetch is progressive (writes each batch into the live field + fires `vg1:waveFieldProgress`) and
  rate-aware (BATCH 350, CONCURRENCY 2). A clean full populate takes ~2.3 min, then cached 3 h in
  localStorage (`vg1_wave_field`). ≤400 coords/request is safe (URL ~5.5 KB). Endpoint is fetched
  DIRECTLY client-side — Open-Meteo is CORS-enabled, no proxy needed. Land cells return
  `wave_height:null` (masked to NaN; doesn't break the batch). Same limit will apply to any future
  Open-Meteo layer (currents, SST) — reuse this pacing.

- **`getTrueElevation(x,z)` returns REAL-WORLD METERS (GEBCO-backed), ocean negative / land positive.**
  Takes SCENE x,z; ocean ≈ −3000…−5000 m, land positive (Sahara +538, Tibet +1530, Amazon basin +49).
  Sea level = 0. Use it as a crisp land/ocean MASK for any ocean overlay: `elev(x,z) > 0` → land →
  drop the vertex. waveFieldLayer uses this so the sea-state field hugs the rendered coastline instead
  of the coarse 5° data grid (killed the coastal colour-bleed + the "sheet floating over continents"
  look). Injected the same way as integrity: `layer.setElevationFn(getTrueElevation)` in main.js.
  For contour iso-lines, set land cells to NaN and skip any marching-squares cell touching a NaN corner
  — otherwise lines hug coastlines and look messy. Fill holes for full ocean coverage with a
  multi-source BFS nearest-fill on the data grid (waveFieldManager `_rebuildFilled`/`waveAtFilled`) —
  the GEBCO mask still decides land, so filled land cells never render.

- **Ocean-surface overlays must sit at the SEA mesh height (~scene y = −0.2), NOT arbitrary positive Y.**
  The sea plane is at `position.y = -0.2` (waterManager). Vertical scale is steep: `getTrueElevation`
  meters → scene Y is heavily compressed, so even y=0.6 floats a flat overlay HUNDREDS of metres above
  the sea and over all low-lying land (looked like the sea-state "hovered above continents"). Fix: set
  the overlay Y just above the sea mesh (waveFieldLayer `WAVE_Y = -0.12`). Land terrain then rises above
  it and occludes it (depthTest on), and the GEBCO mask drops land vertices anyway. Any future sea-surface
  layer (currents, SST) should sit at the same height. EXACT value matters: the water mesh is at world
  y = −0.2 (scale 1, no exaggeration even when zoomed/tile-streamed). Set the overlay to −0.19 (0.01 above
  water) — waveFieldLayer `WAVE_Y = -0.19`. Subtle but critical: at a GRAZING camera angle even a 0.08-unit
  gap above the water projects into a huge translucent "ceiling" floating toward the horizon, which reads
  as the layer hovering above the continents. Hug the water tightly and it disappears.
  Plus: a flat translucent ocean overlay seen EDGE-ON still reads as a floating veil toward the horizon
  even when seated on the water. Fix = grazing-angle alpha fade in the shader: compute view-space
  graze = abs(dot(normalize(-viewPos), viewNormal)); alpha *= smoothstep(uFadeLo, uFadeHi, graze)
  (waveFieldLayer defaults 0.18→0.5). Top-down (graze→1) full, horizon (graze→0) gone. No camera
  uniform needed (view-space is automatic). Tunable live: vg1WaveLayer.setFade(lo,hi).
  Palette lesson: a sea-state ramp must avoid BOTH ocean-blue (calm blends into water) AND land-green
  (calm reads as land over open ocean). Current ramp skips green: cyan→pale aqua→white→yellow→orange→
  red→magenta. Distinct as a data overlay at every level.
  CLEAN COASTLINES: don't mask land per-vertex on the heatmap mesh — a coarse grid gives blocky,
  grid-aligned coast steps. Instead build a per-PIXEL land/ocean mask TEXTURE once from getTrueElevation
  (equirectangular 2048×1024, land=0/ocean=255, RGBA UnsignedByte, LinearFilter, RepeatWrapping on S),
  pass each vertex's lon/lat → UV, and clip in the fragment shader with smoothstep(0.42,0.58,mask).
  Coastline crispness then decouples from mesh density (waveFieldLayer `_buildLandMask`, built lazily on
  first enable; getTrueElevation is a fast lookup so 2 M samples ≈ <10 ms). uMaskOn uniform gates it.
  DEAD END (2026-06-17): "paint sea-state INTO the water surface" (tint the Gerstner water shader in
  waterManager) is INVISIBLE. Proven by hiding the Water mesh (`dynamicSeaLevel` child, MeshStandard
  name 'Water', 300×300 @ y=-0.2, opacity 0.85) → the ocean stays fully navy. The ocean COLOUR is drawn
  by the point-cloud splat (terrainBuilder, camera.y>25) + the sea-floor/bathymetry mesh, NOT the water
  surface — the Gerstner water is a thin translucent photoreal layer on top. So tinting only the water
  has no visible effect at any zoom. The water-shader hooks (uSeaState / uSeaStateStrength) were added
  but left DORMANT (strength 0, no-op). To truly colour "the ocean" you'd have to tint the splat +
  sea-floor mesh in terrainBuilder (heavily protected uniforms — high risk). The visible, polished
  answer remains the OVERLAY mesh on top (renders regardless of what draws the ocean), seated on the
  water at WAVE_Y=-0.19, clipped to the coast per-pixel by the land mask, grazing-faded at the horizon.
  FULL-MAP COVERAGE: don't build the heatmap mesh by stepping LATITUDE (±LAT_LIM) — Mercator leaves a
  polar gap (dark band at the top/bottom edge where the field stops at 84° but the map reaches ~85°).
  Build rows uniform in scene-Z spanning the full ±MAP_HEIGHT/2, and derive lat per row via inverse
  Mercator for data/mask sampling (waveFieldLayer `_buildHeatGeometry`, rows=320). refresh() then reads
  lon/lat from the per-vertex `lonlat` attribute instead of recomputing. ISOBANDS: contour thresholds =
  the legend band boundaries [1,2,3,4,5.5,7,9] drawn as BLACK lines → the field reads as sections by
  wave strength, each colour band bounded.
  ISOBANDS / HYBRID POSTERIZE (2026-06-17): for crisp sea-state sections, quantize PER-FRAGMENT, not
  per-vertex (Gouraud interpolation blurs per-vertex bands). Pass wave height as a `wh` vertex attribute
  → varying; fragment computes `mix(bandColor(vWH), vC, 0.18)` = flat band colour + faint smooth nuance
  (the "hybrid"). Boundary lines use a small nautical vocabulary: thin solid (≤3 m), dashed (4/5.5 m,
  LineMaterial dashed+computeLineDistances), bold "cased" double line (7/9 m = black base LineSegments2 +
  bright thin core sharing the same geo). "Front emphasis" needs NO code — discrete bands at fixed
  thresholds bunch where the gradient is steep, so storm fronts render as dense stacked boundaries.
  The terraced-extrusion idea was rejected (reintroduces the floating/relief problems) — keep it FLAT.
  SMOOTH ENCLOSING OUTLINES (2026-06-17): marching squares emits unordered SEGMENTS → jagged. To get
  clean perimeters that wrap each zone like a drawn border: (1) `_contourSegs` returns lon/lat segments,
  (2) `_chainSegments` greedily joins them into continuous polylines by shared (quantized) endpoints,
  (3) `_chaikin` corner-cuts 2× into flowing curves, (4) project to scene + emit. Style by severity:
  ALL lines are BLACK (0x000000), weighted: sub-3 m (thresholds 0.5/1/1.5/2/2.5) = thin but VISIBLE
  (not a faint hairline — calm seas need real lines, and finer sub-3 m steps reveal cascade structure),
  3–5.5 m = bold, 7/9 m = heaviest + a thin light core 0xeef6ff (pure black vanishes on the dark
  red/magenta cores). What to outline: the threshold perimeters in open water only — NEVER coastlines
  (land cells skipped) or the map edge.
  "LINES LOOK LIGHT/GREY not black" even at color 0x000000 opacity 1.0: a solid-black LINE drawn UNDER
  (or interleaved with) the translucent heatmap fill + the baked-in base bathymetry lines gets tinted/
  washed toward the bright fill colour. renderOrder alone (62 vs fill 60) wasn't enough. FIX: contour
  LineMaterials set `depthTest:false` + renderOrder 100/101 so they paint LAST, over everything → truly
  black. Tradeoff: at extreme oblique angles an ocean contour behind a continent can draw over the land,
  but contours are ocean-only and the map is mostly viewed top-down, so acceptable. NOTE there is a
  faint CYAN base bathymetry/depth-contour layer baked into the ocean/terrain rendering (NOT toggleable
  geometry — survives hiding every Line layer + wind + water hex grid); removing it would mean editing
  the protected terrain/ocean shader. IDENTIFIED 2026-06-17: that cyan web is the BATHYMETRY DEPTH
  CONTOURS — a shader effect in terrainBuilder's ocean-floor material (minor every 500 m soft teal,
  major every 2500 m bright cyan), gated by `material.userData.showContours.value` (uShowContours).
  It is NOT geometry and NOT in any layer toggle, which is why hours of scene-hunting failed. Lesson:
  when a line layer survives hiding all geometry, it's a SHADER effect — grep the terrain/water shaders.
  Fix: waveFieldLayer.setVisible now calls `_setBathymetryContours(on?0:1)` — traverses the scene and
  sets every showContours uniform, so Sea State auto-hides the depth contours (clean black wave isobands)
  and restores them when off. (Alternative if the dense look is ever wanted: recolour the 500/2500 m
  contour lines in terrainBuilder from teal/cyan to dark instead of hiding them.)

- **"Lines won't render BLACK" even at color 0x000000 / opacity 1 — it's the POST-PROCESSING, not the
  material.** The scene's composer chain (Render→Bloom→Fog→Clouds→TiltShift×2→Bokeh) processes the whole
  finished image: fog tints by depth, depth-of-field blur smears thin lines → a pure-black 2px line comes
  out soft GREY. No material/renderOrder/depthTest change fixes it because the greying happens after the
  scene renders. FIX (2026-06-17): render the lines in a SEPARATE THREE.Scene AFTER `composer.render()`.
  waveFieldLayer holds `_overlayScene` (contourGroup lives there, not in the main scene); main.js calls
  `waveFieldLayer.renderOverlay(renderer, camera)` right after composer.render() — does
  `autoClear=false; clearDepth(); render(overlayScene, camera)`. Result: true crisp black lines, immune to
  fog/blur/bloom. General lesson: anything that must stay pixel-exact (crisp lines, HUD-in-3D) renders
  post-composer, not in the main scene.
  CONFIRMED TRADE-OFF (2026-06-17, after much iteration): the sea-state contour lines can be EITHER
  thin+crisp-black (overlay scene rendered after composer — FINAL CHOICE, Jamal wants black) OR
  perfectly locked-to-map through the operational-theatre cinematic orbit (in-scene), but NOT both.
  In-scene lines get greyed mainly by the TILT-SHIFT pass (on a tilted map most content sits in its
  outer blur band); easing tilt-shift helps but in-scene still never reads as crisp as the overlay.
  The overlay used to SLIDE during cinematic orbit — ROOT-CAUSED + FIXED (2026-06-17): cinematic orbit
  does `scene.rotation.y += 0.001` (spins the whole main scene); the overlay is a separate scene that
  wasn't spinning. Fix: `renderOverlay(renderer, camera, scene)` mirrors `_overlayScene.rotation/position/
  scale` from the main scene each frame → contours rotate with the map. So overlay now gives thin black
  AND stays locked. (If any future feature transforms the main scene, the overlay already follows it.) Also: toggling the FOG layer OFF makes the in-scene contours vanish
  entirely (odd coupling, not chased — fog stays on by default). Line weights: danger 1.8 / index 1.3 /
  standard 1.0 / intermediate 0.6 (thin). NOTE the ocean state is seasonal: in N-hemisphere summer the
  calm northern oceans legitimately have few high-band outlines; the storms (and bold lines) sit in the
  Southern Ocean winter. Sparse outlines over calm water is correct, not a bug.

- **Node require cache.** `flight-proxy.js` caches `require('./equasis-lookup.js')`. Editing the
  lookup module does nothing until the proxy process is restarted.

- **Equasis endpoints (no API — web session scrape).** Login: GET `/EquasisWeb/public/HomePage` →
  POST `/EquasisWeb/authen/HomePage` (follow 302 with cookies). Ship data is a **GET**:
  `/EquasisWeb/restricted/ShipInfo?fs=ShipInfo&P_IMO=<imo>` (and `ShipInspection` for detentions).
  Name→IMO is a **POST** to `/EquasisWeb/restricted/Search?fs=Search` with
  `P_ENTREE_ENTETE`/`P_ENTREE_ENTETE_HIDDEN=<name>`. Credentials live server-side in `.env` only
  (gitignored) — never sent to the browser, never committed.

_Last updated: 2026-06-17._

---

## Screen-space imagery rationing starved its own fallback (2026-07-25)

**Tried:** only fetch a tile's own satellite imagery within N rings of the camera
tile; everything beyond borrows from an already-downloaded coarser ancestor.
Sharp at the centre of view, softening outward, far fewer HTTP requests.

**Measured result: it made things WORSE.** Mean "palette" tiles (no satellite
imagery, showing the flat elevation ramp) across five sparse sites went
**59% → 75%**. Siberia z11 went 23% → 78%; Simpson Desert 35% → 73%.

**Why — and this is the transferable part.** The gate was applied to EVERY LOD
level. But borrowing only works if a coarser ancestor already holds real imagery,
and the coarse levels were rationed by the same rule. The pyramid was starved at
its base: there was nothing left to borrow FROM. The ancestor cache finished the
run at a **0.9% hit rate** (171 hits, 18,879 misses) — the mechanism was running
constantly and finding nothing.

**The general shape of the mistake:** a fallback that depends on a resource must
not be rationed by the same rule that produces that resource. Gate the many
(z11 ~181 tiles/view), never the few (z9 ~30, z10 ~93) — the few are the source.

**If retried:** apply the ring gate ONLY to the finest currently-lit level and let
coarser levels always fetch in full. Left in place as `IMAGERY_OWN_RINGS = Infinity`
(disabled) with the reasoning at the constant.

**Also note this was the THIRD wrong swing at the same subsystem in one session.**
The first blamed `IMG_MAX_CONCURRENT` — measured false, the limit hit its floor of
4 with the blank rate unchanged at 28→29%. The second (ancestor cache with one
shared 32-entry LRU) silently never hit, because the finest level evicted the
parents it needed. Only the third had the courtesy to fail loudly. The subsystem
punishes plausible reasoning; measure a baseline BEFORE changing anything here.

---

## The measurement was the bug: colour variance ≠ missing imagery (2026-07-25)

A five-site sweep reported 35–93% of tiles "missing imagery" (Kansas 93%). Three
fixes were designed against that number. Then the app's own records were checked:
`_imgFailures` was EMPTY at every level — imagery was landing on ~100% of tiles.

The metric classified a tile as "no imagery" if its point-colour standard
deviation was < 0.012. But flat terrain produces flat colour WITH imagery — and
all five chosen sites (Simpson Desert, Sahara, Kansas plains, Amazon canopy,
Siberian plain) are visually uniform terrain. The metric measured terrain
flatness and was read as pipeline failure. Tokyo "scored well" only because
cities are visually busy.

Fixes: tiles now carry a ground-truth `entry.imagery = 'own'|'borrowed'` flag set
at apply time — record the fact, never infer it from pixels. General rule: when a
metric says the system is badly broken but nothing LOOKS broken, audit the metric
against the system's own bookkeeping before designing any fix.

## Fixed world-space constants: one bug, four disguises (2026-07-25)

Same defect found four times in one day, each looking unrelated:
  • vessel hulls rendered 38 km long (192x; the hull template is 3.4 units, so
    reading BASELINE_SCALE as if the model were 1 unit understates 3.4x)
  • vessel shadow sprites fixed at 5 units = 668 km ("green lights" filling z12)
  • vessel dot lifted +0.02 units = 2.7 KM above the hull ("to avoid z-fighting
    with the water plane" — which had been disabled that morning)
  • OSM buildings at LOCAL_SCALE 0.002 = ~267x ("remove the blue cities", 07-15)

The class: a world-space size chosen while looking at ONE zoom level, used at
all of them. It only surfaces when the camera's range extends (minDistance drops)
— the constant didn't change, the context did. When extending camera range, grep
for `scale.set(` and fixed world-unit sizes and re-derive each against
`vesselScale.js` (pixel floors + hull-proportional + one-way caps). Related trap
fixed the same day: markers must size from the EFFECTIVE rendered scale, not
`userData.renderScale` (the base value) — sizing from base made the fix a
measured no-op (k=1.0000) that LOOKED like it worked because the pixel floor
moved numbers anyway.

## Verification hygiene, paid for in full (2026-07-25)

• Hidden-tab runs distort timing measurements (rAF paused, dives stretched): an
  interim "84% transit cut" was really 40% on a clean visible run. Never quote
  numbers from a run that went hidden.
• Tests must not clear the user's live caches for baselines — vg1GeoCache.clear()
  wiped a day of accumulated warmth and read as "you broke the map". Use
  throwaway regions instead.
• Namespace debug globals: ad-hoc instrumentation on `window.__T` clobbered the
  (since-deleted) frame profiler that had exactly the data being sought.
• A probe of a tokenized endpoint without the app's Authorization header returns
  401s that masquerade as coverage gaps; service-worker cache hits masquerade as
  origin 200s. Probe with the app's own auth + cache:'reload'.
• `ship.visible` is a layer/cluster flag, NOT a frustum test — at close zoom all
  500 vessels are "visible". A visibility gate built on it saves nothing; real
  per-entity culling needs an actual frustum check (does not exist yet).

## Still open (verified facts, no fix yet) — 2026-07-25

• ~25–40ms/frame is unexplained: hiding the ENTIRE base cloud changed nothing;
  hiding all 13M tile points changed nothing. CPU-side, outside both. The
  per-section profiler (window.__T) was deleted from main.js; re-add it before
  any further perf work.
• Cesium World Terrain has NO z9+ data above 60°N (SRTM limit — measured, exact,
  not symmetric; south is fine to 60°S). Gated in terrainCoverage.js. The data
  does not exist; only the wasted fetches were fixable.
• GFS fix (651→27 requests) is verified by request count only — quota was
  exhausted; live wind data unconfirmed until quota reset.
• Tile seams: median 4.7m (sub-texel, invisible) but p95 ~52m — a real tail,
  likely _flatQM fallback tiles meeting real QM neighbours.


## 2026-07-28 — Cesium's ocean is ABOVE sea level (the geoid trap)

Cesium World Terrain has no bathymetry at z6–z8 over most open water. An ocean
tile there decodes as the flat GEOID surface — up to ~+85 m ABOVE the ellipsoid
(+11..+20 m measured off Japan), not 0 and not negative. Consequence: every
"elevation < −5 m = ocean" guard in the tile builder PASSED open-water tiles as
low-lying land, and each painted a full budget of water-imagery points over the
bathymetry mesh — the tile-shaped ocean checkerboard. "Depth is not land" has a
twin: **height is not land either.** Never classify water by elevation alone.

Second half of the same bug: the baked land mask's bits INCLUDED the ±1 coastal
dilation ring, so `isWaterOnly` said "land" for every near-coast water tile —
fetch margin silently became a painting licence. Fix: mask v2 ships TWO planes —
FETCH (dilated, unchanged semantics) and LAND (undilated, labelled places
stamped with a ±1 ring because Malé city and MLE airport straddle two z12 tiles
— the first v2 bake proved it by failing its own test). Suppression requires
BOTH keys: land plane says water AND heights fit the geoid envelope
(config GEOID_RELIEF_MAX_M / GEOID_ABS_MAX_M). Either alone deletes islands or
misses ocean. Verified live: 197 tiles suppressed around Tokyo, one straggler
(malformed QM → _flatQM rescue path consulting only the 9.8 km DEM mask) traced
and the rescue branch now checks the land plane too.

Debugging lessons paid for tonight, again:
- The camera target must sit ON the curved surface (`curveOffset(x,z)`, ≈ −3.2
  at Japan). Framing a view at target y=0 makes the world read dim/sunken and
  sends you chasing lighting bugs that don't exist. The droop is design-wide
  (vessels, buildings, camera clamp) — not a bug, don't "fix" it.
- Hidden tab AGAIN produced fake evidence ("all opacities stuck at 0", "loading
  grew to 54") — check document.visibilityState BEFORE trusting any live number.
- Colour heuristics lied AGAIN: "blue-dominant avg" flagged dark Kii cedar
  forest as ocean. Positions (all points at y≈−3) were the honest signal.
- Hot-evicting live tiles to force rebuilds poisons per-tile state; reload
  instead. And background `nohup` does not survive between sandbox bash calls —
  run long jobs foreground or checkpointed.


## 2026-07-28 — The black coastal wedges: one symptom, THREE authors

Sharp black triangles/rectangles at coasts turned out to be three separate
mechanisms, peeled in order:

1. **Interpolation from a discarded vertex.** The ocean-floor mesh gives LAND
   vertices a placeholder colour and discards their fragments — but a coastal
   triangle mixes land and ocean vertices, and the KEPT ocean-side fragments
   interpolate toward the land corner's colour. Placeholder was (0,0,0) →
   black triangles exactly one ~78 km mesh face wide at steep drops. A
   "never rendered" vertex still renders through interpolation. Placeholder is
   now the shelf-start teal, and land vertices get the same NdotL relief shade
   so the blended corner matches its neighbours.
2. **Two authorities declining to paint the same spot.** The floor mesh
   discards where the coarse DEM says land (≥0); the tile carve removes points
   where the fine land plane says water. In narrow bays (Tokyo Bay) the DEM
   reads the water as land → BOTH bowed out → a black rectangle with two
   authors. Rule now enforced in _carveFor: a cell may only be carved when
   getBestElevation — the SAME function the floor's discard derives from —
   also says water there. Never let two painters each assume the other covers
   a pixel; gate one on the other's actual predicate, not on a parallel
   approximation of it.
3. **Genuinely dark shading** on hadal-band trench walls facing away from the
   fixed NW relief light (band colour × 0.45 ambient) — thin slivers remain
   and are arguably correct chart shading; left alone deliberately.

Meta-lesson, again: the wedges predated the evening's tile work and were
initially misattributed to it. Screenshot archaeology (the artifact appears in
the FIRST screenshot of the session) is the fastest innocence proof there is.


## Vessel model pipeline (2026-07-29)

**`children.forEach` vs `traverse` when harvesting a template.** shipInstancer's
harvest read `template.children` and filtered `isMesh`. That is correct for
entityBuilder's flat Groups and finds EXACTLY ZERO meshes in a glTF scene, which
nests Scene > Node > Mesh. The failure is silent — an empty part list produces an
empty set, no error, no vessels. Any code that accepts "a Group of meshes" from
more than one producer has to traverse.

**Measuring a hull's beam by histogramming vertices.** The first version of the
baker's bow-at-+Z check binned vertex |x| by Z band and demanded the forward band
be narrower. It rejected all 21 subtypes as "facing the wrong way". Cause: a
plan-form extrusion has vertices only where the outline CHANGES DIRECTION, so an
extruded hull has no vertices at all amidships — the mid-band half-beam measured
0.00. Fix: intersect triangle EDGES with station planes (the ship-lines-plan
construction), which is correct for any tessellation. Generalises: never sample a
shape's cross-section from its vertex cloud.

**A box hull cannot prove its own orientation.** BARGE's plan-form is nearly
fore-aft symmetric, so the taper check is structurally incapable of catching a
reversed barge. Rather than loosen the threshold for all 21 (which would have
quietly weakened a check that works), `boxHull: true` switches it to a weaker
test and records "orientation declared, not proven" in the manifest. When a
check cannot work, say so in the artifact instead of relaxing it everywhere.

**Build at the origin, rotate, THEN translate.** `box(w,h,l,x,y,z).rotateX(a)`
reads like it tilts the part in place. It rotates the already-offset geometry
about the WORLD origin and throws it off the ship. Cost two rounds: deck cranes
ended up below the waterline, sails detached from the mast.

**A freshly allocated instance slot is not empty.** When a vessel migrates from
its procedural set to a model set, the new slot holds whatever the buffer holds —
read back as an identity matrix, i.e. scale 1, i.e. a 3.4-unit (~450 km) hull for
one frame, on every vessel, on every migration. `_adoptModel` now replays the
vessel's last transform into the new slot instead of waiting for the next update
sweep. Caught by reading matrices back mid-test rather than by looking at it.

**Resolving a vessel's appearance once, at spawn.** Everything the mesh resolver
needs — length (AIS Dimension A+B) and name — rides the type-5 STATIC message,
which can trail the position report that created the vessel by minutes. Resolve
once at spawn and `lengthM` is always null, so the length ladders never fire:
every CARGO renders as a coaster, every TANKER as a product tanker, and it looks
exactly like the ladder thresholds are mis-tuned rather than never reached.
aisManager's reclassify hook does NOT cover it — it fires only on a CLASS change,
it assigns `existing.class` ~25 lines before `existing.lengthM`, and a vessel
typed from typeCache never fires it at all. `shipInstancer.resubtype()` runs on
the per-report update path instead, guarded by a class|length|name signature.
Rule of thumb: for anything derived from AIS statics, ask "what is null the
instant this vessel first appears?" — usually the answer is most of it.

**Releasing a slot before securing its replacement.** `_migrate` allocates in the
destination set FIRST, then releases. The natural order (release, then alloc)
loses the vessel entirely if the destination is at capacity — its old slot is
already back on the free list and there is nothing to restore.

**2026-07-29 — A STALE STAGED COPY IS A DELETE. Overwriting a file from a copy
read minutes earlier destroys everything added in between, and a missing named
export takes the whole app down, not just its feature.** `config.js` was written
from a snapshot taken before the PortWatch work existed, which silently removed
`export const PORTWATCH`. Vanguard1 then would not load at all — not "portwatch
is broken" but a blank app — because ES modules resolve named imports at load
time, so `import { PORTWATCH } from './config.js'` in portActivityManager.js
fails the ENTIRE graph. All 109 modules, gone, on one absent constant.

Three things made this worse than it needed to be.

**(a) The tell for this class of failure is "nothing loads" alongside a CLEAN
syntax check.** `node --check` passes on every file, every import points at a
file that exists, and the whole test suite passes — because the suite imports
modules individually and never exercises the graph as one unit. The check that
actually finds it is: for every `import { X } from './y.js'`, is X really
exported by y.js? Worth keeping as a one-liner; it located this in seconds after
a long detour through scopes and load order.

**(b) It was unrecoverable, because it was uncommitted-vs-uncommitted and git
had nothing to say.** Not in HEAD (never committed), and
`config.js.pre-portwatch.bak` predates the feature. The values were
reconstructed from how the consumers use them: every number matches the
corresponding default in the signatures inside portActivity.js —
matchPorts({maxKm = 50, warnKm = 25}) and seriesStats({recentDays = 7,
baselineDays = 90}) — which is the best available basis precisely because those
defaults were written next to the code that reads the namespace.
`PORT_OVERRIDES` (hand-corrected port name to PortWatch portid) could not be
reconstructed at all and is now empty; the `[portActivity] unmatched:` line on
init is the only way to discover what belonged in it.

**(c) config.js is the highest-risk file in this repo to overwrite.** 64 exports,
imported by roughly 60 modules, and it is where every new feature adds its
namespace — so it is simultaneously the file most likely to have changed under
you and the one whose loss is most total. Write it IN PLACE (read, splice one
namespace, write) rather than replacing it wholesale. The same applies to any
file with many independent consumers.

**Rule: never write a file from a copy you did not just read.** Re-read
immediately before writing and diff, or patch in place. A modification-time
guard catches this and costs nothing — the failure here was applying one to
main.js and index.html but not to config.js, the file rewritten most often
across batches.
