# ACLED Conflict Events — Research Notes

**Generated:** 2026-06-05
**Category:** human
**Manager:** conflictEventManager.js

## Strategic Value

The ACLED dataset is one of the most comprehensive open-source conflict
intelligence feeds available, covering political violence, battles, explosions,
and protests across 200+ countries. For Vanguard1's operational picture:

1. **Shipping risk**: Conflict events near major shipping lanes and ports
   directly affect insurance ratings, vessel routing decisions, and crew safety
   assessments. Yemen, Red Sea, and Gulf of Aden events can be cross-referenced
   with AIS vessel positions in real time.

2. **Chokepoint threat assessment**: The existing `chokepointManager.js` shows
   flow data — conflict events layered on top reveal whether a chokepoint faces
   active military threat, civil unrest, or is currently secure.

3. **Force presence inference**: A concentration of "Battles" events in a
   given area over time indicates sustained military operations — force presence
   that may not appear in AIS or flight data.

4. **Displacement and humanitarian corridors**: Violence against civilians
   events cluster before refugee flows, which in turn affect maritime vessel
   patterns as smuggling/humanitarian routes open.

5. **AI Copilot integration**: The existing `aiCopilot.js` can be extended
   to cross-correlate conflict event density with AIS dark vessel behavior
   in the same region.

## Data Source

**ACLED (Armed Conflict Location & Event Data)**

- API endpoint: `https://api.acleddata.com/acled/read`
- Free academic/research registration: https://acleddata.com/register/
- Commercial use: separate license required
- Coverage: global, since 1997, 200+ countries
- Update frequency: daily (events within 24–48 hours of occurrence)
- Format: JSON, CSV, GeoJSON via API
- API documentation: https://acleddata.com/acled-api-documentation
- Fields available: event_type, sub_event_type, actor1, actor2, country,
  location, latitude, longitude, fatalities, event_date, notes, source

### Rate limits
- Free tier: 500 events per call, paginated
- For full global 30-day history (~15,000 events), implement pagination loop
  in `_fetchData()` across multiple calls

### Example API call
```
GET https://api.acleddata.com/acled/read
  ?email=your@email.com
  &key=YOUR_KEY
  &event_date=20260101
  &event_date_where=BETWEEN
  &event_date_end=20260605
  &limit=500
  &fields=event_date|event_type|latitude|longitude|fatalities|location
```

## Visual Concept

Vertical spikes (thin box geometry, pivot at base) rising from the terrain
surface at each event's lat/lon. Height encodes fatalities on a log scale:
zero-fatality events are 0.5 scene units tall; 100+ fatality events reach
12 units (visible from medium zoom). Color encodes event type:

| Color | Event Type |
|-------|-----------|
| 🔴 Red | Battles |
| 🟠 Orange | Explosions / Remote violence |
| 🟣 Magenta | Violence against civilians |
| 🔵 Blue | Protests |
| 🟡 Yellow | Riots |
| 🟢 Green | Strategic developments |

Events within the last 7 days are rendered at full brightness; older events
(up to 30 days) fade to 50% brightness to create temporal depth.

The layer is **off by default** — analysts opt in via the layer panel, as
the density of conflict data can visually overwhelm the maritime picture.

## Implementation Approach

`THREE.InstancedMesh` with `BoxGeometry(0.3, 1, 0.3)` translated upward so
pivot is at the base. Scale Y drives spike height per instance. Additive
blending prevents spikes from obscuring underlying terrain while creating
a natural glow effect against dark terrain.

Pulse animation (sin wave on Y scale) is applied only to the top 30% of
events by height, limiting per-frame matrix writes to a manageable subset.

For improved visual density clustering, a future enhancement could merge
nearby events (within 0.5 scene units) into a single taller spike — reducing
draw count in conflict-dense regions.

## Research Notes

- ACLED homepage: https://acleddata.com/
- API documentation: https://acleddata.com/acled-api-documentation
- ACLED Early Warning Dashboard (2025): merged Trendfinder + CAST tools
- Bellingcat ACLED guide: https://bellingcat.gitbook.io/toolkit/more/all-tools/acled

## Next Steps

1. Register for free API key at https://acleddata.com/register/
2. Replace `YOUR_EMAIL` and `YOUR_API_KEY` in `conflictEventManager.js`
3. Add CONFLICT constants block to `config.js`
4. Copy manager to project root and import in `main.js`
5. Wire `update(camera, delta)` into animation loop
6. Add legend rendering to `uiController.js` — listen for `vg1:conflictLegend`
7. Consider: cross-reference with `portManager.js` port coords to auto-alert
   when conflict events appear within 50km of a major port
