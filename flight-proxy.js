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
const memoryStore = require('./memoryStore.js');  // persistent ground-truth/findings log (Discovery AI)

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

// ── AI provider config ────────────────────────────────────────────────────────
// Two interchangeable backends for /ai-assess and /ai-discover. Pick one via
// AI_PROVIDER=anthropic|gemini in .env, or just set whichever key you have —
// Anthropic wins if both are present. Gemini exists as a free-tier option for
// people without an Anthropic key (see memory/decisions.md, 2026-06-21).
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const CLAUDE_MODEL      = 'claude-haiku-4-5-20251001'; // fast + cheap for live events

// Gemini — set your key: GEMINI_API_KEY=... in .env. Free tier, no card required.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL   = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

const AI_PROVIDER = (process.env.AI_PROVIDER
    || (ANTHROPIC_API_KEY ? 'anthropic' : (GEMINI_API_KEY ? 'gemini' : ''))
).toLowerCase();

// VANGUARD tactical intelligence system prompt
const COPILOT_SYSTEM = `You are VANGUARD's embedded intelligence AI — a real-time maritime and air domain awareness co-pilot. You receive structured event data from live AIS, aviation, and satellite feeds and produce concise tactical assessments.

Rules:
- Write exactly 2-3 sentences. Never more.
- Use a terse, intelligence-community voice. UPPERCASE for vessel names, locations, and key entities.
- State the anomaly clearly, assess the most likely intent or cause, and flag the key risk.
- Do not hedge excessively. Give a direct assessment with a confidence qualifier if needed (e.g. "HIGH confidence", "ASSESSED probable").
- Never use bullet points, headers, or markdown. Plain prose only.
- If the event is near strategic infrastructure (cable, chokepoint, port), lead with that.`;

// VANGUARD AI Discovery system prompt — cross-domain pattern-finding, distinct
// from COPILOT_SYSTEM above (which assesses ONE pre-flagged event). This call
// receives the WHOLE recent live picture and must find correlations no single
// rule-based detector could see, while refusing to invent significance that
// isn't in the data — every claim must point at something actually present in
// the payload (an MMSI, a flag, a timestamp), never a generic guess.
const DISCOVERY_SYSTEM = `You are VANGUARD's AI Discovery layer — you receive a cross-domain snapshot of live maritime intelligence (developing per-vessel event threads, AIS physics-invariant violations, integrity-flagged vessels, RF intel events, chokepoint vessel activity) and your job is to find the ONE most significant correlation or pattern that a single-domain rule engine would miss, NOT to re-describe individual events.

Rules:
- Only surface a finding if it connects 2+ pieces of evidence already present in the snapshot (e.g. a vessel appearing in BOTH the developing-stories timeline AND the integrity-flagged list; an RF event tied to a vessel that's also AIS-flagged; a cluster of invariant violations sharing a region, chokepoint, or time window). A single isolated event is not a discovery — return an empty assessment ("") if nothing in the snapshot actually correlates.
- Every sentence must cite a specific MMSI, flag, tier, RF event type, chokepoint name, or timestamp from the snapshot. Never write a claim that can't be traced to a field you were given.
- Write 2-4 sentences, terse intelligence-community voice, UPPERCASE vessel/place names. State the correlation, then the most likely read on it, with a confidence qualifier.
- If you believe the operator should look at a specific vessel right now, also return an action. Respond ONLY with raw JSON, no markdown fences, in exactly this shape:
{"assessment": "<your finding, or empty string if none>", "actions": [{"tool": "selectVessel", "args": {"mmsi": "<mmsi>", "openCard": true}}]}
- "actions" may be an empty array. Only emit a selectVessel action for the single most important vessel in your finding, never more than one.

TOOL — searchHistory(mmsi, days): the snapshot only shows the CURRENT picture. If a vessel in developingStories or integrityFlagged looks suspicious and its PAST pattern (not just this moment) would change your assessment, you may request its history instead of answering. To do so, respond ONLY with raw JSON in exactly this shape: {"toolCall": {"name": "searchHistory", "args": {"mmsi": "<mmsi>", "days": 7}}}. You will then be given the result and must answer in the normal {"assessment", "actions"} shape — you may use this tool at most once per request, so only call it when the snapshot alone is genuinely insufficient.`;

// VANGUARD AI Discovery — OPTIONS mode (2026-07-21). Used instead of
// DISCOVERY_SYSTEM whenever discoveryManager.js's escalation carries a named
// trigger type with a fixed menu (see discoveryRules.js's OPTION_MENUS). The
// difference from DISCOVERY_SYSTEM is deliberate and narrow: Claude's job
// here is to RANK a small analyst-written menu against the evidence, not to
// freely compose an assessment. This is what makes the result renderable as
// clickable option cards instead of a paragraph, and it's a harder task to
// hallucinate on — the model can misjudge which option fits best, but it
// can't invent a hypothesis that isn't in the menu.
const OPTIONS_SYSTEM = `You are VANGUARD's AI Discovery layer, ranking a FIXED set of analyst-defined hypotheses against live evidence — not free-writing an assessment. You will be given a cross-domain snapshot, the specific trigger condition that fired, and a MENU of hypotheses appropriate to that trigger type.

Rules:
- Rank EVERY item in the menu — do not omit any, and do not add a hypothesis that isn't in the menu.
- Each item gets a confidence of exactly "HIGH", "MEDIUM", or "LOW", and one sentence of reasoning grounded in a specific field from the snapshot (MMSI, flag, tier, RF event type, chokepoint name, timestamp). Never write a claim that can't be traced to a field you were given.
- Order the array from most to least likely.
- If nothing in the evidence actually distinguishes between menu items, say so plainly in the reasoning (e.g. "no distinguishing evidence yet") rather than fabricating a detail to justify a ranking.
- You may also propose the operator's console take action, via "actions". Available tools:
    - selectVessel(mmsi, openCard): pan the camera to a vessel and optionally open its detail card. Use when a specific vessel deserves the operator's immediate attention right now.
    - addToWatchlist(mmsi): add a vessel to the persistent watchlist for ongoing monitoring. Use when the vessel's behavior warrants tracking over time, not just flagging in this one pass.
    - flagForNextShift(mmsi, note): add to the watchlist AND leave a short note explaining the concern, for whoever picks this up next. Use when there's something specific worth putting on record, not just a vessel worth watching.
  Only take an action when the evidence genuinely warrants it — most passes should return an empty actions array. Never invent an mmsi that isn't present in the snapshot above. At most 2 actions per response.
- Respond ONLY with raw JSON, no markdown fences, in exactly this shape:
{"options": [{"label": "<exact menu item text>", "confidence": "HIGH", "reasoning": "<one grounded sentence>"}], "actions": [{"tool": "addToWatchlist", "args": {"mmsi": "<mmsi>"}}]}
- "actions" may be an empty array.

TOOL — searchHistory(mmsi, days): same as before — if a vessel's PAST pattern (not just this moment) would change your ranking, you may request it once instead of answering. Respond ONLY with raw JSON: {"toolCall": {"name": "searchHistory", "args": {"mmsi": "<mmsi>", "days": 7}}}. You will then be given the result and must answer in the {"options", "actions"} shape — at most one tool call per request.`;

