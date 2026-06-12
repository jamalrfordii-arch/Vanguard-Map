#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║  VANGUARD  —  Shader Auto-Tuner Agent                   ║
 * ║                                                          ║
 * ║  Iterates over terrain shader uniform values, captures  ║
 * ║  screenshots at each combination, and uses Claude        ║
 * ║  vision to score them for visual quality — producing a  ║
 * ║  suggested optimal config.js block.                      ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * Uniforms tuned:
 *   uBrightness  (land brightness multiplier)
 *   uLandLift    (additive floor for shadowed land)
 *   uLandGamma   (shadow lift curve)
 *   uSaturation  (colour vibrancy)
 *
 * Usage:
 *   node shader-auto-tuner.js               ← run full sweep
 *   node shader-auto-tuner.js --quick       ← coarser grid, faster
 *   node shader-auto-tuner.js --target polar ← focus on polar brightness bug
 *
 * Outputs:
 *   reports/shader-tune-results.json   ← all scores
 *   reports/shader-tune-best.png       ← screenshot of best combo
 *   Prints a ready-to-paste config.js block with optimal values
 */

import puppeteer  from 'puppeteer';
import Anthropic  from '@anthropic-ai/sdk';
import fs         from 'fs';
import path       from 'path';
import { fileURLToPath } from 'url';
import { waitForSceneAndDismissModals, launchBrowser } from './agent-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORTS   = path.join(__dirname, 'reports');
const MAP_URL   = 'http://localhost:3000';

const QUICK_MODE  = process.argv.includes('--quick');
const TARGET      = (() => { const i = process.argv.indexOf('--target'); return i !== -1 ? process.argv[i + 1] : 'global'; })();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function log(msg)     { console.log(`[TUNER] ${msg}`); }
function ok(msg)      { console.log(`\x1b[32m✓  ${msg}\x1b[0m`); }

// ── Current defaults from config.js (used as centre of search space) ─────────
const DEFAULTS = {
  uBrightness:  0.90,
  uLandLift:    0.28,
  uLandGamma:   0.65,
  uSaturation:  2.10,
};

// ── Search grids ──────────────────────────────────────────────────────────────
// Full grid: ~81 combinations. Quick grid: ~16.
function range(centre, step, count) {
  const vals = [];
  const half = Math.floor(count / 2);
  for (let i = -half; i <= half; i++) {
    vals.push(+(centre + i * step).toFixed(3));
  }
  return vals;
}

const GRID = QUICK_MODE
  ? {
      uBrightness: range(DEFAULTS.uBrightness, 0.05, 3),
      uLandLift:   range(DEFAULTS.uLandLift,   0.05, 3),
      uLandGamma:  [DEFAULTS.uLandGamma],
      uSaturation: range(DEFAULTS.uSaturation, 0.15, 3),
    }
  : {
      uBrightness: range(DEFAULTS.uBrightness, 0.04, 5),
      uLandLift:   range(DEFAULTS.uLandLift,   0.04, 5),
      uLandGamma:  range(DEFAULTS.uLandGamma,  0.05, 3),
      uSaturation: range(DEFAULTS.uSaturation, 0.15, 5),
    };

// Respect documented hard limits
function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }
function safeBrightness(v)  { return clamp(v, 0.6, 1.1); }
function safeLandLift(v)    { return clamp(v, 0.15, 0.40); }
function safeLandGamma(v)   { return clamp(v, 0.50, 0.85); }
function safeSaturation(v)  { return clamp(v, 1.5, 2.5); }

// Camera positions per target
const TARGET_CAMERAS = {
  global: { cam: [0, 300, 80],  tgt: [0, 0, 0]   },
  polar:  { cam: [0, 80, 155],  tgt: [0, 0, 120]  },
  tropic: { cam: [20, 50, 10],  tgt: [20, 0, 10]  },
  close:  { cam: [12, 16, -62], tgt: [12, 0, -62] },
};

const CAM = TARGET_CAMERAS[TARGET] || TARGET_CAMERAS.global;

