#!/usr/bin/env node
// stm-proxy.js — the SECOM sidecar. STM_ROUTE_SPEC §7.1.
//
//     node tools/stm-pki.mjs      # once, to create .secom/
//     node stm-proxy.js           # then this, on :8788
//
// ── WHY A SIDECAR AT ALL ────────────────────────────────────────────────────
//
// SECOM (IEC 63173-2:2022) requires mutual TLS with a client certificate the
// application controls, and an ECDSA signature over each payload made with a
// private key the application holds. A browser can do neither. It cannot present
// a client certificate under program control — the platform chooses, via a UI we
// do not drive — and it cannot hold a signing key that is both usable and
// non-extractable across a page load in any way a counterparty would accept.
//
// This is not a limitation to work around; it is the reason the architecture has
// this shape. The browser speaks plain HTTP to localhost, and this process is the
// only thing that ever touches a certificate or a private key. Phases 1 and 2
// were built to work with no network at all precisely so the map stays useful
// before any of this exists.
//
// ── WHAT IS REAL HERE AND WHAT IS NOT ───────────────────────────────────────
//
// REAL: the mutual TLS, the certificate validation, the ECDSA signing and
// verification, the identity extracted from the peer certificate, the rule that
// signatures are checked over transmitted bytes.
//
// NOT REAL: membership of a trust community. The certificates come from
// tools/stm-pki.mjs, a development CA of our own. No MCP Identity Registry, no
// Service Registry, no discovery. A real counterparty would reject us and we
// would reject them, correctly.
//
// The VIS surface below is a SUBSET of STM VIS REST v2.2 — voyage plans,
// subscriptions and acknowledgements. /area (S-124 navigational warnings) is
// deliberately absent rather than stubbed: an endpoint that accepts warnings and
// does nothing with them is worse than one that is honestly missing.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
    envelope, open as openEnvelope, mrnFromCert, publicKeyOf,
    ACK_TYPE, RESPONSE, ALGORITHM,
} from './stmSecom.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
        ? process.argv[i + 1] : fallback;
}
const PORT   = Number(arg('port', 8788));
const PKIDIR = path.resolve(arg('pki', path.join(HERE, '.secom')));
const LOCAL_PORT = Number(arg('localPort', 8789));
const MAX_BODY = 4 * 1024 * 1024;   // matches STM.MAX_PLAN_BYTES

// ── state ───────────────────────────────────────────────────────────────────
// In memory on purpose. A sidecar that persists voyage plans becomes a second
// source of truth beside voyagePlanStore, and two stores that can disagree about
// which plan is current is exactly the bug this whole subsystem exists to avoid.
const plans = new Map();          // uvid → { env, receivedAt, senderMrn, opened }
const subscriptions = new Map();  // id → { mrn, dataProductType, createdAt }

export function createServer({ pkiDir = PKIDIR } = {}) {
    const read = (f) => fs.readFileSync(path.join(pkiDir, f));
    let creds;
    try {
        creds = {
            key:  read('server.key'),
            cert: read('server.crt'),
            ca:   read('ca.crt'),
            clientKey:  read('client.key'),
            clientCert: read('client.crt'),
        };
    } catch (e) {
        throw new Error(
            `No PKI in ${pkiDir} (${e.code}). Run:  node tools/stm-pki.mjs\n` +
            '  SECOM is mutual TLS — there is no unauthenticated mode to fall back to.');
    }

    const ownMrn = mrnFromCert(creds.clientCert) ?? 'urn:mrn:stm:org:unknown';

    const server = https.createServer({
        key: creds.key,
        cert: creds.cert,
        ca: creds.ca,
        requestCert: true,
        // No anonymous callers. SECOM has no notion of one, and an
        // "authentication optional" mode is how a service ends up with an
        // unauthenticated path nobody remembers is there.
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
    }, (req, res) => handle(req, res, creds, ownMrn));

    server.ownMrn = ownMrn;
    server.creds = creds;
    return server;
}

