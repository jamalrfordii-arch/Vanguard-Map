// surveyManager.js — Surveying toolkit for the map (2026-07-24, Jamal).
//
// Four capabilities, all built on the map's existing georeferencing:
//   1. Coordinate readout  — click a point → lat/lon (decimal + DMS), UTM, and
//                            DEM elevation. Reuses uiController.requestMapPick.
//   2. Control points /    — placed or imported markers with a label + known
//      benchmarks            coordinates (the georeferencing backbone surveyors
//                            actually work from). Distinct symbol from #3.
//   3. Imported survey pts — load a CSV or GeoJSON of real measured points
//                            (lat/lon[/elev][/label]) and plot them.
//   4. Area measurement    — pick a polygon → enclosed area + perimeter.
//   (Distance/bearing already exists as the two-click ruler in measureManager.js.)
//
// HONESTY / SCALE NOTE — this is a whole-Earth web-Mercator scene at ~134 km per
// scene unit with a ~450 m DEM. These tools DISPLAY real coordinates and give
// survey CONTEXT; they are NOT instrument-grade. Real surveying coordinates come
// from RTK-GNSS / total stations / LiDAR and a projected CRS + geoid — this map
// is the picture, not the measuring device. Elevations here are coarse DEM, not
// orthometric survey heights, and are labelled "DEM" so nobody mistakes them.
//
// Dependency policy (CLAUDE.md): imports only lower-level modules (aisManager's
// lonLatToScene, terrainBuilder's getTrueElevation/getSceneGroundY) → no cycle.
// Singleton export; window.vg1Survey is a debug mirror only.

import * as THREE from 'three';
import { lonLatToScene } from './aisManager.js';
import { getTrueElevation, getSceneGroundY } from './terrainBuilder.js';

// ── WGS84 ellipsoid → UTM (Transverse Mercator, Snyder/USGS series) ───────────
// Returns { zone, hemisphere:'N'|'S', easting, northing } in metres. Good to a
// few mm within a zone — far finer than the DEM behind it, but correct so an
// imported survey point reads out in the grid a surveyor expects.
export function latLonToUTM(lat, lon) {
    const a = 6378137.0, f = 1 / 298.257223563, k0 = 0.9996;
    const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
    const zone = Math.floor((lon + 180) / 6) + 1;
    const lon0 = ((zone - 1) * 6 - 180 + 3) * Math.PI / 180;   // central meridian
    const latR = lat * Math.PI / 180, lonR = lon * Math.PI / 180;

    const sinLat = Math.sin(latR), cosLat = Math.cos(latR), tanLat = Math.tan(latR);
    const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
    const T = tanLat * tanLat;
    const C = ep2 * cosLat * cosLat;
    const A = cosLat * (lonR - lon0);
    const M = a * ((1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256) * latR
        - (3 * e2 / 8 + 3 * e2 * e2 / 32 + 45 * e2 * e2 * e2 / 1024) * Math.sin(2 * latR)
        + (15 * e2 * e2 / 256 + 45 * e2 * e2 * e2 / 1024) * Math.sin(4 * latR)
        - (35 * e2 * e2 * e2 / 3072) * Math.sin(6 * latR));

    const easting = k0 * N * (A + (1 - T + C) * A ** 3 / 6
        + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000;
    let northing = k0 * (M + N * tanLat * (A * A / 2
        + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24
        + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
    if (lat < 0) northing += 10000000;   // false northing, southern hemisphere

    return { zone, hemisphere: lat >= 0 ? 'N' : 'S', easting, northing };
}

// Decimal degrees → D°M'S.s" with hemisphere letter.
export function formatDMS(value, isLat) {
    const hemi = isLat ? (value >= 0 ? 'N' : 'S') : (value >= 0 ? 'E' : 'W');
    const v = Math.abs(value);
    const d = Math.floor(v);
    const mFloat = (v - d) * 60;
    const m = Math.floor(mFloat);
    const s = (mFloat - m) * 60;
    return `${d}°${String(m).padStart(2, '0')}'${s.toFixed(1).padStart(4, '0')}"${hemi}`;
}

// Enclosed area (m²) of a lat/lon polygon via equal-area local projection around
// the centroid + shoelace. Fine for survey-scale parcels; deliberately simple.
function polygonAreaM2(pts) {
    if (pts.length < 3) return 0;
    const lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
    const mPerDegLat = 111320;
    const mPerDegLon = 111320 * Math.cos(lat0 * Math.PI / 180);
    const xy = pts.map(p => ({ x: p.lon * mPerDegLon, y: p.lat * mPerDegLat }));
    let area = 0;
    for (let i = 0; i < xy.length; i++) {
        const j = (i + 1) % xy.length;
        area += xy[i].x * xy[j].y - xy[j].x * xy[i].y;
    }
    return Math.abs(area) / 2;
}

// Great-circle perimeter (m) of the (closed) polygon.
function perimeterM(pts) {
    const R = 6371008.8;
    const hav = (aLat, aLon, bLat, bLon) => {
        const dLat = (bLat - aLat) * Math.PI / 180, dLon = (bLon - aLon) * Math.PI / 180;
        const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(s));
    };
    let per = 0;
    for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        per += hav(pts[i].lat, pts[i].lon, pts[j].lat, pts[j].lon);
    }
    return per;
}

// ── Visual factories ──────────────────────────────────────────────────────────
const COLOR_SURVEY   = 0x40c4ff;   // cyan — imported/measured survey points
const COLOR_CONTROL  = 0x00e87a;   // green — control points / benchmarks
const COLOR_READOUT  = 0xffd54a;   // amber — one-off coordinate readout pin
const COLOR_AREA     = 0xff8c00;   // orange — area polygon

function makeLabelSprite(text) {
    const W = 256, H = 48;
    const cvs = document.createElement('canvas');
    cvs.width = W; cvs.height = H;
    const ctx = cvs.getContext('2d');
    ctx.font = 'bold 18px Courier New';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = 'rgba(0,4,12,0.9)'; ctx.lineWidth = 4; ctx.lineJoin = 'round';
    ctx.strokeText(text, W / 2, H / 2);
    ctx.fillStyle = '#fff6da';
    ctx.fillText(text, W / 2, H / 2);
    const tex = new THREE.CanvasTexture(cvs);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(4, 0.75, 1);
    sp.renderOrder = 7;
    return sp;
}

// Control points get a triangle (survey convention), survey points a ring, the
// readout pin a small cross — so the three categories are distinguishable.
function makeMarker(type) {
    const color = type === 'control' ? COLOR_CONTROL : type === 'readout' ? COLOR_READOUT : COLOR_SURVEY;
    let geo;
    if (type === 'control') {
        geo = new THREE.RingGeometry(0.0, 0.28, 3);           // filled triangle
    } else {
        geo = new THREE.RingGeometry(0.14, 0.24, 24);          // ring
    }
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.95, depthWrite: false,
        side: THREE.DoubleSide,
    });
    return new THREE.Mesh(geo, mat);
}