// VANGUARD AI Discovery — direct operator Q&A. Same snapshot, same grounding
// discipline as DISCOVERY_SYSTEM, but answering a specific question instead
// of scanning autonomously for a correlation. Added 2026-06-21 — the pass-only
// loop was one-directional; this gives the operator a way to ask it something.
const QUERY_SYSTEM = `You are VANGUARD's AI Discovery layer, now answering a direct question from the operator instead of running an autonomous scan. You receive the same cross-domain snapshot (developing event threads, AIS invariant violations, integrity-flagged vessels, RF intel events, chokepoint vessel activity) plus a specific question.

Rules:
- Answer the question directly, 2-4 sentences, terse intelligence-community voice, UPPERCASE vessel/place names.
- Ground every claim in a specific field from the snapshot (MMSI, flag, tier, RF event type, chokepoint name). If the snapshot has nothing relevant to the question, say so plainly instead of inventing an answer — do not hallucinate vessels, events, or locations not present in the data.
- You may be given a PRIOR CONVERSATION block above the question — use it to resolve follow-ups ("that vessel", "what about it now") but never treat anything said there as a new fact; re-ground every claim in the current snapshot (or in a searchHistory tool result), not in what was previously said.
- Never use bullet points, headers, or markdown. Plain prose only.
- Respond ONLY with raw JSON, no markdown fences, in exactly this shape: {"answer": "<your answer>"}

TOOL — searchHistory(mmsi, days): if answering requires a specific vessel's PAST pattern beyond what's in the current snapshot or conversation, you may request it instead of answering immediately. To do so, respond ONLY with raw JSON in exactly this shape: {"toolCall": {"name": "searchHistory", "args": {"mmsi": "<mmsi>", "days": 7}}}. You will then be given the result and must answer in the normal {"answer"} shape — at most one tool call per question.`;

/** Parse Claude's discovery response — expects raw JSON per DISCOVERY_SYSTEM,
 *  but falls back to treating it as plain text if it didn't comply. */
function parseDiscoveryResponse(raw) {
    if (!raw) return { assessment: '', actions: [] };
    try {
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
        const parsed  = JSON.parse(cleaned);
        return {
            assessment: typeof parsed.assessment === 'string' ? parsed.assessment : '',
            actions:    Array.isArray(parsed.actions) ? parsed.actions : [],
        };
    } catch (_) {
        // Model didn't return clean JSON — surface the text, take no action.
        return { assessment: raw, actions: [] };
    }
}

/** Parse Claude's OPTIONS-mode response — expects raw JSON per OPTIONS_SYSTEM.
 *  Unlike parseDiscoveryResponse, there's no "fall back to raw text" path:
 *  an options card either has valid ranked options or it doesn't render at
 *  all (rawFallback carries the text so discoveryManager can still surface
 *  SOMETHING rather than silently drop a spent Claude call). Malformed
 *  individual option entries are filtered rather than failing the whole
 *  response — a model that gets one field wrong shouldn't lose the other three.*/
function parseOptionsResponse(raw) {
    if (!raw) return { options: [], actions: [] };
    try {
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
        const parsed  = JSON.parse(cleaned);
        const options = Array.isArray(parsed.options)
            ? parsed.options
                .filter(o => o && typeof o.label === 'string' && o.label.trim())
                .map(o => ({
                    label:      o.label.trim(),
                    confidence: ['HIGH', 'MEDIUM', 'LOW'].includes(o.confidence) ? o.confidence : 'LOW',
                    reasoning:  typeof o.reasoning === 'string' ? o.reasoning : '',
                }))
            : [];
        return { options, actions: Array.isArray(parsed.actions) ? parsed.actions : [] };
    } catch (_) {
        return { options: [], actions: [], rawFallback: raw };
    }
}

/** Build the OPTIONS-mode user message: the same cross-domain summary
 *  buildDiscoverySummary produces, plus the specific trigger that fired and
 *  the fixed menu to rank against it. */
function buildOptionsSummary(snapshot, triggerType, triggerText, menu) {
    const base = buildDiscoverySummary(snapshot);
    const menuList = menu.map((m, i) => `${i + 1}. ${m}`).join('\n');
    return `${base}\n\nTRIGGER FIRED: ${triggerType} — ${triggerText}\n\n`
        + `MENU (rank ALL of these against the evidence above, do not add or omit any):\n${menuList}`;
}

