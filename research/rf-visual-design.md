# VANGUARD1 — RF Intelligence Visual Design

A style guide and visual treatment spec for the eight RF intelligence features. Designed to extend the existing aesthetic, not invent a new one.

---

## Section 1 — The VANGUARD1 Visual Language

VANGUARD1's look is **operational restraint with selective glow**. The map is a dark, cold, photographic-feeling globe — and the only things that emit light are the things that matter. Everything else is information, not decoration.

### Color palette (exact)

**Ocean / base**
- `#0a1224` — abyssal navy (renderer clear, deep ocean)
- `#0f1a30` — sea plane base
- `#162338` — shallow water gradient
- `#1d2c44` — atmospheric haze fallback

**Terrain**
- `#8a6a3a` — primary ochre (mid-elevation point splat)
- `#a98445` — high-altitude warm gold
- `#5e7a3c` — temperate green (vegetated splat)
- `#3c4f2a` — dark forest shadow
- `#c8a060` — desert / arid highlight

**Tactical UI (the "voice")**
- `#5cf0ff` — primary cyan (selected, active, hover)
- `#3ac8d6` — secondary cyan (idle UI lines, ribbons)
- `#1e7f8a` — dim cyan (inactive HUD chrome)
- `#0c2a30` — cyan-shadow (panel backdrops)

**Status / severity**
- `#9fb4c7` — INFO neutral (gray-blue)
- `#ffb547` — WATCH amber
- `#ff6a3d` — ALERT orange-red
- `#ff2a4d` — CRITICAL red
- `#ff6cf0` — anomaly magenta (RF noise, special class)
- `#b870ff` — secondary violet (used sparingly — space weather, ionosphere)

**Neutral grays**
- `#e8eef5` — primary text
- `#9aa8b8` — secondary text
- `#5b6a7c` — tertiary text / dividers
- `#2a3543` — disabled / inert chrome

### Typography

- **Tactical / numeric / coordinates**: `JetBrains Mono`, `ui-monospace`, `Menlo` — 11px for chips, 13px for HUD readouts, 16px for primary labels. Letter-spacing `0.02em`. Always uppercase for ALL CAPS LABELS like callsigns, MMSI, hex IDs.
- **Body / descriptive**: `Inter`, `system-ui` — 13px regular, 14px medium for panel headers. Sentence case.
- **Never**: serif faces, geometric sans like Futura, anything condensed, anything italic in 3D space (illegible at small WebGL sprite sizes).

### Motion vocabulary

- **Pulse (urgency)**: sine wave, 1.2s period for ALERT, 2.4s for WATCH, 4.0s for ambient INFO. Amplitude 0.6→1.0 on opacity.
- **Halo expansion (EPIRB-style)**: ease-out cubic, 1.8s per ring, 3 concurrent rings staggered 600ms.
- **Fade-in (new entity)**: linear, 400ms opacity ramp.
- **Fade-out (decay)**: ease-in quad, 800ms — slower out than in so dismissal feels deliberate.
- **Camera transitions**: existing directorManager cinematic curves — do not introduce competing easing.
- **Idle ambient sweep (radar/cone)**: linear rotation, 4s full revolution for surface radars, 8s for long-range.
- **Streamline flow**: dash-offset advance, 0.6 units/sec — slow enough to read direction without dizziness.

### Blending modes

- **Additive**: energy, light, emission — sun glow, RF noise particles, cone interiors, halo rings, satellite arc trails, lightning, SATCOM ribbons. *Anything that should brighten on overlap.*
- **Normal**: solid information — vessel hulls, port markers, labels, cable lines (when not pulsing), country borders.
- **Multiply** (rare): atmospheric darkening, night terminator soft edge, fog density tint. Never on UI elements.
- **Premultiplied alpha** sprites for all label backdrops to avoid edge fringing on the cyan glow.

### Render order conventions

Bottom → top:
1. **0–10**: terrain point cloud, continent mesh, ocean floor
2. **20–40**: water plane, country borders, cable lines
3. **50–70**: surface entities — vessels, ports, chokepoints, lightning
4. **80–100**: airborne — flights, radar cones, MUF dome
5. **110–130**: orbital — satellites, sat arcs, SATCOM ribbons
6. **140–160**: atmospherics — clouds, fog volumes, magnetic field lines
7. **180–200**: HUD overlays — alert zones, bearing lines, range rings
8. **220–240**: labels, sprites, glyphs
9. **250+**: critical alert overlays (EPIRB expansion, anomaly badges)

