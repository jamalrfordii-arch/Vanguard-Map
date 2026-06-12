// magneticFieldManager.js — Geomagnetic layer: magnetic field lines + telluric currents.
//
// MAGNETIC FIELD LINES
//   Uses a simplified IGRF dipole model (pure math, no API).
//   The Earth's magnetic north pole sits at ~80.7°N, 72.7°W. The dipole is tilted
//   ~11.5° from the geographic axis. Field lines are traced using r = L·sin²(θ)
//   in the magnetic frame then rotated into geographic coordinates.
//   Rendered as animated flowing lines arcing from hemisphere to hemisphere.
//
// TELLURIC CURRENTS
//   Horizontal current flow lines rendered below the terrain surface.
//   Color and animation speed driven by NOAA real-time Kp index (free endpoint).
//   Rendered with depthTest:false so they show through the terrain like x-ray.
//
// Registers with Central System (layerManager) and responds to toggle/opacity events.

import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT } from './config.js';

// ── Dipole constants (IGRF simplified) ───────────────────────────────────────
const LAT_N_DEG = 80.7;   // geographic lat of magnetic north pole
const LON_N_DEG = -72.7;  // geographic lon of magnetic north pole
const LAT_N     = LAT_N_DEG * Math.PI / 180;
const LON_N     = LON_N_DEG * Math.PI / 180;

// Magnetic north pole unit vector in geographic Cartesian
// Geographic X → (0°N, 0°E), Y → (0°N, 90°E), Z → 90°N
const MAG_Z = [
    Math.cos(LAT_N) * Math.cos(LON_N),
    Math.cos(LAT_N) * Math.sin(LON_N),
    Math.sin(LAT_N),
];
// Magnetic X axis: geo-Z cross MAG_Z (then normalise)
function _cross(a, b) {
    return [ a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0] ];
}
function _norm(v) {
    const l = Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]);
    return [v[0]/l, v[1]/l, v[2]/l];
}
const GEO_Z = [0, 0, 1];
const MAG_X  = _norm(_cross(GEO_Z, MAG_Z));
const MAG_Y  = _cross(MAG_Z, MAG_X);  // already unit length (right-hand)

// Rotate magnetic Cartesian → geographic Cartesian
function _rotMagToGeo(xm, ym, zm) {
    return [
        xm*MAG_X[0] + ym*MAG_Y[0] + zm*MAG_Z[0],
        xm*MAG_X[1] + ym*MAG_Y[1] + zm*MAG_Z[1],
        xm*MAG_X[2] + ym*MAG_Y[2] + zm*MAG_Z[2],
    ];
}

// ── Field line shell / longitude layout ──────────────────────────────────────
// L-shell = equatorial distance in Earth radii. Higher L → field line arcs higher.
const L_SHELLS   = [1.4, 1.7, 2.2, 3.0];          // 4 shells
const MAG_LONS   = Array.from({length: 12}, (_, i) => i * 30 * Math.PI / 180); // every 30°
const POINTS_PER = 90;   // points per field line segment
const ALT_SCALE  = 0.005; // km above surface → scene Y units (Everest ~10 units)
const EARTH_R_KM = 6371;

// ── Scene coordinate helpers ─────────────────────────────────────────────────
function _geoToScene(lat_deg, lon_deg, alt_km) {
    const x = (lon_deg / 180.0) * (MAP_WIDTH  / 2);
    const z = (lat_deg /  90.0) * (MAP_HEIGHT / 2);
    const y = Math.max(0, alt_km) * ALT_SCALE;
    return new THREE.Vector3(x, y, z);
}

