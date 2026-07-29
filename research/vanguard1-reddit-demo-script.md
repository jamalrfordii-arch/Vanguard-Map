# VANGUARD1 — Reddit demo shot list
**Target: 60-90s · live AIS feed · pure cinematic, no captions/voiceover**

Everything below uses controls that actually exist and work today — verified against the live code, not assumed. One thing worth knowing up front: the codebase has a `CinematicDirector` auto-camera class (`directorManager.js`) but it's dead code, never wired into `main.js` — so this is a fully manual, live-operated shoot. No autopilot. Practice each move once before hitting record.

## Controls cheat sheet

| Action | Input |
|---|---|
| Rotate | Right-click drag |
| Pan | Left-click drag |
| Zoom / dolly | Scroll wheel, or middle-click drag |
| Jump to a location | Press `/` to open search → type a place name or `"lat, lon"` → arrow keys + Enter. This **flies** the camera there smoothly (a few seconds), it doesn't snap. |
| Lock a vessel | Click its hull — opens the detail card + a focus vignette. Click again to unlock. |
| Close search / cancel | `Escape` |

Camera altitude range is 2.3 (lowest) to 550 (highest) scene units. Below 200 the tile-streaming terrain starts loading in; below 25 the point-cloud/continent-mesh crossfade happens; below 90 ships stop clustering into count-bubbles and render individually. That crossfade *is* the visual spectacle beat below — no extra effect needed, just fly there.

## Recommended location: Strait of Hormuz

Search `"26, 56"` (or "Strait of Hormuz" if it resolves). It's the narrowest real chokepoint in the data and has the densest guaranteed AIS traffic of any of the six chokepoints wired into the map — best odds of a visually busy shot regardless of what's actually transiting when you hit record. Do one un-recorded dry run first to confirm current live traffic density looks good; AIS is real-time, so it does fluctuate.

## Shot list

| Time | Shot | Camera move | What it shows |
|---|---|---|---|
| 0:00–0:12 | Cold open — full globe | Load in at max zoom-out (default start is already near this). Right-drag slowly, one continuous rotate, no stops. | Establishes it's a real interactive 3D globe, not a static render. |
| 0:12–0:28 | Descent | Press `/`, type `26, 56`, Enter. Let the fly-to animation run uninterrupted. | The LOD crossfade — point cloud → tile-streamed terrain resolving in — happens automatically as altitude drops. This is the single best "wait, this is real-time" beat in the whole video; don't rush it. |
| 0:28–0:36 | Close the gap | Scroll/dolly down further until individual ship hulls are visible (below ~y=80). | Cluster bubbles dissolve into real per-vessel models — cargo, tanker, etc. each a different color/shape. |
| 0:36–0:52 | Vessel detail | Right-drag a slow orbit around the strait. Click one ship to lock it. Hold ~4-5s on the opened detail card + vignette. Click it again to unlock. | Hull variety, wakes, trails, and — if you're filming during local dusk/night at that longitude — running lights (port/stbd/masthead/stern). Sim clock defaults to live wall-clock time, so lighting condition is whatever time it actually is there; `window.simClock` in DevTools can scrub to a different time if you want to force a night shot instead of leaving it to chance. |
| 0:52–1:12 | AI Discovery | Pan/zoom toward the DISCOVERY panel. See below for how this card gets on screen. Hover the ranked options to show the reasoning text, then click CONFIRM and hold on the "✓ CONFIRMED — ACTIONS EXECUTED" state for a beat. | The actual differentiator: an AI-ranked, human-confirmed course of action, not an auto-pilot black box. |
| 1:12–1:25 | Pull back | Scroll/dolly straight back out (or middle-drag), fast and continuous, ending near the same wide framing as the open. | Bookends the video — same shot you opened on, now clearly "zoomed into" a real place. |

## The Discovery card — a real decision to make first

Cross-domain anomalies (the trigger type that produces the richest card, with both vessel and aircraft evidence) are event-driven — they may or may not fire organically inside a 60-90s window even with live data flowing. Two honest options:

- **Let it happen organically.** Do a longer practice run first with the DISCOVERY panel open and watch for a real trigger, then time your shoot to when one's likely. Fully authentic, but you don't control the timing.
- **Trigger it on purpose.** Run `window.vg1Discovery.testOptionsMode('CROSS_DOMAIN')` in the browser console right before this shot. This is not a fake visual — it builds a synthetic snapshot and sends it through the actual `/ai-discover` backend, so the card, the reasoning, and the CONFIRM flow are all real. It just guarantees the timing. Requires the local AI backend (`flight-proxy.js`, port 8787) to be running, or the fetch fails and nothing appears.

Either is defensible for a demo; just be clear with yourself (and viewers, if asked in comments) about which one you used. If you go with the manual trigger, run it and close DevTools *before* you start the recorded portion of this shot — don't let the console show on screen.

## Recording setup notes

- Capture the browser in fullscreen/kiosk mode (F11) so address bar and tabs don't show — cleaner frame.
- 1920×1080 @ 30fps is a safe default for Reddit; the render pipeline already runs Bloom → Fog → Clouds → two Tilt-Shift passes → Bokeh every frame, and screen-capture software adds its own overhead on top, so do a short recorded test clip first and check for dropped frames before the real take. Close other heavy apps if it's choppy.
- No on-screen captions per your call on narration — if you want a title for the Reddit post itself, that's just post text, not baked into the video.
