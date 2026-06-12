// portManager.js — Tier-based LOD port system with Phase 4 contextual animation
//
// Phases implemented:
//   Phase 1 — Data tiers: every port has tier (1/2/3) + region string
//   Phase 2 — Zoom LOD: camera.y thresholds gate which tiers render
//             + label collision detection (lower-tier label hides on overlap)
//   Phase 3 — Hover spotlight: hovering a Tier 1 port reveals its whole region,
//             dims all other visible ports to 30%, 800 ms linger on exit
//   Phase 4 — Animation:
//             · Zoom reveals   → simple 400 ms opacity ease-out
//             · Hover reveals  → staggered bloom radiating from hovered anchor
//             · First-encounter → scale 0.7→1.0 combined with opacity fade
//             · Hover exit     → 800 ms linger before fade begins (not mirrored)
//
// Usage (main.js):
//   const portManager = new PortManager(scene);
//   portManager.tick(camera, mouse, delta);   // mouse = THREE.Vector2 NDC
//   setupUI({ portMarkersGroup: portManager.group, ... });

import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT } from './config.js';

// ── Port database ─────────────────────────────────────────────────────────────
// tier 1 = Global hub   — always visible
// tier 2 = Regional hub — visible at meso zoom (camera.y ≤ MACRO_Y)
// tier 3 = Local port   — visible only at micro zoom or via hover reveal
// type      : primary function of the port
// teuRank   : global container TEU rank (null = not ranked)
// maxVessel : largest vessel class that can enter
// serves    : strategic chokepoints / waterways this port feeds
const PORTS = [
    // ── NORTH SEA ─────────────────────────────────────────────────────────────
    { name: 'ROTTERDAM',    lat: 51.92,  lon:  4.48,  tier: 1, region: 'NORTH SEA',       type: 'Container + Bulk + Energy', teuRank:  11, maxVessel: 'Post-Panamax (24,000 TEU)', serves: ['English Channel', 'Danish Straits'] },
    { name: 'ANTWERP',      lat: 51.26,  lon:  4.40,  tier: 1, region: 'NORTH SEA',       type: 'Container + Chemicals',     teuRank:  13, maxVessel: 'Post-Panamax (24,000 TEU)', serves: ['English Channel'] },
    { name: 'HAMBURG',      lat: 53.55,  lon:  9.97,  tier: 1, region: 'NORTH SEA',       type: 'Container + Bulk',          teuRank:  18, maxVessel: 'Post-Panamax (20,000 TEU)', serves: ['North Sea', 'Baltic Sea'] },
    { name: 'FELIXSTOWE',   lat: 51.96,  lon:  1.35,  tier: 2, region: 'NORTH SEA',       type: 'Container',                 teuRank:  42, maxVessel: 'Post-Panamax',               serves: ['English Channel'] },
    { name: 'BREMEN',       lat: 53.09,  lon:  8.80,  tier: 3, region: 'NORTH SEA',       type: 'Container + Multipurpose',  teuRank: null, maxVessel: 'Post-Panamax',              serves: ['North Sea'] },
    { name: 'AMSTERDAM',    lat: 52.38,  lon:  4.90,  tier: 3, region: 'NORTH SEA',       type: 'Bulk + Energy',             teuRank: null, maxVessel: 'Panamax',                   serves: ['North Sea'] },

    // ── MEDITERRANEAN ─────────────────────────────────────────────────────────
    { name: 'ALGECIRAS',    lat: 36.13,  lon: -5.45,  tier: 2, region: 'MEDITERRANEAN',   type: 'Container + Transhipment',  teuRank:  32, maxVessel: 'ULCV (24,000 TEU)',          serves: ['Strait of Gibraltar'] },
    { name: 'BARCELONA',    lat: 41.35,  lon:  2.15,  tier: 2, region: 'MEDITERRANEAN',   type: 'Container + Cruise',        teuRank: null, maxVessel: 'Post-Panamax',              serves: ['Mediterranean'] },
    { name: 'VALENCIA',     lat: 39.44,  lon: -0.32,  tier: 2, region: 'MEDITERRANEAN',   type: 'Container',                 teuRank:  26, maxVessel: 'Post-Panamax',               serves: ['Mediterranean'] },
    { name: 'MARSEILLE',    lat: 43.30,  lon:  5.37,  tier: 3, region: 'MEDITERRANEAN',   type: 'Container + Oil',           teuRank: null, maxVessel: 'Suezmax',                   serves: ['Mediterranean'] },
    { name: 'GENOA',        lat: 44.41,  lon:  8.92,  tier: 3, region: 'MEDITERRANEAN',   type: 'Container + Multipurpose',  teuRank: null, maxVessel: 'Post-Panamax',              serves: ['Mediterranean'] },
    { name: 'PIRAEUS',      lat: 37.95,  lon: 23.63,  tier: 2, region: 'MEDITERRANEAN',   type: 'Container + Transhipment',  teuRank:  30, maxVessel: 'ULCV (24,000 TEU)',          serves: ['Mediterranean', 'Bosphorus'] },
    { name: 'ISTANBUL',     lat: 41.02,  lon: 28.97,  tier: 2, region: 'MEDITERRANEAN',   type: 'Multipurpose + Cruise',     teuRank: null, maxVessel: 'Panamax',                   serves: ['Bosphorus', 'Black Sea'] },
    { name: 'PORT SAID',    lat: 31.26,  lon: 32.30,  tier: 2, region: 'MEDITERRANEAN',   type: 'Container + Transhipment',  teuRank: null, maxVessel: 'ULCV',                       serves: ['Suez Canal'] },

    // ── RED SEA / GULF ────────────────────────────────────────────────────────
    { name: 'SUEZ',         lat: 29.97,  lon: 32.55,  tier: 3, region: 'RED SEA / GULF',  type: 'Transit + Multipurpose',    teuRank: null, maxVessel: 'New Panamax',               serves: ['Suez Canal'] },
    { name: 'JEDDAH',       lat: 21.49,  lon: 39.18,  tier: 2, region: 'RED SEA / GULF',  type: 'Container + Multipurpose',  teuRank: null, maxVessel: 'Post-Panamax',              serves: ['Red Sea', 'Bab-el-Mandeb'] },
    { name: 'DUBAI',        lat: 25.07,  lon: 55.13,  tier: 1, region: 'RED SEA / GULF',  type: 'Container + Energy',        teuRank:   9, maxVessel: 'ULCV (24,000 TEU)',          serves: ['Strait of Hormuz', 'Persian Gulf'] },

    // ── SOUTH ASIA ────────────────────────────────────────────────────────────
    { name: 'MUMBAI',       lat: 18.93,  lon: 72.84,  tier: 2, region: 'SOUTH ASIA',      type: 'Container + Multipurpose',  teuRank: null, maxVessel: 'Post-Panamax',              serves: ['Arabian Sea'] },
    { name: 'COLOMBO',      lat:  6.95,  lon: 79.85,  tier: 3, region: 'SOUTH ASIA',      type: 'Container + Transhipment',  teuRank: null, maxVessel: 'Post-Panamax',              serves: ['Indian Ocean'] },

    // ── SE ASIA ───────────────────────────────────────────────────────────────
    { name: 'SINGAPORE',    lat:  1.26,  lon: 103.82, tier: 1, region: 'SE ASIA',         type: 'Container + Energy Hub',    teuRank:   2, maxVessel: 'ULCV (24,000 TEU)',          serves: ['Strait of Malacca'] },
    { name: 'PORT KLANG',   lat:  3.00,  lon: 101.39, tier: 2, region: 'SE ASIA',         type: 'Container',                 teuRank:  12, maxVessel: 'Post-Panamax',               serves: ['Strait of Malacca'] },
    { name: 'JAKARTA',      lat: -6.10,  lon: 106.83, tier: 2, region: 'SE ASIA',         type: 'Container + Multipurpose',  teuRank: null, maxVessel: 'Post-Panamax',              serves: ['Strait of Malacca', 'South China Sea'] },
    { name: 'HO CHI MINH',  lat: 10.78,  lon: 106.70, tier: 3, region: 'SE ASIA',         type: 'Container',                 teuRank: null, maxVessel: 'Post-Panamax',              serves: ['South China Sea'] },

    // ── EAST ASIA ─────────────────────────────────────────────────────────────
    { name: 'SHANGHAI',     lat: 31.23,  lon: 121.47, tier: 1, region: 'EAST ASIA',       type: 'Container',                 teuRank:   1, maxVessel: 'ULCV (24,000 TEU)',          serves: ['South China Sea', 'Taiwan Strait'] },
    { name: 'HONG KONG',    lat: 22.29,  lon: 114.16, tier: 1, region: 'EAST ASIA',       type: 'Container',                 teuRank:   9, maxVessel: 'ULCV (24,000 TEU)',          serves: ['South China Sea'] },
    { name: 'TIANJIN',      lat: 39.02,  lon: 117.73, tier: 2, region: 'EAST ASIA',       type: 'Container + Bulk',          teuRank:   7, maxVessel: 'Post-Panamax',               serves: ['Sea of Japan'] },
    { name: 'QINGDAO',      lat: 36.07,  lon: 120.37, tier: 2, region: 'EAST ASIA',       type: 'Container + Bulk + Oil',    teuRank:   5, maxVessel: 'ULCV',                       serves: ['Sea of Japan'] },
    { name: 'BUSAN',        lat: 35.10,  lon: 129.04, tier: 2, region: 'EAST ASIA',       type: 'Container + Transhipment',  teuRank:   6, maxVessel: 'ULCV (24,000 TEU)',          serves: ['Sea of Japan'] },
    { name: 'TOKYO',        lat: 35.65,  lon: 139.77, tier: 2, region: 'EAST ASIA',       type: 'Container + Multipurpose',  teuRank: null, maxVessel: 'Post-Panamax',              serves: ['Sea of Japan'] },
    { name: 'KAOHSIUNG',    lat: 22.62,  lon: 120.27, tier: 2, region: 'EAST ASIA',       type: 'Container + Transhipment',  teuRank:  14, maxVessel: 'ULCV',                       serves: ['Taiwan Strait'] },

    // ── OCEANIA ───────────────────────────────────────────────────────────────
    { name: 'SYDNEY',       lat:-33.85,  lon: 151.21, tier: 2, region: 'OCEANIA',         type: 'Container + Multipurpose',  teuRank: null, maxVessel: 'Post-Panamax',              serves: ['South Pacific'] },
    { name: 'MELBOURNE',    lat:-37.82,  lon: 144.90, tier: 3, region: 'OCEANIA',         type: 'Container + Bulk',          teuRank: null, maxVessel: 'Post-Panamax',              serves: ['South Pacific'] },

    // ── NORTH AMERICA WEST ────────────────────────────────────────────────────
    { name: 'LOS ANGELES',  lat: 33.73,  lon:-118.27, tier: 1, region: 'N AMERICA WEST',  type: 'Container',                 teuRank:  17, maxVessel: 'ULCV (18,000 TEU)',          serves: ['North Pacific'] },
    { name: 'SEATTLE',      lat: 47.60,  lon:-122.33, tier: 2, region: 'N AMERICA WEST',  type: 'Container + Bulk',          teuRank: null, maxVessel: 'Post-Panamax',              serves: ['North Pacific'] },
    { name: 'VANCOUVER',    lat: 49.29,  lon:-123.12, tier: 2, region: 'N AMERICA WEST',  type: 'Container + Bulk',          teuRank: null, maxVessel: 'Post-Panamax',              serves: ['North Pacific'] },

    // ── NORTH AMERICA EAST ────────────────────────────────────────────────────
    { name: 'NEW YORK',     lat: 40.64,  lon: -74.04, tier: 1, region: 'N AMERICA EAST',  type: 'Container + Bulk',          teuRank:  22, maxVessel: 'Post-Panamax',               serves: ['North Atlantic'] },
    { name: 'HOUSTON',      lat: 29.73,  lon: -95.00, tier: 2, region: 'N AMERICA EAST',  type: 'Bulk + Energy + LNG',       teuRank: null, maxVessel: 'Suezmax',                   serves: ['Gulf of Mexico'] },
    { name: 'NEW ORLEANS',  lat: 29.95,  lon: -90.07, tier: 3, region: 'N AMERICA EAST',  type: 'Bulk + Grain',              teuRank: null, maxVessel: 'Panamax',                   serves: ['Gulf of Mexico'] },

    // ── SOUTH AMERICA ─────────────────────────────────────────────────────────
    { name: 'SANTOS',       lat:-23.95,  lon: -46.33, tier: 2, region: 'SOUTH AMERICA',   type: 'Container + Bulk + Grain',  teuRank: null, maxVessel: 'Post-Panamax',              serves: ['South Atlantic'] },
    { name: 'BUENOS AIRES', lat:-34.62,  lon: -58.37, tier: 2, region: 'SOUTH AMERICA',   type: 'Container + Multipurpose',  teuRank: null, maxVessel: 'Panamax',                   serves: ['South Atlantic'] },

    // ── AFRICA ────────────────────────────────────────────────────────────────
    { name: 'LAGOS',        lat:  6.43,  lon:  3.41,  tier: 3, region: 'AFRICA',          type: 'Multipurpose + Oil',        teuRank: null, maxVessel: 'Panamax',                   serves: ['Gulf of Guinea'] },
    { name: 'DURBAN',       lat:-29.87,  lon: 31.04,  tier: 2, region: 'AFRICA',          type: 'Container + Bulk',          teuRank: null, maxVessel: 'Post-Panamax',              serves: ['Cape of Good Hope'] },
    { name: 'CAPE TOWN',    lat:-33.92,  lon: 18.42,  tier: 3, region: 'AFRICA',          type: 'Multipurpose + Repair',     teuRank: null, maxVessel: 'Panamax',                   serves: ['Cape of Good Hope'] },
];

