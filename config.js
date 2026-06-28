// config.js — Global constants. Import from here; never hardcode in managers.
//
// VISUAL CONSTANTS: these values were hand-tuned and define Vanguard's look.
// Do not change them without reading CLAUDE.md first — they have cascading effects.

// ── Map geometry ──────────────────────────────────────────────────────────────
export const MAP_WIDTH  = 300;   // scene units = full longitude span
export const MAP_HEIGHT = 300;   // scene units = full latitude span (Mercator)

// ── Point cloud ───────────────────────────────────────────────────────────────
export const MAX_SPLAT_BUDGET  = 2_000_000;   // bumped from 1.5M — denser terrain (2026-06-12)
export const SPLAT_LAND_GRID   = 7500;    // ~7500² × 0.30 ≈ 16.9M candidates, sampled to budget
export const SPLAT_OCEAN_GRID  = 3000;    // bumped from 1195 — ocean now reads as point-cloud at the same density language as land

// Splat shader uniforms — tunable live: window.splatCloud.material.uniforms.uBrightness.value = X
// Changing these shifts the brightness/colour of ALL land terrain.
export const SPLAT_BRIGHTNESS  = 0.86;   // tuned by shader-auto-tuner (was 0.90)
export const SPLAT_LAND_LIFT   = 0.28;   // unchanged — near 0.15 hard floor, not worth risking
export const SPLAT_LAND_GAMMA  = 0.70;   // tuned by shader-auto-tuner (was 0.65) — lifts shadow mid-tones
export const SPLAT_SATURATION  = 2.10;   // tuned by shader-auto-tuner (was 2.25)
export const SPLAT_HEMI_STRENGTH  = 0.35; // hemisphere lighting: 0=off, 1=full. Tune live via DevTools.
export const SPLAT_BIOME_STRENGTH = 0.30; // biome tinting: 0=off, 1=full. Tune live via DevTools.

// ── Terrain LOD crossfade thresholds (camera.position.y) ─────────────────────
// HYBRID MODE: splat is the only thing rendered. Continent mesh stays in
// memory as a silent data object (geometry + elevation values available for
// future shader sampling) but never renders. Splat opacity stays at 1.0 at
// every zoom level — these negative values guarantee the fade calc clamps
// to 1.0 regardless of camera height.
export const SPLAT_FADE_START      = -1;   // negative = never starts fading (splat always visible)
export const SPLAT_FADE_END        = -10;  // never reaches "hidden"
export const CONTINENT_FADE_START  = 25;   // legacy — kept for compatibility, mesh forced hidden in continentMesh.js
export const CONTINENT_FADE_END    = 15;   // legacy
export const CONTINENT_MESH_SEGS   = 1536; // subdivisions — 2.36M vertices. Do not raise on low-end GPUs.

// ── Tile stream LOD altitudes (camera.position.y) ────────────────────────────
export const TILE_LOD_ALTS = [200, 120, 50, 22, 12]; // zoom levels 6,8,10,12,13

// ── Post-processing — do not touch without reading CLAUDE.md ─────────────────
export const BLOOM_STRENGTH_BASE = 0.25;  // baseline; rises to BASE+THREAT_RANGE at max threat
export const BLOOM_THREAT_RANGE  = 0.30;  // bloom added at max threat level
export const BLOOM_RADIUS        = 0.40;
export const BLOOM_THRESHOLD     = 0.95;  // hairpin — lowering below 0.90 blows out the scene
export const TONE_MAPPING_EXPOSURE = 0.85; // ACES filmic — do not change

// ── Lighting (animation loop drives these from dayFactor = sunElevation 0..1) ─
// PBR physically-correct mode divides by π — these values look lower than they are.
export const AMBIENT_INTENSITY_BASE = 4.0;  // night floor
export const AMBIENT_INTENSITY_BONUS = 0.5; // added at solar noon
export const DIR_LIGHT_INTENSITY_MAX = 2.0; // at solar noon (pow(dayFactor, 0.7) * MAX)

// ── Water ─────────────────────────────────────────────────────────────────────
export const WATER_OPACITY = 0.85;

