// chokepointManager.js — Diamond landmark system for strategic maritime chokepoints.
//
// Visual language: diamond glyph (NATO tactical point-of-interest symbol)
// with a 3-letter identifier code, floating name label, and count badge.
// No world-space rings — the diamond is a point marker, not a territory.
//
// ── State machine ──────────────────────────────────────────────────────────────
//   DORMANT  — no vessels in bounding box
//              dim outline, barely visible, no label brightness
//   ACTIVE   — vessels present, normal traffic
//              cyan, full glyph, count badge, 4 cardinal ticks
//   ALERT    — dark vessel in box  OR  vessel count ≥ ALERT_COUNT (6)
//              amber, pip at top vertex, slight diamond fill
//   CLOSURE  — stopped/anchored vessel (speed < 2 kts) in box
//              OR hostile/military vessel in box
//              OR 2+ dark vessels in box
//              OR vessel count ≥ CLOSURE_COUNT (10)
//              red, pips at all 4 vertices, stronger fill, BLINKS at ~1 Hz
//
// The hit disc on each landmark stores live state/count fields so uiController
// can attach them to a targeted SITREP when the user clicks.

import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT } from './config.js';

// ── Thresholds ────────────────────────────────────────────────────────────────
const ALERT_COUNT   = 6;
const CLOSURE_COUNT = 10;
const STOPPED_KTS   = 2;   // ≤ this speed → vessel is considered stopped/anchored

// ── 3-letter identifiers ──────────────────────────────────────────────────────
const CP_CODES = {
    'STRAIT OF HORMUZ':    'HOR',
    'STRAIT OF MALACCA':   'MAL',
    'BAB-EL-MANDEB':       'BAB',
    'SUEZ CANAL':          'SUE',
    'STRAIT OF GIBRALTAR': 'GIB',
    'ENGLISH CHANNEL':     'ENG',
    'DANISH STRAITS':      'DAN',
    'TAIWAN STRAIT':       'TWN',
    'LUZON STRAIT':        'LUZ',
    'CAPE OF GOOD HOPE':   'CGH',
    'DRAKE PASSAGE':       'DRK',
};

// ── Color palette per state ───────────────────────────────────────────────────
const STATE_COLOR = {
    dormant: '#1e3a48',
    active:  '#40c4ff',
    alert:   '#ffaa00',
    closure: '#ff1744',
};

// ── Mercator lon/lat → scene x/z ─────────────────────────────────────────────
function _lonLatToScene(lon, lat) {
    const x      = (lon / 180.0) * (MAP_WIDTH  / 2.0);
    const latRad = lat * (Math.PI / 180.0);
    const mercY  = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
    const z      = -(mercY / Math.PI) * (MAP_HEIGHT / 2.0);
    return { x, z };
}

// ── State classifier ──────────────────────────────────────────────────────────
function _classifyState(count, darkCount, stoppedCount) {
    if (stoppedCount > 0 || darkCount >= 2 || count >= CLOSURE_COUNT) {
        return 'closure';
    }
    if (darkCount >= 1 || count >= ALERT_COUNT) {
        return 'alert';
    }
    if (count > 0) {
        return 'active';
    }
    return 'dormant';
}