function send(res, status, body) {
    const s = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
    res.end(s);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let n = 0; const chunks = [];
        req.on('data', (c) => {
            n += c.length;
            if (n > MAX_BODY) { reject(new Error('PAYLOAD_TOO_LARGE')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

async function handle(req, res, creds, ownMrn) {
    // WHO IS CALLING comes from the certificate, never from the body. A senderMrn
    // field in a payload is a claim; the peer certificate is the thing mTLS
    // actually established, and the two are compared below rather than one being
    // trusted.
    const peer = req.socket.getPeerCertificate?.();
    const peerPem = peer?.raw
        ? `-----BEGIN CERTIFICATE-----\n${peer.raw.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`
        : null;
    const callerMrn = peerPem ? mrnFromCert(peerPem) : null;
    if (!callerMrn) {
        return send(res, 403, RESPONSE.error(403, 'peer certificate carries no MRN in its SAN'));
    }

    const url = new URL(req.url, 'https://localhost');
    const p = url.pathname.replace(/\/+$/, '') || '/';

    try {
        // ── GET /v2/voyagePlans[?uvid=|?mmsi=] ──────────────────────────────
        if (req.method === 'GET' && p === '/v2/voyagePlans') {
            const uvid = url.searchParams.get('uvid');
            const mmsi = url.searchParams.get('mmsi');
            let out = [...plans.values()];
            if (uvid) out = out.filter(x => x.uvid === uvid);
            if (mmsi) out = out.filter(x => x.mmsi === mmsi);
            return send(res, 200, RESPONSE.ok({
                voyagePlans: out.map(x => ({
                    uvid: x.uvid, mmsi: x.mmsi, senderMrn: x.senderMrn,
                    dataProductType: x.env.dataProductType,
                    receivedAt: x.receivedAt, opened: x.opened,
                    // The envelope is returned whole so the caller can verify it
                    // themselves. Handing back only our parsed view would make
                    // this service the trust anchor, which it is not.
                    envelope: x.env,
                })),
            }));
        }

        // ── POST /v2/voyagePlans — upload a signed plan ─────────────────────
        if (req.method === 'POST' && p === '/v2/voyagePlans') {
            const body = await readBody(req);
            let env;
            try { env = JSON.parse(body.toString('utf8')); }
            catch { return send(res, 400, RESPONSE.error(400, 'body is not JSON')); }

            // Verified against the PEER'S key — the certificate mTLS validated —
            // not against a key named in the envelope. A message that says who
            // signed it proves nothing about who signed it.
            const opened = openEnvelope(env, publicKeyOf(peerPem));
            if (!opened.ok) {
                return send(res, 400, {
                    ...RESPONSE.error(400, `signature check failed: ${opened.reason}`),
                    ackType: ACK_TYPE.ERROR,
                });
            }
            if (env.senderMrn && env.senderMrn !== callerMrn) {
                // Not fatal to the signature, but it is a lie about identity and
                // must not pass silently.
                return send(res, 403, {
                    ...RESPONSE.error(403,
                        `senderMrn "${env.senderMrn}" does not match the calling certificate "${callerMrn}"`),
                    ackType: ACK_TYPE.ERROR,
                });
            }

            const uvid = env.uvid ?? extractUvid(opened.text) ?? randomUUID();
            plans.set(uvid, {
                uvid,
                mmsi: env.mmsi ?? extractMmsi(opened.text),
                senderMrn: callerMrn,
                // Kept so the LOCAL face can re-verify the signature when it
                // serves this plan, instead of trusting a flag set at arrival.
                senderCertPem: peerPem,
                env,
                receivedAt: new Date().toISOString(),
                opened: false,
            });
            return send(res, 201, RESPONSE.ok({
                uvid,
                ackType: ACK_TYPE.DELIVERED,
                // DELIVERED, not OPENED. We have stored it; nobody has read it.
                note: 'stored. An OPENED_ACK is sent when a consumer actually reads it.',
            }));
        }

        // ── POST /v2/voyagePlans/:uvid/opened ───────────────────────────────
        const openedMatch = /^\/v2\/voyagePlans\/([^/]+)\/opened$/.exec(p);
        if (req.method === 'POST' && openedMatch) {
            const rec = plans.get(decodeURIComponent(openedMatch[1]));
            if (!rec) return send(res, 404, RESPONSE.error(404, 'no such uvid'));
            rec.opened = true;
            rec.openedAt = new Date().toISOString();
            return send(res, 200, RESPONSE.ok({ ackType: ACK_TYPE.OPENED, uvid: rec.uvid }));
        }

        // ── subscriptions ───────────────────────────────────────────────────
        if (req.method === 'POST' && p === '/v2/voyagePlans/subscription') {
            const body = await readBody(req);
            let spec = {};
            try { spec = body.length ? JSON.parse(body.toString('utf8')) : {}; } catch { /* empty is fine */ }
            const id = randomUUID();
            subscriptions.set(id, {
                id, mrn: callerMrn,
                dataProductType: spec.dataProductType ?? null,
                createdAt: new Date().toISOString(),
            });
            return send(res, 201, RESPONSE.ok({ subscriptionIdentifier: id }));
        }
        const subMatch = /^\/v2\/voyagePlans\/subscription\/([^/]+)$/.exec(p);
        if (req.method === 'DELETE' && subMatch) {
            const id = decodeURIComponent(subMatch[1]);
            const sub = subscriptions.get(id);
            if (!sub) return send(res, 404, RESPONSE.error(404, 'no such subscription'));
            // Your subscription, or nobody's. Deleting by bare id would let any
            // authenticated peer cancel another organisation's feed.
            if (sub.mrn !== callerMrn) {
                return send(res, 403, RESPONSE.error(403, 'that subscription belongs to another MRN'));
            }
            subscriptions.delete(id);
            return send(res, 200, RESPONSE.ok({ deleted: id }));
        }
        if (req.method === 'GET' && p === '/v2/voyagePlans/subscription') {
            return send(res, 200, RESPONSE.ok({
                subscriptions: [...subscriptions.values()].filter(s => s.mrn === callerMrn),
            }));
        }

        // ── identity / health ───────────────────────────────────────────────
        if (req.method === 'GET' && p === '/v2/identity') {
            return send(res, 200, RESPONSE.ok({
                serviceMrn: ownMrn,
                callerMrn,
                algorithm: ALGORITHM,
                trustAnchor: 'DEVELOPMENT CA — not the MCP Identity Registry',
                plans: plans.size,
                subscriptions: subscriptions.size,
            }));
        }

        return send(res, 404, RESPONSE.error(404, `no route for ${req.method} ${p}`));
    } catch (e) {
        if (e.message === 'PAYLOAD_TOO_LARGE') {
            return send(res, 413, RESPONSE.error(413, `payload exceeds ${MAX_BODY} bytes`));
        }
        return send(res, 500, RESPONSE.error(500, e.message));
    }
}

// Cheap extraction for indexing only — NOT parsing. The codecs own parsing, they
// live in the browser, and duplicating even a little of that here would create a
// second implementation to drift.
function extractUvid(text) {
    return /uvid="([^"]+)"/i.exec(text)?.[1] ?? /<uvid>([^<]+)<\/uvid>/i.exec(text)?.[1] ?? null;
}
function extractMmsi(text) {
    return /vesselMMSI="([^"]+)"/i.exec(text)?.[1] ?? null;
}

// ── THE LOCAL FACE ──────────────────────────────────────────────────────────
//
// The browser cannot do mutual TLS — it cannot present a client certificate
// under program control, and it cannot hold a signing key a counterparty would
// accept. So the map talks to THIS, in the clear, on loopback, and the sidecar
// remains the only process that ever touches a certificate or a private key.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ KNOWN LIMITATION, STATED RATHER THAN HIDDEN                              ║
// ║                                                                          ║
// ║ Anything running on this machine can reach this port, and this port can  ║
// ║ sign with the organisation's private key. Binding to 127.0.0.1 keeps it  ║
// ║ off the network; it does NOT keep it away from other local software.     ║
// ║                                                                          ║
// ║ That is acceptable for a development sidecar and NOT acceptable for a    ║
// ║ real deployment, where this face needs a per-session token the app       ║
// ║ fetches from its OWN origin (so a foreign page cannot read it) and the   ║
// ║ signing route needs an explicit operator confirmation. Both are          ║
// ║ deliberately absent here rather than half-built.                         ║
// ╚══════════════════════════════════════════════════════════════════════════╝
export function createLocalServer({ creds, ownMrn }) {
    return http.createServer(async (req, res) => {
        // Loopback only, checked per REQUEST as well as at bind. A bind address
        // is a configuration; this is a fact about the socket in front of us.
        const ra = req.socket.remoteAddress ?? '';
        if (!/^(::1|::ffff:127\.|127\.)/.test(ra)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'loopback only', saw: ra }));
        }
        // The map is served from a different port, so this is cross-origin.
        // Localhost origins only — not '*', which would let any page on the
        // internet drive a service that holds a signing key.
        const origin = req.headers.origin;
        if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
        }
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

        const url = new URL(req.url, 'http://localhost');
        const p = url.pathname.replace(/\/+$/, '') || '/';
        try {
            if (req.method === 'GET' && p === '/local/status') {
                return send(res, 200, RESPONSE.ok({
                    serviceMrn: ownMrn, algorithm: ALGORITHM,
                    trustAnchor: 'DEVELOPMENT CA — not the MCP Identity Registry',
                    plans: plans.size, subscriptions: subscriptions.size,
                }));
            }

            // Plans, WITH their payload text so the browser can parse them with
            // its own codecs. The sidecar deliberately does not parse route
            // documents — routeCodecs owns that, and a second implementation
            // here is a second thing to drift.
            if (req.method === 'GET' && p === '/local/voyagePlans') {
                const out = [];
                for (const rec of plans.values()) {
                    const opened = openEnvelope(rec.env, publicKeyOf(rec.senderCertPem));
                    out.push({
                        uvid: rec.uvid, mmsi: rec.mmsi, senderMrn: rec.senderMrn,
                        dataProductType: rec.env.dataProductType,
                        receivedAt: rec.receivedAt, opened: rec.opened,
                        // VERIFIED AT READ TIME, not trusted from when it arrived.
                        // A store is a place things can be edited.
                        signatureValid: opened.ok,
                        payload: opened.ok ? opened.text : null,
                    });
                }
                return send(res, 200, RESPONSE.ok({ voyagePlans: out }));
            }

            // Sign and publish OUR OWN plan — the outbound direction.
            if (req.method === 'POST' && p === '/local/publish') {
                const body = await readBody(req);
                let spec;
                try { spec = JSON.parse(body.toString('utf8')); }
                catch { return send(res, 400, RESPONSE.error(400, 'body is not JSON')); }
                if (typeof spec.payload !== 'string' || !spec.payload.trim()) {
                    return send(res, 400, RESPONSE.error(400, 'payload (the route document) is required'));
                }
                const env = envelope({
                    payload: spec.payload,
                    privateKey: creds.clientKey,
                    dataProductType: spec.dataProductType ?? 'RTZ',
                    senderMrn: ownMrn,
                });
                const uvid = spec.uvid ?? extractUvid(spec.payload) ?? randomUUID();
                plans.set(uvid, {
                    uvid, mmsi: spec.mmsi ?? extractMmsi(spec.payload),
                    senderMrn: ownMrn, senderCertPem: creds.clientCert,
                    env, receivedAt: new Date().toISOString(), opened: false,
                });
                return send(res, 201, RESPONSE.ok({ uvid, exchangeId: env.exchangeId, ackType: ACK_TYPE.DELIVERED }));
            }

            return send(res, 404, RESPONSE.error(404, `no route for ${req.method} ${p}`));
        } catch (e) {
            if (e.message === 'PAYLOAD_TOO_LARGE') return send(res, 413, RESPONSE.error(413, 'payload too large'));
            return send(res, 500, RESPONSE.error(500, e.message));
        }
    });
}

