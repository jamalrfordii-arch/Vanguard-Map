# Vanguard1 — AI Agents

Nine agents: six for QA and tooling, three for continuous research, vision, and strategic planning — working together as an ecosystem that constantly thinks about how to evolve the map toward its holographic endpoint.

## Setup (run once)

```bash
cd agents
npm install
```

Set your Anthropic API key (required by agents 2, 4, 5, 6):
```bash
# Windows
set ANTHROPIC_API_KEY=sk-ant-...

# Or add to your system environment variables permanently
```

---

## Agent 1 — Visual Regression Guard
**No API key needed. No browser restart needed.**

Catches bloom explosions, terrain colour shifts, water changes automatically.

```bash
# First run — save golden baselines
node visual-regression-guard.js --update

# After any code change — compare vs baselines
node visual-regression-guard.js

# Test a single camera position
node visual-regression-guard.js --pos mediterranean
```

Camera positions: `global_overview`, `north_atlantic`, `mediterranean`, `strait_of_hormuz`, `close_zoom_port`

Diff images saved to `reports/` when a regression is detected.

---

## Agent 2 — Antarctica Bug Hunter
**Requires ANTHROPIC_API_KEY.**

Binary-searches the scene graph to find the grey shape near Antarctica.

```bash
node antarctica-bug-hunter.js

# Save a screenshot at every binary search step
node antarctica-bug-hunter.js --save-screenshots
```

Outputs the exact object name, type, UUID, and vertex count of the culprit.
Saves `reports/hunt_baseline.png` and `reports/hunt_culprit_hidden.png`.

---

## Agent 3 — Architecture Compliance
**No API key needed. No browser needed.**

Scans all .js files for 10 architecture rule violations.

```bash
node architecture-compliance.js

# Output JSON report
node architecture-compliance.js --json
```

Rules checked:
1. Manager cross-imports (should use vg1: events)
2. bloomPass.radius/threshold written outside sceneSetup.js
3. waterUniforms written outside skyManager.js
4. Hardcoded light intensities
5. `new THREE.Vector3()` inside loops (GC pressure)
6. DOM queries inside update()/tick()
7. fetch() without await
8. Flat constants in config.js (should use namespace groups)
9. splatCloud uniforms written outside terrainBuilder.js

Exits with code 1 if any ERRORs are found (safe to use as a pre-commit hook).

---

## Agent 4 — Layer Scaffolder
**Requires ANTHROPIC_API_KEY.**

Generates a complete, wired-up new manager file for any new layer.

```bash
# Generate a lightning layer
node layer-scaffolder.js --name lightning --category atmosphere

# Generate telluric currents
node layer-scaffolder.js --name telluric --category geomagnetic

# Generate ACLED conflict data layer
node layer-scaffolder.js --name acled --category human
```

Categories: `surface` | `atmosphere` | `geomagnetic` | `space` | `human`

Outputs:
- `../[name]Manager.js` — complete scaffold, ready to fill in `_fetchData()`
- Patches `../config.js` with a new `[NAME]` constant group

---

## Agent 5 — Shader Auto-Tuner
**Requires ANTHROPIC_API_KEY.**

Iterates terrain shader uniforms and finds the optimal visual values.

```bash
# Full sweep (~81 combos, ~10 minutes)
node shader-auto-tuner.js

# Quick sweep (~16 combos, ~2 minutes)
node shader-auto-tuner.js --quick

# Focus on the polar brightness issue
node shader-auto-tuner.js --quick --target polar

# Focus on close-zoom shadow darkness
node shader-auto-tuner.js --quick --target close
```

Outputs:
- `reports/shader-tune-results.json` — all scored combinations
- `reports/shader-tune-best.png` — screenshot of best result
- Prints a ready-to-paste `config.js` block

---

## Agent 6 — LOD Transition Validator
**Requires ANTHROPIC_API_KEY.**

Validates all 7 documented LOD thresholds using Claude vision.

```bash
# Validate all thresholds
node lod-validator.js

# Validate a single threshold
node lod-validator.js --threshold 25

# JSON report
node lod-validator.js --json
```

Checks: `y=200`, `y=120`, `y=50`, `y=25`, `y=22`, `y=15`, `y=12`

Saves before/after screenshots to `reports/lod_[name]_above.png` and `reports/lod_[name]_below.png`.

---

---

## Agent 7 — Map Vision Agent
**Requires ANTHROPIC_API_KEY. Requires the map to be running.**

Screenshots the live map from multiple camera angles, analyses each view with Claude vision, and proposes the most impactful visual improvements. Rotates through eight analysis dimensions so every run explores fresh territory — always oriented toward the holographic ecosystem goal.

