#!/usr/bin/env python3
"""
build_tile_land_mask.py — bake the global "does this tile need terrain?" bitmask.

WHY THIS EXISTS
───────────────
tileStreamManager decides whether to fetch a Cesium QM tile + ArcGIS imagery with
`_isPureOceanTile`, which skips a tile only when all 49 DEM samples read deeper
than −60 m. That is a DEPTH test standing in for a LAND test, and on continental
shelves the two are not the same thing. Measured at z9 against terrain_dem_baked.png:

    region                       fetched now   contain land   pure waste
    Sunda / Indonesia               72.1%         50.6%         21.5%
    North Sea                       72.3%         45.9%         26.4%
    Yellow / East China Sea         70.6%         55.2%         15.4%
    Persian Gulf                    99.8%         84.2%         15.6%
    open Pacific                     0.0%          0.0%          0.0%

The whole Sunda Shelf is shallower than 60 m, so every tile over it passes the
gate and gets a full QM + imagery fetch for water that the base splat cloud and
the Gerstner sea plane already draw correctly. Same story in the North Sea, the
Yellow Sea, the Gulf, the Grand Banks, the Bahamas bank.

Rather than tune the depth constant (which cannot be made right — shelf depth
and land are independent facts), this bakes the real answer offline, once, from
a proper coastline, and hands the runtime an O(1) bit lookup.

SOURCES (union — a tile is kept if ANY source says land)
────────────────────────────────────────────────────────
1. GSHHG coastline via the `global-land-mask` package, 43200×21600 (~0.9 km).
   Authoritative land/water. Catches small islands GEBCO's 2.6 km grid loses
   (Nauru reads −1961 m in GEBCO — a whole country averaged into open ocean)
   and below-sea-level land GEBCO cannot express (Death Valley −81 m, the
   Caspian, the Dead Sea, Qattara, Turfan).
2. gebco_terrarium.png, 8192×4096 equirectangular, elevation ≥ 0.
3. terrain_dem_baked.png, 2048×1024 Mercator, elevation ≥ 0. Coarse, but it is
   the DEM the point builder itself consults, so including it guarantees we
   never cull a tile that the renderer would have painted land into. This is the
   no-regression guard, not a resolution contribution.

GRID
────
Matches tileStreamManager's geographic TMS grid exactly:
    2^(zoom+1) columns × 2^zoom rows, tx=0 at lon −180, ty=0 at lat −90 (SOUTH).
Levels nest exactly (a zoom-N tile is 4 zoom-N+1 tiles), so every level except
the finest is a 2× block-max of the level below — no resampling error.

OUTPUT  data/tile-land-mask.bin
────────────────────────────────
    magic   8 bytes  "VG1TMASK"
    u32     version (2)
    u32     minZoom
    u32     maxZoom
    u32     dilation rings
    u32     flags (reserved, 0)
    then (maxZoom−minZoom+1) × u32 QUADS: fetchOffset, fetchLength, landOffset, landLength
    then the packed bitplanes, LSB-first, bit index = ty * (2^(zoom+1)) + tx.

    FETCH plane: 1 = fetch this tile's terrain/imagery (land ∪ dilation ∪ labelled
    places). The dilation ring is an ERROR MARGIN for fetching — it keeps
    coastline tiles whole when the rasters misregister by a tile.
    LAND plane:  1 = this tile actually CONTAINS land (land ∪ labelled places,
    NO dilation). Added v2 (2026-07-28) because the runtime needs to distinguish
    "fetch it to be safe" from "may paint points here": Cesium's ocean tiles
    decode at the GEOID surface (+11..+20 m near Japan, ABOVE sea level), so
    every dilation-ring water tile passed the builder's elevation guards and
    painted a full budget of water-imagery points over the bathymetry mesh —
    the tile-shaped ocean checkerboard, live-diagnosed 2026-07-28.

USAGE
─────
    pip install -r tools/requirements.txt
    python3 tools/build_tile_land_mask.py
    python3 tools/build_tile_land_mask.py --dilation 0 --max-zoom 12 --report
"""

import argparse
import json
import io
import os
import re
import struct
import sys

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAP_WIDTH = 300.0
MAP_HEIGHT = 300.0
MAGIC = b"VG1TMASK"
VERSION = 2


