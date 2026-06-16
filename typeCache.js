// typeCache.js — persist learned vessel MMSI→class in localStorage.
//
// WHY: AIS only broadcasts ship type in the static (type-5) message, ~every 6 min
// per vessel, so a fresh session starts almost all-grey (class OTHER) and only
// colorizes minutes later as static arrives. Remembering each vessel's class once
// learned lets us render it correctly the instant it reappears — the map looks
// classified from the first seconds instead of after ~10 minutes. MMSI↔type is
// stable for real ships, so this is safe.
//
// Writes are debounced (the live feed sets hundreds of types in bursts), and the
// store is soft-capped so it can't grow without bound. Console: window.vg1TypeCache.

const LS_KEY = 'vg1_vessel_types';
const MAX    = 20000;            // soft cap on remembered vessels
const FLUSH_MS = 4000;

let _map = {};
try {
    if (typeof localStorage !== 'undefined')
        _map = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {};
} catch (_) { _map = {}; }

let _flushTimer = null;
function _scheduleFlush() {
    if (_flushTimer || typeof localStorage === 'undefined') return;
    _flushTimer = setTimeout(() => {
        _flushTimer = null;
        try {
            const keys = Object.keys(_map);
            if (keys.length > MAX) {                 // prune oldest-inserted keys
                const trimmed = {};
                for (const k of keys.slice(keys.length - MAX)) trimmed[k] = _map[k];
                _map = trimmed;
            }
            localStorage.setItem(LS_KEY, JSON.stringify(_map));
        } catch (_) { /* quota / private mode — cache stays in-memory only */ }
    }, FLUSH_MS);
}

export const typeCache = {
    // Cached class for an MMSI, or null if unknown.
    get(mmsi) { return _map[String(mmsi)] || null; },
    // Remember a real class (never caches OTHER — that's "type unknown").
    set(mmsi, cls) {
        if (!cls || cls === 'OTHER') return;
        const k = String(mmsi);
        if (_map[k] === cls) return;
        _map[k] = cls;
        _scheduleFlush();
    },
    size() { return Object.keys(_map).length; },
    clear() { _map = {}; try { localStorage.removeItem(LS_KEY); } catch (_) {} },
};

if (typeof window !== 'undefined') window.vg1TypeCache = typeCache;
