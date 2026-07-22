// config.js — Global constants. Import from here; never hardcode in managers.
//
// VISUAL CONSTANTS: these values were hand-tuned and define Vanguard's look.
// Do not change them without reading CLAUDE.md first — they have cascading effects.

// ── Map geometry ──────────────────────────────────────────────────────────────
export const MAP_WIDTH  = 300;   // scene units = full longitude span
export const MAP_HEIGHT = 300;   // scene units = full latitude span (Mercator)

// ── Point cloud ───────────────────────────────────────────────────────────────
// The real cap on GPU point count is terrainWorker.js's MAX_ALLOC (see that
// file) — there's no separate "budget" constant here. A MAX_SPLAT_BUDGET
// export was removed 2026-07-20: never wired into the worker (never received,
// never sampled to), and its presence had masked a real bug — SPLAT_LAND_GRID
// =7500 silently overflowed the old MAX_ALLOC before the ocean pass ever ran,
// so SPLAT_OCEAN_GRID's points never rendered (0/131,387 sampled points had
// negative elevation). Fixed by trimming SPLAT_LAND_GRID so land+ocean fits
// under MAX_ALLOC with headroom — see that constant for the real budget math.
// If true sampling-to-budget is wanted again, thread it through the worker —
// don't just declare a constant here again.
export const SPLAT_LAND_GRID   = 6000;    // 7500→5500→6000 (2026-07-20). First cut (5500) fixed
                                          // oblique-angle FPS (34-44fps→stable 63fps) and let the
                                          // ocean pass finally render, but Jamal flagged the base
                                          // cloud reading visibly grainy/banded at close oblique zoom
                                          // where it's still a substantial backdrop (uFade~0.43) next
                                          // to crisp tile-stream "panels" — confirmed live, not the
                                          // tile-stream's fault at that spot. 70fps measured at the
                                          // exact reported scenario = ~10fps of headroom above a 60fps
                                          // target, so gave some density back: 6000 → ~14.9M land +
                                          // ~5.28M ocean ≈ 20.2M, just over the old 20M MAX_ALLOC —
                                          // bumped that too (see terrainWorker.js). Paired with wider
                                          // real tile-stream coverage (tileStreamManager.js adaptive
                                          // radius) — both levers pulled together per Jamal's call.
                                          // Measured land fraction of the grid is ~0.413 (Mercator-
                                          // inflated, not the ~0.30 the original comment assumed).
export const SPLAT_OCEAN_GRID  = 3000;    // bumped from 1195 — unchanged; was already correctly sized,
                                          // just never got to render until the land-grid trim above.

// Splat shader uniforms — tunable live: window.splatCloud.material.uniforms.uBrightness.value = X
// Changing these shifts the brightness/colour of ALL land terrain.
export const SPLAT_BRIGHTNESS  = 0.95;   // "Natural Earth" palette (2026-07-13, Jamal's pick, was 0.86)
export const SPLAT_LAND_LIFT   = 0.18;   // 0.28 → 0.18 (2026-07-13): this drives the
                                          // close-zoom brightness lift (up to 1+lift at
                                          // dist<150). Tuned for the old dark look, it was
                                          // washing out the Natural Earth palette up close
                                          // ("flat and too bright" — Jamal). 0.15 hard floor.
export const SPLAT_LAND_GAMMA  = 0.70;   // tuned by shader-auto-tuner (was 0.65) — lifts shadow mid-tones
export const SPLAT_SATURATION  = 1.30;   // "Natural Earth" palette (2026-07-13, Jamal's pick, was 2.10)
                                          // Live A/B/baseline study at the global view: 2.10 read as
                                          // "video-game lime"; 1.30 lets the satellite data's real
                                          // olives/tans/ochres through — biomes differentiate again.
export const SPLAT_HEMI_STRENGTH  = 0.35; // hemisphere lighting: 0=off, 1=full. Tune live via DevTools.
export const SPLAT_HILLSHADE      = 0.42; // 0.55→0.42 (2026-07-18): the aspect-aware relief shading adds
                                          // light/dark contrast on every slope — fine on flat deserts, but
                                          // over hilly green terrain it stacked onto the busy forest imagery
                                          // and amplified the speckly look. Softened to calm it while keeping
                                          // terrain definition. cartographic NW hillshade: 0=off, 1=max carve.
