#!/usr/bin/env python3
"""
tools/bake_from_ply.py — Vanguard1 PLY export → terrain map baking pipeline
═══════════════════════════════════════════════════════════════════════════════

Reads a Vanguard1-exported binary PLY file and rasterizes three replacement
map PNGs into your project folder:

  terrain_dem_baked.png        Terrarium-encoded heightmap
                               Drop-in replacement for the AWS DEM tiles.
                               Sharper coastlines + MeshLab-smoothed ridges.

  terrain_normals_baked.png    Normal map from Poisson-reconstructed normals.
                               Drop-in replacement for terrain_normals.png.
                               Lighting becomes physically accurate at every
                               ridge, valley, and cliff face.

  terrain_radiance_baked.png   Greyscale ridge/curvature map (new texture).
                               Bright at ridges, dark on plains.
                               Wire into the splat shader as an extra glow
                               channel (see instructions at bottom of file).

Usage:
  # From the Vanguard1 project root:
  python tools/bake_from_ply.py ~/Downloads/vanguard1_terrain_1500000.ply

  # Custom output resolution (default 4096×2048):
  python tools/bake_from_ply.py my_cloud.ply --width 8192 --height 4096

  # Output to a specific folder:
  python tools/bake_from_ply.py my_cloud.ply --out-dir ./assets/

Install deps (once):
  pip install numpy Pillow scipy --break-system-packages
  # or: python3 -m pip install -r tools/requirements.txt

═══════════════════════════════════════════════════════════════════════════════
Coordinate system reference
───────────────────────────
  MAP_WIDTH = MAP_HEIGHT = 300 scene units = full Earth

  Position X  : (lon / 180) * 150       range [-150, 150]
  Position Z  : -mercY * (300/(2π))     range ~[-150, 150]
  Position Y  : finalY + curveY
                  finalY  = hMeters / 1000  (land)
                          = hMeters / 600   (ocean)
                  curveY  = -(dist²) × 20
                  dist    = sqrt((x/300)² + (z/300)²)

  UV mapping to PNG pixel (col, row):
    u   = x / 300 + 0.5                 ∈ [0, 1]  (left=west, right=east)
    v   = z / 300 + 0.5                 ∈ [0, 1]  (top=north, bottom=south)
    col = round(u * (W - 1))
    row = round(v * (H - 1))

Terrarium decode (matches terrainBuilder.js exactly):
    hMeters = R * 256 + G + B / 256 - 32768
═══════════════════════════════════════════════════════════════════════════════
"""

import argparse
import struct
import sys
import os
import time
import numpy as np
from pathlib import Path
from PIL import Image

# ── Scene constants — must match config.js ───────────────────────────────────
MAP_WIDTH  = 300.0
MAP_HEIGHT = 300.0
ELEV_SCALE_LAND  = 1000.0   # hMeters = finalY * 1000  (land)
ELEV_SCALE_OCEAN =  600.0   # hMeters = finalY * 600   (ocean)
CURVE_COEFF      =   20.0   # curveY = -(dist²) * 20

# ── Default output ────────────────────────────────────────────────────────────
DEFAULT_W = 4096
DEFAULT_H = 2048


# ─────────────────────────────────────────────────────────────────────────────
# 1. PLY READER
# ─────────────────────────────────────────────────────────────────────────────