# ── grid helpers (mirror tilePointsBuilder.js exactly) ────────────────────────
def lat_to_scene_z(lat_deg):
    lr = np.clip(np.deg2rad(lat_deg), -1.48, 1.48)
    my = np.log(np.tan(np.pi / 4.0 + lr / 2.0))
    return -my * (MAP_HEIGHT / (2.0 * np.pi))


def terrarium_elev(path):
    """Decode a Terrarium-encoded PNG to metres."""
    a = np.asarray(Image.open(path).convert("RGB")).astype(np.float32)
    return a[:, :, 0] * 256.0 + a[:, :, 1] + a[:, :, 2] / 256.0 - 32768.0


def bin_edges(n_src, n_dst):
    """Integer start index of each of n_dst equal bins over n_src samples."""
    return np.round(np.arange(n_dst) * (n_src / n_dst)).astype(np.int64)


def any_true_2d(src_bool, dst_rows, dst_cols, row_edges=None, invert=False):
    """Reduce a boolean grid to dst_rows×dst_cols with an ANY (max) reduction.

    Columns are always uniform bins. Rows use `row_edges` when supplied, which is
    how a Mercator-rowed source gets folded onto the linear-latitude tile grid.
    Done in row chunks — the GSHHG mask is 933 MB and this box has 3 GB, so
    `invert` is applied per band rather than by negating the whole array.
    """
    src_rows, src_cols = src_bool.shape
    col_edges = bin_edges(src_cols, dst_cols)
    if row_edges is None:
        row_edges = bin_edges(src_rows, dst_rows)
    out = np.zeros((dst_rows, dst_cols), dtype=bool)
    for r in range(dst_rows):
        r0 = int(row_edges[r])
        r1 = int(row_edges[r + 1]) if r + 1 < len(row_edges) else src_rows
        if r1 <= r0:
            r1 = min(r0 + 1, src_rows)
        if r0 >= src_rows:
            continue
        band = src_bool[r0:r1]
        # ANY over each column bin: reduceat with logical-or semantics via max.
        col_any = (~band).max(axis=0) if invert else band.max(axis=0)
        out[r] = np.maximum.reduceat(col_any, col_edges).astype(bool)
    return out


def dilate_rings(grid, rings):
    """3×3 max-dilate `rings` times. Longitude wraps; latitude clamps."""
    for _ in range(rings):
        acc = grid.copy()
        for dx in (-1, 0, 1):
            rolled = np.roll(grid, dx, axis=1)          # lon wraps at the antimeridian
            acc |= rolled
            up = np.empty_like(rolled)
            up[:-1] = rolled[1:]
            up[-1] = rolled[-1]
            dn = np.empty_like(rolled)
            dn[1:] = rolled[:-1]
            dn[0] = rolled[0]
            acc |= up
            acc |= dn
        grid = acc
    return grid


# ── sources ───────────────────────────────────────────────────────────────────
def land_from_gshhg(tpx, tpy):
    """ANY-land per finest tile from the 43200×21600 GSHHG mask (row 0 = north)."""
    from global_land_mask import globe

    # NOTE: globe._mask is the OCEAN mask — is_land() returns logical_not of it.
    # Reducing it directly gives the inverse of what this function is named for,
    # which on the first bake produced "68.1% land tiles" (i.e. the ocean
    # fraction) and a mask that kept 99.9% of the globe. Hence invert=True.
    mask = globe._mask                      # (21600, 43200) bool, row 0 = +90
    src_rows = mask.shape[0]
    edges = bin_edges(src_rows, tpy)
    north_first = any_true_2d(mask, tpy, tpx, row_edges=edges, invert=True)
    return np.flipud(north_first)            # ty=0 is now the southernmost row


