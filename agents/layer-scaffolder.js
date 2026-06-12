#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║  VANGUARD  —  Layer Scaffolder Agent                    ║
 * ║                                                          ║
 * ║  Reads existing manager files as templates, asks Claude  ║
 * ║  to understand the pattern, then generates a complete    ║
 * ║  new manager file for a new data layer — correctly       ║
 * ║  wired to layerManager, config.js, and the vg1: event   ║
 * ║  system. Ready to fill in with actual data logic.        ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * Usage:
 *   node layer-scaffolder.js --name lightning --category atmosphere
 *   node layer-scaffolder.js --name telluric  --category geomagnetic
 *   node layer-scaffolder.js --name acled     --category human
 *
 * Categories: surface | atmosphere | geomagnetic | space | human
 *
 * Outputs:
 *   ../[name]Manager.js         — new manager file
 *   (patches config.js with a new constant group)
 */

import Anthropic from '@anthropic-ai/sdk';
import fs        from 'fs';
import path      from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT   = path.join(__dirname, '..');
const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── CLI args ──────────────────────────────────────────────────────────────────
function getArg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
}
const LAYER_NAME = getArg('--name');
const CATEGORY   = getArg('--category') || 'atmosphere';

if (!LAYER_NAME) {
  console.error('Usage: node layer-scaffolder.js --name <layerName> --category <category>');
  console.error('  Categories: surface | atmosphere | geomagnetic | space | human');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable not set.');
  process.exit(1);
}

const MANAGER_NAME = LAYER_NAME.charAt(0).toUpperCase() + LAYER_NAME.slice(1) + 'Manager';
const FILE_NAME    = LAYER_NAME + 'Manager.js';
const CONST_GROUP  = LAYER_NAME.toUpperCase();

// ── Template files to read as examples ───────────────────────────────────────
const TEMPLATE_FILES = ['gfsWindManager.js', 'gpsJammingManager.js', 'spaceWeatherManager.js'];

