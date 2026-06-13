// rfIntelManager.js — RF Intelligence domain coordinator (Phase 1).
// Owns the RF event stream: sub-managers (beacons, divergence, jamming, …)
// call recordEvent(); this module stores, counts, dispatches, and renders
// the RF INTEL feed panel. See research/rf-intel-build-plan.md.
//
// Public API (per the locked plan):
//   rfIntel.recordEvent({ type, severity, location, vessel?, source, summary, evidence })
//   rfIntel.eventsForVessel(mmsi)   — chips for vessel tooltips (Phase 2+)
//   rfIntel.eventsInRegion(bbox)
//   rfIntel.setTime(t)              — temporal-state convention; no-op v1
//
// Events also dispatch as 'vg1:rfEvent' on window — ALERT severity is
// auto-promoted by main.js into the existing alerts pipeline.
// DevTools: window.rfIntel

const MAX_EVENTS = 400;

// Severity styling per research/rf-visual-design.md
const SEV = {
    INFO:  { color: '#9fb4c7' },
    WATCH: { color: '#ffb547' },
    ALERT: { color: '#ff6a3d' },
};

class RFIntelManager {
    constructor() {
        this.events  = [];           // newest last
        this.counts  = { INFO: 0, WATCH: 0, ALERT: 0 };
        this._panel  = null;
    }

    recordEvent(evt) {
        const e = {
            timestamp: evt.timestamp ?? Date.now(),
            severity:  evt.severity  ?? 'INFO',
            type:      evt.type      ?? 'RF_EVENT',
            location:  evt.location  ?? null,
            vessel:    evt.vessel    ?? null,
            source:    evt.source    ?? 'derived',
            summary:   evt.summary   ?? '',
            evidence:  evt.evidence  ?? {},
        };
        this.events.push(e);
        if (this.events.length > MAX_EVENTS) {
            const dropped = this.events.shift();
            this.counts[dropped.severity] = Math.max(0, this.counts[dropped.severity] - 1);
        }
        this.counts[e.severity] = (this.counts[e.severity] || 0) + 1;

        window.dispatchEvent(new CustomEvent('vg1:rfEvent', { detail: e }));
        if (this._panel) this._panel.add(e);
        return e;
    }

    eventsForVessel(mmsi, n = 10) {
        const m = String(mmsi);
        return this.events.filter(e => e.vessel && String(e.vessel.mmsi) === m).slice(-n);
    }

    eventsInRegion({ latMin, latMax, lonMin, lonMax }) {
        return this.events.filter(e => e.location &&
            e.location.lat >= latMin && e.location.lat <= latMax &&
            e.location.lon >= lonMin && e.location.lon <= lonMax);
    }

    setTime(_t) { /* temporal-state convention — no-op for v1 */ }

    attachPanel(panel) { this._panel = panel; }
}

export const rfIntel = new RFIntelManager();
if (typeof window !== 'undefined') window.rfIntel = rfIntel;

// ── RF INTEL feed — renders into the Vanguard Panel's RF tab (#vp-rf) ────────
// New events flash the tab in the event's severity color (violet INFO,
// amber WATCH, red ALERT) and bump the unseen-count badge until opened.
// flyTo: (lat, lon) => void — provided by main.js (camera transition)
export function initRFIntelPanel({ flyTo }) {
    const pane   = document.getElementById('vp-rf');
    const tabBtn = document.querySelector('.vp-tab[data-tab="rf"]');
    const badge  = document.getElementById('vp-rf-badge');
    if (!pane) { console.warn('[RF] #vp-rf pane missing — panel not initialized'); return null; }

    pane.innerHTML = `
        <div id="rf-counters" style="letter-spacing:1px; color:#4a6b84; padding:8px 10px 4px;">
            0 INFO · 0 WATCH · 0 ALERT
        </div>
        <div id="rf-list" style="overflow-y:auto; padding:0 8px 8px;">
            <div style="color:#2e4a5e; padding:4px 2px;">NO RF EVENTS</div>
        </div>
    `;
    const listEl = document.getElementById('rf-list');
    const cntEl  = document.getElementById('rf-counters');

    // Unseen tracking — cleared when the tab is opened
    let unseen = 0;
    const FLASH = { INFO: 'rgba(184,112,255,0.35)', WATCH: 'rgba(255,181,71,0.35)', ALERT: 'rgba(255,106,61,0.45)' };

    function isTabOpen() { return tabBtn?.classList.contains('active'); }
    function updateBadge() {
        if (!badge || !tabBtn) return;
        tabBtn.classList.toggle('has-alert', unseen > 0);
        badge.textContent = unseen > 99 ? '99+' : String(unseen);
    }
    function flashTab(severity) {
        if (!tabBtn || isTabOpen()) return;
        tabBtn.style.setProperty('--rf-flash', FLASH[severity] || FLASH.INFO);
        tabBtn.classList.remove('rf-flash');
        void tabBtn.offsetWidth;            // restart the CSS animation
        tabBtn.classList.add('rf-flash');
    }
    tabBtn?.addEventListener('click', () => {
        unseen = 0;
        updateBadge();
        tabBtn.classList.remove('rf-flash');
    });

    function refreshCounters() {
        const c = rfIntel.counts;
        cntEl.textContent = `${c.INFO || 0} INFO · ${c.WATCH || 0} WATCH · ${c.ALERT || 0} ALERT`;
        cntEl.style.color = (c.ALERT > 0) ? '#ff6a3d' : (c.WATCH > 0) ? '#ffb547' : '#4a6b84';
    }

    const panel = {
        add(e) {
            if (listEl.firstElementChild?.textContent === 'NO RF EVENTS') listEl.innerHTML = '';
            if (!isTabOpen()) { unseen++; updateBadge(); }
            flashTab(e.severity);
            const sev = SEV[e.severity] || SEV.INFO;
            const t   = new Date(e.timestamp);
            const hh  = String(t.getUTCHours()).padStart(2, '0');
            const mm  = String(t.getUTCMinutes()).padStart(2, '0');
            const card = document.createElement('div');
            card.style.cssText = `
                border:1px solid ${sev.color}44; border-left:3px solid ${sev.color};
                padding:5px 7px; margin-bottom:5px; cursor:${e.location ? 'pointer' : 'default'};
                background:rgba(0,0,0,0.3);
            `;
            card.innerHTML = `
                <div style="display:flex; justify-content:space-between; color:${sev.color}; letter-spacing:1px;">
                    <span>${e.type.replace(/_/g, ' ')}</span><span>${hh}:${mm}Z</span>
                </div>
                ${e.vessel ? `<div style="color:#cfe3f1;">${(e.vessel.name || e.vessel.mmsi)}</div>` : ''}
                <div style="color:#8aabc4;">${e.summary}</div>
                <div style="color:#4a6b84;">src: ${e.source}</div>
            `;
            if (e.location && flyTo) {
                card.addEventListener('click', () => flyTo(e.location.lat, e.location.lon));
            }
            listEl.prepend(card);
            while (listEl.children.length > 60) listEl.lastElementChild.remove();
            refreshCounters();
        }
    };

    rfIntel.attachPanel(panel);
    // backfill anything recorded before the panel mounted
    rfIntel.events.slice(-60).forEach(e => panel.add(e));
    return panel;
}
