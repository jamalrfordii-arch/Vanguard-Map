// sw.js — VANGUARD1 service worker.
//
// Two jobs:
//  1) CODE (same-origin .js/.mjs/.html/.json): network-first, cache as offline
//     fallback. Kills the stale-ES-module-cache problem so updates apply on the
//     next reload while still working offline.
//  2) TERRAIN TILES (Cesium quantized-mesh DEM + ArcGIS imagery): cache-FIRST,
//     persistent, size-capped. Tiles are effectively immutable (a z/x/y tile's
//     geometry/imagery doesn't change), so once fetched they're served from disk
//     on every later dive/revisit — instant, no network. This is the "load
//     faster" layer of the continent-detail stack (2026-07-15).
//
// Note: Cesium tile requests carry a short-lived Authorization header, but the
// tile DATA is token-independent, so we match by URL (ignoreVary) and reuse the
// cached body regardless of which session token requested it.

const CODE_CACHE = 'vg1-code-v1';
// v1 → v2 (2026-07-15): the old tile cache held truncated Cesium .terrain tiles
// (partial 200s) that corrupted the QM parser ("Offset outside DataView"). The
// activate handler drops v1 on next load, wiping them; .terrain is no longer
// cached at all (see fetch handler), so it can't recur.
const TILE_CACHE = 'vg1-tiles-v2';
const CODE_RE    = /\.(js|mjs|html|json)$/;

// Hosts whose GET responses are cacheable terrain tiles.
// Includes the base-map tile hosts (AWS Terrarium DEM + EOX Sentinel-2 cloudless)
// so the open global floor caches after first boot → instant on every reload.
const TILE_HOSTS = /(^|\.)(assets\.ion\.cesium\.com|server\.arcgisonline\.com|tiles\.maps\.eox\.at|s3\.amazonaws\.com)$/i;
// Soft cap on cached tile entries; oldest are trimmed FIFO once exceeded.
// ~4000 tiles ≈ a few hundred MB of terrain+imagery — plenty for many sessions.
const TILE_MAX = 4000;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
    // Drop any stale cache versions, keep the current two.
    const keep = new Set([CODE_CACHE, TILE_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.filter(n => !keep.has(n)).map(n => caches.delete(n)));
    await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') return;
    const url = new URL(e.request.url);

    // ── Terrain tiles: cache-first, persistent ────────────────────────────────
    if (TILE_HOSTS.test(url.hostname)) {
        // EXCEPTION: Cesium quantized-mesh (.terrain) is truncation-sensitive
        // binary — a partial cached copy corrupts the QM parser. Never cache it
        // (it re-fetches fast via the priority queue anyway). Everything else on
        // these hosts — satellite imagery + the base DEM/colour tiles, where the
        // real load-time win is — stays cache-first.
        if (url.pathname.endsWith('.terrain')) return;   // network-only
        e.respondWith(cacheFirstTile(e.request));
        return;
    }

    // ── Same-origin code: network-first ───────────────────────────────────────
    const isSameOriginCode = url.origin === self.location.origin
        && (CODE_RE.test(url.pathname) || url.pathname.endsWith('/'));
    if (!isSameOriginCode) return; // everything else (websocket/API) passes through

    e.respondWith(
        fetch(e.request)
            .then((res) => {
                if (res.ok) {
                    const copy = res.clone();
                    caches.open(CODE_CACHE).then((c) => c.put(e.request, copy));
                }
                return res;
            })
            .catch(() => caches.match(e.request))
    );
});

// Serve a tile from cache if present; otherwise fetch, store, and return it.
async function cacheFirstTile(req) {
    const cache = await caches.open(TILE_CACHE);
    const hit = await cache.match(req, { ignoreVary: true });
    if (hit) return hit;
    let res;
    try {
        res = await fetch(req);
    } catch (_) {
        // offline / network error — last-ditch cache match, else propagate failure
        const fallback = await cache.match(req, { ignoreVary: true });
        return fallback || Response.error();
    }
    if (res && res.ok) {
        // Store a clone; trim asynchronously so we don't block the response.
        cache.put(req, res.clone()).then(() => trimTileCache(cache)).catch(() => {});
    }
    return res;
}

// FIFO trim: Cache API keys() returns entries in insertion order, so the first
// N are the oldest. Keeps storage bounded without tracking access times.
async function trimTileCache(cache) {
    const keys = await cache.keys();
    const excess = keys.length - TILE_MAX;
    if (excess > 0) {
        for (let i = 0; i < excess; i++) cache.delete(keys[i]);
    }
}
