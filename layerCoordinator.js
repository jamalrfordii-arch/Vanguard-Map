// layerCoordinator.js — the continent-detail "brain" (Phase 3, 2026-07-15)
//
// One place that, every frame, decides which detail layer OWNS the ground at the
// current view and drives the cross-fades so the layers hand off cleanly instead
// of fighting or cluttering each other. The stack, coarse → fine:
//
//   1. Base point cloud  (global fallback floor — always present unless covered)
//   2. Streamed tile points (Cesium DEM + procedural amplification)
//   3. 3DGS hotspot captures (photoreal, per-location)
//
// Rules it enforces:
//   • Base cloud fades as EITHER the tile points OR a 3DGS capture solidly cover
//     the look-at — so the sparse global dots never clutter real detail, but stay
//     as a backstop wherever nothing has loaded (no black voids).
//   • Tile points fade out from UNDER a fully-present 3DGS capture, so the
//     photoreal splat owns that ground without dots punching through it.
//
// It reads, it never renders: it only calls the existing fade hooks
// (updatePointCloud, tileStream.setDetailDim). Add future layers here so the
// hand-off logic stays in exactly one file.

import { updatePointCloud } from './terrainBuilder.js';

export class LayerCoordinator {
    /**
     * @param {object} tileStream — TileStreamManager (needs coverageFraction + setDetailDim)
     * @param {object} gsManager  — GaussianSplatOverlayManager (needs capturePresence)
     */
    constructor(tileStream, gsManager) {
        this._tiles = tileStream || null;
        this._gs    = gsManager  || null;
    }

    // Call once per animation frame, after the layers' own updates.
    update(camera, lookAt = null) {
        // How much a photoreal capture owns the view (0..1).
        const gsPresence = this._gs ? this._gs.capturePresence(camera) : 0;

        // How much the streamed tile points solidly cover the look-at (0..1).
        const tileCoverage = this._tiles ? this._tiles.coverageFraction(camera, lookAt) : 0;

        // BASE CLOUD: fade under whichever detail layer covers more. A capture
        // counts as full coverage of its own footprint, so max() lets it clear
        // the base too when you're right on it.
        //
        // Coverage GAIN (2026-07-18): the tile coverage metric is a strict 5×5
        // solid-tile fraction, and a real view almost always includes a few water
        // or no-data tiles (Cesium 404s over ocean), so it plateaus around 0.6 even
        // when the ground is visually full. Left linear, that pinned the base cloud
        // at ~40% forever — dots punching through the imagery and its millions of
        // points never culling (an FPS drag). Applying a gain lets a reasonably
        // covered view (≈0.65) trigger a FULL takeover (base → 0, then .visible off),
        // while genuinely sparse views (fast dives, mid-ocean) still keep the base
        // as a backstop so nothing goes black.
        // No floor (cap 1.0): once tiles cover the ground the base culls ENTIRELY
        // (uFade→0, .visible off) and stops rendering its millions of points. Earlier
        // a floor was kept to backstop black holes, but the flat-tile fallback in the
        // loader now gives the active level full hole-free coverage, so no backstop is
        // needed. On a fast dive coverage is briefly < 1 and the base fades in
        // proportionally, so nothing goes black mid-descent.
        const effectiveCoverage = Math.min(1, tileCoverage * 1.6);
        updatePointCloud(camera, Math.max(effectiveCoverage, gsPresence));

        // TILE POINTS: fade out from under a fully-present capture (1-presence),
        // so the splat is unobstructed; full opacity everywhere else.
        if (this._tiles && this._tiles.setDetailDim) {
            this._tiles.setDetailDim(1 - gsPresence);
        }
    }
}