### Layout philosophy

- **Dark default.** Empty space is black ocean. Negative space is the dominant element.
- **Glow earns attention.** If three things glow, none of them are urgent. A single pulsing cyan ring on a dark globe is louder than ten flashing icons.
- **Information density at the cursor, not in the periphery.** Tooltip chips carry detail; the map carries pattern.
- **Operational, not consumer.** This is a watch-floor tool. It should feel like a piece of equipment, not a dashboard.

### What the aesthetic is NOT

- No glassmorphism, frosted blur panels, or iOS-style translucent cards.
- No rainbow / viridis / turbo gradients applied broadly — heat ramps stay within a constrained two-color span (cyan→amber, navy→red).
- No comic-sans, no display faces, no handwritten anything.
- No skeuomorphic textures — no brushed metal, no leather, no paper.
- No drop shadows on flat UI. Glow only, and only on active elements.
- No emoji as glyphs. Custom monochrome SVG only.
- No 3D bevels on UI chrome. Lines are 1px or 2px, flat.

---

## Section 2 — Visual Spec for the 8 RF Features

### 1. AIS Divergence

**Color**: Halo flip from `#3ac8d6` (nominal) → `#ff6a3d` (divergent). Warning glyph `#ffb547`. Past-flagged-position trail `#ff8c4a` at 35% opacity.

**Form**: Existing vessel halo (ring sprite) recolored. The `⚠` is a small SVG glyph rendered as a `THREE.Sprite` at scale 0.6, orbiting the vessel at radius 1.2 units, Y-offset +0.4. The trail is a `Line2` polyline of the last 8 flagged positions with thickness 1.5px and additive blending.

**Motion**: Halo pulses at 1.2s period when divergent. Glyph orbits at 4s/revolution counter-clockwise (against the typical clockwise of nominal indicators — subtle anomaly cue). Trail fades from head (full opacity) to tail (zero) over its length, never animates.

**Hierarchy**: Halo renderOrder 70, glyph 230, trail 55. Halo blending additive, glyph normal, trail additive.

**Label**: Only on hover or selection. JetBrains Mono 11px white-on-`#0c2a30` rounded-rect backdrop (radius 3px, padding 4px 6px), 1px `#3ac8d6` border. Shows MMSI, last-known speed delta, divergence score.

**Severity**: INFO = halo stays cyan, glyph hidden, trail at 20% opacity. WATCH = halo amber pulse 2.4s, glyph visible, trail 35%. ALERT = halo orange-red pulse 1.2s, glyph orbiting + pulsing, trail 50% with brighter head.

**Reference**: The "spoofed contact" indicators in AEGIS combat system displays — a friendly track suddenly outlined in amber. Also the "ghost track" overlays in The Expanse's CIC where a missile's predicted path is rendered as a thinning dotted curve.

### 2. GPS Jamming Attribution

**Color**: Zone fill `#ff6a3d` at 8% opacity. Cell heatmap from `#ffb547` (low) → `#ff2a4d` (high) — strictly within the warning-to-critical span. Crosshair centroid `#5cf0ff`.

**Form**: Existing alert zone polygon retained. Cells are an `InstancedMesh` of flat quads, 5×5° each, on a sphere shell at Y=0.5 above water. Crosshair is two crossed `Line2` segments 6 units long with a 0.8 unit gap in the center (a real reticle, not an X), plus a 0.3-unit inner circle.

**Motion**: Cells animate via shader — `uTime` drives a noise displacement of the heat value with amplitude `0.15 * intensity`, period 3s. Crosshair gently rotates 0.2 rad/sec and pulses scale 0.95→1.05 at 2s period.

**Hierarchy**: Zone polygon renderOrder 180, cells 60, crosshair 235. All additive except the zone fill (normal, low alpha).

**Label**: Crosshair carries a single chip 1.5 units to its upper-right: `[JAM]` tag, estimated radius in km, confidence percentage. Mono 11px, cyan border.

**Severity**: INFO = cells visible only on layer toggle, no centroid. WATCH = centroid present but no pulse, cells static. ALERT = full crosshair + cell shader animation + pulse.