def read_ply(path: str) -> dict:
    """
    Parse a binary little-endian PLY with the exact layout written by
    exportPLY.js:
        float32 x, y, z, nx, ny, nz
        uint8   red, green, blue
    Returns dict with numpy arrays: x, y, z, nx, ny, nz, r, g, b
    """
    path = Path(path)
    if not path.exists():
        sys.exit(f"[ERROR] PLY file not found: {path}")

    print(f"[PLY]  Reading {path.name}  ({path.stat().st_size / 1_048_576:.1f} MB)…")

    with open(path, 'rb') as f:
        # ── Parse ASCII header ────────────────────────────────────────────────
        header_lines = []
        while True:
            line = f.readline().decode('ascii', errors='replace').strip()
            header_lines.append(line)
            if line == 'end_header':
                break

        # Extract vertex count
        n_verts = 0
        for line in header_lines:
            if line.startswith('element vertex'):
                n_verts = int(line.split()[-1])
                break
        if n_verts == 0:
            sys.exit("[ERROR] Could not parse vertex count from PLY header.")

        print(f"[PLY]  {n_verts:,} vertices declared in header")

        # ── Verify expected property layout ──────────────────────────────────
        # We expect exactly: x y z nx ny nz red green blue
        # (6 float32 + 3 uint8 = 27 bytes per vertex)
        props = [l for l in header_lines if l.startswith('property')]
        expected = [
            'property float x',   'property float y',   'property float z',
            'property float nx',  'property float ny',  'property float nz',
            'property uchar red', 'property uchar green', 'property uchar blue',
        ]
        if props != expected:
            print("[WARN] PLY properties don't match expected layout — attempting anyway.")
            print(f"       Found:    {props}")
            print(f"       Expected: {expected}")

        # ── Read binary payload ───────────────────────────────────────────────
        # 27 bytes per vertex: 6×float32 + 3×uint8
        BYTES_PER_VERTEX = 6 * 4 + 3
        raw = f.read(n_verts * BYTES_PER_VERTEX)

    actual = len(raw) // BYTES_PER_VERTEX
    if actual < n_verts:
        print(f"[WARN] Expected {n_verts:,} vertices but binary data has {actual:,} — using {actual:,}")
        n_verts = actual

    # Unpack with numpy for speed
    # dtype: 6 little-endian float32, then 3 uint8
    dt = np.dtype([
        ('x',  '<f4'), ('y',  '<f4'), ('z',  '<f4'),
        ('nx', '<f4'), ('ny', '<f4'), ('nz', '<f4'),
        ('r',  'u1'),  ('g',  'u1'),  ('b',  'u1'),
    ])
    data = np.frombuffer(raw[:n_verts * BYTES_PER_VERTEX], dtype=dt)

    print(f"[PLY]  Loaded {n_verts:,} points  ✓")
    return {
        'x':  data['x'].astype(np.float32),
        'y':  data['y'].astype(np.float32),
        'z':  data['z'].astype(np.float32),
        'nx': data['nx'].astype(np.float32),
        'ny': data['ny'].astype(np.float32),
        'nz': data['nz'].astype(np.float32),
        'r':  data['r'].astype(np.float32) / 255.0,
        'g':  data['g'].astype(np.float32) / 255.0,
        'b':  data['b'].astype(np.float32) / 255.0,
    }


# ─────────────────────────────────────────────────────────────────────────────
# 2. COORDINATE HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def scene_to_uv(x: np.ndarray, z: np.ndarray):
    """Scene XZ → UV [0, 1].  Clips to valid range."""
    u = np.clip(x / MAP_WIDTH  + 0.5, 0.0, 1.0)
    v = np.clip(z / MAP_HEIGHT + 0.5, 0.0, 1.0)
    return u, v


def recover_elevation(y: np.ndarray, x: np.ndarray, z: np.ndarray) -> np.ndarray:
    """
    Invert the terrainWorker.js Y formula:
        pos.y = finalY + curveY
        finalY = hMeters / ELEV_SCALE_LAND   (land, finalY >= 0)
               = hMeters / ELEV_SCALE_OCEAN  (ocean, finalY < 0)
        curveY = -(dist²) * CURVE_COEFF

    Returns elevation in metres.
    """
    dist_sq = (x / MAP_WIDTH) ** 2 + (z / MAP_HEIGHT) ** 2
    curve_y = -dist_sq * CURVE_COEFF
    final_y = y - curve_y          # = hMeters / scale
    is_land = final_y >= 0
    elev_m  = np.where(is_land,
                       final_y * ELEV_SCALE_LAND,
                       final_y * ELEV_SCALE_OCEAN)
    return elev_m.astype(np.float32)


# ─────────────────────────────────────────────────────────────────────────────
# 3. RASTERIZER
# ─────────────────────────────────────────────────────────────────────────────

