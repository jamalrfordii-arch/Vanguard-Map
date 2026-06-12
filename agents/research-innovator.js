#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  VANGUARD  —  Research Innovator Agent                          ║
 * ║                                                                  ║
 * ║  Explores genuinely new directions for the map through live      ║
 * ║  web research, then generates scaffold code and a detailed       ║
 * ║  innovation report. Writes everything to Vanguard1/proposed/     ║
 * ║  for human review — nothing touches production automatically.    ║
 * ║                                                                  ║
 * ║  Six phases:                                                     ║
 * ║    1. AUDIT     — read codebase to know what already exists      ║
 * ║    2. MEMORY    — read prior reports to avoid repeating          ║
 * ║    3. RESEARCH  — live web search for new directions             ║
 * ║    4. RANK      — Claude picks the strongest innovations         ║
 * ║    5. SCAFFOLD  — generate real code for top picks               ║
 * ║    6. REPORT    — write INNOVATION_REPORT + proposed/ files      ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Usage:
 *   node research-innovator.js              ← full run
 *   node research-innovator.js --fast       ← fewer search rounds, quicker
 *   node research-innovator.js --topic sar  ← focus on a specific domain
 *
 * Scheduled: runs every Sunday at 11pm via the Vanguard schedule task.
 * Output:    Vanguard1/proposed/INNOVATION_REPORT_YYYY-MM-DD.md
 *            Vanguard1/proposed/[feature-slug]/[featureManager.js + RESEARCH.md]
 */

import Anthropic from '@anthropic-ai/sdk';
import fs        from 'fs';
import path      from 'path';
import { fileURLToPath } from 'url';
import { generateComplete } from './agent-utils.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const PROJECT    = path.join(__dirname, '..');
const PROPOSED   = path.join(PROJECT, 'proposed');
const AGENTS_DIR = __dirname;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FAST_MODE  = process.argv.includes('--fast');
const TOPIC_FLAG = (() => { const i = process.argv.indexOf('--topic'); return i !== -1 ? process.argv[i+1] : null; })();
const DATE_STR   = new Date().toISOString().slice(0, 10);

// How many innovation directions to research and how many to scaffold
const RESEARCH_DIRECTIONS = FAST_MODE ? 5  : 10;
const TOP_INNOVATIONS     = FAST_MODE ? 2  : 3;

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function log(msg)     { console.log(`\x1b[36m[INNOVATOR]\x1b[0m ${msg}`); }
function phase(msg)   { console.log(`\n\x1b[1m\x1b[35m━━ ${msg} ━━\x1b[0m`); }
function ok(msg)      { console.log(`\x1b[32m✓  ${msg}\x1b[0m`); }

// ── Phase 1: AUDIT ────────────────────────────────────────────────────────────
// Read the key project files to build a picture of what already exists.

function auditCodebase() {
  phase('PHASE 1 — AUDIT');

  const readSafe = (rel) => {
    const p = path.join(PROJECT, rel);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  };

  // Collect existing manager names
  const managers = fs.readdirSync(PROJECT)
    .filter(f => f.endsWith('Manager.js') || f.endsWith('Builder.js'))
    .map(f => f.replace('.js', ''));

  const audit = {
    claudeMd:   readSafe('CLAUDE.md').slice(0, 6000),
    spec:       readSafe('vanguard-spec.md').slice(0, 6000),
    notes:      readSafe('NOTES.md').slice(0, 3000),
    devNotes:   readSafe('VANGUARD1_DEV_NOTES.md').slice(0, 3000),
    managers:   managers,
    configKeys: readSafe('config.js').match(/export const \w+/g) || [],
  };

  log(`Found ${managers.length} managers: ${managers.join(', ')}`);
  log(`Read spec (${audit.spec.length} chars), CLAUDE.md (${audit.claudeMd.length} chars)`);
  ok('Audit complete');
  return audit;
}

// ── Phase 2: MEMORY ───────────────────────────────────────────────────────────
// Read previous innovation reports so we don't re-propose the same things.

