// equasis-lookup.js — server-side Equasis vessel dossier fetcher.
//
// Used by flight-proxy.js to enrich a vessel by IMO: registered owner, ISM
// manager, flag, classification society, build year, detention count. Free
// Equasis account required — EQUASIS_USER / EQUASIS_PASS in .env (gitignored,
// server-side only).
//
// Equasis has NO API — this drives its web session: GET home (cookie) → POST
// login (follow redirect) → POST ship search by IMO → parse HTML. The login
// 302-redirects, so we follow redirects while carrying cookies. On failure the
// response includes a `diag` block (status codes, sizes) so problems are
// debuggable without guesswork.

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const HOST        = 'www.equasis.org';
const ORIGIN      = 'https://www.equasis.org';
const CACHE_FILE  = path.join(__dirname, 'equasis-cache-v2.json');   // v2 = rich dossier schema
const UA          = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) VANGUARD-research';
const SESSION_TTL = 20 * 60 * 1000;

let _cache = {};
try { _cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (_) {}
let _session = null;   // { cookie, ts }

function rawRequest(opts, body) {
    return new Promise((resolve, reject) => {
        const r = https.request(opts, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode, headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        r.on('error', reject);
        if (body) r.write(body);
        r.end();
    });
}

function addCookies(jar, setCookie) {
    for (const c of (setCookie || [])) {
        const [pair] = c.split(';');
        const [k] = pair.split('=');
        jar.set(k.trim(), pair.trim());
    }
}
const cookieHeader = (jar) => [...jar.values()].join('; ');

// Request that follows up to `max` redirects, carrying a cookie jar.
async function request(method, pathStr, { jar, body, referer } = {}, max = 5) {
    jar = jar || new Map();
    let p = pathStr;
    for (let i = 0; i <= max; i++) {
        const headers = {
            'User-Agent': UA, 'Cookie': cookieHeader(jar),
            'Accept': 'text/html,application/xhtml+xml,*/*',
        };
        if (referer) headers['Referer'] = referer;
        if (body) {
            headers['Content-Type']   = 'application/x-www-form-urlencoded';
            headers['Content-Length'] = Buffer.byteLength(body);
            headers['Origin']         = ORIGIN;
        }
        const res = await rawRequest({ host: HOST, path: p, method: (i === 0 ? method : 'GET'), headers }, i === 0 ? body : null);
        addCookies(jar, res.headers['set-cookie']);
        if (res.status >= 300 && res.status < 400 && res.headers.location) {
            p = res.headers.location.replace(ORIGIN, '');   // follow redirect (GET)
            body = null;
            continue;
        }
        return { ...res, jar, finalPath: p };
    }
    throw new Error('too many redirects');
}

async function login() {
    const user = process.env.EQUASIS_USER, pass = process.env.EQUASIS_PASS;
    if (!user || !pass) throw new Error('EQUASIS_USER / EQUASIS_PASS not set in .env');
    const jar = new Map();

    const home = await request('GET', '/EquasisWeb/public/HomePage?fs=HomePage', { jar });
    const form = `j_email=${encodeURIComponent(user)}&j_password=${encodeURIComponent(pass)}`;
    const auth = await request('POST', '/EquasisWeb/authen/HomePage', {
        jar, body: form, referer: ORIGIN + '/EquasisWeb/public/HomePage?fs=HomePage',
    });

    const authed = /logout|déconnexion|deconnexion|Welcome|restricted/i.test(auth.body) || auth.finalPath.includes('restricted');
    _session = { cookie: cookieHeader(jar), jar, ts: Date.now(),
                 diag: { homeStatus: home.status, authStatus: auth.status, authFinal: auth.finalPath, authLen: auth.body.length, authed } };
    return _session;
}

async function fetchShipHTML(imo) {
    if (!_session || Date.now() - _session.ts > SESSION_TTL) await login();
    const ref = ORIGIN + '/EquasisWeb/restricted/Search?fs=Search';
    const get = (path) => request('GET', path, { jar: _session.jar, referer: ref });
    // Three tabs, each a direct GET keyed by IMO. ShipInfo is required; the other
    // two are best-effort (some vessels have no inspection/history records).
    const info = await get(`/EquasisWeb/restricted/ShipInfo?fs=ShipInfo&P_IMO=${encodeURIComponent(imo)}`);
    let inspHtml = '', histHtml = '';
    try { inspHtml = (await get(`/EquasisWeb/restricted/ShipInspection?fs=ShipInfo&P_IMO=${encodeURIComponent(imo)}`)).body; } catch (_) {}
    try { histHtml = (await get(`/EquasisWeb/restricted/ShipHistory?fs=ShipInfo&P_IMO=${encodeURIComponent(imo)}`)).body; } catch (_) {}
    return { html: info.body, inspHtml, histHtml, status: info.status, finalPath: info.finalPath, login: _session.diag };
}

// ── Dependency-free HTML helpers ─────────────────────────────────────────────
const strip = (h) => String(h || '').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#3[49];|&apos;/gi, "'")
    .replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ').trim();
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tableBlocks = (html) => html.match(/<table[\s\S]*?<\/table>/gi) || [];
const rowCells = (tableHtml) => (tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) || [])
    .map(tr => (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(strip));

// Old loose label→value (kept as a fallback for the bootstrap-grid particulars).
function field(html, ...labels) {
    for (const label of labels) {
        const re = new RegExp(esc(label) + '[\\s\\S]{0,60}?<\\/[^>]+>\\s*<[^>]*>([^<]{1,90})', 'i');
        const m = html.match(re);
        if (m && strip(m[1])) return strip(m[1]);
    }
    return null;
}

// Particulars live in a <div class="row"><div class="col"><b>Label</b></div>
// <div class="col">Value</div></div> grid. Pull the value div after the label.
function gridField(html, ...labels) {
    for (const label of labels) {
        const re = new RegExp('<b[^>]*>\\s*' + esc(label) + '\\s*:?\\s*<\\/b>\\s*<\\/div>\\s*<div[^>]*>([\\s\\S]*?)<\\/div>', 'i');
        const m = html.match(re);
        if (m) { const v = strip(m[1]); if (v) return v; }
    }
    return field(html, ...labels);   // graceful fallback to the loose matcher
}

function hName(html) {
    const m = html.match(/<h4[^>]*>[\s\S]*?<b[^>]*>([^<]+)<\/b>/i);
    return m ? strip(m[1]) : null;
}

// Management/ownership: scan tables for rows carrying a company role.
function parseManagement(html) {
    const out = [], seen = new Set();
    for (const tb of tableBlocks(html)) {
        for (const cells of rowCells(tb)) {
            if (cells.length < 3) continue;
            const roleIdx = cells.findIndex(c => /\b(owner|manager|operator|charter|ISM|DOC company)\b/i.test(c));
            if (roleIdx < 0) continue;
            const role = cells[roleIdx];
            const rest = cells.filter((_, i) => i !== roleIdx);
            const company = rest.find(c => /[A-Za-z]{3,}/.test(c) && !/^\d+$/.test(c) && !/^(owner|manager|operator)/i.test(c)) || '';
            const date = (cells.find(c => /\d{2}\/\d{2}\/\d{4}/.test(c)) || '');
            if (!company) continue;
            const key = role + '|' + company;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ role, company, date });
        }
    }
    return out;
}

