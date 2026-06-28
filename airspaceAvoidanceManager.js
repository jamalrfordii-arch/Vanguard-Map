// airspaceAvoidanceManager.js — SCOPING DOC ONLY, NOT IMPLEMENTED (task #12)
//
// This file is deliberately not imported anywhere. It's the design output
// for "scope airspace-avoidance war signal detection" — Jamal's idea that a
// sharp drop in overflight density over a region, vs. that region's own
// recent baseline, is a usable proxy for airspace closure/conflict (NOTAM
// closures, active SAM threats, declared war zones). Civil traffic reroutes
// around these almost in real time, often ahead of news coverage — which is
// also why task #13's aviation news feed (aviationNewsManager.js) is a
// natural corroborating signal once this is built: "cell X went quiet" +
// "news mentions airspace closure near X" is a much stronger signal than
// either alone.
//
// Config knobs already added: AIRSPACE_AVOIDANCE in config.js.
//
// ── Data model ────────────────────────────────────────────────────────────
// A Map<cellKey, CellHistory> where cellKey = `${latBucket},${lonBucket}`
// (latBucket/lonBucket = Math.floor(deg / AIRSPACE_AVOIDANCE.GRID_DEG)).
//
// CellHistory = {
//   samples: Map<hourOfDay (0-23), number[]>  // rolling occupancy counts, one bucket per hour-of-day so we compare like-for-like (3am traffic is naturally low; that's not a signal)
//   current: number                            // live occupancy count, refreshed every AIRSPACE_AVOIDANCE.SAMPLE_INTERVAL_MS
//   flaggedSince: number | null                 // sim-time ms when this cell first dropped below threshold, or null
// }
//
// ── Algorithm ─────────────────────────────────────────────────────────────
// 1. Every SAMPLE_INTERVAL_MS: bucket every live aircraft in window.aisShips
//    into its grid cell by current lat/lon. Push each cell's count into
//    samples[hourOfDay], capped to BASELINE_WINDOW_HR / SAMPLE_INTERVAL_MS
//    entries per hour bucket (oldest evicted first — simple ring buffer).
// 2. For each cell with >= MIN_BASELINE_SAMPLES for the current hour bucket:
//    baseline = average(samples[currentHour])
//    if baseline < MIN_BASELINE_COUNT: skip (open ocean / already-quiet
//      airspace, a drop to zero there isn't informative)
//    dropPct = (baseline - current) / baseline * 100
//    if dropPct >= DROP_THRESHOLD_PCT: this cell is a candidate
// 3. Candidates only become an alert after GRACE_HR of sustained drop
//    (flaggedSince tracks first candidate tick; promote to alert once
//    now - flaggedSince >= GRACE_HR). This filters out a single bad ADS-B
//    coverage gap or a brief lull, same grace-period principle as
//    conflictManager.js's GRACE_MS, just on a much longer timescale.
// 4. On promotion: dispatch 'vg1:airspaceAvoidance' with { cellKey, lat, lon,
//    baseline, current, dropPct, since }. main.js/alertsManager.js would
//    consume this the same way AIRCRAFT_CONFLICT alerts are consumed today.
//
// ── Open questions / risks (why this is scope-only, not built yet) ───────
// 1. Persistence: 7 days of hourly-bucketed history per cell needs to survive
//    page reloads to be useful (a fresh page load has zero baseline and would
//    take a week to become meaningful). localStorage is the existing pattern
//    (feedManager.js, watchlist.js) but 7 days × 24 hours × N cells could get
//    large depending on GRID_DEG — needs a size check before committing to
//    that approach versus a lightweight server-side store via flight-proxy.js.
// 2. Cold start: there is no seed data. The very first deployment has no
//    baseline at all for ~24h minimum (MIN_BASELINE_SAMPLES=12 at one sample
//    per hour-bucket per day means day 1 produces only 1 sample/bucket).
//    Practically this means the feature is silent for its first week unless
//    we backfill from a historical flight-data source, which is a separate
//    integration decision.
// 3. False positives from receiver coverage, not airspace closure: ADS-B/
//    MLAT coverage itself can dip (ground station outage, satellite ADS-B
//    feed hiccup) and look identical to a real traffic drop. Nothing in this
//    design distinguishes "the sky emptied" from "we stopped hearing the
//    sky." A real implementation likely needs a coverage-confidence input
//    (e.g. is the receiver network reporting nominal counts in NEIGHBORING
//    cells right now?) before promoting a drop to an alert.
// 4. Grid edges: a corridor or border that sits on a cell boundary could
//    have its traffic split across two cells, diluting the drop in both
//    rather than showing fully in either. GRID_DEG=2 is a starting guess;
//    tuning this against real closure events (a known NOTAM date range) is
//    the right way to validate it, not guessing.
// 5. No country/region labeling: cells are coordinates, not place names. A
//    real alert needs reverse-geocoding (or finally importing country
//    polygon data) to say "airspace over Eastern Ukraine" instead of a lat/
//    lon pair an analyst has to look up.
//
// ── Suggested build order, when this moves from scope to build ───────────
//   a. Land the sampling/baseline loop (steps 1-2 above) with NO alerting —
//      just populate window.vg1AirspaceAvoidance for console inspection, let
//      it run a few days, eyeball whether real-world closures (there's
//      usually at least one active NOTAM-driven reroute somewhere) show up
//      as a visible dip before wiring any UI to it.
//   b. Only then add the GRACE_HR promotion + alert dispatch + panel UI —
//      same order conflictManager.js followed (engine first, alert type
//      second, per tasks #10 → #11 in the task list).
