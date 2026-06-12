// sitrepManager.js — SITREP tab: auto-generated situation report + analyst log
// BRIEF view: generates on tab click from live watchlist, alerts, and feed data
// LOG view:   placeholder for analyst journal (next build)

const LS_LAST_VISIT  = 'vg1_sitrep_last_visit';
const LS_LAST_STATE  = 'vg1_sitrep_last_state';
const LS_WATCHLIST   = 'vg1_watchlist_mmsis';
const LS_LOG_ENTRIES = 'vg1_sitrep_log';

// ── Intel theme classification (mirrors feedManager TAG_KEYS for interpretation)
const INTEL_THEMES = {
    INCIDENT:   { label: 'security incidents and vessel seizures',   keys: ['attack', 'seized', 'explosion', 'drone', 'missile', 'piracy', 'pirate', 'incident'] },
    CHOKEPOINT: { label: 'chokepoint and corridor disruptions',      keys: ['strait', 'suez', 'hormuz', 'malacca', 'red sea', 'bab el-mandeb', 'canal', 'gibraltar'] },
    SANCTIONS:  { label: 'sanctions and embargo activity',           keys: ['sanction', 'ofac', 'embargo', 'shadow fleet', 'grey fleet'] },
    CONFLICT:   { label: 'regional conflict and military activity',  keys: ['conflict', 'houthi', 'military', 'naval', 'war', 'blockade', 'warship'] },
    COMMODITY:  { label: 'commodity and freight disruptions',        keys: ['oil', 'lng', 'gas', 'grain', 'freight', 'baltic dry', 'bunker', 'crude'] },
};

// ── View state ────────────────────────────────────────────────────────────────
let _view      = 'brief';
let _composing = false;   // true when compose box is open in LOG view

// ── Log entry persistence ─────────────────────────────────────────────────────
function _loadLogEntries() {
    try { return JSON.parse(localStorage.getItem(LS_LOG_ENTRIES) || '[]'); } catch { return []; }
}
function _saveLogEntries(entries) {
    try { localStorage.setItem(LS_LOG_ENTRIES, JSON.stringify(entries)); } catch {}
}

// ── Data gathering ────────────────────────────────────────────────────────────
function _getWatchedMMSIs() {
    try { return JSON.parse(localStorage.getItem(LS_WATCHLIST) || '[]'); } catch { return []; }
}

function _getWatchedVessels() {
    const mmsis = _getWatchedMMSIs();
    if (!mmsis.length) return [];

    return mmsis.map(mmsi => {
        const ship = window.aisShips?.find(s => String(s.userData?.id) === String(mmsi));
        const ud   = ship?.userData || {};
        const cachedName = window.watchlist?.getCachedName(mmsi) || String(mmsi);
        const name = (ud.displayName && ud.displayName !== String(mmsi))
            ? ud.displayName : cachedName;

        return {
            mmsi,
            name,
            speedKts:   ud.speedKts   ?? null,
            headingDeg: ud.headingDeg ?? null,
            destination: ud.destination || null,
            latDeg:     ud.latDeg     ?? null,
            lonDeg:     ud.lonDeg     ?? null,
            country:    ud.country    || null,
            inLiveFeed: !!ship,
        };
    });
}

function _getActiveAlerts() {
    const log = window.alertsManager?.getLog?.() || [];
    return log.filter(e => !e.dismissed);
}

function _getRecentIntel() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const articles = window.feedManager?.getArticles?.() || [];
    return articles.filter(a =>
        a.tier === 'intel' && new Date(a.pubDate).getTime() > cutoff
    );
}

function _getMissedSince(lastVisit) {
    if (!lastVisit) return { alerts: [], articles: [] };
    const lv = new Date(lastVisit);
    const log  = window.alertsManager?.getLog?.() || [];
    const feed = window.feedManager?.getArticles?.() || [];
    return {
        alerts:   log.filter(e  => new Date(e.timestamp)  > lv),
        articles: feed.filter(a => new Date(a.pubDate)     > lv && a.tier === 'intel'),
    };
}

