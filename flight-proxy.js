// flight-proxy.js — Local CORS proxy for airplanes.live + Celestrak TLE data
// Run in a separate terminal: node flight-proxy.js
// Endpoints:
//   GET /flights                      → airplanes.live global aircraft states
//   GET /satellites?group=<name>      → Celestrak TLE for a satellite group
//
// Celestrak group names supported:
//   stations  — Space stations (ISS, CSS)
//   starlink  — SpaceX Starlink
//   gps       — GPS operational constellation
//   weather   — NOAA weather satellites
const http  = require('http');
const https = require('https');
const url   = require('url');
const equasis = require('./equasis-lookup.js');   // vessel dossier (Equasis)

// Load .env (EQUASIS_USER / EQUASIS_PASS, ANTHROPIC_API_KEY) if present —
// no dependency; tiny KEY=VALUE parser.
try {
    const fs = require('fs'), path = require('path');
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
            const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
            if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
    }
} catch (_) {}

// ── Anthropic Claude API config ───────────────────────────────────────────────
// Set your key: export ANTHROPIC_API_KEY=sk-ant-...
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const CLAUDE_MODEL      = 'claude-haiku-4-5-20251001'; // fast + cheap for live events

// VANGUARD tactical intelligence system prompt
const COPILOT_SYSTEM = `You are VANGUARD's embedded intelligence AI — a real-time maritime and air domain awareness co-pilot. You receive structured event data from live AIS, aviation, and satellite feeds and produce concise tactical assessments.

Rules:
- Write exactly 2-3 sentences. Never more.
- Use a terse, intelligence-community voice. UPPERCASE for vessel names, locations, and key entities.
- State the anomaly clearly, assess the most likely intent or cause, and flag the key risk.
- Do not hedge excessively. Give a direct assessment with a confidence qualifier if needed (e.g. "HIGH confidence", "ASSESSED probable").
- Never use bullet points, headers, or markdown. Plain prose only.
- If the event is near strategic infrastructure (cable, chokepoint, port), lead with that.`;

const PORT         = 8787;
const FLIGHTS_URL  = 'https://api.airplanes.live/v2/point/0/0/20000';

// Celestrak GP data API — returns TLE text for a named group.
const CELESTRAK_BASE = 'https://celestrak.org/SOCRATES/gp.php';

// Telegeography submarine cable GeoJSON — official API, fall back to GitHub branches
const CABLE_URLS = [
    'https://www.submarinecablemap.com/api/v3/cable/cable-geo.json',
    'https://raw.githubusercontent.com/telegeography/www.submarinecablemap.com/master/public/api/v3/cable/cable-geo.json',
    'https://raw.githubusercontent.com/telegeography/www.submarinecablemap.com/main/public/api/v3/cable/cable-geo.json',
];

const CELESTRAK_GROUPS = {
    stations: `${CELESTRAK_BASE}?GROUP=stations&FORMAT=TLE`,
    starlink: `${CELESTRAK_BASE}?GROUP=starlink&FORMAT=TLE`,
    gps:      `${CELESTRAK_BASE}?GROUP=gps-ops&FORMAT=TLE`,
    weather:  `${CELESTRAK_BASE}?GROUP=noaa&FORMAT=TLE`,
};

// ── Flight response cache (30 s TTL) ─────────────────────────────────────────
let _flightCache = null;   // { body: Buffer, contentType: string, ts: number }
const FLIGHT_CACHE_TTL = 30_000;

// ── Generic upstream fetch helper ─────────────────────────────────────────────
function proxyGet(targetUrl, res) {
    https.get(targetUrl, upstream => {
        res.writeHead(upstream.statusCode, {
            'Content-Type': upstream.headers['content-type'] || 'text/plain',
        });
        upstream.pipe(res);
    }).on('error', err => {
        console.error('[proxy] Upstream error:', err.message, '→', targetUrl);
        res.writeHead(502);
        res.end(JSON.stringify({ error: err.message }));
    });
}

