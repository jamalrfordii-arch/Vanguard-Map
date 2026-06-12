#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  VANGUARD  —  Map Vision Agent                                   ║
 * ║                                                                  ║
 * ║  Screenshots the live map from multiple zoom levels and camera   ║
 * ║  angles, then asks Claude to analyse each view through the lens  ║
 * ║  of "what would make this more immersive and realistic?".        ║
 * ║                                                                  ║
 * ║  This agent always thinks forward — every run picks a fresh      ║
 * ║  visual dimension to explore, oriented toward the ultimate goal  ║
 * ║  of a holographic, living, ecosystem-level intelligence map.     ║
 * ║                                                                  ║
 * ║  Output:  proposed/vision/VISION_REPORT_YYYY-MM-DD.md           ║
 * ║           proposed/vision/screenshots/  (annotated PNGs)        ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Usage:
 *   node map-vision-agent.js                    ← full analysis
 *   node map-vision-agent.js --view global      ← single camera view
 *   node map-vision-agent.js --focus atmosphere ← focus one dimension
 *   node map-vision-agent.js --url http://localhost:5173  ← custom port
 *
 * The map must be running locally before this agent is invoked.
 * Default URL: http://localhost:8080
 */

import Anthropic          from '@anthropic-ai/sdk';
import puppeteer          from 'puppeteer';
import fs                 from 'fs';
import path               from 'path';
import { fileURLToPath }  from 'url';
import { generateComplete, waitForSceneAndDismissModals, setCamera, launchBrowser } from './agent-utils.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const PROJECT    = path.join(__dirname, '..');
const PROPOSED   = path.join(PROJECT, 'proposed', 'vision');
const DATE_STR   = new Date().toISOString().slice(0, 10);

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const VIEW_FLAG  = (() => { const i = process.argv.indexOf('--view');  return i !== -1 ? process.argv[i+1] : null; })();
const FOCUS_FLAG = (() => { const i = process.argv.indexOf('--focus'); return i !== -1 ? process.argv[i+1] : null; })();
const URL_FLAG   = (() => { const i = process.argv.indexOf('--url');   return i !== -1 ? process.argv[i+1] : null; })();
const MAP_URL    = URL_FLAG || 'http://localhost:3000';

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function log(msg)     { console.log(`\x1b[34m[VISION]\x1b[0m ${msg}`); }
function phase(msg)   { console.log(`\n\x1b[1m\x1b[34m━━ ${msg} ━━\x1b[0m`); }
function ok(msg)      { console.log(`\x1b[32m✓  ${msg}\x1b[0m`); }

// ── Camera views to screenshot ────────────────────────────────────────────────
// Each view captures a meaningfully different visual context.

const CAMERA_VIEWS = {
  global_overview: {
    label:       'Global Overview',
    camera:      [0, 220, 0],
    target:      [0, 0, 0],
    settleMs:    3000,
    description: 'Top-down tactical overview — the analyst\'s default starting view',
  },
  north_atlantic: {
    label:       'North Atlantic (mid-zoom)',
    camera:      [-30, 80, -30],
    target:      [-20, 0, -20],
    settleMs:    2500,
    description: 'Mid-altitude ocean view — tests water, atmosphere, ship density rendering',
  },
  strait_of_hormuz: {
    label:       'Strait of Hormuz (close)',
    camera:      [56, 25, 26],
    target:      [56, 0, 27],
    settleMs:    3000,
    description: 'Chokepoint close-zoom — tests LOD transitions, vessel detail, building layer',
  },
  polar_region: {
    label:       'Arctic / Polar',
    camera:      [0, 120, -130],
    target:      [0, 0, -130],
    settleMs:    2000,
    description: 'High-latitude view — tests polar terrain rendering and ice representation',
  },
  dawn_angle: {
    label:       'Oblique Dawn Angle',
    camera:      [-60, 45, 20],
    target:      [0, 0, 0],
    settleMs:    2000,
    description: 'Low-angle view emphasising atmosphere, god rays, and horizon haze',
  },
};

// ── Visual analysis dimensions ────────────────────────────────────────────────
// Each run rotates through these to always explore fresh territory.

const ANALYSIS_DIMENSIONS = [
  'atmosphere_and_lighting',
  'water_and_ocean',
  'terrain_and_landmass',
  'vessel_and_asset_detail',
  'data_density_and_readability',
  'immersion_and_cinematic_quality',
  'tactical_clarity',
  'holographic_future_potential',
];

function pickDimension() {
  if (FOCUS_FLAG) return FOCUS_FLAG;
  // Rotate through dimensions based on existing reports so we never repeat
  ensureDir(PROPOSED);
  const existing = fs.readdirSync(PROPOSED).filter(f => f.startsWith('VISION_REPORT_') && f.endsWith('.md'));
  const idx = existing.length % ANALYSIS_DIMENSIONS.length;
  return ANALYSIS_DIMENSIONS[idx];
}

// ── Load memory: what has the vision agent already noticed? ───────────────────

