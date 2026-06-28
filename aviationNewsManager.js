// aviationNewsManager.js — Aviation-relevant news for the Altitude Watch panel
//
// Task #13 ("Add flight news to Altitude Watch panel"). Deliberately a small,
// standalone sibling of feedManager.js rather than an extension of it — Feed
// tab is maritime-only by design (its keyword gates assume that domain), and
// the architecture rule in CLAUDE.md is "communicate between managers via
// events, never import one manager into another." Same rss2json proxy
// pattern, same staggering, much smaller surface: one list, no tags/pins.
//
// Renders into #aw-news-list inside the Altitude Watch panel (index.html).
// True NOTAMs require an aviation-authority API key we don't have; this
// covers the next-best signal — aviation trade/incident press, filtered for
// airspace/closure/incident relevance — which is what task #12's
// war-signal scoping doc (see config.js AIRSPACE_AVOIDANCE block and
// airspaceAvoidanceManager.js) assumes will eventually need a corroborating
// news layer anyway.

const RSS2JSON_BASE = 'https://api.rss2json.com/v1/api.json?count=8&rss_url=';

const SOURCES = [
    { id: 'avh',  label: 'AV HERALD',  url: 'https://avherald.com/rss.php' },
    { id: 'avweb', label: 'AVWEB',     url: 'https://www.avweb.com/feed/' },
    { id: 'simple', label: 'SIMPLEFLY', url: 'https://simpleflying.com/feed/' },
];

// Relevance gate — must mention something airspace/incident/closure related.
// Kept deliberately narrower than feedManager's maritime gate: aviation trade
// press runs a lot of pure-business content (route launches, earnings) that
// has nothing to do with the "what's happening in the sky right now" purpose
// of this panel.
const RELEVANCE_GATE = [
    'airspace', 'closure', 'closed', 'no-fly', 'notam', 'diversion', 'diverted',
    'grounded', 'incident', 'emergency landing', 'mayday', 'squawk', 'faa',
    'easa', 'icao', 'conflict zone', 'war zone', 'missile', 'drone', 'strike',
    'shot down', 'overflight', 'reroute', 'rerouted', 'sanctions', 'military',
];

let _articles = [];
let _fetching = false;
let _lastFetch = 0;
const POLL_MS = 15 * 60 * 1000;

function _esc(str) {
    return String(str ?? '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}

function _relTime(pubDate) {
    const d = new Date(pubDate);
    if (isNaN(d.getTime())) return '';
    const mins = Math.floor((Date.now() - d) / 60000);
    if (mins < 1) return 'NOW';
    if (mins < 60) return `${mins}M`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}H`;
    return `${Math.floor(hrs / 24)}D`;
}

function _isRelevant(item) {
    const t = `${item.title} ${item.description || ''}`.toLowerCase();
    return RELEVANCE_GATE.some(k => t.includes(k));
}

async function _fetchSource(src) {
    try {
        const url = RSS2JSON_BASE + encodeURIComponent(src.url);
        const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
        if (!res.ok) return [];
        const data = await res.json();
        if (data.status !== 'ok' || !Array.isArray(data.items)) return [];
        return data.items.map(item => ({
            id: `${src.id}::${(item.link || item.title || '').slice(0, 120)}`,
            title: (item.title || '(untitled)').trim(),
            link: item.link || '#',
            pubDate: item.pubDate || new Date().toISOString(),
            sourceLabel: src.label,
            description: (item.description || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(),
        }));
    } catch (err) {
        console.warn(`[AvNews] ${src.id} fetch failed:`, err.message);
        return [];
    }
}

function _render() {
    const list = document.getElementById('aw-news-list');
    if (!list) return;
    if (!_articles.length) {
        list.innerHTML = `<div class="vp-empty" style="margin-top:4px;">${_fetching ? 'FETCHING…' : 'NO AVIATION NEWS LOADED'}</div>`;
        return;
    }
    list.innerHTML = _articles.slice(0, 10).map(a => `
        <a class="aw-news-row" href="${_esc(a.link)}" target="_blank" rel="noopener"
           style="display:block; border-left:3px solid #40c4ff; padding:5px 8px; margin:2px 0;
                  background:rgba(255,255,255,0.02); text-decoration:none;">
            <div style="display:flex; justify-content:space-between; gap:6px;">
                <span style="font-size:9px; color:#8aabc4;">${_esc(a.sourceLabel)}</span>
                <span style="font-size:9px; color:#5c7b94;">${_relTime(a.pubDate)}</span>
            </div>
            <div style="font-size:11px; color:#cfe3f1; line-height:1.3; margin-top:2px;">${_esc(a.title)}</div>
        </a>
    `).join('');
}

async function _refresh() {
    if (_fetching) return;
    _fetching = true;
    _render();

    const seen = new Set();
    const fresh = [];
    for (const src of SOURCES) {
        const items = await _fetchSource(src);
        await new Promise(r => setTimeout(r, 1150)); // respect rss2json ~1 req/sec, same as feedManager.js
        for (const item of items) {
            if (!_isRelevant(item) || seen.has(item.id)) continue;
            fresh.push(item);
            seen.add(item.id);
        }
    }
    fresh.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    _articles = fresh.slice(0, 30);
    _fetching = false;
    _lastFetch = Date.now();
    _render();
}

export function initAviationNewsManager() {
    const list = document.getElementById('aw-news-list');
    if (!list) { console.warn('[AvNews] #aw-news-list missing'); return; }

    _render();
    _refresh();

    // Altitude Watch panel has no visibility flag of its own to check (it's a
    // standalone panel, not a tab) — same always-on polling as initAltitudeWatch.
    setInterval(() => {
        if (Date.now() - _lastFetch > POLL_MS) _refresh();
    }, 60_000);

    window.aviationNewsManager = { refresh: _refresh, getArticles: () => _articles };
}
