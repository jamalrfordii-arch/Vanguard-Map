// aiCopilot.js — Proactive intelligence co-pilot for VANGUARD
//
// Architecture:
//   1. Binds to AISManager / FlightManager event callbacks (non-destructively)
//   2. Runs rule-based anomaly detection every 30 s (no AI cost)
//   3. Scores each event — high-score events are queued for Claude enrichment
//   4. Claude assessments are rate-limited (1 call per 20 s max) and inject back
//      into the live stream as [AI]-prefixed entries
//   5. All stream events are broadcast to registered UI callbacks

import { COPILOT } from './config.js';

// ── Strategic chokepoints (lat/lon bounding boxes) ────────────────────────────
export const CHOKEPOINTS = [
    // Widened 2026-07-21: 26.0 latMin only covered the narrow pinch point and
    // missed the Gulf of Oman approach lanes (real transit traffic queues/goes
    // dark as far south as ~25.0N before entering the strait proper). Every
    // other entry in this table is already modeled as an approach zone, not a
    // pinch point (see Malacca's 5° span) — this brings Hormuz in line and was
    // confirmed against a live miss: a synthetic dark-vessel event at lat 25.82
    // fell outside the old box and never got the chokepoint score/snapshot bonus.
    { name: 'STRAIT OF HORMUZ',    latMin: 25.0,  latMax: 27.0, lonMin:  54.5, lonMax:  57.5 },
    // Widened 2026-07-21 (same pass as Hormuz): the old lonMin=99.0 covered
    // only the strait proper and missed the Andaman Sea approach (Preparis
    // Channel / north of Sabang, ~95-99E) where inbound traffic queues before
    // the pinch point — same "pinch point vs approach lane" gap as Hormuz.
    { name: 'STRAIT OF MALACCA',   latMin:  1.0,  latMax:  6.0, lonMin:  95.0, lonMax: 104.5 },
    // Widened 2026-07-21: old box centered tightly on the strait itself and
    // clipped the Gulf of Aden approach (out to ~46-48E), which is where most
    // of this corridor's actual dark-vessel/piracy-relevant activity happens,
    // not just the ~20km pinch point between Yemen and Djibouti.
    { name: 'BAB-EL-MANDEB',       latMin: 11.0,  latMax: 13.5, lonMin:  42.5, lonMax:  46.5 },
    // Checked, not widened: a canal (not an open strait) has no meaningful
    // "approach lane" ambiguity — ships transit the fixed channel or they
    // don't. Existing box already spans Port Said to Suez plus a margin.
    { name: 'SUEZ CANAL',          latMin: 29.5,  latMax: 32.0, lonMin:  32.0, lonMax:  33.0 },
    // Checked, not widened: real strait width (~35.9-36.0N) already sits
    // comfortably inside the existing box with margin on both the Atlantic
    // and Mediterranean sides.
    { name: 'STRAIT OF GIBRALTAR', latMin: 35.5,  latMax: 36.5, lonMin:  -6.5, lonMax:  -4.5 },
    // Widened 2026-07-21: old latMin=49.5/lonMin=-2.5 started east of Ushant
    // and missed the whole western approach (Brittany/Western Approaches,
    // down to ~48.5N/-5.5W) that Channel-bound Atlantic traffic transits
    // before ever reaching the narrow Dover Strait end.
    { name: 'ENGLISH CHANNEL',     latMin: 48.5,  latMax: 51.5, lonMin:  -5.5, lonMax:   2.5 },
    // Checked, not widened: Skagerrak/Kattegat/Belts/Øresund already fit the
    // existing box with margin.
    { name: 'DANISH STRAITS',      latMin: 54.5,  latMax: 58.0, lonMin:   8.0, lonMax:  13.0 },
    // Tightened 2026-07-21 — real bug, not a widen: this overlapped LUZON
    // STRAIT below by 0.5 deg of latitude (22.0-22.5N, both spanning
    // 119-122E), so a vessel in that band double-counted in both chokepoints'
    // traffic state and snapshot data. Taiwan's real southern tip (Eluanbi)
    // is ~21.9N — that's the natural boundary between the two straits.
    { name: 'TAIWAN STRAIT',       latMin: 21.9,  latMax: 26.0, lonMin: 119.0, lonMax: 122.0 },
    // Tightened 2026-07-21 to meet Taiwan Strait's new latMin cleanly instead
    // of overlapping it (see comment above) — latMax was 22.5, real Bashi
    // Channel / Luzon Strait activity is south of Taiwan's tip anyway.
    { name: 'LUZON STRAIT',        latMin: 18.0,  latMax: 21.9, lonMin: 119.0, lonMax: 124.0 },
    // Checked, not widened: this is a rounding point, not a strait — ships
    // already swing wide around it, and the existing box has generous margin
    // on every side of the actual Cape (~-34.35, 18.47).
    { name: 'CAPE OF GOOD HOPE',   latMin: -35.5, latMax: -33.0,lonMin:  17.5, lonMax:  20.5 },
    // Widened 2026-07-21: old lonMin=-68.0 clipped the western half of the
    // passage — real Drake Passage traffic (and the Chilean archipelago side
    // routing) extends out to roughly -72 to -75W, not just the Atlantic side.
    { name: 'DRAKE PASSAGE',       latMin: -62.0, latMax: -55.0,lonMin: -72.0, lonMax: -55.0 },
];

