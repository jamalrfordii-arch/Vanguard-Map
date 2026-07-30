// tests/moduleGraph.test.mjs — the module graph must actually link.
// Run from repo root:  node tests/moduleGraph.test.mjs
//
// WHY THIS EXISTS (2026-07-30). Two defects with the same signature cost an
// evening, and neither was findable by reading the file that contained it:
//
//   1. portActivityManager.js imported { PORTWATCH } from config.js, and the
//      PORTWATCH block had been lost in a later rewrite of config.js.
//   2. lightningManager.js was truncated mid-shader and did not parse. It had
//      been that way since the baseline commit (05ed8b5, 2026-06-12) — the only
//      commit that ever touched it. RETIRED 2026-07-30: moved to _to_delete/
//      along with the LIGHTNING block in config.js it was written against, whose
//      twenty keys config.js never actually had. Nothing imported it and
//      nothing ever could have.
//
// A missing named export is an ES-module INSTANTIATION failure. It happens
// before any code executes, so:
//
//   • no module in the graph runs — not even the entry point;
//   • start() never runs, so main.js's try/catch never fires;
//   • there is no "RESOURCES BLOCKED" screen and no window.__bootError;
//   • the initial loading screen simply sits there, forever.
//
// That is the worst possible failure shape: total, silent, and indistinguishable
// from a slow network. Both defects were invisible only because nothing imports
// those two modules YET. Wire either one in and the app dies with no clue.
//
// So this test does not ask "does the app boot" — it asks the cheaper, stricter
// question: does every module PARSE, and does every local named import resolve
// to a name the target module actually exports. Both landmines above fail it.
//
// ── Two deliberate design choices ────────────────────────────────────────────
//
// PARSE IN PLACE, never via a temp copy. `node --check` picks its parse goal
// (module vs script) from the nearest package.json. Ours says type:module, so a
// file checked at its real path is parsed the way the BROWSER will parse it.
// Copying it to /tmp first silently switches the parser to script mode, and
// observed 2026-07-30: the truncated lightningManager.js *passes* --check in
// script mode and fails in module mode. A checker that copies files is a checker
// that lies.
//
// KNOWN_BROKEN cannot rot. Each entry is asserted to STILL be broken. Fix the
// file and this test fails until you delete its entry — an allow-list that
// silently outlives its reason is how the original problem hid in the first
// place.
//
// ── What this test does NOT do ───────────────────────────────────────────────
//   • It is not a parser. Imports are matched by a deliberately narrow regex
//     (see CLAUSE_OK) that only accepts real import clauses. It can miss an
//     exotic form — a false NEGATIVE. It cannot invent one: any hit it reports
//     names a specific module, specifier and identifier that a human can check
//     in seconds. Noise, never silence.
//   • Bare specifiers ('three', '3d-tiles-renderer') are skipped — they resolve
//     through index.html's importmap to a CDN, which a test cannot see.
//   • Dynamic import() specifiers are followed for REACHABILITY, but a template
//     literal specifier cannot be resolved statically and is ignored.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = 'main.js';

// Modules that are known-broken, WITH the reason and what to do. Every entry is
// re-verified below: if it starts passing, this test fails and tells you to
// remove it. Do not add an entry without a diagnosis.
// EMPTY BY DESIGN, and it should stay that way. The single entry this list was
// built for — lightningManager.js — was retired on 2026-07-30 rather than
// finished, which is the outcome an allow-list like this is supposed to force:
// name the broken thing, and the naming makes someone decide about it.
// Adding an entry here is a commitment to fix or remove the file, not a way to
// make the suite green.
const KNOWN_BROKEN = {};

// Stale hand-made backups. Excluded from the graph on purpose — a backup is
// allowed to rot. Listed at the end so they do not rot invisibly.
const isBackup = (f) => /\.bak$/.test(f) || /\.backup\.js$/.test(f);

// macOS AppleDouble resource forks: `._foo.js`, 4 KB of binary metadata that a
// non-Mac filesystem leaves behind next to every real file. They are not
// modules, they are not source, nothing can import them, and they will never
// parse. Excluded by NAME rather than by "it failed to parse", because the whole
// point of this test is that a file which fails to parse is a finding.
const isAppleDouble = (f) => f.startsWith('._');

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// ── Source reading, with comments removed ────────────────────────────────────
// Block comments go first. Line comments are only stripped when the `//` starts
// the line, because this codebase is full of strings like
// 'http://localhost:8787' and a naive strip would turn one into a syntax hazard
// and, worse, could fabricate a `from '...'` match out of the wreckage.
const srcCache = new Map();
function source(rel) {
    if (srcCache.has(rel)) return srcCache.get(rel);
    const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const clean = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    srcCache.set(rel, clean);
    return clean;
}

