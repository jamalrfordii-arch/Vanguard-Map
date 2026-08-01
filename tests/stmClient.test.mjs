// tests/stmClient.test.mjs — the browser half, and the full loop.
// Run from repo root:  node --import ./tests/_stubs/register.mjs tests/stmClient.test.mjs
//
// PART 1 exercises StmClient against a stub sidecar — fast, and it covers the
// rule that matters most: an unverified plan is NOT IMPORTED. Not imported and
// flagged. Not imported.
//
// PART 2 runs the whole chain for real: a signed plan goes into the sidecar over
// MUTUAL TLS from an external peer, the browser-facing local port serves it back
// with the signature RE-CHECKED at read time, StmClient parses it through
// routeCodecs and puts it in voyagePlanStore, and enhancedMonitor then monitors
// a vessel against it. Phase 3 → Phase 1, end to end, with no step faked.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { createPrivateKey } from 'node:crypto';
import { DOMParser } from './_stubs/xmlDom.mjs';
import { generate, requireOpenssl, FILES } from '../tools/stm-pki.mjs';
import { envelope } from '../stmSecom.mjs';
import { createServer, createLocalServer, plans, subscriptions } from '../stm-proxy.js';
import { StmClient, summarisePull } from '../stmClient.js';
import { voyagePlanStore } from '../voyagePlanStore.js';
import { EnhancedMonitor } from '../enhancedMonitor.js';
import { simClock } from '../simClock.js';