// ── Tunables ──────────────────────────────────────────────────────────────────
const MACRO_Y          = 200;   // camera.y above this → tier 1 only
const MESO_Y           = 80;    // camera.y 80–200 → tier 1+2; below 80 → all tiers
const FADE_SPEED       = 5.0;   // opacity lerp rate — ~400 ms to reach target
const HOVER_SCREEN_PX  = 44;    // screen-pixel radius for tier-1 hover hit
const HOVER_LINGER_MS  = 800;   // ms before hover-revealed ports begin fading out
const BLOOM_DIST_SCALE = 0.9;   // world-distance → ms bloom delay per unit
const BLOOM_MAX_MS     = 380;   // cap on bloom stagger delay
const DIM_FACTOR       = 0.28;  // opacity multiplier for non-hovered-region ports

// ── Helpers ───────────────────────────────────────────────────────────────────
function _toScene(lon, lat) {
    const x      = (lon / 180.0) * (MAP_WIDTH / 2.0);
    const latRad = lat * (Math.PI / 180.0);
    const mercY  = Math.log(Math.tan(Math.PI / 4.0 + latRad / 2.0));
    const z      = -(mercY / Math.PI) * (MAP_HEIGHT / 2.0);
    return new THREE.Vector3(x, 0.4, z);
}