// PSC inspections: data rows carry a dd/mm/yyyy date; detention is a Y/N cell.
function parseInspections(html) {
    const out = [];
    for (const tb of tableBlocks(html)) {
        const rows = rowCells(tb);
        if (!rows.some(r => /detention/i.test(r.join(' '))) && !/detention/i.test(tb)) continue;
        for (const cells of rows) {
            if (cells.length < 3) continue;
            const date = cells.find(c => /\d{2}\/\d{2}\/\d{4}/.test(c));
            if (!date) continue;   // skips header + spacer rows
            const detIdx = cells.findIndex(c => /^(y|yes|n|no)$/i.test(c.trim()));
            const detained = detIdx >= 0 ? /^(y|yes)$/i.test(cells[detIdx].trim())
                                         : /detained/i.test(cells.join(' '));
            out.push({ authority: cells[0] || '', port: cells[1] || '', date, detained });
        }
    }
    return out;
}

// Ship history: classify each table by its header (former names / flags).
function parseHistory(html) {
    const names = [], flags = [];
    for (const tb of tableBlocks(html)) {
        const rows = rowCells(tb);
        if (rows.length < 2) continue;
        const header = (rows[0] || []).join(' ').toLowerCase();
        const body = rows.slice(1).filter(r => r.length >= 2 && r[0]);
        if (/name/.test(header) && !/company/.test(header)) for (const c of body) names.push({ value: c[0], date: c[1] || '' });
        else if (/flag/.test(header)) for (const c of body) flags.push({ value: c[0], date: c[1] || '' });
    }
    return { names, flags };
}

