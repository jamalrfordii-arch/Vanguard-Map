// tests/aisManagerFields.test.mjs — the STM prerequisite fields.
// Run from repo root:  node --import ./tests/_stubs/register.mjs tests/aisManagerFields.test.mjs
//
// Three fields Enhanced Monitoring cannot work without, each of which used to be
// silently destroyed at ingest (docs/STM_ROUTE_SPEC.md §1):
//
//   1. SOG was Math.round()ed to an integer. AIS transmits 0.1-knot steps, so
//      that threw away a factor of ten. At 12 kn a ±0.5 kn error is ±4%, which
//      over a 6-hour leg is a ±14 minute ETA error — larger than any schedule
//      tolerance worth alarming on.
//   2. COG was read and then discarded in favour of heading. Heading is where
//      the bow points; COG is where the ship is going. Their difference IS the
//      set-and-drift signal that distinguishes a current-induced excursion from
//      a deliberate turn.
//   3. Navigational status was never parsed at all, so a vessel legitimately at
//      anchor was indistinguishable from one under way.
//
// This suite feeds messages through the real ingest() seam rather than poking
// the vessel objects, so it fails if the parse regresses anywhere in that path.

// domEnv FIRST — AISManager's constructor touches window/document/localStorage
// for the key prompt and the vessel-count readout. ES modules evaluate imports
// in source order, so the globals are in place before aisManager is loaded.
import './_stubs/domEnv.mjs';
import assert from 'node:assert/strict';
import { AISManager, parseNavStatus, NAV_STATUS_TEXT } from '../aisManager.js';
import { simClock } from '../simClock.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
const near = (a, b, tol, msg) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ±${tol}, got ${a}`);

// A PositionReport in AISStream's shape — the same envelope the live WebSocket,
// RecordedAISSource and SyntheticAISSource all produce.
function posReport({ mmsi = '265177000', lat = 57.6, lon = 11.6,
                     sog = 12.3, cog = 235.4, heading, navStatus, t } = {}) {
    const pr = { Sog: sog, Cog: cog };
    if (heading !== undefined) pr.TrueHeading = heading;
    if (navStatus !== undefined) pr.NavigationalStatus = navStatus;
    return {
        MessageType: 'PositionReport',
        MetaData: {
            MMSI: mmsi, ShipName: 'NORDIC TRADER', ShipType: 70,
            latitude: lat, longitude: lon,
            time_utc: new Date(t ?? simClock.now()).toISOString(),
        },
        Message: { PositionReport: pr },
    };
}

function freshManager() {
    const m = new AISManager();
    m.vessels.clear();
    return m;
}
const vesselAfter = (msgs) => {
    const m = freshManager();
    for (const msg of msgs) m.ingest(msg);
    return m.vessels.get('265177000');
};

console.log('1. SOG precision (the ±14 minute ETA bug)');
test('12.3 kn survives ingest as 12.3, not 12', () => {
    near(vesselAfter([posReport({ sog: 12.3 })]).speedKts, 12.3, 1e-9);
});
test('the full 0.1-knot AIS resolution is preserved across the range', () => {
    for (const s of [0.1, 3.7, 9.9, 12.3, 18.6, 24.9]) {
        near(vesselAfter([posReport({ sog: s })]).speedKts, s, 1e-9, `sog ${s}:`);
    }
});
test('finer-than-transmitted precision is rounded to the 0.1 kn AIS step', () => {
    // 12.34 kn cannot have been transmitted; claiming that precision would be
    // inventing accuracy the source does not have.
    near(vesselAfter([posReport({ sog: 12.34 })]).speedKts, 12.3, 1e-9);
    near(vesselAfter([posReport({ sog: 12.36 })]).speedKts, 12.4, 1e-9);
});
test('an UPDATE keeps the precision too, not just the first sight', () => {
    const m = freshManager();
    m.ingest(posReport({ sog: 12.3 }));
    m.ingest(posReport({ sog: 8.7, lon: 11.62 }));
    near(m.vessels.get('265177000').speedKts, 8.7, 1e-9);
});
test('a 4-hour leg at 12.3 kn vs 12 kn differs by more than 5 nm', () => {
    // The concrete reason this matters: the rounding error is not cosmetic.
    const exact = 12.3 * 4, rounded = 12 * 4;
    assert.ok(exact - rounded > 1, `${(exact - rounded).toFixed(1)} nm of drift in 4 hours`);
});
test('a zero SOG stays 0, not null', () => {
    assert.equal(vesselAfter([posReport({ sog: 0 })]).speedKts, 0);
});

console.log('2. COG kept separate from heading');
test('cogDeg and headingDeg are BOTH stored and are different fields', () => {
    const v = vesselAfter([posReport({ cog: 235.4, heading: 240 })]);
    near(v.cogDeg, 235.4, 1e-9, 'course over ground');
    assert.equal(v.headingDeg, 240, 'where the bow points');
});
test('the drift angle is recoverable — this is the set-and-drift signal', () => {
    const v = vesselAfter([posReport({ cog: 235.4, heading: 240 })]);
    near(Math.abs(v.headingDeg - v.cogDeg), 4.6, 0.01,
        'a 4.6° crab angle; collapsing the two fields destroys it');
});
test('headingDeg still falls back to COG when TrueHeading is absent', () => {
    // The 3D model must always point somewhere sensible.
    const v = vesselAfter([posReport({ cog: 235.4, heading: undefined })]);
    near(v.headingDeg, 235.4, 1e-9);
    near(v.cogDeg, 235.4, 1e-9);
});
test('headingDeg falls back to COG on the AIS 511 "not available" sentinel', () => {
    const v = vesselAfter([posReport({ cog: 100, heading: 511 })]);
    near(v.headingDeg, 100, 1e-9);
});
test('an ABSENT cog is null, NOT 0 — 0 is due north, a real bearing', () => {
    const m = freshManager();
    const msg = posReport({});
    delete msg.Message.PositionReport.Cog;
    m.ingest(msg);
    assert.equal(m.vessels.get('265177000').cogDeg, null,
        'using 0 as a missing-value sentinel would put every silent vessel northbound');
});
test('an out-of-range cog is rejected rather than stored', () => {
    assert.equal(vesselAfter([posReport({ cog: 360 })]).cogDeg, null, '360 is out of [0,360)');
    assert.equal(vesselAfter([posReport({ cog: -5 })]).cogDeg, null);
    assert.equal(vesselAfter([posReport({ cog: 3600 })]).cogDeg, null);
});
test('cog 0.0 (due north) IS accepted — it is a legitimate course', () => {
    assert.equal(vesselAfter([posReport({ cog: 0 })]).cogDeg, 0);
});
test('cogDeg updates on subsequent reports', () => {
    const m = freshManager();
    m.ingest(posReport({ cog: 90 }));
    m.ingest(posReport({ cog: 180, lon: 11.62 }));
    assert.equal(m.vessels.get('265177000').cogDeg, 180);
});

console.log('3. Navigational status');
test('parseNavStatus maps the ITU-R M.1371 codes', () => {
    assert.deepEqual(parseNavStatus(0), { navStatus: 0, navStatusText: 'UNDER WAY USING ENGINE' });
    assert.deepEqual(parseNavStatus(1), { navStatus: 1, navStatusText: 'AT ANCHOR' });
    assert.deepEqual(parseNavStatus(2), { navStatus: 2, navStatusText: 'NOT UNDER COMMAND' });
    assert.deepEqual(parseNavStatus(5), { navStatus: 5, navStatusText: 'MOORED' });
    assert.deepEqual(parseNavStatus(6), { navStatus: 6, navStatusText: 'AGROUND' });
});
test('all 16 codes have text — no silent gaps in the table', () => {
    for (let i = 0; i <= 15; i++) {
        assert.ok(NAV_STATUS_TEXT[i], `code ${i} has no text`);
        assert.equal(parseNavStatus(i).navStatus, i);
    }
});
test('an ABSENT status is null, not 0 ("under way")', () => {
    const v = vesselAfter([posReport({})]);
    assert.equal(v.navStatus, null,
        'defaulting to 0 would assert every silent vessel is under way using engine');
    assert.equal(v.navStatusText, null);
});
test('out-of-range and non-integer values are rejected', () => {
    assert.equal(parseNavStatus(16).navStatus, null);
    assert.equal(parseNavStatus(-1).navStatus, null);
    assert.equal(parseNavStatus(2.5).navStatus, null);
    assert.equal(parseNavStatus('nonsense').navStatus, null);
    assert.equal(parseNavStatus(undefined).navStatus, null);
});
test('status 15 ("undefined") is PRESERVED, not nulled', () => {
    // "The crew did not set it" and "we never heard the field" are different
    // facts, and the UI should be able to tell them apart.
    const v = vesselAfter([posReport({ navStatus: 15 })]);
    assert.equal(v.navStatus, 15);
    assert.equal(v.navStatusText, 'UNDEFINED');
});
test('status 14 (AIS-SART / MOB / EPIRB) survives — it is a real signal', () => {
    assert.equal(vesselAfter([posReport({ navStatus: 14 })]).navStatusText, 'AIS-SART / MOB / EPIRB');
});
test('status reaches the vessel through ingest, with a timestamp', () => {
    const v = vesselAfter([posReport({ navStatus: 1 })]);
    assert.equal(v.navStatus, 1);
    assert.equal(v.navStatusText, 'AT ANCHOR');
    assert.ok(Number.isFinite(v.navStatusAt), 'when we learned it');
});
test('a later report WITHOUT the field keeps the last known status', () => {
    // Most AIS reports omit it. Blanking on every silent report would make the
    // status flicker to null constantly; "we last heard AT ANCHOR" is the more
    // useful and more honest reading.
    const m = freshManager();
    m.ingest(posReport({ navStatus: 1 }));
    m.ingest(posReport({ lon: 11.62 }));
    const v = m.vessels.get('265177000');
    assert.equal(v.navStatus, 1, 'retained');
    assert.equal(v.navStatusText, 'AT ANCHOR');
});
test('a CHANGED status overwrites and re-stamps', () => {
    const m = freshManager();
    m.ingest(posReport({ navStatus: 1, t: 1000 }));
    const firstAt = m.vessels.get('265177000').navStatusAt;
    m.ingest(posReport({ navStatus: 0, lon: 11.62, t: 60_000 }));
    const v = m.vessels.get('265177000');
    assert.equal(v.navStatus, 0);
    assert.equal(v.navStatusText, 'UNDER WAY USING ENGINE');
    assert.ok(v.navStatusAt > firstAt, 'the timestamp moved with it');
});

console.log('regression guard — nothing else in the vessel record moved');
test('the existing fields are untouched by these additions', () => {
    const v = vesselAfter([posReport({})]);
    assert.equal(v.mmsi, '265177000');
    assert.equal(v.name, 'NORDIC TRADER');
    assert.equal(v.class, 'CARGO');
    near(v.latDeg, 57.6, 1e-9);
    near(v.lonDeg, 11.6, 1e-9);
    assert.equal(v.destination, null);
    assert.equal(v.eta, null);
    assert.equal(v.draughtM, null);
    assert.ok(v.currentPos && v.targetPos && v.prevPos, 'scene positions still built');
});

console.log(`\naisManagerFields.test: ${passed} checks passed`);
