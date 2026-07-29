// tools/cacheWarmthHarness.js — measure whether a revisit is actually served
// from the built-geometry cache.
//
// Paste into DevTools, or import it. Runs entirely in the page because it needs
// the live tile pipeline and IndexedDB; the pure parts (keying, eviction) are
// unit-tested in tests/tileGeometryCache.test.mjs.
//
// WHAT IT MEASURES, and why the obvious version is wrong:
// Attributing a cache hit to a build call by diffing stats.hits around it does
// NOT work — builds are async and interleave, so another tile's hit lands inside
// your window. A first attempt at this reported a 55% "cacheable hit rate" while
// the cache's own counters said 11%. The counters inside the cache are the only
// honest source, so this harness reads deltas on those and never tries to
// attribute per call.
//
// It also counts BUILD CALLS PER TILE, which is the thing that actually caps the
// hit rate: measured 1,361 builds for ~317 tiles (4.3x) on one visit. Every
// redundant build is a lookup that can miss, so a cache cannot reach 100% while
// the pipeline rebuilds the same tile repeatedly.
//
//   await vg1CacheWarmth({ lon: -75.5, lat: 39.0, alt: 0.6, settleMs: 40000 })

export async function cacheWarmth({
    lon = -75.5, lat = 39.0, alt = 0.6, settleMs = 40000, awayMs = 10000,
} = {}) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Only count time the tab is actually rendering — a hidden tab pauses rAF and
    // the tile pipeline stops, which silently turns a 40s settle into nothing.
    const settle = async (ms) => {
        let v = 0;
        while (v < ms) { await sleep(1000); if (document.visibilityState === 'visible') v += 1000; }
    };

    const gc = window.vg1GeoCache;
    const ts = window.tileStream;
    const cam = window.camera, ctl = window.controls;
    if (!gc || !ts) return { error: 'tileStream or vg1GeoCache missing' };

    const X = lon * (300 / 360);
    const lr = lat * Math.PI / 180;
    const Z = -Math.log(Math.tan(Math.PI / 4 + lr / 2)) * (300 / (2 * Math.PI));

    const snapshot = () => ({ hits: gc.stats.hits, misses: gc.stats.misses,
                              puts: gc.stats.puts, evicted: gc.stats.evicted });
    const delta = (a, b) => ({
        hits: b.hits - a.hits, misses: b.misses - a.misses,
        puts: b.puts - a.puts, evicted: b.evicted - a.evicted,
        hitRate: (b.hits - a.hits + b.misses - a.misses) > 0
            ? +(100 * (b.hits - a.hits) / (b.hits - a.hits + b.misses - a.misses)).toFixed(1) : null,
    });

    const tilesNow = () => {
        let tiles = 0, visible = 0, withImagery = 0;
        for (const k of ts._caches) {
            if (!(k._targetOpac > 0.001)) continue;
            for (const [, e] of k._tiles) {
                tiles++;
                if (e.mesh?.visible) visible++;
                if (e.imagery) withImagery++;
            }
        }
        return { tiles, visible, withImagery };
    };

    const visit = async (label) => {
        const a = snapshot();
        ctl.target.set(X, 0, Z);
        cam.position.set(X, ctl.target.y + alt, Z + alt * 0.4);
        await settle(settleMs);
        return { label, ...delta(a, snapshot()), ...tilesNow() };
    };
    const flyAway = async () => {
        ctl.target.set(0, 0, 0); cam.position.set(0, 200, 0);
        await settle(awayMs);
    };

    await gc.clear();
    gc.stats.hits = gc.stats.misses = gc.stats.puts = gc.stats.evicted = 0;
    gc.stats.bytes = 0;

    await flyAway();
    const cold = await visit('COLD (cache cleared)');
    await flyAway();
    const warm = await visit('WARM (same ground)');
    await flyAway();
    const warm2 = await visit('WARM again');

    const buildsPerTile = cold.tiles ? +((cold.hits + cold.misses) / cold.tiles).toFixed(2) : null;
    return {
        cold, warm, warm2,
        buildsPerTile,
        // The headline. A revisit should be served almost entirely from cache; if
        // it is not, the cause is nearly always redundant rebuilds rather than the
        // cache failing to store.
        verdict: warm.hitRate >= 90 ? 'PASS — revisit served from cache'
               : warm.hitRate >= 60 ? `PARTIAL — ${warm.hitRate}% (redundant rebuilds cap this)`
               : `FAIL — ${warm.hitRate}% of lookups hit`,
        note: buildsPerTile > 2.5
            ? `${buildsPerTile} builds per tile — every redundant build is a lookup that can miss`
            : 'build count per tile looks sane',
    };
}

if (typeof window !== 'undefined') window.vg1CacheWarmth = cacheWarmth;
