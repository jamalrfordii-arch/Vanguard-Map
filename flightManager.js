// flightManager.js — airplanes.live poller via local proxy
// Run flight-proxy.js in a second terminal first:  node flight-proxy.js
import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT, FLIGHT, AIRCRAFT_CLASSES, FLIGHT_DYNAMICS, AIRLINE_PREFIXES } from './config.js';
import { simClock } from './simClock.js';

// ── Heading/bank/pitch helpers ─────────────────────────────────────────────────
// Shortest signed angular difference a→b, in degrees, range (-180, 180].
function shortestAngleDelta(a, b) {
    return ((b - a + 540) % 360) - 180;
}

// ── ICAO type-code → visual subclass ──────────────────────────────────────────
// Maps the ADS-B `t` field (e.g. "B738", "A388", "C56X") to a visual class
// that selects the correct InstancedMesh set in aircraftInstancer.js.
// Returns null for unknown types so the caller can fall back to other signals.
// Sets are intentionally explicit (no fuzzy prefix matching) to avoid false
// positives — if a code is ambiguous, leave it out and let category-map handle it.
const _TC_MILITARY = new Set([
    'F15','F15E','F15C','F15D','F16','F16C','F16D','F18','F18C','F18D','F22','F35','F117',
    'B1','B1B','B2','B2A','B21','B52','B52H',
    'A10','AV8','U2','SR71',
    'C130','C130J','C17','C17A','C5','C5M','KC135','KC46','C141','C40','C37',
    'P3','P8','E3','E6','E8',
    'AH64','AH6','AH1','CH47','CH47F','UH60','MH60','SH60','OH58',
    'V22','MV22','CV22',
    'MQ9','MQ1','RQ4','RQ7',
    'T38','T45','T6','T6A','T1',
]);
const _TC_WIDEBODY = new Set([
    'B742','B743','B744','B748',
    'B762','B763','B764',
    'B772','B773','B77L','B77W','B77X','B788','B789','B78X',
    'A310',
    'A330','A332','A333','A338','A339',
    'A343','A345','A346',
    'A350','A358','A359','A35K',
    'A380','A388',
    'IL96','AN124','IL76','AN22',
]);
const _TC_REGIONAL = new Set([
    'E135','E140','E145',
    'E170','E175','E175L',
    'E190','E190E2','E195','E195E2',
    'E275','E290','E295',
    'CRJ1','CRJ2','CRJ7','CRJ9','CRJX',
    'DH8A','DH8B','DH8C','DH8D',
    'AT43','AT44','AT45','AT72','AT73','AT75','AT76',
    'SF34','B190','J328',
    'DHC6','DHC7','DHC8',
    'F50','F70','F100',
    'DO28','DO328',
    'AN24','AN26','AN28',
    'EM110','EM120',
]);
const _TC_BIZJET = new Set([
    'C25A','C25B','C25C','C25M',
    'C56X','C560','C55B','C551',
    'C680','C68A','C700','C750',
    'CL30','CL35','CL60',
    'F2TH','FA10','FA50','FA7X',
    'GL5T','GL7T','GLEX',
    'GALX','GULF',
    'GIV','GV','G150','G280','G350','G450','G550','G600','G650',
    'H25A','H25B',
    'LJ25','LJ31','LJ35','LJ45','LJ55','LJ60',
    'PC24','PRM1','SBRL',
    'BE40','WW24','WW23',
    'HA4T','ASTR',
    'E50P','E55P',
    'JSTR','HDJT',
]);
const _TC_NARROWBODY = new Set([
    'A318','A319','A320','A321','A20N','A21N',
    'B732','B733','B734','B735','B736','B737','B738','B739','B73X',
    'B38M','B39M',
    'MD80','MD81','MD82','MD83','MD87','MD88','MD90',
    'B717','DC9',
    'B752','B753',
    'MA60','TU154','TU204',
]);

// Returns a visual class string or null if the typeCode is unknown/unrecognised.
// Priority in classifyAircraft: MILITARY db-flag → CARGO callsign → this fn →
// emitter-category map → DEFAULT.
// Exported so main.js can call it from the hexdb-enrichment reclassification path
// (when the card opens and hexdb.io returns a typeCode that the ADS-B stream didn't
// carry — see `vg1:aircraftTypeEnriched` event handler in main.js).
export function typeCodeToVisualClass(typeCode) {
    if (!typeCode) return null;
    const t = typeCode.toUpperCase().trim();
    if (_TC_MILITARY.has(t))   return 'MILITARY';
    if (_TC_WIDEBODY.has(t))   return 'WIDEBODY';
    if (_TC_REGIONAL.has(t))   return 'REGIONAL';
    if (_TC_BIZJET.has(t))     return 'BIZJET';
    if (_TC_NARROWBODY.has(t)) return 'NARROWBODY';
    return null;
}

