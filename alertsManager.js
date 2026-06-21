// alertsManager.js — Alert log + rules engine for the ALERTS tab
// Initialised by main.js:  initAlertsManager(aiCopilot, aisManager)
//
// Responsibilities:
//   • Receives events from aiCopilot and converts them to alert log entries
//   • Persists log and rule config to localStorage
//   • Renders the ALERTS tab (log view + rules view)
//   • Manages the unread badge on the ALERTS tab button
//   • Click-to-focus: clicking an alert pans camera + shows selection ring

const LS_LOG   = 'vg1_alerts_log';
const LS_RULES = 'vg1_alerts_rules';
const MAX_LOG  = 200;

// ── Per-type display metadata ─────────────────────────────────────────────────
const TYPE_META = {
    DARK_VESSEL:     { label: 'DARK VESSEL',      severity: 'CRITICAL', icon: '◉', color: '#ff1744' },
    SPEED_ANOMALY:   { label: 'SPEED ANOMALY',    severity: 'WARNING',  icon: '⚡', color: '#ff8c00' },
    COURSE_CHANGE:   { label: 'COURSE CHANGE',    severity: 'WARNING',  icon: '↻',  color: '#ff8c00' },
    CABLE_PROXIMITY: { label: 'CABLE PROXIMITY',  severity: 'INFO',     icon: '⚠',  color: '#40c4ff' },
    CHOKEPOINT:      { label: 'CHOKEPOINT',       severity: 'INFO',     icon: '◈',  color: '#40c4ff' },
    REAPPEAR:        { label: 'VESSEL REAPPEAR',  severity: 'INFO',     icon: '◎',  color: '#00e87a' },
    ZONE_BREACH:     { label: 'ZONE BREACH',      severity: 'CRITICAL', icon: '⬡',  color: '#ff1744' },
    DETENTION:       { label: 'PSC DETENTION',    severity: 'WARNING',  icon: '⚓', color: '#ff8c00' },
    CUSTOM:          { label: 'CUSTOM',           severity: 'INFO',     icon: '◆',  color: '#40c4ff' },
};

// ── Default rule set ──────────────────────────────────────────────────────────
const DEFAULT_RULES = [
    { id: 'dark_vessel',     name: 'DARK VESSEL',      type: 'DARK_VESSEL',     enabled: true,  params: {} },
    { id: 'speed_anomaly',   name: 'SPEED ANOMALY',    type: 'SPEED_ANOMALY',   enabled: true,  params: {} },
    { id: 'course_change',   name: 'COURSE CHANGE',    type: 'COURSE_CHANGE',   enabled: false, params: {} },
    { id: 'cable_proximity', name: 'CABLE PROXIMITY',  type: 'CABLE_PROXIMITY', enabled: false, params: {} },
    { id: 'reappear',        name: 'VESSEL REAPPEAR',  type: 'REAPPEAR',        enabled: true,  params: {} },
    { id: 'detention',       name: 'PSC DETENTION',    type: 'DETENTION',       enabled: true,  params: {} },
    { id: 'chokepoint',      name: 'CHOKEPOINT ENTRY', type: 'CHOKEPOINT',      enabled: false, params: {} },
    // Custom speed threshold — fires when a vessel is reported above N kts
    { id: 'speed_threshold', name: 'SPEED THRESHOLD',  type: 'SPEED_ANOMALY',   enabled: false, params: { minKts: 30 }, custom: true, customLabel: 'Min speed (kts)' },
];

// ── localStorage helpers ──────────────────────────────────────────────────────
function _loadLog()   { try { return JSON.parse(localStorage.getItem(LS_LOG)   || '[]'); } catch { return []; } }
function _saveLog(l)  { try { localStorage.setItem(LS_LOG, JSON.stringify(l)); } catch {} }
function _loadRules() {
    try {
        const saved = JSON.parse(localStorage.getItem(LS_RULES) || 'null');
        if (!saved) return JSON.parse(JSON.stringify(DEFAULT_RULES));
        // Merge saved overrides into the default set so new defaults appear
        return DEFAULT_RULES.map(def => {
            const s = saved.find(r => r.id === def.id);
            return s ? { ...def, ...s } : def;
        });
    } catch { return JSON.parse(JSON.stringify(DEFAULT_RULES)); }
}
function _saveRules(r) { try { localStorage.setItem(LS_RULES, JSON.stringify(r)); } catch {} }