// voyagePlanStore is a singleton object, not a class. For the unit half we want
// isolation between cases, so this is a minimal stand-in with the three methods
// StmClient actually uses — deliberately NOT a copy of the real store's logic,
// which would let this suite pass while the real one broke.
const fakeStore = () => {
    const byUvid = new Map();
    return {
        add(p) { byUvid.set(String(p.uvid), p); },
        all() { return [...byUvid.values()]; },
        byUvid(u) { return byUvid.get(String(u)) ?? null; },
    };
};
import { parseAny } from '../routeCodecs.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
async function atest(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const RTZ = `<?xml version="1.0"?>
<route version="1.1" xmlns="http://www.cirm.org/RTZ/1/1" uvid="urn:mrn:stm:voyage:id:peer:77">
  <routeInfo routeName="PEER ROUTE" vesselMMSI="265177000" routeStatus="7"/>
  <waypoints>
    <waypoint id="1"><position lat="57.60" lon="11.65"/></waypoint>
    <waypoint id="2"><position lat="57.63" lon="11.50"/>
      <leg portsideXTD="0.15" starboardXTD="0.30"/></waypoint>
  </waypoints>
</route>`;

const parse = (xml) => parseAny(xml, { domParser: new DOMParser() });

// ═══════════════════════ PART 1 — the gate, against a stub ══════════════════

function stubClient(voyagePlans) {
    const store = fakeStore();
    const client = new StmClient({
        base: 'http://stub', store, parse,
        fetch: async (url) => {
            if (url.endsWith('/local/voyagePlans')) {
                return { ok: true, json: async () => ({ voyagePlans }) };
            }
            if (url.endsWith('/local/status')) return { ok: true, json: async () => ({ plans: voyagePlans.length }) };
            return { ok: false, status: 404, json: async () => ({}) };
        },
    });
    return { client, store };
}

console.log('THE GATE — an unverified plan is not imported');
await atest('signatureValid:false is REJECTED, and the store stays empty', async () => {
    const { client, store } = stubClient([
        { uvid: 'u1', senderMrn: 'urn:mrn:stm:org:x', signatureValid: false, payload: RTZ },
    ]);
    const r = await client.pull();
    assert.equal(r.imported, 0);
    assert.equal(store.all().length, 0, 'a document of unknown authorship must not reach the monitor');
    assert.equal(r.rejected[0].reason, 'SIGNATURE_NOT_VALID');
});
await atest('a MISSING signatureValid is treated as invalid, not as absent', async () => {
    // `!== true` rather than `=== false`. An older sidecar that omits the field
    // must not be read as "fine".
    const { client, store } = stubClient([{ uvid: 'u2', payload: RTZ }]);
    const r = await client.pull();
    assert.equal(store.all().length, 0);
    assert.equal(r.rejected[0].reason, 'SIGNATURE_NOT_VALID');
});
await atest('a verified plan IS imported, with provenance attached', async () => {
    const { client, store } = stubClient([
        { uvid: 'urn:mrn:stm:voyage:id:peer:77', senderMrn: 'urn:mrn:stm:org:peer',
          signatureValid: true, payload: RTZ, receivedAt: '2026-07-30T10:00:00Z' },
    ]);
    const r = await client.pull();
    assert.equal(r.imported, 1);
    const p = store.all()[0];
    assert.equal(p.routeName, 'PEER ROUTE');
    assert.equal(p.sourceOrigin, 'secom');
    assert.equal(p.senderMrn, 'urn:mrn:stm:org:peer');
    assert.equal(p.signatureVerified, true);
});
await atest('a verified but unparseable payload is rejected with the codec\'s reason', async () => {
    const { client, store } = stubClient([
        { uvid: 'u3', senderMrn: 'm', signatureValid: true, payload: '<foo/>' },
    ]);
    const r = await client.pull();
    assert.equal(store.all().length, 0);
    assert.equal(r.rejected[0].reason, 'UNPARSEABLE');
    assert.match(r.rejected[0].detail, /root is <foo>/);
});
await atest('re-pulling the same plan counts as skipped, not imported twice', async () => {
    const rec = [{ uvid: 'urn:mrn:stm:voyage:id:peer:77', senderMrn: 'm', signatureValid: true, payload: RTZ }];
    const { client, store } = stubClient(rec);
    await client.pull();
    const r2 = await client.pull();
    assert.equal(r2.imported, 0);
    assert.equal(r2.skipped, 1);
    assert.equal(store.all().length, 1, 'supersede by uvid, never duplicate');
});
await atest('an unreachable sidecar is not an error — the map works without it', async () => {
    const client = new StmClient({ base: 'http://stub', store: fakeStore(), parse,
        fetch: async () => { throw new Error('ECONNREFUSED'); } });
    const r = await client.pull();
    assert.equal(r.unavailable, true);
    assert.equal(client.available, false);
    assert.equal(await client.status(), null, 'status() must not throw either');
});

console.log('what the operator is told');
test('a rejection is never summarised away into a count', () => {
    const s = summarisePull({ imported: 3, skipped: 0, rejected: [
        { uvid: 'u9', senderMrn: 'urn:mrn:stm:org:x', reason: 'SIGNATURE_NOT_VALID', detail: 'author unknown' },
    ] });
    assert.match(s, /REJECTED u9/);
    assert.match(s, /urn:mrn:stm:org:x/);
    assert.match(s, /SIGNATURE_NOT_VALID/);
});
test('an unavailable sidecar says the map is unaffected', () => {
    assert.match(summarisePull({ unavailable: true }), /UNAVAILABLE.*map is unaffected/s);
});

// ═════════════════ PART 2 — the whole chain, nothing faked ══════════════════

try { requireOpenssl(); } catch {
    console.log('\nPART 2 SKIPPED — openssl not on PATH (needed to mint test certs).');
    console.log(`\nstmClient.test: ${passed} checks passed`);
    process.exit(0);
}

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
generate({ out: DIR, org: 'VANGUARD1', mrn: 'urn:mrn:stm:org:vanguard1', force: true });
const rd = (f) => fs.readFileSync(path.join(DIR, f));

const secure = createServer({ pkiDir: DIR });
await new Promise(r => secure.listen(0, '127.0.0.1', r));
const local = createLocalServer({ creds: secure.creds, ownMrn: secure.ownMrn });
await new Promise(r => local.listen(0, '127.0.0.1', r));
const SECURE_PORT = secure.address().port;
const LOCAL_PORT = local.address().port;

function postSigned(env) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(env);
        const req = https.request({
            host: '127.0.0.1', port: SECURE_PORT, servername: 'localhost',
            method: 'POST', path: '/v2/voyagePlans',
            key: rd(FILES.clientKey), cert: rd(FILES.clientCrt), ca: rd(FILES.caCrt),
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => { let s = ''; res.on('data', d => { s += d; });
                      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(s) })); });
        req.on('error', reject);
        req.write(body); req.end();
    });
}