/** Build a readable cross-domain summary for the discovery prompt. */
function buildDiscoverySummary(snapshot) {
    if (!snapshot) return 'No data.';
    const lines = [];

    const stories = snapshot.developingStories || [];
    if (stories.length) {
        lines.push(`DEVELOPING EVENT THREADS (${stories.length} vessels with 2+ recent events):`);
        for (const s of stories.slice(0, 15)) {
            const evs = (s.events || []).map(e => `${e.type} (${e.ageSec}s ago: ${e.detail})`).join(' → ');
            lines.push(`  MMSI ${s.mmsi}: ${evs}`);
        }
    }

    const flagged = snapshot.integrityFlagged || [];
    if (flagged.length) {
        lines.push(`INTEGRITY-FLAGGED VESSELS (${flagged.length}):`);
        for (const f of flagged.slice(0, 15)) {
            lines.push(`  MMSI ${f.mmsi}: tier ${f.tier}, score ${f.score}, flags [${(f.flags || []).join(', ')}]`);
        }
    }

    const violations = snapshot.invariantViolations || [];
    if (violations.length) {
        lines.push(`RECENT AIS INVARIANT VIOLATIONS (${violations.length}, most recent last):`);
        for (const v of violations.slice(-15)) {
            lines.push(`  ${JSON.stringify(v)}`);
        }
    }

    const rf = snapshot.rfEvents || [];
    if (rf.length) {
        lines.push(`RF INTEL EVENTS (${rf.length}, most recent last):`);
        for (const r of rf.slice(-15)) {
            lines.push(`  ${r.severity} ${r.type}${r.vessel ? ' [vessel ' + r.vessel + ']' : ''}: ${r.summary} (${r.ageSec}s ago)`);
        }
    }

    const cps = snapshot.chokepointActivity || [];
    if (cps.length) {
        lines.push(`CHOKEPOINT VESSEL ACTIVITY (${cps.length}):`);
        for (const c of cps) {
            // MMSIs (added 2026-07-21) — without these the model has an aggregate
            // count with nothing to cross-reference against developing threads /
            // integrity flags / RF, and correctly refuses to speculate. See
            // memory/decisions.md for the live miss that surfaced this.
            const vessels = c.vessels || [];
            const mmsiList = vessels.length
                ? ' [' + vessels.map(v => `${v.mmsi}${v.dark ? ' DARK' : ''}${v.stopped ? ' STOPPED' : ''}`).join(', ') + ']'
                : '';
            lines.push(`  ${c.name}: ${c.count} vessels, state ${c.state}${c.dark ? ', ' + c.dark + ' dark' : ''}${mmsiList}`);
        }
    }

    if (lines.length === 0) return 'No notable activity in this pass.';
    return lines.join('\n');
}

// ── LLM backends — same contract regardless of provider ──────────────────────
// Each resolves with the model's raw text reply, or rejects with an Error.
// /ai-assess and /ai-discover call callLLM() and don't know which backend ran.

function callAnthropic(systemPrompt, userMsg, maxTokens) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            model:      CLAUDE_MODEL,
            max_tokens: maxTokens,
            system:     systemPrompt,
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
                    const parsed = JSON.parse(Buffer.concat(chunks).toString());
                    if (parsed?.error) { reject(new Error(parsed.error.message || 'Anthropic API error')); return; }
                    resolve(parsed?.content?.[0]?.text?.trim() || '');
                } catch (_) {
                    reject(new Error('Failed to parse Claude response'));
                }
            });
        });
        apiReq.on('error', reject);
        apiReq.write(payload);
        apiReq.end();
    });
}