def rasterize_mean(u: np.ndarray, v: np.ndarray,
                   values: np.ndarray, W: int, H: int,
                   n_channels: int = 1) -> tuple:
    """
    Scatter `values` (shape N or N×C) onto a W×H grid using mean accumulation.
    Returns (grid [H×W×C or H×W], mask [H×W bool])
    """
    col = np.round(u * (W - 1)).astype(np.int32)
    row = np.round(v * (H - 1)).astype(np.int32)

    # Clamp to valid range
    col = np.clip(col, 0, W - 1)
    row = np.clip(row, 0, H - 1)

    if n_channels == 1:
        accum = np.zeros((H, W), dtype=np.float64)
        count = np.zeros((H, W), dtype=np.int32)
        np.add.at(accum, (row, col), values)
        np.add.at(count, (row, col), 1)
        mask  = count > 0
        grid  = np.where(mask, accum / np.maximum(count, 1), 0.0).astype(np.float32)
    else:
        accum = np.zeros((H, W, n_channels), dtype=np.float64)
        count = np.zeros((H, W),            dtype=np.int32)
        for c in range(n_channels):
            np.add.at(accum[:, :, c], (row, col), values[:, c])
        np.add.at(count, (row, col), 1)
        mask = count > 0
        grid = np.where(mask[:, :, None],
                        accum / np.maximum(count[:, :, None], 1), 0.0
                       ).astype(np.float32)

    return grid, mask


# ─────────────────────────────────────────────────────────────────────────────
# 4. GAP FILLING
# ─────────────────────────────────────────────────────────────────────────────

