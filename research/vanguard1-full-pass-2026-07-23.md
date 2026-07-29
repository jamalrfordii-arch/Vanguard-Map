# VANGUARD1 — Full professional pass
**2026-07-23 · all three personas, live app (http://localhost:3000/) + code**

Confirmed the app live before starting (scene/controls present, tab foregrounded and visible —
checked `document.hidden`/`visibilityState` first per the scar-tissue precedent) and confirmed
`flight-proxy.js` (localhost:8787) answering. Ran all three personas in rotation against the live
map over roughly 45 minutes of real elapsed time and multiple spaced checkpoints — not a single
click-through. Before starting, I read the four prior research memos on file
(`vanguard1-method1-walkthrough-findings.md`, `vanguard1-method1-fuller-pass.md`,
`vanguard1-asset-audit-refresh.md`, `vanguard1-ship-subsystem-audit.md`) plus `decisions.md` and
`scar-tissue.md` so I wasn't re-discovering old ground. Good news first: **every item on the two
prior punch lists is fixed and still holds live** — I re-verified each one rather than trusting the
memo. What follows is what's newly found this pass, plus what I explicitly re-confirmed working.
I did not get to satellites, submarine cables, or the space-weather/magnetic-field layers in depth
this pass — flagged as not-covered rather than silently skipped.

## Re-confirmed still fixed (not re-litigated as new findings)
Live-verified, not just grepped: the options-card pending Confirm/Dismiss gate (still holds — see
duty officer section below, where I used it for real), the SAT/NEWS/SPACE WX status-bar segments
(all three present and were genuinely OFFLINE/STALE this session — a real condition, not a
regression: `flight-proxy.js` itself answers fine, confirmed via a direct `fetch()` from the page
console, so the AIR feed's LIVE state and these three domains' down state are independent facts),
the ALERTS-tab grouping (`3x AIRCRAFT LOST SIGNAL`, `5x AIRCRAFT LANDED` collapsed rows while
CRITICAL `AERIAL CONFLICT` entries stayed individually listed), DISCOVERY's MMSI-linkify (253 live
links found on one card), and the AIR TRAFFIC panel's stale-tag — this last one I got to see fire
on a *real* transition, not a static state: partway through the session the AIR feed actually
dropped from LIVE to `PROXY OFFLINE`, and the panel correctly flipped to "297 aircraft (feed
offline — last known)" in the same tick the status bar went red. That's the collection-lead fix
from the last pass catching a real live event, which is the best kind of confirmation.

## Watch analyst
Sat with a genuinely live DISCOVERY console (not synthetic — 25 rule ticks, 91 rule findings, 22
Claude escalations, 0 Claude errors over the session) and read an active OPTIONS card cold: HIGH
"independent vessels each reacting to the same external event," MEDIUM "detection/data artifact,"
reasoning that named the actual evidence (three vessels flagged DARK inside an English Channel
closure state with 23 tracked/9 dark) rather than asserting a verdict — still reads like real
analyst reasoning, consistent with the original walkthrough's finding.

**Real bug, found by actually clicking a reference the way an analyst would.** The RULE line `1
dark vessel transiting SUEZ CANAL (2 tracked, state closure) — MMSI 219632000` has a clickable MMSI
(the 2026-07-22 fix). Clicking it does what a watch analyst would do at 2am to sanity-check a dark
contact — and opens a vessel-detail card with **every field blank** (CLASS/SPEED/HEADING/LAT/LON/
REGION/FLAG all `—`) and an **AIS INTEGRITY badge reading "TRUSTED · 100 — No anomalies," which is
fabricated reassurance, not an assessment** — `uiController.js:629-630` defaults `score`/`tier` to
`100`/`'TRUSTED'` whenever `integrityManager.getRecord(id)` returns nothing, with no way to tell
"verified clean" apart from "never assessed." I didn't stop at "looks wrong" — I checked
`window.aisShips` (no match for that MMSI) and the console, which showed a real uncaught exception:
`TypeError: Cannot read properties of undefined (reading 'clone') at TransitionManager.onLock
(transitionManager.js:59:47)`. Root cause, read from source: `main.js`'s `vg1:selectVessel`
handler (~line 1250) has three fallback tiers for opening a card — object in the live 3D scene,
then `aisManager.vessels.get(mmsi).threeObject`, then a **synthetic placeholder object**
(`main.js:1276-1292`) built when neither exists. The synthetic only sets `{userData: {...}}` — it
never sets `.position`. `showVesselDetail()` unconditionally ends with
`window.transitionMgr?.onLock(ship)` (`uiController.js:1159`), and `onLock` does
`ship.position.clone()` (`transitionManager.js:59`) with no guard. For any MMSI that's aged off the
live feed entirely (which a "dark vessel" reference very often is, by definition), this throws.

