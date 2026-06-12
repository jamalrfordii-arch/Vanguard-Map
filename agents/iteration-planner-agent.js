#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  VANGUARD  —  Iteration Planner Agent                           ║
 * ║                                                                  ║
 * ║  Reads every proposal, research note, and vision report in       ║
 * ║  proposed/, cross-references the current codebase, and builds   ║
 * ║  a prioritised ROADMAP — always asking: "what single change      ║
 * ║  delivers the most toward the holographic ecosystem vision?"     ║
 * ║                                                                  ║
 * ║  Also generates a NEXT_BUILD.md with the top-priority proposal  ║
 * ║  broken into concrete implementation steps, ready to hand off   ║
 * ║  to a human developer or the Builder agent.                     ║
 * ║                                                                  ║
 * ║  Output:  proposed/ROADMAP.md          ← always overwritten     ║
 * ║           proposed/NEXT_BUILD.md       ← always overwritten     ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Usage:
 *   node iteration-planner-agent.js          ← full planning pass
 *   node iteration-planner-agent.js --quick  ← skip deep file reads
 */

import Anthropic          from '@anthropic-ai/sdk';
import fs                 from 'fs';
import path               from 'path';
import { fileURLToPath }  from 'url';
import { generateComplete } from './agent-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT   = path.join(__dirname, '..');
const PROPOSED  = path.join(PROJECT, 'proposed');
const DATE_STR  = new Date().toISOString().slice(0, 10);
const QUICK     = process.argv.includes('--quick');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function log(msg)     { console.log(`\x1b[33m[PLANNER]\x1b[0m ${msg}`); }
function phase(msg)   { console.log(`\n\x1b[1m\x1b[33m━━ ${msg} ━━\x1b[0m`); }
function ok(msg)      { console.log(`\x1b[32m✓  ${msg}\x1b[0m`); }
function readSafe(p, maxChars = 4000) {
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8').slice(0, maxChars);
}

// ── Phase 1: Ingest — read all proposals, research, and vision reports ────────

function ingestProposed() {
  phase('PHASE 1 — INGESTING PROPOSALS');
  const findings = [];

  function walkDir(dir, depth = 0) {
    if (depth > 4) return;
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith('.') || entry.startsWith('._')) continue;
      const fullPath = path.join(dir, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        walkDir(fullPath, depth + 1);
      } else if (entry.endsWith('.md') && !entry.startsWith('ERROR_')) {
        const content = fs.readFileSync(fullPath, 'utf8').slice(0, QUICK ? 1500 : 3000);
        const relPath  = path.relative(PROJECT, fullPath);
        findings.push({ relPath, content });
      }
    }
  }

  walkDir(PROPOSED);

  log(`Found ${findings.length} proposal/research/vision documents`);
  ok('Ingestion complete');
  return findings;
}

// ── Phase 2: Snapshot — read current codebase state ──────────────────────────

function snapshotCodebase() {
  phase('PHASE 2 — CODEBASE SNAPSHOT');

  const managers = fs.readdirSync(PROJECT)
    .filter(f => !f.startsWith('.') && !f.startsWith('._') && (f.endsWith('Manager.js') || f.endsWith('Builder.js')))
    .map(f => f.replace('.js', ''));

  const snapshot = {
    claudeMd:   readSafe(path.join(PROJECT, 'CLAUDE.md'), 5000),
    spec:       readSafe(path.join(PROJECT, 'vanguard-spec.md'), 3000),
    notes:      readSafe(path.join(PROJECT, 'NOTES.md'), 2000),
    devNotes:   readSafe(path.join(PROJECT, 'VANGUARD1_DEV_NOTES.md'), 2000),
    managers,
    configKeys: readSafe(path.join(PROJECT, 'config.js'), 1500),
  };

  log(`${managers.length} managers in codebase: ${managers.join(', ')}`);
  ok('Snapshot complete');
  return snapshot;
}

// ── Phase 3: Prioritise — Claude reads everything and builds the roadmap ──────

async function buildRoadmap(findings, snapshot) {
  phase('PHASE 3 — BUILDING ROADMAP');
  log(`Analysing ${findings.length} documents against the holographic vision…`);

  // Prepare a condensed digest of all findings
  const digest = findings
    .map(f => `### ${f.relPath}\n${f.content}`)
    .join('\n\n---\n\n');

  const systemPrompt = `You are the strategic director of Vanguard1, a Three.js real-time tactical intelligence map.

The current codebase has these managers: ${snapshot.managers.join(', ')}

Architecture rules from CLAUDE.md:
${snapshot.claudeMd.slice(0, 2000)}

The ultimate vision: a holographic, living ecosystem — a tactical intelligence layer that feels as alive as the planet it represents. Every layer should breathe with real data. The experience should be cinematic yet readable. Think: the bridge of a warship crossed with a scientific visualization of Earth. Holographic displays showing multi-domain intelligence with limitless opportunities for data expression.

Your job: read all the proposals and research, then decide what should be built NEXT to move most powerfully toward that vision.`;

  return generateComplete(client, {
    model: 'claude-opus-4-6',
    max_tokens: 12000,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `Here is a digest of all current proposals, research notes, and vision reports for Vanguard1:

${digest.slice(0, 30000)}

---

Build a strategic ROADMAP. Structure your response as:

# Vanguard1 Roadmap — ${DATE_STR}

## Vision North Star
(One paragraph: describe what Vanguard1 looks and feels like at its ultimate holographic endpoint)

## Current State Assessment
(What's strongest right now? What's the biggest gap between current state and the vision?)

## Priority Queue

For each of the top 10 items (ordered strictly by: impact toward the holographic vision × feasibility):

### #N — [Title]
**Type:** [new-manager | shader-patch | data-layer | performance | architecture]
**Source:** [which proposal/research file this comes from]
**Vision Impact:** Why this moves toward the holographic ecosystem goal
**One-line Description:** What it adds or changes
**Dependencies:** What must exist first (if any)
**Estimated Effort:** [SMALL=hours | MEDIUM=days | LARGE=weeks]
**Risk Level:** [LOW | MEDIUM | HIGH] (see CLAUDE.md for what HIGH means)

## Deferred (interesting but not now)
(List proposals that are worth keeping but don't yet have the right conditions)

## What NOT to Build
(Proposals that conflict with the architecture, duplicate existing work, or move away from the vision)`,
    }],
  });
}

