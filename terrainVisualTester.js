// terrainVisualTester.js — Automated regression tester for three visual-fidelity
// bugs Jamal reported from a close-oblique screenshot near the Strait of Hormuz
// (2026-07-21): 3DGS splat overlays floating disconnected from the ground, country
// border lines floating above/sinking below the visible terrain, and black gaps
// opening between adjacent tile-mode point tiles where the land elevates.
//
// Each got a code fix:
//   • gaussianSplatOverlay.js  — captures now anchor to getSceneGroundY(cx,cz),
//                                not a bare absolute-Y constant.
//   • terrainBuilder.js        — redrapeToTerrainHeight() snaps every border
//                                vertex to the real continent-mesh height once
//                                it's loaded.
//   • tileStreamManager.js     — point-tile edge overlap now scales with each
//                                tile's own relief (maxHeight-minHeight) instead
//                                of a flat 0.8% margin.
//
// This is the "run it and get a pass/fail" companion, same spirit as
// tileLoadTester.js: measures the actual symptom (Y deviation, empty boundary
// strips) off live scene data instead of re-eyeballing a screenshot every time
// something nearby changes.
//
// Console API:
//   window.vg1VisualTest.run()            → flies to waypoints, runs all 3 checks
//   window.vg1VisualTest.checkBorders()    → single check, current camera spot
//   window.vg1VisualTest.checkSplats()     → single check, no camera move needed
//   window.vg1VisualTest.checkTileGaps()   → single check, current camera spot
//
// All are safe to call standalone from DevTools; run() just sequences them
// across a diverse spread of terrain (flat + steep-relief spots, since the
// tile-gap bug is relief-triggered).

import { lonLatToScene } from './aisManager.js';
import { getSceneGroundY } from './terrainBuilder.js';

// Reuses tileLoadTester's waypoint style — steep-relief spots first since
// that's where the gap bug actually shows; flat spots included as negative
// controls (should always come back gap-free).
const WAYPOINTS = [
    ['Strait of Hormuz (reported spot)', 56.5,   26.5,  15, 10],
    ['Andes / trench coast (steep)',    -70.5,  -33.5,  15, 10],
    ['Himalaya (steep)',                 86.9,   27.9,  15, 10],
    ['Alps (steep)',                      8.0,   46.5,  15, 10],
    ['Kansas plains (flat control)',    -98.5,   38.5,  15, 10],
    ['Sahara desert (flat control)',     10.0,   23.0,  15, 10],
];

const SETTLE_TIMEOUT_MS = 15000;
const SETTLE_POLL_MS    = 250;
const SETTLE_QUIET_MS   = 1000;

const BORDER_DEVIATION_THRESHOLD = 0.05;   // scene units — LIFT is 0.015, so ~3x that is the alarm line
const GAP_EMPTY_BIN_FRACTION     = 0.15;   // >15% of a shared boundary strip empty on both sides = gap

class TerrainVisualTester {

    // ── Check 1: border drape accuracy ────────────────────────────────────────
    checkBorders() {
        const bordersGroup = window.vg1Borders;
        const heightFn     = window.terrainHeight?.sampleTerrainHeightXZ;
        if (!bordersGroup) return { skipped: true, reason: 'window.vg1Borders not set' };
        if (!window.terrainHeight?.isReady?.()) return { skipped: true, reason: 'terrainHeight sampler not ready yet' };

        const deviations = [];
        bordersGroup.traverse(obj => {
            if (!obj.isLine || !obj.geometry) return;
            const pos = obj.geometry.attributes.position;
            if (!pos) return;
            const stride = Math.max(1, Math.floor(pos.count / 60)); // sample ~60 verts/line, plenty for a drape check
            for (let i = 0; i < pos.count; i += stride) {
                const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
                const groundY = heightFn(x, z);
                if (Number.isFinite(groundY)) deviations.push(Math.abs(y - groundY));
            }
        });

        if (!deviations.length) return { skipped: true, reason: 'no border vertices sampled' };
        deviations.sort((a, b) => a - b);
        const max = deviations[deviations.length - 1];
        const avg = deviations.reduce((a, b) => a + b, 0) / deviations.length;
        const p95 = deviations[Math.floor(deviations.length * 0.95)];
        return {
            sampleCount:   deviations.length,
            avgDeviation:  +avg.toFixed(4),
            p95Deviation:  +p95.toFixed(4),
            maxDeviation:  +max.toFixed(4),
            pass:          p95 <= BORDER_DEVIATION_THRESHOLD,
        };
    }

