// vesselTab.js — Live vessel roster for the Vanguard Panel "Vessels" tab
// Initialised by main.js:  initVesselTab(aisManager)
//
// Data source: aisManager.vessels  (Map<mmsi, vesselData>)
// Output:      renders into #vp-vessels inside the Vanguard Panel
// Interactions:
//   • Region header click → collapse / expand that group
//   • Vessel row click    → dispatch 'vg1:selectVessel' (handled by main.js)

// ── Geographic region bounding boxes ─────────────────────────────────────────
// Priority order: more specific regions first, broad oceans last.
// First matching box wins for each vessel.
const REGIONS = [
    // Enclosed / semi-enclosed seas
    { name: 'Baltic Sea',        minLat: 53, maxLat: 66, minLon: 10,   maxLon: 30  },
    { name: 'North Sea',         minLat: 51, maxLat: 62, minLon: -4,   maxLon: 13  },
    { name: 'Black Sea',         minLat: 40, maxLat: 48, minLon: 27,   maxLon: 42  },
    { name: 'Mediterranean Sea', minLat: 30, maxLat: 47, minLon: -6,   maxLon: 42  },
    { name: 'Red Sea',           minLat: 10, maxLat: 30, minLon: 32,   maxLon: 45  },
    { name: 'Persian Gulf',      minLat: 22, maxLat: 30, minLon: 48,   maxLon: 60  },
    { name: 'Arabian Sea',       minLat:  0, maxLat: 25, minLon: 55,   maxLon: 78  },
    { name: 'Bay of Bengal',     minLat:  5, maxLat: 22, minLon: 78,   maxLon: 100 },
    { name: 'South China Sea',   minLat:  0, maxLat: 25, minLon: 100,  maxLon: 125 },
    { name: 'East China Sea',    minLat: 25, maxLat: 40, minLon: 118,  maxLon: 135 },
    { name: 'Sea of Japan',      minLat: 32, maxLat: 52, minLon: 128,  maxLon: 142 },
    { name: 'Philippine Sea',    minLat:  5, maxLat: 25, minLon: 125,  maxLon: 145 },
    { name: 'Coral Sea',         minLat:-25, maxLat: -5, minLon: 145,  maxLon: 175 },
    { name: 'Tasman Sea',        minLat:-50, maxLat:-25, minLon: 145,  maxLon: 180 },
    { name: 'Caribbean Sea',     minLat:  8, maxLat: 25, minLon: -90,  maxLon: -60 },
    { name: 'Gulf of Mexico',    minLat: 18, maxLat: 32, minLon: -98,  maxLon: -80 },
    // Major oceans — broad fallbacks
    { name: 'North Atlantic',    minLat:  0, maxLat: 70, minLon: -80,  maxLon: -5  },
    { name: 'South Atlantic',    minLat:-60, maxLat:  0, minLon: -70,  maxLon: 20  },
    { name: 'North Pacific',     minLat:  0, maxLat: 70, minLon: -180, maxLon: -80 },
    { name: 'North Pacific',     minLat:  0, maxLat: 70, minLon: 142,  maxLon: 180 },
    { name: 'South Pacific',     minLat:-60, maxLat:  0, minLon: -180, maxLon: -80 },
    { name: 'South Pacific',     minLat:-60, maxLat:  0, minLon: 145,  maxLon: 180 },
    { name: 'Indian Ocean',      minLat:-60, maxLat: 30, minLon: 20,   maxLon: 147 },
    { name: 'Arctic Ocean',      minLat: 70, maxLat: 90, minLon: -180, maxLon: 180 },
    { name: 'Southern Ocean',    minLat:-90, maxLat:-60, minLon: -180, maxLon: 180 },
];

function getRegion(lat, lon) {
    if (lat == null || lon == null) return 'Unknown Region';
    for (const r of REGIONS) {
        if (lat >= r.minLat && lat <= r.maxLat && lon >= r.minLon && lon <= r.maxLon) {
            return r.name;
        }
    }
    return 'Open Ocean';
}

