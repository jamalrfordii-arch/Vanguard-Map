// discoveryManager.js — Cross-domain AI discovery layer
//
// Distinct from aiCopilot.js's per-event enrichment (one anomaly → one Claude
// call → better prose for that one thing). DiscoveryManager instead:
//   1. Keeps a rolling per-entity TIMELINE (narrative memory — supplements,
//      doesn't replace, aiCopilot's debounce/dedup, which only suppresses
//      repeat alerts and has no sense of a developing story).
//   2. Periodically builds ONE cross-domain SNAPSHOT (invariants ledger +
//      integrity flags + clusters + recent timelines) — things no single
//      rule-based detector can see together.
//   3. Sends that snapshot to /ai-discover and lets Claude (a) surface a
//      correlation/pattern nobody specifically asked about, and (b) act back
//      on the scene via a small TOOL REGISTRY, instead of only writing text.
//
// Follows the project's "distributed autonomy under central intent" principle
// (memory/decisions.md, 2026-06-14): this manager never imports aisManager,
// integrityManager, etc. — it reads their already-global, already-public
// surfaces (window.aisShips, window.vg1Invariants, window.vg1Integrity) and
// acts only through the existing `vg1:` event bus. New features register new
// tools; they never need to touch this file's internals.

import { DISCOVERY } from './config.js';
import { runDiscoveryRules } from './discoveryRules.js';

export class DiscoveryManager {
    constructor() {
        this._listeners   = [];   // (event) → void — same shape as aiCopilot events
        this._tickTimer    = 0;
        this._isProcessing = false;
        this._lastCallTime = 0;

        // mmsi (string) → [{ type, time, detail, score }]  (newest last)
        this._timeline = new Map();
        this._entriesSinceLastPass = 0;

        // [{ question, answer }] — last few /ai-query turns, newest last.
        // Conversational memory (phase 2, memory/decisions.md 2026-06-21):
        // sent to /ai-query as context so follow-ups ("what about it now?")
        // resolve, but never read back as ground truth — see QUERY_SYSTEM.
        this._queryHistory = [];

        // name (string) → (args) => void   — what Claude is allowed to DO
        this._tools = new Map();
        this._registerBuiltinTools();

        this._aiCopilot = null;

        // Rolling in-memory counters for the live UI stats panel (added
        // 2026-06-21 for "monitor this system for some time" — analysts want
        // an at-a-glance health check without opening the JSONL log).
        // `passes`/`claudeCalls`/`actionsExecuted` are the original fields,
        // kept for backward compat with anything already reading them.
        //   ticks         — every _maybeRunDiscoveryPass call, gated or not
        //   ruleFindings  — cumulative rule-engine findings emitted
        //   escalations   — cumulative times escalation gate was crossed
        //   ruleOnlySaves — cumulative times the rule engine handled it alone
        //                   (this is the number that matters most: Claude
        //                   calls avoided)
        //   claudeErrors  — cumulative failed/non-OK /ai-discover attempts
        this.stats = {
            passes: 0, claudeCalls: 0, actionsExecuted: 0,
            ticks: 0, ruleFindings: 0, escalations: 0, ruleOnlySaves: 0, claudeErrors: 0,
            startedAt: Date.now(),
        };
    }

    // ── Public API ──────────────────────────────────────────────────────────

    onEvent(callback) {
        this._listeners.push(callback);
    }

    /** Register a callback Claude's response can invoke by name. Extensible —
     *  new managers/features call this to expose themselves to discovery,
     *  no edits to this file required. */
    registerTool(name, fn) {
        this._tools.set(name, fn);
    }

    /** Feed this manager from aiCopilot's existing event stream — the source
     *  of per-entity timeline entries. Read-only subscription, non-destructive. */
    bindCopilot(aiCopilot) {
        this._aiCopilot = aiCopilot;
        aiCopilot.onEvent(evt => this._recordTimelineEntry(evt));
    }

