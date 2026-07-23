// altitudeDeckManager.js — Flight-level reference grid
//
// A small wireframe grid patch at real-world flight levels, anchored under
// whichever aircraft is currently selected/clicked (state.lockedShip),
// hidden the rest of the time. Whichever deck is nearest the selected
// aircraft's actual altitude brightens; the other two stay dim.
//
// A full-map variant (every deck extended across the whole scene, gated
// behind a layerManager.js toggle) was built and then removed 2026-06-27.
// Diagnosis: the three flight levels sit at scene-Y ≈11.1 / 16.7 / 22.8 (see
// altitudeMetersToY in flightManager.js) — a spread of well under 12 scene
// units. controls.maxDistance is 550 (sceneSetup.js), so seeing the whole
// map at once means being zoomed out far enough that a 12-unit height
// difference reads as nothing. The grid itself was color-coded per deck, but
// aircraft icons weren't, so there was no way to tell which deck a given
// plane belonged to just by looking — "planes get lost in the decks." Per-
// aircraft patches sidestep this by anchoring the grid right where you're
// already looking, at HUD scale, rather than asking you to perceive a tiny
// absolute height difference from far away. The cross-aircraft picture that
// full-map mode was actually trying to give (who's near which level, who's
// about to cross one) belongs in the Altitude Watch panel instead.
//
// Decks use real-world flight levels, not the trail-color altitude bands
// elsewhere in the app:
//   FL180 · 18,000 ft — U.S. transition altitude. Below this, aircraft fly
//                       local-altimeter (QNH) altitudes; above it, everyone
//                       flies standard pressure (29.92"/1013mb) flight levels
//                       so vertical separation is consistent app-wide.
//   FL290 · 29,000 ft — floor of the RVSM band, where the hemispheric rule
//                       takes over: eastbound traffic (heading 000–179°)
//                       is assigned odd flight levels (290/310/330…),
//                       westbound (180–359°) gets even ones (300/320/340…).
//                       This is what actually keeps head-on traffic apart.
//   FL410 · 41,000 ft — RVSM ceiling. Above this, traffic thins out fast —
//                       mostly long-range business jets.
//
// Y comes from altitudeMetersToY() in flightManager.js — the exact function
// that places every live aircraft — so a deck always lines up with where
// traffic actually flies, never drifts out of sync with a duplicated formula.
//
// Labels (2026-06-27 revision): the floating sprite caption on each grid line
// ("FL410 · 41,000 ft — RVSM ceiling") used to draw with depthTest off, so it
// sat on top of the aircraft it was meant to contextualize — exactly
// backwards, since the plane is the thing you clicked on. Brought back here
// smaller, dimmer, and depth-tested: the aircraft model (and terrain) now
// occlude the label like any other object in the scene, instead of the label
// drawing through everything in front of it. The full descriptive text (RVSM
// rule, transition altitude, etc.) lives in the Altitude Watch panel's
// #aw-legend instead — the in-scene label is just the short flight-level tag.
// Same depthTest reasoning applies to the grid/rim lines below.

import * as THREE from 'three';
import { LineMaterial }         from 'three/addons/lines/LineMaterial.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineSegments2 }        from 'three/addons/lines/LineSegments2.js';
import { altitudeMetersToY, altitudeBandIndex } from './flightManager.js';

const FT_TO_M = 0.3048;

// ── Deck registry — real flight levels only ─────────────────────────────────
const DECKS = [
    {
        id:    'fl180',
        altFt: 18000,
        label: '0–18,000 FT', // range below this deck, not the FL code — easier to read at a glance than "FL180"
        y:     altitudeMetersToY(18000 * FT_TO_M),
        color: 0x40c4ff,
        labelColor: '#9cd9ff',
    },
    {
        id:    'fl290',
        altFt: 29000,
        label: '18,000–29,000 FT',
        y:     altitudeMetersToY(29000 * FT_TO_M),
        color: 0xffab40,
        labelColor: '#ffd9a0',
    },
    {
        id:    'fl410',
        altFt: 41000,
        label: '29,000–41,000 FT',
        y:     altitudeMetersToY(41000 * FT_TO_M),
        color: 0xd9b3ff,
        labelColor: '#e6d4ff',
    },
];

const PATCH_SIZE      = 48;   // scene units — local grid patch width/depth
const PATCH_DIVISIONS = 8;
const DIM_OPACITY       = 0.14; // deck the aircraft is NOT currently in
const HIGHLIGHT_OPACITY = 0.40; // deck the aircraft IS currently in — kept well under 1 so the aircraft model reads as the brightest thing at its own position
const RIM_MULT          = 1.5;  // rim is brighter than the grid fill
const LABEL_DIM_OPACITY       = 0.30; // label on a deck the aircraft is NOT in
const LABEL_HIGHLIGHT_OPACITY = 0.75; // label on the aircraft's current deck — still legible, never fights the model for attention

// ── Canvas-painted label texture — short altitude range only
// ("18,000–29,000 FT"), not the long description (that lives in the Altitude
// Watch panel's #aw-legend). ────────────────────────────────────────────────
function makeDeckLabelTexture(text, color) {
    const W = 280, H = 40;
    const cvs = document.createElement('canvas');
    cvs.width = W; cvs.height = H;
    const ctx = cvs.getContext('2d');
    ctx.fillStyle = 'rgba(2, 8, 20, 0.6)';
    ctx.beginPath();
    ctx.roundRect(0, 0, W, H, 5);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(0.75, 0.75, W - 1.5, H - 1.5, 5);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = 'bold 15px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, W / 2, H / 2 + 1);
    const tex = new THREE.CanvasTexture(cvs);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
}

function _dpr() { return window.devicePixelRatio || 1; }
function _resolutionVec() {
    return new THREE.Vector2(window.innerWidth * _dpr(), window.innerHeight * _dpr());
}

