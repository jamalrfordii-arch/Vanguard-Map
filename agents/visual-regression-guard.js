#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║  VANGUARD  —  Visual Regression Guard                   ║
 * ║                                                          ║
 * ║  Captures screenshots at fixed camera positions and      ║
 * ║  pixel-diffs them against stored golden baselines.       ║
 * ║  Catches bloom explosions, terrain colour shifts,        ║
 * ║  water changes, and LOD pop-in before you notice them.   ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * Usage:
 *   node visual-regression-guard.js              ← compare vs baselines
 *   node visual-regression-guard.js --update     ← save new baselines
 *   node visual-regression-guard.js --pos mediterranean  ← single position
 *
 * First run: always use --update to create the baselines.
 * After any code change: run without --update to detect regressions.
 */

import puppeteer   from 'puppeteer';
import { PNG }     from 'pngjs';
import pixelmatch  from 'pixelmatch';
import fs          from 'fs';
import path        from 'path';
import { fileURLToPath } from 'url';

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const BASELINES_DIR = path.join(__dirname, 'baselines');
const REPORTS_DIR   = path.join(__dirname, 'reports');
const MAP_URL       = 'http://localhost:3000';

// How many pixels (fraction 0–1) can differ before the test fails.
// 0.03 = 3% tolerance — handles JPEG artefacts / minor AA variation.
const FAIL_THRESHOLD = 0.03;

const UPDATE_MODE = process.argv.includes('--update');
const SINGLE_POS  = (() => {
  const i = process.argv.indexOf('--pos');
  return i !== -1 ? process.argv[i + 1] : null;
})();

