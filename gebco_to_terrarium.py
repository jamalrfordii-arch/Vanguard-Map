"""
gebco_to_terrarium.py
---------------------
Converts GEBCO_2026 GeoTIFF tiles into a Terrarium-format PNG heightmap
compatible with Vanguard's getTrueElevation() decoder.

Terrarium encoding:
    elevation (meters) = (R * 256 + G + B/256) - 32768

Usage:
    1. Install dependencies:
           pip install rasterio numpy Pillow
    2. Point GEBCO_ZIP or GEBCO_DIR at your downloaded files (see config below)
    3. Run:
           python gebco_to_terrarium.py
    4. Output: gebco_terrarium.png  (place next to your other assets)

Requirements: Python 3.8+, rasterio, numpy, Pillow
"""

import os
import sys
import zipfile
import tempfile
import numpy as np
from pathlib import Path
from PIL import Image

# ── CONFIG ──────────────────────────────────────────────────────────────────

# Path to the downloaded zip file (change if you extracted it manually)
GEBCO_ZIP = r"C:\Users\jamal\Desktop\Vanguard1\gebco_2026_geotiff.zip"

# If you already extracted the zip, set GEBCO_DIR to the folder containing the .tif files
# and set GEBCO_ZIP = None
GEBCO_DIR = None  # e.g. r"C:\Users\jamal\Downloads\gebco_2026_geotiff"

# Output PNG path
OUTPUT_PATH = r"C:\Users\jamal\Desktop\Vanguard1\gebco_terrarium.png"

# Output resolution — 8192×4096 gives ~2.6 arc-min/pixel (~5 km), well above
# the current Terrarium zoom-4 resolution (~9.8 km). Increase to 16384×8192
# for maximum GEBCO detail (larger file, slower load).
OUT_WIDTH  = 8192
OUT_HEIGHT = 4096

# ── MAIN ────────────────────────────────────────────────────────────────────

def main():
    try:
        import rasterio
        from rasterio.enums import Resampling
        from rasterio.transform import from_bounds
        import rasterio.warp
    except ImportError:
        print("ERROR: rasterio not found. Run:  pip install rasterio")
        sys.exit(1)

    # 1. Locate .tif files -------------------------------------------------
    tif_files = []

    if GEBCO_ZIP and os.path.exists(GEBCO_ZIP):
        print(f"Extracting {GEBCO_ZIP} ...")
        tmp_dir = tempfile.mkdtemp(prefix="gebco_")
        with zipfile.ZipFile(GEBCO_ZIP, 'r') as zf:
            for member in zf.namelist():
                if member.lower().endswith('.tif'):
                    zf.extract(member, tmp_dir)
                    tif_files.append(os.path.join(tmp_dir, member))
        print(f"  Extracted {len(tif_files)} tile(s) to {tmp_dir}")
    elif GEBCO_DIR:
        tif_files = sorted(Path(GEBCO_DIR).glob("*.tif"))
        tif_files = [str(p) for p in tif_files]
        print(f"Found {len(tif_files)} tile(s) in {GEBCO_DIR}")
    else:
        print("ERROR: Set GEBCO_ZIP or GEBCO_DIR at the top of this script.")
        sys.exit(1)

    if not tif_files:
        print("ERROR: No .tif files found.")
        sys.exit(1)

    print(f"\nMerging {len(tif_files)} tile(s)...")

    # 2. Read each tile at target resolution and stitch into output array ----
    # Reads each 90x90 degree tile downsampled directly — no huge arrays.
    print(f"Stitching {len(tif_files)} tile(s) into {OUT_WIDTH} x {OUT_HEIGHT} output ...")
    elev_r = np.zeros((OUT_HEIGHT, OUT_WIDTH), dtype=np.float32)

    for i, tif_path in enumerate(tif_files):
        with rasterio.open(tif_path) as ds:
            left, bottom, right, top = ds.bounds

            # Map geographic bounds to output pixel coordinates
            x_start = int(round((left  + 180) / 360 * OUT_WIDTH))
            x_end   = int(round((right + 180) / 360 * OUT_WIDTH))
            y_start = int(round((90 - top)    / 180 * OUT_HEIGHT))
            y_end   = int(round((90 - bottom) / 180 * OUT_HEIGHT))

            tile_w = max(1, x_end - x_start)
            tile_h = max(1, y_end - y_start)

            data = ds.read(1, out_shape=(tile_h, tile_w),
                           resampling=Resampling.average).astype(np.float32)

            elev_r[y_start:y_end, x_start:x_end] = data
            print(f"  Tile {i+1}/{len(tif_files)}: bounds ({left},{bottom},{right},{top}) "
                  f"-> px ({x_start},{y_start}) to ({x_end},{y_end})")

    print(f"  Done: range {elev_r.min():.0f} m to {elev_r.max():.0f} m")

    # 4. Encode as Terrarium RGB -----------------------------------------
    # elevation = (R*256 + G + B/256) - 32768
    # => shifted = elevation + 32768
    # => R = floor(shifted) >> 8
    # => G = floor(shifted) & 0xFF
    # => B = frac(shifted) * 256

    print("\nEncoding as Terrarium RGB ...")
    shifted = elev_r + 32768.0
    shifted = np.clip(shifted, 0, 65535.999)  # guard against out-of-range

    shifted_int  = shifted.astype(np.uint32)
    shifted_frac = shifted - np.floor(shifted)

    R = (shifted_int >> 8).astype(np.uint8)
    G = (shifted_int & 0xFF).astype(np.uint8)
    B = (shifted_frac * 256).astype(np.uint8)

    rgb = np.stack([R, G, B], axis=-1)  # (H, W, 3)

    # 5. Save PNG ----------------------------------------------------------
    print(f"\nSaving to {OUTPUT_PATH} ...")
    out_img = Image.fromarray(rgb, mode='RGB')
    out_img.save(OUTPUT_PATH, format='PNG', optimize=False, compress_level=1)

    size_mb = os.path.getsize(OUTPUT_PATH) / (1024 * 1024)
    print(f"  Done. File size: {size_mb:.1f} MB")

    # 6. Quick sanity check -----------------------------------------------
    print("\nSanity check (decode a few known depths):")
    check_points = [
        ("Mariana Trench (11°N, 142°E)",  (OUT_HEIGHT - int((11/90)*OUT_HEIGHT//2)),  int((142+180)/360 * OUT_WIDTH)),
        ("Dead Sea (31°N, 35°E)",          (OUT_HEIGHT//2 - int((31/90)*OUT_HEIGHT//2)), int((35+180)/360 * OUT_WIDTH)),
        ("Mid-Pacific (0°, -150°)",         OUT_HEIGHT//2,                                int((-150+180)/360 * OUT_WIDTH)),
    ]
    for name, row, col in check_points:
        row = max(0, min(OUT_HEIGHT-1, row))
        col = max(0, min(OUT_WIDTH-1, col))
        r, g, b = rgb[row, col]
        decoded = (int(r)*256 + int(g) + int(b)/256) - 32768
        print(f"  {name}: {decoded:.1f} m")

    print("\n✓ gebco_terrarium.png is ready.")
    print("  Next step: update dataLoader.js to load this file instead of")
    print("  (or alongside) the Terrarium tiles for ocean pixels.")


if __name__ == "__main__":
    main()