function callGemini(systemPrompt, userMsg, maxTokens) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            contents:          [{ role: 'user', parts: [{ text: userMsg }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig:  { maxOutputTokens: maxTokens },
        });
        const reqOptions = {
            hostname: 'generativelanguage.googleapis.com',
            path:     `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
            method:   'POST',
            headers: {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
        };
        const apiReq = https.request(reqOptions, apiRes => {
            const chunks = [];
            apiRes.on('data', c => chunks.push(c));
            apiRes.on('end', () => {
                try {
                    const parsed = JSON.parse(Buffer.concat(chunks).toString());
                    if (parsed?.error) { reject(new Error(parsed.error.message || 'Gemini API error')); return; }
                    resolve(parsed?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '');
                } catch (_) {
                    reject(new Error('Failed to parse Gemini response'));
                }
            });
        });
        apiReq.on('error', reject);
        apiReq.write(payload);
        apiReq.end();
    });
}

function _callLLMRaw(systemPrompt, userMsg, maxTokens) {
    if (AI_PROVIDER === 'anthropic') return callAnthropic(systemPrompt, userMsg, maxTokens);
    if (AI_PROVIDER === 'gemini')    return callGemini(systemPrompt, userMsg, maxTokens);
    return Promise.reject(new Error('No AI provider configured. Set ANTHROPIC_API_KEY or GEMINI_API_KEY in .env.'));
}

// ── Shared call budget (free-tier quota guard, 2026-06-21) ──────────────────
// /ai-assess, /ai-discover, /ai-query, and the tool-use round trip in
// callLLMWithTools all funnel through callLLM() — and on a free-tier key
// (no Anthropic key, no billing — see memory/decisions.md) they're all
// drawing from the SAME quota. Three protections, in order:
//   1. A hard minimum interval between ANY call, so a burst of console
//      activity (RUN NOW + a couple of questions) can't blow through a
//      per-minute cap.
//   2. A short response cache — re-asking the exact same question against
//      the exact same snapshot within the window reuses the prior answer
//      instead of spending a new call. (Doesn't touch memoryStore — only
//      the in-flight HTTP round trip is skipped.)
//   3. Once the provider reports the quota itself is exhausted, stop
//      calling it for a cooldown window instead of hammering an API that's
//      already saying no — a failed call can still count against quota.
const LLM_MIN_INTERVAL_MS = 8_000;       // ~7 calls/min ceiling
const LLM_CACHE_TTL_MS    = 60_000;      // identical request reuses the answer for 60s
const QUOTA_COOLDOWN_MS   = 5 * 60_000;  // back off for 5min once quota-exhausted is seen

let _lastLLMCallTime     = 0;
let _quotaExhaustedUntil = 0;
const _llmCache = new Map(); // `${systemPrompt.length}:${userMsg}` -> { ts, value }

function _isQuotaError(err) {
    const msg = (err && err.message || '').toLowerCase();
    return msg.includes('quota') || msg.includes('rate limit') || msg.includes('resource_exhausted') || msg.includes('429');
}

/** Single entry point both AI endpoints call — swap providers by changing
 *  AI_PROVIDER/.env only, never the endpoint code. */
async function callLLM(systemPrompt, userMsg, maxTokens) {
    const cacheKey = `${systemPrompt.length}:${userMsg}`;
    const cached = _llmCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < LLM_CACHE_TTL_MS) {
        console.log('[proxy] LLM call served from cache — quota not spent');
        return cached.value;
    }

    if (Date.now() < _quotaExhaustedUntil) {
        const waitS = Math.ceil((_quotaExhaustedUntil - Date.now()) / 1000);
        throw new Error(`AI quota exhausted — cooling down ${waitS}s before retrying (free-tier limit hit)`);
    }

    const sinceLast = Date.now() - _lastLLMCallTime;
    if (sinceLast < LLM_MIN_INTERVAL_MS) {
        await new Promise(r => setTimeout(r, LLM_MIN_INTERVAL_MS - sinceLast));
    }
    _lastLLMCallTime = Date.now();

    try {
        const result = await _callLLMRaw(systemPrompt, userMsg, maxTokens);
        if (_llmCache.size > 200) _llmCache.clear(); // simple bound, local dev tool
        _llmCache.set(cacheKey, { ts: Date.now(), value: result });
        return result;
    } catch (err) {
        if (_isQuotaError(err)) {
            _quotaExhaustedUntil = Date.now() + QUOTA_COOLDOWN_MS;
            console.warn(`[proxy] quota exhausted — pausing all LLM calls for ${QUOTA_COOLDOWN_MS / 1000}s`);
        }
        throw err;
    }
}

// ── Discovery tool-use (phase 2, memory/decisions.md 2026-06-21) ────────────
// Neither callAnthropic nor callGemini above use native tool-calling APIs —
// this project's own minimal text-in/text-out convention instead: if the
// model's raw reply is {"toolCall": {"name": ..., "args": {...}}} instead of
// its normal answer shape, run the named read-only tool server-side and call
// the model exactly once more with the result appended. Capped at one round
// trip on purpose — these are bounded lookups (searchHistory), not an
// open-ended agent loop, so there's no need for a max-iterations guard.
const DISCOVERY_TOOLS = {
    searchHistory: ({ mmsi, days } = {}) => memoryStore.searchHistory(mmsi, days || 7),
};

function parseToolCall(raw) {
    if (!raw) return null;
    try {
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
        const parsed  = JSON.parse(cleaned);
        if (parsed && parsed.toolCall && typeof parsed.toolCall.name === 'string') return parsed.toolCall;
    } catch (_) { /* not a tool call — fall through */ }
    return null;
}

async function callLLMWithTools(systemPrompt, userMsg, maxTokens) {
    const first = await callLLM(systemPrompt, userMsg, maxTokens);
    const toolCall = parseToolCall(first);
    if (!toolCall) return first;

    const fn = DISCOVERY_TOOLS[toolCall.name];
    if (!fn) {
        console.warn(`[proxy] discovery requested unknown tool: ${toolCall.name}`);
        return first; // caller's own parse fallback will surface this as plain text
    }

    let result;
    try { result = fn(toolCall.args || {}); }
    catch (err) { result = { error: err.message }; }

    console.log(`[proxy] → discovery tool call: searchHistory(${JSON.stringify(toolCall.args || {})}) → ${result?.hits?.length ?? 0} hits`);

    const followUp = `${userMsg}\n\nTOOL RESULT — searchHistory(${JSON.stringify(toolCall.args || {})}):\n${JSON.stringify(result)}\n\nNow give your final answer in the exact JSON format specified in your instructions. Do not request another tool call.`;
    return callLLM(systemPrompt, followUp, maxTokens);
}

const PORT = 8787;

// Anonymous-tier fallback ADS-B mirrors — both are community feeder-network
// aggregators with an identical (ADSBExchange-compatible) /v2/point/lat/lon/radius
// schema, so the proxy can swap between them with zero changes downstream.
// Both are subject to anonymous-tier IP-reputation/rate-limit blocking (see
// memory/decisions.md — observed 403 from airplanes.live and 420 from adsb.lol
// simultaneously on 2026-06-26), which is why OpenSky (below) is now tried first
// when credentials are configured. These remain as the fallback chain.
const FLIGHTS_URLS = [
    'https://api.airplanes.live/v2/point/0/0/20000',
    'https://api.adsb.lol/v2/point/0/0/20000',
];

// ── OpenSky Network (registered OAuth2 client) — primary flight source ───────
// Free, registered-account source. Far more reliable for unattended polling
// than the anonymous mirrors above since it isn't subject to the same
// IP-reputation throttling. Setup (one-time, done by Jamal — Claude cannot
// create accounts):
//   1. Register a free account at https://opensky-network.org
//   2. Account → API Client → create a new client → copy the Client ID/Secret
//   3. Add to flight-proxy.js's .env:
//        OPENSKY_CLIENT_ID=...
//        OPENSKY_CLIENT_SECRET=...
// If unset, this source is skipped and the proxy falls straight through to
// the anonymous mirrors above — no behavior change for anyone who hasn't set
// this up yet.
const OPENSKY_CLIENT_ID     = process.env.OPENSKY_CLIENT_ID || '';
const OPENSKY_CLIENT_SECRET = process.env.OPENSKY_CLIENT_SECRET || '';
const OPENSKY_TOKEN_URL  = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const OPENSKY_STATES_URL = 'https://opensky-network.org/api/states/all';

let _openSkyToken = null; // { value, expiresAt } — tokens live 30 min; refreshed 60s early

function getOpenSkyToken(cb) {
    if (_openSkyToken && Date.now() < _openSkyToken.expiresAt) return cb(null, _openSkyToken.value);

    const body = `grant_type=client_credentials&client_id=${encodeURIComponent(OPENSKY_CLIENT_ID)}&client_secret=${encodeURIComponent(OPENSKY_CLIENT_SECRET)}`;
    const target = new url.URL(OPENSKY_TOKEN_URL);
    const req = https.request({
        hostname: target.hostname,
        path: target.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
        },
    }, upstream => {
        const chunks = [];
        upstream.on('data', c => chunks.push(c));
        upstream.on('end', () => {
            try {
                const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (upstream.statusCode !== 200 || !json.access_token) {
                    return cb(new Error(`OpenSky token endpoint returned ${upstream.statusCode}`));
                }
                _openSkyToken = { value: json.access_token, expiresAt: Date.now() + (json.expires_in - 60) * 1000 };
                cb(null, _openSkyToken.value);
            } catch (e) { cb(e); }
        });
    });
    req.on('error', cb);
    req.write(body);
    req.end();
}

// OpenSky's numeric `category` field is the same ADS-B emitter-category enum
// as the A*/B*/C* string codes config.js's AIRCRAFT_CLASSES.CATEGORY_MAP
// expects — just flattened to integers. Mapping back to the string means
// flightManager.js's classifyAircraft() needs zero source-specific branching.
const OPENSKY_CATEGORY_MAP = {
    2: 'A1', 3: 'A2', 4: 'A3', 5: 'A4', 6: 'A5', 7: 'A6', 8: 'A7',
    9: 'B1', 10: 'B2', 11: 'B3', 12: 'B4', 14: 'B6', 15: 'B7',
};

function fetchOpenSkyStates(cb) {
    if (!OPENSKY_CLIENT_ID || !OPENSKY_CLIENT_SECRET) return cb(new Error('not configured'));

    getOpenSkyToken((err, token) => {
        if (err) return cb(err);

        https.get(OPENSKY_STATES_URL, { headers: { Authorization: `Bearer ${token}` } }, upstream => {
            const chunks = [];
            upstream.on('data', c => chunks.push(c));
            upstream.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { /* not JSON */ }
                if (upstream.statusCode !== 200 || !parsed || !Array.isArray(parsed.states)) {
                    return cb(new Error(`states/all returned ${upstream.statusCode}`));
                }

                // Map OpenSky's positional state-vector array onto the same
                // {ac:[...]} shape the ADSBExchange-compatible mirrors return,
                // so downstream code (flightManager.js) needs zero changes.
                const ac = parsed.states.map(s => {
                    const icao24 = s[0], callsign = s[1], lon = s[5], lat = s[6],
                          baroAltM = s[7], onGround = s[8], velocityMs = s[9],
                          trueTrack = s[10], squawk = s[14], category = s[17];
                    return {
                        hex: (icao24 || '').toUpperCase(),
                        flight: (callsign || '').trim(),
                        lon, lat,
                        alt_baro: onGround ? 'ground' : Math.round((baroAltM ?? 0) * 3.28084),
                        gs: velocityMs != null ? Math.round(velocityMs * 1.94384) : 0,
                        track: trueTrack ?? 0,
                        squawk: squawk || null,
                        emergency: null,   // not exposed by /states/all
                        category: OPENSKY_CATEGORY_MAP[category] || '',
                        dbFlags: 0,        // OpenSky has no military-registry flag; category A6 still classifies as MILITARY
                    };
                }).filter(a => a.lon != null && a.lat != null);

                cb(null, JSON.stringify({ ac }));
            });
        }).on('error', cb);
    });
}

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

// ── Flight route / aircraft photo / registry caches ──────────────────────────
// Keyed by the lookup key (callsign / registration / icao24 hex), long TTL
// since routes, photos, and tail-number registry data essentially never
// change. Simple size-bounded Maps, same pattern as _llmCache above — this is
// a local dev tool, not a production cache layer.
const _routeCache = new Map();  // callsign -> { ts, value }
const _photoCache = new Map();  // registration -> { ts, value }
const _regCache   = new Map();  // icao24 hex -> { ts, value }
const ROUTE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;  // 6h
const PHOTO_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const REG_CACHE_TTL_MS   = 30 * 24 * 60 * 60 * 1000; // 30d — static tail-number registry data

function fetchJson(targetUrl) {
    return new Promise((resolve, reject) => {
        // planespotters.net's published API rules (planespotters.net/photo/api,
        // checked 2026-06-27) explicitly require server-side clients to send a
        // unique, descriptive User-Agent naming the app + a contact email/URL —
        // a generic UA (or worse, a spoofed browser UA, which we tried first
        // and made things worse) gets 403'd as unidentified scraping traffic.
        // adsbdb.com/hexdb.io don't enforce this, so the old generic UA worked
        // for those; planespotters specifically does.
        https.get(targetUrl, { headers: {
            'User-Agent': 'Vanguard1-TacticalMap/1.0 (+mailto:jamalrfordii@gmail.com)',
            'Accept': 'application/json,*/*',
        } }, upstream => {
            let body = '';
            upstream.on('data', c => body += c);
            upstream.on('end', () => {
                if (upstream.statusCode !== 200) {
                    reject(new Error(`HTTP ${upstream.statusCode}`));
                    return;
                }
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

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

    function serveStaleOrEmpty() {
        if (_flightCache) {
            console.warn('[proxy] all ADS-B sources failed — serving stale cache');
            res.writeHead(200, { 'Content-Type': _flightCache.contentType });
            res.end(_flightCache.body);
        } else {
            console.warn('[proxy] all ADS-B sources failed and no cache — sending empty');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ac: [] }));
        }
    }

    // A 403/429/anti-bot block sometimes comes back as a 200 with an HTML
    // interstitial (Cloudflare challenge page, etc.) instead of a real error
    // code — checking statusCode alone would cache that garbage for 30s and
    // starve the next source. Validate the actual JSON shape before accepting.
    function acceptBody(bodyStr, sourceLabel) {
        let parsed = null;
        try { parsed = JSON.parse(bodyStr); } catch (_) { /* not JSON */ }
        if (!parsed || !Array.isArray(parsed.ac)) return false;
        console.log(`[proxy] flights served from ${sourceLabel} (${parsed.ac.length} aircraft)`);
        const body = Buffer.from(bodyStr, 'utf8');
        _flightCache = { body, contentType: 'application/json', ts: now };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
        return true;
    }

    // Priority: airplanes.live → adsb.lol → OpenSky (last resort).
    //
    // airplanes.live and adsb.lol are ADSBExchange-compatible feeds that include
    // the `t` (ICAO type code) and `r` (registration) fields on every state —
    // these are what drive the aircraft shape classification system in
    // flightManager.js (NARROWBODY / WIDEBODY / REGIONAL / BIZJET). OpenSky's
    // /states/all endpoint does not include type codes or registrations, so it
    // can only produce COMMERCIAL/CARGO/HELICOPTER/GA shapes. OpenSky is kept
    // as the last-resort fallback (position data is better than nothing) but
    // should never win when either primary mirror is reachable.
    function tryMirror(idx) {
        if (idx >= FLIGHTS_URLS.length) return tryOpenSkyFallback();

        const targetUrl = FLIGHTS_URLS[idx];
        const chunks = [];
        https.get(targetUrl, { headers: { 'User-Agent': 'VANGUARD/1.0 (+local-dev)' } }, upstream => {
            upstream.on('data', c => chunks.push(c));
            upstream.on('end', () => {
                const bodyStr = Buffer.concat(chunks).toString('utf8');
                if (upstream.statusCode === 200 && acceptBody(bodyStr, targetUrl)) return;
                console.warn(`[proxy] ${targetUrl} returned ${upstream.statusCode} — trying next source...`);
                tryMirror(idx + 1);
            });
        }).on('error', err => {
            console.error(`[proxy] ${targetUrl} error: ${err.message} — trying next source...`);
            tryMirror(idx + 1);
        });
    }

    // OpenSky as last resort — provides positions but NOT type codes or
    // registrations, so shape classification degrades to class-only (COMMERCIAL
    // for most aircraft). Only attempted when both primary mirrors fail and
    // credentials are configured.
    function tryOpenSkyFallback() {
        if (!OPENSKY_CLIENT_ID || !OPENSKY_CLIENT_SECRET) return serveStaleOrEmpty();
        console.warn('[proxy] primary mirrors failed — falling back to OpenSky (no type codes)');
        fetchOpenSkyStates((err, bodyStr) => {
            if (!err && acceptBody(bodyStr, 'OpenSky Network (fallback)')) return;
            console.warn(`[proxy] OpenSky fallback also failed (${err ? err.message : 'bad payload'})`);
            serveStaleOrEmpty();
        });
    }

    tryMirror(0);
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const parsed   = url.parse(req.url, true);
    const pathname = parsed.pathname;

    // ── /flights — airplanes.live global aircraft states ─────────────────────
    if (pathname === '/flights') {
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

    // ── /flight-route — origin/destination airport lookup by callsign ────────
    // adsbdb.com is a free, no-key, community ADS-B route database — given a
    // callsign it returns the flight's filed origin/destination airports.
    // ADS-B itself carries no flight-plan data, so this is the only way to
    // answer "where did this aircraft come from / where is it going".
    if (pathname === '/flight-route') {
        const callsign = String(parsed.query.callsign || '').trim().toUpperCase();
        if (!callsign) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Required param: callsign' }));
            return;
        }
        const cached = _routeCache.get(callsign);
        if (cached && Date.now() - cached.ts < ROUTE_CACHE_TTL_MS) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ...cached.value, cached: true }));
            return;
        }
        console.log(`[proxy] → adsbdb route lookup ${callsign}`);
        fetchJson(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`)
            .then(data => {
                const route = data?.response?.flightroute;
                const value = route ? {
                    ok: true,
                    origin:      route.origin?.iata_code || route.origin?.icao_code || null,
                    originName:  route.origin?.municipality || route.origin?.name || null,
                    destination: route.destination?.iata_code || route.destination?.icao_code || null,
                    destName:    route.destination?.municipality || route.destination?.name || null,
                } : { ok: false, error: 'no route on file' };
                if (_routeCache.size > 500) _routeCache.clear();
                _routeCache.set(callsign, { ts: Date.now(), value });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(value));
            })
            .catch(err => {
                console.warn('[proxy] route lookup failed:', err.message);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return;
    }

    // ── /aircraft-reg — registration/type/owner by ICAO24 hex ────────────────
    // Fallback for when the active flight source is OpenSky: its /states/all
    // state vector (see fetchOpenSkyStates above) carries icao24 and callsign
    // but NOT registration or aircraft-type — those simply aren't fields in
    // that endpoint's schema, unlike the ADSBExchange-compatible mirrors
    // (airplanes.live/adsb.lol) where `s.r`/`s.t` come free on every report.
    // hexdb.io is a free, no-key, static tail-number registry keyed by the
    // ICAO24 hex itself, so it works regardless of which live feed is active.
    // This is what makes REGISTRATION/TYPE — and therefore the photo lookup,
    // which needs a registration — work when OpenSky is the primary source.
    if (pathname === '/aircraft-reg') {
        const hex = String(parsed.query.hex || '').trim().toLowerCase();
        if (!hex) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Required param: hex' }));
            return;
        }
        const cached = _regCache.get(hex);
        if (cached && Date.now() - cached.ts < REG_CACHE_TTL_MS) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ...cached.value, cached: true }));
            return;
        }
        console.log(`[proxy] → hexdb.io registry lookup ${hex}`);
        fetchJson(`https://hexdb.io/api/v1/aircraft/${encodeURIComponent(hex)}`)
            .then(data => {
                const value = (data && data.Registration) ? {
                    ok: true,
                    registration: data.Registration || null,
                    typeCode:     data.ICAOTypeCode  || null,
                    operator:     data.RegisteredOwners || null,
                } : { ok: false, error: 'not found' };
                if (_regCache.size > 1000) _regCache.clear();
                _regCache.set(hex, { ts: Date.now(), value });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(value));
            })
            .catch(err => {
                console.warn('[proxy] registry lookup failed:', err.message);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return;
    }

    // ── /aircraft-photo — real photo of the specific airframe by registration ─
    // planespotters.net is a free, no-key public photo API. Returns the first
    // available photo + photographer credit (their API requires attribution).
    if (pathname === '/aircraft-photo') {
        const reg = String(parsed.query.reg || '').trim().toUpperCase();
        if (!reg) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Required param: reg' }));
            return;
        }
        const cached = _photoCache.get(reg);
        if (cached && Date.now() - cached.ts < PHOTO_CACHE_TTL_MS) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ...cached.value, cached: true }));
            return;
        }
        console.log(`[proxy] → planespotters photo lookup ${reg}`);
        fetchJson(`https://api.planespotters.net/pub/photos/reg/${encodeURIComponent(reg)}`)
            .then(data => {
                const photo = data?.photos?.[0];
                const value = photo ? {
                    ok: true,
                    thumbnail: photo.thumbnail_large?.src || photo.thumbnail?.src || null,
                    link:      photo.link || null,
                    photographer: photo.photographer || null,
                } : { ok: false, error: 'no photo on file' };
                if (_photoCache.size > 500) _photoCache.clear();
                _photoCache.set(reg, { ts: Date.now(), value });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(value));
            })
            .catch(err => {
                console.warn('[proxy] photo lookup failed:', err.message);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
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
            if (!AI_PROVIDER) {
                res.writeHead(503);
                res.end(JSON.stringify({ error: 'No AI provider configured. Set ANTHROPIC_API_KEY or GEMINI_API_KEY in .env.' }));
                return;
            }

            let context;
            try { context = JSON.parse(body).context; }
            catch (_) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid JSON body' }));
                return;
            }

            // Build a readable event summary for the model
            const userMsg = buildEventSummary(context);
            console.log(`[proxy] → ${AI_PROVIDER} assessment: ${context?.event} | score: ${context?.score ?? '?'}`);

            try {
                const text       = await callLLM(COPILOT_SYSTEM, userMsg, 200);
                const assessment = text || 'Assessment unavailable.';
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ assessment }));
            } catch (err) {
                console.error(`[proxy] ${AI_PROVIDER} API error:`, err.message);
                res.writeHead(502);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // ── /ai-discover — cross-domain AI Discovery pass (discoveryManager.js) ──
    if (pathname === '/ai-discover' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            if (!AI_PROVIDER) {
                res.writeHead(503);
                res.end(JSON.stringify({ error: 'No AI provider configured. Set ANTHROPIC_API_KEY or GEMINI_API_KEY in .env.' }));
                return;
            }

            let snapshot, triggerType, triggerText, menu;
            try {
                const parsedBody = JSON.parse(body);
                snapshot    = parsedBody.snapshot;
                // OPTIONS mode (2026-07-21): present only when discoveryManager.js's
                // escalation has a named trigger type with a menu attached (see
                // discoveryRules.js's OPTION_MENUS). Absent → falls straight back to
                // the original free-assessment DISCOVERY_SYSTEM path below, unchanged.
                triggerType = typeof parsedBody.triggerType === 'string' ? parsedBody.triggerType : null;
                triggerText = typeof parsedBody.triggerText === 'string' ? parsedBody.triggerText : '';
                menu        = Array.isArray(parsedBody.menu) && parsedBody.menu.length ? parsedBody.menu : null;
            } catch (_) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid JSON body' }));
                return;
            }

            const useOptionsMode = !!(triggerType && menu);
            const userMsg = useOptionsMode
                ? buildOptionsSummary(snapshot, triggerType, triggerText, menu)
                : buildDiscoverySummary(snapshot);
            console.log(`[proxy] → ${AI_PROVIDER} discovery pass ${useOptionsMode ? `(OPTIONS: ${triggerType})` : '(assessment)'} `
                + `| stories: ${snapshot?.developingStories?.length ?? 0} | flagged: ${snapshot?.integrityFlagged?.length ?? 0}`);

            // Ground truth first — log the exact snapshot the model is about
            // to see, BEFORE the call. If the model errors out, the event is
            // still on record; if it doesn't, we have an id to tag the finding.
            const eventId = memoryStore.appendEvent(snapshot, { kind: 'pass', triggerType });

            try {
                // Token budget (2026-07-21, live-caught): 500 was tuned for
                // DISCOVERY_SYSTEM's short prose assessment. OPTIONS_SYSTEM has to
                // rank every item in a 3-4 entry menu with a full grounded-reasoning
                // sentence EACH, plus an actions array — a real live response
                // (COORDINATED_MULTI_VESSEL trigger) measurably ran out of budget
                // mid-way through its actions array ("Unterminated string in JSON"),
                // silently losing the whole pass to parseOptionsResponse's
                // rawFallback path instead of rendering cards. 1024 gives real
                // headroom; DISCOVERY_SYSTEM keeps its original 500.
                const raw    = await callLLMWithTools(useOptionsMode ? OPTIONS_SYSTEM : DISCOVERY_SYSTEM, userMsg, useOptionsMode ? 1024 : 500);
                const result = useOptionsMode ? parseOptionsResponse(raw) : parseDiscoveryResponse(raw);
                if (useOptionsMode) { result.triggerType = triggerType; result.triggerText = triggerText; }
                memoryStore.appendFinding(eventId, result, { provider: AI_PROVIDER, kind: 'pass' });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (err) {
                console.error(`[proxy] ${AI_PROVIDER} discovery API error:`, err.message);
                res.writeHead(502);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // ── /ai-query — direct operator Q&A against the live snapshot ────────────
    // Same snapshot shape as /ai-discover, but answers a specific question
    // instead of scanning autonomously. discoveryManager.js's query(q) calls this.
    if (pathname === '/ai-query' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            if (!AI_PROVIDER) {
                res.writeHead(503);
                res.end(JSON.stringify({ error: 'No AI provider configured. Set ANTHROPIC_API_KEY or GEMINI_API_KEY in .env.' }));
                return;
            }

            let question, snapshot, history;
            try {
                const parsed = JSON.parse(body);
                question = parsed.question;
                snapshot = parsed.snapshot;
                history  = parsed.history;
            } catch (_) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid JSON body' }));
                return;
            }
            if (!question || !String(question).trim()) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Missing question' }));
                return;
            }

            // Conversational memory (phase 2, memory/decisions.md 2026-06-21) —
            // discoveryManager.js sends its last few Q&A turns; folded into the
            // prompt as context only, never as new ground truth (see QUERY_SYSTEM).
            let historyBlock = '';
            if (Array.isArray(history) && history.length) {
                historyBlock = '\n\nPRIOR CONVERSATION (most recent last):\n'
                    + history.map(h => `Q: ${h.question}\nA: ${h.answer}`).join('\n');
            }
            const userMsg = `${buildDiscoverySummary(snapshot)}${historyBlock}\n\nOPERATOR QUESTION: ${question}`;
            console.log(`[proxy] → ${AI_PROVIDER} query: "${question}"`);

            const eventId = memoryStore.appendEvent(snapshot, { kind: 'query', question });

            try {
                const raw = await callLLMWithTools(QUERY_SYSTEM, userMsg, 300);
                let answer;
                try {
                    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
                    answer = JSON.parse(cleaned).answer;
                } catch (_) {
                    answer = raw; // model didn't comply with JSON shape — surface raw text anyway
                }
                answer = answer || 'No answer.';
                memoryStore.appendFinding(eventId, { answer }, { provider: AI_PROVIDER, kind: 'query' });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ answer }));
            } catch (err) {
                console.error(`[proxy] ${AI_PROVIDER} query API error:`, err.message);
                res.writeHead(502);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // ── /memory/recent — read back the persistent Discovery memory ───────────
    // GET /memory/recent?kind=events|findings&limit=N
    // Used by the eval harness and (later) any UI that wants to show history.
    // Read-only: this endpoint can never write, by design — the only writers
    // are the appendEvent/appendFinding calls above, both server-side.
    if (pathname === '/memory/recent' && req.method === 'GET') {
        const kind  = parsed.query.kind === 'findings' ? 'findings' : 'events';
        const limit = Math.min(parseInt(parsed.query.limit, 10) || 50, 500);
        try {
            const items = memoryStore.readRecent(kind, limit);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ kind, count: items.length, items }));
        } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }


    // ── /memory/log-pass — free telemetry, NO LLM involved (POST) ────────────
    // One call per discoveryManager tick (rule-only or escalated alike). This
    // is what lets an analyst answer "has the filter been behaving
    // consistently for the last N hours" without babysitting a live tab —
    // see memory/decisions.md, 2026-06-21 "rule engine monitoring" entry.
    if (pathname === '/memory/log-pass' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            let data;
            try { data = JSON.parse(body); }
            catch (_) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid JSON body' }));
                return;
            }
            try {
                const id = memoryStore.appendRulePass(data);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, id }));
            } catch (err) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // ── /memory/rule-stats — rolled-up rule-engine health (GET) ──────────────
    // GET /memory/rule-stats?hours=N (default 24). Pure aggregation of
    // ruleEngine.jsonl — escalation rate, Claude error rate, finding counts.
    if (pathname === '/memory/rule-stats' && req.method === 'GET') {
        const hours = Math.min(parseInt(parsed.query.hours, 10) || 24, 24 * 30);
        try {
            const summary = memoryStore.summarizeRulePasses(hours);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(summary));
        } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message }));
        }
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
    res.end('Not found. Use /flights, /flight-route?callsign=, /aircraft-photo?reg=, /aircraft-reg?hex=, /satellites?group=<name>, /cables, /weather, /gibs-tile, /memory/recent, /memory/rule-stats, or POST /ai-assess, /ai-discover, /memory/log-pass');
});

