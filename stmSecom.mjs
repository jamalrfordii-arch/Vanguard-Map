// stmSecom.mjs — SECOM envelope: signing, verification, and the identity in a cert.
//
// Pure Node crypto, no server, no I/O. Everything here is testable without
// opening a socket, which is the point — the envelope rules are where the
// interesting failures are and they should not require a handshake to exercise.
//
// SECOM is IEC 63173-2:2022: mutual TLS for CHANNEL security, plus a signature
// over each PAYLOAD so a message stays attributable after it leaves the channel.
// The two are not redundant. mTLS proves who opened the connection; the payload
// signature proves who authored the bytes, and survives being stored, forwarded
// or replayed into a log.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ THE ONE RULE THAT MATTERS                                                ║
// ║                                                                          ║
// ║ SIGN AND VERIFY THE TRANSMITTED BYTES. Never re-serialise a parsed        ║
// ║ object and verify against that.                                          ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// JSON.stringify is not canonical. Key order follows insertion order, number
// formatting is engine-defined at the edges, and any parse→stringify round trip
// can legally produce different bytes for an equal object. A verifier that
// re-serialises therefore fails on VALID messages — intermittently, depending on
// who produced them — and the natural "fix" is to loosen verification until it
// passes, at which point the signature means nothing.
//
// So the envelope carries the payload as base64 of the exact signed bytes, and
// verification decodes that and checks it directly. The parsed object is a
// CONVENIENCE derived after verification, never an input to it. This is the same
// class of error as the S-421 axis order: both produce plausible results while
// being wrong, and neither announces itself.

import { createSign, createVerify, X509Certificate, randomUUID } from 'node:crypto';

/** SECOM signing algorithm. ECDSA over P-256 with SHA-256. */
export const ALGORITHM = 'ECDSA-SHA256';

// DER, stated explicitly rather than relied upon. Node's default for EC is DER,
// but WebCrypto and several other stacks default to the fixed-width P1363 pair —
// the same key and message produce bytes that do not verify across the two, with
// no error that says so. Naming it here is the difference between a compatibility
// note and a two-day investigation.
export const DSA_ENCODING = 'der';

/**
 * Sign bytes.
 * @param {Buffer|Uint8Array|string} payload the EXACT bytes to transmit
 * @param {KeyObject|string} privateKey
 * @returns {{algorithm: string, dsaEncoding: string, value: string}} base64 signature
 */
export function sign(payload, privateKey) {
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const s = createSign('sha256');
    s.update(buf);
    s.end();
    return {
        algorithm: ALGORITHM,
        dsaEncoding: DSA_ENCODING,
        value: s.sign({ key: privateKey, dsaEncoding: DSA_ENCODING }).toString('base64'),
    };
}

/**
 * Verify a signature over bytes.
 * @returns {boolean} — never throws on bad input; a malformed signature is not
 *   an exception, it is a false. Throwing here tempts callers into a try/catch
 *   whose catch block quietly means "accept".
 */
export function verifySignature(payload, signature, publicKey) {
    try {
        if (!signature || typeof signature.value !== 'string') return false;
        if (signature.algorithm && signature.algorithm !== ALGORITHM) return false;
        const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
        const v = createVerify('sha256');
        v.update(buf);
        v.end();
        return v.verify({ key: publicKey, dsaEncoding: signature.dsaEncoding || DSA_ENCODING },
                        Buffer.from(signature.value, 'base64'));
    } catch {
        return false;
    }
}

/**
 * Wrap a payload for transmission.
 *
 * `data` is base64 of the bytes that were signed, so a receiver can reproduce
 * them exactly. `dataProductType` is a SECOM enum member — RTZ and S421 are
 * SEPARATE members, not variants of one "route" type, which is why the registry
 * records sourceFormat rather than flattening it.
 */
export function envelope({ payload, privateKey, dataProductType, senderMrn, exchangeId }) {
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    return {
        exchangeId: exchangeId ?? randomUUID(),
        dataProductType,
        senderMrn,
        createdAt: new Date().toISOString(),
        data: bytes.toString('base64'),
        signature: sign(bytes, privateKey),
    };
}

/**
 * Open an envelope.
 *
 * @returns {{ok: boolean, reason?: string, bytes?: Buffer, text?: string}}
 *
 * Returns the BYTES. Deliberately does not parse them: the caller decides what
 * the payload is (RTZ, S-421, JSON), and handing back a parsed object here would
 * invite verifying one thing and using another.
 */
export function open(env, publicKey) {
    if (!env || typeof env !== 'object') return { ok: false, reason: 'NOT_AN_ENVELOPE' };
    if (typeof env.data !== 'string')    return { ok: false, reason: 'NO_DATA' };
    if (!env.signature)                  return { ok: false, reason: 'NO_SIGNATURE' };

    let bytes;
    try { bytes = Buffer.from(env.data, 'base64'); }
    catch { return { ok: false, reason: 'DATA_NOT_BASE64' }; }

    // Buffer.from is lenient with base64 — it drops invalid characters rather
    // than failing — so a corrupted field yields SHORTER bytes instead of an
    // error. The signature check below is what actually catches that, which is
    // the correct order: never trust the encoding step to validate content.
    if (!verifySignature(bytes, env.signature, publicKey)) {
        return { ok: false, reason: 'BAD_SIGNATURE' };
    }
    return { ok: true, bytes, text: bytes.toString('utf8') };
}

// ── identity ────────────────────────────────────────────────────────────────

/**
 * The MRN a certificate claims, from its subjectAltName URI entry.
 *
 * MCP puts a maritime identity there rather than in the CN, because a CN is a
 * display string with no structure and every registry disagrees about what goes
 * in it. Returns null when absent — an unnamed peer is not an error at this
 * layer, it is a fact the caller has to decide about.
 */
export function mrnFromCert(certPem) {
    try {
        const c = certPem instanceof X509Certificate ? certPem : new X509Certificate(certPem);
        const san = c.subjectAltName || '';
        const m = /URI:(urn:mrn:[^\s,]+)/i.exec(san);
        return m ? m[1] : null;
    } catch {
        return null;
    }
}

/** The public key of a PEM certificate, for verifying what its holder signed. */
export function publicKeyOf(certPem) {
    const c = certPem instanceof X509Certificate ? certPem : new X509Certificate(certPem);
    return c.publicKey;
}

// ── SECOM-ish response shapes ───────────────────────────────────────────────

/**
 * SECOM acknowledgements distinguish DELIVERED from OPENED. That is not
 * bookkeeping: for a shore centre, "the ship received your route" and "the
 * bridge opened it" are different operational facts, and collapsing them lets a
 * centre believe a plan was seen when it was only stored.
 */
export const ACK_TYPE = {
    DELIVERED: 'DELIVERED_ACK',
    OPENED:    'OPENED_ACK',
    ERROR:     'ERROR_ACK',
};

export const RESPONSE = {
    ok:      (body = {}) => ({ SECOM_ResponseCode: 0, ...body }),
    error:   (code, message) => ({ SECOM_ResponseCode: code, message }),
};
