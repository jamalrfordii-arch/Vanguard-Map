// tests/stmSecom.test.mjs — the SECOM envelope and the sidecar, end to end.
// Run from repo root:  node --import ./tests/_stubs/register.mjs tests/stmSecom.test.mjs
//
// Two halves, and the first is the one that would ship a silent hole:
//
//   PART 1  the envelope. Signing and verification over TRANSMITTED BYTES, and
//           the specific failure that happens when someone re-serialises first.
//   PART 2  the sidecar over real mutual TLS: a signed plan in, identity taken
//           from the certificate rather than the body, DELIVERED vs OPENED, and
//           subscriptions that belong to whoever created them.
//
// Needs openssl to mint the test PKI; skips cleanly without it.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { generate, requireOpenssl, FILES } from '../tools/stm-pki.mjs';
import {
    sign, verifySignature, envelope, open, mrnFromCert, publicKeyOf, ALGORITHM, ACK_TYPE,
} from '../stmSecom.mjs';
import { createServer, plans, subscriptions } from '../stm-proxy.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
async function atest(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

try { requireOpenssl(); } catch {
    console.log('SKIPPED — openssl is not on PATH. The sidecar does not need it; minting test certs does.');
    console.log('\nstmSecom.test: skipped');
    process.exit(0);
}

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'secom-'));
const ALT = fs.mkdtempSync(path.join(os.tmpdir(), 'secom-alt-'));
generate({ out: DIR, org: 'VANGUARD1', mrn: 'urn:mrn:stm:org:vanguard1', force: true });
generate({ out: ALT, org: 'IMPOSTOR', mrn: 'urn:mrn:stm:org:impostor', force: true });
const rd  = (d, f) => fs.readFileSync(path.join(d, f));
const key = (d) => createPrivateKey(rd(d, FILES.clientKey));
const pub = (d) => publicKeyOf(rd(d, FILES.clientCrt));

const RTZ = '<?xml version="1.0"?><route version="1.1" uvid="urn:mrn:stm:voyage:id:demo:1">'
          + '<routeInfo routeName="TEST" vesselMMSI="265177000" routeStatus="7"/></route>';

// ═══════════════════════════ PART 1 — THE ENVELOPE ══════════════════════════

console.log('signing');
test('a signature verifies over the same bytes', () => {
    const sig = sign(RTZ, key(DIR));
    assert.equal(sig.algorithm, ALGORITHM);
    assert.equal(verifySignature(RTZ, sig, pub(DIR)), true);
});
test('one flipped byte fails', () => {
    const sig = sign(RTZ, key(DIR));
    assert.equal(verifySignature(RTZ.replace('265177000', '265177001'), sig, pub(DIR)), false);
});
test('another organisation\'s key fails', () => {
    assert.equal(verifySignature(RTZ, sign(RTZ, key(ALT)), pub(DIR)), false);
});
test('garbage in returns FALSE, never throws', () => {
    // A verifier that throws invites a try/catch whose catch block means "accept".
    for (const bad of [null, undefined, {}, { value: 'not base64!!' }, { value: 123 }]) {
        assert.doesNotThrow(() => verifySignature(RTZ, bad, pub(DIR)));
        assert.equal(verifySignature(RTZ, bad, pub(DIR)), false, JSON.stringify(bad));
    }
});
test('a signature claiming a different algorithm is refused', () => {
    const sig = { ...sign(RTZ, key(DIR)), algorithm: 'RSA-SHA1' };
    assert.equal(verifySignature(RTZ, sig, pub(DIR)), false);
});

