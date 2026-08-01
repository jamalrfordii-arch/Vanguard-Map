// tools/profile-ais.js — per-manager frame cost, without the profiling header.
//
// Load from the DevTools console on http://localhost:3000:
//     await import('/tools/profile-ais.js'); vg1ProfileAIS()
//
// WHY THIS EXISTS. Chrome's JS Self-Profiling API (`new Profiler()`) gives real
// per-FUNCTION sampling, but refuses unless the server sends
// `Document-Policy: js-profiling` — which is what tools/profile-server.mjs is
// for. This works on the ordinary dev server instead, at the price of
// granularity: it measures per MANAGER, not per function.
//
// What is already established when you run this:
//   · frame ≈ 32 ms — ≈ 23 ms main-thread JS, ≈ 8 ms GPU
//   · the 20.4M-splat terrain costs 0.6 ms. It is not the problem.
//   · turning OFF the "AIS Vessels" layer drops in-frame JS 22.5 → 7.0 ms
//   · every other layer moves it by less than the noise
//
// So ~15.5 ms lives in the AIS path. This narrows it to which manager.
//
// ── TWO LIMITS, BUILT INTO THE OUTPUT RATHER THAN HIDDEN ────────────────────
//
//   1. SELF TIME IS NOT EXCLUSIVE. If A.tick() calls B.update(), B's cost is
//      counted in both rows. Read the table as "time spent inside this manager",
//      not as a partition that sums to the frame.
//   2. ONLY REACHABLE OBJECTS ARE COVERED. Managers main.js keeps in module
//      scope and never puts on window cannot be wrapped from the console. The
//      UNATTRIBUTED row is that gap — and if it dominates, that IS the finding:
//      the expensive thing is one we cannot see from here, so we read animate()
//      instead of measuring.
//
// Every method it wraps is restored when it finishes.

(function () {
    const TARGET_RE = /^(tick|update|render|step)$/;

    window.vg1ProfileAIS = function (durationMs = 5000) {
        const hitch = window.vg1Hitch;
        if (!hitch) { console.error('[profile-ais] vg1Hitch not found — is the app booted?'); return; }
        if (document.visibilityState !== 'visible') {
            // The trap that cost an evening on 2026-07-30: a hidden tab suspends
            // requestAnimationFrame entirely, so the FPS readout and any frame
            // timing become a stopped clock rather than a slow one.
            console.error('[profile-ais] this tab is HIDDEN. requestAnimationFrame is suspended — '
                        + 'every number would be meaningless. Focus the tab and re-run.');
            return;
        }

        const restore = [];
        const cost = new Map();

        for (const key of Object.keys(window)) {
            if (!/^vg1/.test(key)) continue;
            let obj;
            try { obj = window[key]; } catch { continue; }
            if (!obj || typeof obj !== 'object') continue;
            const proto = Object.getPrototypeOf(obj) || {};
            const names = new Set([...Object.keys(obj), ...Object.getOwnPropertyNames(proto)]);
            for (const m of names) {
                if (!TARGET_RE.test(m)) continue;
                let fn;
                try { fn = obj[m]; } catch { continue; }
                if (typeof fn !== 'function') continue;
                const label = `${key}.${m}`;
                const original = fn.bind(obj);
                restore.push(() => { try { obj[m] = fn; } catch {} });
                try {
                    obj[m] = function (...args) {
                        const t0 = performance.now();
                        try { return original(...args); }
                        finally {
                            const e = cost.get(label) ?? { ms: 0, calls: 0 };
                            e.ms += performance.now() - t0; e.calls++;
                            cost.set(label, e);
                        }
                    };
                } catch { restore.pop(); }
            }
        }

        const of = hitch.frame.bind(hitch), oe = hitch.frameEnd.bind(hitch);
        let t0 = 0, frames = 0, inFrameMs = 0;
        hitch.frame = function (...a) { t0 = performance.now(); return of(...a); };
        hitch.frameEnd = function (...a) {
            if (t0) { inFrameMs += performance.now() - t0; frames++; }
            return oe(...a);
        };
        restore.push(() => { hitch.frame = of; hitch.frameEnd = oe; });

        console.log(`[profile-ais] wrapped ${restore.length - 1} method(s); measuring ${durationMs} ms.`);
        console.log('[profile-ais] LEAVE THIS TAB FOCUSED and do not interact until it prints.');

        setTimeout(() => {
            for (const r of restore) r();
            if (!frames) {
                console.error('[profile-ais] zero frames recorded — the tab lost focus. Re-run.');
                return;
            }
            const perFrame = inFrameMs / frames;
            const rows = [...cost.entries()]
                .map(([label, e]) => ({
                    manager: label,
                    'ms/frame': +(e.ms / frames).toFixed(2),
                    'calls/frame': +(e.calls / frames).toFixed(1),
                    '% of JS': +((e.ms / inFrameMs) * 100).toFixed(1),
                }))
                .filter(r => r['ms/frame'] >= 0.05)
                .sort((a, b) => b['ms/frame'] - a['ms/frame']);

            const attributed = rows.reduce((s, r) => s + r['ms/frame'], 0);
            rows.push({
                manager: '— UNATTRIBUTED (module-scope, not on window) —',
                'ms/frame': +(perFrame - attributed).toFixed(2),
                'calls/frame': '',
                '% of JS': +(((perFrame - attributed) / perFrame) * 100).toFixed(1),
            });

            console.log(`[profile-ais] ${frames} frames · ${perFrame.toFixed(1)} ms/frame of main-thread JS`);
            console.table(rows);
            console.log('[profile-ais] Self time is NOT exclusive. Copy the table, or '
                      + 'copy(JSON.stringify(vg1ProfileAISResult)) to paste it somewhere.');
            window.vg1ProfileAISResult = { frames, msPerFrame: +perFrame.toFixed(2), rows };
        }, durationMs);
    };

    console.log('[profile-ais] ready — run  vg1ProfileAIS()');
})();

