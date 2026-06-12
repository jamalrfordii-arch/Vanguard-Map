# Vanguard1 — Development Notes
*Last updated: 2026-05-25*

This document captures all design decisions, component specs, and instructions for
working with Claude on future changes. Read this before starting any session.

---

## Long-Term Vision

Vanguard1 is being built as a desktop product first. The long-term goal is to
port it to holographic and spatial computing platforms once the product is
mature and the technology has caught up.

**Why this sequencing makes sense:**
The 3D terrain, depth, lighting, and spatial map design are all groundwork that
makes more sense in a holographic context than on a flat screen. Building it
correctly now means the holographic port is a platform migration, not a rebuild.
A well-architected flat product becomes a well-architected holographic one.

**Target platforms (future phases):**
- **Looking Glass** — glasses-free light field hologram, sits on a desk, runs
  WebGL/Three.js natively. Lowest friction port from the current stack.
- **Apple Vision Pro** — headset, high fidelity display, spatial computing.
  Natural fit for an immersive command center experience.
- **PlayStation VR2 / PS5 headset** — accessible consumer hardware that could
  bring Vanguard1 to a broader audience.
- **Microsoft HoloLens** — enterprise AR, hands-free, overlays onto real world.
  Relevant for physical command center environments.

**AI copilot in the holographic context:**
When hands are occupied interacting with a holographic display, voice becomes
the primary input. The AI copilot (Claude API) becomes essential at that point —
voice commands like "show me dark vessels in the Persian Gulf" or "alert me if
this ship changes course" are the natural interaction model. Build the copilot
when the holographic port begins.

**Principle:** By the time Vanguard1 is well-established as a product, the
hardware will have caught up. Build the product right. The platform will follow.

---

## Design Principles

These principles guided how we designed the tab system and should apply to
every future feature before a single line of code is written.

**1. Define purpose before implementation.**
Every feature must answer: what problem does this solve for the user? If you
can't answer that clearly, don't build it yet. We removed cities from the
watchlist because we couldn't answer what value they'd deliver without a
real data source.

**2. Real data before real features.**
A feature is only as good as the data behind it. Placeholder content dressed
up as functionality is worse than nothing — it creates the illusion of
capability without the substance. We removed buildings from cityManager.js
and cities from the watchlist for exactly this reason.

**3. Question scope aggressively.**
Every time a feature is proposed, ask: is this core to what Vanguard1 does
right now? If the answer is "it would be nice" or "maybe later" — document
it and move on. The satellite cluster, Gaussian splats, and flight data are
all real features that belong in later phases. They're documented, not deleted.

**4. Design the full user experience before touching code.**
We spent significant time defining all five tabs — their purpose, content,
interactions, and rules — before writing anything. This means implementation
decisions are made at design time, not mid-build when they're expensive to change.

**5. Build from the user's mental model outward.**
The geographic hierarchy for the Vessels tab came from asking how an operator
actually thinks about the maritime picture — by region, not by vessel name.
Always start from how the user thinks, not from what's easy to build.

**6. Scope creep is a design problem, not a build problem.**
When new ideas come up mid-design (stocks tab, city watchlist), evaluate them
at the design level before committing. Some belong immediately (Markets tab),
some belong later (cities), some don't belong at all. Decide before building.

**7. Keep the map primary.**
Vanguard1 is a map-first product. Every UI decision should preserve the map
as the dominant element. Panels, strips, and cards are subordinate to it.
If a UI element covers the map unnecessarily, redesign it.

**8. Remove before you add.**
Before building new features, remove anything that doesn't belong. A clean
codebase is easier to build on than a cluttered one. Phase 1 cleanup came
before Phase 1 building for this reason.

---

## How to work with Claude on Vanguard1

**Always start by saying:** "Read VANGUARD1_DEV_NOTES.md before we begin."

**When making changes to a specific file, say:**
"Only modify [filename]. Do not touch any other files unless I explicitly ask."

**When discussing UI:** Describe which tab or panel you mean specifically —
"the Vessels tab in the left strip" not just "the left panel."

**When discussing alerts:** Specify the severity level — red, orange, or yellow.

**When reverting changes:** Say "undo the last change to [filename]" and Claude
will restore the previous version. Never say "undo everything" — be specific.

---

## Architecture Overview

### Core files (do not modify without understanding full impact)
| File | Role |
|---|---|
| `main.js` | Entry point, animation loop, scene orchestration |
| `sceneSetup.js` | Renderer, camera, lights, post-processing |
| `config.js` | MAP_WIDTH, MAP_HEIGHT, shared constants |
| `terrainBuilder.js` | DEM loading, elevation/color lookup, normal map |
| `continentMesh.js` | Full-globe terrain mesh (SEGS=1536) |
| `continentWorker.js` | Background worker that builds terrain geometry |
| `aisManager.js` | Live AIS vessel data management |
| `cityManager.js` | City glows, labels, footprint rings, infra icons |
| `uiController.js` | All UI interactions and panel logic |
| `index.html` | HTML structure, left strip, panels |

### Orphaned files (kept for future phases, not imported anywhere)
| File | Purpose | Phase |
|---|---|---|
| `satelliteManager.js` | Live satellite tracking via SGP4/TLE | Future |
| `satelliteBuilder.js` | Satellite 3D model factory | Future |
| `satArcManager.js` | Orbital ground-track arc lines | Future |
| `instancedSatManager.js` | GPU-instanced satellite rendering | Future |
| `gaussianSplatOverlay.js` | Photorealistic 3DGS asset overlays | Future |
| `directorManager.js` | Cinematic auto-camera screensaver | Future |
| `continentGPUCompute.js` | WebGPU normal map generator | Future |

---

## Terrain

- **SEGS = 1536** — 45+ fps on MacBook Pro. Do not increase without testing fps.
- **normalScale = 3.5** — calibrated for ELEV_SCALE=7 bake. If you re-run
  `generate_normals.py` with different settings, update normalScale to ELEV_SCALE/2.
- **generate_normals.py** lives in `tools/`. Run locally with:
  `cd ~/Desktop/Vanguard1/tools && python3 generate_normals.py`
  This is a one-time bake — it writes `terrain_normals.png` and does not run again
  until you explicitly run it.
- **Ocean floor** stays at 512 SEGS for GPU budget balance.
- **Cliff suppression**: smoothstep(0.28, 0.68, vSlope) × (1 - smoothstep(0, 500, vTrueElev)) × 0.95
- **Snow caps**: blend to cool white above 3200m, full at 4500m.

