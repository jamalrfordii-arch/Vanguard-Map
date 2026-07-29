# VANGUARD1 — Research Plan & Asset Audit

*2026-07-22 · audience: Jamal (sole builder/analyst today), with an eye toward future analysts*

---

## Why this looks different from a normal user-research doc

There's no user base yet — one person builds and uses VANGUARD1. Five to eight interviews aren't
available, so this substitutes two things a solo project can actually run: a structured
persona-based walkthrough (you role-play the analyst types the tool is built for, using a script
instead of intuition), and a lightweight plan for the day real analysts look at it. Both feed the
same asset audit below.

## Part 1 — Research plan

### Personas, grounded in the doctrine the codebase already implements

`memory/doctrine-osint-cycle.md` maps VANGUARD1's modules to a published 5-phase maritime OSINT
cycle (Identification → Collection → Processing → Analysis → Dissemination). Three personas cover
that cycle end to end:

| Persona | OSINT phase(s) | What they'd actually do in VANGUARD1 | What "success" looks like |
|---|---|---|---|
| **Watch analyst** | Analysis, Dissemination | Sits with the live map for a shift, reacts to alerts/DISCOVERY cards, checks the watchlist | Finds real anomalies fast, doesn't drown in noise, trusts what a card tells them |
| **Collection lead** | Identification, Collection, Processing | Decides which layers/feeds to trust, audits data quality, spot-checks a vessel's integrity flags | Can tell real signal from a coverage gap or feed glitch without digging into code |
| **Duty officer** | Dissemination → decision | Reads a DISCOVERY option card during a developing situation and picks a course of action | Card gives them enough to act, not just enough to notice |

The Duty officer maps directly to the course-of-action feature already built (options cards +
`addToWatchlist`/`flagForNextShift`) — it's the persona this session's work has served most
directly so far.

### Method 1 — self-run cognitive walkthrough (do this first, costs nothing)

For each persona, run a short scripted session against the live app and write down every point of
friction or confusion as if you were that person, not the builder:

1. **Watch analyst, 20 min:** open the map at a random real-world hour, let alerts/DISCOVERY fire
   naturally, don't intervene except to react to what the UI surfaces. Note anything you had to
   already know to interpret (tribal knowledge a real analyst wouldn't have).
2. **Collection lead, 15 min:** open Map Layers, toggle every layer off then on one at a time, ask
   "how would I know if this feed is stale or broken right now?" for each one.
3. **Duty officer, 10 min:** trigger `window.vg1Discovery.testOptionsMode(...)` for each of the
   four trigger types, read only the card (not the code), decide what you'd click, and note any
   card where the right action wasn't obvious from the text alone.

This is cheap, repeatable, and already caught real bugs this session (the design critique + its
three priority fixes came from exactly this kind of walkthrough).

### Method 2 — lightweight external validation (when you're ready for outside eyes)

Recruiting 5 people fitting "maritime/OSINT-adjacent" doesn't require a formal user pool — OSINT and
maritime-security communities (r/OSINT, Maritime Executive's reader base, open-source-intelligence
Slack/Discord groups, port-security LinkedIn groups) are used to being asked for a quick look at a
tool. A 20-minute unmoderated session works better than a live interview here since you're not
staffed for scheduling:

- Screen-record them narrating first impressions of the live map for 5 minutes, no prompts.
- Then ask them to find and interpret one DISCOVERY card, unprompted.
- Close with three questions: "what would you have expected to see that isn't here," "did anything
  feel like it was hiding information," "would you trust an option card enough to act on it."

Don't run this yet if the honest answer to "is my mapping accurate at close zoom" is still open —
you already flagged that as a prerequisite, and it's now been substantially exercised (25-location
sweep, oblique-fade fix, border-float fix). It's in reasonable shape to show someone.

---

## Part 2 — Asset audit

Audited directly against the codebase and `memory/decisions.md`, not aspirationally.

### Visual / rendering fidelity

