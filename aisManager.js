// aisManager.js — AISStream WebSocket manager, vessel registry, and API key prompt
import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT, AIS } from './config.js';
import { MID_TO_COUNTRY } from './aisCountries.js';
import { typeCache } from './typeCache.js';
import { simClock } from './simClock.js';
import { checkPositionReport, parseEventTime } from './invariants.js';

function mmsiToCountry(mmsi) {
    const mid = parseInt(String(mmsi).slice(0, 3), 10);
    return MID_TO_COUNTRY[mid] || null;
}

// ── Coordinate helper (mirrors lonLatToVec3 in entityBuilder.js) ─────────────
export function lonLatToScene(lon, lat, y = 0) {
    const x      = (lon / 180.0) * (MAP_WIDTH / 2.0);
    const latRad = lat * (Math.PI / 180.0);
    const mercY  = Math.log(Math.tan(Math.PI / 4.0 + latRad / 2.0));
    const z      = -(mercY / Math.PI) * (MAP_HEIGHT / 2.0);
    return new THREE.Vector3(x, y, z);
}

// ── AIS numeric ShipType → VANGUARD entity class ─────────────────────────────
// Source: ITU-R M.1371 Annex 8 (AIS ship-type table).
//
// HONESTY PRINCIPLE: AIS cannot detect warships — naval combatants do not
// broadcast AIS, so there is NO military/patrol/hostile class here. Vessels
// are classified strictly by what the transponder declares. Self-declared
// "military operations" (35) and "law enforcement" (55) are rare and noisy,
// so they fold into OTHER rather than implying real military detection.
//
// Note: the AIS type code cannot distinguish container vs bulk vs RoRo within
// CARGO (the second digit encodes hazardous-cargo category, not ship subtype).
// Finer cargo subtyping would require the ship name or an external registry.
function aisTypeToClass(t) {
    if (t == null) return 'OTHER';
    if (t >= 70 && t <= 79)                       return 'CARGO';     // 70-79 cargo
    if (t >= 80 && t <= 89)                       return 'TANKER';    // 80-89 tanker
    if (t >= 60 && t <= 69)                       return 'PASSENGER'; // 60-69 passenger/cruise/ferry
    if (t >= 40 && t <= 49)                       return 'HSC';       // 40-49 high-speed craft
    if (t === 30)                                 return 'FISHING';   // 30 fishing
    if (t === 31 || t === 32 || t === 52)         return 'TUG';       // towing / tug
    if (t === 33)                                 return 'DREDGER';   // dredging / underwater ops
    if (t === 50)                                 return 'PILOT';     // pilot vessel
    if (t === 36)                                 return 'SAILING';   // sailing
    if (t === 37)                                 return 'PLEASURE';  // pleasure craft
    if (t === 51 || t === 53 || t === 54 ||
        t === 58 || t === 59)                     return 'SERVICE';   // SAR / tender / anti-pollution / medical / noncombatant
    return 'OTHER';                                                   // 20-29 WIG, 35 military, 55 law enf., 90-99 other, unknown
}