function parse(infoHtml, inspHtml, histHtml, imo) {
    const flagCodeM = infoHtml.match(/\/flags?\/([A-Za-z]{2,3})\.(?:png|gif|jpe?g)/i);
    const flagCode  = flagCodeM ? flagCodeM[1].toUpperCase() : null;
    // Country name sits in a "(Panama)" cell next to the flag image.
    const flagCountryM = infoHtml.match(/<b[^>]*>\s*Flag\s*:?\s*<\/b>[\s\S]{0,240}?\(([^)<]{2,40})\)/i);
    const flagCountry  = flagCountryM ? strip(flagCountryM[1]) : null;

    const management    = parseManagement(infoHtml);
    const classSociety  = gridField(infoHtml, 'Classification society', 'Class');
    const inspections   = parseInspections(inspHtml);
    const history       = parseHistory(histHtml);

    const owner   = (management.find(m => /owner/i.test(m.role)) || {}).company
                    || field(infoHtml, 'Registered owner', 'Owner');
    const manager = (management.find(m => /\bISM\b|manager/i.test(m.role)) || {}).company
                    || field(infoHtml, 'ISM Manager', 'Ship manager', 'Manager');

    const data = {
        schema: 2,
        imo,
        name:         hName(infoHtml) || gridField(infoHtml, 'Name of ship', 'Ship name'),
        type:         gridField(infoHtml, 'Type of ship', 'Ship type', 'Type'),
        grossTonnage: gridField(infoHtml, 'Gross tonnage', 'Gross Tonnage', 'GT'),
        dwt:          gridField(infoHtml, 'DWT', 'Deadweight'),
        built:        gridField(infoHtml, 'Year of build', 'Date of build', 'Year built', 'Built'),
        callSign:     gridField(infoHtml, 'Call Sign', 'Call sign'),
        mmsi:         gridField(infoHtml, 'MMSI'),
        flag:         flagCountry || gridField(infoHtml, 'Flag') || flagCode,
        flagCode,
        status:       gridField(infoHtml, 'Status'),
        class:        classSociety,
        owner, manager,
        management, classification: classSociety ? [{ society: classSociety }] : [],
        inspections, history,
        detentions:   inspections.filter(i => i.detained).length,
        inspectionCount: inspections.length,
        fetchedAt: Date.now(),
    };
    data.found = !!(data.name || owner || manager || data.grossTonnage || management.length);
    return data;
}

// Resolve an IMO from a vessel name via the Equasis search endpoint, so the
// dossier works automatically without the analyst typing an IMO.
async function searchByName(name) {
    if (!_session || Date.now() - _session.ts > SESSION_TTL) await login();
    const body = `P_PAGE=1&P_PAGE_COMP=1&P_PAGE_SHIP=1`
        + `&P_ENTREE_ENTETE=${encodeURIComponent(name)}&P_ENTREE_ENTETE_HIDDEN=${encodeURIComponent(name)}`;
    const res = await request('POST', '/EquasisWeb/restricted/Search?fs=Search', {
        jar: _session.jar, body, referer: ORIGIN + '/EquasisWeb/restricted/Search?fs=Search',
    });
    const cands = [];
    for (const row of res.body.split(/<tr[\s>]/i)) {
        const m = row.match(/>\s*(\d{7})\s*</);   // 7-digit IMO link
        if (m) cands.push({ imo: m[1], text: strip(row).toUpperCase() });
    }
    return cands;
}

// AIS flags are ISO alpha-3 codes (GBR, PAN); Equasis lists flags by country name.
// Map the common maritime flag states so we can actually compare them.
const FLAG_NAMES = {
    PAN:['panama'], LBR:['liberia'], MHL:['marshall'], BHS:['bahamas'], HKG:['hong kong'],
    SGP:['singapore'], MLT:['malta'], CYP:['cyprus'], GRC:['greece'], CHN:['china'],
    JPN:['japan'], KOR:['korea'], GBR:['united kingdom','britain'], USA:['united states','usa'],
    NOR:['norway'], DNK:['denmark'], DEU:['germany'], NLD:['netherlands'], ITA:['italy'],
    FRA:['france'], ESP:['spain'], PRT:['portugal','madeira'], RUS:['russia'], TUR:['turkey','türkiye'],
    IND:['india'], IDN:['indonesia'], MYS:['malaysia'], PHL:['philippines'], THA:['thailand'],
    VNM:['viet'], ARE:['emirates'], SAU:['saudi'], IRN:['iran'], TWN:['taiwan'], AUS:['australia'],
    CAN:['canada'], BRA:['brazil'], ATG:['antigua'], VCT:['vincent'], COK:['cook'], BRB:['barbados'],
    BMU:['bermuda'], GIB:['gibraltar'], ISL:['iceland'], SWE:['sweden'], FIN:['finland'], POL:['poland'],
    EST:['estonia'], LVA:['latvia'], LTU:['lithuania'], HRV:['croatia'], BEL:['belgium'], IRL:['ireland'],
    BGR:['bulgaria'], UKR:['ukraine'], CHE:['switzerland'], LKA:['sri lanka'], PAK:['pakistan'],
};