// ── Day/night terrain shading (terrainBuilder splat shader) ──────────────────
// Geographic terminator dimming of the terrain itself — tracks the real sun
// (and simClock scrubbing). Tunable live:
//   window.splatCloud.material.uniforms.uNightDim.value   = 0..1 (effect strength)
//   window.splatCloud.material.uniforms.uNightFloor.value = min brightness on night side
export const DAYNIGHT_TERRAIN = {
    // NOTE: this dim MULTIPLIES with the dayNightManager overlay's own night
    // darkening — keep STRENGTH/FLOOR gentle or night-side land goes black.
    STRENGTH: 0.35,   // 0 = off, 1 = full terminator contrast
    FLOOR:    0.60,   // night side never darker than this × day color (keeps terrain readable)
};

// ── Terrain vertical exaggeration ─────────────────────────────────────────────
// 1.0 = the original hand-tuned look (~200× true vertical exaggeration at low
// elevations). Lower = flatter, more physically honest terrain — sensible now
// that the map supports deep zoom. Applied at terrain BUILD time: change
// requires a reload to take effect. Flows to: splat worker, ocean floor mesh,
// terrain mesh, tile stream, buildings, city patches, cable depths, and the
// shader's elevation-decode (contours/cliff thresholds).
export const TERRAIN_VSCALE_LAND  = 0.05;  // land: near-true scale — flat, clean for tracking
export const TERRAIN_VSCALE_OCEAN = 1.0;   // ocean: full original drama — bathymetry is information

// Back-compat alias (single-scale consumers); prefer the split constants above.
export const TERRAIN_VERTICAL_SCALE = TERRAIN_VSCALE_LAND;

// ── Splat FX (terrainBuilder splat shader) ────────────────────────────────────
// Tunable live:
//   window.splatCloud.material.uniforms.uSplatScale.value = 1.3  (point size, closes gaps)
//   window.splatCloud.material.uniforms.uRidgePulse.value = 0.3  (ridge energy glow, 0 = off)
export const SPLAT_FX = {
    SCALE:       1.15,  // global point-size multiplier — >1 closes inter-splat gaps
    RIDGE_PULSE: 0.18,  // animated ridge glow strength — subtle by default
};

// ── Aquarium walls (ocean floor edge depth) ───────────────────────────────────
export const AQUARIUM_DEPTH = 28; // scene units below sea level — must exceed deepest ocean floor

// ── Aircraft animation ────────────────────────────────────────────────────────
export const AIRCRAFT_TIME_SCALE = 0.4; // visual speed multiplier (tooltip knots are unchanged)

// ── AIS data layer ────────────────────────────────────────────────────────────
export const AIS = {
    // Master switch for the LIVE AIS vessel layer. false = no key prompt, no
    // WebSocket, no live vessels on the map (reversible). The 3D vessel models +
    // synthetic scenarios are unaffected.
    LIVE_ENABLED: true,
    WS_URL:      'wss://stream.aisstream.io/v0/stream',
    STORAGE_KEY: 'vanguard_ais_key',
    MAX_VESSELS: 500,   // raised from 200 (2026-06-12) — GPU headroom confirmed
    STALE_MS:    10 * 60 * 1000,  // remove vessels silent for 10 min
    DARK_MS:      5 * 60 * 1000,  // flag as "dark" after 5 min silence
    BBOX:        [[-90.0, -180.0], [90.0, 180.0]],
};

// ── Simulation / replay (simClock.js + dataSource.js) ────────────────────────
export const SIM = {
    SOURCE_TICK_MS: 500,     // how often synthetic/recorded sources emit (real ms) — was 2000; lowered for more frequent position updates / visibly smoother movement
    RECORDER_MAX:   200000,  // max captured AIS messages before recorder stops
};

