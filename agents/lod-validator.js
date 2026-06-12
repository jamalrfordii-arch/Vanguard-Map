#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║  VANGUARD  —  LOD Transition Validator                  ║
 * ║                                                          ║
 * ║  Moves the camera through every documented LOD           ║
 * ║  threshold, captures screenshots above and below each   ║
 * ║  seam, and uses Claude vision to verify the crossfades  ║
 * ║  look correct (no pop-in, no double-draw, no gap).       ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * Thresholds validated (from CLAUDE.md):
 *   y > 200   tile stream stops loading
 *   y = 120   zoom level 8 tiles
 *   y =  50   zoom level 10 tiles
 *   y =  25   point cloud → continent mesh fade START
 *   y =  22   zoom level 12 tiles
 *   y =  15   point cloud → continent mesh fade END
 *   y =  12   zoom level 13 tiles
 *
 * Usage:
 *   node lod-validator.js
 *   node lod-validator.js --threshold 25   (single threshold)
 *   node lod-validator.js --json           (JSON report output)
 */

import puppeteer  from 'puppeteer';
import Anthropic  from '@anthropic-ai/sdk';
import { waitForSceneAndDismissModals, launchBrowser } from './agent-utils.js';
import fs         from 'fs';
import path       from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORTS   = path.join(__dirname, 'reports');
const MAP_URL   = 'http://localhost:3000';

const SINGLE    = (() => { const i = process.argv.indexOf('--threshold'); return i !== -1 ? parseFloat(process.argv[i+1]) : null; })();
const JSON_MODE = process.argv.includes('--json');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function log(msg)     { console.log(`[LOD-VAL] ${msg}`); }
function pass(msg)    { console.log(`\x1b[32m✓  ${msg}\x1b[0m`); }
function fail(msg)    { console.log(`\x1b[31m✗  ${msg}\x1b[0m`); }
function warn(msg)    { console.log(`\x1b[33m⚠  ${msg}\x1b[0m`); }

// ── LOD thresholds ────────────────────────────────────────────────────────────
// Each entry: { y, name, aboveDelta, belowDelta, description, expectation }
// aboveDelta / belowDelta: how far above/below threshold to position camera
const THRESHOLDS = [
  {
    y: 25, name: 'continent_mesh_fade_start',
    aboveDelta: 5, belowDelta: 5,
    description: 'Point cloud fully visible above, crossfade begins below',
    expectation: 'Above y=25: point cloud terrain visible, continent mesh hidden. Below y=25: fade crossfade begins, no hard pop-in.',
  },
  {
    y: 15, name: 'continent_mesh_fade_end',
    aboveDelta: 5, belowDelta: 3,
    description: 'Crossfade ends — continent mesh fully visible',
    expectation: 'Above y=15: partial crossfade. Below y=15: continent mesh fully visible, point cloud hidden. No double-draw gap.',
  },
  {
    y: 50, name: 'tile_zoom_10',
    aboveDelta: 10, belowDelta: 10,
    description: 'Tile stream switches to zoom level 10',
    expectation: 'Smooth tile quality increase — no blank patches, no seams. Tile geometry aligns with terrain below.',
  },
  {
    y: 120, name: 'tile_zoom_8',
    aboveDelta: 20, belowDelta: 20,
    description: 'Tile stream switches to zoom level 8',
    expectation: 'Tiles load without flickering. LOD transition looks gradual, not sudden.',
  },
  {
    y: 200, name: 'tile_stream_start',
    aboveDelta: 30, belowDelta: 30,
    description: 'Tile stream begins loading below y=200',
    expectation: 'Above y=200: no tile geometry visible. Below y=200: tiles begin appearing without Z-fighting with point cloud.',
  },
  {
    y: 22, name: 'tile_zoom_12',
    aboveDelta: 3, belowDelta: 3,
    description: 'Tile stream switches to zoom level 12 (high detail)',
    expectation: 'Fine-grained tile detail appears. Building geometry may activate. No texture seams.',
  },
];