function readTemplate(name) {
  const p = path.join(PROJECT, name);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

function readConfig() {
  return fs.readFileSync(path.join(PROJECT, 'config.js'), 'utf8');
}

function log(msg) { console.log(`[SCAFFOLD] ${msg}`); }
function ok(msg)  { console.log(`\x1b[32m✓  ${msg}\x1b[0m`); }

// ── Category-specific hints ───────────────────────────────────────────────────
const CATEGORY_HINTS = {
  surface:      'This layer renders terrain, infrastructure, or political boundary data.',
  atmosphere:   'This layer renders atmospheric phenomena like weather, lightning, or clouds. It should respond to altitude changes (visible above y=30, may fade below).',
  geomagnetic:  'This layer renders geomagnetic data like field lines, currents, or ionospheric data. Uses arc/line geometry. Should integrate with spaceWeatherManager data.',
  space:        'This layer renders space domain objects like satellites, magnetosphere, or solar wind. Objects exist at very high altitude (y > 100).',
  human:        'This layer renders human/operational intelligence data — GPS jamming zones, EM warfare, infrastructure events. Uses polygon/heatmap geometry on the surface.',
};

// ── Config patch ──────────────────────────────────────────────────────────────
function patchConfig(configContent, layerName, constGroup) {
  const newBlock = `
// ${layerName}Manager constants
export const ${constGroup} = {
    ENABLED:        true,
    OPACITY:        0.8,
    UPDATE_INTERVAL_MS: 30_000,   // how often to refresh data
    MAX_OBJECTS:    500,          // instanced mesh budget
    FADE_START:     200,          // camera.y above which layer fades out
    FADE_END:       220,          // camera.y above which layer is fully hidden
};
`;
  // Append before the last export (or at end)
  const lastExport = configContent.lastIndexOf('\nexport ');
  if (lastExport === -1) return configContent + newBlock;
  return configContent.slice(0, lastExport) + newBlock + configContent.slice(lastExport);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log(`Scaffolding "${LAYER_NAME}Manager.js" (category: ${CATEGORY})…`);

  // Read templates
  const templates = TEMPLATE_FILES
    .map(f => ({ name: f, code: readTemplate(f) }))
    .filter(t => t.code !== null);

  if (templates.length === 0) {
    console.error('Could not find any template manager files in the project.');
    process.exit(1);
  }

  const configContent = readConfig();
  const categoryHint  = CATEGORY_HINTS[CATEGORY] || '';

  log(`Read ${templates.length} template files. Calling Claude to generate scaffold…`);

  // Build the prompt
  const templateDocs = templates.map(t =>
    `=== ${t.name} ===\n${t.code.slice(0, 3000)}\n[... truncated ...]`
  ).join('\n\n');

  const configSnippet = configContent.slice(0, 2000);

  const prompt = `You are an expert Three.js developer working on Vanguard1, a 3D tactical intelligence map.

The architecture rules are:
- Each layer lives in its own *Manager.js file
- Managers register with layerManager using layerManager.register({ id, label, category, defaultOn })
- Managers listen to window.addEventListener('vg1:layerChanged', ...) events to toggle visibility
- Managers NEVER import other manager files — they communicate via CustomEvents on window
- New constants go in config.js under a named group: export const ${CONST_GROUP} = { KEY: val }
- update()/tick() methods must not create new THREE objects — use module-scope scratch vars
- No DOM queries in update loops

Category hint: ${categoryHint}

Here are example manager files to follow as templates:

${templateDocs}

Here is the beginning of config.js so you can see the naming convention:

${configSnippet}

Now generate a COMPLETE, production-ready scaffold for a new manager called "${MANAGER_NAME}" for the "${LAYER_NAME}" layer in the "${CATEGORY}" category.

Requirements:
1. Full ES module with proper imports from Three.js and config.js
2. Exported class ${MANAGER_NAME} with: constructor(), init(scene), update(camera, dt), dispose()
3. layerManager.register() call in init() with correct category
4. vg1:layerChanged event listener that toggles layer visibility
5. Module-scope scratch THREE.Vector3 vars (no allocations in update())
6. A placeholder _fetchData() method with a comment about what real API to call
7. Instanced mesh or Points geometry (whichever fits the category)
8. Fade based on camera.y using ${CONST_GROUP}.FADE_START / FADE_END
9. All constants referenced from config.js ${CONST_GROUP} group
10. JSDoc comments on all public methods

Output ONLY the JavaScript file contents, no markdown fences.`;

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  const generatedCode = response.content[0].text.trim();

  // Write the manager file
  const outPath = path.join(PROJECT, FILE_NAME);
  if (fs.existsSync(outPath)) {
    const backup = outPath.replace('.js', '.backup.js');
    fs.copyFileSync(outPath, backup);
    log(`Existing file backed up → ${path.basename(backup)}`);
  }
  fs.writeFileSync(outPath, generatedCode, 'utf8');
  ok(`Generated: ${FILE_NAME}`);

  // Patch config.js
  const configPath    = path.join(PROJECT, 'config.js');
  const patchedConfig = patchConfig(configContent, LAYER_NAME, CONST_GROUP);
  fs.writeFileSync(configPath, patchedConfig, 'utf8');
  ok(`config.js patched with ${CONST_GROUP} constants`);

  // Print next steps
  console.log('\n────────────────────────────────────────────────');
  console.log('  Next steps:');
  console.log(`  1. Open ${FILE_NAME} and fill in _fetchData()`);
  console.log(`  2. Import and instantiate in main.js:`);
  console.log(`       import { ${MANAGER_NAME} } from './${FILE_NAME}';`);
  console.log(`       const ${LAYER_NAME}Manager = new ${MANAGER_NAME}();`);
  console.log(`       await ${LAYER_NAME}Manager.init(scene);`);
  console.log(`  3. Add to the animation loop:`);
  console.log(`       ${LAYER_NAME}Manager.update(camera, delta);`);
  console.log(`  4. Add to layerManager in index.html for UI toggle`);
  console.log('────────────────────────────────────────────────');
}

main().catch(err => { console.error('[SCAFFOLD] Fatal:', err); process.exit(1); });
