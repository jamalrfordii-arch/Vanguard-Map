// conflictManager.js — Aerial proximity / conflict detection (TCAS-style CPA check)
//
// Pairwise closest-point-of-approach check across every live aircraft.
// Straight-line dead-reckoning only — no turn prediction — which is why
// CONFLICT.LOOKAHEAD_SEC (config.js) is capped at 5 minutes: beyond that the
// straight-line assumption stops meaning anything. This is advisory only,
// same philosophy as flightIntegrityManager.js's flags: an indicator for
// analyst review, never a real ATC separation tool.
//
// Two-speed design:
//   • evaluate(aircraftList) — O(n²) pairwise CPA math, run on a timer
//     (CONFLICT.TICK_MS) from main.js, NOT every frame. Returns newly
//     triggered pairs so main.js can fire alerts without re-deriving "is
//     this new" itself.
//   • updateVisuals(aircraftByIcao) — cheap, run every frame: just moves the
//     connecting line for whatever pairs are already flagged. Never touches
//     the O(n²) math.
//
// A pair stays flagged for CONFLICT.GRACE_MS after it stops triggering, so
// it doesn't flicker in and out right at the threshold edge.
//
// Console: window.vg1Conflicts.all() / .flagged() / .getRecord(key)

import * as THREE from 'three';
import { LineMaterial }         from 'three/addons/lines/LineMaterial.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineSegments2 }        from 'three/addons/lines/LineSegments2.js';
import viewport from './viewport.js';   // map rect (was window.innerWidth/Height)
import { CONFLICT } from './config.js';
import { simClock } from './simClock.js';
import { pairKey, evaluatePair, forEachCandidatePair } from './conflictMath.js';

const SEVERITY_COLOR = { CRITICAL: 0xff1744, ADVISORY: 0xff8c00 };

function _resolutionVec() {
    return new THREE.Vector2(viewport.bufferWidth(), viewport.bufferHeight());
}

class ConflictManager {
    constructor(scene) {
        this._pairs = new Map();  // pairKey → record
        this._dirty = false;

        // ── Visual: one dynamic line per active pair, connecting the two
        // aircraft. Same depthTest/AdditiveBlending convention as
        // altitudeDeckManager.js — respects the depth buffer so terrain and
        // other aircraft occlude it normally, doesn't draw through everything.
        this.scene = scene || null;
        this.group = new THREE.Group();
        this.group.name = 'aerialConflicts';
        if (scene) scene.add(this.group);
        this._lines = new Map(); // pairKey → { mesh, material }
        // On-map conflict LINES disabled (2026-07-24, Jamal: the web of red/orange
        // links confused users). Detection still runs — pair data stays available
        // via all()/flagged()/forAircraft() for card readouts, alerts, and badges.
        // Flip window.vg1Conflicts._drawLines = true to bring the lines back.
        this._drawLines = false;

        this._onResize = () => {
            const res = _resolutionVec();
            for (const { material } of this._lines.values()) material.resolution?.copy(res);
        };
        if (typeof window !== 'undefined') {
        // Subscribe to viewport, not window 'resize'. The resolution uniform is in
        // DRAWING-BUFFER pixels, which change on window resize, on layout change
        // (dock/rails), AND on a runtime pixel-ratio nudge from the FPS monitor.
        // Only viewport sees all three.
            this._offResize = viewport.onChange(this._onResize);
            window.vg1Conflicts = this;
        }
    }

