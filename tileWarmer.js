// tileWarmer.js — warm the tile caches in the background, so the places you go
// load instantly instead of building while you watch.
//
// WHY (2026-07-25). Two facts, both measured the same day:
//   • A COLD close-zoom dive ramps in over ~10s (72 tiles visible at 5s) because
//     every tile pays fetch (~1.5s) + build (up to 1339ms at z12) while on screen.
//   • A WARM dive is instant — 231/231 tiles at the first sample — because the
//     geometry cache (tileGeometryCache.js) already holds the built points and a
//     hit skips fetch AND build.
//
// So the machinery for "effortless" already exists and is verified; the only gap
// is that nothing fills the cache BEFORE you arrive. This module does that: when
// the app is idle (camera still, build pool empty), it quietly fetches + builds +
// caches tiles around the places you have visited, at the worst possible queue
// priority so live loading always wins. Warmth persists in IndexedDB across
// reloads, so the map genuinely accumulates familiarity session over session.
//
// This is the third option between "slow patchy first loads" and "offline bake
// step": the same pre-computation as a bake, but performed by the running app in
// its own dead time, with no build pipeline and no separate artifact to manage.
//
// Pure parts (spot store, ring enumeration, idle detector) live here and are
// node-testable; the fetch/build half delegates to the tile cache's warmTile(),
// which reuses the app's own pipeline so a warmed tile is byte-identical to a
// lived-in one.

/** Visited-place store. Deduplicated on a coarse grid so hovering around one
 *  port doesn't fill the list with near-duplicates. LRU-capped. */
export class VisitStore {
    constructor({ maxSpots = 24, gridDeg = 0.25 } = {}) {
        this.maxSpots = maxSpots;
        this.gridDeg  = gridDeg;
        this.spots    = [];              // [{lon, lat, t}]
    }
    keyOf(lon, lat) {
        return Math.round(lon / this.gridDeg) + '|' + Math.round(lat / this.gridDeg);
    }
    record(lon, lat, t = Date.now()) {
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
        const k = this.keyOf(lon, lat);
        const i = this.spots.findIndex(s => this.keyOf(s.lon, s.lat) === k);
        if (i !== -1) {
            // Refresh, don't duplicate — moves it to most-recent.
            const [s] = this.spots.splice(i, 1);
            s.t = t;
            this.spots.push(s);
            return false;
        }
        this.spots.push({ lon, lat, t });
        while (this.spots.length > this.maxSpots) this.spots.shift();
        return true;
    }
    /** Most recent first — recent places are the likeliest to be revisited. */
    ordered() { return [...this.spots].reverse(); }
    toJSON() { return this.spots; }
    static fromJSON(arr, opts) {
        const v = new VisitStore(opts);
        if (Array.isArray(arr)) {
            for (const s of arr) {
                if (s && Number.isFinite(s.lon) && Number.isFinite(s.lat)) {
                    v.spots.push({ lon: s.lon, lat: s.lat, t: s.t || 0 });
                }
            }
            v.spots.sort((a, b) => a.t - b.t);
            while (v.spots.length > v.maxSpots) v.spots.shift();
        }
        return v;
    }
}

/** Tiles in a (2r+1)² ring around lon/lat at `zoom`, CENTRE FIRST — warming is
 *  interruptible, so the most valuable tiles must be attempted earliest. */
export function ringTiles(lon, lat, zoom, r = 2) {
    const dLon = 360 / (2 ** (zoom + 1));
    const dLat = 180 / (2 ** zoom);
    const tx0 = Math.floor((lon + 180) / dLon);
    const ty0 = Math.floor((lat + 90) / dLat);
    const tpx = 2 ** (zoom + 1);
    const tpy = 2 ** zoom;
    const out = [];
    for (let d = 0; d <= r; d++) {                    // ring by ring, centre out
        for (let dy = -d; dy <= d; dy++) {
            for (let dx = -d; dx <= d; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue;
                const ty = ty0 + dy;
                if (ty < 0 || ty >= tpy) continue;    // latitude clamps
                out.push({ zoom, tx: ((tx0 + dx) % tpx + tpx) % tpx, ty });
            }
        }
    }
    return out;
}

/** Idle detector: the camera has to have been STILL for `stillMs`. Movement is
 *  judged on position, not just target, so orbiting counts as activity. */
