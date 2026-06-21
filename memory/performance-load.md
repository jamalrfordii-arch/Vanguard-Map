# Performance — load-time vs capability (the gap)

**Finding (2026-06-14):** VANGUARD1 adapts to device capability at RENDER time (pixelRatio, post-FX,
runtime FPS via `qualityManager`) but NOT at LOAD time. The heaviest boot work ignores the tier.

## Confirmed bottlenecks
- `dataLoader.js` has **0** references to `quality`. `loadAllData()` always fetches **512 tiles**
  (256 DEM zoom-4 + 256 ArcGIS satellite, GRID_SIZE=16), stitched into **two 4096×4096 RGBA buffers
  (~134 MB raw)** — same for a phone and an RTX desktop. Boot `await`s all of it before first frame.
- Local assets `await`-blocked at boot: **gebco_terrarium.png = 54 MB**, **terrain_normals.png = 17 MB**
  (main.js:328). BOTH have graceful null fallbacks → both are safely deferrable/skippable.
- Point cloud: `SPLAT_LAND_GRID=7500`; LOW `gridScale=√0.18≈0.42` → ~3180² ≈ **10M candidate points
  even on LOW** (floor `Math.max(1800,…)` doesn't bind). Heavy CPU/GPU build on weak devices.
- **No network awareness at all** — `navigator.connection` / `effectiveType` / `saveData` / `downlink`
  have zero references. Tier = GPU/CPU/RAM only. A strong laptop on slow wifi still gets ULTRA + 512 tiles.

## Fix surface (capable machines stay unchanged; only weak/slow ones downscale)
1. **Tier-gate tile zoom in dataLoader** — pass `quality` in: LOW→zoom2 (16 tiles/1024²),
   MEDIUM→zoom3 (64/2048²), HIGH/ULTRA→zoom4 (256/4096²). 4–16× fewer fetches + less memory.
2. **Defer the big local assets** — load GEBCO + normals AFTER first render (progressive upgrade),
   skip GEBCO entirely on LOW. They already fall back gracefully.
3. **Add a network-aware signal** to `detectTier()` — `saveData`/`effectiveType<=3g`/low `downlink`
   should knock the tier down a notch regardless of GPU.
4. **Lower the LOW point-grid floor** so phones build far fewer points.
5. **Progressive boot** — show terrain as soon as DEM+color are ready; stream borders/GEBCO/normals after.

NOTE: terrain is visual-ownership territory (see CLAUDE.md warnings). Only touch load resolution for
LOW/MEDIUM; keep HIGH/ULTRA (the dev's own machine) pixel-identical.

## Instrumentation in place (measurement-only, no behavior change)
`bootProfiler.js` is wired into `main.js` + `dataLoader.js`. It marks each boot stage (data fetch,
stitch+decode per source, point-cloud build, the blocking 17MB normal-map await, continent mesh) and
auto-dumps `[BOOT PROFILE]` at end of init. Console API: `vg1BootProfile.report()` / `.data`.
The network breakdown reads REAL transferred bytes from the Resource Timing API and groups by source
(DEM/satellite/GEBCO/normals/borders/JS), and it flags `saveData`/`effectiveType` — proving the tier
picker ignores network. **To get numbers:** DevTools → Network throttle "Slow 4G" (+ CPU 4–6× for
mobile sim), hard-reload, read the dump. Best run on the actual device someone reported as slow.

_Diagnosed 2026-06-14; instrumentation added._

## SHIPPED (2026-06-14)
- **Pre-load PERFORMANCE screen** (`choosePerformanceTier` in main.js) — every load, picks quality TIER
  + FPS CAP, gates `loadAllData`.
- **FPS cap** — runtime frame limiter in animate loop; `quality.fpsCap()`; cap-aware pixel-ratio tune.
- **Tier → tile download** — `quality.tileZoom()` (LOW=2/MED=3/HIGH=ULTRA=4) passed to `loadAllData`;
  GRID_SIZE=2^zoom. Verified: LOW = 32 tiles / 1024² vs HIGH 512 tiles / 4096². THE load-time fix.

- **GEBCO + normal-map skip on LOW (SHIPPED 2026-06-14).** On LOW tier, `loadAllData({skipGebco:true})`
  skips the 54 MB GEBCO (ocean floor falls back to Terrarium via getBestElevation) and main.js skips the
  17 MB normal map (`quality.tier==='LOW' ? null : loadNormalMap`, graceful smooth-normal fallback).
  Verified: LOW downloads neither (gebco/normals = NONE) + 32 tiles only. ~71 MB saved on LOW.

## STILL OPEN
- Optional: defer the normal map to AFTER first render on MEDIUM/HIGH too (currently a blocking await).
  Low priority — only LOW skips it now.
