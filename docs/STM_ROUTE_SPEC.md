# VANGUARD1 — STM Route Plan & Enhanced Monitoring

**Design specification, v0.1 — 2026-07-29**
Scope: Route Plan exchange (RTZ 1.1 + STM extensions, S-421) and Enhanced Monitoring,
with a SECOM/VIS interop path. Spec only — no code written yet.

---

## 0. Executive summary

Vanguard1 today is a **VTMS**: it observes where ships *are*. STM is a different paradigm —
it exchanges where ships *intend to go*. Everything in this spec follows from that one
distinction.

The unit of work is the **voyage plan**: an RTZ document a vessel shares, carrying waypoints,
per-leg corridor limits (XTD), safety depths, speed envelopes, and a schedule of ETAs.
Enhanced Monitoring is then almost embarrassingly simple to state — compare observed position
and time against the plan the ship itself declared — and the entire difficulty is in
(a) getting a plan at all, (b) the geodesy, and (c) not lying when there is no plan.

**Eight new modules, three phases.** Phase 1 is fully offline and needs no network: a canonical
voyage-plan model, an RTZ codec, route geometry math, a 3D route layer, and the monitor.
Phase 2 adds S-421. Phase 3 adds the SECOM/VIS network surface, which **must live in a Node
sidecar, not the browser** — see §7.1, this is the single biggest architectural constraint in
the whole design.

**Three prerequisite fixes in `aisManager.js` block everything.** They are small. They are not
optional. See §1.

---

## 1. Prerequisites — fix these before writing any STM code

These are in `aisManager.js` and each one silently destroys a downstream STM computation.

### 1.1 SOG is rounded to an integer — `aisManager.js:551`, `:525`

```js
speedKts: Math.round(report.Sog)
```

AIS transmits SOG in 0.1-knot steps. Rounding to integer discards a factor-of-ten of
precision. At 12 kn a ±0.5 kn error is ±4%, which over a 6-hour leg is a **±14 minute ETA
error** — larger than most schedule tolerances you would ever want to alarm on. Every
projected-ETA computation in §5.3 inherits this error.

**Fix:** store `Math.round(report.Sog * 10) / 10`. Keep the integer value as a separate
`speedKtsDisplay` if any UI depends on the rounded form, rather than rounding at the source.

### 1.2 COG is discarded — `aisManager.js:493`

```js
headingDeg: TrueHeading < 511 ? TrueHeading : cog   // cog then thrown away
```

Heading is where the bow points. COG is where the ship is actually going. In a beam current
or strong wind they differ by the drift angle — routinely 5–15° for a laden vessel in a
cross-set, and the difference *is the signal* for a set-and-drift excursion off the route
axis. Collapsing them into one field makes cross-track drift indistinguishable from a
deliberate turn.

**Fix:** store both. `headingDeg` (may be null — the existing null-heading handling in
`vesselInstruments.js:127-133` is correct and should be preserved) and `cogDeg` as separate
fields. Enhanced Monitoring uses `cogDeg`; the bearing dial keeps using `headingDeg`.

### 1.3 Navigational status is never parsed — absent everywhere

AIS message types 1/2/3 carry a 4-bit navigational status (0 = under way using engine,
1 = at anchor, 2 = not under command, 3 = restricted manoeuvrability, 5 = moored,
6 = aground, 7 = engaged in fishing, 8 = under way sailing, …). Vanguard1 parses none of it.

Without it: a vessel at anchor inside its XTD corridor is indistinguishable from one under
way, so schedule alarms fire on ships that are legitimately stopped and waiting; anchorage
and berth cannot be told apart in `portCallManager`; and "not under command" — the one status
that most justifies suppressing a deviation alarm — is invisible.

**Fix:** parse `Message.PositionReport.NavigationalStatus` into `vessel.navStatus` (integer)
and `vessel.navStatusText`. Null when absent. Enhanced Monitoring gates on it (§5.6).

### 1.4 Secondary — worth knowing, not blocking

- `vessel.history` is declared at `:581` and never written. Real track history lives in
  `rollingRecorder._byMmsi`, decimated to ~1 sample / 30 s (`vesselInstruments.js:198`).
  30-second resolution is *adequate* for cross-track monitoring (a 20 kn ship moves 170 m in
  30 s, well inside a typical 0.2 NM XTD) but marginal for reconstructing a turn. Phase 1
  reads `rollingRecorder`; do not build a second buffer until something proves it necessary.
- `vessel.eta` is a **display string** `"MM/DD HH:mmZ"` with no year (`:403-407`). It is the
  crew's declared destination ETA from AIS static data. It is *not* the RTZ schedule and must
  never be conflated with it. Keep the field, keep it a string, and give the RTZ schedule its
  own home in the voyage plan model.
- `alertsManager` uses `Date.now()` (`:83, :149`) rather than `simClock.now()`. STM alerts
  must survive time-scrubbing, so new alert raises should carry an explicit simClock
  timestamp in `extra` until that inconsistency is resolved properly.

---

## 2. The standards, and which ones we actually implement

Confirmed against primary sources, July 2026.