    // ── Check 2: splat overlay ground anchoring ───────────────────────────────
    checkSplats() {
        const gs = window.gsManager;
        if (!gs) return { skipped: true, reason: 'window.gsManager not set' };

        const rows = gs._overlays.map(e => {
            const expectedY = getSceneGroundY(e.cx, e.cz) + e.cfg.yOffset;
            const loaded    = !!e.loaded && !!e.viewer;
            const actualY   = loaded ? e.viewer.position.y : null;
            const deviation = loaded ? Math.abs(actualY - expectedY) : null;
            return { name: e.cfg.name, loaded, expectedY: +expectedY.toFixed(4), actualY, deviation };
        });

        const loadedRows = rows.filter(r => r.loaded);
        const maxDeviation = loadedRows.length ? Math.max(...loadedRows.map(r => r.deviation)) : 0;
        return {
            overlayCount: rows.length,
            loadedCount:  loadedRows.length,
            overlays:     rows,
            maxDeviation: +maxDeviation.toFixed(6),
            pass:         maxDeviation < 1e-6,   // deterministic formula now — any deviation means the fix regressed
        };
    }

    // ── Check 3b: blacklisted (permanently-empty) tiles near the current view ──
    // 2026-07-21: a reported "not loading tile" bug — a sharp, isolated black
    // square inside otherwise-normal farmland — turned out to be a points-mode
    // tile that came back with zero points after ocean-exclusion filtering,
    // which the old guard just blacklisted, wrongly assuming the base cloud
    // would backstop the single empty cell (it doesn't — LayerCoordinator's
    // fade is one global value per frame, not per-cell). Fixed by rebuilding a
    // flat-quad fallback before giving up (see tileStreamManager.js). This
    // check counts what's STILL blacklisted after that fix, near wherever the
    // camera currently is — should stay at/near 0 for real land; any nonzero
    // count here for a spot that isn't genuinely far-offshore/no-data is a
    // regression of the same bug.
    checkEmptyTileHoles() {
        const ts = window.tileStream;
        if (!ts) return { skipped: true, reason: 'window.tileStream not set' };
        const perLevel = ts._caches.map(c => ({ zoom: c._cfg.zoom, blacklisted: c._unavailable ? c._unavailable.size : 0 }));
        const total = perLevel.reduce((s, l) => s + l.blacklisted, 0);
        return { perLevel, total, pass: true /* informational — no fixed pass threshold, sparse-ocean 404s are expected */ };
    }

    // ── Check 3: tile-boundary point coverage gaps ────────────────────────────
    checkTileGaps() {
        const ts = window.tileStream;
        if (!ts) return { skipped: true, reason: 'window.tileStream not set' };

        const gapReports = [];
        let pairsChecked = 0;

        for (const cache of ts._caches) {
            const entries = [...cache._tiles.entries()].filter(([, e]) =>
                e.mesh && e.mesh.visible && e.opacity > 0.3 && e.mesh.geometry?.attributes?.position
            );
            for (let i = 0; i < entries.length; i++) {
                for (let j = i + 1; j < entries.length; j++) {
                    const [keyA, entryA] = entries[i];
                    const [keyB, entryB] = entries[j];
                    const result = this._measureEdgeGap(entryA.mesh, entryB.mesh);
                    if (!result) continue;   // not adjacent — skip
                    pairsChecked++;
                    if (result.hasGap) gapReports.push({ zoom: cache._cfg.zoom, tileA: keyA, tileB: keyB, ...result });
                }
            }
        }

        return { pairsChecked, pairsWithGap: gapReports.length, gaps: gapReports, pass: gapReports.length === 0 };
    }