def land_from_labelled_places(tpx, tpy):
    """Force-keep every place the APP ITSELF labels: ports, cities, airports.

    ADDED 2026-07-25, after extending the coverage audit to z11/z12 immediately
    caught Male (Maldives) culled at both. Male is a ~2 km2 island; at the finest
    bake it falls between GSHHG samples and the 1-ring dilation never reaches it.
    Coarser levels hid it because a z10 tile is 19.6 km and catches it by accident.

    The general point: a mask derived only from coastline rasters will always lose
    something smaller than its own sampling, and what it loses is exactly what a
    map most wants to show - small island ports, atoll airports. The app already
    ships authoritative coordinates for these, so treat them as land BY
    CONSTRUCTION instead of hoping the raster resolves them.

    This makes the coverage test's invariant structural: it reads the same files
    the test scrapes, so a port added in a novel location extends both together.
    """
    out = np.zeros((tpy, tpx), dtype=bool)
    pts = []
    for fname in ("portManager.js", "cityManager.js"):
        path = os.path.join(REPO, fname)
        if not os.path.exists(path):
            continue
        src = io.open(path, encoding="utf8").read()
        for m in re.finditer(r"lat:\s*(-?\d+\.?\d*)[^}]{0,200}?lon:\s*(-?\d+\.?\d*)", src):
            pts.append((float(m.group(1)), float(m.group(2))))
        for m in re.finditer(r"lon:\s*(-?\d+\.?\d*)[^}]{0,200}?lat:\s*(-?\d+\.?\d*)", src):
            pts.append((float(m.group(2)), float(m.group(1))))
    apath = os.path.join(REPO, "airports.js")
    if os.path.exists(apath):
        src = io.open(apath, encoding="utf8").read()
        for m in re.finditer(r"'[A-Z]{3}':\s*\[\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*\]", src):
            pts.append((float(m.group(1)), float(m.group(2))))

    d_lon, d_lat = 360.0 / tpx, 180.0 / tpy
    kept = 0
    for lat, lon in pts:
        if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
            continue
        tx = int((lon + 180.0) / d_lon) % tpx
        ty = int((lat + 90.0) / d_lat)
        if 0 <= ty < tpy:
            out[ty, tx] = True
            kept += 1
    print("    %d labelled places forced land" % kept)
    return out


def land_from_gebco(tpx, tpy, sea_level_m):
    path = os.path.join(REPO, "gebco_terrarium.png")
    if not os.path.exists(path):
        print("  ! gebco_terrarium.png missing — skipping this source")
        return np.zeros((tpy, tpx), dtype=bool)
    e = terrarium_elev(path)                 # 8192×4096 equirect, row 0 = north
    north_first = any_true_2d(e >= sea_level_m, tpy, tpx)
    return np.flipud(north_first)