function loadMemory() {
  phase('PHASE 2 — MEMORY');
  const reports = fs.existsSync(PROPOSED)
    ? fs.readdirSync(PROPOSED).filter(f => f.startsWith('INNOVATION_REPORT_') && f.endsWith('.md'))
    : [];

  const previousTopics = [];
  for (const r of reports.slice(-4)) { // last 4 reports
    const content = fs.readFileSync(path.join(PROPOSED, r), 'utf8');
    const headings = content.match(/^## \d+\..+/gm) || [];
    previousTopics.push(...headings.map(h => h.replace(/^## \d+\.\s*/, '').trim()));
  }

  log(`Found ${reports.length} previous reports. Already proposed: ${previousTopics.length} features.`);
  if (previousTopics.length) log(`Previously proposed: ${previousTopics.slice(0, 5).join(', ')}…`);
  ok('Memory loaded');
  return previousTopics;
}

// ── Phase 3: RESEARCH ─────────────────────────────────────────────────────────
// Use Claude with live web search to explore new directions.
// Runs a multi-turn agentic loop until Claude signals it has enough material.

async function conductResearch(audit, previousTopics) {
  phase('PHASE 3 — RESEARCH');

  const avoidList = previousTopics.length
    ? `\n\nDo NOT propose these — they were already suggested in previous reports:\n${previousTopics.map(t => `- ${t}`).join('\n')}`
    : '';

  const topicFocus = TOPIC_FLAG
    ? `\n\nThe user has asked to focus this research session on: "${TOPIC_FLAG}". Prioritize this domain.`
    : '';

  const systemPrompt = `You are a senior research engineer and strategic analyst for Vanguard1, a real-time 3D geospatial intelligence platform built in Three.js.

The platform currently has these capabilities (already built):
Managers: ${audit.managers.join(', ')}

Platform architecture summary:
${audit.claudeMd.slice(0, 2000)}

Your mission: discover GENUINELY NEW directions — capabilities, data sources, visualization techniques, or intelligence layers that the project has not yet imagined. Think boldly. Look at:
- Cutting-edge OSINT and maritime intelligence tools
- New public data APIs (satellite, RF, acoustic, environmental, economic)
- Emerging Three.js / WebGL / WebGPU visualization techniques
- Academic research in geospatial intelligence
- What commercial tools like Windward, Spire, Palantir, Maxar are doing
- Open-source geospatial projects on GitHub
- New space domain awareness capabilities
- Electromagnetic, cyber, and information warfare data sources
- Environmental intelligence (ocean currents, ice, weather patterns as intelligence)
- AI/ML approaches to maritime and aerial pattern analysis
${avoidList}
${topicFocus}

Use web search extensively. Search for specific APIs, GitHub repos, papers, and tools. Be concrete — identify real data sources with actual endpoints where possible.`;

  const userPrompt = `Research ${RESEARCH_DIRECTIONS} genuinely new innovation directions for Vanguard1. For each direction:
1. What is it? (1-2 sentences)
2. Why is it strategically valuable for an intelligence map?
3. What specific data source, API, or technique enables it? (real URLs if you found them)
4. How does it fit with the existing Three.js architecture?
5. What would the new manager be called?

Format your response as a numbered list. Be specific and concrete — real APIs, real GitHub repos, real data feeds. No vague suggestions.`;

  // ── Research cache: skip web search if we already have findings from today ──
  const CACHE_FILE = path.join(AGENTS_DIR, 'reports', `research-cache-${DATE_STR}.txt`);
  ensureDir(path.join(AGENTS_DIR, 'reports'));
  if (fs.existsSync(CACHE_FILE) && !process.argv.includes('--fresh')) {
    const cached = fs.readFileSync(CACHE_FILE, 'utf8');
    log(`Resuming from cached research (${cached.length} chars) — skipping web search.`);
    log('Run with --fresh to force new research.');
    return cached;
  }

  log('Starting live web research…');
  log(FAST_MODE ? '(fast mode — fewer search rounds)' : '(full research mode)');

  const messages = [{ role: 'user', content: userPrompt }];
  let researchText = '';
  let iterations = 0;
  const maxIterations = FAST_MODE ? 4 : 8;

  // Agentic search loop — Claude searches the web autonomously
  while (iterations < maxIterations) {
    iterations++;
    log(`Research round ${iterations}/${maxIterations}…`);

    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 8000,
      system: systemPrompt,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages,
    });

    // Collect any text content
    const textBlocks = response.content.filter(b => b.type === 'text');
    if (textBlocks.length) {
      researchText += textBlocks.map(b => b.text).join('\n');
    }

    // If Claude is done searching, break
    if (response.stop_reason === 'end_turn') {
      log('Research complete — Claude finished searching.');
      break;
    }

    // If Claude wants to search more, add its response and continue
    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });
      // For server-side web_search, results are automatically injected
      // We add a continuation prompt to keep the loop going
      messages.push({
        role: 'user',
        content: response.content
          .filter(b => b.type === 'tool_use')
          .map(b => ({ type: 'tool_result', tool_use_id: b.id, content: '' })),
      });
      continue;
    }

    break;
  }

  if (!researchText.trim()) {
    // Fallback: ask without web search if tool isn't available
    log('Web search unavailable — using Claude knowledge base for research…');
    const fallback = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    researchText = fallback.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  }

  // Save to cache so a billing/network failure at phase 4+ can resume without re-searching
  if (researchText.trim()) {
    fs.writeFileSync(CACHE_FILE, researchText, 'utf8');
    log(`Research cached → reports/research-cache-${DATE_STR}.txt`);
  }

  ok(`Research complete — ${researchText.length} chars of findings`);
  return researchText;
}