// ── Field line point generator ───────────────────────────────────────────────
// Returns an array of sub-arrays of THREE.Vector3.
// Split into sub-arrays wherever the line crosses the date line (lon jump > 90°).
function _fieldLinePoints(L, magLon) {
    const thetaFoot  = Math.asin(Math.min(1, 1.0 / Math.sqrt(L))); // colatitude at surface
    const thetaStart = Math.PI - thetaFoot; // south magnetic footpoint
    const thetaEnd   = thetaFoot;           // north magnetic footpoint

    const rawPts  = [];
    const rawT    = [];

    for (let i = 0; i <= POINTS_PER; i++) {
        const t     = i / POINTS_PER;
        const theta = thetaStart + (thetaEnd - thetaStart) * t;
        const r     = L * Math.sin(theta) * Math.sin(theta); // in Earth radii

        // Magnetic Cartesian
        const xm = r * Math.sin(theta) * Math.cos(magLon);
        const ym = r * Math.sin(theta) * Math.sin(magLon);
        const zm = r * Math.cos(theta);

        // Rotate to geographic Cartesian
        const [xg, yg, zg] = _rotMagToGeo(xm, ym, zm);

        const r_geo  = Math.sqrt(xg*xg + yg*yg + zg*zg);
        const lat    = Math.asin(Math.max(-1, Math.min(1, zg / r_geo))) * 180 / Math.PI;
        const lon    = Math.atan2(yg, xg) * 180 / Math.PI;
        const alt_km = Math.max(0, (r_geo - 1.0) * EARTH_R_KM);

        rawPts.push({ lat, lon, alt_km });
        rawT.push(t);
    }

    // Split at date-line crossings (|Δlon| > 90° between consecutive points)
    const segments = [];
    let current    = [];
    let currentT   = [];

    for (let i = 0; i < rawPts.length; i++) {
        if (i > 0) {
            const dLon = Math.abs(rawPts[i].lon - rawPts[i-1].lon);
            if (dLon > 90) {
                if (current.length > 1) segments.push({ pts: current, tVals: currentT });
                current  = [];
                currentT = [];
            }
        }
        current.push(_geoToScene(rawPts[i].lat, rawPts[i].lon, rawPts[i].alt_km));
        currentT.push(rawT[i]);
    }
    if (current.length > 1) segments.push({ pts: current, tVals: currentT });
    return segments;
}

// ── Shaders ──────────────────────────────────────────────────────────────────
const VERT_FIELD = /* glsl */`
    attribute float aT;
    varying   float vT;
    varying   float vAlt;
    uniform   float uMaxY;
    void main() {
        vT   = aT;
        vAlt = clamp(position.y / max(uMaxY, 1.0), 0.0, 1.0);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const FRAG_FIELD = /* glsl */`
    varying float vT;
    varying float vAlt;
    uniform float uTime;
    uniform float uOpacity;
    void main() {
        // Flow pulse along the line (south → north)
        float flow  = 0.45 + 0.55 * sin(vT * 22.0 - uTime * 1.8);
        // Magenta at surface → cyan at altitude
        vec3 colLow  = vec3(1.00, 0.31, 0.71);  // #ff50b4
        vec3 colHigh = vec3(0.25, 0.77, 1.00);  // #40c4ff
        vec3 color   = mix(colLow, colHigh, vAlt);
        // Alpha: strong near surface, fades at altitude apex
        float alpha  = (1.0 - vAlt * 0.55) * flow * uOpacity;
        gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
    }
