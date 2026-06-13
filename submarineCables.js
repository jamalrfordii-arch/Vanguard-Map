// submarineCables.js — Telegeography global submarine cable network
// ~500 real undersea fiber optic cables, each rendered following actual bathymetric terrain.
// Data: github.com/telegeography/www.submarinecablemap.com (public, CC-licensed)
//
// Y placement mirrors terrainBuilder.js exactly:
//   ocean: sceneY = (hMeters / 1500) − dist² × 20   + CABLE_OFFSET
//   shore: sceneY =                  − dist² × 20   + CABLE_OFFSET
// so cables dip into trenches and rise over ridges exactly as the splat cloud does.

import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT, TERRAIN_VSCALE_OCEAN } from './config.js';
import { getTrueElevation } from './terrainBuilder.js';

// Routed via local proxy (same as OpenSky + Celestrak) — avoids CORS and GitHub branch issues.
const CABLE_URL = 'http://localhost:8787/cables';

const CABLE_Y_OFFSET = 0.30;   // scene units above seabed to prevent z-fighting
const MAX_PTS_PER_SEG = 300;   // decimate dense segments for performance

// ── Coordinate helpers ────────────────────────────────────────────────────────

function lonLatToXZ(lon, lat) {
    const x      = lon * (MAP_WIDTH / 360);
    const latCl  = Math.max(-82, Math.min(82, lat));
    const latRad = latCl * (Math.PI / 180);
    const mercY  = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
    const z      = -mercY * (MAP_HEIGHT / (2 * Math.PI));
    return { x, z };
}

// Reproduce terrainBuilder's ocean Y precisely so cables hug the seabed.
function seabedSceneY(hMeters, x, z) {
    const dist   = Math.sqrt((x / MAP_WIDTH) ** 2 + (z / MAP_HEIGHT) ** 2);
    const curveY = -Math.pow(dist, 2) * 20.0;
    // Ocean: push down proportional to depth; shore/land: sit at the curve surface
    const depthY = hMeters < 0 ? (hMeters / 1500.0) * TERRAIN_VSCALE_OCEAN : 0;
    return depthY + curveY + CABLE_Y_OFFSET;
}

// ── Antimeridian splitter ─────────────────────────────────────────────────────
// If two consecutive lon values differ by > 180° the cable crosses the dateline.
// Split here to avoid a line shooting across the whole map.

function splitAntimeridian(coords) {
    const segs = [];
    let cur    = [];
    for (let i = 0; i < coords.length; i++) {
        if (i > 0 && Math.abs(coords[i][0] - coords[i - 1][0]) > 180) {
            if (cur.length >= 2) segs.push(cur);
            cur = [];
        }
        cur.push(coords[i]);
    }
    if (cur.length >= 2) segs.push(cur);
    return segs;
}

// ── Point decimation ──────────────────────────────────────────────────────────
// Sub-sample very dense coordinate arrays to keep GPU geometry lean.

function decimate(coords, maxPts) {
    if (coords.length <= maxPts) return coords;
    const step = coords.length / maxPts;
    const out  = [];
    for (let i = 0; i < maxPts; i++) out.push(coords[Math.round(i * step)]);
    return out;
}

// ── Line builder for one cable ────────────────────────────────────────────────

function buildCable(multiCoords, colorHex, group) {
    // One shared material per cable — different color per cable, same shader settings
    const mat = new THREE.LineBasicMaterial({
        color:       new THREE.Color(colorHex || '#3377cc'),
        transparent: true,
        opacity:     0.35,   // reduced from 0.72 — web convergence at cable hubs was too dominant
        depthWrite:  false,
    });

    for (const lineCoords of multiCoords) {
        const segments = splitAntimeridian(lineCoords);

        for (const seg of segments) {
            const pts = decimate(seg, MAX_PTS_PER_SEG);
            if (pts.length < 2) continue;

            const verts = [];
            for (const [lon, lat] of pts) {
                const { x, z } = lonLatToXZ(lon, lat);
                const hM = getTrueElevation(x, z);
                verts.push(new THREE.Vector3(x, seabedSceneY(hM, x, z), z));
            }

            const geo  = new THREE.BufferGeometry().setFromPoints(verts);
            const line = new THREE.Line(geo, mat);
            line.renderOrder = 2;   // above terrain splats, below sea-level plane
            group.add(line);
        }
    }
}

// ── Cable landing stations ────────────────────────────────────────────────────
// Small pulsing dots at the first and last coordinate of every MultiLineString segment.
// These mark where cables come ashore.

const _landingGeo = new THREE.SphereGeometry(0.35, 5, 5);

function addLandingStation(lon, lat, colorHex, group) {
    const { x, z } = lonLatToXZ(lon, lat);
    const hM  = getTrueElevation(x, z);
    const y   = seabedSceneY(hM, x, z) + 0.15;

    const mat  = new THREE.MeshBasicMaterial({ color: new THREE.Color(colorHex || '#ffffff'), transparent: true, opacity: 0.9 });
    const mesh = new THREE.Mesh(_landingGeo, mat);
    mesh.position.set(x, y, z);
    mesh.renderOrder = 3;
    group.add(mesh);
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function createSubmarineCables(scene) {
    const group = new THREE.Group();
    group.name  = 'submarineCables';
    scene.add(group);

    const statusEl = document.getElementById('cable-status');
    if (statusEl) statusEl.innerText = 'LOADING...';

    try {
        const res = await fetch(CABLE_URL, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const geojson = await res.json();

        let cableCount = 0;

        for (const feature of geojson.features ?? []) {
            const { geometry, properties } = feature;
            if (!geometry) continue;

            const color = properties?.color ?? '#3377cc';

            let multiCoords;
            if (geometry.type === 'MultiLineString') {
                multiCoords = geometry.coordinates;
            } else if (geometry.type === 'LineString') {
                multiCoords = [geometry.coordinates];
            } else {
                continue;
            }

            buildCable(multiCoords, color, group);

            // Landing stations — one dot at each end of each line segment
            for (const line of multiCoords) {
                if (line.length >= 1) {
                    addLandingStation(line[0][0],                line[0][1],                color, group);
                    addLandingStation(line[line.length - 1][0],  line[line.length - 1][1],  color, group);
                }
            }

            cableCount++;
        }

        if (statusEl) statusEl.innerText = `${cableCount} CABLES`;
        console.log(`[CABLES] ${cableCount} submarine cables rendered`);

    } catch (err) {
        console.warn('[CABLES] Could not load cable data:', err.message);
        if (statusEl) statusEl.innerText = 'OFFLINE';
    }

    return group;
}