| Artefact | What it is | Our stance |
|---|---|---|
| **RTZ 1.0** | Route plan XML, normative **Annex S of IEC 61174:2015 Ed.4**. Namespace `http://www.cirm.org/RTZ/1/0`. The de-facto ECDIS interchange format today. | **Read + write. This is the primary format.** |
| **RTZ 1.1 + STM extensions** | STM Validation's extended schema, namespace `http://www.cirm.org/RTZ/1/1`. All STM additions live in `<extensions>` (`RouteInfoExtensionSTM`, `ScheduleElementExtensionSTM`). Adds `routeStatus`, UVID. | **Read + write. This is what VIS speaks.** |
| **RTZ 1.2** | **IEC PAS 61174-1:2021**. Adds test clauses; *retains v1.0 schema unchanged* so PAS conformance doesn't break 61174:2015 conformance. | Accept on read. Emit 1.1. |
| **S-421** | The same model re-expressed in **S-100 / GML 3.2**. Published as **IEC 63173-1:2021**, IHO registry v1.0.0, 2021-06-01. Adds `RouteActionPoint`, `RouteScheduleRecommended`, standardised IDs. | **Phase 2, read + write.** See §2.1 for the caveat. |
| **SECOM** | **IEC 63173-2:2022 Ed.1.0**, published 2022-05-30. Secure ship-shore exchange: REST API + mutual TLS + payload signing + service discovery. Payload-agnostic; `S421` and `RTZ` are *separate* `dataProductType` enum members. | **Phase 3, Node sidecar only.** |
| **STM VIS REST v2.2** | The Voyage Information Service API. `/voyagePlans`, `/voyagePlans/subscription`, `/textMessage`, `/area`, `/acknowledgement`. This is how a shore centre subscribes to a ship's route. | **Phase 3.** Model the client and the server. |
| **S-124** | Navigational warnings, S-100 based. Delivered to ECDIS as hazard polygons via VIS `POST /area`. | Phase 3, stretch. |
| **MCP / MRN** | Maritime Connectivity Platform — Identity Registry (X.509 CA), Service Registry, and the `urn:mrn:...` identifier scheme. STM voyages use `urn:mrn:stm:voyage:id:<org>:<UUID>`. | Adopt the **identifier scheme** in Phase 1. Defer the PKI to Phase 3. |

### 2.1 Two honesty caveats to bake into the docs, not discover later

**S-421 v1.0.0 is built on S-100 Edition 4.0.0. S-100 Edition 5.2.1 came into force
2026-01-01.** A v1.1 uplift has been in progress since 2024 and its publication status could
not be confirmed. So: implement S-421 against the published 1.0.0 schema, isolate it behind
the codec boundary (§4.2), and expect to redo it. Do not let S-421 types leak into the
canonical model.

**There is no IMO mandate for SECOM or S-421.** IMO Res. MSC.530(106) — the revised ECDIS
performance standards — contains no mention of SECOM, IEC 63173, S-421 or RTZ. This is
sometimes claimed and it is wrong. IALA Guideline **G1157 Ed.2.0** defers S-100 web-service
API implementation to IEC 63173-2, which is the strongest real endorsement. Say that
precisely; do not upgrade it to a mandate in any demo narration.

---

## 3. The RTZ data model, as we will consume it

Extracted from the Annex S / STM RTZ specification. Attribute names are exact.

```xml
<route version="1.1" xmlns="http://www.cirm.org/RTZ/1/1">
  <routeInfo routeName="..." vesselMMSI="265177000" vesselIMO="9123456"
             vesselVoyage="urn:mrn:stm:voyage:id:acme:b6d7b492-..."
             routeStatus="7" .../>
  <waypoints>
    <defaultWaypoint><leg .../></defaultWaypoint>
    <waypoint id="1" revision="0" name="..." radius="0.5">
      <position lat="57.6" lon="11.6"/>
      <leg starboardXTD="0.2" portsideXTD="0.2"
           safetyContour="20" safetyDepth="15"
           geometryType="Loxodrome" speedMin="8" speedMax="14"
           draughtForward="9.5" draughtAft="10.1"
           staticUKC="1.0" dynamicUKC="1.5" masthead="45"
           legNote1="..." legNote2="..."/>
    </waypoint>
  </waypoints>
  <schedules>
    <schedule id="1" name="Monitoring">
      <manual>
        <scheduleElement waypointId="1" eta="2026-07-29T14:00:00Z"
                         etaWindowBefore="00:30" etaWindowAfter="01:00"
                         etd="..." stay="00.02.00" speed="12.5" speedWindow="1.0"
                         windSpeed="..." currentSpeed="..." fuel="..."/>
      </manual>
      <calculated><!-- same shape --></calculated>
    </schedule>
  </schedules>
  <extensions>
    <extension manufacturer="STM" name="RouteInfoExtensionSTM" version="1.1"/>
  </extensions>
</route>
```

### 3.1 Fields that carry the monitoring logic

These four are the ones that matter, and the crucial point is that **they are per-leg values
declared by the ship itself** — not thresholds we invent:

| Field | Unit | Used by |
|---|---|---|
| `leg/@portsideXTD`, `leg/@starboardXTD` | nautical miles¹ | Cross-track alarm (§5.2) |
| `scheduleElement/@eta` + `@etaWindowBefore` / `@etaWindowAfter` | ISO 8601 + `HH:MM` | Schedule alarm (§5.3) |
| `leg/@safetyDepth`, `@safetyContour` | metres | Grounding alarm (§5.4) |
| `leg/@speedMin`, `@speedMax`, `scheduleElement/@speedWindow` | knots | Speed-envelope alarm (§5.5) |

¹ **Unit ambiguity — resolve at parse time.** Annex S specifies XTD as a decimal 0.0–10.0 in
nautical miles. Several STM documents describe XTD in metres. A value of `200` is
unambiguously metres; a value of `0.2` is unambiguously NM. Implement
`normaliseXTD(v)`: if `v > 10` treat as metres and convert, else treat as NM; record which
branch fired in the parse report and surface it. Never silently guess.

### 3.2 `routeStatus` — the STM enum, and why 7 is special

| # | Status |
|---|---|
| 1 | Original |
| 2 | Planned for voyage |
| 3 | Optimized |
| 4 | Cross-checked |
| 5 | Safety-checked |
| 6 | Approved |
| **7** | **Used for monitoring** ← Enhanced Monitoring keys on this |
| 8 | Inactive |

Only a route at **status 7** is loaded in the ship's ECDIS and being steered. Monitoring a
route at any other status is monitoring an intention that nobody is executing. The monitor
must filter on this, and the UI must show the status, because "this ship is 2 NM off a route
it never activated" is not a finding.

Only one active schedule should exist at status 7.

---

## 4. Module design

Eight new modules. Each follows the established Vanguard1 shape: a `config.js` namespace, a
timer-driven `tick()` for O(n·m) work, a separate per-frame `updateVisuals()` where there is
a visual half, a singleton with getters as the owner of shared state, and a `window.vg1*`
debug mirror that is **not** the data path.