function loadVisionMemory() {
  const reports = fs.existsSync(PROPOSED)
    ? fs.readdirSync(PROPOSED)
        .filter(f => f.startsWith('VISION_REPORT_') && f.endsWith('.md'))
        .slice(-3)
    : [];

  const previousFindings = [];
  for (const r of reports) {
    const content = fs.readFileSync(path.join(PROPOSED, r), 'utf8');
    // Extract proposal titles from previous reports
    const titles = content.match(/^### Proposal \d+:.+/gm) || [];
    previousFindings.push(...titles.map(t => t.replace(/^### Proposal \d+:\s*/, '').trim()));
  }

  return previousFindings;
}

// ── Screenshot a single view ──────────────────────────────────────────────────

async function screenshotView(page, viewKey, viewDef, outputDir) {
  log(`  Capturing: ${viewDef.label}…`);

  await setCamera(page, viewDef.camera, viewDef.target, viewDef.settleMs);

  const screenshotPath = path.join(outputDir, `${viewKey}_${DATE_STR}.png`);
  await page.screenshot({ path: screenshotPath, type: 'png' });

  ok(`  Screenshot saved: screenshots/${viewKey}_${DATE_STR}.png`);
  return screenshotPath;
}

// ── Analyse a screenshot with Claude vision ───────────────────────────────────

async function analyseScreenshot(screenshotPath, viewDef, dimension, previousFindings) {
  const imageData = fs.readFileSync(screenshotPath);
  const base64    = imageData.toString('base64');

  const avoidClause = previousFindings.length
    ? `\n\nDo NOT repeat these observations — they have already been proposed in previous reports:\n${previousFindings.map(f => `- ${f}`).join('\n')}`
    : '';

  const prompt = `You are a senior visual designer and 3D graphics engineer reviewing a screenshot of Vanguard1, a real-time 3D tactical intelligence map built in Three.js.

This screenshot was taken from: **${viewDef.label}**
Context: ${viewDef.description}

Your analysis focus this run: **${dimension.replace(/_/g, ' ').toUpperCase()}**

The ultimate vision for this map is a holographic, living ecosystem — a tactical intelligence layer that feels as alive as the planet it represents. Think: the kind of map you'd see in a sci-fi command centre, where every data layer breathes and every visual element communicates meaning.

Looking at this screenshot through the lens of "${dimension.replace(/_/g, ' ')}", identify:

1. **What's working well** — visual elements that are already strong (be specific about geometry, shading, or data representation)
2. **The most impactful gap** — the single biggest visual weakness you see for this focus dimension
3. **Three concrete proposals** — specific, implementable improvements ordered by visual impact. For each:
   - What it would look like (be evocative and specific)
   - What Three.js/GLSL technique enables it
   - Estimated complexity (LOW/MEDIUM/HIGH)
   - Why it moves toward the holographic ecosystem goal
${avoidClause}

Be honest and direct. If something looks bad, say so. If something surprises you (good or bad), call it out.`;

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
        { type: 'text',  text: prompt },
      ],
    }],
  });

  return response.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

// ── Synthesise all view analyses into a final report ──────────────────────────

async function synthesiseReport(viewAnalyses, dimension, previousFindings) {
  log('Synthesising cross-view insights…');

  const combinedAnalyses = viewAnalyses
    .map(({ viewDef, analysis }) => `## View: ${viewDef.label}\n\n${analysis}`)
    .join('\n\n---\n\n');

  const avoidClause = previousFindings.length
    ? `\n\nThese have already been proposed — do NOT include them:\n${previousFindings.map(f => `- ${f}`).join('\n')}`
    : '';

  return generateComplete(client, {
    model: 'claude-opus-4-6',
    max_tokens: 8000,
    system: `You are the creative director for Vanguard1, synthesising visual analysis from multiple camera angles into a single actionable improvement report.
The goal: a holographic, living tactical intelligence map. Think boldly. Every proposal should move the needle toward that vision.`,
    messages: [{
      role: 'user',
      content: `I have visual analyses of the Vanguard1 map from ${viewAnalyses.length} different camera views, all focused on: **${dimension.replace(/_/g, ' ')}**.

Here are the per-view analyses:

${combinedAnalyses}

---

Synthesise these into a unified vision report. Structure it as:

## Executive Summary
(2-3 sentences: what is the most important thing you see across all views?)

## Cross-View Patterns
(What weaknesses or opportunities appear consistently across multiple views?)

## Priority Proposals

For each of the top 5 proposals (ordered by visual impact):

### Proposal N: [Short Title]
**Impact:** What the map will look and feel like after this change
**Technique:** The specific Three.js/GLSL/WebGL approach
**Affected Files:** Which existing files to modify (or name of new manager to create)
**Complexity:** LOW / MEDIUM / HIGH
**Holographic Vision:** How this moves toward the living ecosystem goal

## The Next Iteration
(One paragraph: if you could only implement one thing from this report, what would it be and why?)
${avoidClause}`,
    }],
  });
}

// ── Write the final report ────────────────────────────────────────────────────