// ── Physics invariants (invariants.js) ───────────────────────────────────────
export const INVARIANTS = {
    HARD_REJECT_KTS:      120,  // implied speed above this → report rejected (teleport)
    MAX_SPEED_KTS: {            // per entity class — above these → flag
        CARGO:     35,
        TANKER:    30,
        PASSENGER: 45,
        HSC:       60,          // high-speed craft / fast ferries
        FISHING:   25,
        DEFAULT:   50,
    },
    SOG_MISMATCH_FACTOR:  3,    // implied speed > reported SOG × this → spoof flag
    SOG_MISMATCH_MIN_KTS: 15,   // ignore mismatches below this implied speed (noise)
    MIN_DT_MS:            30 * 1000,       // min event-time gap for speed checks
    MAX_EVENT_AGE_MS:     10 * 60 * 1000,  // arrival lag beyond this → STALE_EVENT
    MAX_FUTURE_SKEW_MS:   60 * 1000,       // event ahead of arrival beyond this → FUTURE_EVENT
    LEDGER_MAX:           500,  // violation ring-buffer size
};

// ── AIS Integrity / counter-spoofing scoring ────────────────────────────────
// Per-vessel trust score = 100 − Σ(active flag weights). Flags are indicators
// for analyst review, NOT verdicts. Engine: integrityManager.js. All tunable.
export const INTEGRITY = {
    // Penalty weight per flag type (points off the 100 trust score).
    WEIGHTS: {
        ON_LAND:          15,   // reported position is inland — WEAK signal: dominated by legit
                                // inland-waterway traffic (Rhine, Great Lakes, Danube…) that the
                                // coarse DEM can't tell from land. A lone hit stays TRUSTED; only
                                // corroborated by other flags does it push toward QUESTIONABLE/SUSPECT.
        IMPOSSIBLE_SPEED: 35,   // teleport-grade kinematic jump (invariants)
        FALSE_FLAG:       25,   // Equasis flag vs MMSI-MID country mismatch (v1.5)
        MMSI_INVALID:     20,   // malformed MMSI / unknown MID
        SOG_MISMATCH:     20,   // implied speed vs reported SOG (invariants)
        EXCESSIVE_SPEED:  18,   // over class max (invariants)
        DARK:             15,   // AIS transponder gone silent
        LOITERING:        15,   // stopped together offshore (possible STS)
        TIME_REGRESSION:  15,   // timestamp manipulation (invariants)
        DEFAULT:          10,   // any other invariant violation
    },
    TIER_TRUSTED:      80,      // score ≥ → TRUSTED (green)
    TIER_QUESTIONABLE: 50,      // score ≥ → QUESTIONABLE (amber); below → SUSPECT (red)
    ON_LAND_MIN_M:     10,      // center terrain elevation above this (m) to consider "land"
    ON_LAND_MARGIN:    0.30,    // scene-unit radius (~30 km) — ALL neighbours must also be land
                                // before flagging, so coarse-coastline/port vessels aren't false-flagged
    FLAG_TTL_MS:       15 * 60 * 1000,   // soft (event) flags expire after this if not re-triggered
    LOITER_RADIUS_NM:   0.5,    // two stopped vessels within this → rendezvous candidate
    LOITER_MIN_KTS:     1.0,    // speed below this counts as "stopped"
    LOITER_MIN_MS:     20 * 60 * 1000,   // sustained this long → LOITERING flag
    TICK_MS:           4000,    // periodic loiter/decay cadence
};

// ── Flight Integrity / trust scoring (2026-06-24) ────────────────────────────
// Aerial-domain sibling of INTEGRITY above — same 0-100 score / TRUSTED-
// QUESTIONABLE-SUSPECT tiering, same "flags are indicators for analyst
// review, never verdicts" philosophy, see flightIntegrityManager.js. Self-
// contained (unlike the AIS pipeline, there's no separate flightInvariants
// gate module yet — kinematic checks live inside the scoring module itself).
export const FLIGHT_INTEGRITY = {
    WEIGHTS: {
        EMERGENCY:        50,   // squawk 7500/7600/7700 or ADS-B emergency field set
        IMPOSSIBLE_SPEED: 35,   // teleport-grade position jump between polls
        ALTITUDE_JUMP:    25,   // climb/descent rate implied between polls is impossible
        ICAO_INVALID:     20,   // malformed/null hex24 (000000, FFFFFF, not 6 hex chars)
        SPEED_MISMATCH:   20,   // reported ground speed << implied speed from track
        EXCESSIVE_SPEED:  15,   // implied speed exceeds plausible-aircraft ceiling
        DARK:             15,   // ADS-B went silent (removed after STALE_MS with no update)
        DEFAULT:          10,
    },
    TIER_TRUSTED:      80,      // score ≥ → TRUSTED (green) — mirrors INTEGRITY tiers for UI consistency
    TIER_QUESTIONABLE: 50,      // score ≥ → QUESTIONABLE (amber); below → SUSPECT (red)
    FLAG_TTL_MS:       10 * 60 * 1000,  // soft (event) flags expire after this if not re-triggered
    MIN_DT_MS:         2000,    // ignore kinematic checks under this poll interval (noise floor)
    IMPOSSIBLE_SPEED_KTS: 2200, // faster than anything in civil or most military airspace (SR-71-class)
    EXCESSIVE_SPEED_KTS:  700,  // soft ceiling — flags outliers, not a hard physical limit
    SPEED_MISMATCH_MIN_KTS: 100,  // only check mismatch above this implied speed (avoid low-speed GPS noise)
    SPEED_MISMATCH_FACTOR:  1.6,  // implied speed must exceed reported gs by this factor to flag
    ALTITUDE_JUMP_FPM:  12000,  // implied climb/descent rate (ft/min) beyond this is impossible
    TICK_MS:            5000,   // periodic flag-decay cadence
};

