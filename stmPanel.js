// stmPanel.js — the STM surface an operator actually looks at: a coverage
// readout, and drag-and-drop import of real RTZ route plans.
//
// ── WHY THE COVERAGE READOUT IS THE POINT OF THIS FILE ──────────────────────
// Essentially no live AIS vessel shares a route plan. So a map with route
// ribbons on three ships and nothing on four hundred is a map where four hundred
// vessels are UNKNOWN — and an operator will read bare water as "fine" unless
// the number is stated out loud. Everything else here is convenience; this is
// the part that keeps the display honest (docs/STM_ROUTE_SPEC.md §5.8).
//
// The readout therefore never says "OK" or shows a green all-clear. It says how
// many vessels it can speak about and how many it cannot, and it labels the
// second group UNKNOWN rather than compliant.
//
// ── DOM ─────────────────────────────────────────────────────────────────────
// This module builds its own DOM rather than adding markup to index.html.
// That is a deliberate exception to CLAUDE.md's "new UI panel → index.html +
// uiController" rule, and beaufortWarningManager.js is the precedent: a
// self-contained styled element appended to document.body with cssText. The
// reason is containment — index.html is 272 KB of actively-edited markup, and a
// status badge does not justify a merge risk there. Visual language is copied
// from #alert-zone-badge and beaufortWarningManager's hover card so it does not
// look foreign.
//
// Tests: node tests/stmPanel.test.mjs (pure formatting) and the DOM/drop path in
// tests/browser/stmPanelDom.html.

import { STM } from './config.js';
import { voyagePlanStore } from './voyagePlanStore.js';
import { enhancedMonitor, MONITOR_STATE } from './enhancedMonitor.js';
// The panel does not know what formats exist. It asks the registry, which is
// the only module allowed to import a codec — so adding S-421 changes no UI
// code and no operator-facing string.
import { parseAny, isRouteFile as registryIsRouteFile,
         acceptedExtensionsText, formatsText } from './routeCodecs.js';
import { isSynthetic } from './scenarioRoute.js';

const PANEL_CSS = `position:fixed; right:14px; bottom:64px; z-index:120;
    display:none; min-width:186px; max-width:260px;
    background:rgba(1,10,20,0.92); border:1px solid rgba(64,196,255,0.45);
    border-left:3px solid #40c4ff; padding:8px 11px;
    font-family:'Courier New',monospace; font-size:10px; letter-spacing:1px;
    color:#cfe8f5; backdrop-filter:blur(12px); pointer-events:none;
    white-space:nowrap; line-height:1.65;`;

const TOAST_CSS = `position:fixed; left:50%; bottom:96px; transform:translateX(-50%);
    z-index:140; display:none; max-width:min(560px, 88vw);
    background:rgba(1,10,20,0.95); border:1px solid rgba(64,196,255,0.5);
    border-left:3px solid #40c4ff; padding:10px 14px;
    font-family:'Courier New',monospace; font-size:10px; letter-spacing:1px;
    color:#cfe8f5; backdrop-filter:blur(12px); white-space:pre-wrap;
    box-shadow:0 0 24px rgba(64,196,255,0.12); pointer-events:none;`;

const DROP_CSS = `position:fixed; inset:0; z-index:139; display:none;
    background:rgba(1,10,20,0.55); border:2px dashed rgba(64,196,255,0.6);
    font-family:'Courier New',monospace; font-size:13px; letter-spacing:2px;
    color:#9fd8ee; align-items:center; justify-content:center; text-align:center;
    pointer-events:none; backdrop-filter:blur(2px);`;

const COL = { hot: '#ff8c00', crit: '#ff1744', dim: '#6d8798', syn: '#8a8f98' };

// ── pure formatting (tested in Node, no DOM) ─────────────────────────────────

