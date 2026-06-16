// vesselIcons.js — per-class 2D vessel map icons (side silhouettes), generated
// once on a canvas and cached as a THREE texture. One texture per class (12),
// reused across every vessel of that class. Drawn to match the VANGUARD1 vessel
// class design sheet: class-coloured hull + white superstructure, bow to +x.
//
// Used by entityBuilder.createAISVesselObject to give each vessel a camera-facing
// sprite that reads its type at map/medium zoom, before the 3D hull is legible.

import * as THREE from 'three';

const _cache = new Map();
const INK   = 'rgba(6,12,20,0.85)';
const WHITE = '#eef3f7';
const GREY  = '#9aa6ad';
const DARK  = '#5a6670';

const W = 128, H = 64;

function drawIcon(cls, x, color) {
    x.clearRect(0, 0, W, H);
    x.lineJoin = 'round'; x.lineCap = 'round';

    const box = (x0, y0, w, h, fill) => {
        x.beginPath(); x.rect(x0, y0, w, h);
        x.fillStyle = fill; x.fill(); x.lineWidth = 2.5; x.strokeStyle = INK; x.stroke();
    };
    const poly = (pts, fill) => {
        x.beginPath(); x.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) x.lineTo(pts[i][0], pts[i][1]);
        x.closePath(); x.fillStyle = fill; x.fill(); x.lineWidth = 2.5; x.strokeStyle = INK; x.stroke();
    };
    const line = (x0, y0, x1, y1, w = 2.5, col = INK) => {
        x.beginPath(); x.moveTo(x0, y0); x.lineTo(x1, y1); x.lineWidth = w; x.strokeStyle = col; x.stroke();
    };
    // Standard hull: deck top y=30, bottom y=44, tapered bow at right (x1).
    const hull = (x0, x1) => poly([[x0, 30], [x1 - 16, 30], [x1, 37], [x1 - 16, 44], [x0, 44]], color);

    switch (cls) {
        case 'CARGO':
            hull(16, 108);
            box(18, 15, 15, 15, WHITE);
            for (let i = 0; i < 4; i++) box(36 + i * 17, 17, 15, 13, i % 2 ? '#cf4444' : color);
            break;
        case 'TANKER':
            hull(14, 110);
            box(16, 17, 13, 13, WHITE);
            line(34, 26, 96, 26, 3, GREY);
            box(60, 20, 11, 11, DARK);
            break;
        case 'PASSENGER':
            hull(20, 108);
            box(28, 20, 76, 11, WHITE); box(36, 12, 60, 9, WHITE); box(46, 5, 40, 7, WHITE);
            box(30, 2, 9, 11, color);
            break;
        case 'HSC':
            poly([[18, 33], [104, 33], [120, 38], [104, 43], [18, 43]], color);
            line(20, 43, 102, 43, 2.5, '#0a121c');
            poly([[44, 33], [88, 33], [88, 22], [76, 16], [50, 16], [44, 24]], '#6fe0ef');
            break;
        case 'FISHING':
            hull(20, 104);
            box(72, 16, 16, 14, WHITE);
            line(28, 30, 28, 12); line(28, 12, 48, 18);
            break;
        case 'TUG':
            hull(34, 110);
            box(50, 8, 26, 22, WHITE);
            box(58, 0, 12, 9, DARK);
            break;
        case 'DREDGER':
            hull(16, 108);
            box(44, 18, 34, 12, '#574539');
            line(40, 30, 64, 4); line(80, 30, 64, 4); line(54, 16, 74, 16);
            box(18, 15, 15, 15, WHITE);
            break;
        case 'PILOT':
            hull(28, 104);
            box(54, 16, 24, 15, WHITE);
            box(54, 11, 24, 5, DARK);
            break;
        case 'SAILING':
            poly([[34, 34], [92, 34], [108, 38], [92, 43], [34, 43]], color);
            line(64, 34, 64, 4, 3, GREY);
            poly([[61, 8], [61, 32], [34, 32]], WHITE);
            poly([[67, 12], [67, 32], [90, 32]], '#d8e2ea');
            break;
        case 'PLEASURE':
            hull(34, 108);
            box(48, 19, 38, 4, WHITE);
            box(52, 23, 30, 8, '#9fc4e8');
            break;
        case 'SERVICE':
            hull(20, 106);
            box(22, 16, 26, 14, WHITE);
            line(74, 30, 74, 6); line(74, 6, 104, 16);
            break;
        default:   // OTHER
            hull(28, 108);
            box(30, 16, 22, 14, WHITE);
            line(40, 16, 40, 6);
            break;
    }
}

// Returns a cached THREE.CanvasTexture for the class icon (aspect 2:1, W×H).
export function vesselIconTexture(cls, color) {
    const key = cls || 'OTHER';
    if (_cache.has(key)) return _cache.get(key);
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    drawIcon(key, canvas.getContext('2d'), color || '#90a4ae');
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    _cache.set(key, tex);
    return tex;
}

export const VESSEL_ICON_ASPECT = W / H;   // 2.0
