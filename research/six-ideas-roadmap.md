# VANGUARD1 — Six-Idea Roadmap

Design document for the six features selected from the council review (2026-06-12).
All builds sit on the SimClock + DataSource layer (`simClock.js`, `dataSource.js`).

| # | Feature | Origin | Feasibility | Effort | External data |
|---|---------|--------|-------------|--------|---------------|
| 1 | Dark Vessel Intel Ledger | Jamal (revised from ghost tracks) | **High — build now** | ~1 session | None (GFW optional, free) |
| 2 | Provenance & Safety Layer | Sokolov (security) | **High — build now** | ~1–2 sessions | None (C2PA lib optional) |
| 3 | Timeline Sensitivity Forks | Whitfield (historiography) | Medium | ~3–4 sessions | None (uses own captures) |
| 4 | Anomaly-Gated Recaps | Marchetti (media studies) | Medium | ~3–4 sessions | None (uses own baseline) |
| 5 | Satellite Maneuver Detection | Adeyemi (astrodynamics) | Medium — needs data accumulation lead time | ~3 sessions + weeks of TLE snapshots | Space-Track account (free) |
| 6 | Ledger-vs-Water Gap | Vogel (economic sociology) | Research project | ~5+ sessions | UN Comtrade (free tier) + GFW (free) |

---

## 1. Dark Vessel Intel Ledger — list, not lines (revised 2026-06-12)

**Decision.** Ghost-track rendering struck: not worth the draw calls. Dark
vessels get *recorded and ranked*, not traced.

**Concept.** When a vessel goes dark it enters a persistent intel ledger — a
HUD list and a localStorage log: name, MMSI, class, flag, last position,
heading/speed at loss, time dark, nearest chokepoint/port, watchlist status.
On reappearance the entry closes with gap duration and displacement (how far
it moved while silent — large displacement during silence is itself a flag).
Zero scene geometry; one DOM panel.

**Architecture.**
- Extend `alertsManager.js` or a small `darkLedger.js`: subscribes to dark/
  reappear events, maintains the ledger, persists to localStorage
  (`vg1_dark_ledger`).
- Ranking: dark-in-chokepoint > dark-on-watchlist > tanker > others; ledger
  sorted so the suspicious silences surface.
- Feeds the copilot: ledger summary becomes context for SITREP and anomaly
  prompts ("3 tankers dark near Hormuz in past 6h" is a *pattern*, invisible
  when each event is a transient alert).
- Optional cross-check: Global Fishing Watch Events API publishes real AIS-off
  gap events — validates our detection thresholds against an independent source.

**Risks.** Minimal. AIS reception gaps (terrestrial coverage holes) will pollute
the ledger with false "dark" events → note the region's reception quality
alongside each entry; displacement-on-reappear helps separate coverage gaps
(vessel continued normally) from deliberate silence (vessel deviated).

---

## 2. Provenance & Safety Layer — synthetic marking + real-vessel protection

**Concept.** Two halves. (a) *Synthetic provenance*: formalize the reserved
`999…` MMSI prefix, badge synthetic vessels in every UI surface, and sign
exports. (b) *Real-vessel safety*: a delay/fuzz policy for sensitive vessel
classes, since rebroadcasting live positions has real piracy/crew-safety
implications (vessels in high-risk areas already go dark deliberately under
SOLAS Article 21 allowances).

**Architecture.**
- `dataSource.js`: `SyntheticAISSource` hard-enforces the `999` prefix (refuses
  to emit otherwise); injects `_synthetic: true` into MetaData.
- `aisManager.ingest()`: stamps `vessel.synthetic` from that flag — the one
  permitted place where sources are distinguishable, existing solely so the UI
  can label truth.
- UI: SYN badge in tooltip, vessel tab, ship list, SITREP (uiController +
  vesselTab + sitrepManager touchpoints). Synthetic trails rendered dashed.
- Exports: recorder NDJSON gains a manifest header line
  `{type:'vg1-manifest', sources:[...], synthetic_mmsi_ranges:[...], sha256}`.
  Screenshots/exports get C2PA Content Credentials via the `c2pa-js` WASM
  library (verifiable in-browser, no server) — phase 2.
