// flightRouteManager.js — Per-aircraft flight path recorder
//
// Records actual flight positions as the plane moves and renders them as a
// yellow track line. No API call, no prediction — the path grows in real time
// from the moment tracking is enabled.
//
// Toggle: uiController.js fires vg1:flightRouteToggle { flight }
// Result: vg1:flightRouteResult { flight, ok, error? }

import * as THREE from 'three';

const TRACK_COLOR = 0xffdd00;   // yellow
const TRACK_Y     = 1.5;         // slight lift above sea level (avoids z-fighting)
const MAX_PTS     = 600;         // max recorded positions before oldest are dropped
const MIN_DIST_SQ = 0.06;        // squared scene-units — min movement before a new point is saved

export class FlightRouteManager {
    constructor(scene) {
        this._scene  = scene;
        this._routes = new Map();   // flight THREE.Group → entry

        window.addEventListener('vg1:flightRouteToggle', e => {
            this._onToggle(e.detail.flight);
        });
    }

    isActive(flight) { return this._routes.has(flight); }

    // ── Toggle ──────────────────────────────────────────────────────────────────
    _onToggle(flight) {
        if (!flight) return;
        if (this._routes.has(flight)) {
            this._removeRoute(flight);
        } else {
            this._addRoute(flight);
        }
    }

    // ── Start recording — build scene objects and seed first point ──────────────
    _addRoute(flight) {
        const positions = new Float32Array(MAX_PTS * 3);

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setDrawRange(0, 0);

        const mat = new THREE.LineBasicMaterial({
            color:       TRACK_COLOR,
            transparent: true,
            opacity:     0.85,
            depthWrite:  false,
        });

        const line = new THREE.Line(geo, mat);
        this._scene.add(line);

        const entry = { positions, line, count: 0, lastX: null, lastZ: null };

        // Seed from current position so the line starts immediately
        this._push(entry, flight.position.x, flight.position.z);

        this._routes.set(flight, entry);

        // Signal UI — button changes to HIDE ROUTE
        window.dispatchEvent(new CustomEvent('vg1:flightRouteResult', {
            detail: { flight, ok: true }
        }));
    }

    // ── Append one point to the recorded track ──────────────────────────────────
    _push(entry, x, z) {
        if (entry.count >= MAX_PTS) {
            // Buffer full — evict oldest point by shifting left one slot
            entry.positions.copyWithin(0, 3);
            const i = (MAX_PTS - 1) * 3;
            entry.positions[i]     = x;
            entry.positions[i + 1] = TRACK_Y;
            entry.positions[i + 2] = z;
            // count stays at MAX_PTS
        } else {
            const i = entry.count * 3;
            entry.positions[i]     = x;
            entry.positions[i + 1] = TRACK_Y;
            entry.positions[i + 2] = z;
            entry.count++;
        }

        entry.lastX = x;
        entry.lastZ = z;

        const attr = entry.line.geometry.attributes.position;
        attr.needsUpdate = true;
        entry.line.geometry.setDrawRange(0, entry.count);
    }

    // ── Remove route — dispose scene objects ────────────────────────────────────
    _removeRoute(flight) {
        const entry = this._routes.get(flight);
        this._routes.delete(flight);
        if (!entry) return;
        this._scene.remove(entry.line);
        entry.line.geometry.dispose();
        entry.line.material.dispose();
    }

    // ── tick — called every frame from main.js animation loop ──────────────────
    tick() {
        for (const [flight, entry] of this._routes) {
            // Auto-clean if plane left the scene (landed / feed dropped)
            if (!flight.parent) {
                this._removeRoute(flight);
                continue;
            }

            const x = flight.position.x;
            const z = flight.position.z;

            // Only record a new point when the plane has moved meaningfully
            if (entry.lastX !== null) {
                const dx = x - entry.lastX;
                const dz = z - entry.lastZ;
                if (dx * dx + dz * dz < MIN_DIST_SQ) continue;
            }

            this._push(entry, x, z);
        }
    }

    // Remove all active routes — call on scene reset
    clear() {
        for (const flight of [...this._routes.keys()]) {
            this._removeRoute(flight);
        }
    }
}