// ── Apply uniforms via browser console ───────────────────────────────────────
async function applyUniforms(page, vals) {
  await page.evaluate(vals => {
    // Find splatCloud by traversing scene (it's a THREE.Points with uBrightness uniform)
    let cloud = null;
    window.scene.traverse(obj => {
      if (!cloud && obj.isPoints && obj.material?.uniforms?.uBrightness) cloud = obj;
    });
    if (!cloud) return;
    cloud.material.uniforms.uBrightness.value = vals.uBrightness;
    cloud.material.uniforms.uLandLift.value   = vals.uLandLift;
    cloud.material.uniforms.uLandGamma.value  = vals.uLandGamma;
    cloud.material.uniforms.uSaturation.value = vals.uSaturation;
  }, vals);
  await new Promise(r => setTimeout(r, 400)); // let shaders recompile
}

// ── Ask Claude to score the screenshot ───────────────────────────────────────
async function scoreScreenshot(buf, vals) {
  const b64 = buf.toString('base64');
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
        {
          type: 'text',
          text: `This is a screenshot of a 3D tactical globe map terrain renderer.
Score its visual quality from 1–10 on these criteria:
1. Land colour naturalness (are vegetation/desert/snow colours realistic?)
2. Shadow depth (are shadowed areas too dark or too bright?)
3. Colour vibrancy (vivid but not neon?)
4. Overall contrast and readability

Respond with ONLY a JSON object like: {"score": 7.5, "notes": "brief reason"}`,
        },
      ],
    }],
  });

  try {
    const text = msg.content[0].text.trim();
    const json = JSON.parse(text.replace(/```json|```/g, '').trim());
    return { score: json.score || 5, notes: json.notes || '' };
  } catch {
    return { score: 5, notes: 'parse error' };
  }
}

