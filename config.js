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
    WS_URL:      'wss://stream.aisstream.io/v0/stream',
    STORAGE_KEY: 'vanguard_ais_key',
    MAX_VESSELS: 500,   // raised from 200 (2026-06-12) — GPU headroom confirmed
    STALE_MS:    10 * 60 * 1000,  // remove vessels silent for 10 min
    DARK_MS:      5 * 60 * 1000,  // flag as "dark" after 5 min silence
    BBOX:        [[-90.0, -180.0], [90.0, 180.0]],
};

// ── Simulation / replay (simClock.js + dataSource.js) ────────────────────────
export const SIM = {
    SOURCE_TICK_MS: 2000,    // how often synthetic/recorded sources emit (real ms)
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
    ALT_LOW_MAX:    2000,            // m — solid yellow below this
    ALT_MID_MAX:    6000,            // m — yellow→white gradient
    ALT_CRUISE_MAX: 10000,           // m — light grey; cyan gradient above
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