// ── Airspace-avoidance war-signal detection (SCOPED, NOT BUILT — task #12) ───
// Jamal's idea: a sharp drop in overflight density over a region vs. its own
// recent baseline is a proxy for airspace closure/conflict — civil traffic
// reroutes around war zones, SAM threats, and NOTAM closures almost in real
// time, often well ahead of mainstream news. This block is the scoping
// deliverable for task #12: config knobs + design notes, deliberately not
// wired into a manager yet. See airspaceAvoidanceManager.js for the full
// design writeup (data model, algorithm, open questions) — kept as a
// non-imported stub file for the same reason.
//
// Key design choice: grid cells, not country polygons. We have no country
// border geometry in this codebase (aisCountries.js is MMSI→country text
// only, not polygons) and pulling one in is its own scoped decision. A coarse
// lat/lon grid sidesteps that dependency entirely and arguably detects the
// signal earlier — a closed air corridor inside a country shows up as a grid
// cell anomaly before the whole country's traffic visibly drops.
export const AIRSPACE_AVOIDANCE = {
    GRID_DEG:           2,            // cell size in degrees lat/lon — coarse enough to smooth normal traffic noise, fine enough to localize a corridor
    BASELINE_WINDOW_HR: 24 * 7,       // rolling baseline = same cell's avg occupancy over the trailing 7 days, bucketed by hour-of-day (traffic is diurnal — compare like-for-like hours, not a flat 7-day average)
    SAMPLE_INTERVAL_MS: 5 * 60_000,   // how often a cell's current occupancy is sampled into its history
    MIN_BASELINE_SAMPLES: 12,         // don't flag a cell until it has at least this many historical samples for its hour-of-day bucket — avoids false positives from sparse history
    DROP_THRESHOLD_PCT: 60,           // flag when current occupancy is this much below baseline (e.g. 60 = traffic is down 60%+ from normal for this cell/hour)
    MIN_BASELINE_COUNT: 4,            // ignore cells whose baseline occupancy is already near-zero (e.g. open ocean) — a "drop" from 1 aircraft to 0 isn't a signal
    GRACE_HR:           2,            // a flagged cell must stay below threshold this long before it's treated as a sustained closure rather than a momentary gap in ADS-B coverage
};

// ── Aerial conflict / proximity detection (TCAS-style CPA check) ─────────────
// Sibling of FLIGHT_INTEGRITY — separate module (conflictManager.js) since
// this is pairwise (O(n²) over live aircraft) rather than per-aircraft.
export const CONFLICT = {
    HORIZONTAL_NM:    5,      // CPA horizontal separation below this = conflict
    VERTICAL_FT:      1000,   // CPA vertical separation below this = conflict (standard IFR sep is 1000ft above FL290, 2000 below... we use one band, this is advisory not a real ATC tool)
    LOOKAHEAD_SEC:    300,    // only project CPA up to 5 minutes out — beyond that the dead-reckoning straight-line assumption (no turns) is too unreliable to mean anything
    MIN_SPEED_KTS:    50,     // ignore aircraft below this (parked/taxiing/ground-adjacent noise, already mostly filtered by FLIGHT.MIN_ALT_M)
    TICK_MS:          3000,   // recompute cadence — independent of FLIGHT.POLL_INTERVAL since dead-reckoned positions move every frame
    GRACE_MS:         15_000, // keep a pair flagged this long after it stops triggering, so it doesn't flicker in/out right at the threshold edge
    // Severity bands — purely a function of how close + how soon, for UI color only.
    CRITICAL_NM:      2,
    CRITICAL_SEC:     90,
};

