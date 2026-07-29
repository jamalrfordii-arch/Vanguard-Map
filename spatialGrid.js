// spatialGrid.js — count near neighbours without comparing every pair.
//
// WHY (2026-07-25): main.js's dark-marker overlap reduction ran, every frame:
//
//     for each dark vessel
//         for each OTHER dark vessel
//             if distance < 4.0 → nearbyCount++
//
// That is O(n²) per frame. With 200 dark vessels it is 40,000 distance tests
// sixty times a second, and it gets WORSE as you zoom out and more vessels
// become visible — the opposite of what a viewer expects.
//
// It is the same shape as the aircraft conflict check fixed earlier the same day
// (44,850 candidate pairs → 4 via a sorted sweep). That fix never propagated
// here, which is the recurring lesson: when you fix an O(n²), grep for the other
// ones rather than waiting to trip over them.
//
// Approach: bucket points into a uniform grid of cell size = radius, then compare
// each point only against its own cell and the 8 around it. Any point within
// `radius` is guaranteed to be in one of those 9 cells, so the answer is EXACT —
// this is a speed-up, not an approximation. Expected O(n) for evenly spread
// points; degrades toward O(n²) only if everything piles into one cell, which for
// vessel positions on a world map does not happen.
//
// Pure: no THREE, no DOM. See tests/spatialGrid.test.mjs.

/**
 * For each point, how many OTHER points lie within `radius` (Euclidean, XZ).
 *
 * @param {Array<{x:number,z:number}>} points
 * @param {number} radius
 * @returns {Int32Array} counts, index-aligned with `points`
 */
export function countNeighborsWithin(points, radius) {
    const n = points.length;
    const out = new Int32Array(n);
    if (n < 2 || !(radius > 0)) return out;

    // Cell size == radius, so the search neighbourhood is exactly 3x3 cells.
    const inv = 1 / radius;
    const cells = new Map();
    // Key must be INJECTIVE, not merely a good hash. A hashed key (the obvious
    // `cx * 73856093 ^ cz * 19349663`) collides, and the failure mode is not a
    // slowdown — it is DOUBLE COUNTING. When two of the nine neighbour cells
    // happen to collide with each other, the same merged bucket is scanned twice
    // and every point in it counts twice. Caught by this module's own test on
    // random and negative inputs; the small hand-written cases all passed,
    // because collisions need large or negative cell indices to show up.
    const keyOf = (cx, cz) => cx + '|' + cz;

    const cx = new Int32Array(n), cz = new Int32Array(n);
    for (let i = 0; i < n; i++) {
        const p = points[i];
        // Non-finite coordinates would poison the bucketing and silently drop the
        // point from every neighbourhood. Leave it at count 0 instead.
        if (!Number.isFinite(p?.x) || !Number.isFinite(p?.z)) { cx[i] = cz[i] = 2147483647; continue; }
        const a = Math.floor(p.x * inv), b = Math.floor(p.z * inv);
        cx[i] = a; cz[i] = b;
        const k = keyOf(a, b);
        let bucket = cells.get(k);
        if (!bucket) { bucket = []; cells.set(k, bucket); }
        bucket.push(i);
    }

    const r2 = radius * radius;
    for (let i = 0; i < n; i++) {
        if (cx[i] === 2147483647) continue;
        const p = points[i];
        let count = 0;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                const bucket = cells.get(keyOf(cx[i] + dx, cz[i] + dz));
                if (!bucket) continue;
                for (let bi = 0; bi < bucket.length; bi++) {
                    const j = bucket[bi];
                    if (j === i) continue;
                    const q = points[j];
                    const ddx = p.x - q.x, ddz = p.z - q.z;
                    if (ddx * ddx + ddz * ddz < r2) count++;
                }
            }
        }
        out[i] = count;
    }
    return out;
}

/** Reference implementation. Exported so the test can prove the grid agrees with
 *  it exactly rather than merely "looking about right" — an approximate
 *  neighbour count would show up as markers flickering opacity, which is
 *  precisely the kind of bug nobody traces back to a spatial index. */
export function countNeighborsBruteForce(points, radius) {
    const n = points.length;
    const out = new Int32Array(n);
    const r2 = radius * radius;
    for (let i = 0; i < n; i++) {
        if (!Number.isFinite(points[i]?.x) || !Number.isFinite(points[i]?.z)) continue;
        let c = 0;
        for (let j = 0; j < n; j++) {
            if (i === j) continue;
            const q = points[j];
            if (!Number.isFinite(q?.x) || !Number.isFinite(q?.z)) continue;
            const dx = points[i].x - q.x, dz = points[i].z - q.z;
            if (dx * dx + dz * dz < r2) c++;
        }
        out[i] = c;
    }
    return out;
}
