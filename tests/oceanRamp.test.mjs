/**
 * tests/oceanRamp.test.mjs
 *   node --import ./tests/_stubs/register.mjs tests/oceanRamp.test.mjs
 *
 * The ocean depth ramp is DUPLICATED — once in terrainBuilder.createSolidOceanFloor
 * (the floor mesh) and once in terrainWorker (the splat points). Both source files
 * carry a comment saying they must match exactly, because the two surfaces meet at
 * a visible seam and a drift between them shows up as a colour discontinuity in
 * open water.
 *
 * A comment cannot enforce that. This test can: it parses the band coefficients
 * out of both files and asserts they are identical, then checks the properties
 * the ramp was rebuilt for.
 *
 * Parsing source text is unusual for a unit test and deliberate here — the
 * alternative is extracting the ramp into a shared module, which would mean the
 * worker importing from the main bundle. Until that refactor happens, this is
 * the cheapest thing that actually fails when the two drift.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => c ? (pass++, console.log(`  ✓ ${n}`))
                               : (fail++, console.error(`  ✗ ${n} ${x}`));

// ── pull the band arithmetic out of a source file ───────────────────────────
function bands(file) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    const i = src.indexOf('if (d < 200) {');
    if (i < 0) return null;
    const seg = src.slice(i, i + 2400);
    const m = [...seg.matchAll(/([rgb]) = (-?[\d.]+) ([+-]) t \* ([\d.]+)/g)];
    return m.map(x => [x[1], +x[2], x[3], +x[4]]);
}

const A = bands('terrainBuilder.js');
const B = bands('terrainWorker.js');

console.log('\noceanRamp — the two copies must not drift');
{
    ok('terrainBuilder ramp found', !!A && A.length === 12, `got ${A?.length}`);
    ok('terrainWorker ramp found',  !!B && B.length === 12, `got ${B?.length}`);
    ok('coefficients are byte-identical', JSON.stringify(A) === JSON.stringify(B));
    console.log('    → floor mesh and splat cloud meet at a seam; drift shows as a colour break');
}

// ── evaluate the ramp the way the shaders do ────────────────────────────────
// bands: [0,200] [200,2000] [2000,6000] [6000,11000]
function colourAt(d) {
    const c = A;
    const pick = (b, ch) => { const e = c[b * 3 + ch]; return [e[1], e[2] === '+' ? e[3] : -e[3]]; };
    let b, t;
    if (d < 200)       { b = 0; t = d / 200; }
    else if (d < 2000) { b = 1; t = (d - 200) / 1800; }
    else if (d < 6000) { b = 2; t = (d - 2000) / 4000; }
    else               { b = 3; t = Math.min(1, (d - 6000) / 5000); }
    return [0, 1, 2].map(ch => { const [base, k] = pick(b, ch); return base + k * t; });
}
const hsv = ([r, g, bb]) => {
    const mx = Math.max(r, g, bb), mn = Math.min(r, g, bb), dl = mx - mn;
    let h = 0;
    if (dl > 1e-9) {
        if (mx === r)       h = ((g - bb) / dl) % 6;
        else if (mx === g)  h = (bb - r) / dl + 2;
        else                h = (r - g) / dl + 4;
    }
    return { h: (h * 60 + 360) % 360, s: mx ? dl / mx : 0, v: mx };
};

const DEPTHS = [0, 200, 2000, 6000, 11000];
const S = DEPTHS.map(d => ({ d, ...hsv(colourAt(d)) }));

console.log('\noceanRamp — depth is carried by HUE, not brightness alone');
{
    const hues = S.map(x => x.h);
    const spread = Math.max(...hues) - Math.min(...hues);
    ok('hue rotates well beyond the old 15°', spread > 60, `spread=${spread.toFixed(0)}°`);
    ok('rotation runs shallow→deep (teal→violet)', S[0].h < S[S.length - 1].h,
        `${S[0].h.toFixed(0)}° → ${S[S.length-1].h.toFixed(0)}°`);
    console.log(`    → ${S.map(x=>`${x.d}m:${x.h.toFixed(0)}°`).join('  ')}`);
}

console.log('\noceanRamp — brightness headroom for relief shading');
{
    // The reason for the rebuild: hillshade modulates VALUE. At 5% there is
    // nothing left to darken, so trench walls cannot read however good the
    // geometry is.
    const deepest = S[S.length - 1].v;
    ok('hadal value stays off the floor (>12%)', deepest > 0.12, `v=${(deepest*100).toFixed(0)}%`);
    ok('more than double the old 5% floor', deepest > 0.10, `v=${(deepest*100).toFixed(0)}%`);
    const at6k = S.find(x => x.d === 6000).v;
    ok('6 km keeps usable headroom (>20%)', at6k > 0.20, `v=${(at6k*100).toFixed(0)}%`);
    console.log(`    → ${S.map(x=>`${x.d}m:${(x.v*100).toFixed(0)}%`).join('  ')}`);
}

console.log('\noceanRamp — saturation is no longer pinned at maximum');
{
    const sats = S.map(x => x.s);
    ok('shallows are desaturated (sediment/chlorophyll)', sats[0] < 0.70,
        `shelf sat=${(sats[0]*100).toFixed(0)}%`);
    ok('nothing sits at the old 93–96% band', Math.max(...sats) < 0.90,
        `max=${(Math.max(...sats)*100).toFixed(0)}%`);
    ok('saturation actually varies with depth', (Math.max(...sats) - Math.min(...sats)) > 0.15);
    console.log(`    → ${S.map(x=>`${x.d}m:${(x.s*100).toFixed(0)}%`).join('  ')}`);
}

console.log('\noceanRamp — bands stay continuous at their joins');
{
    for (const d of [200, 2000, 6000]) {
        const lo = colourAt(d - 0.001), hi = colourAt(d + 0.001);
        const gap = Math.max(...[0,1,2].map(i => Math.abs(lo[i] - hi[i])));
        ok(`no visible colour step at ${d} m`, gap < 0.01, `gap=${gap.toFixed(4)}`);
    }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