// ── API Key prompt (styled to match VANGUARD HUD) ────────────────────────────
function promptForAPIKey() {
    return new Promise(resolve => {
        const saved = localStorage.getItem(AIS.STORAGE_KEY);
        // AGENT_BYPASS is written by automated agents during testing.
        // Treat it as "no key" — show the prompt rather than attempting
        // a live WebSocket connection with a fake credential.
        if (saved && saved !== 'AGENT_BYPASS') { resolve(saved); return; }
        if (saved === 'AGENT_BYPASS') localStorage.removeItem(AIS.STORAGE_KEY);

        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position:fixed; inset:0;
            background:rgba(1,4,9,0.96);
            display:flex; flex-direction:column;
            justify-content:center; align-items:center;
            z-index:200;
            font-family:'Courier New',Courier,monospace;
        `;

        overlay.innerHTML = `
            <div style="
                border:1px solid #40c4ff;
                border-left:4px solid #40c4ff;
                padding:32px 40px;
                background:rgba(1,10,20,0.92);
                max-width:440px; width:90%;
                box-shadow:0 0 50px rgba(64,196,255,0.12);
            ">
                <div style="color:#fff; font-size:14px; letter-spacing:3px; font-weight:800; text-transform:uppercase; margin-bottom:5px;">
                    AIS STREAM INTEGRATION
                </div>
                <div style="color:#40c4ff; font-size:10px; letter-spacing:1px; text-transform:uppercase; margin-bottom:24px; opacity:0.8;">
                    Live Maritime Domain Awareness // Mediterranean Region
                </div>

                <div style="color:#8aabc4; font-size:10px; letter-spacing:1px; text-transform:uppercase; margin-bottom:6px;">
                    AISStream API Key
                </div>
                <input id="ais-key-input" type="password"
                    placeholder="Paste your key here..."
                    autocomplete="off"
                    style="
                        width:100%; box-sizing:border-box;
                        background:rgba(0,0,0,0.5);
                        border:1px solid rgba(64,196,255,0.4);
                        color:#fff; padding:10px 12px;
                        font-family:'Courier New',monospace;
                        font-size:11px; outline:none;
                        letter-spacing:1px; margin-bottom:10px;
                    "
                />
                <div id="ais-key-error" style="color:#ff1744; font-size:9px; letter-spacing:1px; text-transform:uppercase; min-height:14px; margin-bottom:8px;"></div>

                <label style="
                    display:flex; align-items:center; gap:8px;
                    font-size:10px; color:#8aabc4; margin-bottom:22px;
                    cursor:pointer; text-transform:uppercase; letter-spacing:1px;
                ">
                    <input type="checkbox" id="ais-remember" style="accent-color:#40c4ff;" checked>
                    Remember on this device
                </label>

                <button id="ais-connect-btn" style="
                    width:100%;
                    background:rgba(64,196,255,0.1);
                    border:1px solid #40c4ff;
                    color:#40c4ff; padding:12px;
                    font-family:'Courier New',monospace;
                    font-size:11px; cursor:pointer;
                    text-transform:uppercase; letter-spacing:2px;
                    transition:background 0.2s;
                ">CONNECT TO AIS NETWORK</button>

                <button id="ais-demo-btn" style="
                    width:100%; margin-top:10px;
                    background:transparent;
                    border:1px solid rgba(138,171,196,0.45);
                    color:#8aabc4; padding:12px;
                    font-family:'Courier New',monospace;
                    font-size:11px; cursor:pointer;
                    text-transform:uppercase; letter-spacing:2px;
                    transition:border-color 0.2s, color 0.2s;
                ">VIEW DEMO — NO KEY NEEDED</button>

                <div style="margin-top:14px; font-size:9px; color:#4a6b84; text-align:center; text-transform:uppercase; letter-spacing:1px; line-height:1.6;">
                    Free API key available at <span style="color:#40c4ff;">aisstream.io</span><br>
                    Demo mode shows scripted synthetic traffic — no live data
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        const btn      = document.getElementById('ais-connect-btn');
        const input    = document.getElementById('ais-key-input');
        const errorEl  = document.getElementById('ais-key-error');
        const remember = document.getElementById('ais-remember');

        btn.addEventListener('mouseover', () => btn.style.background = 'rgba(64,196,255,0.25)');
        btn.addEventListener('mouseout',  () => btn.style.background = 'rgba(64,196,255,0.1)');

        function submit() {
            const key = input.value.trim();
            if (!key) {
                errorEl.innerText = 'KEY REQUIRED';
                input.focus();
                return;
            }
            if (remember.checked) localStorage.setItem(AIS.STORAGE_KEY, key);
            overlay.remove();
            resolve(key);
        }

        btn.addEventListener('click', submit);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });

        // Demo mode — no key, no live socket; synthetic scenario instead.
        const demoBtn = document.getElementById('ais-demo-btn');
        demoBtn.addEventListener('mouseover', () => { demoBtn.style.borderColor = '#8aabc4'; demoBtn.style.color = '#cfe3f1'; });
        demoBtn.addEventListener('mouseout',  () => { demoBtn.style.borderColor = 'rgba(138,171,196,0.45)'; demoBtn.style.color = '#8aabc4'; });
        demoBtn.addEventListener('click', () => {
            overlay.remove();
            resolve(DEMO_MODE);
        });

        input.focus();
    });
}

// Sentinel returned by promptForAPIKey when the user picks demo mode.
export const DEMO_MODE = Symbol('vg1-demo-mode');