---

## Camera & Controls

- **Camera starts at:** position(0, 250, 400)
- **Zoom limits:** minDistance=15, maxDistance=550
- **Polar angle limits:** 0.04 to 1.35 rad
- **Mouse buttons:** LEFT=PAN, MIDDLE=DOLLY, RIGHT=ROTATE
- **Fly-to behavior:** When selecting a watchlisted vessel, the camera does NOT
  change zoom/height. It pans (lerps controls.target) to center on the vessel's
  XZ position while maintaining current Y height.

---

## Vessel Rendering

- **Generic AIS vessels:** Cyan triangles indicating heading direction.
- **Watchlisted vessels:** Same model/triangle but with a colored ring around them.
  Do NOT change vessel size or alter 3D models. The ring is the only addition.
- **Realistic vessel models:** When real 3D boat models are placed on the map,
  the triangle does NOT appear. The model IS the marker. Ring sits around the model.
- **Selection ring:** Reuses the existing `hoverReticle` pattern from sceneSetup.js.
  A persistent ring that follows the vessel each frame. Removed when user clicks
  water or empty map space.

### Ring color logic
| State | Ring color |
|---|---|
| On watchlist, no alerts | Green #00ff88 |
| Informational alert (yellow) | Yellow #ffff00 |
| Watch-level alert (orange) | Orange #ff8c00 |
| Critical alert (red) | Red #ff3333 |
| Not on watchlist | No ring |

---

## UI Architecture

### Left strip
- Fixed width ~280-300px
- Contains tabs — each tab is a detachable panel
- Tabs can be dragged out to become floating windows
- Floating windows can be: collapsed (title bar only), docked back, or closed
- Panel positions and open/closed state persist via localStorage

### Tab structure (Phase 1)
1. **Vessels** — geographic vessel browser
2. **Watchlist** — monitored ships (cities/planes/satellites in future phases)
3. **Alerts** — fires only against watchlisted vessels
4. **Feed** — maritime news with pinned commodity bar
5. **Markets** — full commodity tracking, organized by category, customizable

### Right panel
- Hidden by default — appears only when something is selected
- Context-sensitive: shows vessel detail card or city detail card
- Appears to the RIGHT of the clicked asset on the map
- Dismissed by clicking empty water/map space

### Bottom bar
- Slim ~30px status bar
- Shows: data feed health, last AIS update time, FPS (already implemented)
- Reference only, not interactive unless something breaks

---

## Vessels Tab

### Geographic hierarchy
Regions are defined by lat/lon bounding boxes. Vessel assignment is computed
from current AIS position. Counts update as vessels move.

**Structure:**
```
[Ocean / Sea]          (total count)
  Underway             (count)
  At anchor            (count)
  Moored               (count)
    ↳ [Port Name]      (count)
    ↳ [Port Name]      (count)
```

**Regions to include:**
- Pacific Ocean (North Pacific, South Pacific, South China Sea)
- Atlantic Ocean (North Atlantic, South Atlantic, Gulf of Mexico)
- Indian Ocean (Arabian Sea, Bay of Bengal)
- Mediterranean Sea
- Persian Gulf
- Red Sea
- Arctic Ocean
- Southern Ocean
- Strategic straits: Strait of Hormuz, Strait of Malacca, Strait of Gibraltar,
  Taiwan Strait, Bosporus, English Channel, Bab el-Mandeb, Panama Canal, Suez Canal

**Vessel sorting:** Alphabetical within each group.

**Inline entry layout:**
```
VESSEL NAME              🇵🇦
Origin → Destination  •  14.2 kn
```

**Text filter:** A lightweight "type to narrow" field at the top of each
expanded region. Not a full search system — just narrows the visible list.

### Dock detection logic
A vessel is considered moored/docked when ALL THREE are true:
1. AIS navigation status = 5 (Moored) or 1 (At anchor)
2. Speed < 0.5 knots
3. Position within proximity of a known port (World Port Index dataset)

### Vessel detail card
Appears to the right of the vessel on the map when clicked.
Also accessible from the Vessels tab list.

**Contents:**
- Vessel name + flag
- Vessel type (container, tanker, bulk carrier, etc.)
- MMSI and IMO number
- Current position (lat/lon)
- Origin
- Destination
- Speed and heading (live)
- Last AIS ping timestamp
- Cargo type (vessel class level — not manifest detail)
- AIS navigation status
- **[+ Add to Watchlist]** button — changes to "On Watchlist" indicator once added.
  A vessel cannot be added to the watchlist twice.

**Not shown on non-watchlisted card:**
- Alert settings toggles
- Notes field
- Remove button

---

## Watchlist Tab

### Grouping
**Current phase: Ships only.**

Cities, planes, and satellites are intentionally excluded until real data sources
exist to justify them. A watchlist entry that never updates and never alerts is
not a feature — it's a placeholder.

Future expansion plan:
- **Cities** — add when a real port/city data source is integrated. Candidates:
  port authority APIs, Lloyd's List Intelligence, UN COMTRADE trade flow data,
  OFAC/EU/UN sanctions databases by port. Cities clicked on the map can still
  show AIS-derived port activity (vessels currently in port) without being on
  the watchlist — that requires no new data source.
- **Planes** — add when flightManager.js is reconnected with a live flight feed.
- **Satellites** — add when satelliteManager.js is reconnected.

Within the Ships group, entries can be dragged to reorder. Order persists via localStorage.

### Watchlist entry layout

**Ship entry:**
```
VESSEL NAME              🟢  (ring color indicator)
🇵🇦  Vessel Type
Origin → Destination  •  Speed
Added: [date]
```

**City entry:**
```
CITY NAME                🟢
Region  •  Ocean
[N] vessels currently in port
```

### Watchlisted vessel detail card
Same as the standard vessel detail card PLUS:

**Additional sections:**
- **Notes:** Free text field. Optional. No prompt — just there if you want it.
- **Alert settings:** Toggle each significant change alert on/off individually.
- **[Remove from Watchlist]** button.

### Alert toggles (per watchlisted vessel)
```
ALERT SETTINGS
☑ AIS signal loss
☑ Course deviation (>30°)
☑ Speed anomaly
☑ Identity change (name/MMSI)
☑ Zone entry
☑ Port arrival / departure
☑ Status change
```
All on by default. User can toggle any off. Settings persist via localStorage.

