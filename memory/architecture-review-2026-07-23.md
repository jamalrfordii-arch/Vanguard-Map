# Architecture Review — VANGUARD1

**Status:** Proposed (review + recommendations)
**Date:** 2026-07-23
**Reviewer:** Claude (engineering:architecture)
**Scope:** 102 ES modules, ~40.7k LOC, Three.js, no bundler, browser served locally.

---

## Summary

The system has a genuinely good bones: a documented layered doctrine, a single
source of sim-time, a clean pluggable data-source abstraction, and a per-report
invariant gate with test-per-rule discipline. The institutional memory (`CLAUDE.md`
+ `memory/`) is better than most production teams keep.

The main architectural risk is not any one module — it is that **the real dependency
graph runs through `window.*` globals, not through the event bus the doctrine claims.**
The stated rule ("never import one manager into another — communicate via events") is
aspirational; the code already votes against it in two ways (direct imports and, more
importantly, ~30 global singletons acting as an untyped service locator). That gap
between doctrine and reality is the thing worth fixing, because scar tissue accumulates
fastest where the map disagrees with the terrain.

There is also one concrete breakage: a test for a module you deleted still ships and
will fail `npm test`.

---

## What's strong (keep and protect)

**Time discipline — `simClock` as single source of sim-time.** Managers call
`simClock.now()` / `.date()` instead of `Date.now()`. This is the correct spine for a
replay/scrub/live system and it's rare that a codebase actually holds the line on it.

**Data-source adapter pattern — `dataSource.js`.** `SyntheticAISSource`,
`RecordedAISSource`, `ZoneRecordedSource`, `CompositeSource` all emit AISStream-shaped
messages into `aisManager.ingest()` and downstream can't tell them apart. Textbook.
This is what lets you replay, synthesize, and go live without touching consumers. Highest-
leverage design decision in the repo.

**Invariant gate — `invariants.js`.** A validation boundary on every position report
(reject vs. flag), with dual timestamps (`lastEventTime` vs `lastSeen`) kept deliberately
distinct, plus a rule that every new invariant needs a test that tries to fool it. This
is a real trust boundary, well placed.

**Manager pattern + `setVisible` + `layerToggle` events** cleanly separates the layer
panel (DOM) from the 12 managers that own geometry. Boot uses workers for heavy terrain
math. Test suite exists (13 files, `node --test`).

---

## Findings & risks

### 1. Shared state travels through `window.*` globals, not events — P1

Events (21 `vg1:*` custom events) carry *notifications*, but *state* is shared through
global singletons. The clearest case:

- `window.aisShips = []` is created once in `main.js` and **read by 8 modules**
  (`airspaceAvoidanceManager`, `climbRibbonManager`, `discoveryManager`,
  `instancedSatManager`, `sitrepManager`, `uiController`, `watchlist`, `main`).
- ~30 other `window.*` singletons (`splatCloud`, `tileStream`, `camera`, `controls`,
  `watchlist`, `alertsManager`, `rfIntel`, …) form an implicit service locator.

Consequence: the true coupling graph is invisible, untyped, and boot-order-dependent.
Nothing enforces who may mutate `aisShips` or what shape its elements have. This is the
single biggest fragility multiplier — every "works on load but breaks after X" bug lives
here.

This isn't a call to purge globals (DevTools access to `window.simClock` etc. is genuinely
useful). It's a call to distinguish **debug handles** (fine) from **load-bearing shared
state** (should be owned).

### 2. Doctrine says "no manager imports another"; ~14 already do — P2

`skyManager → waterManager`, `waterManager/tileStream/cityManager/buildingManager →
terrainBuilder`, `rfEmergencyBeaconManager → aisManager + rfIntelManager`, several
`*Manager → flightManager`, `→ legendManager`. Most are *legitimate* build dependencies
(the sky needs the water surface). The rule is too absolute, so reality quietly overrides
it — which trains the next contributor to distrust the doctrine. Fix the doctrine, not the
code.

### 3. `main.js` (2,799 LOC) and `uiController.js` (2,837 LOC) are god-objects — P2

`main.js` has 65 imports, hand-maintains **55 per-frame `update()/tick()` calls**, the boot
sequence, and the `layerToggle` switch. Every new layer edits this file, so it's a serialized
merge-risk chokepoint and the animation loop is a manually-curated list that will drift from
the set of managers that actually exist.

### 4. Zombie test breaks the suite — P0 (fast)

`tests/layerManager.test.mjs:16` does `import { layerManager } from '../layerManager.js'` —
but `layerManager.js` was removed as dead code (per `CLAUDE.md`, 2026-07-23). Since
`npm test` runs `node --test` with auto-discovery, this file throws on import and takes the
suite's exit code down with it. The dead-code removal wasn't carried through to `tests/`.

### 5. Minor noise

- `tileStreamManager.backup.js` (637 LOC) committed alongside the live file.
- A second, fully commented-out `layerToggle` handler sits in `main.js` (~L1650) inside a
  `/* */` block — dead but confusing next to the live handler at L1542.

---

## Recommendation (ADR-style) — own the shared entity state

**Decision:** Introduce a small `entityStore.js` that *owns* the load-bearing shared
collections (`aisShips`, flights, satellites) behind getters/subscribe, and migrate the 8
`aisShips` readers to it incrementally. Keep `window.*` only as debug handles, not as the
data path.

| Dimension | Global `window.aisShips` (today) | `entityStore` module |
|-----------|----------------------------------|----------------------|
| Complexity | Low now, high later | Low–Med, front-loaded |
| Coupling visibility | Invisible / untyped | Explicit import graph |
| Boot-order safety | Fragile (must exist before readers) | Store guarantees init |
| DevTools access | Free (`window.aisShips`) | Keep a `window` alias for debug |
| Migration cost | — | Incremental, reader-by-reader |

**Trade-off:** you lose the zero-ceremony convenience of a global array; you gain a single
owner, a place to put the element schema, and a real dependency graph. Given the app's
trajectory (more layers, more consumers of vessel state), the convenience stops paying for
itself.

**Why not "just use events for state too":** events are the wrong tool for
current-snapshot reads — consumers that render every frame would have to cache the last
payload anyway, which is a store with extra steps. Events for change *notifications*, a
store for current *state*.

---

## Prioritized action items

1. [ ] **P0** — Fix or delete `tests/layerManager.test.mjs`; restore a green `npm test`.
2. [ ] **P1** — Update `CLAUDE.md` dependency doctrine to a tiered rule: events for
   cross-domain notifications; direct imports allowed for true pipeline build-dependencies;
   `window.*` for debug handles only, never as the data path. Document reality.
3. [ ] **P1** — Add `entityStore.js`; migrate the 8 `aisShips` readers off the raw global
   incrementally.
4. [ ] **P2** — Extract a frame scheduler (managers register an `update` fn) so the
   55-call loop in `main.js` isn't hand-maintained; split boot sequencing out of `main.js`.
5. [ ] **P2** — Delete `tileStreamManager.backup.js` and the commented-out `layerToggle`
   handler.

---

## Things I deliberately did *not* flag

The tuned visual uniforms, bloom threshold, LOD seams, and Mercator/linear terrain mismatch
are documented as intentional and manually calibrated. Those are product decisions, not
architecture debt — leave them alone.
