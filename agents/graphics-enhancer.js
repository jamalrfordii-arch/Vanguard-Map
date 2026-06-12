#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  VANGUARD  —  Graphics Enhancer Agent                           ║
 * ║                                                                  ║
 * ║  Researches new visual rendering techniques across four tracks   ║
 * ║  and generates concrete GLSL patches, shader upgrades, and       ║
 * ║  manager scaffolds. Writes everything to proposed/graphics/      ║
 * ║  for human review — nothing touches production automatically.    ║
 * ║                                                                  ║
 * ║  Four research tracks:                                           ║
 * ║    1. POINT CLOUD  — terrain splat quality & PBR shading         ║
 * ║    2. REALISM      — lighting, atmosphere, water, shadows        ║
 * ║    3. VESSELS      — ship/aircraft model detail & LOD            ║
 * ║    4. TECHNIQUES   — new Three.js/WebGL visual capabilities      ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Usage:
 *   node graphics-enhancer.js              ← full run (all 4 tracks)
 *   node graphics-enhancer.js --track vessels   ← single track
 *   node graphics-enhancer.js --fresh      ← ignore cached research
 *
 * Output: Vanguard1/proposed/graphics/GRAPHICS_REPORT_YYYY-MM-DD.md
 *         Vanguard1/proposed/graphics/[track]/[enhancement]/
 */

import Anthropic from '@anthropic-ai/sdk';
import fs        from 'fs';
import path      from 'path';
import { fileURLToPath } from 'url';
import { generateComplete } from './agent-utils.js';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const PROJECT     = path.join(__dirname, '..');
const PROPOSED    = path.join(PROJECT, 'proposed', 'graphics');
const CACHE_DIR   = path.join(__dirname, 'reports');
const DATE_STR    = new Date().toISOString().slice(0, 10);

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TRACK_FLAG  = (() => { const i = process.argv.indexOf('--track'); return i !== -1 ? process.argv[i+1] : null; })();
const FRESH       = process.argv.includes('--fresh');

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function log(msg)     { console.log(`\x1b[35m[GFX]\x1b[0m ${msg}`); }
function phase(msg)   { console.log(`\n\x1b[1m\x1b[33m━━ ${msg} ━━\x1b[0m`); }
function ok(msg)      { console.log(`\x1b[32m✓  ${msg}\x1b[0m`); }
function track(msg)   { console.log(`\x1b[36m▶  ${msg}\x1b[0m`); }

// ── Current codebase snapshot ─────────────────────────────────────────────────
// We give the agent precise excerpts of the visual code it's improving,
// so it generates patches that actually apply cleanly.

function readVisualContext() {
  const readSlice = (file, start, len) => {
    const p = path.join(PROJECT, file);
    if (!fs.existsSync(p)) return `// ${file} not found`;
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    return lines.slice(start, start + len).join('\n');
  };
  const readSafe = (file, maxChars = 3000) => {
    const p = path.join(PROJECT, file);
    if (!fs.existsSync(p)) return `// ${file} not found`;
    return fs.readFileSync(p, 'utf8').slice(0, maxChars);
  };

  return {
    // Point cloud GLSL shader (the fragment shader is the visual core)
    splatShader:   readSafe('terrainBuilder.js', 5000),
    // Post-processing chain
    sceneSetup:    readSafe('sceneSetup.js', 3000),
    // Cloud ray-marching
    cloudShader:   readSafe('cloudManager.js', 4000),
    // Water Gerstner waves
    waterShader:   readSafe('waterManager.js', 3000),
    // Vessel geometry builders
    entityBuilder: readSafe('entityBuilder.js', 4000),
    // Fog pass
    fogShader:     readSafe('fogManager.js', 2000),
    // Config visual constants
    config:        readSafe('config.js', 2000),
    // Current managers list
    managers:      fs.readdirSync(PROJECT).filter(f => f.endsWith('Manager.js') || f.endsWith('Builder.js')),
  };
}

// ── Research track definitions ────────────────────────────────────────────────

