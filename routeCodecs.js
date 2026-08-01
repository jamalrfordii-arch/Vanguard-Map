// routeCodecs.js — the format registry. The ONLY module that may import a codec.
//
// STM_ROUTE_SPEC §4.2: "If S-421 GML types are visible anywhere outside
// s421Codec.js, the uplift becomes a refactor of the entire subsystem instead of
// one file." voyagePlan.js took the first half of that (what a plan MEANS lives
// away from any format). This file takes the second: choosing WHICH format a
// document is, so nothing upstream has to know that more than one exists.
//
// Before this, stmPanel imported `parse as parseRtz` and hard-coded the strings
// "RTZ" and ".rtz / .rtzp / .xml" into text an operator reads. Adding a second
// format that way means editing the UI, and — worse — an operator dropping a
// valid S-421 file would be told it was "not a usable RTZ document", which is
// both wrong and actively misleading about why it failed.
//
// ── SNIFFING, AND WHY IT IS NOT A DOM PARSE ─────────────────────────────────
//
// Detection reads the root element tag out of the raw text rather than parsing
// the document twice. Two reasons, in order of importance:
//
//   1. A document we cannot parse still has to produce a good REPORT. If sniffing
//      required a successful DOM parse, a truncated or malformed file would fail
//      before we knew what it was trying to be, and the operator would get
//      "unrecognised" for a file that is obviously an RTZ route with a missing
//      closing tag. Knowing the intended format is what lets the codec explain
//      the failure in that format's own terms.
//   2. Parsing megabyte GML twice to decide who should parse it is waste.
//
// The scan is bounded and deliberately dumb: find the first element tag, take its
// local name and any namespace declared on it. It is not a parser and must never
// grow into one — anything subtler than "which codec gets this" belongs in the
// codec, where a real DOM is available.

import * as rtz from './rtzCodec.js';
import * as s421 from './s421Codec.js';

// How many characters of the head to scan for the root element. Generous enough
// for an XML declaration, a licence comment block and a root tag carrying a
// dozen namespace declarations; small enough that it costs nothing on a large
// document.
const SNIFF_CHARS = 4096;

/**
 * A codec descriptor.
 *
 *   id          stable key, used in reports and in the plan's sourceFormat
 *   label       what the operator sees
 *   extensions  offered in the drag-drop hint; lowercase, no dot
 *   roots       root element LOCAL names this format uses
 *   nsMatch     substring that must appear in the root tag's namespaces, or null
 *   parse       (xmlString, opts) → { plan, report }
 *   serialise   (plan, opts) → xmlString   — optional
 *   provisional true when the implementation has never been checked against a
 *               real document from a real system. Surfaced to the operator.
 */
export const CODECS = [
    {
        id: 'RTZ',
        label: 'RTZ',
        extensions: ['rtz', 'rtzp', 'xml'],
        roots: ['route', 'routes'],
        nsMatch: 'cirm.org/RTZ',
        parse: rtz.parse,
        serialise: rtz.serialise,
        provisional: false,
    },
    {
        id: 'S421',
        label: 'S-421',
        extensions: ['gml', 's421', 'xml'],
        // NOT 'route'. RTZ owns that root name, and a bare <Route> with no
        // namespace is far more likely to be RTZ than S-421 in this codebase's
        // lifetime. An S-421 document that DOES declare its namespace is caught
        // by nsMatch, which is checked first — so the only documents this misses
        // are namespace-less S-421 files, which are not valid S-100 anyway.
        roots: ['dataset', 'routeplan', 's421_route'],
        nsMatch: 'S421',
        parse: s421.parse,
        serialise: s421.serialise,
        // Its element NAMES are inferred from the published model, not read from
        // the XSD — see the header of s421Codec.js. Everything parsed by it is
        // flagged so the operator is never shown an S-421 import that looks as
        // trustworthy as an RTZ one.
        provisional: true,
    },
];

/** Register a codec at runtime. Returns the registry, for chaining in tests. */
export function register(codec) {
    const i = CODECS.findIndex(c => c.id === codec.id);
    if (i === -1) CODECS.push(codec); else CODECS[i] = codec;
    return CODECS;
}

export function codecById(id) {
    return CODECS.find(c => c.id === id) ?? null;
}

/**
 * Root element local name + declared namespaces, from raw text.
 * @returns {{root: string, ns: string}|null}
 */
