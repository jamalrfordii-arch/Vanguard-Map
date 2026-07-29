// tilePointsBuilder.js — pure point-cloud generation for one streamed terrain tile.
//
// No THREE, no DOM, no window: sibling of conflictMath.js and igrf.js in that
// sense. Extracted from tileStreamManager._buildPoints on 2026-07-24 so the work
// can run in a Worker — it is ~40ms of synchronous number-crunching per tile, and
// with ~242 active tiles in a close-in view that is ~10 SECONDS of main-thread CPU
// that currently blocks the frame loop. Keeping it in ONE module means the worker
// and the main thread share an implementation instead of drifting apart.
//
// STAGE 1 of that change is a pure extraction: identical maths, identical output,
// still called synchronously from the main thread. Nothing here should behave
// differently from the code it replaced. Stage 2 adds the worker.
//
// buildTilePoints() returns plain typed arrays; turning them into a THREE.Points
// stays in tileStreamManager, since that half cannot leave the main thread.

import { MAP_WIDTH, MAP_HEIGHT, TILESTREAM, TERRAIN_VERTICAL_SCALE } from './config.js';
import { elevToSceneY as sharedElevToSceneY, TERRAIN_MODE, resolveMode } from './terrainHeight.js';

// The active height mode. Read from localStorage once so the WORKER (which has no
// localStorage of its own in some contexts) and the main thread agree, and cached
// because this is called per point — millions of times per tile build.
let _mode = null;
export function activeTerrainMode() {
    if (_mode === null) {
        let stored;
        try { stored = globalThis.localStorage?.getItem('vg1_terrain_mode'); } catch (_) {}
        _mode = resolveMode(stored);
    }
    return _mode;
}
/** Override the cached mode — used by the worker, which is handed the mode
 *  explicitly rather than reading storage. */
export function setTerrainMode(mode) { _mode = resolveMode(mode); }

const DEG2RAD = Math.PI / 180;
const TWO_PI  = Math.PI * 2;

/**
 * Earth-curvature Y offset — matches the formula in terrainWorker.js exactly
 * so tile meshes sit flush against the splat-cloud surface.
 */
export function curveOffset(sceneX, sceneZ) {
    const dist = Math.sqrt((sceneX / MAP_WIDTH) ** 2 + (sceneZ / MAP_HEIGHT) ** 2);
    return -Math.pow(dist, 2) * 20.0;
}

export function geoTileBounds(tx, ty, zoom) {
    const dLon = 360 / (2 ** (zoom + 1));
    const dLat = 180 / (2 ** zoom);
    return {
        west:  tx * dLon - 180,
        east:  (tx + 1) * dLon - 180,
        south: ty * dLat - 90,
        north: (ty + 1) * dLat - 90,
    };
}

/** Longitude → scene X (matches lonLatToScene in aisManager.js). */
export function lonToSceneX(lonDeg) {
    return lonDeg * (MAP_WIDTH / 360);
}

/** Latitude → scene Z (Web Mercator, matches lonLatToScene). */
export function latToSceneZ(latDeg) {
    const lr = Math.max(-1.48, Math.min(1.48, latDeg * DEG2RAD));
    const my = Math.log(Math.tan(Math.PI / 4 + lr / 2));
    return -my * (MAP_HEIGHT / TWO_PI);
}

/**
 * Elevation (metres) → scene Y for TILE terrain, before curveOffset.
 *
 * Delegates to terrainHeight.js, which is now the single source of truth for BOTH
 * surfaces the map draws (this one and the base splat cloud in terrainWorker.js).
 * They previously carried independent copies that disagreed by ~3x, which put the
 * base cloud's backstop points ABOVE the tiles they back — see that file's header
 * for the full diagnosis. Do not reintroduce a local copy of this maths.
 *
 * Also used by main.js's deep-dive collision clamp, so the camera's ground floor
 * tracks the surface actually on screen.
 */
export function elevToSceneY(elevMeters, mode = undefined) {
    return sharedElevToSceneY(elevMeters, TERRAIN_VERTICAL_SCALE, 'tiles',
                              mode ?? activeTerrainMode());
}

