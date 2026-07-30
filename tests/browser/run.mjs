// tests/browser/run.mjs — drive the browser parity harness in headless Chromium.
//
// Run from repo root:  node tests/browser/run.mjs
//
// WHY: every other test in the suite runs in Node against tests/_stubs/xmlDom.mjs.
// Production uses the browser's native DOMParser and real localStorage. This
// closes that gap — it loads the actual ES modules over a real HTTP origin (so
// module resolution and localStorage both behave as they do in the app) and
// reports any divergence.
//
// Requires playwright. Skips with exit 0 and a clear message if it is absent, so
// the suite stays runnable on a machine without it.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8791;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.mjs':  'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.xml':  'application/xml; charset=utf-8',
};

const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        // Contain path traversal — this serves the repo root.
        const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
        const file = join(ROOT, rel);
        if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
        const body = await readFile(file);
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
    } catch {
        res.writeHead(404).end('not found');
    }
});

let chromium;
try {
    ({ chromium } = await import('playwright'));
} catch {
    console.log('browser parity: SKIPPED (playwright not installed)');
    process.exit(0);
}

await new Promise(r => server.listen(PORT, r));

// Honour a preinstalled Chromium when the environment provides one whose build
// number does not match this playwright package (CI images commonly pin one).
// Without this, launch() goes looking for a build it will never find.
const launchOpts = {};
if (process.env.VG1_CHROMIUM) launchOpts.executablePath = process.env.VG1_CHROMIUM;

let browser;
try {
    browser = await chromium.launch(launchOpts);
} catch (e) {
    if (/Executable doesn't exist/.test(e.message) && !launchOpts.executablePath) {
        console.log('browser parity: SKIPPED (no Chromium binary; set VG1_CHROMIUM to one)');
        server.close();
        process.exit(0);
    }
    throw e;
}
const page = await browser.newPage();

// A module-level exception (bad import, syntax error) leaves the harness
// green-but-empty, so page errors are failures in their own right. The one
// exception is the browser's automatic favicon request, which this static
// server has no reason to satisfy and which says nothing about the code.
const IGNORABLE = /favicon\.ico/;
// Chromium's console line for an HTTP error does NOT include the URL — it is
// always the bare "Failed to load resource: …status of 404…", so it cannot be
// filtered by target and cannot be attributed to a file. The 'response' handler
// below sees the URL and is authoritative for HTTP status; dropping the
// unattributable console duplicate here avoids a permanent false failure from
// the browser's automatic favicon request while still failing on any real 404.
const UNATTRIBUTABLE = /^Failed to load resource:/;
const consoleErrors = [];
page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (IGNORABLE.test(t) || UNATTRIBUTABLE.test(t)) return;
    consoleErrors.push(t);
});
page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));
page.on('requestfailed', r => {
    if (!IGNORABLE.test(r.url())) consoleErrors.push(`request failed: ${r.url()}`);
});
// A 404 is a *successful* HTTP exchange, so it never reaches 'requestfailed',
// and the console message it produces does not name the URL. Catch it here
// instead — a missing module is precisely the failure this harness exists for.
page.on('response', r => {
    if (r.status() >= 400 && !IGNORABLE.test(r.url())) {
        consoleErrors.push(`HTTP ${r.status()} ${r.url()}`);
    }
});

// Harnesses to run, in order. The render one needs WebGL and a local copy of
// three (the app's import map points at a CDN, unreachable from a sandbox), so
// it self-skips if either is missing rather than failing the suite.
const HARNESSES = [
    { file: 'rtzBrowserParity.html',
      label: 'browser parity (native DOMParser + real localStorage)' },
    { file: 'routeLayerRender.html',
      label: 'route layer render (real WebGL2 + real THREE)',
      needs: 'node_modules/three/build/three.module.js',
      shot: 'tests/browser/_routeLayer.png' },
    { file: 'stmPanelDom.html',
      label: 'STM panel — DOM, import and drag overlay' },
    { file: 'stmWiring.html',
      label: 'STM wiring — the main.js / index.html integration itself',
      needs: 'node_modules/three/build/three.module.js' },
    { file: 'stmIntegration.html',
      label: 'STM integration — full pipeline, 15-hour voyage, nothing mocked',
      needs: 'node_modules/three/build/three.module.js',
      shot: 'tests/browser/_stmIntegration.png',
      timeline: true },
];

let results = [];
let fatal = null;
const sections = [];
try {
    for (const h of HARNESSES) {
        if (h.needs) {
            try { await readFile(join(ROOT, h.needs)); }
            catch {
                sections.push({ label: h.label, skipped: `missing ${h.needs} — run: npm install three` });
                continue;
            }
        }
        consoleErrors.length = 0;
        await page.goto(`http://localhost:${PORT}/tests/browser/${h.file}`, { waitUntil: 'load' });
        await page.waitForFunction(() => window.__DONE__ === true, null, { timeout: 30000 });
        const r = await page.evaluate(() => window.__RESULTS__);
        const stats = await page.evaluate(() => window.__STATS__ ?? null);
        const timeline = h.timeline ? await page.evaluate(() => window.__TIMELINE__ ?? null) : null;
        if (h.shot) await page.screenshot({ path: join(ROOT, h.shot) });
        sections.push({ label: h.label, results: r, stats, timeline, errors: [...consoleErrors] });
        results = results.concat(r);
    }
} catch (e) {
    fatal = e.message;
}

await browser.close();
server.close();

for (const s of sections) {
    console.log(`\n${s.label}`);
    if (s.skipped) { console.log(`  — SKIPPED: ${s.skipped}`); continue; }
    for (const r of s.results) {
        if (r.ok) console.log(`  ✓ ${r.name}`);
        else console.error(`  ✗ ${r.name}\n    ${r.error}`);
    }
    if (s.stats?.litFraction != null) {
        console.log(`  · lit pixels ${(s.stats.litFraction * 100).toFixed(3)}% · ` +
                    `peak luminance ${s.stats.maxLum.toFixed(3)} (bloom threshold 0.95)`);
    }
    if (s.stats?.ticks != null) {
        console.log(`  · ${s.stats.ticks.toLocaleString()} monitor ticks · ` +
                    `${s.stats.alerts} alerts · ` +
                    `${s.stats.coverage.monitored}/${s.stats.coverage.total} monitored`);
    }
    if (s.errors?.length) console.error('  ✗ page errors:\n    ' + s.errors.join('\n    '));
}
console.log('');

if (fatal) {
    console.error(`  ✗ harness failed to complete: ${fatal}`);
    if (consoleErrors.length) console.error('  page errors:\n    ' + consoleErrors.join('\n    '));
    process.exit(1);
}

const failed = results.filter(r => !r.ok).length +
               sections.reduce((a, s) => a + (s.errors?.length ? 1 : 0), 0);

console.log(`browser: ${results.length - failed}/${results.length} checks passed` +
            (sections.some(s => s.skipped) ? ' (some harnesses skipped)' : ''));
process.exit(failed ? 1 : 0);
