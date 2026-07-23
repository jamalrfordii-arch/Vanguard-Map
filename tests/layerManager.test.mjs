// tests/layerManager.test.mjs — event-contract test for the central layer registry.
// Run from repo root (needs the DOM env; npm test wires it for the whole suite):
//   node --import ./tests/_stubs/register.mjs tests/layerManager.test.mjs
//
// layerManager is the hub every visible layer registers with, and the rest of the
// app reacts to its `vg1:layerChanged` / `vg1:layerRegistered` events. This tests
// the CONTRACT — method in → correct event + state + persistence out — not any
// rendering. If a refactor changes an event name, drops a payload field, or lets a
// reserved layer be toggled, this fails in Node with no browser needed.
//
// NOTE: domEnv MUST be imported before layerManager — the module registers ~30
// layers at load time, each dispatching on window, so window must already exist.
import './_stubs/domEnv.mjs';
import { captureEvents } from './_stubs/domEnv.mjs';
import assert from 'node:assert/strict';
import { layerManager } from '../layerManager.js';
import { LAYER } from '../config.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('registration & default state');
test('built-in layers registered with their defaults', () => {
    assert.equal(layerManager.isOn('ais-vessels'), true,  'ais-vessels defaultOn:true');
    assert.equal(layerManager.isOn('clouds'), false,      'clouds defaultOn:false');
});
test('unknown layer reads a safe default, never throws', () => {
    assert.deepEqual(layerManager.getState('does-not-exist'), { on: false, opacity: 1.0 });
    assert.equal(layerManager.isOn('does-not-exist'), false);
});

console.log('set() → vg1:layerChanged contract');
test('set(id,on) flips state and emits exactly one event with the right payload', () => {
    const events = captureEvents('vg1:layerChanged');
    layerManager.set('clouds', true);
    assert.equal(layerManager.isOn('clouds'), true, 'state flipped on');
    assert.equal(events.length, 1, 'exactly one event');
    assert.deepEqual(events[0].detail, { id: 'clouds', on: true, opacity: 1.0 },
        'detail carries id, on, and opacity');
    events.stop();
});
test('toggle() inverts current state and emits', () => {
    const events = captureEvents('vg1:layerChanged');
    const before = layerManager.isOn('clouds');
    layerManager.toggle('clouds');
    assert.equal(layerManager.isOn('clouds'), !before);
    assert.equal(events.length, 1);
    events.stop();
});

console.log('setOpacity() clamps and emits');
test('opacity is clamped to [0,1]', () => {
    layerManager.setOpacity('clouds', 5);
    assert.equal(layerManager.getState('clouds').opacity, 1, 'clamped high → 1');
    layerManager.setOpacity('clouds', -3);
    assert.equal(layerManager.getState('clouds').opacity, 0, 'clamped low → 0');
});
test('setOpacity emits vg1:layerChanged with the new opacity', () => {
    const events = captureEvents('vg1:layerChanged');
    layerManager.setOpacity('clouds', 0.4);
    assert.equal(events.length, 1);
    assert.equal(events[0].detail.opacity, 0.4);
    events.stop();
});

console.log('reserved layers are immutable');
test('set() on a reserved layer is a no-op and emits nothing', () => {
    // 'lightning' is registered with reserved:true.
    const before = layerManager.isOn('lightning');
    const events = captureEvents('vg1:layerChanged');
    layerManager.set('lightning', true);
    layerManager.toggle('lightning');
    assert.equal(layerManager.isOn('lightning'), before, 'reserved state unchanged');
    assert.equal(events.length, 0, 'reserved layer never emits');
    events.stop();
});
test('writes to an unknown layer are safely ignored (no throw, no event)', () => {
    const events = captureEvents('vg1:layerChanged');
    assert.doesNotThrow(() => layerManager.set('nope', true));
    assert.equal(events.length, 0);
    events.stop();
});

console.log('persistence');
test('state changes are written to localStorage under the config key', () => {
    layerManager.set('weather', true);
    const raw = localStorage.getItem(LAYER.STORAGE_KEY);
    assert.ok(raw, `expected something saved under ${LAYER.STORAGE_KEY}`);
    const saved = JSON.parse(raw);
    assert.equal(saved.weather.on, true, 'persisted on-state for the layer just set');
    assert.ok('opacity' in saved.weather, 'persisted opacity too');
});

console.log(`\nlayerManager.test: ${passed} checks passed`);
