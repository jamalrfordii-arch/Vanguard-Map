// contextCardManager.js — First-encounter context cards
//
// Shows a plain-language explanation the first time a user encounters a
// concept that requires domain knowledge to interpret correctly.
// Each card is shown exactly once per session then suppressed.
//
// Usage:
//   import { contextCards } from './contextCardManager.js';
//   contextCards.show('DARK_VESSEL');   // no-ops on second call
//
// Trigger map (where each key is fired):
//   DARK_VESSEL       → onClick when userData.isDark === true
//   ORBITAL           → onClick when userData.class === 'ORBITAL'
//   CLUSTER           → main.js animate loop, first frame clusters are visible
//   ALERT_ZONE        → onClick zone placement in uiController.js
//   AIS_OFFLINE       → aisManager._setStatus on error / reconnect
//   SUBMARINE_CABLE   → toggle-cables first enable
//   ROUTE_PREDICTION  → toggle-prediction first enable
//   CHOKEPOINT        → aiCopilot onEvent when event.chokepoint is set
//   PORT_MARKER       → tickRaycasting / onClick on port class (future hook)

// ── Context definitions ───────────────────────────────────────────────────────

const REGISTRY = {

    DARK_VESSEL: {
        icon:  '◉',
        title: 'This vessel has gone dark',
        body:  `AIS — Automatic Identification System — is a radio transponder that every large commercial vessel is legally required to keep transmitting. It broadcasts the ship's position, speed, and heading to other ships and satellites every few seconds.
<br><br>
This vessel's transponder has gone silent. The orange ring marks its <em>last known position</em> before contact was lost. It could be equipment failure, a deliberate attempt to avoid detection, or the vessel entering an area with poor satellite coverage.
<br><br>
The system will alert if it reappears.`,
        accent: '#c06010',   // amber — matches the dark-vessel halo colour
    },

    DISTRESS_BEACON: {
        icon:  '◆',
        title: 'Distress beacon detected',
        body:  `A distress beacon is an emergency radio transmitter activated when a vessel or person is in danger at sea. This one was detected from its AIS broadcast — certain reserved transmitter IDs identify the device type:
<br><br>
<strong>EPIRB</strong> — Emergency Position-Indicating Radio Beacon, activates automatically when a vessel sinks.<br>
<strong>SART</strong> — Search and Rescue Transponder, carried in life rafts to guide rescuers.<br>
<strong>MOB</strong> — Man Overboard device, worn by crew and triggered when someone falls into the water.
<br><br>
The red marker hovers above the beacon's reported position. This is a life-safety signal — it is always shown, regardless of which layers are active. Coverage is partial: only beacons broadcasting over AIS are detected here, not the full Cospas-Sarsat satellite network.`,
        accent: '#ff2a4d',
    },

    ORBITAL: {
        icon:  '◎',
        title: 'Orbital asset — satellite track',
        body:  `This is a satellite track derived from Two-Line Element (TLE) orbital data — the same public catalogue maintained by the US Space Force. The ground track shows the path the satellite's footprint traces across the Earth's surface.
<br><br>
Altitude, orbital period, and inclination determine what the satellite can see and when. Reconnaissance satellites in low orbit (~400 km) revisit the same ground location every ~90 minutes.`,
        accent: '#204880',
    },

    CLUSTER: {
        icon:  '◯',
        title: 'These circles are vessel groups',
        body:  `At this zoom level, individual ship and aircraft icons overlap too much to be useful, so nearby entities are grouped into a single bubble. The number shows how many tracked assets are inside the cluster region.
<br><br>
<strong>Zoom in</strong> to dissolve clusters into individual tracks. The bubble will split into individual icons as you descend toward continent level.
<br><br>
Blue circles are surface vessels. The same clustering applies to aircraft at their zoom threshold.`,
        accent: '#1a6080',
    },

    ALERT_ZONE: {
        icon:  '⚠',
        title: 'Alert zone placed',
        body:  `You have placed a geofence on the map. Any tracked vessel or aircraft that enters this radius will be counted in the badge label above it.
<br><br>
This is a manual monitoring tool — useful for watching a specific port, chokepoint, or area of interest without having to keep the map centred on it. The count updates in real time as entities move in and out of the boundary.
<br><br>
Click <strong>PLACE ALERT ZONE</strong> again to move it, or clear it from the Settings panel.`,
        accent: '#c03020',
    },

    AIS_OFFLINE: {
        icon:  '⊘',
        title: 'Live tracking feed lost',
        body:  `The AIS data connection has dropped. AIS (Automatic Identification System) is the live radio feed that keeps vessel positions current — without it, all positions freeze at their last received location.
<br><br>
Vessels continue moving in the real world even when the feed is offline. The longer the outage, the less you should trust the positions shown.
<br><br>
The system will reconnect automatically. Track staleness is shown by the LIVE VESSELS counter stopping.`,
        accent: '#804010',
    },

    SUBMARINE_CABLE: {
        icon:  '〰',
        title: 'Submarine internet cables',
        body:  `These lines on the ocean floor are the physical backbone of the internet. Over 400 cables carry approximately 95% of all international internet and telephone traffic between continents — satellite links carry the rest.
<br><br>
Vessel proximity to cable routes is operationally significant. Accidental damage from anchors accounts for most cable breaks, but deliberate interference is a documented threat vector.
<br><br>
This layer lets you cross-reference vessel positions against cable routes in real time.`,
        accent: '#306050',
    },

    ROUTE_PREDICTION: {
        icon:  '⤳',
        title: 'Predicted future positions',
        body:  `The dashed line ahead of each vessel is a dead-reckoning projection — where the vessel will be if it maintains its current speed and heading. This is a mathematical estimate, not a filed route.
<br><br>
Accuracy degrades over time. A 30-minute projection is usually reliable for vessels on open water; anything beyond 6 hours should be treated as directional intent, not a precise forecast.
<br><br>
Vessels that alter course, slow down, or stop will immediately diverge from this line.`,
        accent: '#204060',
    },

    CHOKEPOINT: {
        icon:  '⌁',
        title: 'Strategic maritime chokepoint',
        body:  `Roughly 90% of global trade travels by sea, and much of it must pass through a small number of narrow straits. These chokepoints — Hormuz, Malacca, Suez, Gibraltar, and others — are where disruption has the fastest global consequence.
<br><br>
The intelligence feed flags vessels near these locations because even routine anomalies here — a vessel going dark, unusual clustering, speed changes — carry outsized geopolitical weight compared to the same events in open ocean.`,
        accent: '#705010',
    },

};