// ── Camera FOV presets ────────────────────────────────────────────────────────
export const CAMERA = {
    FOV_PRESETS: [
        { key: 'CIN', fov: 55, maxPolar: 1.35, label: 'CINEMATIC' },
        { key: 'BAL', fov: 35, maxPolar: 1.35, label: 'BALANCED'  },
        { key: 'TAC', fov: 18, maxPolar: 1.20, label: 'TACTICAL'  },
    ],
    FOV_DEFAULT_IDX: 1,  // BALANCED
};

// ── Flight tracking + altitude colour ────────────────────────────────────────
export const FLIGHT = {
    API_URL:       'http://localhost:8787/flights',
    POLL_INTERVAL: 30_000,           // ms — safe for anonymous tier
    MAX_AIRCRAFT:  300,
    STALE_MS:      120 * 1000,       // remove after 2 min silence
    MIN_ALT_M:      300 * 0.3048,    // ~91.4m = 300ft AGL — symmetric appear/disappear floor.
                                      // An aircraft is only tracked above this altitude; a poll
                                      // reporting it at/below this (or explicitly on the ground)
                                      // is treated as a landing, same threshold both directions.
    ALT_LOW_MAX:    2000,            // m — solid yellow below this
    ALT_MID_MAX:    6000,            // m — yellow→white gradient
    ALT_CRUISE_MAX: 10000,           // m — light grey; cyan gradient above
};

// ── Aircraft flight dynamics (visual, not physical sim) ──────────────────────
// Heading/bank/pitch are smoothed in flightManager.js's tick() and applied as
// a per-instance quaternion in aircraftInstancer.js. None of this feeds back
// into actual position — it's purely a believable visual layer on top of the
// real ADS-B track/altitude trend, tuned by eye rather than derived from real
// aerodynamics.
export const FLIGHT_DYNAMICS = {
    TURN_RATE_DEG_PER_SEC: 6,    // max yaw speed when chasing a new heading report
    BANK_MAX_DEG:          25,   // clamp on visual roll
    BANK_GAIN:             0.8,  // deg of bank per deg of remaining heading error
    BANK_EASE_RATE:        4,    // how fast bank eases toward its target (per sec)
    PITCH_MAX_DEG:         12,   // clamp on visual nose-up/down
    PITCH_GAIN:            1.0,  // deg of pitch per m/s of vertical rate
    PITCH_EASE_RATE:       3,    // how fast pitch eases toward its target (per sec)
    SPAWN_EASE_SEC:        0.5,  // motion-graphics polish (2026-06-27): newly spawned aircraft scale in over this many seconds instead of popping to full size instantly — see flightManager.js tick() spawnEase and aircraftInstancer.js's easeOutBack
};

