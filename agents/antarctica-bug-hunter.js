#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║  VANGUARD  —  Antarctica Bug Hunter                     ║
 * ║                                                          ║
 * ║  Isolates the grey multi-faced shape on the south edge   ║
 * ║  near Antarctica by doing a binary search through the    ║
 * ║  Three.js scene graph — toggling visibility, taking a    ║
 * ║  screenshot, and checking if the shape disappeared.      ║
 * ║                                                          ║
 * ║  When it finds the culprit it prints the object's name,  ║
 * ║  type, geometry stats, and a suggested fix.              ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * Usage:
 *   node antarctica-bug-hunter.js
 *   node antarctica-bug-hunter.js --save-screenshots   (saves every step)
 */

import puppeteer  from 'puppeteer';
import Anthropic  from '@anthropic-ai/sdk';
import { waitForSceneAndDismissModals, launchBrowser } from './agent-utils.js';
import fs         from 'fs';
import path       from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const REPORTS    = path.join(__dirname, 'reports');
const MAP_URL    = 'http://localhost:3000';
const SAVE_STEPS = process.argv.includes('--save-screenshots');

// Camera angle that makes the Antarctica grey shape clearly visible.
// Global overview tilted to show the southern map edge at the bottom —
// matches the default startup camera in sceneSetup.js.
const ANTACTICA_CAM    = [0,  250, 400];
const ANTARCTICA_TGT   = [0,  0,   0];

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function log(msg)     { console.log(`[BUG-HUNT] ${msg}`); }
function found(msg)   { console.log(`\x1b[33m⚑  ${msg}\x1b[0m`); }
function ok(msg)      { console.log(`\x1b[32m✓  ${msg}\x1b[0m`); }
function step(msg)    { console.log(`\x1b[36m   ${msg}\x1b[0m`); }

/** Navigate and wait for scene to load, dismissing any modals. */
async function boot(page) {
  await page.goto(MAP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForSceneAndDismissModals(page);
}

/** Move camera to Antarctica view. */
async function viewAntarctica(page) {
  await page.evaluate(([cx, cy, cz], [tx, ty, tz]) => {
    window.controls.object.position.set(cx, cy, cz);
    window.controls.target.set(tx, ty, tz);
    window.controls.update();
  }, ANTACTICA_CAM, ANTARCTICA_TGT);
  await new Promise(r => setTimeout(r, 1500));
}

/** Ask Claude whether the grey shape is visible in a screenshot. */
async function greyShapeVisible(screenshotBuf) {
  const b64 = screenshotBuf.toString('base64');
  const msg = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 100,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: b64 },
        },
        {
          type: 'text',
          text: 'This is a screenshot of a 3D tactical globe map shown at a tilted perspective. The bottom edge of the map shows the southern hemisphere and Antarctica region. Is there an anomalous flat grey or light-grey rectangular/polygonal shape visible along the bottom-south edge of the 3D map terrain (it may look like a grey slab, grey wall, or grey geometric patch that does not match the terrain coloring)? Answer only YES or NO.',
        },
      ],
    }],
  });
  const answer = msg.content[0].text.trim().toUpperCase();
  return answer.startsWith('YES');
}

/** Get a flat list of all scene object UUIDs and names for binary search. */
async function getSceneObjects(page) {
  return page.evaluate(() => {
    const objs = [];
    window.scene.traverse(obj => {
      // Skip the scene root itself
      if (obj === window.scene) return;
      objs.push({
        uuid: obj.uuid,
        name: obj.name || '(unnamed)',
        type: obj.type,
        visible: obj.visible,
        parentUuid: obj.parent?.uuid || null,
        isGroup: obj.isGroup || obj.type === 'Group',
        vertexCount: obj.geometry?.attributes?.position?.count || 0,
      });
    });
    return objs;
  });
}

/** Toggle visibility of a list of objects by UUID. Returns their previous states. */
async function setVisible(page, uuids, visible) {
  return page.evaluate((uuids, visible) => {
    const prev = {};
    window.scene.traverse(obj => {
      if (uuids.includes(obj.uuid)) {
        prev[obj.uuid] = obj.visible;
        obj.visible = visible;
      }
    });
    return prev;
  }, uuids, visible);
}

/** Restore visibility from a { uuid: bool } map. */
async function restoreVisible(page, prevMap) {
  await page.evaluate(prevMap => {
    window.scene.traverse(obj => {
      if (prevMap[obj.uuid] !== undefined) {
        obj.visible = prevMap[obj.uuid];
      }
    });
  }, prevMap);
}