```
                    ┌──────────────────────────────────────────┐
                    │        NODE SIDECAR (stm-proxy.js)       │
                    │  mTLS · X.509 · payload signing          │
                    │  SECOM /v1/* · VIS /voyagePlans/*        │
                    └───────────────────┬──────────────────────┘
                                        │ plain HTTP/WS, localhost
  ┌─────────────────────────────────────▼──────────────────────────────────┐
  │ BROWSER                                                                │
  │                                                                        │
  │  rtzCodec.js ─┐                                                        │
  │  s421Codec.js ─┼──► voyagePlanStore.js ◄── stmClient.js                │
  │               │      (owner of plans)                                  │
  │               │            │                                           │
  │               │            ├──► routeLayer.js ──► scene (3D ribbons)   │
  │               │            │         ▲                                 │
  │               │            │         │ uses                            │
  │               │            └──► routeGeometry.js  (pure math)          │
  │               │                      ▲                                 │
  │               │                      │ uses                            │
  │               └──────────► enhancedMonitor.js ──► window.alertsManager │
  │                                  ▲                └─► vg1:routeDeviation│
  │                                  │ reads                               │
  │                             entityStore.ships()                        │
  │                             simClock.now()                             │
  └────────────────────────────────────────────────────────────────────────┘
```

### 4.1 `voyagePlanStore.js` — owner of the plan collection

Modelled directly on `entityStore.js`, which CLAUDE.md names as the pattern for shared state.
This is the **only** module that may mutate the plan collection.

```js
// Canonical model — format-neutral. Neither RTZ nor S-421 types appear here.
VoyagePlan = {
  uvid,              // urn:mrn:stm:voyage:id:<org>:<uuid> — the identity
  mmsi, imo,         // string | null. mmsi is the join key to entityStore
  vesselName,        // string | null
  routeName,         // string | null
  routeStatus,       // 1..8 | null
  routeAuthor,       // string | null
  validFrom, validTo,// ms epoch | null
  sourceFormat,      // 'RTZ_1_0' | 'RTZ_1_1' | 'RTZ_1_2' | 'S421_1_0_0' | 'SYNTHETIC'
  sourceOrigin,      // 'file' | 'vis' | 'secom' | 'scenario'
  receivedAt,        // simClock.now()
  waypoints: [ Waypoint ],
  schedules: [ Schedule ],
  parseReport,       // ParseReport — see below. NEVER null.
  raw                // the original document text, retained verbatim for re-export
}

Waypoint = {
  id, revision, name,
  lat, lon,
  radius,            // NM | null
  leg: Leg | null    // the leg INBOUND to this waypoint (RTZ convention)
}

Leg = {
  geometryType,      // 'Loxodrome' | 'Orthodrome'  (default Loxodrome)
  portsideXTD,       // NM | null  ← normalised, see §3.1
  starboardXTD,      // NM | null
  safetyDepth,       // m | null
  safetyContour,     // m | null
  speedMin, speedMax,// kn | null
  draughtForward, draughtAft, staticUKC, dynamicUKC, masthead,  // m | null
  note1, note2
}

Schedule = {
  id, name,
  kind,              // 'manual' | 'calculated' | 'recommended'  (recommended is S-421 only)
  elements: [ { waypointId, eta, etd, etaWindowBefore, etaWindowAfter,
                etdWindowBefore, etdWindowAfter, stay, speed, speedWindow } ]
                     // eta/etd are ms epoch | null; windows are ms durations | null
}

ParseReport = {
  ok, format, version,
  warnings: [ {code, detail, waypointId?} ],   // e.g. XTD_UNIT_INFERRED, ETA_UNPARSEABLE
  droppedElements: [ string ],
  xtdUnitInferred: 'NM' | 'M' | null
}
```

**API** (singleton, `entityStore` shape):

```
add(plan) · removeByUvid(uvid) · clear()
all() → VoyagePlan[]          // stable reference
byUvid(uvid) · byMmsi(mmsi)   // byMmsi returns the ACTIVE plan (status 7) or null
allByMmsi(mmsi)               // every plan for that vessel, any status
monitored()                   // every plan at routeStatus === 7 within validity window
```

Persistence: `localStorage['vg1_voyage_plans']`, debounced flush following
`portCallManager.js:35-58`. Cap by count and by total bytes — RTZ documents for a long ocean
passage can run to hundreds of waypoints, so a raw-text cap matters more here than an entry
count. Suggest 200 plans / 4 MB, evict oldest `receivedAt` first, and **log the eviction** —
silent truncation is the failure mode CLAUDE.md's honesty principle exists to prevent.

Events emitted: `vg1:voyagePlanReceived`, `vg1:voyagePlanActivated` (status → 7),
`vg1:voyagePlanExpired`.

Debug mirror: `window.vg1Plans`.

### 4.2 `rtzCodec.js` / `s421Codec.js` — format at the edge

Both expose the same pair and nothing else:

```js
parse(xmlString) → { plan: VoyagePlan|null, report: ParseReport }
serialise(plan, {version}) → xmlString
```

**The codec boundary is the whole point.** S-421 v1.0.0 sits on S-100 Ed.4.0.0 while the
in-force edition is 5.2.1; a v1.1 is in progress with unconfirmed status. That schema *will*
move. If S-421 GML types are visible anywhere outside `s421Codec.js`, the uplift becomes a
refactor of the entire subsystem instead of one file.

Parsing: use the browser's native `DOMParser` — no XML library, consistent with the project's
no-bundler stance. S-421's GML geometry needs a small `gml:Point`/`gml:posList` reader; that
is roughly 60 lines and does not justify a dependency.

Round-trip requirement: `parse(serialise(parse(x).plan)).plan` must deep-equal
`parse(x).plan`. This is the phase-1 acceptance test and it catches unit-conversion bugs
immediately.

**Retain `raw`.** When re-exporting a plan we received, emit the original bytes unless the
plan was modified. RTZ carries vendor `<extension>` elements with arbitrary child nodes that
we do not model and must not destroy.

### 4.3 `routeGeometry.js` — pure math, no THREE