export class IdleDetector {
    constructor({ stillMs = 4000, moveEps = 0.01 } = {}) {
        this.stillMs = stillMs;
        this.moveEps = moveEps;
        this._last = null;
        this._stillSince = 0;
    }
    tick(x, y, z, now) {
        if (this._last) {
            const dx = x - this._last.x, dy = y - this._last.y, dz = z - this._last.z;
            if (dx * dx + dy * dy + dz * dz > this.moveEps * this.moveEps) {
                this._stillSince = now;               // moved — reset the clock
            }
        } else {
            this._stillSince = now;
        }
        this._last = { x, y, z };
        return (now - this._stillSince) >= this.stillMs;
    }
}

const LS_KEY = 'vg1_warm_spots';

export class TileWarmer {
    /**
     * @param caches   tileStream._caches — each must expose warmTile(tx, ty)
     * @param zooms    which levels to warm (deep ones: that is where cold hurts)
     * @param ringR    ring radius per spot per level
     */
    constructor(caches, { zooms = [11, 12], ringR = 2, intervalMs = 700 } = {}) {
        this._caches = caches;
        this._zooms = zooms;
        this._ringR = ringR;
        this._intervalMs = intervalMs;
        this._idle = new IdleDetector({});
        this._lastRun = 0;
        this._inFlight = false;
        this._queue = [];                 // [{zoom, tx, ty}]
        this._queuedFor = new Set();      // spot keys already expanded
        this.enabled = true;
        this.stats = { warmed: 0, alreadyWarm: 0, skipped: 0, failed: 0, queued: 0,
                       visits: 0, lastResult: null };
        let stored = null;
        try { stored = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (_) {}
        this.visits = VisitStore.fromJSON(stored);
    }

    /** Call when the camera is CLOSE to the ground somewhere — that is a visit. */
    recordVisit(lon, lat) {
        if (this.visits.record(lon, lat)) {
            this.stats.visits++;
            try { localStorage.setItem(LS_KEY, JSON.stringify(this.visits)); } catch (_) {}
            // New place → its ring goes to the FRONT of the queue; the place you
            // are at right now beats every older spot.
            const spotKey = this.visits.keyOf(lon, lat);
            this._queuedFor.add(spotKey);
            const fresh = [];
            for (const z of this._zooms) fresh.push(...ringTiles(lon, lat, z, this._ringR));
            this._queue.unshift(...fresh);
            this.stats.queued = this._queue.length;
        }
    }

    /** Expand not-yet-queued known spots into the queue (oldest last). */
    _refill() {
        for (const s of this.visits.ordered()) {
            const k = this.visits.keyOf(s.lon, s.lat);
            if (this._queuedFor.has(k)) continue;
            this._queuedFor.add(k);
            for (const z of this._zooms) this._queue.push(...ringTiles(s.lon, s.lat, z, this._ringR));
            this.stats.queued = this._queue.length;
            return true;                  // one spot per refill — stay gentle
        }
        return false;
    }

    /**
     * Per-frame. Internally throttled; near-free when there is nothing to do.
     * Warms ONE tile at a time — the point is to use dead time, not to compete
     * with the session that is actually happening.
     */
    async tick(camera, now = performance.now()) {
        if (!this.enabled || this._inFlight) return;
        const idle = this._idle.tick(camera.position.x, camera.position.y, camera.position.z, now);
        if (!idle) return;
        if (now - this._lastRun < this._intervalMs) return;
        // Never compete with live tile work — that would make the visible load
        // SLOWER in exchange for warming ground nobody is looking at.
        const pool = (typeof window !== 'undefined') && window.vg1TilePool?.stats();
        if (pool && (pool.queued > 0 || pool.inFlight > 0)) return;

        if (this._queue.length === 0 && !this._refill()) return;
        const job = this._queue.shift();
        this.stats.queued = this._queue.length;
        const cache = this._caches.find(c => c._cfg.zoom === job.zoom);
        if (!cache || typeof cache.warmTile !== 'function') return;

        this._inFlight = true;
        this._lastRun = now;
        try {
            const r = await cache.warmTile(job.tx, job.ty);
            this.stats.lastResult = `z${job.zoom}/${job.tx}/${job.ty}: ${r}`;
            if (r === 'warmed') this.stats.warmed++;
            else if (r === 'already-warm' || r === 'live') this.stats.alreadyWarm++;
            else if (r === 'failed') this.stats.failed++;
            else this.stats.skipped++;
        } catch (_) {
            this.stats.failed++;
        } finally {
            this._inFlight = false;
        }
    }

    /** Manually queue a place (console / tests): vg1Warmer.warmNow(-74, 40.7) */
    warmNow(lon, lat) {
        this.recordVisit(lon, lat);
        return `queued ${this._queue.length} tiles around ${lon},${lat}`;
    }
}
