// discoveryRules.js — Local analyst-tradecraft rule engine for DISCOVERY.
//
// Runs on EVERY discovery tick, in-browser, for $0 — no LLM call, no network.
// Encodes the same heuristics a maritime-domain analyst applies by eye to a
// single snapshot:
//   • two vessels stopped together offshore        → possible STS transfer
//   • a vessel already flagged SUSPECT on 2+ tells   → already self-explaining
//   • an RF ALERT                                    → always worth a line
//   • a dark vessel transiting a chokepoint           → always worth a line
// These are CONFIDENT findings — the underlying data already explains itself
// (integrityManager's flags and chokepointManager's counts already carry
// human-readable detail). A sentence of Claude prose wouldn't tell an analyst
// anything they couldn't read off the raw flags, so we template it and never
// spend a call on it. Findings are tagged "RULE ENGINE" in the console so
// nobody mistakes a template for an AI assessment (see uiController.js).
//
// What a rule CAN'T do is weigh several *independently weak* signals against
// each other into one narrative: an RF emission near a chokepoint near a
// vessel's developing AIS story might be three unrelated blips, or one
// unfolding incident — only reasoning across all three at once tells the
// difference. That's exactly the case still worth a Claude call, so this
// module also surfaces ESCALATION reasons for genuinely ambiguous,
// cross-domain co-occurrence — discoveryManager decides what to do with them.
//
// Pure module: no THREE, no DOM, no fetch, no window writes. Takes the same
// snapshot discoveryManager already builds (see discoveryManager._buildSnapshot);
// returns { findings, escalate, escalateReasons }. Unit-testable in plain node.

import { DISCOVERY_RULES as R } from './config.js';

// ── Option menus (2026-07-21) ─────────────────────────────────────────────
// Each escalateReasons entry now carries a `type` tag, and every type maps to
// a FIXED, analyst-written menu of hypotheses below. This is the difference
// between "AI writes an assessment" and "AI proposes options": Claude's job
// on an escalation is to rank a small named menu against the evidence, not
// freely invent prose. The menu is the thing worth defending/tuning over
// time — see research/ai-discover-data-scope.md for why this is scoped to
// vessels-only for now (chokepoint boxes, RF distress, and integrity/
// invariant flags are the only domains actually wired into the snapshot).
export const OPTION_MENUS = {
    STS_GROUP: [
        'Legitimate anchorage — waiting for berth, pilot, or customs clearance',
        'Coordinated flotilla activity',
        'Weather-related mass station-keeping',
        'Ship-to-ship transfer hub (sanctions evasion or cargo consolidation)',
    ],
    MULTI_SIGNAL_VESSEL: [
        'AIS spoofing / intentional signature masking',
        'Genuine equipment failure (transponder or navigation)',
        'Deliberate evasive maneuvering',
        'Benign operational correction (course/speed change for routine reasons)',
    ],
    CROSS_DOMAIN: [
        'Single unfolding incident — the signals are related',
        'Coincidental unrelated activity — the signals are independent',
        'Sensor or data-quality artifact producing a false correlation',
    ],
    COORDINATED_MULTI_VESSEL: [
        'Coordinated multi-vessel activity',
        'Independent vessels each reacting to the same external event (weather, chokepoint closure, traffic)',
        'Detection or data artifact affecting multiple tracks at once',
    ],
};