// ── AICopilot ─────────────────────────────────────────────────────────────────
export class AICopilot {
    constructor() {
        this._listeners     = [];          // (event) → void — UI callbacks
        this._callQueue     = [];          // events awaiting Claude enrichment
        this._isProcessing  = false;
        this._lastCallTime  = 0;
        this._anomalyTimer  = 0;

        // Per-vessel baseline snapshot for anomaly detection
        this._vesselBaselines = new Map(); // mmsi → { speedKts, headingDeg, latDeg, lonDeg }

        // Debounce: suppress duplicate event types per vessel within DEBOUNCE_MS
        this._recentEvents = new Map();    // `${mmsi}_${type}` → timestamp

        // Cable sample points populated by main.js after /cables loads
        // Each entry: { lat, lon, name }
        this.cableSegments = [];

        // ── Vessel anomaly registry ────────────────────────────────────────────
        // Tracks which vessels have active anomalies so 3D rings can be shown.
        // mmsi (string) → { level: 1|2|3, setAt: timestamp }
        //   1 = WARN  (amber) — speed/course anomaly
        //   2 = HOT   (orange) — cable proximity or large speed delta
        //   3 = CRITICAL (red) — dark vessel / hostile contact
        this._activeAnomalies = new Map();

        // References set by bind*() methods
        this._aisManager    = null;
        this._flightManager = null;

        // Internal stats exposed to the HUD
        this.stats = {
            eventsDetected:  0,
            claudeCalls:     0,
            anomaliesActive: 0,
        };
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    /** Register a UI callback to receive all stream events. */
    onEvent(callback) {
        this._listeners.push(callback);
    }

    /**
     * Bind to an AISManager instance.
     * Wraps its onVesselDark / onVesselReappear callbacks non-destructively.
     */
    bindAISManager(aisManager) {
        this._aisManager = aisManager;

        const prevDark     = aisManager.onVesselDark;
        const prevReappear = aisManager.onVesselReappear;

        aisManager.onVesselDark = (mmsi, vessel) => {
            if (prevDark) prevDark(mmsi, vessel);
            this._onDark(mmsi, vessel);
        };

        aisManager.onVesselReappear = (mmsi, vessel) => {
            if (prevReappear) prevReappear(mmsi, vessel);
            this._onReappear(mmsi, vessel);
        };
    }

    /** Bind to a FlightManager instance (for future air-domain anomaly detection). */
    bindFlightManager(flightManager) {
        this._flightManager = flightManager;
    }

    /**
     * Call from the main animation loop each frame.
     * @param {number} delta  Seconds since last frame.
     */
    tick(delta) {
        // Rule-based anomaly detection — throttled to ANOMALY_TICK_S
        this._anomalyTimer += delta;
        if (this._anomalyTimer >= COPILOT.ANOMALY_TICK_S) {
            this._anomalyTimer = 0;
            this._detectAnomalies();
            this._expireAnomalies();
        }

        // Claude enrichment queue — rate-limited
        this._processQueue();
    }

    // ── Vessel anomaly registry (drives 3D rings in entityBuilder) ─────────────

    _setAnomaly(mmsi, level) {
        this._activeAnomalies.set(String(mmsi), { level, setAt: Date.now() });
    }

    clearAnomaly(mmsi) {
        this._activeAnomalies.delete(String(mmsi));
    }

    /** Returns 0 (no anomaly), 1 (warn), 2 (hot), or 3 (critical). */
    getVesselAnomalyLevel(mmsi) {
        return this._activeAnomalies.get(String(mmsi))?.level ?? 0;
    }

    _expireAnomalies() {
        const cutoff = Date.now() - 5 * 60 * 1000; // expire after 5 min
        this._activeAnomalies.forEach((data, mmsi) => {
            if (data.setAt < cutoff) this._activeAnomalies.delete(mmsi);
        });
    }

    // ── AISManager event handlers ─────────────────────────────────────────────

    _onDark(mmsi, vessel) {
        // Mark vessel as critical-level anomaly so its 3D ring activates
        this._setAnomaly(mmsi, 3);

        const chokepoint = this._nearChokepoint(vessel.latDeg, vessel.lonDeg);
        const cable      = this._nearCable(vessel.latDeg, vessel.lonDeg);

        // Scoring — higher = more likely to be significant
        let score = 50;
        if (chokepoint)              score += 30;
        if (cable)                   score += 25;
        if ((vessel.speedKts || 0) > 12) score += 10; // fast vessel going dark is notable

        const raw = [
            `AIS signal lost. Last position ${this._coord(vessel.latDeg, vessel.lonDeg)}.`,
            `SOG before silence: ${vessel.speedKts ?? '?'}kts, HDG ${vessel.headingDeg ?? '?'}°.`,
            chokepoint ? `Located near ${chokepoint}.` : '',
            cable      ? `Proximity to ${cable} detected.` : '',
        ].filter(Boolean).join(' ');

        this._emit({
            type:  'DARK_VESSEL',
            cls:   score >= 80 ? 'hot' : 'warn',
            label: `DARK — ${vessel.name || mmsi}`,
            body:  raw,
            score,
            forClaude: score >= COPILOT.EVENT_SCORE_THRESHOLD,
            claudeContext: {
                event:          'DARK_VESSEL',
                vessel:         this._vesselSnap(vessel, mmsi),
                chokepoint,
                cableProximity: cable,
                score,
            },
        }, `${mmsi}_dark`);
    }

    _onReappear(mmsi, vessel) {
        // Clear anomaly ring when vessel comes back online
        this.clearAnomaly(mmsi);

        this._emit({
            type:  'REAPPEAR',
            cls:   'ok',
            label: `SIGNAL RESTORED — ${vessel.name || mmsi}`,
            body:  `AIS feed resumed. Position: ${this._coord(vessel.latDeg, vessel.lonDeg)}. SOG: ${vessel.speedKts}kts.`,
            score: 20,
            forClaude: false,
        }, `${mmsi}_reappear`);
    }

    // ── Rule-based anomaly detection ─────────────────────────────────────────

    _detectAnomalies() {
        if (!this._aisManager) return;
        let anomalyCount = 0;

        this._aisManager.vessels.forEach((vessel, mmsi) => {
            if (vessel.isDark) return;

            const baseline = this._vesselBaselines.get(mmsi);

            if (baseline) {
                // ── Speed anomaly ──────────────────────────────────────────────
                const speedDelta = Math.abs((vessel.speedKts || 0) - (baseline.speedKts || 0));
                if (speedDelta > 8 && (vessel.speedKts || 0) > 1) {
                    // Always refresh anomaly level — even if event is debounced
                    this._setAnomaly(mmsi, speedDelta > 14 ? 2 : 1);
                    const key = `${mmsi}_speed`;
                    if (!this._isRecentEvent(key)) {
                        const dir = vessel.speedKts > baseline.speedKts ? 'ACCELERATED' : 'DECELERATED';
                        anomalyCount++;
                        this._emit({
                            type:  'SPEED_ANOMALY',
                            cls:   'warn',
                            label: `SPEED ANOMALY — ${vessel.name || mmsi}`,
                            body:  `${dir} ${baseline.speedKts}kts → ${vessel.speedKts}kts (Δ${speedDelta.toFixed(0)}kts). Position: ${this._coord(vessel.latDeg, vessel.lonDeg)}.`,
                            score: 45 + Math.min(speedDelta * 2, 40),
                            forClaude: speedDelta > 14,
                            claudeContext: {
                                event:         'SPEED_ANOMALY',
                                vessel:        this._vesselSnap(vessel, mmsi),
                                speedDelta,
                                previousSpeed: baseline.speedKts,
                                chokepoint:    this._nearChokepoint(vessel.latDeg, vessel.lonDeg),
                            },
                        }, key);
                    }
                }

                // ── Heading deviation > 45° ────────────────────────────────────
                const hdgDelta = this._headingDelta(vessel.headingDeg, baseline.headingDeg);
                if (hdgDelta > 45) {
                    this._setAnomaly(mmsi, 1);
                    const key = `${mmsi}_heading`;
                    if (!this._isRecentEvent(key)) {
                        anomalyCount++;
                        this._emit({
                            type:  'COURSE_CHANGE',
                            cls:   'warn',
                            label: `COURSE CHANGE — ${vessel.name || mmsi}`,
                            body:  `Heading deviation: ${baseline.headingDeg?.toFixed(0)}° → ${vessel.headingDeg?.toFixed(0)}° (Δ${hdgDelta.toFixed(0)}°). SOG: ${vessel.speedKts}kts.`,
                            score: 38,
                            forClaude: false,
                        }, key);
                    }
                }
            }

            // ── Cable proximity: slow/stopped vessel near cable ────────────────
            const cable = this._nearCable(vessel.latDeg, vessel.lonDeg);
            if (cable && (vessel.speedKts || 0) < 3) {
                this._setAnomaly(mmsi, 2);
                const key = `${mmsi}_cable`;
                if (!this._isRecentEvent(key)) {
                    anomalyCount++;
                    this._emit({
                        type:  'CABLE_PROXIMITY',
                        cls:   'hot',
                        label: `CABLE PROXIMITY — ${vessel.name || mmsi}`,
                        body:  `Slow/stationary vessel (${vessel.speedKts}kts) near ${cable}. Possible anchor over cable route. Position: ${this._coord(vessel.latDeg, vessel.lonDeg)}.`,
                        score: 78,
                        forClaude: true,
                        claudeContext: {
                            event:         'CABLE_PROXIMITY',
                            vessel:        this._vesselSnap(vessel, mmsi),
                            cableProximity: cable,
                        },
                    }, key);
                }
            }

            // Update baseline for next tick
            this._vesselBaselines.set(mmsi, {
                speedKts:   vessel.speedKts,
                headingDeg: vessel.headingDeg,
                latDeg:     vessel.latDeg,
                lonDeg:     vessel.lonDeg,
            });
        });

        // ── Cluster detection ──────────────────────────────────────────────────
        this._detectClusters();

        this.stats.anomaliesActive = anomalyCount;
        this._updateHUD();
    }

    _detectClusters() {
        if (!this._aisManager) return;
        const vessels = Array.from(this._aisManager.vessels.values())
            .filter(v => !v.isDark && (v.speedKts || 0) > 0.5);

        const used = new Set();

        vessels.forEach(v => {
            if (used.has(v.mmsi) || v.latDeg == null) return;

            const cluster = [v];
            vessels.forEach(v2 => {
                if (v2.mmsi === v.mmsi || used.has(v2.mmsi) || v2.latDeg == null) return;
                const dist = Math.sqrt(
                    Math.pow(v2.latDeg - v.latDeg, 2) +
                    Math.pow(v2.lonDeg - v.lonDeg, 2)
                );
                if (dist < COPILOT.CLUSTER_DEG_RADIUS) cluster.push(v2);
            });

            if (cluster.length < COPILOT.CLUSTER_MIN_VESSELS) return;

            cluster.forEach(c => used.add(c.mmsi));

            const darkCount  = cluster.filter(c => c.isDark).length;
            const chokepoint = this._nearChokepoint(v.latDeg, v.lonDeg);
            const flags      = [...new Set(cluster.map(c => c.country).filter(Boolean))];
            const classes    = [...new Set(cluster.map(c => c.class).filter(Boolean))];
            const key        = `cluster_${v.mmsi}`;

            if (!this._isRecentEvent(key)) {
                const score = 55 + cluster.length * 4 + darkCount * 12 + (chokepoint ? 20 : 0);
                this._emit({
                    type:  'CLUSTER',
                    cls:   darkCount > 0 ? 'hot' : 'warn',
                    label: `CLUSTER — ${cluster.length} VESSELS`,
                    body:  [
                        `${cluster.length}-vessel cluster near ${this._coord(v.latDeg, v.lonDeg)}.`,
                        darkCount > 0 ? `${darkCount} dark.` : '',
                        chokepoint ? `Near ${chokepoint}.` : '',
                        flags.length ? `Flags: ${flags.slice(0, 3).join(', ')}.` : '',
                    ].filter(Boolean).join(' '),
                    score,
                    forClaude: cluster.length >= 6 || darkCount >= 2 || !!chokepoint,
                    claudeContext: {
                        event:       'CLUSTER',
                        count:       cluster.length,
                        darkCount,
                        centroidLat: v.latDeg,
                        centroidLon: v.lonDeg,
                        chokepoint,
                        classes,
                        flags,
                    },
                }, key);
            }
        });
    }

    // ── Event emission ────────────────────────────────────────────────────────

    _emit(event, dedupeKey) {
        if (dedupeKey && this._isRecentEvent(dedupeKey)) return;
        if (dedupeKey) this._recentEvents.set(dedupeKey, Date.now());

        event.timestamp = Date.now();
        event.timeStr   = 'JUST NOW';
        this.stats.eventsDetected++;

        // Immediately push raw event to UI
        this._listeners.forEach(cb => cb({ ...event }));

        // Queue for Claude enrichment if score crosses threshold
        if (event.forClaude && event.claudeContext) {
            this._callQueue.push({ ...event });
        }

        this._updateHUD();
    }

    // ── Claude enrichment queue ───────────────────────────────────────────────

    async _processQueue() {
        if (this._isProcessing || this._callQueue.length === 0) return;
        if (Date.now() - this._lastCallTime < COPILOT.MIN_CALL_INTERVAL) return;

        this._isProcessing  = true;
        this._lastCallTime  = Date.now();

        // Take the highest-scored pending event
        this._callQueue.sort((a, b) => b.score - a.score);
        const event = this._callQueue.shift();

        try {
            const res = await fetch(COPILOT.API_URL, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ context: event.claudeContext }),
                signal:  AbortSignal.timeout(15_000),
            });

