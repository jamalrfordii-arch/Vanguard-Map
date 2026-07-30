// voyagePlanStore.js — single owner of the STM voyage-plan collection.
//
// Same role for route plans that entityStore.js plays for live entities, and
// deliberately the same shape: one owning module with getters, all structural
// mutation funnelled through it, and `window.*` only ever a read-only debug
// mirror (CLAUDE.md Tier 3). No other module may mutate the collection.
//
// WHAT A PLAN IS
// --------------
// A canonical VoyagePlan (docs/STM_ROUTE_SPEC.md §4.1), format-neutral: RTZ and
// S-421 both parse INTO this shape and serialise back OUT of it, and nothing
// downstream knows which wire format it came from — the same indistinguishability
// aisManager.ingest() gives live / replayed / synthetic AIS.
//
// IDENTITY
// --------
// The primary key is the UVID (`urn:mrn:stm:voyage:id:<org>:<uuid>`), because a
// vessel can hold several plans at once — an approved one, a superseded one, a
// shore-suggested alternative. MMSI is a secondary index, and `byMmsi()`
// deliberately returns only the ACTIVE plan, since "the route this ship is
// steering" is a question with exactly one right answer at a time.
//
// A plan with no UVID still needs a stable key or every re-import duplicates it,
// so one is synthesised from MMSI + route name and MARKED as synthesised. We
// never mint a UVID for a plan received from a real service: the ship owns its
// UVID and service providers must not rewrite it.
//
// Tests: node tests/voyagePlanStore.test.mjs

import { STM } from './config.js';
import { simClock } from './simClock.js';
import { ROUTE_STATUS_MONITORING } from './rtzCodec.js';

const _plans = [];                 // stable reference, like entityStore's array
const _byUvid = new Map();         // uvid → plan (index, not ownership)

let _flushTimer = null;
let _dirty = false;

// ── helpers ──────────────────────────────────────────────────────────────────

function now() {
    // simClock, not Date.now — plans must survive time-scrubbing along with
    // everything else (CLAUDE.md: managers never call Date.now for world time).
    try { return simClock.now(); } catch { return Date.now(); }
}

function emit(name, detail) {
    if (typeof window === 'undefined' || !window.dispatchEvent) return;
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch { /* non-fatal */ }
}

function planBytes(plan) {
    // The raw document dominates; everything else is small by comparison.
    return (plan?.raw?.length ?? 0) + 512;
}

/**
 * Stable key for a plan. Real UVIDs pass through untouched.
 * A synthesised key is prefixed and flagged so it can never be mistaken for one
 * a ship actually issued.
 */
export function planKey(plan) {
    if (plan?.uvid) return plan.uvid;
    const mmsi = plan?.mmsi ?? 'nommsi';
    const name = (plan?.routeName ?? 'unnamed').replace(/\s+/g, '-').toLowerCase();
    return `${STM.ORG_MRN_PREFIX}:local:${mmsi}:${name}`;
}

/** True when the plan is inside its declared validity window (or declares none). */
export function isValidAt(plan, t = now()) {
    if (!plan) return false;
    if (plan.validFrom != null && t < plan.validFrom) return false;
    if (plan.validTo != null && t > plan.validTo) return false;
    return true;
}

/**
 * True when this plan is the one the ship is actually steering: routeStatus 7
 * ("used for monitoring" — loaded in the ECDIS) AND currently valid.
 *
 * When STM.MONITOR_ONLY_STATUS_7 is false, any status except 8 (inactive)
 * qualifies. That switch exists for demos against files that never set a status,
 * and it is off by design: monitoring a route at status 2 is monitoring an
 * intention nobody is executing.
 */
export function isMonitored(plan, t = now()) {
    if (!plan || !isValidAt(plan, t)) return false;
    if (STM.MONITOR_ONLY_STATUS_7) return plan.routeStatus === ROUTE_STATUS_MONITORING;
    return plan.routeStatus !== 8;
}

// ── persistence ──────────────────────────────────────────────────────────────

function scheduleFlush() {
    _dirty = true;
    if (_flushTimer != null) return;
    if (typeof setTimeout === 'undefined') return;
    _flushTimer = setTimeout(() => { _flushTimer = null; flush(); }, STM.PLAN_FLUSH_MS);
}