### City detail card (map click only — NOT a watchlist feature)
Cities are not on the watchlist in the current phase. However clicking a city
on the map still surfaces AIS-derived port activity at no extra data cost:
- City name, region, ocean
- Vessels currently in port (derived from AIS position + dock detection)
- Recent arrivals and departures (derived from AIS)
- Any watchlisted vessels currently docked there (highlighted)

No [+ Add to Watchlist] button on city cards until a real port data source
is integrated. See Grouping section above for candidates.

---

## Alerts Tab

### Core rules
- Alerts only fire for watchlisted vessels. Never for general AIS traffic.
- Three severity levels:
  - 🔴 Red — Critical (AIS dark, identity change, restricted zone entry)
  - 🟠 Orange — Watch (major course deviation, speed anomaly, unexpected port)
  - 🟡 Yellow — Informational (port arrival, chokepoint passage, status change)
- Per-vessel alert types can be toggled off in the watchlist detail card.
- Alerts clear automatically when the condition resolves (e.g. AIS reappears after going dark).

### Alert card format
Alerts are grouped by vessel. If one vessel has multiple active alerts they are
stacked inside one vessel block. Multiple vessels each get their own block.

```
VESSEL NAME  •  🇵🇦
  🔴 AIS SIGNAL LOST
     Last seen: Strait of Hormuz — 14 minutes ago
     [ OK ]

  🟠 SPEED ANOMALY
     Was 14.2 kn → Now 1.1 kn. Open ocean, no port nearby.
     [ OK ]
```

### Acknowledgement
- User reads the plain language explanation and presses [ OK ] to dismiss.
- On OK: brief "Acknowledged 09:14" timestamp fades out over ~1 second, then card disappears.
- Condition resolving itself (e.g. vessel reappears after AIS loss) also auto-clears the alert.

### Alert history
- Last 24 hours of alerts kept in memory only. Not written to disk.
- History clears when the app is closed.
- Anything needing longer-term record keeping should be documented outside the platform.

### Tab indicator
- Alerts tab icon blinks when there are unacknowledged alerts.
- Blink color matches highest active severity — red, orange, or yellow.
- Stops blinking once all alerts are acknowledged.
- Does not interrupt the operator — draws the eye without demanding attention.

### "View on Map" behavior
- Pans camera to vessel. Does NOT change zoom height.
- Vessel ring pulses briefly to draw the eye on arrival.

---

## Feed Tab

### Purpose
A curated stream of maritime-relevant news and geopolitical events. Not vessel
tracking — that lives in Alerts and Watchlist. The Feed gives context that
explains why vessels are behaving the way they are.

Focused on: strait closures, port disruptions, commodity news, sanctions,
geopolitical events affecting shipping lanes, labor disputes at major ports.

### Commodity bar
A slim always-visible horizontal strip pinned to the top of the Feed tab.
Shows selected commodities at a glance — updates on a set interval.

```
BRENT  $82.14 ▲1.2%  |  LNG  $14.30 ▼0.8%  |  BALTIC DRY  1,847 ▲2.1%  |  ...
```

- Green for price up, red for price down
- User selects which 6-8 commodities appear here from the full list in Markets tab
- Settings icon on the bar opens commodity selection panel
- Selection persists via localStorage
- Scrolls horizontally if needed

### Article format
```
09:42  Strait of Hormuz — partial closure reported        [Lloyd's List]
09:14  Iron ore demand drops as Chinese steel output falls [Nikkei Asia]
08:55  Red Sea diversions add 12 days to Europe routes    [gCaptain]
```
Time — headline — source tag. Click entry → panel appears with full article
or clean summary. Panel is dismissible.

### News sources (RSS feeds)
**Maritime specific:** Lloyd's List, TradeWinds, Splash247, gCaptain, USNI News
**Asia:** South China Morning Post, Straits Times, The Hindu, Nikkei Asia
**Middle East:** Arab News, Gulf News, Al Jazeera English
**Commodities:** Reuters Commodities, Bloomberg Markets (public feeds)

### Feed rules
- **Polling interval:** Every 15-20 minutes. Maritime news does not break by the second.
- **Article cap:** 25 articles maximum at any time.
- **Auto-clear:** Articles older than 48 hours drop off automatically.
- **Per-source cap:** Maximum 3 articles per source in the feed at once.
- **Deduplication:** Headlines >80% similar or identical URLs are dropped.
  First article in wins. A small indicator shows how many other sources covered
  the same story.
- **Keyword filter:** Articles must contain relevant terms (shipping, vessel,
  port, strait, cargo, tanker, commodity, maritime, sanctions, etc.) to enter
  the feed. Filters out general political news from regional sources.
- **Pinned articles:** User can pin an article — exempt from auto-clear and
  article cap. Must be manually unpinned.
- **Session behavior:** Auto-clear applies between sessions. Articles loaded
  during an active session stay until the app is closed.

### Filtering
Filter the feed by region — Persian Gulf, South China Sea, Atlantic, etc.
Narrows articles to those geographically tagged to that region.

---

## Markets Tab

### Purpose
Full commodity tracking with price history. Companion to the Feed tab.
Feed shows the news headline — Markets shows the price data behind it.

### Layout
Organized by category:

**Shipping Indices**
- Baltic Dry Index
- World Container Index (WCI)

**Energy**
- Brent Crude
- WTI Crude
- LNG
- Natural Gas (Henry Hub)
- Uranium

**Metals**
- Iron Ore
- Copper
- Aluminum
- Coal

**Agriculture**
- Grain (Wheat)
- Soybeans
- Palm Oil

### Per-commodity display
- Current price + change + percentage
- Sparkline showing 24-48 hour price movement
- Color coded: green up, red down

### Customization
User selects which commodities appear in the Feed tab commodity bar.
All commodities always visible in Markets tab regardless of Feed bar selection.

### Data source
Yahoo Finance and public commodity APIs. Free endpoints to start.
No paid API required for initial build.

### Future expansion
- Shipping lane freight rates by specific route
- Sanctions-related commodity restrictions
- Trade volume data by region

---

## Significant Change Definitions