let _nextId = 1;

export class SurveyManager {
    constructor() {
        this._scene   = null;
        this.group    = null;
        this._points  = [];      // { id, type, lat, lon, elevM, label, mesh, label3d }
        this._readoutPin = null; // transient marker for coordinate readout mode
        this._area    = null;    // { verts:[{lat,lon,point}], line, fill, label }
        this._mode    = 'idle';  // 'idle' | 'readout' | 'control' | 'area'
        this._onChange = null;
    }

    init(scene) {
        this._scene = scene;
        this.group  = new THREE.Group();
        this.group.name = 'survey';
        this.group.visible = true;    // survey output persists regardless of panel; setVisible() available for a layer toggle
        scene.add(this.group);
        return this;
    }

    setVisible(on) { if (this.group) this.group.visible = on; }
    isVisible()    { return !!this.group?.visible; }
    onChange(cb)   { this._onChange = cb; }
    _notify(kind, payload) { if (this._onChange) this._onChange(kind, payload); }

    mode()        { return this._mode; }
    setMode(m)    { this._mode = m; this._notify('mode', m); }
    points()      { return this._points; }

    // ── 1. Coordinate readout ────────────────────────────────────────────────
    // Pure-ish: given a pick {lon,lat} (and optional scene point for elevation),
    // returns the full coordinate description. Also drops/moves the amber pin.
    describe(pick) {
        const { lon, lat } = pick;
        const scenePos = pick.point ? pick.point : lonLatToScene(lon, lat);
        let elevM = null;
        try { elevM = getTrueElevation(scenePos.x, scenePos.z); } catch (_) { /* DEM not ready */ }
        const utm = latLonToUTM(lat, lon);
        const out = {
            lat, lon,
            latDMS: formatDMS(lat, true),
            lonDMS: formatDMS(lon, false),
            utm,
            utmStr: `${utm.zone}${utm.hemisphere} ${Math.round(utm.easting)}E ${Math.round(utm.northing)}N`,
            elevM,
        };
        this._dropReadoutPin(lon, lat, scenePos);
        this._notify('readout', out);
        return out;
    }

