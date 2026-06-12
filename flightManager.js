// flightManager.js — airplanes.live poller via local proxy
// Run flight-proxy.js in a second terminal first:  node flight-proxy.js
import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT, FLIGHT } from './config.js';
import { simClock } from './simClock.js';

// ── Coordinate helper ─────────────────────────────────────────────────────────
export function lonLatAltToScene(lon, lat, altMeters) {
    const x      = (lon / 180.0) * (MAP_WIDTH / 2.0);
    const latRad = lat * (Math.PI / 180.0);
    const mercY  = Math.log(Math.tan(Math.PI / 4.0 + latRad / 2.0));
    const z      = -(mercY / Math.PI) * (MAP_HEIGHT / 2.0);
    const y      = altMeters > 50 ? Math.max(2.0, (altMeters / 12000) * 22) : 2.0;
    return new THREE.Vector3(x, y, z);
}

// ── FlightManager ─────────────────────────────────────────────────────────────
export class FlightManager {
    constructor() {
        this.aircraft = new Map(); // icao24 → aircraftData
        this._timer   = null;

        this.onAircraftNew    = null; // (icao24, data) → void
        this.onAircraftUpdate = null; // (icao24, data) → void
        this.onAircraftRemove = null; // (icao24) → void
    }

    init() {
        this._poll();
        this._timer = setInterval(() => this._poll(), FLIGHT.POLL_INTERVAL);
    }

    async _poll() {
        try {
            this._setStatus('POLLING...');
            const res = await fetch(FLIGHT.API_URL, { signal: AbortSignal.timeout(15000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (!data || !Array.isArray(data.ac)) throw new Error('Bad payload');
            this._handleData(data);
        } catch (err) {
            console.warn('[FLIGHT] Poll error:', err.message);
            this._setStatus('PROXY OFFLINE');
        }
    }

    _handleData(data) {
        const states = data.ac || [];
        const now    = simClock.now();

        for (const s of states) {
            const icao24    = s.hex;
            const callsign  = (s.flight || '').trim().replace(/[^\x20-\x7E]/g, '') || 'UNKNOWN';
            const country   = '';
            const lon       = s.lon;
            const lat       = s.lat;
            const altFeet   = s.alt_baro;
            const onGround  = altFeet === 'ground';
            const altMeters = onGround ? 0 : (altFeet ?? s.alt_geom ?? 0) * 0.3048;
            const speedKts  = Math.round(s.gs ?? 0);
            const heading   = s.track ?? 0;

            if (onGround || lon == null || lat == null) continue;
            if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
            if (altMeters < 100) continue;
            const scenePos = lonLatAltToScene(lon, lat, altMeters);

            const existing = this.aircraft.get(icao24);
            if (existing) {
                existing.prevPos.copy(existing.targetPos);
                existing.targetPos.copy(scenePos);
                existing.lerpAlpha  = 0;
                existing.speedKts   = speedKts;
                existing.headingDeg = heading;
                existing.latDeg     = lat;
                existing.lonDeg     = lon;
                existing.altMeters  = altMeters;
                existing.lastSeen   = now;
                if (this.onAircraftUpdate) this.onAircraftUpdate(icao24, existing);
            } else {
                if (this.aircraft.size >= FLIGHT.MAX_AIRCRAFT) continue;
                const a = {
                    icao24, callsign, country,
                    speedKts, headingDeg: heading,
                    latDeg: lat, lonDeg: lon, altMeters,
                    currentPos:  scenePos.clone(),
                    prevPos:     scenePos.clone(),
                    targetPos:   scenePos.clone(),
                    lerpAlpha:   1,
                    lastSeen:    now,
                    threeObject: null,
                    history:     []
                };
                this.aircraft.set(icao24, a);
                if (this.onAircraftNew) this.onAircraftNew(icao24, a);
            }
        }

        this._setStatus('LIVE // ANON');
        this._updateCount();
    }

    tick(delta) {
        const now   = simClock.now();
        const stale = [];

        this.aircraft.forEach((a, icao24) => {
            if (a.lerpAlpha < 1) {
                a.lerpAlpha = Math.min(1, a.lerpAlpha + delta * 0.1);
                a.currentPos.lerpVectors(a.prevPos, a.targetPos, a.lerpAlpha);
            } else if (a.speedKts > 50 && a.threeObject) {
                const speedMs = a.speedKts * 0.51444;
                const distM   = speedMs * delta;
                const hdgRad  = a.headingDeg * (Math.PI / 180);
                const mPerDeg = 111320;
                const dLat    = Math.cos(hdgRad) * (distM / mPerDeg);
                const cosLat  = Math.cos(a.latDeg * Math.PI / 180) || 0.001;
                const dLon    = Math.sin(hdgRad) * (distM / (mPerDeg * cosLat));

                a.latDeg       += dLat;
                a.lonDeg       += dLon;
                a.currentPos.x += (dLon / 180.0) * (MAP_WIDTH  / 2.0);
                a.currentPos.z -= dLat * (MAP_HEIGHT / (2.0 * Math.PI));
            }

            if (now - a.lastSeen > FLIGHT.STALE_MS) stale.push(icao24);
        });

        stale.forEach(icao24 => {
            if (this.onAircraftRemove) this.onAircraftRemove(icao24);
            this.aircraft.delete(icao24);
        });
    }

    _setStatus(text) {
        const el = document.getElementById('flight-status');
        if (el) el.innerText = text;
    }
    _updateCount() {
        const el = document.getElementById('flight-count');
        if (el) el.innerText = this.aircraft.size;
    }

    disconnect() {
        if (this._timer) clearInterval(this._timer);
    }
}