// ── AISManager ───────────────────────────────────────────────────────────────
export class AISManager {
    constructor() {
        this.ws      = null;
        this._apiKey = null;
        this.vessels = new Map(); // MMSI string → vessel state object

        // Callbacks set by main.js
        this.onVesselNew      = null; // (mmsi, vesselData) → void
        this.onVesselUpdate   = null; // (mmsi, vesselData) → void
        this.onVesselRemove   = null; // (mmsi) → void
        this.onVesselDark     = null; // (mmsi, vesselData) → void  — fired once when vessel goes silent
        this.onVesselReappear = null; // (mmsi, vesselData) → void  — fired when dark vessel sends again
        this.onVesselReclassify = null; // (mmsi, vesselData) → void — ship type arrived via static; rebuild model
        this.onRawMessage     = null; // (msg) → void — every inbound message, any source (AISRecorder tap)

        this._sources = new Set();    // attached DataSource instances (dataSource.js)
    }

    // ── Source seam ──────────────────────────────────────────────────────────
    // Single entry point for ALL traffic — live WebSocket, recorded replay,
    // and synthetic scenarios. Sources cannot be told apart downstream.
    ingest(msg) {
        if (this.onRawMessage) this.onRawMessage(msg);
        this._handleMsg(msg);
    }

    attachSource(source) {
        this._sources.add(source);
        source.start(msg => this.ingest(msg));
    }

    detachSource(source) {
        source.stop();
        this._sources.delete(source);
    }

    detachAllSources() {
        this._sources.forEach(s => s.stop());
        this._sources.clear();
    }

    // Pause/resume the LIVE WebSocket feed without closing the socket —
    // used during replay so recorded and live traffic don't fight.
    setLivePaused(v) { this._livePaused = !!v; }

    // Remove every vessel (fires onVesselRemove for scene cleanup). Used when
    // entering replay: a fresh world prevents the invariant gate from rejecting
    // replayed positions as impossible teleports of existing vessels.
    clearAllVessels() {
        this.vessels.forEach((v, mmsi) => {
            if (this.onVesselRemove) this.onVesselRemove(mmsi);
        });
        this.vessels.clear();
        this._updateCount();
        this._updateDarkCount();
    }

    // Call once after scene is ready. Shows key prompt then opens socket —
    // or, in demo mode, skips the socket and announces vg1:demoMode so
    // main.js can load a synthetic scenario instead.
    async init() {
        // Live AIS layer disabled via config — skip the key prompt + WebSocket so
        // no live vessels spawn. Reversible: set AIS.LIVE_ENABLED = true in config.js.
        if (AIS.LIVE_ENABLED === false) {
            this._setStatus('AIS LAYER OFF');
            import('./contextCardManager.js').then(m => m.contextCards.unblock());
            console.info('[AIS] Live vessel layer disabled (AIS.LIVE_ENABLED=false). 3D models + scenarios unaffected.');
            return;
        }
        const result = await promptForAPIKey();
        // AIS key prompt dismissed — unblock context cards so they can now show.
        // Dynamic import avoids a circular dep (aisManager has no other UI imports).
        import('./contextCardManager.js').then(m => m.contextCards.unblock());

        if (result === DEMO_MODE) {
            this._setStatus('DEMO // SYNTHETIC');
            window.dispatchEvent(new CustomEvent('vg1:demoMode'));
            return;
        }
        this._apiKey = result;
        this._connect();
    }

    _connect() {
        this._setStatus('CONNECTING...');
        this.ws = new WebSocket(AIS.WS_URL);

        this.ws.onopen = () => {
            this._setStatus('LIVE // GLOBAL');
            this.ws.send(JSON.stringify({
                APIKey:             this._apiKey,
                BoundingBoxes:      [AIS.BBOX],
                FilterMessageTypes: ['PositionReport', 'ShipStaticData']
            }));
        };

        this.ws.onmessage = async e => {
            try {
                const text = e.data instanceof Blob ? await e.data.text() : e.data;
                const msg  = JSON.parse(text);
                if (this._livePaused) return;  // replay in progress — live feed muted
                this.ingest(msg);
            }
            catch (err) { console.warn('[AIS] Parse error:', err); }
        };

        this.ws.onerror = () => this._setStatus('ERROR');

        this.ws.onclose = () => {
            this._setStatus('RECONNECTING...');
            setTimeout(() => this._connect(), 5000);
        };
    }

