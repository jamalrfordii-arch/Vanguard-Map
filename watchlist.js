// watchlist.js — Vessel watchlist for the Vanguard Panel
// Initialised by main.js:  initWatchlist(aisManager)
//
// Responsibilities:
//   • localStorage persistence of watched MMSIs, per-vessel notes, alert prefs
//   • Wires Add / Remove buttons in the vessel detail card
//   • Renders the Watchlist tab inside #vp-watchlist
//   • Exposes window.watchlist public API
//
// Public API (window.watchlist):
//   .add(mmsi)               — add MMSI to watchlist
//   .remove(mmsi)            — remove MMSI from watchlist
//   .isWatched(mmsi)         — boolean
//   .getAll()                — array of tracked MMSIs
//   .getNotes(mmsi)          — string
//   .getAlerts(mmsi)         — { speed, course, dark } booleans
//   .onCardOpen(mmsi)        — call when a vessel detail card opens

const LS_WATCHED  = 'vg1_watchlist_mmsis';
const LS_NOTES    = 'vg1_watchlist_notes';
const LS_ALERTS   = 'vg1_watchlist_alerts';
const LS_NAMECACHE = 'vg1_watchlist_namecache'; // last-known name per MMSI

// ── localStorage helpers ──────────────────────────────────────────────────────
function _loadSet()       { try { return new Set(JSON.parse(localStorage.getItem(LS_WATCHED)   || '[]')); } catch { return new Set(); } }
function _saveSet(s)      { localStorage.setItem(LS_WATCHED,   JSON.stringify([...s])); }
function _loadNotes()     { try { return JSON.parse(localStorage.getItem(LS_NOTES)     || '{}'); } catch { return {}; } }
function _saveNotes(n)    { localStorage.setItem(LS_NOTES,     JSON.stringify(n)); }
function _loadAlerts()    { try { return JSON.parse(localStorage.getItem(LS_ALERTS)    || '{}'); } catch { return {}; } }
function _saveAlerts(a)   { localStorage.setItem(LS_ALERTS,    JSON.stringify(a)); }
function _loadNameCache()  { try { return JSON.parse(localStorage.getItem(LS_NAMECACHE) || '{}'); } catch { return {}; } }
function _saveNameCache(c) { localStorage.setItem(LS_NAMECACHE, JSON.stringify(c)); }
const _defaultAlerts = () => ({ speed: false, course: false, dark: false });

// ── ISO 3166-1 alpha-3 → alpha-2 for flag emoji ───────────────────────────────
const ISO3_TO_2 = {
    ABW:'AW',AFG:'AF',AGO:'AO',ALB:'AL',AND:'AD',ARE:'AE',ARG:'AR',ARM:'AM',
    ATG:'AG',AUS:'AU',AUT:'AT',AZE:'AZ',BDI:'BI',BEL:'BE',BEN:'BJ',BFA:'BF',
    BGD:'BD',BGR:'BG',BHR:'BH',BHS:'BS',BIH:'BA',BLR:'BY',BLZ:'BZ',BOL:'BO',
    BRA:'BR',BRB:'BB',BRN:'BN',BTN:'BT',BWA:'BW',CAF:'CF',CAN:'CA',CHE:'CH',
    CHL:'CL',CHN:'CN',CIV:'CI',CMR:'CM',COD:'CD',COG:'CG',COL:'CO',COM:'KM',
    CPV:'CV',CRI:'CR',CUB:'CU',CYP:'CY',CZE:'CZ',DEU:'DE',DJI:'DJ',DMA:'DM',
    DNK:'DK',DOM:'DO',DZA:'DZ',ECU:'EC',EGY:'EG',ERI:'ER',ESP:'ES',EST:'EE',
    ETH:'ET',FIN:'FI',FJI:'FJ',FRA:'FR',FSM:'FM',GAB:'GA',GBR:'GB',GEO:'GE',
    GHA:'GH',GIN:'GN',GMB:'GM',GNB:'GW',GNQ:'GQ',GRC:'GR',GRD:'GD',GTM:'GT',
    GUY:'GY',HKG:'HK',HND:'HN',HRV:'HR',HTI:'HT',HUN:'HU',IDN:'ID',IND:'IN',
    IRL:'IE',IRN:'IR',IRQ:'IQ',ISL:'IS',ISR:'IL',ITA:'IT',JAM:'JM',JOR:'JO',
    JPN:'JP',KAZ:'KZ',KEN:'KE',KGZ:'KG',KHM:'KH',KIR:'KI',KOR:'KR',KWT:'KW',
    LAO:'LA',LBN:'LB',LBR:'LR',LBY:'LY',LCA:'LC',LIE:'LI',LKA:'LK',LSO:'LS',
    LTU:'LT',LUX:'LU',LVA:'LV',MAC:'MO',MAR:'MA',MCO:'MC',MDA:'MD',MDG:'MG',
    MDV:'MV',MEX:'MX',MHL:'MH',MKD:'MK',MLI:'ML',MLT:'MT',MMR:'MM',MNE:'ME',
    MNG:'MN',MOZ:'MZ',MRT:'MR',MUS:'MU',MWI:'MW',MYS:'MY',NAM:'NA',NER:'NE',
    NGA:'NG',NIC:'NI',NLD:'NL',NOR:'NO',NPL:'NP',NRU:'NR',NZL:'NZ',OMN:'OM',
    PAK:'PK',PAN:'PA',PER:'PE',PHL:'PH',PLW:'PW',PNG:'PG',POL:'PL',PRK:'KP',
    PRT:'PT',PRY:'PY',PSE:'PS',QAT:'QA',ROU:'RO',RUS:'RU',RWA:'RW',SAU:'SA',
    SDN:'SD',SEN:'SN',SGP:'SG',SLB:'SB',SLE:'SL',SLV:'SV',SMR:'SM',SOM:'SO',
    SRB:'RS',SSD:'SS',STP:'ST',SUR:'SR',SVK:'SK',SVN:'SI',SWE:'SE',SWZ:'SZ',
    SYC:'SC',SYR:'SY',TCD:'TD',TGO:'TG',THA:'TH',TJK:'TJ',TKM:'TM',TLS:'TL',
    TON:'TO',TTO:'TT',TUN:'TN',TUR:'TR',TUV:'TV',TWN:'TW',TZA:'TZ',UGA:'UG',
    UKR:'UA',URY:'UY',USA:'US',UZB:'UZ',VAT:'VA',VCT:'VC',VEN:'VE',VNM:'VN',
    VUT:'VU',WSM:'WS',YEM:'YE',ZAF:'ZA',ZMB:'ZM',ZWE:'ZW',
};