// ── Intel theme scorer ────────────────────────────────────────────────────────
function _dominantThemes(articles) {
    const scores = {};
    for (const [key, { keys }] of Object.entries(INTEL_THEMES)) {
        scores[key] = 0;
        for (const a of articles) {
            const t = `${a.title} ${a.description || ''}`.toLowerCase();
            scores[key] += keys.filter(k => t.includes(k)).length;
        }
    }
    return Object.entries(scores)
        .filter(([, s]) => s > 0)
        .sort(([, a], [, b]) => b - a)
        .map(([key]) => INTEL_THEMES[key].label);
}

// ── Executive summary text builder ────────────────────────────────────────────
function _buildSummary(vessels, activeAlerts, recentIntel, missed, lastVisit) {
    const paras = [];

    // ── Paragraph 1: Vessel tracking
    if (vessels.length === 0) {
        paras.push('No vessels are currently on the watchlist. Add vessels via the map or the Vessels tab.');
    } else {
        const withAlerts = vessels.filter(v =>
            activeAlerts.some(a => String(a.mmsi) === String(v.mmsi))
        );
        const nominal    = vessels.filter(v =>
            !activeAlerts.some(a => String(a.mmsi) === String(v.mmsi))
        );
        const offFeed    = vessels.filter(v => !v.inLiveFeed);

        let p = `${vessels.length} vessel${vessels.length !== 1 ? 's' : ''} monitored. `;

        if (withAlerts.length > 0) {
            p += `${withAlerts.map(v => v.name).join(', ')} ${withAlerts.length === 1 ? 'has' : 'have'} active alerts requiring attention. `;
        }

        if (nominal.length > 0 && withAlerts.length > 0) {
            p += `${nominal.length} ${nominal.length === 1 ? 'vessel is' : 'vessels are'} reporting nominal.`;
        } else if (nominal.length === vessels.length) {
            p += 'All vessels reporting nominal.';
        }

        if (offFeed.length > 0) {
            p += ` ${offFeed.length} ${offFeed.length === 1 ? 'vessel is' : 'vessels are'} not currently in the live AIS feed — position data unavailable.`;
        }

        paras.push(p.trim());
    }

    // ── Paragraph 2: Alerts
    if (activeAlerts.length === 0) {
        paras.push('No active alerts. All monitored conditions are within expected parameters.');
    } else {
        const critical = activeAlerts.filter(a => a.severity === 'CRITICAL');
        const warnings = activeAlerts.filter(a => a.severity === 'WARNING');
        let p = '';

        if (critical.length > 0) {
            p += `${critical.length} critical alert${critical.length !== 1 ? 's require' : ' requires'} immediate attention. `;
        }
        if (warnings.length > 0) {
            p += `${warnings.length} watch-level alert${warnings.length !== 1 ? 's are' : ' is'} active.`;
        }

        paras.push(p.trim());
    }

    // ── Paragraph 3: Intelligence feed
    const feedLoaded = (window.feedManager?.getArticles?.() || []).length > 0;
    if (!feedLoaded) {
        paras.push('Intelligence feed has not yet loaded. Open the Feed tab to initialize the RSS stream.');
    } else if (recentIntel.length === 0) {
        paras.push('No intelligence items in the past 24 hours.');
    } else {
        const themes = _dominantThemes(recentIntel);
        let p = `${recentIntel.length} intelligence item${recentIntel.length !== 1 ? 's' : ''} logged in the past 24 hours`;
        if (themes.length > 0) {
            p += `, with reporting concentrated on ${themes.slice(0, 2).join(' and ')}`;
        }
        p += '.';
        paras.push(p);
    }

    // ── Paragraph 4: What you missed
    if (lastVisit && (missed.alerts.length > 0 || missed.articles.length > 0)) {
        const t = _fmtTime(lastVisit);
        const parts = [];
        if (missed.alerts.length > 0)
            parts.push(`${missed.alerts.length} new alert${missed.alerts.length !== 1 ? 's' : ''}`);
        if (missed.articles.length > 0)
            parts.push(`${missed.articles.length} new intelligence item${missed.articles.length !== 1 ? 's' : ''}`);
        paras.push(`Since your last visit at ${t} UTC: ${parts.join(' and ')}.`);
    }

    return paras;
}