/**
 * Cap a tile's point size so points cannot overlap beyond `maxOverlap` times the
 * gap between them.
 *
 * MEASURED 2026-07-25 at Tokyo, z12 active. `ptSize` in LOD_LEVELS is almost
 * constant down the ladder (0.0196 → 0.0117) while the tile span collapses
 * 128-fold (4.69u → 0.037u), so overlap grows without bound with depth:
 *
 *     z8  4.8x      z10 16.4x
 *     z9  8.1x      z11 20.1x      z12 38.9x
 *
 * The codebase states its own target in the ACTIVE_PTS_CAP note — "14,000 pts →
 * point size is ~4.8x the gap". z12 was running at 39x, meaning a single point
 * spanned about a third of its own tile. The consequence: z11 and z12 fetched
 * 15.5 m and 9.6 m imagery and then rendered it through points far too fat to
 * resolve it. The detail was bought and then discarded.
 *
 * A CLAMP, not a formula, and that distinction matters. The coarse levels are
 * deliberately UNDER-overlapped (z5 sits at 0.3x, relying on the base splat cloud
 * to backstop the gaps) and were hand-tuned that way. Driving every level to a
 * target overlap would inflate z5's point size ~14x and wreck the world view.
 * Clamping only ever shrinks, so it cannot touch a level that is already sane.
 *
 * @param {number} zoom
 * @param {number} pointCount   ACTUAL points in this tile, not the budget — the
 *                              active-tile cap and the budget disagree, and using
 *                              the budget would mis-size every capped tile.
 * @param {number} configuredSize  ptSize from LOD_LEVELS (after any multipliers)
 * @param {number} maxOverlap
 */
export function clampPointSize(zoom, pointCount, configuredSize, maxOverlap = 6) {
    if (!(configuredSize > 0)) return configuredSize;
    if (!(pointCount > 0) || !Number.isFinite(pointCount)) return configuredSize;
    if (!(maxOverlap > 0)) return configuredSize;
    const span = MAP_WIDTH / (2 ** (zoom + 1));
    const gap  = span / Math.sqrt(pointCount);
    return Math.min(configuredSize, maxOverlap * gap);
}

function _pHash(x, y) {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
}
function _pValNoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = _pHash(xi, yi),     b = _pHash(xi + 1, yi);
    const c = _pHash(xi, yi + 1), d = _pHash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;   // 0..1
}
export function _pFbm(x, y) {
    let f = 0, amp = 0.5, freq = 1;
    for (let o = 0; o < 4; o++) { f += amp * _pValNoise(x * freq, y * freq); freq *= 2.03; amp *= 0.5; }
    return f;   // ~0..1, mean ≈ 0.5
}

/**
 * Elevation → base colour.
 *
 * ⚠ THIS RAMP IS NOT A BIOME MAP AND MUST NOT PRETEND TO BE ONE (rewritten
 * 2026-07-25). The previous version treated ALTITUDE AS ARIDITY: every land
 * band from 600 m up ran pure orange-brown, peaking at r0.54/g0.18/b0.12 —
 * a chroma of 0.46, i.e. a fully saturated desert ochre — for ground that on
 * most of the planet at that altitude is forest. Reported live as "land mass
 * colors look off": whole montane regions rendered as one gold wash, deserts
 * and treeline and alpine meadow all the same hue.
 *
 * Elevation genuinely predicts only two things: that ground above the
 * treeline is bare rock, and that ground above the snowline is snow. It says
 * nothing about whether 900 m is Sahara or Bavaria. So the land half of this
 * ramp is now deliberately LOW-CHROMA (max ~0.12 vs the old 0.46): green
 * through the vegetated altitudes, warm grey rock above treeline, snow at the
 * top. Biome colour comes from the satellite imagery, which actually knows —
 * see PHOTO_BLEND in config.js, currently 0.92 close-up.
 *
 * That low chroma matters even where imagery IS present. The palette keeps an
 * 8% share of every blended point, and at 0.46 chroma that 8% was enough to
 * drag the whole surface warm before POINT_SATURATION then amplified it. A
 * neutral base cannot do that. Do not "restore the warmth" here — if deserts
 * read too grey, the fix is the imagery blend or a real biome/landcover
 * lookup, not a hue this function has no way to know.
 *
 * The ocean bands below are unchanged; depth→colour IS a real relationship.
 */
