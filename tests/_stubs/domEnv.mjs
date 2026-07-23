// tests/_stubs/domEnv.mjs — a tiny, dependency-free browser environment for
// manager contract tests.
//
// Vanguard1's managers never import each other; they communicate only through
// `vg1:*` events on `window` (see CLAUDE.md architecture rules). That makes each
// manager testable in isolation: dispatch an event / call a method, then assert
// what it emits or persists — no GPU, no real DOM.
//
// This module installs just enough of the browser globals for that: `window`
// (an EventTarget so addEventListener/dispatchEvent work), `localStorage`, and a
// forgiving `document` stub for managers that poke the DOM during init. Import it
// FIRST, before importing the manager under test — ES modules evaluate imports in
// source order, so a manager's top-level code (singletons, register() calls) will
// see these globals already in place:
//
//     import './_stubs/domEnv.mjs';
//     import { layerManager } from '../layerManager.js';
//
// Pure logic tests (invariants, projection, data-source) do NOT import this, so
// `window` stays undefined for them and their guarded `typeof window` checks
// behave exactly as they do in production.

// CustomEvent is global in Node 19+, but polyfill defensively so the suite runs
// on any supported Node without a flag.
if (typeof globalThis.CustomEvent === 'undefined') {
    globalThis.CustomEvent = class CustomEvent extends Event {
        constructor(type, opts = {}) { super(type, opts); this.detail = opts?.detail ?? null; }
    };
}

// ── localStorage ──────────────────────────────────────────────────────────────
class LocalStorageStub {
    constructor() { this._m = new Map(); }
    getItem(k)    { return this._m.has(String(k)) ? this._m.get(String(k)) : null; }
    setItem(k, v) { this._m.set(String(k), String(v)); }
    removeItem(k) { this._m.delete(String(k)); }
    clear()       { this._m.clear(); }
    key(i)        { return [...this._m.keys()][i] ?? null; }
    get length()  { return this._m.size; }
}

// ── document ──────────────────────────────────────────────────────────────────
// A "null-object" element: every property read returns another forgiving element
// and every method is a no-op, so DOM-touching init code runs without throwing.
function fakeEl() {
    const el = {
        style: {}, dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        children: [], childNodes: [],
        innerHTML: '', outerHTML: '', textContent: '', value: '',
        appendChild(c) { return c; }, removeChild(c) { return c; }, remove() {},
        insertAdjacentHTML() {}, setAttribute() {}, removeAttribute() {},
        getAttribute() { return null; }, hasAttribute() { return false; },
        addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
        querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
        focus() {}, blur() {}, click() {}, closest() { return null; },
        getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }; },
    };
    return el;
}

const documentStub = {
    getElementById() { return fakeEl(); },
    createElement()  { return fakeEl(); },
    querySelector()  { return fakeEl(); },
    querySelectorAll() { return []; },
    createDocumentFragment() { return fakeEl(); },
    addEventListener() {}, removeEventListener() {},
    body: fakeEl(), documentElement: fakeEl(),
};

// ── install ───────────────────────────────────────────────────────────────────
const win = new EventTarget();
globalThis.window       = win;
globalThis.document     = documentStub;
globalThis.localStorage = new LocalStorageStub();
// Some code calls the bare globals (in a browser these are window's).
globalThis.addEventListener    = win.addEventListener.bind(win);
globalThis.removeEventListener = win.removeEventListener.bind(win);
globalThis.dispatchEvent       = win.dispatchEvent.bind(win);

// Collect all events of a given type into an array (returns the array + a stop fn).
// Handy for asserting "exactly one vg1:layerChanged fired with this detail".
export function captureEvents(type) {
    const seen = [];
    const handler = (e) => seen.push(e);
    win.addEventListener(type, handler);
    seen.stop = () => win.removeEventListener(type, handler);
    return seen;
}

export { win as window, documentStub as document };
export const localStorage = globalThis.localStorage;
