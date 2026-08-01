// tests/stmPki.test.mjs — the SECOM dev PKI, proved by an actual TLS handshake.
// Run from repo root:  node --import ./tests/_stubs/register.mjs tests/stmPki.test.mjs
//
// A certificate test that only inspects fields tells you the DER says the right
// words. It does not tell you the TLS stack will accept them, and the gap
// between those two is where mTLS bugs live — a missing SAN, an extendedKeyUsage
// that excludes clientAuth, a key that does not match its cert. All three parse
// perfectly and all three fail at handshake with errors that name no file.
//
// So the core of this suite stands up a real HTTPS server on loopback with
// requestCert + rejectUnauthorized and connects to it. What is asserted is not
// "the fields look right" but "the handshake succeeded and the server learned
// who the client was" — and, just as importantly, that the handshake FAILS when
// it should.
//
// Generation needs openssl; the sidecar does not. If openssl is absent this
// suite skips rather than fails, and says so — a red suite on a machine that
// simply lacks a build tool teaches people to ignore red suites.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { generate, verify, requireOpenssl, FILES } from '../tools/stm-pki.mjs';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
async function atest(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

let haveOpenssl = true;
try { requireOpenssl(); } catch { haveOpenssl = false; }
if (!haveOpenssl) {
    console.log('SKIPPED — openssl is not on PATH. Generation needs it; the sidecar does not.');
    console.log('\nstmPki.test: skipped');
    process.exit(0);
}

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-pki-test-'));
const ALT = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-pki-alt-'));
const p = (f) => path.join(DIR, f);
const read = (d, f) => fs.readFileSync(path.join(d, f));

generate({ out: DIR, org: 'TESTORG', mrn: 'urn:mrn:stm:org:testorg', force: true });
generate({ out: ALT, org: 'IMPOSTOR', mrn: 'urn:mrn:stm:org:impostor', force: true });

console.log('what was generated');
test('six files, ECDSA P-256', () => {
    for (const f of Object.values(FILES)) assert.ok(fs.existsSync(p(f)), `missing ${f}`);
    const c = new X509Certificate(read(DIR, FILES.serverCrt));
    assert.equal(c.publicKey.asymmetricKeyType, 'ec');
    assert.equal(c.publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
});
test('verify() passes on a freshly generated set', () => {
    const v = verify(DIR);
    assert.deepEqual(v.problems, []);
    assert.equal(v.ok, true);
});
test('the CA is a CA and the leaves are not', () => {
    assert.equal(new X509Certificate(read(DIR, FILES.caCrt)).ca, true);
    assert.equal(new X509Certificate(read(DIR, FILES.serverCrt)).ca, false);
    assert.equal(new X509Certificate(read(DIR, FILES.clientCrt)).ca, false);
});
test('the MRN travels in the client SAN as a URI', () => {
    const san = new X509Certificate(read(DIR, FILES.clientCrt)).subjectAltName;
    assert.match(san, /URI:urn:mrn:stm:org:testorg/);
    assert.doesNotMatch(san, /DNS:/, 'a client cert with a DNS SAN could impersonate a server');
});
test('regenerating without --force refuses rather than invalidating the CA', () => {
    // Silently replacing the CA breaks every cert issued from it, mid-debug,
    // for a reason unrelated to whatever the person was changing.
    assert.throws(() => generate({ out: DIR, force: false }), /already exist/);
});

console.log('verify() actually detects damage');
test('a truncated certificate is reported, not swallowed', () => {
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-pki-broken-'));
    generate({ out: broken, force: true });
    const crt = path.join(broken, FILES.serverCrt);
    fs.writeFileSync(crt, fs.readFileSync(crt).slice(0, 200));
    const v = verify(broken);
    assert.equal(v.ok, false);
    assert.ok(v.problems.some(x => x.includes(FILES.serverCrt)), v.problems.join('; '));
    fs.rmSync(broken, { recursive: true, force: true });
});
test('a key swapped for another PKI\'s key is caught', () => {
    const mixed = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-pki-mixed-'));
    generate({ out: mixed, force: true });
    fs.copyFileSync(path.join(ALT, FILES.serverKey), path.join(mixed, FILES.serverKey));
    const v = verify(mixed);
    assert.equal(v.ok, false);
    assert.ok(v.problems.some(x => /does not match/.test(x)), v.problems.join('; '));
    fs.rmSync(mixed, { recursive: true, force: true });
});

// ── the part that matters: a real handshake ─────────────────────────────────

function startServer() {
    return new Promise((resolve) => {
        const server = https.createServer({
            key: read(DIR, FILES.serverKey),
            cert: read(DIR, FILES.serverCrt),
            ca: read(DIR, FILES.caCrt),
            requestCert: true,
            rejectUnauthorized: true,     // SECOM is MUTUAL TLS, not TLS
        }, (req, res) => {
            const peer = req.socket.getPeerCertificate();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                subject: peer?.subject?.CN ?? null,
                san: peer?.subjectaltname ?? null,
            }));
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function request(opts) {
    return new Promise((resolve, reject) => {
        const req = https.request({ host: '127.0.0.1', servername: 'localhost',
                                    path: '/', method: 'GET', ...opts }, (res) => {
            let body = '';
            res.on('data', d => { body += d; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

const server = await startServer();
const port = server.address().port;

console.log('MUTUAL TLS — the handshake, not the fields');
await atest('a client presenting the right cert connects, and the server learns its MRN', async () => {
    const r = await request({
        port,
        key: read(DIR, FILES.clientKey),
        cert: read(DIR, FILES.clientCrt),
        ca: read(DIR, FILES.caCrt),
    });
    assert.equal(r.status, 200);
    const seen = JSON.parse(r.body);
    assert.match(seen.san, /urn:mrn:stm:org:testorg/,
        'the whole point of mTLS here is that the server knows WHO connected');
});
await atest('a client with NO certificate is rejected', async () => {
    await assert.rejects(
        () => request({ port, ca: read(DIR, FILES.caCrt) }),
        (e) => /socket hang up|alert|ECONNRESET|certificate/i.test(e.message),
        'an anonymous client must not reach the handler');
});
await atest('a client with a cert from ANOTHER CA is rejected', async () => {
    // The impostor's cert is structurally perfect. It is simply not ours.
    await assert.rejects(
        () => request({ port,
            key: read(ALT, FILES.clientKey),
            cert: read(ALT, FILES.clientCrt),
            ca: read(DIR, FILES.caCrt) }),
        (e) => /socket hang up|alert|ECONNRESET|unknown ca|certificate/i.test(e.message));
});
await atest('a client that does not trust our CA refuses the SERVER', async () => {
    // The other direction, and easy to forget: mutual means both sides check.
    await assert.rejects(
        () => request({ port,
            key: read(DIR, FILES.clientKey),
            cert: read(DIR, FILES.clientCrt),
            ca: read(ALT, FILES.caCrt) }),
        (e) => /self.signed|unable to verify|UNABLE_TO_VERIFY|SELF_SIGNED/i.test(e.message + e.code));
});
await atest('the server cert is accepted for "localhost" specifically', async () => {
    // A missing or wrong SAN fails here and nowhere else.
    await assert.doesNotReject(() => new Promise((resolve, reject) => {
        const s = tls.connect({ port, host: '127.0.0.1', servername: 'localhost',
            key: read(DIR, FILES.clientKey), cert: read(DIR, FILES.clientCrt),
            ca: read(DIR, FILES.caCrt) }, () => {
            const ok = s.authorized;
            s.destroy();
            ok ? resolve() : reject(new Error('not authorized: ' + s.authorizationError));
        }).on('error', reject);
    }));
});

server.close();
fs.rmSync(DIR, { recursive: true, force: true });
fs.rmSync(ALT, { recursive: true, force: true });

console.log(`\nstmPki.test: ${passed} checks passed`);