// ── ISO 3166-1 alpha-3 → alpha-2 for Unicode flag emoji ──────────────────────
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

function flagEmoji(iso3) {
    if (!iso3) return '🏴';
    const iso2 = ISO3_TO_2[iso3];
    if (!iso2) return '🏴';
    return Array.from(iso2)
        .map(c => String.fromCodePoint(c.codePointAt(0) + 127397))
        .join('');
}

function truncate(str, max) {
    if (!str) return '';
    return str.length > max ? str.slice(0, max) + '…' : str;
}

// ── Main export ───────────────────────────────────────────────────────────────
export function initVesselTab(aisManager) {
    const pane = document.getElementById('vp-vessels');
    if (!pane) return;

    // Track which regions the user has collapsed (default: all open)
    const _regionOpen = {};

    // Dirty flag — set by AIS events so we re-render promptly
    let _dirty      = true;
    let _lastRender = 0;

    // ── Hook AIS events to set dirty flag ───────────────────────────────────
    // Wrap without clobbering existing handlers set in main.js
    const _markDirty = () => { _dirty = true; };
    const _prev = {
        new:    aisManager.onVesselNew,
        update: aisManager.onVesselUpdate,
        remove: aisManager.onVesselRemove,
    };
    aisManager.onVesselNew    = (...a) => { _prev.new?.(...a);    _markDirty(); };
    aisManager.onVesselUpdate = (...a) => { _prev.update?.(...a); _markDirty(); };
    aisManager.onVesselRemove = (...a) => { _prev.remove?.(...a); _markDirty(); };

    // Also re-render when watchlist changes so + / ★ buttons update immediately
    window.addEventListener('vg1:watchlistChanged', _markDirty);

    // Poll every 2 s — only re-renders when dirty or 15 s has elapsed
    setInterval(() => {
        const now = Date.now();
        if (_dirty || now - _lastRender > 15_000) {
            _render();
            _dirty      = false;
            _lastRender = now;
        }
    }, 2000);

    // Initial render (may already have vessels if page was not refreshed)
    setTimeout(() => { _render(); _dirty = false; _lastRender = Date.now(); }, 800);

    // ── Render ───────────────────────────────────────────────────────────────
    function _render() {
        const vessels = Array.from(aisManager.vessels.values());

        if (vessels.length === 0) {
            pane.innerHTML = `<div class="vp-empty">
                AIS FEED OFFLINE<br>VESSEL ROSTER APPEARS<br>WHEN FEED IS LIVE
            </div>`;
            return;
        }

        // Group by region
        const groups = {};
        for (const v of vessels) {
            const r = getRegion(v.latDeg, v.lonDeg);
            if (!groups[r]) groups[r] = [];
            groups[r].push(v);
        }

        // Sort alphabetically within each region
        for (const arr of Object.values(groups)) {
            arr.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        }

        // Sort region names: Known first, Unknown last, else alphabetical
        const regionNames = Object.keys(groups).sort((a, b) => {
            if (a === 'Unknown Region') return  1;
            if (b === 'Unknown Region') return -1;
            return a.localeCompare(b);
        });

        let html = `<div class="vt-summary">${vessels.length} VESSEL${vessels.length !== 1 ? 'S' : ''} TRACKED</div>`;

        for (const region of regionNames) {
            const vList  = groups[region];
            const isOpen = _regionOpen[region] === true; // default closed

            html += `<div class="vt-region">
                <div class="vt-region-header" data-region="${region}">
                    <span class="vt-chevron">${isOpen ? '▼' : '▶'}</span>
                    <span class="vt-region-name">${region}</span>
                    <span class="vt-region-count">${vList.length}</span>
                </div>
                <div class="vt-region-body" style="display:${isOpen ? 'block' : 'none'}">`;

            for (const v of vList) {
                const flag     = flagEmoji(v.country);
                const speed    = v.speedKts ?? null;
                const moored   = speed !== null && speed < 1;
                const dest     = truncate(v.destination, 16);
                const isDark   = v.isDark;
                const watched  = window.watchlist?.isWatched(v.mmsi) ?? false;

                const speedHtml = moored
                    ? `<span class="vt-moored">⚓ MOORED</span>`
                    : speed !== null
                        ? `<span class="vt-speed">${speed}<span class="vt-unit"> kts</span></span>`
                        : `<span class="vt-unknown">—</span>`;

                const destHtml = dest
                    ? `<span class="vt-arrow">›</span><span class="vt-dest">${dest}</span>`
                    : '';

                const darkBadge = isDark
                    ? `<span class="vt-dark-badge">DARK</span>`
                    : '';

                // Watchlist toggle button: + (add) or ★ (already watched)
                const wlBtn = `<button class="vt-wl-btn${watched ? ' vt-wl-on' : ''}"
                    data-mmsi="${v.mmsi}"
                    title="${watched ? 'Remove from watchlist' : 'Add to watchlist'}"
                    >${watched ? '★' : '+'}</button>`;

                html += `<div class="vt-vessel-row${isDark ? ' vt-is-dark' : ''}"
                    data-mmsi="${v.mmsi}"
                    title="Click to select · Double-click for stats card">
                    <span class="vt-flag">${flag}</span>
                    <div class="vt-info">
                        <div class="vt-name-row">
                            <span class="vt-name">${v.name || 'UNKNOWN'}</span>
                            ${darkBadge}
                        </div>
                        <div class="vt-detail-row">
                            ${speedHtml}${destHtml}
                        </div>
                    </div>
                    ${wlBtn}
                </div>`;
            }

            html += `</div></div>`;
        }

        pane.innerHTML = html;

        // ── Region collapse / expand ──────────────────────────────────────────
        pane.querySelectorAll('.vt-region-header').forEach(hdr => {
            hdr.addEventListener('click', () => {
                const region  = hdr.dataset.region;
                const body    = hdr.nextElementSibling;
                const chevron = hdr.querySelector('.vt-chevron');
                const nowOpen = body.style.display !== 'none';
                body.style.display  = nowOpen ? 'none' : 'block';
                chevron.textContent = nowOpen ? '▶' : '▼';
                _regionOpen[region] = !nowOpen;
            });
        });

        // ── Watchlist toggle button ───────────────────────────────────────────
        pane.querySelectorAll('.vt-wl-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation(); // don't trigger row select
                const mmsi    = btn.dataset.mmsi;
                const watched = window.watchlist?.isWatched(mmsi) ?? false;
                if (watched) {
                    window.watchlist.remove(mmsi);
                    btn.textContent = '+';
                    btn.classList.remove('vt-wl-on');
                    btn.title = 'Add to watchlist';
                } else {
                    window.watchlist?.add(mmsi);
                    btn.textContent = '★';
                    btn.classList.add('vt-wl-on');
                    btn.title = 'Remove from watchlist';
                }
            });
        });

        // ── Vessel row interactions ───────────────────────────────────────────
        pane.querySelectorAll('.vt-vessel-row').forEach(row => {

            // Single click → select vessel (pan camera + ring), NO card open
            row.addEventListener('click', () => {
                const mmsi = row.dataset.mmsi;
                window.dispatchEvent(new CustomEvent('vg1:selectVessel', {
                    detail: { mmsi, source: 'vesselTab', openCard: false }
                }));
                pane.querySelectorAll('.vt-vessel-row').forEach(r => r.classList.remove('vt-selected'));
                row.classList.add('vt-selected');
            });

            // Double-click → select + open stats card
            row.addEventListener('dblclick', () => {
                const mmsi = row.dataset.mmsi;
                window.dispatchEvent(new CustomEvent('vg1:selectVessel', {
                    detail: { mmsi, source: 'vesselTab', openCard: true }
                }));
            });
        });
    }
}
