// satelliteManager.js — Real satellite tracking via Celestrak TLE + SGP4 propagation.
//
// Data flow:
//   1. Fetch TLE text from the local proxy  (/satellites?group=...)
//   2. Parse TLE triplets (name / line1 / line2)
//   3. Build satrec objects with satellite.js twoline2satrec()
//   4. Every animation frame: propagate each satrec → ECI → geodetic → Mercator scene pos
//   5. Fire onSatelliteNew / onSatelliteUpdate callbacks so main.js can manage 3D objects
//
// Run flight-proxy.js first — it now also proxies Celestrak to avoid CORS.
import * as sat from 'https://cdn.skypack.dev/satellite.js@5.0.0';
import { MAP_WIDTH, MAP_HEIGHT } from './config.js';
import { simClock } from './simClock.js';

// ── Celestrak groups to fetch (via local proxy) ───────────────────────────────
// Keep totals manageable: stations(~10) + gps(~32) + weather(~20) + starlink(capped 80)
const GROUPS = [
    { key: 'stations', type: 'STATION',  cap: 999 },
    { key: 'gps',      type: 'GPS',      cap: 999 },
    { key: 'weather',  type: 'WEATHER',  cap: 999 },
    { key: 'starlink', type: 'STARLINK', cap: 80  }, // thousands exist — cap for perf
];

// ── Altitude → scene Y (logarithmic so LEO/MEO/GEO all fit on-screen) ─────────
// LEO  (~400 km) → Y ≈ 38   MEO (~20 200 km) → Y ≈ 53   GEO (~35 786 km) → Y ≈ 55
const SAT_Y_MIN    = 35;    // scene Y for lowest LEO
const SAT_Y_RANGE  = 20;    // total Y band for all orbits
const ALT_LOG_MIN  = Math.log10(200);          // 200 km floor
const ALT_LOG_MAX  = Math.log10(36000);        // GEO ceiling

export function satAltToSceneY(altKm) {
    const km = Math.max(200, Math.min(36000, altKm || 400));
    const t  = (Math.log10(km) - ALT_LOG_MIN) / (ALT_LOG_MAX - ALT_LOG_MIN);
    return SAT_Y_MIN + t * SAT_Y_RANGE;
}

// ── Lat/lon → scene X, Z (Mercator — same formula used for ships & aircraft) ──
function toSceneXZ(latDeg, lonDeg) {
    // Normalise longitude to [-180, 180]
    const lon     = ((lonDeg + 180) % 360 + 360) % 360 - 180;
    const x       = lon * (MAP_WIDTH / 360);
    const latCl   = Math.max(-82, Math.min(82, latDeg));
    const latRad  = latCl * (Math.PI / 180);
    const mercY   = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
    const z       = -mercY * (MAP_HEIGHT / (2 * Math.PI));
    return { x, z };
}

// ── SatelliteManager ──────────────────────────────────────────────────────────
export class SatelliteManager {
    constructor() {
        this.satellites = new Map();   // noradId → satData
        this._satrecs   = new Map();   // noradId → satrec

        // Callbacks — set these before calling init()
        this.onSatelliteNew    = null; // (id, data) → void
        this.onSatelliteUpdate = null; // (id, data) → void
        this.onSatelliteRemove = null; // (id) → void
    }

    // ── Initialise: fetch all groups, then re-fetch every hour ───────────────
    async init() {
        this._updateStatus('FETCHING');
        await this._fetchAll();
        setInterval(() => this._fetchAll(), 3_600_000); // TLEs age slowly — 1 h is fine
    }

    async _fetchAll() {
        for (const { key, type, cap } of GROUPS) {
            try {
                await this._fetchGroup(key, type, cap);
            } catch (e) {
                console.warn(`[SAT] Failed to fetch group "${key}":`, e.message);
            }
        }
        this._updateStatus(`LIVE // ${this.satellites.size} TRACKED`);
    }