// ── Import extraction ────────────────────────────────────────────────────────
// A real import clause contains ONLY identifiers, braces, commas, stars and
// whitespace. Requiring that is what makes this precise: a greedy span that ran
// past the end of a statement would pick up a quote, a semicolon or a paren and
// be rejected here. (An earlier, looser version of this check reported three
// false positives in this very repo — main.js/terrainBuilder.js,
// scenarioRoute.js/config.js, voyagePlanStore.js/config.js — all of them a span
// that had swallowed a neighbouring line.)
const CLAUSE_OK = /^[\sA-Za-z0-9_$,{}*]*$/;
const IMPORT_RE = /^[ \t]*import\b([\s\S]*?)\bfrom\s*['"]([^'"]+)['"]/gm;
const REEXPORT_RE = /^[ \t]*export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm;
const EXPORT_STAR_RE = /^[ \t]*export\s*\*\s*(?:as\s+[A-Za-z0-9_$]+\s+)?from\s*['"]([^'"]+)['"]/gm;
const SIDE_EFFECT_RE = /^[ \t]*import\s*['"]([^'"]+)['"]/gm;
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const isLocal = (spec) => spec.startsWith('./') || spec.startsWith('../');
const namesIn = (braced) => braced.split(',')
    .map((p) => p.trim()).filter(Boolean)
    .map((p) => p.split(/\s+as\s+/)[0].trim());

/** Every local specifier a module references, static or dynamic. */
function edgesOf(rel) {
    const s = source(rel);
    const out = new Set();
    for (const m of s.matchAll(IMPORT_RE)) {
        // CLAUSE_OK here too, not just in §3. Without it, a dynamic `import(...)`
        // sitting at the start of a line can pair with a `from '...'` further down
        // and manufacture a specifier that resolves to nothing — which §2 would
        // then report as a missing file. A false failure in the checker is worse
        // than a missed edge, because it teaches people to ignore the checker.
        if (CLAUSE_OK.test(m[1]) && isLocal(m[2])) out.add(m[2]);
    }
    for (const re of [REEXPORT_RE, EXPORT_STAR_RE, SIDE_EFFECT_RE, DYNAMIC_RE]) {
        for (const m of s.matchAll(re)) {
            const spec = m[m.length - 1];
            if (isLocal(spec)) out.add(spec);
        }
    }
    return [...out];
}

/** What a module exports, following `export * from` transitively. */
const exportCache = new Map();
function exportsOf(rel, seen = new Set()) {
    if (exportCache.has(rel)) return exportCache.get(rel);
    if (seen.has(rel)) return new Set();            // cycle guard
    seen.add(rel);
    const s = source(rel);
    const names = new Set();
    for (const m of s.matchAll(/\bexport\s+(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([A-Za-z0-9_$]+)/g)) {
        names.add(m[1]);
    }
    for (const m of s.matchAll(/\bexport\s*\{([^}]*)\}(?!\s*from)/g)) {
        // `export { a as default }` — the exported name is what follows `as`.
        m[1].split(',').map((p) => p.trim()).filter(Boolean).forEach((p) => {
            const parts = p.split(/\s+as\s+/);
            names.add((parts[1] ?? parts[0]).trim());
        });
    }
    for (const m of s.matchAll(REEXPORT_RE)) {
        m[1].split(',').map((p) => p.trim()).filter(Boolean).forEach((p) => {
            const parts = p.split(/\s+as\s+/);
            names.add((parts[1] ?? parts[0]).trim());
        });
    }
    if (/\bexport\s+default\b/.test(s)) names.add('default');
    for (const m of s.matchAll(EXPORT_STAR_RE)) {
        const t = resolve(rel, m[1]);
        if (t) for (const n of exportsOf(t, seen)) if (n !== 'default') names.add(n);
    }
    exportCache.set(rel, names);
    return names;
}

/** Resolve a relative specifier to a repo-relative path, or null if absent. */
function resolve(fromRel, spec) {
    const p = path.relative(ROOT, path.resolve(path.dirname(path.join(ROOT, fromRel)), spec));
    return fs.existsSync(path.join(ROOT, p)) ? p.split(path.sep).join('/') : null;
}

// ── The scanned set: every module in the repo root ───────────────────────────
const allRoot = fs.readdirSync(ROOT);
const rootModules = allRoot
    .filter((f) => f.endsWith('.js') && !isBackup(f) && !isAppleDouble(f))
    .sort();
const backups = allRoot.filter((f) => isBackup(f) && !isAppleDouble(f)).sort();
const appleDoubles = allRoot.filter(isAppleDouble).length;

// ── Reachability from the entry point ────────────────────────────────────────
// Partitions every failure into "breaks the app right now" and "breaks the app
// the moment it is wired in". Both matter; they are not equally urgent, and
// conflating them is why the two landmines sat unnoticed.
const reachable = new Set();
(function walk(rel) {
    if (reachable.has(rel)) return;
    reachable.add(rel);
    for (const spec of edgesOf(rel)) {
        const t = resolve(rel, spec);
        if (t && t.endsWith('.js') && !reachable.has(t)) walk(t);
    }
})(ENTRY);

const where = (f) => (reachable.has(f) ? 'BOOT GRAPH' : 'orphan');

console.log(`module graph: ${rootModules.length} root modules, `
          + `${reachable.size} reachable from ${ENTRY}, ${backups.length} backups skipped`
          + (appleDoubles ? `, ${appleDoubles} macOS ._ forks ignored` : ''));