function flush() {
    if (!_dirty) return;
    _dirty = false;
    if (typeof localStorage === 'undefined') return;
    try {
        // Persist the raw documents plus the identity fields needed to re-index
        // without re-parsing on read. Re-parsing happens lazily on load.
        const payload = _plans.map(p => ({
            uvid: p.uvid, mmsi: p.mmsi, routeName: p.routeName, routeStatus: p.routeStatus,
            sourceFormat: p.sourceFormat, sourceOrigin: p.sourceOrigin,
            receivedAt: p.receivedAt, validFrom: p.validFrom, validTo: p.validTo,
            raw: p.raw ?? null,
        }));
        localStorage.setItem(STM.STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
        // Quota exhaustion is the likely cause and it is not fatal — the plans
        // are still live in memory. Say so rather than failing silently.
        console.warn('[voyagePlanStore] persist failed:', e?.message ?? e);
    }
}

/**
 * Enforce the count and byte caps, oldest `receivedAt` first.
 *
 * Eviction is LOGGED. Silent truncation reads as "we have everything" when we
 * do not, which is the failure mode the codebase's honesty rule exists to
 * prevent (an ocean-passage RTZ can be hundreds of KB, so the byte cap bites
 * long before the count cap does).
 */
function evictIfNeeded() {
    const dropped = [];

    while (_plans.length > STM.MAX_PLANS) {
        const victim = oldestIndex();
        if (victim < 0) break;
        dropped.push(_plans[victim]);
        removeAt(victim);
    }

    let bytes = _plans.reduce((a, p) => a + planBytes(p), 0);
    while (bytes > STM.MAX_PLAN_BYTES && _plans.length > 1) {
        const victim = oldestIndex();
        if (victim < 0) break;
        bytes -= planBytes(_plans[victim]);
        dropped.push(_plans[victim]);
        removeAt(victim);
    }

    if (dropped.length) {
        console.warn(`[voyagePlanStore] evicted ${dropped.length} plan(s) to stay under ` +
            `${STM.MAX_PLANS} plans / ${(STM.MAX_PLAN_BYTES / 1024 / 1024).toFixed(1)} MB: ` +
            dropped.map(p => p.uvid ?? p.routeName ?? '(unnamed)').join(', '));
        emit('vg1:voyagePlanEvicted', { count: dropped.length, uvids: dropped.map(planKey) });
    }
    return dropped;
}

function oldestIndex() {
    let best = -1, bestT = Infinity;
    for (let i = 0; i < _plans.length; i++) {
        const t = _plans[i].receivedAt ?? 0;
        if (t < bestT) { bestT = t; best = i; }
    }
    return best;
}

function removeAt(i) {
    const [p] = _plans.splice(i, 1);
    if (p) _byUvid.delete(planKey(p));
    return p ?? null;
}

// ── the store ────────────────────────────────────────────────────────────────

export const voyagePlanStore = {
    // ── reads ────────────────────────────────────────────────────────────────

    /** The live array, by STABLE reference. Do not push/splice — use add/remove. */
    all() { return _plans; },

    count() { return _plans.length; },

    /** Exact plan by UVID (or synthesised key), or null. */
    byUvid(uvid) { return _byUvid.get(String(uvid)) ?? null; },

    /** Every plan held for an MMSI, any status, newest first. */
    allByMmsi(mmsi) {
        const key = String(mmsi);
        return _plans
            .filter(p => p.mmsi != null && String(p.mmsi) === key)
            .sort((a, b) => (b.receivedAt ?? 0) - (a.receivedAt ?? 0));
    },

    /**
     * The plan this vessel is actually steering, or null.
     *
     * Null is a real and common answer — essentially no live AIS vessel shares a
     * route plan — and it means UNMONITORED, which is NOT the same as compliant.
     * Callers must render the difference. See docs/STM_ROUTE_SPEC.md §5.8.
     */
    byMmsi(mmsi, t = now()) {
        const candidates = this.allByMmsi(mmsi).filter(p => isMonitored(p, t));
        return candidates[0] ?? null;   // newest wins if a ship shares two at status 7
    },

    /** Every plan currently at monitoring status and inside its validity window. */
    monitored(t = now()) { return _plans.filter(p => isMonitored(p, t)); },

    /** Total retained bytes — for the store panel and the eviction story. */
    bytes() { return _plans.reduce((a, p) => a + planBytes(p), 0); },

    // ── writes (the ONLY sanctioned mutations) ───────────────────────────────

    /**
     * Add or REPLACE a plan. Replacement is by key, so re-receiving an updated
     * plan for the same UVID supersedes rather than duplicates — which is what
     * a VIS subscription push does on every update.
     * Returns the stored plan, or null if the argument was unusable.
     */
    add(plan) {
        if (!plan || typeof plan !== 'object') return null;
        if (!Array.isArray(plan.waypoints) || plan.waypoints.length < 2) {
            console.warn('[voyagePlanStore] refusing a plan with fewer than 2 waypoints — ' +
                         'there is no route axis to measure against.');
            return null;
        }

        const stored = { ...plan };
        stored.receivedAt ??= now();
        if (!stored.uvid) {
            stored.uvidSynthesised = true;   // never let this be mistaken for a real one
        }
        const key = planKey(stored);

        const prev = _byUvid.get(key);
        if (prev) {
            const i = _plans.indexOf(prev);
            if (i >= 0) _plans[i] = stored; else _plans.push(stored);
        } else {
            _plans.push(stored);
        }
        _byUvid.set(key, stored);

        evictIfNeeded();
        scheduleFlush();

        emit('vg1:voyagePlanReceived', {
            uvid: key, mmsi: stored.mmsi, routeStatus: stored.routeStatus,
            routeName: stored.routeName, superseded: !!prev,
            sourceFormat: stored.sourceFormat, sourceOrigin: stored.sourceOrigin,
        });
        if (isMonitored(stored)) {
            emit('vg1:voyagePlanActivated', { uvid: key, mmsi: stored.mmsi });
        }
        return stored;
    },

    /** Remove by UVID (or synthesised key). Returns the removed plan, or null. */
    removeByUvid(uvid) {
        const key = String(uvid);
        const p = _byUvid.get(key);
        if (!p) return null;
        const i = _plans.indexOf(p);
        if (i >= 0) _plans.splice(i, 1);
        _byUvid.delete(key);
        scheduleFlush();
        emit('vg1:voyagePlanRemoved', { uvid: key, mmsi: p.mmsi });
        return p;
    },

    /** Drop every plan for an MMSI. Returns how many went. */
    removeByMmsi(mmsi) {
        const victims = this.allByMmsi(mmsi);
        victims.forEach(p => this.removeByUvid(planKey(p)));
        return victims.length;
    },

    /**
     * Drop plans whose validity window has closed. Returns the removed plans.
     * Called on the monitor's tick — a plan that expired mid-voyage should stop
     * being monitored, not keep raising alarms against a stale schedule.
     */
    expire(t = now()) {
        const gone = _plans.filter(p => p.validTo != null && t > p.validTo);
        gone.forEach(p => {
            this.removeByUvid(planKey(p));
            emit('vg1:voyagePlanExpired', { uvid: planKey(p), mmsi: p.mmsi, validTo: p.validTo });
        });
        return gone;
    },

    /** Empty the collection in place, keeping the stable reference. */
    clear() {
        _plans.length = 0;
        _byUvid.clear();
        scheduleFlush();
    },

    // ── persistence control ──────────────────────────────────────────────────

    /** Force an immediate write. Normally the debounced flush handles this. */
    flushNow() { _dirty = true; flush(); },

    /**
     * Rehydrate from localStorage. Needs a parser because only the raw document
     * is persisted — `parseFn(raw) → {plan, report}`, normally rtzCodec.parse.
     * Injected rather than imported so the store stays format-agnostic and so
     * S-421 can be routed here later without touching this file.
     * Returns { loaded, failed }.
     */
    load(parseFn) {
        if (typeof localStorage === 'undefined' || typeof parseFn !== 'function') {
            return { loaded: 0, failed: 0 };
        }
        let raw;
        try { raw = localStorage.getItem(STM.STORAGE_KEY); }
        catch { return { loaded: 0, failed: 0 }; }
        if (!raw) return { loaded: 0, failed: 0 };

        let rows;
        try { rows = JSON.parse(raw); }
        catch (e) {
            console.warn('[voyagePlanStore] stored payload is corrupt, discarding:', e?.message ?? e);
            return { loaded: 0, failed: 0 };
        }
        if (!Array.isArray(rows)) return { loaded: 0, failed: 0 };

        let loaded = 0, failed = 0;
        for (const row of rows) {
            if (!row?.raw) { failed++; continue; }
            try {
                const { plan } = parseFn(row.raw);
                if (!plan) { failed++; continue; }
                plan.receivedAt = row.receivedAt ?? now();
                // Provenance and re-entry are two different facts and neither
                // may overwrite the other. `sourceOrigin` answers "where did this
                // plan come from" — a file, a VIS push, a SECOM object — and
                // that stays true forever. `restoredFromStorage` answers "how did
                // it get into THIS session", which matters because a restored
                // plan has not been re-confirmed by its source and may have been
                // superseded while the tab was closed.
                plan.sourceOrigin = row.sourceOrigin ?? plan.sourceOrigin ?? 'file';
                plan.restoredFromStorage = true;
                if (this.add(plan)) loaded++; else failed++;
            } catch { failed++; }
        }
        if (failed) {
            console.warn(`[voyagePlanStore] ${failed} stored plan(s) failed to restore.`);
        }
        return { loaded, failed };
    },
};

// ── DEBUG HANDLE ONLY — Tier 3, never the data path (CLAUDE.md) ──────────────
if (typeof window !== 'undefined') {
    window.vg1Plans = voyagePlanStore;
}