// ── Diamond glyph texture ─────────────────────────────────────────────────────
// Outer diamond → inner diamond → center dot → cardinal ticks → alert pips → code.
// State controls: which pips appear, fill opacity, glow intensity, line weight.
function _makeGlyphTex(code, colorStr, state) {
    const S = 128, cx = 64, cy = 64;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = S;
    const ctx = canvas.getContext('2d');

    const R  = 30;   // outer diamond half-size
    const Ri = 19;   // inner diamond half-size
    const isDormant = state === 'dormant';
    const isClosure = state === 'closure';
    const isAlert   = state === 'alert';

    ctx.strokeStyle = colorStr;
    ctx.fillStyle   = colorStr;

    // ── Faint fill — alert / closure only ──────────────────────────────────────
    if (!isDormant) {
        const fillAlpha = isClosure ? '1a' : isAlert ? '10' : '00';
        if (fillAlpha !== '00') {
            ctx.fillStyle = colorStr + fillAlpha;
            ctx.shadowColor = 'transparent';
            ctx.beginPath();
            ctx.moveTo(cx,     cy - R);
            ctx.lineTo(cx + R, cy    );
            ctx.lineTo(cx,     cy + R);
            ctx.lineTo(cx - R, cy    );
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = colorStr;
        }
    }

    // ── Outer diamond ──────────────────────────────────────────────────────────
    ctx.shadowColor = colorStr;
    ctx.shadowBlur  = isDormant ? 2 : isClosure ? 12 : 7;
    ctx.lineWidth   = isClosure ? 2.5 : isDormant ? 1.2 : 1.8;
    ctx.globalAlpha = isDormant ? 0.5 : 1;
    ctx.strokeStyle = colorStr;
    ctx.beginPath();
    ctx.moveTo(cx,     cy - R);
    ctx.lineTo(cx + R, cy    );
    ctx.lineTo(cx,     cy + R);
    ctx.lineTo(cx - R, cy    );
    ctx.closePath();
    ctx.stroke();

    // ── Inner diamond ──────────────────────────────────────────────────────────
    if (!isDormant) {
        ctx.shadowBlur  = 4;
        ctx.lineWidth   = 1;
        ctx.globalAlpha = 0.50;
        ctx.beginPath();
        ctx.moveTo(cx,      cy - Ri);
        ctx.lineTo(cx + Ri, cy     );
        ctx.lineTo(cx,      cy + Ri);
        ctx.lineTo(cx - Ri, cy     );
        ctx.closePath();
        ctx.stroke();
        ctx.globalAlpha = 1;
    }

    // ── Center dot ────────────────────────────────────────────────────────────
    ctx.shadowBlur = isDormant ? 4 : 9;
    ctx.globalAlpha = isDormant ? 0.6 : 1;
    ctx.fillStyle = colorStr;
    ctx.beginPath();
    ctx.arc(cx, cy, isDormant ? 2 : 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // ── Cardinal ticks ────────────────────────────────────────────────────────
    if (!isDormant) {
        const tS = R + 3, tE = R + 12;
        ctx.shadowBlur = 5;
        ctx.lineWidth  = 1.5;
        ctx.strokeStyle = colorStr;
        // Top
        ctx.beginPath(); ctx.moveTo(cx, cy - tS); ctx.lineTo(cx, cy - tE); ctx.stroke();
        // Bottom
        ctx.beginPath(); ctx.moveTo(cx, cy + tS); ctx.lineTo(cx, cy + tE); ctx.stroke();
        // Right
        ctx.beginPath(); ctx.moveTo(cx + tS, cy); ctx.lineTo(cx + tE, cy); ctx.stroke();
        // Left
        ctx.beginPath(); ctx.moveTo(cx - tS, cy); ctx.lineTo(cx - tE, cy); ctx.stroke();
    }

    // ── Alert pips ────────────────────────────────────────────────────────────
    const pipR = isClosure ? 4.5 : 3.5;
    const pipY = cy - R - 13;
    if (isAlert) {
        // Single pip at top vertex — "something flagged here"
        ctx.shadowBlur = 8;
        ctx.fillStyle  = colorStr;
        ctx.beginPath();
        ctx.arc(cx, pipY, pipR, 0, Math.PI * 2);
        ctx.fill();
    } else if (isClosure) {
        // Pips at all 4 cardinal tips — "passage at risk"
        ctx.shadowBlur = 12;
        ctx.fillStyle  = colorStr;
        [
            [cx,         cy - R - 13],
            [cx,         cy + R + 13],
            [cx + R + 13, cy        ],
            [cx - R - 13, cy        ],
        ].forEach(([px, py]) => {
            ctx.beginPath();
            ctx.arc(px, py, pipR, 0, Math.PI * 2);
            ctx.fill();
        });
    }

    // ── 3-letter code ─────────────────────────────────────────────────────────
    if (!isDormant) {
        ctx.shadowBlur   = 6;
        ctx.fillStyle    = colorStr;
        ctx.font         = `bold 14px Courier New`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(code, cx, cy);
        ctx.shadowBlur   = 0;
        ctx.fillStyle    = '#e8f4ff';
        ctx.fillText(code, cx, cy);
    }

    ctx.shadowBlur  = 0;
    ctx.globalAlpha = 1;
    return new THREE.CanvasTexture(canvas);
}

// ── Name label texture ────────────────────────────────────────────────────────
// stressed = true adds a glowing 2 px underline (Plan 03 strait stress indicator).
// Fires when state is 'alert' or 'closure' — anomaly_ratio > 10% within bounds.
function _makeNameTex(name, colorStr, stressed = false) {
    const W = 280, H = 42;   // extra 4 px height for underline clearance
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx    = canvas.getContext('2d');

    ctx.font         = 'bold 12px Courier New';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    // Dark outline — rendered first so it sits behind the coloured text.
    ctx.shadowBlur   = 0;
    ctx.strokeStyle  = 'rgba(0, 4, 12, 0.90)';
    ctx.lineWidth    = 3;
    ctx.lineJoin     = 'round';
    ctx.strokeText(name, W / 2, H / 2 - 2);

    // Coloured glow pass
    ctx.shadowColor  = colorStr;
    ctx.shadowBlur   = 7;
    ctx.fillStyle    = colorStr;
    ctx.fillText(name, W / 2, H / 2 - 2);
    // Bright white fill on top
    ctx.shadowBlur   = 0;
    ctx.fillStyle    = '#d8eaf8';
    ctx.fillText(name, W / 2, H / 2 - 2);

    // Strait stress underline — 2 px line below text, colored + glowing
    if (stressed) {
        const tw = ctx.measureText(name).width;
        const lx = W / 2 - tw / 2 - 2;
        const rx = W / 2 + tw / 2 + 2;
        const ly = H / 2 + 8;
        ctx.shadowColor  = colorStr;
        ctx.shadowBlur   = 5;
        ctx.strokeStyle  = colorStr;
        ctx.lineWidth    = 2;
        ctx.beginPath();
        ctx.moveTo(lx, ly);
        ctx.lineTo(rx, ly);
        ctx.stroke();
        ctx.shadowBlur   = 0;
    }

    return new THREE.CanvasTexture(canvas);
}

// ── Count badge texture ───────────────────────────────────────────────────────
function _makeCountTex(count, colorStr) {
    const S = 56;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = S;
    const ctx = canvas.getContext('2d');
    const fontSize = count >= 100 ? 16 : count >= 10 ? 20 : 22;

    ctx.font         = `bold ${fontSize}px Courier New`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor  = colorStr;
    ctx.shadowBlur   = 9;
    ctx.fillStyle    = colorStr;
    ctx.fillText(String(count), S / 2, S / 2);
    ctx.shadowBlur   = 0;
    ctx.fillStyle    = '#ffffff';
    ctx.fillText(String(count), S / 2, S / 2);

    return new THREE.CanvasTexture(canvas);
}

// ── ChokepointManager ─────────────────────────────────────────────────────────
export class ChokepointManager {
    constructor(scene, chokepoints) {
        this.scene      = scene;
        this._landmarks = [];
        this._hitMeshes = [];

        chokepoints.forEach(cp => {
            const code      = CP_CODES[cp.name] ?? cp.name.slice(0, 3).toUpperCase();
            const centerLat = (cp.latMin + cp.latMax) / 2;
            const centerLon = (cp.lonMin + cp.lonMax) / 2;
            const { x, z }  = _lonLatToScene(centerLon, centerLat);
            // Phase 2 hybrid: anchor chokepoint glyph to actual terrain.
            // Most chokepoints (Hormuz, Malacca, Bab-el-Mandeb) are over water
            // → terrain = 0 → groundY = 0.5 like before. Inland/elevated
            // chokepoints now rise correctly with the land underneath them.
            const terrainY  = window.terrainHeight?.sampleTerrainHeightXZ?.(x, z) ?? 0;
            const groundY   = Math.max(0, terrainY) + 0.5;

            // ── Glyph sprite ────────────────────────────────────────────────────
            const glyphTex = _makeGlyphTex(code, STATE_COLOR.dormant, 'dormant');
            const glyphMat = new THREE.SpriteMaterial({
                map: glyphTex, transparent: true, opacity: 0.35, depthTest: false,
            });
            const glyphSprite = new THREE.Sprite(glyphMat);
            glyphSprite.scale.set(6, 6, 1);
            glyphSprite.position.set(x, groundY + 1.2, z);
            glyphSprite.renderOrder = 10;
            scene.add(glyphSprite);

            // ── Name label ──────────────────────────────────────────────────────
            const nameTex = _makeNameTex(cp.name, STATE_COLOR.dormant);
            const nameMat = new THREE.SpriteMaterial({
                map: nameTex, transparent: true, opacity: 0.28, depthTest: false,
            });
            const nameSprite = new THREE.Sprite(nameMat);
            nameSprite.scale.set(15, 2.0, 1);
            nameSprite.position.set(x, groundY + 6.2, z);
            nameSprite.renderOrder = 999;
            scene.add(nameSprite);

            // ── Count badge ─────────────────────────────────────────────────────
            // Positioned upper-right of the glyph center — approximates the
            // top-right corner of the diamond for standard overhead camera angles.
            const countTex = _makeCountTex(0, STATE_COLOR.active);
            const countMat = new THREE.SpriteMaterial({
                map: countTex, transparent: true, opacity: 0, depthTest: false,
            });
            const countSprite = new THREE.Sprite(countMat);
            countSprite.scale.set(2.8, 2.8, 1);
            countSprite.position.set(x + 2.8, groundY + 4.8, z - 0.5);
            countSprite.renderOrder = 999;
            scene.add(countSprite);

            // ── Invisible hit disc ──────────────────────────────────────────────
            const hitMesh = new THREE.Mesh(
                new THREE.CircleGeometry(5.5, 32),
                new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
            );
            hitMesh.rotation.x = -Math.PI / 2;
            hitMesh.position.set(x, groundY, z);
            hitMesh.userData.chokepointName  = cp.name;
            hitMesh.userData.chokepointCode  = code;
            hitMesh.userData.chokepointData  = cp;
            hitMesh.userData.isChokepoint    = true;
            // Live fields updated by tick() — read by uiController for SITREP
            hitMesh.userData.chokepointState = 'dormant';
            hitMesh.userData.chokepointCount = 0;
            hitMesh.userData.chokepointDark  = 0;
            scene.add(hitMesh);
            this._hitMeshes.push(hitMesh);

            this._landmarks.push({
                cp, code, x, z,
                glyphSprite, glyphMat,
                nameSprite,  nameMat,
                countSprite, countMat,
                hitMesh,
                lastState:     'dormant',
                lastCount:     -1,
                blinkTimer:    Math.random() * 2,   // stagger initial blink phase
                breatheOffset: Math.random() * Math.PI * 2,
            });
        });
    }

    // Chokepoint glyphs are coloured by VESSEL density, so they're tied to the AIS
    // vessel layer — hidden when it's off (and raycast hits suppressed too).
    setVisible(on) {
        this._hidden = !on;
        this._landmarks.forEach(lm => {
            lm.glyphSprite.visible = on;
            lm.nameSprite.visible  = on;
            lm.countSprite.visible = on;
            lm.hitMesh.visible     = on;
        });
    }

    tick(delta, elapsed, aisShips) {
        if (this._hidden) return;
        this._landmarks.forEach(lm => {
            // ── Classify vessels in this chokepoint ──────────────────────────────
            let count = 0, darkCount = 0, stoppedCount = 0;

            for (let i = 0, n = aisShips.length; i < n; i++) {
                const ship = aisShips[i];
                if (!ship.userData.isRealAIS) continue;
                const lat = ship.userData.latDeg, lon = ship.userData.lonDeg;
                if (lat == null) continue;
                if (lat < lm.cp.latMin || lat > lm.cp.latMax ||
                    lon < lm.cp.lonMin || lon > lm.cp.lonMax) continue;

                count++;
                if (ship.userData.isDark)                                          darkCount++;
                if ((ship.userData.speedKts ?? 99) <= STOPPED_KTS && !ship.userData.isDark) stoppedCount++;
            }

            const state    = _classifyState(count, darkCount, stoppedCount);
            const colorStr = STATE_COLOR[state];
            const active   = state !== 'dormant';

            // ── Rebuild textures when state or count changes ─────────────────────
            const stateChanged = state !== lm.lastState;
            const countChanged = count !== lm.lastCount;

            if (stateChanged) {
                // Glyph
                if (lm.glyphMat.map) lm.glyphMat.map.dispose();
                lm.glyphMat.map         = _makeGlyphTex(lm.code, colorStr, state);
                lm.glyphMat.needsUpdate = true;
                // Name label — stressed underline when anomaly_ratio > 10% (alert/closure)
                const stressed = state === 'alert' || state === 'closure';
                if (lm.nameMat.map) lm.nameMat.map.dispose();
                lm.nameMat.map         = _makeNameTex(lm.cp.name, colorStr, stressed);
                lm.nameMat.needsUpdate = true;
                // Glyph scale: small bump for alert/closure
                const sz = state === 'closure' ? 7.5 : state === 'alert' ? 6.8 : 6.0;
                lm.glyphSprite.scale.set(sz, sz, 1);

                lm.lastState = state;
            }

            if (stateChanged || countChanged) {
                if (lm.countMat.map) lm.countMat.map.dispose();
                lm.countMat.map         = _makeCountTex(count, colorStr);
                lm.countMat.needsUpdate = true;
                lm.countMat.opacity     = active ? 0.92 : 0;
                lm.lastCount = count;
            }

            // ── Update hit mesh userData for click handler ───────────────────────
            lm.hitMesh.userData.chokepointState = state;
            lm.hitMesh.userData.chokepointCount = count;
            lm.hitMesh.userData.chokepointDark  = darkCount;

            // ── Drive opacity ─────────────────────────────────────────────────────
            if (state === 'closure') {
                // Square-wave blink at ~1 Hz — matches dark vessel marker rhythm
                lm.blinkTimer += delta;
                const blinkOn = (Math.floor(lm.blinkTimer * 1.1) % 2 === 0);
                lm.glyphMat.opacity = blinkOn ? 0.95 : 0.28;
                lm.nameMat.opacity  = blinkOn ? 0.90 : 0.45;
            } else if (active) {
                // Slow breathe — staggered so each chokepoint feels independent
                const breathe       = Math.sin(elapsed * 1.0 + lm.breatheOffset) * 0.5 + 0.5;
                lm.glyphMat.opacity = 0.72 + breathe * 0.20;   // 0.72 – 0.92
                lm.nameMat.opacity  = 0.80;
            } else {
                // Dormant — barely present
                lm.glyphMat.opacity = 0.28;
                lm.nameMat.opacity  = 0.22;
            }
        });
    }

    getHitMeshes() { return this._hitMeshes; }

    dispose() {
        this._landmarks.forEach(lm => {
            [lm.glyphSprite, lm.nameSprite, lm.countSprite].forEach(obj => {
                this.scene.remove(obj);
                if (obj.material?.map) obj.material.map.dispose();
                if (obj.material)      obj.material.dispose();
            });
            this.scene.remove(lm.hitMesh);
            lm.hitMesh.geometry.dispose();
            lm.hitMesh.material.dispose();
        });
        this._landmarks = [];
        this._hitMeshes = [];
    }
}
