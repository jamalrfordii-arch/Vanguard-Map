// continentWorker.js — Vertex data for the data-only continent mesh
//
// HYBRID MODE: the continent mesh no longer renders, so this worker only has
// to produce the data the height sampler + any future elevation-aware system
// actually consume. We dropped the satellite colour pass, the UV grid, and
// the index buffer — none of which exist downstream anymore.
//
// Output arrays (transferred zero-copy back to the main thread):
//   positions  Float32Array  (x, y, z) × vertCount   — DEM-displaced
//   slopes     Float32Array  (s)       × vertCount   — 0–1 terrain steepness
//   trueElevs  Float32Array  (m)       × vertCount   — raw metres above sea level
//
// What was removed when the mesh stopped rendering:
//   • colors    — was 3 channels × vertex of biome/snow/rock blending math
//   • uvs       — only useful for texture mapping
//   • indices   — only useful for triangle rendering
//   • satCol()  — satellite colour sampler (no colour pass to feed)
//   • colorData/W/H worker input — no longer needed, saves a structured-clone
//
// Result: ~150 lines of math gone, structured-clone of the satellite RGBA
// array (~16MB) no longer crosses the worker boundary.

self.onmessage = ({ data }) => {
    const {
        demData, imgW, imgH,
        MAP_WIDTH, MAP_HEIGHT,
        SEGS,
    } = data;

    const V = (SEGS + 1) * (SEGS + 1);

    const positions  = new Float32Array(V * 3);
    const slopes     = new Float32Array(V);
    const trueElevs  = new Float32Array(V);

    // ── Elevation sampler — Terrarium RGB encoding ────────────────────────────
    function elev(x, z) {
        let u = Math.floor((x / MAP_WIDTH  + 0.5) * (imgW - 1));
        let v = Math.floor((z / MAP_HEIGHT + 0.5) * (imgH - 1));
        u = Math.max(0, Math.min(u, imgW - 1));
        v = Math.max(0, Math.min(v, imgH - 1));
        const i = (v * imgW + u) * 4;
        return (demData[i] * 256.0 + demData[i + 1] + demData[i + 2] / 256.0) - 32768.0;
    }

    // ── Smoothed elevation for vertex Y positions ─────────────────────────────
    // 9-tap box filter rounds off single-pixel DEM spikes into natural ridgelines.
    // Radius fixed in map units (not relative to SEGS) so smoothing stays
    // consistent regardless of triangle count.
    const _sr = 1.2;
    function elevSmooth(x, z) {
        const d = _sr;
        return (elev(x,    z   ) * 4
              + elev(x + d, z   )
              + elev(x - d, z   )
              + elev(x,    z + d)
              + elev(x,    z - d)
              + elev(x + d, z + d)
              + elev(x - d, z + d)
              + elev(x + d, z - d)
              + elev(x - d, z - d)) / 12.0;
    }

    // Step size for central-difference slope — ~0.7 quad widths
    const step = (MAP_WIDTH / SEGS) * 0.7;

    let vi = 0;
    for (let row = 0; row <= SEGS; row++) {
        for (let col = 0; col <= SEGS; col++) {
            const x   = (col / SEGS - 0.5) * MAP_WIDTH;
            const z   = (row / SEGS - 0.5) * MAP_HEIGHT;
            const hM  = elev(x, z);          // raw elevation — slope + true height
            const hMs = elevSmooth(x, z);    // smoothed — vertex Y only
            trueElevs[vi] = hM;

            const isOcean = hM < 0;

            // Vertex Y — ocean clamped to 0 so coastline faces don't dive into
            // trenches. Land uses smoothed elev / 850 so the height matches the
            // value the original render path produced (terrainHeightSampler
            // callers were tuned against this exact scale; do not change without
            // updating the sampler's downstream consumers).
            const vy = isOcean ? 0 : hMs / 850.0;

            positions[vi * 3]     = x;
            positions[vi * 3 + 1] = vy;
            positions[vi * 3 + 2] = z;

            // ── Central-difference slope magnitude ─────────────────────────────
            // Four-sample gradient; 0=flat, 1=vertical. Ocean = 1.0 by convention
            // (matches the original render-path slope coding so any future system
            // that wants land-only slope can filter with isOcean = hM < 0).
            if (isOcean) {
                slopes[vi] = 1.0;
            } else {
                const e0 = elev(x + step, z);
                const e1 = elev(x - step, z);
                const e2 = elev(x, z + step);
                const e3 = elev(x, z - step);
                const gx = (e0 - e1) / (2 * step * 1000);
                const gz = (e2 - e3) / (2 * step * 1000);
                slopes[vi] = Math.min(1.0, Math.sqrt(gx * gx + gz * gz) * 1.5);
            }

            vi++;
        }
    }

    self.postMessage(
        { positions, slopes, trueElevs },
        [positions.buffer, slopes.buffer, trueElevs.buffer]
    );
};