export const SPLAT_BIOME_STRENGTH = 0.30; // biome tinting: 0=off, 1=full. Tune live via DevTools.

// ── Terrain LOD crossfade thresholds (camera.position.y) ─────────────────────
// HYBRID MODE: splat is the only thing rendered. Continent mesh stays in
// memory as a silent data object (geometry + elevation values available for
// future shader sampling) but never renders. Splat opacity stays at 1.0 at
// every zoom level — these negative values guarantee the fade calc clamps
// to 1.0 regardless of camera height.
export const SPLAT_FADE_START      = -1;   // negative = never starts fading (splat always visible)
export const SPLAT_FADE_END        = -10;  // never reaches "hidden"
// Used INSTEAD of the two above when the Cesium tile stream is live (2026-07-12):
// dots hand off to photoreal z12/13 tiles at close zoom. Without a token /
// offline, the always-visible values above still apply — never bare ocean floor.
export const SPLAT_FADE_TILES_START = 24;  // 13→24 (2026-07-18): hand the base cloud off to the photographic TILES at a HIGHER altitude, so the good tile render (shot 2) appears sooner instead of the grainy base cloud (shot 1). Also culls the base's ~16M points earlier → better FPS in the mid-zoom band. Original note: base cloud starts fading as the z7
                                           // point tiles activate (showAlt 13), so it's on its way out
                                           // by the time detailed tiles carry the terrain.
export const SPLAT_FADE_TILES_END   = 14;  // 7→14 (2026-07-18): base fully gone by this altitude so tiles own the mid/close view. Original note: base fully gone once tile points solidly cover —
                                           // stops the sparse zoomed-out dots cluttering close detail.

// ── Cesium tile stream rendering style (2026-07-12) ─────────────────────────
export const TILESTREAM = {
    // 'points'    → sample Cesium DEM tiles into dense splat-style points: the
    //               map stays one aesthetic, just gets geometrically true and
    //               denser as you descend (Jamal's pick — "idea 3").
    // 'photoreal' → satellite-textured terrain meshes (kept as an alternate).
    STYLE:            'points',
    // FORCE_MESH (2026-07-18): global override — when true, EVERY tile level renders
    // as a textured satellite mesh (defined/crisp, map-like) instead of points, at
    // all zooms. This is the "defined from a distance" demo. Set back to false to
    // return to the point-cloud aesthetic (per-level 'render' fields then apply).
    FORCE_MESH:       false,
    POINTS_PER_TILE:  6000,   // density budget per tile, spread by triangle area
    POINT_SIZE:       0.014,  // world-units, size-attenuated with distance
    POINT_OPACITY:    0.92,   // max opacity of streamed points once faded in
    // Photo-colored points (2026-07-12): sample each point's color from the
    // satellite image of its exact spot — XRF-level color detail, still pure
    // point-cloud aesthetic. PHOTO_BLEND: 1 = raw photo color, 0 = palette only.
    PHOTO_COLOR:      true,
    // ── Colour: TWO sets (2026-07-18) ────────────────────────────────────────
    // The boosted values (below) apply ONLY to the close-up deep levels (z ≥ 8),
    // where the user wanted strong, vivid imagery day/night. The coarse levels
    // (z < 8) — the tiles you see at the world/regional view — use the *_FAR
    // values, which are the original calibrated palette, so the zoomed-out map
    // keeps its natural "Natural Earth" look and matches the base cloud instead
    // of going gold/over-saturated. Selected by zoom in _buildPoints.
    PHOTO_BLEND:      0.92,   // close-up (z≥8): real satellite colour dominates
    POINT_BRIGHTNESS: 0.95,   // close-up (z≥8): strong day/night (tiles unlit)
    POINT_SATURATION: 1.40,   // close-up (z≥8): vivid
    PHOTO_BLEND_FAR:      0.80,  // coarse (z<8): original blend — natural world-view palette
    POINT_BRIGHTNESS_FAR: 0.85,  // 0.72→0.85 (2026-07-18): coarse/mid tiles were reading muddy at night; lifted for readability (no saturation boost on far, so minimal desert gold-cast)
    POINT_SATURATION_FAR: 1.00,  // coarse (z<8): no extra saturation — no desert gold cast
    POINT_SMOOTH:         1.15,  // tile point-size multiplier (2026-07-18): >1 overlaps points into a smoother surface (trimmed 1.30→1.15 to reduce edge-seam brightness + overdraw)
    // Procedural detail amplification (2026-07-15): synthesized coherent fine
    // relief + surface texture baked into tile points, filling in below the
    // ~30m DEM resolution so every area stays detailed as you zoom. All the
    // knobs below are tunable; set ENABLED:false to A/B against raw DEM.
    PROCEDURAL: {
        ENABLED: true,
        FREQ:    12,      // base spatial frequency of the synthetic detail (×2^(zoom-7) per level)
        RELIEF:  0.0018,  // 0.004→0.0018 (2026-07-18): less synthetic micro-bump so the surface reads smoother (keeps real DEM relief)
        COLOR:   0.05,    // 0.14→0.05 (2026-07-18): the ±7% per-point brightness noise was the "sandpaper" speckle — calmed to ±2.5% for a smoother surface
    },
};
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
export const WATER_OPACITY = 0.96;  // 0.85 → 0.96 (2026-07-15): stop terrain/backdrop showing
                                    // through the sea plane at grazing angles (looked transparent)