    /** Call from the main animation loop each frame. */
    tick(delta) {
        this._tickTimer += delta;
        if (this._tickTimer < DISCOVERY.TICK_S) return;
        this._tickTimer = 0;
        this._pruneTimeline();
        this._maybeRunDiscoveryPass();
    }

    // ── Timeline (temporal memory) ─────────────────────────────────────────

    _recordTimelineEntry(evt) {
        // Only entries tied to a specific entity build a narrative thread.
        const mmsi = evt.claudeContext?.vessel?.mmsi ?? evt.mmsi;
        if (mmsi == null) return;

        const key = String(mmsi);
        if (!this._timeline.has(key)) this._timeline.set(key, []);
        const arr = this._timeline.get(key);

        arr.push({ type: evt.type, time: Date.now(), detail: evt.label, score: evt.score ?? 0 });
        while (arr.length > DISCOVERY.MAX_TIMELINE_PER_ENTITY) arr.shift();

        this._entriesSinceLastPass++;
    }

    _pruneTimeline() {
        const cutoff = Date.now() - DISCOVERY.TIMELINE_TTL_MS;
        this._timeline.forEach((arr, key) => {
            while (arr.length && arr[0].time < cutoff) arr.shift();
            if (arr.length === 0) this._timeline.delete(key);
        });
    }

    /** Entities with >1 timeline entry are exactly the "small unremarkable
     *  events that add up" case a single-event rule engine can't see. */
    _entitiesWithDevelopingStory() {
        const out = [];
        this._timeline.forEach((arr, mmsi) => {
            if (arr.length >= 2) out.push({ mmsi, entries: arr });
        });
        return out.sort((a, b) => b.entries.length - a.entries.length);
    }

    // ── Cross-domain snapshot ──────────────────────────────────────────────

    _buildSnapshot() {
        const snapshot = {
            generatedAt: Date.now(),
            developingStories: this._entitiesWithDevelopingStory().slice(0, DISCOVERY.MAX_SNAPSHOT_ENTITIES)
                .map(s => ({ mmsi: s.mmsi, events: s.entries.map(e => ({ type: e.type, ageSec: Math.round((Date.now() - e.time) / 1000), detail: e.detail })) })),
            invariantViolations: (typeof window !== 'undefined' && window.vg1Invariants)
                ? window.vg1Invariants.recent(20)
                : [],
            integrityFlagged: (typeof window !== 'undefined' && window.vg1Integrity)
                ? window.vg1Integrity.flagged().slice(0, DISCOVERY.MAX_SNAPSHOT_ENTITIES).map(r => ({
                    mmsi: r.mmsi, score: r.score, tier: r.tier, flags: [...(r.flags?.keys?.() ?? [])],
                  }))
                : [],
            // RF and chokepoint domains — added 2026-06-21 so "cross-domain" actually
            // means cross-domain (was AIS-only before: timeline + invariants + integrity).
            rfEvents: (typeof window !== 'undefined' && window.rfIntel)
                ? window.rfIntel.events.slice(-15).map(e => ({
                    type: e.type, severity: e.severity, summary: e.summary,
                    vessel: e.vessel ? (e.vessel.mmsi ?? e.vessel.name ?? null) : null,
                    ageSec: Math.round((Date.now() - e.timestamp) / 1000),
                  }))
                : [],
            chokepointActivity: (typeof window !== 'undefined' && window.chokepointHitMeshes)
                ? window.chokepointHitMeshes
                    .filter(m => (m.userData.chokepointCount || 0) > 0)
                    .map(m => ({
                        name: m.userData.chokepointName, count: m.userData.chokepointCount,
                        state: m.userData.chokepointState, dark: m.userData.chokepointDark || 0,
                    }))
                : [],
        };
        return snapshot;
    }

