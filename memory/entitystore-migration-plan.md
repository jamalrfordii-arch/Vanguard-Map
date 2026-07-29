# Migration Plan — `entityStore.js` (own the shared entity array)

**Status:** ✅ COMPLETE (Phases 0–3 shipped 2026-07-23)
**Date:** 2026-07-23
**Target:** Replace the load-bearing `window.aisShips` global with an owning module.
**Risk:** Low–Medium (writes are already centralized; see finding below).

> **Outcome:** `entityStore.js` + `tests/entityStore.test.mjs` landed; all mutators in
> `main.js` and all readers in `main.js`/`uiController.js`/`watchlist.js`/`sitrepManager.js`
> migrated. `window.aisShips` is now a read-only debug mirror only. Suite green (13 files).
> Verified live in-browser: add path (count 0→800), remove path (reversible removeRef),
> and the migrated read panels (fleet-intel, vessel comparative-context) — zero console
> errors. CLAUDE.md updated (module map, data-layer row, Tier-3 policy).

---

## Why do this first (benefits)

**1. It removes the single biggest fragility in the app.** `window.aisShips` is a raw
mutable array with no owner, no schema, and boot-order dependence, read by 8 modules.
Every "works on load, breaks after X" class of bug lives on exactly this kind of global.
Fixing it retires a whole category of future bugs, not one bug.

**2. It's the prerequisite for the other cleanups.** The tiered dependency doctrine
(just added to CLAUDE.md) says "no new load-bearing globals" and points at a planned
`entityStore`. Splitting `main.js` (the P2 frame-scheduler work) is also easier once
entity access goes through a stable import instead of a global the loop mutates inline.
Doing entityStore first unblocks the rest; doing it last means redoing that work.

**3. The array is misnamed and that hides bugs.** It doesn't hold "ais ships" — it holds
vessels **and** real flights (`userData.isRealFlight`) **and** satellite groups (pushed by
`instancedSatManager`). Consumers filter it ad hoc (`.filter(o => o.userData.isRealFlight)`).
A real store can expose typed accessors (`ships()`, `flights()`, `all()`) so those filters
live in one place instead of being re-derived in uiController, watchlist, sitrep, etc.

**4. It gives you a schema seam and an events seam for free.** Once one module owns
add/remove, it's the natural place to (a) assert element shape in dev builds and (b) emit
`vg1:entityAdded/Removed` if a consumer later wants push instead of per-frame scan. You
can't add either cleanly while 8 modules poke a bare array.

**5. Low cost to capture it now — the hard part is already done.** Grep shows **every
mutation** (`push`/`splice`) is in `main.js` (8 sites). No other module writes the global
(the `aisShips.push` in `entityBuilder.js` and the loops in `chokepointManager`/`uiController`
operate on a **passed-in parameter**, not the global). So the writer is already single;
only reads are scattered. That's the cheap case.

---

## Current state (grounded in grep, 2026-07-23)

| | Where |
|---|---|
| Init | `main.js:98` — `window.aisShips = []` (reassigned exactly once) |
| Writes (push/splice) | `main.js` only — 8 sites (L708, 893, 1017, 1067, 1071, 1177, 1180, 1210, 1229) |
| Reads — direct global | `main.js` (many), `uiController.js` (5), `watchlist.js` (2), `sitrepManager.js` (1) |
| Reads — via passed param | `clusterManager`, `navLightManager`, `climbRibbonManager`, `chokepointManager`, `tickRaycasting`, `instancedSatManager` (these receive the array as an arg — no change needed) |
| Contents | vessels + real flights (`isRealFlight`) + satellite groups — heterogeneous |

**Design consequence:** the store must expose the array **by stable reference** (never
reassign it) so the modules that already take it as a parameter keep working unchanged, and
so a `window.aisShips` debug alias can point at the same array during migration.

---

## Target design — `entityStore.js`

```js
// entityStore.js — single owner of live scene entities (vessels, flights, sats).
// The array identity is STABLE for the app lifetime; never reassigned, only mutated.
const _entities = [];

export const entityStore = {
  all()      { return _entities; },                 // stable ref — safe to pass around
  ships()    { return _entities.filter(e => !e.userData.isRealFlight && !e.userData.isSat); },
  flights()  { return _entities.filter(e => e.userData.isRealFlight); },
  count()    { return _entities.length; },

  add(obj)   { _entities.push(obj); },              // (optionally emit vg1:entityAdded)
  removeById(id) {
    const i = _entities.findIndex(s => s.userData.id === id);
    if (i !== -1) return _entities.splice(i, 1)[0];
    return null;
  },
  removeRef(obj) {
    const i = _entities.indexOf(obj);
    if (i !== -1) _entities.splice(i, 1);
  },
};

// DEBUG MIRROR ONLY — same reference, not the data path. Remove once readers migrate.
if (typeof window !== 'undefined') window.aisShips = entityStore.all();
```

Because `window.aisShips` is aliased to the *same* array, **nothing breaks on day one** —
every existing reader keeps working while you migrate them one at a time.

---

## Phased steps (each phase ships independently, suite stays green)

**Phase 0 — Safety net (before touching anything).**
- [ ] Add `tests/entityStore.test.mjs`: add/removeById/removeRef, `ships()`/`flights()`
      partitioning, and the invariant that `all()` returns a stable reference across calls.
- [ ] Confirm `npm test` green (12 files today).

**Phase 1 — Introduce the store, alias the global.**
- [ ] Create `entityStore.js` as above.
- [ ] In `main.js`, replace `window.aisShips = []` (L98) with
      `import { entityStore } from './entityStore.js'` and the debug alias.
- [ ] Convert `main.js`'s 8 mutation sites to `entityStore.add(...)` /
      `entityStore.removeById(...)` / `entityStore.removeRef(...)`.
- [ ] No reader changes yet. Suite green, app visually identical (same array reference).

**Phase 2 — Migrate direct readers off the global, module by module.**
Order chosen low-blast-radius → high:
- [ ] `sitrepManager.js` (1 read) → `entityStore.all()` / `.ships()`
- [ ] `watchlist.js` (2 reads)
- [ ] `uiController.js` (5 reads — includes the `isRealFlight` filter → use `.flights()`)
- [ ] `main.js` internal reads (largest, but same file as the writer — do last, mechanical)
- After each module: `npm test` + a manual load smoke-check.

**Phase 3 — Remove the crutch.**
- [ ] Delete the `window.aisShips` debug alias (or keep a clearly-labelled read-only mirror
      if you still want DevTools access — acceptable per Tier 3 doctrine).
- [ ] Grep `window.aisShips` returns only the intentional debug mirror (or nothing).
- [ ] Update `CLAUDE.md`: change the "Add a new data layer" row and the dependency policy
      to reference `entityStore` as the owner of live entities.

---

## Explicitly out of scope (don't scope-creep this)

- Renaming `userData.id`/`mmsi`/`icao24` conventions — separate cleanup.
- Splitting flights into their own store — `entityStore.flights()` is enough for now; a
  second store is only worth it if the heterogeneous array causes a concrete bug.
- The `main.js` frame-scheduler extraction (P2) — do it *after* this, as its own change.

## Rollback

Each phase is a standalone commit. If a reader regresses, revert that one module's commit;
the alias in Phases 1–2 means the global still exists as a fallback until Phase 3.