// ── Day/night terrain shading (terrainBuilder splat shader) ──────────────────
// Geographic terminator dimming of the terrain itself — tracks the real sun
// (and simClock scrubbing). Tunable live:
//   window.splatCloud.material.uniforms.uNightDim.value   = 0..1 (effect strength)
//   window.splatCloud.material.uniforms.uNightFloor.value = min brightness on night side
export const DAYNIGHT_TERRAIN = {
    // NOTE: this dim MULTIPLIES with the dayNightManager overlay's own night
    // darkening — keep STRENGTH/FLOOR gentle or night-side land goes black.
    STRENGTH: 0.20,   // 0.35→0.20 (2026-07-18): gentler terminator dim so night terrain stays readable
    FLOOR:    0.82,   // 0.60→0.82 (2026-07-18): night side never darker than 82% of day colour — lifts night readability (trades some day/night contrast for a map you can read 24/7)
};

// ── Terrain vertical exaggeration ─────────────────────────────────────────────
// 1.0 = the original hand-tuned look (~200× true vertical exaggeration at low
// elevations). Lower = flatter, more physically honest terrain — sensible now
// that the map supports deep zoom. Applied at terrain BUILD time: change
// requires a reload to take effect. Flows to: splat worker, ocean floor mesh,
// terrain mesh, tile stream, buildings, city patches, cable depths, and the
// shader's elevation-decode (contours/cliff thresholds).
export const TERRAIN_VSCALE_LAND  = 0.20;  // 0.05 → 0.20 (2026-07-15): restore land relief +
                                           // lift Cesium tiles above the wavy sea plane. Starting
                                           // point for live tuning — push toward 0.3–0.4 for more
                                           // drama, back off toward 0.1 if peaks spike. Was 0.05
                                           // ("near-true, flat for tracking") which drowned the
                                           // close-zoom tile terrain under the ocean.
export const TERRAIN_VSCALE_OCEAN = 1.0;   // ocean: full original drama — bathymetry is information

// Back-compat alias (single-scale consumers); prefer the split constants above.
export const TERRAIN_VERTICAL_SCALE = TERRAIN_VSCALE_LAND;