**Reference**: NOAA's radar reflectivity heat cells (constrained palette, blocky, additive). The targeting reticle from Foundation S2's Invictus bridge displays — minimal, geometric, no chrome.

### 3. HF MUF Propagation Overlay

**Color**: Translucent heatmap from `#1d2c44` (low MUF, ~3 MHz) → `#3ac8d6` (mid, ~14 MHz) → `#ff6cf0` (high, ~30 MHz). Always ≤25% opacity. Dome version uses same ramp.

**Form**: 2D version is a `THREE.Mesh` of a UV-sphere shell at Y=0.2 with a fragment shader sampling a procedural MUF field. 3D dome version is a hemisphere at radius scaled from camera-target, with the same shader plus a vertical altitude gradient (faded at the equator, brighter at the apex).

**Motion**: The MUF field advects at 0.05 units/sec to suggest the moving terminator. No pulsing. Dome version slowly rotates `0.01 rad/sec` to imply solar driving.

**Hierarchy**: 2D heatmap renderOrder 35 (above water, below entities). Dome renderOrder 145 (above clouds). Both additive blending, depth-write off.

**Label**: No per-pixel labels. A legend chip in the UI panel only.

**Severity**: This layer is observational, not alert-driven. Opacity scales with user-controlled "MUF emphasis" slider, default 15%.

**Reference**: The VOACAP propagation maps from amateur radio software, but desaturated. The atmospheric overlay in the Blade Runner 2049 LAPD spinner HUD when scanning altitudes.

### 4. Military Radar Emission Cones

**Color**: Country-coded. USA `#5cf0ff`, RUS `#ff2a4d`, CHN `#ff6a3d`, PRK `#ffb547`, NATO `#3ac8d6`, unknown `#9fb4c7`. All at 12% fill opacity.

**Form**: A `THREE.Mesh` cone — base radius = max range, height = max range, with the apex at the emitter. Custom shader gives a falloff: opacity = `pow(1.0 - normalizedDistance, 1.5)` so the cone fades toward its edge instead of cutting hard. Wireframe edge in the country color at 40% opacity.

**Motion**: A swept "scan line" — a thin radial band, 5° wide, sweeps the cone at 4s/revolution (surface) or 8s/revolution (long-range OTH). The band is brighter (`+30%` emission) than the cone fill.

**Hierarchy**: renderOrder 85. Additive blending for cone fill, normal for the wireframe edge. Depth-write off so cones don't occlude vessels inside them.

**Label**: A small chip at the apex: emitter ID, band (S/X/L/UHF), country code. Mono 11px. On hover, expanded chip with PRF, estimated power.

**Severity**: INFO = no scan line, cone at 8% opacity. WATCH = scan line at 4s. ALERT = scan line at 2s + cone fill rises to 18% + apex pulses.

**Reference**: The radar coverage cones in NORAD planning displays. The Imperial sensor sweep cones in Andor (gray-blue, translucent, with a visible sweep). The Expanse Roci's threat-cone overlay during the Donnager fight.

### 5. SATCOM Line-of-Sight Ribbons

**Color**: `#5cf0ff` primary. Idle/inactive `#3ac8d6` at 30% opacity. Degraded link `#ffb547`.

**Form**: A `Line2` ribbon (thick line) from vessel position to satellite position at Y=51 (existing LEO altitude). The line follows a slight catenary arc — not straight — by sampling 16 points along a quadratic Bezier with a control point pulled toward the camera, giving 3D depth read. Width 2px.

**Motion**: A `dashOffset` advance at 0.8 units/sec creates a "data flowing" effect — 12 unit dashes, 8 unit gaps. The flow direction encodes uplink (vessel→sat) vs downlink (sat→vessel). On link establishment: 600ms ease-in fade.

**Hierarchy**: renderOrder 120, additive blending. Depth-write off so multiple ribbons stack without z-fighting.

**Label**: None on the ribbon itself. The associated vessel and satellite carry their own labels.

**Severity**: INFO = single static line, no dash. WATCH = degraded amber, slower dash. ALERT = link loss, ribbon flashes red-orange and fades over 1.5s.

**Reference**: The starlink coverage visualizations from Celestrak. The data-link overlays in The Expanse where the Razorback transmits to MCRN command — a thin, dashed, blue-white arc with directionality.