console.log('THE RULE — verify the transmitted bytes, not a re-serialisation');
test('an envelope opens to the exact bytes that were signed', () => {
    const env = envelope({ payload: RTZ, privateKey: key(DIR),
                           dataProductType: 'RTZ', senderMrn: 'urn:mrn:stm:org:vanguard1' });
    const o = open(env, pub(DIR));
    assert.equal(o.ok, true, o.reason);
    assert.equal(o.text, RTZ);
    assert.ok(Buffer.isBuffer(o.bytes));
});
test('RE-SERIALISING A PARSED PAYLOAD BREAKS THE SIGNATURE — the trap, demonstrated', () => {
    // JSON.stringify is not canonical: key order follows insertion order, so an
    // equal object can serialise to different bytes. A verifier that parses and
    // re-serialises therefore rejects VALID messages, intermittently, depending
    // on who produced them — and the natural "fix" is to weaken verification.
    const original = JSON.stringify({ mmsi: '265177000', uvid: 'x', status: 7 });
    const sig = sign(original, key(DIR));
    const reserialised = JSON.stringify(JSON.parse(
        JSON.stringify({ status: 7, uvid: 'x', mmsi: '265177000' })));  // equal, different order

    assert.notEqual(reserialised, original, 'the two byte strings really do differ');
    assert.deepEqual(JSON.parse(reserialised), JSON.parse(original), 'while being the same object');
    assert.equal(verifySignature(original, sig, pub(DIR)), true, 'original bytes verify');
    assert.equal(verifySignature(reserialised, sig, pub(DIR)), false,
        'and the equal-but-reordered bytes do not — which is why open() returns bytes, not an object');
});
test('a tampered data field fails, even though base64 decoding is lenient', () => {
    // Buffer.from drops invalid base64 characters rather than failing, so a
    // corrupted field yields shorter bytes with no error. The signature is what
    // catches it — never the encoding step.
    const env = envelope({ payload: RTZ, privateKey: key(DIR), dataProductType: 'RTZ' });
    env.data = env.data.slice(0, -8) + 'AAAAAAAA';
    assert.equal(open(env, pub(DIR)).reason, 'BAD_SIGNATURE');
});
test('malformed envelopes are named, not lumped together', () => {
    assert.equal(open(null, pub(DIR)).reason, 'NOT_AN_ENVELOPE');
    assert.equal(open({}, pub(DIR)).reason, 'NO_DATA');
    assert.equal(open({ data: 'x' }, pub(DIR)).reason, 'NO_SIGNATURE');
});

console.log('identity from a certificate');
test('the MRN comes out of the SAN', () => {
    assert.equal(mrnFromCert(rd(DIR, FILES.clientCrt)), 'urn:mrn:stm:org:vanguard1');
    assert.equal(mrnFromCert(rd(ALT, FILES.clientCrt)), 'urn:mrn:stm:org:impostor');
});
test('a certificate without an MRN yields null, not a guess', () => {
    assert.equal(mrnFromCert(rd(DIR, FILES.serverCrt)), null);
    assert.equal(mrnFromCert('not a certificate'), null);
});

// ═══════════════════════ PART 2 — THE SIDECAR, OVER mTLS ════════════════════

const server = createServer({ pkiDir: DIR });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