def land_from_baked_dem(tpx, tpy, sea_level_m):
    """The 2048×1024 Mercator DEM the point builder itself reads.

    Rows are Mercator, so the row bins are non-uniform in latitude: convert each
    tile's south/north edge through latToSceneZ, exactly as getTrueElevation does.
    """
    path = os.path.join(REPO, "terrain_dem_baked.png")
    if not os.path.exists(path):
        print("  ! terrain_dem_baked.png missing — skipping this source")
        return np.zeros((tpy, tpx), dtype=bool)
    e = terrarium_elev(path)
    h, w = e.shape
    d_lat = 180.0 / tpy
    lat_edges = np.arange(tpy + 1) * d_lat - 90.0
    z = lat_to_scene_z(lat_edges)                       # north is −z
    v = np.clip(((z / MAP_HEIGHT) + 0.5) * (h - 1), 0, h - 1)
    # v decreases as latitude increases; tile row ty spans v[ty+1]..v[ty].
    land = e >= sea_level_m
    out = np.zeros((tpy, tpx), dtype=bool)
    # Columns: the tile grid may be FINER than the source (2026-07-25). This DEM is
    # 2048 wide; a z12 grid is 8192. reduceat() bins n_src samples into n_dst and
    # only makes sense when n_src >= n_dst — past that it indexes off the end and
    # raises, which is exactly how the z12 bake first failed.
    #
    # The two cases mean different things and must not be conflated:
    #   DOWNSAMPLE (tpx <= w)  many texels per tile → tile is land if ANY is
    #   UPSAMPLE   (tpx >  w)  many tiles per texel → tile takes its texel's value
    # The second is nearest-neighbour, and it is honest about the fact that a
    # 19.6 km DEM cannot resolve a 4.9 km tile — it will mark all ~16 tiles under
    # a coastal texel as land. That is why this source is UNIONED with GEBCO and
    # GSHHG rather than trusted alone at the finest levels.
    upsample = tpx > w
    col_idx  = (np.arange(tpx) * w // tpx) if upsample else None
    col_edges = None if upsample else bin_edges(w, tpx)
    for ty in range(tpy):
        r0 = int(np.floor(v[ty + 1]))
        r1 = int(np.ceil(v[ty])) + 1
        r0 = max(0, min(r0, h - 1))
        r1 = max(r0 + 1, min(r1, h))
        row = land[r0:r1].max(axis=0)
        out[ty] = row[col_idx] if upsample else \
                  np.maximum.reduceat(row, col_edges).astype(bool)
    return out


# ── packing ───────────────────────────────────────────────────────────────────
def pack_bits(grid):
    """Row-major, LSB-first: bit index = ty * tpx + tx."""
    return np.packbits(grid.reshape(-1), bitorder="little").tobytes()


def write_asset(path, fetch_planes, land_planes, min_zoom, max_zoom, dilation):
    """v2: per zoom, TWO planes — fetch (dilated) and land (undilated)."""
    n = max_zoom - min_zoom + 1
    header_len = len(MAGIC) + 4 * 5 + 16 * n     # 4 u32 per zoom in the table
    offset = header_len
    table, blobs = [], []
    for z in range(min_zoom, max_zoom + 1):
        fblob = pack_bits(fetch_planes[z])
        lblob = pack_bits(land_planes[z])
        table.append((offset, len(fblob), offset + len(fblob), len(lblob)))
        blobs.append(fblob)
        blobs.append(lblob)
        offset += len(fblob) + len(lblob)
    with open(path, "wb") as f:
        f.write(MAGIC)
        f.write(struct.pack("<IIIII", VERSION, min_zoom, max_zoom, dilation, 0))
        for foff, fln, loff, lln in table:
            f.write(struct.pack("<IIII", foff, fln, loff, lln))
        for blob in blobs:
            f.write(blob)
    return offset


# ── reporting ─────────────────────────────────────────────────────────────────
REGIONS = {
    "Sunda / Indonesia": (100, 120, -8, 8),
    "North Sea": (-4, 9, 51, 60),
    "Yellow / E. China Sea": (117, 128, 24, 40),
    "Persian Gulf": (48, 57, 24, 30),
    "Bahamas / Florida": (-82, -72, 21, 28),
    "Caribbean": (-85, -60, 9, 23),
    "open Pacific": (-160, -140, -10, 10),
}


def depth_gate_baseline(tpx, tpy, margin_m=-60.0):
    """Reproduce the CURRENT _isPureOceanTile decision so the report has a
    before/after, not just an after."""
    path = os.path.join(REPO, "terrain_dem_baked.png")
    if not os.path.exists(path):
        return None
    e = terrarium_elev(path)
    h, w = e.shape
    d_lat = 180.0 / tpy
    lat_edges = np.arange(tpy + 1) * d_lat - 90.0
    z = lat_to_scene_z(lat_edges)
    v = np.clip(((z / MAP_HEIGHT) + 0.5) * (h - 1), 0, h - 1)
    shallow = e >= margin_m
    out = np.zeros((tpy, tpx), dtype=bool)
    # Same upsample case as land_from_baked_dem — see the note there. This is the
    # report-only baseline, so the crash it caused happened AFTER the asset was
    # written, which is a good way to lose a 15-minute bake to a cosmetic path.
    upsample = tpx > w
    col_idx   = (np.arange(tpx) * w // tpx) if upsample else None
    col_edges = None if upsample else bin_edges(w, tpx)
    for ty in range(tpy):
        r0 = max(0, min(int(np.floor(v[ty + 1])), h - 1))
        r1 = max(r0 + 1, min(int(np.ceil(v[ty])) + 1, h))
        row = shallow[r0:r1].max(axis=0)
        out[ty] = row[col_idx] if upsample else \
                  np.maximum.reduceat(row, col_edges).astype(bool)
    return out


def report(zoom, kept, baseline):
    tpy, tpx = kept.shape
    d_lon, d_lat = 360.0 / tpx, 180.0 / tpy
    print(f"\n  region breakdown at z{zoom} (fetched = tile is loaded):")
    print(f"    {'region':24s} {'tiles':>7s} {'before':>8s} {'after':>8s} {'saved':>8s}")
    for name, (w, e, s, n) in REGIONS.items():
        x0, x1 = int((w + 180) / d_lon), int((e + 180) / d_lon)
        y0, y1 = int((s + 90) / d_lat), int((n + 90) / d_lat)
        sub_a = kept[y0:y1, x0:x1]
        tot = sub_a.size
        after = sub_a.mean()
        before = baseline[y0:y1, x0:x1].mean() if baseline is not None else float("nan")
        saved = (before - after) / before if before else 0.0
        print(f"    {name:24s} {tot:7d} {before:7.1%} {after:7.1%} {saved:7.1%}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--min-zoom", type=int, default=3)
    ap.add_argument("--max-zoom", type=int, default=10)
    ap.add_argument("--dilation", type=int, default=1,
                    help="rings of water tiles kept around land (default 1)")
    ap.add_argument("--sea-level", type=float, default=0.0,
                    help="elevation (m) at or above which a DEM sample counts as land")
    ap.add_argument("--out", default=os.path.join(REPO, "data", "tile-land-mask.bin"))
    ap.add_argument("--report", action="store_true", help="print per-region savings")
    args = ap.parse_args()

    max_z = args.max_zoom
    tpx, tpy = 2 ** (max_z + 1), 2 ** max_z
    print(f"Baking tile land mask z{args.min_zoom}–z{max_z}, dilation {args.dilation} ring(s)")
    print(f"  finest grid: {tpx} × {tpy} tiles")

    print("  · GSHHG coastline (43200×21600) …")
    land = land_from_gshhg(tpx, tpy)
    print(f"    land tiles: {land.sum():,} ({land.mean():.1%})")

    print("  · GEBCO bathymetry/topography (8192×4096) …")
    g = land_from_gebco(tpx, tpy, args.sea_level)
    print(f"    adds {int((g & ~land).sum()):,} tiles")
    land |= g

    print("  · baked DEM the point builder reads (2048×1024) …")
    d = land_from_baked_dem(tpx, tpy, args.sea_level)
    print(f"    adds {int((d & ~land).sum()):,} tiles")
    land |= d

    print("  \u00b7 labelled places from the app's own data \u2026")
    q = land_from_labelled_places(tpx, tpy)
    # Stamp each place with a \u00b11 ring AT THE FINEST LEVEL before the union.
    # A labelled coordinate is a point (an airport on one islet, a city centre
    # 2 km away on the next); without the ring, the v2 LAND plane \u2014 which has
    # no dilation of its own \u2014 protects only the exact tile the label falls in,
    # and the neighbouring tile holding the actual town gets suppressed by the
    # geoid-ocean gate. Mal\u00e9 city vs MLE airport straddle two z12 tiles; the
    # coverage test caught it on the first v2 bake (2026-07-28). ~9 tiles per
    # place is noise in the totals and pure safety for atolls.
    q = dilate_rings(q, 1)
    print(f"    adds {int((q & ~land).sum()):,} tiles (incl. 1-ring stamp)")
    land |= q
    print(f"  union land tiles: {land.sum():,} ({land.mean():.1%})")

    # Build every level from the finest by exact 2× block-max, then dilate each
    # level separately — a "1 tile ring" is a different distance at every zoom.
    # v2 keeps BOTH: the undilated planes ship as the LAND planes (may points be
    # painted here?), the dilated ones as the FETCH planes (should terrain load?).
    planes, undilated = {}, {max_z: land}
    for z in range(max_z - 1, args.min_zoom - 1, -1):
        p = undilated[z + 1]
        undilated[z] = p.reshape(p.shape[0] // 2, 2, p.shape[1] // 2, 2).max(axis=(1, 3))
    for z in range(args.min_zoom, max_z + 1):
        planes[z] = dilate_rings(undilated[z], args.dilation)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    size = write_asset(args.out, planes, undilated, args.min_zoom, max_z, args.dilation)
    print(f"\n  wrote {args.out}  ({size / 1024:.1f} KB)")

    print(f"\n  {'zoom':>5s} {'tiles':>10s} {'fetch':>10s} {'skip':>10s} {'skipped':>8s}")
    for z in range(args.min_zoom, max_z + 1):
        p = planes[z]
        tot, keep = p.size, int(p.sum())
        print(f"  {'z' + str(z):>5s} {tot:10,d} {keep:10,d} {tot - keep:10,d} {1 - keep / tot:7.1%}")

    if args.report:
        base = depth_gate_baseline(tpx, tpy)
        report(max_z, planes[max_z], base)

    meta = {
        "generated_by": "tools/build_tile_land_mask.py",
        "min_zoom": args.min_zoom, "max_zoom": max_z,
        "dilation_rings": args.dilation, "sea_level_m": args.sea_level,
        "sources": ["GSHHG via global-land-mask", "gebco_terrarium.png", "terrain_dem_baked.png"],
        "bytes": size,
        "fetch_fraction": {f"z{z}": round(float(planes[z].mean()), 5)
                           for z in range(args.min_zoom, max_z + 1)},
    }
    with open(args.out + ".json", "w") as f:
        json.dump(meta, f, indent=2)
    print(f"  wrote {args.out}.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