### 6. Submarine Cable Correlation

**Color**: Cables ambient `#3ac8d6` at 25% opacity underwater. Correlated/at-risk pulse `#ff2a4d`. Vessel-link line `#ffb547`.

**Form**: Existing cable geometry retained but its material is upgraded to use a custom shader that adds a soft glow at Y<0 (underwater segments) via an emissive fresnel. The pulse is an animated brightness multiplier on the segment of cable nearest the correlated vessel. The vessel-link is a `Line2` with a 1.5px dashed pattern connecting the vessel to the nearest cable point.

**Motion**: Ambient glow is static. The pulse travels along the affected cable segment at 6 units/sec — a 4-unit "bright wavefront" of `+60%` brightness. Vessel-link line fades in over 400ms when correlation triggers, fades out over 1.2s when cleared.

**Hierarchy**: Cable lines renderOrder 30 (below surface entities but above water). Pulse uses additive. Vessel-link renderOrder 75.

**Label**: A small chip at the midpoint of the vessel-link: `[CBL-CORR]`, distance in meters, correlation confidence. Mono 11px, amber border.

**Severity**: INFO = ambient glow only. WATCH = vessel-link line appears (amber). ALERT = red pulse on cable + thicker vessel-link line + persistent until acknowledged.

**Reference**: The undersea cable maps from TeleGeography, but with the cyan-glow restraint. The "infrastructure stress" indicators in the Foundation S2 Trantor shield displays — calm baseline, single bright pulse on a stressed segment.

### 7. Lightning RF Noise

**Color**: `#ff6cf0` magenta particles, `#ffb547` for sustained storm cores. Background "noisy region" stipple `#ff6cf0` at 6% opacity.

**Form**: A `THREE.Points` cloud at Y=10, point size 2–4px, additive. Each lightning event is a 3-particle burst with a 1-particle persistent "echo" that decays over 8 seconds. For sustained storms, the underlying noisy region is a 5×5° quad with an animated stipple shader (Worley noise threshold at varying time offsets).

**Motion**: Burst particles fade from 100% to 0% opacity over 2s on an ease-in curve. The echo particle decays linearly over 8s. Stipple shader animates noise at 0.3 units/sec — slow enough to read as ambient, fast enough to feel "alive."

**Hierarchy**: renderOrder 65 for bursts, 32 for stipple. Both additive.

**Label**: No labels on individual strikes. A regional chip appears when a storm cluster exceeds threshold: `[LIGHTNING]`, strikes/min, centroid lat/lon.

**Severity**: INFO = particle bursts only. WATCH = stipple region appears under sustained activity. ALERT = stipple intensifies (8%→18%) + chip displayed.

**Reference**: The Vaisala GLD360 visualizations — magenta points on a dark globe, sparse, technical. The "atmospheric interference" indicator in Dune Part 2's worm-sensor displays.

### 8. EPIRB Distress

**Color**: `#ff2a4d` critical red. Halo core `#ff6a3d`. Expansion ring `#ff2a4d` fading to `#ff6cf0` at the wave edge.

**Form**: Central marker is a `THREE.Sprite` of a circle + radial spokes glyph at scale 1.5, color `#ff2a4d`. Surrounding it: a stacked set of three expanding `RingGeometry` discs facing the camera (billboarded), each starting at radius 0 and expanding to radius 8. A persistent core halo (radius 2.5, `#ff6a3d` additive at 40%) pulses underneath.

**Motion**: Each expansion ring takes 1.8s ease-out-cubic to go from 0 to full radius, fading from 80% to 0% opacity simultaneously. Three rings staggered by 600ms — so there is always one ring mid-expansion. Core halo pulses sine 1.2s period, amplitude 0.7→1.0.

**Hierarchy**: renderOrder 255 (top of everything). Additive blending. Depth-test off — must be visible even when the camera is below the horizon line.

**Label**: Always visible, no hover required. Mono 13px white on `#2a0a14` rounded-rect with 1.5px `#ff2a4d` border. Shows beacon ID, registered vessel name, position, and "ACKNOWLEDGE" action button.

**Severity**: EPIRB is by definition CRITICAL. The visual does not de-escalate; the only state change is "acknowledged" — which dims the halo to 50% opacity and slows the pulse to 4s, but does not remove it until cleared.

