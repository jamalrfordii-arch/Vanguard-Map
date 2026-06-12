# VANGUARD1 — Multi-Domain Tactical Intelligence Map

A real-time 3D map of the world's moving things: live ship traffic (AIS), aircraft,
satellites, submarine cables, ports, chokepoints, and space weather — rendered as a
1.5M-point terrain cloud with day/night, ocean simulation, and cinematic camera work.
Built with Three.js and plain ES modules. No build step, no framework.

**▶ [Live demo](https://jamalrfordii-arch.github.io/Vanguard-Map/)** — no signup needed:
click **VIEW DEMO** on the opening screen for synthetic traffic, or paste a free
[aisstream.io](https://aisstream.io) key for live global ship data.

![demo](docs/demo.gif)

## Try it

```bash
git clone https://github.com/jamalrfordii-arch/Vanguard-Map.git
cd Vanguard-Map
npx serve .        # or: python -m http.server 3000
```

Open `http://localhost:3000` in a Chromium browser with hardware acceleration.

**Live ship data (free):** the app prompts for an [aisstream.io](https://aisstream.io)
API key on first load — free signup, the key stays in your browser's localStorage.

**High-res terrain tiles (optional):** get a free token at
[cesium.com/ion](https://cesium.com/ion) → Access Tokens, then in DevTools:
`localStorage.setItem('vg1_cesium_token', 'YOUR_TOKEN')`. Without it the map uses
the point-cloud terrain at all zoom levels.

**Flights & AI copilot (optional):** require the local proxy —
`node flight-proxy.js` in a second terminal. Without it those layers stay quiet;
everything else works.

## Time control & scenarios

The map runs on a simulated clock and pluggable data sources — DevTools console:

```js
simClock.setTime('2026-05-10T12:00:00Z')   // scrub the world to any moment
simClock.setRate(60)                        // 1 real second = 1 sim minute
vg1Scenario.load('./scenarios/hormuz-demo.json')  // inject scripted synthetic vessels
vg1Scenario.record(); vg1Scenario.save()    // capture live AIS to NDJSON
vg1Scenario.replay('./captures/x.ndjson')   // replay a capture
vg1Invariants.stats()                       // physics-violation ledger (spoof/teleport detection)
```

Synthetic vessels use reserved `999…` MMSIs and are scripted in `scenarios/*.json`.

## Tests

```bash
node tests/invariants.test.mjs
```

## Architecture

One manager per domain (`aisManager`, `flightManager`, `satelliteManager`, …),
communicating only via `vg1:*` DOM events — no cross-imports. All position reports
pass a physics invariant gate (`invariants.js`) before they can move an entity.
See `CLAUDE.md` for the full module map and contribution rules.

## Feedback

Open a [GitHub Issue](https://github.com/jamalrfordii-arch/Vanguard-Map/issues) —
bug reports, feature ideas, and "this ran at N fps on my machine" reports are all useful.
