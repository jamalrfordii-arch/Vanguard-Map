// climbRibbonManager.js — climb/descent "ribbons" for aircraft.
//
// A short vertical tail hanging off each aircraft: up = climbing, down =
// descending, none = level. Length is the altitude the aircraft will gain/lose
// over FLIGHT.RIBBON_SEC at its current (smoothed) vertical rate, mapped through
// the SAME non-linear altitude curve the aircraft is drawn with (altitudeMetersToY),
// so the ribbon is proportional to on-screen vertical movement, not raw feet — an
// identical climb rate draws a longer tail down low (expanded band) than up high.
//
// Perf model mirrors navLightManager: ONE LineSegments with pre-allocated CPU
// buffers sized to the aircraft cap; each frame we write only the live climbing/
// descending aircraft and set the draw range. One draw call, zero per-frame
// allocation. Level aircraft (|rate| < RIBBON_MIN_RATE_MS) are skipped entirely,
// which also keeps cruise jitter from cluttering the view.
//
// Toggle live from DevTools: window.vg1Ribbon.enabled = false

import * as THREE from 'three';
import { FLIGHT } from './config.js';
import { altitudeRibbonDeltaY } from './flightManager.js';

const MAX = FLIGHT.MAX_AIRCRAFT + 50;   // headroom above the tracked-aircraft cap

export class ClimbRibbonManager {
    constructor(scene) {
        this._scene   = scene;
        // OFF by default: the feed carries no vertical-rate field, so the rate is
        // estimated by differencing barometric altitude across ~30 s polls — coarse
        // enough that on-by-default it reads as clutter. Opt in when you want it:
        //   window.vg1Ribbon.enabled = true
        this.enabled  = false;

        this._pos = new Float32Array(MAX * 2 * 3);  // 2 vertices (base, tip) per aircraft
        this._col = new Float32Array(MAX * 2 * 3);

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(this._pos, 3));
        geo.setAttribute('color',    new THREE.BufferAttribute(this._col, 3));
        geo.setDrawRange(0, 0);

        const mat = new THREE.LineBasicMaterial({
            vertexColors: true,
            transparent:  true,
            opacity:      0.85,
            depthWrite:   false,
        });

        this._lines = new THREE.LineSegments(geo, mat);
        this._lines.frustumCulled = false;
        this._lines.renderOrder   = 14;   // over terrain/ocean, under the nav-light points (15)
        scene.add(this._lines);

        this._climb   = new THREE.Color(FLIGHT.RIBBON_CLIMB_COLOR);
        this._descend = new THREE.Color(FLIGHT.RIBBON_DESCENT_COLOR);
    }

    // Call every frame from main.js with window.aisShips.
    update(objects) {
        if (!this.enabled || !objects || typeof objects[Symbol.iterator] !== 'function') {
            this._lines.geometry.setDrawRange(0, 0);
            return;
        }

        const minRate = FLIGHT.RIBBON_MIN_RATE_MS;
        const secs    = FLIGHT.RIBBON_SEC;
        let idx = 0; // aircraft written (each = 2 vertices)

        for (const obj of objects) {
            if (idx >= MAX) break;
            const ud = obj.userData;
            if (!ud || !ud.isRealFlight || !obj.visible) continue;

            const rate = ud.verticalRateMs;
            if (rate == null || Math.abs(rate) < minRate) continue;

            let dY = altitudeRibbonDeltaY(ud.altMeters ?? 0, rate, secs);
            if (dY === 0) continue;
            // Cap length so a strong low-altitude maneuver (expanded band) can't
            // draw a scene-dominating streak.
            const cap = FLIGHT.RIBBON_MAX_UNITS;
            if (dY >  cap) dY =  cap;
            else if (dY < -cap) dY = -cap;

            const p = obj.position;
            const c = rate > 0 ? this._climb : this._descend;
            const v = idx * 6;

            // base vertex — at the aircraft
            this._pos[v]     = p.x; this._pos[v + 1] = p.y;        this._pos[v + 2] = p.z;
            // tip vertex — projected vertical trend
            this._pos[v + 3] = p.x; this._pos[v + 4] = p.y + dY;   this._pos[v + 5] = p.z;

            this._col[v]     = c.r; this._col[v + 1] = c.g; this._col[v + 2] = c.b;
            this._col[v + 3] = c.r; this._col[v + 4] = c.g; this._col[v + 5] = c.b;

            idx++;
        }

        this._lines.geometry.setDrawRange(0, idx * 2);
        this._lines.geometry.attributes.position.needsUpdate = true;
        this._lines.geometry.attributes.color.needsUpdate    = true;
    }

    dispose() {
        this._scene.remove(this._lines);
        this._lines.geometry.dispose();
        this._lines.material.dispose();
    }
}
