// beaufortWarningManager.js — Beaufort wind-warning contour layer.
//
// Reads the SAME live GFS wind field as the wind-streak layer (via the wind
// manager's public windAt(lon,lat)), thresholds it at the WMO/Beaufort warning
// limits, and draws glowing contour outlines where wind crosses each tier:
//
//   GALE      34 kt  (Beaufort 8-9)   — soft warm-white glow
//   STORM     48 kt  (Beaufort 10-11) — amber-orange
//   HURRICANE 64 kt  (Beaufort 12)    — hot red
//
// Temperature ramp: cool at the calm outer edge, hot toward the dangerous core,
// so a glance reads severity by heat. Outlines (not filled) so the wind streaks
// stay vivid underneath — toggle this on over the live wind and you watch the
// streaks spiral in while the warning zones bloom over them.
//
// DERIVED, NON-AUTHORITATIVE: thresholds applied to a public forecast model,
// not an official met-service warning product. Wind data: NOAA GFS via
// Open-Meteo. Independent layer toggle ('wind-warnings').

import * as THREE from 'three';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineSegments2 }        from 'three/addons/lines/LineSegments2.js';
import { LineMaterial }         from 'three/addons/lines/LineMaterial.js';
import { MAP_WIDTH, MAP_HEIGHT } from './config.js';
import { legendManager } from './legendManager.js';

const KT      = 0.514444;   // m/s per knot
const Y       = 5.2;        // render height — just above the surface wind streaks
const RES_DEG = 2.5;        // sampling grid resolution (degrees)
const LAT_LIM = 84;         // Mercator pole clamp

// Severity ramp — redundantly encoded so it reads over the busy map: heat +
// brightness + line thickness + (hurricane only) a pulse. Hurricane is hot
// magenta — complementary to ocean blue, so it pops where red drowned.
// core === glow === legend swatch colour, so the rendered contour reads as the
// exact hue shown in the MAP KEYS panel (additive core over a same-hue halo).
const TIERS = [
    { name: 'GALE',      kt: 34, mps: 34 * KT, beaufort: '8–9',   core: 0x9fd0ff, glow: 0x9fd0ff, w: 2.0, pulse: 0 },
    { name: 'STORM',     kt: 48, mps: 48 * KT, beaufort: '10–11', core: 0xff9e2a, glow: 0xff9e2a, w: 3.0, pulse: 0 },
    { name: 'HURRICANE', kt: 64, mps: 64 * KT, beaufort: '12',    core: 0xff2aa0, glow: 0xff2aa0, w: 4.6, pulse: 1 },
];

function lonLatToScene(lon, lat) {
    const x = (lon / 180) * (MAP_WIDTH / 2);
    const l = Math.max(-LAT_LIM, Math.min(LAT_LIM, lat)) * Math.PI / 180;
    const mercY = Math.log(Math.tan(Math.PI / 4 + l / 2));
    const z = -(mercY / Math.PI) * (MAP_HEIGHT / 2);
    return [x, z];
}

export class BeaufortWarningManager {
    constructor(scene) {
        this.group = new THREE.Group();
        this.group.name = 'windWarnings';
        this.group.visible = false;          // off until toggled
        this.group.renderOrder = 95;         // above wind streaks, below HUD
        scene.add(this.group);

        this._wind   = null;                 // windAt source (set via setWindSource)
        this._tiers  = [];                   // { glowMat, coreMat }
        this._lastBuild = 0;
        this._fillOpacity = 1.0;             // glow strength multiplier (live-tunable)
    }

    setWindSource(windManager) { this._wind = windManager; }

    setVisible(on) {
        this.group.visible = !!on;
        if (on) legendManager.show('wind-warnings', 'STORM WARNINGS · BEAUFORT', this._legendHTML());
        else    legendManager.hide('wind-warnings');
        if (on && (Date.now() - this._lastBuild > 1000)) this.rebuild();
    }

