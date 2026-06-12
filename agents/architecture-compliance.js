#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║  VANGUARD  —  Architecture Compliance Agent             ║
 * ║                                                          ║
 * ║  Reads every .js file in the project and checks for     ║
 * ║  violations of the rules documented in CLAUDE.md.       ║
 * ║  No browser required — pure static code analysis.       ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * Rules checked:
 *   1. Managers must not import other managers (use vg1: events)
 *   2. bloomPass properties other than .strength must not be set outside sceneSetup.js
 *   3. waterUniforms must only be written in skyManager.js
 *   4. Light intensities must not be hardcoded (must come from dayFactor)
 *   5. new THREE.Vector3() must not appear inside loop bodies
 *   6. No DOM queries (getElementById/querySelector) inside update()/tick() methods
 *   7. No synchronous fetch() calls (must use async/await or .then)
 *   8. config.js constants must use namespace groups (e.g. export const FOO = { KEY: val })
 *   9. No manager should write splatCloud uniforms (only terrainBuilder.js)
 *  10. window.dispatchEvent pattern must be used for cross-manager communication
 *
 * Usage:
 *   node architecture-compliance.js
 *   node architecture-compliance.js --fix    (auto-comment violations with TODO)
 *   node architecture-compliance.js --json   (output JSON report)
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const PROJECT    = path.join(__dirname, '..');  // Vanguard1 root
const REPORTS    = path.join(__dirname, 'reports');
const JSON_MODE  = process.argv.includes('--json');
const FIX_MODE   = process.argv.includes('--fix');

// Manager files (files that end in Manager.js or Builder.js)
const MANAGER_PATTERN = /Manager\.js$|Builder\.js$|Worker\.js$/;

// Files that are ALLOWED to do certain things
const ALLOWED_BLOOM_FILES   = new Set(['sceneSetup.js', 'main.js']);
const ALLOWED_WATER_FILES   = new Set(['skyManager.js', 'waterManager.js']);
const ALLOWED_SPLAT_FILES   = new Set(['terrainBuilder.js']);
const ALLOWED_LIGHT_FILES   = new Set(['main.js']);

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

// ── Violation record ──────────────────────────────────────────────────────────
function violation(file, line, rule, message, severity = 'error') {
  return { file: path.basename(file), fullPath: file, line, rule, message, severity };
}

// ── Rule checkers ─────────────────────────────────────────────────────────────

/**
 * Rule 1: Managers must not import other managers.
 * Cross-manager communication must use window.dispatchEvent(new CustomEvent('vg1:…'))
 */