// true = flag agrees, false = flag contradicts, null = can't tell (unmapped flag).
function flagAgrees(rowText, flag) {
    const names = FLAG_NAMES[String(flag || '').toUpperCase().trim()];
    if (!names) return null;
    return names.some(n => rowText.includes(n.toUpperCase()));
}

// Returns { imo, confidence, reason, candidates? }. confidence: high|medium|low|none.
// Will NOT guess when the name is only a fuzzy hit and the flag disagrees.
function pickBest(cands, name, flag) {
    if (!cands.length) return { imo: null, confidence: 'none', reason: 'no search results' };
    const n = String(name || '').toUpperCase().trim();
    const nameRe = n ? new RegExp('\\b' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b') : null;
    const tagged = cands.map(c => ({
        imo: c.imo,
        exact: !!(nameRe && nameRe.test(c.text)),
        flag: flagAgrees(c.text, flag),   // true / false / null
    }));

    let p = tagged.find(c => c.exact && c.flag === true);
    if (p) return { imo: p.imo, confidence: 'high', reason: 'name + flag match' };

    p = tagged.find(c => c.exact && c.flag !== false);   // exact name, flag unknown/agnostic
    if (p) return { imo: p.imo, confidence: 'medium', reason: 'exact name match' };

    p = tagged.find(c => c.flag === true);                // fuzzy name but flag agrees
    if (p) return { imo: p.imo, confidence: 'low', reason: 'flag match (name inexact)' };

    if (tagged.length === 1 && tagged[0].flag !== false)  // sole result, no contradiction
        return { imo: tagged[0].imo, confidence: 'low', reason: 'sole result' };

    // Ambiguous — don't guess. Hand back the candidate IMOs for manual disambiguation.
    return { imo: null, confidence: 'none', reason: 'multiple matches, none confident',
             candidates: tagged.slice(0, 6).map(c => c.imo) };
}

async function lookup(opts) {
    // Accept a bare IMO string (back-compat) or { imo, name, flag }.
    const o = (typeof opts === 'string') ? { imo: opts } : (opts || {});
    let imo = String(o.imo || '').replace(/\D/g, '');
    let match = imo.length >= 6 ? { confidence: 'exact', reason: 'IMO supplied' } : null;

    // No IMO? Resolve it from the vessel name (which the map always has).
    if (imo.length < 6 && o.name) {
        try {
            match = pickBest(await searchByName(o.name), o.name, o.flag);
            if (match && match.imo) imo = match.imo;
        } catch (e) { console.warn('[equasis] name resolve failed:', e.message); match = { confidence: 'none', reason: e.message }; }
    }
    if (imo.length < 6) return {
        ok: false,
        error: o.name ? `couldn't confidently match "${o.name}"${o.flag ? ' (' + o.flag + ')' : ''} — enter an IMO to confirm` : 'invalid IMO',
        match,
    };
    if (_cache[imo]) return { ok: true, cached: true, data: _cache[imo], match };
    try {
        const r = await fetchShipHTML(imo);
        const data = parse(r.html, r.inspHtml, r.histHtml, imo);
        const looksLikeLogin = /j_password/i.test(r.html) || r.html.indexOf('authen/HomePage') >= 0;
        const diag = { searchStatus: r.status, searchFinal: r.finalPath, htmlBytes: r.html.length, login: r.login, looksLikeLogin };
        if (!data.found) {
            console.warn('[equasis] no fields parsed —', JSON.stringify(diag));
            return { ok: false, error: 'no data parsed', diag };
        }
        _cache[imo] = data;
        try { fs.writeFileSync(CACHE_FILE, JSON.stringify(_cache, null, 2)); } catch (_) {}
        console.log(`[equasis] ${imo}: ${data.name || 'vessel'} · ${data.flag || '?'} · ${data.detentions} detention refs · match=${match ? match.confidence : 'n/a'}`);
        return { ok: true, cached: false, data, match };
    } catch (e) {
        console.warn('[equasis] error:', e.message);
        return { ok: false, error: e.message };
    }
}

module.exports = { lookup, parse, pickBest, _internals: { parseManagement, parseInspections, parseHistory, gridField } };