export function runDiscoveryRules(snapshot) {
    const findings = [];          // [{ text, mmsi? }] — emit straight to console, no LLM needed
    const escalateReasons = [];   // [{ type, text, mmsis }] — non-empty → worth spending a Claude call.
                                   // `type` keys into OPTION_MENUS above; discoveryManager picks the
                                   // first entry as the pass's dominant trigger for v1 (documented
                                   // simplification — see discoveryManager.js's escalation call site).

    // ── RF ALERT — never goes silent, and the summary is already human prose ──
    for (const rf of snapshot.rfEvents || []) {
        if (rf.severity === 'ALERT') {
            findings.push({
                text: `RF ALERT — ${rf.summary}${rf.vessel ? ` (linked: MMSI ${rf.vessel})` : ''}`,
                mmsi: rf.vessel ?? null,
            });
        }
    }

    // ── Chokepoint dark-vessel transit — a count check, not a judgment call ──
    for (const cp of snapshot.chokepointActivity || []) {
        if (cp.dark > 0) {
            // MMSIs (added 2026-07-21 alongside the vessel-list snapshot field) —
            // fall back to the bare count if an older snapshot shape shows up.
            const darkMmsis = (cp.vessels || []).filter(v => v.dark).map(v => v.mmsi);
            const who = darkMmsis.length ? ` — MMSI ${darkMmsis.join(', ')}` : '';
            findings.push({
                text: `${cp.dark} dark vessel${cp.dark > 1 ? 's' : ''} transiting ${cp.name} `
                    + `(${cp.count} tracked, state ${cp.state})${who}`,
                mmsi: darkMmsis.length === 1 ? darkMmsis[0] : null,
            });
        }
    }

    // ── SUSPECT-tier vessel, multiple corroborating flags ─────────────────────
    // integrityManager already explains *why* — flag types ARE the explanation.
    const loitering = [];
    for (const v of snapshot.integrityFlagged || []) {
        if (v.tier === 'SUSPECT' && (v.flags || []).length >= R.SUSPECT_MIN_FLAGS_FOR_AUTO) {
            findings.push({
                text: `MMSI ${v.mmsi} is SUSPECT (trust ${v.score}/100) — ${v.flags.join(', ')}`,
                mmsi: v.mmsi,
            });
        }
        if ((v.flags || []).includes('LOITERING')) loitering.push(v.mmsi);
    }

    // ── STS / rendezvous pair — exactly two stopped together is the textbook
    // case and templates cleanly. More than that is ambiguous (anchorage?
    // coordinated flotilla?) and gets escalated instead. ──────────────────────
    if (loitering.length === R.STS_PAIR_CONFIDENT_MAX) {
        findings.push({
            text: `Possible ship-to-ship transfer — MMSI ${loitering[0]} and ${loitering[1]} stopped alongside each other`,
        });
    } else if (loitering.length > R.STS_PAIR_CONFIDENT_MAX) {
        escalateReasons.push({
            type: 'STS_GROUP',
            text: `${loitering.length} vessels loitering together (${loitering.join(', ')}) — more than a simple pair`,
            mmsis: loitering,
        });
    }

    // ── Multi-signal single vessel — DIVERSITY of event type, not volume.
    // Three pings of the same type is noise; two different kinds of anomalous
    // behavior on one vessel in the same window is the "several pieces of
    // information together" case worth a synthesized read. ───────────────────
    for (const story of snapshot.developingStories || []) {
        const distinctTypes = new Set((story.events || []).map(e => e.type));
        if (distinctTypes.size >= R.MULTI_SIGNAL_TYPES_MIN) {
            escalateReasons.push({
                type: 'MULTI_SIGNAL_VESSEL',
                text: `MMSI ${story.mmsi} shows ${distinctTypes.size} different kinds of anomalous behavior `
                    + `(${[...distinctTypes].join(', ')}) in the same window`,
                mmsis: [story.mmsi],
            });
        }
    }

    // ── Cross-domain co-occurrence — rules can DETECT "these are all active
    // right now" but can't WEIGH "are they related, or just noise lighting up
    // at once?" — exactly the reasoning an LLM call is worth spending on. ─────
    const activeDomains = [
        (snapshot.rfEvents || []).length > 0,
        (snapshot.chokepointActivity || []).length > 0,
        (snapshot.developingStories || []).length > 0,
        loitering.length > 0,
    ].filter(Boolean).length;
    if (activeDomains >= R.CROSS_DOMAIN_ESCALATE_MIN_DOMAINS) {
        escalateReasons.push({
            type: 'CROSS_DOMAIN',
            text: `${activeDomains} domains active simultaneously (RF/chokepoint/AIS-story/loitering) `
                + `— worth checking for a single underlying incident`,
            mmsis: (snapshot.developingStories || []).map(s => s.mmsi),
        });
    }

    // ── Several vessels developing stories at once — a pattern judgment call,
    // not a count check, so it escalates rather than templating. ─────────────
    if ((snapshot.developingStories || []).length >= R.COORDINATED_VESSEL_MIN) {
        escalateReasons.push({
            type: 'COORDINATED_MULTI_VESSEL',
            text: `${snapshot.developingStories.length} vessels with developing stories in the same window `
                + `— possible coordinated activity`,
            mmsis: snapshot.developingStories.map(s => s.mmsi),
        });
    }

    return { findings, escalate: escalateReasons.length > 0, escalateReasons };
}