Depends on nothing. Testable in plain Node. Extends the existing primitives
(`haversineNm`, `bearingDeg` in `dataSource.js:32-45`) rather than duplicating them —
that module is already the established home for maritime geodesy and `portCallManager.js:30`
sets the precedent for importing from it.

```js
// Rhumb-line (Mercator) pair — RTZ's default geometryType
rhumbDistanceNm(lat1, lon1, lat2, lon2)
rhumbBearingDeg(lat1, lon1, lat2, lon2)
rhumbDestination(lat, lon, bearingDeg, distNm)

// Great-circle
gcCrossTrackNm(latP, lonP, latA, lonA, latB, lonB)   // signed: + = starboard of A→B
gcAlongTrackNm(latP, lonP, latA, lonA, latB, lonB)
gcInterpolate(latA, lonA, latB, lonB, f)             // for orthodrome tessellation

// Rhumb cross-track — NOT the great-circle formula
rhumbCrossTrackNm(latP, lonP, latA, lonA, latB, lonB)

// Route-level
projectOntoRoute(lat, lon, plan) → {
  legIndex,          // which leg the vessel is on, or null if off the route entirely
  crossTrackNm,      // signed
  alongTrackNm,      // from the leg's start waypoint
  distanceToNextWpNm,
  distanceToEndNm,
  snapLat, snapLon   // the foot of the perpendicular
}
```

**Two things that are easy to get wrong:**

**Cross-track must match the leg's `geometryType`.** A loxodrome and an orthodrome between
the same two points diverge — on a 500 NM leg at 60°N the great-circle sags several miles
south of the rhumb line. Using the great-circle cross-track formula on a leg the ship is
steering as a rhumb line manufactures a deviation that does not exist. Dispatch on
`leg.geometryType`, defaulting to Loxodrome per RTZ.

**Leg assignment is not "nearest leg".** A route that doubles back on itself (a survey
pattern, a river with a hairpin) has two legs close to the same point. Assign by
**progression**: prefer the leg the vessel was on last tick, advance when `alongTrackNm`
exceeds the leg length (with waypoint `radius` as the turn-acceptance circle), and only fall
back to a global nearest-leg search when the vessel is outside every corridor. Store the
current leg index in the monitor's per-MMSI state (§5.1). This also gives non-arrival
detection for free.

**A pleasant property of your coordinate system:** `lonLatToScene()` is a Mercator
projection, and **a loxodrome is a straight line in Mercator**. So a rhumb-line leg renders
as a straight segment in scene space with zero tessellation. Only orthodrome legs need
subdivision. Tessellate those at ~25 NM or 2° of longitude, whichever is finer.

### 4.4 `routeLayer.js` — the 3D route

Follows the layer convention in CLAUDE.md exactly: exposes `setVisible(on)`, gets a
`.lp-row[data-layer="routes"]` in `index.html` and a `case` in the `layerToggle` switch in
`main.js`. Registers nothing in `entityStore` (routes are not entities).

Renders per monitored plan:

| Element | Geometry | Notes |
|---|---|---|
| **Centreline** | `Line2` / fat line, tessellated per §4.3 | Colour by deviation state (§5.7) |
| **XTD corridor** | Two offset polylines + a translucent ribbon mesh between them | Offsets are per-leg and asymmetric (`portsideXTD` ≠ `starboardXTD`). This is the visual that makes STM legible at a glance and it is the money shot for a demo. |
| **Waypoints** | Instanced octahedron + turn-radius ring | Reuse the `portManager.js` pip pattern. `InstancedMesh` — CLAUDE.md's rule is ≥20 same-type objects get instanced, and a route has hundreds. |
| **Action points** | Distinct glyph | S-421 only. Phase 2. |
| **Schedule ticks** | Small marks at scheduled ETA positions | Optional; makes schedule slip visible spatially. |
| **Ghost position** | A faint hull at where the ship *should* be now per schedule | Cheap, and it explains "out of schedule" better than any number. |

**Performance.** One `Line2` per route is fine at demo scale (tens of routes). Do not build
geometry in `updateVisuals()` — build once on `vg1:voyagePlanReceived`, then only update
material uniforms per frame. This is the exact failure CLAUDE.md lists under "FPS drops on
map load".

**Altitude.** Routes are sea-level features. Draw them at a small fixed `y` above the water
plane with `depthTest` on, matching how `portManager` clamps to terrain. Do not sample
terrain height per vertex — a 400-waypoint route would be 400 samples per rebuild.

**Bloom.** Route materials must stay below the bloom threshold (0.95) or the corridor ribbon
will blow out the scene. CLAUDE.md flags this as a hairpin. Use unlit `MeshBasicMaterial`
with opacity, not emissive.

### 4.5 `enhancedMonitor.js` — the deviation engine

The heart of it. Shaped exactly like `portCallManager`: a per-MMSI `Map` of state, a
`tick(vessels)` on a `config.js` timer (not per frame), and a `vg1:*` event on state change.

Detailed in §5.

### 4.6 `stmClient.js` — browser side of interop

Talks only to the local sidecar over plain HTTP/WebSocket. Knows nothing about TLS, X.509 or
signatures. Provides:

```js
listRemotePlans(filter) · fetchPlan(uvid) · subscribe(uvid|null) · unsubscribe(uvid)
pushPlan(plan, target) · sendTextMessage(uvid, text) · sendArea(uvid, s124Xml)
onPlanPushed(cb)     // sidecar → browser, via WebSocket
```

### 4.7 `stm-proxy.js` — the Node sidecar

See §7. Precedent: `flight-proxy.js` (73 KB) and the copilot on `localhost:8787` already
establish that Vanguard1 runs Node-side helpers.

### 4.8 `config.js` → `STM` namespace

Every constant lives here, per CLAUDE.md's rule that managers never hardcode.