- Safety policy: `SAFETY = { DELAY_CLASSES, DELAY_MS, FUZZ_NM }` in config.js —
  e.g. delay/fuzz display of tankers inside defined high-risk-area polygons.
  Display-only transform applied at render, never to stored data.

**Risks.** C2PA signing needs a key/cert story — self-signed is fine for v1.
Delay policy is a product decision (what classes, what areas) more than code.

---

## 3. Timeline Sensitivity Forks — counterfactuals as sensitivity analysis

**Concept.** Not "what would have happened" (unknowable past a short horizon)
but "which moments were load-bearing": branch a recorded timeline at time T,
perturb one event (remove a vessel, close a chokepoint), run N short forks, and
measure divergence. Output: a ranked list of the day's most consequential moments.

**Architecture.**
- `simClock.js` gains `fork()` → returns a child clock with independent
  rate/offset (parent untouched). Small, additive change.
- New `forkManager.js`: snapshot vessel-state Maps (serialize the plain fields,
  skip THREE objects — rebuilt on restore), restore-into-branch, run a
  `RecordedAISSource` + optional `SyntheticAISSource` perturbation against the
  fork clock, headless (no render) at high rate (e.g. 600×).
- Divergence metric v1: mean haversine displacement of common vessels between
  branch and baseline at T+horizon; plus count of alert-zone breaches delta.
- UI later: timeline strip with branch markers; v1 is console-driven
  (`vg1Fork.run(captureUrl, perturbation, horizonMin)`).

**Dependencies.** Needs captures (AISRecorder — done) and benefits from ghost
tracks' hypothesis machinery for perturbation realism.

**Risks.** Headless fast-forward must not touch the live scene — strict
separation between branch state and rendered state. Divergence in a sparse
capture is noisy → require minimum vessel counts.

---

## 4. Anomaly-Gated Recaps — the documentary that mostly stays silent

**Concept.** A nightly recap renders ONLY when the day statistically deviates
from baseline. Narration is hedged by design, and every claim links to a
timestamp in the day's capture.

**Architecture.**
- New `baselineManager.js`: maintains rolling per-region stats (vessel counts,
  dark events, chokepoint transits, alert counts) in IndexedDB; daily z-scores
  against a 14-day window.
- Gate: recap pipeline runs only if any |z| exceeds threshold (config:
  `RECAP = { Z_THRESHOLD, MIN_BASELINE_DAYS }`).
- Pipeline: baseline summary + day's alert log + capture excerpts → aiCopilot
  (existing `localhost:8787` Claude proxy) with a constrained prompt: hedged
  language required, every sentence must cite a `t=` timestamp; output rendered
  as a SITREP-style overlay; directorManager flies the camera to each cited
  moment in sequence. Video export via MediaRecorder API — phase 2.
- Each claim's timestamp is clickable → `simClock.setTime(t)` + replay. The
  recap is falsifiable by construction.

**Dependencies.** Recorder (done), baseline accumulation (needs ~2 weeks of
runtime before the gate has meaning), forks optional but synergistic.

**Risks.** LLM narration inventing significance is the failure mode this exists
to prevent — the citation requirement is the control; reject any output
sentence lacking a resolvable timestamp.

---

## 5. Satellite Maneuver Detection — TLE history diffing

**Concept.** Satellites that change orbit chose to. Diff successive element
sets per object; flag deltas exceeding per-regime thresholds; render the old
orbit ghosted behind the new one with a confidence label.

**Data.** Space-Track (free account, user agreement) — the `gp_history` class
exposes 138M+ historical element sets. Note an ecosystem wrinkle: 5-digit
catalog numbers exhaust around July 2026, after which new objects get 6-digit
IDs unavailable in legacy TLE format — consume the OMM/JSON format from day
one, not TLE text. Until history access is plumbed, self-accumulate: persist
daily GP snapshots (the existing `localhost:8787/satellites` proxy already
fetches them) into IndexedDB — analysis becomes possible after ~2–4 weeks.