| Change | Severity | Notes |
|---|---|---|
| AIS signal lost | 🔴 Red | Vessel stops broadcasting |
| AIS signal reappears | 🟡 Yellow | After being dark |
| Identity change (name/MMSI) | 🔴 Red | Known deception tactic |
| Zone entry (restricted) | 🔴 Red | User-defined or system zones |
| Major course deviation | 🟠 Orange | >30° from declared route |
| Speed anomaly | 🟠 Orange | Dramatic drop or spike |
| Unexpected port arrival | 🟠 Orange | Doesn't match declared destination |
| Approaching chokepoint | 🟠 Orange | Hormuz, Malacca, Gibraltar, etc. |
| Vessel stops mid-ocean | 🟠 Orange | Stationary, no port nearby |
| Port arrival (declared) | 🟡 Yellow | Normal arrival at destination |
| Port departure | 🟡 Yellow | Vessel leaves a port |
| Chokepoint passage | 🟡 Yellow | Informational log |
| Status change | 🟡 Yellow | Underway → anchored, etc. |
| AIS reappears after dark | 🟡 Yellow | After signal loss resolved |

---

## cityManager.js — Design Decisions

- **Buildings removed.** Instanced box buildings were placeholder art, not real data.
  Do not re-add without a real data source.
- **setMode('military'|'business')** is kept as a hook for future global mode manager.
  Currently hardcoded to 'military'. Do not remove this method.
- **addPortCities() removed.** It only built placeholder buildings.
- **Kept:** Glow halos, city name labels, footprint rings, infra icons (✈ ⚓ $),
  close-zoom terrain patches.

---

## Performance Notes

- Pixel ratio capped at 1.5 (renderer.setPixelRatio)
- TiltShift passes are active — do not disable without user confirmation
- Bloom: strength=0.25, radius=0.4, threshold=0.92
- Target: 45+ fps on MacBook Pro M-series
- GPU budget: continent mesh (1536 SEGS) + ocean floor (512 SEGS) + AIS vessels
- Do not add new heavy geometry without checking fps impact first

---

## What Was Built — 2026-05-17

### Phase 1 Cleanup Completed
- **Removed:** threat strip (HTML + CSS + threat level logic in main.js)
- **Removed:** active vessels list panel, active flights list panel (HTML + CSS)
- **Removed:** AI Copilot UI panel (CSS, HTML, all inline JS handlers)
- **Kept:** `aiCopilot.js` detection engine — still fully wired in main.js via
  `bindAISManager`, `bindFlightManager`, `onEvent`, `tick()`. Events now route
  to a stub `window.vanguardCopilotEvent` that will be replaced when Alerts tab is built.
- **Rebuilt:** right toolbar — now has layers⊞, city◈, search⌕, weather☁, settings⚙
  plus zoom+/−, FOV, and NA/EU/PAC sector buttons.
- **cityManager.js:** removed holographic miniature buildings, addPortCities(), stale
  building visibility/dispose code. Kept halos, labels, footprint rings, infra icons,
  terrain patches, setMode() hook.

### Left Strip Tab System (`index.html`)
A fixed tab strip at the vertical center of the left edge with a slide-in panel.
- 5 tabs: Vessels ⛵, Watchlist ★, Alerts ⚠, Feed ◈, Markets ⬡
- Panel opens to the right of the tab strip when a tab is clicked; clicking the
  active tab again collapses it
- Detach button (⤢) pulls the panel out to a floating window with free drag
  via the header; dock button (⤡) returns it
- Collapse (▲) button shrinks the panel to header-only height
- Alert badge on Alerts tab: shows count, pulses red when anomalies are active
- `window.leftStrip.setActiveTab(tab)` and `window.leftStrip.setAlertBadge(n)`
  are the public API for other JS modules
- State (open tab, floating, float position) persists across page refreshes via localStorage

### Bottom Status Bar (`index.html`)
A slim 28px bar fixed to the bottom edge of the screen.
- Segments: AIS status + dot, vessel count, air feed status + dot, on-screen count, FPS, GPU
- FPS is measured by patching `requestAnimationFrame` — accurate, zero overhead
- All values mirror existing DOM elements (ais-status, ais-vessel-count, etc.)
  so they update in sync with the existing HUD without duplicating data sources
- Collapse button shrinks the bar to a 4px accent line; expand tab appears
  bottom-right to restore it. State persists via localStorage.
- Color coding: green = live, orange = offline/warn, red = critical/low-fps

---

## What Was Built — 2026-05-19

### Vessel Tab (`vesselTab.js`)
- Geographic hierarchy: vessels grouped by ocean/sea region with underway/anchor/moored counts
- Each row has flag emoji, vessel name, speed, destination, + watchlist toggle button (`+` / `★`)
- Single-click pans camera + shows selection ring; double-click opens stats card
- Live updates via AIS callbacks; re-renders on `vg1:watchlistChanged`

### Watchlist (`watchlist.js`)
- Full localStorage persistence: watched MMSIs, per-vessel notes, alert toggles, name cache
- Name cache (`vg1_watchlist_namecache`) survives page refresh; populated from AIS Type 5 messages
  and `window.aisShips` userData.displayName. Names resolve within ~6 min of AIS feed repopulating.
- Per-row remove button (`✕`) — removes vessel without needing to open the card
- Single-click selects/pans; double-click opens stats card
- **Alert flash system:** when aiCopilot fires DARK_VESSEL / SPEED_ANOMALY / COURSE_CHANGE for a
  watchlisted vessel with the matching toggle enabled, the watchlist row pulses (3× CSS keyframe
  animation) then holds a colored left border (red = CRITICAL, orange = WARNING) until the user
  clicks the row. Flash state auto-expires after 5 minutes.

### Vessel Detail Card (`index.html`, `uiController.js`, `main.js`)
- Draggable: click-drag the header bar to reposition freely; clamped to viewport
- Minimizable: `—` button collapses to header-only; `□` restores. State persists while card is open.
- Vessel data populated from Three.js userData or `aisManager.vessels` rich synthetic fallback
- For watchlist vessels whose 3D object is not in `window.aisShips`, looks up `threeObject`
  directly from `aisManager.vessels`, then falls back to a live-data synthetic object with
  class, speed, heading, lat/lon, country, destination, ETA all populated

### Selection Ring (`selectionRing.js`)
- Cyan by default; green when vessel is watchlisted
- Two rings: outer rotates slowly, inner breathes opacity
- Cleared on card close or empty-map click