// ── State hash for change detection ──────────────────────────────────────────
function _stateHash(vessels, activeAlerts, recentIntel) {
    const v = vessels.map(v => `${v.mmsi}:${v.speedKts ?? ''}`).join(',');
    const a = activeAlerts.map(a => a.id || a.type).sort().join(',');
    const i = recentIntel.map(a => a.id).sort().join(',');
    return `${v}|${a}|${i}`;
}

// ── localStorage helpers ──────────────────────────────────────────────────────
function _saveLastVisit() {
    try { localStorage.setItem(LS_LAST_VISIT, Date.now()); } catch {}
}
function _loadLastVisit() {
    try { return parseInt(localStorage.getItem(LS_LAST_VISIT)) || 0; } catch { return 0; }
}
function _saveLastState(h) {
    try { localStorage.setItem(LS_LAST_STATE, h); } catch {}
}
function _loadLastState() {
    try { return localStorage.getItem(LS_LAST_STATE) || ''; } catch { return ''; }
}

// ── Formatters ────────────────────────────────────────────────────────────────
function _fmtTime(ts) {
    return new Date(ts).toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
    });
}

function _esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Render: BRIEF view ────────────────────────────────────────────────────────
function _renderBrief() {
    const el = document.getElementById('sr-brief-content');
    if (!el) return;

    const now        = Date.now();
    const lastVisit  = _loadLastVisit();
    const lastState  = _loadLastState();

    const vessels    = _getWatchedVessels();
    const active     = _getActiveAlerts();
    const intel      = _getRecentIntel();
    const missed     = _getMissedSince(lastVisit || 0);
    const hash       = _stateHash(vessels, active, intel);
    const unchanged  = hash === lastState && lastState !== '';

    _saveLastVisit();
    _saveLastState(hash);

    const summaryParas = _buildSummary(vessels, active, intel, missed, lastVisit);

    // ── Vessel rows
    const vesselRowsHtml = vessels.map(v => {
        const vAlerts  = active.filter(a => String(a.mmsi) === String(v.mmsi));
        const hasCrit  = vAlerts.some(a => a.severity === 'CRITICAL');
        const hasWarn  = vAlerts.some(a => a.severity === 'WARNING');
        const cls      = hasCrit ? 'critical' : hasWarn ? 'warning' : 'nominal';
        const icon     = hasCrit ? '🔴' : hasWarn ? '🟠' : '🟢';
        const lbl      = hasCrit ? 'ALERT' : hasWarn ? 'WATCH' : 'NOMINAL';
        const speed    = v.speedKts != null ? `${Number(v.speedKts).toFixed(1)} KTS` : '—';
        const dest     = v.destination || '—';

        return `<div class="sr-vessel sr-vessel-${cls}">
            <div class="sr-vessel-top">
                <span class="sr-vessel-name">${_esc(v.name)}</span>
                <span class="sr-vessel-badge sr-badge-${cls}">${icon} ${lbl}</span>
            </div>
            <div class="sr-vessel-meta">
                <span>${_esc(speed)}</span>
                <span class="sr-arr">→</span>
                <span>${_esc(dest)}</span>
                ${!v.inLiveFeed ? '<span class="sr-offline">NOT IN FEED</span>' : ''}
            </div>
            ${vAlerts.length ? `<div class="sr-vessel-tags">${
                vAlerts.map(a => `<span class="sr-vtag">${_esc((a.type || '').replace(/_/g, ' '))}</span>`).join('')
            }</div>` : ''}
        </div>`;
    }).join('');

    // ── Active alerts rows — collapsible, closed by default
    const alertsHtml = active.length === 0 ? '' : `
        <details class="sr-section sr-collapsible">
            <summary class="sr-section-lbl">
                ACTIVE ALERTS <span class="sr-count-badge">${active.length}</span>
                <span class="sr-caret">▾</span>
            </summary>
            <div class="sr-collapsible-body">
                ${active.map(a => {
                    const sev  = (a.severity || '').toLowerCase();
                    const icon = a.severity === 'CRITICAL' ? '🔴' : a.severity === 'WARNING' ? '🟠' : '🟡';
                    return `<div class="sr-alert-row sr-alert-${sev}">
                        <span class="sr-alert-icon">${icon}</span>
                        <div class="sr-alert-body">
                            <span class="sr-alert-vessel">${_esc(a.vesselName || a.mmsi)}</span>
                            <span class="sr-alert-type">${_esc((a.type || '').replace(/_/g, ' '))}</span>
                        </div>
                        <span class="sr-alert-time">${a.timestamp ? _fmtTime(a.timestamp) : ''}</span>
                    </div>`;
                }).join('')}
            </div>
        </details>`;

    // ── Intel articles rows — shown at top
    const intelHtml = intel.length === 0 ? '' : `
        <div class="sr-section">
            <div class="sr-section-lbl">INTELLIGENCE</div>
            ${intel.slice(0, 5).map(a => `
                <div class="sr-intel-row">
                    <span class="sr-intel-src">${_esc(a.sourceLabel)}</span>
                    <a class="sr-intel-title" href="${_esc(a.link)}"
                       target="_blank" rel="noopener">${_esc(a.title)}</a>
                </div>
            `).join('')}
        </div>`;

    // ── Watchlist rows — collapsible, closed by default
    const watchlistHtml = vessels.length === 0 ? '' : `
        <details class="sr-section sr-collapsible">
            <summary class="sr-section-lbl">
                WATCHLIST <span class="sr-count-badge">${vessels.length}</span>
                <span class="sr-caret">▾</span>
            </summary>
            <div class="sr-collapsible-body">${vesselRowsHtml}</div>
        </details>`;

    el.innerHTML = `
        <div class="sr-header">
            <span class="sr-header-label">SITUATION REPORT</span>
            <span class="sr-header-time">${_fmtTime(now)} UTC</span>
        </div>
        ${unchanged ? `<div class="sr-no-change">NO CHANGE SINCE ${_fmtTime(lastVisit)} UTC</div>` : ''}

        ${intelHtml}

        <div class="sr-section sr-section-summary">
            <div class="sr-section-lbl">EXECUTIVE SUMMARY</div>
            ${summaryParas.map(p => `<p class="sr-para">${_esc(p)}</p>`).join('')}
        </div>

        ${watchlistHtml}
        ${alertsHtml}
    `;
}