export function elevToColor(elev) {
    let r, g, b;

    if (elev < -6000) {
        r = 0.01; g = 0.04; b = 0.15;
    } else if (elev < -2000) {
        const t = (elev + 6000) / 4000;
        r = 0.01 + t * 0.03; g = 0.04 + t * 0.10; b = 0.15 + t * 0.20;
    } else if (elev < -200) {
        const t = (elev + 2000) / 1800;
        r = 0.04 + t * 0.04; g = 0.14 + t * 0.16; b = 0.35 + t * 0.20;
    } else if (elev < 0) {
        const t = (elev + 200) / 200;
        r = 0.08 + t * 0.04; g = 0.30 + t * 0.10; b = 0.55 + t * 0.10;
    } else if (elev < 150) {
        // Coastal lowland — green, faintly blue-shadowed. Slightly cooler than
        // the old band so a shoreline doesn't jump warm the instant it leaves
        // the water.
        const t = elev / 150;
        r = 0.15 + t * 0.04; g = 0.27 + t * 0.06; b = 0.14 + t * 0.01;
    } else if (elev < 600) {
        // Rolling / lowland vegetated. Green stays DOMINANT (g > r) — the old
        // ramp inverted that at 300 m, which is where the gold cast began.
        const t = (elev - 150) / 450;
        r = 0.19 + t * 0.05; g = 0.33 + t * 0.02; b = 0.15 - t * 0.01;
    } else if (elev < 1500) {
        // Montane forest → olive. Warming slightly, but green still leads.
        // g falls by 0.025, not 0.03: at 0.03 the band's luminance drifts very
        // slightly DOWNWARD as elevation rises (dL/dt = -0.0008), because the
        // green loss outweighs the red gain under Rec.601 weights. Invisible on
        // its own, but a ramp whose brightness moves backwards against height
        // fights the shading and is a trap for whoever tunes this next.
        const t = (elev - 600) / 900;
        r = 0.24 + t * 0.06; g = 0.35 - t * 0.025; b = 0.14 - t * 0.01;
    } else if (elev < 2600) {
        // Treeline crossing: olive → bare rock. Rock is a WARM NEUTRAL
        // (~0.42/0.39/0.35), not an orange — the blue channel has to come UP
        // here, which is exactly what the old ramp did in reverse.
        // g starts at 0.325 to meet the montane band exactly (it ends at
        // 0.35 − 0.025). Starting it at 0.32 leaves a −0.005 step that is far
        // too small to see but does make luminance non-monotonic at 1500 m.
        const t = (elev - 1500) / 1100;
        r = 0.30 + t * 0.12; g = 0.325 + t * 0.065; b = 0.13 + t * 0.22;
    } else if (elev < 3800) {
        // High rock → snow-streaked alpine. Converging on neutral as it
        // brightens, so peaks read as light rock, never as hot highlights
        // against the bloom threshold.
        // Lands EXACTLY on the snow value at 3800 m (0.86/0.90/0.96). Ending it
        // short — as an earlier draft of this did at 0.72/0.73/0.75 — puts a
        // visible contour line around every peak at the band boundary, which is
        // the same class of artefact as an LOD seam and just as easy to miss in
        // a screenshot. Every boundary in this ramp is C0-continuous; keep it
        // that way when adjusting any band.
        const t = (elev - 2600) / 1200;
        r = 0.42 + t * 0.44; g = 0.39 + t * 0.51; b = 0.35 + t * 0.61;
    } else {
        // Permanent snow / ice — faintly blue, as snow in daylight is.
        r = 0.86; g = 0.90; b = 0.96;
    }

    return {
        r: Math.min(1, Math.max(0, r)),
        g: Math.min(1, Math.max(0, g)),
        b: Math.min(1, Math.max(0, b)),
    };
}

/**
 * Generate the point cloud for a single tile.
 * @param {object} cfg      the LOD level config: { zoom, ptsBudget, imgSize, ptSize }
 * @param {number} tx,ty    tile coords at cfg.zoom
 * @param {object} qmData   decoded quantized-mesh: vertices/indices/min+maxHeight
 * @param {object|null} imgData  RGBA pixels for the tile's imagery, or null
 * @returns {{positions: Float32Array, colors: Float32Array, count: number}}
 */