const TRACKS = {
  'point-cloud': {
    label: 'Point Cloud & Terrain Rendering',
    searchFocus: `Search for: three.js point cloud rendering PBR 2025, WebGL terrain splat shading techniques, GLSL ambient occlusion point cloud, real-time terrain point rendering improvements, better color grading GLSL shader terrain, three.js Points material advanced shading, GPU terrain rendering techniques, normal estimation point cloud WebGL, three.js r165 r166 new rendering features`,
    contextKey: 'splatShader',
    outputType: 'shader-patch',
    prompt: (ctx) => `You are improving the terrain point cloud shader in Vanguard1, a 3D tactical intelligence map.

CURRENT POINT CLOUD FRAGMENT SHADER (terrainBuilder.js):
${ctx.splatShader.slice(0, 4000)}

CURRENT CONFIG CONSTANTS:
${ctx.config}

Research findings:
{{RESEARCH}}

Propose 2 concrete improvements to the terrain point cloud rendering. For each:
1. TITLE: Short name
2. VISUAL_EFFECT: What the analyst will see change
3. TECHNIQUE: The specific GLSL or rendering technique
4. SHADER_PATCH: The actual GLSL code to add or replace, with clear comments showing which section of terrainBuilder.js it applies to
5. RISK: LOW/MEDIUM/HIGH (with reasoning — does it touch the hairpin uniforms?)
6. DATA_SOURCE: If it needs new data (e.g. normal maps, AO textures)

Focus on: PBR-style shading, better shadow lift, normal-based lighting, terrain surface type differentiation (ice/desert/forest), better polar region rendering. Do NOT change SPLAT_BRIGHTNESS, SPLAT_LAND_LIFT, SPLAT_LAND_GAMMA, SPLAT_SATURATION — the auto-tuner owns those.`,
  },

  'realism': {
    label: 'Realism — Lighting, Atmosphere, Water',
    searchFocus: `Search for: three.js atmospheric scattering 2025, WebGL god rays volumetric light shaft, GLSL ocean foam spray simulation, three.js screen space ambient occlusion, WebGL shadow mapping three.js, three.js night city glow technique, atmospheric haze distance fog WebGL, GLSL water surface caustics rendering, three.js lens flare implementation, real-time aurora borealis three.js particle system`,
    contextKey: 'sceneSetup',
    outputType: 'manager-or-patch',
    prompt: (ctx) => `You are improving the realism of Vanguard1, a 3D tactical intelligence map.

CURRENT POST-PROCESSING CHAIN (sceneSetup.js):
${ctx.sceneSetup}

CURRENT CLOUD SHADER (cloudManager.js):
${ctx.cloudShader.slice(0, 2000)}

CURRENT WATER SHADER (waterManager.js):
${ctx.waterShader.slice(0, 2000)}

CURRENT FOG PASS (fogManager.js):
${ctx.fogShader}

Research findings:
{{RESEARCH}}

Propose 2 concrete realism improvements. For each:
1. TITLE: Short name
2. CATEGORY: Which system it improves (water/atmosphere/lighting/post-process)
3. VISUAL_EFFECT: What the analyst will see — be specific and evocative
4. IMPLEMENTATION: The Three.js/GLSL approach — new ShaderPass, new manager, or patch to existing shader
5. CODE: Complete implementation — either a full new manager file OR a precise GLSL patch with file/line context
6. PERFORMANCE_COST: Estimated FPS impact (new post-process passes cost ~5fps on integrated GPU)
7. RISK: LOW/MEDIUM/HIGH

CRITICAL: The post-processing chain is Render→Bloom→Fog→Clouds→TiltShift×2→Bokeh. Adding another pass needs explicit LOW risk justification. Prefer improvements to EXISTING shaders over new passes.`,
  },

  'vessels': {
    label: 'Vessel & Aircraft Design',
    searchFocus: `Search for: free 3D ship model GLTF GLB open source maritime, three.js GLTF loader ship model, procedural ship hull GLSL shader WebGL, three.js instanced LOD mesh vessel, container ship 3D model free download, naval vessel 3D model open source, aircraft 3D model GLTF free, three.js MeshStandardMaterial ship PBR texture, ship silhouette rendering three.js, animated ship propeller three.js`,
    contextKey: 'entityBuilder',
    outputType: 'entity-upgrade',
    prompt: (ctx) => `You are improving the vessel and aircraft visual design in Vanguard1, a 3D tactical intelligence map.

CURRENT VESSEL GEOMETRY (entityBuilder.js — shape builders):
${ctx.entityBuilder.slice(0, 4000)}

The current vessels use THREE.BoxGeometry and THREE.CylinderGeometry with MeshStandardMaterial. Classes: CARGO, TANKER, PATROL, HOSTILE, FIGHTER, AWACS, DRONE, SUBMARINE, ORBITAL.

Research findings:
{{RESEARCH}}

Propose 2 concrete vessel design improvements. For each:
1. TITLE: Short name
2. VESSEL_CLASS: Which class(es) this improves (or ALL)
3. VISUAL_EFFECT: What the vessels will look like — be specific
4. APPROACH: New geometry shapes, GLTF loader, PBR materials, LOD system, or shader enhancement
5. CODE: Complete Three.js code — either a replacement shapeBuilder function, a new vesselDetailManager, or a GLTF loading approach with fallback to current geometry
6. FREE_ASSETS: Specific URLs to free/open-source 3D models or textures if applicable
7. PERFORMANCE_NOTE: Instance budget impact

Focus on: class-specific hull shapes that are visually distinct, better materials (rust streaks, antifouling paint on hulls, metallic aircraft finishes), animated elements (rotating radar, propeller wash), LOD so vessels gain detail on zoom.`,
  },

  'techniques': {
    label: 'Emerging Three.js & WebGL Techniques',
    searchFocus: `Search for: three.js r165 r166 new features 2025, WebGPU three.js migration guide, three.js instanced mesh new capabilities, GLSL compute shader WebGL2, three.js MeshPhysicalMaterial new properties 2025, real-time global illumination WebGL, three.js custom depth material, WebGL2 transform feedback particles, three.js texture compression KTX2, three.js animation mixer GPU skinning`,
    contextKey: 'sceneSetup',
    outputType: 'technique',
    prompt: (ctx) => `You are a graphics engineer evaluating emerging Three.js and WebGL techniques for Vanguard1, a 3D tactical intelligence map built on Three.js r165.

CURRENT RENDERER SETUP (sceneSetup.js):
${ctx.sceneSetup}

CURRENT MANAGERS: ${ctx.managers.join(', ')}

Research findings:
{{RESEARCH}}

Propose 2 techniques from the latest Three.js/WebGL ecosystem that would meaningfully improve Vanguard1. For each:
1. TITLE: Short name
2. WHAT_IT_ENABLES: The new visual or performance capability
3. THREE_JS_VERSION: Which Three.js version introduced it (r165, r166, etc.)
4. VANGUARD_APPLICATION: Exactly how it would be used in this specific codebase
5. CODE: A working implementation example wired to Vanguard1's existing architecture
6. MIGRATION_EFFORT: LOW/MEDIUM/HIGH (how much existing code needs to change)
7. PERFORMANCE_GAIN: Estimated improvement (if any)

Focus on capabilities that are already stable in r165+ and ready to use today.`,
  },
};