```bash
# Full analysis (all 5 views, auto-selects dimension)
node map-vision-agent.js

# Single camera view
node map-vision-agent.js --view north_atlantic

# Focus a specific dimension
node map-vision-agent.js --focus water_and_ocean
# Dimensions: atmosphere_and_lighting | water_and_ocean | terrain_and_landmass |
#             vessel_and_asset_detail | data_density_and_readability |
#             immersion_and_cinematic_quality | tactical_clarity | holographic_future_potential

# Custom map URL (default: http://localhost:8080)
node map-vision-agent.js --url http://localhost:5173
```

Views: `global_overview`, `north_atlantic`, `strait_of_hormuz`, `polar_region`, `dawn_angle`

Output:
- `proposed/vision/VISION_REPORT_YYYY-MM-DD.md` — prioritised proposals with analysis
- `proposed/vision/screenshots/` — annotated PNGs for each view

---

## Agent 8 — Iteration Planner Agent
**Requires ANTHROPIC_API_KEY. No browser needed.**

Reads every file in `proposed/` (all research notes, proposals, vision reports), cross-references the current codebase, and builds a prioritised ROADMAP — always asking: *what single change delivers the most toward the holographic ecosystem vision?*

Also generates `NEXT_BUILD.md`: a step-by-step implementation plan for the #1 priority item, ready to hand to a developer or follow yourself.

```bash
# Full planning pass (reads all proposed/ files deeply)
node iteration-planner-agent.js

# Quick mode (shallower reads, faster)
node iteration-planner-agent.js --quick
```

Output (both files are always overwritten with the freshest plan):
- `proposed/ROADMAP.md` — top 10 priorities with effort/risk/impact ratings
- `proposed/NEXT_BUILD.md` — detailed step-by-step plan for #1 priority

---

## Agent 9 — Graphics Enhancer Agent
**Requires ANTHROPIC_API_KEY. No browser needed.**

Researches cutting-edge visual rendering techniques across four tracks and generates concrete GLSL patches and manager scaffolds.

```bash
node graphics-enhancer.js                    # all 4 tracks
node graphics-enhancer.js --track vessels    # vessels & aircraft only
node graphics-enhancer.js --track realism    # lighting/atmosphere/water
node graphics-enhancer.js --track point-cloud
node graphics-enhancer.js --track techniques
node graphics-enhancer.js --fresh            # ignore cached research
```

Output: `proposed/graphics/GRAPHICS_REPORT_YYYY-MM-DD.md` + per-track proposals

---

## Recommended ecosystem workflow

```
                    ┌─────────────────────────────────┐
                    │  RESEARCH ECOSYSTEM (on demand)  │
                    │                                  │
                    │  research-innovator.js           │
                    │    → proposed/[feature]/         │
                    │                                  │
                    │  graphics-enhancer.js            │
                    │    → proposed/graphics/[track]/  │
                    │                                  │
                    │  map-vision-agent.js             │
                    │    → proposed/vision/            │
                    └────────────────┬────────────────┘
                                     │  all proposals feed in
                                     ▼
                    ┌─────────────────────────────────┐
                    │  ITERATION PLANNER (on demand)   │
                    │                                  │
                    │  iteration-planner-agent.js      │
                    │    → proposed/ROADMAP.md         │
                    │    → proposed/NEXT_BUILD.md      │
                    └────────────────┬────────────────┘
                                     │  developer reads NEXT_BUILD.md
                                     ▼
                    ┌─────────────────────────────────┐
                    │  QUALITY GATE (before/after)     │
                    │                                  │
                    │  architecture-compliance.js      │
                    │  visual-regression-guard.js      │
                    │  lod-validator.js                │
                    └─────────────────────────────────┘
```

**Suggested cadence:**
```bash
# Explore the next visual dimension
node map-vision-agent.js

# Research a specific domain
node research-innovator.js --topic [domain]
node graphics-enhancer.js --track [track] --fresh

# Get the prioritised build plan
node iteration-planner-agent.js

# Read the plan and build it
cat proposed/NEXT_BUILD.md

# Verify nothing broke
node architecture-compliance.js
node visual-regression-guard.js

# Repeat
node iteration-planner-agent.js
```

---

## Suggested workflow

```bash
# Before committing a change:
node architecture-compliance.js       # fast, no API key
node visual-regression-guard.js       # fast, no API key

# After a visual change:
node lod-validator.js                 # validate LOD seams
node shader-auto-tuner.js --quick     # check if new values look better

# To fix the Antarctica bug:
node antarctica-bug-hunter.js

# To add a new layer:
node layer-scaffolder.js --name [layer] --category [cat]
```
