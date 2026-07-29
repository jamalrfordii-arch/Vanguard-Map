// tests/tileLandMaskCoverage.test.mjs — the no-regression audit for the tile cull.
// Run from repo root:  node tests/tileLandMaskCoverage.test.mjs
//
// tileLandMask.test.mjs checks a hand-picked list of hard cases. This one checks
// EVERY fixed geographic thing the map already draws — every port, airport and
// city in the repo's own data — against the mask at every streamed zoom.
//
// The reasoning: a tile cull can only cause one kind of damage, terrain that
// stops loading somewhere it used to. Anywhere the map plants a labelled object
// is somewhere a user will fly the camera down to, so those are exactly the
// tiles whose disappearance would be noticed. If the mask keeps all of them, the
// remaining culled tiles are water nobody descends to inspect.
//
// This audit reads the real data files, so adding a port or airport in a novel
// place automatically extends the test — no list to keep in sync here.

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tileLandMask } from '../tileLandMask.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSET = join(REPO, 'data', 'tile-land-mask.bin');

if (!existsSync(ASSET)) {
    console.error(`  ✗ ${ASSET} missing — run: python3 tools/build_tile_land_mask.py`);
    process.exit(1);
}
const bytes = readFileSync(ASSET);
tileLandMask.ingest(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

// z11/z12 added 2026-07-25, when those LOD levels were enabled and the mask was
// re-baked to cover them. Before that they resolved against their z10 ancestor,
// which was conservative and therefore safe; now they are baked from the finest
// sources directly, so a bad bake could genuinely cull a real port or airport at
// the deepest zoom while every coarser level still looked perfect. These are the
// levels most worth auditing, not the least.
const ZOOMS = [6, 7, 8, 9, 10, 11, 12];
const tileOf = (lat, lon, z) => ({
    tx: Math.floor((lon + 180) / (360 / 2 ** (z + 1))),
    ty: Math.floor((lat + 90) / (180 / 2 ** z)),
});

// ── scrape the repo's own coordinate tables ───────────────────────────────────
// Regex rather than import: these modules pull in THREE and a DOM at load time.
function scrapeLatLonFields(file) {
    const src = readFileSync(join(REPO, file), 'utf8');
    const out = [];
    const re = /name:\s*'([^']+)'[^}]*?lat:\s*(-?\d+\.?\d*)[^}]*?lon:\s*(-?\d+\.?\d*)/g;
    const re2 = /name:\s*'([^']+)'[^}]*?lon:\s*(-?\d+\.?\d*)[^}]*?lat:\s*(-?\d+\.?\d*)/g;
    let m;
    while ((m = re.exec(src))) out.push([m[1], +m[2], +m[3]]);
    while ((m = re2.exec(src))) out.push([m[1], +m[3], +m[2]]);
    return out;
}

function scrapeAirports() {
    const src = readFileSync(join(REPO, 'airports.js'), 'utf8');
    const out = [];
    const re = /'([A-Z]{3})':\s*\[\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*\]/g;
    let m;
    while ((m = re.exec(src))) out.push([m[1], +m[2], +m[3]]);
    return out;
}

const SETS = {
    ports:   scrapeLatLonFields('portManager.js'),
    cities:  scrapeLatLonFields('cityManager.js'),
    airports: scrapeAirports(),
};

let failures = 0;
let checked = 0;

for (const [label, rows] of Object.entries(SETS)) {
    assert.ok(rows.length > 20, `${label}: scraped only ${rows.length} rows — the data format changed`);
    const bad = [];
    for (const [name, lat, lon] of rows) {
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85) continue;
        for (const z of ZOOMS) {
            const { tx, ty } = tileOf(lat, lon, z);
            checked++;
            if (!tileLandMask.shouldFetch(z, tx, ty)) bad.push(`${name} (${lat}, ${lon}) @z${z}`);
        }
    }
    if (bad.length) {
        failures += bad.length;
        console.error(`  ✗ ${label}: ${bad.length} of ${rows.length} culled`);
        bad.slice(0, 15).forEach(b => console.error(`      ${b}`));
        if (bad.length > 15) console.error(`      … and ${bad.length - 15} more`);
    } else {
        console.log(`  ✓ ${label}: all ${rows.length} kept at z${ZOOMS.join(', z')}`);
    }
}

console.log(`\n${checked} tile lookups, ${failures} culled locations`);
if (failures) {
    console.error('A labelled location sits in a culled tile — that is missing ground, not saved bandwidth.');
    process.exitCode = 1;
}