/**
 * Turn a coverage object into the lines the badge renders.
 *
 * Deliberately has no "all clear" state. When nothing is deviating it says so,
 * but it always shows the UNKNOWN count alongside — because "0 deviating" out of
 * 3 monitored while 428 vessels are unmonitored is not good news, and a readout
 * that only reported the first number would be actively misleading.
 *
 * @returns {Array<{label: string, value: string, colour?: string}>}
 */
export function formatCoverage(cov, { syntheticPlans = 0, totalPlans = 0 } = {}) {
    const c = cov ?? {};
    const total = c.total ?? 0;
    const monitored = c.monitored ?? 0;
    const unknown = c.unmonitored ?? Math.max(0, total - monitored);
    const rows = [
        { label: 'MONITORED', value: `${monitored} of ${total}` },
        // Always shown, even at zero. This is the number the whole panel exists
        // to keep in front of the operator.
        { label: 'UNKNOWN', value: String(unknown),
          colour: unknown > 0 ? COL.dim : undefined },
    ];
    if (c.deviating) rows.push({ label: 'DEVIATING', value: String(c.deviating), colour: COL.hot });
    if (c.arrived)   rows.push({ label: 'ARRIVED', value: String(c.arrived) });
    if (c.suppressed) {
        // "Not misbehaving" — at anchor, moored, NUC. Distinct from on-track.
        rows.push({ label: 'STATIONARY', value: String(c.suppressed), colour: COL.dim });
    }
    if (totalPlans && syntheticPlans) {
        rows.push({
            label: 'PLANS',
            value: syntheticPlans === totalPlans
                ? `${totalPlans} (all synthetic)`
                : `${totalPlans} (${syntheticPlans} synthetic)`,
            colour: COL.syn,
        });
    } else if (totalPlans) {
        rows.push({ label: 'PLANS', value: String(totalPlans) });
    }
    return rows;
}

/**
 * Summarise an import attempt for the toast.
 *
 * Parse warnings are surfaced, not swallowed. XTD_UNIT_INFERRED in particular
 * means a monitoring threshold was read as metres rather than nautical miles — a
 * factor of 1852 — and the operator has to be told that happened.
 *
 * @param {Array<{name: string, plan: object|null, report: object}>} outcomes
 */
export function summariseImport(outcomes) {
    const ok = outcomes.filter(o => o.plan);
    const bad = outcomes.filter(o => !o.plan);
    const lines = [];

    if (ok.length) {
        lines.push(`IMPORTED ${ok.length} ROUTE PLAN${ok.length > 1 ? 'S' : ''}`);
        for (const o of ok) {
            const p = o.plan;
            const leg = p.waypoints.find(w => w.leg)?.leg;
            const xtd = leg
                ? `${leg.portsideXTD ?? '—'}/${leg.starboardXTD ?? '—'} nm`
                : 'no corridor declared';
            const status = p.routeStatus == null ? 'no status'
                : p.routeStatus === 7 ? 'status 7 — MONITORED'
                : `status ${p.routeStatus} — not monitored`;
            lines.push(`  ${p.routeName ?? o.name} · ${p.mmsi ?? 'no MMSI'} · ` +
                       `${p.waypoints.length} wp · XTD ${xtd} · ${status}`);
            // A plan parsed by a codec that has never seen a real document of its
            // format must not sit in the log looking exactly like one that has.
            // The operator is the last line of defence against a mis-mapped field,
            // and they can only be that if they know which import to distrust.
            if (p.provisionalCodec) {
                lines.push(`    ⚠ parsed by a PROVISIONAL codec${p.sourceFormat ? ` (${p.sourceFormat})` : ''} — ` +
                           'element mapping is inferred, not validated against a real document. ' +
                           'Check the waypoints against the source before acting on this plan.');
            }
            if (p.routeStatus !== 7) {
                lines.push('    not at status 7, so nothing will be monitored against it');
            }
        }
    }
    for (const o of bad) {
        lines.push(`REJECTED ${o.name}: ${o.report?.warnings?.[0]?.detail ?? 'not a usable route plan document'}`);
    }
    // Warnings from every outcome, deduplicated by code.
    const warned = new Map();
    for (const o of outcomes) for (const w of o.report?.warnings ?? []) {
        if (!warned.has(w.code)) warned.set(w.code, w.detail);
    }
    // INSUFFICIENT_WAYPOINTS already surfaces as a rejection above.
    warned.delete('INSUFFICIENT_WAYPOINTS');
    if (warned.size) {
        lines.push('WARNINGS');
        for (const [code, detail] of warned) lines.push(`  ${code}: ${detail}`);
    }
    const dropped = outcomes.flatMap(o => o.report?.droppedElements ?? []);
    if (dropped.length) {
        lines.push(`DROPPED ${dropped.length} element(s): ${dropped.slice(0, 3).join('; ')}` +
                   (dropped.length > 3 ? ' …' : ''));
    }
    return lines.join('\n');
}

