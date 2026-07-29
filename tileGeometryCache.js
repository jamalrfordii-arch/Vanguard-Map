// tileGeometryCache.js — persist BUILT tile geometry, not the source tiles.
//
// WHY (2026-07-25). The service worker already caches the source bytes from
// Cesium and ArcGIS, and it works: a cached tile request returns in ~4ms versus
// ~1500ms from the network. But that only removes HALF the cost. On a cache hit
// the app still decodes the quantized mesh, samples the imagery, and generates
// 40,000 points — measured at 1339ms per z12 tile, 986 SECONDS of build work for
// one NYC dive. A warm byte cache gives you a fast download and a slow build.
//
// So this caches the OUTPUT instead: the positions and colours that
// buildTilePoints produces. A hit skips the fetch AND the build, which is the
// difference between "revisiting is quicker" and "revisiting is instant".
//
// Cost of that: a built z12 tile is 40,000 × (3 float32 + 3 uint8) ≈ 600 KB,
// roughly 6× the source JPEG. That is exactly why this is a BOUNDED, evicting
// cache of a working set rather than an attempt to hold the planet — the whole
// z12 land surface is 12.2 million tiles, about 1.2 TB.
//
// ── THE THING THAT MAKES THIS DANGEROUS ─────────────────────────────────────
// A geometry cache serves BYTES THAT LOOK FINE. If the key misses any input that
// changed the output, you get silently stale terrain: old heights after a terrain
// mode switch, old point counts after a budget change, old colours after a
// palette edit. Nothing errors, nothing looks obviously broken, and it survives
// reloads — the worst failure shape there is.
//
// Everything that can change the output must therefore be in the fingerprint,
// and SCHEMA_VERSION must be bumped whenever the builder's maths changes.
// tests/tileGeometryCache.test.mjs tries to fool it.

/** Bump when buildTilePoints' OUTPUT changes for identical inputs.
 *  Changing sampling, the palette, procedural relief, or the elevation transform
 *  all qualify. When in doubt, bump: a wasted rebuild costs a second, a stale
 *  cache costs a bug you will not see. */
export const SCHEMA_VERSION = 1;

const DB_NAME  = 'vg1-tile-geometry';
const STORE    = 'tiles';
const META     = 'meta';

/**
 * Everything that affects the bytes buildTilePoints emits, folded into one
 * short string. NOT included: ptSize (material-only, applied after the build)
 * and priority (scheduling only).
 */
export function fingerprint(parts) {
    const {
        schema = SCHEMA_VERSION, zoom, ptsBudget, imgSize, activeCap,
        terrainMode, photoBlend, procEnabled, procRelief, saturation, hasImagery,
    } = parts;
    return [
        's' + schema, 'z' + zoom, 'b' + ptsBudget, 'c' + activeCap, 'i' + imgSize,
        'm' + terrainMode, 'p' + photoBlend, procEnabled ? 'P1' : 'P0',
        'r' + procRelief, 'S' + saturation, hasImagery ? 'I1' : 'I0',
    ].join('');
}

/** Stable per-tile key. Tile identity plus the fingerprint of how it was built. */
export function cacheKey(zoom, tx, ty, fp) {
    return `${zoom}/${tx}/${ty}|${fp}`;
}

/**
 * Which entries to drop to get under `maxBytes`, oldest-access first.
 * Pure so the policy is testable without a database.
 * @param entries [{key, bytes, lastAccess}]
 * @returns {string[]} keys to delete
 */
export function planEviction(entries, maxBytes) {
    let total = 0;
    for (const e of entries) total += e.bytes;
    if (total <= maxBytes) return [];
    // Oldest first. Ties broken by key so the plan is deterministic — a
    // non-deterministic eviction plan makes cache bugs unreproducible.
    const byAge = [...entries].sort(
        (a, b) => (a.lastAccess - b.lastAccess) || (a.key < b.key ? -1 : 1));
    const drop = [];
    for (const e of byAge) {
        if (total <= maxBytes) break;
        drop.push(e.key);
        total -= e.bytes;
    }
    return drop;
}

/** Bytes a built tile occupies: 3 float32 positions + 3 uint8 colours per point. */
export function entryBytes(count) { return count * (3 * 4 + 3 * 1); }

export class TileGeometryCache {
    constructor({ maxBytes = 512 * 1024 * 1024 } = {}) {
        this.maxBytes = maxBytes;
        this._db = null;
        this._open = null;
        this._trimming = false;
        this.stats = { hits: 0, misses: 0, puts: 0, evicted: 0, bytes: 0, errors: 0 };
    }

    get available() { return typeof indexedDB !== 'undefined'; }

