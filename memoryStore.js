// memoryStore.js — Persistent, append-only memory for the Discovery AI.
//
// Two strictly separate logs (see memory/decisions.md, 2026-06-21 entry on
// "safe memory accumulation"):
//
//   events.jsonl    — GROUND TRUTH. The exact snapshot fed to the model on
//                     each discovery pass / query. Never written to by the
//                     model. This is what actually happened on the map.
//
//   findings.jsonl   — INFERENCE. What the model said, tagged with the id of
//                     the events.jsonl entry it was grounded in. Never read
//                     back into a future snapshot as if it were ground truth
//                     — that would create a hallucination feedback loop
//                     (the model agreeing with its own past guesses instead
//                     of with the live map state).
//
// Storage: plain JSONL files under memory/discovery/. No DB dependency —
// consistent with the rest of this project's "no bundler, minimal deps"
// philosophy (see CLAUDE.md). Append-only, like memory/decisions.md.

const fs   = require('fs');
const path = require('path');

const DIR          = path.join(__dirname, 'memory', 'discovery');
const EVENTS_FILE   = path.join(DIR, 'events.jsonl');
const FINDINGS_FILE = path.join(DIR, 'findings.jsonl');
// ruleEngine.jsonl — added 2026-06-21 for rule-filter monitoring (see
// discoveryRules.js + memory/decisions.md). ONE entry per discoveryManager
// tick, gated or not, regardless of whether a Claude call happened. This is
// the durable answer to "is the local rule engine still behaving consistently
// over hours/days" — independent of the in-browser console (capped, lost on
// reload) and independent of whether /ai-discover itself is reachable.
const RULE_FILE     = path.join(DIR, 'ruleEngine.jsonl');