**Watch analyst tool gap, separate finding:** Asset Search (top-right, "callsign · MMSI · country")
does not do what the label implies for finding an entity fast. Typed `HITACHI` (a confirmed live
vessel, pulled straight from `window.aisShips`) — no dropdown, no camera fly-to. It correctly showed
`1 MATCH` in a small counter and set every other vessel/aircraft `.visible = false`
(`uiController.js:155-177`, `applySearchFilter`/`tickSearchVisibility`) — a real, working filter —
but if that one match is on the other side of the globe from the current camera, the analyst now
has a *correctly isolated* dot they still have to manually hunt for on an otherwise-empty map. DISCOVERY's
MMSI links and Sector Search both actually fly the camera; Asset Search doesn't, despite sitting
right next to tools that do.

## Duty officer
Traced a live options card all the way through, the way the role requires. Card proposed
`selectVessel({"mmsi":"305530000","openCard":true})` behind a Confirm/Dismiss strip — confirmed the
gate is real by reading it cold, clicking CONFIRM, and watching the card correctly flip to
"✓ CONFIRMED — ACTIONS EXECUTED" (the 2026-07-22 fix genuinely holds under a fresh, real pass, not
just in isolated regression testing).

**But following the actual consequence through is what surfaced the real severity of the bug watch
analyst found above.** Confirming re-fires the identical code path (`discoveryManager.js:701` →
`main.js:1292` → `showVesselDetail` → `transitionManager.js:59`), console showed the same
uncaught `TypeError`, confirmed via full stack trace this time. The material consequence: in
`main.js`'s tertiary branch, `showVesselDetail(synthetic, ...)` and `window.watchlist?.onCardOpen(mmsi)`
are two adjacent statements with no `try/catch` between them (`main.js:1292-1293`). Because the
exception throws *inside* `showVesselDetail` (at its last line), **the very next statement —
`onCardOpen`, which is what shows the watchlist notes/checkboxes/remove-button section — never
runs.** I proved this isn't a hunch: I opened YASMIN (a vessel genuinely on the watchlist since
the earlier 2026-07-22 walkthrough, real persisted notes confirmed via
`window.watchlist.getNotes('710007453')` — both the original AI escalation note and a second one
were there, verbatim, localStorage survived across sessions correctly) and its card rendered with
**no watchlist section at all** — `document.getElementById('vd-watchlist-section').style.display`
read `"none"`, `isWatched('710007453')` read `true`. The data is intact; the UI has no way to show
or remove it once this crash fires, and the crash fires for exactly the kind of vessel (aged off
the live feed, dark, or otherwise not in the current 500-vessel roster) a duty officer would most
need to check on. This is one root cause producing three symptoms across three files (blank
telemetry + fabricated TRUSTED badge, silent camera-transition failure, and a watchlist card that
can't be read or cleared) — not three separate bugs.

## Collection lead
Checked feed trust the way the role does — status bar first, not individual layers. AIS/AIR/SAT/
NEWS/SPACE WX all show real, currently-differentiated states (confirmed above). RF tab: `NO
DETECTORS REGISTERED · 0 INFO · 0 WATCH · 0 ALERT · NO RF EVENTS` — an honest, explicit "nothing
here" rather than a silently-empty panel, which is exactly what a collection lead needs to
distinguish "no data" from "feed broken." Cables/satellites domains weren't reached this pass
(logged above as not-covered, not as clean).

Toggled Sea State and Surface Wind directly in Map Layers: both rendered instantly, correctly
(a MAP KEYS legend auto-appeared for both), no console errors, no lag — mechanical spot-check,
clean. AI backend health (`CLAUDE OK 22 · CLAUDE ERR 0` on the DISCOVERY tab across the session) is
itself a collection-lead-relevant fact worth recording: the Gemini call-budget breaker from
`scar-tissue.md` never tripped this session, so 22 real escalations processed cleanly start to
finish.

**Minor UI friction, not a bug:** on first load, two different floating panels are both titled
"VANGUARD PANEL" (`#ui-layer`'s system-status widget and the tabbed `#vanguard-panel` with
VESSELS/WATCHLIST/ALERTS/etc.) and default to nearly the same screen position, with the tabbed one
starting collapsed and mostly hidden behind the other. Took several minutes of exploration to find
the actual DISCOVERY/ALERTS/WATCHLIST tabs were in a *second*, differently-behaved panel with the
same name — a real analyst opening this for the first time would hit the same confusion.

## Punch list, ranked

1. **Guard `TransitionManager.onLock()` against a `ship` with no `.position`** (or, upstream, give
   the `main.js:1276-1292` synthetic fallback object a real `.position`, even a dummy one) — this
   single fix clears the blank/fabricated-TRUSTED vessel card, the silent camera-transition crash,
   AND the broken watchlist-notes section, all three of which trace to the same unguarded
   `ship.position.clone()` at `transitionManager.js:59`. Currently reproducible from three different
   entry points (DISCOVERY MMSI link, AI CONFIRM action, and opening a watchlisted-but-aged-off
   vessel), all real, all live-verified this session — highest priority given the number of
   workflows it silently breaks.
2. **Make `renderIntegrity()` (`uiController.js:629-630`) distinguish "no record exists" from
   "assessed and clean"** — right now both render identically as `TRUSTED · 100`, which is
   misleading specifically for the dark/off-roster vessels a duty officer most needs to trust the
   read on. A simple "NO DATA" state (distinct color/label) instead of defaulting to TRUSTED would
   fix this independent of item #1.
3. **Give Asset Search a fly-to-match action** (Enter key, or auto-fly on a single match) to match
   the behavior DISCOVERY links and Sector Search already have — right now it isolates the one
   matching entity but leaves the analyst to hunt for it manually if it's off-screen.
4. **Rename or reposition one of the two "VANGUARD PANEL" widgets** so they're distinguishable at a
   glance — small, but real first-open friction, same class of fix as the WX→SPACE WX relabel
   already shipped.

## Innovation ideas

- **A "why is this blank?" state for vessel-detail fields**, not specific to the bug above: any
  time a card shows a placeholder/synthetic object (aged off the feed, never live-tracked, etc.)
  the card could say so explicitly ("last known: none — vessel not currently tracked") instead of
  rendering empty dashes that read as a loading state. Useful independent of whether item #1/#2
  above ship, because "why are all these fields blank" is itself a legitimate question a duty
  officer needs answered fast, not inferred from silence.
- **A "last N days" mini-history strip on the vessel-detail card** for anything AI-flagged or
  watchlisted — the note text and the raw AIS feed already both exist (localStorage notes,
  chokepoint dark-vessel snapshots); nobody has built a single place that shows "flagged → dark →
  reappeared → flagged again" as a timeline. Duty officers currently have to reconstruct that story
  by reading DISCOVERY log lines and watchlist notes separately.
- **A single "feed health" console API** (`window.vg1FeedHealth()` or similar) that returns the
  live/stale/offline state of every domain (AIS/AIR/SAT/NEWS/SPACE WX/RF/cables) as one object —
  right now a collection lead auditing trust has to look at three different UI surfaces (status
  bar, RF tab, Map Layers) to get the full picture; this pass would have been faster with one.

## What I didn't cover

Satellites, submarine cables, magnetic-field/Birkeland/ionospheric layers, the zone-recorder
workflow, and SITREP were not exercised this pass — no findings for or against those, not silently
clean.