function _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function _makeLabelSprite(name, tier) {
    const canvas = document.createElement('canvas');
    canvas.width  = 256;
    canvas.height = 48;
    const ctx = canvas.getContext('2d');

    const fontSize = tier === 1 ? 15 : tier === 2 ? 13 : 11;
    ctx.font = `bold ${fontSize}px Courier New`;
    const tw  = ctx.measureText(name).width;
    const pad = 9;
    const bx  = Math.max(0, 128 - tw / 2 - pad);
    const bw  = Math.min(256, tw + pad * 2);

    _roundRect(ctx, bx, 7, bw, 34, 5);
    ctx.fillStyle = 'rgba(1, 10, 20, 0.82)';
    ctx.fill();

    const borderAlpha = tier === 1 ? 0.72 : tier === 2 ? 0.48 : 0.30;
    ctx.strokeStyle = `rgba(64, 196, 255, ${borderAlpha})`;
    ctx.lineWidth   = tier === 1 ? 1.5 : 1;
    ctx.stroke();

    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    // Dark outline pass — drawn first so it renders behind the coloured fill.
    // Keeps text legible against bright desert, snow, and ocean backgrounds.
    ctx.shadowBlur   = 0;
    ctx.strokeStyle  = 'rgba(0, 4, 12, 0.90)';
    ctx.lineWidth    = tier === 1 ? 3 : 2.5;
    ctx.lineJoin     = 'round';
    ctx.strokeText(name, 128, 25);

    // Coloured fill + glow on top
    ctx.shadowColor  = '#40c4ff';
    ctx.shadowBlur   = tier === 1 ? 9 : 5;
    ctx.fillStyle    = `rgba(64, 196, 255, ${tier === 1 ? 0.98 : 0.82})`;
    ctx.fillText(name, 128, 25);
    ctx.shadowBlur   = 0;
    ctx.fillText(name, 128, 25);

    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({
        map: tex, transparent: true, depthTest: false, opacity: 0,
    });
    const spr = new THREE.Sprite(mat);
    const sw  = tier === 1 ? 11 : tier === 2 ? 9.5 : 8.5;
    spr.scale.set(sw, sw * (48 / 256), 1);
    spr.renderOrder = 998;
    return spr;
}

