// s421Codec.js — S-421 Route Plan (IEC 63173-1) ⇄ canonical VoyagePlan.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ PROVISIONAL. This codec has NEVER been run against a real S-421 document ║
// ║ produced by a real system. Read §"What is verified" before trusting it.  ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// ── WHAT IS VERIFIED, AND WHAT IS INFERRED ──────────────────────────────────
//
// VERIFIED — the GML geometry encoding. gml:Point/gml:pos, gml:posList and
// gml:LineString are GML 3.2.1, stable, and unambiguous. srsName and the
// axis-order rule that comes with it are likewise well defined. That machinery
// below is correct because the specification for it is public and settled.
//
// INFERRED — every S-421 element and attribute NAME in FEATURE_NAMES. These come
// from the S-421 route model as described in IEC 63173-1, which mirrors RTZ
// field for field. They are a best reading, not a transcription from the XSD:
//
//   · The IHO Product Specification Register was returning an empty table under
//     maintenance when this was written (2026-07-30).
//   · schemas.s100dev.net disallows automated retrieval.
//   · The IHO's own S-421 landing page carries no edition or date; its last
//     modification stamp is 2021.
//
// So the honest position is: the SHAPE is right, the SPELLING may not be.
//
// ── WHAT THIS FILE DOES ABOUT THAT ──────────────────────────────────────────
//
// It fails loudly and usefully. When the name table does not match a document,
// parse() does not just return "no waypoints" — it reports the element names it
// ACTUALLY FOUND, ranked by frequency. Hand one real S-421 file to this codec
// and its rejection message tells you exactly which entries in FEATURE_NAMES are
// wrong. That turns the first real document into a five-minute correction rather
// than a rewrite, which is the whole reason to ship an unverified parser instead
// of no parser.
//
// Every name lookup is namespace-agnostic and accepts several spellings, because
// the cost of being lenient here is zero and the cost of being strict is
// rejecting a valid file over a capital letter.
//
// ── EDITIONS ARE RECORDED, NEVER NORMALISED ─────────────────────────────────
//
// S-421 sits on some edition of S-100; the IHO's resource pages now describe
// Phase 1 product specifications as compliant to S-100 Ed. 5.2.0, while our own
// spec recorded S-421 against Ed. 4.0.0. Which edition a given document was
// written against is therefore a property OF THE DOCUMENT, and we read it out
// and keep it verbatim in `sourceVersion`. We never upgrade, downgrade or
// harmonise it. If two editions differ on geometry or CRS handling, a silently
// normalised plan is a monitoring threshold computed against the wrong
// reference — the same class of error as inferring XTD units.

import { ROUTE_STATUS_MONITORING } from './voyagePlan.js';

// ── namespaces ──────────────────────────────────────────────────────────────
export const GML_NS = 'http://www.opengis.net/gml/3.2';
// Matched as a SUBSTRING, deliberately. S-100 product namespaces carry the
// edition in the URI and we do not want to enumerate editions we cannot verify.
export const S421_NS_HINT = 'S421';

/**
 * S-421 local names, by role. FIRST MATCH WINS, so put the most likely spelling
 * first. Everything here is INFERRED — see the header.
 */
export const FEATURE_NAMES = {
    route:          ['Route', 'RoutePlan', 'S421_Route'],
    routeInfo:      ['RouteInfo', 'routeInfo', 'RoutePlanInfo'],
    waypointHolder: ['Waypoints', 'waypoints', 'RouteWaypoints'],
    waypoint:       ['Waypoint', 'waypoint', 'RouteWaypoint'],
    leg:            ['Leg', 'leg', 'RouteLeg', 'legInfo'],
    scheduleHolder: ['Schedules', 'schedules'],
    schedule:       ['Schedule', 'schedule', 'RouteSchedule'],
    scheduleManual: ['Manual', 'manual', 'RouteScheduleManual'],
    scheduleCalc:   ['Calculated', 'calculated', 'RouteScheduleCalculated'],
    scheduleElement:['ScheduleElement', 'scheduleElement', 'RouteScheduleElement'],
    actionPoint:    ['RouteActionPoint', 'ActionPoint', 'actionPoint'],
};

