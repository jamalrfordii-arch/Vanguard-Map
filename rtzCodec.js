// rtzCodec.js — RTZ route plan ⇄ canonical VoyagePlan.
//
// RTZ is the route-plan exchange format normative in IEC 61174:2015 Ed.4
// Annex S ("Route plan format for export and import"). Three versions matter:
//
//   1.0  IEC 61174:2015 Annex S.  ns http://www.cirm.org/RTZ/1/0
//   1.1  STM Validation extension. ns http://www.cirm.org/RTZ/1/1 — adds
//        routeStatus and the voyage UVID inside <extensions>. This is what the
//        STM Voyage Information Service actually speaks.
//   1.2  IEC PAS 61174-1:2021. Adds test clauses; deliberately RETAINS the 1.0
//        schema unchanged so PAS conformance cannot break 61174:2015
//        conformance. Nothing to do here beyond accepting the version string.
//
// We READ all three and WRITE 1.1 by default.
//
// WHY A CANONICAL MODEL RATHER THAN "JUST KEEP THE XML"
// -----------------------------------------------------
// S-421 expresses the same route in S-100/GML instead of RTZ XML, and S-421
// v1.0.0 is pinned to S-100 Ed. 4.0.0 while Ed. 5.2.1 came into force
// 2026-01-01 — so that schema WILL move. Everything downstream (the monitor,
// the 3D layer) talks to the canonical model, and each wire format is confined
// to its own codec. When S-421 v1.1 lands it is one file, not a refactor.
//
// Canonical model shape: docs/STM_ROUTE_SPEC.md §4.1.
// Tests: node tests/rtzCodec.test.mjs

import { STM } from './config.js';

export const RTZ_NS = {
    '1.0': 'http://www.cirm.org/RTZ/1/0',
    '1.1': 'http://www.cirm.org/RTZ/1/1',
    '1.2': 'http://www.cirm.org/RTZ/1/2',
};

// ── STM routeStatus (RTZ 1.1 Guidelines v1.8 §routeStatusEnum) ───────────────
// 7 is the one Enhanced Monitoring keys on: it means the route is loaded in the
// ship's ECDIS and being steered. Monitoring a route at any other status is
// monitoring an intention nobody is executing.
export const ROUTE_STATUS = {
    1: 'ORIGINAL',
    2: 'PLANNED FOR VOYAGE',
    3: 'OPTIMIZED',
    4: 'CROSS CHECKED',
    5: 'SAFETY CHECKED',
    6: 'APPROVED',
    7: 'USED FOR MONITORING',
    8: 'INACTIVE',
};
export const ROUTE_STATUS_MONITORING = 7;

// ── tiny XML helpers ─────────────────────────────────────────────────────────
// Namespace-agnostic by local name. RTZ files in the wild are inconsistent about
// prefixes and about whether the default namespace is even declared, and a
// namespace-strict reader rejects real, otherwise-valid documents. Being lenient
// on READ and correct on WRITE is the right asymmetry.

function localName(el) {
    return el.localName || el.nodeName.replace(/^.*:/, '');
}

function childrenNamed(el, name) {
    if (!el) return [];
    const out = [];
    for (const c of el.childNodes || []) {
        if (c.nodeType === 1 && localName(c) === name) out.push(c);
    }
    return out;
}

function firstNamed(el, name) {
    return childrenNamed(el, name)[0] ?? null;
}

/** Attribute as a trimmed string, or null when absent/empty. */
function attrStr(el, name) {
    if (!el || !el.getAttribute) return null;
    const v = el.getAttribute(name);
    if (v == null) return null;
    const t = String(v).trim();
    return t === '' ? null : t;
}

