// draughtCache.js — persist each vessel's observed maximum draught (meters) in
// localStorage, refining the coarse per-class seed in config.js CARGO.MAX_DRAFT_BY_CLASS
// toward a real per-vessel "loaded" reference over time.
//
// WHY: there is no hull/DWT database wired into this app (see
// research/vanguard1-cargo-intel-spec-2026-07-23.md §4.1) — the AIS ShipStaticData
// message's MaximumStaticDraught field, despite its name, is set by the crew each
// voyage and changes with load state; it is NOT the vessel's structural maximum.
// So "how deep does this ship sit when truly full" has to be learned empirically:
// the highest draught ever actually observed for an MMSI is a decent proxy for its
// loaded reference, and the estimate only ever improves as more sightings arrive.
// Same debounced-flush / soft-cap shape as typeCache.js. Console: window.vg1DraughtCache.

const LS_KEY   = 'vg1_vessel_max_draught';
const MAX      = 20000;   // soft cap on remembered vessels
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

export const draughtCache = {
    // Highest observed draught (meters) for an MMSI, or null if never seen.
    get(mmsi) { return _map[String(mmsi)] ?? null; },
    // Record a new observation — only ever raises the stored max, never lowers it:
    // a vessel riding lighter later is a real ballast trip, not evidence its full
    // draught is shallower than what was previously observed.
    observe(mmsi, draughtM) {
        // 30m sanity ceiling — even the deepest-draught real vessels (loaded ULCCs)
        // sit well under this; guards against a garbled/out-of-range AIS field.
        if (draughtM == null || !(draughtM > 0) || draughtM > 30) return;
        const k = String(mmsi);
        if (_map[k] == null || draughtM > _map[k]) {
            _map[k] = draughtM;
            _scheduleFlush();
        }
    },
    size()  { return Object.keys(_map).length; },
    clear() { _map = {}; try { localStorage.removeItem(LS_KEY); } catch (_) {} },
};

if (typeof window !== 'undefined') window.vg1DraughtCache = draughtCache;
