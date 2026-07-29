# VANGUARD1 — Cargo Intelligence Layer (Phase 1: Draft Capture + Port-Call Detection)
**2026-07-23 · feature spec, not yet built**

## 1. Goal

Give VANGUARD1 a real laden/ballast read and a rough commodity-flow trail per vessel, using
**only data already licensed and flowing through the app today** — no new external dependency,
no paid feed. This is the free tier of the commodity-tracking discussion: draft-based load
estimation + port-to-port voyage reconstruction + the chokepoint counters that already exist.
The bet is that these three, done honestly, get most of the practical value of a paid tracker
(Kpler/Vortexa/Windward) for the one thing this app actually needs — a plausible "is this vessel
full or empty, and where did it just come from" answer on the vessel card and via console.

## 2. Non-goals (explicitly deferred, not forgotten)

- Exact commodity identity (crude vs. product oil, iron ore vs. coal) — draft gives load
  *factor*, not cargo *identity*. This needs vessel-specialization history (Equasis/GISIS) or
  paid manifest data, both discussed separately as later, costed phases.
- Exact tonnage — needs a real hull database (deadweight tonnage per IMO number), not just a
  class-average draft table.
- Ground-truth verification against customs/bill-of-lading data (ImportGenius/Panjiva) or
  satellite tank-fill imagery (Kayrros-style) — both paid/enterprise, out of scope here.
- New UI panel — this rides on the existing vessel-detail card and chokepoint system, not a new
  screen.

## 3. What already exists that this builds on

| Piece | File | Status today |
|---|---|---|
| AIS static message parsing | `aisManager.js` (~316-355) | Captures `imo`, `destination`, `shipType` from `ShipStaticData`. **Does not capture `Draught`**, though AISStream sends it in the same message. |
| Vessel object model | `aisManager.js` (~443-470) | Plain object per MMSI (`class`, `country`, `speedKts`, `headingDeg`, `latDeg`/`lonDeg`, `destination`, `history`, etc.) — this is where new fields attach. |
| Port database | `portManager.js` (`PORTS`, ~31 onward) | ~40+ ports, each with `lat`/`lon`, `tier`, `region`, **`type`** (e.g. `'Container + Bulk + Energy'`, `'Container + Oil'`), `teuRank`, `maxVessel`, `serves` (chokepoints). No radius/polygon — centroid only. `type` is a free, already-written cargo-specialization hint per port. |
| Chokepoint vessel counting | `chokepointManager.js` (~368-452) | Already classifies live vessels inside named boxes (Hormuz, Malacca, Bab-el-Mandeb, etc.) and tracks count/dark-count per box, per tick. This is already the same metric as "barrels/day transiting Hormuz," just not laden-weighted yet. |
| Config namespacing | `config.js` (`export const AIS = {...}`, `CONFLICT = {...}`, `FLIGHT = {...}`) | Established pattern for adding a new named constant group — this spec adds `CARGO = {...}`. |
| Vessel-detail card | `uiController.js` `showVesselDetail()` (~977) | Renders CLASS/HEADING/COUNTRY/etc. by `getElementById`, with a precedent for a conditionally-shown section (`vd-aircraft-section`, ~998-1014) that only displays for aircraft — the cargo section follows the same pattern for AIS surface vessels. |
| Persisted per-vessel state pattern | `watchlist.js` | Existing precedent for a small per-MMSI localStorage-backed record — the port-call log reuses this shape rather than inventing a new persistence mechanism. |

## 4. Data model additions

### 4.1 Vessel object (`aisManager.js`)
Add to the `ShipStaticData` handler (next to the existing `imo`/`destination`/`shipType` capture,
~line 320-355) and to the initial vessel literal (~443-470):

```js
existing.draughtM = (static_.Draught != null) ? static_.Draught : existing.draughtM ?? null;
```

Note: AIS spec (ITU-R M.1371) reports `Draught` in **0.1 m units** in the raw bitstream, but
confirm what AISStream's JSON layer already normalizes it to before dividing — check a live
message before assuming raw decimeters, since other fields (`Cog`, `Sog`) arrive already scaled.

