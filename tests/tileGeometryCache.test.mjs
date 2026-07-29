// tests/tileGeometryCache.test.mjs — pin the built-geometry cache's KEYING.
// Run from repo root:  node tests/tileGeometryCache.test.mjs
//
// The IndexedDB plumbing can't run under node, and it is not the risky part
// anyway. The risky part is the KEY.
//
// A geometry cache serves bytes that look completely fine. If the key omits an
// input that changed the output, you get silently stale terrain — old heights
// after a terrain-mode switch, old point counts after a budget change — with no
// error, no visual "broken" signal, and persistence across reloads. That is the
// worst failure shape available, and it is entirely a keying problem.
//
// So every test here is an attempt to make two DIFFERENT builds collide on one
// key. Each one corresponds to something that actually changed in this codebase
// within a single day: terrain mode (legacy→flat), ACTIVE_PTS_CAP (14k→40k),
// imgSize, saturation, procedural relief.

import assert from 'node:assert/strict';
import { fingerprint, cacheKey, planEviction, entryBytes, SCHEMA_VERSION }
    from '../tileGeometryCache.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const BASE = {
    zoom: 12, ptsBudget: 52000, imgSize: 512, activeCap: 40000,
    terrainMode: 'flat', photoBlend: 0.92, procEnabled: true,
    procRelief: 0.004, saturation: 1.15, hasImagery: true,
};
const fp = (over = {}) => fingerprint({ ...BASE, ...over });

console.log('the key must change when the OUTPUT would change');

test('terrain mode is in the key — flat and tall are different geometry', () => {
    // Switching mode moves every land height by up to 3x. Serving flat geometry
    // in tall mode would look plausible and be wrong everywhere.
    assert.notEqual(fp({ terrainMode: 'flat' }), fp({ terrainMode: 'tall' }));
    assert.notEqual(fp({ terrainMode: 'flat' }), fp({ terrainMode: 'legacy' }));
});

test('the active point cap is in the key — 14k and 40k are different tiles', () => {
    // ACTIVE_PTS_CAP went 14000 → 40000 in one session. A cache keyed without it
    // would serve 14k-point tiles forever after the raise.
    assert.notEqual(fp({ activeCap: 14000 }), fp({ activeCap: 40000 }));
});

test('imagery presence is in the key — palette and photo are different colours', () => {
    // Tiles build twice: palette first, imagery second. If both collide, the
    // palette version could be served permanently and imagery would never appear.
    assert.notEqual(fp({ hasImagery: false }), fp({ hasImagery: true }));
});

test('imgSize, photoBlend, saturation and procedural relief are all in the key', () => {
    for (const [k, v] of [['imgSize', 256], ['photoBlend', 0.80],
                          ['saturation', 1.40], ['procRelief', 0.008],
                          ['procEnabled', false], ['ptsBudget', 26000]]) {
        assert.notEqual(fp(), fp({ [k]: v }), `${k} missing from the fingerprint`);
    }
});

test('SCHEMA_VERSION invalidates everything — the escape hatch for maths changes', () => {
    // Not every output change is expressible as a parameter. Editing the palette
    // or the sampling loop changes bytes with identical inputs, and the only
    // honest answer is to bump the schema.
    assert.notEqual(fingerprint({ ...BASE, schema: SCHEMA_VERSION }),
                    fingerprint({ ...BASE, schema: SCHEMA_VERSION + 1 }));
});

console.log('the key must NOT change on things that do not affect output');

test('identical inputs give an identical key', () => {
    assert.equal(fp(), fp());
    assert.equal(cacheKey(12, 100, 200, fp()), cacheKey(12, 100, 200, fp()));
});

test('tile identity separates tiles that share a fingerprint', () => {
    const f = fp();
    assert.notEqual(cacheKey(12, 100, 200, f), cacheKey(12, 101, 200, f));
    assert.notEqual(cacheKey(12, 100, 200, f), cacheKey(12, 100, 201, f));
    assert.notEqual(cacheKey(11, 100, 200, f), cacheKey(12, 100, 200, f));
});

console.log('eviction policy');

test('does nothing while under budget', () => {
    const e = [{ key: 'a', bytes: 10, lastAccess: 1 }, { key: 'b', bytes: 10, lastAccess: 2 }];
    assert.deepEqual(planEviction(e, 100), []);
});

test('drops least-recently-used first', () => {
    const e = [{ key: 'new', bytes: 50, lastAccess: 300 },
               { key: 'old', bytes: 50, lastAccess: 100 },
               { key: 'mid', bytes: 50, lastAccess: 200 }];
    assert.deepEqual(planEviction(e, 100), ['old']);
    assert.deepEqual(planEviction(e, 50),  ['old', 'mid']);
});

test('eviction is DETERMINISTIC when timestamps tie', () => {
    // Same-millisecond writes are common during a dive. A non-deterministic plan
    // makes any cache bug unreproducible, which is how you lose a day.
    const e = [{ key: 'b', bytes: 50, lastAccess: 5 }, { key: 'a', bytes: 50, lastAccess: 5 }];
    assert.deepEqual(planEviction(e, 50), planEviction(e, 50));
    assert.deepEqual(planEviction(e, 50), ['a']);
});

test('frees enough to get UNDER budget, not merely one entry', () => {
    const e = Array.from({ length: 10 }, (_, i) => ({ key: 'k' + i, bytes: 100, lastAccess: i }));
    const drop = planEviction(e, 250);
    assert.equal(drop.length, 8, `expected to free down to 250 bytes, dropped ${drop.length}`);
});

console.log('sizing');

test('entry size matches the real buffer layout', () => {
    // 3 float32 positions + 3 uint8 colours per point. Used for the budget, so a
    // wrong figure means the cache silently overruns its cap.
    assert.equal(entryBytes(1), 15);
    assert.equal(entryBytes(40000), 600000);
});

test('a z12 view is a realistic fraction of the default budget', () => {
    // Sanity on the default 512MB: ~180 tiles at 40k points is ~108MB, so a
    // handful of locations fit and the planet does not — which is the intent.
    const view = 180 * entryBytes(40000);
    assert.ok(view < 512 * 1024 * 1024, 'one view must fit comfortably');
    assert.ok(view * 20 > 512 * 1024 * 1024, 'but 20 views must NOT — eviction has to matter');
});

console.log(`\n${passed} passed`);