    /** Public: bypass the activity gate and run a pass right now. Still respects
     *  _isProcessing (no overlapping calls) but skips the rule-engine escalation
     *  gate and MIN_CALL_INTERVAL — this is a deliberate one-off operator
     *  action, not the autonomous clock. */
    forcePass() {
        return this._maybeRunDiscoveryPass(true);
    }

    /** Public: answer a freeform operator question using the current live
     *  snapshot as grounding context. Separate code path from the autonomous
     *  pass — doesn't touch _entriesSinceLastPass/_lastCallTime/stats.passes. */
    async query(question) {
        const q = (question || '').trim();
        if (!q) return;
        this._emit({ type: 'DISCOVERY_QUERY', cls: 'discovery-query', timestamp: Date.now(), body: `> ${q}` });
        try {
            const snapshot = this._buildSnapshot();
            const res = await fetch(DISCOVERY.QUERY_API_URL, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ question: q, snapshot, history: this._queryHistory }),
                signal:  AbortSignal.timeout(20_000),
            });
            if (res.ok) {
                const { answer } = await res.json();
                this._emit({
                    type: 'DISCOVERY', cls: 'discovery', label: '◈ AI DISCOVERY',
                    body: answer || '(no answer)', isAiEnriched: true,
                    timestamp: Date.now(), timeStr: 'JUST NOW',
                });
                this._queryHistory.push({ question: q, answer: answer || '(no answer)' });
                while (this._queryHistory.length > DISCOVERY.MAX_QUERY_HISTORY) this._queryHistory.shift();
            } else {
                const errBody = await res.text().catch(() => '');
                this._emit({
                    type: 'DISCOVERY_ERROR', cls: 'discovery-error', timestamp: Date.now(),
                    body: `query failed — ${res.status}${errBody ? ': ' + errBody.slice(0, 200) : ''}`,
                });
            }
        } catch (err) {
            this._emit({
                type: 'DISCOVERY_ERROR', cls: 'discovery-error', timestamp: Date.now(),
                body: `query failed — ${err.message}`,
            });
        }
    }

    /** Fire-and-forget telemetry to the persistent rule-engine log (see
     *  memoryStore.js appendRulePass / flight-proxy.js POST /memory/log-pass).
     *  Deliberately never awaited and never throws into the caller — this is
     *  best-effort monitoring, not part of the discovery contract. If the
     *  proxy is down, the live UI stats panel still works (it reads in-memory
     *  this.stats), only the durable log is missing for that window. */
    _logPass(outcome, rules, extra = {}) {
        try {
            const body = JSON.stringify({
                outcome, // 'nothing' | 'rule-handled' | 'escalated-ok' | 'escalated-error' | 'cooldown'
                ruleFindingsCount: rules?.findings?.length || 0,
                escalate: !!rules?.escalate,
                escalateReasons: rules?.escalateReasons || [],
                ...extra,
            });
            fetch(DISCOVERY.LOG_PASS_URL, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
            }).catch(() => { /* proxy unreachable — durable log just misses this tick */ });
        } catch (_) { /* never let telemetry break the discovery loop */ }
    }

    /** Read-only snapshot of stats for the UI panel — never mutate the
     *  returned object, it's the live counters by reference-copy. */
    getStatsSummary() {
        return { ...this.stats, uptimeMs: Date.now() - this.stats.startedAt };
    }

    async _maybeRunDiscoveryPass(force = false) {
        if (this._isProcessing) {
            if (force) {
                this._emit({
                    type: 'DISCOVERY_SCAN', cls: 'discovery-scan', timestamp: Date.now(),
                    body: 'pass already running — try again in a moment',
                });
            }
            return;
        }
        // Build the snapshot and run the local rule engine on EVERY tick,
        // gated or not — both are local reads of already-public state, no
        // fetch, no cost (see discoveryRules.js). Confident findings are
        // emitted regardless of whether this pass ends up calling Claude; an
        // analyst shouldn't have to wait on MIN_CALL_INTERVAL to hear "two
        // vessels are doing an STS transfer right now."
        const snapshot = this._buildSnapshot();
        const rules    = runDiscoveryRules(snapshot);
        this._entriesSinceLastPass = 0;
        this.stats.ticks++;
        this.stats.ruleFindings += rules.findings.length;

        for (const f of rules.findings) {
            this._emit({
                type: 'DISCOVERY_RULE', cls: 'discovery-rule', label: '◆ RULE ENGINE',
                timestamp: Date.now(), body: f.text, mmsi: f.mmsi ?? null,
            });
        }

        const nothingAtAll = snapshot.developingStories.length === 0 && snapshot.integrityFlagged.length === 0
            && snapshot.invariantViolations.length === 0 && snapshot.rfEvents.length === 0
            && snapshot.chokepointActivity.length === 0;

        // Escalation gate — replaces the old blunt "3+ new entries" counter.
        // Only genuinely ambiguous, cross-domain, or multi-signal situations
        // (per discoveryRules.js) are worth spending a Claude call on; routine
        // ticks now cost nothing even when something happened, because the
        // rule engine already explained it above.
        //
        // AI_ENABLED is a hard kill switch on top of that gate: when false,
        // NOTHING reaches /ai-discover — not a genuine escalation, not a
        // forced RUN NOW. This exists so the console stays usable (and quota
        // stays untouched) while a provider key is exhausted/unset; the rule
        // engine keeps running exactly as before, it just never hands off.
        const aiOff = !DISCOVERY.AI_ENABLED;
        if (aiOff || (!force && (nothingAtAll || !rules.escalate))) {
            if (!nothingAtAll) this.stats.ruleOnlySaves++;
            this._logPass(nothingAtAll ? 'nothing' : 'rule-handled', rules, aiOff ? { aiDisabled: true, forced: force } : undefined);
            this._emit({
                type: 'DISCOVERY_SCAN', cls: 'discovery-scan', timestamp: Date.now(),
                body: nothingAtAll
                    ? (aiOff
                        ? 'scan — nothing across any domain to analyze (AI disabled — config.js DISCOVERY.AI_ENABLED)'
                        : `scan — nothing across any domain to analyze (next check in ${DISCOVERY.TICK_S}s, or hit RUN NOW)`)
                    : aiOff
                        ? `AI disabled — rule engine handled ${rules.findings.length} finding(s) locally`
                            + (rules.escalate ? `; would have escalated: ${rules.escalateReasons.join('; ')}` : '')
                        : `rule engine handled ${rules.findings.length} finding(s) locally — `
                            + `nothing ambiguous enough to escalate (next check in ${DISCOVERY.TICK_S}s, or hit RUN NOW)`,
            });
            return;
        }
        if (force && nothingAtAll) {
            this._logPass('nothing', rules, { forced: true });
            this._emit({
                type: 'DISCOVERY_SCAN', cls: 'discovery-scan', timestamp: Date.now(),
                body: 'forced scan — nothing across any domain to analyze',
            });
            return;
        }
        if (!force && Date.now() - this._lastCallTime < DISCOVERY.MIN_CALL_INTERVAL) {
            const waitS = Math.ceil((DISCOVERY.MIN_CALL_INTERVAL - (Date.now() - this._lastCallTime)) / 1000);
            this._logPass('cooldown', rules, { waitS });
            this._emit({
                type: 'DISCOVERY_SCAN', cls: 'discovery-scan', timestamp: Date.now(),
                body: `escalation-worthy activity detected but call budget cooling down — ${waitS}s remaining`,
            });
            return;
        }

        if (rules.escalate) this.stats.escalations++;
        this._isProcessing = true;
        this._lastCallTime = Date.now();
        this.stats.passes++;

        this._emit({
            type: 'DISCOVERY_SCAN', cls: 'discovery-scan', timestamp: Date.now(),
            body: force && !rules.escalate
                ? `forced scan — ${snapshot.developingStories.length} developing stories, `
                    + `${snapshot.integrityFlagged.length} flagged, ${snapshot.invariantViolations.length} violations`
                : `escalating to Claude — ${rules.escalateReasons.join('; ') || 'forced by operator'}`,
        });

        try {
            const res = await fetch(DISCOVERY.API_URL, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ snapshot }),
                signal:  AbortSignal.timeout(20_000),
            });

            if (res.ok) {
                const { assessment, actions } = await res.json();
                this.stats.claudeCalls++;
                this._logPass('escalated-ok', rules, { forced: force, hasAssessment: !!assessment });

                if (assessment) {
                    this._emit({
                        type:      'DISCOVERY',
                        cls:       'discovery',
                        label:     '◈ AI DISCOVERY',
                        body:      assessment,
                        isAiEnriched: true,
                        timestamp: Date.now(),
                        timeStr:   'JUST NOW',
                    });
                } else {
                    this._emit({
                        type: 'DISCOVERY_SCAN', cls: 'discovery-scan', timestamp: Date.now(),
                        body: 'no correlation found in this pass',
                    });
                }

                this._executeActions(actions);
            } else {
                const errBody = await res.text().catch(() => '');
                this.stats.claudeErrors++;
                this._logPass('escalated-error', rules, { forced: force, error: `HTTP ${res.status}` });
                this._emit({
                    type: 'DISCOVERY_ERROR', cls: 'discovery-error', timestamp: Date.now(),
                    body: `provider returned ${res.status}${errBody ? ': ' + errBody.slice(0, 200) : ''}`,
                });
            }
        } catch (err) {
            console.warn('[DiscoveryManager] discovery pass failed:', err.message);
            this.stats.claudeErrors++;
            this._logPass('escalated-error', rules, { forced: force, error: err.message });
            this._emit({
                type: 'DISCOVERY_ERROR', cls: 'discovery-error', timestamp: Date.now(),
                body: `discovery pass failed — ${err.message}`,
            });
        }

        this._isProcessing = false;
    }

    // ── Tool registry — Claude acting back on the scene ────────────────────

    _registerBuiltinTools() {
        // Reuses the EXISTING event-bus contract (main.js / vesselTab.js /
        // watchlist.js all already dispatch this) — zero new wiring needed
        // for "fly camera to + optionally open the card".
        this.registerTool('selectVessel', ({ mmsi, openCard = false } = {}) => {
            if (mmsi == null || typeof window === 'undefined') return;
            window.dispatchEvent(new CustomEvent('vg1:selectVessel', {
                detail: { mmsi, source: 'aiDiscovery', openCard: !!openCard },
            }));
        });
    }

    _executeActions(actions) {
        if (!Array.isArray(actions)) return;
        for (const action of actions) {
            const fn = this._tools.get(action?.tool);
            if (!fn) {
                console.warn(`[DiscoveryManager] unknown tool requested: ${action?.tool}`);
                this._emit({
                    type: 'DISCOVERY_ERROR', cls: 'discovery-error', timestamp: Date.now(),
                    body: `unknown tool requested: ${action?.tool}`,
                });
                continue;
            }
            try {
                fn(action.args || {});
                this.stats.actionsExecuted++;
                this._emit({
                    type: 'DISCOVERY_ACTION', cls: 'discovery-action', timestamp: Date.now(),
                    body: `→ action: ${action.tool}(${JSON.stringify(action.args || {})})`,
                });
            } catch (err) {
                console.warn(`[DiscoveryManager] tool "${action.tool}" failed:`, err.message);
                this._emit({
                    type: 'DISCOVERY_ERROR', cls: 'discovery-error', timestamp: Date.now(),
                    body: `action "${action.tool}" failed — ${err.message}`,
                });
            }
        }
    }

    // ── Event emission ─────────────────────────────────────────────────────

    _emit(event) {
        this._listeners.forEach(cb => cb({ ...event }));
    }
}
