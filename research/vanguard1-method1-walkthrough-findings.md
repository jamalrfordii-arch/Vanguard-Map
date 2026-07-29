# VANGUARD1 — Method 1 Walkthrough Findings

*2026-07-22 · live session against the running app, no code changes yet*

Ran the three scripted persona passes from the research plan against the live map, which happened
to have real DISCOVERY activity in progress — better than synthetic, since every observation below
is what actually rendered, not a staged test.

## Watch analyst

A live options card for MMSI 710007453 (YASMIN) was mid-render: 4 ranked hypotheses (HIGH "AIS
spoofing / intentional signature masking," MEDIUM "genuine equipment failure," MEDIUM "deliberate
evasive maneuvering," LOW "benign operational correction"), each with a real analyst-grade reasoning
paragraph, not filler. Reading it cold:

- **Good:** the reasoning genuinely argues against the lower-ranked options too ("benign corrections
  don't typically produce sustained dark-vessel state," "equipment failure wouldn't precede AIS
  dropout in this order") — it reads like a real analyst weighing alternatives, not a single verdict
  dressed up as four.
- **Friction — the raw RULE-fired log lines below the card are a wall of undifferentiated text.**
  Six lines like `RULE ⬥ 3 dark vessels transiting STRAIT OF GIBRALTAR (3 tracked, state closure) —
  MMSI 249258000, 305896000, 255916103` stack with identical styling — no line breaks between
  entities, no vessel names, just raw MMSI digit strings. Skimming this at 2am, nothing helps you
  tell "routine chokepoint chatter" from "the thing I should look at" except reading every line.
- **Friction — no way to jump from an MMSI to the vessel.** Every RULE line and reasoning paragraph
  refers to vessels by MMSI only. There's no click-to-select on an inline MMSI, so verifying "is
  249258000 actually near Gibraltar right now" means manually searching for it elsewhere in the UI.

## Duty officer

Followed the same card down to its action log and found the actual answer to "what happens after I
read four ranked hypotheses":

```
→ action: selectVessel({"mmsi":"710007453","openCard":true})
→ action: flagForNextShift({"mmsi":"710007453","note":"YASMIN escalating multi-signal anomaly:
  speed anomalies 880-880s ago, dark vessel state 603s-now. Pattern consistent with intentional
  masking; recommend urgent position verification and historical track review."})
```

**This is the single most important finding from the whole walkthrough.** The AI already acted on
its own top-ranked hypothesis (flagged the vessel, wrote the note) before a human read any of the
four options. The ranking with confidence tiers strongly implies a human is meant to weigh HIGH vs.
MEDIUM vs. LOW and choose — but by the time the card renders, that choice has already been made
autonomously. If a duty officer disagreed and thought MEDIUM "equipment failure" was more likely,
there's currently no way to act on that instead; the record now says "escalating... intentional
masking" regardless of what a human concludes after reading it.

This isn't necessarily wrong as a design (auto-escalating the top hypothesis to next shift is a
defensible default), but it's a real gap between what the UI implies ("here are options, you
decide") and what it does ("I decided, here's why"). Worth an explicit decision: either make the
options genuinely selectable (a human picks which hypothesis to act on) or reframe the card's
copy so it reads as "here's what I did and why," not "here are your options."

On the positive side: the vessel side-panel confirmed the note IS visible later — YASMIN's panel
shows a WATCHLISTED section with the AI's exact note text, checkboxes (needs anomaly / course
change / dark vessel), and a REMOVE FROM WATCHLIST control. So the record persists and is legible —
the gap is specifically at the moment of decision, not after.

## Collection lead

Toggled through Map Layers and checked the bottom status bar rather than each individual layer:

- **Good, worth keeping:** the status bar already shows per-feed live/offline state for the two
  feeds that most need it — `AIS LIVE` (green) sat next to `AIR OFFLINE` (orange) during this
  session, confirmed real (not a flicker) after a 3-second re-check. That's exactly the affordance
  a collection lead needs, and it caught a real, currently-true fact: **the aircraft feed is down
  right now** while AIS is up.
- **Gap:** that's the only two feeds with a visible health indicator. RF, satellites, weather, news,
  and chokepoint-derived state have no equivalent — Map Layers only shows on/off toggles, not
  freshness. A collection lead auditing "can I trust what I'm looking at" has no way to check those
  five domains without digging into DevTools.
- **Separately noticed, real and current:** the ALERTS tab (220 total and climbing) is dominated by
  near-duplicate `AIRCRAFT LOST SIGNAL — MONITOR` entries with almost identical text, at the same
  visual weight as the much rarer `AERIAL CONFLICT — CRITICAL` entries. This is the same
  signal-to-noise problem the DISCOVERY log had before this session's fix, in a different panel that
  hasn't gotten the same treatment. Given the aircraft feed is currently offline, some of this
  flood may itself be an artifact of that outage rather than real per-aircraft events — worth
  checking whether a feed dropping should produce one alert ("feed lost") instead of N per-aircraft
  ones.

## Punch list, ranked

1. **Decide and fix the options-card decision gap** (Duty officer finding) — either make hypotheses
   selectable or change the copy to stop implying a choice that's already been made.
2. **Extend the live/offline status indicator beyond AIS/AIR** to RF, satellites, weather, news —
   cheap relative to its value, and the pattern already exists to copy.
3. **De-duplicate/group ALERTS tab noise**, especially around feed-outage-driven floods of identical
   per-entity alerts — same fix family as the DISCOVERY log de-emphasis already shipped.
4. **Make MMSI references clickable** in DISCOVERY reasoning/RULE lines so a watch analyst can jump
   straight to the vessel instead of manually searching.

Not urgent: the RULE-line wall-of-text formatting is real but cosmetic once #4 is fixed (a
clickable MMSI makes the wall scannable even if the layout doesn't change).
