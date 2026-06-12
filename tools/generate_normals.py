#!/usr/bin/env python3
"""
Vanguard1 — Terrain Normal Map Generator
=========================================
Downloads zoom-4 Terrarium DEM tiles (16 × 16 = 256 tiles), stitches them
into a 4 096 × 4 096 elevation grid, and bakes a tangent-space normal map
that Three.js MeshStandardMaterial.normalMap can consume directly.

The result is 4× higher resolution than the runtime DEM sample grid, giving
mountain ridgelines, valley walls, and coastal cliffs a visibly sharper lit
profile without touching vertex counts.

Usage
-----
    cd Vanguard1/tools
    python3 -m pip install -r requirements.txt
    python3 generate_normals.py

    (On some systems: pip3 install -r requirements.txt  then  python3 generate_normals.py)
    (If python3 is missing: brew install python  — then retry)

Output
------
    Vanguard1/terrain_normals.png  (~14-18 MB, 4096×4096 RGB PNG)

After the file exists, reload Vanguard1 in the browser — it is loaded
automatically at startup and applied to both the continent mesh and the
per-city terrain patches.

Tuning
------
ELEV_SCALE   Vertical exaggeration multiplier (default 5.0).
             Raise to 8-12 for dramatic alpine relief; lower to 2-3 for
             gentler, more photographic normals.
ZOOM         Tile zoom level (default 4 = 4096px).  Raise to 5 for 8192px
             but expect ~1 024 tile downloads and a larger output file.
"""

import io
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import convolve, gaussian_filter

# ── Configuration ─────────────────────────────────────────────────────────────
ZOOM        = 4               # Tile zoom level (4 → 16×16 grid → 4096×4096 px)
TILE_PX     = 256             # Pixels per tile edge (Terrarium standard)
ELEV_SCALE  = 7.0             # Vertical exaggeration (raised 5→7 for more punch)
MAP_WIDTH   = 300.0           # Must match MAP_WIDTH in config.js

# ── High-frequency sharpening ──────────────────────────────────────────────────
# Unsharp mask applied to the elevation grid before Sobel normal computation.
# Enhances ridgelines, gullies, canyon walls, and rocky cliff texture without
# requiring higher-zoom tile downloads.
#
# SHARPEN_SIGMA    Gaussian blur radius (px) used for the detail extraction pass.
#                  Lower = sharper fine detail; higher = broader feature enhancement.
#                  Good range: 1.5 (very fine) – 4.0 (ridge-scale).
# SHARPEN_STRENGTH Multiplier for the high-frequency layer added back in.
#                  0 = off, 1.0 = 100% boost, 1.5 = 150% boost.
#                  Values above 2.0 can create ringing artifacts on flat plains.
SHARPEN_SIGMA    = 2.0        # px — detail extraction blur radius
SHARPEN_STRENGTH = 1.4        # HF boost multiplier

TILE_URL   = (
    "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
)
OUT_PATH   = Path(__file__).resolve().parent.parent / "terrain_normals.png"

# ── Tile download ──────────────────────────────────────────────────────────────

def fetch_tile(z, x, y, retries=3):
    """Download one Terrarium tile; return raw PNG bytes or None on failure."""
    url = TILE_URL.format(z=z, x=x, y=y)
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "Vanguard1-NormalMapGen/1.0"}
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                return resp.read()
        except Exception as exc:
            if attempt == retries - 1:
                print(f"\n  !! Tile ({z},{x},{y}) failed after {retries} tries: {exc}",
                      file=sys.stderr)
                return None
            time.sleep(1.5 * (attempt + 1))

# ── Terrarium decode ───────────────────────────────────────────────────────────

def decode_terrarium(rgb):
    """Convert Terrarium-encoded uint8 RGB array (H,W,3) → float32 metres."""
    r = rgb[:, :, 0].astype(np.float32)
    g = rgb[:, :, 1].astype(np.float32)
    b = rgb[:, :, 2].astype(np.float32)
    return r * 256.0 + g + b / 256.0 - 32768.0

# ── Normal-map computation ─────────────────────────────────────────────────────

def elevation_to_normals(elev, h_scale):
    """
    Sobel-filter normal map from a float32 elevation grid.

    h_scale = (scene_vertical_per_metre) / (scene_horizontal_per_pixel)
            = (1/1000) / (MAP_WIDTH / grid_width) * ELEV_SCALE

    Returns float32 RGB array in [0, 1] (tangent-space, packed as n*0.5+0.5).
    R = +X tangent  (east)
    G = +Y (up-normal strength)
    B = +Z tangent  (south, matching Three.js axis convention)
    """
    # 3×3 Sobel kernels — sum of absolute weights = 8
    kx = np.array([[-1,  0,  1],
                   [-2,  0,  2],
                   [-1,  0,  1]], dtype=np.float32)
    kz = np.array([[-1, -2, -1],
                   [ 0,  0,  0],
                   [ 1,  2,  1]], dtype=np.float32)

    dx = convolve(elev, kx) * h_scale / 8.0   # east–west gradient
    dz = convolve(elev, kz) * h_scale / 8.0   # north–south gradient

    # Surface normal in tangent space: (-∂h/∂x,  1,  -∂h/∂z), then normalise
    nx = -dx
    ny = np.ones_like(dx)
    nz = -dz
    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    nx /= length
    ny /= length
    nz /= length

    # Pack to [0, 1]: channel = normal_component * 0.5 + 0.5
    r = (nx * 0.5 + 0.5).clip(0.0, 1.0)
    g = (ny * 0.5 + 0.5).clip(0.0, 1.0)
    b = (nz * 0.5 + 0.5).clip(0.0, 1.0)

    return np.stack([r, g, b], axis=-1)   # (H, W, 3) float32

# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    tiles_x = 2 ** ZOOM    # 16
    tiles_y = 2 ** ZOOM    # 16
    total_w = tiles_x * TILE_PX    # 4096
    total_h = tiles_y * TILE_PX    # 4096
    total   = tiles_x * tiles_y   # 256

    print("Vanguard1 — Terrain Normal Map Generator")
    print(f"  Zoom       : {ZOOM}  ({tiles_x}×{tiles_y} tiles)")
    print(f"  Resolution : {total_w}×{total_h} px")
    print(f"  Elev scale : {ELEV_SCALE}")
    print(f"  Output     : {OUT_PATH}")
    print()

    # ── Download + stitch ──────────────────────────────────────────────────────
    elev_grid = np.zeros((total_h, total_w), dtype=np.float32)

    done = 0
    t0   = time.time()
    for ty in range(tiles_y):
        for tx in range(tiles_x):
            raw  = fetch_tile(ZOOM, tx, ty)
            done += 1
            elapsed = time.time() - t0
            eta = int((elapsed / done) * (total - done)) if done else 0
            pct = done / total * 100
            bar = "█" * int(pct / 4) + "░" * (25 - int(pct / 4))
            print(
                f"\r  [{bar}] {done:3d}/{total}  {pct:4.0f}%  ETA {eta:3d}s   ",
                end="", flush=True,
            )
            if raw is None:
                continue   # leave as 0 m (sea level) on download failure
            img       = Image.open(io.BytesIO(raw)).convert("RGB")
            elev_tile = decode_terrarium(np.array(img, dtype=np.uint8))
            y0, x0    = ty * TILE_PX, tx * TILE_PX
            elev_grid[y0 : y0 + TILE_PX, x0 : x0 + TILE_PX] = elev_tile

    print(f"\n\nStitched elevation grid: min {elev_grid.min():.0f} m  "
          f"max {elev_grid.max():.0f} m")

    # ── High-frequency sharpening pass ────────────────────────────────────────
    # Unsharp mask: subtract a Gaussian-blurred version of the elevation grid
    # and add the difference back at SHARPEN_STRENGTH × weight.
    # This emphasises fine ridges, gullies, cliff faces, and canyon walls so
    # the Sobel filter picks up detail that would otherwise be too subtle.
    # Ocean pixels are excluded so sharpening doesn't bleed into flat sea floor.
    print(f"Sharpening elevation  (σ={SHARPEN_SIGMA}px, ×{SHARPEN_STRENGTH})…")
    land_mask   = elev_grid >= -50.0
    blur        = gaussian_filter(elev_grid, sigma=SHARPEN_SIGMA)
    hf_layer    = elev_grid - blur                         # high-frequency residual
    elev_sharp  = elev_grid.copy()
    elev_sharp[land_mask] = (
        elev_grid[land_mask] + hf_layer[land_mask] * SHARPEN_STRENGTH
    )
    # Clamp to prevent ringing artifacts on very flat areas (deltas, plains)
    elev_sharp  = np.clip(elev_sharp, elev_grid.min(), elev_grid.max())

    # ── Normal map computation ─────────────────────────────────────────────────
    # h_scale maps (elevation metres) → (Three.js scene vertical units) per
    # (Three.js scene horizontal units per pixel).
    # land Y = hM / 700  →  scene_vertical_per_metre = 1/700
    # horizontal: MAP_WIDTH / total_w scene units per pixel
    # base_scale = (1/700) / (MAP_WIDTH/total_w) = total_w / (700 * MAP_WIDTH)
    # NOTE: divisor updated from 1000 → 700 to match continentWorker.js hM/700
    base_scale = total_w / (850.0 * MAP_WIDTH)   # matches continentWorker.js hM/850
    h_scale    = ELEV_SCALE * base_scale
    print(f"Computing normal map  (h_scale = {h_scale:.5f})…")

    normals = elevation_to_normals(elev_sharp, h_scale)

    # Ocean pixels (elev < -50 m) → flat up-normal packed as (0.5, 1.0, 0.5).
    # The continent mesh shader discards these pixels anyway, but this prevents
    # any normal-map bleeding at shoreline borders.
    ocean_mask = elev_grid < -50.0
    normals[ocean_mask, 0] = 0.5
    normals[ocean_mask, 1] = 1.0
    normals[ocean_mask, 2] = 0.5

    # ── Save ───────────────────────────────────────────────────────────────────
    normal_u8 = (normals * 255.0 + 0.5).astype(np.uint8)
    out_img   = Image.fromarray(normal_u8, "RGB")
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    out_img.save(str(OUT_PATH))   # PNG default compression

    mb = OUT_PATH.stat().st_size / (1024 * 1024)
    print(f"Saved → {OUT_PATH}  ({mb:.1f} MB)")
    print()
    print("Next step: reload Vanguard1 in the browser.")
    print("terrain_normals.png is loaded automatically at startup if present.")

if __name__ == "__main__":
    main()