### Alerts Tab (`alertsManager.js`)
- **LOG view:** scrollable feed of triggered alerts; severity badge (CRITICAL/WARNING/INFO);
  relative timestamps; per-entry dismiss; CLEAR ALL; persisted in localStorage (max 200)
- **RULES view:** toggle switches per alert type; custom speed-threshold rule with editable KTS input
- Unread badge on ALERTS tab clears when tab is opened; recalculated from log on page refresh
- Click any alert row with an MMSI → `vg1:selectVessel` pans camera + shows selection ring

---

## Pending Tasks (as of 2026-05-19)

- [ ] Build Feed tab — RSS aggregation, deduplication, keyword filter, commodity bar
- [ ] Build Markets tab — full commodity list by category, sparklines, Feed bar customization
- [ ] Build city detail card — AIS-derived port activity only (no watchlist)
- [ ] Wire dock detection logic (AIS status code 5 or 1 + speed < 0.5kn + port proximity)
- [ ] Address global city list (3D vs 2D inconsistency; Google Tiles integration)
- [ ] Decide long-term fate of the hud-panel (Operational Theatre) — migrate
      its status data into the bottom bar and left strip, then remove it

---

## Future Backlog (deferred, not forgotten)

### Geofence / Alert Zone — upgrade to full entry detection
**Current state:** A single semi-transparent disk can be placed on the 3D map via the toolbar.
`tickAlertZone()` counts vessels inside each frame and shows a count badge. No entry events fire,
no alerts are generated, no persistence, one zone only.

**What needs to be built:**
- Track which MMSIs were inside the zone last tick vs this tick. Delta = entry event.
- On entry: fire `alertsManager.addAlert({ type: 'ZONE_BREACH', mmsi, ... })` → appears in
  ALERTS tab log + triggers watchlist row flash if vessel is watched.
- Support multiple named zones simultaneously (e.g. "HORMUZ WATCH", "PORT APPROACH").
- Persist zone definitions (center lat/lon, radius, name) in localStorage; rebuild 3D meshes on load.
- Surface zone management inside the ALERTS tab RULES section — create, rename, delete, radius
  adjust — rather than a buried toolbar button.
- The 3D rendering side (disk + ring meshes) is already done. The work is entry detection + UI.

### Chokepoint Congestion Alerts
**Rationale:** ChokepointManager already tracks live vessel counts at all 11 strategic chokepoints.
Congestion thresholds (e.g. 6+ vessels = WARNING, 12+ = CRITICAL) and loitering detection
(vessel < 2 kts inside a chokepoint zone) are high-value signals that require minimal new infrastructure.

**What needs to be built:**
- Per-chokepoint vessel count thresholds → `alertsManager.addAlert({ type: 'CHOKEPOINT', ... })`
- Loitering detection: vessel inside chokepoint radius with speed < 2 kts for > 10 min
- Enable CHOKEPOINT rule in ALERTS tab RULES view (currently disabled by default)
- Consider a dedicated "Chokepoint Status" summary somewhere in the UI (ALERTS tab or bottom bar)

### Port Entry / Departure Alerts
**Rationale:** More complex than chokepoints — requires per-port geofences calibrated to actual
port boundaries, which is data-intensive to set up correctly. Worth doing once the World Port
Index dataset is integrated for dock detection.

**Dependency:** Dock detection logic (AIS status + speed + port proximity). Build that first.

---

---

## Electromagnetic Spectrum — Research Notes (2026-05-25)

Understanding this is foundational to building the geomagnetic and operational layers
correctly. These notes are a working reference, updated as we learn.

### What the electromagnetic field is
The Earth's magnetic field and a radio wave are the same fundamental phenomenon —
electromagnetism — operating at different frequencies. The geodynamo in the Earth's
molten outer core generates the static geomagnetic field at essentially 0 Hz. Radio
waves, microwaves, and GPS signals are all disturbances in that same electromagnetic
field, oscillating at much higher frequencies. A wave IS a disturbance in the field —
it doesn't travel through the field like water in a pipe, it propagates by an
oscillating electric field generating an oscillating magnetic field generating an
oscillating electric field, chained forward at the speed of light.

### Units of measurement
- **Tesla (T)** — SI unit for magnetic field strength (flux density). Named after
  Nikola Tesla. At Earth scale we work in **nanoteslas (nT)** because Earth's field
  is tiny: surface values of 25,000–65,000 nT = ~0.00005 Tesla. An MRI machine
  runs at 1.5–3 Tesla for comparison.
- **Hertz (Hz)** — cycles per second. Measures electromagnetic wave frequency.
  Named after Heinrich Hertz who proved EM waves exist. Used across the full
  spectrum from ELF (3 Hz) to gamma rays (10²⁴ Hz).
- **The relationship**: Field strength at a given location sets limits on what
  frequencies can propagate through that medium. The plasma frequency and cyclotron
  frequency — both derived from local field strength — determine what waves pass
  through, reflect, or get absorbed. This is the Appleton-Hartree equation. It's
  why AM radio bounces off the ionosphere at night but not during the day.

### The electromagnetic spectrum organized by altitude from Earth's core

The electromagnetic environment naturally stratifies by frequency moving outward
from the core. Weaker field = lower cyclotron frequency = longer wavelength
interactions dominate. The further from the core, the lower the dominant
frequencies, and lower frequency means longer wavelength.

```
ALTITUDE          FREQ RANGE          WAVELENGTH        PHENOMENA
─────────────────────────────────────────────────────────────────────────────
Deep space        ~millihertz         millions of km    Solar wind fluctuations
Magnetosphere     ELF / VLF           thousands of km   Whistler waves along
  (1000km+)       0.1–30 kHz                            field lines, Van Allen
                                                         belt particle dynamics
Upper ionosphere  HF radio            10s of meters     Long-distance radio
  (200–1000km)    3–30 MHz                              bounces, HAARP range,
                                                         over-the-horizon radar
Lower ionosphere  VHF / UHF           cm to meters      GPS (L-band ~1.5GHz),
  (60–200km)      30MHz–3GHz                            satellite comms, aurora
                                                         at 100–300km altitude
Surface–60km      Schumann / ELF      100,000s of km    Schumann resonance
                  7.83 Hz + harmonics                   (Earth-ionosphere cavity
                                                         heartbeat), telluric
                                                         currents, compass
                                                         navigation
Earth's core      ~0 Hz (static)      ∞ (no oscillation) Geodynamo, source of
                                                         the geomagnetic field
```