// ── ContextCardManager ────────────────────────────────────────────────────────

class ContextCardManager {
    constructor() {
        this._seen    = new Set();   // keys shown this session
        this._cardEl  = null;        // cached DOM reference
        this._current = null;        // currently displayed key
        this._readyAt = null;        // timestamp after which cards are allowed
        this._queue   = [];          // keys queued while startup modals are active
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    /**
     * Signal that startup blocking modals are done (AIS key prompt dismissed).
     * Cards queued during the blocking period will show 2 s after this call.
     */
    unblock() {
        this._readyAt = Date.now() + 2000;
        if (this._queue.length) {
            setTimeout(() => {
                const next = this._queue.shift();
                if (next) this.show(next);
            }, 2000);
        }
    }

    /** Show a context card if this key hasn't been shown this session. */
    show(key) {
        if (this._disabled) return;   // globally suppressed "for the moment" (2026-07-15); set contextCards._disabled=false to re-enable
        if (this._seen.has(key)) return;
        const def = REGISTRY[key];
        if (!def) { console.warn('[ContextCard] Unknown key:', key); return; }

        // If a blocking startup modal is still active, queue the card instead
        // of showing it immediately so the two never overlap.
        const aisModal = document.getElementById('ais-key-input');
        const notReady = this._readyAt === null || Date.now() < this._readyAt;
        if (aisModal || notReady) {
            if (!this._queue.includes(key)) this._queue.push(key);
            return;
        }

        // Don't interrupt a currently visible card — queue behind it
        if (this._current) {
            if (!this._queue.includes(key)) this._queue.push(key);
            return;
        }

        this._seen.add(key);
        this._current = key;
        this._render(def);
    }

    /** Dismiss the currently visible card and show the next queued one if any. */
    dismiss() {
        const card = this._getCard();
        card.classList.remove('ctx-card--visible');
        // Remove from DOM after transition so it doesn't block pointer events
        setTimeout(() => {
            card.style.display = 'none';
            // Show next queued card 500 ms after this one disappears
            if (this._queue.length) {
                setTimeout(() => {
                    const next = this._queue.shift();
                    if (next) this.show(next);
                }, 500);
            }
        }, 320);
        this._current = null;
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    _getCard() {
        if (!this._cardEl) {
            this._cardEl = document.getElementById('context-card');
        }
        return this._cardEl;
    }

    _render(def) {
        const card = this._getCard();
        if (!card) return;

        // Swap accent colour via CSS custom property
        card.style.setProperty('--ctx-accent', def.accent);

        card.querySelector('.ctx-icon').textContent  = def.icon;
        card.querySelector('.ctx-title').textContent = def.title;
        card.querySelector('.ctx-body').innerHTML    = def.body;

        card.style.display = 'flex';
        // Force reflow so the transition fires on next frame
        void card.offsetWidth;
        card.classList.add('ctx-card--visible');
    }
}

// Singleton — import this everywhere
export const contextCards = new ContextCardManager();
