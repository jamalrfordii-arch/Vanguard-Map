/**
 * tests/oceanDespike.test.mjs
 *   node --import ./tests/_stubs/register.mjs tests/oceanDespike.test.mjs
 *
 * The median de-spike replaced a 6-iteration Gaussian whose FWHM (~319 km) was
 * about 11× wider than a continental shelf break (10–50 km). The whole point of
 * the swap is that a median does TWO things a Gaussian cannot do together:
 *
 *   1. remove an isolated sampling spike COMPLETELY
 *   2. preserve a step edge EXACTLY
 *
 * Both are asserted below, and the Gaussian is run alongside on identical data
 * to show it fails the second one — so this file documents the reason for the
 * change, not just the change.
 */

import { medianDespikeOcean } from '../terrainBuilder.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => c ? (pass++, console.log(`  ✓ ${n}`))
                               : (fail++, console.error(`  ✗ ${n} ${x}`));

const N = 9;                                  // 9×9 grid
const idx = (r, c) => r * N + c;
const allOcean = () => new Float32Array(N * N).fill(-1);   // every vertex is ocean

// Reference implementation of the OLD filter, for comparison only.
function gaussian6(rawY, elevations, verts, passes = 6) {
    const tmp = new Float32Array(rawY);
    for (let p = 0; p < passes; p++) {
        for (let r = 1; r < verts - 1; r++) {
            for (let c = 1; c < verts - 1; c++) {
                const i = r * verts + c;
                if (elevations[i] >= 0) continue;
                const tl = rawY[i-verts-1], tc = rawY[i-verts], tr = rawY[i-verts+1];
                const ml = rawY[i-1],       mc = rawY[i],       mr = rawY[i+1];
                const bl = rawY[i+verts-1], bc = rawY[i+verts], br = rawY[i+verts+1];
                tmp[i] = (tl+tr+bl+br + (tc+ml+mr+bc)*2 + mc*4) / 16;
            }
        }
        rawY.set(tmp);
    }
    return rawY;
}

console.log('\noceanDespike — removes an isolated sampling spike');
{
    const y = new Float32Array(N * N).fill(-2.0);
    y[idx(4, 4)] = -40.0;                       // one vertex lands in a trench pixel
    medianDespikeOcean(y, allOcean(), N, 1);
    ok('spike replaced by its neighbourhood', Math.abs(y[idx(4,4)] - (-2.0)) < 1e-6,
        `got ${y[idx(4,4)]}`);
    ok('neighbours untouched', Math.abs(y[idx(4,3)] - (-2.0)) < 1e-6);
}

console.log('\noceanDespike — PRESERVES a shelf break (the whole point)');
{
    // Vertical cliff: shallow shelf on the left, abyss on the right.
    const SHELF = -0.2, ABYSS = -6.0;
    const y = new Float32Array(N * N);
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) y[idx(r,c)] = c < 4 ? SHELF : ABYSS;

    const med = medianDespikeOcean(Float32Array.from(y), allOcean(), N, 1);
    ok('shelf side exact after median',  Math.abs(med[idx(4,3)] - SHELF) < 1e-6, `got ${med[idx(4,3)]}`);
    ok('abyss side exact after median',  Math.abs(med[idx(4,4)] - ABYSS) < 1e-6, `got ${med[idx(4,4)]}`);
    const medDrop = Math.abs(med[idx(4,4)] - med[idx(4,3)]);
    ok('full cliff height retained', Math.abs(medDrop - (ABYSS - SHELF < 0 ? SHELF - ABYSS : 0)) < 1e-6,
        `drop=${medDrop.toFixed(3)} of ${(SHELF-ABYSS).toFixed(3)}`);

    // The old filter on identical data.
    const gau = gaussian6(Float32Array.from(y), allOcean(), N, 6);
    const gauDrop = Math.abs(gau[idx(4,4)] - gau[idx(4,3)]);
    ok('6× Gaussian visibly flattens the same cliff', gauDrop < medDrop * 0.6,
        `gaussian kept ${gauDrop.toFixed(3)}, median kept ${medDrop.toFixed(3)}`);
    console.log(`    → cliff height kept: median ${medDrop.toFixed(2)}, gaussian ${gauDrop.toFixed(2)}`
              + ` (${((1 - gauDrop/medDrop) * 100).toFixed(0)}% lost to blur)`);
}

console.log('\noceanDespike — never touches land');
{
    const y = new Float32Array(N * N).fill(-2.0);
    const elev = new Float32Array(N * N).fill(-1);
    elev[idx(4,4)] = 250;                 // land vertex
    y[idx(4,4)] = 99.0;                   // an absurd value that must survive
    medianDespikeOcean(y, elev, N, 1);
    ok('land vertex left exactly as-is', y[idx(4,4)] === 99.0, `got ${y[idx(4,4)]}`);
}

console.log('\noceanDespike — borders and degenerate input');
{
    const y = new Float32Array(N * N).fill(-3.0);
    y[idx(0,0)] = -50.0;                  // corner: outside the 1..N-2 window
    medianDespikeOcean(y, allOcean(), N, 1);
    ok('border vertices are skipped, not corrupted', y[idx(0,0)] === -50.0);

    const y2 = Float32Array.from([-1,-2,-3,-4]);
    const before = Array.from(y2);
    medianDespikeOcean(y2, new Float32Array(4).fill(-1), 2, 0);   // passes = 0
    ok('passes=0 is a no-op', Array.from(y2).every((v,i)=>v===before[i]));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