function _flagEmoji(iso3) {
    if (!iso3) return '🏴';
    const iso2 = ISO3_TO_2[iso3];
    if (!iso2) return '🏴';
    return Array.from(iso2)
        .map(c => String.fromCodePoint(c.codePointAt(0) + 127397))
        .join('');
}

function _truncate(str, max) {
    if (!str) return '';
    return str.length > max ? str.slice(0, max) + '…' : str;
}

// ── Main export ───────────────────────────────────────────────────────────────
export function initWatchlist(aisManager) {

    // ── Mutable state ─────────────────────────────────────────────────────────
    const _watched    = _loadSet();
    const _notes      = _loadNotes();
    const _alerts     = _loadAlerts();
    const _nameCache  = _loadNameCache(); // last-known name + country per MMSI
    let   _currentMmsi = null;            // MMSI whose card is currently open
    // Flash states: mmsi → { type, severity, color, ts }
    // Persists across re-renders until the user clicks the row.
    const _flashStates = {};

    // Snapshot live vessel data into the name cache for a given MMSI.
    // Pass the vessel object directly (from callback arg) to avoid a stale map lookup.
    // Rejects 'UNKNOWN' — only caches real names.
    function _snapshotName(mmsi, vesselObj) {
        const v = vesselObj || aisManager.vessels.get(mmsi);
        let changed = false;

        if (v) {
            const realName = v.name && v.name !== 'UNKNOWN' ? v.name : null;
            if (realName && realName !== _nameCache[mmsi]?.name) {
                (_nameCache[mmsi] = _nameCache[mmsi] || {}).name = realName;
                changed = true;
            }
            if (v.country && v.country !== _nameCache[mmsi]?.country) {
                (_nameCache[mmsi] = _nameCache[mmsi] || {}).country = v.country;
                changed = true;
            }
        }

        // Also pull from the Three.js object's userData.displayName as backup
        if (!_nameCache[mmsi]?.name) {
            const shipObj = window.aisShips?.find(s => String(s.userData.id) === mmsi);
            const dn = shipObj?.userData?.displayName;
            if (dn && dn !== 'UNKNOWN' && dn !== mmsi) {
                (_nameCache[mmsi] = _nameCache[mmsi] || {}).name = dn;
                changed = true;
            }
        }

        if (changed) _saveNameCache(_nameCache);
    }

    // ── DOM refs ──────────────────────────────────────────────────────────────
    const addRow    = document.getElementById('vd-watchlist-add-row');
    const addBtn    = document.getElementById('vd-watchlist-add');
    const wlSection = document.getElementById('vd-watchlist-section');
    const notesEl   = document.getElementById('vd-notes');
    const chkSpeed  = document.getElementById('vd-alert-speed');
    const chkCourse = document.getElementById('vd-alert-course');
    const chkDark   = document.getElementById('vd-alert-dark');
    const removeBtn = document.getElementById('vd-watchlist-remove');
    const vdClose   = document.getElementById('vd-close');

    // ── Public API ────────────────────────────────────────────────────────────
    window.watchlist = {
        add(mmsi) {
            const m = String(mmsi);
            _watched.add(m);
            _saveSet(_watched);
            if (!_notes[m])  { _notes[m]  = '';               _saveNotes(_notes);   }
            if (!_alerts[m]) { _alerts[m] = _defaultAlerts(); _saveAlerts(_alerts); }
            _snapshotName(m, aisManager.vessels.get(m)); // persist name + country so it survives page refresh
            _emit('add', m);
            _renderWatchlistTab();
        },
        remove(mmsi) {
            const m = String(mmsi);
            _watched.delete(m);
            _saveSet(_watched);
            _emit('remove', m);
            _renderWatchlistTab();
        },
        isWatched(mmsi)  { return _watched.has(String(mmsi)); },
        getAll()         { return [..._watched]; },
        getNotes(mmsi)   { return _notes[String(mmsi)]  || ''; },
        getAlerts(mmsi)  { return _alerts[String(mmsi)] || _defaultAlerts(); },
        // Returns the best known display name for an MMSI (live > cached > null)
        getCachedName(mmsi) {
            const m = String(mmsi);
            const v = aisManager.vessels.get(m);
            const liveName = (v?.name && v.name !== 'UNKNOWN') ? v.name : null;
            return liveName || _nameCache[m]?.name || null;
        },

        // Called by main.js whenever a vessel detail card opens
        onCardOpen(mmsi) {
            const m = String(mmsi || '');
            if (!m) return;

            // Always show watchlist sections if the vessel is already watchlisted
            // (so it can always be removed, even if it dropped off the live feed).
            // Only hide sections for entities that are neither watchlisted nor
            // known AIS vessels (e.g. aircraft, satellites).
            const isKnownAIS  = aisManager.vessels.has(m);
            const isWatchlisted = _watched.has(m);
            if (!isKnownAIS && !isWatchlisted) {
                _currentMmsi = null;
                _hideWatchlistSections();
                return;
            }
            _currentMmsi = m;
            _updateCardState(m);
        },
    };

    // ── Vessel detail button wiring ───────────────────────────────────────────
    addBtn?.addEventListener('click', () => {
        if (!_currentMmsi) return;
        window.watchlist.add(_currentMmsi);
        _updateCardState(_currentMmsi);
    });

    removeBtn?.addEventListener('click', () => {
        if (!_currentMmsi) return;
        window.watchlist.remove(_currentMmsi);
        _updateCardState(_currentMmsi);
    });

    // Notes: auto-save on every keystroke
    notesEl?.addEventListener('input', () => {
        if (!_currentMmsi) return;
        _notes[_currentMmsi] = notesEl.value;
        _saveNotes(_notes);
    });

    // Alert checkboxes: auto-save on change
    const _saveCheckboxes = () => {
        if (!_currentMmsi) return;
        _alerts[_currentMmsi] = {
            speed:  chkSpeed?.checked  || false,
            course: chkCourse?.checked || false,
            dark:   chkDark?.checked   || false,
        };
        _saveAlerts(_alerts);
        // Refresh tab so dots update immediately
        _renderWatchlistTab();
    };
    chkSpeed?.addEventListener('change',  _saveCheckboxes);
    chkCourse?.addEventListener('change', _saveCheckboxes);
    chkDark?.addEventListener('change',   _saveCheckboxes);

    // Close button — hide watchlist sections
    vdClose?.addEventListener('click', () => {
        _currentMmsi = null;
        _hideWatchlistSections();
    });

    // ── Helpers ───────────────────────────────────────────────────────────────
    function _updateCardState(mmsi) {
        if (!addRow || !wlSection) return;
        const watched = window.watchlist.isWatched(mmsi);
        addRow.style.display    = watched ? 'none'  : 'block';
        wlSection.style.display = watched ? 'block' : 'none';

        if (watched && notesEl) {
            notesEl.value       = _notes[mmsi]  || '';
            const al            = _alerts[mmsi] || _defaultAlerts();
            if (chkSpeed)  chkSpeed.checked  = al.speed;
            if (chkCourse) chkCourse.checked = al.course;
            if (chkDark)   chkDark.checked   = al.dark;
        }
    }

    function _hideWatchlistSections() {
        if (addRow)    addRow.style.display    = 'none';
        if (wlSection) wlSection.style.display = 'none';
    }

    function _emit(type, mmsi) {
        window.dispatchEvent(new CustomEvent('vg1:watchlistChanged', { detail: { type, mmsi } }));
    }

    // ── Vessel alert flash ────────────────────────────────────────────────────
    // Fired by alertsManager when a watched vessel's per-vessel toggle matches.
    window.addEventListener('vg1:vesselAlert', e => {
        const { mmsi, type, severity, color } = e.detail;
        if (!_watched.has(String(mmsi))) return;
        _flashStates[mmsi] = { type, severity, color: color || '#ff1744', ts: Date.now() };
        _tabDirty = true; // force re-render on next interval
        _renderWatchlistTab(); // immediate render so the flash starts now
    });

    // Clear flash state when user selects a vessel (they've seen the alert)
    window.addEventListener('vg1:selectVessel', e => {
        const mmsi = String(e.detail?.mmsi || '');
        if (mmsi && _flashStates[mmsi]) {
            delete _flashStates[mmsi];
            _tabDirty = true;
        }
    });

    // ── Watchlist tab renderer ────────────────────────────────────────────────
    function _renderWatchlistTab() {
        const pane = document.getElementById('vp-watchlist');
        if (!pane) return;

        const mmsis = [..._watched];

        if (mmsis.length === 0) {
            pane.innerHTML = `<div class="vp-empty">
                NO VESSELS WATCHED<br>
                CLICK A VESSEL ON MAP<br>
                THEN ADD TO WATCHLIST
            </div>`;
            return;
        }

        let html = `<div class="vt-summary">${mmsis.length} VESSEL${mmsis.length !== 1 ? 'S' : ''} WATCHED</div>`;

        for (const mmsi of mmsis) {
            const v       = aisManager.vessels.get(mmsi);
            const cached  = _nameCache[mmsi] || {};
            // Live name is only trusted when it's a real name (not 'UNKNOWN').
            // Fall back to cached last-known name, then MMSI as last resort.
            const liveName = (v?.name && v.name !== 'UNKNOWN') ? v.name : null;
            const name    = liveName || cached.name || mmsi;
            const country = v?.country  || cached.country  || null;
            const flag    = _flagEmoji(country);
            const speed   = v?.speedKts ?? null;
            const moored = speed !== null && speed < 1;
            const dest   = v?.destination ? _truncate(v.destination, 18) : '';
            const isDark = v?.isDark || false;
            const al     = _alerts[mmsi] || _defaultAlerts();

            const speedStr = moored
                ? '⚓ MOORED'
                : speed !== null ? `${speed.toFixed(1)} kts` : '—';

            const metaStr = dest ? `${speedStr} › ${dest}` : speedStr;

            const dotSpeed  = al.speed  ? 'wl-dot-on' : '';
            const dotCourse = al.course ? 'wl-dot-on' : '';
            const dotDark   = al.dark   ? 'wl-dot-on' : '';

            const darkBadge = isDark ? ` <span class="vt-dark-badge">DARK</span>` : '';

            // Flash / alerted state — auto-expires after 5 minutes
            const flash = _flashStates[mmsi];
            const isAlerted = flash && (Date.now() - flash.ts) < 5 * 60 * 1000;
            if (flash && !isAlerted) delete _flashStates[mmsi]; // clean up expired
            const alertedClass = isAlerted
                ? (flash.severity === 'CRITICAL' ? ' wl-alerted-critical' : ' wl-alerted-warning')
                : '';

            html += `<div class="wl-vessel-row${isDark ? ' vt-is-dark' : ''}${mmsi === _currentMmsi ? ' wl-selected' : ''}${alertedClass}"
                        data-mmsi="${mmsi}" data-flash="${isAlerted ? '1' : ''}" title="${name} — MMSI ${mmsi}">
                <span class="wl-flag">${flag}</span>
                <div class="wl-info">
                    <div class="wl-name">${name}${darkBadge}</div>
                    <div class="wl-meta">${metaStr}</div>
                </div>
                <div class="wl-row-actions">
                    <div class="wl-alert-dots">
                        <div class="wl-dot ${dotSpeed}"  title="Speed anomaly alert"></div>
                        <div class="wl-dot ${dotCourse}" title="Course change alert"></div>
                        <div class="wl-dot ${dotDark}"   title="Dark vessel alert"></div>
                    </div>
                    <button class="wl-remove-btn" data-mmsi="${mmsi}" title="Remove from watchlist">✕</button>
                </div>
            </div>`;
        }

        pane.innerHTML = html;

        // Trigger pulse animation on newly-alerted rows.
        // We force a reflow before adding the class so the animation
        // always plays from scratch, even on re-renders.
        pane.querySelectorAll('.wl-vessel-row[data-flash="1"]').forEach(row => {
            void row.offsetWidth; // reflow
            row.classList.add('wl-pulse');
        });

        // Row interactions
        pane.querySelectorAll('.wl-vessel-row').forEach(row => {
            // Single click → select (pan camera + ring), no card
            row.addEventListener('click', () => {
                const mmsi = row.dataset.mmsi;
                window.dispatchEvent(new CustomEvent('vg1:selectVessel', {
                    detail: { mmsi, source: 'watchlistTab', openCard: false }
                }));
                pane.querySelectorAll('.wl-vessel-row').forEach(r => r.classList.remove('wl-selected'));
                row.classList.add('wl-selected');
            });

            // Double-click → select + open stats card
            row.addEventListener('dblclick', () => {
                const mmsi = row.dataset.mmsi;
                window.dispatchEvent(new CustomEvent('vg1:selectVessel', {
                    detail: { mmsi, source: 'watchlistTab', openCard: true }
                }));
            });
        });

        // Remove buttons — stop propagation so row click/dblclick don't fire
        pane.querySelectorAll('.wl-remove-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                window.watchlist?.remove(btn.dataset.mmsi);
            });
        });
    }

    // ── Initial render & live updates ─────────────────────────────────────────
    _renderWatchlistTab();

    // Re-render the watchlist tab when AIS data arrives or updates for watched vessels.
    // onVesselNew fires on page load as the feed repopulates — this is the key hook
    // that resolves "UNKNOWN" names after a refresh.
    // onVesselUpdate fires during live operation to keep speed/dest/dark current.
    let _tabDirty      = false;
    let _tabLastRender = 0;

    const _markTabDirtyIfWatched = (...a) => {
        // aisManager callbacks: (mmsi: string, vesselData: object)
        const mmsi = String(a[0] || '');
        if (!_watched.has(mmsi)) return;
        _tabDirty = true;
        // Pass vessel object directly — a[1] is the live data at callback time
        _snapshotName(mmsi, a[1]);
    };

    const _prevNew    = aisManager.onVesselNew;
    const _prevUpdate = aisManager.onVesselUpdate;

    aisManager.onVesselNew = (...a) => {
        _prevNew?.(...a);
        _markTabDirtyIfWatched(...a);
    };
    aisManager.onVesselUpdate = (...a) => {
        _prevUpdate?.(...a);
        _markTabDirtyIfWatched(...a);
    };

    // Immediate startup scan — pick up any names already in aisManager.vessels
    // before the first interval tick fires (AIS feed may have data in <3 s).
    // Use setTimeout(0) so aisManager.vessels is populated before we run.
    setTimeout(() => {
        for (const mmsi of _watched) {
            _snapshotName(mmsi);
        }
        if (_watched.size > 0) {
            _tabDirty = true;
        }
    }, 500);

    setInterval(() => {
        // Aggressively scan ALL watched vessels every 3 s so names get cached
        // as soon as AIS data arrives — regardless of callback timing.
        // Also pulls names from window.aisShips userData.displayName as a fallback
        // since Three.js objects are sometimes updated before aisManager.vessels.
        for (const mmsi of _watched) {
            _snapshotName(mmsi); // picks up from aisManager.vessels
            // Additional source: Three.js userData.displayName
            if (!_nameCache[mmsi]?.name || _nameCache[mmsi].name === 'UNKNOWN') {
                const shipObj = window.aisShips?.find(s => String(s.userData.id) === mmsi);
                const displayName = shipObj?.userData?.displayName;
                if (displayName && displayName !== 'UNKNOWN' && displayName !== mmsi) {
                    (_nameCache[mmsi] = _nameCache[mmsi] || {}).name = displayName;
                    _saveNameCache(_nameCache);
                }
            }
        }

        const now = Date.now();
        if (_tabDirty || now - _tabLastRender > 30_000) {
            _renderWatchlistTab();
            _tabDirty      = false;
            _tabLastRender = now;
        }
    }, 3000);
}