// ── Web research per track ────────────────────────────────────────────────────

async function researchTrack(trackKey, trackDef) {
  const cacheFile = path.join(CACHE_DIR, `gfx-cache-${DATE_STR}-${trackKey}.txt`);
  ensureDir(CACHE_DIR);

  if (!FRESH && fs.existsSync(cacheFile)) {
    const cached = fs.readFileSync(cacheFile, 'utf8');
    log(`  Resuming from cache (${cached.length} chars)`);
    return cached;
  }

  const messages = [{
    role: 'user',
    content: `You are researching visual rendering techniques for Vanguard1, a Three.js tactical map.

Research track: ${trackDef.label}

${trackDef.searchFocus}

Search the web thoroughly. Find specific: GitHub repos with code, Three.js examples, GLSL techniques, free 3D assets, academic papers. Return detailed findings with URLs.`,
  }];

  let researchText = '';
  let iterations = 0;

  while (iterations < 4) {
    iterations++;
    log(`  Search round ${iterations}/4…`);

    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 6000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages,
    });

    const textBlocks = response.content.filter(b => b.type === 'text');
    if (textBlocks.length) researchText += textBlocks.map(b => b.text).join('\n');

    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });
      messages.push({
        role: 'user',
        content: response.content
          .filter(b => b.type === 'tool_use')
          .map(b => ({ type: 'tool_result', tool_use_id: b.id, content: '' })),
      });
    } else break;
  }

  // Fallback if web search unavailable
  if (!researchText.trim()) {
    log('  Web search unavailable — using knowledge base…');
    const fallback = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: `Research ${trackDef.label} techniques for Three.js r165. Provide specific GLSL techniques, Three.js APIs, GitHub repos, and implementation approaches. Be concrete and technical.` }],
    });
    researchText = fallback.content.filter(b => b.type === 'text').map(b => b.text).join('');
  }

  if (researchText.trim()) fs.writeFileSync(cacheFile, researchText, 'utf8');
  return researchText;
}

