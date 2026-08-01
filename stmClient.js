// stmClient.js — the browser half of SECOM. Talks to the sidecar, not the sea.
//
// STM_ROUTE_SPEC §7.1: SECOM cannot run in a browser. It needs a client
// certificate presented under program control and a private key the application
// holds, and a page can do neither. So this module speaks PLAIN HTTP to
// stm-proxy.js on loopback, and the sidecar owns every certificate and key.
//
// What that buys, and it is the whole point of the split: this file has no
// crypto in it at all. There is no key here to leak, no signature to get subtly
// wrong, no canonicalisation rule to violate. It moves documents and asks the
// sidecar whether they were genuine.
//
// ── THE HONESTY RULE THAT SHAPES THIS FILE ──────────────────────────────────
//
// A plan whose signature did not verify is NOT imported. Not imported-and-
// flagged, not imported-with-a-warning — not imported. Everything downstream of
// voyagePlanStore treats a plan as a statement of intent by a named vessel, and
// the signature is the only thing making that true. A plan that fails
// verification is a document of unknown authorship, and monitoring a ship
// against one would produce alarms attributed to a route nobody demonstrably
// sent. It is reported to the operator and dropped.
//
// Parsing is done by routeCodecs, exactly as it is for a dropped file. There is
// no SECOM-specific parse path, because a plan that arrived over the network is
// not a different KIND of plan — only a differently-provenanced one.

import { parseAny } from './routeCodecs.js';
import { voyagePlanStore } from './voyagePlanStore.js';

const DEFAULT_BASE = 'http://127.0.0.1:8789';

export class StmClient {
    /**
     * @param {{base?: string, store?: object, parse?: Function, fetch?: Function}} opts
     */
    constructor(opts = {}) {
        this.base  = (opts.base ?? DEFAULT_BASE).replace(/\/+$/, '');
        this.store = opts.store ?? voyagePlanStore;
        this.parse = opts.parse ?? parseAny;
        this._fetch = opts.fetch ?? ((...a) => fetch(...a));
        /** Last error, for the panel. Null when the last call succeeded. */
        this.lastError = null;
        /** False until a call succeeds — the sidecar is optional, not assumed. */
        this.available = false;
        this._timer = null;
    }

    async _get(path) {
        const r = await this._fetch(`${this.base}${path}`, { headers: { Accept: 'application/json' } });
        if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
        return r.json();
    }

    /**
     * Is the sidecar there, and who does it think it is?
     *
     * Never throws. The sidecar is an OPTIONAL component — the map works
     * completely without it, which is why phases 1 and 2 were built offline —
     * and a missing optional service must not surface as an application error.
     */
    async status() {
        try {
            const s = await this._get('/local/status');
            this.available = true;
            this.lastError = null;
            return s;
        } catch (e) {
            this.available = false;
            this.lastError = e.message;
            return null;
        }
    }

    /**
     * Pull plans from the sidecar and import the ones that verify.
     *
     * @returns {{imported: number, rejected: Array, skipped: number, unavailable?: boolean}}
     */
    async pull() {
        let payload;
        try {
            payload = await this._get('/local/voyagePlans');
            this.available = true;
            this.lastError = null;
        } catch (e) {
            this.available = false;
            this.lastError = e.message;
            return { imported: 0, rejected: [], skipped: 0, unavailable: true };
        }

        const out = { imported: 0, rejected: [], skipped: 0 };
        for (const rec of payload?.voyagePlans ?? []) {
            // ── the gate ────────────────────────────────────────────────────
            if (rec.signatureValid !== true) {
                out.rejected.push({
                    uvid: rec.uvid, senderMrn: rec.senderMrn,
                    reason: 'SIGNATURE_NOT_VALID',
                    detail: 'The sidecar could not verify this document against the '
                          + 'certificate that delivered it. Not imported — its author is unknown.',
                });
                continue;
            }
            if (typeof rec.payload !== 'string' || !rec.payload.trim()) {
                out.rejected.push({ uvid: rec.uvid, senderMrn: rec.senderMrn,
                    reason: 'EMPTY_PAYLOAD', detail: 'Verified, but there was nothing inside.' });
                continue;
            }

            const { plan, report, format } = this.parse(rec.payload);
            if (!plan) {
                out.rejected.push({
                    uvid: rec.uvid, senderMrn: rec.senderMrn, reason: 'UNPARSEABLE',
                    detail: report?.warnings?.[0]?.detail ?? 'no codec accepted the document',
                });
                continue;
            }

            // Provenance the operator can act on. sourceOrigin says HOW it got
            // here; senderMrn says WHO sent it — and the second is only
            // meaningful because the signature verified above.
            plan.sourceOrigin = 'secom';
            plan.senderMrn = rec.senderMrn;
            plan.exchangeReceivedAt = rec.receivedAt;
            plan.signatureVerified = true;
            if (rec.uvid && !plan.uvid) plan.uvid = rec.uvid;

            const before = this.store.byUvid?.(plan.uvid);
            this.store.add(plan);
            if (before) out.skipped++; else out.imported++;
            void format;
        }
        return out;
    }

    /**
     * Hand a route document to the sidecar to SIGN and publish.
     * The signing key never comes near this process.
     */
    async publish(routeDocument, { dataProductType = 'RTZ', uvid, mmsi } = {}) {
        const r = await this._fetch(`${this.base}/local/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload: routeDocument, dataProductType, uvid, mmsi }),
        });
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error(body?.message ?? `publish → HTTP ${r.status}`);
        return body;
    }

    /** Poll. Returns a stop function; safe to call start twice. */
    start(intervalMs = 15000, onResult) {
        this.stop();
        const tick = async () => {
            const r = await this.pull();
            if (onResult) { try { onResult(r); } catch { /* a listener must not stop the loop */ } };
        };
        void tick();
        this._timer = setInterval(tick, intervalMs);
        return () => this.stop();
    }

    stop() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    }
}

/**
 * One line for the operator. Rejections are NEVER summarised away — a plan that
 * failed verification is the single most important thing this subsystem can
 * have to say, and burying it in a count is how it stops being noticed.
 */
export function summarisePull(result) {
    if (!result) return '';
    if (result.unavailable) return 'SECOM SIDECAR UNAVAILABLE — no exchange. The map is unaffected.';
    const lines = [];
    if (result.imported) lines.push(`SECOM: imported ${result.imported} verified plan(s)`);
    if (result.skipped)  lines.push(`  ${result.skipped} already held`);
    for (const r of result.rejected ?? []) {
        lines.push(`  REJECTED ${r.uvid ?? '(no uvid)'} from ${r.senderMrn ?? 'unknown sender'}: ${r.reason}`);
        if (r.detail) lines.push(`    ${r.detail}`);
    }
    if (!lines.length) return 'SECOM: nothing new';
    return lines.join('\n');
}

export const stmClient = new StmClient();

// ── Debug handle (Tier 3 — DevTools only, never the data path) ──────────────
if (typeof window !== 'undefined') {
    window.vg1Secom = {
        client: stmClient,
        status: () => stmClient.status(),
        pull:   () => stmClient.pull().then(r => { console.log(summarisePull(r)); return r; }),
        publish: (doc, o) => stmClient.publish(doc, o),
    };
}