// ── Camera test positions ─────────────────────────────────────────────────────
// Each position exercises a different visual system:
//   global_overview   → bloom, overall tone mapping, ocean/land balance
//   north_atlantic    → water Gerstner waves, fog pass
//   mediterranean     → vessel rendering, cluster bubbles, port markers
//   strait_of_hormuz  → chokepoint glyph, close water, bathymetry
//   close_zoom_port   → continent mesh LOD, building extrusion, wake particles
//
// cam   = [x, y, z]   camera.position
// tgt   = [x, y, z]   controls.target  (where camera looks)
const POSITIONS = [
  { name: 'global_overview',  cam: [0,   300, 80],   tgt: [0,   0,  0]  },
  { name: 'north_atlantic',   cam: [-15, 110, -25],  tgt: [-15, 0, -25] },
  { name: 'mediterranean',    cam: [25,  65,  -48],  tgt: [25,  0, -48] },
  { name: 'strait_of_hormuz', cam: [90,  28,  -18],  tgt: [90,  0, -18] },
  { name: 'close_zoom_port',  cam: [12,  16,  -62],  tgt: [12,  0, -62] },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function ts()         { return new Date().toISOString().replace(/[:.]/g, '-'); }
function log(msg)     { console.log(`[VRG] ${msg}`); }
function pass(msg)    { console.log(`\x1b[32m✓ ${msg}\x1b[0m`); }
function fail(msg)    { console.log(`\x1b[31m✗ ${msg}\x1b[0m`); }
function info(msg)    { console.log(`\x1b[36m  ${msg}\x1b[0m`); }

/** Wait for the Three.js scene + controls to be ready. */
async function waitForScene(page) {
  await page.waitForFunction(
    () => window.scene && window.controls && window.scene.children.length > 5,
    { timeout: 30_000 }
  );
  // Extra settle time for shaders / first-frame jitter
  await new Promise(r => setTimeout(r, 2000));
}

/** Move camera to a test position and wait for it to settle. */
async function setCameraPosition(page, cam, tgt) {
  await page.evaluate(([cx, cy, cz], [tx, ty, tz]) => {
    window.controls.object.position.set(cx, cy, cz);
    window.controls.target.set(tx, ty, tz);
    window.controls.update();
  }, cam, tgt);
  // Let LOD tiles, trails, and post-process settle
  await new Promise(r => setTimeout(r, 1500));
}

/** Capture a PNG Buffer from puppeteer screenshot. */
async function capture(page) {
  return page.screenshot({ type: 'png', fullPage: false });
}

/** Compare two PNG buffers. Returns { diffRatio, diffPng }. */
function compareImages(bufA, bufB) {
  const imgA = PNG.sync.read(bufA);
  const imgB = PNG.sync.read(bufB);
  const { width, height } = imgA;
  const diff   = new PNG({ width, height });
  const count  = pixelmatch(imgA.data, imgB.data, diff.data, width, height, { threshold: 0.1 });
  const ratio  = count / (width * height);
  return { diffRatio: ratio, diffPng: PNG.sync.write(diff), width, height };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  ensureDir(BASELINES_DIR);
  ensureDir(REPORTS_DIR);

  log(UPDATE_MODE ? '🔄 Running in UPDATE mode — saving new baselines' : '🔍 Running in COMPARE mode');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=swiftshader'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 810 });

  log(`Navigating to ${MAP_URL}…`);
  await page.goto(MAP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForScene(page);

  // Remove AIS modal (dynamically created div, child has id="ais-connect-btn")
  await page.evaluate(() => {
    localStorage.setItem('vanguard_ais_key', 'AGENT_BYPASS');
    const aisBtn = document.getElementById('ais-connect-btn');
    if (aisBtn) {
      let el = aisBtn;
      while (el && el !== document.body) {
        if (el.style && el.style.position === 'fixed') { el.remove(); break; }
        el = el.parentElement;
      }
    }
    document.querySelectorAll('button').forEach(b => {
      if (/^got it$/i.test(b.textContent.trim())) b.click();
    });
  });
  await new Promise(r => setTimeout(r, 1000));
  log('Scene ready.');

  const positions = SINGLE_POS
    ? POSITIONS.filter(p => p.name === SINGLE_POS)
    : POSITIONS;

  if (positions.length === 0) {
    fail(`Unknown position "${SINGLE_POS}". Available: ${POSITIONS.map(p => p.name).join(', ')}`);
    await browser.close();
    process.exit(1);
  }

  const results = [];

  for (const pos of positions) {
    log(`Camera → ${pos.name}`);
    await setCameraPosition(page, pos.cam, pos.tgt);

    const buf = await capture(page);

    if (UPDATE_MODE) {
      const baselinePath = path.join(BASELINES_DIR, `${pos.name}.png`);
      fs.writeFileSync(baselinePath, buf);
      pass(`Baseline saved: ${pos.name}.png`);
      results.push({ name: pos.name, status: 'updated' });
      continue;
    }

    const baselinePath = path.join(BASELINES_DIR, `${pos.name}.png`);
    if (!fs.existsSync(baselinePath)) {
      fail(`No baseline for "${pos.name}" — run with --update first`);
      results.push({ name: pos.name, status: 'no_baseline' });
      continue;
    }

    const baselineBuf = fs.readFileSync(baselinePath);
    const { diffRatio, diffPng, width, height } = compareImages(baselineBuf, buf);
    const pct = (diffRatio * 100).toFixed(2);

    if (diffRatio > FAIL_THRESHOLD) {
      fail(`${pos.name}: ${pct}% pixels changed (threshold ${(FAIL_THRESHOLD * 100).toFixed(0)}%)`);
      const reportBase = path.join(REPORTS_DIR, `${pos.name}_${ts()}`);
      fs.writeFileSync(`${reportBase}_current.png`,  buf);
      fs.writeFileSync(`${reportBase}_diff.png`,     diffPng);
      info(`Diff saved to reports/${path.basename(reportBase)}_diff.png`);
      info(`Current saved to reports/${path.basename(reportBase)}_current.png`);
      results.push({ name: pos.name, status: 'FAIL', diffPct: pct });
    } else {
      pass(`${pos.name}: ${pct}% changed — within tolerance ✓`);
      results.push({ name: pos.name, status: 'pass', diffPct: pct });
    }
  }

  await browser.close();

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log('\n─────────────────────────────────────');
  console.log('  Visual Regression Guard — Summary  ');
  console.log('─────────────────────────────────────');
  const failures = results.filter(r => r.status === 'FAIL');
  results.forEach(r => {
    if (r.status === 'pass')    pass(`  ${r.name.padEnd(25)} ${r.diffPct}%`);
    else if (r.status === 'FAIL') fail(`  ${r.name.padEnd(25)} ${r.diffPct}% ← REGRESSION`);
    else if (r.status === 'updated') pass(`  ${r.name.padEnd(25)} baseline updated`);
    else fail(`  ${r.name.padEnd(25)} no baseline`);
  });
  console.log('─────────────────────────────────────');

  if (failures.length > 0) {
    console.log(`\n\x1b[31m${failures.length} regression(s) detected. Check reports/ for diff images.\x1b[0m`);
    process.exit(1);
  } else if (!UPDATE_MODE) {
    console.log('\n\x1b[32mAll positions passed.\x1b[0m');
  }
}

main().catch(err => { console.error('[VRG] Fatal:', err); process.exit(1); });