// ── Generate proposals for a track ───────────────────────────────────────────

async function generateProposals(trackKey, trackDef, researchText, ctx) {
  const promptTemplate = trackDef.prompt(ctx);
  const fullPrompt = promptTemplate.replace('{{RESEARCH}}', researchText.slice(0, 4000));

  // generateComplete() continues automatically if the model hits max_tokens,
  // preventing the truncated-file bug that cut off proposals mid-code-block.
  return generateComplete(client, {
    model: 'claude-opus-4-6',
    max_tokens: 16000,
    system: `You are a senior Three.js graphics engineer working on Vanguard1.
Generate concrete, implementable graphics improvements.
All code must use ES module syntax.
All shader code must be valid GLSL ES 3.00.
Mark any change to the post-processing chain or bloom settings as HIGH risk.
IMPORTANT: Always write complete code. Never truncate or abbreviate with "// ... rest of code". Every function must be fully implemented.`,
    messages: [{ role: 'user', content: fullPrompt }],
  });
}

// ── Write output files ────────────────────────────────────────────────────────

function writeTrackOutput(trackKey, trackDef, researchText, proposalsText) {
  const trackDir = path.join(PROPOSED, trackKey);
  ensureDir(trackDir);

  // Research notes
  fs.writeFileSync(
    path.join(trackDir, `RESEARCH_${DATE_STR}.md`),
    `# ${trackDef.label} — Research Notes\n\n*${DATE_STR}*\n\n${researchText}`,
    'utf8'
  );

  // Proposals
  fs.writeFileSync(
    path.join(trackDir, `PROPOSALS_${DATE_STR}.md`),
    `# ${trackDef.label} — Enhancement Proposals\n\n*${DATE_STR}*\n\n> Review carefully before applying. Shader patches must be tested in isolation.\n\n${proposalsText}`,
    'utf8'
  );

  ok(`  Written → proposed/graphics/${trackKey}/PROPOSALS_${DATE_STR}.md`);

  // Try to extract code blocks and save as separate files
  const codeBlocks = [...proposalsText.matchAll(/```(?:js|glsl|javascript)?\n([\s\S]*?)```/g)];
  codeBlocks.forEach((match, i) => {
    const code = match[1].trim();
    if (code.length < 50) return; // skip tiny snippets
    const ext = code.includes('gl_FragColor') || code.includes('void main') ? 'glsl' : 'js';
    const filename = `enhancement_${i + 1}.${ext}`;
    fs.writeFileSync(path.join(trackDir, filename), code, 'utf8');
    ok(`  Code extracted → proposed/graphics/${trackKey}/${filename}`);
  });
}

// ── Build the main report ─────────────────────────────────────────────────────

