// igrf.js — IGRF dipole field strength calculator
//
// Given a geographic latitude (degrees), longitude (degrees), and altitude (km),
// returns the magnetic field strength in nanoteslas (nT).
//
// Uses the simplified centered-dipole approximation of the IGRF model.
// The dipole is tilted ~11.5° from the geographic axis with the magnetic
// north pole at approximately 80.7°N, 72.7°W (IGRF-13 epoch 2020).
//
// Formula:
//   B = (B0 / r³) × √(1 + 3·sin²(λ_mag))
//
// Where:
//   B0  = 29,872 nT  (Earth's dipole moment at surface, IGRF-13)
//   r   = distance from Earth's centre in Earth radii
//   λ_mag = magnetic latitude at the point
//
// Accuracy: ±2,000–4,000 nT vs full IGRF spherical-harmonic model.
// Good enough for visualisation; click-to-measure cards will note this.
//
// The South Atlantic Anomaly is a real-world departure from the dipole
// that this model cannot capture — it will be annotated separately.

// ── Dipole constants (IGRF-13, epoch 2020.0) ─────────────────────────────────
const B0_NT        = 29872;          // dipole moment, nanoteslas at Earth surface
const EARTH_R_KM   = 6371;           // mean Earth radius, km

const LAT_N_DEG    = 80.7;           // geographic latitude  of magnetic north pole
const LON_N_DEG    = -72.7;          // geographic longitude of magnetic north pole
const LAT_N        = LAT_N_DEG * Math.PI / 180;
const LON_N        = LON_N_DEG * Math.PI / 180;

// Magnetic north pole unit vector in geographic Cartesian
// Axes: X → (0°N,0°E), Y → (0°N,90°E), Z → 90°N
const _MAG_POLE = [
    Math.cos(LAT_N) * Math.cos(LON_N),
    Math.cos(LAT_N) * Math.sin(LON_N),
    Math.sin(LAT_N),
];

// ── Internal helpers ──────────────────────────────────────────────────────────
function _dot(a, b) {
    return a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
}

// Convert geographic lat/lon (degrees) to unit Cartesian vector
function _geoToCart(latDeg, lonDeg) {
    const lat = latDeg * Math.PI / 180;
    const lon = lonDeg * Math.PI / 180;
    return [
        Math.cos(lat) * Math.cos(lon),
        Math.cos(lat) * Math.sin(lon),
        Math.sin(lat),
    ];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * sampleStrength(latDeg, lonDeg, altKm)
 *
 * Returns the total magnetic field strength in nanoteslas at the given point.
 *
 * @param {number} latDeg  Geographic latitude  in degrees  (-90 … +90)
 * @param {number} lonDeg  Geographic longitude in degrees (-180 … +180)
 * @param {number} altKm   Altitude above Earth's surface  in kilometres
 * @returns {number} Field strength in nanoteslas (nT)
 */
export function sampleStrength(latDeg, lonDeg, altKm) {
    // Distance from Earth's centre in Earth radii
    const r = (EARTH_R_KM + Math.max(0, altKm)) / EARTH_R_KM;

    // Unit vector toward the point
    const p = _geoToCart(latDeg, lonDeg);

    // sin(magnetic latitude) = dot product of point vector with pole vector
    const sinMagLat = _dot(p, _MAG_POLE);

    // Dipole field strength formula
    const B = (B0_NT / (r * r * r)) * Math.sqrt(1.0 + 3.0 * sinMagLat * sinMagLat);

    return B;
}

/**
 * sampleStrengthNormalized(latDeg, lonDeg, altKm)
 *
 * Returns field strength normalised to the range 0→1 relative to
 * the surface dipole peak (~59,000 nT at the poles).
 * Useful as a direct driver for shader thickness/opacity attributes.
 *
 * @param {number} latDeg
 * @param {number} lonDeg
 * @param {number} altKm
 * @returns {number} Normalised strength 0.0–1.0
 */
export function sampleStrengthNormalized(latDeg, lonDeg, altKm) {
    // Peak dipole value: B0 × √4 = 2×B0 at magnetic poles, surface
    const peak = 2.0 * B0_NT;
    return Math.min(1.0, sampleStrength(latDeg, lonDeg, altKm) / peak);
}

/**
 * sampleMagneticLatitude(latDeg, lonDeg)
 *
 * Returns the magnetic latitude in degrees at the given geographic location.
 * Useful for determining which field line shell (L-shell) a point sits on
 * and for computing day/night electrojet position.
 *
 * @param {number} latDeg
 * @param {number} lonDeg
 * @returns {number} Magnetic latitude in degrees (-90 … +90)
 */
export function sampleMagneticLatitude(latDeg, lonDeg) {
    const p        = _geoToCart(latDeg, lonDeg);
    const sinMagLat = Math.max(-1, Math.min(1, _dot(p, _MAG_POLE)));
    return Math.asin(sinMagLat) * 180 / Math.PI;
}

/**
 * FIELD_REFERENCE
 *
 * Named reference values in nanoteslas for use in UI cards and legends.
 */
export const FIELD_REFERENCE = {
    POLE_SURFACE_NT:      59000,   // strong — magnetic poles, surface
    MID_LAT_SURFACE_NT:   45000,   // mid-latitudes, surface
    EQUATOR_SURFACE_NT:   29872,   // weakest surface zone, magnetic equator
    SAA_ANOMALY_NT:       22000,   // South Atlantic Anomaly (actual, not modelled)
    D_LAYER_NT:           52000,   // approximate field at D layer altitude (~75km)
    E_LAYER_NT:           47000,   // approximate field at E layer altitude (~120km)
    F1_LAYER_NT:          38000,   // approximate field at F1 layer altitude (~200km)
    F2_LAYER_NT:          28000,   // approximate field at F2 layer altitude (~375km)
    INNER_VB_NT:           5000,   // approximate field at inner Van Allen (~3000km)
    OUTER_VB_NT:            200,   // approximate field at outer Van Allen (~17500km)
};