    // ── Detection (timer cadence, broad-phase + CPA) ─────────────────────────
    // aircraftList: array of flightManager.aircraft values — needs icao24,
    // callsign, latDeg, lonDeg, altMeters, speedKts, headingDeg, verticalRateMs.
    //
    // Was all-pairs O(n²) — 300 aircraft = 44,850 evaluatePair() calls per tick,
    // measured 85ms avg / 197ms worst, the largest single stutter source in the
    // app. forEachCandidatePair() applies a conservative separation bound first
    // (see conflictMath.js): it can admit pairs that turn out fine, it can never
    // reject a real conflict, so results are identical to the brute-force version.
    // tests/conflictBroadPhase.test.mjs fuzzes the two against each other.
    evaluate(aircraftList) {
        const now = simClock.now();
        const live = aircraftList.filter(a =>
            a.speedKts >= CONFLICT.MIN_SPEED_KTS && a.latDeg != null && a.lonDeg != null);

        const triggered = new Set();
        const newPairs = [];

        this._lastPairsConsidered = forEachCandidatePair(live, CONFLICT, (a, b) => {
            const result = evaluatePair(a, b);
            if (!result) return;

            const key = pairKey(a.icao24, b.icao24);
            triggered.add(key);
            const wasActive = this._pairs.has(key);
            const record = {
                key, a: a.icao24, b: b.icao24,
                callsignA: a.callsign, callsignB: b.callsign,
                ...result,
                lastTriggered: now,
            };
            this._pairs.set(key, record);
            if (!wasActive) { this._dirty = true; newPairs.push(record); }
        });

        // Grace-period expiry — only drop pairs that have been silent for
        // GRACE_MS, so a pair right at the threshold edge doesn't flicker.
        for (const [key, rec] of this._pairs) {
            if (!triggered.has(key) && now - rec.lastTriggered > CONFLICT.GRACE_MS) {
                this._pairs.delete(key);
                this._dirty = true;
            }
        }

        this._broadcastIfDirty();
        return newPairs;
    }

    // ── Visuals (every-frame cadence, cheap — only touches active pairs) ────
    // aircraftByIcao: a Map (or Map-like .get) from icao24 → object with a
    // .currentPos THREE.Vector3 — flightManager.aircraft satisfies this directly.
    updateVisuals(aircraftByIcao) {
        if (!this.scene) return;

        // Lines suppressed by default (see _drawLines in constructor). Detection
        // keeps running; we just don't draw the connecting links. Clean up any
        // lines that may already exist, then bail before creating more.
        if (!this._drawLines) {
            if (this._lines.size) for (const key of [...this._lines.keys()]) this._removeLine(key);
            return;
        }

        for (const key of this._lines.keys()) {
            if (!this._pairs.has(key)) this._removeLine(key);
        }

        for (const rec of this._pairs.values()) {
            const oa = aircraftByIcao.get(rec.a);
            const ob = aircraftByIcao.get(rec.b);
            if (!oa || !ob) { this._removeLine(rec.key); continue; }

            let entry = this._lines.get(rec.key);
            if (!entry) entry = this._createLine(rec.key);

            const positions = new Float32Array([
                oa.currentPos.x, oa.currentPos.y, oa.currentPos.z,
                ob.currentPos.x, ob.currentPos.y, ob.currentPos.z,
            ]);
            entry.mesh.geometry.setPositions(positions);
            entry.material.color.set(SEVERITY_COLOR[rec.severity] ?? SEVERITY_COLOR.ADVISORY);
        }
    }

    _createLine(key) {
        const geo = new LineSegmentsGeometry();
        geo.setPositions(new Float32Array(6)); // updated immediately after creation
        const mat = new LineMaterial({
            color: SEVERITY_COLOR.ADVISORY,
            linewidth: 1.8,
            transparent: true,
            opacity: 0.6,
            depthWrite: false,
            depthTest: true,   // same reasoning as altitudeDeckManager.js — respect normal depth occlusion
            blending: THREE.AdditiveBlending,
            resolution: _resolutionVec(),
        });
        const mesh = new LineSegments2(geo, mat);
        mesh.frustumCulled = false;
        mesh.renderOrder = 5;
        this.group.add(mesh);
        const entry = { mesh, material: mat };
        this._lines.set(key, entry);
        return entry;
    }

    _removeLine(key) {
        const entry = this._lines.get(key);
        if (!entry) return;
        this.group.remove(entry.mesh);
        entry.mesh.geometry.dispose();
        entry.material.dispose();
        this._lines.delete(key);
    }

    _broadcastIfDirty() {
        if (!this._dirty || typeof window === 'undefined') return;
        this._dirty = false;
        window.dispatchEvent(new CustomEvent('vg1:conflictChanged'));
    }

    // ── Read API ──────────────────────────────────────────────────────────────
    all()      { return [...this._pairs.values()].sort((a, b) => a.etaSec - b.etaSec); }
    flagged()  { return this.all().filter(r => r.severity === 'CRITICAL'); }
    getRecord(key) { return this._pairs.get(key) || null; }
    // Every active pair involving this icao24 — used to badge a selected aircraft.
    forAircraft(icao24) { return this.all().filter(r => r.a === icao24 || r.b === icao24); }

    disconnect() {
        this._offResize?.();
        for (const key of [...this._lines.keys()]) this._removeLine(key);
    }
}

export { ConflictManager, pairKey };