    // Determines, from two tile meshes' bounding boxes, whether they sit side by
    // side (share an edge) and if so scans a thin strip along that shared edge
    // for boundary bins with zero points from EITHER mesh — an empty bin means a
    // visible hole at that point along the seam.
    _measureEdgeGap(meshA, meshB) {
        const posA = meshA.geometry.attributes.position;
        const posB = meshB.geometry.attributes.position;
        if (!posA || !posB) return null;

        meshA.geometry.computeBoundingBox();
        meshB.geometry.computeBoundingBox();
        const bbA = meshA.geometry.boundingBox, bbB = meshB.geometry.boundingBox;

        const xOverlap = Math.min(bbA.max.z, bbB.max.z) - Math.max(bbA.min.z, bbB.min.z);
        const zOverlap = Math.min(bbA.max.x, bbB.max.x) - Math.max(bbA.min.x, bbB.min.x);
        const xGap = Math.max(bbA.min.x, bbB.min.x) - Math.min(bbA.max.x, bbB.max.x);
        const zGap = Math.max(bbA.min.z, bbB.min.z) - Math.min(bbA.max.z, bbB.max.z);
        const tileWidthX = bbA.max.x - bbA.min.x;
        const tileWidthZ = bbA.max.z - bbA.min.z;

        let axis, spanMin, spanMax, stripCenter;
        if (xOverlap > tileWidthZ * 0.3 && xGap < tileWidthX * 0.15) {
            axis = 'x';
            stripCenter = (Math.min(bbA.max.x, bbB.max.x) + Math.max(bbA.min.x, bbB.min.x)) / 2;
            spanMin = Math.max(bbA.min.z, bbB.min.z);
            spanMax = Math.min(bbA.max.z, bbB.max.z);
        } else if (zOverlap > tileWidthX * 0.3 && zGap < tileWidthZ * 0.15) {
            axis = 'z';
            stripCenter = (Math.min(bbA.max.z, bbB.max.z) + Math.max(bbA.min.z, bbB.min.z)) / 2;
            spanMin = Math.max(bbA.min.x, bbB.min.x);
            spanMax = Math.min(bbA.max.x, bbB.max.x);
        } else {
            return null;   // not adjacent along either axis
        }
        if (!(spanMax > spanMin)) return null;

        const stripHalfWidth = Math.max(tileWidthX, tileWidthZ) * 0.03;
        const BINS = 24;
        const binHits = new Array(BINS).fill(false);

        const scan = (posAttr) => {
            for (let i = 0; i < posAttr.count; i++) {
                const px = posAttr.getX(i), pz = posAttr.getZ(i);
                const along = axis === 'x' ? px : pz;
                if (Math.abs(along - stripCenter) > stripHalfWidth) continue;
                const t = axis === 'x' ? pz : px;
                if (t < spanMin || t > spanMax) continue;
                const bin = Math.min(BINS - 1, Math.max(0, Math.floor((t - spanMin) / (spanMax - spanMin) * BINS)));
                binHits[bin] = true;
            }
        };
        scan(posA);
        scan(posB);

        const emptyBins = binHits.filter(h => !h).length;
        const emptyFrac = emptyBins / BINS;
        return { hasGap: emptyFrac > GAP_EMPTY_BIN_FRACTION, emptyFrac: +emptyFrac.toFixed(2), axis };
    }

    // ── Camera movement (mirrors tileLoadTester.js) ───────────────────────────
    async _flyToAndSettle(lon, lat, altY, tiltZ) {
        if (!window.camera || !window.controls || !window.tileStream) {
            throw new Error('[VisualTest] scene not ready — camera/controls/tileStream missing on window');
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
                lastCount = stats.totalTiles;
                stableStart = null;
            }
        }
    }

    // ── Full sweep ─────────────────────────────────────────────────────────────
    async run(waypoints = WAYPOINTS) {
        const results = [];
        for (const [label, lon, lat, altY, tiltZ] of waypoints) {
            await this._flyToAndSettle(lon, lat, altY, tiltZ);
            results.push({
                label, lon, lat,
                borders: this.checkBorders(),
                splats:  this.checkSplats(),
                gaps:    this.checkTileGaps(),
                holes:   this.checkEmptyTileHoles(),
            });
        }

        const fails = [];
        results.forEach(r => {
            if (r.borders.pass === false) fails.push(`${r.label}: borders p95=${r.borders.p95Deviation}`);
            if (r.splats.pass === false)  fails.push(`${r.label}: splats maxDev=${r.splats.maxDeviation}`);
            if (r.gaps.pass === false)    fails.push(`${r.label}: ${r.gaps.pairsWithGap} tile-pair gap(s)`);
        });

        console.table(results.map(r => ({
            spot: r.label,
            bordersP95: r.borders.p95Deviation ?? '(skipped)',
            bordersPass: r.borders.pass ?? '—',
            splatsMaxDev: r.splats.maxDeviation ?? '(skipped)',
            splatsPass: r.splats.pass ?? '—',
            tileGapPairs: r.gaps.pairsWithGap ?? '(skipped)',
            gapsPass: r.gaps.pass ?? '—',
            blacklistedTiles: r.holes.total ?? '(skipped)',
        })));

        const pass = fails.length === 0;
        console.log(pass
            ? `[VisualTest] PASS — ${results.length} spots, borders/splats/gaps all clean`
            : `[VisualTest] FAIL — ${fails.length} issue(s):\n  ${fails.join('\n  ')}`);

        return { pass, fails, results };
    }
}

export const terrainVisualTester = new TerrainVisualTester();