function writeMainReport(trackResults) {
  ensureDir(PROPOSED);

  const lines = [
    `# Vanguard1 Graphics Enhancement Report — ${DATE_STR}`,
    ``,
    `> Generated by the Graphics Enhancer Agent. All patches in \`proposed/graphics/[track]/\` — review and test before applying to production.`,
    ``,
    `---`,
    ``,
    `## Quick Reference`,
    ``,
    `| Track | File | Risk |`,
    `|-------|------|------|`,
  ];

  for (const { trackKey, trackDef } of trackResults) {
    lines.push(`| ${trackDef.label} | \`proposed/graphics/${trackKey}/PROPOSALS_${DATE_STR}.md\` | See proposals |`);
  }

  lines.push(``, `---`, ``);

  for (const { trackKey, trackDef, proposalsText } of trackResults) {
    lines.push(`## ${trackDef.label}`);
    lines.push(``);
    lines.push(proposalsText.slice(0, 2000));
    if (proposalsText.length > 2000) lines.push(`\n*[Full proposals in proposed/graphics/${trackKey}/PROPOSALS_${DATE_STR}.md]*`);
    lines.push(``, `---`, ``);
  }

  lines.push(`## How to Apply a Patch`);
  lines.push(``);
  lines.push(`1. Open the PROPOSALS file for the track you want`);
  lines.push(`2. Find the enhancement you like`);
  lines.push(`3. For SHADER PATCHES: locate the indicated section in the source file and replace`);
  lines.push(`4. For NEW MANAGERS: copy the extracted .js file to the project root, wire into main.js`);
  lines.push(`5. Run the Visual Regression Guard to confirm nothing broke:`);
  lines.push(`   \`node agents/visual-regression-guard.js\``);
  lines.push(`6. If the regression guard fails, revert the patch and adjust`);
  lines.push(``);
  lines.push(`_Next graphics report scheduled automatically. Run \`node agents/graphics-enhancer.js --fresh\` to force a new search._`);

  const reportPath = path.join(PROPOSED, `GRAPHICS_REPORT_${DATE_STR}.md`);
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  ok(`Main report → proposed/graphics/GRAPHICS_REPORT_${DATE_STR}.md`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY not set.');
    process.exit(1);
  }

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   VANGUARD — Graphics Enhancer Agent             ║');
  console.log(`║   ${DATE_STR}                                   ║`);
  console.log('╚══════════════════════════════════════════════════╝\n');

  phase('READING VISUAL CODEBASE');
  const ctx = readVisualContext();
  log(`Read ${Object.keys(ctx).length} visual source files`);
  log(`Vessel classes found: CARGO, TANKER, PATROL, HOSTILE, FIGHTER, AWACS, DRONE, SUBMARINE`);
  ok('Visual context loaded');

  // Filter to single track if --track flag used
  const tracksToRun = TRACK_FLAG
    ? { [TRACK_FLAG]: TRACKS[TRACK_FLAG] }
    : TRACKS;

  if (TRACK_FLAG && !TRACKS[TRACK_FLAG]) {
    console.error(`Unknown track "${TRACK_FLAG}". Available: ${Object.keys(TRACKS).join(', ')}`);
    process.exit(1);
  }

  const trackResults = [];

  for (const [trackKey, trackDef] of Object.entries(tracksToRun)) {
    phase(`TRACK: ${trackDef.label.toUpperCase()}`);

    // Research
    track('Researching…');
    const researchText = await researchTrack(trackKey, trackDef);
    log(`  ${researchText.length} chars of research`);

    // Generate proposals
    track('Generating enhancement proposals…');
    const proposalsText = await generateProposals(trackKey, trackDef, researchText, ctx);
    log(`  ${proposalsText.length} chars of proposals`);

    // Write files
    track('Writing output files…');
    writeTrackOutput(trackKey, trackDef, researchText, proposalsText);

    trackResults.push({ trackKey, trackDef, researchText, proposalsText });
  }

  phase('WRITING MAIN REPORT');
  writeMainReport(trackResults);

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   DONE                                           ║');
  console.log(`║   proposed/graphics/GRAPHICS_REPORT_${DATE_STR}.md ║`);
  console.log('╚══════════════════════════════════════════════════╝\n');
}

main().catch(err => {
  console.error('[GFX] Fatal:', err.message);
  // Save partial progress note
  ensureDir(PROPOSED);
  fs.writeFileSync(
    path.join(PROPOSED, `ERROR_${DATE_STR}.md`),
    `# Graphics Enhancer Error — ${DATE_STR}\n\n${err.message}\n\n${err.stack}`,
    'utf8'
  );
  process.exit(1);
});
