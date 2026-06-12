# RF Intelligence Domain — VANGUARD1 Build Plan

**User decisions (locked):**
- Architecture: top-level RF domain (own toggle, own manager) AND per-vessel augmentation on existing maritime data
- Use case: maritime SIGINT analyst — sees how RF works globally including space, how RF is used as a weapon, supervises threats
- All 8 RF features to be built
- Own RF Intel Feed / analysis section
- Free OSINT data only; follow temporal-state convention (history buffers, setTime(t), no scrubber yet)

---

## Architecture

```
rfIntelManager.js                   ← coordinator, owns the RF event stream
├─ rfDivergenceDetector.js          ← AIS-vs-actual position divergence (feature #1)
├─ rfJammingAttribution.js          ← extends existing gpsJammingManager (feature #2)
├─ rfPropagationManager.js          ← MUF / HF reachability overlay (feature #3)
├─ rfEmissionsManager.js            ← military radar cones (feature #4)
├─ rfSatcomLinksManager.js          ← SATCOM line-of-sight ribbons (feature #5)
├─ rfCableActivityManager.js        ← submarine cable / anchor correlation (feature #6)
├─ rfLightningNoiseManager.js       ← VLF/HF lightning interference (feature #7)
└─ rfEmergencyBeaconManager.js      ← EPIRB/SART detector (feature #8)

rfIntelFeedPanel (HUD)              ← the analyst's feed (new sidebar tab)
```

**Event flow:**
1. Each sub-manager fetches its data feed, runs detection logic, emits typed RF events
2. `rfIntelManager` accumulates events into a global event store + posts to feed panel
3. `rfIntelManager.eventsForVessel(mmsi)` returns the chips that decorate that vessel's tooltip
4. High-severity events promote to existing `alertsManager` automatically

**Public API of rfIntelManager:**
```js
rfIntelManager.recordEvent({
    type: 'EMCON_VIOLATION' | 'AIS_DIVERGENCE' | 'JAMMING_SPIKE' | ...,
    timestamp: ms,
    severity: 'INFO' | 'WATCH' | 'ALERT',
    location: { lat, lon },
    vessel?: { mmsi, name },
    source: 'gpsjam.org' | 'AISStream' | 'derived',
    summary: string,
    evidence: { ... }
});

rfIntelManager.eventsForVessel(mmsi)   // returns array, last N
rfIntelManager.eventsInRegion(bbox)     // for hover-region briefing
rfIntelManager.setTime(t)               // temporal-state convention; no-op for v1
```

**Top-level toggle vs per-vessel overlay:**
- Top-level layer = the *visualizations* (propagation map, cones, ribbons, lightning, jamming zones) — only show when layer ON
- Per-vessel chips = always-on once `rfIntelManager` is initialized — they decorate vessels regardless of whether the visualization layer is toggled
- Reason: an analyst monitoring vessels always wants RF context on their tooltips; the dramatic global overlays are situational

---

## The 8 Features — Build Specs

### #1 — AIS Position Divergence Detection

**Data source:** Two streams of the same vessel.
- Primary: existing aisstream.io feed (terrestrial AIS)
- Secondary: AISStream paid satellite-AIS *or* (free path) use `vessel.lastKnownPosition` plus dead-reckoning to flag implausible jumps

**Detection logic:** For each vessel update, if `Δposition / Δtime > 2 × maxKnownSpeed`, OR if reported position is on land (use coastline polygon), OR if MMSI is geographically inconsistent (Russian MID broadcasting from Caribbean) — flag.

**Visual:** Vessel halo flips from cyan → orange-red. Small ⚠ glyph orbits the vessel sprite. Past 24h flagged positions form a faint orange trail.

**Vessel chip:** `AIS DIVERGENCE · 23nm @ 14:32Z`

**Feed entry:**
```json
{type:'AIS_DIVERGENCE', severity:'WATCH', vessel:{mmsi, name},
 evidence:{claimedPos, expectedPos, distanceNm, gapMinutes}}
```

**Difficulty:** Medium. Detection is fast; the false-positive tuning is the work.
**Analyst value:** Highest — this is THE classic maritime SIGINT product.

---

### #2 — GPS Jamming with Attribution Attempts

