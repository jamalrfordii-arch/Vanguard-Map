// satArcManager.js — Satellite ground-track arc overlay
//
// For every tracked satellite (or a selected subset), propagates the orbit
// forward N minutes using the same satellite.js SGP4 engine that
// satelliteManager.js uses for live positions, then draws the predicted
// ground track as a glowing arc line on the Mercator map.
//
// Features
// ────────
//  • Full-orbit arc (one revolution)  OR  60-minute forward look-ahead arc
//  • Two-layer rendering: broad cyan glow (additive) + sharp white core
//  • Auto-wraps across the antimeridian (inserts NaN break-points)
//  • Selectable arcs: call showArc(id) / hideArc(id) or showAll() / hideAll()
//  • Arc colour encodes altitude:  low-orbit (cyan) → high-orbit (violet)
//  • Minimal CPU cost: arc geometry is rebuilt every ARC_REFRESH_S seconds,
//    not every frame.  Only visible arcs are rebuilt.
//
// Integration
// ───────────
//   import { SatArcManager } from './satArcManager.js';
//   const satArcManager = new SatArcManager(scene);
//   // pass SatelliteManager.satellites Map reference after init:
//   satArcManager.setSatellites(satelliteManager.satellites);
//   // in animate():
//   satArcManager.tick(delta);

import * as THREE from 'three';
import * as sat   from 'https://cdn.skypack.dev/satellite.js@5.0.0';
import { MAP_WIDTH, MAP_HEIGHT } from './config.js';
import { simClock } from './simClock.js';

const DEG2RAD      = Math.PI / 180;
const TWO_PI       = Math.PI * 2;
const ARC_REFRESH_S = 30;    // rebuild arc geometry every N seconds
const ARC_MINUTES   = 95;    // look-ahead window (≈ one LEO orbit)
const ARC_STEPS     = 190;   // points along the arc (one per 30 sec)
const MAX_ARCS      = 200;   // cap — don't draw arcs for every sat simultaneously

// ── Mercator helpers (mirrors dayNightManager.js) ─────────────────────────────
function latLonToXZ(latDeg, lonDeg) {
    const x   = lonDeg * (MAP_WIDTH / 360);
    const lr  = Math.max(-1.48, Math.min(1.48, latDeg * DEG2RAD));
    const my  = Math.log(Math.tan(Math.PI / 4 + lr / 2));
    const z   = -my * (MAP_HEIGHT / TWO_PI);
    return [x, z];
}

// ── Altitude → arc colour ─────────────────────────────────────────────────────
// LEO  (< 600 km)  → cyan     #40c4ff
// MEO  (600–3000)  → teal     #40ffcc
// HEO / GEO (>3000)→ violet   #c080ff
function altToColor(altKm) {
    if (altKm < 600)  return new THREE.Color(0x40c4ff);
    if (altKm < 3000) return new THREE.Color(0x40ffcc);
    return new THREE.Color(0xc080ff);
}

// ── SatArcManager ─────────────────────────────────────────────────────────────
export class SatArcManager {
    /**
     * @param {THREE.Scene} scene
     */
    constructor(scene) {
        this._scene      = scene;
        this._satellites = null;     // Map<id, satData> — set via setSatellites()
        this._arcs       = new Map(); // id → { glowLine, coreLine, visible, lastRebuild }
        this._elapsed    = 0;
        this._showAll    = false;    // when true, show arcs for all tracked sats
        this._selected   = new Set(); // ids whose arcs are explicitly shown
    }