// ── Phase 4: RANK ─────────────────────────────────────────────────────────────
// Claude picks the strongest innovations based on impact, uniqueness, and
// feasibility within the Three.js architecture.

async function rankInnovations(researchText, audit) {
  phase('PHASE 4 — RANK & SYNTHESIZE');
  log(`Selecting top ${TOP_INNOVATIONS} innovations from research…`);

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 6000,
    system: `You are an architect for Vanguard1, a Three.js geospatial intelligence platform.
Architecture rules:
- Each new layer = new *Manager.js file with layerManager registration
- Managers communicate via window.dispatchEvent(new CustomEvent('vg1:…'))
- Constants go in config.js under a namespace group
- No imports between managers`,
    messages: [{
      role: 'user',
      content: `Here are the research findings for potential new Vanguard1 innovations:

${researchText}

Select the ${TOP_INNOVATIONS} strongest innovations based on:
1. Strategic intelligence value (how much does it enhance the analyst's picture?)
2. Data availability (is there a real, accessible data source?)
3. Visual impact (how compelling will it look in 3D?)
4. Architectural fit (can it be built as a manager without breaking the pipeline?)

For each chosen innovation, provide:
- TITLE: (short name, will become the manager file name prefix)
- SLUG: (kebab-case, e.g. "sar-vessel-detection")
- CATEGORY: (surface | atmosphere | geomagnetic | space | human)
- STRATEGIC_VALUE: (2-3 sentences on why this matters for intelligence)
- DATA_SOURCE: (specific API endpoint, WebSocket URL, or data feed)
- VISUAL_CONCEPT: (what will it look like on the 3D map?)
- MANAGER_NAME: (e.g. "SarVesselManager")
- IMPLEMENTATION_APPROACH: (specific Three.js geometry/technique to use)
- RESEARCH_NOTES: (key findings from research, URLs, references)

Format as JSON array. Be precise and technical.`,
    }],
  });

  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');

  // Extract JSON from response
  let innovations = [];
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) innovations = JSON.parse(jsonMatch[0]);
  } catch {
    // Parse failure — extract structured data manually
    log('JSON parse failed, extracting data manually…');
    innovations = [{ TITLE: 'Research findings', SLUG: 'research', rawText: text }];
  }

  ok(`Selected ${innovations.length} innovations to build`);
  return { innovations, fullText: text };
}

// ── Phase 5: SCAFFOLD ─────────────────────────────────────────────────────────
// Generate real Three.js manager code for each top innovation.

