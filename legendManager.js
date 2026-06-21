// legendManager.js — one unified "MAP KEYS" panel that auto-composes a collapsible
// card per ACTIVE layer. Layers call show(id,title,html) when enabled and hide(id)
// when disabled; each card collapses to its title (state persisted), and the whole
// stack can be minimised. Replaces the old per-layer floating legends that overlapped.
//
// Distributed-autonomy "arm": no imports, talks only via its small API + the DOM.
// Console: window.legendManager.

class LegendManager {
    constructor() {
        this._cards = new Map();              // id → { wrap, header, body, titleEl, caret }
        this._container = null;
        this._panelMin = false;
        this._CKEY = 'vg1_legend_collapsed';  // per-card collapsed state
        this._MKEY = 'vg1_legend_min';        // whole-panel minimised
        this._collapsed = this._load(this._CKEY, {});
        this._panelMin = this._load(this._MKEY, false);
        this._build();
        if (typeof window !== 'undefined') window.legendManager = this;
    }

    _load(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } }
    _save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota */ } }

    _build() {
        if (typeof document === 'undefined' || document.getElementById('vg1-map-keys')) return;
        const c = document.createElement('div');
        c.id = 'vg1-map-keys';
        c.style.cssText = [
            'position:fixed', 'left:18px', 'top:64px', 'z-index:50',
            'display:flex', 'flex-direction:column', 'gap:6px',
            'width:218px', 'max-height:calc(100vh - 130px)', 'overflow-y:auto',
            'font:11px/1.35 ui-monospace,Consolas,monospace', 'color:#a8c5dc',
            'pointer-events:auto', 'user-select:none',
        ].join(';');

        // Master header (title + minimise-all)
        const head = document.createElement('div');
        head.style.cssText = [
            'display:flex', 'justify-content:space-between', 'align-items:center',
            'padding:5px 9px', 'background:rgba(2,6,14,0.82)',
            'border:1px solid rgba(120,180,220,0.28)', 'border-radius:6px',
            'cursor:pointer', 'letter-spacing:0.14em', 'color:#cfe2f3', 'font-weight:600',
            'backdrop-filter:blur(6px)', '-webkit-backdrop-filter:blur(6px)',
        ].join(';');
        const ht = document.createElement('span'); ht.textContent = 'MAP KEYS';
        const hc = document.createElement('span'); hc.style.cssText = 'color:#6f93ac;';
        head.appendChild(ht); head.appendChild(hc);
        head.title = 'Collapse / expand all keys';
        head.addEventListener('click', () => { this._panelMin = !this._panelMin; this._save(this._MKEY, this._panelMin); this._applyPanelMin(); });
        this._head = head; this._headCaret = hc; this._headTitle = ht;

        const stack = document.createElement('div');
        stack.style.cssText = 'display:flex; flex-direction:column; gap:6px;';
        this._stack = stack;

        c.appendChild(head); c.appendChild(stack);
        document.body.appendChild(c);
        this._container = c;
        this._applyPanelMin();
        this._refreshHeader();
    }

    // ── public API ────────────────────────────────────────────────────────────
    // Show (creating if needed) a key card for a layer.
    show(id, title, html) {
        if (!this._container) this._build();
        let card = this._cards.get(id);
        if (!card) { card = this._makeCard(id, title); this._cards.set(id, card); this._stack.appendChild(card.wrap); }
        card.titleEl.textContent = title;
        card.body.innerHTML = html;
        card.wrap.style.display = '';
        this._applyCollapsed(id);
        this._refreshHeader();
    }

    hide(id) {
        const card = this._cards.get(id);
        if (card) card.wrap.style.display = 'none';
        this._refreshHeader();
    }

    // ── internals ───────────────────────────────────────────────────────────────
    _makeCard(id, title) {
        const wrap = document.createElement('div');
        wrap.style.cssText = [
            'background:rgba(2,6,14,0.78)', 'border:1px solid rgba(120,180,220,0.28)',
            'border-radius:6px', 'overflow:hidden',
            'backdrop-filter:blur(6px)', '-webkit-backdrop-filter:blur(6px)',
        ].join(';');

        const header = document.createElement('div');
        header.style.cssText = [
            'display:flex', 'justify-content:space-between', 'align-items:center',
            'padding:6px 9px', 'cursor:pointer', 'letter-spacing:0.08em',
            'color:#cfe2f3', 'font-weight:600',
        ].join(';');
        const titleEl = document.createElement('span'); titleEl.textContent = title;
        const caret = document.createElement('span'); caret.style.cssText = 'color:#6f93ac; margin-left:8px;';
        header.appendChild(titleEl); header.appendChild(caret);

        const body = document.createElement('div');
        body.style.cssText = 'padding:2px 9px 8px;';

        header.addEventListener('click', () => {
            const nowCollapsed = body.style.display !== 'none';
            this._collapsed[id] = nowCollapsed; this._save(this._CKEY, this._collapsed);
            this._applyCollapsed(id);
        });

        wrap.appendChild(header); wrap.appendChild(body);
        return { wrap, header, body, titleEl, caret };
    }

    _applyCollapsed(id) {
        const card = this._cards.get(id); if (!card) return;
        const collapsed = !!this._collapsed[id];
        card.body.style.display = collapsed ? 'none' : '';
        card.caret.textContent = collapsed ? '▸' : '▾';
    }

    _applyPanelMin() {
        if (!this._stack) return;
        this._stack.style.display = this._panelMin ? 'none' : 'flex';
        if (this._headCaret) this._headCaret.textContent = this._panelMin ? '▸' : '▾';
    }

    // Hide the whole panel when nothing is active.
    _refreshHeader() {
        if (!this._container) return;
        let anyVisible = false;
        this._cards.forEach(c => { if (c.wrap.style.display !== 'none') anyVisible = true; });
        this._container.style.display = anyVisible ? 'flex' : 'none';
    }

    // Helper: build standard swatch rows from [{label, hex}] (newest/strongest first).
    static swatchRows(rows, footer) {
        let html = '';
        for (const r of rows) {
            html += `<div style="display:flex;align-items:center;gap:8px;padding:1px 0;">
                <span style="width:18px;height:7px;border-radius:1px;flex:0 0 auto;background:${r.hex};"></span>
                <span>${r.label}</span></div>`;
        }
        if (footer) html += `<div style="color:#4a6b84;margin-top:6px;font-size:9px;letter-spacing:0.04em;">${footer}</div>`;
        return html;
    }
}

export const legendManager = new LegendManager();
