// hemisphericRule.js — the "wrong-way flight level" check. Pure: no THREE, no
// DOM, no fetch — unit-testable in plain node (sibling of invariants.js and
// conflictMath.js).
//
// ICAO hemispheric (a.k.a. semicircular) cruising rule, scoped here to the RVSM
// band (FL290–FL410) where VANGUARD's own doctrine applies it (see the deck notes
// in altitudeDeckManager.js). An aircraft ESTABLISHED at a cruise level should fly:
//   • ODD  flight levels (FL290/310/330/350/370/390/410) when EASTBOUND  (track 000–179°)
//   • EVEN flight levels (FL300/320/340/360/380/400)       when WESTBOUND (track 180–359°)
// 1,000 ft apart. A level that doesn't match the aircraft's heading is a
// "wrong-way" level.
//
// ADVISORY ONLY — an analyst indicator, never a verdict. Oceanic track systems,
// regional exceptions, strategic-lateral-offset, contingency/emergency descents,
// and explicit ATC clearances all legitimately break the rule. That's why the
// caller weights it lightly and only checks aircraft that are actually level
// (a climbing/descending aircraft is legitimately between levels).
//
// Returns null when the rule doesn't apply: no/invalid heading, outside the
// band, or not within `levelTolFt` of a whole flight level (i.e. mid-transition).
// Otherwise { nearestFt, eastbound, expectedParity, actualParity, wrongWay }.

export function hemisphericLevelCheck(altFt, headingDeg, {
    bandLoFt = 29000, bandHiFt = 41000, levelTolFt = 200,
} = {}) {
    if (headingDeg == null || !Number.isFinite(headingDeg)) return null;
    if (altFt == null || !Number.isFinite(altFt)) return null;

    // Must be established within levelTolFt of a whole flight level — otherwise
    // it's climbing/descending through, not cruising at, a level.
    const nearestFt = Math.round(altFt / 1000) * 1000;
    if (Math.abs(altFt - nearestFt) > levelTolFt) return null;
    if (nearestFt < bandLoFt || nearestFt > bandHiFt) return null;

    const hdg          = ((headingDeg % 360) + 360) % 360;  // normalise, incl. negatives
    const eastbound    = hdg < 180;                          // 000–179 E · 180–359 W
    const flThousands  = nearestFt / 1000;                   // FL310 → 31
    const actualParity   = (flThousands % 2 === 1) ? 'odd' : 'even';
    const expectedParity = eastbound ? 'odd' : 'even';

    return { nearestFt, eastbound, expectedParity, actualParity, wrongWay: expectedParity !== actualParity };
}