// ── Aircraft classification ───────────────────────────────────────────────────
// Picks a visual class from raw ADS-B fields. Priority order:
//   1. Military dbFlags bit (most authoritative — comes from operator databases)
//   2. Cargo callsign prefix (operator-level certainty)
//   3. ICAO typeCode → visual subclass (shape-accurate for known types)
//   4. Emitter category map (coarser — catches helicopters, GA, etc.)
//   5. Default (COMMERCIAL — generic airliner shape, matches old behaviour)
function classifyAircraft(s, callsign) {
    if (((s.dbFlags ?? 0) & AIRCRAFT_CLASSES.MILITARY_DB_FLAG) !== 0) return 'MILITARY';
    const prefix = callsign.slice(0, 3).toUpperCase();
    if (AIRCRAFT_CLASSES.CARGO_CALLSIGN_PREFIXES.includes(prefix)) return 'CARGO';
    const tcClass = typeCodeToVisualClass(s.t);
    if (tcClass) return tcClass;
    const cat = (s.category || '').toUpperCase();
    return AIRCRAFT_CLASSES.CATEGORY_MAP[cat] || AIRCRAFT_CLASSES.DEFAULT;
}

// Operator display name from the callsign's 3-letter ICAO prefix — local
// table lookup, no network call. Returns null (not '—') when unknown so
// callers can decide their own fallback text.
function operatorFromCallsign(callsign) {
    const prefix = (callsign || '').slice(0, 3).toUpperCase();
    return AIRLINE_PREFIXES[prefix] || null;
}

// ── Coordinate helper ─────────────────────────────────────────────────────────
// Continuous from ground up — no floor clamp. The old Math.max(2.0, ...)
// pinned every aircraft below ~3,600ft to the exact same height, which
// collapses departure/approach traffic near an airport into one overlapping
// stack regardless of their real altitude separation.
// Exported standalone so altitudeDeckManager.js can place its flight-level
// reference grids at the exact same heights aircraft actually render at,
// instead of duplicating this formula and risking drift between the two.
export function altitudeMetersToY(altMeters) {
    return altMeters > 50 ? 2.0 + (altMeters / 12000) * 20 : 2.0;
}

export function lonLatAltToScene(lon, lat, altMeters) {
    const x      = (lon / 180.0) * (MAP_WIDTH / 2.0);
    const latRad = lat * (Math.PI / 180.0);
    const mercY  = Math.log(Math.tan(Math.PI / 4.0 + latRad / 2.0));
    const z      = -(mercY / Math.PI) * (MAP_HEIGHT / 2.0);
    const y      = altitudeMetersToY(altMeters);
    return new THREE.Vector3(x, y, z);
}

// ── FlightManager ─────────────────────────────────────────────────────────────
export class FlightManager {
    constructor() {
        this.aircraft = new Map(); // icao24 → aircraftData
        this._timer   = null;

        this.onAircraftNew    = null; // (icao24, data) → void
        this.onAircraftUpdate = null; // (icao24, data) → void
        this.onAircraftRemove = null; // (icao24) → void — genuine stale/lost-signal removal only
        // (icao24, data) → void — fired when the feed explicitly reports the
        // aircraft on the ground (alt_baro === 'ground'), i.e. it landed.
        // Distinct from onAircraftRemove: that fires after STALE_MS of total
        // silence, which is what actually happens when an aircraft flies out
        // of receiver range or its transponder fails — a real "lost signal"
        // event. Without this split, a normal landing and a genuine signal
        // loss were indistinguishable (both just stopped updating until the
        // same 2-minute timeout removed them), so a landing was wrongly
        // logged identically to losing track of an aircraft mid-flight.
        this.onAircraftLanded = null;
        // (report) → void — fired for EVERY parsed state, new or existing,
        // before scene mutation. Wired to flightIntegrityManager.evaluate in
        // main.js; kept generic so this module stays ignorant of scoring.
        this.onPositionEvaluated = null;
        // (state) → void — every raw wire-shaped aircraft state, fired before
        // any parsing/filtering (including ground reports, so a replay can
        // reproduce landings faithfully). Mirrors aisManager.onRawMessage —
        // this is the recorder tap. Zero behavior change when unset.
        this.onRawAircraft = null;

        this._livePaused = false; // true during replay: _poll() is muted
    }

