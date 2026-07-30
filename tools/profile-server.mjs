#!/usr/bin/env node
// tools/profile-server.mjs — the dev server, plus one header.
//
// WHY THIS EXISTS. Chrome ships the JS Self-Profiling API (`new Profiler(...)`),
// which is a real sampling profiler you can drive from page script and read as
// data — function names, line numbers, self time. It is gated behind a
// permissions header, and refuses without it:
//
//     DOMException: Failed to construct 'Profiler':
//                   JS profiling is disabled by Document Policy.
//
// Whatever normally serves this repo on :3000 does not send that header, so the
// profiler cannot be constructed and the only frame-cost numbers available are
// coarse ones — wrap a function, time it, subtract. Good enough to say "the AIS
// layer costs 15 ms"; useless for saying which function inside it.
//
// This server is the smallest thing that closes that gap: the same static files,
// on a second port, with `Document-Policy: js-profiling`. Nothing else about the
// app changes. Run it alongside the normal one and profile at :3001; leave :3000
// exactly as it is for ordinary work.
//
//     node tools/profile-server.mjs            # :3001, serves the repo root
//     node tools/profile-server.mjs --port 4000 --root .
//
// Then, in the page:
//
//     const p = new Profiler({ sampleInterval: 5, maxBufferSize: 200000 });
//     // ... let it run a few seconds ...
//     const trace = await p.stop();   // { frames, resources, samples, stacks }
//
// `sampleInterval` is a REQUEST, not a promise — the browser clamps it, and
// `p.sampleInterval` after construction tells you what you actually got.
//
// ── Deliberate choices ──────────────────────────────────────────────────────
//
// NO-STORE ON EVERYTHING. A profiling run you cannot trust is worse than none,
// and a stale cached module is exactly the kind of thing that sends you looking
// for a regression in code the browser is not running. Correctness over speed:
// this server is not for ordinary development.
//
// NO DEPENDENCIES. package.json has no runtime deps and this is not the file to
// introduce the first one.
//
// RANGE REQUESTS ARE HONOURED. The repo has 50 MB .obj/.ply assets and the
// terrain path streams binary; a server that answers every request with 200 and
// the whole body can change load behaviour enough to move what you are trying to
// measure.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg('port', 3001));
// Default to the repo root — this file lives in tools/.
const ROOT = path.resolve(arg('root', path.join(HERE, '..')));

// Content types that matter to this app. `text/javascript` is required for ES
// modules: a wrong type makes the browser refuse the module outright, and the
// error names the MIME type rather than the file, which reads like a code fault.
const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.mjs':  'text/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.geojson': 'application/json; charset=utf-8',
    '.map':  'application/json; charset=utf-8',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif':  'image/gif',
    '.ico':  'image/x-icon',
    '.glb':  'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.obj':  'text/plain; charset=utf-8',
    '.ply':  'application/octet-stream',
    '.bin':  'application/octet-stream',
    '.wasm': 'application/wasm',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.txt':  'text/plain; charset=utf-8',
    '.xml':  'application/xml; charset=utf-8',
    '.rtz':  'application/xml; charset=utf-8',
};

/**
 * Resolve a URL path to a file inside ROOT, or null.
 *
 * The containment check is on the RESOLVED path, not the raw URL: `%2e%2e`,
 * backslashes on Windows and symlinked directories all survive a string-level
 * check on the request and do not survive this one.
 */
function resolveSafe(urlPath) {
    let rel;
    try { rel = decodeURIComponent(urlPath.split('?')[0].split('#')[0]); }
    catch { return null; }                       // malformed %-escape
    if (rel.endsWith('/')) rel += 'index.html';
    const full = path.resolve(ROOT, '.' + path.posix.normalize(rel));
    const within = full === ROOT || full.startsWith(ROOT + path.sep);
    return within ? full : null;
}

// THE POINT OF THIS FILE. Everything else here is an ordinary static server.
//
// Document-Policy: js-profiling  — unlocks `new Profiler(...)`.
// COOP/COEP are NOT set: they are needed for SharedArrayBuffer, not for
// profiling, and enabling them would block the CDN imports in index.html's
// importmap — i.e. it would break the app in order to profile it.
const COMMON = {
    'Document-Policy': 'js-profiling',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
};

const send = (res, code, body, headers = {}) => {
    res.writeHead(code, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        ...COMMON,
        ...headers,
    });
    res.end(body);
};

const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(res, 405, 'method not allowed\n', { Allow: 'GET, HEAD' });
    }

    const full = resolveSafe(req.url || '/');
    if (!full) return send(res, 403, 'forbidden\n');

    let st;
    try {
        st = await fsp.stat(full);
        if (st.isDirectory()) {
            const idx = path.join(full, 'index.html');
            st = await fsp.stat(idx);
            return stream(req, res, idx, st);
        }
    } catch {
        return send(res, 404, `not found: ${req.url}\n`);
    }
    return stream(req, res, full, st);
});

function stream(req, res, file, st) {
    const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const headers = { ...COMMON, 'Content-Type': type, 'Accept-Ranges': 'bytes' };

    // Range — see the header note. Single ranges only; a multipart/byteranges
    // reply is not worth the code here, and no browser needs one for this app.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && st.size > 0) {
        const [, rawStart, rawEnd] = range;
        let start, end;
        if (rawStart === '') {                    // suffix range: last N bytes
            const n = Number(rawEnd);
            if (!Number.isFinite(n) || n <= 0) return unsatisfiable(res, st.size);
            start = Math.max(0, st.size - n); end = st.size - 1;
        } else {
            start = Number(rawStart);
            end = rawEnd === '' ? st.size - 1 : Number(rawEnd);
        }
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= st.size) {
            return unsatisfiable(res, st.size);
        }
        end = Math.min(end, st.size - 1);
        res.writeHead(206, {
            ...headers,
            'Content-Range': `bytes ${start}-${end}/${st.size}`,
            'Content-Length': end - start + 1,
        });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(file, { start, end }).pipe(res);
    }

    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
}

function unsatisfiable(res, size) {
    res.writeHead(416, { ...COMMON, 'Content-Range': `bytes */${size}` });
    res.end();
}

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.error(`[profile-server] port ${PORT} is already in use — `
                    + `pass --port <n> to pick another.`);
        process.exit(1);
    }
    throw e;
});

server.listen(PORT, () => {
    console.log(`[profile-server] http://localhost:${PORT}  root=${ROOT}`);
    console.log('[profile-server] Document-Policy: js-profiling  (new Profiler() will work here)');
    console.log('[profile-server] no-store on every response — this server is for measuring, not for speed');
});