function ensureDir() {
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

function genId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function appendLine(file, obj) {
    ensureDir();
    fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

/**
 * Record a ground-truth snapshot (the exact data the model was shown).
 * Returns the generated event id so the caller can tag the matching finding.
 */
function appendEvent(snapshot, meta = {}) {
    const id = genId('evt');
    appendLine(EVENTS_FILE, {
        id,
        ts: new Date().toISOString(),
        kind: meta.kind || 'pass',   // 'pass' (autonomous) | 'query' (operator-asked)
        question: meta.question || null,
        snapshot,
    });
    return id;
}

/**
 * Record what the model said, tagged with the ground-truth event it was
 * grounded in. `sourceEventId` must reference a real events.jsonl entry —
 * never omit it and never backfill with another finding's id.
 */
function appendFinding(sourceEventId, result, meta = {}) {
    const id = genId('find');
    appendLine(FINDINGS_FILE, {
        id,
        ts: new Date().toISOString(),
        sourceEventId,
        provider: meta.provider || null,
        kind: meta.kind || 'pass',
        result,
    });
    return id;
}

/**
 * Append one discoveryManager tick's outcome — free, no LLM involved, called
 * on EVERY pass (rule-only and escalated alike) so the log reflects the full
 * cadence, not just the moments something escalated. `data` shape is owned
 * by the caller (discoveryManager.js); this just stamps it and appends.
 */
function appendRulePass(data = {}) {
    const id = genId('rule');
    const entry = { id, ts: new Date().toISOString(), ...data };
    appendLine(RULE_FILE, entry);
    return id;
}

/**
 * Read the last `limit` lines of a log, newest last (same order as written).
 * kind: 'events' | 'findings' | 'rulePasses'
 */
function readRecent(kind, limit = 50) {
    const file = kind === 'findings' ? FINDINGS_FILE : kind === 'rulePasses' ? RULE_FILE : EVENTS_FILE;
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const slice = lines.slice(-Math.max(1, limit));
    const out = [];
    for (const line of slice) {
        try { out.push(JSON.parse(line)); } catch (_) { /* skip corrupt line */ }
    }
    return out;
}

/** Look up a single event by id (used to ground a finding when reviewing). */
function getEventById(id) {
    return readRecent('events', 100000).find(e => e.id === id) || null;
}

/**
 * Discovery AI tool-use, phase 2 (memory/decisions.md, 2026-06-21 "next steps"
 * entry). The model only ever sees ONE live snapshot per call — this lets it
 * pull a specific vessel's own past out of events.jsonl on demand instead of
 * being limited to whatever happened to still be in the rolling timeline.
 * Read-only, bounded by `days`; never touches findings.jsonl as if it were
 * ground truth (same hallucination-feedback-loop rule as the rest of this
 * file) — it only scans the snapshots themselves for mentions of the mmsi.
 */
function searchHistory(mmsi, days = 7) {
    const mm = String(mmsi);
    if (!mm || mm === 'undefined' || mm === 'null') return { mmsi, days, hits: [] };

    const cutoff = Date.now() - Math.max(1, Number(days) || 7) * 24 * 60 * 60 * 1000;
    const events = readRecent('events', 100000).filter(e => {
        const t = Date.parse(e.ts);
        return Number.isFinite(t) && t >= cutoff;
    });

    const hits = [];
    for (const e of events) {
        const snap = e.snapshot || {};
        const matches = [];

        for (const s of (snap.developingStories || [])) {
            if (String(s.mmsi) === mm) matches.push({ kind: 'developingStory', events: s.events });
        }
        for (const f of (snap.integrityFlagged || [])) {
            if (String(f.mmsi) === mm) matches.push({ kind: 'integrityFlag', tier: f.tier, score: f.score, flags: f.flags });
        }
        for (const v of (snap.invariantViolations || [])) {
            if (String(v.mmsi) === mm) matches.push({ kind: 'invariantViolation', detail: v });
        }
        for (const r of (snap.rfEvents || [])) {
            if (r.vessel != null && String(r.vessel) === mm) matches.push({ kind: 'rfEvent', detail: r });
        }

        if (matches.length) hits.push({ eventId: e.id, ts: e.ts, passKind: e.kind, matches });
    }

    // Past findings that named this mmsi in their own text — informational
    // only, returned separately and labeled as inference so the model can't
    // mistake a prior guess for a new fact.
    const findings = readRecent('findings', 100000).filter(f => {
        const t = Date.parse(f.ts);
        if (!Number.isFinite(t) || t < cutoff) return false;
        const text = JSON.stringify(f.result || '');
        return text.includes(mm);
    }).map(f => ({ findingId: f.id, ts: f.ts, kind: f.kind, result: f.result }));

    return { mmsi: mm, days, hits, priorFindings: findings };
}

/**
 * Roll up ruleEngine.jsonl over the last `hours` for an analyst-facing health
 * check — "is the filter still behaving consistently" without anyone having
 * to read raw JSONL by hand. Pure aggregation, no judgment calls: counts and
 * rates only, the analyst draws their own conclusions from the numbers.
 */
function summarizeRulePasses(hours = 24) {
    const cutoff = Date.now() - Math.max(1, Number(hours) || 24) * 60 * 60 * 1000;
    const rows = readRecent('rulePasses', 1_000_000).filter(r => {
        const t = Date.parse(r.ts);
        return Number.isFinite(t) && t >= cutoff;
    });

    const out = {
        hours, windowStart: new Date(cutoff).toISOString(), totalTicks: rows.length,
        ruleFindings: 0, escalations: 0, ruleOnlySaves: 0, nothingTicks: 0,
        claudeCallsOk: 0, claudeCallsError: 0, escalateReasons: {},
    };
    for (const r of rows) {
        out.ruleFindings += r.ruleFindingsCount || 0;
        if (r.outcome === 'escalated-ok')       out.claudeCallsOk++;
        if (r.outcome === 'escalated-error')    out.claudeCallsError++;
        if (r.outcome === 'rule-handled')       out.ruleOnlySaves++;
        if (r.outcome === 'nothing')            out.nothingTicks++;
        if (r.escalate) {
            out.escalations++;
            for (const reason of (r.escalateReasons || [])) {
                out.escalateReasons[reason] = (out.escalateReasons[reason] || 0) + 1;
            }
        }
    }
    out.escalationRatePct = out.totalTicks ? +(100 * out.escalations / out.totalTicks).toFixed(1) : 0;
    out.claudeErrorRatePct = (out.claudeCallsOk + out.claudeCallsError)
        ? +(100 * out.claudeCallsError / (out.claudeCallsOk + out.claudeCallsError)).toFixed(1) : 0;
    return out;
}

module.exports = { appendEvent, appendFinding, appendRulePass, readRecent, getEventById, searchHistory, summarizeRulePasses };
