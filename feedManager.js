// feedManager.js — Feed tab: maritime threat intelligence + shipping news
// Architecture: RSS → rss2json CORS proxy → classify → two-section render

const RSS2JSON_BASE = 'https://api.rss2json.com/v1/api.json?count=10&rss_url=';

// ── News sources ──────────────────────────────────────────────────────────────
const SOURCES = [
    // Intel tier — naval, security, incident-heavy
    { id: 'usni',   label: 'USNI',     url: 'https://news.usni.org/feed',                       tier: 'intel' },
    { id: 'naval',  label: 'NAVAL',    url: 'https://navaltoday.com/feed/',                     tier: 'intel' },
    // News tier — general maritime trade press
    { id: 'gcapt',  label: 'gCAPTAIN', url: 'https://gcaptain.com/feed/',                       tier: 'news'  },
    { id: 'splash', label: 'SPLASH',   url: 'https://splash247.com/feed/',                      tier: 'news'  },
    { id: 'mexec',  label: 'MAREX',    url: 'https://maritime-executive.com/feed',               tier: 'news'  },
    { id: 'hship',  label: 'HELLENIC', url: 'https://www.hellenicshippingnews.com/feed/',        tier: 'news'  },
];

// Keywords that bump any article to INTEL tier regardless of source
const INTEL_BUMP = [
    'sanction', 'seized', 'attack', 'piracy', 'pirate', 'houthi', 'drone',
    'missile', 'military', 'navy', 'naval', 'blockade', 'conflict', 'explosion',
    'threat', 'ofac', 'embargo', 'shadow fleet', 'grey fleet', 'interdiction',
    'iran', 'russia', 'north korea', 'smuggl', 'weapons', 'coast guard intercept',
    'weapons cache', 'dark vessel', 'spoofing', 'identity change',
];

// Maritime relevance gate — article must pass at LEAST ONE term from each tier.
//
// MARITIME_GATE_STRONG: unambiguously maritime operational terms.
// An article matching any of these is clearly relevant.
// (Excludes 'navy'/'naval' — too generic; matches food, budget, admin articles)
const MARITIME_GATE_STRONG = [
    'ship', 'vessel', 'tanker', 'cargo ship', 'maritime', 'shipping',
    'container ship', 'bulk carrier', 'lng carrier', 'offshore',
    'seafarer', 'seaborne', 'chokepoint', 'strait', 'canal',
    'suez', 'hormuz', 'malacca', 'bosporus', 'red sea', 'bab el-mandeb',
    'panama canal', 'taiwan strait', 'port call', 'anchorage', 'berth',
    'coast guard intercept', 'ais signal', 'dark vessel',
    'piracy', 'pirate', 'shadow fleet', 'grey fleet',
    'warship', 'frigate', 'destroyer', 'aircraft carrier', 'corvette',
    'submarine cable', 'underwater cable',
];

// MARITIME_GATE_BROAD: broader terms that count only if at least one STRONG term
// is also present OR the source is already an intel-tier source (USNI/NAVAL).
// This avoids false positives like "oil prices" or "trade deal" in general news.
const MARITIME_GATE_BROAD = [
    'port', 'harbor', 'harbour', 'fleet', 'freight', 'container',
    'voyage', 'lng', 'oil tanker', 'bulk cargo', 'shipping lane',
    'sea lane', 'naval vessel', 'navy ship', 'patrol vessel',
];

// Legacy alias kept so _isMaritime() below works with both tiers
const MARITIME_GATE = MARITIME_GATE_STRONG;

// ── Tag filter → keyword mapping (used by Feed UI and SITREP intel interpretation)
const TAG_KEYS = {
    SANCTIONS:  ['sanction', 'ofac', 'embargo', 'shadow fleet', 'grey fleet'],
    INCIDENT:   ['attack', 'seized', 'explosion', 'drone', 'missile', 'piracy', 'pirate', 'incident'],
    CHOKEPOINT: ['strait', 'suez', 'hormuz', 'malacca', 'bosporus', 'canal', 'red sea', 'bab el-mandeb', 'gibraltar', 'taiwan strait'],
    COMMODITY:  ['oil', 'lng', 'gas', 'iron ore', 'grain', 'wheat', 'freight rate', 'baltic dry', 'bunker', 'crude'],
    CONFLICT:   ['conflict', 'houthi', 'military', 'naval', 'war', 'blockade', 'gunboat', 'warship'],
};

