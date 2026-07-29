// tilePointsPool.js — a small worker pool for tile point generation.
//
// WHY (2026-07-24): building one tile's points is ~40ms (~20ms since ACTIVE_PTS_CAP
// was halved) of synchronous number-crunching. A close-in view needs ~250 tiles, so
// that is 5-10 SECONDS of CPU. On the main thread it was rationed to
// BUILD_BUDGET_MS (6ms) per frame — which is why a close view took ten seconds to
// fill AND stuttered the whole time. In workers it runs flat out, in parallel,
// and the frame loop never sees it.
//
// Replaces the main-thread _queueBuild for point building specifically, and keeps
// the two behaviours that path had and that callers depend on:
//   • PRIORITY — nearest tile to the load anchor builds first (lower = sooner).
//   • EVICTION — when the backlog is full, the WORST-priority job is dropped and
//     resolved with `null`, exactly what _queueBuild did. Callers already handle
//     null as "aged out, nothing to register" (see the `if (built === null)`
//     guards in tileStreamManager). A fast camera sweep must not build a queue of
//     tiles for ground nobody is looking at any more.
//
// Falls back to synchronous in-process building if Workers are unavailable, so
// there is no second code path to maintain for that case — same module, same
// results, just on the wrong thread.

import { buildTilePoints } from './tilePointsBuilder.js';

// 3 → 7 (2026-07-25). The old value was chosen when the pool's job was to hide a
// ~2.5ms build behind a ~1.5s fetch — the fetch was the constraint and 3 workers
// "saturated the fetch pipeline". That is no longer the shape of the problem.
//
// MEASURED at NYC z12, instrumenting the live pipeline:
//     986 SECONDS of build work through 3 workers in one session
//     z10 320ms/build   z11 694ms/build   z12 1339ms/build
//     build p50 79ms when the queue is empty, p90 3265ms when it is not
// That p50/p90 spread is the proof: the cost is QUEUEING, not compute. Builds got
// ~13x more expensive as the ladder deepened (more points per tile, and
// ACTIVE_PTS_CAP went 14000 → 40000 for sampling quality), so the pool became the
// bottleneck the fetch used to be.
//
// Still leaves headroom: min(7, cores-1) is 7 on a 12-core machine, so 5 cores
// remain for the main thread and everything else. Workers are idle whenever the
// camera is still, so the cost of extra ones is memory (each holds a module copy),
// not steady-state CPU.
const POOL_SIZE = Math.max(1, Math.min(7, (navigator?.hardwareConcurrency || 4) - 1));
// Generous next to any single level's loadRadius grid, small enough that a thrashing
// camera cannot grow an unbounded backlog of stale work.
const MAX_QUEUE = 240;

class TilePointsPool {
    constructor() {
        this._workers = [];
        this._idle    = [];
        this._queue   = [];          // { priority, msg, resolve }
        this._jobs    = new Map();   // id → { resolve, worker }
        this._nextId  = 1;
        this._failed  = false;

        try {
            for (let i = 0; i < POOL_SIZE; i++) {
                const w = new Worker(new URL('./tilePointsWorker.js', import.meta.url), { type: 'module' });
                w.onmessage = (e) => this._onDone(w, e.data);
                w.onerror   = (err) => {
                    // A worker-level error has no job id, so settle whatever this
                    // worker was doing rather than leaking a pending promise.
                    console.warn('[TilePool] worker error:', err?.message ?? err);
                    this._settleWorker(w, null);
                };
                this._workers.push(w);
                this._idle.push(w);
            }
            console.info(`[TilePool] ${this._workers.length} worker(s) ready`);
        } catch (err) {
            // Blocked by CSP, file://, or an old browser. Not fatal.
            console.warn('[TilePool] Workers unavailable, building on main thread:', err?.message ?? err);
            this._failed = true;
        }
    }

    get available() { return !this._failed && this._workers.length > 0; }

    /**
     * @returns {Promise<{positions,colors,count}|null>} null if evicted for space.
     */
    build(cfg, tx, ty, qmData, imgData, priority = 0, landMask = null, imgRect = null) {
        if (!this.available) {
            // Synchronous fallback — same function the workers call.
            try { return Promise.resolve(buildTilePoints(cfg, tx, ty, qmData, imgData, landMask, imgRect)); }
            catch (err) { return Promise.reject(err); }
        }
        return new Promise((resolve) => {
            const id  = this._nextId++;
            // NOTE: qmData and imgData are CLONED, not transferred. qmData is reused
            // by the caller for the imagery rebuild pass, and transferring would
            // neuter it on the main thread — the second build would then see an
            // empty buffer and silently produce a blank tile.
            const msg = { id, cfg, tx, ty, qmData, imgData, landMask, imgRect };
            if (this._queue.length >= MAX_QUEUE) {
                let wi = 0;
                for (let i = 1; i < this._queue.length; i++)
                    if (this._queue[i].priority > this._queue[wi].priority) wi = i;
                if (this._queue[wi].priority > priority) {
                    this._queue.splice(wi, 1)[0].resolve(null);   // drop the worst
                } else {
                    resolve(null); return;                        // this one IS the worst
                }
            }
            this._queue.push({ priority, msg, resolve });
            this._pump();
        });
    }

    _pump() {
        while (this._idle.length && this._queue.length) {
            let bi = 0;
            for (let i = 1; i < this._queue.length; i++)
                if (this._queue[i].priority < this._queue[bi].priority) bi = i;
            const job = this._queue.splice(bi, 1)[0];
            const w   = this._idle.pop();
            this._jobs.set(job.msg.id, { resolve: job.resolve, worker: w });
            w.postMessage(job.msg);
        }
    }

    _onDone(worker, data) {
        const entry = this._jobs.get(data.id);
        this._jobs.delete(data.id);
        this._idle.push(worker);
        if (entry) {
            if (data.error) { console.warn('[TilePool] build failed:', data.error); entry.resolve(null); }
            else entry.resolve({ positions: data.positions, colors: data.colors, count: data.count });
        }
        this._pump();
    }

    _settleWorker(worker, value) {
        for (const [id, entry] of this._jobs) {
            if (entry.worker === worker) { entry.resolve(value); this._jobs.delete(id); }
        }
        if (!this._idle.includes(worker)) this._idle.push(worker);
        this._pump();
    }

    stats() {
        return { workers: this._workers.length, idle: this._idle.length,
                 queued: this._queue.length, inFlight: this._jobs.size,
                 available: this.available };
    }
}

export const tilePointsPool = new TilePointsPool();
if (typeof window !== 'undefined') window.vg1TilePool = tilePointsPool;
