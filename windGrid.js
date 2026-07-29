// windGrid.js — resample a coarse lat/lon wind field onto a finer render grid.
//
// WHY (2026-07-25): gfsWindManager asked Open-Meteo for a 1° global grid —
// 360 x 181 = 65,160 points, batched 100 at a time = 651 HTTP requests on EVERY
// page load. Open-Meteo's free tier allows ~10,000/day, so ~15 loads exhausted the
// whole quota; after that every batch 429s, live data never arrives, and the
// expensive synthetic fallback runs for the entire session. That was the steady
// state, not the exception. It also buried the console badly enough to obstruct
// diagnosing unrelated things.
//
// The mismatch was using a POINT-QUERY api to pull a RASTER field. Fetching at 5°
// instead (72 x 37 = 2,664 points = 27 batches) and interpolating up is a 24x
// reduction in requests for almost no visual loss: 10m wind is smooth at synoptic
// scale, and the particle layer renders streamlines, not isobars — it could never
// show 1° detail anyway.
//
// ⚠ INTERPOLATE THE VECTOR COMPONENTS, NEVER SPEED+DIRECTION. Averaging bearings
// is wrong at the 0/360 seam: 350° and 10° average to 180° — a wind blowing due
// SOUTH where both neighbours blow due NORTH. Interpolating u and v sidesteps it
// entirely, and is also what makes calm zones between opposing flows come out as
// near-zero wind rather than a fast wind pointing somewhere invented.
//
// Pure: no DOM, no THREE, no fetch. See tests/windGrid.test.mjs.

/**
 * Bilinearly resample a source grid onto a destination grid.
 *
 * Both grids are lat/lon aligned, row 0 = lat -90, col 0 = lon -180, row-major.
 * Longitude WRAPS (col srcW-1 is adjacent to col 0); latitude CLAMPS (there is no
 * row above the north pole).
 *
 * @returns {{u: Float32Array, v: Float32Array}} destination field, dstW*dstH
 */
export function resampleWindGrid(srcU, srcV, srcW, srcH, srcResDeg,
                                 dstW, dstH, dstResDeg) {
    const u = new Float32Array(dstW * dstH);
    const v = new Float32Array(dstW * dstH);

    for (let row = 0; row < dstH; row++) {
        const lat = -90 + row * dstResDeg;
        // Position in SOURCE row space. Clamped: the pole rows have no neighbour
        // beyond them, so an out-of-range destination row samples the edge rather
        // than wrapping to the opposite pole.
        let fy = (lat + 90) / srcResDeg;
        if (fy < 0) fy = 0;
        if (fy > srcH - 1) fy = srcH - 1;
        const y0 = Math.floor(fy);
        const y1 = Math.min(y0 + 1, srcH - 1);
        const ty = fy - y0;

        for (let col = 0; col < dstW; col++) {
            const lon = -180 + col * dstResDeg;
            const fx  = (lon + 180) / srcResDeg;
            const x0  = Math.floor(fx) % srcW;
            const x1  = (x0 + 1) % srcW;          // wraps across the dateline
            const tx  = fx - Math.floor(fx);

            const i00 = y0 * srcW + x0, i01 = y0 * srcW + x1;
            const i10 = y1 * srcW + x0, i11 = y1 * srcW + x1;

            const uTop = srcU[i00] + (srcU[i01] - srcU[i00]) * tx;
            const uBot = srcU[i10] + (srcU[i11] - srcU[i10]) * tx;
            const vTop = srcV[i00] + (srcV[i01] - srcV[i00]) * tx;
            const vBot = srcV[i10] + (srcV[i11] - srcV[i10]) * tx;

            const o = row * dstW + col;
            u[o] = uTop + (uBot - uTop) * ty;
            v[o] = vTop + (vBot - vTop) * ty;
        }
    }
    return { u, v };
}

/** Cell count for a global grid at this resolution — the thing that drives the
 *  request count, so it is worth being able to assert on directly. */
export function gridCellCount(resDeg) {
    return Math.round(360 / resDeg) * (Math.round(180 / resDeg) + 1);
}
