# Scar Tissue — gotchas that cost real time. Read before debugging.

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