```js
export const STM = {
  // Monitoring cadence
  TICK_MS: 5000,                    // deviation evaluation interval

  // Defaults used ONLY when the plan omits the value. See §5.8 — these are
  // OUR choices, not standard values. Every alarm raised on a default must
  // say so in its payload.
  DEFAULT_XTD_NM: 0.5,
  DEFAULT_SCHEDULE_TOLERANCE_MS: 30 * 60 * 1000,

  // Hysteresis — an alarm must persist before it fires, and clear before it clears
  DEVIATION_CONFIRM_MS: 60_000,
  DEVIATION_CLEAR_MS: 120_000,
  ALARM_COOLDOWN_MS: 15 * 60 * 1000,   // per (mmsi, alarmType)

  // Gating
  MONITOR_ONLY_STATUS_7: true,
  MIN_SOG_FOR_SCHEDULE_KTS: 0.5,    // below this, projected ETA is meaningless
  SUPPRESS_ON_NAV_STATUS: [1, 2, 3, 5, 6],  // anchored, NUC, restricted, moored, aground

  // Geometry
  ORTHODROME_TESSELLATION_NM: 25,
  XTD_UNIT_THRESHOLD: 10,           // >10 ⇒ the value is metres, not NM

  // Store
  MAX_PLANS: 200,
  MAX_PLAN_BYTES: 4 * 1024 * 1024,
  PLAN_FLUSH_MS: 4000,

  // Interop
  PROXY_URL: 'http://localhost:8788',
  ORG_MRN_PREFIX: 'urn:mrn:stm:voyage:id:vanguard1',
};
```

---

## 5. Enhanced Monitoring — the algorithms

### 5.1 Per-vessel monitor state

```js
MonitorState = {
  mmsi, uvid,
  legIndex,              // current leg, for progression-based assignment (§4.3)
  crossTrackNm,          // signed, latest
  alongTrackNm,
  distanceToNextWpNm,
  projectedEtaNextWp,    // ms | null
  scheduleSlipMs,        // + = late | null
  alarms: Map<type, {since, confirmed, lastRaised, evidence}>,
  state,                 // 'ON_TRACK' | 'DEVIATING' | 'OFF_ROUTE' | 'NO_FIX' | 'UNMONITORED'
  lastEvaluated          // simClock.now()
}
```

### 5.2 `OFF_XTE` — cross-track deviation

The STM Validation shore-side implementation (deliverable D2.9/D2.11) defines this verbatim
as: *"the target deviates from the route axis by more than the `portsideXTD` /
`starboardXTD` value of RTZ."*

```
leg   = plan.waypoints[state.legIndex].leg
xt    = crossTrack(vessel, leg)          // signed, NM, method per leg.geometryType
limit = xt >= 0 ? leg.starboardXTD : leg.portsideXTD
if (limit == null) limit = STM.DEFAULT_XTD_NM, mark evidence.usedDefault = true
breach = Math.abs(xt) > limit
```

The threshold is **the ship's own declared corridor**, asymmetric, per leg. Do not invent a
global constant. This is the single most important structural fact about Enhanced Monitoring
and the thing most implementations get wrong.

Hysteresis: a breach must hold for `DEVIATION_CONFIRM_MS` before the alarm confirms, and
clear for `DEVIATION_CLEAR_MS` before it releases. A ship cutting a corner inside the
waypoint turn radius will momentarily exceed XTD and that is normal navigation, not a
deviation. **Suppress entirely while within `waypoint.radius` of a turn.**

### 5.3 `OUT_OF_SCHEDULE` — schedule slip

STM's definition: *"the target's ETA to the next waypoint is behind the schedule."*

```
sched = activeSchedule(plan)                         // the one at status 7
elem  = sched.elements.find(e => e.waypointId === nextWaypoint.id)
if (!elem?.eta) → null, state UNKNOWN (not compliant, not deviating)

sog = vessel.speedKts                                 // needs §1.1 fixed
if (sog < STM.MIN_SOG_FOR_SCHEDULE_KTS) → null       // stopped: projection meaningless

projectedEta = simClock.now() + (distanceToNextWpNm / sog) * 3600_000
slip         = projectedEta - elem.eta
tolerance    = slip > 0 ? (elem.etaWindowAfter  ?? STM.DEFAULT_SCHEDULE_TOLERANCE_MS)
                        : (elem.etaWindowBefore ?? STM.DEFAULT_SCHEDULE_TOLERANCE_MS)
breach       = Math.abs(slip) > tolerance
```

RTZ carries `etaWindowBefore` / `etaWindowAfter` **per waypoint**, so a compliant
implementation has per-waypoint tolerances without inventing any. Use them when present.

Note the projection uses distance **to the next waypoint along the route**, not
great-circle-direct — a ship that has to round a headland is not "ahead of schedule" because
the headland is close in a straight line.

### 5.4 `GROUNDING_ON_ROUTE` — safety depth

STM's definition: *"the `Draught` parameter value for the route target is larger than the
`safetyDepth` value of RTZ."*

```
draught = vessel.draughtM                    // AIS static, bounded 0<d≤30 (aisManager:446-450)
breach  = draught != null && leg.safetyDepth != null && draught > leg.safetyDepth
```

Both operands nullable, so this alarm is frequently `null` — most AIS targets never broadcast
a valid static draught. That is correct behaviour, not a gap. Render "—", never "safe".

Note this is a *plan consistency* check — the ship's declared draught against its own declared
safety depth — not a real UKC computation. Real UKC needs bathymetry, tide and squat, and is
out of scope here. Say so in the UI label: this is **"safety depth conflict"**, not
"grounding risk".

### 5.5 `SPEED_OUT_OF_ENVELOPE`

```
breach = (leg.speedMin != null && sog < leg.speedMin - (elem?.speedWindow ?? 0)) ||
         (leg.speedMax != null && sog > leg.speedMax + (elem?.speedWindow ?? 0))
```

Low value on its own; useful as corroborating evidence attached to a schedule alarm.

### 5.6 `NON_ARRIVAL` and `ROUTE_ABANDONED`

Two derived states IALA's VTS use-case list calls out and RTZ does not directly support:

- **`NON_ARRIVAL`** — `projectedEta` for the *final* waypoint has passed by more than its
  tolerance and the vessel is still under way. This is the one that matters operationally: a
  ship that never showed up.