server.listen(PORT, () => {
    console.log(`[flight-proxy] Running at http://localhost:${PORT}`);
    console.log('[flight-proxy]   /flights                  → airplanes.live');
    console.log('[flight-proxy]   /flight-route?callsign=    → adsbdb.com route lookup');
    console.log('[flight-proxy]   /aircraft-photo?reg=       → planespotters.net photo lookup');
    console.log('[flight-proxy]   /aircraft-reg?hex=         → hexdb.io registration/type fallback (OpenSky source)');
    console.log('[flight-proxy]   /satellites?group=<name>  → Celestrak TLE');
    console.log('[flight-proxy]   /cables                   → Telegeography cable GeoJSON');
    console.log('[flight-proxy]   /gibs-tile?layer=&date=&tileset=&z=&row=&col=  → NASA GIBS');
    console.log('[flight-proxy]   /weather?lat=&lon=&key=     → OpenWeatherMap');
    console.log('[flight-proxy]   /memory/recent?kind=events|findings&limit=N → Discovery memory log');
    console.log('[flight-proxy]   /memory/rule-stats?hours=N  → rule-engine health summary');
    console.log('[flight-proxy]   POST /memory/log-pass        → rule-engine pass telemetry (free)');
    console.log('[flight-proxy] Groups: stations | starlink | gps | weather');
    console.log(`[flight-proxy]   AI provider: ${AI_PROVIDER || '(none — set ANTHROPIC_API_KEY or GEMINI_API_KEY in .env)'}`);
    console.log('[flight-proxy] Press Ctrl+C to stop.');
});