// ── Aircraft classification (visual variety) ─────────────────────────────────
// ADS-B carries an emitter category (ICAO Mode S Annex 10) and, on airplanes.live,
// a dbFlags bitfield. Neither directly says "this is a cargo jet" or "this is a
// fighter" — category tells us airframe size class, dbFlags bit 1 tells us
// military, and cargo carriers are inferred from known callsign prefixes since
// there is no dedicated flag for it. Classification happens once per poll in
// flightManager.js; entityBuilder.js consumes the result to pick a visual model.
export const AIRCRAFT_CLASSES = {
    CATEGORY_MAP: {
        A1: 'GA', A2: 'GA',
        A3: 'COMMERCIAL', A4: 'COMMERCIAL', A5: 'COMMERCIAL',
        A6: 'MILITARY',
        A7: 'HELICOPTER',
        B2: 'GA', B6: 'GA',   // lighter-than-air / UAV — folded into GA visuals for now
    },
    CARGO_CALLSIGN_PREFIXES: [
        'FDX', 'UPS', 'GTI', 'CLX', 'ABW', 'BOX', 'CKS', 'GEC', 'CAO', 'MPH', 'ABX',
    ],
    MILITARY_DB_FLAG: 1,   // dbFlags & 1 (airplanes.live convention)
    HEX: {
        COMMERCIAL: '#e0f0ff',
        CARGO:      '#ffab40',
        MILITARY:   '#8aff80',
        HELICOPTER: '#40c4ff',
        GA:         '#d9b3ff',
    },
    SCALE: {
        COMMERCIAL: 0.13,
        CARGO:      0.15,
        MILITARY:   0.10,
        HELICOPTER: 0.11,
        GA:         0.08,
    },
    DEFAULT: 'COMMERCIAL',
};

// ── Airline operator lookup (callsign ICAO prefix → display name) ───────────
// Pure local table, no network call — same spirit as CARGO_CALLSIGN_PREFIXES
// above. Covers the major commercial/cargo carriers likely to show up on a
// global ADS-B feed; not exhaustive. Used by flightManager.js to populate
// the aircraft card's OPERATOR field instantly (vs. registration/type which
// come straight off the wire, and origin/destination/photo which need a
// network round trip — see flight-proxy.js /flight-route, /aircraft-photo).
export const AIRLINE_PREFIXES = {
    AAL: 'American Airlines',   UAL: 'United Airlines',     DAL: 'Delta Air Lines',
    SWA: 'Southwest Airlines',  JBU: 'JetBlue',              ASA: 'Alaska Airlines',
    SKW: 'SkyWest',             FFT: 'Frontier Airlines',    NKS: 'Spirit Airlines',
    ACA: 'Air Canada',          WJA: 'WestJet',
    BAW: 'British Airways',     VIR: 'Virgin Atlantic',      EZY: 'easyJet',
    RYR: 'Ryanair',             AFR: 'Air France',           DLH: 'Lufthansa',
    KLM: 'KLM',                 IBE: 'Iberia',               VLG: 'Vueling',
    SWR: 'Swiss',                AUA: 'Austrian Airlines',   SAS: 'SAS',
    FIN: 'Finnair',              TAP: 'TAP Air Portugal',    LOT: 'LOT Polish Airlines',
    WZZ: 'Wizz Air',             THY: 'Turkish Airlines',    AFL: 'Aeroflot',
    UAE: 'Emirates',             QTR: 'Qatar Airways',       ETD: 'Etihad Airways',
    SVA: 'Saudia',               GFA: 'Gulf Air',             KAC: 'Kuwait Airways',
    MEA: 'Middle East Airlines', RJA: 'Royal Jordanian',
    CPA: 'Cathay Pacific',       SIA: 'Singapore Airlines',  ANA: 'All Nippon Airways',
    JAL: 'Japan Airlines',       KAL: 'Korean Air',           AAR: 'Asiana Airlines',
    CCA: 'Air China',            CSN: 'China Southern',       CES: 'China Eastern',
    EVA: 'EVA Air',              CAL: 'China Airlines',       THA: 'Thai Airways',
    AXM: 'AirAsia',              GIA: 'Garuda Indonesia',     MAS: 'Malaysia Airlines',
    QFA: 'Qantas',               JST: 'Jetstar',               VOZ: 'Virgin Australia',
    ANZ: 'Air New Zealand',
    LAN: 'LATAM Airlines',       AVA: 'Avianca',               AMX: 'Aeromexico',
    GLO: 'GOL Linhas Aereas',    AZU: 'Azul Brazilian Airlines',
    ETH: 'Ethiopian Airlines',   SAA: 'South African Airways', KQA: 'Kenya Airways',
    // Cargo — mirrors CARGO_CALLSIGN_PREFIXES, named explicitly here for the OPERATOR field
    FDX: 'FedEx Express',  UPS: 'UPS Airlines',   GTI: 'Atlas Air',  CLX: 'Cargolux',
    ABW: 'Air Bridge Cargo', BOX: 'AeroLogic',    CKS: 'Kalitta Air', GEC: 'Lufthansa Cargo',
    CAO: 'Air China Cargo',  MPH: 'Martinair Cargo', ABX: 'ABX Air',
};