            if (res.ok) {
                const { assessment } = await res.json();
                this.stats.claudeCalls++;

                // Push Claude-enriched version back to the stream
                this._listeners.forEach(cb => cb({
                    ...event,
                    body:        assessment,
                    label:       `[AI] ${event.label}`,
                    isAiEnriched: true,
                    timeStr:     this._ageStr(event.timestamp),
                }));

                this._updateHUD();
            }
        } catch (err) {
            console.warn('[AICopilot] Claude enrichment failed:', err.message);
        }

        this._isProcessing = false;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    _nearChokepoint(lat, lon) {
        if (lat == null || lon == null) return null;
        for (const cp of CHOKEPOINTS) {
            if (lat >= cp.latMin && lat <= cp.latMax &&
                lon >= cp.lonMin && lon <= cp.lonMax) return cp.name;
        }
        return null;
    }

    _nearCable(lat, lon) {
        if (!this.cableSegments.length || lat == null || lon == null) return null;
        for (const seg of this.cableSegments) {
            const d = Math.sqrt(Math.pow(lat - seg.lat, 2) + Math.pow(lon - seg.lon, 2));
            if (d < 0.45) return seg.name || 'SUBMARINE CABLE';
        }
        return null;
    }

    /** Smallest angular difference between two headings (0–180). */
    _headingDelta(a, b) {
        if (a == null || b == null) return 0;
        const d = Math.abs(a - b) % 360;
        return d > 180 ? 360 - d : d;
    }

    _isRecentEvent(key) {
        const last = this._recentEvents.get(key);
        return !!last && (Date.now() - last < COPILOT.DEBOUNCE_MS);
    }

    _coord(lat, lon) {
        if (lat == null || lon == null) return '—';
        return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
    }

    _ageStr(ts) {
        const sec = Math.floor((Date.now() - ts) / 1000);
        if (sec < 60) return 'JUST NOW';
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} AGO`;
    }

    _vesselSnap(vessel, mmsi) {
        return {
            mmsi,
            name:       vessel.name,
            class:      vessel.class,
            flag:       vessel.country,
            speedKts:   vessel.speedKts,
            headingDeg: vessel.headingDeg,
            latDeg:     vessel.latDeg,
            lonDeg:     vessel.lonDeg,
            destination: vessel.destination,
        };
    }

    // ── Feature 2: SITREP — on-demand scene summary ──────────────────────────

    /**
     * Generate a situation report for the current camera view.
     * Immediately pushes a loading placeholder, then replaces it with a
     * Claude-enriched assessment (falls back to a local summary if offline).
     *
     * @param {object} sceneContext  Snapshot from window.gatherSceneContext()
     */
    async requestSitrep(sceneContext) {
        const loadingId = `sitrep_${Date.now()}`;

        // Push loading placeholder — user sees instant feedback
        this._listeners.forEach(cb => cb({
            type:      'SITREP',
            cls:       'sitrep',
            label:     '⬡ SITUATION REPORT',
            body:      '…',
            isLoading: true,
            loadingId,
            timestamp: Date.now(),
            timeStr:   'NOW',
        }));

        let assessment = null;

        // Try Claude enrichment via the existing API endpoint
        try {
            const res = await fetch(COPILOT.API_URL, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    context: {
                        event:       'SITREP',
                        sceneContext,
                        instruction: 'Provide a concise 3–5 sentence tactical situation report in plain language. Describe what is visible in this maritime theatre view, flag anything operationally significant, and state the threat assessment. Keep it factual and direct — this is for a maritime domain awareness operator.',
                    }
                }),
                signal: AbortSignal.timeout(15_000),
            });

            if (res.ok) {
                const data = await res.json();
                assessment = data.assessment;
                this.stats.claudeCalls++;
                this._updateHUD();
            }
        } catch (err) {
            console.warn('[AICopilot] SITREP Claude call failed:', err.message);
        }

        // Fall back to local plain-text summary if Claude is unavailable
        if (!assessment) {
            assessment = this._buildLocalSitrep(sceneContext);
        }

        // Replace the loading entry with the final content
        this._listeners.forEach(cb => cb({
            type:        'SITREP',
            cls:         'sitrep',
            label:       '⬡ SITUATION REPORT',
            body:        assessment,
            isLoading:   false,
            isSitrep:    true,
            replacesId:  loadingId,
            timestamp:   Date.now(),
            timeStr:     'NOW',
        }));
    }

    /** Construct a plain-text SITREP locally when the Claude API is offline. */
    _buildLocalSitrep(ctx) {
        const lines = [];

        lines.push(`REGION: ${ctx.region || 'UNKNOWN'}`);
        lines.push(`TRACKING: ${ctx.totalVisible} of ${ctx.totalAll} entities in current view`);

        const ORDER = ['CARGO','TANKER','PASSENGER','HSC','FISHING','TUG','DREDGER','PILOT','SAILING','PLEASURE','SERVICE','OTHER','ORBITAL'];
        const breakdown = ORDER
            .filter(cls => (ctx.classCounts?.[cls] || 0) > 0)
            .map(cls => `${ctx.classCounts[cls]}× ${cls}`)
            .join('  ·  ');
        if (breakdown) lines.push(`COMPOSITION: ${breakdown}`);

        if (ctx.darkCount > 0) {
            lines.push(`⚠ ${ctx.darkCount} DARK — transponder${ctx.darkCount > 1 ? 's' : ''} silent, last known positions shown`);
        }
        if (ctx.nearChokepoint) {
            lines.push(`CHOKEPOINT: ${ctx.nearChokepoint} — monitor for vessel anomalies`);
        }

        lines.push(`THREAT ASSESSMENT: ${ctx.threatLevel}`);

        if ((ctx.cameraAlt || 0) > 200) {
            lines.push('ZOOM IN for individual vessel analysis');
        }

        return lines.join('\n');
    }

    // ── HUD stat updates ──────────────────────────────────────────────────────

    _updateHUD() {
        const el = id => document.getElementById(id);
        if (el('copilot-events'))   el('copilot-events').innerText   = this.stats.eventsDetected;
        if (el('copilot-claude'))   el('copilot-claude').innerText   = this.stats.claudeCalls;
        if (el('copilot-anomalies'))el('copilot-anomalies').innerText= this.stats.anomaliesActive;
        if (el('copilot-queue'))    el('copilot-queue').innerText    = this._callQueue.length;
    }
}
