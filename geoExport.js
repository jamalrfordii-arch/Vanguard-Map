// geoExport.js — Export VANGUARD1 data as standard GeoJSON.
//
// GeoJSON chosen over GPX/KML because it's the simplest format to hand-author
// correctly and is broadly interoperable (QGIS, geojson.io, Google Earth via
// import, Mapbox/Leaflet, etc.). All coordinates below are [lon, lat] — the
// GeoJSON spec's required order, which is the opposite of how this codebase
// usually reasons about lat/lon (see aisManager.js lonLatToScene).
//
// Pure data module: no THREE, no DOM dependency except downloadGeoJSON's
// Blob/anchor trick. Callers pass plain lat/lon data already produced
// elsewhere (measureManager's result object, a vessel's userData.posLog) —
// this module does not reach into scene objects itself.

export function measurementToGeoJSON(result) {
    if (!result) return null;
    const { aLat, aLon, bLat, bLon, distanceNm, distanceKm, bearingDeg } = result;
    return {
        type: 'FeatureCollection',
        features: [
            {
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: [[aLon, aLat], [bLon, bLat]] },
                properties: {
                    kind: 'measurement',
                    distance_nm: Number(distanceNm.toFixed(2)),
                    distance_km: Number(distanceKm.toFixed(2)),
                    bearing_deg_true: Number(bearingDeg.toFixed(1)),
                },
            },
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [aLon, aLat] },
                properties: { kind: 'measurement-point', role: 'A' },
            },
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [bLon, bLat] },
                properties: { kind: 'measurement-point', role: 'B' },
            },
        ],
    };
}

// vessel: the plain object carrying { id, displayName, posLog } — pass
// shipGroup.userData directly. posLog entries are { lat, lon, ts } (epoch ms),
// throttled to ~every 30 min, capped at 48 entries (see main.js).
// Returns null if there's no real track to export (honesty: never fabricate
// a line from a single point).
export function vesselTrackToGeoJSON(vessel) {
    const log = vessel?.posLog ?? [];
    if (log.length === 0) return null;

    const pointFeatures = log.map(p => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: {
            kind: 'track-point',
            mmsi: vessel.id ?? null,
            ts: p.ts,
            iso_time: new Date(p.ts).toISOString(),
        },
    }));

    const features = [...pointFeatures];
    if (log.length >= 2) {
        features.unshift({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: log.map(p => [p.lon, p.lat]) },
            properties: {
                kind: 'track',
                mmsi: vessel.id ?? null,
                name: vessel.displayName ?? 'UNKNOWN',
                point_count: log.length,
                first_ts: log[0].ts,
                last_ts: log[log.length - 1].ts,
            },
        });
    }

    return { type: 'FeatureCollection', features };
}

export function downloadGeoJSON(geojson, filename) {
    if (!geojson) return;
    const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: 'application/geo+json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename.endsWith('.geojson') ? filename : `${filename}.geojson`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