function call(method, p, { body, pki = DIR } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body == null ? null
            : (typeof body === 'string' ? body : JSON.stringify(body));
        const req = https.request({
            host: '127.0.0.1', port: PORT, servername: 'localhost', method, path: p,
            key: rd(pki, FILES.clientKey), cert: rd(pki, FILES.clientCrt), ca: rd(DIR, FILES.caCrt),
            headers: payload ? { 'Content-Type': 'application/json',
                                 'Content-Length': Buffer.byteLength(payload) } : {},
        }, (res) => {
            let s = '';
            res.on('data', d => { s += d; });
            res.on('end', () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null }));
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

console.log('the sidecar identifies its caller by CERTIFICATE');
await atest('/v2/identity reports who connected, from the cert', async () => {
    const r = await call('GET', '/v2/identity');
    assert.equal(r.status, 200);
    assert.equal(r.body.callerMrn, 'urn:mrn:stm:org:vanguard1');
    assert.match(r.body.trustAnchor, /DEVELOPMENT CA/, 'it must not claim to be MCP');
});
await atest('an untrusted client cannot connect at all', async () => {
    await assert.rejects(() => call('GET', '/v2/identity', { pki: ALT }),
        (e) => /socket hang up|alert|ECONNRESET|certificate/i.test(e.message));
});

console.log('voyage plan exchange');
let uvid;
await atest('a correctly signed plan is accepted and acknowledged DELIVERED', async () => {
    const env = envelope({ payload: RTZ, privateKey: key(DIR), dataProductType: 'RTZ',
                           senderMrn: 'urn:mrn:stm:org:vanguard1' });
    const r = await call('POST', '/v2/voyagePlans', { body: env });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.ackType, ACK_TYPE.DELIVERED);
    uvid = r.body.uvid;
    assert.equal(uvid, 'urn:mrn:stm:voyage:id:demo:1', 'indexed by the uvid in the payload');
});
await atest('a plan signed by someone else is REJECTED even over a valid channel', async () => {
    // The channel is authenticated; the payload is not. This is the case that
    // makes payload signing worth having at all.
    const env = envelope({ payload: RTZ, privateKey: key(ALT), dataProductType: 'RTZ' });
    const r = await call('POST', '/v2/voyagePlans', { body: env });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /BAD_SIGNATURE/);
    assert.equal(r.body.ackType, ACK_TYPE.ERROR);
});
await atest('a senderMrn that contradicts the certificate is refused', async () => {
    const env = envelope({ payload: RTZ, privateKey: key(DIR), dataProductType: 'RTZ',
                           senderMrn: 'urn:mrn:stm:org:someone-else' });
    const r = await call('POST', '/v2/voyagePlans', { body: env });
    assert.equal(r.status, 403);
    assert.match(r.body.message, /does not match the calling certificate/);
});
await atest('a stored plan is returned WITH its envelope so the caller can verify it', async () => {
    const r = await call('GET', '/v2/voyagePlans?uvid=' + encodeURIComponent(uvid));
    assert.equal(r.status, 200);
    assert.equal(r.body.voyagePlans.length, 1);
    const got = r.body.voyagePlans[0];
    assert.equal(got.senderMrn, 'urn:mrn:stm:org:vanguard1');
    const reopened = open(got.envelope, pub(DIR));
    assert.equal(reopened.ok, true, 'the round trip must not disturb the signed bytes');
    assert.equal(reopened.text, RTZ);
});
await atest('DELIVERED and OPENED are different facts', async () => {
    // "the ship received your route" and "the bridge opened it" are not the same
    // thing, and collapsing them lets a shore centre believe a plan was seen.
    let r = await call('GET', '/v2/voyagePlans?uvid=' + encodeURIComponent(uvid));
    assert.equal(r.body.voyagePlans[0].opened, false);
    r = await call('POST', `/v2/voyagePlans/${encodeURIComponent(uvid)}/opened`);
    assert.equal(r.body.ackType, ACK_TYPE.OPENED);
    r = await call('GET', '/v2/voyagePlans?uvid=' + encodeURIComponent(uvid));
    assert.equal(r.body.voyagePlans[0].opened, true);
});
await atest('marking an unknown uvid opened is a 404, not a silent success', async () => {
    const r = await call('POST', '/v2/voyagePlans/nope/opened');
    assert.equal(r.status, 404);
});

console.log('subscriptions belong to whoever made them');
await atest('create, list, delete', async () => {
    const c = await call('POST', '/v2/voyagePlans/subscription', { body: { dataProductType: 'RTZ' } });
    assert.equal(c.status, 201);
    const id = c.body.subscriptionIdentifier;
    const l = await call('GET', '/v2/voyagePlans/subscription');
    assert.ok(l.body.subscriptions.some(s => s.id === id));
    const d = await call('DELETE', '/v2/voyagePlans/subscription/' + id);
    assert.equal(d.status, 200);
    const l2 = await call('GET', '/v2/voyagePlans/subscription');
    assert.ok(!l2.body.subscriptions.some(s => s.id === id));
});
await atest('another MRN cannot delete a subscription it does not own', async () => {
    const c = await call('POST', '/v2/voyagePlans/subscription', { body: {} });
    const id = c.body.subscriptionIdentifier;
    subscriptions.get(id).mrn = 'urn:mrn:stm:org:someone-else';   // pretend it is theirs
    const d = await call('DELETE', '/v2/voyagePlans/subscription/' + id);
    assert.equal(d.status, 403);
    assert.match(d.body.message, /belongs to another MRN/);
    subscriptions.delete(id);
});

console.log('limits and unknown routes');
await atest('an oversized body is refused with 413, not buffered', async () => {
    const r = await call('POST', '/v2/voyagePlans', { body: 'x'.repeat(5 * 1024 * 1024) })
        .catch(e => ({ status: 'ECONN', body: { message: e.message } }));
    assert.ok(r.status === 413 || r.status === 'ECONN', JSON.stringify(r));
});
await atest('an unknown route names the method and path', async () => {
    const r = await call('GET', '/v2/nope');
    assert.equal(r.status, 404);
    assert.match(r.body.message, /GET \/v2\/nope/);
});

server.close();
plans.clear(); subscriptions.clear();
fs.rmSync(DIR, { recursive: true, force: true });
fs.rmSync(ALT, { recursive: true, force: true });

console.log(`\nstmSecom.test: ${passed} checks passed`);