// landMask (2026-07-24): an N×N Uint8 grid over the tile's BASE bounds, 1 = land,
// 0 = ocean, sampled from the authoritative global DEM on the main thread (see
// tileStreamManager.buildTileLandMask). Optional — omit it and behaviour is
// exactly as before.
//
// WHY THIS EXISTS. The two ocean trims below (per-triangle and per-sample) both
// judge using the TILE'S OWN quantized-mesh heights. That works whenever Cesium
// reports honest elevations, and fails completely when it doesn't: the _flatQM
// decoder-overrun fallback sets all four vertices to the same minHeight, and if
// that value is bogus-positive the tile believes it is land everywhere and trims
// nothing. The visible result is a full square of land-coloured points hanging
// out over open water around islands and coasts — reported live 2026-07-24, with
// the giveaway being flat green/orange elevToColor LAND bands sitting on sea.
//
// The DEM does not have that failure mode; it is the same source _isPureOceanTile
// already trusts for the whole-tile decision. This applies it per sample, so the
// tile is carved to the real coastline regardless of what its header claims.
export function buildTilePoints(cfg, tx, ty, qmData, imgData = null, landMask = null,
                                imgRect = null) {
        const b  = geoTileBounds(tx, ty, cfg.zoom);
        let x0 = lonToSceneX(b.west),  x1 = lonToSceneX(b.east);
        let z0 = latToSceneZ(b.north), z1 = latToSceneZ(b.south);
        // Base bounds, kept before the seam-overlap widening below — the land
        // mask is indexed against these, not the widened ones.
        const bx0 = x0, bx1 = x1, bz0 = z0, bz1 = z1;
        const maskN = landMask ? Math.round(Math.sqrt(landMask.length)) : 0;
        // Edge overlap (2026-07-18): point tiles have no skirts, so their dots stop
        // exactly at the tile boundary and adjacent tiles leave a thin dark seam
        // between them (very visible against a dark/night backdrop). Expand each
        // tile's point footprint a few % past its bounds so neighbours overlap and
        // cover the crack. Vertices are placed via tileU/tileV across [x0,x1]/[z0,z1],
        // so widening those spans spreads the points outward.
        //
        // Relief-scaled overlap (2026-07-21): a flat 0.8% margin covers flat/rolling
        // ground fine, but Jamal reported real black gaps "when the land elevates" —
        // steep tiles (mountains, cliffs, canyon walls) have far more VERTICAL
        // separation between two horizontally-close edge points than flat terrain
        // does, so the same horizontal overlap that hides a flat seam isn't enough
        // to visually bridge a steep one; the gap opens along the elevation change,
        // not along an XZ boundary. qmData.minHeight/maxHeight (already decoded,
        // free) is a direct measure of this tile's local relief — scale the margin
        // up for tiles with real vertical range instead of a one-size-fits-all 0.8%.
        {
            const relief = Math.max(0, qmData.maxHeight - qmData.minHeight);
            // 0.8% base, ramping toward 4% by ~4000m of relief (steep alpine terrain).
            const reliefBoost = Math.min(0.032, relief / 125000);
            const overlapFrac = 0.008 + reliefBoost;
            const _ovx = (x1 - x0) * overlapFrac, _ovz = (z1 - z0) * overlapFrac;
            x0 -= _ovx; x1 += _ovx; z0 -= _ovz; z1 += _ovz;
        }
        // Colour set by zoom (2026-07-18): only the close-up deep levels get the
        // vivid boost; coarse world-view tiles keep the original calibrated palette.
        const _deep      = cfg.zoom >= 6;   // 8→6 (2026-07-18): bring the bright, photographic "close-up" palette (more real imagery, more colour) in at a HIGHER altitude — z6/z7 now match the z8/z9 look, so the good render appears sooner as you descend. z3-z5 (world view) stay on the calmer far palette to avoid the desert gold-cast.
        const photoBlend = imgData ? (_deep ? TILESTREAM.PHOTO_BLEND : (TILESTREAM.PHOTO_BLEND_FAR ?? 0.80)) : 0;

        // Where this tile sits inside `imgData`. Identity = the image IS this
        // tile's own imagery. A sub-rect means we are borrowing an ancestor's.
        // `size` must come from the rect when borrowing: the ancestor was fetched
        // at ITS level's imgSize, which need not match this level's.
        const _rectU0    = imgRect ? imgRect.u0    : 0;
        const _rectV0    = imgRect ? imgRect.v0    : 0;
        const _rectScale = imgRect ? imgRect.scale : 1;
        const _imgN      = (imgRect && imgRect.size) || cfg.imgSize || 256;

        const { vertexCount, uBuf, vBuf, hBuf, minHeight, maxHeight, indices } = qmData;

        // Decode all vertices once: scene XZ + elevation in metres
        const vsx = new Float32Array(vertexCount);
        const vsz = new Float32Array(vertexCount);
        const vel = new Float32Array(vertexCount);
        for (let i = 0; i < vertexCount; i++) {
            const tileU = uBuf[i] / 32767;
            const tileV = vBuf[i] / 32767;
            vsx[i] = x0 + tileU * (x1 - x0);
            vsz[i] = z1 + tileV * (z0 - z1);
            vel[i] = minHeight + (hBuf[i] / 32767) * (maxHeight - minHeight);
        }

        // Area-weighted point budget per triangle, so density is even no matter
        // how coarse or fine Cesium's adaptive mesh is (flat tiles = few big
        // triangles; mountains = many small ones).
        //
        // Open-ocean exclusion (2026-07-20, "tile extends to the ocean and I can
        // still see the ocean through the tiles"): this loop used to give EVERY
        // triangle its area-weighted share of the budget, land or sea alike —
        // ocean triangles just clamp to elevY=0 (see the sampling loop below).
        // That's fine for tight coastal tiles, but coarse tiles (z3-z6) can span
        // huge stretches of open water alongside a sliver of coast, and every
        // point spent on that water is wasted: it's sparse (a few thousand points
        // over a whole tile), sits right at y=0 near the real water plane
        // (y=-0.2), and never fuses into a surface — so instead of solid ocean
        // you get a faint scatter of dots hovering just above the real, correctly
        // rendered water, letting it show through between them. Worse, the LAND
        // sub-tile of tile mesh sits directly above/beside these dots, reading as
        // a distinct patch "floating" over a moat of visible water where the
        // ocean-clamped points should've been. Fix: triangles that are open ocean
        // at every vertex (well below sea level, past any real coastal margin)
        // get NO budget at all — skip them in the area sum so their share goes to
        // land/coastal triangles instead, and skip them in the sampling loop below
        // too. The base splat cloud + water plane already render the ocean
        // correctly; the tile layer has no business drawing sparse ghost dots
        // over it. The margin keeps genuine shoreline triangles (which straddle
        // the coastline within a tile) still eligible, same spirit as the
        // terrainWorker.js coastal-fill band.
        //
        // −20 → −5 m (2026-07-25). This margin exists to absorb QM height noise
        // at the waterline, and ±5 m covers that. At −20 m it was also absorbing
        // entire continental shelves: the Sunda Shelf, the North Sea and the
        // Gulf are shallower than 20 m over huge areas, so the trim declared
        // them land and the tile drew a full budget of land-coloured points
        // across open water. That is what the blue-green rectangles over the sea
        // in the 2026-07-25 screenshots were. The authoritative fix is the DEM
        // land mask below (now thresholded at sea level, TILESTREAM.LAND_MARGIN_M);
        // this constant is only the QM-side epsilon and should stay small.
        const OCEAN_MARGIN_M = TILESTREAM.SHORELINE_EPSILON_M ?? -5;
        const triCount = indices.length / 3;
        const areas = new Float32Array(triCount);
        let totalArea = 0;
        for (let t = 0; t < triCount; t++) {
            const a = indices[t * 3], b2 = indices[t * 3 + 1], c = indices[t * 3 + 2];
            const isOpenOcean = vel[a] < OCEAN_MARGIN_M && vel[b2] < OCEAN_MARGIN_M && vel[c] < OCEAN_MARGIN_M;
            if (isOpenOcean) { areas[t] = 0; continue; }
            const area = Math.abs(
                (vsx[b2] - vsx[a]) * (vsz[c] - vsz[a]) -
                (vsx[c] - vsx[a]) * (vsz[b2] - vsz[a])
            ) * 0.5;
            areas[t] = area;
            totalArea += area;
        }

        const budget    = cfg.ptsBudget || TILESTREAM.POINTS_PER_TILE;
        const positions = new Float32Array(budget * 3);
        // Uint8, NORMALIZED on the GPU (2026-07-25). Same trick the base splat
        // cloud already uses — terrainBuilder's note records it saving ~233MB and
        // being "what lets the renderer hold 2x supersampling instead of losing it
        // to GC pauses". At 12.6M tile points, Float32 colour was ~151MB; this is
        // ~38MB. The consumer MUST pass `true` as BufferAttribute's normalized
        // flag or every colour arrives divided by 255 (i.e. black).
        //
        // Side effect, deliberate: colour is clamped to 1.0. Measured values reached
        // 1.15 via the procedural tint, and anything over 0.95 trips the bloom
        // threshold, so this also stops bright terrain glowing. Flagged rather than
        // hidden — it is a small visual change, not a pure memory win.
        const colors    = new Uint8Array(budget * 3);
        let n = 0;

        // Deterministic LCG seeded by tile coords — same tile always samples the
        // same points (no shimmer on evict + reload).
        let seed = ((tx * 73856093) ^ (ty * 19349663) ^ (cfg.zoom * 83492791)) >>> 0;
        const rand = () => {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            return seed / 4294967296;
        };

        // Procedural detail params — finer + smaller-amplitude at deeper zoom, so
        // it reads as genuine sub-DEM roughness rather than uniform bumpiness.
        const _sat       = _deep ? (TILESTREAM.POINT_SATURATION ?? 1.0)
                                 : (TILESTREAM.POINT_SATURATION_FAR ?? 1.0);   // vivid close-up, natural far (2026-07-18)
        // Colour-shaping terms for the saturation stage (2026-07-25). Both
        // global — the cast they correct is a property of the imagery's
        // illuminant, which does not change with zoom level. Set either to 0 to
        // A/B against the old flat-multiplier behaviour.
        const _warmTrim    = TILESTREAM.POINT_WARM_TRIM     ?? 0;
        const _shadowDesat = TILESTREAM.POINT_SHADOW_DESAT  ?? 0;
        const _shadowL     = TILESTREAM.POINT_SHADOW_L      ?? 0.20;
        const PROC       = TILESTREAM.PROCEDURAL || {};
        const _procOn    = PROC.ENABLED !== false;
        const _zf        = 2 ** Math.max(0, cfg.zoom - 7);      // 1 at z7 … 32 at z12
        const _procFreq  = (PROC.FREQ   ?? 12)    * _zf;
        const _procRelief= (PROC.RELIEF ?? 0.004) / Math.sqrt(_zf);
        const _procColor = (PROC.COLOR  ?? 0.14);

        // Fully-oceanic tile (every triangle excluded above) — totalArea is 0,
        // which would otherwise divide-to-NaN below. Nothing to draw: the water
        // plane and base cloud already cover it correctly, so just emit an empty
        // points geometry instead of a NaN-positioned one.
        for (let t = 0; totalArea > 0 && t < triCount && n < budget; t++) {
            const ia = indices[t * 3], ib = indices[t * 3 + 1], ic = indices[t * 3 + 2];
            let count = Math.round(budget * (areas[t] / totalArea));
            if (count === 0 && rand() < budget * (areas[t] / totalArea)) count = 1;
            for (let k = 0; k < count && n < budget; k++) {
                // Uniform barycentric sample (sqrt trick)
                const su = Math.sqrt(rand());
                const bv = su * (1 - rand());
                const bw = su - bv;                 // su*(r2) — bv+bw = su
                const ba = 1 - su;
                const sx = ba * vsx[ia] + bv * vsx[ib] + bw * vsx[ic];
                const sz = ba * vsz[ia] + bv * vsz[ib] + bw * vsz[ic];
                const el = ba * vel[ia] + bv * vel[ib] + bw * vel[ic];

                // Per-SAMPLE ocean trim (2026-07-21, "trim the tiles that hang
                // off into the ocean"): the triangle-level exclusion above only
                // drops triangles that are ocean at ALL THREE vertices — a
                // triangle with just one shore vertex and two far-out sea-floor
                // vertices (common at z6/z7's coarse Cesium triangulation near a
                // steep coast, where one huge triangle can span from the shore
                // out across a wide flat seabed) still gets its full area-
                // weighted budget, and every sample in it still got a point
                // before this fix, regardless of how deep that specific sample's
                // interpolated elevation was. Clamped to y=0 + dark elevToColor
                // blue, those samples rendered as a solid-looking shelf of
                // points hovering at sea level out over real, deeper water —
                // reported live as tiles "hanging off into the ocean." Reusing
                // the same OCEAN_MARGIN_M (-20m) here at the per-sample level:
                // skip (don't emit) any individual sample whose interpolated
                // elevation is past the margin, even inside an otherwise-
                // eligible straddling triangle. Shoreline samples (the shallow
                // side of that same triangle) still come through fine.
                if (el < OCEAN_MARGIN_M) continue;

                // ── DEM land mask (authoritative) ─────────────────────────────
                // Runs after the QM-height trim, not instead of it: the QM check
                // is finer-grained where the heights are trustworthy, and this
                // catches the case where they are not. uv is clamped because the
                // mask covers the tile's BASE bounds while sampling happens over
                // bounds widened by the seam-overlap margin — the few points in
                // that fringe reuse the nearest edge cell, which is correct to
                // within a fraction of a mask cell.
                if (landMask) {
                    const mu = Math.min(maskN - 1, Math.max(0,
                        Math.floor(((sx - bx0) / (bx1 - bx0)) * maskN)));
                    const mv = Math.min(maskN - 1, Math.max(0,
                        Math.floor(((sz - bz0) / (bz1 - bz0)) * maskN)));
                    if (landMask[mv * maskN + mu] === 0) continue;
                }

                // Same elevation treatment as the mesh path: ocean clamps to sea
                // level, shoreline tapers, land scales. Shared with main.js's
                // collision clamp via elevToSceneY — do not inline it again.
                let elevY = elevToSceneY(el);

                // ── Procedural sub-DEM micro-relief (synthesized, land only) ──────
                if (_procOn && el > 0) {
                    elevY += (_pFbm(sx * _procFreq, sz * _procFreq) - 0.5) * _procRelief;
                }

                positions[n * 3]     = sx;
                positions[n * 3 + 1] = elevY + curveOffset(sx, sz);
                positions[n * 3 + 2] = sz;

                let { r, g, b: cb } = elevToColor(el);
                if (photoBlend > 0) {
                    // Sample the satellite photo at this point's exact spot.
                    // Image row 0 = north; tile V axis runs south→north.
                    // 2×2 BOX AVERAGE (2026-07-13): single-pixel sampling made
                    // adjacent points carry uncorrelated colors — the mid-zoom
                    // "grainy and undefined" look. Averaging 4 texels smooths
                    // sample variance without blurring real structures.
                    // imgRect (2026-07-25) lets this tile paint itself from an
                    // ANCESTOR's already-fetched imagery instead of its own. `u0/v0/
                    // scale` locate this tile inside that larger image; the identity
                    // rect {0,0,1} is the normal own-imagery case. Expressing it in
                    // the SAME normalized space the sampler already uses means this
                    // is convention-independent — no need to reason about whether
                    // image row 0 is north here, because both sides use one mapping.
                    const IS  = _imgN;
                    const fu  = (sx - x0) / (x1 - x0);
                    const fv  = (sz - z0) / (z1 - z0);
                    const au  = _rectU0 + fu * _rectScale;
                    const av  = _rectV0 + fv * _rectScale;
                    const tu = Math.min(IS - 2, Math.max(0, Math.round(au * (IS - 1))));
                    const tv = Math.min(IS - 2, Math.max(0, Math.round(av * (IS - 1))));
                    const i00 = (tv * IS + tu) * 4, i01 = i00 + 4;
                    const i10 = ((tv + 1) * IS + tu) * 4, i11 = i10 + 4;
                    const pr = (imgData[i00] + imgData[i01] + imgData[i10] + imgData[i11]) / 1020;
                    const pg = (imgData[i00+1] + imgData[i01+1] + imgData[i10+1] + imgData[i11+1]) / 1020;
                    const pb = (imgData[i00+2] + imgData[i01+2] + imgData[i10+2] + imgData[i11+2]) / 1020;
                    r  = r  * (1 - photoBlend) + pr * photoBlend;
                    g  = g  * (1 - photoBlend) + pg * photoBlend;
                    cb = cb * (1 - photoBlend) + pb * photoBlend;
                }
                // ── Procedural surface-texture colour variation (land only) ───────
                if (_procOn && el > 0) {
                    const _pt = 1 + (_pFbm(sx * _procFreq * 3.1 + 17.0, sz * _procFreq * 3.1 + 9.0) - 0.5) * _procColor;
                    r *= _pt; g *= _pt; cb *= _pt;
                }
                // ── Vividness (2026-07-18) ────────────────────────────────────────
                // Tile points are unlit, so this is the ONLY colour control they
                // have — the satellite palette is naturally muted (hazy, low-contrast
                // orbital imagery), which reads muddy at close zoom, especially over
                // arid terrain and on the night side. Push each point away from its
                // own luminance so the imagery comes in strong and true-coloured,
                // consistently for every tile on the planet.
                //
                // ⚠ THE CLAMP DOES NOT DO WHAT THIS COMMENT USED TO CLAIM (noted
                // 2026-07-25). It said the clamp "keeps the boost from punching
                // bright pixels over the bloom threshold" — but it clamps to 1.15,
                // and bloomPass.threshold is 0.95 (see CLAUDE.md), so everything
                // from 0.95 to 1.15 blooms freely. Measured: saturated imagery
                // reaches 1.150 on all three channels. It also only runs when
                // _sat !== 1, so at neutral saturation there is no clamp at all.
                //
                // Deliberately NOT changed here. Clamping to 1.0 would dim the
                // brightest points by up to 13% across every tile on the planet,
                // and that is a look decision on a hand-tuned value, not a bug fix
                // to make in passing. Flagged so the next person reads the code
                // rather than the old comment.
                if (_sat !== 1 || _warmTrim > 0 || _shadowDesat > 0) {
                    const L = 0.299 * r + 0.587 * g + 0.114 * cb;

                    // ── Per-point saturation, HUE- AND LUMINANCE-AWARE ────────
                    // (2026-07-25) A flat chroma multiplier is the wrong shape
                    // for satellite imagery and produced BOTH artefacts Jamal
                    // reported in one go. Orbital imagery of terrain is split by
                    // its illuminant: sunlit ground carries the warm direct-sun
                    // cast, shadowed ground is lit almost entirely by blue
                    // skylight. Scaling chroma uniformly amplifies that split
                    // instead of the actual surface colour, so at _sat 1.40 —
                    //   • neutral tan rock (0.55/0.47/0.38) → hot neon ochre,
                    //     and because the clamp is 1.15, not 1.0, it also blooms
                    //   • blue-filled shadow (0.10/0.13/0.18) → vivid teal
                    // which is precisely the gold-slopes / teal-hollows look.
                    //
                    // This is the SAME MISTAKE, at the SAME VALUE, that has been
                    // fixed twice already elsewhere in this codebase and never
                    // propagated here (see memory/decisions.md):
                    //   2026-06-20 — IBTrACS categoryColor()'s 1.4× boost SHIFTED
                    //                hues (Cat-2 orange → yellow); boost removed.
                    //   2026-07-13 — SPLAT_SATURATION 2.10 → 1.30 because the
                    //                boost "crushed the satellite data's real
                    //                color variation into uniform lime."
                    // The base splat cloud has sat 1.30 and the tiles had 1.40,
                    // so the two surfaces also disagreed across the LOD handoff.
                    //
                    // Two shaping terms, both defaultable to 0 for a clean A/B
                    // against the old behaviour:
                    let sat = _sat;

                    // (1) WARM TRIM. Pull the multiplier back on points that
                    // lean orange/yellow (red leads, blue trails) in proportion
                    // to how warm they are. Greens and blues keep the full
                    // boost, so vegetation and water still gain vividness while
                    // rock and sand stay the colour they actually are. Measured
                    // against chroma, not absolute channel values, so it tracks
                    // hue rather than exposure.
                    if (_warmTrim > 0) {
                        const mx = r > g ? (r > cb ? r : cb) : (g > cb ? g : cb);
                        const mn = r < g ? (r < cb ? r : cb) : (g < cb ? g : cb);
                        const chroma = mx - mn;
                        if (chroma > 1e-4 && r >= g && g >= cb) {
                            // 0 at neutral, 1 at fully warm-dominant.
                            const warmth = (r - cb) / chroma;
                            sat -= (sat - 1) * _warmTrim * warmth;
                        }
                    }

                    // (2) SHADOW DESATURATION. Below SHADOW_L the imagery's
                    // colour is skylight, not surface albedo, so boosting it is
                    // boosting an artefact. Fade the chroma multiplier toward
                    // (and slightly past) neutral as luminance falls — dark
                    // slopes go grey-blue like real shadow instead of teal.
                    if (_shadowDesat > 0 && L < _shadowL) {
                        const dark = 1 - (L / _shadowL);          // 0 at the knee → 1 at black
                        sat *= 1 - _shadowDesat * dark;
                    }

                    r  = L + (r  - L) * sat;
                    g  = L + (g  - L) * sat;
                    cb = L + (cb - L) * sat;

                    // Clamp to 1.0, not 1.15. The old ceiling sat ABOVE
                    // bloomPass.threshold (0.95, see CLAUDE.md), so saturated
                    // imagery measured 1.150 on all three channels and bloomed
                    // freely — the previous author flagged this in a comment and
                    // deliberately left it, because dropping to 1.0 would have
                    // dimmed the brightest points by 13% while the gold cast was
                    // still there and would have looked like a regression. With
                    // the cast gone that tradeoff reverses: 1.0 is the honest
                    // ceiling for an unlit vertex colour, and terrain should not
                    // be feeding the bloom pass at all.
                    if (r  < 0) r  = 0; else if (r  > 1) r  = 1;
                    if (g  < 0) g  = 0; else if (g  > 1) g  = 1;
                    if (cb < 0) cb = 0; else if (cb > 1) cb = 1;
                }
                // Explicit clamp before the cast: Uint8Array WRAPS on overflow, so
                // an unclamped 1.15 would store as 38/255 — a bright desert point
                // rendering near-black. Uint8ClampedArray would handle it, but the
                // transferable path and the base cloud both use plain Uint8.
                colors[n * 3]     = r  < 0 ? 0 : r  > 1 ? 255 : (r  * 255 + 0.5) | 0;
                colors[n * 3 + 1] = g  < 0 ? 0 : g  > 1 ? 255 : (g  * 255 + 0.5) | 0;
                colors[n * 3 + 2] = cb < 0 ? 0 : cb > 1 ? 255 : (cb * 255 + 0.5) | 0;
                n++;
            }
        }

    return { positions, colors, count: n };
}