    /** Provide a reference to SatelliteManager.satellites (Map). */
    setSatellites(satellitesMap) {
        this._satellites = satellitesMap;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /** Show the ground-track arc for a specific satellite by NORAD id. */
    showArc(id) {
        this._selected.add(String(id));
        this._ensureArc(String(id));
        const arc = this._arcs.get(String(id));
        if (arc) { arc.glowLine.visible = true; arc.coreLine.visible = true; arc.visible = true; }
    }

    /** Hide the ground-track arc for a specific satellite. */
    hideArc(id) {
        this._selected.delete(String(id));
        const arc = this._arcs.get(String(id));
        if (arc) { arc.glowLine.visible = false; arc.coreLine.visible = false; arc.visible = false; }
    }

    /** Toggle arc visibility for a satellite. Returns new visible state. */
    toggleArc(id) {
        if (this._selected.has(String(id))) { this.hideArc(id); return false; }
        this.showArc(id); return true;
    }

    /** Show arcs for ALL tracked satellites (capped at MAX_ARCS). */
    showAll() {
        this._showAll = true;
    }

    /** Return to show-only-selected mode. */
    hideAll() {
        this._showAll = false;
        this._arcs.forEach((arc, id) => {
            if (!this._selected.has(id)) {
                arc.glowLine.visible = false;
                arc.coreLine.visible = false;
                arc.visible = false;
            }
        });
    }

    // ── Internal arc management ───────────────────────────────────────────────

    _ensureArc(id) {
        if (this._arcs.has(id)) return;

        const makeLine = (color, opacity, linewidth) => {
            const geo = new THREE.BufferGeometry();
            // Pre-allocate enough positions for ARC_STEPS + wraparound breaks
            const positions = new Float32Array((ARC_STEPS + 20) * 3);
            geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            const mat = new THREE.LineBasicMaterial({
                color,
                transparent:  true,
                opacity,
                linewidth,
                blending:     THREE.AdditiveBlending,
                depthWrite:   false,
                depthTest:    false,
            });
            const line = new THREE.Line(geo, mat);
            line.renderOrder = 7;
            line.frustumCulled = false;
            this._scene.add(line);
            return line;
        };

        const data = this._satellites?.get(id);
        const col  = data ? altToColor(data.altKm ?? 400) : new THREE.Color(0x40c4ff);

        const glowLine = makeLine(col.clone().multiplyScalar(0.6), 0.28, 2);
        const coreLine = makeLine(col,                              0.70, 1);

        this._arcs.set(id, {
            glowLine,
            coreLine,
            visible:     true,
            lastRebuild: -ARC_REFRESH_S,  // force immediate rebuild
        });
    }

    _removeArc(id) {
        const arc = this._arcs.get(id);
        if (!arc) return;
        [arc.glowLine, arc.coreLine].forEach(l => {
            l.geometry.dispose();
            l.material.dispose();
            this._scene.remove(l);
        });
        this._arcs.delete(id);
    }

    // ── Geometry rebuild ──────────────────────────────────────────────────────

    _rebuildArc(id) {
        const arc  = this._arcs.get(id);
        if (!arc)  return;
        const data = this._satellites?.get(id);
        if (!data?.satrec) return;

        const now     = simClock.date();
        const dtSec   = (ARC_MINUTES * 60) / ARC_STEPS;
        const pts     = [];
        let   prevX   = null;

        for (let i = 0; i <= ARC_STEPS; i++) {
            const t    = new Date(now.getTime() + i * dtSec * 1000);
            let   posVel;
            try {
                posVel = sat.propagate(data.satrec, t);
            } catch (_) { continue; }

            const posEci = posVel.position;
            if (!posEci || typeof posEci === 'boolean') continue;

            // ECI → geodetic
            const gmst    = sat.gstime(t);
            const geodetic = sat.eciToGeodetic(posEci, gmst);
            const latDeg  = sat.degreesLat(geodetic.latitude);
            const lonDeg  = sat.degreesLong(geodetic.longitude);

            const [x, z] = latLonToXZ(latDeg, lonDeg);
            const y      = 1.2;  // slightly above the terminator overlay

            // Insert a NaN break at antimeridian jumps to avoid long cross-map lines
            if (prevX !== null && Math.abs(x - prevX) > MAP_WIDTH * 0.45) {
                pts.push(new THREE.Vector3(NaN, NaN, NaN));
            }
            pts.push(new THREE.Vector3(x, y, z));
            prevX = x;
        }

        // Update both line geometries
        const update = (line) => {
            line.geometry.setFromPoints(pts);
            line.geometry.attributes.position.needsUpdate = true;
        };
        update(arc.glowLine);
        update(arc.coreLine);

        // Update colour to match current altitude
        const col = altToColor(data.altKm ?? 400);
        arc.coreLine.material.color.copy(col);
        arc.glowLine.material.color.copy(col.clone().multiplyScalar(0.6));

        arc.lastRebuild = this._elapsed;
    }

    // ── tick ──────────────────────────────────────────────────────────────────

    /**
     * Call once per animation frame.
     * @param {number} delta — seconds since last frame
     */
    tick(delta) {
        this._elapsed += delta;
        if (!this._satellites) return;

        // Determine which arc ids should be visible
        const activeIds = new Set(this._selected);
        if (this._showAll) {
            let count = 0;
            for (const id of this._satellites.keys()) {
                if (count++ >= MAX_ARCS) break;
                activeIds.add(id);
            }
        }

        // Ensure arc objects exist for all active ids
        for (const id of activeIds) {
            this._ensureArc(id);
        }

        // Show / hide based on active set
        this._arcs.forEach((arc, id) => {
            const shouldShow = activeIds.has(id);
            if (!shouldShow) {
                if (arc.glowLine.visible) {
                    arc.glowLine.visible = false;
                    arc.coreLine.visible = false;
                }
                return;
            }
            if (!arc.glowLine.visible) {
                arc.glowLine.visible = true;
                arc.coreLine.visible = true;
            }
            // Rebuild stale arcs
            if (this._elapsed - arc.lastRebuild > ARC_REFRESH_S) {
                this._rebuildArc(id);
            }
        });

        // Prune arcs for satellites that no longer exist
        for (const id of this._arcs.keys()) {
            if (!this._satellites.has(id)) {
                this._removeArc(id);
            }
        }
    }

    dispose() {
        for (const id of [...this._arcs.keys()]) {
            this._removeArc(id);
        }
    }
}