/** Attribute/child names carrying scalar values. Also inferred. */
export const FIELD_NAMES = {
    routeName:     ['routeName', 'name', 'routeIdentifier'],
    routeStatus:   ['routeStatus', 'status'],
    routeAuthor:   ['routeAuthor', 'author'],
    vesselName:    ['vesselName', 'shipName'],
    vesselMMSI:    ['vesselMMSI', 'mmsi', 'MMSI'],
    vesselIMO:     ['vesselIMO', 'imo', 'IMO'],
    waypointId:    ['id', 'waypointId', 'wptId'],
    waypointName:  ['name', 'waypointName'],
    radius:        ['radius', 'turnRadius', 'waypointRadius'],
    portsideXTD:   ['portsideXTD', 'portXTD', 'xtdPort'],
    starboardXTD:  ['starboardXTD', 'stbdXTD', 'xtdStarboard'],
    safetyDepth:   ['safetyDepth', 'legSafetyDepth'],
    speedMin:      ['speedMin', 'minimumSpeed'],
    speedMax:      ['speedMax', 'maximumSpeed'],
    geometryType:  ['geometryType', 'legGeometry'],
    etd:           ['etd', 'ETD', 'departureTime'],
    eta:           ['eta', 'ETA', 'arrivalTime'],
    elementWpId:   ['waypointId', 'waypointRef', 'wptId'],
};

// ── tiny DOM helpers, namespace-agnostic by local name ──────────────────────

const localName = (el) => el.localName || el.nodeName.replace(/^.*:/, '');

function* descendants(el) {
    const kids = el.childNodes || [];
    for (let i = 0; i < kids.length; i++) {
        const n = kids[i];
        if (n.nodeType !== 1) continue;
        yield n;
        yield* descendants(n);
    }
}

function childrenNamed(el, names) {
    const want = names.map(n => n.toLowerCase());
    const out = [];
    const kids = el.childNodes || [];
    for (let i = 0; i < kids.length; i++) {
        const n = kids[i];
        if (n.nodeType === 1 && want.includes(localName(n).toLowerCase())) out.push(n);
    }
    return out;
}

/** First descendant matching any of `names`, at any depth. */
function findNamed(el, names) {
    const want = names.map(n => n.toLowerCase());
    for (const n of descendants(el)) {
        if (want.includes(localName(n).toLowerCase())) return n;
    }
    return null;
}

/** All descendants matching any of `names`, at any depth, in document order. */
function findAllNamed(el, names) {
    const want = names.map(n => n.toLowerCase());
    const out = [];
    for (const n of descendants(el)) {
        if (want.includes(localName(n).toLowerCase())) out.push(n);
    }
    return out;
}

/**
 * A scalar, read from an attribute OR a child element of the same name.
 *
 * S-100 GML encodings put simple values in child elements where RTZ uses
 * attributes, and real exporters are inconsistent about it. Checking both costs
 * one extra lookup and removes a whole category of "parsed but everything is
 * null".
 */
function field(el, names) {
    if (!el) return null;
    for (const n of names) {
        if (el.getAttribute) {
            const v = el.getAttribute(n);
            if (v != null && v !== '') return v;
        }
    }
    const want = names.map(n => n.toLowerCase());
    const kids = el.childNodes || [];
    for (let i = 0; i < kids.length; i++) {
        const k = kids[i];
        if (k.nodeType === 1 && want.includes(localName(k).toLowerCase())) {
            const t = (k.textContent || '').trim();
            if (t !== '') return t;
        }
    }
    return null;
}

const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

// ── GML geometry — the part that is actually specified ──────────────────────

/**
 * Latitude/longitude out of a GML geometry element.
 *
 * AXIS ORDER IS THE TRAP. GML 3.2 with an EPSG URN CRS (`urn:ogc:def:crs:EPSG::4326`)
 * is LATITUDE FIRST. The same coordinates under `http://www.opengis.net/def/crs/OGC/1.3/CRS84`
 * are LONGITUDE first. Guessing wrong puts a ship in the wrong hemisphere, and
 * for the Kattegat — 57°N 11°E — both orderings produce a plausible-looking
 * position on the globe, so it will not announce itself.
 *
 * Default is lat-first: EPSG::4326 is what S-100 products use, and the CRS84
 * exception is explicit in the srsName when it applies.
 *
 * @returns {{lat: number, lon: number}|null}
 */
