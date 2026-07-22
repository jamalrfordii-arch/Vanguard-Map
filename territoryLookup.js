// territoryLookup.js — country identification from lon/lat (2026-07-13)
//
// Feeds the SENSOR ALIGNMENT hover readout: cursor → lon/lat → country name.
// Data: the Natural Earth admin-0 GeoJSON that dataLoader already fetches at
// boot for the border lines — no extra network cost, initTerritoryLookup()
// just receives the same object.
//
// Pure module: no THREE, no DOM. Testable in node:
//   point-in-polygon (ray casting) with a per-feature bbox prefilter, so a
//   lookup is ~O(features-whose-bbox-contains-point × their vertices) — a few
//   dozen microseconds in practice. Callers should still throttle to taste.

let _features = null;   // [{ name, bbox:[minLon,minLat,maxLon,maxLat], polys:[ [ring0, ring1…] ] }]

/** Ray-casting point-in-ring. ring = [[lon,lat], …]. */
function _inRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        if (((yi > lat) !== (yj > lat)) &&
            (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

/** Point in polygon (outer ring minus holes). poly = [outerRing, hole1, …]. */
function _inPoly(lon, lat, poly) {
    if (!_inRing(lon, lat, poly[0])) return false;
    for (let h = 1; h < poly.length; h++) {
        if (_inRing(lon, lat, poly[h])) return false;   // inside a hole
    }
    return true;
}

export function initTerritoryLookup(geojson) {
    if (!geojson || !geojson.features) { _features = null; return; }
    _features = geojson.features.map(f => {
        const name = f.properties?.name || f.properties?.NAME || f.properties?.admin || '?';
        const polys = f.geometry.type === 'Polygon'
            ? [f.geometry.coordinates]
            : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [];
        let minLon = 180, minLat = 90, maxLon = -180, maxLat = -90;
        polys.forEach(poly => poly[0].forEach(([lo, la]) => {
            if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo;
            if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
        }));
        return { name, bbox: [minLon, minLat, maxLon, maxLat], polys };
    }).filter(f => f.polys.length);
}

/** Country name at lon/lat, or null over open water / before init. */
export function countryAt(lon, lat) {
    if (!_features) return null;
    for (const f of _features) {
        const [a, b, c, d] = f.bbox;
        if (lon < a || lon > c || lat < b || lat > d) continue;
        for (const poly of f.polys) {
            if (_inPoly(lon, lat, poly)) return f.name;
        }
    }
    return null;
}