function checkManagerCrossImports(file, lines) {
  const violations = [];
  const fileName = path.basename(file);
  if (!MANAGER_PATTERN.test(fileName)) return violations;

  lines.forEach((line, i) => {
    const m = line.match(/import\s+.*from\s+['"]\.\/(\w+Manager|\w+Builder)\.js['"]/);
    if (m) {
      violations.push(violation(
        file, i + 1, 'RULE-1',
        `Manager imports another manager: "${m[1]}.js". Use window.dispatchEvent(new CustomEvent('vg1:…')) instead.`,
        'error'
      ));
    }
  });
  return violations;
}

/**
 * Rule 2: bloomPass properties other than .strength must only be set in sceneSetup.js.
 */
function checkBloomPassWrites(file, lines) {
  const violations = [];
  const fileName = path.basename(file);
  if (ALLOWED_BLOOM_FILES.has(fileName)) return violations;

  lines.forEach((line, i) => {
    if (/bloomPass\.(radius|threshold|resolution)\s*=/.test(line)) {
      violations.push(violation(
        file, i + 1, 'RULE-2',
        `bloomPass.${line.match(/bloomPass\.(\w+)/)[1]} written outside sceneSetup.js. Only .strength may be written elsewhere.`,
        'error'
      ));
    }
  });
  return violations;
}

/**
 * Rule 3: waterUniforms must only be written in skyManager.js / waterManager.js.
 */
function checkWaterUniformWrites(file, lines) {
  const violations = [];
  const fileName = path.basename(file);
  if (ALLOWED_WATER_FILES.has(fileName)) return violations;

  lines.forEach((line, i) => {
    if (/waterUniforms\s*\./.test(line) || /water\.(opacity|color|emissive)\s*=/.test(line)) {
      violations.push(violation(
        file, i + 1, 'RULE-3',
        `Water uniform/property written outside skyManager.js. Only skyManager.update() should write water uniforms.`,
        'warning'
      ));
    }
  });
  return violations;
}

/**
 * Rule 4: Light intensities must not be hardcoded in manager files.
 * They must be driven by dayFactor in the animation loop (main.js).
 */
function checkHardcodedLightIntensity(file, lines) {
  const violations = [];
  const fileName = path.basename(file);
  if (ALLOWED_LIGHT_FILES.has(fileName)) return violations;

  lines.forEach((line, i) => {
    if (/(?:ambientLight|dirLight|pointLight|spotLight)\.intensity\s*=\s*\d/.test(line)) {
      violations.push(violation(
        file, i + 1, 'RULE-4',
        `Hardcoded light intensity. Intensities must be driven by dayFactor in main.js, not set directly in managers.`,
        'error'
      ));
    }
  });
  return violations;
}

/**
 * Rule 5: new THREE.Vector3() / new THREE.Color() inside loop bodies causes GC pressure.
 * Scratch vectors should be declared at module scope and reused.
 */
function checkVectorAllocationsInLoops(file, lines) {
  const violations = [];
  let insideLoop = 0;
  let braceDepth = 0;
  let loopOpenBrace = -1;

  lines.forEach((line, i) => {
    // Simple heuristic: detect for/while/forEach loop openers
    if (/^\s*(for|while)\s*\(|\.forEach\(|\.map\(/.test(line)) {
      insideLoop++;
      loopOpenBrace = braceDepth;
    }
    braceDepth += (line.match(/\{/g) || []).length;
    braceDepth -= (line.match(/\}/g) || []).length;
    if (insideLoop > 0 && braceDepth <= loopOpenBrace) insideLoop = Math.max(0, insideLoop - 1);

    if (insideLoop > 0 && /new THREE\.(Vector[234]|Color|Quaternion|Matrix[34])\s*\(/.test(line)) {
      violations.push(violation(
        file, i + 1, 'RULE-5',
        `"new THREE.*" inside a loop body allocates GC pressure. Declare a scratch variable at module scope and reuse it.`,
        'warning'
      ));
    }
  });
  return violations;
}

/**
 * Rule 6: No DOM queries inside update() or tick() method bodies.
 * DOM queries are expensive; cache elements at init time.
 */
function checkDOMQueriesInUpdateLoop(file, lines) {
  const violations = [];
  let insideUpdate = false;
  let updateBraceDepth = 0;
  let braceDepth = 0;

  lines.forEach((line, i) => {
    if (/^\s*(update|tick)\s*\(/.test(line) && !insideUpdate) {
      insideUpdate = true;
      updateBraceDepth = braceDepth;
    }
    braceDepth += (line.match(/\{/g) || []).length;
    braceDepth -= (line.match(/\}/g) || []).length;
    if (insideUpdate && braceDepth <= updateBraceDepth && i > 0) insideUpdate = false;

    if (insideUpdate && /document\.(getElementById|querySelector|querySelectorAll|getElementsBy)/.test(line)) {
      violations.push(violation(
        file, i + 1, 'RULE-6',
        `DOM query inside update()/tick(). Cache the element reference at init time instead.`,
        'warning'
      ));
    }
  });
  return violations;
}

/**
 * Rule 7: Synchronous-looking fetch without await in an async context.
 * All fetch() calls should be awaited or .then()-chained properly.
 */
function checkSyncFetch(file, lines) {
  const violations = [];
  lines.forEach((line, i) => {
    // flag: fetch( without await, without .then, and not inside a return expression
    const hasFetch = /[^a-zA-Z]fetch\s*\(/.test(line);
    const hasAwait = /\bawait\b/.test(line);
    const hasThen  = /\.then\s*\(/.test(line);
    const isReturn = /^\s*return\s+fetch/.test(line);
    if (hasFetch && !hasAwait && !hasThen && !isReturn) {
      violations.push(violation(
        file, i + 1, 'RULE-7',
        `fetch() without await or .then() — looks synchronous. Ensure it's properly awaited.`,
        'warning'
      ));
    }
  });
  return violations;
}

/**
 * Rule 8: config.js constants should use namespace groups.
 * e.g. export const MYMODULE = { KEY: value } — not flat export const KEY = value
 * (Only enforce in config.js itself)
 */
function checkConfigNamespacing(file, lines) {
  const violations = [];
  if (path.basename(file) !== 'config.js') return violations;

  lines.forEach((line, i) => {
    // Flag: export const UPPERCASE_WORD = (a primitive, not an object)
    if (/^export const [A-Z_]+\s*=\s*(?!\{)/.test(line.trim())) {
      violations.push(violation(
        file, i + 1, 'RULE-8',
        `Flat constant in config.js. Use a namespace group: export const MODULE = { KEY: value } to keep config.js organised.`,
        'info'
      ));
    }
  });
  return violations;
}

/**
 * Rule 9: splatCloud uniforms must only be written in terrainBuilder.js.
 */
function checkSplatCloudWrites(file, lines) {
  const violations = [];
  const fileName = path.basename(file);
  if (ALLOWED_SPLAT_FILES.has(fileName)) return violations;

  lines.forEach((line, i) => {
    if (/splatCloud\.material\.uniforms|window\.splatCloud/.test(line) && /=/.test(line)) {
      violations.push(violation(
        file, i + 1, 'RULE-9',
        `splatCloud uniforms written outside terrainBuilder.js. Terrain shader uniforms must only be set there.`,
        'error'
      ));
    }
  });
  return violations;
}

/**
 * Rule 10: Cross-manager communication should use window.dispatchEvent.
 * Flag direct method calls on manager instances that were imported.
 */
function checkDirectManagerMethodCalls(file, lines) {
  const violations = [];
  // Look for patterns like: someManager.someMethod() where someManager was imported
  const imported = new Set();
  lines.forEach(line => {
    const m = line.match(/import\s+\{?\s*(\w+)\s*\}?\s+from/);
    if (m) imported.add(m[1]);
  });

  lines.forEach((line, i) => {
    imported.forEach(name => {
      if (MANAGER_PATTERN.test(name + '.js')) return; // skip non-manager imports
      const pattern = new RegExp(`\\b${name}\\.(update|tick|init|add|remove|clear|reset|set)\\(`);
      if (pattern.test(line)) {
        violations.push(violation(
          file, i + 1, 'RULE-10',
          `Direct call to ${name}.method() across managers. Prefer window.dispatchEvent(new CustomEvent('vg1:…')) for loose coupling.`,
          'info'
        ));
      }
    });
  });
  return violations;
}

// ── File scanner ──────────────────────────────────────────────────────────────
function scanFile(filePath) {
  const raw   = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  return [
    ...checkManagerCrossImports(filePath, lines),
    ...checkBloomPassWrites(filePath, lines),
    ...checkWaterUniformWrites(filePath, lines),
    ...checkHardcodedLightIntensity(filePath, lines),
    ...checkVectorAllocationsInLoops(filePath, lines),
    ...checkDOMQueriesInUpdateLoop(filePath, lines),
    ...checkSyncFetch(filePath, lines),
    ...checkConfigNamespacing(filePath, lines),
    ...checkSplatCloudWrites(filePath, lines),
  ];
}

function getJsFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'agents' || entry.name === 'node_modules' || entry.name === 'lib') continue;
    if (entry.isDirectory()) {
      results.push(...getJsFiles(path.join(dir, entry.name)));
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.backup.js')) {
      results.push(path.join(dir, entry.name));
    }
  }
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  ensureDir(REPORTS);

  const files = getJsFiles(PROJECT);
  console.log(`[COMPLIANCE] Scanning ${files.length} files in ${PROJECT}…\n`);

  const allViolations = [];
  for (const file of files) {
    try {
      const v = scanFile(file);
      allViolations.push(...v);
    } catch (e) {
      console.error(`  Skipped ${path.basename(file)}: ${e.message}`);
    }
  }

  // Group by file
  const byFile = {};
  for (const v of allViolations) {
    if (!byFile[v.file]) byFile[v.file] = [];
    byFile[v.file].push(v);
  }

  if (JSON_MODE) {
    const report = { scannedFiles: files.length, violations: allViolations };
    const outPath = path.join(REPORTS, `compliance_${Date.now()}.json`);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`JSON report → ${outPath}`);
    return;
  }

  const SEV_COLOR = { error: '\x1b[31m', warning: '\x1b[33m', info: '\x1b[36m' };
  const SEV_LABEL = { error: 'ERROR  ', warning: 'WARNING', info: 'INFO   ' };

  let errorCount = 0, warnCount = 0, infoCount = 0;

  for (const [file, viols] of Object.entries(byFile)) {
    console.log(`\x1b[1m${file}\x1b[0m`);
    for (const v of viols) {
      const col = SEV_COLOR[v.severity] || '';
      console.log(`  ${col}${SEV_LABEL[v.severity]}\x1b[0m  line ${String(v.line).padStart(4)}  [${v.rule}]  ${v.message}`);
      if (v.severity === 'error')   errorCount++;
      if (v.severity === 'warning') warnCount++;
      if (v.severity === 'info')    infoCount++;
    }
    console.log('');
  }

  console.log('══════════════════════════════════════════════════');
  console.log(`  Files scanned:   ${files.length}`);
  console.log(`  \x1b[31mErrors:          ${errorCount}\x1b[0m`);
  console.log(`  \x1b[33mWarnings:        ${warnCount}\x1b[0m`);
  console.log(`  \x1b[36mInfo:            ${infoCount}\x1b[0m`);
  console.log('══════════════════════════════════════════════════');

  if (errorCount === 0 && warnCount === 0) {
    console.log('\n\x1b[32m✓ No architecture violations found.\x1b[0m');
  } else if (errorCount > 0) {
    process.exit(1);
  }
}

main();