// ── PortManager ───────────────────────────────────────────────────────────────
export class PortManager {
    constructor(scene) {
        this._scene   = scene;
        this._group   = new THREE.Group();
        this._group.name = 'portMarkers';
        this._enabled = true;

        // Shared geometries — per-port materials for individual opacity
        this._diamondGeo = new THREE.OctahedronGeometry(0.55, 0);
        this._ringGeo    = new THREE.RingGeometry(1.0, 1.25, 16);

        // Scratch vectors — allocated once to avoid per-frame GC pressure
        this._scrNDC = new THREE.Vector3();

        this._ports = PORTS.map(data => {
            const pos = _toScene(data.lon, data.lat);
            // Phase 2 hybrid: clamp port height to actual terrain elevation
            // (or sea level for coastal ports). Sampler may not be ready yet
            // on cold start — falls back to 0 (sea level) which is reasonable
            // for the first ~1s before the continent worker finishes.
            const ground = window.terrainHeight?.sampleTerrainHeightXZ?.(pos.x, pos.z) ?? 0;
            pos.y = Math.max(0, ground);

            // Diamond pip
            const dMat = new THREE.MeshStandardMaterial({
                color: 0x40c4ff, emissive: 0x40c4ff,
                emissiveIntensity: 1.4,
                transparent: true, opacity: 0, depthWrite: false,
            });
            const diamond = new THREE.Mesh(this._diamondGeo, dMat);
            diamond.position.copy(pos);
            diamond.renderOrder = 997;

            // Ground ring
            const rMat = new THREE.MeshBasicMaterial({
                color: 0x40c4ff,
                transparent: true, opacity: 0,
                side: THREE.DoubleSide, depthWrite: false,
            });
            const ring = new THREE.Mesh(this._ringGeo, rMat);
            ring.position.set(pos.x, pos.y + 0.1, pos.z);   // ring sits on terrain (or sea level)
            ring.rotation.x = -Math.PI / 2;
            ring.renderOrder = 996;

            // Label sprite
            const label = _makeLabelSprite(data.name, data.tier);
            label.position.set(pos.x, pos.y + 3.5, pos.z);

            this._group.add(diamond, ring, label);

            return {
                data, pos,
                diamond, dMat,
                ring,    rMat,
                label,

                // Animation state
                opacity:       0,
                targetOpacity: 0,
                scale:         data.tier === 1 ? 1.0 : 0.82,
                targetScale:   data.tier === 1 ? 1.0 : 0.82,

                // Phase 4 state
                bloomAt:         0,      // ms — do not start fading in before this
                seenThisSession: false,  // first encounter triggers scale bloom
                hoverRevealed:   false,  // currently visible due to hover
                hoverExitAt:     0,      // ms — when hover on this region ended
                labelVisible:    true,   // collision result — resolved each tick
            };
        });

        scene.add(this._group);
    }