**Reference**: The Mayday overlays in real Coast Guard SAR displays — large, persistent, red, impossible to miss. The "distress beacon" indicator from Andor's Imperial scanner — a slow expanding red radial wave that doesn't speed up but doesn't stop.

---

## Section 3 — Missing Visual Primitives

The RF domain demands several reusable primitives that don't yet exist in VANGUARD1. Each should ship as a small module under `vizPrimitives/` so future domains (cyber, OSINT, weather extensions) can compose from the same library.

### Primitives catalogue

**a) Spectrum waterfall sprite** — Frequency-vs-time texture. A 2D canvas, drawn off-screen, rolling line-by-line (oldest row dropped, newest row written), texture-uploaded each frame. Used in tooltip chips for jamming and HF emitters. **Look**: 80×40px, magma-but-restrained palette (`#0a1224` → `#3ac8d6` → `#ff2a4d`). **Three.js**: a `CanvasTexture` updated via `texture.needsUpdate = true` at 5Hz. **Reusable**: weather radar reflectivity history, vessel speed history, satellite signal strength history. **Difficulty**: Low.

**b) Bearing line** — A radial line from a sensor to a candidate emitter. **Look**: thin (1.5px) `Line2` with a 60% opacity, dashed pattern, terminating in a small open circle at the far end. Color matches the emitter classification. **Three.js**: `Line2` with `dashed: true`, dynamic geometry. **Reusable**: direction-finding for RF, search-and-rescue last-known-bearing, sonar contacts. **Difficulty**: Low.

**c) Time-series sparkline sprite** — 12-second history line for tooltip chips. **Look**: 60×18px sparkline, 1px line, cyan, no axes, no labels, just a shape. **Three.js**: `CanvasTexture`, redrawn at 2Hz. **Reusable**: vessel speed, altitude trends, signal strength. **Difficulty**: Low.

**d) Directional cone with falloff** — Used for radar emissions but also for spotlights, search lights, optical sensors. **Look**: cone mesh with a shader giving `pow(1 - r, 1.5)` radial falloff and a sweep band. **Three.js**: `ConeGeometry` + custom `ShaderMaterial` with `uTime` and `uSweepAngle` uniforms. **Reusable**: any directional sensor, drone optical FOV, missile seeker cones. **Difficulty**: Medium.

**e) Radial expansion wave** — The EPIRB-style stacked-ring effect. **Look**: 3 billboarded rings, ease-out expansion, staggered phase. **Three.js**: an `InstancedMesh` of 3 ring quads with a vertex shader animating per-instance phase offset. **Reusable**: missile launch detection, explosion events, breaking-news pulses, sonar pings. **Difficulty**: Medium.

**f) Heat-gradient cell map** — Grid of intensity cells on the sphere. **Look**: instanced flat quads, constrained palette ramp, optional shader noise. **Three.js**: `InstancedMesh` with per-instance color attribute, fragment shader for noise. **Reusable**: weather, pollution, cyber intrusion density, signal strength fields. **Difficulty**: Medium.

**g) Translucent dome overlay** — Hemisphere of context — propagation, range, AO. **Look**: a hemisphere mesh with fresnel edge brightening, vertical gradient, additive. **Three.js**: `SphereGeometry` half, custom shader. **Reusable**: HF propagation, missile range envelopes, communications coverage, weather radar reach. **Difficulty**: Medium.

**h) Animated stipple region** — A "this area is noisy" indicator. **Look**: Worley-noise threshold shader producing flickering dots over a 5×5° patch. **Three.js**: `PlaneGeometry` patch on the sphere + `ShaderMaterial`. **Reusable**: storm activity, electronic warfare zones, jammed regions, congested airspace. **Difficulty**: Medium.

**i) Severity tier badge glyph** — A consistent 3-state dot pattern. **Look**: 1 dot (INFO, gray-blue), 2 stacked dots (WATCH, amber), 3 dots in a triangle (ALERT, red). 12×12px SVG. **Three.js**: `Sprite` with `CanvasTexture`. **Reusable**: every alert in the system. **Difficulty**: Low.