// ── Formatters ────────────────────────────────────────────────────────────────
function _fmtFull(ts) {
    const d = new Date(ts);
    const date = d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric', timeZone: 'UTC' }).toUpperCase();
    const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'UTC' });
    return `${date}  ${time} UTC`;
}

// ── Render: LOG view ──────────────────────────────────────────────────────────
function _renderLog() {
    const el = document.getElementById('sr-log-content');
    if (!el) return;

    const entries = _loadLogEntries();  // newest first from localStorage

    // ── Compose box (shown when + is pressed)
    const composeHtml = _composing ? `
        <div class="sr-log-compose">
            <div class="sr-log-compose-ts">${_fmtFull(Date.now())}</div>
            <textarea class="sr-log-compose-area" id="sr-log-textarea"
                placeholder="Type your log entry…" rows="4" spellcheck="true"></textarea>
            <div class="sr-log-compose-actions">
                <button class="sr-log-cancel-btn" id="sr-log-cancel" title="Cancel">✕</button>
                <button class="sr-log-save-btn"   id="sr-log-save"   title="Save entry">✓</button>
            </div>
        </div>` : '';

    // ── Saved entries
    const entriesHtml = entries.length === 0 && !_composing ? `
        <div class="sr-log-empty">
            <div class="sr-log-empty-icon">◈</div>
            <div class="sr-log-empty-lbl">NO LOG ENTRIES</div>
            <div class="sr-log-empty-sub">Press + to add your first entry</div>
        </div>` :
        entries.map(e => `
        <div class="sr-log-entry" data-id="${e.id}">
            <div class="sr-log-entry-head">
                <span class="sr-log-entry-ts">${_fmtFull(e.ts)}</span>
                <button class="sr-log-del-btn" data-id="${e.id}" title="Delete entry">✕</button>
            </div>
            <div class="sr-log-entry-text">${_esc(e.text)}</div>
        </div>`).join('');

    el.innerHTML = `
        <div class="sr-log-header">
            <span class="sr-log-header-lbl">ANALYST LOG</span>
            <button class="sr-log-add-btn" id="sr-log-add" title="New entry"
                    ${_composing ? 'disabled' : ''}>+</button>
        </div>
        ${composeHtml}
        <div class="sr-log-entries">${entriesHtml}</div>
    `;

    _bindLogEvents(el);
}