    async _fetchGroup(key, type, cap) {
        const res = await fetch(`http://localhost:8787/satellites?group=${key}`, {
            signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        this._parseTLE(text, type, cap);
    }

    // ── TLE parsing ───────────────────────────────────────────────────────────
    _parseTLE(text, type, cap) {
        const lines  = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
        let   count  = 0;

        for (let i = 0; i + 2 < lines.length; i += 3) {
            if (count >= cap) break;

            const name = lines[i].replace(/^0 /, '').trim(); // strip leading "0 " if 3LE format
            const tle1 = lines[i + 1];
            const tle2 = lines[i + 2];

            // Sanity check — TLE lines always start with '1 ' / '2 '
            if (!tle1.startsWith('1 ') || !tle2.startsWith('2 ')) continue;

            // NORAD catalog number is columns 3–7 of TLE line 2
            const id = tle2.substring(2, 7).trim();

            try {
                const satrec = sat.twoline2satrec(tle1, tle2);
                if (satrec.error !== 0) continue; // SGP4 init failed

                this._satrecs.set(id, satrec);

                if (!this.satellites.has(id)) {
                    const data = {
                        id, name, type,
                        latDeg: 0, lonDeg: 0, altKm: 400,
                        speedKmS: 7.8,
                        headingDeg: 0,
                        threeObject: null,
                    };
                    this.satellites.set(id, data);

                    // Compute first position before notifying so coordinates exist
                    this._propagateOne(id, data);
                    if (this.onSatelliteNew) this.onSatelliteNew(id, data);
                } else {
                    // TLE refreshed — just update the satrec silently
                    const data = this.satellites.get(id);
                    this._propagateOne(id, data);
                }

                count++;
            } catch (_) {
                // Skip malformed records without crashing
            }
        }
    }

    // ── Propagate a single satellite to the current UTC instant ──────────────
    _propagateOne(id, data) {
        const satrec = this._satrecs.get(id);
        if (!satrec) return;

        const now = simClock.date();
        const pv  = sat.propagate(satrec, now);

        if (!pv || !pv.position || typeof pv.position !== 'object') return;

        const gmst = sat.gstime(now);
        const gd   = sat.eciToGeodetic(pv.position, gmst);

        const prevLon = data.lonDeg;
        data.latDeg   = sat.radiansToDegrees(gd.latitude);
        data.lonDeg   = sat.radiansToDegrees(gd.longitude);
        data.altKm    = gd.height; // km

        // Approximate heading from Δlon (quick, good enough for trail orientation)
        const dLon = data.lonDeg - prevLon;
        if (Math.abs(dLon) < 90) {
            data.headingDeg = Math.atan2(dLon, data.latDeg - (data._prevLat ?? data.latDeg)) * (180 / Math.PI);
        }
        data._prevLat = data.latDeg;

        // Velocity magnitude (km/s)
        if (pv.velocity) {
            const v = pv.velocity;
            data.speedKmS = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
        }
    }

    // ── tick — called every animation frame ──────────────────────────────────
    // SGP4 propagation is expensive (~140+ trig-heavy calcs per call).
    // Satellites move slowly enough that 10 Hz is visually indistinguishable
    // from 60 Hz, so we skip propagation on 5 out of every 6 frames.
    tick(_delta) {
        this._tickCount = (this._tickCount ?? 0) + 1;
        if (this._tickCount % 6 !== 0) return;

        this.satellites.forEach((data, id) => {
            this._propagateOne(id, data);
            if (this.onSatelliteUpdate) this.onSatelliteUpdate(id, data);
        });
    }

    // ── Utility ───────────────────────────────────────────────────────────────
    getScenePosition(data) {
        const { x, z } = toSceneXZ(data.latDeg, data.lonDeg);
        return { x, y: satAltToSceneY(data.altKm), z };
    }

    _updateStatus(msg) {
        const el = document.getElementById('sat-status');
        if (el) el.innerText = msg;
        const dot = document.getElementById('sat-dot');
        if (dot) dot.classList.toggle('live', msg.startsWith('LIVE'));
    }
}