New derived fields (computed, not stored raw):
- `maxDraughtM` — seeded from a class-average lookup (`CARGO.MAX_DRAFT_BY_CLASS`, keyed by the
  existing `aisTypeToClass()` output), refined per-MMSI by the highest `draughtM` ever actually
  observed for that vessel (a running "personal-best" high-water-mark, persisted the same way
  `watchlist.js` persists per-MMSI state). This avoids needing a real hull/DWT database while
  still converging on a decent per-vessel estimate over time.
- `loadFactor = draughtM / maxDraughtM`, clamped `[0, 1]`.
- `ladenState`: `LADEN` (`loadFactor ≥ CARGO.LADEN_THRESHOLD`), `BALLAST`
  (`loadFactor ≤ CARGO.BALLAST_THRESHOLD`), else `PARTIAL`. `UNKNOWN` if `draughtM` or
  `maxDraughtM` is null — **must render as `—`, never guess a state from missing data** (this is
  the same honesty lesson as the fabricated-`TRUSTED` badge bug already found and punch-listed —
  don't repeat that mistake here with a fabricated `BALLAST`).

### 4.2 Port-call log (new, small, per-MMSI)
```js
{ port: 'ROTTERDAM', arrivedAt: <simClock ms>, departedAt: <simClock ms|null>,
  draughtOnArrival: <m|null>, draughtOnDeparture: <m|null> }
```
Kept as a short rolling array (last N calls) on the vessel object, persisted the same way
`watchlist.js` persists to localStorage, keyed by MMSI.

## 5. New module: `portCallManager.js`

Per `CLAUDE.md`'s architecture table ("Add a new data layer → new `*Manager.js`, register with
`layerManager`"), this is a new file, not logic bolted onto `aisManager.js` or `portManager.js`.

**Detection loop** (driven by a timer, not every frame — same two-speed pattern as
`conflictManager.js`: cheap position check every frame, heavier state-transition logic on a
slower tick):

- For each live AIS vessel, haversine distance (reuse or extract the haversine already used by
  `zoneRecorder.js`) to every `PORTS` entry.
- State machine per vessel: `UNDERWAY` → `APPROACHING` (inside `CARGO.PORT_CALL_RADIUS_NM`,
  speed above a "still moving" floor) → `IN_PORT` (inside radius AND speed below a "stopped"
  floor for `CARGO.DWELL_MIN_MS` continuously) → `DEPARTED` (exits radius) → back to `UNDERWAY`,
  writing a completed port-call record with entry/exit draft on the `IN_PORT → DEPARTED`
  transition.
- Emits `vg1:portCall` (matching the project's `vg1:*` CustomEvent convention) with
  `{mmsi, port, arrivedAt, departedAt, draughtDelta}` so other managers (chokepoint flow,
  alerts) can react without a direct import, per `CLAUDE.md`'s "communicate between managers"
  rule.

**Known approximation, stated up front:** ports here are centroids with a fixed radius, not real
harbor polygons — a vessel anchored offshore waiting for a berth, or a large port with docks
5+ nm from the centroid (e.g. Rotterdam's Maasvlakte), will need a generous radius and will still
sometimes misfire. This should be labeled as an approximation in the UI, not silently trusted.

## 6. Cargo inference (derived, computed on read — not persisted as a "fact")

Combine, for any vessel where `class` is a bulk/tanker/LNG-relevant type:
`ladenState` + the **departure port's** `type` string (already-written data, e.g.
`'Container + Oil'`) + `serves` (which chokepoints that port feeds).

Output a `probableCargo` object: `{ label: 'Crude oil (probable)', confidence: 'LOW' | 'MEDIUM' }`
— confidence is **explicitly always capped at MEDIUM**, never HIGH, since this is a structural
inference with no manifest behind it. This mirrors the AI Discovery card's own HIGH/MEDIUM/LOW
convention already used elsewhere in the app, so it reads consistently rather than inventing a
new confidence vocabulary.

**This must never render with unqualified-sounding copy.** The recent audit work found real
damage from a badge that silently defaulted to a confident-sounding state (`uiController.js:
629-630`, `TRUSTED · 100` shown for vessels with no actual record). The cargo estimate section
carries an explicit `ESTIMATED — NOT VERIFIED` tag at all times, no exceptions, so it can't repeat
that mistake.

## 7. Vessel-card surfacing (`uiController.js`)

New conditionally-rendered `vd-cargo-section`, following the exact precedent of
`vd-aircraft-section` (~998-1014): shown only when `ud.isRealAIS && class is bulk/tanker/LNG`.
Fields: `DRAFT` (m, or `—`), `LOAD FACTOR` (%, or `—`), `STATE` (LADEN/BALLAST/PARTIAL/`—`),
`PROBABLE CARGO` (label + confidence tag), `LAST PORT` (name + dwell duration), `INFERRED VOYAGE`
(last completed port → current destination, if both known).

## 8. Console API

`window.vg1Cargo.forVessel(mmsi)` — full inferred record for one vessel.
`window.vg1Cargo.chokepointFlow(code, windowMs)` — laden-vessel-transit count through a named
chokepoint over a time window, built on top of `chokepointManager`'s existing per-box vessel
classification (§3) — this is the piece that turns a chokepoint diamond into an actual trade-flow
estimate rather than a raw density counter.

## 9. Config additions (`config.js`)

```js
export const CARGO = {
    PORT_CALL_RADIUS_NM: 12,     // centroid-only approximation — see §5 caveat
    DWELL_MIN_MS:        45 * 60 * 1000,
    STOPPED_SPEED_KTS:   1.5,
    LADEN_THRESHOLD:     0.85,   // loadFactor at/above this = LADEN
    BALLAST_THRESHOLD:   0.55,   // loadFactor at/below this = BALLAST
    MAX_DRAFT_BY_CLASS: {        // seed values, meters — refined per-MMSI at runtime (§4.1)
        TANKER: 18, BULK_CARRIER: 14, LNG_CARRIER: 12, CONTAINER: 15, // placeholders, verify against real class averages before shipping
    },
};
```

## 10. Phased build order

1. **Draught capture** (`aisManager.js`) — smallest possible change, verify the raw AISStream
   units first against a live message.
2. **Port-call detection** (new `portCallManager.js`) — the real engineering lift; get the
   state machine and dwell logic right before anything downstream depends on it.
3. **Cargo inference + vessel-card UI** (`uiController.js` + `index.html` markup) — pure
   read-side, no new data collection, can iterate on copy/thresholds freely once 1-2 land.
4. **Chokepoint laden-flow aggregation** (extends `chokepointManager.js`) — the payoff step;
   turns existing density counters into a rough trade-volume signal.

Phase 2 (separate spec, later, costed): Equasis/GISIS cross-reference for real vessel
specialization history; UN Comtrade as an after-the-fact accuracy check against this phase's
estimates.

## 11. Risks / honesty constraints

- `Draught` is not sent by every vessel on every static message — expect frequent `null`.
  Render `—`, never a fabricated number or state.
- Centroid+radius port-call detection will false-positive on transits-near-but-not-into a port
  and false-negative on far-offshore berths — state this as a known approximation in the UI
  copy, not just this spec.
- Cargo label is inference, capped at MEDIUM confidence, always tagged `ESTIMATED — NOT
  VERIFIED` — this is a hard constraint, not a nice-to-have, given the project's own recent
  history with a badge that defaulted to false confidence.

## 12. Success criteria

Point at any tanker or bulker currently transiting a chokepoint and get a plausible LADEN/BALLAST
read plus a last-port trail, spot-checked by hand against a couple of real known cases (e.g. a
VLCC that just departed a Gulf loading port should read LADEN, high load factor, correct last
port). Chokepoint laden-transit counts should be directionally sane compared to published
EIA/UN Comtrade figures for the same strait, even though this phase has no way to confirm exact
tonnage.