/** Capture page screenshot as Buffer, with retry on transient failure. */
async function snap(page, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      // Small pause before each screenshot — lets WebGL finish rendering
      await new Promise(r => setTimeout(r, 600));
      return await page.screenshot({ type: 'png' });
    } catch (err) {
      if (i === retries - 1) throw err;
      log(`Screenshot failed (attempt ${i + 1}), retrying…`);
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

// ── Binary search through the scene graph ────────────────────────────────────
async function binarySearch(page, candidates, depth = 0) {
  const indent = '  '.repeat(depth);
  step(`${indent}Testing ${candidates.length} objects…`);

  if (candidates.length === 0) return null;

  if (candidates.length === 1) {
    // Confirm this single object is the culprit
    const prev = await setVisible(page, [candidates[0].uuid], false);
    await new Promise(r => setTimeout(r, 1200));
    const buf = await snap(page);
    const stillVisible = await greyShapeVisible(buf);
    await restoreVisible(page, prev);

    if (!stillVisible) {
      found(`${indent}FOUND: "${candidates[0].name}" (${candidates[0].type})`);
      return candidates[0];
    }
    return null;
  }

  // Split in half
  const mid   = Math.floor(candidates.length / 2);
  const left  = candidates.slice(0, mid);
  const right = candidates.slice(mid);

  // Test left half
  const leftUuids = left.map(o => o.uuid);
  const prev      = await setVisible(page, leftUuids, false);
  await new Promise(r => setTimeout(r, 1200));  // let WebGL re-render
  const buf   = await snap(page);

  if (SAVE_STEPS) {
    ensureDir(REPORTS);
    fs.writeFileSync(path.join(REPORTS, `hunt_depth${depth}_left.png`), buf);
  }

  const leftHides = !(await greyShapeVisible(buf));
  await restoreVisible(page, prev);

  if (leftHides) {
    step(`${indent}→ shape hidden by left half, recursing left`);
    return binarySearch(page, left, depth + 1);
  }

  // Test right half
  const rightUuids = right.map(o => o.uuid);
  const prev2      = await setVisible(page, rightUuids, false);
  await new Promise(r => setTimeout(r, 1200));
  const buf2    = await snap(page);
  const rightHides = !(await greyShapeVisible(buf2));
  await restoreVisible(page, prev2);

  if (rightHides) {
    step(`${indent}→ shape hidden by right half, recursing right`);
    return binarySearch(page, right, depth + 1);
  }

  step(`${indent}→ shape requires multiple objects — narrowing…`);
  // Both halves needed — try left then right individually
  const fromLeft  = await binarySearch(page, left, depth + 1);
  const fromRight = await binarySearch(page, right, depth + 1);
  return fromLeft || fromRight;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[BUG-HUNT] Error: ANTHROPIC_API_KEY environment variable not set.');
    console.error('  Set it with:  set ANTHROPIC_API_KEY=your_key_here  (Windows)');
    process.exit(1);
  }

  ensureDir(REPORTS);

  const { browser, page } = await launchBrowser(puppeteer);

  log('Loading Vanguard…');
  await boot(page);

  log('Positioning camera over Antarctica…');
  await viewAntarctica(page);

  const baselineShot = await snap(page);
  fs.writeFileSync(path.join(REPORTS, 'hunt_baseline.png'), baselineShot);
  log('Baseline screenshot saved → reports/hunt_baseline.png');

  log('Checking if grey shape is visible in baseline…');
  const shapePresent = await greyShapeVisible(baselineShot);

  if (!shapePresent) {
    ok('Claude does not detect a grey anomalous shape in the current view.');
    ok('Either the bug is fixed, or the camera angle needs adjusting.');
    ok('Try running with a different camera angle if you can still see the shape manually.');
    await browser.close();
    return;
  }

  log('Grey shape confirmed. Fetching scene graph…');
  const allObjects = await getSceneObjects(page);
  log(`Scene contains ${allObjects.length} objects. Starting binary search…`);
  console.log('');

  const culprit = await binarySearch(page, allObjects);

  console.log('\n════════════════════════════════════════');
  if (culprit) {
    found('BUG FOUND');
    console.log(`  Name:         ${culprit.name}`);
    console.log(`  Type:         ${culprit.type}`);
    console.log(`  UUID:         ${culprit.uuid}`);
    console.log(`  Vertex count: ${culprit.vertexCount}`);
    console.log(`  Parent UUID:  ${culprit.parentUuid}`);
    console.log('');
    console.log('  Suggested fixes:');
    if (culprit.type === 'Mesh' || culprit.type === 'Points') {
      console.log('  1. Search for this UUID/name in your .js files to find where it\'s created.');
      console.log('  2. If it\'s an ocean floor mesh boundary triangle, clip geometry to lat < 80°S.');
      console.log('  3. If it\'s an aquarium wall, confirm it uses Object3D.visible=false not opacity.');
      console.log('  4. If it\'s a fog/cloud pass artefact, add a south-boundary clip in the shader.');
    } else if (culprit.type === 'Group') {
      console.log('  The culprit is a Group — run the hunt again on its children for the exact mesh.');
    }
    // Save final culprit screenshot
    const prev = await setVisible(page, [culprit.uuid], false);
    await new Promise(r => setTimeout(r, 800));
    const fixedShot = await snap(page);
    fs.writeFileSync(path.join(REPORTS, 'hunt_culprit_hidden.png'), fixedShot);
    await restoreVisible(page, prev);
    log('Screenshot with culprit hidden → reports/hunt_culprit_hidden.png');
  } else {
    console.log('  Could not isolate a single object via binary search.');
    console.log('  The shape may be produced by a shader/post-process pass rather than geometry.');
    console.log('  Next step: disable post-process passes one-by-one (fog, cloud, bloom).');
  }
  console.log('════════════════════════════════════════');

  await browser.close();
}

main().catch(err => { console.error('[BUG-HUNT] Fatal:', err); process.exit(1); });