// ── HTML escaper ─────────────────────────────────────────────────────────────
function _esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Relative time formatter ───────────────────────────────────────────────────
function _relTime(ts) {
    const d = Math.floor((Date.now() - ts) / 1000);
    if (d < 60)  return d + 's ago';
    if (d < 3600) return Math.floor(d / 60) + 'm ago';
    return Math.floor(d / 3600) + 'h ago';
}

// ── Unique ID generator ───────────────────────────────────────────────────────
let _idSeq = Date.now();
function _uid() { return ++_idSeq; }

// ── Main export ───────────────────────────────────────────────────────────────
export function initAlertsManager(aiCopilot, aisManager) {

    // ── State ─────────────────────────────────────────────────────────────────
    let _log    = _loadLog();
    let _rules  = _loadRules();
    let _unread = 0;
    let _view   = 'log';      // 'log' | 'rules'
    let _tabOpen = false;     // true when ALERTS tab is the active tab
    let _renderPending = false;
    let _search = '';         // vessel name / MMSI filter
    let _searchFocused = false;

    // Recalculate unread on load (entries that aren't dismissed or read)
    _unread = _log.filter(e => !e.read && !e.dismissed).length;
    _updateBadge();

    // ── Rule lookup by type ───────────────────────────────────────────────────
    function _isEnabled(type) {
        return _rules.some(r => r.type === type && r.enabled);
    }

    // ── Add an alert entry ────────────────────────────────────────────────────
    function _addAlert({ type, mmsi, vesselName, message, extra }) {
        if (!_isEnabled(type)) return;

        const meta = TYPE_META[type] || TYPE_META.CUSTOM;
        const entry = {
            id:         _uid(),
            type,
            severity:   meta.severity,
            icon:       meta.icon,
            color:      meta.color,
            label:      meta.label,
            mmsi:       mmsi || null,
            vesselName: vesselName || mmsi || '—',
            message:    message || '',
            extra:      extra || null,
            timestamp:  Date.now(),
            read:       _tabOpen,   // auto-read if tab is open
            dismissed:  false,
        };

        _log.unshift(entry);
        if (_log.length > MAX_LOG) _log = _log.slice(0, MAX_LOG);
        _saveLog(_log);

        if (!_tabOpen) {
            _unread++;
            _updateBadge();
        }

        // ── Watchlist row flash ───────────────────────────────────────────────
        // If this vessel is watchlisted AND the per-vessel toggle for this alert
        // type is enabled, fire vg1:vesselAlert so the watchlist row pulses.
        if (mmsi && window.watchlist?.isWatched(mmsi)) {
            const al = window.watchlist.getAlerts(mmsi);
            const shouldFlash = (
                (type === 'DARK_VESSEL'   && al.dark)   ||
                (type === 'SPEED_ANOMALY' && al.speed)  ||
                (type === 'COURSE_CHANGE' && al.course)
            );
            if (shouldFlash) {
                window.dispatchEvent(new CustomEvent('vg1:vesselAlert', {
                    detail: { mmsi, type, severity: meta.severity, color: meta.color }
                }));
            }
        }

        _scheduleRender();
    }

    // ── aiCopilot event → alert ───────────────────────────────────────────────
    if (aiCopilot) {
        aiCopilot.onEvent(evt => {
            const mmsi        = String(evt.claudeContext?.vessel?.mmsi || '');
            const vesselName  = _resolveVesselName(mmsi);
            const speedKts    = evt.claudeContext?.vessel?.speedKts;
            const chokepoint  = evt.claudeContext?.chokepoint;

            switch (evt.type) {
                case 'DARK_VESSEL':
                    _addAlert({
                        type: 'DARK_VESSEL', mmsi, vesselName,
                        message: 'AIS signal lost — vessel went dark',
                    });
                    break;

                case 'SPEED_ANOMALY': {
                    // Also check custom speed-threshold rule
                    const threshRule = _rules.find(r => r.id === 'speed_threshold' && r.enabled);
                    if (threshRule && speedKts != null && speedKts < threshRule.params.minKts) break;
                    _addAlert({
                        type: 'SPEED_ANOMALY', mmsi, vesselName,
                        message: speedKts != null ? `${speedKts.toFixed(1)} kts detected` : 'Velocity anomaly',
                    });
                    break;
                }

                case 'COURSE_CHANGE':
                    _addAlert({
                        type: 'COURSE_CHANGE', mmsi, vesselName,
                        message: 'Significant heading deviation',
                    });
                    break;

                case 'CABLE_PROXIMITY':
                    _addAlert({
                        type: 'CABLE_PROXIMITY', mmsi, vesselName,
                        message: 'Operating near submarine cable',
                    });
                    break;

                case 'REAPPEAR':
                    _addAlert({
                        type: 'REAPPEAR', mmsi, vesselName,
                        message: 'AIS signal reacquired',
                    });
                    break;

                default:
                    if (chokepoint) {
                        _addAlert({
                            type: 'CHOKEPOINT', mmsi, vesselName,
                            message: `Near ${chokepoint}`,
                        });
                    }
                    break;
            }
        });
    }

    // ── Vessel name resolver ──────────────────────────────────────────────────
    function _resolveVesselName(mmsi) {
        if (!mmsi) return '—';
        const v = aisManager?.vessels?.get(mmsi);
        if (v?.name && v.name !== 'UNKNOWN') return v.name;
        return window.watchlist?.getCachedName?.(mmsi) || mmsi;
    }

    // ── Badge ─────────────────────────────────────────────────────────────────
    function _updateBadge() {
        const btn = document.querySelector('.vp-tab[data-tab="alerts"]');
        const bdg = document.getElementById('vp-alerts-badge');
        if (!btn || !bdg) return;
        const n = _unread;
        btn.classList.toggle('has-alert', n > 0);
        bdg.textContent = n > 99 ? '99+' : n > 0 ? String(n) : '';
        // CSS handles visibility via .has-alert .vp-badge { display: flex }
    }

    // ── Mark all read when tab opens ──────────────────────────────────────────
    function _markAllRead() {
        _log.forEach(e => { e.read = true; });
        _saveLog(_log);
        _unread = 0;
        _updateBadge();
    }

    // ── Render scheduler (debounce rapid updates) ─────────────────────────────
    function _scheduleRender() {
        if (_renderPending) return;
        _renderPending = true;
        requestAnimationFrame(() => {
            _renderPending = false;
            _render();
        });
    }

    // ── Tab open / close tracking ─────────────────────────────────────────────
    // Hook into the existing tab system: watch for the ALERTS tab becoming active
    document.querySelectorAll('.vp-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            const isAlerts = btn.dataset.tab === 'alerts';
            _tabOpen = isAlerts;
            if (isAlerts) {
                _markAllRead();
                _scheduleRender();
            }
        });
    });

    // ── Main renderer ─────────────────────────────────────────────────────────
    function _render() {
        const pane = document.getElementById('vp-alerts');
        if (!pane) return;
        if (_view === 'rules') { _renderRules(pane); return; }
        _renderLog(pane);
    }

    // ── LOG view ──────────────────────────────────────────────────────────────
    function _renderLog(pane) {
        const q       = _search.toLowerCase().trim();
        const all     = _log.filter(e => !e.dismissed);
        const visible = q
            ? all.filter(e =>
                (e.vesselName || '').toLowerCase().includes(q) ||
                (e.mmsi || '').includes(q))
            : all;
        const total   = all.length;
        const shown   = visible.length;
        const unread  = all.filter(e => !e.read).length;

        let html = `
        <div class="al-toolbar">
            <div class="al-toolbar-left">
                ${total > 0
                    ? `<span class="al-count">${unread > 0 ? `<span class="al-unread-dot"></span>${unread} NEW &nbsp;·&nbsp; ` : ''}${total} TOTAL</span>`
                    : `<span class="al-count">NO ALERTS</span>`}
            </div>
            <div class="al-toolbar-right">
                <button class="al-view-btn" data-view="log"   ${_view==='log'   ? 'data-active' : ''}>LOG</button>
                <button class="al-view-btn" data-view="rules" ${_view==='rules' ? 'data-active' : ''}>RULES</button>
                ${total > 0 ? `<button class="al-clear-btn">CLEAR</button>` : ''}
            </div>
        </div>
        <div class="al-search-row">
            <input id="al-search-input" class="al-search" type="text"
                   placeholder="SEARCH VESSEL…" value="${_esc(_search)}"
                   autocomplete="off" spellcheck="false" />
            ${q && shown !== total ? `<span class="al-search-count">${shown} / ${total}</span>` : ''}
        </div>`;

        if (total === 0) {
            html += `<div class="vp-empty" style="margin-top:20px;">
                NO ACTIVE ALERTS<br>ANOMALY ENGINE MONITORING<br>ALL LIVE VESSELS
            </div>`;
        } else if (shown === 0) {
            html += `<div class="vp-empty" style="margin-top:20px;">
                NO MATCH FOR "${_esc(_search.toUpperCase())}"
            </div>`;
        } else {
            html += `<div class="al-log">`;
            for (const e of visible) {
                const isNew = !e.read;
                html += `
                <div class="al-entry${isNew ? ' al-new' : ''}${e.mmsi ? ' al-clickable' : ''}"
                     data-id="${e.id}" data-mmsi="${e.mmsi || ''}">
                    <div class="al-entry-left">
                        <span class="al-icon" style="color:${e.color}">${e.icon}</span>
                        <div class="al-entry-body">
                            <div class="al-entry-header">
                                <span class="al-type" style="color:${e.color}">${e.label}</span>
                                <span class="al-sev al-sev-${e.severity.toLowerCase()}">${e.severity}</span>
                            </div>
                            <div class="al-vessel">${e.vesselName}</div>
                            <div class="al-msg">${e.message}</div>
                        </div>
                    </div>
                    <div class="al-entry-right">
                        <span class="al-time">${_relTime(e.timestamp)}</span>
                        <button class="al-dismiss" data-id="${e.id}" title="Dismiss">✕</button>
                    </div>
                </div>`;
            }
            html += `</div>`;
        }

        pane.innerHTML = html;
        _bindLogEvents(pane);
    }

    function _bindLogEvents(pane) {
        // Search input
        const searchEl = pane.querySelector('#al-search-input');
        if (searchEl) {
            if (_searchFocused) {
                searchEl.focus();
                const len = searchEl.value.length;
                searchEl.setSelectionRange(len, len);
            }
            searchEl.addEventListener('focus', () => { _searchFocused = true; });
            searchEl.addEventListener('blur',  () => { _searchFocused = false; });
            searchEl.addEventListener('input', () => {
                _search = searchEl.value;
                _scheduleRender();
            });
            searchEl.addEventListener('click', e => e.stopPropagation());
        }

        // View switcher
        pane.querySelectorAll('.al-view-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                _view = btn.dataset.view;
                _render();
            });
        });

        // Clear all
        pane.querySelector('.al-clear-btn')?.addEventListener('click', () => {
            _log.forEach(e => { e.dismissed = true; });
            _saveLog(_log);
            _scheduleRender();
        });

        // Dismiss single
        pane.querySelectorAll('.al-dismiss').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const id = Number(btn.dataset.id);
                const entry = _log.find(en => en.id === id);
                if (entry) { entry.dismissed = true; _saveLog(_log); }
                _scheduleRender();
            });
        });

        // Click entry → focus vessel
        pane.querySelectorAll('.al-entry.al-clickable').forEach(row => {
            row.addEventListener('click', e => {
                if (e.target.classList.contains('al-dismiss')) return;
                const mmsi = row.dataset.mmsi;
                if (!mmsi) return;
                window.dispatchEvent(new CustomEvent('vg1:selectVessel', {
                    detail: { mmsi, source: 'alertsTab', openCard: false }
                }));
            });
        });
    }

    // ── RULES view ────────────────────────────────────────────────────────────
    function _renderRules(pane) {
        let html = `
        <div class="al-toolbar">
            <div class="al-toolbar-left"><span class="al-count">ALERT RULES</span></div>
            <div class="al-toolbar-right">
                <button class="al-view-btn" data-view="log"   ${_view==='log'   ? 'data-active' : ''}>LOG</button>
                <button class="al-view-btn" data-view="rules" ${_view==='rules' ? 'data-active' : ''}>RULES</button>
            </div>
        </div>
        <div class="al-rules-list">`;

        for (const rule of _rules) {
            const meta = TYPE_META[rule.type] || TYPE_META.CUSTOM;
            html += `
            <div class="al-rule" data-id="${rule.id}">
                <div class="al-rule-left">
                    <label class="al-toggle-wrap">
                        <input type="checkbox" class="al-rule-toggle" data-id="${rule.id}"
                               ${rule.enabled ? 'checked' : ''}>
                        <span class="al-toggle-track"><span class="al-toggle-thumb"></span></span>
                    </label>
                    <div class="al-rule-info">
                        <div class="al-rule-name" style="color:${rule.enabled ? meta.color : '#4a6b84'}">${rule.name}</div>
                        <div class="al-rule-desc">${_ruleDesc(rule)}</div>
                    </div>
                </div>
                ${rule.custom ? `
                <div class="al-rule-param">
                    <span class="al-param-label">&gt;</span>
                    <input type="number" class="al-param-input" data-id="${rule.id}"
                           value="${rule.params.minKts || 30}" min="0" max="100" step="1">
                    <span class="al-param-label">KTS</span>
                </div>` : ''}
            </div>`;
        }

        html += `</div>
        <div class="al-rules-note">
            Rules apply to all live vessels. Per-vessel alerts are configured<br>
            from the vessel card watchlist section.
        </div>`;

        pane.innerHTML = html;
        _bindRulesEvents(pane);
    }

    function _ruleDesc(rule) {
        if (rule.id === 'speed_threshold') return `Flag vessels exceeding threshold`;
        const meta = TYPE_META[rule.type];
        switch (rule.type) {
            case 'DARK_VESSEL':     return 'AIS signal lost for 5+ minutes';
            case 'SPEED_ANOMALY':   return 'Sudden velocity change detected';
            case 'COURSE_CHANGE':   return 'Major heading deviation';
            case 'CABLE_PROXIMITY': return 'Operating near submarine cable';
            case 'REAPPEAR':        return 'Dark vessel reacquires AIS signal';
            case 'CHOKEPOINT':      return 'Vessel near strategic chokepoint';
            default: return meta?.label || rule.type;
        }
    }

    function _bindRulesEvents(pane) {
        // View switcher
        pane.querySelectorAll('.al-view-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                _view = btn.dataset.view;
                _render();
            });
        });

        // Rule toggles
        pane.querySelectorAll('.al-rule-toggle').forEach(chk => {
            chk.addEventListener('change', () => {
                const id   = chk.dataset.id;
                const rule = _rules.find(r => r.id === id);
                if (rule) { rule.enabled = chk.checked; _saveRules(_rules); }
                _render();
            });
        });

        // Custom param inputs (speed threshold)
        pane.querySelectorAll('.al-param-input').forEach(inp => {
            inp.addEventListener('change', () => {
                const id   = inp.dataset.id;
                const rule = _rules.find(r => r.id === id);
                if (rule) {
                    rule.params.minKts = Math.max(0, Math.min(100, Number(inp.value) || 30));
                    _saveRules(_rules);
                }
            });
            // Don't propagate click to rule row
            inp.addEventListener('click', e => e.stopPropagation());
        });
    }

    // ── Periodic timestamp refresh (updates "2m ago" → "3m ago" etc.) ─────────
    setInterval(() => {
        if (_tabOpen && _view === 'log') _render();
    }, 30_000);

    // ── Initial render ────────────────────────────────────────────────────────
    _render();

    // ── Public API ────────────────────────────────────────────────────────────
    window.alertsManager = {
        addAlert: _addAlert,
        getLog:   () => _log,
        getRules: () => _rules,
        // Fire a manual/custom alert from anywhere in the app
        custom(message, mmsi) {
            _addAlert({ type: 'CUSTOM', mmsi: mmsi || null, vesselName: _resolveVesselName(mmsi), message });
        },
    };
}
