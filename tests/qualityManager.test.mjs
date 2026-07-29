// tests/qualityManager.test.mjs — try to fool the adaptive quality controller.
// Run from repo root:  node tests/qualityManager.test.mjs
//
// Why this suite exists (2026-07-24): the controller silently pinned a scene that
// actually runs at 77fps to its lowest pixel ratio and left it there for the whole
// session. Nothing was broken in a way anything could observe — the map just looked
// soft, and `info()` reported a pixel ratio the renderer wasn't using. It cost an
// afternoon to find. The failure mode was never "wrong arithmetic"; it was feeding
// the controller frames that weren't frames. So the tests below are mostly about
// what goes IN, not what comes out.

import './_stubs/domEnv.mjs';

import assert from 'node:assert/strict';

// pixelCap() clamps to devicePixelRatio, so give the stub headroom to climb into.
window.devicePixelRatio = 2;

const { quality } = await import('../qualityManager.js');

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// ── Harness ──────────────────────────────────────────────────────────────────
function fakeRenderer(initial = 1) {
    let pr = initial;
    return {
        setPixelRatio(v) { pr = v; },
        getPixelRatio()  { return pr; },
    };
}

// Reset the singleton to a known pre-warmup state and attach a fresh renderer.
function reset({ tier = 'ULTRA', startPr = 1.0, renderScale = 1 } = {}) {
    quality.setTier(tier);
    quality.setRenderScale(renderScale);
    const r = fakeRenderer(startPr);
    quality.attachRenderer(r);
    quality._pr    = startPr;
    quality._warm  = 0;
    quality._cool  = 0;
    quality._emaMs = 16.7;
    r.setPixelRatio(startPr);
    return r;
}

const feed = (n, ms) => { for (let i = 0; i < n; i++) quality.tick(ms / 1000); };

// Frame time INDEPENDENT of pixel ratio is what `feed` models, and that is a real
// scene (measured 2026-07-25: 4x the pixels cost 8% more frame time). But it is not
// the only one — a genuinely fill-bound renderer costs pixel AREA, and the
// controller is now allowed to tell the difference. This helper models that case so
// the ease-down path is exercised against a GPU where lowering resolution actually
// works, instead of against one where it silently never could.
const feedFillBound = (n, msAtPr1, r) => {
    for (let i = 0; i < n; i++) {
        const pr = r.getPixelRatio();
        quality.tick((msAtPr1 * pr * pr) / 1000);
    }
};

// ── The actual bug: boot frames are not frames ───────────────────────────────
console.log('boot-frame rejection');

test('a long burst of clamped 100ms boot frames never moves pixel ratio', () => {
    const r = reset({ startPr: 1.0 });
    // main.js clamps delta to 0.1s, so every stalled boot frame — whether it took
    // 300ms or 3s — arrives here as exactly 100ms and looks like a real 10fps
    // sample. 600 of them is a realistic cold boot.
    feed(600, 100);
    assert.equal(r.getPixelRatio(), 1.0, 'boot frames must not downscale the map');
});

test('boot frames leave no residue in the frame-time average', () => {
    reset();
    feed(600, 100);
    feed(30, 13);
    // Deliberately only 30 good frames. An α=0.1 EMA poisoned to 100ms decays to
    // ~16.7 after 30 samples at 13ms — still above the 15ms "plenty of headroom"
    // gate, which is exactly how the controller stayed stuck. Rejected samples
    // must leave the average at 13 immediately, not merely converge eventually.
    assert.ok(quality.info().frameMs < 15,
        `EMA polluted by rejected samples: ${quality.info().frameMs}ms`);
});

test('samples just under the reject threshold are still accepted', () => {
    reset();
    feed(400, 45);            // 45ms — genuinely slow, but plausible steady state
    assert.ok(quality.info().frameMs > 40,
        'a real 45ms frame must count; the gate is for outliers, not slow machines');
});

