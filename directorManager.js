// directorManager.js — Cinematic auto-camera when the user is idle
//
// After 15 s of no interaction the director activates, picks a random live
// asset from aisShips, positions the camera at a cinematically chosen offset,
// and smoothly cuts to a new angle every 12 s. Any user input (pointer, wheel,
// keyboard) immediately hands control back.
//
// Fixes vs. original CinematicDir.js:
//   • Frame-rate-independent smoothing via exponential damping
//     (1 - exp(-k·Δt)) — lerp speed is consistent at 30 fps and 120 fps.
//   • Camera offsets are rotated by the target's Y rotation so "broadside",
//     "tailing", etc. actually map to the right world direction.
//   • Accepts aisShips array directly — no militaryManager dependency.
//   • Exposes activeTarget getter so main.js can snap DoF focal plane.
import * as THREE from 'three';
import { DIRECTOR } from './config.js';

export class CinematicDirector {
    constructor(camera, controls, aisShipsRef) {
        this.camera      = camera;
        this.controls    = controls;
        this.aisShipsRef = aisShipsRef;  // live reference — reflects adds/removes

        this._enabled      = false;  // off by default; HUD toggle-director enables it
        this.isActive      = false;
        this.idleTime      = 0;
        this._shotTimer    = 0;
        this.currentTarget = null;   // THREE.Object3D currently being tracked

        // World-space offset applied to the target position to derive ideal cam pos.
        // Reset in _pickNewShot() each cut.
        this._worldOffset = new THREE.Vector3();

        // Reusable objects — avoid per-frame allocation
        this._idealCamPos = new THREE.Vector3();
        this._q           = new THREE.Quaternion();

        // Interrupt on any user input
        const interrupt = () => {
            this.idleTime = 0;
            if (this.isActive) {
                this.isActive      = false;
                this.currentTarget = null;
                document.getElementById('director-toast')?.remove();
            }
        };
        window.addEventListener('pointerdown', interrupt);
        window.addEventListener('wheel',       interrupt);
        window.addEventListener('keydown',     interrupt);
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /** Enable or disable the director without resetting idle time. */
    get enabled() { return this._enabled ?? true; }
    set enabled(v) {
        this._enabled = v;
        if (!v && this.isActive) {
            this.isActive      = false;
            this.currentTarget = null;
            document.getElementById('director-toast')?.remove();
        }
    }

    toggle() { this.enabled = !this.enabled; }

    // ── Called every frame from main animate() ────────────────────────────────

    update(delta) {
        if (!this.enabled) return;
        if (!this.isActive) {
            this.idleTime += delta;
            if (this.idleTime >= DIRECTOR.IDLE_THRESHOLD) this._activate();
            return;
        }

        this._shotTimer += delta;
        if (this._shotTimer >= DIRECTOR.SHOT_DURATION || !this.currentTarget) {
            this._pickNewShot();
        }

        if (!this.currentTarget) return;

        const targetPos = this.currentTarget.position;

        // ── Exponential damping — frame-rate independent ──────────────────────
        // factor = 1 - exp(-k·Δt) approaches 1 asymptotically; at k=3.5 and
        // Δt=1/60 it gives ~0.056 per frame — smooth glide, not a snap.
        const followFactor = 1.0 - Math.exp(-DIRECTOR.FOLLOW_K * delta);
        const flyFactor    = 1.0 - Math.exp(-DIRECTOR.FLY_K    * delta);

        // Pan orbital target toward the tracked asset
        this.controls.target.lerp(targetPos, followFactor);

        // Derive ideal camera position from the heading-relative offset.
        // currentTarget.rotation.y encodes the asset's heading (set every tick
        // by the main loop for both vessels and aircraft), so rotating the
        // local offset by that angle gives a world-space position that always
        // means "behind", "broadside", etc. from the asset's perspective.
        this._q.setFromAxisAngle(
            new THREE.Vector3(0, 1, 0),
            this.currentTarget.rotation.y
        );
        this._idealCamPos
            .copy(this._worldOffset)
            .applyQuaternion(this._q)
            .add(targetPos);

        this.camera.position.lerp(this._idealCamPos, flyFactor);
        this.controls.update();
    }

    // ── Getter used by main.js to snap DoF focal plane ───────────────────────

    get activeTarget() {
        return this.isActive ? this.currentTarget : null;
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    _activate() {
        this.isActive = true;
        this._pickNewShot();

        let toast = document.getElementById('director-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'director-toast';
            toast.style.cssText = `
                position: absolute;
                bottom: 40px;
                left: 50%;
                transform: translateX(-50%);
                color: var(--orange, #ff5e00);
                font-family: monospace;
                font-size: 13px;
                background: rgba(1, 10, 20, 0.82);
                padding: 8px 18px;
                border: 1px solid var(--orange, #ff5e00);
                border-radius: 4px;
                pointer-events: none;
                z-index: 100;
                letter-spacing: 2px;
                text-shadow: 0 0 8px var(--orange, #ff5e00);
            `;
            toast.innerText = '⬤  CINEMATIC DIRECTOR ACTIVE';
            document.body.appendChild(toast);
        }
    }

    _pickNewShot() {
        this._shotTimer = 0;

        // Filter to objects that actually have a position (skip recently removed)
        const assets = this.aisShipsRef.filter(o => o?.position);
        if (assets.length === 0) return;

        this.currentTarget = assets[Math.floor(Math.random() * assets.length)];

        // Determine asset type by elevation
        const y = this.currentTarget.position.y;
        const isSatellite = y > 50;
        const isAircraft  = y > 1.0 && !isSatellite;

        // Offsets are in the asset's LOCAL space (forward = +Z, right = +X).
        // They are rotated into world space in update() by the target's Y rotation.
        //
        // Kept intentionally moderate — the scene scale means large offsets send
        // the camera off the map edge.
        let offsets;
        if (isSatellite) {
            offsets = [
                new THREE.Vector3(  0, 20,  40),  // trailing high
                new THREE.Vector3( 30, 10,   0),  // side elevation
                new THREE.Vector3(  0, 60,   0),  // top-down orbital
            ];
        } else if (isAircraft) {
            offsets = [
                new THREE.Vector3(  0,  4, -14),  // tailing high
                new THREE.Vector3(-10,  1,   8),  // leading low angle
                new THREE.Vector3(  0, 16,   0),  // top-down satellite view
                new THREE.Vector3( 12,  2, -12),  // high starboard quarter
            ];
        } else {
            // Surface vessel
            offsets = [
                new THREE.Vector3( 16,  5,  16),  // port broadside
                new THREE.Vector3(-16,  2, -16),  // starboard low rear
                new THREE.Vector3(  2,  1,   9),  // close water-level stern
                new THREE.Vector3(  0,  8, -20),  // bow-on head-on
            ];
        }

        this._worldOffset.copy(offsets[Math.floor(Math.random() * offsets.length)]);
    }
}
