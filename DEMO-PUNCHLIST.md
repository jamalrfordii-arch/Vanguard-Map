# DEMO PUNCH LIST — getting a current demo version in shape
_2026-07-10. Ordered by demo impact ÷ effort. Sources: CLAUDE.md known issues,
memory/decisions.md, memory/performance-load.md, public feedback themes._

## P0 — visible bugs a reviewer will screenshot

1. **Antarctica grey shape — ROOT-CAUSED & FIXED (2026-07-13), verified live.** It was never
   one bug. (a) The "flat multi-faceted shapes" = HOLES in the ice sheet: ice shelves /
   subglacial basins are below sea level, the land pass skipped them, and the dark sea plane
   showed through → fixed by rendering sub-zero cells south of ~77°S as sea-level ice.
   (b) The warm/tan rim (grey before the hue-preserving ceiling) = the desert warm terms
   painting the polar coast, because EVERY latitude gate was miscalibrated: mercator-normalized
   0.64 is 74.7° LATITUDE, not 57° → belt cut to 0.42 (≈60°), polar desat added south-only.
   (c) The 2026-06-21 polarIce theory was a real but SECONDARY contributor — that's why the
   old fix "didn't work": it treated the smallest of three causes.

2. **"Continent mesh visible at far zoom" — ROOT-CAUSED & FIXED (2026-07-12).** Two findings:
   (a) The continent mesh itself was innocent — it's data-only since the hybrid migration
   (no material, never scene-added, `update()` is a no-op). CLAUDE.md "Known issue #1" is stale.
   (b) The REAL ghost terrain (reproduced live: tan patch south of Lagos, Gulf of Guinea) was
   `cityManager.js`: `_buildTerrainPatches()` never set `mesh.position`, so ALL ~36 city
   terrain patches rendered stacked at world (0,0,0) = Null Island. The LOD update measured
   distance to the correct city (`cx,cz`) but drew the mesh at origin — so flying near ANY
   city lit up a ghost patch in the Gulf of Guinea, the one place on the map you could see it.
   Fix: `mesh.position.set(x, 0, z)` (one line, cityManager.js). Verified live in-browser:
   Gulf of Guinea clean, Lagos patch now renders centred on Lagos, coastline aligned.
   NOT pushed — awaiting Jamal's verification.

## P1 — demo reliability (nothing cuts out mid-demo)

3. **OpenSky credentials (YOUR 5-minute task, blocks nothing else).** The reliable-planes fix
   from 2026-06-26 is built but idle until you register at opensky-network.org → Account →
   API Client and drop `OPENSKY_CLIENT_ID/SECRET` into `flight-proxy.js`'s `.env`. Without it,
   flights still ride the two anonymous mirrors that failed simultaneously once already.
   — *Effort: XS. Impact: planes don't vanish while someone's watching.*

4. **Bundled real-capture demo.** The new zone recorder makes this possible: arm a window over
   a busy zone (Singapore Strait, Hormuz, English Channel), capture a real 30–60 min of ships +
   planes, ship the NDJSON in `captures/`, and make the "VIEW DEMO" button offer real recorded
   traffic instead of (or alongside) the synthetic Hormuz scenario. A demo that's deterministic,
   works with zero API keys, and shows real movement. — *Effort: S (mechanism now exists).
   Impact: high — the demo stops depending on live feeds being up.*

5. **Graceful degradation sweep with the proxy OFF.** Much of the intel layer
   (Equasis, AI discovery, RF stats) needs `flight-proxy.js` on :8787. A cold visitor won't run
   it. Verify every panel shows a calm empty/offline state instead of errors — the CORS scar
   showed how misleading those failures look. — *Effort: S. Impact: first-run impression.*

## P2 — load time (first impression before any pixel renders)

6. **Defer the 17 MB normal map on MEDIUM/HIGH** to after first render (currently a blocking
   await; LOW already skips it). The graceful fallback already exists. — *Effort: S.*

7. **Progressive boot.** Show terrain as soon as DEM + color tiles are ready; stream borders /
   GEBCO / normals after (performance-load.md fix #5). The boot profiler is already wired to
   measure before/after. — *Effort: M. Impact: perceived load time, the #1 bounce reason.*

## NEW — deep-dive zoom regime (2026-07-12, the "XRF question")
The tile stream now speaks Cesium's real grid (EPSG:4326/TMS) and runs a hybrid
ladder: photo-colored point tiles at strategic altitude, SOLID imagery-draped
mesh tiles below y≈9 (z7–z13 configured, 512–1024px imagery). Camera floor
lowered 15 → 2 (~300 km view, 8× deeper than before). **Blocked from true
city-scale zoom by one thing: camera.near = 1.** Lowering near to 0.05 fogs the
world black — the fog/bokeh/tilt-shift passes read depth assuming near=1. The
work item: thread the near-plane through the post-chain depth uniforms (or make
near dynamic by altitude), then drop `controls.minDistance` toward 0.08 and the
z9–z13 mesh bands light up at XRF-class detail. — *Effort: M, focused session.
Everything else is already built and waiting on it.*

## P3 — hygiene (cheap credibility)

8. **Delete orphaned files:** `vesselIcons.js`, `rfEmergencyBeaconManager.js` (both documented
   orphans, no importers). — *Effort: XS.*
9. **`submarineCables.js` is dead code** but listed in CLAUDE.md's module map as if live —
   either wire it in as a layer or pull it from the map. Decide, don't leave the mismatch.
   — *Effort: XS–M depending on the call.*
10. **`layerManager.js` vs real wiring:** the actual layer toggles run through index.html's
    inline script + the main.js switch; `vg1:layerChanged` has no listeners. Fold the doc note
    into CLAUDE.md so the next feature doesn't wire the wrong bus (this bit once already).
    — *Effort: XS (doc fix).*

## Already fixed — don't re-litigate
Camera responsiveness (damping 0.12 + Camera Feel setting), tier-gated tile downloads
(LOW = 32 tiles vs HIGH = 512), GEBCO+normals skipped on LOW, GEBCO projection seam
(the "black gap" a reviewer caught), FPS cap.