async function setCamera(page, cam, tgt) {
  await page.evaluate(([cx,cy,cz],[tx,ty,tz]) => {
    window.controls.object.position.set(cx,cy,cz);
    window.controls.target.set(tx,ty,tz);
    window.controls.update();
  }, cam, tgt);
  await new Promise(r => setTimeout(r, 1000));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY not set.');
    process.exit(1);
  }
  ensureDir(REPORTS);

  // Build all combinations
  const combos = [];
  for (const b of GRID.uBrightness.map(safeBrightness)) {
    for (const l of GRID.uLandLift.map(safeLandLift)) {
      for (const g of GRID.uLandGamma.map(safeLandGamma)) {
        for (const s of GRID.uSaturation.map(safeSaturation)) {
          combos.push({ uBrightness: b, uLandLift: l, uLandGamma: g, uSaturation: s });
        }
      }
    }
  }

  log(`Starting shader sweep: ${combos.length} combinations, target: ${TARGET}`);
  log(QUICK_MODE ? '(quick mode — coarser grid)' : '(full mode)');

  // ── Progress file: resume from crash ────────────────────────────────────────
  const PROGRESS_FILE = path.join(REPORTS, 'shader-tune-progress.json');
  let results = [];
  let startIndex = 0;

  if (fs.existsSync(PROGRESS_FILE) && !process.argv.includes('--fresh')) {
    results = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    startIndex = results.length;
    log(`Resuming from combination ${startIndex + 1}/${combos.length} (delete reports/shader-tune-progress.json to restart)`);
  }

  // How many combos to run per browser session before relaunching
  // Keeps memory use bounded — browser relaunches cleanly between batches
  const BATCH_SIZE = 15;

  let best = results.reduce(
    (b, r) => r.score > b.score ? { score: r.score, vals: r.vals, notes: r.notes, buf: null } : b,
    { score: -1, vals: null, buf: null, notes: '' }
  );

  for (let i = startIndex; i < combos.length; i += BATCH_SIZE) {
    const batch = combos.slice(i, i + BATCH_SIZE);

    log(`Launching browser for batch ${Math.floor(i / BATCH_SIZE) + 1} (combos ${i + 1}–${Math.min(i + BATCH_SIZE, combos.length)})…`);

    let browser, page;
    try {
      ({ browser, page } = await launchBrowser(puppeteer, { width: 1024, height: 576 }));
      await page.goto(MAP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await waitForSceneAndDismissModals(page);
      await setCamera(page, CAM.cam, CAM.tgt);
    } catch (err) {
      log(`Browser launch failed: ${err.message} — skipping batch`);
      try { await browser?.close(); } catch {}
      continue;
    }

    for (let j = 0; j < batch.length; j++) {
      const globalIdx = i + j;
      const vals = batch[j];
      process.stdout.write(`  [${globalIdx + 1}/${combos.length}] B=${vals.uBrightness} L=${vals.uLandLift} G=${vals.uLandGamma} S=${vals.uSaturation} → `);

      try {
        await applyUniforms(page, vals);
        await new Promise(r => setTimeout(r, 500)); // let renderer settle
        const buf = await page.screenshot({ type: 'png' });
        const { score, notes } = await scoreScreenshot(buf, vals);

        process.stdout.write(`score ${score.toFixed(1)}  ${notes}\n`);
        results.push({ vals, score, notes });

        // Save progress after every step so a crash loses nothing
        fs.writeFileSync(PROGRESS_FILE, JSON.stringify(results, null, 2));

        if (score > best.score) {
          best = { score, vals, buf, notes };
          fs.writeFileSync(path.join(REPORTS, 'shader-tune-best.png'), buf);
        }
      } catch (err) {
        process.stdout.write(`CRASHED (${err.message.slice(0, 60)})\n`);
        log('Page crashed mid-batch — saving progress and relaunching…');
        break; // exit inner loop, outer loop will relaunch browser
      }
    }

    try { await browser.close(); } catch {}
    log('Batch done. Relaunching browser for next batch…\n');
  }

  // ── Final results ─────────────────────────────────────────────────────────────
  // Clean up progress file now that we're done
  if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);

  const reportPath = path.join(REPORTS, 'shader-tune-results.json');
  fs.writeFileSync(reportPath, JSON.stringify(
    [...results].sort((a, b) => b.score - a.score),
    null, 2
  ));
  ok(`Results saved → reports/shader-tune-results.json`);
  ok(`Best screenshot saved → reports/shader-tune-best.png`);

  // ── Print recommended config block ───────────────────────────────────────────
  const sorted = [...results].sort((a, b) => b.score - a.score);
  const top = sorted[0];
  if (!top) { log('No results collected.'); return; }

  const bv = top.vals;
  console.log('\n════════════════════════════════════════════════════');
  console.log('  Recommended config.js values (paste into SPLAT_*):');
  console.log('════════════════════════════════════════════════════');
  console.log(`  Score: ${top.score.toFixed(1)}/10  —  ${top.notes}`);
  console.log('');
  console.log(`  export const SPLAT_BRIGHTNESS  = ${bv.uBrightness};   // was ${DEFAULTS.uBrightness}`);
  console.log(`  export const SPLAT_LAND_LIFT   = ${bv.uLandLift};   // was ${DEFAULTS.uLandLift}`);
  console.log(`  export const SPLAT_LAND_GAMMA  = ${bv.uLandGamma};   // was ${DEFAULTS.uLandGamma}`);
  console.log(`  export const SPLAT_SATURATION  = ${bv.uSaturation};  // was ${DEFAULTS.uSaturation}`);
  console.log('════════════════════════════════════════════════════');
  console.log('\nTop 5 combinations:');
  sorted.slice(0, 5).forEach((r, i) => {
    const v = r.vals;
    console.log(`  ${i + 1}. score ${r.score.toFixed(1)}  B=${v.uBrightness} L=${v.uLandLift} G=${v.uLandGamma} S=${v.uSaturation}  — ${r.notes}`);
  });
}

main().catch(err => { console.error('[TUNER] Fatal:', err); process.exit(1); });
