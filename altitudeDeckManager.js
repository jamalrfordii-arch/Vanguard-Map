// altitudeDeckManager.js — Stratified atmospheric/operational altitude decks
//
// Renders a subtle wireframe horizontal grid at each named altitude in the
// scene, with edge labels identifying it. Decks auto-fade when the camera
// is near top-down (so they never block the map) and brighten when the
// camera is tilted at an angle — making the 3D atmospheric volume readable.
//
// This module is the spatial primitive that the rest of the project's 3D
// architecture stands on. Today's decks are the wind altitudes:
//
//   Y =  8  SURFACE · 10 m
//   Y = 14  850 mb  · 1.5 km
//   Y = 22  250 mb  · 10 km
//
// Future decks will live here too as their data layers come online:
//   Y = 18  CRUISE   · 11 km   (commercial flights, contrails)
//   Y = 35  STRATO   · 20 km   (high-altitude recon, balloons)
//   Y = 80+ LEO      · 400+ km (satellites, ISS)
//   Y = -3  SUBSURFACE · -3 km (submarines, undersea cables)
//
// Each deck is just an entry in DECKS — add new ones as you add their data.

import * as THREE from 'three';
import { LineMaterial }         from 'three/addons/lines/LineMaterial.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineSegments2 }        from 'three/addons/lines/LineSegments2.js';
import { MAP_WIDTH, MAP_HEIGHT } from './config.js';

// ── Deck registry ───────────────────────────────────────────────────────────
const DECKS = [
    {
        id:           'surface',
        label:        'SURFACE · 10 m',
        y:            8,
        color:        0x4a8cff,         // operational blue
        gridDivisions: 32,
        opacity:      0.50,
        labelColor:   '#9cc8ff',
    },
    {
        id:           'low',
        label:        '850mb · 1.5 km',
        y:            14,
        color:        0x6cd0cc,         // teal
        gridDivisions: 24,
        opacity:      0.45,
        labelColor:   '#9ce6e0',
    },
    {
        id:           'jet',
        label:        '250mb · 10 km',
        y:            22,
        color:        0xc8e6ff,         // icy pale blue
        gridDivisions: 18,
        opacity:      0.48,
        labelColor:   '#e6f0ff',
    },
];

// ── Camera-tilt visibility curve ────────────────────────────────────────────
// Returns [0..1] visibility multiplier based on camera tilt angle.
// Top-down (~90° elevation) = 0 (decks invisible — they'd block the map).
// Tilted at ~55° or below = 1 (decks fully visible).
const FADE_TILT_HI = 85;
const FADE_TILT_LO = 55;

function tiltVisibility(cam) {
    const x = cam.position.x;
    const y = cam.position.y;
    const z = cam.position.z;
    const horiz = Math.sqrt(x * x + z * z);
    const tiltDeg = Math.atan2(y, horiz) * 180 / Math.PI;   // 90 = pure top-down
    const v = (FADE_TILT_HI - tiltDeg) / (FADE_TILT_HI - FADE_TILT_LO);
    return Math.max(0, Math.min(1, v));
}

// ── Canvas-painted label texture ────────────────────────────────────────────
function makeDeckLabelTexture(text, color) {
    const W = 280, H = 56;
    const cvs = document.createElement('canvas');
    cvs.width = W; cvs.height = H;
    const ctx = cvs.getContext('2d');
    ctx.fillStyle = 'rgba(2, 8, 20, 0.62)';
    ctx.beginPath();
    ctx.roundRect(0, 0, W, H, 5);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(0.75, 0.75, W - 1.5, H - 1.5, 5);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = 'bold 18px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 14, H / 2 + 1);
    ctx.font = '16px monospace';
    ctx.textAlign = 'right';
    ctx.fillText('◇', W - 14, H / 2 + 1);
    const tex = new THREE.CanvasTexture(cvs);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
}

// ── Wireframe grid mesh at a deck (Line2 for proper screen-space thickness) ─
function makeDeckGrid(cfg) {
    const divX = cfg.gridDivisions;
    const divZ = Math.max(6, Math.round(divX * 0.55));
    const halfX = MAP_WIDTH  * 0.5;
    const halfZ = MAP_HEIGHT * 0.5;
    const positions = [];
    for (let i = 0; i <= divX; i++) {
        const x = -halfX + (i / divX) * MAP_WIDTH;
        positions.push(x, cfg.y, -halfZ, x, cfg.y, halfZ);
    }
    for (let j = 0; j <= divZ; j++) {
        const z = -halfZ + (j / divZ) * MAP_HEIGHT;
        positions.push(-halfX, cfg.y, z, halfX, cfg.y, z);
    }
    const geo = new LineSegmentsGeometry();
    geo.setPositions(new Float32Array(positions));
    const dpr = window.devicePixelRatio || 1;
    const mat = new LineMaterial({
        color:       cfg.color,
        linewidth:   1.6,                       // device-pixel screen-space thickness
        transparent: true,
        opacity:     cfg.opacity,
        depthWrite:  false,
        depthTest:   false,
        blending:    THREE.AdditiveBlending,
        resolution:  new THREE.Vector2(window.innerWidth * dpr, window.innerHeight * dpr),
    });
    const lines = new LineSegments2(geo, mat);
    lines.frustumCulled = false;
    lines.renderOrder = 5;
    return { mesh: lines, material: mat };
}