// ── SEGMENT TIMERS ──────────────────────────────────────────────────────────
//
// The manager-level table above attributed ~89% of main-thread time to code it
// could not reach: the work is INLINE in animate(), not inside any manager's
// tick(). main.js carries matching `_seg(...)` marks (temporary, 2026-07-31)
// that are inert until window.__vg1Seg exists — this turns them on, samples,
// and turns them off again.
//
//     await import('/tools/profile-ais.js'); vg1ProfileSegments()
//
// Segment N measures from the previous mark to this one, so a row's label is
// "everything up to and including this call". Unlike the manager table these ARE
// exclusive and they DO sum to the frame — which is the point.
(function () {
    window.vg1ProfileSegments = function (durationMs = 5000) {
        if (document.visibilityState !== 'visible') {
            console.error('[segments] this tab is HIDDEN — requestAnimationFrame is suspended '
                        + 'and every number would be a stopped clock. Focus the tab and re-run.');
            return;
        }
        window.__vg1Seg = { acc: {}, frames: 0 };
        console.log(`[segments] sampling ${durationMs} ms — LEAVE THIS TAB FOCUSED.`);
        setTimeout(() => {
            const S = window.__vg1Seg;
            window.__vg1Seg = null;              // marks go inert again
            if (!S || !S.frames) {
                console.error('[segments] zero frames — tab lost focus, or main.js has no _seg marks.');
                return;
            }
            const rows = Object.entries(S.acc)
                .map(([segment, ms]) => ({ segment, 'ms/frame': +(ms / S.frames).toFixed(2) }))
                .sort((a, b) => b['ms/frame'] - a['ms/frame']);
            const total = rows.reduce((t, r) => t + r['ms/frame'], 0);
            for (const r of rows) r['% of frame'] = +((r['ms/frame'] / total) * 100).toFixed(1);
            console.log(`[segments] ${S.frames} frames · ${total.toFixed(1)} ms/frame accounted for`);
            console.table(rows);
            window.vg1SegmentsResult = { frames: S.frames, msPerFrame: +total.toFixed(2), rows };
            console.log('[segments] copy(JSON.stringify(vg1SegmentsResult)) to paste it.');
        }, durationMs);
    };
    console.log('[segments] ready — run  vg1ProfileSegments()');
})();