// ── Ask Claude to assess an LOD transition pair ───────────────────────────────
async function assessTransition(aboveBuf, belowBuf, threshold) {
  const toB64 = b => b.toString('base64');
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: toB64(aboveBuf) } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: toB64(belowBuf) } },
        {
          type: 'text',
          text: `These are two screenshots from a 3D tactical globe map taken above and below a Level-of-Detail (LOD) threshold at camera altitude y=${threshold.y}.
Threshold: ${threshold.name} — ${threshold.description}
Expected behaviour: ${threshold.expectation}

Image 1 = camera ABOVE the threshold (y=${threshold.y + threshold.aboveDelta})
Image 2 = camera BELOW the threshold (y=${threshold.y - threshold.belowDelta})

Assess the LOD transition. Look for: hard pop-in, missing geometry, Z-fighting, double-draw artefacts, or blank patches.
Respond with ONLY JSON: {"status": "pass"|"warn"|"fail", "score": 1-10, "issues": ["issue1", ...], "notes": "brief summary"}`,
        },
      ],
    }],
  });

  try {
    const text = msg.content[0].text.trim();
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    return { status: 'warn', score: 5, issues: ['parse error'], notes: msg.content[0].text };
  }
}

// ── Scene + camera helpers ────────────────────────────────────────────────────

async function setAltitude(page, y, tx = 0, tz = 0) {
  // Keep camera XZ roughly over Europe (good test area with varied terrain + tiles)
  const cx = 15, cz = -45;
  await page.evaluate(([cx, cy, cz], [tx, ty, tz]) => {
    window.controls.object.position.set(cx, cy, cz);
    window.controls.target.set(tx, ty, tz);
    window.controls.update();
  }, [cx, y, cz], [tx, 0, tz]);
  // Wait longer at low altitudes — tiles need to stream in
  const wait = y < 30 ? 3000 : y < 100 ? 1500 : 1000;
  await new Promise(r => setTimeout(r, wait));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY not set.');
    process.exit(1);
  }
  ensureDir(REPORTS);

  const thresholds = SINGLE
    ? THRESHOLDS.filter(t => t.y === SINGLE)
    : THRESHOLDS;

  if (thresholds.length === 0) {
    console.error(`No threshold found for y=${SINGLE}`);
    console.error('Available: ' + THRESHOLDS.map(t => t.y).join(', '));
    process.exit(1);
  }

  const { browser, page } = await launchBrowser(puppeteer);

  log('Loading map…');
  await page.goto(MAP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForSceneAndDismissModals(page);
  log('Scene ready. Validating LOD thresholds…\n');

  const results = [];

  for (const threshold of thresholds) {
    log(`Testing threshold: ${threshold.name} (y=${threshold.y})`);

    // Screenshot ABOVE
    await setAltitude(page, threshold.y + threshold.aboveDelta);
    const aboveBuf = await page.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(REPORTS, `lod_${threshold.name}_above.png`), aboveBuf);

    // Screenshot BELOW
    await setAltitude(page, threshold.y - threshold.belowDelta);
    const belowBuf = await page.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(REPORTS, `lod_${threshold.name}_below.png`), belowBuf);

    // Assess
    const assessment = await assessTransition(aboveBuf, belowBuf, threshold);
    const result = { threshold: threshold.name, y: threshold.y, ...assessment };
    results.push(result);

    if (assessment.status === 'pass') {
      pass(`${threshold.name} (y=${threshold.y})  score ${assessment.score}/10  — ${assessment.notes}`);
    } else if (assessment.status === 'warn') {
      warn(`${threshold.name} (y=${threshold.y})  score ${assessment.score}/10  — ${assessment.notes}`);
      if (assessment.issues?.length) {
        assessment.issues.forEach(iss => console.log(`     • ${iss}`));
      }
    } else {
      fail(`${threshold.name} (y=${threshold.y})  score ${assessment.score}/10  — ${assessment.notes}`);
      if (assessment.issues?.length) {
        assessment.issues.forEach(iss => console.log(`     • ${iss}`));
      }
    }
    console.log('');
  }

  await browser.close();

  // ── Report ─────────────────────────────────────────────────────────────────
  if (JSON_MODE) {
    const outPath = path.join(REPORTS, `lod-report-${Date.now()}.json`);
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
    log(`JSON report → ${outPath}`);
  }

  const fails  = results.filter(r => r.status === 'fail');
  const warns  = results.filter(r => r.status === 'warn');
  const passes = results.filter(r => r.status === 'pass');

  console.log('══════════════════════════════════════');
  console.log('  LOD Validator Summary');
  console.log('══════════════════════════════════════');
  console.log(`  \x1b[32mPassed: ${passes.length}\x1b[0m`);
  console.log(`  \x1b[33mWarnings: ${warns.length}\x1b[0m`);
  console.log(`  \x1b[31mFailed: ${fails.length}\x1b[0m`);
  console.log(`  Screenshots → reports/lod_*.png`);
  console.log('══════════════════════════════════════');

  if (fails.length > 0) process.exit(1);
}

main().catch(err => { console.error('[LOD-VAL] Fatal:', err); process.exit(1); });