// ── 1. Every module parses, in module mode, at its real path ─────────────────
const CONCURRENCY = 16;
const parseErrors = new Map();
{
    const queue = [...rootModules];
    const workers = Array.from({ length: CONCURRENCY }, async () => {
        for (let f = queue.pop(); f; f = queue.pop()) {
            try {
                await execFileP(process.execPath, ['--check', path.join(ROOT, f)]);
            } catch (e) {
                const msg = String(e.stderr || e.message).split('\n')
                    .find((l) => /Error/.test(l)) ?? 'parse failed';
                parseErrors.set(f, msg.trim());
            }
        }
    });
    await Promise.all(workers);
}

test('every module parses as an ES module', () => {
    const unexpected = [...parseErrors.keys()].filter((f) => !(f in KNOWN_BROKEN));
    assert.deepEqual(unexpected, [],
        'these do not parse — the app cannot boot if any is reachable:\n'
        + unexpected.map((f) => `      ${f} [${where(f)}]  ${parseErrors.get(f)}`).join('\n'));
});

test('KNOWN_BROKEN entries are still broken (delete the entry once fixed)', () => {
    const fixed = Object.keys(KNOWN_BROKEN).filter((f) => !parseErrors.has(f));
    assert.deepEqual(fixed, [],
        'these now parse — remove them from KNOWN_BROKEN:\n'
        + fixed.map((f) => `      ${f}`).join('\n'));
});

test('nothing broken is reachable from the entry point', () => {
    const live = [...parseErrors.keys()].filter((f) => reachable.has(f));
    assert.deepEqual(live, [],
        `these are BROKEN and imported from ${ENTRY} — the app is dead:\n`
        + live.map((f) => `      ${f}  ${parseErrors.get(f)}`).join('\n'));
});

// ── 2. Every local specifier points at a file that exists ───────────────────
const missingFiles = [];
for (const f of rootModules) {
    if (parseErrors.has(f)) continue;               // garbage in, garbage out
    for (const spec of edgesOf(f)) {
        if (!resolve(f, spec)) missingFiles.push({ f, spec });
    }
}

test('every local import specifier resolves to a real file', () => {
    assert.deepEqual(missingFiles, [],
        'missing files:\n' + missingFiles
            .map(({ f, spec }) => `      ${f} [${where(f)}]  →  ${spec}`).join('\n'));
});

// ── 3. Every named import exists in the target — THE PORTWATCH CHECK ─────────
const dangling = [];
for (const f of rootModules) {
    if (parseErrors.has(f)) continue;
    const s = source(f);

    for (const m of s.matchAll(IMPORT_RE)) {
        const clause = m[1], spec = m[2];
        if (!isLocal(spec) || !CLAUSE_OK.test(clause)) continue;
        const target = resolve(f, spec);
        if (!target) continue;                      // already reported in §2
        const have = exportsOf(target);
        const braced = clause.match(/\{([\s\S]*)\}/);
        const wanted = braced ? namesIn(braced[1]) : [];
        const bare = clause.replace(/\{[\s\S]*\}/, '').replace(/,/g, '').trim();
        if (bare && !bare.startsWith('*')) wanted.push('default');
        for (const w of wanted) {
            if (!have.has(w)) dangling.push({ f, spec, name: w });
        }
    }

    for (const m of s.matchAll(REEXPORT_RE)) {
        const target = resolve(f, m[2]);
        if (!target) continue;
        const have = exportsOf(target);
        for (const w of namesIn(m[1])) {
            if (!have.has(w)) dangling.push({ f, spec: m[2], name: w });
        }
    }
}

test('every local named import resolves to a real export', () => {
    assert.deepEqual(dangling, [],
        'DANGLING — each of these is a silent boot hang if reached '
        + '(no error screen, no window.__bootError, loading screen forever):\n'
        + dangling.map(({ f, spec, name }) =>
            `      ${f} [${where(f)}]  imports { ${name} }  from  ${spec}`).join('\n'));
});

// ── 3b. The specific regression, pinned by name ─────────────────────────────
// Generic checks are easy to weaken by accident. This one names the case that
// actually cost an evening, so a future refactor of the machinery above cannot
// quietly stop covering it.
test('regression: portActivityManager\'s config imports resolve', () => {
    const f = 'portActivityManager.js';
    if (!rootModules.includes(f)) return;           // deleted is fine
    const have = exportsOf('config.js');
    for (const m of source(f).matchAll(IMPORT_RE)) {
        if (resolve(f, m[2]) !== 'config.js') continue;
        const braced = m[1].match(/\{([\s\S]*)\}/);
        for (const w of (braced ? namesIn(braced[1]) : [])) {
            assert.ok(have.has(w),
                `config.js does not export ${w} — see KNOWN_BROKEN's sibling case, `
                + 'and note the PORTWATCH block was lost this way once already');
        }
    }
});

if (backups.length) {
    console.log(`\nskipped backups (not checked, allowed to rot): ${backups.join(', ')}`);
}
console.log(`\n${passed} checks passed`);