- **`ROUTE_ABANDONED`** — the vessel is outside every leg corridor by more than
  `5 × max(XTD)` for longer than `10 × DEVIATION_CONFIRM_MS`, or `projectOntoRoute` returns
  `legIndex === null` persistently. Downgrade the plan's effective status locally and stop
  raising XTE alarms — an abandoned route generates alarm spam otherwise. Do **not** mutate
  the stored `routeStatus`; the ship owns that field. Track it as monitor state.

### 5.7 Vessel/route visual states

| State | Meaning | Colour cue |
|---|---|---|
| `UNMONITORED` | No plan shared. **The overwhelming majority of real AIS traffic.** | Neutral — the existing vessel colouring, no route drawn |
| `ON_TRACK` | Plan at status 7, inside corridor, on schedule | Route drawn calm |
| `DEVIATING` | One or more alarms confirmed | Route + corridor tinted, alarm badge |
| `OFF_ROUTE` | Outside corridor by a wide margin / abandoned | Route drawn faint, vessel flagged |
| `NO_FIX` | Plan exists but the vessel is dark or stale | Route drawn, ghost position shown, explicit "no position" |

### 5.8 The honesty rules for this subsystem

CLAUDE.md documents an "honesty principle" enforced culturally throughout the codebase —
derived fields must be `null` when the input is unknown, and approximations state their own
limits. Enhanced Monitoring has three specific traps.

**1. `UNMONITORED` ≠ compliant.** Essentially no live AIS vessel shares an RTZ plan. If the
UI shows a fleet where five ships have route ribbons and four hundred do not, an operator
will read the four hundred as "fine". They are *unknown*. The layer needs an explicit count —
"12 of 431 vessels monitored" — visible whenever the route layer is on. This is the single
most important UI decision in the spec.

**2. Defaults must announce themselves.** `STM.DEFAULT_XTD_NM` and
`DEFAULT_SCHEDULE_TOLERANCE_MS` are **our inventions**. No numeric Enhanced Monitoring
threshold exists in any primary STM source — the criteria are per-leg RTZ values, full stop.
When an alarm fires on a default rather than a declared value, the alert payload carries
`usedDefault: true` and the UI says "assumed 0.5 NM (not declared)". Otherwise the system
manufactures authority it does not have.

**3. Synthetic routes must be labelled.** Phase 1 generates routes from scenario waypoints
(§6.1). A synthetic route has `sourceFormat: 'SYNTHETIC'` and must render visually distinct
from a received one. Never let a demo blur the line between "this ship shared its plan" and
"we made one up for it".

### 5.9 Alert integration

`window.alertsManager.addAlert(...)` is the ready-made output channel (`alertsManager.js:588`).
New types need **both** a `TYPE_META` entry (`:16-31`) and a `DEFAULT_RULES` entry (`:34-49`)
— `ZONE_BREACH` exists in the first without the second and is consequently unraisable, which
is the cautionary example.

| Type | Severity |
|---|---|
| `ROUTE_DEVIATION` | WARNING |
| `SCHEDULE_SLIP` | WARNING |
| `SAFETY_DEPTH_CONFLICT` | CRITICAL |
| `NON_ARRIVAL` | CRITICAL |
| `ROUTE_RECEIVED` | INFO |
| `ROUTE_SUGGESTION_SENT` | INFO |

The unused `extra` field (`:147`) is the natural carrier for structured evidence:

```js
extra: { uvid, legIndex, crossTrackNm, xtdLimitNm, usedDefault,
         scheduleSlipMs, projectedEta, declaredEta, simTime }
```

Dedup: `alertsManager` has none — it collapses consecutive same-type rows visually at render
time but nothing keys on `(type, mmsi)`. A deviation evaluated every 5 s would produce 12
identical alerts a minute. **The monitor must dedupe at the source** via
`STM.ALARM_COOLDOWN_MS` per `(mmsi, alarmType)`. Do not push this problem downstream.

---

## 6. Getting plans in — the bootstrapping problem

Real AIS gives you no route plans. Four sources, in build order:

### 6.1 Synthetic — from scenario waypoints (Phase 1, day one)

`SyntheticAISSource` scenarios already carry `entities[].waypoints` with `{lon, lat, t?}`
(`dataSource.js:118-136`), and `_buildLegs()` (`:159-175`) already derives leg times from
`haversineNm / speedKts`. That is a schedule. **Export a scenario entity as RTZ** and you get
a closed loop with no network: the ship follows the plan, you perturb it, monitoring fires.

Add to a scenario entity:
```js
{ mmsi, name, waypoints: [...],
  stmRoute: {                      // optional
    xtdNm: 0.2, safetyDepth: 15, speedMin: 8, speedMax: 14,
    deviate: { fromWpIndex: 3, offsetNm: 0.8 }   // deliberate excursion for testing
  } }
```

This gives you every acceptance test in §8 without touching a network stack, and it is
deterministic under `RecordedAISSource` replay.

### 6.2 File import (Phase 1)

Drag-and-drop an `.rtz` / `.rtzp` / `.xml` onto the map. STM publishes operational and
technical test data alongside the schema, and ECC's free S-421 creator emits both formats.
This is how you validate the codec against documents you did not write.

### 6.3 VIS subscription (Phase 3)

The real thing:

```
POST /voyagePlans/subscription   { callbackEndpoint, uvid? }
```

`callbackEndpoint` is mandatory; `uvid` optional — omitting it subscribes to *every* active
plan at status 1–7 the requester has access to. VIS checks the ship's ACL, returns the
current plan immediately, then **pushes** every update to the callback. The callback must
itself be a VIS-shaped `POST /voyagePlans` endpoint, which means the sidecar is both client
and server.

Caveat worth encoding: subscription support is per-instance, not universal. The Gothenburg
Shore Centre's own service instance description lists "Accept subscription request" as **No**
— it accepts voluntarily pushed plans instead. Read the G1128 service instance description
before assuming. Support both push-receive and subscribe.

### 6.4 SECOM (Phase 3)

`dataProductType` is `RTZ` or `S421` — they are separate enum members, so SECOM carries either.
Retrieval is `GET /v1/object` with `dataReference`, or `POST /v1/subscription`.

---

## 7. Interop architecture

### 7.1 The constraint that shapes everything: SECOM cannot run in a browser