**Architecture.**
- Proxy gains a snapshot cron (server-side, append-only NDJSON per day).
- New `maneuverManager.js`: per-object time series of mean motion, inclination,
  eccentricity; detection = change exceeding k·σ of that object's own history
  (thresholds per regime: LEO/MEO/GEO behave differently — config
  `MANEUVER = { K_SIGMA, REGIME_BANDS }`). Every flag carries a confidence, per
  Adeyemi's warning: drag and solar weather (already fetched by
  spaceWeatherManager — correlate!) produce natural element drift.
- Render: ghost arc = satArcManager pattern with pre-maneuver elements, dashed,
  fading over 48h sim time.

**Risks.** False positives are the whole game. Calibrate on objects with known
behavior (ISS reboosts are documented and frequent) before trusting any flag.

---

## 6. Ledger-vs-Water Gap — paper flows vs observed flows

**Concept.** Don't trace cargo as dye (implies false physical certainty).
Compare *declared* trade flows (customs ledgers) against *observed* shipping
flows (AIS port calls + chokepoint transits). The discrepancy is the signal.

**Data.**
- UN Comtrade: free tier = 500 calls/day, 100K records/call via
  comtradedeveloper.un.org — monthly bilateral flows by HS code. Enough for
  corridor-level analysis (e.g. crude oil, HS 2709, by partner country).
- Global Fishing Watch Events API (free key): port visits, loitering,
  encounters (STS transfer proxies), AIS-off gaps — the "water" side,
  pre-computed.
- Own AIS observations: port calls inferred from portManager proximity +
  speed≈0 dwell.

**Architecture.**
- Server-side aggregation (extend the existing proxy — this is fetch-heavy and
  must not run in the render loop): monthly corridor matrix
  {origin, destination, commodity} × {declared_value, observed_transits}.
- New `gapManager.js`: renders corridors as arcs colored by gap magnitude;
  click → time series panel.
- v1 scope: ONE commodity (crude), ONE region (e.g. Gulf → East Asia), monthly
  resolution. Generalize only after the pipeline proves out.

**Risks.** Unit reconciliation (declared $ or kg vs counted transits) is
genuinely hard — expect a research phase. Comtrade reporting lags months;
this layer is structurally retrospective, not live. Frame it as such in UI.

---

## Build order & dependency graph

```
            ┌─ 1. Dark Ledger ───────┐
 (shipped)  │                        ├─→ 3. Forks ──→ 4. Gated Recaps
 SimClock ──┤  2. Provenance/Safety ─┘         (needs baseline accrual)
 DataSource │
            ├─ 5. Maneuver Detection  ← start snapshot accumulation NOW
            └─ 6. Ledger Gap          ← start Comtrade/GFW key signup NOW
```

1. **Dark Ledger** — one session, zero rendering cost, validates against SYN
   GHOST CHARLIE immediately.
2. **Provenance/Safety** — small, touches UI broadly, should land before any
   synthetic content gets shared anywhere.
3. **Start the two slow clocks in parallel**: TLE snapshot accumulation (one
   proxy cron) and baseline stats accumulation (one manager) — both are cheap
   to start and gate later features on weeks of data.
4. **Forks**, then **Gated Recaps** (recaps consume baseline + capture + fork
   machinery).
5. **Ledger Gap** last — genuine research project; prototype offline in a
   notebook before any rendering.

## Sources

- [Space-Track documentation](https://www.space-track.org/documentation) — gp_history class, account requirements
- [CelesTrak GP data formats](https://celestrak.org/NORAD/documentation/gp-data-formats.php) — catalog number exhaustion, OMM formats
- [UN Comtrade developer portal](https://comtradedeveloper.un.org/) — free tier limits
- [comtradeapicall (official Python lib)](https://github.com/uncomtrade/comtradeapicall)
- [Global Fishing Watch APIs](https://globalfishingwatch.org/our-apis/) — Events API: encounters, loitering, port visits, AIS-off gaps
- [C2PA explainer](https://spec.c2pa.org/specifications/specifications/2.4/explainer/Explainer.html) — manifest/signing model; c2pa-js for in-browser verification
- [Maritime Executive — encrypting vessel ID vs piracy](https://maritime-executive.com/editorials/encrypting-vessel-id-data-can-thwart-maritime-piracy) — safety context for the delay/fuzz policy
