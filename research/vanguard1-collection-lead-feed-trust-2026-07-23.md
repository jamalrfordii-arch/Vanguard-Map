# VANGUARD1 — Collection lead feed-trust audit
**2026-07-23 · collection lead only, live app (http://localhost:3000/) + code**

Jamal's ask was scoped to one question — "can I trust the data feeds right now, AIS/aircraft/RF/
satellites/all of it" — which is exactly the collection lead's job per `references/personas.md`
("responsible for whether the *sources* feeding the map can be trusted, not the individual
events... is every feed's live/stale/offline state actually visible, or would you only find out
it's down by noticing nothing's happening"). I ran that persona only, not a full three-persona
rotation, since the request didn't touch watch-analyst or duty-officer workflows. Before starting
I read the three prior audits on file (`vanguard1-method1-walkthrough-findings.md`,
`vanguard1-method1-fuller-pass.md`, `vanguard1-full-pass-2026-07-23.md` — the last one from
earlier *today*) plus `memory/decisions.md` and `memory/scar-tissue.md`, so what follows is new
ground, not a re-run of the AIS/AIR status-bar work already confirmed clean three times. The tab
started backgrounded (`document.hidden: true`, FPS 2) — foregrounded it before drawing any
conclusion, per the scar-tissue precedent for automation tabs. I did not cover submarine cables,
ports LOD, chokepoint flow-data trust, GPS-jamming/AIS-spoofing overlays, or watchlist/alerts
data quality this pass — flagged as not-covered, not silently clean.

The headline finding: **the status bar's five feed indicators (AIS/AIR/SAT/NEWS/SPACE WX) are not
one consistent kind of signal.** Two are genuine, correctly-reported states (AIS live, SPACE WX
down for a real external reason). Two look like the same kind of "feed is down" reading but
actually mean something structurally different — the code that would serve them isn't running at
all, versus a genuine intermittent flake. One (NEWS) reports stale for a reason that has nothing
to do with the news sources themselves. A collection lead reading the bar at face value would
draw the wrong conclusion in three of five cases.

## AIS — trustworthy, no new findings

Steady `AIS LIVE`, 500 vessels tracked, for the whole session. This matches all three prior
audits and my own spot checks (`window.aisShips` populated, vessel counts moving realistically
across ocean regions in the VESSELS tab). Nothing new to add; AIS remains the one feed I'd call
fully trustworthy without qualification.

## AIR (aircraft) — the status bar is honest about *that* it flaps, but not *why*, and the why matters

Watched it flip `AIR LIVE` → `AIR OFFLINE` → `AIR LIVE` three times in about two minutes of real
elapsed time this session, live on screen (298→300→295→300 aircraft, with "FEED OFFLINE — LAST
KNOWN" appearing and clearing each time). Traced it to source rather than assuming a flaky UI:

- `flightManager.js`'s `_poll()` (`flightManager.js:254-269`) fetches `FLIGHT.API_URL`
  (`http://localhost:8787/flights`, `config.js:372`) with a 15-second `AbortSignal.timeout`
  (`flightManager.js:261`). Any fetch that doesn't resolve inside 15s throws and sets
  `PROXY OFFLINE` (`flightManager.js:267`) — indistinguishable in the UI from the proxy actually
  being dead.
- I hit the same endpoint directly from the page console, cold: **200, real data** — 2,343,306
  bytes of live ADS-B (`hex`/`flight`/`lon`/`lat`/`alt_baro`/`gs`/`track` fields, genuine
  callsigns like `TVF26PJ`, `DMFSS`, `N759PA`). The proxy and its upstream source are not down.
- Timed the same manual fetch: **13,236 ms** for that payload — within two seconds of the
  client's own 15s abort budget. The reason for the flapping isn't a dead feed, it's an unbounded
  global payload (the server doesn't appear to filter by region before sending, and the client
  caps to `FLIGHT.MAX_AIRCRAFT: 300` only *after* the whole thing arrives) landing right on the
  edge of the timeout.
- Read the network log for the session and found this isn't purely a timing coincidence either —
  `/flights` returned real `503`s from the server itself multiple times in the same session,
  mixed in with `200`s. So there are two independent failure modes both painting the identical
  `AIR OFFLINE` picture: genuine (if likely transient) server-side `503`s, and a payload-size vs.
  timeout race that a collection lead can't tell apart from a real outage by reading the bar.

**Bottom line for trust:** treat `AIR OFFLINE` as "unreliable read on this poll," not "the feed is
down." It self-corrects most of the time within one or two 30-second poll cycles (`config.js:373`,
`FLIGHT.POLL_INTERVAL: 30_000`), and I directly confirmed real, current 300-aircraft data on
either side of every OFFLINE flicker this session.

## RF — the honest "nothing here" is honest for a different reason than it implies

`RF` tab reads `NO DETECTORS REGISTERED · 0 INFO · 0 WATCH · 0 ALERT · NO RF EVENTS`, confirmed
live (`window.rfIntel.detectors.size === 0`). The prior two audits praised this as a good,
explicit "nothing here" state versus a silently-empty panel — still true, but I traced *why* it's
empty and it's not "quiet right now." `rfIntelManager.js:39`'s `registerDetector()` has exactly
one caller in the entire codebase: `rfEmergencyBeaconManager.js:45`. Per `memory/decisions.md`
(2026-06-14), that manager was **deliberately unwired from `main.js`** over five weeks ago ("RF
distress-beacon visuals removed entirely... `rfEmergencyBeaconManager.js` is now an orphaned
file"), and nothing has replaced it since. So there is currently no code path in the running app
that could ever call `registerDetector()` — RF intel isn't quiet, it structurally has no possible
source connected. The panel's phrasing doesn't distinguish "no signals right now" from "no
detector has existed for five weeks," and a collection lead would reasonably assume the former.

## Satellites — the backend is genuinely live; the client code that would use it isn't running

`SAT OFFLINE` in the status bar looks like the same kind of reading as `AIR OFFLINE` — a feed
that's down. It isn't. I fetched the backend directly: `http://localhost:8787/satellites?group=
stations` → **200**, real current TLE data (ISS/ZARYA, POISK, epoch `26203` — day-of-year 203 of
2026, i.e. today). The data source works. But `satelliteManager.js` (which would parse this TLE
data and drive the `SAT` indicator via `_updateStatus()`, `satelliteManager.js:190-193`) is **never
imported by `main.js`** — confirmed by grepping the whole repo: the only importers of
`satelliteManager.js`/`instancedSatManager.js`/`satArcManager.js` are a code comment showing
example usage and nothing else; `window.layerManager` and any satellite-manager instance are both
absent from the live page (`typeof window.satelliteManager` is undefined). `#sat-status` is a
static `OFFLINE` string hardcoded in `index.html:2595` that nothing currently overwrites. This
isn't a feed outage, it's an unwired subsystem with working code sitting behind it — a materially
different fact for a collection lead than "the satellite feed went dark."

## SPACE WX — genuinely, currently down, for a real external reason (not a bug)

Checked all four NOAA SWPC endpoints `spaceWeatherManager.js` calls directly:
`noaa-planetary-k-index.json` → 200 (fine), but `kyoto-ae.json`, `solar-wind/plasma-7-day.json`,
and `solar-wind/mag-7-day.json` all returned **503** this session. Three of four upstream NOAA
endpoints are down on NOAA's side right now — `SPACE WX OFFLINE` is accurate and this is a real,
currently-true external outage, not a VANGUARD1 bug. Good to have confirmed distinctly from the
satellite finding above, since both read identically as "OFFLINE" in the bar for completely
different underlying reasons (one is us, one is NOAA).

## NEWS — the sources are fine; the trigger for refreshing them isn't what a collection lead would assume

`NEWS STALE` at session start, and it was telling the truth by the letter of the code — the
persisted articles in `localStorage['vg1_feed_articles']` were dated **2026-06-30**, over three
weeks old. But the reason isn't that the RSS sources are broken. `feedManager.js` only calls
`_refreshAll()` when the FEED tab is actually open and active (`feedManager.js:407` and `:423`,
both gated on `pane.classList.contains('vp-active')`) — there's no background timer independent
of the panel being visible. The moment I opened the FEED tab this session, it fetched live and
flipped to **`NEWS LIVE`, "UPDATED 07:30"**, with genuinely current articles across five of six
sources (NAVAL, HELLENIC, gCAPTAIN, SPLASH, USNI — most tagged "NOW"). Confirmed the underlying
rss2json fetches succeed cleanly (200 for the USNI feed, checked directly). A collection lead who
never opens the FEED tab would see `NEWS STALE` indefinitely and reasonably conclude the news
pipeline is broken; it's actually one click from fully live, and the sources behind it are
healthy.

## Layer toggles — two disconnected systems, one running and one documented

Toggling the visible **Map Layers** panel (15 rows: AIS Vessels, Vessel Trails, Chokepoint Labels,
Port Markers, Sea State, City Labels, City Halos, Country Borders, Surface Wind, Storm Warnings,
Low-Level Wind, Jet Stream, IBTrACS Cyclones, Fog, GPS Jamming) all worked correctly — this is a
hand-built panel hardcoded directly in `index.html` (`#layers-panel`, `.lp-row[data-layer=...]`
markup at `index.html:2721-2800`, click handler at `index.html:3651`). But `CLAUDE.md` documents
`layerManager.js` as the project's "Central layer on/off/opacity registry" and tells future
contributors to register new layers there. That module is real and does register ~30 layers,
including a whole `SPACE` category (Satellites, Magnetosphere, Solar Wind — `layerManager.js:
171-174`) and a `GEOMAGNETIC` category (Van Allen belts, ionospheric D/E/F1/F2, magnetic field —
`layerManager.js:161-168`) that never appear anywhere in the actual visible panel. I grepped the
whole repo for importers of `layerManager.js`: the only ones are two **not-yet-built** managers
under `proposed/` and the unit test suite — `main.js` never imports it, and `window.layerManager`
is `undefined` at runtime. **`layerManager.js` is dead code in the currently running app.** This
explains, structurally, why Satellites/Magnetosphere/Geomagnetic layers have no toggle in the real
panel at all — they were never ported into the hardcoded system that actually ships, only into
the registry that doesn't run. For a collection lead, the practical consequence is: you cannot
currently answer "is this layer on and can I trust its state" for anything space/geomagnetic by
checking `layerManager.js` — it isn't wired to anything real.

## AI backend — separately healthy, worth naming since it shares the same proxy as the flaky AIR feed

DISCOVERY tab this session: `TICKS 50 · RULE FINDINGS 181 · RULE-ONLY SAVES 3 · ESCALATIONS 47`,
`CLAUDE OK 47 · CLAUDE ERR 0`. Every AI escalation this session round-tripped cleanly through the
same `localhost:8787` server that's flaky for `/flights`. Worth stating explicitly: the AIR feed's
intermittent flapping is isolated to that one endpoint (payload size vs. timeout), not a sign the
backend generally can't be trusted — the AI-assessment pipeline on the same server had a clean
47-for-47 session.

## Punch list, ranked

1. **Fix the AIR false-negative at the root** — either have the flight-proxy return a
   pre-filtered/bounded payload (region cap server-side, not just `FLIGHT.MAX_AIRCRAFT` client-side
   after the full transfer) or raise/adapt the client timeout so a legitimately-slow-but-real
   13s+ response doesn't get reported identically to a dead proxy. Currently `AIR OFFLINE` is as
   likely to mean "the data's just slow" as "the feed is actually down," which defeats the
   purpose of a trust indicator.
2. **Decide the fate of `layerManager.js`** — either wire it into `main.js` for real (so
   Satellites/Geomagnetic layers get an actual toggle and a real feed-health story) or remove it
   and correct `CLAUDE.md`'s module map so it stops pointing future work at a registry that
   doesn't run. Right now the documented architecture and the shipped architecture disagree.
3. **Either wire `satelliteManager.js` into `main.js` or relabel the indicator** — the backend
   TLE data is proven live; the client code just isn't running. `SAT OFFLINE` should read
   something like `SAT — NOT ENABLED` so a collection lead can tell "not wired up" apart from
   "feed went dark."
4. **Give NEWS a background refresh independent of the FEED tab being open**, or at minimum
   timestamp the panel's cached articles individually so three-week-old cached content isn't
   indistinguishable from fresh content once the aggregate flag flips back to LIVE.
5. **Clarify the RF panel's empty-state copy** — "NO DETECTORS REGISTERED" is accurate but reads
   like a momentary lull; it's actually been true since the 2026-06-14 removal with nothing
   since. A "no detector source connected" framing would be more honest about the timescale.

## What I didn't cover

Submarine cables, port markers' LOD/data-quality, chokepoint flow-data trust, the GPS-jamming and
AIS-spoofing operational overlays (both `reserved: true` / not-yet-built per `layerManager.js`),
IBTrACS/GFS wind data freshness beyond a visual toggle check, and watchlist/alerts data integrity
were not exercised this pass — no findings for or against those, not silently assumed clean.
