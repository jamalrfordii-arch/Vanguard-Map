# 3DGS Capture Sourcing Pipeline (Phase 4)

The photoreal hotspot layer is fed by **Gaussian-splat captures** (`.spz`/`.splat`/`.ksplat`)
pinned to lat/lon. This is the agent-driven pipeline for finding, ingesting, and
placing them. The design principle: **captures are data, not code** — sourcing
appends to `manifest.json`; the app picks it up on reload with zero code changes.

---

## The honest constraint

There is **no API that returns a photoreal 3D capture for an arbitrary port**.
Public 3DGS captures are sparse and rarely geotagged or bulk-downloadable. So this
pipeline is **agent-in-the-loop curation**, not full automation:

- Agents are good at: searching the sources below for a named target, judging
  quality, downloading a candidate, converting format, and registering it.
- Agents cannot: conjure a capture where none exists. Most `targets` in the
  manifest will stay `pending` until someone captures the site (drone/ground pass
  → train a splat) or a public one appears.

Set expectations accordingly: this fills hotspots opportunistically, not the globe.

---

## Manifest schema (`manifest.json`)

```jsonc
{
  "captures": [                 // pinned onto the map when status === "sourced"
    {
      "id": "airmuseum2",
      "name": "Museum of Flight",
      "status": "sourced",      // "sourced" = live | "pending" = not yet found
      "path": "./splats/airmuseum2.spz",
      "lat": 47.518607, "lon": -122.296747,
      "sceneScale": 0.0015,     // metres → scene units (tune to real size)
      "yOffset": 0.15,          // lift above terrain (scene units)
      "rotation": [0,0,0,1],    // quaternion (tune if the capture is tilted)
      "showCamY": 4.0,          // load when camera altitude < this
      "fullCamY": 1.5,          // fully opaque + owns the ground below this
      "showHorizDist": 6.0,     // and within this horizontal distance
      "source": "…", "notes": "…"
    }
  ],
  "targets": [ { "id","name","category","lat","lon","status":"pending" } ]
}
```

---

## Sourcing workflow (per target)

1. **Pick a target** from `manifest.targets` (or a new one the user names).
2. **Search these sources** for the site by name + nearby landmarks:
   - Luma AI captures — https://lumalabs.ai/captures
   - Polycam explore — https://poly.cam/explore
   - Sketchfab (filter: Gaussian Splatting / downloadable)
   - Academic / open sets — INRIA 3DGS, Objaverse, MipNeRF360
3. **Evaluate** a candidate: coverage of the actual site, resolution, artifact
   level, license (must allow download + use), and export format.
4. **REQUIRED output format: `.ksplat`** (or `.ply`). Do NOT ship `.spz`.
   Why: this app is not cross-origin isolated (it depends on many cross-origin
   tile sources that COEP would break), so `SharedArrayBuffer` is unavailable —
   and the splat viewer's `.spz` decode path stalls on the shared-memory workers
   and never loads (verified 2026-07-15). `.ksplat` loads cleanly without it.
   - Generation tools (VGGT / 3DGS trainers) natively emit `.ply` → convert to
     `.ksplat` (the `.ply → .ksplat` step is headless-friendly; `.spz` is not).
   - A legacy `.spz` you can't avoid → one-off browser convert at
     https://superspl.at/editor (upload `.spz` → export `.ksplat`).
   Then place the `.ksplat` in `splats/`.

   **Agent-run conversion (headless, no browser)** — the pipeline's convert step:
   ```bash
   pip install "git+https://github.com/francescofugazzi/3dgsconverter.git" --break-system-packages
   3dgsconverter -i input.spz  -o splats/name.ksplat -f ksplat --force   # SPZ v3/4 supported
   3dgsconverter -i input.ply  -o splats/name.ksplat -f ksplat --force   # generation output
   3dgsconverter -i file --info                                          # inspect bounds/points/format
   ```
   Add `--compression_level 1` for a smaller/faster file. The capture's local
   bounds (from `--info`) set the placement scale: `sceneScale ≈ desiredMetres /
   (localBoundsWidth × 133000)`, since 1 scene unit ≈ 133 km.
5. **Register**: append a `captures` entry with `status: "sourced"`, the real
   `lat`/`lon` (Google Maps right-click), and starting placement values. Move the
   corresponding `targets` entry's status to `"sourced"` (or remove it).
6. **Tune in-place**: reload, dive onto it, and adjust `sceneScale` (size),
   `yOffset` (height), `rotation` (orientation) live via
   `window.gsManager._overlays[i].cfg`, then bake the good values back into the
   manifest.

---

## Invoking it

- Manual, one target: *"Claude, source a 3DGS capture for the Port of Singapore."*
  → the agent runs steps 1–5 and reports what it found (or that nothing usable
  exists yet).
- Batch: point the agent at the `pending` list and have it attempt each, marking
  `sourced` where it succeeds and leaving notes where it can't.
- Scheduled (optional): a recurring task that re-checks `pending` targets for
  newly-published captures.

## Placement quick-reference

`sceneScale` = desiredSpanInSceneUnits ÷ captureSpanInMetres. 1 scene unit ≈ 133 km,
so a 300 m site spanning ~0.3 units → sceneScale ≈ 0.3 / 300 = 0.001.