function _bindLogEvents(el) {
    // Open compose box
    el.querySelector('#sr-log-add')?.addEventListener('click', () => {
        _composing = true;
        _renderLog();
        // Focus textarea after render
        requestAnimationFrame(() => {
            el.querySelector('#sr-log-textarea')?.focus();
        });
    });

    // Save entry on green ✓
    el.querySelector('#sr-log-save')?.addEventListener('click', () => {
        const ta   = el.querySelector('#sr-log-textarea');
        const text = ta?.value?.trim();
        if (!text) { ta?.focus(); return; }

        const entries = _loadLogEntries();
        entries.unshift({ id: Date.now(), ts: Date.now(), text });
        _saveLogEntries(entries);
        _composing = false;
        _renderLog();
    });

    // Cancel compose on red ✕ (compose header)
    el.querySelector('#sr-log-cancel')?.addEventListener('click', () => {
        _composing = false;
        _renderLog();
    });

    // Ctrl+Enter also saves
    el.querySelector('#sr-log-textarea')?.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            el.querySelector('#sr-log-save')?.click();
        }
        // Escape cancels
        if (e.key === 'Escape') {
            _composing = false;
            _renderLog();
        }
    });

    // Delete entries
    el.querySelectorAll('.sr-log-del-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const id      = Number(btn.dataset.id);
            const entries = _loadLogEntries().filter(e => e.id !== id);
            _saveLogEntries(entries);
            _renderLog();
        });
    });
}

// ── View switcher ─────────────────────────────────────────────────────────────
function _switchView(pane, view) {
    _view = view;
    pane.querySelectorAll('.sr-view-btn').forEach(b =>
        b.classList.toggle('sr-view-active', b.dataset.view === view)
    );
    document.getElementById('sr-brief-content').style.display = view === 'brief' ? '' : 'none';
    document.getElementById('sr-log-content').style.display   = view === 'log'   ? '' : 'none';

    if (view === 'brief') _renderBrief();
    if (view === 'log')   _renderLog();
}

// ── Shell (built once on first open) ─────────────────────────────────────────
function _buildShell(pane) {
    if (pane.dataset.srInit) return;
    pane.dataset.srInit = '1';
    // Layout (flex column, no padding) is controlled by CSS (#vp-sitrep.vp-active).
    // Do NOT set display inline — it overrides display:none on inactive tabs.

    pane.innerHTML = `
        <div id="sr-view-switcher">
            <button class="sr-view-btn sr-view-active" data-view="brief">BRIEF</button>
            <button class="sr-view-btn" data-view="log">LOG</button>
        </div>
        <div id="sr-content-area">
            <div id="sr-brief-content"></div>
            <div id="sr-log-content" style="display:none"></div>
        </div>
    `;

    pane.querySelectorAll('.sr-view-btn').forEach(btn =>
        btn.addEventListener('click', () => _switchView(pane, btn.dataset.view))
    );
}

// ── Init ──────────────────────────────────────────────────────────────────────
export function initSitrepManager() {
    const tabBtn = document.querySelector('.vp-tab[data-tab="sitrep"]');
    const pane   = document.getElementById('vp-sitrep');
    if (!tabBtn || !pane) {
        console.warn('[SITREP] Tab or pane not found — check index.html');
        return;
    }

    tabBtn.addEventListener('click', () => {
        _buildShell(pane);
        _switchView(pane, _view);
    });

    // If SITREP was the remembered active tab on load
    if (pane.classList.contains('vp-active')) {
        _buildShell(pane);
        _switchView(pane, _view);
    }

    window.sitrepManager = {
        refresh: () => {
            if (document.getElementById('vp-sitrep')?.classList.contains('vp-active')) {
                _renderBrief();
            }
        },
    };
}
