// terrainHeight.js — the ONE place elevation becomes scene Y.
//
// THE BUG THIS EXISTS TO FIX (diagnosed 2026-07-25):
// The map draws land twice, from two transforms that disagreed by ~3x.
//
//   base splat cloud (terrainWorker.js)   h / 650, tapering to /1100 above 2000m
//   streamed tiles   (tilePointsBuilder)  h / 2000
//
// Both then multiply by TERRAIN_VERTICAL_SCALE and add the same curveOffset, so
// the discrepancy is purely the divisor. On 1000m terrain the base cloud's surface
// sits 0.208 scene units ABOVE the tile surface.
//
// That matters because the base cloud NEVER fades under the all-points LOD ladder
// (see solidCoverage — it only fades the base for MESH levels, and there are none).
// It is meant to be a BACKSTOP behind the tiles. Sitting 3x too high, it is not
// behind them — it is in front, and its points poke through the photographic tile
// surface and win the depth test.
//
// This is almost certainly the "random splat dots floating around" reported live on
// 2026-07-21 from a close oblique view over ground that was solidly tiled. That was
// diagnosed as a FADE problem and patched with TILT_FADE_FLOOR, which made the dots
// fainter. They are not floating because they are too opaque. They are floating
// because they are computed at the wrong height.
//
// ── MODES ────────────────────────────────────────────────────────────────────
// Reconciling moves one of two hand-tuned views, so it is a look decision, not a
// correctness one. All three modes are honest; pick by flying them.
//
//   FLAT    both 'flat'   ← ACTIVE DEFAULT (chosen 2026-07-25, see DEFAULT_MODE)
//                           base DROPS to meet the tiles. Close-up untouched;
//                           world view flattens ~3x, partly undoing the 07-15
//                           relief bump. The more physically honest of the two.
//   TALL    both 'tall'   — tiles RISE to meet the base instead. World view
//                           untouched; close-up gains ~3x relief.
//   LEGACY  base='tall', tiles='flat'
//                         — the historical split, kept as an escape hatch. This is
//                           the ONLY mode where the two surfaces disagree, i.e. the
//                           only one with the floating-dots defect. Nothing should
//                           land here by accident, which is why it is not the
//                           fallback for an unrecognised value.
//
// Switch live:  window.vg1TerrainMode('tall' | 'flat' | 'legacy')
//
// Pure: no THREE, no DOM. Imported by tilePointsBuilder (main thread) AND
// terrainWorker (worker) so the two CANNOT drift apart again — that was the whole
// failure, and a shared constant is the only structural fix for it.

export const TERRAIN_MODE = {
    LEGACY: 'legacy',
    TALL:   'tall',
    FLAT:   'flat',
};

/** Which formula each consumer uses, per mode. */
export function formulaFor(consumer, mode = TERRAIN_MODE.LEGACY) {
    if (mode === TERRAIN_MODE.TALL) return 'tall';
    if (mode === TERRAIN_MODE.FLAT) return 'flat';
    // LEGACY reproduces the historical split exactly.
    return consumer === 'base' ? 'tall' : 'flat';
}

/** Shoreline taper distance (m). Squares the ramp so the coast eases out of the
 *  sea plane rather than stepping off it. Applied in BOTH formulas — it is a
 *  shoreline-quality feature, not part of the exaggeration disagreement. */
const SHORE_TAPER_M = 15;

/**
 * Elevation (metres) → scene Y, BEFORE curveOffset and before vertical scale.
 * Ocean (h <= 0) is always flat 0: the sea plane owns that band.
 *
 * @param {number} hM       elevation in metres
 * @param {'tall'|'flat'} formula  from formulaFor()
 */
export function landElevToUnits(hM, formula) {
    if (!(hM > 0)) return 0;
    let y;
    if (formula === 'tall') {
        // The base cloud's historical curve: 650 at low elevation easing to 1100
        // at peaks >= 4000m, so high mountains don't run away vertically.
        const highBlend = Math.min(1, Math.max(0, (hM - 2000) / 2000));
        y = hM / (650 + highBlend * 450);
    } else {
        y = hM / 2000;
    }
    if (hM < SHORE_TAPER_M) y *= hM / SHORE_TAPER_M;
    return y;
}

/**
 * Full elevation → scene Y for a consumer, including vertical scale.
 * Callers still add curveOffset themselves (it depends on scene XZ, not height).
 */
export function elevToSceneY(hM, vscale, consumer, mode) {
    return landElevToUnits(hM, formulaFor(consumer, mode)) * vscale;
}

// ── DECIDED 2026-07-25: FLAT ─────────────────────────────────────────────────
// Jamal's call after flying all three. The deciding argument was that this was
// never "realistic vs stylised" — BOTH formulas are heavy vertical exaggeration,
// and the only question was how much. Taking Everest, where 1 scene unit = 133.58 km:
//
//     true to life          0.066 units
//     tiles   (/2000)       0.885 units   → 13x exaggerated
//     base    (/650-1100)   1.609 units   → 24x exaggerated
//
// So FLAT adopts the more physically honest of the two, and it is also the one the
// close-up photographic terrain already uses — which matters because satellite
// imagery is flat and true, and hanging 24x geometry under it makes mountains read
// as spires. The cost, accepted knowingly: the world view softens, partly undoing
// the 2026-07-15 bump that raised TERRAIN_VSCALE_LAND to restore land relief.
//
// LEGACY is retained as an escape hatch, not as a fallback — it is the only mode
// where the two surfaces disagree, so nothing should land there by accident.
export const DEFAULT_MODE = TERRAIN_MODE.FLAT;

/**
 * Resolve the active mode from a persisted override.
 * All three modes are honoured when named explicitly — including LEGACY, which
 * must stay reachable. Anything unrecognised falls back to DEFAULT_MODE.
 */
export function resolveMode(stored) {
    return Object.values(TERRAIN_MODE).includes(stored) ? stored : DEFAULT_MODE;
}