    // Legend body for the unified MAP KEYS panel (mirrors the GFS wind pattern).
    _legendHTML() {
        return legendManager.constructor.swatchRows([
            { label: 'HURRICANE · 64+ kt (B12)',   hex: '#ff2aa0' },
            { label: 'STORM · 48–63 kt (B10–11)',  hex: '#ff9e2a' },
            { label: 'GALE · 34–47 kt (B8–9)',     hex: '#9fd0ff' },
        ], 'derived from GFS · non-authoritative');
    }

    // Live tuning from DevTools: window.vg1Warnings.setGlow(1.5)
    setGlow(mult) {
        this._fillOpacity = Math.max(0, mult);
    }

    // ── Build contours from the current wind field ───────────────────────────
    rebuild() {
        if (!this._wind || typeof this._wind.windAt !== 'function') return;
        this._lastBuild = Date.now();

        // Sample the shared wind field onto a regular lon/lat grid (speed m/s).
        const cols = Math.round(360 / RES_DEG) + 1;
        const rows = Math.round((2 * LAT_LIM) / RES_DEG) + 1;
        const spd  = new Float32Array(cols * rows);
        for (let r = 0; r < rows; r++) {
            const lat = -LAT_LIM + r * RES_DEG;
            for (let c = 0; c < cols; c++) {
                const lon = -180 + c * RES_DEG;
                spd[r * cols + c] = this._wind.windAt(lon, lat).speed || 0;
            }
        }

        this._clear();
        const resW = (typeof window !== 'undefined') ? window.innerWidth  : 1920;
        const resH = (typeof window !== 'undefined') ? window.innerHeight : 1080;

        for (const tier of TIERS) {
            const pts = this._contour(spd, cols, rows, tier.mps);
            if (pts.length < 6) { this._tiers.push(null); continue; }

            const geo = new LineSegmentsGeometry();
            geo.setPositions(pts);

            const glowMat = new LineMaterial({
                color: tier.glow, linewidth: tier.w * 3, transparent: true,
                opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false,
            });
            const coreMat = new LineMaterial({
                color: tier.core, linewidth: tier.w, transparent: true,
                opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false,
            });
            glowMat.resolution.set(resW, resH);
            coreMat.resolution.set(resW, resH);

            const glow = new LineSegments2(geo, glowMat);
            const core = new LineSegments2(geo, coreMat);
            glow.computeLineDistances(); core.computeLineDistances();
            glow.renderOrder = 94; core.renderOrder = 96;
            this.group.add(glow, core);
            this._tiers.push({ glowMat, coreMat, tier });
        }
    }

    _clear() {
        while (this.group.children.length) {
            const c = this.group.children.pop();
            c.geometry?.dispose?.();
            c.material?.dispose?.();
        }
        this._tiers = [];
    }

    // ── Marching squares → flat [x1,y1,z1, x2,y2,z2, …] in scene space ───────
    _contour(grid, cols, rows, t) {
        const out = [];
        const at = (r, c) => grid[r * cols + c];
        const f  = (a, b) => { const d = b - a; return Math.abs(d) < 1e-6 ? 0.5 : Math.max(0, Math.min(1, (t - a) / d)); };
        const push = (p1, p2) => {
            // skip dateline-wrapping artifacts
            if (Math.abs(p1[0] - p2[0]) > 180) return;
            const a = lonLatToScene(p1[0], p1[1]);
            const b = lonLatToScene(p2[0], p2[1]);
            out.push(a[0], Y, a[1], b[0], Y, b[1]);
        };

        for (let r = 0; r < rows - 1; r++) {
            const lat0 = -LAT_LIM + r * RES_DEG, lat1 = lat0 + RES_DEG;
            for (let c = 0; c < cols - 1; c++) {
                const lon0 = -180 + c * RES_DEG, lon1 = lon0 + RES_DEG;
                const TL = at(r, c), TR = at(r, c + 1), BR = at(r + 1, c + 1), BL = at(r + 1, c);
                let k = 0;
                if (TL > t) k |= 8; if (TR > t) k |= 4; if (BR > t) k |= 2; if (BL > t) k |= 1;
                if (k === 0 || k === 15) continue;

                const T = [lon0 + RES_DEG * f(TL, TR), lat0];
                const R = [lon1, lat0 + RES_DEG * f(TR, BR)];
                const B = [lon0 + RES_DEG * f(BL, BR), lat1];
                const L = [lon0, lat0 + RES_DEG * f(TL, BL)];

                switch (k) {
                    case 1:  push(L, B); break;
                    case 2:  push(B, R); break;
                    case 3:  push(L, R); break;
                    case 4:  push(T, R); break;
                    case 5:  push(L, T); push(B, R); break;
                    case 6:  push(T, B); break;
                    case 7:  push(T, L); break;
                    case 8:  push(T, L); break;
                    case 9:  push(T, B); break;
                    case 10: push(T, R); push(L, B); break;
                    case 11: push(T, R); break;
                    case 12: push(L, R); break;
                    case 13: push(B, R); break;
                    case 14: push(L, B); break;
                }
            }
        }
        return out;
    }