### Each Central System layer maps to a frequency band
- SURFACE layer     → static geomagnetic field, Schumann (~0–30 Hz)
- ATMOSPHERE layer  → ELF/VLF/HF interactions, lightning (~3 Hz–30 MHz)
- GEOMAGNETIC layer → ionospheric plasma dynamics, GPS band (~30 MHz–3 GHz)
- SPACE layer       → magnetospheric ELF, whistlers, Van Allen (~0.1–30 kHz)
- OPERATIONAL layer → GPS jamming (~1.5 GHz), microwave comms, HAARP (2–10 MHz)

The layered stack from surface to space IS the electromagnetic spectrum organized
by altitude. This is not just aesthetic — it is physically accurate.

### Signal jamming — where it actually happens
Most practical GPS jamming happens at ground level. GPS signals from satellites
at 20,200 km altitude arrive extremely weak (~-130 dBm). A ground-based jammer
transmits on the same L-band frequency (L1: 1575.42 MHz) and simply overwhelms
nearby receivers with noise. Creates a localized bubble of GPS denial — 50 to
500+ km depending on power. Source is identifiable and localized. This is what
gpsjam.org tracks.

Ionospheric manipulation is a separate, more sophisticated capability. HAARP
(Alaska), Sura (Russia), EISCAT (Norway) transmit powerful HF radio into the
ionosphere, heating and disturbing it. A disturbed ionosphere bends and absorbs
signals passing through it — affects GPS, over-the-horizon radar, long-range
comms — at a regional scale. Harder to attribute, connected directly to the
geomagnetic field layer.

Geomagnetic storms do naturally what HAARP does artificially. A Kp=7+ storm
disrupts the ionosphere globally. The magnetic field layer and GPS jamming layer
are causally linked — not just neighbors in the Central System.

### The South Atlantic Anomaly
A region over South America and the South Atlantic where Earth's magnetic field
is ~40% weaker than the global average. Caused by a patch of reverse-polarity
field in the outer core. Satellites malfunction crossing it (elevated radiation
exposure). GPS degrades. Aircraft experience higher cosmic ray exposure. This
anomaly is a permanent feature of the IGRF model and should be visually prominent
in the magnetic field layer — it is arguably the most operationally significant
geomagnetic feature on the map.

### Variables that affect the electromagnetic field — Data Viz Drivers

These are critical. Each variable is a potential live data input, animation driver,
or visualization layer. The field is never static — it is the sum of all of these
forces acting simultaneously at different frequencies.

| Variable | Timescale | Effect on field | Data viz application | Data source |
|---|---|---|---|---|
| **Solar wind** | Minutes–hours | Compresses sunward side, stretches night-side tail. Primary driver of geomagnetic storms. | Particle flow speed/intensity, field line compression animation | NOAA SWPC real-time solar wind (free) |
| **Solar flares / CME** | Hours–days | Billion-tonne plasma slams field, causes storm. Field rings and oscillates like struck bell. | Storm alert overlay, Kp spike animation, particle burst effect | NOAA SWPC alerts (free) |
| **Kp index** | 3-hour updates | Measures global geomagnetic disturbance 0–9. Kp 5+ = storm. | Primary driver of particle animation intensity and speed in viz | NOAA SWPC (free JSON) |
| **Dst index** | Hourly | Measures ring current strength during storms. Negative = compression. | Storm intensity overlay, field strength deviation from IGRF baseline | NOAA SWPC (free JSON) |
| **The Moon** | ~28 day cycle | Gravitational tide pulls atmosphere, moving it through the field, generating ionospheric dynamo currents. | Subtle tidal pulse in ionospheric layer animation | Computed (lunar phase math, no API) |
| **Lightning / thunderstorms** | Seconds | 100 strikes/second globally pump energy into Earth-ionosphere cavity at 7.83 Hz — Schumann resonance. | Real-time lightning layer, Schumann resonance pulse animation | Blitzortung.org (free, real-time global lightning) |
| **Seasons / Earth tilt** | Annual | Angle of solar wind changes, ionosphere thickens/thins. Field has annual breathing cycle. | Seasonal modulation of ionospheric layer opacity | Computed (orbital math, no API) |
| **Polar wandering** | Years–decades | Magnetic north pole drifting toward Siberia ~55 km/year, accelerating. IGRF updates every 5 years. | Animated pole position drift overlay (historical + projected) | IGRF historical coefficients |
| **South Atlantic Anomaly** | Decades (slow drift) | 40% field weakness over South America/South Atlantic. Satellite anomalies, GPS degradation, radiation exposure. | Persistent anomaly zone highlighted in field strength heatmap | IGRF computed |
| **Geodynamo fluctuations** | Centuries | Slow changes in core flow alter field structure. Precursor to possible reversal. | Long-timescale scenario / historical replay layer | IGRF historical record |
| **Earthquakes / volcanism** | Sudden | Piezoelectric stress in rocks may generate local EM anomalies before major events. Debated. | Anomaly flag when seismic activity correlates with local field deviation | USGS seismic + IGRF deviation |
| **Human / power grids** | Continuous | 50-60 Hz EM noise from power infrastructure. GIC (geomagnetically induced currents) during storms damage transformers. | Grid vulnerability overlay during storm events | IGRF + Kp + grid infrastructure data |
| **Nuclear / HEMP** | Instantaneous | High-altitude detonation creates EMP cone, collapses ionosphere locally, disturbs Van Allen belts for years. | Historical scenario replay (Starfish Prime 1962), speculative HEMP modeling | Scenario layer (computed) |

### Key insight for data visualization
The field is fluid and breathing — it has rhythms at every timescale simultaneously.
Like an ocean with tides, waves, ripples, and currents all happening at once.
Each variable above operates at a different frequency band and timescale.
The visualization should reflect this — not a static picture but a living system
where particle speed, density, color, and behavior respond to live inputs.

**Priority variables for first build (available, free, real-time):**
1. Kp index — NOAA, drives overall animation intensity
2. Solar wind speed/pressure — NOAA, drives compression/expansion effect
3. Lightning — Blitzortung.org, drives Schumann pulse
4. South Atlantic Anomaly — IGRF computed, always visible as field weakness zone

**Variables for future phases:**
- Dst index (storm depth)
- Lunar cycle modulation
- GIC / grid vulnerability overlay
- Seismic correlation anomalies