/** True when a dragged item plausibly carries route-plan files. */
export function looksLikeFileDrag(dt) {
    if (!dt) return false;
    const types = Array.from(dt.types ?? []);
    return types.includes('Files');
}

/**
 * True for filenames worth offering to the registry.
 *
 * Re-exported rather than reimplemented: the accepted set is a property of
 * which codecs are registered, and a second copy of that list here is a second
 * place to forget to update. Kept as a named export because callers and tests
 * already import it from this module.
 */
export const isRouteFile = registryIsRouteFile;

// ── the panel ────────────────────────────────────────────────────────────────

export class StmPanel {
    constructor(opts = {}) {
        this.store = opts.store ?? voyagePlanStore;
        this.monitor = opts.monitor ?? enhancedMonitor;
        this.parse = opts.parse ?? parseAny;
        this._el = null;
        this._toast = null;
        this._drop = null;
        this._toastTimer = null;
        this._enabled = true;
        this._dragDepth = 0;
        this._bound = [];
    }

    /** Build the DOM and attach listeners. Safe to call once. */
    init() {
        if (typeof document === 'undefined' || this._el) return this;

        this._el = document.createElement('div');
        this._el.id = 'stm-coverage';
        this._el.style.cssText = PANEL_CSS;
        document.body.appendChild(this._el);

        this._toast = document.createElement('div');
        this._toast.id = 'stm-toast';
        this._toast.style.cssText = TOAST_CSS;
        document.body.appendChild(this._toast);

        this._drop = document.createElement('div');
        this._drop.id = 'stm-drop';
        this._drop.style.cssText = DROP_CSS;
        this._drop.textContent = `DROP ROUTE PLAN — ${formatsText()}`;
        document.body.appendChild(this._drop);

        // Re-render on the events that can change the answer, plus a slow tick
        // for states that change without an event (a vessel going dark).
        const on = (t, fn, el = window) => { el.addEventListener(t, fn); this._bound.push([el, t, fn]); };
        for (const ev of ['vg1:routeMonitorState', 'vg1:voyagePlanReceived',
                          'vg1:voyagePlanRemoved', 'vg1:voyagePlanExpired']) {
            on(ev, () => this.render());
        }
        this._interval = setInterval(() => this.render(), Math.max(2000, STM.TICK_MS));

        // ── drag and drop ────────────────────────────────────────────────────
        // Counted enter/leave: a single 'dragleave' fires when the pointer
        // crosses into a CHILD element, so a naive hide/show flickers the overlay
        // continuously as the cursor moves across the page.
        on('dragenter', (e) => {
            if (!looksLikeFileDrag(e.dataTransfer)) return;
            e.preventDefault();
            this._dragDepth++;
            this._drop.style.display = 'flex';
        });
        on('dragover', (e) => { if (looksLikeFileDrag(e.dataTransfer)) e.preventDefault(); });
        on('dragleave', () => {
            this._dragDepth = Math.max(0, this._dragDepth - 1);
            if (this._dragDepth === 0) this._drop.style.display = 'none';
        });
        on('drop', (e) => {
            if (!looksLikeFileDrag(e.dataTransfer)) return;
            e.preventDefault();
            this._dragDepth = 0;
            this._drop.style.display = 'none';
            this.importFiles(e.dataTransfer.files);
        });

        this.render();
        if (typeof window !== 'undefined') window.vg1StmPanel = this;
        return this;
    }