    get group()  { return this._group; }

    // ── Click detection — call from onClick handler ───────────────────────────
    // Returns the port data object if a port label is within clickPx of mouse,
    // null otherwise. Same screen-space approach as hover detection.
    checkClick(mouse, camera, clickPx = 52) {
        const vpW = window.innerWidth, vpH = window.innerHeight;
        const msx = (mouse.x *  0.5 + 0.5) * vpW;
        const msy = (mouse.y * -0.5 + 0.5) * vpH;
        let nearest = null, nearestDist = clickPx;
        this._ports.forEach(p => {
            if (p.opacity < 0.05) return; // not visible — skip
            this._scrNDC.copy(p.pos).project(camera);
            if (this._scrNDC.z > 1) return;
            const sx   = (this._scrNDC.x *  0.5 + 0.5) * vpW;
            const sy   = (this._scrNDC.y * -0.5 + 0.5) * vpH;
            const dist = Math.hypot(sx - msx, sy - msy);
            if (dist < nearestDist) { nearestDist = dist; nearest = p.data; }
        });
        return nearest;
    }

    // ── Enable / disable (ports panel toggle) ─────────────────────────────────
    setEnabled(v) {
        this._enabled = v;
        // When disabled, fade everything out; tick continues to run the tween
        if (!v) this._ports.forEach(p => { p.targetOpacity = 0; });
    }

