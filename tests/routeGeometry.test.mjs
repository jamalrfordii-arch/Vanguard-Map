// tests/routeGeometry.test.mjs — geodesy for STM route plans.
// Run from repo root:  node tests/routeGeometry.test.mjs
// Pure node, no browser, no THREE.
//
// The point of this suite is NOT to confirm the formulas run. It is to prove the
// two things that would silently produce wrong monitoring verdicts:
//   (1) rhumb and great-circle cross-track are genuinely DIFFERENT, so using the
//       wrong one against a declared geometryType is a real error, not pedantry;
//   (2) leg assignment survives a route that doubles back on itself, which is
//       where "nearest leg" quietly fails.

import assert from 'node:assert/strict';
import {
    rhumbDistanceNm, rhumbBearingDeg, rhumbDestination,
    gcDistanceNm, gcCrossTrackNm, gcAlongTrackNm, gcInterpolate,
    rhumbCrossTrackNm, rhumbAlongTrackNm,
    crossTrackNm, alongTrackNm, legLengthNm, tessellateLeg,
    measureLeg, projectOntoRoute, bearingDeltaDeg, normaliseBearing,
} from '../routeGeometry.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
const near = (a, b, tol, msg) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ±${tol}, got ${a}`);

const wp = (id, lat, lon, leg = null) => ({ id, lat, lon, leg, name: `WP${id}`, radius: null });

console.log('bearing helpers');
test('normaliseBearing wraps into [0,360)', () => {
    assert.equal(normaliseBearing(370), 10);
    assert.equal(normaliseBearing(-10), 350);
    assert.equal(normaliseBearing(360), 0);
});
test('bearingDeltaDeg takes the short way round 359 vs 001', () => {
    assert.equal(bearingDeltaDeg(359, 1), 2);
    assert.equal(bearingDeltaDeg(1, 359), 2);
    assert.equal(bearingDeltaDeg(0, 180), 180);
});

console.log('rhumb line — known values');
test('1° of latitude along a meridian is 60 nm', () =>
    near(rhumbDistanceNm(0, 0, 1, 0), 60, 0.2));
test('1° of longitude at the equator is 60 nm', () =>
    near(rhumbDistanceNm(0, 0, 0, 1), 60, 0.2));
test('1° of longitude at 60°N is 30 nm (cos 60° = 0.5)', () =>
    near(rhumbDistanceNm(60, 0, 60, 1), 30, 0.2));
test('due-north leg bears 000, due-east bears 090', () => {
    near(rhumbBearingDeg(0, 0, 1, 0), 0, 0.01);
    near(rhumbBearingDeg(0, 0, 0, 1), 90, 0.01);
    near(rhumbBearingDeg(0, 0, -1, 0), 180, 0.01);
    near(rhumbBearingDeg(0, 0, 0, -1), 270, 0.01);
});
test('rhumbDestination round-trips against rhumbDistance/Bearing', () => {
    const from = { lat: 57.6, lon: 11.6 };            // Gothenburg approaches
    const to = rhumbDestination(from.lat, from.lon, 235, 180);
    near(rhumbDistanceNm(from.lat, from.lon, to.lat, to.lon), 180, 0.5, 'distance');
    near(rhumbBearingDeg(from.lat, from.lon, to.lat, to.lon), 235, 0.1, 'bearing');
});
test('east-west rhumb at high latitude does not blow up (dPsi→0 branch)', () => {
    const d = rhumbDistanceNm(80, 0, 80, 10);
    near(d, 10 * 60 * Math.cos(80 * Math.PI / 180), 0.5);
});
test('rhumb across the antimeridian is short, not 359° long', () =>
    near(rhumbDistanceNm(0, 179.5, 0, -179.5), 60, 0.5));

console.log('great circle');
test('gc and rhumb agree on a short leg', () => {
    const g = gcDistanceNm(57.6, 11.6, 57.8, 11.9);
    const r = rhumbDistanceNm(57.6, 11.6, 57.8, 11.9);
    near(g, r, 0.05, 'short legs should be indistinguishable');
});
test('gc is SHORTER than rhumb on a long high-latitude east-west leg', () => {
    // 40° of longitude at 60°N: rhumb 1200.8 nm, great circle 1182.4 nm.
    // 18 nm of difference on a single leg — a real navigational quantity, not
    // a rounding artefact.
    const g = gcDistanceNm(60, -20, 60, 20);
    const r = rhumbDistanceNm(60, -20, 60, 20);
    assert.ok(g < r, `great circle ${g} should be shorter than rhumb ${r}`);
    assert.ok(r - g > 10, `difference should be material, got ${(r - g).toFixed(2)} nm`);
});
test('the gc/rhumb gap grows with leg length, and RELATIVELY with latitude', () => {
    const len = (lat, span) => rhumbDistanceNm(lat, -span, lat, span);
    const gap = (lat, span) => len(lat, span) - gcDistanceNm(lat, -span, lat, span);
    const rel = (lat, span) => gap(lat, span) / len(lat, span);

    assert.ok(gap(60, 20) > gap(60, 10), 'longer leg, bigger gap');
    assert.ok(gap(0, 20) < 0.01, 'on the equator a parallel IS a great circle');

    // Note the shape here, because the obvious guess is wrong: for a FIXED
    // angular span the ABSOLUTE gap peaks near 60° (18.4 nm) and then shrinks
    // (14.7 nm at 70°, 8.2 nm at 80°) — because the leg itself is getting
    // shorter faster than the divergence grows. What rises monotonically all
    // the way to the pole is the gap as a FRACTION of leg length: 0.5% at 30°,
    // 1.5% at 60°, 2.0% at 80°.
    assert.ok(gap(70, 20) < gap(60, 20), 'absolute gap peaks near 60° and falls');
    assert.ok(rel(30, 20) < rel(60, 20), 'relative gap rises with latitude');
    assert.ok(rel(60, 20) < rel(80, 20), '…and keeps rising toward the pole');
});
test('gcInterpolate endpoints are the endpoints', () => {
    const a = gcInterpolate(10, 20, 30, 40, 0);
    const b = gcInterpolate(10, 20, 30, 40, 1);
    near(a.lat, 10, 1e-6); near(a.lon, 20, 1e-6);
    near(b.lat, 30, 1e-6); near(b.lon, 40, 1e-6);
});
test('gc midpoint of an east-west leg bows POLEWARD of the rhumb line', () => {
    const mid = gcInterpolate(60, -10, 60, 10, 0.5);
    assert.ok(mid.lat > 60, `great circle should sag north of 60°N, got ${mid.lat}`);
});

console.log('cross-track — sign convention');
test('a point north of an eastbound leg is to PORT (negative)', () => {
    // Heading 090; north is on the left hand.
    const xt = rhumbCrossTrackNm(0.1, 5, 0, 0, 0, 10);
    assert.ok(xt < 0, `expected negative (port), got ${xt}`);
    near(Math.abs(xt), 6, 0.2, 'magnitude 0.1° = 6 nm');
});
test('a point south of an eastbound leg is to STARBOARD (positive)', () => {
    const xt = rhumbCrossTrackNm(-0.1, 5, 0, 0, 0, 10);
    assert.ok(xt > 0, `expected positive (starboard), got ${xt}`);
    near(xt, 6, 0.2);
});
test('great-circle cross-track uses the same sign convention', () => {
    assert.ok(gcCrossTrackNm(0.1, 5, 0, 0, 0, 10) < 0, 'north of eastbound = port');
    assert.ok(gcCrossTrackNm(-0.1, 5, 0, 0, 0, 10) > 0, 'south of eastbound = starboard');
});
test('a point exactly on the axis has ~zero cross-track, both geometries', () => {
    near(rhumbCrossTrackNm(0, 5, 0, 0, 0, 10), 0, 0.01);
    near(gcCrossTrackNm(0, 5, 0, 0, 0, 10), 0, 0.01);
});

console.log('THE ONE THAT MATTERS: rhumb ≠ great circle on a long leg');
test('a ship ON the rhumb line reads as MILES off the great circle', () => {
    // 500 nm-ish east-west leg at 60°N. Put the vessel exactly on the rhumb
    // line (the course it is actually steering if geometryType=Loxodrome).
    const A = { lat: 60, lon: -10 }, B = { lat: 60, lon: 10 };
    const P = { lat: 60, lon: 0 };                 // dead on the rhumb line

    const xtRhumb = Math.abs(rhumbCrossTrackNm(P.lat, P.lon, A.lat, A.lon, B.lat, B.lon));
    const xtGc    = Math.abs(gcCrossTrackNm(P.lat, P.lon, A.lat, A.lon, B.lat, B.lon));

    near(xtRhumb, 0, 0.05, 'on the rhumb line, rhumb cross-track is zero');
    assert.ok(xtGc > 2,
        `great-circle cross-track should be materially non-zero, got ${xtGc.toFixed(2)} nm`);
    // With a typical XTD of 0.2-0.5 nm this is the difference between "on track"
    // and a confirmed deviation alarm on a perfectly compliant ship.
    assert.ok(xtGc > 10 * 0.5, 'the error dwarfs a realistic XTD corridor');
});
test('dispatch honours the declared geometryType', () => {
    const A = { lat: 60, lon: -10 }, B = { lat: 60, lon: 10 }, P = { lat: 60, lon: 0 };
    const asLox = Math.abs(crossTrackNm(P.lat, P.lon, A.lat, A.lon, B.lat, B.lon, 'Loxodrome'));
    const asOrt = Math.abs(crossTrackNm(P.lat, P.lon, A.lat, A.lon, B.lat, B.lon, 'Orthodrome'));
    near(asLox, 0, 0.05);
    assert.ok(asOrt > 2);
});
test('missing geometryType defaults to Loxodrome (per RTZ)', () => {
    const A = { lat: 60, lon: -10 }, B = { lat: 60, lon: 10 }, P = { lat: 60, lon: 0 };
    near(Math.abs(crossTrackNm(P.lat, P.lon, A.lat, A.lon, B.lat, B.lon, undefined)), 0, 0.05);
    near(Math.abs(crossTrackNm(P.lat, P.lon, A.lat, A.lon, B.lat, B.lon, null)), 0, 0.05);
});
test('geometryType matching is case-insensitive', () => {
    const A = { lat: 60, lon: -10 }, B = { lat: 60, lon: 10 }, P = { lat: 60, lon: 0 };
    const lower = Math.abs(crossTrackNm(P.lat, P.lon, A.lat, A.lon, B.lat, B.lon, 'orthodrome'));
    const upper = Math.abs(crossTrackNm(P.lat, P.lon, A.lat, A.lon, B.lat, B.lon, 'ORTHODROME'));
    near(lower, upper, 1e-9);
});

console.log('along-track');
test('along-track is 0 at the leg start and the full length at the end', () => {
    near(rhumbAlongTrackNm(0, 0, 0, 0, 0, 10), 0, 0.01);
    near(rhumbAlongTrackNm(0, 10, 0, 0, 0, 10), 600, 0.5);
});
test('along-track is NEGATIVE behind the leg start (not clamped)', () =>
    assert.ok(rhumbAlongTrackNm(0, -1, 0, 0, 0, 10) < 0));
test('along-track EXCEEDS the leg length past the end (not clamped)', () =>
    assert.ok(rhumbAlongTrackNm(0, 11, 0, 0, 0, 10) > 600));
test('gc along-track recovers its sign behind the start', () =>
    assert.ok(gcAlongTrackNm(0, -1, 0, 0, 0, 10) < 0));
test('a point on the axis is not pushed off it by acos domain error', () => {
    // cos(d)/cos(xt) can drift a hair past 1.0 here; unguarded this returns NaN.
    const at = gcAlongTrackNm(0, 5, 0, 0, 0, 10);
    assert.ok(Number.isFinite(at), `expected finite, got ${at}`);
    near(at, 300, 1);
});

console.log('tessellation');
test('a loxodrome leg needs exactly 2 points (straight in Mercator)', () => {
    const pts = tessellateLeg(60, -10, 60, 10, 'Loxodrome', 25);
    assert.equal(pts.length, 2, 'no subdivision — this is the whole point');
});
test('an orthodrome leg subdivides and the middle bows off the chord', () => {
    const pts = tessellateLeg(60, -10, 60, 10, 'Orthodrome', 25);
    assert.ok(pts.length > 10, `expected many segments, got ${pts.length}`);
    assert.ok(pts[Math.floor(pts.length / 2)].lat > 60, 'midpoint bows poleward');
});
test('tessellation endpoints are exact', () => {
    const pts = tessellateLeg(10, 20, 30, 40, 'Orthodrome', 25);
    near(pts[0].lat, 10, 1e-6);
    near(pts[pts.length - 1].lat, 30, 1e-6);
});

console.log('measureLeg');
test('reports fraction, remaining and cross-track together', () => {
    const m = measureLeg(0.05, 5, wp(1, 0, 0), wp(2, 0, 10));
    near(m.legLengthNm, 600, 1);
    near(m.fraction, 0.5, 0.01);
    near(m.remainingNm, 300, 2);
    assert.ok(m.crossTrackNm < 0, 'north of an eastbound leg is port');
});

console.log('projectOntoRoute — leg progression');
const straight = { waypoints: [wp(1, 0, 0), wp(2, 0, 5), wp(3, 0, 10), wp(4, 0, 15)] };

test('a route with <2 waypoints returns nulls, not guesses', () => {
    const r = projectOntoRoute(0, 0, { waypoints: [wp(1, 0, 0)] });
    assert.equal(r.legIndex, null);
    assert.equal(r.crossTrackNm, null);
    assert.equal(r.method, 'no-route');
});
test('picks the correct leg with no hint', () => {
    const r = projectOntoRoute(0, 7.5, straight, null);
    assert.equal(r.legIndex, 1, 'lon 7.5 is on leg wp2→wp3');
});
test('distanceToEndNm accumulates the remaining legs', () => {
    const r = projectOntoRoute(0, 7.5, straight, null);
    near(r.distanceToEndNm, 7.5 * 60, 2, 'from lon 7.5 to lon 15 is 450 nm');
});
test('advances to the next leg when the ship passes a waypoint', () => {
    const r = projectOntoRoute(0, 12, straight, 1);   // hint says leg 1, ship is on leg 2
    assert.equal(r.legIndex, 2);
    assert.equal(r.method, 'progression');
});
test('advances across MULTIPLE legs if the ship jumped ahead', () => {
    const r = projectOntoRoute(0, 12, straight, 0);
    assert.equal(r.legIndex, 2);
});
test('steps back one leg when the ship is behind the hinted leg', () => {
    const r = projectOntoRoute(0, 2.5, straight, 1);
    assert.equal(r.legIndex, 0);
});
test('snap point lands on the route axis', () => {
    const r = projectOntoRoute(0.05, 7.5, straight, null);
    near(r.snapLat, 0, 0.001, 'snapped back onto the axis');
    near(r.snapLon, 7.5, 0.01);
});

console.log('THE OTHER ONE THAT MATTERS: a route that doubles back');
// Out east, then straight back west a hair to the north. Legs 0 and 2 are
// geometrically ~4 nm apart, so "nearest leg" flips between them.
const hairpin = {
    waypoints: [
        wp(1, 0.00, 0), wp(2, 0.00, 5),      // leg 0: eastbound
        wp(3, 0.07, 5),                       // leg 1: the turn (4.2 nm north)
        wp(4, 0.07, 0),                       // leg 2: westbound, parallel to leg 0
    ]
};
test('a ship on the outbound leg stays on the outbound leg', () => {
    const r = projectOntoRoute(0.005, 2.5, hairpin, 0);
    assert.equal(r.legIndex, 0, 'must not jump to the parallel return leg');
});
test('the same POSITION on the return leg resolves to the return leg', () => {
    // Nearly the same point, but the hint says the vessel has come around.
    const r = projectOntoRoute(0.065, 2.5, hairpin, 2);
    assert.equal(r.legIndex, 2, 'progression, not proximity, decides');
});
test('without a hint the two are genuinely ambiguous — which is the bug', () => {
    // Documents WHY the hint exists: a midpoint between the parallel legs
    // resolves by raw proximity and can land on either.
    const mid = projectOntoRoute(0.035, 2.5, hairpin, null);
    assert.ok(mid.legIndex === 0 || mid.legIndex === 2);
    assert.equal(mid.method, 'search');
});
test('a wildly wrong hint is rejected and falls back to search', () => {
    const r = projectOntoRoute(0, 2.5, straight, 3);   // hint out of range
    assert.equal(r.legIndex, 0);
    assert.equal(r.method, 'search');
});
test('a hint far off-axis is rejected and re-searched (corridor guard)', () => {
    // 120 nm off a 5 nm corridor. The hint is discarded, but the global search
    // still finds a leg whose perpendicular foot lands on the segment — so the
    // method is 'search', not 'off-route'. Deciding that 120 nm is a deviation
    // is the MONITOR's job (it compares against the leg's XTD); this function's
    // only job is to say which leg the measurement is against.
    const r = projectOntoRoute(2.0, 2.5, straight, 0, 5);
    assert.equal(r.method, 'search');
    assert.equal(r.legIndex, 0);
    assert.ok(Math.abs(r.crossTrackNm) > 100, 'the excursion is reported, not hidden');
});
test('a ship past the end of the route still returns a leg, flagged off-route', () => {
    const r = projectOntoRoute(0, 40, straight, null);
    assert.equal(r.legIndex, 2, 'clamps to the last leg');
    assert.equal(r.method, 'off-route');
    assert.ok(r.fraction > 1, 'fraction reports the overshoot rather than hiding it');
});
test('leg assignment never loops forever on a degenerate route', () => {
    const degenerate = { waypoints: [wp(1, 0, 0), wp(2, 0, 0), wp(3, 0, 0)] };
    assert.doesNotThrow(() => projectOntoRoute(0, 0, degenerate, 0));
});

console.log('mixed-geometry route');
test('legLengthNm honours per-leg geometryType', () => {
    const lox = legLengthNm(60, -10, 60, 10, 'Loxodrome');
    const ort = legLengthNm(60, -10, 60, 10, 'Orthodrome');
    assert.ok(ort < lox);
});
test('a route mixing both geometries measures each leg by its own type', () => {
    const mixed = {
        waypoints: [
            wp(1, 60, -10),
            wp(2, 60, 0, { geometryType: 'Loxodrome' }),
            wp(3, 60, 10, { geometryType: 'Orthodrome' }),
        ]
    };
    const onLox = projectOntoRoute(60, -5, mixed, 0);
    near(onLox.crossTrackNm, 0, 0.05, 'rhumb leg: a constant-latitude track is on axis');
    const onOrt = projectOntoRoute(60, 5, mixed, 1);
    assert.ok(Math.abs(onOrt.crossTrackNm) > 0.5,
        'gc leg: the same constant-latitude track is genuinely off the great circle');
});

console.log(`\nrouteGeometry.test: ${passed} checks passed`);
