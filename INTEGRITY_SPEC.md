# AIS Integrity Manager — Build Spec

**Goal:** turn VANGUARD1's invisible physics gate (`invariants.js`) into a visible, headline
analytical capability — a per-vessel **trust score** that flags vessels whose AIS broadcasts don't
add up (spoofing / manipulation / errors), with the specific reasons. This is the project's
differentiator and the "Analysis" phase of the OSINT doctrine. Flags are **indicators for analyst
review**, never verdicts.

---

## 1. Can we compute this for every ship on the map? (Yes — here's how)

The trick: integrity is **never** a per-frame scan of all vessels. It's computed the same way
`invariants.js` already works — **event-driven, incrementally, as each AIS message arrives.**

| Cadence | What runs | Cost |
|---------|-----------|------|
| **Per report** (on `aisManager` ingest, where `checkPositionReport` already runs) | kinematic checks (reuse existing violations) + position-on-land + MMSI validity. Updates ONE vessel's record. | O(1) per message |
| **Periodic timer** (~every 4 s) | loitering / rendezvous (STS) — only over vessels with speed < ~1 kt; score decay/recovery | O(k²), k = stopped vessels (small) |
| **Per frame** | nothing recalculated — the map marker just *reads* the already-computed score | ~free |

Most vessels sit at score 100 and cost nothing. Only anomalies accumulate flags. This scales to
thousands of vessels because the heavy path is amortized across incoming messages, not the render loop.

---

## 2. Detection set

**Reuse (already computed in `invariants.js`, just consume the `violations` array):**
- `IMPOSSIBLE_SPEED` / `EXCESSIVE_SPEED` — kinematic impossibility (teleport / over-class-max).
- `SOG_MISMATCH` — reported speed vs implied speed (position-faking tell).
- `TIME_REGRESSION` / `FUTURE_EVENT` / `STALE_EVENT` — timestamp manipulation.

**New (cheap, reuse existing assets):**
- **Position-on-land** — `getTrueElevation(lonLatToScene(...))` > ~0 m → vessel reporting itself on dry land. Classic spoof/error.
- **MMSI validity** — not 9 digits, or MID not in `MID_TO_COUNTRY` (`aisCountries.js`) → malformed identity.
- **AIS dark / gap** — reuse existing `isDark`: prolonged silence, esp. reappearing far away.
- **Loitering / rendezvous (STS)** — two+ vessels stopped together offshore for a sustained window (sanctions-evasion signature).

**Cross-source (v1.5, when an Equasis dossier is cached):**
- **False-flag** — Equasis registered flag vs MMSI-MID country mismatch (flag-hopping indicator).

**Ambitious (v2):** satellite-imagery ship detection cross-checked against AIS (the reviewer's idea).

---

## 3. Scoring model

Each vessel gets an integrity record:
```
{ mmsi, score: 0..100, tier: 'TRUSTED'|'QUESTIONABLE'|'SUSPECT',
  flags: [{ type, weight, detail, ts }], lastEval }
```
- Start at **100** (trusted). Each active flag subtracts a weighted penalty: `score = 100 − Σ active weights`.
- Weights (tunable in `config.js` → `INTEGRITY`): e.g. on-land 40, impossible-speed 35, SOG-mismatch 20,
  false-flag 25, loitering 15, MMSI-invalid 20, dark 15, time-regression 15.
- **Recency / recovery:** soft flags expire after N minutes if not re-triggered (score recovers);
  condition-based flags (on-land, dark) persist while the condition holds.
- **Tiers → colour:** 100–80 TRUSTED (green) · 79–50 QUESTIONABLE (amber) · <50 SUSPECT (red).

---

## 4. Where it surfaces (answering: card? panel tab? watchlist?)

**All three, with distinct roles — they reinforce each other:**

- **Vessel card → "AIS INTEGRITY" section** *(per-vessel detail; yes).* Trust score + tier badge + the
  specific flags with plain-language reasons ("reported position is 4 km inland", "implied 90 kt vs
  reported 12 kt"). Collapsible, like the Equasis dossier.

- **Vanguard Panel → new "INTEGRITY" tab *(the primary analytical surface; yes).*** A triage board
  listing every flagged vessel (score < TRUSTED), sorted by severity, with score + top reason +
  click-to-fly. Same pattern as the RF detector board. **This is the headline view** — the thing that
  answers "what can your tool do that others can't."

- **Watchlist → annotate, don't relocate.** Keep the watchlist user-curated, but show each watched
  vessel's integrity score/tier in its row, and optionally one-click "watch all SUSPECT". Integrity
  lives in its own tab; the watchlist just gains an integrity column.

- **Map → visible flag.** SUSPECT/QUESTIONABLE vessels get a colour-coded ring (reuse the existing
  anomaly-ring infrastructure in `entityBuilder`/`main.js`), so suspect vessels surface themselves
  without opening a card.

---

## 5. Module & wiring

- **New `integrityManager.js`** — owns `Map<mmsi, record>`. API:
  - `evaluate(vessel, violations, report)` — called from `aisManager.ingest` right after
    `checkPositionReport` (line ~359, where `violations` + `existing` vessel already exist). Adds
    on-land + MMSI checks, folds in kinematic violations, recomputes score.
  - `tick()` — periodic timer: loitering/STS + flag decay.
  - `getRecord(mmsi)`, `flagged()` (sorted list for the board), `score(mmsi)`.
  - Emits `vg1:integrityChanged` (board + card listen; never import managers into each other).
- **`config.js` → `INTEGRITY`** — weights, tier thresholds, on-land elevation cutoff, loiter radius/time, flag TTL.
- **`uiController.js`** — render the card section; build the INTEGRITY panel tab; add watchlist column.
- **`entityBuilder.js` / `main.js`** — drive the map ring colour from the vessel's tier (read-only in loop).

---

## 6. Build phases

1. **Engine:** `integrityManager.js` + `INTEGRITY` config + wire `evaluate()` into ingest. Verify scores
   via a synthetic scenario (on-land vessel, teleporter, SOG-faker) — unit-test the scoring like the
   invariants tests.
2. **Card:** "AIS INTEGRITY" collapsible section (score + tier + reasons).
3. **Panel tab:** INTEGRITY triage board (flagged list, sort, click-to-fly).
4. **Map + watchlist:** tier-coloured ring; integrity column in watchlist.
5. **(later)** false-flag cross-check with cached Equasis; v2 satellite cross-check.

## 7. Verification
- `tests/integrity.test.mjs` — feed crafted reports, assert scores/flags (mirror `invariants.test.mjs`).
- Synthetic scenario in `scenarios/` with planted anomalies; confirm the board lists them.
- Perf sanity: confirm no per-frame recompute (board reads cached records only).