    _dropReadoutPin(lon, lat, scenePos) {
        if (!this.group) return;
        if (!this._readoutPin) { this._readoutPin = makeMarker('readout'); this.group.add(this._readoutPin); }
        const y = getSceneGroundY(scenePos.x, scenePos.z) + 0.05;
        this._readoutPin.position.set(scenePos.x, y, scenePos.z);
        this._readoutPin.visible = true;
    }

    // ── 2 & 3. Control points, benchmarks, and imported survey points ─────────
    // type: 'survey' | 'control'. Returns the stored record.
    addPoint(lat, lon, { type = 'survey', label = '', elevM = null } = {}) {
        if (!this.group) return null;
        const scenePos = lonLatToScene(lon, lat);
        const y = getSceneGroundY(scenePos.x, scenePos.z) + 0.05;

        const mesh = makeMarker(type);
        mesh.position.set(scenePos.x, y, scenePos.z);
        this.group.add(mesh);

        const id  = _nextId++;
        const txt = label || `${type === 'control' ? 'CP' : 'SP'}${id}`;
        const label3d = makeLabelSprite(txt);
        label3d.position.set(scenePos.x, y + 0.6, scenePos.z);
        this.group.add(label3d);

        const rec = { id, type, lat, lon, elevM, label: txt, mesh, label3d };
        this._points.push(rec);
        this._notify('points', this._points);
        return rec;
    }

    addPointFromPick(pick, opts = {}) {
        return this.addPoint(pick.lat, pick.lon, opts);
    }

    removePoint(id) {
        const i = this._points.findIndex(p => p.id === id);
        if (i < 0) return;
        const p = this._points[i];
        this.group.remove(p.mesh);    p.mesh.geometry.dispose();  p.mesh.material.dispose();
        this.group.remove(p.label3d); p.label3d.material.map?.dispose(); p.label3d.material.dispose();
        this._points.splice(i, 1);
        this._notify('points', this._points);
    }

    // Import a CSV or GeoJSON string. CSV: header row with lat/lon (aliases:
    // latitude/y, longitude/lon/lng/x) plus optional elev/elevation/alt/z and
    // name/label/id. GeoJSON: Point / MultiPoint features. Returns { added, error }.
    importText(text, { type = 'survey' } = {}) {
        const trimmed = (text || '').trim();
        if (!trimmed) return { added: 0, error: 'empty file' };
        try {
            if (trimmed[0] === '{' || trimmed[0] === '[') {
                return this._importGeoJSON(JSON.parse(trimmed), type);
            }
            return this._importCSV(trimmed, type);
        } catch (e) {
            return { added: 0, error: e.message };
        }
    }