`;

// ── Telluric current shaders (subsurface, amber) ─────────────────────────────
const VERT_TEL = /* glsl */`
    attribute float aT;
    varying   float vT;
    void main() {
        vT          = aT;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;
const FRAG_TEL = /* glsl */`
    varying float vT;
    uniform float uTime;
    uniform float uOpacity;
    uniform float uKp;     // 0–9 Kp index: drives speed and brightness
    void main() {
        float speed  = 1.2 + uKp * 0.35;
        float flow   = 0.4 + 0.6 * sin(vT * 18.0 - uTime * speed);
        vec3  color  = vec3(1.0, 0.55, 0.10);  // amber
        float alpha  = flow * uOpacity * 0.70;
        gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
    }
`;

// ── Main class ────────────────────────────────────────────────────────────────
export class MagneticFieldManager {
    constructor(scene) {
        this._scene   = scene;
        this._uTime   = { value: 0 };
        this._uOpF    = { value: 0.75 };  // field line opacity
        this._uOpT    = { value: 0.60 };  // telluric opacity
        this._uKp     = { value: 1.0  };  // Kp index (fetched from NOAA)

        // Separate groups so they can be toggled independently
        this._fieldGroup    = new THREE.Group();
        this._telluricGroup = new THREE.Group();
        this._fieldGroup.visible    = false;
        this._telluricGroup.visible = false;
        scene.add(this._fieldGroup);
        scene.add(this._telluricGroup);

        this._matField    = null;
        this._matTelluric = null;
        this._maxY        = 0;

        this._buildFieldLines();
        this._buildTelluricLines();
        this._fetchKp();

        // ── Respond to Central System toggles ────────────────────────────────
        window.addEventListener('vg1:layerChanged', (e) => {
            const { id, on, opacity } = e.detail;
            if (id === 'magnetic-field') {
                this._fieldGroup.visible = on;
                this._uOpF.value = opacity * 0.75;
            }
            if (id === 'telluric') {
                this._telluricGroup.visible = on;
                this._uOpT.value = opacity * 0.60;
            }
        });
    }

    // ── Build field line meshes ───────────────────────────────────────────────
    _buildFieldLines() {
        // Find max Y for shader normalisation
        let maxY = 1;
        for (const L of L_SHELLS) {
            const peakAlt = (L - 1.0) * EARTH_R_KM * ALT_SCALE;
            maxY = Math.max(maxY, peakAlt);
        }
        this._maxY = maxY;

        this._matField = new THREE.ShaderMaterial({
            vertexShader:   VERT_FIELD,
            fragmentShader: FRAG_FIELD,
            uniforms: {
                uTime:    this._uTime,
                uOpacity: this._uOpF,
                uMaxY:    { value: maxY },
            },
            transparent: true,
            depthWrite:  false,
            blending:    THREE.AdditiveBlending,
        });

        for (const L of L_SHELLS) {
            for (const magLon of MAG_LONS) {
                const segments = _fieldLinePoints(L, magLon);
                for (const seg of segments) {
                    if (seg.pts.length < 2) continue;
                    const geo  = new THREE.BufferGeometry().setFromPoints(seg.pts);
                    const tArr = new Float32Array(seg.tVals);
                    geo.setAttribute('aT', new THREE.BufferAttribute(tArr, 1));
                    this._fieldGroup.add(new THREE.Line(geo, this._matField));
                }
            }
        }
    }

    // ── Build telluric current meshes ─────────────────────────────────────────
    // Simple subsurface horizontal flow lines following the magnetic equator.
    // The magnetic equator is where magnetic latitude = 0 (r = L, any L at θ = 90°).
    _buildTelluricLines() {
        this._matTelluric = new THREE.ShaderMaterial({
            vertexShader:   VERT_TEL,
            fragmentShader: FRAG_TEL,
            uniforms: {
                uTime:    this._uTime,
                uOpacity: this._uOpT,
                uKp:      this._uKp,
            },
            transparent: true,
            depthTest:   false,
            depthWrite:  false,
            blending:    THREE.AdditiveBlending,
        });

        // Generate flow lines at several latitudes in the surface
        const TELLURIC_LATS = [-60, -45, -30, -15, 0, 15, 30, 45, 60];
        const Y_BELOW       = -0.6; // just below terrain surface

        for (const lat of TELLURIC_LATS) {
            // Horizontal lines spanning full longitude range
            const pts   = [];
            const tVals = [];
            const steps = 80;
            for (let i = 0; i <= steps; i++) {
                const t   = i / steps;
                const lon = -180 + t * 360;
                // Slight sinusoidal deviation to follow magnetic equator shape
                const latShift = Math.sin((lon + LON_N_DEG) * Math.PI / 180) * 8.0
                                * (1.0 - Math.abs(lat) / 90.0);
                const adjLat = lat + latShift;
                pts.push(new THREE.Vector3(
                    (lon / 180.0) * (MAP_WIDTH  / 2),
                    Y_BELOW,
                    (adjLat / 90.0) * (MAP_HEIGHT / 2)
                ));
                tVals.push(t);
            }
            const geo  = new THREE.BufferGeometry().setFromPoints(pts);
            const tArr = new Float32Array(tVals);
            geo.setAttribute('aT', new THREE.BufferAttribute(tArr, 1));
            this._telluricGroup.add(new THREE.Line(geo, this._matTelluric));
        }
    }

    // ── NOAA Kp index (real-time, free) ──────────────────────────────────────
    // Updates every 15 minutes. Kp 0–3 = quiet, 4–5 = active, 6+ = storm.
    async _fetchKp() {
        try {
            const res  = await fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json');
            const data = await res.json();
            if (data && data.length > 1) {
                // Last entry: [datetime, Kp, ...]
                const last = data[data.length - 1];
                const kp   = parseFloat(last[1]);
                if (!isNaN(kp)) {
                    this._uKp.value = kp;
                    console.log(`[MagneticField] Kp index: ${kp}`);
                }
            }
        } catch (e) {
            console.warn('[MagneticField] Kp fetch failed, using default:', e.message);
        }
        // Re-poll every 15 minutes
        setTimeout(() => this._fetchKp(), 15 * 60 * 1000);
    }

    // ── Per-frame update ──────────────────────────────────────────────────────
    update(elapsed) {
        this._uTime.value = elapsed;
    }

    // ── Visibility / opacity (called directly if needed) ─────────────────────
    setFieldVisible(on)    { this._fieldGroup.visible    = on; }
    setTelluricVisible(on) { this._telluricGroup.visible = on; }
    setFieldOpacity(v)     { this._uOpF.value = v * 0.75; }
    setTelluricOpacity(v)  { this._uOpT.value = v * 0.60; }

    // ── Cleanup ───────────────────────────────────────────────────────────────
    dispose() {
        [this._fieldGroup, this._telluricGroup].forEach(grp => {
            grp.traverse(obj => {
                obj.geometry?.dispose();
            });
            this._scene.remove(grp);
        });
        this._matField?.dispose();
        this._matTelluric?.dispose();
    }
}