    async open() {
        if (this._db) return this._db;
        if (!this.available) return null;
        if (this._open) return this._open;
        this._open = new Promise((resolve) => {
            let req;
            try { req = indexedDB.open(DB_NAME, 1); }
            catch (_) { this.stats.errors++; return resolve(null); }
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    const os = db.createObjectStore(STORE, { keyPath: 'key' });
                    os.createIndex('lastAccess', 'lastAccess');
                }
                if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
            };
            req.onsuccess = () => { this._db = req.result; resolve(this._db); };
            // Private browsing, disabled storage, quota refusal. Not fatal — the
            // caller must degrade to building normally, never to a blank map.
            req.onerror = () => { this.stats.errors++; resolve(null); };
        });
        return this._open;
    }

    async get(key) {
        const db = await this.open();
        if (!db) return null;
        return new Promise((resolve) => {
            let tx;
            try { tx = db.transaction(STORE, 'readwrite'); }
            catch (_) { this.stats.errors++; return resolve(null); }
            const os = tx.objectStore(STORE);
            const req = os.get(key);
            req.onsuccess = () => {
                const rec = req.result;
                if (!rec) { this.stats.misses++; return resolve(null); }
                // VALIDATE. A truncated or half-written record must be treated as
                // a miss, not handed to the GPU — a short position buffer produces
                // a NaN bounding sphere and silently culls the tile.
                const okLen = rec.positions?.byteLength === rec.count * 12
                           && rec.colors?.byteLength === rec.count * 3;
                if (!okLen || !(rec.count > 0)) {
                    this.stats.errors++; this.stats.misses++;
                    try { os.delete(key); } catch (_) {}
                    return resolve(null);
                }
                rec.lastAccess = Date.now();
                try { os.put(rec); } catch (_) {}          // touch for LRU
                this.stats.hits++;
                resolve({
                    positions: new Float32Array(rec.positions),
                    colors:    new Uint8Array(rec.colors),
                    count:     rec.count,
                });
            };
            req.onerror = () => { this.stats.errors++; this.stats.misses++; resolve(null); };
        });
    }

    async put(key, built) {
        const db = await this.open();
        if (!db || !built || !(built.count > 0)) return;
        // Copy: the caller's arrays are subarrays of larger pooled buffers and are
        // reused, so storing them directly would persist whatever lands there next.
        const positions = built.positions.slice(0, built.count * 3).buffer;
        const colors    = built.colors.slice(0, built.count * 3).buffer;
        return new Promise((resolve) => {
            let tx;
            try { tx = db.transaction(STORE, 'readwrite'); }
            catch (_) { this.stats.errors++; return resolve(); }
            try {
                tx.objectStore(STORE).put({
                    key, positions, colors, count: built.count,
                    bytes: entryBytes(built.count), lastAccess: Date.now(),
                });
                this.stats.puts++;
                this.stats.bytes += entryBytes(built.count);
            } catch (_) { this.stats.errors++; }
            tx.oncomplete = () => {
                // PROACTIVE eviction. Measured 2026-07-25: without this the store
                // reached 525MB against a 512MB budget with evicted:0 — trim() was
                // only reachable from the quota-error path, so the planner (tested,
                // correct) was never actually invoked and the cache grew until
                // IndexedDB started refusing writes. A budget nothing enforces is
                // not a budget.
                //
                // Debounced: trim walks every record, so doing it per put during a
                // 400-tile dive would be far worse than the growth it prevents.
                if (this.stats.bytes > this.maxBytes && !this._trimming) {
                    this._trimming = true;
                    this.trim().finally(() => { this._trimming = false; });
                }
                resolve();
            };
            // QuotaExceededError lands here. Trim and carry on; never throw into
            // the tile pipeline.
            tx.onerror = () => { this.stats.errors++; this.trim().then(resolve, resolve); };
        });
    }

    /** Drop least-recently-used entries until under maxBytes. */
    async trim() {
        const db = await this.open();
        if (!db) return 0;
        const entries = await new Promise((resolve) => {
            const out = [];
            let tx;
            try { tx = db.transaction(STORE, 'readonly'); }
            catch (_) { return resolve(out); }
            const cur = tx.objectStore(STORE).openCursor();
            cur.onsuccess = () => {
                const c = cur.result;
                if (!c) return resolve(out);
                out.push({ key: c.value.key, bytes: c.value.bytes || 0,
                           lastAccess: c.value.lastAccess || 0 });
                c.continue();
            };
            cur.onerror = () => resolve(out);
        });
        const drop = planEviction(entries, this.maxBytes);
        if (!drop.length) return 0;
        await new Promise((resolve) => {
            const tx = db.transaction(STORE, 'readwrite');
            const os = tx.objectStore(STORE);
            for (const k of drop) { try { os.delete(k); } catch (_) {} }
            tx.oncomplete = resolve;
            tx.onerror = resolve;
        });
        this.stats.evicted += drop.length;
        // Recompute from what actually remains. stats.bytes is incremented on every
        // put, so without this it only ever grows and the trigger above would fire
        // on every subsequent put forever.
        const dropped = new Set(drop);
        this.stats.bytes = entries.reduce((t, e) => t + (dropped.has(e.key) ? 0 : e.bytes), 0);
        return drop.length;
    }

    async clear() {
        const db = await this.open();
        if (!db) return;
        await new Promise((resolve) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).clear();
            tx.oncomplete = resolve; tx.onerror = resolve;
        });
    }
}