const TAGS = ['ALL', 'SANCTIONS', 'INCIDENT', 'CHOKEPOINT', 'COMMODITY', 'CONFLICT'];

// ── Module state ──────────────────────────────────────────────────────────────
let _articles  = [];
let _pinned    = new Set();
let _expanded  = new Set();
let _query     = '';
let _tag       = 'ALL';
let _fetching  = false;
let _lastFetch = 0;

const POLL_MS   = 15 * 60 * 1000; // 15 minutes
const LS_PINS     = 'vg1_feed_pins';
const LS_ARTICLES = 'vg1_feed_articles';
const MAX_TOTAL   = 150;   // larger cap now that we persist across sessions
const PER_SRC     = 3;     // per source per fetch cycle
const EXPIRY_DAYS = 7;     // articles older than this age off automatically

// ── Utility ───────────────────────────────────────────────────────────────────
function _articleText(a) {
    return `${a.title} ${a.description || ''}`.toLowerCase();
}

function _matchesTag(a, tag) {
    if (tag === 'ALL') return true;
    const keys = TAG_KEYS[tag] || [];
    return keys.some(k => _articleText(a).includes(k));
}

function _matchesSearch(a, query) {
    if (!query) return true;
    return _articleText(a).includes(query.toLowerCase());
}

function _isMaritime(item) {
    const t = `${item.title} ${item.description || ''}`.toLowerCase();
    // Fast path: any strong maritime term → immediately relevant
    if (MARITIME_GATE_STRONG.some(k => t.includes(k))) return true;
    // Broad terms only qualify when a second broad term also matches
    // (prevents single-word matches like "oil" or "fleet" on non-maritime articles)
    const broadMatches = MARITIME_GATE_BROAD.filter(k => t.includes(k));
    return broadMatches.length >= 2;
}

function _isIntelTier(item, sourceTier) {
    if (sourceTier === 'intel') return true;
    const t = `${item.title} ${item.description || ''}`.toLowerCase();
    return INTEL_BUMP.some(k => t.includes(k));
}

function _articleId(item, srcId) {
    return `${srcId}::${(item.link || item.title || '').slice(0, 120)}`;
}

function _relTime(pubDate) {
    const d = new Date(pubDate);
    if (isNaN(d.getTime())) return '';
    const mins = Math.floor((Date.now() - d) / 60000);
    if (mins < 1)  return 'NOW';
    if (mins < 60) return `${mins}M`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)  return `${hrs}H`;
    return `${Math.floor(hrs / 24)}D`;
}

function _esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ── Fetching ──────────────────────────────────────────────────────────────────
async function _fetchSource(src) {
    try {
        const url = RSS2JSON_BASE + encodeURIComponent(src.url);
        const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
        if (!res.ok) return [];
        const data = await res.json();
        if (data.status !== 'ok' || !Array.isArray(data.items)) return [];

        return data.items.map(item => ({
            id:          _articleId(item, src.id),
            title:       (item.title || '(untitled)').trim(),
            description: (item.description || '')
                             .replace(/<[^>]*>/g, '')
                             .replace(/\s+/g, ' ')
                             .trim()
                             .slice(0, 320),
            link:        item.link || '#',
            pubDate:     item.pubDate || new Date().toISOString(),
            sourceId:    src.id,
            sourceLabel: src.label,
            tier:        _isIntelTier(item, src.tier) ? 'intel' : 'news',
        }));
    } catch (err) {
        console.warn(`[Feed] ${src.id} fetch failed:`, err.message);
        return [];
    }
}