SECOM mandates **mutual TLS with X.509 client certificates** plus **payload-level digital
signatures** (`SHA3_384_WITH_ECDSA` and five siblings) over a **two-layer signed envelope**.

A browser page cannot present a client certificate programmatically, cannot access a private
key for ECDSA signing without the user importing it into WebCrypto by hand, and cannot
control TLS negotiation. There is no workaround. Any claim that Vanguard1 "speaks SECOM" in
the browser is false.

**Therefore: `stm-proxy.js`, a Node sidecar on `localhost:8788`.** It holds the certificate
and key, terminates mTLS outbound, signs and verifies envelopes, and exposes a plain
localhost HTTP/WS surface to the browser. `flight-proxy.js` is the precedent and the shape to
copy. This is not a compromise — it is how every real SECOM implementation is built.

### 7.2 What the sidecar implements

**Outbound (client):** SECOM `GET /v1/object`, `POST /v1/subscription`,
`GET /v1/capability`, `GET /v1/ping`, `POST /v1/searchService`; VIS `GET/POST /voyagePlans`,
`POST /voyagePlans/subscription`.

**Inbound (server):** `POST /v1/object` (receive a pushed plan),
`POST /v1/subscription/notification`, `POST /v1/acknowledgement`; VIS `POST /voyagePlans`
(the subscription callback).

Envelope shape to implement:

```
UploadObject { envelope: EnvelopeUploadObject, envelopeSignature }
EnvelopeUploadObject {
  data(base64), containerType, dataProductType, exchangeMetadata,
  fromSubscription?, ackRequest?, transactionIdentifier(UUID),
  envelopeSignatureCertificate, envelopeRootCertificateThumbprint, envelopeSignatureTime
}
SECOM_ExchangeMetadataObject {
  dataProtection, protectionScheme:"SECOM", digitalSignatureReference,
  digitalSignatureValue { publicRootCertificateThumbprint, publicCertificate, digitalSignature },
  compressionFlag
}
```

Constants: `ContainerTypeEnum` = `S100_DataSet`(0) | `S100_ExchangeSet`(1) | `NONE`(2).
`AckRequestEnum` = 0–3. `MAX_PAYLOAD_SIZE_IN_KB` = 350. Date format `yyyyMMdd'T'HHmmss`.
Certificate thumbprint hash: SHA-256.

**Serialisation trap, learned from the SMA/Saab interoperability test:** envelope signature
verification broke across implementations because JSON attribute ordering is ambiguous. The
adopted fix is to sign a canonical CSV serialisation in **declared attribute order**. Build
that in from the start; retrofitting it means every signature you ever produced is invalid.

**Two path conflicts to probe, not assume.** `GET /v1/object/summary` (reference
implementation) vs `/v1/summary` (2021 draft test) disagree, and a `/v1/publicKey` interface
is named in the IEC contents listing but absent from the reference implementation. Call
`GET /v1/capability` first and adapt.

### 7.3 Identity

Adopt the MRN scheme in Phase 1 even without PKI — it costs nothing and makes Phase 3 a
credential swap rather than a redesign. Voyage identity:
`urn:mrn:stm:voyage:id:vanguard1:<uuid>`. Service/org identity later comes from the MCP
Identity Registry as `urn:mrn:mcp:entity:<ipid>:<ipss>`, with maritime attributes (MMSI, IMO,
callsign, flag state) carried as custom OIDs in the certificate's SubjectAlternativeName.

Do not mint UVIDs for plans you receive. The ship owns its UVID and service providers must
not rewrite it.

---

## 8. Build order and acceptance tests

### Phase 1 — offline, no network (the bulk of the value)

| # | Deliverable | Acceptance test |
|---|---|---|
| 1.0 | `aisManager` prerequisite fixes (§1) | `tests/aisManager.sog.test.mjs` — 12.3 kn survives ingest as 12.3; COG and heading are distinct fields; nav status 1 parses |
| 1.1 | `routeGeometry.js` | Golden values against published great-circle/rhumb worked examples; rhumb vs GC cross-track differ measurably on a 500 NM leg at 60°N; leg progression handles a doubling-back route |
| 1.2 | `rtzCodec.js` | Round-trip identity on STM's published test data; XTD unit inference reports which branch fired; unknown `<extension>` nodes survive re-export byte-identical |
| 1.3 | `voyagePlanStore.js` | Add/replace/expire; status-7 filtering; eviction logs what it dropped |
| 1.4 | Scenario → RTZ export (§6.1) | A scenario entity round-trips to RTZ and back to the same track |
| 1.5 | `routeLayer.js` | Corridor ribbon renders with asymmetric XTD; loxodrome legs are straight in scene space; frame time unchanged with 20 routes loaded |
| 1.6 | `enhancedMonitor.js` | A scenario with `deviate: {fromWpIndex: 3, offsetNm: 0.8}` and XTD 0.2 raises exactly one confirmed `ROUTE_DEVIATION` — not twelve; a ship inside `waypoint.radius` cutting a corner raises none; a stopped ship raises no schedule alarm |
| 1.7 | File import + UI panel | STM test data and an ECC-generated file both load |

Phase 1 exit criterion: **replay a recorded AIS capture with an attached synthetic route and
get deterministic, correctly-deduped alarms.** `RecordedAISSource.isTimeBacked()` is true, so
this is reproducible under time-scrub — which makes it a genuine regression fixture.

### Phase 2 — S-421

`s421Codec.js` behind the same interface. GML 3.2 over the S-100 profile; verify the
namespace against the official 1.0.0 package at cirm.org rather than the draft schemas
floating in third-party repos. Add `RouteActionPoint` rendering and
`RouteScheduleRecommended` as a third schedule kind. Cross-format test: an ECC-converted
RTZ↔S-421 pair must produce identical canonical plans.

### Phase 3 — SECOM / VIS

`stm-proxy.js`, then `stmClient.js`. Start with `GET /v1/ping` and `GET /v1/capability`
against a public test instance — the IALA MCP test instance and the IHO SECOM instance both
exist. Get one signed envelope verified before building anything else; the signature
canonicalisation is where this phase will actually be spent.

