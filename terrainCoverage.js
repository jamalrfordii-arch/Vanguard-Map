// terrainCoverage.js — where Cesium World Terrain actually HAS detailed data.
//
// MEASURED 2026-07-25, directly against the Cesium Ion origin with the app's own
// bearer token and `cache: 'reload'` to bypass the service worker:
//
//   latitude sweep at 75°E, z11, 0.5° steps
//     56.0N .. 60.0N   →  4/4 HTTP 200
//     60.5N .. 64.0N   →  0/4 HTTP 200, all 404
//
//   by zoom at 65°N            by zoom at 55°N
//     z3..z8   → 200             z3..z12  → 200
//     z9..z12  → 404
//
// So the rule is exact and has nothing to do with "deep zoom coverage thinning
// out", which is what the 2026-07-18 note assumed when it disabled z10-z12:
//
//     LEVELS z9 AND FINER HAVE NO DATA ABOVE 60°N. AT ALL. ANYWHERE.
//
// That is the SRTM northern limit. Cesium World Terrain's high-resolution tiles are
// SRTM-derived, and SRTM flew on the Space Shuttle at 57° inclination — it simply
// never imaged above 60°N. Coarse levels (z3-z8) come from other sources and are
// fine everywhere. The southern hemisphere was probed to 60°S and is fine, so this
// is NOT symmetric — do not add a southern limit without measuring it.
//
// WHY THIS MATTERS: it was costing ~150 doomed HTTP round trips per view over any
// high-latitude land — Scandinavia, northern Russia, Alaska, most of Canada,
// Iceland, Greenland. Each one is fetched, 404s, and gets negative-cached, so the
// map recovered visually (the base splat cloud backstops it) while silently
// spending half its tile budget on requests that can never succeed.
//
// This is NOT a bug we can fix — the data does not exist. It is a bug we can stop
// paying for.

/** Northern limit of SRTM-derived terrain, in degrees. Measured, not assumed. */
export const SRTM_NORTH_LIMIT_DEG = 60.0;
/** First zoom level that depends on SRTM. z8 and coarser are covered globally. */
export const SRTM_FIRST_LIMITED_ZOOM = 9;

/**
 * Would a request for this tile be certain to 404 for lack of source data?
 *
 * Gates on the tile's SOUTH edge, not its centre: a tile straddling 60°N still
 * returns 200 (measured — the tile containing 60.0N was served), so gating on the
 * centre or the north edge would discard real data along the boundary row.
 *
 * @param {number} zoom
 * @param {number} southLatDeg  the tile's southern edge, degrees
 * @returns {boolean} true if the fetch is provably pointless
 */
export function isBeyondTerrainCoverage(zoom, southLatDeg) {
    if (!(zoom >= SRTM_FIRST_LIMITED_ZOOM)) return false;
    if (!Number.isFinite(southLatDeg)) return false;   // unknown → attempt it
    return southLatDeg >= SRTM_NORTH_LIMIT_DEG;
}