async function _refreshAll() {
    if (_fetching) return;
    _fetching = true;
    _setStatus('FETCHING…');

    const seenIds       = new Set(_articles.map(a => a.id));
    const perSrcCount   = {};
    const fresh         = [];

    for (const src of SOURCES) {
        const items = await _fetchSource(src);
        // Stagger to respect rss2json ~1 req/sec rate limit
        await new Promise(r => setTimeout(r, 1150));

        for (const item of items) {
            if (!_isMaritime(item))         continue;
            if (seenIds.has(item.id))       continue;  // already have it
            perSrcCount[src.id] = (perSrcCount[src.id] || 0);
            if (perSrcCount[src.id] >= PER_SRC && !_pinned.has(item.id)) continue;
            fresh.push(item);
            perSrcCount[src.id]++;
            seenIds.add(item.id);
        }
    }

    // Keep pinned articles from previous fetch, merge with fresh
    const pinnedArticles = _articles.filter(a => _pinned.has(a.id));
    const pinnedIds      = new Set(pinnedArticles.map(a => a.id));

    const merged = [
        ...pinnedArticles,
        ...fresh.filter(a => !pinnedIds.has(a.id)),
        ..._articles.filter(a => !pinnedIds.has(a.id) && !fresh.find(f => f.id === a.id)),
    ];

    merged.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    _articles = merged.slice(0, MAX_TOTAL);

    _fetching  = false;
    _lastFetch = Date.now();
    _saveArticles(); // persist to localStorage — survives page reload + session restart

    const t = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    _setStatus(`UPDATED ${t}`);
    _render();
}

// ── DOM helpers ───────────────────────────────────────────────────────────────
function _getPane()            { return document.getElementById('vp-feed'); }
function _setStatus(msg)       { const el = document.getElementById('fd-status'); if (el) el.textContent = msg; }

// ── Shell build (runs once on first tab open) ─────────────────────────────────
function _buildShell() {
    const pane = _getPane();
    if (!pane || pane.dataset.fdInit) return;
    pane.dataset.fdInit = '1';
    // Layout is controlled by CSS (#vp-feed.vp-active) — do NOT set display inline
    // or it overrides display:none on inactive tabs.

    pane.innerHTML = `
        <div id="fd-toolbar">
            <input id="fd-search" type="text" placeholder="SEARCH FEED…"
                   autocomplete="off" spellcheck="false" />
            <div id="fd-tags">
                ${TAGS.map(t =>
                    `<button class="fd-tag${t === 'ALL' ? ' fd-tag-active' : ''}" data-tag="${t}">${t}</button>`
                ).join('')}
            </div>
        </div>
        <div id="fd-status-bar">
            <span id="fd-status">STANDBY</span>
            <button id="fd-refresh-btn">↻ REFRESH</button>
        </div>
        <div id="fd-content">
            <div class="fd-section">
                <div class="fd-section-hdr">
                    <span class="fd-section-icon fd-icon-intel">⚠</span>
                    THREAT INTELLIGENCE
                    <span class="fd-section-count" id="fd-count-intel"></span>
                </div>
                <div class="fd-section-body" id="fd-intel-list">
                    <div class="fd-empty">LOADING…</div>
                </div>
            </div>
            <div class="fd-section">
                <div class="fd-section-hdr">
                    <span class="fd-section-icon fd-icon-news">◈</span>
                    SHIPPING NEWS
                    <span class="fd-section-count" id="fd-count-news"></span>
                </div>
                <div class="fd-section-body" id="fd-news-list">
                    <div class="fd-empty">LOADING…</div>
                </div>
            </div>
        </div>
    `;

    // ── Search input
    document.getElementById('fd-search').addEventListener('input', e => {
        _query = e.target.value.trim();
        _render();
    });

    // ── Tag pills
    document.getElementById('fd-tags').addEventListener('click', e => {
        const btn = e.target.closest('.fd-tag');
        if (!btn) return;
        _tag = btn.dataset.tag;
        document.querySelectorAll('.fd-tag').forEach(b =>
            b.classList.toggle('fd-tag-active', b.dataset.tag === _tag)
        );
        _render();
    });

    // ── Refresh button
    document.getElementById('fd-refresh-btn').addEventListener('click', () => _refreshAll());

    // ── Article interactions (expand / pin / link) — delegated
    document.getElementById('fd-content').addEventListener('click', e => {
        const row = e.target.closest('.fd-article');
        if (!row) return;
        const id = row.dataset.id;

        if (e.target.closest('.fd-pin-btn')) {
            e.stopPropagation();
            if (_pinned.has(id)) _pinned.delete(id);
            else _pinned.add(id);
            _savePins();
            _render();
            return;
        }

        // Let read-link open naturally
        if (e.target.closest('.fd-read-link')) return;

        // Toggle expand
        if (_expanded.has(id)) _expanded.delete(id);
        else _expanded.add(id);
        _render();
    });
}