    // Pause/resume the live poll without stopping the timer — used during
    // replay so recorded and live traffic don't fight (same contract as
    // aisManager.setLivePaused).
    setLivePaused(v) { this._livePaused = !!v; }

    // Public injection point for recorded/synthetic states — wire-shaped
    // array (same fields as the live feed's `ac` entries). Downstream cannot
    // tell injected traffic from a live poll.
    ingest(states) {
        if (!Array.isArray(states) || states.length === 0) return;
        this._handleData({ ac: states });
    }

    // Remove every aircraft (fires onAircraftRemove for scene cleanup).
    // Used when entering replay: a fresh sky prevents stale live aircraft
    // lingering next to replayed ones.
    clearAll() {
        this.aircraft.forEach((_, icao24) => {
            if (this.onAircraftRemove) this.onAircraftRemove(icao24);
        });
        this.aircraft.clear();
    }

    init() {
        this._poll();
        this._timer = setInterval(() => this._poll(), FLIGHT.POLL_INTERVAL);
    }

    async _poll() {
        if (this._livePaused) return; // replay in progress — live feed muted
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
            // Recorder tap FIRST — raw wire shape, before any filtering, so a
            // capture is a faithful record of what the feed actually said.
            if (this.onRawAircraft) this.onRawAircraft(s);

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
            const squawk    = s.squawk ?? null;
            const emergency = s.emergency ?? null;
            const aircraftClass = classifyAircraft(s, callsign);
            // Registration (tail number) and ICAO type code (e.g. "B738") come
            // straight off the wire on ADSBExchange-compatible feeds — no extra
            // lookup needed, just weren't plumbed through before. Operator is a
            // local table lookup off the callsign prefix (see AIRLINE_PREFIXES,
            // config.js); origin/destination/photo need a network round trip and
            // are fetched on demand by uiController.js when a card is opened,
            // not here on every poll.
            const registration = s.r || null;
            const typeCode      = s.t || null;
            const operator      = operatorFromCallsign(callsign);
            // Position source — ADSBExchange-compatible feeds (airplanes.live,
            // adsb.lol) tag every state with a `type` field: 'adsb_icao' /
            // 'adsb_icao_nt' for a direct transponder fix, 'mlat' for ground-
            // station multilateration (no direct fix, triangulated from
            // signal timing — materially less precise), 'tisb_icao'/'tisb_*'
            // for relayed traffic-info broadcasts. Anything containing
            // "mlat" is treated as MLAT; everything else defaults to ADS-B
            // (the overwhelming majority of states on this feed).
            const positionSource = String(s.type || '').toLowerCase().includes('mlat') ? 'MLAT' : 'ADSB';

            // Symmetric appear/disappear floor (FLIGHT.MIN_ALT_M, 300ft AGL):
            // an aircraft only exists in the scene above this altitude.
            // Either an explicit 'ground' report OR simply dropping back
            // below the same floor counts as landed — same threshold both
            // directions, so an aircraft fades in and out at the same
            // altitude rather than appearing at one cutoff and lingering
            // until a separate ground flag arrives (which some feeds are
            // slow to set during taxi/final approach). Handled immediately
            // rather than falling through to the STALE_MS timeout, which
            // would make a landing indistinguishable from genuinely losing
            // the signal mid-flight (see onAircraftLanded above).
            const belowFloor = onGround || altMeters < FLIGHT.MIN_ALT_M;
            if (belowFloor) {
                const grounded = this.aircraft.get(icao24);
                if (grounded) {
                    if (this.onAircraftLanded) this.onAircraftLanded(icao24, grounded);
                    this.aircraft.delete(icao24);
                }
                continue;
            }
            if (lon == null || lat == null) continue;
            if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
            const scenePos = lonLatAltToScene(lon, lat, altMeters);

            // Fire BEFORE scene mutation — integrity scoring needs the raw
            // report, not the lerp/trail bookkeeping below. Every parsed
            // state gets evaluated, new aircraft and updates alike; the
            // scoring module tracks its own previous-position snapshot
            // internally so it doesn't need to know which branch this is.
            if (this.onPositionEvaluated) {
                this.onPositionEvaluated({
                    icao24, callsign, lat, lon, altMeters, speedKts,
                    headingDeg: heading, squawk, emergency, now,
                });
            }

            const existing = this.aircraft.get(icao24);
            if (existing) {
                // Lerp must start from where the aircraft is actually sitting on
                // screen right now (currentPos) — NOT the old targetPos. Between
                // polls, the dead-reckoning branch in tick() has been mutating
                // currentPos directly every frame based on heading/speed, so by
                // the time a new report lands ~POLL_INTERVAL later, currentPos
                // has already walked well past the old targetPos. Resetting
                // prevPos to that stale, already-passed targetPos made the lerp
                // open by snapping the plane backward to it before crawling
                // forward again — the "slow motion then snap" Jamal saw live.
                existing.prevPos.copy(existing.currentPos);
                // Project targetPos FORWARD along the heading by ~10s of visual
                // dead-reckoning so the lerp always travels forward, never back.
                // Without this, GPS truth (scenePos) sits behind the visually-
                // overshot currentPos and the lerp visibly pulls the plane back
                // every 30-second poll before DR resumes pushing it forward.
                {
                    const _lerpSec  = 10;          // matches 1 / (delta * 0.1) at 60fps
                    const _spd      = speedKts * 0.51444;
                    const _distM    = _spd * _lerpSec;
                    const _mPerDeg  = 111320;
                    const _vis      = MAP_HEIGHT / (2.0 * Math.PI);
                    const _hdgRad   = heading * (Math.PI / 180);
                    const _dd       = (_distM / _mPerDeg) * _vis;
                    existing.targetPos.copy(scenePos);
                    existing.targetPos.x += Math.sin(_hdgRad) * _dd;
                    existing.targetPos.z -= Math.cos(_hdgRad) * _dd;
                }
                existing.lerpAlpha  = 0;
                existing.speedKts   = speedKts;
                existing.headingDeg = heading;       // raw latest report — informational only now (UI mirror via main.js's obj.userData.headingDeg). Movement AND visual orientation both use currentHeadingDeg as of the 2026-06-28 heading-mismatch fix in tick() — don't reintroduce a dead-reckoning consumer of this raw field without re-checking that fix.
                existing.targetHeadingDeg = heading; // what currentHeadingDeg eases toward in tick()

                // Vertical rate from the altitude delta since the last report —
                // only one sample per poll, so this is necessarily a coarse
                // average over ~POLL_INTERVAL, not an instantaneous reading.
                // Guard dt against near-zero (duplicate/rapid reports) to avoid
                // a divide-by-near-zero spike feeding a momentary huge pitch.
                const dtSec = Math.max(1, (now - existing.lastSeen) / 1000);
                existing.verticalRateMs = (altMeters - existing.altMeters) / dtSec;

                existing.latDeg     = lat;
                existing.lonDeg     = lon;
                existing.altMeters  = altMeters;
                existing.lastSeen   = now;
                existing.aircraftClass = aircraftClass; // can re-classify (e.g. dbFlags arrives later)
                existing.positionSource = positionSource; // MLAT/ADS-B can flip poll-to-poll
                // Registration/type rarely arrive on the very first report for a
                // given aircraft (partial decode) — keep whichever value we already
                // have if this poll's report doesn't include one, rather than
                // flickering a known tail number back to "—".
                if (registration) existing.registration = registration;
                if (typeCode)      existing.typeCode      = typeCode;
                if (operator)      existing.operator      = operator;
                if (this.onAircraftUpdate) this.onAircraftUpdate(icao24, existing);
            } else {
                if (this.aircraft.size >= FLIGHT.MAX_AIRCRAFT) continue;
                const a = {
                    icao24, callsign, country, aircraftClass, positionSource,
                    registration, typeCode, operator,
                    speedKts, headingDeg: heading,
                    latDeg: lat, lonDeg: lon, altMeters,
                    currentPos:  scenePos.clone(),
                    prevPos:     scenePos.clone(),
                    targetPos:   scenePos.clone(),
                    lerpAlpha:   1,
                    lastSeen:    now,
                    threeObject: null,
                    history:     [],
                    // Visual flight-dynamics state — see FLIGHT_DYNAMICS in
                    // config.js and tick() below. Starts settled (no snap on
                    // spawn): current === target, bank/pitch flat.
                    currentHeadingDeg: heading,
                    targetHeadingDeg:  heading,
                    bankDeg:           0,
                    pitchDeg:          0,
                    verticalRateMs:    0,
                    // Motion-graphics polish (2026-06-27): ramps 0→1 over
                    // FLIGHT_DYNAMICS.SPAWN_EASE_SEC, consumed as an
                    // instance-scale multiplier in aircraftInstancer.js so a
                    // newly-appearing aircraft scales in rather than popping
                    // to full size on the first frame it's drawn.
                    spawnEase:         0,
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
                // Bug fix (2026-06-28): this used to dead-reckon off
                // a.headingDeg — the raw, just-arrived report, which snaps
                // to its new value the instant a poll lands. The visual
                // orientation below (currentHeadingDeg) only turns at a
                // capped rate (FLIGHT_DYNAMICS.TURN_RATE_DEG_PER_SEC), so for
                // several seconds after every report the aircraft was
                // moving in the new direction while still visually pointed
                // the old way — read as "erratic"/crabbing motion, worst
                // during turns where consecutive reports differ most.
                // currentHeadingDeg is the single source of truth for both
                // movement and orientation now, so the plane always travels
                // exactly where it's pointed.
                const hdgRad  = a.currentHeadingDeg * (Math.PI / 180);
                const mPerDeg = 111320;
                const dLat    = Math.cos(hdgRad) * (distM / mPerDeg);
                const cosLat  = Math.cos(a.latDeg * Math.PI / 180) || 0.001;
                const dLon    = Math.sin(hdgRad) * (distM / (mPerDeg * cosLat));

                a.latDeg += dLat;
                a.lonDeg += dLon;
                // Visual dead-reckoning: apply a unified scale (MAP_HEIGHT / 2π ≈ 47.75)
                // to BOTH axes so direction is exact (sin/cos heading ratio preserved) and
                // planes are visibly traversing the map between 30-second GPS polls.
                // The lerp at each new poll re-anchors currentPos to GPS truth, so the
                // accumulated visual overshoot is corrected every poll cycle.
                // (Applying the old Z-only scale to just Z made planes drift toward north
                // regardless of heading — the 57× Z vs 1× X imbalance was the direction bug.)
                const visScale = MAP_HEIGHT / (2.0 * Math.PI);
                const distDeg  = distM / mPerDeg;
                a.currentPos.x += Math.sin(hdgRad) * distDeg * visScale;
                a.currentPos.z -= Math.cos(hdgRad) * distDeg * visScale;
            }

            // ── Visual flight dynamics (heading ease, bank, pitch) ──────────
            // Heading itself eases toward the latest report at a capped turn
            // rate instead of snapping (matches the position lerp above —
            // same "no instant jump on a new report" principle, applied to
            // rotation). Bank/pitch are then derived from how much turning/
            // climbing is currently happening, each with their own ease rate
            // so they ramp in and out rather than snapping with the heading.
            if (a.currentHeadingDeg != null) {
                const headingErr = shortestAngleDelta(a.currentHeadingDeg, a.targetHeadingDeg);
                const maxStep     = FLIGHT_DYNAMICS.TURN_RATE_DEG_PER_SEC * delta;
                const step        = Math.max(-maxStep, Math.min(maxStep, headingErr));
                a.currentHeadingDeg = (a.currentHeadingDeg + step + 360) % 360;

                const bankTarget = Math.max(-FLIGHT_DYNAMICS.BANK_MAX_DEG,
                    Math.min(FLIGHT_DYNAMICS.BANK_MAX_DEG, headingErr * FLIGHT_DYNAMICS.BANK_GAIN));
                a.bankDeg += (bankTarget - a.bankDeg) * Math.min(1, delta * FLIGHT_DYNAMICS.BANK_EASE_RATE);

                const pitchTarget = Math.max(-FLIGHT_DYNAMICS.PITCH_MAX_DEG,
                    Math.min(FLIGHT_DYNAMICS.PITCH_MAX_DEG, (a.verticalRateMs ?? 0) * FLIGHT_DYNAMICS.PITCH_GAIN));
                a.pitchDeg += (pitchTarget - a.pitchDeg) * Math.min(1, delta * FLIGHT_DYNAMICS.PITCH_EASE_RATE);
            }

            // Spawn-in scale ramp — see spawnEase field above. Plain linear
            // ramp here; the pop/overshoot shaping (easeOutBack) is applied
            // where it's consumed in aircraftInstancer.js, not here, so this
            // stays a simple 0→1 progress value other consumers could also
            // read literally (e.g. fading in a label) without inheriting the
            // overshoot curve.
            if (a.spawnEase < 1) {
                a.spawnEase = Math.min(1, a.spawnEase + delta / FLIGHT_DYNAMICS.SPAWN_EASE_SEC);
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
