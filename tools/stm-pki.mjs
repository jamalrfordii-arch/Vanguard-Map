#!/usr/bin/env node
// tools/stm-pki.mjs — a development PKI for the SECOM sidecar.
//
//     node tools/stm-pki.mjs              # generate into .secom/ if absent
//     node tools/stm-pki.mjs --force      # regenerate, replacing what is there
//     node tools/stm-pki.mjs --out DIR --org "MY ORG" --mrn urn:mrn:stm:org:me
//
// ── WHAT THIS IS, AND WHAT IT IS NOT ────────────────────────────────────────
//
// SECOM (IEC 63173-2:2022) is mutual TLS with X.509 identity plus ECDSA signing
// of each payload. In production those certificates come from the Maritime
// Connectivity Platform Identity Registry, which issues MRN-bearing certs a
// counterparty's trust store already recognises.
//
// This produces the same SHAPE with an identity nobody else recognises: our own
// CA, a server cert and a client cert, ECDSA P-256, proper extensions. So the
// mTLS handshake is real, the certificate validation is real, the signing is
// real — everything is genuinely exercised EXCEPT membership of a trust
// community. Swapping in MCP-issued certs later is a path change, not a rewrite,
// which is the whole reason to do it this way round.
//
// It is a DEV PKI. The CA private key sits unencrypted next to the certs it
// signed. Never point this at anything that matters.
//
// ── OPENSSL IS A SETUP DEPENDENCY, NOT A RUNTIME ONE ────────────────────────
//
// Node can parse and verify X.509 (crypto.X509Certificate) but cannot issue it,
// so generation shells out to openssl. That is a one-time cost paid here; the
// sidecar itself needs nothing but Node, which matters because the sidecar is
// the thing that has to run on your machine and in CI.
//
// The verification pass at the end deliberately uses NODE, not openssl. A
// generator that checks its work with the same tool that did the work is only
// testing that the tool is self-consistent. Node re-reads the files exactly as
// the TLS stack will.

import { execFileSync } from 'node:child_process';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
        ? process.argv[i + 1] : fallback;
}
const FORCE = process.argv.includes('--force');
const OUT   = path.resolve(arg('out', path.join(HERE, '..', '.secom')));
const ORG   = arg('org', 'VANGUARD1');
const MRN   = arg('mrn', 'urn:mrn:stm:org:vanguard1');
const DAYS  = Number(arg('days', 825));   // the CA/Browser Forum leaf maximum
const CURVE = 'prime256v1';               // NIST P-256; SECOM signing is ECDSA

export const FILES = {
    caKey: 'ca.key', caCrt: 'ca.crt',
    serverKey: 'server.key', serverCrt: 'server.crt',
    clientKey: 'client.key', clientCrt: 'client.crt',
};

