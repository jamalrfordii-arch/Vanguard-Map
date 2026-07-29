// tileLandMask.js — O(1) "does this tile need terrain?" lookup (2026-07-25)
//
// WHY THIS EXISTS
// ───────────────
// tileStreamManager used to decide whether to fetch a Cesium QM tile + ArcGIS
// imagery with `_isPureOceanTile`: skip the tile only if all 49 samples of the
// 2048×1024 baked DEM read deeper than −60 m. That is a DEPTH test standing in
// for a LAND test, and it is wrong in BOTH directions:
//
//   Too permissive on shelves. The Sunda Shelf, the North Sea, the Yellow Sea
//   and the Gulf are all shallower than 60 m, so every tile over them passed
//   and got a full QM + imagery fetch for water the base splat cloud and the
//   sea plane already draw. Measured at z10: 69.1% of Sunda tiles fetched,
//   63.4% actually near land; 70.1% vs 53.1% in the North Sea.
//
//   Too strict on islands. A 19 km DEM pixel averages a small island into the
//   deep water around it, so the gate SKIPPED the tiles containing Malta,
//   Bermuda, Guam, Nassau, Key West, Malé, Nauru, Diego Garcia, St Helena,
//   Funafuti, Kiritimati and Palau — 12 of 17 real islands sampled. Those
//   islands were getting no streamed terrain at all.
//
// Both failures are the same mistake: inferring land from depth. So the answer
// is baked offline from a real coastline (GSHHG at ~0.9 km, unioned with GEBCO
// and with the baked DEM the point builder itself reads) and shipped as a
// packed bitset — 341 KB for z3–z10, one bit per tile. See
// tools/build_tile_land_mask.py for the bake, including the ±1 tile dilation
// ring that keeps a margin of water tiles around every coast.
//
// FAILS OPEN. Until the asset loads — and forever, if it is absent — every
// query returns true and the caller falls back to its own heuristic. A missing
// optional asset must never blank the map.
//
// Debug handle: window.vg1TileMask

const MAGIC = 'VG1TMASK';
const ASSET_URL = './data/tile-land-mask.bin';

class TileLandMask {
    constructor() {
        this.ready     = false;
        this.minZoom   = 0;
        this.maxZoom   = 0;
        this.dilation  = 0;
        this._planes   = new Map();   // zoom → Uint8Array bitplane
        this._loading  = null;
        this.stats     = { queries: 0, skipped: 0 };
    }

    /** Load the baked asset. Idempotent; never rejects. */
    async load(url = ASSET_URL) {
        if (this.ready) return true;
        if (this._loading) return this._loading;
        this._loading = (async () => {
            try {
                const res = await fetch(url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                this.ingest(await res.arrayBuffer());
                console.log(`[TileMask] z${this.minZoom}–z${this.maxZoom}, `
                          + `${this.dilation} ring(s), ${(this._bytes / 1024).toFixed(0)} KB`);
                return true;
            } catch (err) {
                console.warn(`[TileMask] not loaded (${err.message}) — `
                           + 'tile culling falls back to the DEM heuristic');
                return false;
            } finally {
                this._loading = null;
            }
        })();
        return this._loading;
    }

    /** Parse the packed asset. Separated from load() so tests can feed bytes. */
    ingest(arrayBuffer) {
        const bytes = new Uint8Array(arrayBuffer);
        const dv    = new DataView(arrayBuffer);
        for (let i = 0; i < 8; i++) {
            if (bytes[i] !== MAGIC.charCodeAt(i)) throw new Error('bad magic');
        }
        const version = dv.getUint32(8, true);
        if (version !== 1) throw new Error(`unsupported version ${version}`);
        this.minZoom  = dv.getUint32(12, true);
        this.maxZoom  = dv.getUint32(16, true);
        this.dilation = dv.getUint32(20, true);
        const n = this.maxZoom - this.minZoom + 1;
        this._planes.clear();
        for (let i = 0; i < n; i++) {
            const off = dv.getUint32(28 + i * 8, true);
            const len = dv.getUint32(32 + i * 8, true);
            const zoom = this.minZoom + i;
            const expect = ((2 ** (zoom + 1)) * (2 ** zoom)) / 8;
            if (len !== expect) throw new Error(`z${zoom} plane is ${len} B, expected ${expect}`);
            this._planes.set(zoom, bytes.subarray(off, off + len));
        }
        this._bytes = bytes.length;
        this.ready  = true;
        return this;
    }

    /**
     * Should this tile be fetched?
     *
     * true  = the tile holds land, or sits within the dilation ring of a tile
     *         that does. Fetch it.
     * false = water only, all the way to the ring. The base splat cloud and the
     *         sea plane already render it; a QM + imagery fetch would return
     *         data that the builder's ocean trims throw away.
     *
     * Zooms finer than the baked maximum resolve against their ancestor tile,
     * which is conservative (a parent is kept whenever ANY of its children is),
     * so z11/z12 work without baking a 4 MB plane for levels that are currently
     * commented out in the LEVELS table.
     */
    shouldFetch(zoom, tx, ty) {
        if (!this.ready) return true;                       // fail open
        this.stats.queries++;
        let z = zoom, x = tx, y = ty;
        while (z > this.maxZoom) { z--; x >>= 1; y >>= 1; }
        if (z < this.minZoom) return true;                  // coarser than baked
        const plane = this._planes.get(z);
        if (!plane) return true;
        const tpx = 2 ** (z + 1);
        const tpy = 2 ** z;
        x = ((x % tpx) + tpx) % tpx;                        // longitude wraps
        if (y < 0 || y >= tpy) return true;                 // off-grid — let the caller decide
        const bit = y * tpx + x;
        const hit = (plane[bit >> 3] >> (bit & 7)) & 1;
        if (!hit) this.stats.skipped++;
        return hit === 1;
    }

    /** Inverse of shouldFetch, for call sites that read better in the negative. */
    isWaterOnly(zoom, tx, ty) { return this.ready && !this.shouldFetch(zoom, tx, ty); }

    /** Fraction of tiles kept at a zoom — a cheap sanity read from DevTools. */
    fetchFraction(zoom) {
        const plane = this._planes.get(zoom);
        if (!plane) return null;
        let bits = 0;
        for (let i = 0; i < plane.length; i++) {
            let b = plane[i];
            while (b) { bits += b & 1; b >>= 1; }
        }
        return bits / (plane.length * 8);
    }
}

export const tileLandMask = new TileLandMask();

if (typeof window !== 'undefined') window.vg1TileMask = tileLandMask;
