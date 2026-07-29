# VANGUARD1 — Method 1, Fuller Pass

*2026-07-22 · follow-up to vanguard1-method1-walkthrough-findings.md, run after the four fixes*

Ran each persona again, wider than the first pass: watch analyst over several spaced checkpoints
instead of one glance, collection lead toggling layers mechanically instead of eyeballing the panel,
duty officer through all four trigger types instead of one.

## Watch analyst — spaced checkpoints

Over roughly 80 seconds of real elapsed time, the local rule engine ticked once more (no Claude call
— handled locally) and the Claude-escalation counters didn't move. That matches the project's own
design intent (`six-ideas-roadmap.md`'s "Anomaly-Gated Recaps" concept: mostly silent, speaks when it
has something). A watch analyst should expect long quiet stretches punctuated by rare passes, not a
constant stream — worth knowing going in so silence doesn't read as "is this broken."

Two things worth recording as genuinely working well, not gaps: the ALERTS tab's unread badge
(capped at "99+") stayed visible from the DISCOVERY tab the whole time, so a watch analyst absorbed
in one tab still gets a glance-able signal that alerts are piling up elsewhere. And the AIR feed had
a real, persistent outage this session — it correctly and consistently showed AIR OFFLINE the entire
time, no flicker.

## Collection lead — mechanical per-layer toggle

Toggling Surface Wind and Sea State on/off directly: both instant, no lag, no console errors.

Two real findings, one about the app and one about my own fix:

- **The AIR TRAFFIC panel's aircraft count disagreed with the status bar.** While the bottom bar
  consistently read `AIR OFFLINE`, the HUD's "AIR TRAFFIC" count flipped between 0 and 300 across
  checks — sometimes showing a live-looking number while the feed itself was down. A collection lead
  glancing at just the count, not the status bar, could reasonably believe the aircraft picture is
  current when it isn't.
- **My own new WX indicator is mislabeled.** It reflects space weather (Kp/AE/solar wind — the
  `spaceWeatherManager.js` feed) specifically, not the Surface Wind/Storm Warnings/Jet Stream map
  layers, which come from a completely separate feed (`gfsWindManager.js`). Toggling Surface Wind on
  didn't move WX's indicator at all, which is correct behavior but a confusing label — a collection
  lead would reasonably read "WX" as covering the wind layer they just turned on. Should be relabeled
  `SPACE WX` or similar rather than left as-is.

## Duty officer — all four trigger types

Ran STS_GROUP, MULTI_SIGNAL_VESSEL, CROSS_DOMAIN, and COORDINATED_MULTI_VESSEL. All four rendered
ranked, grounded options; wherever the model proposed actions, the Confirm/Dismiss strip appeared and
worked correctly every time. COORDINATED_MULTI_VESSEL's proposed note was genuinely well-written —
"Multi-signal anomaly: DARK_VESSEL + SPEED_ANOMALY in JERSEY chokepoint within 57s window; clustering
pattern suggests possible AIS spoofing or evasion" reads like something a real analyst would write,
not template filler.

One process note worth being transparent about: partway through, two cards appeared to have already
auto-executed their actions without a click, which looked like the pending-action gate had a bug.
Traced it down properly rather than assuming — fired two test passes back-to-back with no clicks in
between and checked `_pendingActions.size` before and after each; both correctly stayed pending
(size went 0→1→2, no auto-resolution). The earlier appearance was self-inflicted: a click aimed at an
MMSI link landed on a different card's Confirm button after the panel auto-scrolled between when I
read coordinates and when I clicked. Documenting this because it's exactly the "verify against live
state, don't trust the first appearance" discipline the project already expects — a false alarm ruled
out properly is worth recording, same as a real bug.

## Updated punch list

1. Relabel the WX status-bar segment (e.g. `SPACE WX`) so it doesn't read as covering the wind map
   layers — small, but exactly the kind of ambiguity a collection lead would trip on.
2. Reconcile the AIR TRAFFIC count with the AIR feed's live/offline state — it should read 0 or show
   a stale marker when the feed is down, not a cached number that looks current.

Everything else from the original punch list is closed and held up under the fuller pass.