// ── PASS CENSUS ─────────────────────────────────────────────────────────────
//
// Established 2026-07-31, by two measurements that only make sense together:
//   · 4.8x fewer pixels (4.47 Mpx -> 0.93 Mpx)  →  composer cost UNCHANGED (7.9 ms)
//   · AIS vessels hidden                        →  frame 15.5 ms cheaper
//
// A cost that tracks scene complexity but ignores resolution is not a fullscreen
// quad. Some of the ~16 renderer.render() calls per frame must be re-rendering
// the SCENE, so every vessel is drawn several times per frame.
//
// This counts them: for each render() call in a frame, which scene, how many
// objects were in it, what target it drew to, and how long it took.
//
//     await import('/tools/profile-ais.js'); vg1PassCensus()
(function () {
    window.vg1PassCensus = function (frames = 3) {
        const r = window.renderer;
        if (!r) { console.error('[passes] window.renderer not found'); return; }
        if (document.visibilityState !== 'visible') {
            console.error('[passes] tab is HIDDEN — nothing will render. Focus it and re-run.');
            return;
        }
        const orig = r.render.bind(r);
        const log = [];
        let frame = 0, idx = 0;

        r.render = function (scene, camera) {
            const t0 = performance.now();
            let objects = 0, meshes = 0, points = 0;
            try {
                scene?.traverse?.(o => {
                    if (o.visible === false) return;
                    if (o.isMesh || o.isPoints || o.isLine || o.isSprite) objects++;
                    if (o.isMesh) meshes++;
                    if (o.isPoints) points++;
                });
            } catch { /* a pass may hand us something odd */ }
            const rt = r.getRenderTarget();
            orig(scene, camera);
            log.push({
                frame, pass: idx++,
                scene: scene?.name || scene?.type || '?',
                objects, meshes, points,
                target: rt ? `${Math.round(rt.width)}x${Math.round(rt.height)}` : 'CANVAS',
                ms: +(performance.now() - t0).toFixed(2),
            });
        };

        const tick = () => {
            frame++; idx = 0;
            if (frame <= frames) return requestAnimationFrame(tick);
            r.render = orig;
            const scenePasses = log.filter(p => p.objects > 20);
            const quadPasses  = log.filter(p => p.objects <= 20);
            console.log(`[passes] ${log.length} render() calls over ${frames} frames `
                      + `(${(log.length / frames).toFixed(1)} per frame)`);
            console.log(`[passes] SCENE passes (>20 objects): ${(scenePasses.length / frames).toFixed(1)}/frame, `
                      + `${(scenePasses.reduce((s, p) => s + p.ms, 0) / frames).toFixed(2)} ms/frame`);
            console.log(`[passes] quad passes:                ${(quadPasses.length / frames).toFixed(1)}/frame, `
                      + `${(quadPasses.reduce((s, p) => s + p.ms, 0) / frames).toFixed(2)} ms/frame`);
            console.table(log.filter(p => p.frame === Math.min(2, frames)));
            window.vg1PassCensusResult = log;
            console.log('[passes] NOTE: renderer.render() returns as soon as commands are QUEUED, '
                      + 'so per-pass ms understates GPU work — the object counts are the signal here.');
            console.log('[passes] copy(JSON.stringify(vg1PassCensusResult))');
        };
        requestAnimationFrame(tick);
        console.log(`[passes] capturing ${frames} frames — leave the tab focused.`);
    };
    console.log('[passes] ready — run  vg1PassCensus()');
})();