test('zero and negative deltas are ignored, not treated as infinite fps', () => {
    const r = reset({ startPr: 1.0 });
    feed(600, 0);
    feed(600, -5);
    assert.equal(r.getPixelRatio(), 1.0, 'a paused/backgrounded tab must not upscale');
    assert.equal(quality.info().warmedUp, false, 'garbage samples must not warm the controller');
});

// ── Warmup gate ──────────────────────────────────────────────────────────────
console.log('warmup gate');

test('controller does not act before it has enough samples', () => {
    const r = reset({ startPr: 1.0 });
    feed(60, 13);             // fast frames, but only half the warmup budget
    assert.equal(r.getPixelRatio(), 1.0, 'must measure before acting');
    assert.equal(quality.info().warmedUp, false);
});

test('EMA seeds from the first real sample instead of the 16.7 guess', () => {
    reset();
    quality.tick(0.013);
    assert.equal(quality.info().frameMs, 13,
        'first accepted sample should become the average outright');
});

// ── Steady-state behaviour still works ───────────────────────────────────────
console.log('steady-state adaptation');

test('sustained fast frames climb toward the cap', () => {
    const r = reset({ startPr: 1.0 });
    feed(4000, 10);           // 100fps — plenty of headroom
    assert.ok(r.getPixelRatio() > 1.0, 'should have climbed');
    assert.ok(r.getPixelRatio() <= quality.pixelCap() + 1e-9,
        `climbed past the cap: ${r.getPixelRatio()} > ${quality.pixelCap()}`);
});

test('sustained slow frames ease down but never below native', () => {
    const r = reset({ startPr: 2.0 });
    feedFillBound(6000, 10, r);   // 40ms at pr=2 — behind budget, and fill-bound
    assert.ok(r.getPixelRatio() < 2.0, 'should have eased down from supersampling');
    // PR_FLOOR is 1.0: give back supersampling under load, but never render
    // below native. Downscaling measured as ~1ms of relief and a large
    // legibility cost — see the constant's comment.
    assert.ok(r.getPixelRatio() >= 1.0 - 1e-9,
        `rendered below native: ${r.getPixelRatio()}`);
});

test('resolution is NOT surrendered when it does not buy frame time', () => {
    // The 2026-07-25 fix. Measured live on an RTX 5060: pr=1 gave 17.7ms, pr=2 gave
    // 19.2ms — 4x the pixels for 8% more time — and hiding the entire 20M-point
    // splat cloud changed nothing. The cost was outside the render entirely. The
    // old controller saw "slow" and walked resolution to the floor anyway, paying
    // in legibility and buying nothing: at 1x, ~8 splats land on each pixel and the
    // depth test picks one at random, which is what made the world view look like
    // static. `feed` models exactly this scene — frame time ignores pixel ratio.
    const savedDpr = window.devicePixelRatio;
    window.devicePixelRatio = 1;
    const r = reset({ tier: 'ULTRA', renderScale: 2, startPr: 2.0 });
    feed(8000, 40);            // sustained 25fps that pixel ratio cannot fix
    assert.ok(r.getPixelRatio() > 1.0 + 1e-9,
        `gave up resolution that bought nothing: ended at ${r.getPixelRatio()}`);
    window.devicePixelRatio = savedDpr;
});

test('but a few slow frames alone do not latch it — one noisy sample is not proof', () => {
    // FILL_BOUND_STRIKES > 1 exists so a GC pause or a background tab cannot
    // convince the controller its only lever is broken.
    const savedDpr = window.devicePixelRatio;
    window.devicePixelRatio = 1;
    const r = reset({ tier: 'ULTRA', renderScale: 2, startPr: 2.0 });
    feedFillBound(3000, 10, r);   // fill-bound: stepping down genuinely helps
    assert.ok(r.getPixelRatio() < 2.0, 'a fill-bound scene must still ease down');
    window.devicePixelRatio = savedDpr;
});