function writeReport(synthesis, viewAnalyses, dimension, screenshotDir) {
  ensureDir(PROPOSED);

  const lines = [
    `# Vanguard1 Vision Report — ${DATE_STR}`,
    ``,
    `**Analysis Focus:** ${dimension.replace(/_/g, ' ').toUpperCase()}`,
    `**Views Analysed:** ${viewAnalyses.map(v => v.viewDef.label).join(', ')}`,
    `**Screenshots:** \`proposed/vision/screenshots/\``,
    ``,
    `> Generated by the Map Vision Agent. Proposals are for review — nothing is applied automatically.`,
    ``,
    `---`,
    ``,
    synthesis,
    ``,
    `---`,
    ``,
    `## Per-View Raw Analysis`,
    ``,
    `<details>`,
    `<summary>Expand to see per-view analysis details</summary>`,
    ``,
  ];

  for (const { viewDef, analysis } of viewAnalyses) {
    lines.push(`### ${viewDef.label}`);
    lines.push(`*${viewDef.description}*`);
    lines.push(`**Screenshot:** \`screenshots/${viewDef.label.toLowerCase().replace(/\s+/g, '_')}_${DATE_STR}.png\``);
    lines.push(``);
    lines.push(analysis);
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
  }

  lines.push(`</details>`);
  lines.push(``);
  lines.push(`_Run \`node agents/map-vision-agent.js\` again for the next visual dimension._`);

  const reportPath = path.join(PROPOSED, `VISION_REPORT_${DATE_STR}.md`);
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  ok(`Report written → proposed/vision/VISION_REPORT_${DATE_STR}.md`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY not set.');
    process.exit(1);
  }

  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║   VANGUARD — Map Vision Agent              ║');
  console.log(`║   ${DATE_STR}                            ║`);
  console.log('╚════════════════════════════════════════════╝\n');

  // Determine analysis dimension for this run
  const dimension = pickDimension();
  log(`Analysis dimension this run: ${dimension.replace(/_/g, ' ')}`);

  // Load memory to avoid repeating previous findings
  phase('LOADING VISION MEMORY');
  const previousFindings = loadVisionMemory();
  log(`${previousFindings.length} previous proposals to avoid repeating`);
  ok('Memory loaded');

  // Screenshot directory
  const screenshotDir = path.join(PROPOSED, 'screenshots');
  ensureDir(screenshotDir);

  // Determine which views to capture
  const viewsToCapture = VIEW_FLAG
    ? { [VIEW_FLAG]: CAMERA_VIEWS[VIEW_FLAG] }
    : CAMERA_VIEWS;

  if (VIEW_FLAG && !CAMERA_VIEWS[VIEW_FLAG]) {
    console.error(`Unknown view "${VIEW_FLAG}". Available: ${Object.keys(CAMERA_VIEWS).join(', ')}`);
    process.exit(1);
  }

  // Launch browser and navigate to the live map
  phase('LAUNCHING BROWSER');
  log(`Connecting to map at ${MAP_URL}…`);

  let browser, page;
  try {
    ({ browser, page } = await launchBrowser(puppeteer));
    await page.goto(MAP_URL, { waitUntil: 'load', timeout: 60_000 });
    await waitForSceneAndDismissModals(page);
    ok('Map loaded and ready');
  } catch (err) {
    console.error(`\n[VISION] Could not connect to map at ${MAP_URL}.`);
    console.error('Make sure the map is running before invoking this agent.');
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  // Screenshot each view
  phase('CAPTURING VIEWS');
  const viewAnalyses = [];

  for (const [viewKey, viewDef] of Object.entries(viewsToCapture)) {
    const screenshotPath = await screenshotView(page, viewKey, viewDef, screenshotDir);

    // Analyse the screenshot
    log(`  Analysing: ${viewDef.label}…`);
    const analysis = await analyseScreenshot(screenshotPath, viewDef, dimension, previousFindings);
    viewAnalyses.push({ viewKey, viewDef, analysis, screenshotPath });
    ok(`  Analysis complete for: ${viewDef.label}`);
  }

  await browser.close();
  ok('Browser closed');

  // Synthesise all analyses into a unified report
  phase('SYNTHESISING REPORT');
  const synthesis = await synthesiseReport(viewAnalyses, dimension, previousFindings);

  // Write report
  phase('WRITING REPORT');
  writeReport(synthesis, viewAnalyses, dimension, screenshotDir);

  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║   DONE                                     ║');
  console.log(`║   proposed/vision/VISION_REPORT_${DATE_STR}.md ║`);
  console.log('╚════════════════════════════════════════════╝\n');

  log(`Next run will analyse: ${ANALYSIS_DIMENSIONS[(ANALYSIS_DIMENSIONS.indexOf(dimension) + 1) % ANALYSIS_DIMENSIONS.length].replace(/_/g, ' ')}`);
}

main().catch(err => {
  console.error('[VISION] Fatal:', err.message);
  ensureDir(PROPOSED);
  fs.writeFileSync(
    path.join(PROPOSED, `ERROR_${DATE_STR}.md`),
    `# Vision Agent Error — ${DATE_STR}\n\n${err.message}\n\n${err.stack}`,
    'utf8'
  );
  process.exit(1);
});