Stretch: shore-to-ship. A route suggestion is an RTZ 1.1 pushed back via
`POST /voyagePlans`; a text message is TXT v1.3 via `POST /textMessage`; an area warning is
S-124 via `POST /area`. All three are proposals — the master decides. If you build the
suggestion path, the UI must never imply the shore side can command.

---

## 9. What this spec deliberately does not cover

- **Real under-keel clearance.** Needs bathymetry as *data* (you have `gebco_2026_geotiff.zip`
  and `gebco_terrarium.png`, but `sampleTerrainHeightXZ` is clamped `Math.max(0, …)` at every
  call site, so sub-sea values are discarded today), plus a tide model and a squat model.
  §5.4 is a plan-consistency check only and is labelled as such.
- **Ship-to-ship CPA/TCPA.** Deserves its own module (`shipConflictManager.js`, mirroring the
  existing aircraft `conflictManager.js`). Depends on the same §1 fixes. Natural next spec.
- **Route optimisation.** A different service entirely — weather routing, fuel models.
- **Port Call Synchronisation / PortCDM.** `portCallManager` is the seed; separate spec.
- **Real MCP enrolment.** Certificate issuance from a live Identity Registry is an
  organisational process, not a coding task.

---

## 10. Open questions for Jamal

1. **Demo target.** Is the audience maritime-domain (who will check whether the XTD corridor
   is asymmetric) or general (who wants the ribbon to look good)? It changes how much of
   Phase 2 is worth doing.
2. **Geographic focus.** The STM test data is Baltic/North Sea. Your `PORTS` and chokepoints
   are global. A Gothenburg–Rotterdam demo route lets you use real published test files;
   anywhere else means synthetic data only.
3. **`vessel.history` resolution.** 30-second decimation from `rollingRecorder` is adequate
   for corridor monitoring, marginal for turn reconstruction. Ship Phase 1 on it and see, or
   build a dedicated buffer now?
4. **Sidecar consolidation.** `flight-proxy.js` is on one port, the copilot on 8787, and this
   proposes 8788. Worth folding into one process, or keep them independent so a SECOM crash
   cannot take down flights?

---

## Sources

- [STM Services — Sea Traffic Management](https://www.seatrafficmanagement.info/stm-services/)
- [STM Message Formats and schemas](https://www.seatrafficmanagement.info/developers-forum/schemas/)
- [MONALISA 2.0 D1.3.2 — STM Voyage exchange format RTZ](https://stm-stmvalidation.s3.eu-west-1.amazonaws.com/uploads/20160420144429/ML2-D1.3.2-Voyage-Exchange-Format-RTZ.pdf)
- [ECDIS Annex S version 1.1 STM Extended — final proposal](https://stm-stmvalidation.s3.eu-west-1.amazonaws.com/uploads/20190322122013/ECDIS-Annex-S-version-1.1-STM-Extended_29032017_Final_Proposal.pdf)
- [RTZ 1.1 Guidelines v1.8 for STM](https://stm-stmvalidation.s3.eu-west-1.amazonaws.com/uploads/20190322122020/RTZ-Guidelines_v1.8_for_STM.pdf)
- [STM Validation D2.9 & D2.11 — Voyage Management testbed description](https://s3-eu-west-1.amazonaws.com/stm-stmvalidation/uploads/20190402151404/STMVal_D2.9-D2.11-STM-Voyage-Management-testbed-description.pdf)
- [VIS-REST-Design-for-SeaSWIM v2.2.21](https://stm-stmvalidation.s3.eu-west-1.amazonaws.com/uploads/20190318154808/VIS-REST-Design-for-SeaSWIM_v2.2.21.pdf)
- [Gothenburg Shore Centre service instance description v1.0](https://stm-stmvalidation.s3.eu-west-1.amazonaws.com/uploads/20190401201745/Gothenburg-SC-Service-instance-description_1.0.pdf)
- [IEC 63173-2:2022 (SECOM) — IEC Webstore](https://webstore.iec.ch/en/publication/64543)
- [gla-rad/SECOMLib — SECOM reference implementation](https://github.com/gla-rad/SECOMLib)
- [SECOM Test Project Final Report v1.0 — SMA / Saab](https://stm-stmvalidation.s3.eu-west-1.amazonaws.com/uploads/20211115152506/SECOM-Test-Project-Final-Report-1.0.pdf)
- [IALA Guideline G1157 Ed.2.0 — Web Service based S-100 Data Exchange](https://www.iala.int/content/uploads/2024/10/G1157-Ed2.0-Web-Service-based-S-100-Data-Exchange.pdf)
- [IEC 63173-1:2021 (S-421 Route Plan) — IEC Webstore](https://webstore.iec.ch/en/publication/32931)
- [IHO GI Registry — S-421 product specification](https://registry.iho.int/productspec/view.do?idx=185&product_ID=S-421)
- [CIRM — S-421 route plan exchange format](https://cirm.org/s-421/)
- [IALA TC03-12.2.1 — Liaison note to IEC on S-421 and VTS use cases](https://www.iala.int/content/uploads/2024/10/TC03-12.2.1-IALA-Liaison-note-to-IEC-on-S-421-and-VTS-use-cases.pdf)
- [IEC PAS 61174-1:2021 (RTZ 1.2) — IEC Webstore](https://webstore.iec.ch/en/publication/67774)
- [MCP — Maritime Resource Name specification](https://docs.maritimeconnectivity.net/en/latest/MRN.html)
- [MCP — Maritime Identity Registry](https://docs.maritimeconnectivity.net/en/latest/MIR.html)
- [IMO Resolution MSC.530(106)](https://wwwcdn.imo.org/localresources/en/KnowledgeCentre/IndexofIMOResolutions/MSCResolutions/MSC.530(106).pdf)
- [ElectronicChartCentre/Route-Portrayal](https://github.com/ElectronicChartCentre/Route-Portrayal)
- Sandaruwan et al., *Real-time 3D Vessel Traffic Monitoring System for Commercial Ports (3DVTMS)*, Proceedings of SEARCC 2013 — supplied by Jamal
