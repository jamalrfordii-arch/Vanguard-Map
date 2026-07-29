// tests/entityStore.test.mjs — contract test for the entity collection owner.
// Run from repo root:  node tests/entityStore.test.mjs
// Pure node, no browser, no THREE. Guards the two promises the store makes:
//   (1) all() returns a STABLE array reference across mutations, and
//   (2) add/removeById/removeRef and the typed partitions behave exactly.
// If a refactor reassigns the internal array or breaks a partition filter, this
// fails in Node with no browser needed.

import assert from 'node:assert/strict';
import { entityStore } from '../entityStore.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// Minimal entity doubles — only the userData fields the store inspects.
const vessel = (id)  => ({ userData: { id, class: 'CARGO' } });
const flight = (id)  => ({ userData: { id, isRealFlight: true } });
const sat    = (id)  => ({ userData: { id, class: 'ORBITAL' } });

function reset() { entityStore.clear(); }

console.log('stable reference (the core promise)');
test('all() returns the same array reference before and after mutation', () => {
    reset();
    const ref1 = entityStore.all();
    entityStore.add(vessel('A'));
    entityStore.removeById('A');
    const ref2 = entityStore.all();
    assert.equal(ref1, ref2, 'reference identity must be preserved across add/remove');
});
test('clear() empties in place without swapping the reference', () => {
    reset();
    const ref = entityStore.all();
    entityStore.add(vessel('A'));
    entityStore.clear();
    assert.equal(entityStore.all(), ref, 'same reference after clear');
    assert.equal(entityStore.count(), 0, 'emptied');
});

console.log('add / count');
test('add appends and returns the entity; count reflects it', () => {
    reset();
    const v = vessel('V1');
    assert.equal(entityStore.add(v), v, 'add returns the entity');
    entityStore.add(flight('F1'));
    assert.equal(entityStore.count(), 2);
});

console.log('removeById');
test('removeById removes the match and returns it (string-compared ids)', () => {
    reset();
    const v = vessel(12345);            // numeric id …
    entityStore.add(v);
    const out = entityStore.removeById('12345'); // … removed by string key
    assert.equal(out, v, 'returns the removed entity');
    assert.equal(entityStore.count(), 0);
});
test('removeById on a missing id returns null and mutates nothing', () => {
    reset();
    entityStore.add(vessel('A'));
    assert.equal(entityStore.removeById('nope'), null);
    assert.equal(entityStore.count(), 1);
});

console.log('removeRef');
test('removeRef removes the exact object and reports true; false if absent', () => {
    reset();
    const a = vessel('A'), b = vessel('A'); // same id, different objects
    entityStore.add(a); entityStore.add(b);
    assert.equal(entityStore.removeRef(b), true, 'removes the exact ref');
    assert.equal(entityStore.count(), 1);
    assert.equal(entityStore.all()[0], a, 'the other same-id object survives');
    assert.equal(entityStore.removeRef(b), false, 'second removal is a no-op → false');
});

console.log('typed partitions');
test('ships / flights / satellites partition the collection correctly', () => {
    reset();
    entityStore.add(vessel('V1'));
    entityStore.add(vessel('V2'));
    entityStore.add(flight('F1'));
    entityStore.add(sat('S1'));
    assert.deepEqual(entityStore.ships().map(e => e.userData.id),      ['V1', 'V2']);
    assert.deepEqual(entityStore.flights().map(e => e.userData.id),    ['F1']);
    assert.deepEqual(entityStore.satellites().map(e => e.userData.id), ['S1']);
    // partitions are disjoint and cover everything
    assert.equal(
        entityStore.ships().length + entityStore.flights().length + entityStore.satellites().length,
        entityStore.count(), 'ships + flights + sats == total (disjoint & exhaustive)');
});
test('malformed entities (missing userData) never crash the partitions', () => {
    reset();
    entityStore.add({});          // no userData
    entityStore.add(vessel('V'));
    assert.doesNotThrow(() => { entityStore.ships(); entityStore.flights(); entityStore.satellites(); });
    // a bare {} is neither flight nor orbital → counts as a ship
    assert.equal(entityStore.ships().length, 2);
});

console.log('byId lookup');
test('byId string-compares and returns null when absent', () => {
    reset();
    const v = vessel(777);
    entityStore.add(v);
    assert.equal(entityStore.byId('777'), v);
    assert.equal(entityStore.byId(777), v);
    assert.equal(entityStore.byId('absent'), null);
});

console.log(`\nentityStore.test: ${passed} checks passed`);