// ── Brighter perimeter ring around each deck ─────────────────────────────────
function makeDeckRim(cfg) {
    const halfX = MAP_WIDTH  * 0.5;
    const halfZ = MAP_HEIGHT * 0.5;
    const positions = new Float32Array([
        -halfX, cfg.y, -halfZ,   halfX, cfg.y, -halfZ,
         halfX, cfg.y, -halfZ,   halfX, cfg.y,  halfZ,
         halfX, cfg.y,  halfZ,  -halfX, cfg.y,  halfZ,
        -halfX, cfg.y,  halfZ,  -halfX, cfg.y, -halfZ,
    ]);
    const geo = new LineSegmentsGeometry();
    geo.setPositions(positions);
    const dpr = window.devicePixelRatio || 1;
    const mat = new LineMaterial({
        color:       cfg.color,
        linewidth:   2.6,                       // perimeter thicker so deck edges are crisp
        transparent: true,
        opacity:     Math.min(1, cfg.opacity * 1.7),
        depthWrite:  false,
        depthTest:   false,
        blending:    THREE.AdditiveBlending,
        resolution:  new THREE.Vector2(window.innerWidth * dpr, window.innerHeight * dpr),
    });
    const line = new LineSegments2(geo, mat);
    line.frustumCulled = false;
    line.renderOrder = 6;
    return { mesh: line, material: mat };
}

// ── Manager ─────────────────────────────────────────────────────────────────
export class AltitudeDeckManager {
    constructor(scene, camera) {
        this.scene  = scene;
        this.camera = camera;
        this.group = new THREE.Group();
        this.group.name = 'altitudeDecks';
        this.group.visible = false;
        scene.add(this.group);
        this._decks = DECKS.map(cfg => this._buildDeck(cfg));

        // Keep LineMaterial.resolution in sync with the canvas so the grid
        // line thickness stays correct after window resizes.
        this._onResize = () => {
            const dpr = window.devicePixelRatio || 1;
            const w = window.innerWidth * dpr;
            const h = window.innerHeight * dpr;
            for (const d of this._decks) {
                d.gridMaterial.resolution?.set(w, h);
                d.rimMaterial.resolution?.set(w, h);
            }
        };
        window.addEventListener('resize', this._onResize);

        console.info(`[Decks] Initialised ${DECKS.length} altitude decks (Line2 wireframes).`);
    }

    _buildDeck(cfg) {
        const deckGroup = new THREE.Group();
        deckGroup.name = `deck_${cfg.id}`;
        const grid = makeDeckGrid(cfg);
        deckGroup.add(grid.mesh);
        const rim = makeDeckRim(cfg);
        deckGroup.add(rim.mesh);
        const labelTex = makeDeckLabelTexture(cfg.label, cfg.labelColor);
        const halfX = MAP_WIDTH  * 0.5;
        const halfZ = MAP_HEIGHT * 0.5;
        const corners = [
            [-halfX + 18, -halfZ + 6],
            [ halfX - 18, -halfZ + 6],
            [-halfX + 18,  halfZ - 6],
            [ halfX - 18,  halfZ - 6],
        ];
        const labelSprites = [];
        for (const [x, z] of corners) {
            const mat = new THREE.SpriteMaterial({
                map:        labelTex,
                transparent:true,
                opacity:    0.95,
                depthWrite: false,
                depthTest:  false,
            });
            const spr = new THREE.Sprite(mat);
            spr.scale.set(34, 6.8, 1);
            spr.position.set(x, cfg.y + 1.6, z);
            spr.renderOrder = 6;
            deckGroup.add(spr);
            labelSprites.push(spr);
        }
        this.group.add(deckGroup);
        return {
            config:       cfg,
            group:        deckGroup,
            gridMaterial: grid.material,
            rimMaterial:  rim.material,
            labelSprites,
            baseGridOpac: cfg.opacity,
            baseRimOpac:  Math.min(1, cfg.opacity * 1.7),
        };
    }

    setVisible(on) {
        this.group.visible = on;
        console.info(`[Decks] Layer ${on ? 'ON' : 'OFF'}`);
    }

    update(_delta) {
        if (!this.group.visible) return;
        const v = tiltVisibility(this.camera);
        for (const deck of this._decks) {
            deck.gridMaterial.opacity = deck.baseGridOpac * v;
            deck.rimMaterial.opacity  = deck.baseRimOpac  * v;
            for (const spr of deck.labelSprites) {
                spr.material.opacity = 0.95 * v;
            }
        }
    }

    addDeck(cfg) {
        const deck = this._buildDeck(cfg);
        this._decks.push(deck);
        return deck;
    }

    getDeck(id) {
        return this._decks.find(d => d.config.id === id);
    }
}