### Data sources for the magnetic field layer
- **IGRF (International Geomagnetic Reference Field)** — the standard mathematical
  model. Coefficients are public, computable client-side, no API. Updated every
  5 years. Accurate for surface field strength, declination, inclination. This is
  the base model for visualization and click-to-measure.
- **NOAA SWPC** — real-time space weather. Kp index (0–9 geomagnetic activity),
  Dst index (storm intensity), AE index (auroral electrojet). Free JSON endpoints.
  This is the live news layer applied on top of IGRF.
- **ESA Swarm** — three satellites actively measuring the field from orbit. Most
  accurate live data. More complex to integrate, consider for future phase.
- **USGS ground observatories** — fixed stations, real-time local measurements.
  Future phase.

### Magnetic field layer — visualization approach (decided 2026-05-25)
- **Base**: IGRF model, client-side computation
- **Live overlay**: NOAA Kp/Dst on top of IGRF
- **Visual style**: particle flow system — thousands of small particles moving
  along local field vectors. Grey dots with cyan outer glow, slight yellow flicker
  (charge effect). Similar to earth.nullschool.net wind visualization but for
  the magnetic field vector.
- **Point cloud coexistence**: TBD — options are altitude separation, terrain fade
  when layer is active, zoom-dependent swap, or stratified altitude bands.
- **Click-to-measure**: lat/lon → IGRF lookup → measurement card showing field
  strength (nT), declination, inclination, live Kp, Claude API interpretation.
- **Prompt card**: shown first time analyst enables the layer. Content to be
  written after build is complete.

---

## Layer System — Full Vision (2026-05-24)

This is the major expansion plan for Vanguard1 — turning it from a maritime
tracker into a full electromagnetic / geophysical / operational intelligence platform.
Sometimes referred to internally as the "Einstein + Tesla" layer plan.

### Layer Categories (5 groups)

Group layers by what they describe, not by data source. This makes preset
combinations natural and the UI scannable.

| # | Category | Contents |
|---|---|---|
| 1 | **Surface** | Terrain, borders, infrastructure — always on, base layer |
| 2 | **Atmosphere** | Clouds, weather scalars, lightning, precipitation, global electric circuit |
| 3 | **Geomagnetic** | Magnetic field lines, telluric currents, Schumann resonance shell |
| 4 | **Space** | Satellites, magnetosphere, Van Allen belts, solar wind / IMF |
| 5 | **Human/Operational** | EM warfare, GPS jamming, signals intelligence, infrastructure attacks |

**Why this grouping:** A user studying a solar storm wants Geomagnetic + Space
on at once. A hurricane analyst wants Atmosphere alone. A GPS denial analyst
wants Atmosphere + Human/Operational + maybe Space. These buckets make the
right combinations one-click.

---

### Rendering Order — Altitudinal Stack

Render in physical altitude order, deepest first:

```
          ─── SPACE ────────────────────────────────────────
          Solar wind / IMF                    orange
          Satellites & debris                 light gray
          Outer magnetosphere                 deep cyan

          ─── UPPER ENVELOPE ───────────────────────────────
          Magnetic field lines                cyan
          Schumann / ionosphere shell         magenta

          ─── ATMOSPHERE ───────────────────────────────────
          Global electric circuit             pale cyan
          Lightning (flash, additive blend)   white-yellow
          Clouds                              white / neutral
          Surface weather scalars             pale blue

          ═══ SURFACE (always on) ══════════════════════════
          Terrain + borders                   neutral

          ─── SUBSURFACE ───────────────────────────────────
          Telluric currents                   amber

          ─── OVERLAY (any altitude) ───────────────────────
          EM warfare / operational            red
```

**Rendering rules:**
- Subsurface layers render below the terrain shell at reduced opacity — visible
  "through" the surface like x-ray vision
- Surface scalars (temp, pressure) render as colored shading on terrain
- Cloud cover is a textured shell at ~10 km altitude
- Lightning is a particle effect at cloud altitude with additive blending so
  flashes pop without washing out clouds
- Magnetic field lines are 3D curves extending from surface into space; depth
  fade so they don't look flat
- EM warfare overlay is special — sits at whatever altitude its phenomenon lives
  at (ground-based jamming = low; ASAT = orbit; HEMP = burst altitude)

---

### UX Patterns

**Story Presets** — pre-configured layer bundles, one click:
- **Severe Weather** → clouds + precipitation + lightning + global electric circuit
- **Solar Storm** → magnetic field + telluric + aurora + Kp index
- **Active Conflict** → GPS jamming + satellite tracks + cloud cover + signal anomalies
- **Grid Vulnerability** → telluric + transmission infrastructure + Kp index + GIC risk
- **SBSP Scenario** → satellites + magnetic field + SBSP coverage + EM warfare overlay

Each preset is a saved bundle of layer toggles + opacity settings. Users can
modify and save their own.

**Focus Mode** — when the field inspector is active on a point, dim all layers
to ~30% except the 2-3 most relevant to what's being inspected:
- Click a lightning strike → Atmosphere + Geomagnetic stay bright, rest dims
- Click a jammed GPS receiver → Human/Operational + Space stay bright, rest dims

**Color Discipline** — one signature color per layer, applied at varying alpha.
No layer uses more than two hues. Without this the screen becomes unreadable
with 4+ layers active simultaneously.

**Two-Layer Cap (default)** — when the user toggles a third layer, the others
gently dim to ~40% opacity unless manually overridden. Guardrail against
Christmas-tree mode.

**Per-Layer Time Resolution** — lightning operates at ~1 second, magnetic field
at ~1 minute, geopolitical events at days. Each layer has its own native
resolution; the master slider operates at the coarsest, and layers
downsample/aggregate when zoomed out.

---

### EM Warfare Expansion — Live Phenomena

This is the analytically distinctive part of Vanguard1. Almost no public-facing
tool combines weather + EM + military signals coherently. Critically: almost all
of this data is openly available.