    // Glow breathing — gentle on gale/storm, strong throb on hurricane so the
    // deadliest tier visibly pulses. elapsed in seconds.
    update(elapsed) {
        if (!this.group.visible) return;
        const calm  = 0.85 + 0.15 * Math.sin(elapsed * 1.4);
        const throb = 0.55 + 0.45 * Math.sin(elapsed * 3.0);   // ~0.5 Hz strong
        for (const t of this._tiers) {
            if (!t) continue;
            if (t.tier.pulse) {
                t.glowMat.opacity = (0.20 + 0.18 * throb) * this._fillOpacity;
                t.coreMat.opacity = 0.65 + 0.35 * throb;
            } else {
                t.glowMat.opacity = 0.16 * calm * this._fillOpacity;
                t.coreMat.opacity = 0.95;
            }
        }
    }

    onResize(w, h) {
        for (const t of this._tiers) {
            if (!t) continue;
            t.glowMat.resolution.set(w, h);
            t.coreMat.resolution.set(w, h);
        }
    }

    // ── Hover + pin interaction ──────────────────────────────────────────────
    // Hover the storm zone (not the hairline) → a card with the LIVE wind speed
    // and tier at the cursor. Double-click → a pinned card you can minimize/close.
    initInteraction(camera, renderer) {
        this._cam   = camera;
        // Pick against the plane the contours actually live on (Y = render
        // height), not the sea surface — otherwise oblique views sample wind at
        // a parallax-shifted spot and the storm never registers under the cursor.
        this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -Y);
        this._ray   = new THREE.Raycaster();
        this._hover = this._makeHoverCard();
        this._pins  = 0;
        const el = renderer.domElement;
        el.addEventListener('mousemove', (e) => this._onMove(e, el));
        el.addEventListener('dblclick',  (e) => this._onDbl(e, el), true);  // capture: beat camera focus
    }

    _sceneToLonLat(x, z) {
        const lon   = (x / (MAP_WIDTH / 2)) * 180;
        const mercY = -z * Math.PI / (MAP_HEIGHT / 2);
        const lat   = (2 * Math.atan(Math.exp(mercY)) - Math.PI / 2) * 180 / Math.PI;
        return { lon, lat };
    }

    _pick(e, el) {
        if (!this._wind?.windAt) return null;
        const r = el.getBoundingClientRect();
        const ndc = { x: ((e.clientX - r.left) / r.width) * 2 - 1,
                      y: -((e.clientY - r.top) / r.height) * 2 + 1 };
        this._ray.setFromCamera(ndc, this._cam);
        const hit = new THREE.Vector3();
        if (!this._ray.ray.intersectPlane(this._plane, hit)) return null;
        const { lon, lat } = this._sceneToLonLat(hit.x, hit.z);
        if (!(Math.abs(lat) <= 85 && Math.abs(lon) <= 180)) return null;
        const spd = this._wind.windAt(lon, lat).speed || 0;
        return { lon, lat, spd, tier: this._tierFor(spd) };
    }

    _tierFor(mps) { let t = null; for (const T of TIERS) if (mps >= T.mps) t = T; return t; }

    _cardHTML(p) {
        const t  = p.tier, kt = Math.round(p.spd / KT);
        const ns = p.lat >= 0 ? 'N' : 'S', ew = p.lon >= 0 ? 'E' : 'W';
        const col = '#' + t.glow.toString(16).padStart(6, '0');
        return `
            <div style="color:${col}; font-weight:800; letter-spacing:2px;">${t.name} FORCE</div>
            <div style="color:#cfe3f1; font-size:15px; margin:2px 0;">${kt} kt</div>
            <div style="color:#8aabc4;">Beaufort ${t.beaufort} · threshold ${t.kt} kt</div>
            <div style="color:#8aabc4;">${Math.abs(p.lat).toFixed(1)}°${ns}  ${Math.abs(p.lon).toFixed(1)}°${ew}</div>
            <div style="color:#4a6b84; margin-top:4px;">GFS · derived, non-authoritative</div>`;
    }

    _makeHoverCard() {
        const d = document.createElement('div');
        d.style.cssText = `position:fixed; display:none; z-index:120; pointer-events:none;
            background:rgba(1,10,20,0.92); border:1px solid rgba(64,196,255,0.45);
            border-left:3px solid #40c4ff; padding:7px 10px; min-width:130px;
            font-family:'Courier New',monospace; font-size:10px; letter-spacing:1px;`;
        document.body.appendChild(d);
        return d;
    }

    _onMove(e, el) {
        if (!this._hover) return;
        if (!this.group.visible) { this._hover.style.display = 'none'; return; }
        const p = this._pick(e, el);
        if (!p || !p.tier) { this._hover.style.display = 'none'; return; }
        this._hover.innerHTML   = this._cardHTML(p);
        this._hover.style.display = 'block';
        this._hover.style.left   = (e.clientX + 14) + 'px';
        this._hover.style.top    = (e.clientY + 14) + 'px';
    }

    _onDbl(e, el) {
        if (!this.group.visible) return;
        const p = this._pick(e, el);
        if (!p || !p.tier) return;
        e.stopImmediatePropagation();           // suppress camera focus
        e.preventDefault();
        this._makePinned(p, e.clientX, e.clientY);
    }

    _makePinned(p, cx, cy) {
        const card = document.createElement('div');
        const offset = (this._pins++ % 5) * 14;
        card.style.cssText = `position:fixed; z-index:121; left:${Math.min(cx + 16, window.innerWidth - 200) + offset}px;
            top:${Math.min(cy + 16, window.innerHeight - 140) + offset}px; width:180px;
            background:rgba(1,10,20,0.95); border:1px solid rgba(64,196,255,0.5);
            font-family:'Courier New',monospace; font-size:10px; letter-spacing:1px; box-shadow:0 0 24px rgba(64,196,255,0.12);`;
        const col = '#' + p.tier.glow.toString(16).padStart(6, '0');
        card.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center;
                 background:rgba(64,196,255,0.08); border-bottom:1px solid rgba(64,196,255,0.3); padding:5px 8px;">
                <span style="color:${col}; font-weight:800; letter-spacing:2px;">${p.tier.name}</span>
                <span><button data-a="min" style="${this._btn()}">–</button><button data-a="close" style="${this._btn()}">×</button></span>
            </div>
            <div data-body style="padding:7px 10px;">${this._cardHTML(p)}</div>`;
        card.querySelector('[data-a="close"]').onclick = () => card.remove();
        card.querySelector('[data-a="min"]').onclick = () => {
            const b = card.querySelector('[data-body]');
            b.style.display = b.style.display === 'none' ? 'block' : 'none';
        };
        document.body.appendChild(card);
    }

    _btn() {
        return `background:none; border:none; color:#8aabc4; cursor:pointer; font-size:13px;
                font-family:inherit; padding:0 4px; line-height:1;`;
    }
}