// ── Layer manager ─────────────────────────────────────────────────────────────
export const LAYER = {
    STORAGE_KEY: 'vg1_central_system',
};

// ── Cinematic director ────────────────────────────────────────────────────────
export const DIRECTOR = {
    IDLE_THRESHOLD: 15.0,  // s — idle before activating
    SHOT_DURATION:  12.0,  // s — cut interval
    FOLLOW_K:        3.5,  // exponential damping for target pan
    FLY_K:           1.8,  // exponential damping for camera fly-in
};

// ── Cluster manager ───────────────────────────────────────────────────────────
export const CLUSTER = {
    SHIP_THRESHOLD:       150,   // camera.y above → combined cluster
    SPLIT_THRESHOLD:       90,   // camera.y 90–150 → split dark/non-dark clusters
    FLIGHT_THRESHOLD:     100,
    ANOMALY_HIGH_RECENCY: 10 * 60 * 1000,       // 10 min → fast pulse
    DARK_STALE:            6 * 60 * 60 * 1000,  // 6 h dark → slow pulse
    ACTIVE_SPEED_KTS:       2,   // minimum knots to qualify as an active vessel
    MARKER_CLOSE_ZOOM:     80,   // camera.y below → individual markers visible
};

// ── Threat intensity (drives bloom strength + vignette opacity) ───────────────
export const THREAT_INTENSITY = {
    LOW:      0.00,
    MODERATE: 0.18,
    ELEVATED: 0.50,
    CRITICAL: 1.00,
};

// ── AI Copilot ────────────────────────────────────────────────────────────────
export const COPILOT = {
    API_URL:              'http://localhost:8787/ai-assess',
    MIN_CALL_INTERVAL:    20_000,        // ms — max 3 Claude calls/min
    EVENT_SCORE_THRESHOLD: 60,           // min score to queue for Claude
    DEBOUNCE_MS:          10 * 60 * 1000, // 10 min between same event/vessel
    ANOMALY_TICK_S:       30,            // rule engine cadence
    CLUSTER_DEG_RADIUS:    1.5,          // ~90 nm radius for vessel clustering
    CLUSTER_MIN_VESSELS:   4,            // min vessels to flag as cluster
};

// ── AI Discovery layer ──────────────────────────────────────────────────────
// Cross-domain pattern-finding, separate from the per-event aiCopilot enrichment
// above. Where COPILOT narrates one event in isolation, DISCOVERY periodically
// hands Claude the whole live picture (recent timeline + invariants + integrity
// + clusters) and lets it surface correlations / act back on the scene.
export const DISCOVERY = {
    AI_ENABLED:        false,           // kill switch — false means NEVER call /ai-discover or /ai-query,
                                          // even on RUN NOW or a genuine escalation. Rule engine only.
                                          // Flip to true once a provider key with real quota is configured.
    API_URL:           'http://localhost:8787/ai-discover',
    QUERY_API_URL:      'http://localhost:8787/ai-query', // freeform operator Q&A, same snapshot context
    LOG_PASS_URL:       'http://localhost:8787/memory/log-pass', // free telemetry — every tick, see memoryStore.js appendRulePass
    TICK_S:             90,            // how often we consider running a discovery pass
    MIN_CALL_INTERVAL:  60_000,        // ms — hard floor between Claude calls (separate budget from COPILOT)
    MIN_NEW_ENTRIES:    3,             // don't call Claude if nothing new happened since last pass
    MAX_TIMELINE_PER_ENTITY: 12,       // rolling per-MMSI history depth (narrative memory, not just dedup)
    TIMELINE_TTL_MS:    6 * 60 * 60 * 1000, // drop timeline entries older than 6h
    MAX_SNAPSHOT_ENTITIES: 40,         // cap payload size — most-relevant entities only (flagged/active first)
    MAX_QUERY_HISTORY:  6,             // # of prior Q&A turns kept for /ai-query conversational memory (3 pairs)
};

