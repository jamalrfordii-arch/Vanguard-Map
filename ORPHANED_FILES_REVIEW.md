# Orphaned Files — Review Before Deletion

These 10 files are no longer imported anywhere in the codebase (confirmed by Phase 1 cleanup).
None of them run at startup. They sit on disk taking up space but do not affect the app.

Review each entry, then decide: **DELETE** or **KEEP FOR LATER**.

---

## 1. `satelliteManager.js` — 195 lines
**What it does:** Real-time satellite tracking. Fetches Two-Line Element (TLE) data from
Celestrak via a local proxy server (flight-proxy.js), parses it with `satellite.js`, and
propagates each satellite's orbit every frame using the SGP4 model. Fires callbacks so
main.js can place 3D objects at the correct map position.

**Depends on:** A running `flight-proxy.js` server + internet connection to Celestrak.

**Verdict:** This is a fully working, well-engineered feature. If you ever want live
satellite overlays on the map, this is the engine. **Safe to delete now** — it is not
connected to anything running. Keep a Git backup if you might want it back.

---

## 2. `satelliteBuilder.js` — 271 lines
**What it does:** 3D model factory for satellite visuals. Builds six distinct satellite
shapes (ISS, Starlink, GPS, Weather, Military, Generic) out of Three.js geometry. Also
exports the color palette (`SAT_COLORS`, `SAT_HTML_COLORS`) used by satellite labels.

**Depends on:** Three.js only.

**Verdict:** Companion to `satelliteManager.js`. No use without it. **Safe to delete.**

---

## 3. `satArcManager.js` — 281 lines
**What it does:** Draws predicted orbital ground-tracks on the map. Takes the same SGP4
engine as `satelliteManager.js`, propagates an orbit forward 60+ minutes, and renders it
as a glowing cyan arc line with antimeridian wrapping. Can show/hide per-satellite.

**Depends on:** `satellite.js` CDN import + `satelliteManager.js` data.

**Verdict:** Visual overlay that only makes sense once satellites are back. **Safe to delete.**

---

## 4. `instancedSatManager.js` — 231 lines
**What it does:** GPU-instancing layer for satellite rendering. Instead of one draw call
per satellite (which breaks at 400+ Starlinks), this batches all satellites of the same
type into a single `InstancedMesh`. Invisible hit-sphere proxies handle raycasting so
tooltips still work. Falls back to the full 3D model only for the ISS.

**Depends on:** `satelliteBuilder.js` (for color constants).

**Verdict:** Performance optimization for a feature (satellites) that isn't running.
**Safe to delete.**

---

## 5. `gaussianSplatOverlay.js` — 318 lines
**What it does:** Pins real-world 3D Gaussian Splat captures (`.splat` / `.ply` files)
to geographic coordinates. When the camera zooms in close enough, the capture fades in
on top of the terrain — think: a photorealistic port terminal or oil platform scan
anchored to a lat/lon. Uses the `@mkkellogg/gaussian-splats-3d` library.

**Depends on:** External `.splat` files you'd need to source from Luma AI or Polycam.

**Verdict:** Ambitious feature — photorealistic asset overlays. Nothing is connected yet
and no `.splat` files exist in the project. **Safe to delete for now.** Worth revisiting
in a later phase when adding high-fidelity port/terminal assets.

---

## 6. `exportPLY.js` — 278 lines
**What it does:** Exports the live Vanguard1 point cloud as a binary `.ply` file you can
open in MeshLab, Blender, or other 3D tools. Packages XYZ position, surface normals,
and RGB color per vertex. The comments include a full MeshLab workflow for turning the
point cloud into a mesh.

**Depends on:** Nothing — it's a pure utility function.

**Verdict:** Developer tool, not a user feature. Useful for terrain debugging and
mesh reconstruction. **Low risk to keep, but safe to delete** since you can recreate
it later if needed.

---

## 7. `directorManager.js` — 200 lines
**What it does:** Cinematic auto-camera. After 15 seconds of no user interaction, it
picks a random ship from the map and smoothly flies the camera to a dramatic angle,
cutting to a new shot every 12 seconds. Any user input immediately hands control back.
Uses frame-rate-independent exponential damping (not lerp) so it looks smooth at any FPS.

**Depends on:** `aisShips` array (ships are running) + Three.js OrbitControls.

**Verdict:** A nice "attract mode" / screensaver feature. Ships are active so the data
dependency exists. Could be wired back in easily. **Safe to delete for now** — Phase 1
is about cleaning up, not adding features.

---

## 8. `tacticalAssets.js` — 247 lines
**What it does:** Procedurally generates 3D port infrastructure — container cranes,
offshore wind turbines, and oil platforms — and places them at hard-coded geographic
coordinates. Uses `getTrueElevation()` so assets sit correctly on the terrain surface.
Wind turbine rotors animate each frame.

**Depends on:** `terrainBuilder.js` (for elevation lookup) + Three.js.

**Verdict:** This was placeholder content — fake infrastructure at generic locations,
not real operational data. **Safe to delete.** Real port/infrastructure data should come
from a proper data source in a later phase.

---

## 9. `cityManager copy.js` — 231 lines
**What it does:** This is an **old backup copy** of `cityManager.js`. The real
`cityManager.js` is still active and imported by `main.js`. This copy is identical
(or slightly older) and serves no purpose.

**Depends on:** Nothing — it is a duplicate.

**Verdict:** **Delete immediately.** It is a stale backup that could cause confusion.

---

## 10. `continentGPUCompute.js` — 254 lines
**What it does:** Two things: (1) Probes whether the browser supports WebGPU compute
shaders. (2) If WebGPU is available, runs a WGSL compute shader to generate the normal
map on the GPU instead of running `generate_normals.py` locally. The GPU output is
byte-for-byte equivalent to the Python script at ELEV_SCALE=5.

**Depends on:** Browser WebGPU API (Chrome 113+). Falls back gracefully if unsupported.

**Verdict:** Forward-looking feature. Right now you generate normals with the Python
script and bake `terrain_normals.png` manually. This would let the app generate normals
at startup without Python. **Not urgent** — and the current Python bake at ELEV_SCALE=7
produces better normals than this GPU path (it's still on ELEV_SCALE=5). **Safe to
delete for now** — the concept is worth revisiting when you move to cloud hosting.

---

## Summary Table

| File | Lines | What | Verdict |
|---|---|---|---|
| `satelliteManager.js` | 195 | Live satellite tracking (SGP4/TLE) | Safe to delete |
| `satelliteBuilder.js` | 271 | Satellite 3D model factory | Safe to delete |
| `satArcManager.js` | 281 | Orbital ground-track arc lines | Safe to delete |
| `instancedSatManager.js` | 231 | GPU-instanced satellite rendering | Safe to delete |
| `gaussianSplatOverlay.js` | 318 | Photorealistic 3DGS asset overlays | Safe to delete |
| `exportPLY.js` | 278 | Point cloud → .ply export tool | Safe to delete |
| `directorManager.js` | 200 | Cinematic auto-camera screensaver | Safe to delete |
| `tacticalAssets.js` | 247 | Fake port/wind/platform assets | Safe to delete |
| `cityManager copy.js` | 231 | Stale duplicate of cityManager.js | **Delete immediately** |
| `continentGPUCompute.js` | 254 | WebGPU normal map generator | Safe to delete |

**Total lines that would be removed: ~2,510**

None of these files are imported by anything currently running. Deleting them will not
affect the terrain, ocean, ships, borders, UI, or any other active feature.

---

*Reviewed: 2026-05-16 — Vanguard1 Phase 1 cleanup*