export function readPosition(geomEl) {
    if (!geomEl) return null;
    const posEl = findNamed(geomEl, ['pos', 'posList', 'coordinates'])
               ?? (localName(geomEl).toLowerCase() === 'pos' ? geomEl : null);
    if (!posEl) return null;
    const text = (posEl.textContent || '').trim();
    if (!text) return null;
    const parts = text.split(/[\s,]+/).map(Number).filter(Number.isFinite);
    if (parts.length < 2) return null;

    const srs = srsNameFor(posEl);
    const lonFirst = /CRS84|crs:OGC/i.test(srs || '');
    const [a, b] = parts;
    const lat = lonFirst ? b : a;
    const lon = lonFirst ? a : b;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon };
}

/** srsName from this element or the nearest ancestor that declares one. */
export function srsNameFor(el) {
    let n = el;
    while (n && n.getAttribute) {
        const s = n.getAttribute('srsName');
        if (s) return s;
        n = n.parentNode;
    }
    return null;
}

// ── report ──────────────────────────────────────────────────────────────────

const makeReport = () => ({
    ok: false, version: null, warnings: [], droppedElements: [], provisional: true,
});

/**
 * Element local names present in a document, most frequent first.
 * This is what makes a failed parse actionable instead of a shrug.
 */
export function elementCensus(root, limit = 14) {
    const counts = new Map();
    for (const n of descendants(root)) {
        const k = localName(n);
        counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([name, n]) => `${name}×${n}`);
}

// ── parse ───────────────────────────────────────────────────────────────────

/**
 * @param {string} xmlString
 * @param {{domParser?: DOMParser, origin?: string, receivedAt?: number}} opts
 * @returns {{plan: object|null, report: object}}
 */
