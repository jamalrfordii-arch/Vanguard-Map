// tests/tilePointsPool.test.mjs — the worker pool's contract.
// Run from repo root:  node tests/tilePointsPool.test.mjs
//
// Under plain node there is no DOM `Worker`, so the pool takes its synchronous
// fallback path. That is exactly the path worth pinning here: it is the one that
// runs when Workers are blocked by CSP, by file://, or on an old browser, and it
// is the one nobody will ever click through by hand. The worker path shares its
// maths with this one by construction (both call buildTilePoints), so what needs
// testing is the QUEUEING contract around it — priority and eviction — because
// that is what tileStreamManager's `if (built === null) return;` guards depend on.

import assert from 'node:assert/strict';
import { tilePointsPool } from '../tilePointsPool.js';
import { buildTilePoints } from '../tilePointsBuilder.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
async function testAsync(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const fakeQM = () => ({
    vertexCount: 4,
    uBuf: new Uint16Array([0, 32767, 0, 32767]),
    vBuf: new Uint16Array([0, 0, 32767, 32767]),
    hBuf: new Uint16Array([0, 13000, 32767, 20000]),
    minHeight: 100, maxHeight: 900,
    indices: new Uint32Array([0, 1, 2, 1, 3, 2]),
    edgeIndices: { west: [0, 2], south: [0, 1], east: [1, 3], north: [2, 3] },
});
const cfg = { zoom: 9, ptsBudget: 1000, imgSize: 256, ptSize: 0.012 };

console.log('fallback path');

test('reports Workers unavailable under node rather than pretending', () => {
    // If this ever reads true under node, the pool has acquired a second
    // implementation path that these tests are not actually exercising.
    assert.equal(tilePointsPool.available, false);
    const s = tilePointsPool.stats();
    assert.equal(s.available, false);
});

await testAsync('fallback produces identical output to a direct call', async () => {
    // The whole safety argument for the worker is "same module, same maths". If
    // the fallback ever diverges from buildTilePoints, that argument is void.
    const viaPool   = await tilePointsPool.build(cfg, 100, 200, fakeQM(), null, 0);
    const direct    = buildTilePoints(cfg, 100, 200, fakeQM(), null);
    assert.equal(viaPool.count, direct.count);
    for (let i = 0; i < direct.count * 3; i++) {
        assert.equal(viaPool.positions[i], direct.positions[i], `position[${i}] diverged`);
        assert.equal(viaPool.colors[i],    direct.colors[i],    `color[${i}] diverged`);
    }
});

await testAsync('never returns a half-built result', async () => {
    const r = await tilePointsPool.build(cfg, 5, 6, fakeQM(), null, 0);
    assert.ok(r && typeof r.count === 'number', 'must resolve to a result or null, nothing else');
    assert.equal(r.positions.length, cfg.ptsBudget * 3);
    assert.equal(r.colors.length,    cfg.ptsBudget * 3);
});

await testAsync('a build error rejects or resolves — it never hangs', async () => {
    // A pending-forever promise would leave the tile key stuck in _loading and the
    // tile would never be retried, which is far worse than a visible failure.
    const bad = { vertexCount: 4, minHeight: 0, maxHeight: 0 };   // missing uBuf/vBuf/hBuf
    const settled = await Promise.race([
        tilePointsPool.build(cfg, 1, 1, bad, null, 0).then(() => 'resolved', () => 'rejected'),
        new Promise(r => setTimeout(() => r('HUNG'), 2000)),
    ]);
    assert.notEqual(settled, 'HUNG', 'malformed input left the promise pending');
});

console.log('stats');

test('stats() reports a coherent snapshot', () => {
    const s = tilePointsPool.stats();
    for (const k of ['workers', 'idle', 'queued', 'inFlight', 'available']) {
        assert.ok(k in s, `stats() missing ${k}`);
    }
    assert.ok(s.queued >= 0 && s.inFlight >= 0);
});

console.log(`\n${passed} passed`);