function proxyFlightsCached(res) {
    const now = Date.now();
    if (_flightCache && now - _flightCache.ts < FLIGHT_CACHE_TTL) {
        res.writeHead(200, { 'Content-Type': _flightCache.contentType });
        res.end(_flightCache.body);
        return;
    }
    const chunks = [];
    https.get(FLIGHTS_URL, upstream => {
        upstream.on('data', c => chunks.push(c));
        upstream.on('end', () => {
            const body = Buffer.concat(chunks);
            if (upstream.statusCode === 200) {
                _flightCache = { body, contentType: upstream.headers['content-type'] || 'application/json', ts: now };
                res.writeHead(200, { 'Content-Type': _flightCache.contentType });
                res.end(body);
            } else if (_flightCache) {
                console.warn(`[proxy] airplanes.live returned ${upstream.statusCode} — serving stale cache`);
                res.writeHead(200, { 'Content-Type': _flightCache.contentType });
                res.end(_flightCache.body);
            } else {
                console.warn(`[proxy] airplanes.live returned ${upstream.statusCode} and no cache — sending empty`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ac: [] }));
            }
        });
    }).on('error', err => {
        console.error('[proxy] airplanes.live error:', err.message);
        if (_flightCache) {
            console.warn('[proxy] Serving stale flight cache after error');
            res.writeHead(200, { 'Content-Type': _flightCache.contentType });
            res.end(_flightCache.body);
        } else {
            res.writeHead(502);
            res.end(JSON.stringify({ error: err.message }));
        }
    });
}