async function scaffoldInnovation(innovation, audit) {
  log(`Scaffolding: ${innovation.TITLE || innovation.MANAGER_NAME}…`);

  // Read template managers for context
  const templateFiles = ['gfsWindManager.js', 'gpsJammingManager.js', 'spaceWeatherManager.js'];
  const templates = templateFiles
    .map(f => { const p = path.join(PROJECT, f); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').slice(0, 2000) : ''; })
    .filter(Boolean)
    .join('\n\n---\n\n');

  // generateComplete() continues automatically if the model hits max_tokens,
  // preventing the truncated-file bug that cut off manager scaffolds mid-code.
  return generateComplete(client, {
    model: 'claude-opus-4-6',
    max_tokens: 16000,
    system: `You are a senior Three.js developer building Vanguard1, a 3D geospatial intelligence platform.

Architecture rules:
- ES modules, no bundler
- Each manager: constructor(), init(scene), update(camera, dt), dispose()
- Register with layerManager.register({ id, label, category, defaultOn })
- Listen to window.addEventListener('vg1:layerChanged', …) for toggle
- Constants in config.js under export const ${(innovation.SLUG || 'feature').toUpperCase().replace(/-/g,'_')} = { … }
- No imports between managers — use window.dispatchEvent(new CustomEvent('vg1:…'))
- No new THREE.Vector3() in update() loops — use module-scope scratch vars
- Fade based on camera.y altitude

IMPORTANT: Always write complete code. Never truncate or abbreviate with "// ... rest of code". Every function must be fully implemented.

Example manager patterns:
${templates.slice(0, 3000)}`,
    messages: [{
      role: 'user',
      content: `Generate a complete, production-ready ${innovation.MANAGER_NAME || innovation.TITLE + 'Manager'}.js for this innovation:

Title: ${innovation.TITLE}
Category: ${innovation.CATEGORY || 'human'}
Data source: ${innovation.DATA_SOURCE || 'to be configured'}
Visual concept: ${innovation.VISUAL_CONCEPT || 'data layer visualization'}
Implementation approach: ${innovation.IMPLEMENTATION_APPROACH || 'instanced mesh or particle system'}

Requirements:
1. Complete ES module with all imports
2. Class ${innovation.MANAGER_NAME || 'NewFeatureManager'} with constructor/init/update/dispose
3. _fetchData() method with commented API integration pointing to: ${innovation.DATA_SOURCE || 'your data source'}
4. Appropriate Three.js geometry for the visual concept
5. layerManager.register() with correct category
6. vg1:layerChanged event listener
7. Camera altitude fade using config constants
8. Module-scope scratch vectors (no in-loop allocations)
9. JSDoc on all public methods

Output ONLY the JavaScript. No markdown fences.`,
    }],
  });
}

// ── Phase 6: REPORT ───────────────────────────────────────────────────────────
// Write INNOVATION_REPORT_DATE.md and all proposed files.

async function writeReport(innovations, researchText, scaffolds) {
  phase('PHASE 6 — WRITING REPORT & PROPOSED FILES');
  ensureDir(PROPOSED);

  // Build report markdown
  const lines = [
    `# Vanguard1 Innovation Report — ${DATE_STR}`,
    ``,
    `> Generated by the Research Innovator Agent. All code is in \`proposed/\` — review before adding to production.`,
    ``,
    `---`,
    ``,
    `## Research Summary`,
    ``,
    researchText.slice(0, 3000) + (researchText.length > 3000 ? '\n\n*[truncated — see full research in agent logs]*' : ''),
    ``,
    `---`,
    ``,
    `## Selected Innovations`,
    ``,
  ];

  for (let i = 0; i < innovations.innovations.length; i++) {
    const inv = innovations.innovations[i];
    const slug = inv.SLUG || `innovation-${i+1}`;

    lines.push(`## ${i+1}. ${inv.TITLE || slug}`);
    lines.push(``);
    lines.push(`**Category:** ${inv.CATEGORY || 'TBD'}`);
    lines.push(`**Manager:** \`${inv.MANAGER_NAME || slug + 'Manager'}.js\``);
    lines.push(`**Proposed file:** \`proposed/${slug}/${inv.MANAGER_NAME || slug + 'Manager'}.js\``);
    lines.push(``);
    lines.push(`### Strategic Value`);
    lines.push(inv.STRATEGIC_VALUE || '_See research notes_');
    lines.push(``);
    lines.push(`### Data Source`);
    lines.push(`\`\`\`\n${inv.DATA_SOURCE || 'TBD'}\n\`\`\``);
    lines.push(``);
    lines.push(`### Visual Concept`);
    lines.push(inv.VISUAL_CONCEPT || '_See implementation approach_');
    lines.push(``);
    lines.push(`### Implementation Approach`);
    lines.push(inv.IMPLEMENTATION_APPROACH || '_See scaffolded code_');
    lines.push(``);
    lines.push(`### Research Notes`);
    lines.push(inv.RESEARCH_NOTES || '_See full research text above_');
    lines.push(``);
    lines.push(`### To activate:`);
    lines.push(`\`\`\`js`);
    lines.push(`// In main.js:`);
    lines.push(`import { ${inv.MANAGER_NAME || slug + 'Manager'} } from './${inv.MANAGER_NAME || slug + 'Manager'}.js';`);
    lines.push(`const ${(inv.SLUG || 'feature').replace(/-./g, m => m[1].toUpperCase())}Manager = new ${inv.MANAGER_NAME || slug + 'Manager'}();`);
    lines.push(`await ${(inv.SLUG || 'feature').replace(/-./g, m => m[1].toUpperCase())}Manager.init(scene);`);
    lines.push(`// In animation loop:`);
    lines.push(`${(inv.SLUG || 'feature').replace(/-./g, m => m[1].toUpperCase())}Manager.update(camera, delta);`);
    lines.push(`\`\`\``);
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
  }

  lines.push(`## How to Use This Report`);
  lines.push(``);
  lines.push(`1. Review each innovation above`);
  lines.push(`2. Open the scaffolded code in \`proposed/[slug]/\``);
  lines.push(`3. Fill in the \`_fetchData()\` method with real API credentials`);
  lines.push(`4. Copy the manager file to the project root`);
  lines.push(`5. Wire it into \`main.js\` using the activation snippet above`);
  lines.push(`6. Add constants to \`config.js\` (see generated scaffold)`);
  lines.push(``);
  lines.push(`_Next report scheduled for next Sunday. Delete this file to re-run manually._`);

  const reportPath = path.join(PROPOSED, `INNOVATION_REPORT_${DATE_STR}.md`);
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  ok(`Report written → proposed/INNOVATION_REPORT_${DATE_STR}.md`);

  // Write scaffold files
  for (let i = 0; i < innovations.innovations.length; i++) {
    const inv = innovations.innovations[i];
    const slug = inv.SLUG || `innovation-${i+1}`;
    const managerName = inv.MANAGER_NAME || slug + 'Manager';
    const dir = path.join(PROPOSED, slug);
    ensureDir(dir);

    // Manager code
    if (scaffolds[i]) {
      fs.writeFileSync(path.join(dir, `${managerName}.js`), scaffolds[i], 'utf8');
      ok(`Code written → proposed/${slug}/${managerName}.js`);
    }

    // Research notes
    const researchMd = [
      `# ${inv.TITLE} — Research Notes`,
      ``,
      `**Generated:** ${DATE_STR}`,
      `**Category:** ${inv.CATEGORY}`,
      `**Manager:** ${managerName}.js`,
      ``,
      `## Strategic Value`,
      inv.STRATEGIC_VALUE || '',
      ``,
      `## Data Source`,
      inv.DATA_SOURCE || '',
      ``,
      `## Visual Concept`,
      inv.VISUAL_CONCEPT || '',
      ``,
      `## Implementation Approach`,
      inv.IMPLEMENTATION_APPROACH || '',
      ``,
      `## Research Notes`,
      inv.RESEARCH_NOTES || '',
      ``,
      `## Next Steps`,
      `1. Open ${managerName}.js and fill in \`_fetchData()\``,
      `2. Register an API key for the data source above`,
      `3. Copy manager to project root and wire into main.js`,
    ].join('\n');

    fs.writeFileSync(path.join(dir, 'RESEARCH.md'), researchMd, 'utf8');
    ok(`Notes written → proposed/${slug}/RESEARCH.md`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY not set.');
    process.exit(1);
  }

  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║   VANGUARD — Research Innovator Agent      ║');
  console.log(`║   ${DATE_STR}${FAST_MODE ? ' · FAST MODE' : '            '}             ║`);
  console.log('╚════════════════════════════════════════════╝\n');

  // Phase 1 — Audit
  const audit = auditCodebase();

  // Phase 2 — Memory
  const previousTopics = loadMemory();

  // Phase 3 — Research
  const researchText = await conductResearch(audit, previousTopics);

  // Phase 4 — Rank
  const innovations = await rankInnovations(researchText, audit);
  log(`Top innovations: ${innovations.innovations.map(i => i.TITLE).join(', ')}`);

  // Phase 5 — Scaffold (in parallel for speed)
  phase('PHASE 5 — SCAFFOLD CODE');
  const scaffolds = await Promise.all(
    innovations.innovations.map(inv => scaffoldInnovation(inv, audit))
  );
  ok(`Generated ${scaffolds.length} manager scaffolds`);

  // Phase 6 — Report
  await writeReport(innovations, researchText, scaffolds);

  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║   DONE                                     ║');
  console.log(`║   proposed/INNOVATION_REPORT_${DATE_STR}.md  ║`);
  console.log('╚════════════════════════════════════════════╝\n');
}

main().catch(err => {
  console.error('[INNOVATOR] Fatal:', err);
  process.exit(1);
});
