# Working with Jamal

- **Style:** concise and direct. Cut words that don't change the meaning. No filler preamble,
  no over-explaining what the document already says.
- **Build cadence:** ships features fast, iteratively; verifies visually (screenshots) and expects
  me to verify too (final verification step, real checks not assumptions).
- **Trust but verify:** wants honest pushback and real diagnosis, not reflexive agreement. Surface
  failure details (the diagnostics-in-card pattern) so he can screenshot and we debug together.
- **Friction is the enemy:** strong preference for things that "just work" without manual steps —
  e.g. resolve IMO from vessel name so he never types a number. Apply this instinct broadly.
- **Holds pushes until confirmed:** don't push to GitHub until the feature is verified working on
  his end.
- **The "brain":** Jamal wants me to have persistent memory + genuine analysis, not just recall.
  Treat this `memory/` folder as that brain: read at session start, update at session end.

_Last updated: 2026-06-14._

## Visual acceptance standard (stated 2026-07-25)

Jamal's explicit requirement: **every change must meet a criterion of high
definition in 3D.** Performance and loading work is not allowed to buy speed
with settled visual quality.

Operationally, any change that touches loading, LOD, budgets, or rendering must
pass this acceptance check before being called done:

- **Settled view identical** to the pre-change baseline at the same camera:
  same levels at full opacity, same visible tile counts, same imagery coverage.
- **Sampling density held**: ≥ ~1 point per screen pixel at the deepest lit
  level (the 2026-07-25 audit standard), point overlap within the 6x clamp.
- **Pixel ratio not silently degraded** — check vg1Quality.info().livePixelRatio
  against the cap.
- Savings are only allowed to come from ground that is NOT on screen (transit
  bands, fringe, off-frustum) — never from what the user is looking at.

The dwell gate (2026-07-25) is the template: it skips fly-through bands entirely
but anywhere the camera dwells loads exactly what it always loaded.