// ── Build a plain-English event summary for Claude ────────────────────────────
function buildEventSummary(ctx) {
    if (!ctx) return 'Unknown event.';
    const v = ctx.vessel || {};
    const vDesc = [
        v.name && v.name !== 'UNKNOWN' ? v.name : null,
        v.mmsi ? `MMSI ${v.mmsi}` : null,
        v.class ? `class ${v.class}` : null,
        v.flag  ? `flag ${v.flag}` : null,
    ].filter(Boolean).join(', ');

    switch (ctx.event) {
        case 'DARK_VESSEL':
            return [
                `DARK VESSEL EVENT: ${vDesc}.`,
                `Last known position: ${ctx.vessel?.latDeg?.toFixed(2)}°N, ${ctx.vessel?.lonDeg?.toFixed(2)}°E.`,
                `Speed before silence: ${v.speedKts}kts, heading ${v.headingDeg}°.`,
                ctx.chokepoint    ? `Near strategic chokepoint: ${ctx.chokepoint}.` : '',
                ctx.cableProximity ? `Near submarine cable: ${ctx.cableProximity}.` : '',
                `Declared destination: ${v.destination || 'UNKNOWN'}.`,
                `Threat score: ${ctx.score}/100.`,
            ].filter(Boolean).join(' ');

        case 'SPEED_ANOMALY':
            return [
                `SPEED ANOMALY: ${vDesc}.`,
                `Velocity changed from ${ctx.previousSpeed}kts to ${v.speedKts}kts (delta: ${ctx.speedDelta?.toFixed(0)}kts).`,
                `Current position: ${v.latDeg?.toFixed(2)}°N, ${v.lonDeg?.toFixed(2)}°E.`,
                ctx.chokepoint ? `Near ${ctx.chokepoint}.` : '',
                `Heading: ${v.headingDeg}°.`,
            ].filter(Boolean).join(' ');

        case 'CABLE_PROXIMITY':
            return [
                `CABLE PROXIMITY ALERT: ${vDesc}.`,
                `Vessel stationary or near-stationary (${v.speedKts}kts) near ${ctx.cableProximity}.`,
                `Position: ${v.latDeg?.toFixed(2)}°N, ${v.lonDeg?.toFixed(2)}°E.`,
                `Vessel class: ${v.class}. Flag: ${v.flag || 'UNKNOWN'}.`,
            ].filter(Boolean).join(' ');

        case 'CLUSTER':
            return [
                `VESSEL CLUSTER DETECTED: ${ctx.count} vessels within ~90nm.`,
                `Centroid: ${ctx.centroidLat?.toFixed(2)}°N, ${ctx.centroidLon?.toFixed(2)}°E.`,
                `Dark vessels in cluster: ${ctx.darkCount}.`,
                ctx.chokepoint ? `Near ${ctx.chokepoint}.` : '',
                `Vessel classes present: ${(ctx.classes || []).join(', ')}.`,
                `Flags observed: ${(ctx.flags || []).slice(0, 5).join(', ') || 'UNKNOWN'}.`,
            ].filter(Boolean).join(' ');

        default:
            return JSON.stringify(ctx);
    }
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
    // Allow any local origin (browser → localhost)
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const parsed   = url.parse(req.url, true);
    const pathname = parsed.pathname;

    // ── /flights — airplanes.live global aircraft states ─────────────────────
    if (pathname === '/flights') {
        console.log('[proxy] → airplanes.live (cached)');
        proxyFlightsCached(res);
        return;
    }

    // ── /vessel — Equasis dossier (by IMO, or auto-resolved from name) ───────
    //   /vessel/<imo>  or  /vessel?imo=...  or  /vessel?name=...&flag=...
    if (pathname === '/vessel' || pathname.startsWith('/vessel/')) {
        const q = parsed.query;
        const imo = q.imo || pathname.split('/')[2] || '';
        console.log(`[proxy] → Equasis ${imo ? 'IMO=' + imo : 'name=' + (q.name || '')}`);
        equasis.lookup({ imo, name: q.name, flag: q.flag }).then(r => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(r));
        }).catch(e => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
        });
        return;
    }

    // ── /satellites?group=<name> — Celestrak TLE ─────────────────────────────
    if (pathname === '/satellites') {
        const group = (parsed.query.group || '').toLowerCase();
        const target = CELESTRAK_GROUPS[group];

        if (!target) {
            res.writeHead(400);
            res.end(`Unknown group "${group}". Valid: ${Object.keys(CELESTRAK_GROUPS).join(', ')}`);
            return;
        }

        console.log(`[proxy] → Celestrak group="${group}"`);
        proxyGet(target, res);
        return;
    }

    // ── /weather?lat=&lon=&key= — OpenWeatherMap current conditions ──────────
    if (pathname === '/weather') {
        const { lat, lon, key } = parsed.query;
        if (!lat || !lon || !key) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Required params: lat, lon, key' }));
            return;
        }
        const owmUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${key}&units=metric`;
        console.log(`[proxy] → OWM weather at (${lat}, ${lon})`);
        proxyGet(owmUrl, res);
        return;
    }

    // ── /cables — Telegeography submarine cable GeoJSON ──────────────────────
    if (pathname === '/cables') {
        console.log('[proxy] → Telegeography cable GeoJSON');

        function tryNext(urls, idx) {
            if (idx >= urls.length) {
                res.writeHead(502);
                res.end(JSON.stringify({ error: 'All cable sources failed' }));
                return;
            }
            https.get(urls[idx], upstream => {
                if (upstream.statusCode === 200) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    upstream.pipe(res);
                } else {
                    console.warn(`[proxy] Cable source ${idx} returned ${upstream.statusCode}, trying next...`);
                    upstream.resume();
                    tryNext(urls, idx + 1);
                }
            }).on('error', err => {
                console.warn(`[proxy] Cable source ${idx} error: ${err.message}, trying next...`);
                tryNext(urls, idx + 1);
            });
        }

        tryNext(CABLE_URLS, 0);
        return;
    }

    // ── /ai-assess — Claude tactical intelligence assessment (POST) ───────────
    if (pathname === '/ai-assess' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            if (!ANTHROPIC_API_KEY) {
                res.writeHead(503);
                res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set on proxy server.' }));
                return;
            }

            let context;
            try { context = JSON.parse(body).context; }
            catch (_) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid JSON body' }));
                return;
            }

            // Build a readable event summary for Claude
            const userMsg = buildEventSummary(context);
            console.log(`[proxy] → Claude assessment: ${context?.event} | score: ${context?.score ?? '?'}`);

            const payload = JSON.stringify({
                model:      CLAUDE_MODEL,
                max_tokens: 200,
                system:     COPILOT_SYSTEM,
                messages:   [{ role: 'user', content: userMsg }],
            });

            const reqOptions = {
                hostname: 'api.anthropic.com',
                path:     '/v1/messages',
                method:   'POST',
                headers: {
                    'Content-Type':      'application/json',
                    'x-api-key':         ANTHROPIC_API_KEY,
                    'anthropic-version': '2023-06-01',
                    'Content-Length':    Buffer.byteLength(payload),
                },
            };

            const apiReq = https.request(reqOptions, apiRes => {
                const chunks = [];
                apiRes.on('data', c => chunks.push(c));
                apiRes.on('end', () => {
                    try {
                        const parsed     = JSON.parse(Buffer.concat(chunks).toString());
                        const assessment = parsed?.content?.[0]?.text?.trim() || 'Assessment unavailable.';
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ assessment }));
                    } catch (_) {
                        res.writeHead(502);
                        res.end(JSON.stringify({ error: 'Failed to parse Claude response' }));
                    }
                });
            });

            apiReq.on('error', err => {
                console.error('[proxy] Claude API error:', err.message);
                res.writeHead(502);
                res.end(JSON.stringify({ error: err.message }));
            });

            apiReq.write(payload);
            apiReq.end();
        });
        return;
    }

    // ── /tile/dem/:z/:x/:y.png  — elevation tiles (Mapzen S3, CORS blocked) ──
    // ── /tile/img/:z/:y/:x     — ArcGIS satellite imagery (CORS blocked) ────
    if (pathname.startsWith('/tile/')) {
        const parts = pathname.split('/'); // ['', 'tile', type, ...]
        const tileType = parts[2];
        let targetUrl;

        if (tileType === 'dem' && parts.length >= 6) {
            // /tile/dem/z/x/y  (strip trailing .png if present)
            const z = parts[3], x = parts[4], y = parts[5].replace('.png','');
            targetUrl = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
        } else if (tileType === 'img' && parts.length >= 6) {
            // /tile/img/z/y/x
            const z = parts[3], y = parts[4], x = parts[5];
            targetUrl = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
        } else if (tileType === 'borders') {
            targetUrl = 'https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_110m_admin_0_countries.geojson';
        }

        if (!targetUrl) { res.writeHead(400); res.end('Bad tile path'); return; }

        console.log(`[proxy] → tile ${pathname}`);
        https.get(targetUrl, { headers: { 'User-Agent': 'VANGUARD/1.0' } }, upstream => {
            // Forward content-type so browser loads image correctly
            const ct = upstream.headers['content-type'] || 'image/png';
            res.writeHead(upstream.statusCode === 200 ? 200 : upstream.statusCode, {
                'Content-Type': ct,
                'Cache-Control': 'public, max-age=86400',
            });
            upstream.pipe(res);
        }).on('error', err => {
            console.error('[proxy] Tile fetch error:', err.message);
            res.writeHead(502);
            res.end('Tile fetch failed');
        });
        return;
    }

    // ── /gibs-tile — NASA GIBS WMTS satellite imagery ─────────────────────────
    // Proxies GIBS tile requests to bypass browser CORS restrictions.
    // Query params: layer, date (YYYY-MM-DD), tileset, z, row, col, fmt (png|jpg)
    if (pathname === '/gibs-tile') {
        const { layer, date, tileset, z, row, col, fmt } = parsed.query;
        if (!layer || !date || !tileset || z == null || row == null || col == null) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Required: layer, date, tileset, z, row, col' }));
            return;
        }
        const format    = fmt || 'png';
        const targetUrl = `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/${layer}/default/${date}/${tileset}/${z}/${row}/${col}.${format}`;
        console.log(`[proxy] → GIBS tile ${layer} ${date} z=${z} r=${row} c=${col}`);

        https.get(targetUrl, { headers: { 'User-Agent': 'VANGUARD/1.0' } }, upstream => {
            const ct = upstream.headers['content-type'] || 'image/png';
            res.writeHead(upstream.statusCode === 200 ? 200 : upstream.statusCode, {
                'Content-Type':  ct,
                'Cache-Control': 'public, max-age=1800', // cache 30 min
                'Access-Control-Allow-Origin': '*',
            });
            upstream.pipe(res);
        }).on('error', err => {
            console.error('[proxy] GIBS tile error:', err.message);
            res.writeHead(502);
            res.end('GIBS fetch failed');
        });
        return;
    }

    // ── 404 catch-all ─────────────────────────────────────────────────────────
    res.writeHead(404);
    res.end('Not found. Use /flights, /satellites?group=<name>, /cables, /weather, /gibs-tile, or POST /ai-assess');
});

server.listen(PORT, () => {
    console.log(`[flight-proxy] Running at http://localhost:${PORT}`);
    console.log('[flight-proxy]   /flights                  → airplanes.live');
    console.log('[flight-proxy]   /satellites?group=<name>  → Celestrak TLE');
    console.log('[flight-proxy]   /cables                   → Telegeography cable GeoJSON');
    console.log('[flight-proxy]   /gibs-tile?layer=&date=&tileset=&z=&row=&col=  → NASA GIBS');
    console.log('[flight-proxy]   /weather?lat=&lon=&key=     → OpenWeatherMap');
    console.log('[flight-proxy] Groups: stations | starlink | gps | weather');
    console.log('[flight-proxy] Press Ctrl+C to stop.');
});