export { plans, subscriptions, envelope };

// ── CLI ─────────────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('stm-proxy.js')) {
    try {
        const server = createServer();
        server.listen(PORT, '127.0.0.1', () => {
            console.log(`[stm-proxy] SECOM sidecar on https://localhost:${PORT}  (mutual TLS)`);
            console.log(`[stm-proxy]   identity   ${server.ownMrn}`);
            console.log('[stm-proxy]   GET    /v2/identity');
            console.log('[stm-proxy]   GET    /v2/voyagePlans[?uvid=|?mmsi=]');
            console.log('[stm-proxy]   POST   /v2/voyagePlans                    (signed envelope)');
            console.log('[stm-proxy]   POST   /v2/voyagePlans/:uvid/opened');
            console.log('[stm-proxy]   POST   /v2/voyagePlans/subscription');
            console.log('[stm-proxy]   DELETE /v2/voyagePlans/subscription/:id');
            console.log('[stm-proxy] TRUST ANCHOR IS A DEV CA. Not MCP. Not interoperable with anyone.');
        });
        const local = createLocalServer({ creds: server.creds, ownMrn: server.ownMrn });
        local.listen(LOCAL_PORT, '127.0.0.1', () => {
            console.log(`[stm-proxy] local face on http://127.0.0.1:${LOCAL_PORT}  (plain HTTP, loopback only)`);
            console.log('[stm-proxy]   GET  /local/status');
            console.log('[stm-proxy]   GET  /local/voyagePlans     (payload + signatureValid, re-checked on read)');
            console.log('[stm-proxy]   POST /local/publish         (signs with the org key)');
            console.log('[stm-proxy] ANY local process can reach that port and it can SIGN. Dev only.');
        });
    } catch (e) {
        console.error('[stm-proxy] ' + e.message);
        process.exit(1);
    }
}