    setVisible(on) {
        this._enabled = !!on;
        this.render();
    }

    /** Read the current picture and paint it. Cheap; no allocation per frame. */
    render() {
        if (!this._el) return;
        const plans = this.store.all();
        // Nothing to say until at least one plan exists — an empty badge reading
        // "0 of 431 monitored" on a map with no STM data at all is noise, not
        // honesty. The moment ONE plan is held, the count appears and stays.
        if (!this._enabled || plans.length === 0) {
            this._el.style.display = 'none';
            return;
        }
        const cov = this.monitor.monitoringCoverage();
        const rows = formatCoverage(cov, {
            totalPlans: plans.length,
            syntheticPlans: plans.filter(isSynthetic).length,
        });
        this._el.innerHTML =
            `<div style="color:#40c4ff; margin-bottom:4px;">STM ENHANCED MONITORING</div>` +
            rows.map(r =>
                `<div><span style="color:${COL.dim}">${r.label}</span> ` +
                `<span style="float:right; padding-left:14px;` +
                `${r.colour ? `color:${r.colour};` : ''}">${r.value}</span></div>`
            ).join('');
        this._el.style.display = 'block';
        // Border turns warm while anything is confirmed deviating.
        this._el.style.borderLeftColor = cov.deviating ? COL.hot : '#40c4ff';
    }

    /**
     * Parse and stage dropped files.
     * Anything the codec cannot use is REPORTED, never silently skipped — a
     * file that vanishes on drop is indistinguishable from one that worked.
     */
    async importFiles(fileList) {
        const files = Array.from(fileList ?? []);
        if (!files.length) return null;

        const candidates = files.filter(f => isRouteFile(f.name));
        const ignored = files.filter(f => !isRouteFile(f.name));

        const outcomes = [];
        for (const f of candidates) {
            let text = '';
            try { text = await f.text(); }
            catch (e) {
                outcomes.push({ name: f.name, plan: null,
                    report: { warnings: [{ code: 'READ_FAILED', detail: String(e?.message ?? e) }] } });
                continue;
            }
            const { plan, report } = this.parse(text, { origin: 'file' });
            if (plan) {
                plan.sourceOrigin = 'file';
                this.store.add(plan);
            }
            outcomes.push({ name: f.name, plan, report });
        }

        let msg = outcomes.length ? summariseImport(outcomes) : '';
        if (ignored.length) {
            msg += (msg ? '\n' : '') +
                `IGNORED ${ignored.length} non-route file(s): ` +
                `${ignored.slice(0, 3).map(f => f.name).join(', ')}` +
                (ignored.length > 3 ? ' …' : '') + `  (${acceptedExtensionsText()} expected)`;
        }
        this.toast(msg || 'NOTHING TO IMPORT');
        this.render();
        return outcomes;
    }

    /** Transient message. Long enough to read a multi-line parse report. */
    toast(text, ms = 11000) {
        if (!this._toast) return;
        this._toast.textContent = text;
        this._toast.style.display = 'block';
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => { this._toast.style.display = 'none'; }, ms);
    }

    dispose() {
        clearInterval(this._interval);
        clearTimeout(this._toastTimer);
        for (const [el, t, fn] of this._bound) el.removeEventListener(t, fn);
        this._bound.length = 0;
        for (const el of [this._el, this._toast, this._drop]) el?.remove();
        this._el = this._toast = this._drop = null;
        if (typeof window !== 'undefined' && window.vg1StmPanel === this) delete window.vg1StmPanel;
    }
}

/** Singleton, following the shape of the other UI initialisers. */
export const stmPanel = new StmPanel();
export function initStmPanel(opts) { return Object.assign(stmPanel, opts ?? {}).init(); }