export function parse(xmlString, opts = {}) {
    const report = makeReport();

    if (typeof xmlString !== 'string' || xmlString.trim() === '') {
        report.warnings.push({ code: 'EMPTY_INPUT', detail: 'No document supplied.' });
        return { plan: null, report };
    }
    const DP = opts.domParser ?? (typeof DOMParser !== 'undefined' ? new DOMParser() : null);
    if (!DP) {
        report.warnings.push({ code: 'NO_XML_PARSER', detail: 'No DOMParser available in this environment.' });
        return { plan: null, report };
    }

    let doc;
    try {
        doc = DP.parseFromString(xmlString, 'application/xml');
    } catch (e) {
        report.warnings.push({ code: 'XML_PARSE_ERROR', detail: String(e && e.message || e) });
        return { plan: null, report };
    }
    const perr = doc.getElementsByTagName('parsererror');
    if (perr && perr.length) {
        report.warnings.push({
            code: 'XML_PARSE_ERROR',
            detail: (perr[0].textContent || 'malformed XML').trim().slice(0, 300),
        });
        return { plan: null, report };
    }

    const root = doc.documentElement;
    if (!root) {
        report.warnings.push({ code: 'NOT_AN_S421_DOCUMENT', detail: 'No root element.' });
        return { plan: null, report };
    }

    // The declared edition, verbatim. Never parsed into parts, never compared,
    // never defaulted — see the header note on editions.
    report.version = root.getAttribute?.('productEdition')
                  ?? root.getAttribute?.('edition')
                  ?? root.getAttribute?.('version')
                  ?? null;
    const declaredNs = rootNamespaces(root);
    if (report.version == null) {
        report.warnings.push({
            code: 'S421_EDITION_UNDECLARED',
            detail: 'The document declares no product edition. Recorded as unknown rather than '
                  + 'assumed — thresholds are read as written, not reinterpreted.',
        });
    }

    // Find the route. It may BE the root, or be nested in a dataset wrapper.
    const routeEl = matchesAny(root, FEATURE_NAMES.route)
        ? root
        : findNamed(root, FEATURE_NAMES.route) ?? root;

    const wpEls = findAllNamed(routeEl, FEATURE_NAMES.waypoint);
    if (wpEls.length === 0) {
        // THE ACTIONABLE FAILURE. See the header: this message is how one real
        // document repairs FEATURE_NAMES.
        report.warnings.push({
            code: 'S421_NAMES_DID_NOT_MATCH',
            detail: 'No waypoint elements matched '
                  + FEATURE_NAMES.waypoint.map(n => `<${n}>`).join('/')
                  + '. This codec is PROVISIONAL — its element names are inferred from the '
                  + 'published model, not read from the XSD. Elements actually present: '
                  + elementCensus(root).join(', ')
                  + '. Correct FEATURE_NAMES in s421Codec.js to match.',
        });
        return { plan: null, report };
    }

    const infoEl = findNamed(routeEl, FEATURE_NAMES.routeInfo) ?? routeEl;
    const waypoints = [];
    for (const el of wpEls) {
        const wp = readWaypoint(el, report);
        if (wp) waypoints.push(wp); else report.droppedElements.push(describeDropped(el));
    }

    if (waypoints.length < 2) {
        report.warnings.push({
            code: 'INSUFFICIENT_WAYPOINTS',
            detail: `${waypoints.length} usable waypoint(s); a route needs at least 2.`,
        });
        return { plan: null, report };
    }

    const routeStatus = num(field(infoEl, FIELD_NAMES.routeStatus));
    const plan = {
        uvid: field(routeEl, ['uvid', 'id', 'routeId']) ?? null,
        routeName: field(infoEl, FIELD_NAMES.routeName),
        routeStatus,
        routeAuthor: field(infoEl, FIELD_NAMES.routeAuthor),
        vesselName: field(infoEl, FIELD_NAMES.vesselName),
        vesselMMSI: field(infoEl, FIELD_NAMES.vesselMMSI),
        vesselIMO:  field(infoEl, FIELD_NAMES.vesselIMO),
        mmsi: field(infoEl, FIELD_NAMES.vesselMMSI),
        waypoints,
        schedules: readSchedules(routeEl, report),
        sourceFormat:  'S421',
        sourceVersion: report.version,   // verbatim, or null. Never invented.
        sourceNamespace: declaredNs,
        sourceOrigin: opts.origin ?? 'file',
        receivedAt: opts.receivedAt ?? null,
        provisionalCodec: true,
        raw: xmlString,
    };

    if (routeStatus == null) {
        report.warnings.push({
            code: 'ROUTE_STATUS_ABSENT',
            detail: 'No routeStatus found. The plan is stored but will NOT be monitored — '
                  + `only status ${ROUTE_STATUS_MONITORING} is steered.`,
        });
    }

    report.ok = true;
    return { plan, report };
}

function matchesAny(el, names) {
    const l = localName(el).toLowerCase();
    return names.some(n => n.toLowerCase() === l);
}

function rootNamespaces(root) {
    const out = [];
    const attrs = root.attributes || [];
    for (let i = 0; i < attrs.length; i++) {
        const a = attrs[i];
        if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) out.push(a.value);
    }
    return out.join(' ') || null;
}

function describeDropped(el) {
    const id = (el.getAttribute && (el.getAttribute('id') || el.getAttribute('gml:id'))) || '?';
    return `waypoint id=${id} (no usable position)`;
}

function readWaypoint(el, report) {
    const pos = readPosition(el);
    if (!pos) return null;
    const legEl = findNamed(el, FEATURE_NAMES.leg);
    return {
        id: field(el, FIELD_NAMES.waypointId),
        name: field(el, FIELD_NAMES.waypointName),
        lat: pos.lat,
        lon: pos.lon,
        radiusNm: num(field(el, FIELD_NAMES.radius)),
        leg: legEl ? readLeg(legEl, report) : null,
    };
}

function readLeg(el) {
    // XTD stays null when undeclared. A default here would be a monitoring
    // threshold this system invented, reported as if the ship had declared it.
    return {
        portsideXTD:  num(field(el, FIELD_NAMES.portsideXTD)),
        starboardXTD: num(field(el, FIELD_NAMES.starboardXTD)),
        safetyDepth:  num(field(el, FIELD_NAMES.safetyDepth)),
        speedMin:     num(field(el, FIELD_NAMES.speedMin)),
        speedMax:     num(field(el, FIELD_NAMES.speedMax)),
        geometryType: field(el, FIELD_NAMES.geometryType),
    };
}