export function rootTagOf(xmlString) {
    if (typeof xmlString !== 'string') return null;
    let head = xmlString.slice(0, SNIFF_CHARS);
    head = head.replace(/<\?[\s\S]*?\?>/g, '')      // XML declaration, PIs
               .replace(/<!--[\s\S]*?-->/g, '')     // comments
               .replace(/<!DOCTYPE[^>]*>/gi, '');
    // First element tag. The trailing \/? matters: <route/> is a valid, minimal
    // document and the first version of this regex required a '>' immediately
    // after the attributes, so a self-closing root returned null and the file was
    // reported as "no XML element found". Caught by tests/routeCodecs.test.mjs.
    const m = /<\s*(?:([\w.-]+):)?([\w.-]+)((?:\s[^>]*?)?)\s*\/?>/.exec(head);
    if (!m) return null;
    return { root: m[2], ns: m[3] ?? '' };
}

/**
 * Which codec should handle this document, or null.
 *
 * Namespace wins over root name. A document declaring the RTZ namespace is RTZ
 * even if someone renamed the root; a bare <route> with no namespace is still
 * offered to RTZ, because real files in the wild omit the declaration and
 * rejecting them would be pedantry with no safety benefit — rtzCodec is already
 * lenient on read for exactly this reason.
 */
export function sniff(xmlString) {
    const t = rootTagOf(xmlString);
    if (!t) return null;
    const byNs = CODECS.find(c => c.nsMatch && t.ns.includes(c.nsMatch));
    if (byNs) return byNs;
    return CODECS.find(c => c.roots.includes(t.root.toLowerCase())) ?? null;
}

/**
 * Parse a document with whichever codec claims it.
 *
 * @returns {{plan: object|null, report: object, format: string|null}}
 *
 * An unrecognised document gets a report in the same shape a codec would
 * produce, so every caller has exactly one failure path to handle. The warning
 * names what was actually found — "root is <foo>" — because "unsupported file"
 * tells an operator nothing they can act on.
 */
export function parseAny(xmlString, opts = {}) {
    const codec = sniff(xmlString);
    if (!codec) {
        const t = rootTagOf(xmlString);
        return {
            plan: null,
            format: null,
            report: {
                ok: false,
                warnings: [{
                    code: 'UNRECOGNISED_ROUTE_FORMAT',
                    detail: t ? `root is <${t.root}> — expected ${expectedRootsText()}`
                              : 'no XML element found in the file',
                }],
                droppedElements: [],
            },
        };
    }
    const { plan, report } = codec.parse(xmlString, opts);
    // Stamp provenance here rather than in each codec: it is the registry that
    // knows which codec ran, and a codec should not have to remember to label
    // its own output. sourceVersion stays whatever the CODEC read from the
    // document — the registry never invents or normalises it.
    if (plan) {
        plan.sourceFormat = plan.sourceFormat ?? codec.id;
        if (codec.provisional) plan.provisionalCodec = true;
    }
    return { plan, report, format: codec.id };
}

/** Every extension any registered codec accepts, deduplicated. */
export function acceptedExtensions() {
    return [...new Set(CODECS.flatMap(c => c.extensions))];
}

/** ".rtz / .rtzp / .xml" — for the drag-drop hint. Built, never written down. */
export function acceptedExtensionsText() {
    return acceptedExtensions().map(e => '.' + e).join(' / ');
}

/** "RTZ" or "RTZ / S-421" — for the drop target and rejection messages. */
export function formatsText() {
    return CODECS.map(c => c.label).join(' / ');
}

function expectedRootsText() {
    return [...new Set(CODECS.flatMap(c => c.roots))].map(r => `<${r}>`).join(' or ');
}

/** True for filenames worth offering to the registry. */
export function isRouteFile(name) {
    const s = String(name ?? '');
    const dot = s.lastIndexOf('.');
    if (dot <= 0) return false;
    return acceptedExtensions().includes(s.slice(dot + 1).toLowerCase());
}

/** Codecs that have never been validated against a real document. */
export function provisionalCodecs() {
    return CODECS.filter(c => c.provisional).map(c => c.label);
}

// ── Debug handle (Tier 3 — DevTools only, never the data path) ───────────────
if (typeof window !== 'undefined') {
    window.vg1RouteCodecs = { CODECS, sniff, parseAny, rootTagOf, acceptedExtensions };
}