// ── Render ────────────────────────────────────────────────────────────────────
function _renderSection(listId, countId, tier) {
    const list  = document.getElementById(listId);
    const count = document.getElementById(countId);
    if (!list) return;

    const visible = _articles.filter(a =>
        a.tier === tier &&
        _matchesTag(a, _tag) &&
        _matchesSearch(a, _query)
    );

    if (count) count.textContent = visible.length ? `(${visible.length})` : '';

    if (!visible.length) {
        const msg = _fetching
            ? 'FETCHING…'
            : (_query || _tag !== 'ALL') ? 'NO MATCHES' : 'NO ARTICLES LOADED';
        list.innerHTML = `<div class="fd-empty">${msg}</div>`;
        return;
    }

    list.innerHTML = visible.map(a => {
        const isExp    = _expanded.has(a.id);
        const isPinned = _pinned.has(a.id);
        const desc     = a.description
            ? a.description.slice(0, 250) + (a.description.length > 250 ? '…' : '')
            : '';

        return `<div class="fd-article${isExp ? ' fd-expanded' : ''}" data-id="${_esc(a.id)}">
            <div class="fd-article-row">
                <span class="fd-time">${_relTime(a.pubDate)}</span>
                <span class="fd-src-tag">${_esc(a.sourceLabel)}</span>
                <span class="fd-title">${_esc(a.title)}</span>
                <button class="fd-pin-btn${isPinned ? ' fd-pinned' : ''}" title="${isPinned ? 'Unpin' : 'Pin article'}">📌</button>
            </div>
            ${isExp ? `<div class="fd-article-body">
                ${desc ? `<p class="fd-desc">${_esc(desc)}</p>` : ''}
                <a class="fd-read-link" href="${_esc(a.link)}" target="_blank" rel="noopener">→ READ FULL ARTICLE</a>
            </div>` : ''}
        </div>`;
    }).join('');
}

function _render() {
    _renderSection('fd-intel-list', 'fd-count-intel', 'intel');
    _renderSection('fd-news-list',  'fd-count-news',  'news');
}

// ── Persistence ───────────────────────────────────────────────────────────────
function _savePins() {
    try { localStorage.setItem(LS_PINS, JSON.stringify([..._pinned])); } catch (_) {}
}
function _loadPins() {
    try { _pinned = new Set(JSON.parse(localStorage.getItem(LS_PINS) || '[]')); } catch (_) {}
}

function _saveArticles() {
    try { localStorage.setItem(LS_ARTICLES, JSON.stringify(_articles)); } catch (_) {}
}
function _loadArticles() {
    try {
        const raw = JSON.parse(localStorage.getItem(LS_ARTICLES) || '[]');
        const cutoff = Date.now() - EXPIRY_DAYS * 24 * 60 * 60 * 1000;
        // Keep pinned articles regardless of age; drop others older than EXPIRY_DAYS
        _articles = raw.filter(a => _pinned.has(a.id) || new Date(a.pubDate).getTime() > cutoff);
    } catch (_) { _articles = []; }
}

// ── Init ──────────────────────────────────────────────────────────────────────
export function initFeedManager() {
    _loadPins();
    _loadArticles(); // restore previous session's articles immediately

    // Build shell + fetch when Feed tab is clicked
    const feedTabBtn = document.querySelector('.vp-tab[data-tab="feed"]');
    if (feedTabBtn) {
        feedTabBtn.addEventListener('click', () => {
            _buildShell();
            // Show stored articles immediately so tab isn't blank while fetching
            if (_articles.length) _render();
            if (Date.now() - _lastFetch > POLL_MS) _refreshAll();
        });
    }

    // If the feed tab is already active on load (e.g. localStorage remembered it)
    const feedPane = document.getElementById('vp-feed');
    if (feedPane?.classList.contains('vp-active')) {
        _buildShell();
        // Show stored articles immediately, then fetch fresh in background
        if (_articles.length) _render();
        _refreshAll();
    }

    // Background polling — only fetches when tab is visible and data is stale
    setInterval(() => {
        const pane = document.getElementById('vp-feed');
        if (pane?.classList.contains('vp-active') && Date.now() - _lastFetch > POLL_MS) {
            _refreshAll();
        }
    }, 60_000);

    // Refresh relative timestamps every minute
    setInterval(() => {
        const pane = document.getElementById('vp-feed');
        if (pane?.classList.contains('vp-active') && _articles.length && !_fetching) {
            _render();
        }
    }, 60_000);

    window.feedManager = {
        refresh:     _refreshAll,
        getArticles: () => _articles,
    };
}