// ── Grid patch ───────────────────────────────────────────────────────────────
function makeDeckGrid(cfg, size, divisions) {
    const half = size * 0.5;
    const positions = [];
    for (let i = 0; i <= divisions; i++) {
        const t = -half + (i / divisions) * size;
        positions.push(t, cfg.y, -half,  t, cfg.y, half);
        positions.push(-half, cfg.y, t,  half, cfg.y, t);
    }
    const geo = new LineSegmentsGeometry();
    geo.setPositions(new Float32Array(positions));
    const mat = new LineMaterial({
        color:       cfg.color,
        linewidth:   1.4,
        transparent: true,
        opacity:     DIM_OPACITY,
        depthWrite:  false,
        depthTest:   true,  // respect the depth buffer so the aircraft model (and terrain) occlude the grid normally, instead of the grid drawing through everything in front of it
        blending:    THREE.AdditiveBlending,
        resolution:  _resolutionVec(),
    });
    const lines = new LineSegments2(geo, mat);
    lines.frustumCulled = false;
    lines.renderOrder = 5;
    return { mesh: lines, material: mat };
}

function makeDeckRim(cfg, size) {
    const half = size * 0.5;
    const positions = new Float32Array([
        -half, cfg.y, -half,   half, cfg.y, -half,
         half, cfg.y, -half,   half, cfg.y,  half,
         half, cfg.y,  half,  -half, cfg.y,  half,
        -half, cfg.y,  half,  -half, cfg.y, -half,
    ]);
    const geo = new LineSegmentsGeometry();
    geo.setPositions(positions);
    const mat = new LineMaterial({
        color:       cfg.color,
        linewidth:   2.2,
        transparent: true,
        opacity:     DIM_OPACITY * RIM_MULT,
        depthWrite:  false,
        depthTest:   true,
        blending:    THREE.AdditiveBlending,
        resolution:  _resolutionVec(),
    });
    const line = new LineSegments2(geo, mat);
    line.frustumCulled = false;
    line.renderOrder = 6;
    return { mesh: line, material: mat };
}

// ── Manager ─────────────────────────────────────────────────────────────────
export class AltitudeDeckManager {
    constructor(scene) {
        this.scene = scene;
        this.group = new THREE.Group();
        this.group.name = 'altitudeDecks';
        this.group.visible = false; // shown only while an aircraft is locked
        scene.add(this.group);

        this._decks = DECKS.map(cfg => this._buildDeck(cfg));
        this._lastLocked = null;

        this._onResize = () => {
            const res = _resolutionVec();
            for (const d of this._decks) {
                d.gridMaterial.resolution?.copy(res);
                d.rimMaterial.resolution?.copy(res);
            }
        };
        window.addEventListener('resize', this._onResize);

        console.info(`[Decks] Initialised ${DECKS.length} flight-level decks.`);
    }

    _buildDeck(cfg) {
        const deckGroup = new THREE.Group();
        deckGroup.name = `deck_${cfg.id}`;

        const grid  = makeDeckGrid(cfg, PATCH_SIZE, PATCH_DIVISIONS);
        const rim   = makeDeckRim(cfg, PATCH_SIZE);
        const label = this._makeLabel(cfg);
        label.position.set(0, cfg.y + 1.2, PATCH_SIZE * 0.5 - 4);
        deckGroup.add(grid.mesh, rim.mesh, label);

        this.group.add(deckGroup);
        return {
            config: cfg,
            group: deckGroup,
            gridMaterial: grid.material,
            rimMaterial:  rim.material,
            labelSprite:  label,
        };
    }

    _makeLabel(cfg) {
        const labelTex = makeDeckLabelTexture(cfg.label, cfg.labelColor);
        const labelMat = new THREE.SpriteMaterial({
            map: labelTex, transparent: true, opacity: LABEL_DIM_OPACITY,
            depthWrite: false, depthTest: true, // depth-tested like the grid — the aircraft model should occlude this, not draw beneath it
        });
        const labelSprite = new THREE.Sprite(labelMat);
        labelSprite.scale.set(17, 2.4, 1); // wider than the FL-code version to fit the altitude-range text, same height
        labelSprite.renderOrder = 6;
        return labelSprite;
    }

    // state — main.js's shared { lockedShip, ... } object. We read
    // lockedShip.userData.isRealFlight (same flag trailManager's per-frame
    // sync uses) so highlighting only ever activates for an aircraft,
    // never a ship.
    update(_delta, state) {
        const locked = state?.lockedShip;
        const isAircraft = !!locked?.userData?.isRealFlight;

        if (!isAircraft) {
            if (this.group.visible) this.group.visible = false;
            this._lastLocked = null;
            return;
        }
        this.group.visible = true;
        this.group.position.set(locked.position.x, 0, locked.position.z);

        const altFt = (locked.userData.altMeters ?? 0) / FT_TO_M;
        // Highlight the band the aircraft is IN (containing-band), not the deck
        // whose flight level is numerically nearest — the latter mis-selects
        // across the lower half of each band (e.g. FL330 → wrong "18–29k" deck).
        const idx = altitudeBandIndex(altFt, this._decks.map(d => d.config.altFt));
        const nearest = this._decks[idx];

        for (const d of this._decks) {
            const on = d === nearest;
            const level = on ? HIGHLIGHT_OPACITY : DIM_OPACITY;
            d.gridMaterial.opacity = level;
            d.rimMaterial.opacity  = level * RIM_MULT;
            d.labelSprite.material.opacity = on ? LABEL_HIGHLIGHT_OPACITY : LABEL_DIM_OPACITY;
        }
    }

    disconnect() {
        window.removeEventListener('resize', this._onResize);
    }
}