    _handleMsg(msg) {
        const meta = msg.MetaData;
        if (!meta) return;

        // ── Static Voyage Data — enrich existing vessel with destination/ETA ──
        if (msg.MessageType === 'ShipStaticData') {
            const mmsi   = String(meta.MMSI);
            const static_ = msg.Message?.ShipStaticData;
            if (!static_) return;

            const existing = this.vessels.get(mmsi);
            if (existing) {
                // IMO number — the key for Equasis dossier lookup. Only static
                // (type 5) messages carry it; position reports do not.
                const imo = static_.ImoNumber ?? static_.IMONumber ?? static_.Imo;
                if (imo && Number(imo) > 0) existing.imo = String(imo);

                const dest = (static_.Destination || '').trim().replace(/[@\x00]+/g, '').trim();
                if (dest) existing.destination = dest.toUpperCase();

                const eta = static_.Eta;
                if (eta && eta.Month > 0) {
                    const pad = n => String(n).padStart(2, '0');
                    existing.eta = `${pad(eta.Month)}/${pad(eta.Day)} ${pad(eta.Hour)}:${pad(eta.Minute)}Z`;
                }

                // Static data may carry a better ship name
                const staticName = (static_.Name || '').trim().replace(/[@\x00]+/g, '').trim();
                if (staticName && staticName !== 'UNKNOWN' && staticName.length > 0) {
                    existing.name = staticName.toUpperCase();
                    if (existing.threeObject) {
                        existing.threeObject.userData.displayName = existing.name;
                    }
                    // Fire onVesselUpdate so watchlist and vessel tab see the real name
                    if (this.onVesselUpdate) this.onVesselUpdate(mmsi, existing);
                }

                // Ship type — ONLY the static (type-5) message carries it; position
                // reports don't, so without this every vessel stays class OTHER (grey).
                // Upgrade away from OTHER and rebuild the model so shape + colour update.
                const shipType = static_.Type ?? static_.ShipType;
                if (shipType != null) {
                    const newClass = aisTypeToClass(shipType);
                    if (newClass !== 'OTHER') {
                        typeCache.set(mmsi, newClass);   // remember for instant typing next time
                        if (newClass !== existing.class) {
                            existing.class = newClass;
                            if (existing.threeObject) existing.threeObject.userData.class = newClass;
                            if (this.onVesselReclassify) this.onVesselReclassify(mmsi, existing);
                        }
                    }
                }
            }
            return;
        }

        // ── Position Report ───────────────────────────────────────────────────
        if (msg.MessageType !== 'PositionReport') return;

        const report = msg.Message?.PositionReport;
        if (!report) return;

        const lat = meta.latitude;
        const lon = meta.longitude;
        if (lat == null || lon == null) return;
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return;

        const mmsi     = String(meta.MMSI);
        const name     = (meta.ShipName || 'UNKNOWN').trim() || 'UNKNOWN';
        const sog      = report.Sog  ?? 0;
        const cog      = report.Cog  ?? 0;
        const rawHdg   = report.TrueHeading;
        const heading  = (rawHdg != null && rawHdg < 511) ? rawHdg : cog;
        const shipType = meta.ShipType ?? 0;

        // ── Dual timestamps: when it happened vs when we heard about it ──────
        // tEvent comes from the message itself (AISStream time_utc / ISO from
        // synthetic+recorded sources); tArrival is sim time now. Never conflate.
        const tArrival = simClock.now();
        const tEvent   = parseEventTime(meta.time_utc) ?? tArrival;

        const scenePos = lonLatToScene(lon, lat);
        const existing = this.vessels.get(mmsi);

        // ── Invariant gate: physics first, rendering second ───────────────────
        const violations = checkPositionReport(
            existing ? { latDeg: existing.latDeg, lonDeg: existing.lonDeg, tEvent: existing.lastEventTime } : null,
            { mmsi, name, lat, lon, sogKts: sog, tEvent, tArrival,
              class: existing?.class ?? aisTypeToClass(shipType) }
        );
        if (violations.some(v => v.severity === 'reject')) {
            // Teleport-grade violation — the report must not move the vessel.
            // It is recorded in the invariant ledger with raw evidence attached.
            return;
        }
        if (existing && violations.length) {
            existing.flagCount = (existing.flagCount ?? 0) + violations.length;
            existing.lastFlag  = violations[violations.length - 1].type;
        }

        if (existing) {
            existing.prevPos.copy(existing.targetPos);
            existing.targetPos.copy(scenePos);
            existing.lerpAlpha  = 0;
            existing.speedKts   = Math.round(sog);
            existing.headingDeg = heading;
            existing.latDeg     = lat;
            existing.lonDeg     = lon;
            existing.lastSeen      = tArrival;
            existing.lastEventTime = tEvent;

            // Dark vessel reappeared — fire reappear callback before update
            if (existing.isDark) {
                existing.isDark    = false;
                existing.darkSince = null;
                if (this.onVesselReappear) this.onVesselReappear(mmsi, existing);
                this._updateDarkCount();
            }

            if (this.onVesselUpdate) this.onVesselUpdate(mmsi, existing);
        } else {
            if (this.vessels.size >= AIS.MAX_VESSELS) return;

            const v = {
                mmsi,
                name,
                // Use the remembered class if we've seen this vessel before, so it
                // renders typed immediately instead of grey until its next static msg.
                class:       typeCache.get(mmsi) || aisTypeToClass(shipType),
                country:     mmsiToCountry(mmsi),
                speedKts:    Math.round(sog),
                headingDeg:  heading,
                latDeg:      lat,
                lonDeg:      lon,
                destination: null,
                eta:         null,
                // Three.js positions — lerped each frame
                currentPos:  scenePos.clone(),
                prevPos:     scenePos.clone(),
                targetPos:   scenePos.clone(),
                lerpAlpha:   1,
                lastSeen:      tArrival,
                lastEventTime: tEvent,
                flagCount:     violations.length,
                lastFlag:      violations.length ? violations[violations.length - 1].type : null,
                threeObject: null,
                history:     [],
                isDark:      false,
                darkSince:   null
            };
            this.vessels.set(mmsi, v);
            if (this.onVesselNew) this.onVesselNew(mmsi, v);
        }

        // ── AIS integrity evaluation (per-report, event-driven) ───────────────
        // Wired to integrityManager.evaluate in main.js. Reuses the violations
        // already computed by the invariant gate above — no extra physics pass.
        if (this.onPositionEvaluated) {
            this.onPositionEvaluated(this.vessels.get(mmsi), violations, {
                sceneX: scenePos.x, sceneZ: scenePos.z, sogKts: sog,
            });
        }

        this._updateCount();
    }

