// measureManager.js — Distance/bearing measurement tool.
//
// Two-click ruler: click point A, click point B, get real great-circle
// distance (nm/km) and initial bearing (deg true), computed with the same
// haversine/bearing math dataSource.js already uses for port-call distance
// checks — not screen-pixel distance. Renders a line + label between the
// two picked points so the measurement is visible on the map, not just a
// number in a panel.
//
// This module is intentionally pick-agnostic: it does NOT import
// uiController.js (which owns requestMapPick/the click raycasting) because
// uiController needs to import *this* module to wire the MEASURE button —
// importing each other would be a cycle. Instead uiController drives the
// two-click flow and calls submitPointA()/submitPointB() with the results.
// See CLAUDE.md's dependency policy: "do not create import cycles."
//
// Follows the CLAUDE.md dependency policy: true singleton export (Tier 3 —
// window.vg1Measure is a debug mirror only, never the data path), no new
// load-bearing globals.

import * as THREE from 'three';
import { haversineNm, bearingDeg } from './dataSource.js';

const NM_TO_KM = 1.852;

function _makeLabelTex(text) {
    const W = 320, H = 64;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    ctx.font         = 'bold 20px Courier New';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    ctx.shadowBlur  = 0;
    ctx.strokeStyle = 'rgba(0, 4, 12, 0.90)';
    ctx.lineWidth   = 4;
    ctx.lineJoin    = 'round';
    ctx.strokeText(text, W / 2, H / 2);

    ctx.shadowColor = '#ffd54a';
    ctx.shadowBlur  = 8;
    ctx.fillStyle   = '#ffd54a';
    ctx.fillText(text, W / 2, H / 2);
    ctx.shadowBlur  = 0;
    ctx.fillStyle   = '#fff6da';
    ctx.fillText(text, W / 2, H / 2);

    return new THREE.CanvasTexture(canvas);
}

function _makeMarker(color) {
    const geo = new THREE.RingGeometry(0.9, 1.3, 32);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.85,
        depthWrite: false, side: THREE.DoubleSide,
    });
    return new THREE.Mesh(geo, mat);
}

export class MeasureManager {
    constructor() {
        this._scene    = null;
        this._active   = false;   // true while waiting on a pick (A or B)
        this._pointA   = null;    // { point: Vector3, lon, lat }
        this._pointB   = null;
        this._markerA  = null;
        this._markerB  = null;
        this._line     = null;
        this._label    = null;
        this._result   = null;    // last completed measurement, see _finish()
        this._onChange = null;    // optional UI callback(state)
    }

    // Register a callback fired on every state transition (arm A / arm B /
    // complete / clear) so the UI can update button text + readout without
    // this module knowing about DOM at all.
    onChange(cb) { this._onChange = cb; }

    _notify(phase) {
        if (this._onChange) this._onChange({ phase, result: this._result });
    }

    isActive() { return this._active; }
    current()  { return this._result; }

    // Begin (or restart) a measurement. Clears any prior visuals first.
    // Caller (uiController) is responsible for arming the first requestMapPick
    // and routing its result into submitPointA().
    start(scene) {
        this.clear();
        this._scene  = scene;
        this._active = true;
        this._notify('arm-a');
    }

    cancel() {
        this._active = false;
        this._notify('cancel');
    }

    clear() {
        if (this._scene) {
            if (this._markerA) { this._scene.remove(this._markerA); this._markerA.geometry.dispose(); this._markerA.material.dispose(); }
            if (this._markerB) { this._scene.remove(this._markerB); this._markerB.geometry.dispose(); this._markerB.material.dispose(); }
            if (this._line)    { this._scene.remove(this._line);    this._line.geometry.dispose();    this._line.material.dispose(); }
            if (this._label)   { this._scene.remove(this._label);   this._label.material.map?.dispose(); this._label.material.dispose(); }
        }
        this._markerA = this._markerB = this._line = this._label = null;
        this._pointA  = this._pointB  = null;
        this._result  = null;
        this._active  = false;
        this._notify('clear');
    }

    // pick: { point: THREE.Vector3, lon, lat } — shape returned by
    // uiController's requestMapPick callback.
    submitPointA(pick) {
        if (!this._active || !this._scene) return;
        this._pointA  = pick;
        this._markerA = _makeMarker(0x40c4ff);
        this._markerA.position.copy(pick.point).setY(pick.point.y + 0.35);
        this._scene.add(this._markerA);
        this._notify('arm-b');
    }

    submitPointB(pick) {
        if (!this._active || !this._scene || !this._pointA) return;
        this._pointB  = pick;
        this._markerB = _makeMarker(0xffd54a);
        this._markerB.position.copy(pick.point).setY(pick.point.y + 0.35);
        this._scene.add(this._markerB);
        this._finish();
    }

    _finish() {
        const a = this._pointA, b = this._pointB;
        const distanceNm = haversineNm(a.lat, a.lon, b.lat, b.lon);
        const brg        = bearingDeg(a.lat, a.lon, b.lat, b.lon);

        // Line between the two scene points, lifted slightly off the terrain
        // so it doesn't z-fight (same offset convention as the alert-zone disk).
        const geo = new THREE.BufferGeometry().setFromPoints([
            a.point.clone().setY(a.point.y + 0.35),
            b.point.clone().setY(b.point.y + 0.35),
        ]);
        const mat = new THREE.LineDashedMaterial({
            color: 0xffd54a, transparent: true, opacity: 0.9,
            dashSize: 1.2, gapSize: 0.6,
        });
        this._line = new THREE.Line(geo, mat);
        this._line.computeLineDistances();
        this._scene.add(this._line);

        const mid = a.point.clone().add(b.point).multiplyScalar(0.5).setY(Math.max(a.point.y, b.point.y) + 2.2);
        const labelText = `${distanceNm.toFixed(1)} NM · BRG ${brg.toFixed(0).padStart(3, '0')}°`;
        const tex = _makeLabelTex(labelText);
        const spriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
        this._label = new THREE.Sprite(spriteMat);
        this._label.scale.set(8, 1.6, 1);
        this._label.position.copy(mid);
        this._label.renderOrder = 5;
        this._scene.add(this._label);

        this._result = {
            aLat: a.lat, aLon: a.lon,
            bLat: b.lat, bLon: b.lon,
            distanceNm, distanceKm: distanceNm * NM_TO_KM,
            bearingDeg: brg,
        };
        this._active = false;
        this._notify('complete');
    }
}

export const measureManager = new MeasureManager();
window.vg1Measure = measureManager; // debug mirror only — see CLAUDE.md Tier 3 policy