**j) Glowing connection ribbon** — Thick line between two points with flow direction. **Look**: `Line2` with dash-flow shader, additive, optional catenary arc. **Three.js**: `Line2` + `LineMaterial` with custom dash logic. **Reusable**: SATCOM, vessel-cable correlation, command-and-control links, supply chains. **Difficulty**: Medium.

### Proposed `vizPrimitives/` library to build first

These six justify the build because they will each be used by ≥3 features across RF and future domains:

1. **`vizPrimitives/expansionWave.js`** — EPIRB, missile launches, breaking news pulses. *(Medium)*
2. **`vizPrimitives/bearingLine.js`** — DF, SAR, sonar. *(Low)*
3. **`vizPrimitives/heatCellGrid.js`** — Jamming, weather, cyber, signal strength. *(Medium)*
4. **`vizPrimitives/directionalCone.js`** — Radars, drones, sensors. *(Medium)*
5. **`vizPrimitives/sparklineSprite.js`** — Every tooltip in the system. *(Low)*
6. **`vizPrimitives/severityBadge.js`** — Every alert. *(Low)*

Defer waterfall (specialized) and animated stipple (only 2 confirmed use cases) until a third domain demands them.

---

## Section 4 — Reference Inspiration & Quality Benchmarks

### Real operational displays

- **NORAD Cheyenne Mountain track displays** — *steal*: the cool blue-on-black palette, the discipline of showing only active tracks, the tabular numeric chips beside each contact. No clutter, no decoration.
- **NASA Mission Control (current Houston FCR)** — *steal*: the green/amber/red discipline (a single color = a single meaning), the persistent telemetry strips, the monospace numeric culture.
- **AEGIS combat system displays (publicly photographed)** — *steal*: the use of geometric symbology (NATO MIL-STD-2525 derivative), the deliberate sparseness, the way threat classes are encoded in shape, not just color.

### Maritime / OSINT

- **Janes IHS Maritime intelligence dashboards** — *steal*: the information density at the cursor (rich tooltips), the muted base map, the way vessel categories are differentiated by silhouette not by hue.
- **MarineTraffic dark mode** — *steal*: the dark navy ocean (matches our `#0a1224` almost exactly), the cyan vessel triangles. Avoid their heat-map overlays — too saturated.
- **EOSDIS Worldview** — *steal*: the constrained scientific palette ramps, the layer-toggle restraint, the way overlays cross-fade rather than slam-cut.

### Sci-fi UIs

- **The Expanse — Rocinante CIC and MCRN command** — *steal*: the operational restraint, the way critical alerts get a single bright halo without flashing chrome, the use of small monospace numeric chips beside every contact. This is VANGUARD1's spiritual reference.
- **Foundation S1-2 ship displays** — *steal*: the geometric purity, the cyan-and-gold restraint, the way data layers feel etched onto the display rather than overlaid.
- **Blade Runner 2049 spinner HUD / LAPD scanner** — *steal*: the spatial-volumetric overlays (our HF dome should feel like this), the way scanning effects sweep with intent.
- **Andor — Imperial command displays** — *steal*: the gray-blue institutional palette, the precision of the line work, the absence of friendliness. RF intel is adversarial — it should feel that way.
- **Dune Part 2 — Atreides scanner and worm-sensor displays** — *steal*: the way ambient atmospheric phenomena are rendered as slow, breathing fields rather than discrete icons. Useful for MUF propagation.

### Tactical chart traditions

- **NHC hurricane track charts** — *steal*: the cone-of-uncertainty as a primary visual idiom (translucent expanding fan), the way historical track + forecast are visually distinct.
- **NOAA marine charts** — *steal*: the symbol economy — every glyph has a fixed meaning, never repurposed. VANGUARD1 should commit to its glyph vocabulary the same way.
- **METAR/TAF displays** — *steal*: the monospace-text-as-primary-data culture. A line of text IS the visualization.

### Quality benchmark statement

VANGUARD1's RF intelligence domain must feel like **the bridge of the Rocinante during a long quiet watch** and **the floor of NORAD at 0300 — calm, dark, attentive, with single bright signals earning their glow** — and never like **a consumer weather app, a gamer streaming overlay, or a SaaS analytics dashboard.** The aesthetic is not decorative; it is the user interface of a serious instrument. Every glow must be load-bearing. Every label must be earned. The dark is not a theme — it is the medium in which signal becomes visible.