| Phenomenon | Source | Notes |
|---|---|---|
| **GPS interference zones** | gpsjam.org (John Wiseman) | Near-real-time. Ukraine/Russia, Israel/Lebanon, Hormuz, Black Sea, Kaliningrad, Syria. Free, well-documented. Render as red shaded zones. |
| **Aircraft route anomalies** | ADS-B Exchange | Flight density heatmap; anomalous diversions highlighted. Aircraft routing around regions almost always has EW/military reason. |
| **Maritime AIS spoofing** | MarineTraffic, Global Fishing Watch | Ships transmitting impossible positions — inside airports, jumping continents. Russian VIP movements correlate with regional GPS spoofing. |
| **Cable infrastructure events** | TeleGeography + news APIs | Submarine cable cuts (Baltic 2024, Red Sea 2024, Taiwan Strait 2023). |
| **Satellite proximity events** | USSPACECOM, CelesTrak | Conjunction warnings. Russian/Chinese inspector satellites approaching US assets. |
| **Active conflict EM signatures** | ACLED + GPS jam overlays | Ukraine, Gaza, Sudan, Myanmar. |
| **Ionospheric heaters** | HAARP public schedule, EISCAT, Sura | Bright transient spots in ionospheric layer. |

---

### Historical Scenarios to Replay

Gold for demo, pedagogy, and analytical argument. Each becomes a scrubable
timeline jump — drop user in at t-1hr, watch the system go red.

| Event | Date | What to show |
|---|---|---|
| Quebec geomagnetic storm | March 1989 | Grid blackout from space weather; natural EW event |
| Halloween storms | Oct-Nov 2003 | Global GIC effects, satellites damaged |
| Starfish Prime | July 1962 | High-altitude nuclear EMP test, streetlights out in Hawaii |
| Chinese ASAT test | Jan 2007 | Debris field still in orbit today |
| Ukraine grid attack | Dec 2015 | First known cyber-induced blackout |
| Russia–Georgia EW campaign | Aug 2008 | Accompanied kinetic operations |
| G5 geomagnetic storm | May 2024 | Most recent major event, well-documented |
| Baltic cable cuts | Oct-Dec 2024 | Multi-incident pattern, Russian/Chinese vessels |
| Ongoing GPS jamming | 2022–present | Ukraine/Russia, Israel/Gaza/Lebanon |

---

### Speculative / Scenario Modeling

| Scenario | Source material | What to build |
|---|---|---|
| **HEMP modeling** | DOD reports, EMP Commission, Foster reports | Nuclear detonation at ~400km altitude over central US → EMP cone covering CONUS. Affected radius, frequency bands, infrastructure impact zones. |
| **Carrington-class solar storm** | Lloyd's of London model | Recreate 1859 event with modern infrastructure. Grid failures, satellite losses, comms blackouts. |
| **Kessler cascade** | Real orbital debris data | Model cascade if major collision occurred. Direct connection to SBSP space governance void. |
| **SBSP-as-DEW conversion** | Your SBSP article | Show that SBSP rectenna and directed energy weapon have identical EM signatures from ground. Show transmitter could be retargeted. The visualization is the argument. |
| **Submarine cable attack** | TeleGeography | Map redundant routes; simulate cutting key cables; watch internet connectivity degrade by region. |

---

### Connection to Existing Work

- **SBSP article** → companion visualization layer making the dual-use argument
  viscerally clear. Identical signatures for civilian vs military orbital infrastructure.
- **ICL / command-responsibility work** → tech-supply-chain layer showing where
  autonomous weapons components originate and where they're deployed.
- **Electricity law work** → grid-vulnerability overlay tying GIC risk to specific
  transmission assets.
- **Public records work** → geographic display of FOIA-derived data.

The visualization doesn't replace legal analysis — it's the evidence display that
makes the legal argument legible. A policymaker who reads "SBSP and DEW share
identical core technology" doesn't fully see it. One who watches the visualization
showing identical EM signatures does.

**Framing note:** This sits in research, journalism, policy analysis, and education
territory — same as Bellingcat, CSIS, Aviation Week, Stimson Center. Inputs are
public, synthesis is analytical, product is interpretive. Worth being clear-eyed
about this if pitching externally: it's a Bellingcat-style analytical tool, not
an operational system. The distinction matters legally and reputationally.

---

### Build Sequence

| Step | What | Status |
|---|---|---|
| 1 | Lightning + cloud cover + time slider | ⬜ Pending |
| 2 | Field inspector with weather + lightning fields | ⬜ Pending |
| 3 | Layer toggle system + 5-category panel + story presets | 🔄 In progress |
| 4 | Magnetic field lines + telluric currents + Kp index | 🔄 In progress |
| 5 | GPS jamming layer (gpsjam.org) | ⬜ Pending |
| 6 | Satellite tracks + ASAT history | ⬜ Pending |
| 7 | Historical scenario replay UI (named timeline jumps) | ⬜ Pending |
| 8 | Schumann sonification, atmospheric electricity, advanced layers | ⬜ Pending |
| 9 | Speculative scenario engine (HEMP, Carrington, SBSP-DEW, Kessler) | ⬜ Pending |

Steps 1–3 = credible v1. Steps 1–6 = serious analytical tool. Steps 1–9 = research-grade system.

**Starting point (2026-05-24):** Building steps 3 and 4 together — layer toggle
panel first (the skeleton), then magnetic field + telluric as the first "wow" layer
to slot into it.

---

## What Was Built — 2026-05-24

### Terrain Point Cloud Improvements
- LAND_GRID increased from 5774 → 7500 (~16.9M land points)
- MAX_ALLOC increased to 18,000,000
- Latitude-based jitter snapping: jitter reduces to 20% at poles to prevent
  grid point spreading at high latitudes
- Size formula: steep terrain now gets larger splats (0.52 at steepness=1)
  vs flat plains (0.20) — compensates visually for sparse high-terrain faces
- Gaussian softened: r2 clip 0.06, falloff exp(-r2 * 8.0)
- Emissive reduced to 0.10, ridge glow reduced to 0.18 (orange dot fix)
- Vertical exaggeration taper: smooth blend from divisor 650 (lowlands) →
  1100 (peaks ≥4000m) — reduces apparent steepness on mountain faces so
  grid points cluster tighter on Andes/Himalayan faces

### Google Photorealistic 3D Tiles — Removed
- Removed googleTilesManager.js import, instantiation, render branch,
  alt+dblclick listener, Escape handler, resize listener from main.js
- Removed ⬡ 3D button from city rows in uiController.js
- Removed port-click → 3D view block from uiController.js
- Removed chokepoint activateAt call from uiController.js
- Removed #gt-overlay HUD div from index.html
- Removed GOOGLE_TILES_API_KEY script tag from index.html
- googleTilesManager.js file deleted from disk

---

*This document should be updated after every significant design decision or build session.*
