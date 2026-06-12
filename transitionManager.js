// transitionManager.js — Plan 02: Compression / Expansion Transition Architecture
//
// Orchestrates three phases across vessel lock / unlock events:
//
//   Phase 01 — Compression   radial vignette centered on locked vessel, 600 ms
//   Phase 02 — The Pull      auto zoom-out + 10° camera tilt, 900 ms ease-in-out
//   Phase 03 — Expansion     cluster bloom radiating from vessel region, 60 ms stagger
//
//   Reverse (zoom-in)  300 ms approach → 200 ms distant-cluster fade → 600 ms vignette
//
// Usage (main.js):
//   const transitionMgr = new TransitionManager(camera);
//   transitionMgr.setClusterManager(clusterManager);
//   window.transitionMgr = transitionMgr;
//   // in animation loop:
//   transitionMgr.tick(state, camera);
//
// Called from uiController.js:
//   window.transitionMgr?.onLock(ship, camera)    — when vessel detail panel opens
//   window.transitionMgr?.onUnlock(ship, stateRef) — when × button closes panel

import * as THREE from 'three';

// ── Tunables ──────────────────────────────────────────────────────────────────
const ZOOM_OUT_HEIGHT = 280;   // world-Y to fly to on unlock
const TILT_ANGLE      = 0.17;  // radians ≈ 10° from vertical
const ZOOM_IN_TOTAL   = 1100;  // ms — full reverse transition duration

export class TransitionManager {
    constructor(camera) {
        this._camera          = camera;
        this._vignetteEl      = null;
        this._scrVec          = new THREE.Vector3();
        this._clusterManager  = null;

        // Zoom-in reverse timing (phases driven by elapsed ms since lock)
        this._zoomInActive    = false;
        this._zoomInStartMs   = 0;
        this._zoomInVesselPos = null;
        this._didFadeDistant  = false;
        this._didVignette     = false;
    }

    // Call once after the DOM is ready
    init() {
        this._vignetteEl = document.getElementById('vessel-vignette');
    }

    setClusterManager(cm) {
        this._clusterManager = cm;
    }

    // ── onLock — called when vessel detail panel opens ────────────────────────
    // Begins the reverse (zoom-in) transition: approach → fade → vignette.
    onLock(ship) {
        // Cancel any in-progress zoom-in
        this._zoomInActive    = true;
        this._zoomInStartMs   = performance.now();
        this._zoomInVesselPos = ship.position.clone();
        this._didFadeDistant  = false;
        this._didVignette     = false;

        // Immediate vignette position seed (will be overridden by tick each frame)
        this._updateVignettePos(ship);
    }

    // ── onUnlock — called when × closes the vessel detail panel ──────────────
    // Phase 01: clear vignette. Phase 02: fly out + tilt. Phase 03: bloom queued
    // in ClusterManager when _shipActive transitions false→true.
    onUnlock(ship, stateRef) {
        // Phase 01 reverse: dissolve vignette
        if (this._vignetteEl) this._vignetteEl.classList.remove('active');

        // Cancel any pending zoom-in
        this._zoomInActive = false;

        // Phase 02: compute tilted zoom-out camera target
        const vPos   = ship.position;
        const height = Math.max(this._camera.position.y * 2.2, ZOOM_OUT_HEIGHT);
        const tiltZ  = height * Math.sin(TILT_ANGLE);

        // Camera flies to a position above-and-behind the vessel
        stateRef.flightTargetPos.set(
            vPos.x,
            height * Math.cos(TILT_ANGLE),
            vPos.z + tiltZ
        );
        stateRef.isFlyingToTarget = true;

        // Phase 03 prep: tell ClusterManager where the vessel was so it can
        // sort clusters by distance when they first become active.
        if (this._clusterManager) {
            this._clusterManager._lastVesselPos = vPos.clone();
        }
    }

    // ── tick — call every animation frame ────────────────────────────────────
    tick(state, camera) {
        this._camera = camera;

        // Always track vignette on the locked ship (camera may be moving)
        if (state.lockedShip && this._vignetteEl?.classList.contains('active')) {
            this._updateVignettePos(state.lockedShip);
        }

        // Reverse zoom-in: 300 ms → fade distant, 600 ms → show vignette
        if (this._zoomInActive) {
            const age = performance.now() - this._zoomInStartMs;

            if (age >= 300 && !this._didFadeDistant) {
                this._didFadeDistant = true;
                if (this._clusterManager && this._zoomInVesselPos) {
                    this._clusterManager.fadeDistantClusters(this._zoomInVesselPos);
                }
            }

            if (age >= 600 && !this._didVignette && state.lockedShip) {
                this._didVignette = true;
                this._updateVignettePos(state.lockedShip);
                if (this._vignetteEl) this._vignetteEl.classList.add('active');
            }

            if (age >= ZOOM_IN_TOTAL) this._zoomInActive = false;
        }
    }

    // ── private helpers ───────────────────────────────────────────────────────

    _updateVignettePos(ship) {
        if (!this._vignetteEl) return;
        this._scrVec.copy(ship.position).project(this._camera);
        // Convert NDC (-1..1) to CSS percentages
        const px = (((this._scrVec.x + 1) / 2) * 100).toFixed(1);
        const py = (((1 - this._scrVec.y) / 2) * 100).toFixed(1);
        this._vignetteEl.style.setProperty('--vessel-x', `${px}%`);
        this._vignetteEl.style.setProperty('--vessel-y', `${py}%`);
    }
}
