// terrainWorker.js — Off-main-thread splat cloud generation.
// Two-pass approach: a dense land pass and a sparse ocean pass.
//   Land pass:  LAND_GRID × LAND_GRID grid, ocean cells skipped  → ~8M land points
//   Ocean pass: OCEAN_GRID × OCEAN_GRID grid, land cells skipped → ~1M ocean points
// Total budget: ~9M points, all land-facing density maximised.
self.onmessage = function(e) {
    const {
        demData, imgW, imgH,
        colorData, colorW, colorH,
        MAP_WIDTH, MAP_HEIGHT,
        LAND_GRID, OCEAN_GRID,
        prngSeed,
        VSCALE_LAND  = 1.0,  // land vertical exaggeration (config.TERRAIN_VSCALE_LAND)
        VSCALE_OCEAN = 1.0,  // ocean vertical exaggeration (config.TERRAIN_VSCALE_OCEAN)
    } = e.data;

    // ── Seeded PRNG (mulberry32) ───────────────────────────────────────────────
    function mulberry32(seed) {
        return function() {
            var t = seed += 0x6D2B79F5;
            t = Math.imul(t ^ t >>> 15, t | 1);
            t ^= t + Math.imul(t ^ t >>> 7, t | 61);
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
    }
    const prng = mulberry32(prngSeed);

    // ── DEM lookup ────────────────────────────────────────────────────────────
    function getTrueElevation(x, z) {
        let u = Math.floor((x / MAP_WIDTH  + 0.5) * (imgW - 1));
        let v = Math.floor((z / MAP_HEIGHT + 0.5) * (imgH - 1));
        u = Math.max(0, Math.min(u, imgW - 1));
        v = Math.max(0, Math.min(v, imgH - 1));
        const idx = (v * imgW + u) * 4;
        return (demData[idx] * 256.0 + demData[idx + 1] + demData[idx + 2] / 256.0) - 32768.0;
    }

    // ── Scene-space Y — used only for normal computation ──────────────────────
    function getSceneY(x, z) {
        const hM   = getTrueElevation(x, z);
        const dist = Math.sqrt((x / MAP_WIDTH) ** 2 + (z / MAP_HEIGHT) ** 2);
        return (hM < 0 ? (hM / 600.0) * VSCALE_OCEAN : (hM / 650.0) * VSCALE_LAND) - Math.pow(dist, 2) * 20.0;
    }

    const normalDelta = (MAP_WIDTH / imgW) * 1.2;

    // ── Pre-allocate — 7500² land grid + ocean pass ───────────────────────────
    const MAX_ALLOC = 18000000;
    const positions = new Float32Array(MAX_ALLOC * 3);
    const colors    = new Float32Array(MAX_ALLOC * 3);
    const sizes     = new Float32Array(MAX_ALLOC);
    const heights   = new Float32Array(MAX_ALLOC);
    const normals   = new Float32Array(MAX_ALLOC * 3);
    const ridges    = new Float32Array(MAX_ALLOC);
    let count = 0;

    // ════════════════════════════════════════════════════════════════════════════
    // LAND PASS — dense grid, ocean cells skipped
    // ════════════════════════════════════════════════════════════════════════════
    const cellW_L = MAP_WIDTH  / LAND_GRID;
    const cellH_L = MAP_HEIGHT / LAND_GRID;

    for (let row = 0; row < LAND_GRID; row++) {
        for (let col = 0; col < LAND_GRID; col++) {

            const xBase     = (col / LAND_GRID - 0.5) * MAP_WIDTH;
            const zBase     = (row / LAND_GRID - 0.5) * MAP_HEIGHT;
            const latFactor = Math.min(1.0, Math.abs(zBase) / (MAP_HEIGHT * 0.45));
            const jitterScale = 1.0 - latFactor * 0.80;  // 1.0 at equator → 0.20 at poles
            const x = xBase + (prng() - 0.5) * cellW_L * 0.2 * jitterScale;
            const z = zBase + (prng() - 0.5) * cellH_L * 0.2 * jitterScale;

            const hMeters = getTrueElevation(x, z);
            if (hMeters < 0) continue;  // skip ocean cells

            // ── Gradient + surface normal ─────────────────────────────────────
            const gd  = normalDelta;
            const yL  = getSceneY(x - gd, z);
            const yR  = getSceneY(x + gd, z);
            const yD  = getSceneY(x, z - gd);
            const yU  = getSceneY(x, z + gd);
            const gradX     = (yR - yL) / (2.0 * gd);
            const gradZ     = (yU - yD) / (2.0 * gd);
            const steepness = Math.min(1.0, Math.sqrt(gradX * gradX + gradZ * gradZ) * 8.0);

            // ── Earth-curvature Y offset ──────────────────────────────────────
            const dist   = Math.sqrt((x / MAP_WIDTH) ** 2 + (z / MAP_HEIGHT) ** 2);
            const curveY = -Math.pow(dist, 2) * 20.0;
            // Smooth exaggeration taper: 650 at low elevation → 1100 at peaks ≥4000m
            // Reduces apparent steepness on mountain faces so grid points cluster tighter
            const highBlend = Math.min(1.0, Math.max(0.0, (hMeters - 2000.0) / 2000.0));
            const exag  = 650.0 + highBlend * 450.0;
            const finalY = (hMeters / exag) * VSCALE_LAND;

            // ── Satellite colour pipeline ─────────────────────────────────────
            let cU = Math.floor((x / MAP_WIDTH  + 0.5) * (colorW - 1));
            let cV = Math.floor((z / MAP_HEIGHT + 0.5) * (colorH - 1));
            cU = Math.max(0, Math.min(cU, colorW - 1));
            cV = Math.max(0, Math.min(cV, colorH - 1));
            const cIdx = (cV * colorW + cU) * 4;

            const rawR = colorData[cIdx]     / 255.0;
            const rawG = colorData[cIdx + 1] / 255.0;
            const rawB = colorData[cIdx + 2] / 255.0;

            let satR = rawR * 0.96;
            let satG = rawG * 1.00;
            let satB = rawB * 0.94;

            const warmness   = Math.max(0.0, rawR - rawB);
            const desertGlow = Math.pow(warmness, 1.5) * 0.32;
            satR += desertGlow * 0.90;
            satG += desertGlow * 0.45;

            const lushness = Math.max(0.0, rawG - rawR);
            const lushGlow = Math.pow(lushness, 1.0) * 0.55;
            satR -= lushGlow * 0.22;
            satG += lushGlow * 1.10;
            satB += lushGlow * 0.25;

            const latNorm    = -z / (MAP_HEIGHT * 0.5);
            const polarIce   = Math.max(0.0, (Math.abs(latNorm) - 0.74) / 0.26);
            const brightness = (rawR + rawG + rawB) / 3.0;

            const suppressCoeff    = 0.25 * (1.0 - polarIce * 0.95);
            const whiteSuppression = 1.0 - Math.pow(brightness, 2.0) * suppressCoeff;
            satR *= whiteSuppression;
            satG *= whiteSuppression;
            satB *= whiteSuppression;

            const chroma   = Math.max(rawR, rawG, rawB) - Math.min(rawR, rawG, rawB);
            const aridGrey = Math.max(0.0, 0.26 - chroma)
                           * Math.max(0.0, brightness - 0.20)
                           * Math.max(0.0, 0.90 - brightness)
                           * (1.0 - polarIce)
                           * Math.max(0.0, 1.0 - hMeters / 4000.0)
                           * 10.0;
            satR += aridGrey * 0.35;
            satG += aridGrey * 0.10;
            satB -= aridGrey * 0.15;

            const latAbs      = Math.abs(latNorm);
            const beltFadeIn  = Math.min(1.0, Math.max(0.0, (latAbs - 0.14) / 0.08));
            const beltFadeOut = Math.min(1.0, Math.max(0.0, (0.64 - latAbs) / 0.10));
            const desertBelt  = beltFadeIn * beltFadeOut;
            const notLush     = Math.max(0.0, 1.0 - lushGlow * 4.0);
            const notAlpineG  = Math.max(0.0, 1.0 - hMeters / 3500.0);
            const notDark     = Math.max(0.0, brightness - 0.22);
            const geoWarm     = desertBelt * notLush * notAlpineG * notDark
                              * (1.0 - polarIce) * 1.8;
            satR += geoWarm * 0.14;
            satG += geoWarm * 0.05;
            satB -= geoWarm * 0.07;

            const topoRatio  = Math.min(1.0, Math.max(0.0, hMeters / 2500.0));
            const snowGlow   = topoRatio * Math.pow(brightness, 3.0) * 0.22;
            // iceShimmer coefficient reduced 0.90→0.30 to prevent polar blowout.
            // Antarctic/Arctic regions stay bright white but no longer clip to 1.0.
            const iceShimmer = Math.min(polarIce * polarIce * brightness * 0.30, 0.25);

            const polarCap = 1.0 - polarIce * 0.18;
            const r = Math.min(polarCap, Math.max(0.0, satR + snowGlow * 0.65 + iceShimmer * 0.94));
            const g = Math.min(polarCap, Math.max(0.0, satG + snowGlow * 0.80 + iceShimmer * 0.97));
            const b = Math.min(polarCap, Math.max(0.0, satB + snowGlow * 1.00 + iceShimmer * 1.00));

            // ── Surface normal ────────────────────────────────────────────────
            let nx = -gradX, ny = 1.0, nz = -gradZ;
            const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (nLen > 0.0) { nx /= nLen; ny /= nLen; nz /= nLen; }

            // ── Write ─────────────────────────────────────────────────────────
            positions[count * 3]     = x;
            positions[count * 3 + 1] = finalY + curveY;
            positions[count * 3 + 2] = z;
            colors[count * 3]     = r;
            colors[count * 3 + 1] = g;
            colors[count * 3 + 2] = b;
            const jitter = prng() * (0.08 * (1.0 - steepness * 0.85));
            sizes[count]   = Math.max(0.18, 0.20 + steepness * 0.32 + latFactor * 0.22) + jitter;
            heights[count] = finalY;
            normals[count * 3]     = nx;
            normals[count * 3 + 1] = ny;
            normals[count * 3 + 2] = nz;
            ridges[count]  = steepness;
            count++;
        }
    }

    // ════════════════════════════════════════════════════════════════════════════
    // OCEAN PASS — coarse grid, land cells skipped
    // ════════════════════════════════════════════════════════════════════════════
    const cellW_O = MAP_WIDTH  / OCEAN_GRID;
    const cellH_O = MAP_HEIGHT / OCEAN_GRID;

    for (let row = 0; row < OCEAN_GRID; row++) {
        for (let col = 0; col < OCEAN_GRID; col++) {

            const x = (col / OCEAN_GRID - 0.5) * MAP_WIDTH  + (prng() - 0.5) * cellW_O * 0.7;
            const z = (row / OCEAN_GRID - 0.5) * MAP_HEIGHT + (prng() - 0.5) * cellH_O * 0.7;

            const hMeters = getTrueElevation(x, z);
            if (hMeters >= 0) continue;  // skip land cells

            // ── Earth-curvature Y offset ──────────────────────────────────────
            const dist   = Math.sqrt((x / MAP_WIDTH) ** 2 + (z / MAP_HEIGHT) ** 2);
            const curveY = -Math.pow(dist, 2) * 20.0;
            const finalY = (hMeters / 600.0) * VSCALE_OCEAN;

            // ── Ocean depth colour — matches the oceanFloorMesh bands ─────────
            // Same four-band scheme as terrainBuilder.createSolidOceanFloor so
            // the splat points and the seafloor mesh read as one continuous
            // surface. Endpoints kept continuous between adjacent bands.
            //   Shelf  (   0–  200 m) : lit cyan
            //   Slope  ( 200–2 000 m) : steel blue
            //   Abyss  (2000–6 000 m) : deep blue-indigo
            //   Hadal  (    > 6000 m) : near-black indigo-violet
            const d = Math.abs(hMeters);
            let r, g, b;
            if (d < 200) {
                const t = d / 200;
                r = 0.06  - t * 0.030;
                g = 0.32  - t * 0.160;
                b = 0.78  - t * 0.230;
            } else if (d < 2000) {
                const t = (d - 200) / 1800;
                r = 0.030 - t * 0.015;
                g = 0.160 - t * 0.100;
                b = 0.550 - t * 0.200;
            } else if (d < 6000) {
                const t = (d - 2000) / 4000;
                r = 0.015 - t * 0.008;
                g = 0.060 - t * 0.035;
                b = 0.350 - t * 0.180;
            } else {
                const t = Math.min(1.0, (d - 6000) / 4000);
                r = 0.007 - t * 0.003;
                g = 0.025 - t * 0.013;
                b = 0.170 - t * 0.115;
            }

            // ── Write ─────────────────────────────────────────────────────────
            positions[count * 3]     = x;
            positions[count * 3 + 1] = finalY + curveY;
            positions[count * 3 + 2] = z;
            colors[count * 3]     = r;
            colors[count * 3 + 1] = g;
            colors[count * 3 + 2] = b;
            sizes[count]   = 0.28;
            heights[count] = finalY;
            normals[count * 3]     = 0.0;
            normals[count * 3 + 1] = 1.0;
            normals[count * 3 + 2] = 0.0;
            ridges[count]  = 0.0;
            count++;
        }
    }

    // Slice to actual count — transfers only the populated portion
    const outPositions = positions.slice(0, count * 3);
    const outColors    = colors.slice(0, count * 3);
    const outSizes     = sizes.slice(0, count);
    const outHeights   = heights.slice(0, count);
    const outNormals   = normals.slice(0, count * 3);
    const outRidges    = ridges.slice(0, count);

    self.postMessage(
        { positions: outPositions, colors: outColors, sizes: outSizes,
          heights: outHeights, normals: outNormals, ridges: outRidges, count },
        [ outPositions.buffer, outColors.buffer, outSizes.buffer,
          outHeights.buffer, outNormals.buffer, outRidges.buffer ]
    );
};