// ── DRAW CALL CENSUS ────────────────────────────────────────────────────────
//
// Reading sceneSetup.js settles what the pass census was for: there is exactly
// ONE scene render per frame. ssaoPass is null, bokehPass.enabled is false, and
// the rest of the chain is UnrealBloom + tilt-shift — all fullscreen quads.
// So "several scene passes" was wrong.
//
// What survives the evidence is the other resolution-independent cost: DRAW
// CALLS. Per-object driver overhead does not care how many pixels each object
// covers, which is exactly the signature measured:
//
//     4.8x fewer pixels  → no change      (not fill bound)
//     AIS vessels hidden → 15.5 ms saved  (scene-complexity bound)
//     20.4M-splat terrain hidden → 0.6 ms (it is ONE draw call)
//
// renderer.info resets on every render() call, and the composer calls render()
// a dozen-plus times per frame — which is why an earlier reading showed "calls:
// 1". Turning autoReset off and reading at frame end gives the real number.
//
//     await import('/tools/profile-ais.js'); vg1DrawCalls()
(function () {
    window.vg1DrawCalls = function (frames = 30) {
        const r = window.renderer;
        if (!r) { console.error('[draws] window.renderer not found'); return; }
        if (document.visibilityState !== 'visible') {
            console.error('[draws] tab is HIDDEN — nothing renders. Focus it and re-run.'); return;
        }
        const prevAuto = r.info.autoReset;
        r.info.autoReset = false;
        const samples = [];
        let n = 0;
        const tick = () => {
            r.info.reset();
            requestAnimationFrame(() => {
                samples.push({
                    calls: r.info.render.calls,
                    triangles: r.info.render.triangles,
                    points: r.info.render.points,
                    lines: r.info.render.lines,
                    programs: r.info.programs?.length ?? 0,
                });
                if (++n < frames) return tick();
                r.info.autoReset = prevAuto;
                const med = (k) => {
                    const a = samples.map(s => s[k]).sort((x, y) => x - y);
                    return a[Math.floor(a.length / 2)];
                };
                const out = {
                    frames: samples.length,
                    drawCalls: med('calls'),
                    triangles: med('triangles'),
                    points: med('points'),
                    lines: med('lines'),
                    shaderPrograms: med('programs'),
                };
                console.table([out]);
                window.vg1DrawCallsResult = out;
                if (out.drawCalls > 300) {
                    console.warn(`[draws] ${out.drawCalls} draw calls per frame. At the ~10-20 us of `
                              + 'driver overhead a call typically costs, that alone accounts for the '
                              + 'frame time — and it is resolution-independent, which matches every '
                              + 'measurement taken so far. The fix is FEWER OBJECTS (merge/instance), '
                              + 'not fewer pixels and not faster shaders.');
                } else {
                    console.warn(`[draws] only ${out.drawCalls} draw calls — that is NOT enough to `
                              + 'explain the frame time, so this hypothesis is dead too. Next suspect '
                              + 'is a GPU pipeline stall: a readPixels, a getParameter, or a buffer '
                              + 'update mid-frame forcing a sync.');
                }
            });
        };
        console.log(`[draws] sampling ${frames} frames — leave the tab focused.`);
        tick();
    };
    console.log('[draws] ready — run  vg1DrawCalls()');
})();

// ── OBJECT CENSUS ───────────────────────────────────────────────────────────
//
// CONFIRMED 2026-07-31: 884 draw calls/frame. At the 10-20 us of driver overhead
// a call costs, that is 8.8-17.7 ms — against a measured 7.9 ms in
// composer.render(). Resolution-independent, scene-complexity-dependent. It fits.
//
// This groups every VISIBLE renderable in the scene so the 884 can be attributed
// to something merge-able. Grouped by constructor + material + rough geometry
// size, because "412 x LineSegments2 with 8 vertices" is a fix and "884 objects"
// is not.
//
//     await import('/tools/profile-ais.js'); vg1ObjectCensus()
(function () {
    window.vg1ObjectCensus = function (top = 25) {
        const s = window.scene;
        if (!s) { console.error('[objects] window.scene not found'); return; }
        const groups = new Map();
        let visible = 0, hidden = 0;

        const visibleInTree = (o) => { // an object only draws if every ancestor is visible
            for (let n = o; n; n = n.parent) if (n.visible === false) return false;
            return true;
        };

        s.traverse(o => {
            if (!(o.isMesh || o.isPoints || o.isLine || o.isLineSegments || o.isSprite)) return;
            if (!visibleInTree(o)) { hidden++; return; }
            visible++;
            const m = Array.isArray(o.material) ? o.material[0] : o.material;
            const verts = o.geometry?.attributes?.position?.count ?? 0;
            const bucket = verts === 0 ? '0' : verts < 10 ? '<10' : verts < 100 ? '<100'
                         : verts < 1e3 ? '<1k' : verts < 1e4 ? '<10k' : verts < 1e6 ? '<1M' : '1M+';
            const key = `${o.type} · ${m?.type ?? 'no-material'} · ${bucket} verts`;
            const g = groups.get(key) ?? { kind: key, count: 0, verts: 0, names: new Set() };
            g.count++; g.verts += verts;
            if (g.names.size < 3 && o.name) g.names.add(o.name);
            groups.set(key, g);
        });

        const rows = [...groups.values()]
            .sort((a, b) => b.count - a.count)
            .slice(0, top)
            .map(g => ({
                kind: g.kind,
                count: g.count,
                'total verts': g.verts,
                'example names': [...g.names].join(', ') || '(unnamed)',
            }));

        console.log(`[objects] ${visible} visible renderables (${hidden} hidden). `
                  + 'Each visible one is ~1 draw call.');
        console.table(rows);
        window.vg1ObjectCensusResult = { visible, hidden, rows };
        const worst = rows[0];
        if (worst && worst.count > 100) {
            console.warn(`[objects] biggest group: ${worst.count} x "${worst.kind}". `
                       + 'That is the merge target — one merged geometry, or an InstancedMesh, '
                       + 'turns those into a single call.');
        }
        console.log('[objects] copy(JSON.stringify(vg1ObjectCensusResult))');
    };
    console.log('[objects] ready — run  vg1ObjectCensus()');
})();