console.log('END TO END — signed over mTLS, served on loopback, monitored on the map');
// The REAL store and the REAL monitor. The point of this half is that a plan
// which travelled the whole SECOM path is indistinguishable downstream from one
// dropped on the map as a file.
const store = voyagePlanStore;
for (const p of [...store.all()]) store.removeByUvid?.(p.uvid);
const client = new StmClient({ base: `http://127.0.0.1:${LOCAL_PORT}`, store, parse });

await atest('a peer delivers a signed plan over mutual TLS', async () => {
    const env = envelope({
        payload: RTZ, privateKey: createPrivateKey(rd(FILES.clientKey)),
        dataProductType: 'RTZ', senderMrn: 'urn:mrn:stm:org:vanguard1',
    });
    const r = await postSigned(env);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.uvid, 'urn:mrn:stm:voyage:id:peer:77');
});
await atest('the local face reports it, with the signature RE-CHECKED at read time', async () => {
    const s = await client.status();
    assert.ok(s, 'sidecar not reachable');
    assert.equal(s.plans, 1);
    assert.match(s.trustAnchor, /DEVELOPMENT CA/);
});
await atest('StmClient imports it into the store, parsed by routeCodecs', async () => {
    const r = await client.pull();
    assert.equal(r.imported, 1, JSON.stringify(r.rejected));
    const p = store.all()[0];
    assert.equal(p.routeName, 'PEER ROUTE');
    assert.equal(p.sourceFormat, 'RTZ', 'the registry chose the codec, not the client');
    assert.equal(p.sourceOrigin, 'secom');
    assert.equal(p.signatureVerified, true);
    assert.equal(p.waypoints[1].leg.portsideXTD, 0.15, 'the corridor survived the whole trip');
});
await atest('TAMPERING AFTER STORAGE IS CAUGHT — the read-time re-check earns its keep', async () => {
    // Someone edits the stored envelope. The plan arrived genuinely signed and
    // was verified once; a flag set at arrival would still say "valid".
    const rec = [...plans.values()][0];
    const original = rec.env.data;
    rec.env.data = Buffer.from(RTZ.replace('265177000', '999999999')).toString('base64');
    const fresh = fakeStore();
    const c2 = new StmClient({ base: `http://127.0.0.1:${LOCAL_PORT}`, store: fresh, parse });
    const r = await c2.pull();
    assert.equal(r.imported, 0, 'a tampered plan must not reach the monitor');
    assert.equal(r.rejected[0].reason, 'SIGNATURE_NOT_VALID');
    assert.equal(fresh.all().length, 0);
    rec.env.data = original;
});
await atest('the imported plan is MONITORED — Phase 3 feeds Phase 1', async () => {
    simClock.setTime(Date.parse('2026-07-29T06:10:00Z'));
    const monitor = new EnhancedMonitor({ store, alerts: { addAlert() {} } });
    // On the route: waypoint 1 is 57.60/11.65, waypoint 2 is 57.63/11.50.
    const vessel = { mmsi: '265177000', latDeg: 57.615, lonDeg: 11.575,
                     speedKts: 12, cogDeg: 300, navStatus: 0 };
    monitor.tick([vessel]);
    const st = monitor.states.get('265177000');
    assert.ok(st, 'no monitor state for the vessel');
    assert.notEqual(st.state, 'UNMONITORED',
        'a plan that travelled the full SECOM path must be monitored like any other');
    assert.equal(typeof st.crossTrackNm, 'number', 'cross-track is computed against the received route');
});

secure.close(); local.close();
plans.clear(); subscriptions.clear();
fs.rmSync(DIR, { recursive: true, force: true });

console.log(`\nstmClient.test: ${passed} checks passed`);