/** Attribute as a finite number, or null. Never returns NaN or 0-for-missing. */
function attrNum(el, name) {
    const s = attrStr(el, name);
    if (s == null) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

function attrInt(el, name) {
    const n = attrNum(el, name);
    return n == null ? null : Math.trunc(n);
}

/** ISO 8601 → ms epoch, or null. Does not guess a timezone. */
function parseIso(s) {
    if (!s) return null;
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
}

/**
 * RTZ time-window attributes are "HH:MM" durations, not clock times.
 * `stay` is "dd.hh.mm". Both → milliseconds, or null.
 */
function parseHhMm(s) {
    if (!s) return null;
    const m = /^(\d{1,3}):(\d{1,2})$/.exec(String(s).trim());
    if (!m) return null;
    return (Number(m[1]) * 60 + Number(m[2])) * 60_000;
}

function parseStay(s) {
    if (!s) return null;
    const m = /^(\d{1,3})\.(\d{1,2})\.(\d{1,2})$/.exec(String(s).trim());
    if (!m) return parseHhMm(s);          // tolerate "HH:MM" in the stay slot
    return ((Number(m[1]) * 24 + Number(m[2])) * 60 + Number(m[3])) * 60_000;
}

function msToHhMm(ms) {
    if (ms == null) return null;
    const total = Math.round(ms / 60_000);
    const h = Math.floor(total / 60), mm = total % 60;
    return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function msToStay(ms) {
    if (ms == null) return null;
    const total = Math.round(ms / 60_000);
    const d = Math.floor(total / 1440), h = Math.floor((total % 1440) / 60), mm = total % 60;
    return `${String(d).padStart(2, '0')}.${String(h).padStart(2, '0')}.${String(mm).padStart(2, '0')}`;
}

function isoOrNull(ms) {
    return ms == null ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function xmlEscape(s) {
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Serialise an attribute only when the value is present. Never emits `=""`. */
function attr(name, value) {
    if (value == null || value === '') return '';
    return ` ${name}="${xmlEscape(value)}"`;
}

// ── XTD unit normalisation ───────────────────────────────────────────────────
/**
 * RTZ Annex S specifies XTD as a decimal 0.0-10.0 in NAUTICAL MILES. Several STM
 * documents describe the same attribute in METRES. Both appear in real files.
 *
 * A value of 200 is unambiguously metres (200 nm of corridor is absurd); a value
 * of 0.2 is unambiguously nautical miles. The threshold sits at the top of the
 * specified NM range, so anything above it can only be metres.
 *
 * The branch taken is RECORDED in the parse report and surfaced in the UI. This
 * is a guess, and a guess that silently changes a monitoring threshold by a
 * factor of 1852 is exactly the kind of thing that must announce itself.
 */
function normaliseXtd(raw, report) {
    if (raw == null) return null;
    if (raw > STM.XTD_UNIT_THRESHOLD) {
        report.xtdUnitInferred = 'M';
        if (!report.warnings.some(w => w.code === 'XTD_UNIT_INFERRED')) {
            report.warnings.push({
                code: 'XTD_UNIT_INFERRED',
                detail: `XTD value ${raw} exceeds the RTZ nautical-mile range (0-${STM.XTD_UNIT_THRESHOLD}); ` +
                        `read as metres and converted. Verify against the source document.`,
            });
        }
        return raw / 1852;
    }
    if (report.xtdUnitInferred == null) report.xtdUnitInferred = 'NM';
    return raw;
}

// ── parse ────────────────────────────────────────────────────────────────────

function makeReport() {
    return {
        ok: false, format: 'RTZ', version: null,
        warnings: [], droppedElements: [], xtdUnitInferred: null,
    };
}

function parseLeg(legEl, report) {
    if (!legEl) return null;
    return {
        geometryType:   attrStr(legEl, 'geometryType') ?? 'Loxodrome',
        portsideXTD:    normaliseXtd(attrNum(legEl, 'portsideXTD'), report),
        starboardXTD:   normaliseXtd(attrNum(legEl, 'starboardXTD'), report),
        safetyContour:  attrNum(legEl, 'safetyContour'),
        safetyDepth:    attrNum(legEl, 'safetyDepth'),
        speedMin:       attrNum(legEl, 'speedMin'),
        speedMax:       attrNum(legEl, 'speedMax'),
        draughtForward: attrNum(legEl, 'draughtForward'),
        draughtAft:     attrNum(legEl, 'draughtAft'),
        staticUKC:      attrNum(legEl, 'staticUKC'),
        dynamicUKC:     attrNum(legEl, 'dynamicUKC'),
        masthead:       attrNum(legEl, 'masthead'),
        note1:          attrStr(legEl, 'legNote1'),
        note2:          attrStr(legEl, 'legNote2'),
    };
}

function parseScheduleElements(container) {
    return childrenNamed(container, 'scheduleElement').map(se => ({
        waypointId:       attrInt(se, 'waypointId'),
        eta:              parseIso(attrStr(se, 'eta')),
        etd:              parseIso(attrStr(se, 'etd')),
        etaWindowBefore:  parseHhMm(attrStr(se, 'etaWindowBefore')),
        etaWindowAfter:   parseHhMm(attrStr(se, 'etaWindowAfter')),
        etdWindowBefore:  parseHhMm(attrStr(se, 'etdWindowBefore')),
        etdWindowAfter:   parseHhMm(attrStr(se, 'etdWindowAfter')),
        stay:             parseStay(attrStr(se, 'stay')),
        speed:            attrNum(se, 'speed'),
        speedWindow:      attrNum(se, 'speedWindow'),
    }));
}

/**
 * Parse an RTZ document.
 * @param {string} xmlString
 * @param {object} [opts] { domParser } — inject a DOMParser in Node tests
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

    // DOMParser reports malformed XML as a <parsererror> element rather than
    // throwing — check for it explicitly or garbage parses "successfully".
    const perr = doc.getElementsByTagName('parsererror');
    if (perr && perr.length) {
        report.warnings.push({
            code: 'XML_PARSE_ERROR',
            detail: (perr[0].textContent || 'malformed XML').trim().slice(0, 300),
        });
        return { plan: null, report };
    }

    const root = doc.documentElement;
    if (!root || localName(root).toLowerCase() !== 'route') {
        report.warnings.push({
            code: 'NOT_AN_RTZ_ROUTE',
            detail: `Root element is <${root ? localName(root) : 'none'}>, expected <route>.`,
        });
        return { plan: null, report };
    }

    report.version = attrStr(root, 'version') ?? '1.0';
    if (!Object.prototype.hasOwnProperty.call(RTZ_NS, report.version)) {
        report.warnings.push({
            code: 'UNKNOWN_RTZ_VERSION',
            detail: `version="${report.version}" is not one of 1.0/1.1/1.2; parsed leniently.`,
        });
    }

    const infoEl = firstNamed(root, 'routeInfo');
    const wpsEl  = firstNamed(root, 'waypoints');

    // ── waypoints ────────────────────────────────────────────────────────────
    // <defaultWaypoint> carries a <leg> whose attributes apply to any leg that
    // omits them. Ignoring it makes every default-driven route look as though it
    // declared no XTD at all — which would silently hand monitoring over to our
    // invented fallback on files that were perfectly explicit.
    const defaultLeg = parseLeg(firstNamed(firstNamed(wpsEl, 'defaultWaypoint'), 'leg'), report);

    const waypoints = [];
    for (const wpEl of childrenNamed(wpsEl, 'waypoint')) {
        const posEl = firstNamed(wpEl, 'position');
        const lat = attrNum(posEl, 'lat');
        const lon = attrNum(posEl, 'lon');
        const id  = attrInt(wpEl, 'id');

        if (lat == null || lon == null) {
            report.droppedElements.push(`waypoint id=${id ?? '?'} (missing or unparseable position)`);
            continue;
        }
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
            report.droppedElements.push(`waypoint id=${id ?? '?'} (position out of range: ${lat},${lon})`);
            continue;
        }

        const ownLeg = parseLeg(firstNamed(wpEl, 'leg'), report);
        // Merge, attribute by attribute: an explicit null on the waypoint's own
        // leg means "not stated", so the default fills it. A whole-object
        // fallback would be wrong — a leg that states only speedMax would lose
        // the default XTD.
        let leg = ownLeg;
        if (defaultLeg) {
            leg = { ...defaultLeg };
            if (ownLeg) for (const [k, v] of Object.entries(ownLeg)) if (v != null) leg[k] = v;
        }

        waypoints.push({
            id, revision: attrInt(wpEl, 'revision'),
            name: attrStr(wpEl, 'name'),
            lat, lon,
            radius: attrNum(wpEl, 'radius'),
            leg,
        });
    }

    if (waypoints.length < 2) {
        report.warnings.push({
            code: 'INSUFFICIENT_WAYPOINTS',
            detail: `${waypoints.length} usable waypoint(s); a route axis needs at least 2.`,
        });
    }

    // ── schedules ────────────────────────────────────────────────────────────
    const schedules = [];
    for (const schEl of childrenNamed(firstNamed(root, 'schedules'), 'schedule')) {
        const id = attrInt(schEl, 'id');
        const name = attrStr(schEl, 'name');
        for (const kind of ['manual', 'calculated']) {
            const sub = firstNamed(schEl, kind);
            if (!sub) continue;
            const elements = parseScheduleElements(sub);
            if (elements.length) schedules.push({ id, name, kind, elements });
        }
    }

    // ── STM extensions ───────────────────────────────────────────────────────
    // routeStatus and the UVID live in <extensions> in RTZ 1.1, but some
    // producers hoist them onto <routeInfo>. Check both; prefer routeInfo.
    let routeStatus = attrInt(infoEl, 'routeStatus');
    let uvid = attrStr(infoEl, 'vesselVoyage');

    for (const extEl of childrenNamed(firstNamed(root, 'extensions'), 'extension')) {
        routeStatus ??= attrInt(extEl, 'routeStatus');
        uvid ??= attrStr(extEl, 'vesselVoyage') ?? attrStr(extEl, 'uvid');
        for (const child of extEl.childNodes || []) {
            if (child.nodeType !== 1) continue;
            routeStatus ??= attrInt(child, 'routeStatus');
            uvid ??= attrStr(child, 'vesselVoyage') ?? attrStr(child, 'uvid');
        }
    }

    if (routeStatus != null && !ROUTE_STATUS[routeStatus]) {
        report.warnings.push({
            code: 'UNKNOWN_ROUTE_STATUS',
            detail: `routeStatus=${routeStatus} is outside the STM 1-8 enumeration.`,
        });
    }

    const mmsi = attrStr(infoEl, 'vesselMMSI');
    const plan = {
        uvid,
        mmsi: mmsi ? String(mmsi) : null,
        imo: attrStr(infoEl, 'vesselIMO'),
        vesselName: attrStr(infoEl, 'vesselName'),
        routeName: attrStr(infoEl, 'routeName'),
        routeStatus,
        routeAuthor: attrStr(infoEl, 'routeAuthor'),
        validFrom: parseIso(attrStr(infoEl, 'validityPeriodStart')),
        validTo:   parseIso(attrStr(infoEl, 'validityPeriodStop')),
        sourceFormat: `RTZ_${String(report.version).replace('.', '_')}`,
        sourceOrigin: opts.origin ?? 'file',
        receivedAt: opts.receivedAt ?? null,
        waypoints,
        schedules,
        parseReport: report,
        // The original bytes, kept verbatim. RTZ <extension> elements may carry
        // arbitrary vendor child nodes we do not model; re-exporting from the
        // canonical model alone would silently destroy them. Anything we send
        // back unmodified goes out as `raw`.
        raw: xmlString,
    };

    report.ok = waypoints.length >= 2;
    return { plan, report };
}

// ── serialise ────────────────────────────────────────────────────────────────

/**
 * Canonical VoyagePlan → RTZ XML.
 * @param {object} plan
 * @param {object} [opts] { version = '1.1', pretty = true }
 */
export function serialise(plan, opts = {}) {
    const version = opts.version ?? '1.1';
    const ns = RTZ_NS[version] ?? RTZ_NS['1.1'];
    const nl = opts.pretty === false ? '' : '\n';
    const ind = opts.pretty === false ? () => '' : (n) => '  '.repeat(n);

    const out = [];
    out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
    out.push(`<route version="${version}" xmlns="${ns}">`);

    // routeInfo
    out.push(ind(1) + '<routeInfo' +
        attr('routeName', plan.routeName ?? 'UNNAMED ROUTE') +
        attr('routeAuthor', plan.routeAuthor) +
        attr('routeStatus', plan.routeStatus) +
        attr('validityPeriodStart', isoOrNull(plan.validFrom)) +
        attr('validityPeriodStop', isoOrNull(plan.validTo)) +
        attr('vesselName', plan.vesselName) +
        attr('vesselMMSI', plan.mmsi) +
        attr('vesselIMO', plan.imo) +
        attr('vesselVoyage', plan.uvid) +
        '/>');

    // waypoints
    out.push(ind(1) + '<waypoints>');
    for (const wp of plan.waypoints ?? []) {
        out.push(ind(2) + '<waypoint' +
            attr('id', wp.id) + attr('revision', wp.revision) +
            attr('name', wp.name) + attr('radius', wp.radius) + '>');
        out.push(ind(3) + `<position lat="${wp.lat}" lon="${wp.lon}"/>`);
        if (wp.leg) {
            const L = wp.leg;
            out.push(ind(3) + '<leg' +
                attr('geometryType', L.geometryType) +
                attr('portsideXTD', L.portsideXTD) +
                attr('starboardXTD', L.starboardXTD) +
                attr('safetyContour', L.safetyContour) +
                attr('safetyDepth', L.safetyDepth) +
                attr('speedMin', L.speedMin) +
                attr('speedMax', L.speedMax) +
                attr('draughtForward', L.draughtForward) +
                attr('draughtAft', L.draughtAft) +
                attr('staticUKC', L.staticUKC) +
                attr('dynamicUKC', L.dynamicUKC) +
                attr('masthead', L.masthead) +
                attr('legNote1', L.note1) +
                attr('legNote2', L.note2) +
                '/>');
        }
        out.push(ind(2) + '</waypoint>');
    }
    out.push(ind(1) + '</waypoints>');

    // schedules — regroup canonical (id, kind) pairs back into one <schedule>
    // per id with <manual>/<calculated> children, which is RTZ's nesting.
    const byId = new Map();
    for (const s of plan.schedules ?? []) {
        const key = s.id ?? 1;
        if (!byId.has(key)) byId.set(key, { id: key, name: s.name, kinds: {} });
        byId.get(key).kinds[s.kind] = s.elements;
    }
    if (byId.size) {
        out.push(ind(1) + '<schedules>');
        for (const s of byId.values()) {
            out.push(ind(2) + '<schedule' + attr('id', s.id) + attr('name', s.name) + '>');
            for (const kind of ['manual', 'calculated']) {
                const els = s.kinds[kind];
                if (!els || !els.length) continue;
                out.push(ind(3) + `<${kind}>`);
                for (const e of els) {
                    out.push(ind(4) + '<scheduleElement' +
                        attr('waypointId', e.waypointId) +
                        attr('etd', isoOrNull(e.etd)) +
                        attr('etdWindowBefore', msToHhMm(e.etdWindowBefore)) +
                        attr('etdWindowAfter', msToHhMm(e.etdWindowAfter)) +
                        attr('eta', isoOrNull(e.eta)) +
                        attr('etaWindowBefore', msToHhMm(e.etaWindowBefore)) +
                        attr('etaWindowAfter', msToHhMm(e.etaWindowAfter)) +
                        attr('stay', msToStay(e.stay)) +
                        attr('speed', e.speed) +
                        attr('speedWindow', e.speedWindow) +
                        '/>');
                }
                out.push(ind(3) + `</${kind}>`);
            }
            out.push(ind(2) + '</schedule>');
        }
        out.push(ind(1) + '</schedules>');
    }

    // STM extension marker — only for 1.1, and only when there is STM content.
    if (version === '1.1' && (plan.routeStatus != null || plan.uvid)) {
        out.push(ind(1) + '<extensions>');
        out.push(ind(2) + '<extension manufacturer="STM" name="RouteInfoExtensionSTM" version="1.1"' +
            attr('routeStatus', plan.routeStatus) + attr('vesselVoyage', plan.uvid) + '/>');
        out.push(ind(1) + '</extensions>');
    }

    out.push('</route>');
    return out.join(nl);
}

// ── convenience ──────────────────────────────────────────────────────────────

/** True when this plan is the one the ship is actually steering. */
export function isMonitoring(plan) {
    return plan?.routeStatus === ROUTE_STATUS_MONITORING;
}

/**
 * The schedule Enhanced Monitoring should measure against.
 * Preference: manual (what the crew entered) over calculated (what a tool
 * produced). RTZ says only one schedule should be active at status 7; when a
 * file breaks that rule we take the first rather than merging, and say so.
 */
export function activeSchedule(plan) {
    const s = plan?.schedules ?? [];
    if (!s.length) return null;
    return s.find(x => x.kind === 'manual') ?? s[0];
}

/** Schedule element for a given waypoint id, or null. */
export function scheduleElementFor(plan, waypointId) {
    const sch = activeSchedule(plan);
    if (!sch) return null;
    return sch.elements.find(e => e.waypointId === waypointId) ?? null;
}

// ── Debug handle (Tier 3 — DevTools only, never the data path) ───────────────
if (typeof window !== 'undefined') {
    window.vg1Rtz = { parse, serialise, isMonitoring, activeSchedule, scheduleElementFor, ROUTE_STATUS };
}