function readSchedules(routeEl, report) {
    const out = [];
    for (const schEl of findAllNamed(routeEl, FEATURE_NAMES.schedule)) {
        for (const [kind, names] of [['manual', FEATURE_NAMES.scheduleManual],
                                     ['calculated', FEATURE_NAMES.scheduleCalc]]) {
            for (const holder of childrenNamed(schEl, names)) {
                out.push({
                    kind,
                    name: field(schEl, ['name']) ?? null,
                    elements: findAllNamed(holder, FEATURE_NAMES.scheduleElement).map(e => ({
                        waypointId: field(e, FIELD_NAMES.elementWpId),
                        etd: field(e, FIELD_NAMES.etd),
                        eta: field(e, FIELD_NAMES.eta),
                    })),
                });
            }
        }
    }
    return out;
}

// ── serialise ───────────────────────────────────────────────────────────────

/**
 * Canonical VoyagePlan → S-421-shaped GML.
 *
 * HONESTY NOTE. Round-tripping through this pair proves our own model survives
 * the trip; it does NOT validate the mapping against the standard, because both
 * halves share the same inferred names. A green round-trip test here means
 * "internally consistent", never "standards compliant", and the test says so.
 *
 * Emits lat-first coordinates under the EPSG::4326 URN, which is the ordering
 * that URN implies.
 */
export function serialise(plan, opts = {}) {
    if (!plan) return '';
    const ind = (n) => '  '.repeat(n);
    const esc = (s) => String(s ?? '').replace(/[<>&"]/g, c =>
        ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    const attr = (k, v) => (v == null || v === '' ? '' : ` ${k}="${esc(v)}"`);
    const srs = opts.srsName ?? 'urn:ogc:def:crs:EPSG::4326';
    const out = [];

    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push(`<Route xmlns:gml="${GML_NS}"${attr('uvid', plan.uvid)}`
           + `${attr('productEdition', plan.sourceVersion)}>`);
    out.push(ind(1) + '<RouteInfo'
        + attr('routeName', plan.routeName)
        + attr('routeStatus', plan.routeStatus)
        + attr('routeAuthor', plan.routeAuthor)
        + attr('vesselName', plan.vesselName)
        + attr('vesselMMSI', plan.vesselMMSI ?? plan.mmsi)
        + attr('vesselIMO', plan.vesselIMO)
        + '/>');
    out.push(ind(1) + '<Waypoints>');
    for (const w of plan.waypoints ?? []) {
        out.push(ind(2) + '<Waypoint' + attr('id', w.id) + attr('name', w.name)
                        + attr('radius', w.radiusNm) + '>');
        out.push(ind(3) + `<gml:Point srsName="${srs}"><gml:pos>${w.lat} ${w.lon}</gml:pos></gml:Point>`);
        if (w.leg) {
            out.push(ind(3) + '<Leg'
                + attr('portsideXTD', w.leg.portsideXTD)
                + attr('starboardXTD', w.leg.starboardXTD)
                + attr('safetyDepth', w.leg.safetyDepth)
                + attr('speedMin', w.leg.speedMin)
                + attr('speedMax', w.leg.speedMax)
                + attr('geometryType', w.leg.geometryType)
                + '/>');
        }
        out.push(ind(2) + '</Waypoint>');
    }
    out.push(ind(1) + '</Waypoints>');
    for (const s of plan.schedules ?? []) {
        out.push(ind(1) + '<Schedule' + attr('name', s.name) + '>');
        out.push(ind(2) + `<${s.kind === 'manual' ? 'Manual' : 'Calculated'}>`);
        for (const e of s.elements ?? []) {
            out.push(ind(3) + '<ScheduleElement'
                + attr('waypointId', e.waypointId) + attr('etd', e.etd) + attr('eta', e.eta) + '/>');
        }
        out.push(ind(2) + `</${s.kind === 'manual' ? 'Manual' : 'Calculated'}>`);
        out.push(ind(1) + '</Schedule>');
    }
    out.push('</Route>');
    return out.join('\n');
}

// ── Debug handle (Tier 3 — DevTools only, never the data path) ──────────────
if (typeof window !== 'undefined') {
    window.vg1S421 = { parse, serialise, FEATURE_NAMES, FIELD_NAMES, readPosition, elementCensus };
}
