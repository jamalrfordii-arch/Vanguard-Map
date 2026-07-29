# VANGUARD1 — AI Discovery, duty officer pass
**2026-07-23 · duty officer only (scoped request), live app (http://localhost:3000/) + code**

Scoped explicitly to one persona and one feature, per the skill's allowance for that. Confirmed
the app was live and already running a genuinely active DISCOVERY session before touching
anything — `window.vg1Discovery.stats` showed real accumulated activity (34 passes, 33 Claude
calls, 139 rule findings, 0 Claude errors by the end of the session), not a cold/empty scene, and
`flight-proxy.js` (localhost:8787) answered a direct `/ai-query` POST rather than connection-
refusing, so the backend the AI layer depends on was genuinely reachable. I read
`research/ai-discover-data-scope.md` (the scoping memo for this feature) and today's earlier
`research/vanguard1-full-pass-2026-07-23.md` (all three personas, same day) first — the second one
already ran a duty-officer AI-Discovery trace and found a real, still-open bug (an unguarded
`ship.position.clone()` in `transitionManager.js:59` that crashes vessel-card rendering for
synthetic/aged-off vessels, corrupting the vessel card, the camera transition, and the watchlist
section all at once). That fix has not been applied (audits don't edit code) and I did not
re-run that exact repro this pass — instead I traced a *different* live decision end-to-end,
through a vessel that took the healthy, non-synthetic path, specifically to see whether the
"UI implies a choice, code already decided" gap the persona exists to catch shows up even when
nothing is crashing. It does, in a different, previously-undocumented shape, detailed below.

## Duty officer

The job here is to follow one decision from the moment it fires through to its actual, persisted
consequence — not to confirm a card renders. I picked a genuinely live, currently-pending
OPTIONS card (`pass-30` in `discoveryManager._pendingActions`, verified via
`window.vg1Discovery._pendingActions.keys()` before touching anything, confirming it really was
still awaiting a human decision, not already auto-run) proposing two actions for MMSI 244690555
("MSTX6"): `selectVessel({mmsi, openCard:true})` and `flagForNextShift({mmsi, note:"MULTI_SIGNAL
pattern: 7 alternating SPEED_ANOMALY + DARK events over 45min... High confidence AIS spoofing /
intentional masking. Recommend historical trajectory review and port authority notification."})`.
Before clicking anything I confirmed `window.watchlist.isWatched('244690555')` was `false` — the
action genuinely hadn't run yet, ruling out the "auto-executed before I looked" failure mode the
2026-07-22 fix was built to prevent. I then clicked **CONFIRM** on the live card myself (a real
click, not a console shortcut) and watched it flip to "✓ CONFIRMED — ACTIONS EXECUTED" with both
action log lines timestamped 7:01:15 AM — the Confirm/Dismiss gate itself still holds.

**Real, newly-found bug: the card the AI auto-opens for you doesn't show the flag it just wrote.**
`selectVessel` and `flagForNextShift` are two actions in the *same* confirmed batch, executed in
array order by `discoveryManager._executeActions()` (`discoveryManager.js:688-699`, iterating
the actions array — `selectVessel` registered at `:634-639`, `flagForNextShift` at `:656-661`).
`selectVessel` opens the vessel-detail card synchronously (dispatches `vg1:selectVessel`, which
`main.js` handles by calling `showVesselDetail()` then `window.watchlist.onCardOpen(mmsi)` at the
moment of open — call sites at `main.js:345` and `main.js:1293`). `flagForNextShift` runs *after*
that, calling `window.watchlist.add(mmsi)` — which genuinely persists (I read it back with
`window.watchlist.getNotes('244690555')`: the real note, correctly timestamped, present in
localStorage) — but nothing re-invokes `watchlist.onCardOpen()` for the card that's already open.
`watchlist.js` does dispatch a `vg1:watchlistChanged` event on `add()` (`watchlist.js:272`), and
`main.js` does listen for it (`main.js:1300-1316`) — but that handler only updates the 3D
selection-ring colour and dead-reckoning eligibility, never the open card's `#vd-watchlist-section`.
I checked, not assumed: immediately after CONFIRM, `document.getElementById('vd-watchlist-section')
.style.display` read `"none"` even though `isWatched('244690555')` was now `true` and a real note
existed. I then closed the card and re-opened the *same* vessel via the identical event
(`vg1:selectVessel`) — the watchlist section rendered correctly this time (`display:"block"`,
"★ WATCHLISTED", real alert-trigger checkboxes). That before/after test rules out a rendering
failure or missing feature — the watchlist section, the note, and the underlying data are all
fine; it's specifically that the auto-opened card is a stale snapshot taken one tool-call too
early. The **audit trail is trustworthy** (the DISCOVERY console log line for `flagForNextShift`
is accurate and timestamped correctly) — it's specifically the auto-opened card, the one surface
a duty officer would actually look at in the moment, that under-reports what just happened.

**Real, separate finding: two independently-correct subsystems disagree about the same vessel at
the same moment, and nothing on the card says so.** The same vessel card (MSTX6, MMSI 244690555)
shows an **AIS INTEGRITY badge reading "TRUSTED · 100 — No anomalies — AIS broadcast consistent"**
directly below the reason the operator just confirmed a spoofing escalation for it. I checked
whether this was the already-known "no record defaults to fake TRUSTED" bug
(`research/vanguard1-full-pass-2026-07-23.md`'s punch-list #2, `uiController.js:629-630`) — it
is not, for this vessel: `window.vg1Integrity.getRecord('244690555')` returned a real, genuinely-
computed record (`{flags:{}, score:100, tier:'TRUSTED'}`), and I confirmed the badge mechanism
can and does show real risk elsewhere in the same session (`OCEAN JUPITER` genuinely reads
`QUESTIONABLE · 70`). So `integrityManager.js` did its job correctly and found nothing wrong by
*its own* current-state rule set (dark/reappear/loitering/false-flag/invalid-MMSI, per the module
map in `CLAUDE.md`). Separately, `discoveryManager.js` builds its "developingStories" field — the
thing that fed this exact HIGH-confidence spoofing hypothesis — from its own independent
`_timeline` Map (`discoveryManager.js:140` init, `:222-223` recording, `:243-254` building the
snapshot field), which accumulates a vessel's anomaly-type history *across ticks*, something
`integrityManager`'s point-in-time flags don't track. Both subsystems are working exactly as
designed; the gap is that the one card an operator actually opens shows only the
`integrityManager` verdict, with no link back to the AI Discovery reasoning that triggered the
card opening in the first place. **I did also reconfirm, on a different vessel (SALVAMAR SHAULA,
MMSI 224833040), that the already-documented, still-open version of this bug is genuinely still
live**: `getRecord('224833040')` returned `null` (no record at all, not a clean one) while its
own OPTIONS card was concurrently proposing a HIGH-confidence "AIS spoofing / intentional
signature masking" hypothesis — same fabricated-TRUSTED symptom as the prior report, unchanged,
since no fix has shipped for it yet.

**Workflow-scale finding: the backlog of undecided cards is invisible.** At the point I started,
`window.vg1Discovery._pendingActions` held **29 separate, genuinely still-pending** action
batches (`pass-2` through `pass-30`, all lacking the `.disc-pending-done` marker that only appears
post-confirm) — real proposed actions, not stale artifacts, several of them for vessels still
actively transiting. The DISCOVERY tab label itself just reads `"DISCOVERY"`, with no count badge
anywhere reflecting how many decisions are outstanding. Given escalations were firing roughly
every tick over the session (34 escalations recorded), a duty officer arriving mid-shift has no
way to tell "there are dozens of undismissed AI recommendations sitting in the scrollback" without
manually scrolling the entire console history looking for cards without a "CONFIRMED" strip. Worth
noting honestly: some of this backlog may be carryover from the earlier full pass run the same day
in this same long-lived tab (the tab was backgrounded — `document.hidden` was `true` when I
started — consistent with it having been left open rather than freshly loaded), so the *count* of
29 shouldn't be read as "this always happens this fast." But the *absence of any indicator at all*
is a structural gap regardless of how the backlog got there — the mechanism to accumulate a large
number of un-actioned decisions clearly exists, and there is nothing warning an operator that it's
happened.

## Punch list, ranked

1. **Re-invoke `watchlist.onCardOpen(mmsi)` (or an equivalent partial re-render of
   `#vd-watchlist-section`) when `vg1:watchlistChanged` fires for the MMSI of the currently-open
   vessel card** — `main.js:1300-1316` already listens for this event and already has the mmsi
   comparison pattern it needs (used for the selection-ring colour update two lines above); it's
   missing the one extra call. Fixes the exact case where a confirmed AI action opens a card that
   doesn't show the escalation note that same action just wrote, live-verified on MMSI 244690555.
2. **Carry the already-open `TransitionManager.onLock()` / synthetic-vessel fix forward** — still
   the highest-severity open item from today's earlier full pass (`transitionManager.js:59`,
   unguarded `ship.position.clone()`); not re-tested this pass but no code has changed since it
   was found, so it should be presumed to still reproduce from a DISCOVERY MMSI link, an AI
   CONFIRM action, or opening a watchlisted-but-aged-off vessel.
3. **Give the vessel-detail card's AIS INTEGRITY section an explicit cross-reference to any live
   AI Discovery finding for the same MMSI** — even a one-line "⚠ AI DISCOVERY: flagged HIGH for
   AIS spoofing, Xs ago" next to the badge, so "TRUSTED · 100" and "just escalated for spoofing"
   never sit unexplained on the same card at the same time. Distinct from item #2's "no data ≠
   clean" bug — this is "two real, correct verdicts, no link between them."
4. **Surface the pending-decision count somewhere in the DISCOVERY tab UI** (a badge on the tab
   label, or a "N awaiting decision" strip pinned above the scrollback) — 29 real pending action
   batches were sitting unconfirmed with zero visible indicator this session.

## Innovation ideas

- **A single reconciled "trust" read-out per vessel**, combining `integrityManager`'s point-in-time
  flags and `discoveryManager`'s cross-tick `developingStories` pattern into one badge with two
  named contributing scores, instead of two separately-correct systems the operator has to know
  to cross-check manually. Matters specifically for the duty officer because the two systems
  disagreeing silently is worse than either one being wrong loudly.
- **A "pending decisions" drawer** — a dedicated, always-visible list of every unconfirmed
  options-mode pass (mmsi, hypothesis, age), separate from the scrolling console log, with
  Confirm/Dismiss right there. The console is a good audit trail but a bad task queue; a duty
  officer picking up a shift needs the queue, not the transcript.
- **A "resolved by" trace on the vessel card** — since `flagForNextShift` notes already carry the
  `[AI DISCOVERY]` prefix and the DISCOVERY console already timestamps every action, a link from
  the watchlist note back to the exact options card/pass that produced it (and vice versa) would
  turn "why was this flagged" from a manual console-scroll into a one click.
