// tools/diagnose-dark-terrain.js — paste into DevTools while the dark view is on screen.
//
// WHY THIS EXISTS (2026-07-25). "The terrain is too dark" has at least nine
// independent multiplicative causes in this codebase, and reading the source
// found every one of them individually GUARDED — yet the screen was still
// black. That means the cause is runtime state, not a constant, and guessing
// at constants in that situation is how the Antarctica fix "appeared not to
// work" for a month (it addressed the smallest of three stacked causes; see
// memory/scar-tissue.md).
//
// This prints every term between the DEM and the pixel, so the dominant one is
// obvious instead of inferred. Run it, paste the output back.
//
// Usage:  copy this whole file into the DevTools console.

(() => {
    const out = [];
    const row = (k, v, note = '') => out.push({ term: k, value: v, note });
    const n = (x, d = 3) => (typeof x === 'number' ? x.toFixed(d) : String(x));

    // ── 0. Where are we, and what time does the sim think it is? ──────────────
    const cam = window.camera || window.vg1Camera;
    if (!cam) { console.error('No window.camera — run this from the map page.'); return; }
    row('camera.y (altitude)', n(cam.position.y), 'splat fades 25→15; tile levels appear at showAlt');
    row('camera.x / z', `${n(cam.position.x, 1)} / ${n(cam.position.z, 1)}`);
    const sc = window.simClock;
    row('sim time (UTC)', sc ? sc.date().toISOString() : 'no simClock');

    // ── 1. Sun / day-night ───────────────────────────────────────────────────
    const sky = window.skyManager;
    if (sky) {
        row('skyManager.sunElevation', n(sky.sunElevation),
            'NEGATIVE = local night. Splat is floored to 0.70, so splat ignores this.');
    }

    // ── 2. Base splat cloud — every uniform that can dim it ──────────────────
    const sp = window.splatCloud;
    if (!sp) {
        row('splatCloud', 'MISSING', '!! base cloud absent entirely');
    } else {
        const u = sp.material.uniforms;
        row('splatCloud.visible', sp.visible, 'false = base cloud culled (layerCoordinator did this)');
        const pick = ['uFade', 'uBrightness', 'uLandLift', 'uLandGamma', 'uSaturation',
                      'uNightDim', 'uNightFloor', 'uSunElevation', 'uOutsideCap', 'uTilt'];
        for (const k of pick) if (u[k]) row(`  splat.${k}`, n(u[k].value));
        // The actual night multiplier the shader will apply, worst case:
        if (u.uNightDim && u.uNightFloor) {
            const worst = 1 - u.uNightDim.value * (1 - u.uNightFloor.value);
            row('  → splat night multiplier (worst)', n(worst),
                'this is the FULL night-side dim; if ~1.0 night is NOT your problem');
        }
    }

    // ── 3. Lights (drive the splat's lit term) ───────────────────────────────
    for (const nm of ['ambientLight', 'dirLight']) {
        const L = window[nm];
        if (L) row(nm + '.intensity', n(L.intensity),
            nm === 'ambientLight' ? 'expected 4.0–4.5 (PBR divides by π)' : 'expected 0 at night, up to 2.0 at noon');
    }

    // ── 4. Tile stream — the surface you actually see close up ───────────────
    const ts = window.tileStream;
    if (!ts) {
        row('tileStream', 'MISSING', '!! no tile manager');
    } else {
        row('tileStream._enabled', ts._enabled,
            'false = Cesium Ion endpoint failed; check console for [TileStream]');
        row('tileStream._detailDim', n(ts._detailDim ?? 1),
            'MULTIPLIES every level\'s opacity. <1 means a 3DGS capture is claiming this ground.');
        const gs = window.gaussianSplatOverlay || window.gsManager;
        if (gs?.capturePresence) row('gs capturePresence', n(gs.capturePresence(cam)),
            'if >0 it is fading BOTH the base cloud and the tile points at once');
        if (ts.coverageFraction) row('tile coverageFraction', n(ts.coverageFraction(cam, null)),
            'drives the base-cloud fade; ×1.6 gain, so ~0.63 fully clears the base');

        (ts._caches || []).forEach((c, i) => {
            const tiles = [...(c._tiles?.values?.() || [])];
            const opac = tiles.map(t => t.opacity);
            const maxO = opac.length ? Math.max(...opac) : 0;
            const avgO = opac.length ? opac.reduce((a, b) => a + b, 0) / opac.length : 0;
            const mat0 = tiles[0]?.mesh?.material;
            row(`z${c._cfg.zoom}`,
                `tiles=${tiles.length} targetOpac=${n(c._targetOpac, 2)} maxOpac=${n(maxO, 2)} avgOpac=${n(avgO, 2)}`,
                mat0 ? `material.color=${n(mat0.color?.r, 2)} size=${n(mat0.size, 4)} vertexColors=${mat0.vertexColors}` : 'no material');
        });

        // Sample REAL vertex colours off a live tile — this separates "the
        // colours are dark" from "the colours are fine but something downstream
        // is eating them," which is the whole question.
        const live = (ts._caches || [])
            .flatMap(c => [...(c._tiles?.values?.() || [])])
            .filter(t => t.opacity > 0.05 && t.mesh?.geometry?.attributes?.color);
        if (!live.length) {
            row('LIVE VERTEX COLOURS', 'none — no tile is above 5% opacity',
                '!! nothing is drawing. The problem is OPACITY/COVERAGE, not colour.');
        } else {
            const a = live[0].mesh.geometry.attributes.color.array;
            let r = 0, g = 0, b = 0, cnt = 0, maxL = 0;
            for (let i = 0; i < a.length; i += 3) {
                r += a[i]; g += a[i + 1]; b += a[i + 2];
                const L = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
                if (L > maxL) maxL = L;
                cnt++;
            }
            r /= cnt; g /= cnt; b /= cnt;
            const meanL = 0.299 * r + 0.587 * g + 0.114 * b;
            row('LIVE VERTEX COLOURS', `mean rgb ${n(r)}/${n(g)}/${n(b)}`,
                `mean luminance ${n(meanL)}, brightest point ${n(maxL)} (over ${cnt} pts)`);
            row('  → verdict', meanL < 0.06
                    ? 'COLOURS ARE THE PROBLEM — imagery is near-black or absent'
                    : 'COLOURS ARE FINE (' + n(meanL) + ') — something downstream is eating them',
                'a healthy daylight satellite tile means luminance ~0.15–0.35');
        }

        // Did imagery actually arrive? If not, points fall back to the palette.
        if (ts.getStuckImageryTiles) {
            const stuck = ts.getStuckImageryTiles() || [];
            row('stuck imagery tiles', stuck.length,
                stuck.length ? '!! these are on palette fallback, not photo' : 'imagery is landing');
        }
        if (window.vg1ImgBreaker?.stats) {
            row('imagery circuit breaker', JSON.stringify(window.vg1ImgBreaker.stats(performance.now())),
                'if open, NO imagery is being fetched → photoBlend=0 → palette only');
        }
    }

    // ── 5. Renderer / post-processing ────────────────────────────────────────
    const rn = window.renderer;
    if (rn) {
        row('toneMappingExposure', n(rn.toneMappingExposure), 'CLAUDE.md: should be 0.85');
        row('renderer.toneMapping', rn.toneMapping);
    }
    const bp = window.bloomPass;
    if (bp) row('bloom strength/threshold', `${n(bp.strength, 2)} / ${n(bp.threshold, 2)}`);
    const bk = window.bokehPass;
    if (bk?.uniforms) row('bokeh aperture/maxblur',
        `${n(bk.uniforms.aperture?.value, 5)} / ${n(bk.uniforms.maxblur?.value, 4)}`,
        'a large maxblur smears the ground into mush, which reads as "dark"');

    console.table(out);
    console.log('%cPaste the table above back into the chat.', 'font-weight:bold');
    return out;
})();