// ── Splat FX (terrainBuilder splat shader) ────────────────────────────────────
// Tunable live:
//   window.splatCloud.material.uniforms.uSplatScale.value = 1.3  (point size, closes gaps)
//   window.splatCloud.material.uniforms.uRidgePulse.value = 0.3  (ridge energy glow, 0 = off)
export const SPLAT_FX = {
    SCALE:       1.40,  // 1.15→1.40 (2026-07-18): global point-size multiplier. Bigger splats overlap
                        // into a continuous surface at mid/far zoom, killing the grainy speckle look
                        // from a distance. Base cloud fades out at close zoom, so this only affects the
                        // world/regional view (where the grain shows) — close-up detail is unaffected.
    RIDGE_PULSE: 0.0,   // 0.18→0 (2026-07-18): the animated blue ridge glow rode along steep/high-relief
                        // terrain — invisible on flat deserts but shimmering over hilly GREEN regions
                        // (Europe, forests), which read as moving 'static/distortion'. Disabled.
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
    // WS subscription BBOX — must be global on aisstream.io free tier (regional
    // BBOX silently drops all messages on the free plan). Client-side filtering
    // (CLIENT_BBOX below) restricts what actually appears on the map.
    BBOX:        [[-90.0, -180.0], [90.0, 180.0]],

    // Client-side region filter applied AFTER the WebSocket delivers messages.
    // Only vessels whose lat/lon falls inside this box are ingested.
    // Set to null to show all received vessels (no geographic restriction).
    CLIENT_BBOX: null,  // null = show all vessels globally; set to [[latMin, lonMin], [latMax, lonMax]] to restrict region
};

// ── Simulation / replay (simClock.js + dataSource.js) ────────────────────────
export const SIM = {
    SOURCE_TICK_MS: 500,     // how often synthetic/recorded sources emit (real ms) — was 2000; lowered for more frequent position updates / visibly smoother movement
    RECORDER_MAX:   200000,  // max captured AIS messages before recorder stops
};

