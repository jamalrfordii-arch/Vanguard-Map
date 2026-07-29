// entityStore.js — single owner of the live scene-entity collection.
//
// Replaces the load-bearing `window.aisShips` global (a raw, ownerless, schema-less
// mutable array read by 8 modules). See memory/entitystore-migration-plan.md.
//
// CONTRACT — the two things every caller may rely on:
//   1. The array identity returned by `all()` is STABLE for the app lifetime.
//      It is never reassigned, only mutated in place. This is what lets modules
//      that take the array as a parameter (clusterManager, navLightManager,
//      chokepointManager, tickRaycasting, …) keep a reference safely, and what
//      lets the `window.aisShips` debug alias stay valid.
//   2. All structural mutation (add / remove) goes through this module. No other
//      module may push/splice the array. (Today every write already lives in
//      main.js — this just gives that writer a name and a home.)
//
// The collection is heterogeneous by design: it holds vessels, real flights
// (userData.isRealFlight === true), and — defensively — orbital assets
// (userData.class === "ORBITAL"). The typed accessors below centralise the
// ad-hoc `.filter(...)` calls that were duplicated across uiController /
// watchlist / sitrep.

const _entities = [];

export const entityStore = {
    // ── reads ────────────────────────────────────────────────────────────────
    /** The live array, by STABLE reference. Do not reassign; do not push/splice — use add/remove. */
    all() { return _entities; },

    /** Count without exposing the array. */
    count() { return _entities.length; },

    /** Vessels: everything that is neither a real flight nor an orbital asset. */
    ships() {
        return _entities.filter(e =>
            !e?.userData?.isRealFlight && e?.userData?.class !== 'ORBITAL');
    },

    /** Real (non-synthetic) flights. */
    flights() {
        return _entities.filter(e => e?.userData?.isRealFlight === true);
    },

    /** Orbital assets (satellites). Defensive — may be empty in current builds. */
    satellites() {
        return _entities.filter(e => e?.userData?.class === 'ORBITAL');
    },

    /** First entity whose userData.id matches (string-compared), or null. */
    byId(id) {
        const key = String(id);
        return _entities.find(e => String(e?.userData?.id) === key) ?? null;
    },

    // ── writes (the ONLY sanctioned mutations) ─────────────────────────────────
    /** Append an entity. Returns the entity. */
    add(obj) {
        _entities.push(obj);
        return obj;
    },

    /** Remove by userData.id (string-compared). Returns the removed entity, or null. */
    removeById(id) {
        const key = String(id);
        const i = _entities.findIndex(e => String(e?.userData?.id) === key);
        return i === -1 ? null : _entities.splice(i, 1)[0];
    },

    /** Remove a specific object reference. Returns true if it was present. */
    removeRef(obj) {
        const i = _entities.indexOf(obj);
        if (i === -1) return false;
        _entities.splice(i, 1);
        return true;
    },

    /** Empty the collection in place (keeps the stable reference). */
    clear() { _entities.length = 0; },
};

// ── DEBUG HANDLES ONLY — NOT the data path (Tier 3, per CLAUDE.md) ─────────────
// Migration complete: no app code reads or writes these globals anymore — every
// reader goes through the entityStore import. They survive purely as DevTools
// conveniences, same as window.simClock / window.vg1Invariants. `window.aisShips`
// aliases the SAME array (mutations via the store are visible here), so it's a
// live read-only mirror for inspection. DO NOT push/splice it directly — that
// bypasses the store's ownership and is exactly the fragility this module retired.
if (typeof window !== 'undefined') {
    window.aisShips = _entities;      // read-only debug mirror of the entity array
    window.entityStore = entityStore; // debug handle (Tier 3)
}
