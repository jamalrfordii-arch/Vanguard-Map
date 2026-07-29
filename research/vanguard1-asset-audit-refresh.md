# VANGUARD1 — Asset Audit Refresh

*2026-07-22 (same day, later) · supersedes Part 2 of vanguard1-research-plan-asset-audit.md*

The original audit was written from codebase inspection alone. Since then, the Method 1 walkthrough
actually ran against the live app (twice — a first pass and a fuller, mechanical pass) and six real
fixes shipped and were live-verified. This refresh updates only what changed; the visual/rendering
and data-feed-coverage pictures are unchanged from the original and aren't repeated in full below.

### Visual / rendering fidelity — unchanged

No work touched this layer today. Still solid (Natural Earth palette, LOD crossfade, border accuracy)
with the same two open gaps (`camera.near` city-scale block, continent-mesh/point-cloud fade drift
risk). Nothing new to report.

### Data layers & feeds — coverage unchanged, observability improved

The real gap identified last week still stands: only vessels have anomaly-*detection* logic behind
them; aircraft, satellites, cables, news, and space weather are all real data with nothing reasoning
over them. What changed today is narrower but genuine — *feed health visibility* widened from two
domains to five. The status bar previously only told you whether AIS or AIR were live; it now also
surfaces SAT, NEWS, and SPACE WX, each wired to that domain's real underlying signal (an existing
but previously-unsurfaced satellite status element, a new `feedManager.js` health export, and the
existing `spaceWeatherManager.js` broadcast, respectively). This doesn't add detection logic — a
collection lead still can't ask "is this aircraft behaving strangely," only "is the aircraft feed
even connected" — but it closes a real, adjacent trust gap the walkthrough surfaced live: two
different UI surfaces (the status bar and the AIR TRAFFIC panel) used to disagree about whether the
aircraft picture was current. They no longer do; the panel now flags itself `(feed offline — last
known)` when the underlying feed is down instead of silently showing a cached count.

### UI / workflow — three more real gaps closed

Building on the design-critique fixes already recorded (marker legend, DISCOVERY log signal/noise,
duplicate Atmosphere header), today's walkthrough found and closed three more, all live-verified:
alert-log flooding during a feed outage now collapses into an expandable group instead of burying
CRITICAL entries at equal visual weight; vessels referenced only by MMSI in DISCOVERY text are now
clickable, jumping straight to the vessel; and the cross-tab unread badge was confirmed already
working well (a rare "checked and it's fine" finding, not a gap).

The two structural gaps from the original audit stand unchanged: no visible "which OSINT phase
produced this" framing, and no cross-source correlation view. Both remain the honest answer to "what
would make this read as more of an analyst tool and less of a dashboard."

### AI Discovery / planning tools — a real maturity upgrade, not just more features

This is where today's work matters most for the planning-tool direction specifically. The walkthrough
found that options-mode cards — the actual "AI-driven courses of action" feature — were quietly
contradicting their own premise: a ranked menu implying a human weighs HIGH vs. MEDIUM vs. LOW, while
the code had already auto-executed the model's own top pick before anyone read it. That's now fixed:
proposed actions sit pending until a human explicitly confirms or dismisses them, live-verified
across all four trigger types with zero silent auto-execution in repeated, controlled testing.

This matters more than a bug fix. XRF's own pitch for the equivalent feature is literally "AI-driven
courses of action" — the value proposition depends on a human being able to trust that they're
actually choosing, not rubber-stamping something already done. Before today, VANGUARD1's version of
that feature technically rendered correctly but structurally undercut the "courses of action" framing
the moment a human paid attention to what the action log actually said. Phase 2 (aircraft behavior
detection) and Phase 3 (news correlation) from the original scope remain unstarted — but Phase 1 is
now not just built, it's trustworthy in the specific way this kind of feature needs to be.

---

## Updated prioritized recommendations

The original five-item list is unchanged in ranking — none of today's fixes substitute for it, they
run on a parallel track (workflow trust vs. new detection domains):

1. Aircraft behavior detection (AI Discovery Phase 2)
2. Dark Vessel Intel Ledger
3. News feed → snapshot wiring (AI Discovery Phase 3)
4. Cross-source correlation view
5. Provenance & Safety layer

One addition, ranked alongside #1 given how directly it now matters: **extend today's pending-action
confirm/dismiss pattern to any future tool the AI gets** (Phase 2's aircraft actions, Phase 3's news
correlation actions, if either grows tool-calling). The gating logic in `discoveryManager.js` is
already generic — `confirmActions(passId)`/`dismissActions(passId)` don't know or care what domain
proposed the action — so this is a "don't regress" note more than new work, but worth stating
explicitly now that the pattern exists and matters.