def gap_fill(grid: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """
    Fill missing pixels using nearest-neighbour interpolation (scipy EDT).
    Works for both 2D (H×W) and 3D (H×W×C) grids.
    """
    try:
        from scipy.ndimage import distance_transform_edt
    except ImportError:
        sys.exit("[ERROR] scipy not found — run: pip install scipy --break-system-packages")

    # Expand dims for uniform handling
    squeezed = grid.ndim == 2
    if squeezed:
        grid = grid[:, :, np.newaxis]
        mask = mask

    filled = grid.copy()
    gap    = ~mask   # True where we need to fill

    if not gap.any():
        return filled.squeeze() if squeezed else filled

    # EDT gives distance from each gap pixel to nearest filled pixel
    # ind gives the flat index of the nearest filled pixel
    _, ind = distance_transform_edt(gap, return_distances=True, return_indices=True)

    for c in range(filled.shape[2]):
        layer = filled[:, :, c]
        # Vectorized nearest-neighbour fill
        filled[:, :, c] = layer[ind[0], ind[1]]

    return filled.squeeze() if squeezed else filled


# ─────────────────────────────────────────────────────────────────────────────
# 5. MAP BUILDERS
# ─────────────────────────────────────────────────────────────────────────────

def build_dem(elev_m: np.ndarray, u, v, W: int, H: int) -> np.ndarray:
    """
    Rasterize elevation and encode as Terrarium RGB.
    Terrarium decode: R*256 + G + B/256 - 32768
    """
    print(f"  Rasterizing elevation…  (range {elev_m.min():.0f} m → {elev_m.max():.0f} m)")

    grid, mask = rasterize_mean(u, v, elev_m, W, H)
    grid = gap_fill(grid, mask)

    # Optional mild smoothing — removes aliasing without blurring real ridges
    try:
        from scipy.ndimage import uniform_filter
        grid = uniform_filter(grid, size=2)
    except ImportError:
        pass

    # Terrarium encode
    val = np.clip(grid.astype(np.float64) + 32768.0, 0.0, 65535.999)
    R = np.floor(val / 256.0).astype(np.uint8)
    G = np.floor(val % 256.0).astype(np.uint8)
    B = np.floor((val % 1.0) * 256.0).astype(np.uint8)

    img = np.stack([R, G, B], axis=2)
    print(f"  DEM rasterized  ✓")
    return img


def build_normalmap(nx, ny, nz, u, v, W: int, H: int) -> np.ndarray:
    """
    Rasterize Poisson normals and encode as RGB normal map.
    Normal map encoding:  pixel = (n * 0.5 + 0.5) * 255
    Compatible with THREE.js MeshStandardMaterial.normalMap
    """
    print(f"  Rasterizing normals…")

    # Normalise (floating point drift from worker may have denormed some)
    length = np.sqrt(nx**2 + ny**2 + nz**2)
    length = np.maximum(length, 1e-6)
    nx = nx / length
    ny = ny / length
    nz = nz / length

    normals = np.stack([nx, ny, nz], axis=1)
    grid, mask = rasterize_mean(u, v, normals, W, H, n_channels=3)
    grid = gap_fill(grid, mask)

    # Re-normalise after gap fill (weighted average may drift from unit length)
    l = np.sqrt((grid**2).sum(axis=2, keepdims=True))
    grid = grid / np.maximum(l, 1e-6)

    # Encode: pixel = (n * 0.5 + 0.5) * 255
    img = np.clip((grid * 0.5 + 0.5) * 255.0, 0, 255).astype(np.uint8)
    print(f"  Normals rasterized  ✓")
    return img


def build_radiance(dem_img: np.ndarray, normal_img: np.ndarray) -> np.ndarray:
    """
    Compute a ridge / curvature map from the baked DEM + normals.

    Strategy:
      1. Laplacian of the heightmap → highlights ridges and valley rims
         (second derivative: large where terrain changes direction)
      2. Gradient magnitude of the heightmap → highlights all edges and slopes
      3. "Tiltness" from the normal map: 1 - ny  (bright where terrain is steep)
      4. Combine all three, normalize, gamma-lift for the War Room glow look

    Output: 8-bit greyscale PNG.
    Wire into the splat shader as a texture — brighter areas get cyan edge glow.
    """
    print(f"  Computing radiance / curvature map…")
    try:
        from scipy.ndimage import gaussian_filter, laplace
    except ImportError:
        sys.exit("[ERROR] scipy not found — run: pip install scipy --break-system-packages")

    # Decode DEM back to float elevation for derivative operations
    R = dem_img[:, :, 0].astype(np.float64)
    G = dem_img[:, :, 1].astype(np.float64)
    B = dem_img[:, :, 2].astype(np.float64)
    elev = R * 256.0 + G + B / 256.0 - 32768.0   # metres

    # ── Layer 1: Laplacian (ridge crests + valley rims) ───────────────────────
    smoothed = gaussian_filter(elev, sigma=1.2)
    lap      = np.abs(laplace(smoothed))
    lap_norm = lap / (np.percentile(lap, 99.5) + 1e-6)
    lap_norm = np.clip(lap_norm, 0.0, 1.0)

    # ── Layer 2: Gradient magnitude (all topographic edges) ──────────────────
    gy, gx = np.gradient(smoothed)
    grad_mag = np.sqrt(gx**2 + gy**2)
    grad_norm = grad_mag / (np.percentile(grad_mag, 99.5) + 1e-6)
    grad_norm = np.clip(grad_norm, 0.0, 1.0)

    # ── Layer 3: Tiltness from normal map (steep faces) ───────────────────────
    ny_chan = normal_img[:, :, 1].astype(np.float64) / 255.0  # G channel = ny
    ny_world = ny_chan * 2.0 - 1.0                             # decode from [0,1] to [-1,1]
    tiltness = np.clip(1.0 - np.abs(ny_world), 0.0, 1.0)

    # ── Combine: weighted blend favoring Laplacian (sharpest ridges) ─────────
    combined = (lap_norm * 0.50 +
                grad_norm * 0.30 +
                tiltness  * 0.20)

    # ── Gamma lift for the War Room neon glow aesthetic ───────────────────────
    # γ < 1 brightens mid-tones; dim ridges become visible, bright ones pop
    gamma    = 0.55
    combined = np.power(np.clip(combined, 0.0, 1.0), gamma)

    # ── Suppress ocean (below sea level) — ocean glow comes from the shader ──
    ocean_mask = (elev < -20.0).astype(np.float64)
    combined   = combined * (1.0 - ocean_mask * 0.85)  # dim but don't zero out

    img = np.clip(combined * 255.0, 0, 255).astype(np.uint8)
    print(f"  Radiance map computed  ✓")
    return img


# ─────────────────────────────────────────────────────────────────────────────
# 6. MAIN PIPELINE
# ─────────────────────────────────────────────────────────────────────────────

def bake(ply_path: str, out_dir: str, W: int, H: int):
    t0 = time.time()

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # ── Load PLY ──────────────────────────────────────────────────────────────
    pts = read_ply(ply_path)
    x, y, z = pts['x'], pts['y'], pts['z']
    nx, ny, nz = pts['nx'], pts['ny'], pts['nz']

    # ── Coordinate conversion ─────────────────────────────────────────────────
    print(f"\n[BAKE] Converting {len(x):,} points to UV + elevation…")
    u, v     = scene_to_uv(x, z)
    elev_m   = recover_elevation(y, x, z)

    # Stats
    land  = (elev_m >= 0).sum()
    ocean = (elev_m  < 0).sum()
    print(f"       Land: {land:,}  Ocean: {ocean:,}")
    print(f"       Elevation range: {elev_m.min():.0f} m → {elev_m.max():.0f} m")
    print(f"       Output grid: {W}×{H} = {W*H:,} pixels\n")

    # ── Bake DEM ──────────────────────────────────────────────────────────────
    print("[BAKE] 1/3  Heightmap (DEM)…")
    dem_img = build_dem(elev_m, u, v, W, H)
    dem_path = out_dir / 'terrain_dem_baked.png'
    Image.fromarray(dem_img, 'RGB').save(dem_path, optimize=False, compress_level=1)
    print(f"       → {dem_path}  ({dem_path.stat().st_size / 1_048_576:.1f} MB)\n")

    # ── Bake Normal Map ───────────────────────────────────────────────────────
    print("[BAKE] 2/3  Normal map…")
    norm_img = build_normalmap(nx, ny, nz, u, v, W, H)
    norm_path = out_dir / 'terrain_normals_baked.png'
    Image.fromarray(norm_img, 'RGB').save(norm_path, optimize=False, compress_level=1)
    print(f"       → {norm_path}  ({norm_path.stat().st_size / 1_048_576:.1f} MB)\n")

    # ── Bake Radiance Map ─────────────────────────────────────────────────────
    print("[BAKE] 3/3  Radiance / curvature map…")
    rad_img = build_radiance(dem_img, norm_img)
    rad_path = out_dir / 'terrain_radiance_baked.png'
    Image.fromarray(rad_img, 'L').save(rad_path, optimize=False, compress_level=1)
    print(f"       → {rad_path}  ({rad_path.stat().st_size / 1_048_576:.1f} MB)\n")

    elapsed = time.time() - t0
    print("═" * 60)
    print(f"[DONE]  All three maps baked in {elapsed:.1f}s\n")

    print("Next steps:")
    print(f"  1. Copy terrain_dem_baked.png → Vanguard1/ and rename to")
    print(f"     terrain_dem.png  (replaces DEM source for the splat worker)")
    print(f"  2. Copy terrain_normals_baked.png → Vanguard1/ and rename to")
    print(f"     terrain_normals.png  (replaces normal map for lighting)")
    print(f"  3. Copy terrain_radiance_baked.png → Vanguard1/")
    print(f"     Then in dataLoader.js add a radiance texture load alongside")
    print(f"     the DEM, and in terrainBuilder.js sample it as a per-point")
    print(f"     glow multiplier (see shader note below).")
    print()
    print("Shader integration for radiance map (terrainBuilder.js):")
    print("  In createHighFidelityPointCloud(), add a uniform:")
    print("    uRadianceMap: { value: radianceTexture }")
    print("  In the vertex shader, sample the texture at UV coordinates")
    print("  and pass to vRidge to override the Sobel-computed ridge value:")
    print("    vec2 uv = vec2(position.x/300.0+0.5, position.z/300.0+0.5);")
    print("    vRidge = texture2D(uRadianceMap, uv).r;")
    print("  This gives MeshLab-quality ridge glow using your baked map.")
    print("═" * 60)


# ─────────────────────────────────────────────────────────────────────────────
# 7. CLI
# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='Bake Vanguard1 PLY export → terrain_dem / normals / radiance PNGs',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split('═')[0],
    )
    parser.add_argument('ply_path',
        help='Path to the PLY file exported from the Vanguard1 EXPORT PLY button')
    parser.add_argument('--out-dir', default='.',
        help='Output directory for baked PNGs (default: current directory)')
    parser.add_argument('--width',  type=int, default=DEFAULT_W,
        help=f'Output image width in pixels (default: {DEFAULT_W})')
    parser.add_argument('--height', type=int, default=DEFAULT_H,
        help=f'Output image height in pixels (default: {DEFAULT_H})')

    args = parser.parse_args()

    # If output dir is default '.', put files next to the PLY
    out_dir = args.out_dir
    if out_dir == '.':
        out_dir = str(Path(args.ply_path).parent)

    print()
    print("═" * 60)
    print("  Vanguard1 PLY → Terrain Map Baking Pipeline")
    print("═" * 60)
    print(f"  Input : {args.ply_path}")
    print(f"  Output: {out_dir}")
    print(f"  Grid  : {args.width} × {args.height}")
    print("═" * 60)
    print()

    bake(args.ply_path, out_dir, args.width, args.height)


if __name__ == '__main__':
    main()