    // ── Main tick — call every animation frame ────────────────────────────────
    // camera : THREE.PerspectiveCamera (live)
    // mouse  : THREE.Vector2  NDC [-1, 1]
    // delta  : seconds since last frame
    tick(camera, mouse, delta) {
        const nowMs = Date.now();
        const camY  = camera.position.y;
        const vpW   = window.innerWidth;
        const vpH   = window.innerHeight;

        // ── Phase 2: zoom tier ────────────────────────────────────────────────
        const zoomTier = camY > MACRO_Y ? 1 : camY > MESO_Y ? 2 : 3;

        // ── Phase 3: screen-space hover detection on tier-1 ports ─────────────
        // Convert mouse NDC to screen pixels; compare against each port's
        // projected position. Closest tier-1 port within HOVER_SCREEN_PX wins.
        let hoveredPort   = null;
        let hoveredRegion = null;

        if (this._enabled) {
            const msx = (mouse.x *  0.5 + 0.5) * vpW;
            const msy = (mouse.y * -0.5 + 0.5) * vpH;

            this._ports.forEach(p => {
                if (p.data.tier !== 1) return;
                this._scrNDC.copy(p.pos).project(camera);
                if (this._scrNDC.z > 1) return; // behind camera
                const sx   = (this._scrNDC.x *  0.5 + 0.5) * vpW;
                const sy   = (this._scrNDC.y * -0.5 + 0.5) * vpH;
                const dist = Math.hypot(sx - msx, sy - msy);
                if (dist < HOVER_SCREEN_PX) {
                    hoveredPort   = p;
                    hoveredRegion = p.data.region;
                }
            });
        }

        // ── Phase 3 + 4: compute target opacity per port ──────────────────────
        if (this._enabled) {
            this._ports.forEach(p => {
                const tier        = p.data.tier;
                const baseVisible = tier <= zoomTier;

                // Base opacity from zoom tier
                const fullOpacity = tier === 1 ? 0.92 : tier === 2 ? 0.78 : 0.62;
                let tgt = baseVisible ? fullOpacity : 0;

                const inHoveredRegion = hoveredRegion && p.data.region === hoveredRegion;

                if (hoveredRegion) {
                    if (inHoveredRegion) {
                        // Always show full opacity within hovered region
                        tgt = fullOpacity;

                        // Queue staggered bloom for ports that weren't base-visible
                        if (!p.hoverRevealed) {
                            p.hoverRevealed = true;
                            p.hoverExitAt   = 0;

                            if (!baseVisible) {
                                // Stagger delay = distance from anchor × scale factor
                                const dist  = hoveredPort
                                    ? p.pos.distanceTo(hoveredPort.pos)
                                    : 0;
                                const delay = Math.min(dist * BLOOM_DIST_SCALE, BLOOM_MAX_MS);
                                p.bloomAt   = nowMs + Math.round(delay);
                            }
                        }

                    } else {
                        // Phase 3: focal dimming for ports outside hovered region
                        tgt = baseVisible ? tgt * DIM_FACTOR : 0;

                        // Handle linger for ports that were revealed by a previous hover
                        if (p.hoverRevealed) {
                            if (p.hoverExitAt === 0) p.hoverExitAt = nowMs;
                            if (nowMs - p.hoverExitAt < HOVER_LINGER_MS) {
                                // Still within linger window — keep at full opacity
                                tgt = Math.max(tgt, fullOpacity);
                            } else {
                                p.hoverRevealed = false;
                                p.hoverExitAt   = 0;
                                p.bloomAt       = 0;
                            }
                        }
                    }

                } else {
                    // No hover active — linger on any recently hovered region
                    if (p.hoverRevealed) {
                        if (p.hoverExitAt === 0) p.hoverExitAt = nowMs;
                        if (nowMs - p.hoverExitAt < HOVER_LINGER_MS) {
                            tgt = Math.max(tgt, fullOpacity);
                        } else {
                            p.hoverRevealed = false;
                            p.hoverExitAt   = 0;
                            p.bloomAt       = 0;
                        }
                    }
                }

                p.targetOpacity = tgt;

                // ── Phase 4: first-encounter scale bloom ──────────────────────
                // Fire the first time a port transitions from invisible → visible.
                if (!p.seenThisSession && tgt > 0 && p.opacity < 0.04) {
                    p.seenThisSession = true;
                    p.scale           = 0.70;
                    p.targetScale     = tier === 1 ? 1.00 : 0.85;
                }
            });
        }

        // ── Phase 2: label collision detection ────────────────────────────────
        this._resolveCollisions(camera, vpW, vpH);

        // ── Apply tweens every frame ──────────────────────────────────────────
        this._applyTweens(delta, nowMs);
    }

