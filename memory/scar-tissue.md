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

- **Node require cache.** `flight-proxy.js` caches `require('./equasis-lookup.js')`. Editing the
  lookup module does nothing until the proxy process is restarted.

- **Equasis endpoints (no API — web session scrape).** Login: GET `/EquasisWeb/public/HomePage` →
  POST `/EquasisWeb/authen/HomePage` (follow 302 with cookies). Ship data is a **GET**:
  `/EquasisWeb/restricted/ShipInfo?fs=ShipInfo&P_IMO=<imo>` (and `ShipInspection` for detentions).
  Name→IMO is a **POST** to `/EquasisWeb/restricted/Search?fs=Search` with
  `P_ENTREE_ENTETE`/`P_ENTREE_ENTETE_HIDDEN=<name>`. Credentials live server-side in `.env` only
  (gitignored) — never sent to the browser, never committed.

_Last updated: 2026-06-14._
