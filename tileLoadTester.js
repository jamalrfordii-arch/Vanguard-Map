// tileLoadTester.js — Automated tile-load regression tester.
//
// Built 2026-07-21 after a user-supplied video (test.mp4) showed a single
// tile stuck on its palette+procedural-noise fallback for 15+ seconds near
// the end of a flight over the Strait of Hormuz — reading on screen as a
// square of black static. Root cause (see tileStreamManager.js's
// _scheduleImageryRetry): imagery fetches only retried once, then silently
// gave up FOREVER with zero record anywhere. That's fixed now, but "watch a
// video and eyeball it" isn't a repeatable way to confirm tiles load
// correctly — this exists so the same check is one console command.
//
// What it does: flies the camera to a fixed set of waypoints (same kind of
// diverse global spread as the manual location-sweep testing this project
// already did — flat farmland, extreme-gradient coastline, high latitude,
// the exact Hormuz spot from the video), waits for each spot's tile count to
// stop changing (settled), then reads tileStreamManager's own diagnostic
// registry for any tile still stuck without real imagery. Settling is
// measured directly off tileStream.getLoadStats(), not a fixed sleep, so the
// reported time is an honest "how long did this actually take" number.
//
// Console API:
//   window.vg1TileTest.run()                      → sweeps all waypoints
//   window.vg1TileTest.runOne(label, lon, lat, y)  → single spot, for
//                                                     reproducing one report
//
// Both are async — `await` them in DevTools, or `.then(r => console.log(r))`.

import { lonLatToScene } from './aisManager.js';

// [label, lon, lat, altitudeY, cameraZOffset] — altitude/offset chosen to
// land inside the tile-stream's active LOD bands (camera.y < 200; z12-z13
// bands kick in below y=22, per CLAUDE.md's LOD table) with a slight oblique
// tilt, since that's the viewing angle test.mp4 was shot at and the angle
// the forward-shift/effective-altitude fixes (tasks #3, #22) both targeted.
const WAYPOINTS = [
    ['Strait of Hormuz (test.mp4 spot)', 56.5,   26.5,  15, 10],
    ['Persian Gulf approach',            57.0,   25.8,  15, 10],
    ['Kansas plains',                   -98.5,   38.5,  15, 10],
    ['Sahara desert',                    10.0,   23.0,  15, 10],
    ['Andes / trench coast',            -70.5,  -33.5,  15, 10],
    ['Himalaya',                         86.9,   27.9,  15, 10],
    ['Amazon basin',                    -60.0,   -3.0,  15, 10],
    ['Tokyo coast',                     139.7,   35.6,  15, 10],
    ['North Sea / Danish Straits',        9.5,   56.0,  15, 10],
    ['Drake Passage (high latitude)',   -65.0,  -58.0,  15, 10],
];

const SETTLE_TIMEOUT_MS = 15000;  // give up waiting for this spot after this long
const SETTLE_POLL_MS    = 250;
const SETTLE_QUIET_MS   = 1200;   // tile count must hold steady this long to count as "settled"

class TileLoadTester {
    async runOne(label, lon, lat, altY = 15, tiltZ = 10) {
        if (!window.camera || !window.controls || !window.tileStream) {
            throw new Error('[TileLoadTest] scene not ready — camera/controls/tileStream missing on window');
        }
        const p = lonLatToScene(lon, lat);
        window.controls.target.set(p.x, 0, p.z);
        window.camera.position.set(p.x, altY, p.z + tiltZ);
        window.controls.update();

        const t0 = performance.now();
        let lastCount = -1, stableStart = null;
        while (performance.now() - t0 < SETTLE_TIMEOUT_MS) {
            await new Promise(r => setTimeout(r, SETTLE_POLL_MS));
            const stats = window.tileStream.getLoadStats();
            if (stats.totalTiles === lastCount) {
                if (stableStart === null) stableStart = performance.now();
                if (performance.now() - stableStart >= SETTLE_QUIET_MS) break;
            } else {
                lastCount   = stats.totalTiles;
                stableStart = null;
            }
        }
        const settleMs = performance.now() - t0;
        const stats     = window.tileStream.getLoadStats();
        return {
            label, lon, lat,
            settleMs:   Math.round(settleMs),
            totalTiles: stats.totalTiles,
            stuckTiles: stats.stuckTiles,
            stuck:      stats.stuck,
            timedOut:   settleMs >= SETTLE_TIMEOUT_MS,
        };
    }

    async run(waypoints = WAYPOINTS) {
        const results = [];
        for (const [label, lon, lat, altY, tiltZ] of waypoints) {
            results.push(await this.runOne(label, lon, lat, altY, tiltZ));
        }
        const totalStuck  = results.reduce((s, r) => s + r.stuckTiles, 0);
        const settleTimes = results.map(r => r.settleMs);
        const summary = {
            waypointsTested: results.length,
            totalStuckTiles: totalStuck,
            anyTimedOut:     results.some(r => r.timedOut),
            avgSettleMs:     Math.round(settleTimes.reduce((a, b) => a + b, 0) / results.length),
            maxSettleMs:     Math.max(...settleTimes),
            pass:            totalStuck === 0,
        };
        console.table(results.map(r => ({
            spot: r.label, settleMs: r.settleMs, tiles: r.totalTiles,
            stuck: r.stuckTiles, timedOut: r.timedOut,
        })));
        console.log(summary.pass
            ? `[TileLoadTest] PASS — ${results.length} spots, 0 stuck tiles, avg settle ${summary.avgSettleMs}ms`
            : `[TileLoadTest] FAIL — ${totalStuck} stuck tile(s) found — inspect result.stuck for detail`);
        return { summary, results };
    }
}

export const tileLoadTester = new TileLoadTester();
