/**
 * tests/viewport.test.mjs — run with: node tests/viewport.test.mjs
 *
 * These tests exist to fail LOUDLY if anyone reintroduces window-relative
 * screen maths after the bezel lands. Per the codebase rule that every new
 * invariant needs a test that tries to fool it, the middle block below asserts
 * that the CURRENT uiController.js maths is wrong under a docked layout — so
 * the test documents the regression it is preventing, not just the fix.
 */

import {
    ndcFromRect, pxFromNdc, clampToRect, bufferSize
} from '../viewport.js';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else      { fail++; console.error(`  ✗ ${name} ${extra}`); }
}
function near(a, b, eps = 1e-9) { return Math.abs(a - b) < eps; }

// A 1920×1080 window running the bezel in INSPECT mode:
//   left rail 48, top rail 36, bottom rail 58, selection dock 296
const WIN  = { w: 1920, h: 1080 };
const RECT = { left: 48, top: 36, width: 1920 - 48 - 296, height: 1080 - 36 - 58 };
//                                        = 1576                      = 986

console.log('\nviewport — NDC against a docked map rect');
{
    const c = ndcFromRect(RECT.left + RECT.width / 2, RECT.top + RECT.height / 2, RECT);
    ok('centre of map → (0,0)', near(c.x, 0) && near(c.y, 0), JSON.stringify(c));

    const tl = ndcFromRect(RECT.left, RECT.top, RECT);
    ok('top-left of map → (-1, +1)', near(tl.x, -1) && near(tl.y, 1), JSON.stringify(tl));

    const br = ndcFromRect(RECT.left + RECT.width, RECT.top + RECT.height, RECT);
    ok('bottom-right of map → (+1, -1)', near(br.x, 1) && near(br.y, -1), JSON.stringify(br));
}

console.log('\nviewport — the regression this module prevents');
{
    // Old maths, as it stands in uiController.js:2350-2351
    const oldNdc = (cx, cy) => ({
        x:  (cx / WIN.w) * 2 - 1,
        y: -(cy / WIN.h) * 2 + 1
    });

    // Click the exact centre of the visible map.
    const cx = RECT.left + RECT.width / 2;   // 836
    const cy = RECT.top + RECT.height / 2;   // 529

    const good = ndcFromRect(cx, cy, RECT);
    const bad  = oldNdc(cx, cy);

    ok('new maths puts map-centre click at NDC origin',
        near(good.x, 0) && near(good.y, 0));

    ok('OLD maths does NOT — it is off-centre',
        !near(bad.x, 0, 1e-3) || !near(bad.y, 0, 1e-3),
        `oldNdc=${JSON.stringify(bad)}`);

    // Quantify the miss in pixels so the failure is legible in a diff.
    const missPxX = Math.abs(bad.x - good.x) * 0.5 * RECT.width;
    const missPxY = Math.abs(bad.y - good.y) * 0.5 * RECT.height;
    console.log(`    → old maths misses by ${missPxX.toFixed(1)}px × ${missPxY.toFixed(1)}px`);
    ok('miss is large enough to select the wrong entity (>20px)',
        Math.hypot(missPxX, missPxY) > 20);
}

console.log('\nviewport — dock open vs closed changes the answer');
{
    const OPEN   = RECT;
    const CLOSED = { left: 48, top: 36, width: 1920 - 48, height: 1080 - 36 - 58 };

    const cx = 900, cy = 500;
    const a = ndcFromRect(cx, cy, OPEN);
    const b = ndcFromRect(cx, cy, CLOSED);
    ok('same pixel maps to different NDC when the dock toggles',
        !near(a.x, b.x, 1e-6),
        `open=${a.x.toFixed(4)} closed=${b.x.toFixed(4)}`);
    console.log('    → this is why a cached width is not acceptable; measure on change');
}

console.log('\nviewport — NDC → px round trip');
{
    for (const [nx, ny] of [[0, 0], [-1, 1], [1, -1], [0.37, -0.62]]) {
        const p = pxFromNdc(nx, ny, RECT.width, RECT.height);
        const back = ndcFromRect(p.x + RECT.left, p.y + RECT.top, RECT);
        ok(`round trip (${nx}, ${ny})`, near(back.x, nx, 1e-9) && near(back.y, ny, 1e-9),
            JSON.stringify(back));
    }
}