test('escapes the floor deadlock — the live failure this fix was written for', () => {
    // The first version of the fix probed only on the way DOWN, and so could never
    // learn anything once it had ALREADY reached the floor: it cannot step down to
    // probe, and refuses to step up while slow. Found live 2026-07-25 — the map sat
    // at 1x with pixelCap 2, frameMs 22.2, _fillBound stuck true, forever.
    const savedDpr = window.devicePixelRatio;
    window.devicePixelRatio = 1;
    const r = reset({ tier: 'ULTRA', renderScale: 2, startPr: 1.0 });   // START at the floor
    feed(8000, 40);            // slow, and pixel ratio cannot fix it
    assert.ok(r.getPixelRatio() > 1.0 + 1e-9,
        `still deadlocked at the floor: ${r.getPixelRatio()}`);
    window.devicePixelRatio = savedDpr;
});

test('a genuinely fill-bound machine at the floor STAYS there', () => {
    // The other side of that coin: proof-by-exhaustion must not hand a weak GPU
    // supersampling it cannot afford. Climbing is measured, so a real cost restores
    // _fillBound and the controller comes back down — and _leverProven then stops
    // the exhaustion rule re-firing, so it settles instead of oscillating.
    const savedDpr = window.devicePixelRatio;
    window.devicePixelRatio = 1;
    const r = reset({ tier: 'ULTRA', renderScale: 2, startPr: 1.0 });
    feedFillBound(12000, 40, r);   // 40ms even at 1x — genuinely fill-bound and slow
    assert.ok(r.getPixelRatio() <= 1.3 + 1e-9,
        `climbed away from the floor on a machine that cannot afford it: ${r.getPixelRatio()}`);
    window.devicePixelRatio = savedDpr;
});

test('the floor never exceeds the cap on a low-dpr display', () => {
    const savedDpr = window.devicePixelRatio;
    window.devicePixelRatio = 0.75;          // cap becomes 0.75, below PR_FLOOR
    const r = reset({ tier: 'LOW', startPr: 0.75 });
    feed(6000, 40);
    assert.ok(r.getPixelRatio() <= 0.75 + 1e-9,
        `floor clamped above the cap: ${r.getPixelRatio()}`);
    window.devicePixelRatio = savedDpr;
});

// ── Reporting ────────────────────────────────────────────────────────────────
console.log('info() reporting');

test('livePixelRatio reads the renderer, not the seeded field', () => {
    const r = reset({ startPr: 1.0 });
    r.setPixelRatio(0.6);                    // something bypasses the controller
    assert.equal(quality.info().livePixelRatio, 0.6,
        'info() must not report a value the renderer is not using');
});

test('with no renderer attached it reports unknown, not the optimistic seed', () => {
    const saved = quality._renderer;
    quality._renderer = null;
    const i = quality.info();
    // _pr is seeded to the tier cap, which is exactly the misleading number that
    // sent an earlier debugging session an hour in the wrong direction. Refusing
    // to answer is strictly better than answering wrongly.
    assert.equal(i.livePixelRatio, null);
    assert.match(i.superSampling, /no renderer/);
    quality._renderer = saved;
});

test('info() surfaces the devicePixelRatio clamp that makes ULTRA unreachable', () => {
    const savedDpr = window.devicePixelRatio;
    window.devicePixelRatio = 1;
    reset({ tier: 'ULTRA', startPr: 1.0 });
    const i = quality.info();
    assert.equal(i.tier, 'ULTRA');
    assert.equal(i.pixelCap, 1, 'ULTRA advertises 2.0 but dpr=1 caps it at 1.0');
    assert.equal(i.devicePixelRatio, 1);
    window.devicePixelRatio = savedDpr;
});

// ── Supersampling ────────────────────────────────────────────────────────────
console.log('render scale / supersampling');

test('renderScale 1.0 changes nothing — the default must be inert', () => {
    const savedDpr = window.devicePixelRatio;
    window.devicePixelRatio = 1;
    reset({ tier: 'ULTRA', renderScale: 1 });
    assert.equal(quality.pixelCap(), quality.autoCap(),
        'default render scale must leave the automatic ceiling untouched');
    assert.equal(quality.pixelCap(), 1, 'dpr=1 ULTRA still caps at native');
    window.devicePixelRatio = savedDpr;
});