function openssl(args, opts = {}) {
    return execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

/** Fail early and by name. "openssl: not found" three calls deep is not a diagnosis. */
export function requireOpenssl() {
    try {
        const v = openssl(['version']).toString().trim();
        return v;
    } catch (e) {
        throw new Error(
            'openssl is required to GENERATE certificates and was not found on PATH.\n' +
            '  Linux/macOS: it is almost certainly installed — check your PATH.\n' +
            '  Windows:     Git for Windows ships it at C:\\Program Files\\Git\\usr\\bin\\openssl.exe;\n' +
            '               add that directory to PATH, or run this from Git Bash.\n' +
            '  The SIDECAR does not need openssl — only this generator does.');
    }
}

/**
 * Generate a CA, a server certificate and a client certificate.
 * @returns {{dir: string, files: Record<string,string>, openssl: string}}
 */
export function generate({ out = OUT, org = ORG, mrn = MRN, days = DAYS, force = FORCE } = {}) {
    const version = requireOpenssl();

    const existing = Object.values(FILES).filter(f => fs.existsSync(path.join(out, f)));
    if (existing.length && !force) {
        // Refusing rather than overwriting: regenerating the CA invalidates every
        // cert already issued from it, and doing that silently to someone
        // mid-debug is a genuinely confusing failure — the handshake starts
        // failing for a reason that has nothing to do with what they changed.
        throw new Error(
            `${existing.length} PKI file(s) already exist in ${out}.\n` +
            '  Pass --force to replace them. Note that regenerating the CA invalidates\n' +
            '  every certificate issued from it, including any a counterparty has pinned.');
    }

    fs.mkdirSync(out, { recursive: true });
    const p = (f) => path.join(out, f);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-pki-'));

    try {
        // ── CA ───────────────────────────────────────────────────────────────
        // pathlen:0 — this CA may sign leaves and nothing else. A dev CA that can
        // mint intermediates is a dev CA that can be talked into minting anything.
        openssl(['ecparam', '-name', CURVE, '-genkey', '-noout', '-out', p(FILES.caKey)]);
        openssl(['req', '-x509', '-new', '-key', p(FILES.caKey), '-sha256',
                 '-days', String(days), '-out', p(FILES.caCrt),
                 '-subj', `/O=${org}/CN=${org} STM Dev CA`,
                 '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
                 '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);

        // ── leaves ───────────────────────────────────────────────────────────
        // extendedKeyUsage is what actually separates these two. A cert valid for
        // BOTH serverAuth and clientAuth lets a client authenticate as the
        // service it is talking to, which quietly removes the point of mutual TLS.
        issue(tmp, p, {
            keyFile: FILES.serverKey, crtFile: FILES.serverCrt,
            subject: `/O=${org}/CN=localhost`,
            ext: [
                'basicConstraints=critical,CA:FALSE',
                'keyUsage=critical,digitalSignature',
                'extendedKeyUsage=serverAuth',
                'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1',
            ],
            days,
        });

        issue(tmp, p, {
            keyFile: FILES.clientKey, crtFile: FILES.clientCrt,
            subject: `/O=${org}/CN=${org} STM Client`,
            ext: [
                'basicConstraints=critical,CA:FALSE',
                'keyUsage=critical,digitalSignature',
                'extendedKeyUsage=clientAuth',
                // The MRN travels in the SAN as a URI. That is where MCP puts a
                // maritime identity, so the shape matches what a real registry
                // issues even though the issuer here is us.
                `subjectAltName=URI:${mrn}`,
            ],
            days,
        });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    // Private keys readable by the owner only. Best-effort: Windows ignores this,
    // and it is not what makes a dev PKI safe — not using it for anything real is.
    for (const f of [FILES.caKey, FILES.serverKey, FILES.clientKey]) {
        try { fs.chmodSync(p(f), 0o600); } catch { /* non-POSIX filesystem */ }
    }

    return {
        dir: out,
        openssl: version,
        files: Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, p(f)])),
    };
}

function issue(tmp, p, { keyFile, crtFile, subject, ext, days }) {
    const csr = path.join(tmp, keyFile + '.csr');
    const cnf = path.join(tmp, keyFile + '.ext');
    fs.writeFileSync(cnf, ext.join('\n') + '\n');
    openssl(['ecparam', '-name', CURVE, '-genkey', '-noout', '-out', p(keyFile)]);
    openssl(['req', '-new', '-key', p(keyFile), '-out', csr, '-subj', subject]);
    openssl(['x509', '-req', '-in', csr, '-CA', p(FILES.caCrt), '-CAkey', p(FILES.caKey),
             '-CAcreateserial', '-out', p(crtFile), '-days', String(days),
             '-sha256', '-extfile', cnf]);
}

/**
 * Re-read what was written and check it with NODE — the same code path the TLS
 * stack uses — rather than asking openssl whether openssl did its job.
 *
 * @returns {{ok: boolean, problems: string[], info: object}}
 */
export function verify(dir = OUT) {
    const problems = [];
    const p = (f) => path.join(dir, f);
    const read = (f) => {
        try { return new X509Certificate(fs.readFileSync(p(f))); }
        catch (e) { problems.push(`${f}: ${e.message}`); return null; }
    };

    const ca = read(FILES.caCrt);
    const server = read(FILES.serverCrt);
    const client = read(FILES.clientCrt);
    if (!ca || !server || !client) return { ok: false, problems, info: {} };

    if (!ca.ca) problems.push('ca.crt is not marked as a CA');
    if (server.ca) problems.push('server.crt is marked as a CA — a leaf must not be');
    if (client.ca) problems.push('client.crt is marked as a CA — a leaf must not be');

    for (const [name, cert] of [['server', server], ['client', client]]) {
        if (!cert.verify(ca.publicKey)) problems.push(`${name}.crt was not signed by ca.crt`);
        if (cert.issuer !== ca.subject) problems.push(`${name}.crt issuer does not match the CA subject`);
        const now = Date.now();
        if (Date.parse(cert.validFrom) > now) problems.push(`${name}.crt is not valid yet`);
        if (Date.parse(cert.validTo) < now) problems.push(`${name}.crt has expired`);
    }

    // The separation that makes mutual TLS mean anything.
    if (!/DNS:localhost/.test(server.subjectAltName ?? ''))
        problems.push('server.crt has no localhost SAN — Node will reject the hostname');
    if (!/URI:urn:mrn:/.test(client.subjectAltName ?? ''))
        problems.push('client.crt carries no MRN in its SAN');
    if (/DNS:/.test(client.subjectAltName ?? ''))
        problems.push('client.crt carries a DNS SAN — it must not be usable as a server');

    // Private keys must actually belong to the certs they sit beside. A mismatched
    // pair fails at handshake time with an error that names neither file.
    for (const [name, crt, key] of [['ca', FILES.caCrt, FILES.caKey],
                                    ['server', FILES.serverCrt, FILES.serverKey],
                                    ['client', FILES.clientCrt, FILES.clientKey]]) {
        try {
            const cert = new X509Certificate(fs.readFileSync(p(crt)));
            if (!cert.checkPrivateKey(createPrivateKey(fs.readFileSync(p(key)))))
                problems.push(`${name}.key does not match ${name}.crt`);
        } catch (e) { problems.push(`${name} key/cert pair: ${e.message}`); }
    }

    return {
        ok: problems.length === 0,
        problems,
        info: {
            ca: ca.subject, caValidTo: ca.validTo,
            serverSan: server.subjectAltName, clientSan: client.subjectAltName,
            keyType: server.publicKey.asymmetricKeyType,
            curve: server.publicKey.asymmetricKeyDetails?.namedCurve,
        },
    };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1]?.endsWith('stm-pki.mjs')) {
    try {
        const r = generate();
        const v = verify(r.dir);
        console.log(`[stm-pki] ${r.openssl}`);
        console.log(`[stm-pki] wrote 6 files to ${r.dir}`);
        console.log(`[stm-pki]   CA        ${v.info.ca}`);
        console.log(`[stm-pki]   key type  ${v.info.keyType} ${v.info.curve}`);
        console.log(`[stm-pki]   server    ${v.info.serverSan}`);
        console.log(`[stm-pki]   client    ${v.info.clientSan}`);
        if (!v.ok) {
            console.error('[stm-pki] VERIFICATION FAILED:');
            for (const p of v.problems) console.error('  · ' + p);
            process.exit(1);
        }
        console.log('[stm-pki] verified with node crypto — chain, extensions and key pairing OK');
        console.log('[stm-pki] DEV PKI. The CA private key is unencrypted beside the certs it signed.');
    } catch (e) {
        console.error('[stm-pki] ' + e.message);
        process.exit(1);
    }
}