// ── Zone recorder (zoneRecorder.js) ──────────────────────────────────────────
export const ZONE_REC = {
    TICK_MS:           500,    // real-ms cadence of the arm/auto-stop state machine
    DEFAULT_RADIUS_NM: 100,    // default capture radius
    MAX_RECORDS:       200000, // hard cap, same ceiling as SIM.RECORDER_MAX
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

// ── Trail pool sizing (trailManager.js) ───────────────────────────────────────
// The trail ring-buffer has ONE fixed-size pool shared by every entity type
// (ships + aircraft + satellites). It must stay ≥ the sum of every domain's
// own cap, or entities silently lose their trail once the pool fills with no
// user-visible error beyond a console warning.
//
// Fixed 2026-07-21: trailManager.js hardcoded MAX_ENTITIES=256 against an
// estimate of "~100 ships + ~80 aircraft + ~20 sats" — stale the moment
// AIS.MAX_VESSELS was raised to 500 on its own (2026-06-12). Deriving it from
// the real per-domain caps means raising any one of them can't silently starve
// the trail pool again.
export const TRAIL_POOL = {
    // ships + aircraft + satellites (stations~10 + gps~32 + weather~20 +
    // starlink cap 80 ≈ 142, rounded up) + margin for synthetic/replay entities.
    MAX_ENTITIES: AIS.MAX_VESSELS + FLIGHT.MAX_AIRCRAFT + 150,
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


// ── Airline livery body colours ───────────────────────────────────────────────
// Two-tier system: known carriers get their real livery primary colour; anything
// not in this table falls back to a hash of the ICAO prefix (see
// getAircraftBodyColor in main.js) which generates a unique, stable colour for
// every airline code without manual entry. Colours are tuned for visibility on
// the dark map — slightly lighter than real livery to read against the terrain.
// Key = 3-letter ICAO operator prefix (same keys as AIRLINE_PREFIXES above).
export const AIRLINE_COLORS = {
    // ── US Majors ──────────────────────────────────────────────────────────────
    AAL: '#b4cce0',  // American Airlines   polished aluminium/chrome tint
    UAL: '#1e72cc',  // United Airlines     United blue
    DAL: '#dce8f8',  // Delta Air Lines     white-silver fuselage (real Delta body is white)
    SWA: '#304cb2',  // Southwest Airlines  fuselage blue
    ASA: '#007888',  // Alaska Airlines     glacier teal
    JBU: '#1a52a0',  // JetBlue             dark blue
    HAL: '#7a2a90',  // Hawaiian Airlines   orchid purple
    VRD: '#cc1a1a',  // Virgin America      red
    // ── US Low-Cost / Ultra ────────────────────────────────────────────────────
    FFT: '#3aaa3a',  // Frontier Airlines   Frontier green
    NKS: '#ffcc00',  // Spirit Airlines     Spirit yellow
    AAY: '#6a1f90',  // Allegiant Air       plum purple
    WJA: '#1a7060',  // WestJet             teal
    // ── US Regionals ───────────────────────────────────────────────────────────
    SKW: '#607080',  // SkyWest             slate
    RPA: '#3a90cc',  // Republic Airways    light blue
    ENY: '#4a6080',  // Envoy (Amer Eagle)  denim
    EDV: '#6455a8',  // Endeavor (DL Conn)  lavender-blue
    ASH: '#7a8844',  // Mesa Airlines       olive
    CPZ: '#507098',  // Compass             steel blue
    // ── US Cargo ───────────────────────────────────────────────────────────────
    FDX: '#8800aa',  // FedEx Express       FedEx purple
    UPS: '#c05800',  // UPS Airlines        UPS brown-orange
    GTI: '#7888a0',  // Atlas Air           cool grey
    CLX: '#cc2020',  // Cargolux            red
    ABW: '#c08020',  // Air Bridge Cargo    gold
    ABX: '#c08020',  // ABX Air             gold
    CKS: '#506070',  // Kalitta Air         slate
    // ── Canadian ───────────────────────────────────────────────────────────────
    ACA: '#cc2020',  // Air Canada          maple red
    // ── European ───────────────────────────────────────────────────────────────
    RYR: '#1c30b0',  // Ryanair             Ryanair royal blue
    EZY: '#e84800',  // easyJet             safety orange
    EJU: '#e84800',  // easyJet Europe      (same brand)
    DLH: '#d4aa00',  // Lufthansa           Lufthansa yellow
    GEC: '#d4aa00',  // Lufthansa Cargo     (same)
    BAW: '#0a2060',  // British Airways     midnight navy
    AFR: '#0030a0',  // Air France          French blue
    KLM: '#00a0e8',  // KLM                 Delft blue
    IBE: '#cc3800',  // Iberia              Spanish orange-red
    VLG: '#f8c800',  // Vueling             gold
    WZZ: '#c00050',  // Wizz Air            magenta
    THY: '#cc1828',  // Turkish Airlines    Turkish red
    SAS: '#1e2880',  // Scandinavian        midnight blue
    AUA: '#cc2020',  // Austrian Airlines   Austrian red
    TAP: '#30a030',  // TAP Air Portugal    green
    FIN: '#1a5090',  // Finnair             Finnair blue
    SWR: '#cc1828',  // Swiss               Swiss red
    LOT: '#0040a0',  // LOT Polish Airlines blue
    // ── Middle East ────────────────────────────────────────────────────────────
    UAE: '#d42020',  // Emirates            red
    QTR: '#700040',  // Qatar Airways       deep burgundy
    ETD: '#c09820',  // Etihad Airways      gold
    SVA: '#006840',  // Saudia              Saudi green
    GFA: '#885020',  // Gulf Air            gold-brown
    MEA: '#cc2020',  // Middle East Airl.   red
    // ── Asia-Pacific ───────────────────────────────────────────────────────────
    SIA: '#1a6098',  // Singapore Airlines  Singapore blue
    CPA: '#00807a',  // Cathay Pacific      teal
    ANA: '#1a2e90',  // All Nippon Airways  midnight blue
    JAL: '#cc1020',  // Japan Airlines      JAL crimson
    KAL: '#0a2490',  // Korean Air          deep blue
    AAR: '#1a4080',  // Asiana Airlines     blue
    CCA: '#cc1828',  // Air China           red
    CSN: '#0a2890',  // China Southern      blue
    CES: '#d41828',  // China Eastern       red
    EVA: '#006840',  // EVA Air             forest green
    CAL: '#cc2020',  // China Airlines      red
    THA: '#5040a8',  // Thai Airways        purple
    AXM: '#cc2020',  // AirAsia             red
    GIA: '#1a5098',  // Garuda Indonesia    blue
    MAS: '#cc2020',  // Malaysia Airlines   red
    QFA: '#cc2020',  // Qantas              Qantas red
    JST: '#e86a00',  // Jetstar             orange
    VOZ: '#d42020',  // Virgin Australia    red
    ANZ: '#1a1a60',  // Air New Zealand     dark navy
    // ── Latin America ──────────────────────────────────────────────────────────
    AVA: '#cc2828',  // Avianca             red
    LAN: '#cc2828',  // LATAM               red
    GLO: '#e86a00',  // GOL Linhas Aéreas   orange
    AZU: '#1860c8',  // Azul Brazilian Airl. blue
    AMX: '#1e3080',  // Aeromexico          navy
    VOI: '#cc2020',  // Volaris             red
    // ── Africa ─────────────────────────────────────────────────────────────────
    ETH: '#1a5090',  // Ethiopian Airlines  blue
    KQA: '#cc2020',  // Kenya Airways       red
};

// ── Airline tail / fin livery colours ────────────────────────────────────────
// Only airlines with a VISUALLY DISTINCT fin color (vs. the fuselage body) are
// listed here. Airlines not listed get their tail tinted the same as the body
// (monochromatic look). Key = same 3-letter ICAO prefix as AIRLINE_COLORS.
// Colors are tuned for readability against the dark map (slightly brightened).
export const AIRLINE_TAIL_COLORS = {
    // ── US Majors — strong body/tail contrast ─────────────────────────────────
    DAL: '#c8161e',  // Delta:      red tail fin   (body=white)     real Delta tail is red widget
    SWA: '#F0A818',  // Southwest:  gold fin        (body=blue)
    AAL: '#181818',  // American:   graphite fin    (body=silver)
    UAL: '#002060',  // United:     deep navy fin   (body=medium blue)
    ASA: '#001830',  // Alaska:     dark navy fin   (body=teal)
    JBU: '#003070',  // JetBlue:    deep navy fin   (body=lighter blue)
    NKS: '#111111',  // Spirit:     black fin        (body=yellow)
    FFT: '#0B350B',  // Frontier:   dark forest fin (body=bright green)
    HAL: '#380060',  // Hawaiian:   deep violet fin (body=orchid)
    // ── European ──────────────────────────────────────────────────────────────
    DLH: '#041340',  // Lufthansa:  dark navy fin   (body=yellow)
    BAW: '#F0F0F0',  // British Airways: white fin  (body=navy) — Union Jack
    AFR: '#F8F8F8',  // Air France: white fin       (body=blue) — tail-fin design
    KLM: '#003880',  // KLM:        deep Delft fin  (body=lighter blue)
    RYR: '#EEEEEE',  // Ryanair:    white fin       (body=royal blue)
    EZY: '#141414',  // easyJet:    dark fin        (body=orange)
    WZZ: '#141414',  // Wizz Air:   dark fin        (body=magenta)
    SWR: '#F0F0F0',  // Swiss:      white fin+cross (body=red)
    SAS: '#A8BBC8',  // Scandinavian: silver fin   (body=navy)
    // ── Middle East ──────────────────────────────────────────────────────────
    UAE: '#141414',  // Emirates:   dark fin        (body=red)
    QTR: '#B8972A',  // Qatar:      dark gold fin   (body=deep burgundy)
    ETD: '#00254A',  // Etihad:     dark navy fin   (body=gold)
    SVA: '#F5F5F5',  // Saudia:     white fin       (body=green)
    // ── Asia-Pacific ─────────────────────────────────────────────────────────
    SIA: '#F0C020',  // Singapore:  gold fin        (body=blue) — the golden bird
    QFA: '#EEEEEE',  // Qantas:     white fin       (body=red)
    JAL: '#EEEEEE',  // JAL:        white fin       (body=crimson)
    ANA: '#3A8AE8',  // ANA:        lighter blue fin(body=midnight blue)
    KAL: '#EEEEEE',  // Korean Air: white fin       (body=deep blue)
    CPA: '#003836',  // Cathay:     dark teal fin   (body=lighter teal)
    // ── Latin America ────────────────────────────────────────────────────────
    AMX: '#F0F0F0',  // Aeromexico: white fin       (body=navy)
    AZU: '#F0F0F0',  // Azul:       white fin       (body=blue)
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
    AI_ENABLED:        true,            // 2026-07-21: flipped on — real ANTHROPIC_API_KEY confirmed
                                          // working against /ai-query (live "PONG" round-trip test)
                                          // after switching flight-proxy.js off the exhausted Gemini
                                          // free-tier key. Kill switch — false means NEVER call
                                          // /ai-discover or /ai-query, even on RUN NOW or a genuine
                                          // escalation. Rule engine only. Flip back to false if quota
                                          // becomes a concern.
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