test('renderScale lifts the devicePixelRatio clamp', () => {
    const savedDpr = window.devicePixelRatio;
    window.devicePixelRatio = 1;
    const r = reset({ tier: 'ULTRA', renderScale: 1 });
    assert.equal(r.getPixelRatio(), 1, 'precondition: at native');
    quality.setRenderScale(2);
    // This is the whole point: dpr=1 means autoCap can never exceed 1.0, so
    // supersampling is unreachable by any automatic path. An explicit opt-in
    // is the only way to render above native.
    assert.equal(quality.autoCap(), 1);
    assert.equal(quality.pixelCap(), 2, 'explicit opt-in must exceed native');
    assert.equal(r.getPixelRatio(), 2, 'and must apply immediately, not creep via tick()');
    quality.setRenderScale(1);
    window.devicePixelRatio = savedDpr;
});

test('RENDER_SCALE_MAX guards against absurd pixel counts on hidpi displays', () => {
    const savedDpr = window.devicePixelRatio;
    window.devicePixelRatio = 2;                  // retina
    reset({ tier: 'ULTRA', renderScale: 2 });     // would be 4.0 = 16× a dpr=1 render
    assert.ok(quality.pixelCap() <= 2.0 + 1e-9,
        `unguarded pixel ratio: ${quality.pixelCap()}`);
    window.devicePixelRatio = savedDpr;
});

test('changing render scale re-arms the controller', () => {
    reset({ renderScale: 1 });
    feed(400, 10);
    assert.equal(quality.info().warmedUp, true, 'precondition: warmed up');
    quality.setRenderScale(1.5);
    // Frame cost just changed by up to 2.25×. The existing average describes a
    // scene that no longer exists, so acting on it would be acting on stale data.
    assert.equal(quality.info().warmedUp, false, 'must re-measure after a cost change');
    quality.setRenderScale(1);
});

test('under load the controller gives back supersampling but stops at native', () => {
    const savedDpr = window.devicePixelRatio;
    window.devicePixelRatio = 1;
    const r = reset({ tier: 'ULTRA', renderScale: 2, startPr: 2.0 });
    feedFillBound(8000, 10, r);   // 40ms at pr=2, scaling with pixel area
    assert.ok(r.getPixelRatio() < 2.0, 'should surrender supersampling under real load');
    assert.ok(r.getPixelRatio() >= 1.0 - 1e-9,
        `fell below native: ${r.getPixelRatio()}`);
    window.devicePixelRatio = savedDpr;
});

// ── Composer sync ────────────────────────────────────────────────────────────
console.log('pixel ratio propagation');

test('every pixel-ratio change announces itself', () => {
    // EffectComposer caches renderer.getPixelRatio() at construction, so a change
    // that isn't announced leaves the whole post chain shading at the old
    // resolution. main.js listens for this to call composer.setPixelRatio().
    const seen = [];
    const h = (e) => seen.push(e.detail.pixelRatio);
    window.addEventListener('vg1:pixelRatioChanged', h);
    try {
        const savedDpr = window.devicePixelRatio;
        window.devicePixelRatio = 1;
        reset({ tier: 'ULTRA', renderScale: 1 });   // attachRenderer fires one
        const afterAttach = seen.length;
        assert.ok(afterAttach > 0, 'attachRenderer must announce the initial ratio');

        quality.setRenderScale(2);
        assert.ok(seen.length > afterAttach, 'setRenderScale must announce');
        assert.equal(seen[seen.length - 1], 2);

        const beforeTick = seen.length;
        quality._warm = 999; quality._cool = 0; quality._emaMs = 40; quality._pr = 2.0;
        quality.tick(0.04);                          // slow frame → step down
        assert.ok(seen.length > beforeTick, 'tick()-driven changes must announce too');

        quality.setRenderScale(1);
        window.devicePixelRatio = savedDpr;
    } finally {
        window.removeEventListener('vg1:pixelRatioChanged', h);
    }
});

console.log(`\n${passed} passed`);