// ── EMPTY-OBJECT OWNER TRACE ────────────────────────────────────────────────
//
// After hiding entityBuilder's two trail Lines at creation, 531 visible
// zero-vertex Lines remained. So either another module creates them, or
// something switches them back on. This finds out WHICH, by reporting the
// parent chain and the distinguishing material properties of the survivors.
//
//     await import('/tools/profile-ais.js?v=' + Date.now()); vg1TraceEmpty()
(function () {
    window.vg1TraceEmpty = function (sample = 6) {
        const s = window.scene;
        if (!s) { console.error('[trace] window.scene not found'); return; }
        const vis = (o) => { for (let n = o; n; n = n.parent) if (n.visible === false) return false; return true; };
        const empties = [];
        s.traverse(o => {
            if (!(o.isLine || o.isLineSegments)) return;
            if ((o.geometry?.attributes?.position?.count ?? 0) !== 0) return;
            empties.push(o);
        });
        const visible = empties.filter(vis);

        // Group by parent identity + material colour: the colour is set from the
        // ship class in entityBuilder, so it separates ship trails from aircraft
        // contrails and from anything a different module made.
        const groups = new Map();
        for (const o of visible) {
            const p = o.parent;
            const m = Array.isArray(o.material) ? o.material[0] : o.material;
            const key = [
                `parent=${p?.name || p?.type || 'none'}`,
                `mat=${m?.type ?? '?'}`,
                `color=#${m?.color?.getHexString?.() ?? '??????'}`,
                `opacity=${m?.opacity ?? '?'}`,
                `dashed=${!!m?.isLineDashedMaterial}`,
            ].join(' · ');
            const g = groups.get(key) ?? { key, count: 0, examples: [] };
            g.count++;
            if (g.examples.length < 2) {
                g.examples.push({ uuid: o.uuid.slice(0, 8), name: o.name || '(unnamed)',
                                  siblings: p?.children?.length ?? 0 });
            }
            groups.set(key, g);
        }
        const rows = [...groups.values()].sort((a, b) => b.count - a.count)
            .map(g => ({ group: g.key, count: g.count, examples: JSON.stringify(g.examples) }));

        console.log(`[trace] ${empties.length} empty Lines total · ${visible.length} VISIBLE · `
                  + `${empties.length - visible.length} hidden`);
        console.table(rows);
        // A raw handle so you can inspect one directly in the Elements/Console.
        window.vg1EmptySample = visible.slice(0, sample);
        console.log(`[trace] window.vg1EmptySample holds ${window.vg1EmptySample.length} of them — `
                  + 'expand one to see .material.color and .parent.');
        console.log('[trace] The colour is the tell: entityBuilder sets ship trails from the ship '
                  + 'class hex and aircraft contrails to 0xd0e8ff.');
    };
    console.log('[trace] ready — run  vg1TraceEmpty()');
})();