**Data source:** gpsjam.org daily JSON (https://gpsjam.org/data/?date=YYYY-MM-DD), aggregated by hex cell.

**Detection / attribution:** Look for sustained spike in a hex cell + adjacent cells. Compute centroid of high-interference cells = candidate emitter region. Mark known military exercise areas vs. unexplained zones differently.

**Visual:** Already have basic zones. Add: a faint ⌖ crosshair at attribution centroid + a label "EST. EMITTER REGION". Cells get a heat gradient (yellow → orange → magenta) by hour-over-hour intensity rate-of-change so analysts see *growing* jamming distinctly from *steady*.

**Vessel chip:** `JAMMED ZONE · 4.2h`

**Feed entry:**
```json
{type:'JAMMING_SPIKE', severity:'ALERT',
 location:{centroidLat, centroidLon, radiusNm},
 evidence:{cellsAffected, ratePerHour, knownExercise: false}}
```

**Difficulty:** Low–medium (most of the substrate exists).
**Analyst value:** High — particularly when correlated with known events (Russian exercises in Kaliningrad, Iranian patrol activity in Hormuz).

---

### #3 — HF Propagation Reachability (MUF Overlay)

**Data source:** Compute the Maximum Usable Frequency from your existing space weather + ionospheric data. Inputs: solar flux (10.7cm radio flux from NOAA SWPC `https://services.swpc.noaa.gov/products/10cm-flux-30-day.json`), Kp index (already have), F2-layer model. Simplified MUF formula: `MUF = critical_freq × secant(angle)`.

**Visual:** Translucent global color overlay (16-color heatmap, 5° grid). Dark blue = 3 MHz (poor), green = 14 MHz (operational), yellow = 28 MHz (excellent). When camera tilts up, the overlay shows as a translucent dome at the F2-layer altitude (Y≈25 in stratified-deck terms).

**Vessel chip:** `HF: 14 MHz USABLE` (or `BLACKOUT` during M+ flare)

**Feed entry (only on regime change):**
```json
{type:'HF_BLACKOUT', severity:'ALERT', location:{region:'POLAR_CAP_NORTH'},
 evidence:{trigger:'X1.4 flare 13:42Z', durationEstimateMin:90}}
```

**Difficulty:** Medium (math + visualization).
**Analyst value:** Niche but distinctive — comms officers care intensely; intel analysts use it to understand why a vessel "went silent."

---

### #4 — Vessel Emissions Cones (Military Radar Signatures)

**Data source:** Public catalog of military vessel platforms + their radar systems. Hard-coded for v1:
- Russian Slava-class: Top Pair radar, 360° sweep, ~200nm range
- US Burke-class: SPY-1D, 90° forward sector, ~250nm range
- Chinese Type 055: H/LJG-346B, 360° AESA, ~300nm range
- (etc — start with ~20 vessel classes)

**Detection:** When a vessel is flagged as military class (from your MMSI/aisCountries lookup + vessel-type AIS field), spawn its emission cone.

**Visual:** Translucent cone/fan extruding from vessel at Y=0–6. Color = country (red Russian, blue US, etc.). Animated sweep for rotating radars. Pulse for active emissions.

**Vessel chip:** `RADAR: SPY-1D (Burke) · ACTIVE`

**Feed entry (on first detection per vessel):**
```json
{type:'MILITARY_RADAR_ID', severity:'INFO',
 vessel:{mmsi, name, suspectedClass:'BURKE-class DDG'},
 evidence:{radarType:'SPY-1D', confidence:0.78}}
```

**Difficulty:** Medium. The catalog is the work; rendering is cheap.
**Analyst value:** High for naval intel analysts; visually distinctive.

---

### #5 — SATCOM Line-of-Sight Ribbons

**Data source:**
- Satellite positions from CelesTrak (already in `satelliteManager.js`)
- Filter to comm satellites (Inmarsat 4/5, Iridium, Starlink, Iridium NEXT)
- Geometric line-of-sight: is vessel within satellite's footprint at current orbit angle?

**Detection:** For each vessel + each comm sat in view, draw a ribbon. Color by satellite operator. Width by inferred traffic (cannot measure real traffic; use orbit-time-since-last-pass as a proxy).

**Visual:** Thin glowing line from vessel at Y=0 to satellite at LEO Y=51 / GEO Y=88. Slight curve to show "great circle through space."

**Vessel chip:** `SATCOM: 2 INMARSAT-4 LINKS` (count of active footprints)

**Feed entry:** None per-link (too noisy). Only when a watched vessel *loses all* SATCOM coverage during dark zone or *gains unexpected* coverage.

**Difficulty:** Medium (geometry + needs satellite manager already populated).
**Analyst value:** Medium-high — useful for understanding comms posture, particularly EMCON correlation.

---

### #6 — Submarine Cable Activity Correlation

**Data source:**
- Cable network from TeleGeography (`https://www.submarinecablemap.com/api/v3/cable/cable-geo.json`)
- Vessel positions you already have

**Detection:** For each vessel below a speed threshold (anchoring behavior, <2 knots for >30 min) within 2nm of a cable, flag. Cross-reference with reported cable incidents (manual list for v1, scraping news for v2).

**Visual:** Cables visible as glowing lines underwater (Y≈−2). When a correlation event triggers, the cable segment pulses red and the offending vessel gets a red link line to the segment.

**Vessel chip:** `LOITERING NEAR CABLE: SeaMeWe-5`

**Feed entry:**
```json
{type:'CABLE_PROXIMITY', severity:'ALERT', vessel:{mmsi, name},
 location:{cableId:'SeaMeWe-5', segment:'Aden-Suez'},
 evidence:{durationMin:142, distanceNm:0.8, vesselClass:'fishing'}}
```

**Difficulty:** Medium.
**Analyst value:** VERY high right now — cable cuts are a major OSINT story. Distinctive feature.

---

### #7 — Lightning RF Noise Maps

**Data source:** blitzortung.org public stream (WebSocket) or LightningMaps.org.

**Detection:** Real-time strike locations. Cluster strikes per 5-min window; high-density regions = high VLF/HF noise.

**Visual:** Faint magenta point clouds across the map at Y=10, slowly decaying. Cluster density = brightness. Doesn't compete with weather since it's at a different altitude.

**Vessel chip:** Only if vessel is in dense lightning region: `RF NOISE: HF DEGRADED`

**Feed entry (only on major outbreak):**
```json
{type:'LIGHTNING_OUTBREAK', severity:'INFO',
 location:{region:'WESTERN_PACIFIC'},
 evidence:{strikesLast15min:1200, hfDegradationDb:-12}}
```

**Difficulty:** Low-medium (data source is straightforward).
**Analyst value:** Low individually, but it explains "why is HF not working" — context, not action.

---

### #8 — EPIRB / SART / Distress Detector

**Data source:**
- Cospas-Sarsat publishes some operational data via partner sites
- Free path: USCG District 1/5/7/8/11/13/17 RSS feeds for SAR incidents
- AIS itself transmits SART signals (Class A type 14 messages)

**Detection:** Parse AIS message types 14 (safety related) and 24 (SART transponders). Cross-reference USCG SAR feed for confirmed incidents.

**Visual:** Pulsing red glow at the beacon position, with a thin radial halo expanding outward. Always-visible regardless of layer toggle (it's an emergency).

**Vessel chip:** `EPIRB ACTIVE: 12:08Z` (red, urgent)

**Feed entry:**
```json
{type:'EPIRB_FIRED', severity:'ALERT',
 location:{lat, lon}, evidence:{transponderType:'SART', source:'AIS msg 24'}}
```

**Difficulty:** Low.
**Analyst value:** Critical — this is a life-safety feature. Must be reliable.

---

## The RF Intel Feed Panel

**Location:** New tab in the existing Vanguard Panel (alongside Vessels / Watchlist / Alerts / Feed / Sitrep). Tab labeled `RF INTEL`.

**Card format:**
```
┌─────────────────────────────────────────────┐
│ ⚠ AIS DIVERGENCE   WATCH    14:32Z          │
│ NAVARK ARCADIA · 47.5°N 12.4°W              │
│ Claimed pos 23.4nm from corroborating data  │
│ Source: aisstream.io + dead-reckoning       │
└─────────────────────────────────────────────┘
```

Header strip across the top with severity counters: `47 INFO · 8 WATCH · 2 ALERT`.

**Filtering:** chips at the top for event class — `All / Divergence / Jamming / Cables / Distress / EMCON`.

**Sort:** newest first by default; toggle to severity.

**Click behavior:** clicking a card flies the camera to the event location (existing transitionManager.js handles the flight) AND opens the related vessel panel if applicable.

**Auto-promotion to Alerts:** Severity `ALERT` events auto-create an alertsManager entry. Severity `WATCH` does not.

**Watched-vessel filter:** toggle showing only events on watchlist members.

---

## Per-Vessel SIGINT Augmentation

Goes in the existing vessel tooltip + expanded vessel panel.

**Tooltip chips (compact, single line each):**
```
EMCON: SILENT 14m       (gray)        — no AIS for 14 min
EMCON: ACTIVE          (cyan)
RADAR: SPY-1D BURKE    (red)          — military radar ID
AIS DIVERGENCE 23nm    (orange)        — spoof flag
JAMMED 4h              (yellow)        — operating in interference
SATCOM: 2 LINKS        (cyan)         — active comms
EPIRB FIRED 12:08Z     (red, blink)   — emergency
HF: 14 MHz USABLE      (gray)         — propagation context
LOITERING / CABLE      (orange)       — cable proximity flag
```

Each chip has a small icon glyph. Severity-coded color.

**Watchlist row badge:** small orange dot when vessel has any WATCH-or-higher RF event in last 4h.

**Vessel detail panel:** expandable section "RF EVENTS (last 24h)" listing past chips with timestamps.

---

## Build Sequence — Five Phases

The bias: build features in order of (visible value × low effort). Each phase ends with a demoable win.

### Phase 1 — Foundation + Distress (1 session)
- Scaffold `rfIntelManager.js` (coordinator, event store, public API)
- Add RF Intel feed panel tab (empty)
- Build `rfEmergencyBeaconManager.js` (#8 — distress beacons)
- Hook AIS message types 14/24 from existing aisstream
- Distress events appear in feed and on map with pulsing red halo
- **Demo moment:** A simulated EPIRB fires, the feed populates, the map pulses, the alert auto-promotes.

### Phase 2 — Divergence + Jamming attribution (2 sessions)
- Build `rfDivergenceDetector.js` (#1) — analyze AIS for impossibilities
- Extend `gpsJammingManager` to compute attribution centroids (#2)
- Per-vessel chips for divergence + jamming exposure
- **Demo moment:** A vessel "teleports" → divergence chip appears, feed populates. A jamming zone grows visibly with attribution centroid.

### Phase 3 — Cable correlation + Military emissions (2 sessions)
- Build `rfCableActivityManager.js` (#6)
- Build `rfEmissionsManager.js` (#4) with initial 20-vessel-class catalog
- Per-vessel chips for cable proximity + military radar ID
- **Demo moment:** Tanker loiters near SeaMeWe-5 → red link pulses. Russian Slava-class shows its radar sweep.

### Phase 4 — SATCOM ribbons + Propagation overlay (2 sessions)
- Build `rfSatcomLinksManager.js` (#5)
- Build `rfPropagationManager.js` (#3 — MUF heatmap)
- Both leverage existing satellite + space weather managers
- **Demo moment:** Toggle the RF layer with camera tilted — you see vessels reaching up to satellites, propagation dome overhead, jet stream below, cyclones nearby. Multi-domain visual.

### Phase 5 — Lightning + polish (1 session)
- Build `rfLightningNoiseManager.js` (#7)
- Polish feed UX, severity tuning, chip false-positive rates
- Wire watchlist badges
- **Demo moment:** the full RF intel layer toggle showing all eight overlays at once.

**Total: ~8 sessions of focused work.**

---

## Honest Pitfalls

1. **The "we're fake SIGINT" perception.** OSINT-grade RF intel is REAL intel, not fake. Position the product accordingly — never claim classified-grade attribution. Use language like "candidate emitter region" not "confirmed."

2. **Data freshness gaps.** gpsjam.org is daily, lightning is realtime, USCG SAR is sometimes hours late. Each chip should show its data age (`14m ago`, `4h cache`, etc.). Don't pretend everything is realtime.

3. **False-positive divergence flags.** This will be the biggest UX issue. Tune carefully: a vessel passing through a satellite-AIS dead zone is not a divergence event. Build in a "suppressed false positives" counter so analysts see what was filtered.

4. **Vessel emission cones — most vessels have no known signature.** Show cones only when ID confidence > 0.7. Otherwise, just show `RADAR: UNKNOWN` chip. Don't fabricate.

5. **HF propagation maps are beautiful but unfamiliar.** Most analysts don't know how to read MUF maps. Include a small legend in-scene and a hover tooltip explaining what color = what frequency.

6. **Performance with everything on at once.** Each sub-manager budgets ~1ms/frame max. Use InstancedMesh for repeated geometry (radar cones, satellite links). Throttle non-realtime feeds.

7. **Cospas-Sarsat is gated.** Real beacon data is only available to authorized SAR coordinators. The AIS-msg-24 path is what we have free; be clear this is partial coverage, not all beacons.

8. **Cable correlation alerts will trigger on innocent fishing vessels.** Filter by vessel class (commercial cargo > fishing > pleasure) for severity scoring. Don't promote a fishing trawler within 2nm of a cable to ALERT — that's almost everywhere in Asian seas.

---

## If You Build Only One First — Build Phase 1

**Reason:** The foundation + EPIRB detector is the smallest scope that proves the entire architecture (event flow, feed panel, vessel-chip augmentation, alert promotion). Once Phase 1 ships, every subsequent feature plugs into the same plumbing. Plus, distress detection is the one feature that has *life safety* value the minute it ships — no analyst will argue against having it.

After Phase 1 the pattern is locked. Each subsequent feature is 1–2 sessions of detection logic + visual + chip wiring against the now-existing infrastructure.

---

*Plan locked. Ready to scope Phase 1 implementation when you give the word.*
