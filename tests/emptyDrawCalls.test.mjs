// tests/emptyDrawCalls.test.mjs — nothing may be added to the scene visible-and-empty.
// Run: node --import ./tests/_stubs/register.mjs tests/emptyDrawCalls.test.mjs
//
// MEASURED 2026-07-31. A frame carried 884 draw calls. 614 of them were
// THREE.Line objects with ZERO vertices — ~70% of the frame's draw calls
// rendering nothing at all. An empty geometry still costs the full per-object
// driver overhead: bind, state change, draw, and no pixels in return.
//
// Cause: entityBuilder created a trail Line from an empty BufferGeometry and
// added it to the scene visible. Only curve-driven simulated entities ever fill
// it, so every real AIS vessel carried one forever. uiController then set
// `trail.visible = ship.visible`, tying visibility to the SHIP rather than to
// whether the trail had anything to draw.
//
// Static on purpose: the dynamic version needs a browser, a GPU and 500 vessels.
// This needs none of them and fails the moment someone adds it back.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');

console.log('empty geometries are created hidden');
test('every trail Line built from an empty BufferGeometry is hidden before scene.add', () => {
    const s = src('entityBuilder.js');
    const re = /const (\w+)\s*=\s*new THREE\.Line\(new THREE\.BufferGeometry\(\),\s*\w+\);([\s\S]{0,900}?)scene\.add\(\1\);/g;
    const offenders = [];
    for (const m of s.matchAll(re)) {
        if (!new RegExp(`${m[1]}\\.visible\\s*=\\s*false`).test(m[2])) offenders.push(m[1]);
    }
    assert.deepEqual(offenders, [],
        'added to the scene with an EMPTY geometry and no visible=false — each is a '
      + 'draw call rendering nothing, every frame: ' + offenders.join(', '));
});

console.log('visibility follows CONTENT, not just the parent entity');
test('no module sets trail.visible without checking the geometry has points', () => {
    // Checked across every file that touches it. Three separate sites had this
    // shape — entityBuilder's default, uiController's two, and main.js's vessel
    // filter — and fixing only some of them fixes nothing, because whichever one
    // runs last wins. main.js's ran on boot AND on every layer toggle.
    const s = ['uiController.js', 'main.js', 'clusterManager.js'].map(src).join('\n');
    // A LITERAL is a deliberate local decision and is fine: `= false` hides it,
    // and `= true` appears exactly once, in the writer that has just filled the
    // geometry (asserted separately below).
    //
    // A VARIABLE is the bug shape. It propagates some other object's visibility
    // — the ship's, the filter's, a layer flag's — onto a line that may have
    // nothing in it. That is what produced 501 empty visible trails.
    const bare = [...s.matchAll(/\.trail\.visible\s*=\s*([^;\n]+);/g)]
        .map(m => m[1].trim())
        .filter(expr => expr !== 'false' && expr !== 'true')
        .filter(expr => !/position\?\.count|\.count\s*[>!]/.test(expr));
    assert.deepEqual(bare, [],
        'assigns trail visibility without checking the geometry has points — that is '
      + 'exactly what made 614 empty lines visible: ' + bare.join(' | '));
});

test('the writer that fills a trail also turns it on', () => {
    // Without this the visible=false at creation trades a performance bug for a
    // correctness one: real trails would never appear.
    const s = src('main.js');
    assert.match(s, /attr\.needsUpdate = true;[\s\S]{0,400}?\.trail\.visible = true;/,
        'main.js fills trail geometry but never sets visible=true');
});

console.log(`\nemptyDrawCalls.test: ${passed} checks passed`);