console.log('\nviewport — tooltip clamping stays inside the map, not the window');
{
    const TIP = { w: 200, h: 140 };

    // A tooltip near the right edge of the MAP must not slide under the dock.
    const r = clampToRect(1600, 400, TIP.w, TIP.h, RECT);
    const rightLimit = RECT.left + RECT.width - TIP.w - 12;   // 1412
    ok('right edge clamps to map, not window', near(r.x, rightLimit),
        `x=${r.x} expected=${rightLimit}`);
    ok('clamped tooltip does not overlap the dock', r.x + TIP.w <= RECT.left + RECT.width);

    // Bottom edge must not slide under the timeline rail.
    const b = clampToRect(600, 1040, TIP.w, TIP.h, RECT);
    const bottomLimit = RECT.top + RECT.height - TIP.h - 12;  // 870
    ok('bottom edge clamps above the timeline rail', near(b.y, bottomLimit),
        `y=${b.y} expected=${bottomLimit}`);

    // Top-left must not slide under the top/left rails.
    const tl = clampToRect(0, 0, TIP.w, TIP.h, RECT);
    ok('top-left clamps clear of the rails',
        tl.x >= RECT.left && tl.y >= RECT.top, JSON.stringify(tl));
}

console.log('\nviewport — degenerate rects must not produce NaN');
{
    // The dock collapse transition passes through width 0 for a frame. A NaN
    // aspect silently corrupts the projection matrix and blanks the map with no
    // console error — viewport.js floors the rect at 1px to prevent this.
    const zero = { left: 0, top: 0, width: 0, height: 0 };
    const n = ndcFromRect(10, 10, zero);
    ok('zero-size rect yields non-finite values (hence the 1px floor in _readRect)',
        !Number.isFinite(n.x) || !Number.isFinite(n.y),
        JSON.stringify(n));

    const floored = { left: 0, top: 0, width: 1, height: 1 };
    const f = ndcFromRect(10, 10, floored);
    ok('1px floor keeps values finite', Number.isFinite(f.x) && Number.isFinite(f.y));
}

console.log('\nviewport — drawing buffer must match THREE.WebGLRenderer exactly');
{
    // THREE does: _canvas.width = Math.floor( width * _pixelRatio )
    const three = (w, r) => Math.floor(w * r);

    // The exact case observed in the running app. Note 1.7 itself is NOT the
    // problem — 2560 * 1.7 === 4352 exactly. The damage comes from a ratio that
    // has been through arithmetic, which is what the runtime FPS monitor
    // produces when it nudges the previous value. Measured live: the renderer
    // was on 1.6999999999999997 and had allocated a 4351px buffer, while the
    // pre-fix bufferWidth() returned 4351.999999999999.
    const RATIO = 1.6999999999999997;
    const naive = 2560 * RATIO;
    ok('the damaging ratio really does produce a float', !Number.isInteger(naive),
        `2560 × ${RATIO} = ${naive}`);

    const f = bufferSize(2560, 1249, RATIO);
    ok('floors to THREE\'s value (4351, matching the real canvas)',
        f.w === three(2560, RATIO) && f.w === 4351, `got ${f.w}`);
    ok('…and is an integer', Number.isInteger(f.w) && Number.isInteger(f.h));
    ok('bare multiply would have been off by one',
        Math.ceil(naive) - f.w === 1, `naive=${naive} fixed=${f.w}`);

    // Sweep the ratios the quality tiers and the runtime monitor actually use.
    let mismatches = 0;
    for (const r of [1, 1.25, 1.5, 1.7, 1.75, 1.8, 2]) {
        for (const [w, h] of [[2560, 1249], [1920, 1080], [2216, 1155], [1576, 986]]) {
            const b = bufferSize(w, h, r);
            if (b.w !== three(w, r) || b.h !== three(h, r)) mismatches++;
        }
    }
    ok('28 ratio × size combinations all match THREE', mismatches === 0,
        `${mismatches} mismatched`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