    // ── Label collision resolver ──────────────────────────────────────────────
    // Projects each visible port to screen space and suppresses labels that
    // overlap a higher-tier (already placed) label.
    _resolveCollisions(camera, vpW, vpH) {
        const placed = [];

        // Sort tier-ascending so tier-1 labels are placed first and always win
        const sorted = [...this._ports].sort((a, b) => a.data.tier - b.data.tier);

        sorted.forEach(p => {
            p.labelVisible = true;
            if (p.targetOpacity < 0.05) return; // invisible — don't reserve space

            this._scrNDC.copy(p.label.position).project(camera);
            if (this._scrNDC.z > 1) { p.labelVisible = false; return; }

            const sx = (this._scrNDC.x *  0.5 + 0.5) * vpW;
            const sy = (this._scrNDC.y * -0.5 + 0.5) * vpH;

            // Approximate half-extents of the label in screen pixels
            const tier = p.data.tier;
            const hw   = (tier === 1 ? 11 : tier === 2 ? 9.5 : 8.5) * 16;
            const hh   = (tier === 1 ? 11 : tier === 2 ? 9.5 : 8.5) * 4;

            const overlaps = placed.some(r =>
                Math.abs(sx - r.cx) < hw + r.hw &&
                Math.abs(sy - r.cy) < hh + r.hh
            );

            if (overlaps) {
                p.labelVisible = false;
            } else {
                placed.push({ cx: sx, cy: sy, hw, hh });
            }
        });
    }

    // ── Tween application ─────────────────────────────────────────────────────
    _applyTweens(delta, nowMs) {
        // Exponential lerp — framerate-independent, matches FADE_SPEED constant
        const lr = 1 - Math.exp(-FADE_SPEED * delta);

        this._ports.forEach(p => {
            // Phase 4: bloom stagger — hold at 0 until bloomAt elapses
            const effectiveTgt = (p.bloomAt > 0 && nowMs < p.bloomAt)
                ? 0
                : p.targetOpacity;

            p.opacity = p.opacity + (effectiveTgt - p.opacity) * lr;
            p.scale   = p.scale   + (p.targetScale - p.scale)  * lr;

            const o = Math.max(0, Math.min(1, p.opacity));

            p.dMat.opacity = o;
            p.diamond.scale.setScalar(p.scale);
            p.diamond.visible = o > 0.008;

            p.rMat.opacity = o * 0.55;
            p.ring.visible = o > 0.008;

            const lO = p.labelVisible ? o : 0;
            p.label.material.opacity = lO;
            p.label.visible          = lO > 0.008;
        });
    }

    dispose() {
        this._scene.remove(this._group);
        this._diamondGeo.dispose();
        this._ringGeo.dispose();
        this._ports.forEach(p => {
            p.dMat.dispose();
            p.rMat.dispose();
            p.label.material.map?.dispose();
            p.label.material.dispose();
        });
    }
}
