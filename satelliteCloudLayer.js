// satelliteCloudLayer.js — Live satellite cloud imagery from NASA GIBS
//
// Uses VIIRS SNPP Band I5 infrared imagery — clouds appear white/grey on a
// transparent background. Works day and night. Updates daily.
//
// Fetches 8 tiles (zoom=1, 4 cols × 2 rows) from NASA GIBS via the local
// proxy (/gibs-tile), stitches them into a 2048×1024 canvas, and drapes
// the result as a semi-transparent texture over the globe.
//
// Toggle: windCloudLayer.visible = true/false
// Refresh: automatic every 30 minutes

import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT } from './config.js';

const PROXY_BASE  = 'http://localhost:8787';
const LAYER       = 'VIIRS_SNPP_Brightness_Temp_BandI5_Night';
const TILE_SET    = '250m';
const ZOOM        = 1;        // 4×2 = 8 tiles covering the globe
const COLS        = 4;
const ROWS        = 2;
const TILE_PX     = 512;      // each GIBS tile is 512×512 px
const OVERLAY_Y   = 3.0;      // float above ocean surface
const OPACITY     = 0.55;     // semi-transparent so map reads through
const REFRESH_MS  = 30 * 60 * 1000;

// Use yesterday's date — today's VIIRS data may not yet be processed
function dataDate() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
}

function tileUrl(row, col) {
    return `${PROXY_BASE}/gibs-tile` +
        `?layer=${LAYER}&date=${dataDate()}&tileset=${TILE_SET}` +
        `&z=${ZOOM}&row=${row}&col=${col}&fmt=png`;
}

export class SatelliteCloudLayer {
    constructor(scene) {
        this.scene    = scene;
        this._visible = true;
        this._mesh    = null;
        this._texture = null;

        // Offscreen canvas — 4 tiles wide × 2 tiles tall
        this._canvas        = document.createElement('canvas');
        this._canvas.width  = TILE_PX * COLS;
        this._canvas.height = TILE_PX * ROWS;
        this._ctx           = this._canvas.getContext('2d');

        this._buildMesh();
        this._loadTiles();

        // Refresh every 30 minutes
        setInterval(() => this._loadTiles(), REFRESH_MS);
    }

    // ── Mesh ──────────────────────────────────────────────────────────────────

    _buildMesh() {
        this._texture            = new THREE.CanvasTexture(this._canvas);
        this._texture.minFilter  = THREE.LinearFilter;
        this._texture.magFilter  = THREE.LinearFilter;

        const geo = new THREE.PlaneGeometry(MAP_WIDTH, MAP_HEIGHT);
        geo.rotateX(-Math.PI / 2);

        const mat = new THREE.MeshBasicMaterial({
            map:         this._texture,
            transparent: true,
            opacity:     OPACITY,
            depthWrite:  false,
            side:        THREE.DoubleSide,
        });

        this._mesh             = new THREE.Mesh(geo, mat);
        this._mesh.position.y  = OVERLAY_Y;
        this._mesh.renderOrder = 5;
        this._mesh.name        = 'satelliteCloudLayer';
        this.scene.add(this._mesh);
    }

    // ── Tile loading ──────────────────────────────────────────────────────────

    async _loadTiles() {
        this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);

        const jobs = [];
        for (let row = 0; row < ROWS; row++) {
            for (let col = 0; col < COLS; col++) {
                jobs.push(this._loadOneTile(row, col));
            }
        }

        await Promise.allSettled(jobs);
        this._texture.needsUpdate = true;
        console.log(`[SatCloud] Tiles loaded for ${dataDate()}`);
    }

    _loadOneTile(row, col) {
        return new Promise(resolve => {
            const img        = new Image();
            img.crossOrigin  = 'anonymous';
            img.onload       = () => {
                // Draw tile into correct position on canvas
                // Row 0 = north (top), Row 1 = south (bottom)
                // Col 0 = west (-180), Col 3 = east (+180)
                this._ctx.drawImage(img,
                    col * TILE_PX,  // x
                    row * TILE_PX,  // y
                    TILE_PX, TILE_PX
                );
                resolve();
            };
            img.onerror = () => {
                console.warn(`[SatCloud] Tile failed: row=${row} col=${col}`);
                resolve(); // skip — don't let one bad tile block the rest
            };
            img.src = tileUrl(row, col);
        });
    }

    // ── Public API ────────────────────────────────────────────────────────────

    get visible()  { return this._visible; }
    set visible(v) {
        this._visible = v;
        if (this._mesh) this._mesh.visible = v;
    }

    /** Manually trigger a data refresh. */
    refresh() { this._loadTiles(); }

    update() {} // no per-frame work
}