| State | Detail |
|---|---|
| **Solid** | Natural Earth land palette, calmed bathymetry, tile/splat crossfade LOD (z3–z13), oblique-angle base-cloud fade, border-on-terrain accuracy (0.013 unit gap, matches intentional lift), empty-tile/black-hole fallback, ocean-triangle exclusion |
| **Known open gap** | True city-scale zoom is blocked by `camera.near = 1` (flagged 2026-07-12, still punchlisted — a real rework, not a quick fix) |
| **Known open gap** | Continent-mesh vs point-cloud fade thresholds can drift (documented known issue in CLAUDE.md); no new drift found this session but nothing prevents recurrence |
| **Not pursued (your call)** | Satellite-imagery cross-referencing for close-zoom verification — you decided to skip this while current mapping holds up; revisit only if a specific accuracy complaint surfaces |

This layer has had the most sustained investment of any asset category and it shows — most of this
session's bug reports (splats, gaps, borders) were regressions in an otherwise well-tuned system,
not first-time gaps.

### Data layers & feeds

Per `research/ai-discover-data-scope.md` (last week's audit, still current): vessels/AIS and
chokepoint traffic are real and richly instrumented (dark/reappear, loitering, integrity flags,
invariant gating). RF is real but narrow (distress beacons only — jamming/spoofing detection is
referenced in comments, not implemented). Aircraft, satellites, cables, news, and space weather all
have real data flowing into the map today with **zero anomaly-detection logic** behind any of them.
Political-event tracking doesn't exist in any form, not even stubbed.

The gap isn't data access — it's detection logic sitting on top of data you already have.

### UI / workflow

Recent fixes (marker legend, DISCOVERY log signal/noise, duplicate Atmosphere header) closed real,
user-visible gaps found via a structured critique. Two ideas from the doctrine file remain
explicitly unbuilt and still relevant: a visible "which OSINT phase produced this alert" framing,
and a cross-source correlation view (AIS track × ownership × port calls) — doctrine calls the
latter "the Analysis phase's core move," which is a strong argument it's underserved right now.

### AI Discovery / planning tools

This is the feature with the most momentum right now. Phase 1 (vessel-only options, four trigger
types, course-of-action tools) is live-verified end to end. `research/ai-discover-data-scope.md`
already scoped Phase 2 (aircraft behavior detection — port `integrityManager.js`'s pattern onto
`flightManager.js`, pure detection-logic work since the feed already exists) and Phase 3 (wire the
already-tagged news feed into the snapshot as a fifth domain) as the next real, buildable expansions
— both still unstarted.

---

## Prioritized recommendations

Ranked by (impact on the "planning tool" direction you're steering toward) ÷ (effort), using what's
already scoped rather than inventing new ideas:

1. **Aircraft behavior detection (AI Discovery Phase 2).** Real data already flows; this is pure
   detection-logic work mirroring code that exists. Highest leverage because it's the most concrete,
   already-scoped gap between what VANGUARD1 sees and what it reasons about.
2. **Dark Vessel Intel Ledger.** Scoped in `research/six-ideas-roadmap.md` back on 2026-06-12 as
   "high feasibility, ~1 session, build now" — and still hasn't been built over a month later. Cheap,
   zero new rendering cost, and it's the kind of pattern-over-time signal ("3 tankers dark near
   Hormuz in 6h") that a single-event alert system structurally can't surface. Worth resurfacing.
3. **News feed → snapshot wiring (AI Discovery Phase 3).** The tagging infrastructure already
   exists in `feedManager.js`; this is a snapshot-field change, not new plumbing.
4. **Cross-source correlation view.** Doctrine explicitly names this as the Analysis phase's core
   move and it's still missing. Bigger lift than the above three, but it's the piece most directly
   tied to "planning tool" credibility with a real analyst persona.
5. **Provenance & Safety layer.** Also scoped as "build now" in June and still not built. Lower
   urgency than the above since it matters most once you're sharing synthetic scenarios or exports
   with anyone else — worth doing before that happens, not necessarily before it.

Not recommended right now: general political-event tracking and open-ocean traffic-flow analytics
(both are real new projects per the data-scope memo, not extensions of what exists) and the
satellite-imagery verification idea you already tabled.