    // Called every animation frame with delta time in seconds.
    tick(delta) {
        const now   = simClock.now();
        const stale = [];

        this.vessels.forEach((v, mmsi) => {
            // Smooth lerp toward latest reported position
            if (v.lerpAlpha < 1) {
                v.lerpAlpha = Math.min(1, v.lerpAlpha + delta * 0.3);
                v.currentPos.lerpVectors(v.prevPos, v.targetPos, v.lerpAlpha);
            }

            // Dark vessel detection — fire once when silence crosses DARK_MS
            if (!v.isDark && (now - v.lastSeen > AIS.DARK_MS)) {
                v.isDark    = true;
                v.darkSince = now;
                if (this.onVesselDark) this.onVesselDark(mmsi, v);
            }

            if (now - v.lastSeen > AIS.STALE_MS) stale.push(mmsi);
        });

        // Remove stale vessels (callback fires before map deletion so
        // main.js can still read vessel data during cleanup)
        stale.forEach(mmsi => {
            if (this.onVesselRemove) this.onVesselRemove(mmsi);
            this.vessels.delete(mmsi);
        });

        this._updateDarkCount();
    }

    // ── HUD helpers ──────────────────────────────────────────────────────────
    _setStatus(text) {
        const el = document.getElementById('ais-status');
        if (el) el.innerText = text;
        // Show first-encounter explanation when the feed goes offline
        if (text === 'ERROR' || text === 'RECONNECTING...') {
            // Dynamic import avoids a circular dep — aisManager has no other UI imports
            import('./contextCardManager.js').then(m => m.contextCards.show('AIS_OFFLINE'));
        }
    }

    _updateCount() {
        const el = document.getElementById('ais-vessel-count');
        if (el) el.innerText = this.vessels.size;
    }

    _updateDarkCount() {
        let n = 0;
        this.vessels.forEach(v => { if (v.isDark) n++; });
        const el = document.getElementById('dark-vessel-count');
        if (el) el.innerText = n;
    }

    disconnect() {
        if (this.ws) this.ws.close();
    }
}