// ── Discovery local rule engine (2026-06-21) ─────────────────────────────────
// Analyst-tradecraft heuristics that run on every tick, in-browser, for $0 —
// see discoveryRules.js. These decide which findings are confident enough to
// template directly (no LLM call) and which co-occurrences are genuinely
// ambiguous enough to be worth spending a Claude call on. Tune here, not in
// discoveryRules.js — that file should stay pure logic, no magic numbers.
export const DISCOVERY_RULES = {
    SUSPECT_MIN_FLAGS_FOR_AUTO:        2,  // SUSPECT tier + this many corroborating flags → auto-finding, no LLM
    STS_PAIR_CONFIDENT_MAX:            2,  // exactly this many loitering together → confident STS template
    MULTI_SIGNAL_TYPES_MIN:            2,  // distinct event TYPES (not just count) on one vessel → escalate
    CROSS_DOMAIN_ESCALATE_MIN_DOMAINS: 3,  // domains (RF/chokepoint/AIS-story/loitering) active at once → escalate
    COORDINATED_VESSEL_MIN:            3,  // vessels with developing stories in the same window → escalate
};

// ── Tactical regions (SITREP context — first match wins, order matters) ───────
export const REGIONS = [
    { name: 'ARCTIC / HIGH NORTH',              latMin:  60, latMax:  90, lonMin: -180, lonMax:  180 },
    { name: 'NORTH SEA / BALTIC',               latMin:  48, latMax:  90, lonMin:   -5, lonMax:   30 },
    { name: 'MEDITERRANEAN',                    latMin:  30, latMax:  48, lonMin:   -6, lonMax:   42 },
    { name: 'RED SEA / GULF OF ADEN',           latMin:  12, latMax:  30, lonMin:   42, lonMax:   60 },
    { name: 'PERSIAN GULF / HORMUZ',            latMin:  22, latMax:  30, lonMin:   48, lonMax:   60 },
    { name: 'ARABIAN SEA',                      latMin:  -5, latMax:  22, lonMin:   55, lonMax:   80 },
    { name: 'WESTERN INDIAN OCEAN',             latMin: -30, latMax:   5, lonMin:   40, lonMax:   80 },
    { name: 'EASTERN INDIAN OCEAN',             latMin: -30, latMax:  20, lonMin:   80, lonMax:  110 },
    { name: 'STRAIT OF MALACCA',                latMin:   0, latMax:  15, lonMin:   95, lonMax:  115 },
    { name: 'SOUTH CHINA SEA',                  latMin:  -5, latMax:  22, lonMin:  105, lonMax:  125 },
    { name: 'EAST CHINA SEA / TAIWAN STRAIT',   latMin:  20, latMax:  38, lonMin:  118, lonMax:  135 },
    { name: 'WESTERN PACIFIC / JAPAN',          latMin:  30, latMax:  90, lonMin:  125, lonMax:  160 },
    { name: 'GULF OF MEXICO / CARIBBEAN',       latMin:  20, latMax:  90, lonMin: -100, lonMax:  -60 },
    { name: 'NORTH ATLANTIC',                   latMin:  40, latMax:  90, lonMin:  -75, lonMax:  -40 },
    { name: 'MID ATLANTIC',                     latMin:  20, latMax:  45, lonMin:  -45, lonMax:  -10 },
    { name: 'SOUTHERN OCEAN',                   latMin: -90, latMax: -20, lonMin: -180, lonMax:  180 },
    { name: 'EASTERN PACIFIC',                  latMin: -90, latMax:  90, lonMin: -180, lonMax: -100 },
    { name: 'NORTHERN EUROPE',                  latMin:  50, latMax:  90, lonMin:  -15, lonMax:   20 },
];

// ── Seeded PRNG (deterministic splat distribution) ───────────────────────────
function mulberry32(a) {
    return function() {
        var t = a += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}
// lightningManager constants
export const LIGHTNING = {
    ENABLED:        true,
    OPACITY:        0.8,
    UPDATE_INTERVAL_MS: 30_000,   // how often to refresh data
    MAX_OBJECTS:    500,          // instanced mesh budget
    FADE_START:     200,          // camera.y above which layer fades out
    FADE_END:       220,          // camera.y above which layer is fully hidden
};

export const prng = mulberry32(12345);