// ── Phase 4: Next Build — detailed implementation plan for #1 priority ────────

async function buildNextImplementation(roadmapText, snapshot) {
  phase('PHASE 4 — NEXT BUILD PLAN');
  log('Generating detailed implementation plan for top priority…');

  // Extract the #1 item from the roadmap
  const topItemMatch = roadmapText.match(/### #1 —.+[\s\S]*?(?=### #2|## Deferred|$)/);
  const topItem = topItemMatch ? topItemMatch[0] : roadmapText.slice(0, 1000);

  return generateComplete(client, {
    model: 'claude-opus-4-6',
    max_tokens: 12000,
    system: `You are a senior Three.js engineer preparing a detailed implementation plan for Vanguard1.
Codebase architecture (CLAUDE.md excerpt):
${snapshot.claudeMd.slice(0, 2000)}

Config keys already defined:
${snapshot.configKeys}

IMPORTANT: All implementation steps must respect the architecture boundaries in CLAUDE.md. No cross-manager imports. No direct writes to protected uniforms.`,
    messages: [{
      role: 'user',
      content: `The top priority item from the Vanguard1 roadmap is:

${topItem}

Generate a complete, ready-to-execute implementation plan. Structure it as:

# Next Build: [Title]
*Generated: ${DATE_STR}*

## What This Delivers
(2-3 sentences: what the map looks/feels like after this is built)

## Files to Create or Modify
(List every file that changes, with the nature of the change)

## Step-by-Step Implementation

For each step:
### Step N: [Action]
- **File:** which file
- **What to do:** precise description
- **Code to add/replace:**
\`\`\`javascript
// exact code here
\`\`\`
- **Verify:** how to confirm this step worked

## Integration Points
(How does this connect to main.js, layerManager, config.js, and the event system?)

## Regression Risks
(What could break, and which visual-regression-guard.js tests to run)

## Rollback
(How to undo if something breaks)`,
    }],
  });
}

// ── Write outputs ──────────────────────────────────────────────────────────────

function writeOutputs(roadmapText, nextBuildText) {
  phase('WRITING OUTPUTS');
  ensureDir(PROPOSED);

  // ROADMAP.md — always overwrite (it's a living document)
  const roadmapPath = path.join(PROPOSED, 'ROADMAP.md');
  fs.writeFileSync(roadmapPath, roadmapText, 'utf8');
  ok('Roadmap written → proposed/ROADMAP.md');

  // NEXT_BUILD.md — always overwrite
  const nextBuildPath = path.join(PROPOSED, 'NEXT_BUILD.md');
  const nextBuildFull = [
    nextBuildText,
    '',
    '---',
    '',
    `*Generated by the Iteration Planner Agent on ${DATE_STR}.*`,
    `*Run \`node agents/iteration-planner-agent.js\` after completing this build to get the next plan.*`,
  ].join('\n');
  fs.writeFileSync(nextBuildPath, nextBuildFull, 'utf8');
  ok('Next build plan written → proposed/NEXT_BUILD.md');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY not set.');
    process.exit(1);
  }

  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║   VANGUARD — Iteration Planner Agent       ║');
  console.log(`║   ${DATE_STR}                            ║`);
  if (QUICK) console.log('║   QUICK MODE                               ║');
  console.log('╚════════════════════════════════════════════╝\n');

  // Phase 1: Ingest all proposals
  const findings = ingestProposed();

  // Phase 2: Snapshot codebase
  const snapshot = snapshotCodebase();

  // Phase 3: Build roadmap
  const roadmapText = await buildRoadmap(findings, snapshot);
  log(`Roadmap generated (${roadmapText.length} chars)`);

  // Phase 4: Detailed plan for top priority
  const nextBuildText = await buildNextImplementation(roadmapText, snapshot);
  log(`Next build plan generated (${nextBuildText.length} chars)`);

  // Write outputs
  writeOutputs(roadmapText, nextBuildText);

  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║   DONE                                     ║');
  console.log('║   proposed/ROADMAP.md                      ║');
  console.log('║   proposed/NEXT_BUILD.md                   ║');
  console.log('╚════════════════════════════════════════════╝\n');

  log('Recommended workflow:');
  log('  1. Review proposed/ROADMAP.md — does the priority order feel right?');
  log('  2. Open proposed/NEXT_BUILD.md — follow the step-by-step plan');
  log('  3. After building: run node agents/visual-regression-guard.js');
  log('  4. Run this agent again to get the next iteration plan');
}

main().catch(err => {
  console.error('[PLANNER] Fatal:', err.message);
  ensureDir(PROPOSED);
  fs.writeFileSync(
    path.join(PROPOSED, `PLANNER_ERROR_${DATE_STR}.md`),
    `# Iteration Planner Error — ${DATE_STR}\n\n${err.message}\n\n${err.stack}`,
    'utf8'
  );
  process.exit(1);
});