    _importCSV(text, type) {
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        if (!lines.length) return { added: 0, error: 'no rows' };
        const delim = lines[0].includes('\t') ? '\t' : ',';
        const head = lines[0].split(delim).map(h => h.trim().toLowerCase());
        const idxOf = (...names) => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; } return -1; };
        const iLat = idxOf('lat', 'latitude', 'y');
        const iLon = idxOf('lon', 'lng', 'long', 'longitude', 'x');
        const iEl  = idxOf('elev', 'elevation', 'alt', 'altitude', 'z', 'height');
        const iNm  = idxOf('name', 'label', 'id', 'point', 'station');
        // If no header match, assume first two columns are lat,lon and treat row 0 as data.
        const headerless = iLat < 0 || iLon < 0;
        const rows = headerless ? lines : lines.slice(1);
        let added = 0;
        for (const line of rows) {
            const c = line.split(delim);
            const lat = parseFloat(headerless ? c[0] : c[iLat]);
            const lon = parseFloat(headerless ? c[1] : c[iLon]);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
            if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
            const elevM = (!headerless && iEl >= 0) ? parseFloat(c[iEl]) : (headerless && c[2] != null ? parseFloat(c[2]) : null);
            const label = (!headerless && iNm >= 0) ? c[iNm]?.trim() : '';
            this.addPoint(lat, lon, { type, label, elevM: Number.isFinite(elevM) ? elevM : null });
            added++;
        }
        return { added, error: added ? null : 'no valid lat/lon rows' };
    }

    _importGeoJSON(obj, type) {
        const feats = obj.type === 'FeatureCollection' ? obj.features
            : obj.type === 'Feature' ? [obj]
            : Array.isArray(obj) ? obj : [];
        let added = 0;
        const addCoord = (coord, props = {}) => {
            const [lon, lat, z] = coord;
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
            const label = props.name || props.label || props.id || '';
            this.addPoint(lat, lon, { type, label: String(label || ''), elevM: Number.isFinite(z) ? z : null });
            added++;
        };
        for (const f of feats) {
            const g = f.geometry || f;
            if (!g) continue;
            if (g.type === 'Point') addCoord(g.coordinates, f.properties);
            else if (g.type === 'MultiPoint') g.coordinates.forEach(c => addCoord(c, f.properties));
        }
        return { added, error: added ? null : 'no Point features' };
    }

    // ── 4. Area measurement ──────────────────────────────────────────────────
    startArea() {
        this.clearArea();
        this._area = { verts: [], line: null, label: null };
        this.setMode('area');
        this._notify('area', { verts: 0 });
    }

    addAreaVertex(pick) {
        if (!this._area) this.startArea();
        const scenePos = pick.point ? pick.point.clone() : lonLatToScene(pick.lon, pick.lat);
        scenePos.y = getSceneGroundY(scenePos.x, scenePos.z) + 0.08;
        this._area.verts.push({ lat: pick.lat, lon: pick.lon, point: scenePos });
        this._redrawArea();
        this._notify('area', this._areaResult());
    }

    _areaResult() {
        const verts = this._area?.verts ?? [];
        if (verts.length < 3) return { verts: verts.length, areaM2: 0, perimeterM: 0 };
        return { verts: verts.length, areaM2: polygonAreaM2(verts), perimeterM: perimeterM(verts) };
    }

    finishArea() {
        const res = this._areaResult();
        this.setMode('idle');
        this._notify('area', { ...res, done: true });
        return res;
    }

    _redrawArea() {
        if (!this.group || !this._area) return;
        // Rebuild the outline each vertex (cheap; a survey polygon is a handful of points).
        if (this._area.line) { this.group.remove(this._area.line); this._area.line.geometry.dispose(); this._area.line.material.dispose(); }
        if (this._area.label) { this.group.remove(this._area.label); this._area.label.material.map?.dispose(); this._area.label.material.dispose(); }

        const pts = this._area.verts.map(v => v.point.clone());
        if (pts.length >= 2) {
            const loop = pts.length >= 3 ? [...pts, pts[0]] : pts;   // close when it's a polygon
            const geo = new THREE.BufferGeometry().setFromPoints(loop);
            const mat = new THREE.LineBasicMaterial({ color: COLOR_AREA, transparent: true, opacity: 0.9 });
            this._area.line = new THREE.Line(geo, mat);
            this.group.add(this._area.line);
        }
        if (pts.length >= 3) {
            const res = this._areaResult();
            const km2 = res.areaM2 / 1e6;
            const areaStr = km2 >= 1 ? `${km2.toFixed(2)} km²` : `${Math.round(res.areaM2).toLocaleString()} m²`;
            const c = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
            const label = makeLabelSprite(areaStr);
            label.position.set(c.x, c.y + 1.0, c.z);
            label.scale.set(5, 0.95, 1);
            this._area.label = label;
            this.group.add(label);
        }
    }

    clearArea() {
        if (this._area && this.group) {
            if (this._area.line)  { this.group.remove(this._area.line);  this._area.line.geometry.dispose();  this._area.line.material.dispose(); }
            if (this._area.label) { this.group.remove(this._area.label); this._area.label.material.map?.dispose(); this._area.label.material.dispose(); }
        }
        this._area = null;
    }

    // Remove the readout pin (e.g. when leaving readout mode).
    clearReadout() {
        if (this._readoutPin) { this._readoutPin.visible = false; }
    }

    clearAll() {
        for (const p of [...this._points]) this.removePoint(p.id);
        this.clearArea();
        if (this._readoutPin) { this.group.remove(this._readoutPin); this._readoutPin.geometry.dispose(); this._readoutPin.material.dispose(); this._readoutPin = null; }
        this.setMode('idle');
    }
}

export const surveyManager = new SurveyManager();
if (typeof window !== 'undefined') window.vg1Survey = surveyManager;   // debug mirror only
