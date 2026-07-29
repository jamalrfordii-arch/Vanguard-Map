// terrainWorker.js — Off-main-thread splat cloud generation.
// Two-pass approach: a dense land pass and a sparse ocean pass.
//   Land pass:  LAND_GRID × LAND_GRID grid, ocean cells skipped
//   Ocean pass: OCEAN_GRID × OCEAN_GRID grid, land cells skipped
// BUDGET NOTE (2026-07-20): output is sliced to MAX_ALLOC below — if land+ocean
// candidates exceed it, the land pass (which runs first) silently wins and the
// ocean pass can be entirely dropped with no error. This bit us once (config.js
// SPLAT_LAND_GRID=7500 → ~23M land candidates alone > the old 18M MAX_ALLOC →
// 0 ocean splats ever rendered, undetected for weeks). Grid values in config.js
// must keep land+ocean candidates comfortably under MAX_ALLOC — the console.warn
// below fires if that budget is ever blown again.
import { landElevToUnits, formulaFor, resolveMode } from './terrainHeight.js';

self.onmessage = function(e) {
    const {
        demData, imgW, imgH,
        colorData, colorW, colorH,
        MAP_WIDTH, MAP_HEIGHT,
        LAND_GRID, OCEAN_GRID,
        prngSeed,
        VSCALE_LAND  = 1.0,  // land vertical exaggeration (config.TERRAIN_VSCALE_LAND)
        VSCALE_OCEAN = 1.0,  // ocean vertical exaggeration (config.TERRAIN_VSCALE_OCEAN)
        TERRAIN_MODE_IN,     // 'legacy' | 'tall' | 'flat' — see terrainHeight.js
    } = e.data;

    // Land height formula for THIS surface. Shared with tilePointsBuilder via
    // terrainHeight.js so the base cloud and the streamed tiles can no longer
    // disagree about where the ground is — they did, by ~3x, which is why base
    // cloud points floated above solidly-tiled terrain.
    const LAND_FORMULA = formulaFor('base', resolveMode(TERRAIN_MODE_IN));

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
        // Ocean keeps its own /600 curve — it is not part of the land disagreement
        // and the sea plane governs that band anyway.
        return (hM < 0 ? (hM / 600.0) * VSCALE_OCEAN
                       : landElevToUnits(hM, LAND_FORMULA) * VSCALE_LAND)
               - Math.pow(dist, 2) * 20.0;
    }

    const normalDelta = (MAP_WIDTH / imgW) * 1.2;

    // ── Pre-allocate ───────────────────────────────────────────────────────────
    // 18M → 20M → 21M → 24M (2026-07-20). First bump: SPLAT_LAND_GRID trimmed
    // 7500→5500, targeting ~17.8M real total (measured land fraction 0.413).
    // Second bump: SPLAT_LAND_GRID given back to 6000 (visual-quality
    // give-back), targeting ~20.2M — raised to 21M for headroom. Third bump:
    // the coastal-fill band added below (cells within COASTAL_BAND_M of sea
    // level, previously skipped as "ocean", now rendered as sea-level land to
    // close coastline point-density gaps) pushed real land+ocean candidates
    // OVER 21M without any console warning surfacing (worker console.warn
    // isn't reliably captured by the browser-automation console reader used
    // to test this — verified truncation directly instead, by sampling
    // aHeight on the actual output buffer: ocean fraction read 0.236 against
    // an expected ~0.587, i.e. most ocean splats were silently dropped).
    // Raised with real headroom this time, not just past the observed count.
    const MAX_ALLOC = 24000000;
    // ── Attribute precision (2026-07-24) ─────────────────────────────────────
    // At the shipped SPLAT_LAND_GRID the cloud is ~20.4M points, and six f32
    // attributes came to 935MB of a 1342MB JS heap. That heap size was the
    // dominant cost of GC pauses (measured: 40 of 53 frame hitches correlated
    // with heap movement, worst 369ms, at an allocation rate of only 0.9MB/s —
    // so it was the SIZE of the live set being scanned, not churn), and those
    // pauses were what stopped the renderer holding 2× supersampling.
    //
    // colour and steepness are both bounded 0..1, so 8 bits each is plenty:
    // 256 levels of colour per channel is what a JPEG delivers anyway, and
    // steepness only ever feeds a smoothstep. Declared `normalized` on the
    // BufferAttribute (terrainBuilder), so GLSL still reads plain 0..1 floats
    // and no shader code changes. Saves ~233MB.
    //
    // position/height stay f32 — they carry world-scale values, not 0..1.
    // normals are the next candidate (Int8, ~175MB) but are a signed range and
    // were deliberately left for a separate step.
    const positions = new Float32Array(MAX_ALLOC * 3);
    const colors    = new Uint8Array(MAX_ALLOC * 3);
    const sizes     = new Float32Array(MAX_ALLOC);
    const heights   = new Float32Array(MAX_ALLOC);
    const normals   = new Float32Array(MAX_ALLOC * 3);
    const ridges    = new Uint8Array(MAX_ALLOC);
    // Quantise 0..1 → 0..255. Explicit clamp: Uint8Array WRAPS on overflow
    // (unlike Uint8ClampedArray), so an out-of-range colour would silently come
    // back as a wildly wrong one rather than saturating.
    const q8 = (t) => (t <= 0 ? 0 : t >= 1 ? 255 : (t * 255 + 0.5) | 0);
    let count = 0;
    let overflowWarned = false;

    // ════════════════════════════════════════════════════════════════════════════
    // LAND PASS — dense grid, ocean cells skipped
    // ════════════════════════════════════════════════════════════════════════════
    const cellW_L = MAP_WIDTH  / LAND_GRID;
    const cellH_L = MAP_HEIGHT / LAND_GRID;

    landLoop:
    for (let row = 0; row < LAND_GRID; row++) {
        for (let col = 0; col < LAND_GRID; col++) {
            if (count >= MAX_ALLOC) {
                if (!overflowWarned) {
                    console.warn(`[terrainWorker] MAX_ALLOC (${MAX_ALLOC.toLocaleString()}) hit during LAND pass — ocean pass will be starved or skipped entirely. Lower SPLAT_LAND_GRID or raise MAX_ALLOC.`);
                    overflowWarned = true;
                }
                break landLoop;
            }

            const xBase     = (col / LAND_GRID - 0.5) * MAP_WIDTH;
            const zBase     = (row / LAND_GRID - 0.5) * MAP_HEIGHT;
            const latFactor = Math.min(1.0, Math.abs(zBase) / (MAP_HEIGHT * 0.45));
            const jitterScale = 1.0 - latFactor * 0.80;  // 1.0 at equator → 0.20 at poles
            // Jitter amplitude 0.2→0.9 (2026-07-20, moiré fix): points sat within
            // only ±10% of a cell width of the regular LAND_GRID lattice, which is
            // basically still a grid — reported live as a crosshatch/moiré pattern
            // over the Sahara at top-down, mid-high altitude (whole-continent)
            // views, where the grid's spatial frequency beats against the screen's
            // pixel grid. mulberry32 (the PRNG here) has good statistical quality,
            // so this isn't a bad-random-source problem — the fix is amplitude:
            // stratified jitter needs to use most of the cell to read as
            // pseudo-random rather than periodic. 0.9 keeps each point safely
            // inside its own cell (±0.45 of cell width — never crosses into a
            // neighbour's territory) while being close enough to full-cell
            // coverage to break the grid's regularity. Latitude taper unchanged
            // (still 1.0 at equator → 0.20 at poles, same ratio, just scaled up
            // from the new higher base) — the reduced polar jitter exists because
            // scene-space X is linear longitude while real-world distance per
            // degree of longitude shrinks near the poles, so the same fractional
            // jitter is proportionally smaller in real terms there anyway.
            const x = xBase + (prng() - 0.5) * cellW_L * 0.9 * jitterScale;
            const z = zBase + (prng() - 0.5) * cellH_L * 0.9 * jitterScale;

            let hMeters = getTrueElevation(x, z);
            // Antarctic ice-shelf fill (2026-07-13, THE "grey shape" root cause):
            // ice shelves and subglacial basins are BELOW sea level, so skipping
            // sub-zero cells punched angular holes in the ice sheet — the dark
            // sea plane showed through as flat multi-faceted shapes at the south
            // edge (grey on the old bright ocean, black on the deep stage). In
            // the deep south those cells are ice in reality: render them as
            // sea-level ice instead of holes. z > 114 ≈ south of 64°S, land only.
            const southShelf = z > 108 && hMeters < 0;   // ≈62°S — peninsula tip included
            // Coastal fill (2026-07-20): the same hole problem shows up on ANY
            // steep coastline, not just Antarctica — e.g. the Andes/Peru-Chile
            // trench drops from +4000m to -5000m within a couple of grid cells,
            // so the land pass's per-cell skip left the coastline itself sparse
            // (real land points, correctly present, but with real gaps between
            // them exposing the now-correctly-masked water plane — reported live
            // as "the blue comes thru" after the water land-mask fix made the
            // water stop covering that gap up by accident). A cell within
            // COASTAL_BAND_M of sea level is very likely coastline/shelf, not
            // open ocean — fill it as sea-level land instead of skipping, same
            // technique as the ice-shelf case above, generalized to every coast.
            // Tuning history: first tried 60m — WRONG, live-verified it swallowed
            // wide, gentle continental shelves as flat "land" (ocean point
            // fraction dropped from a baseline ~0.297 to 0.248 — a real, visible
            // area of ocean turned to sea-level fill, not just thin coastlines).
            // 8m keeps it a genuinely thin coastal fringe (fraction recovered to
            // ~0.261) while still bridging the steep-coast case this was meant
            // to fix. Note this does NOT fully solve extreme near-vertical drops
            // (Andes/trench-style): at LAND_GRID's ~6.7km cell spacing, the true
            // elevation profile can jump straight from deep negative to strongly
            // positive between adjacent samples with nothing landing in an 8m
            // band at all — that specific case needs a finer, coastline-adaptive
            // sampling pass, not a bigger band (a bigger band just eats shelves
            // instead, as measured above). This fill helps ordinary/moderate
            // coastlines, which is most of them.
            const COASTAL_BAND_M = 8;   // metres below sea level still treated as coast
            let coastalFill = hMeters < 0 && hMeters >= -COASTAL_BAND_M;
            // Steep-coast fill (2026-07-20, trench case): the 8m band only
            // catches coasts where the real profile passes THROUGH a shallow
            // depth on its way down. Cliff coasts (Andes/Peru-Chile trench:
            // +4000m to -5000m inside ~1-2 grid cells) skip straight over
            // that band — nothing in it, so the point drops out, same hole
            // as before, just narrower. Depth alone can't distinguish "deep
            // ocean cell next to a cliff" from "deep ocean cell in the open
            // Pacific" — but ADJACENCY can: sample this cell's 4 grid
            // neighbours' real elevation, and if this is ocean (hMeters<0,
            // not already filled) but ANY neighbour is land (>0), a
            // coastline boundary crosses between them right here, so fill
            // this cell at sea level regardless of how deep it actually is.
            // Only runs for cells the depth-band pass would otherwise still
            // drop (southShelf/coastalFill already true skip the extra
            // lookups), so the added cost is 4 getTrueElevation calls per
            // remaining skipped-ocean cell, not per grid cell overall.
            let cliffCoast = false;
            if (hMeters < 0 && !southShelf && !coastalFill) {
                const hN = getTrueElevation(x, z - cellH_L);
                const hS = getTrueElevation(x, z + cellH_L);
                const hE = getTrueElevation(x + cellW_L, z);
                const hW = getTrueElevation(x - cellW_L, z);
                cliffCoast = hN > 0 || hS > 0 || hE > 0 || hW > 0;
            }
            if (hMeters < 0 && !southShelf && !coastalFill && !cliffCoast) continue;  // skip open-ocean cells
            if (southShelf || coastalFill || cliffCoast) hMeters = 0;   // sea-level fill

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
            // Height now comes from the SHARED transform (terrainHeight.js). The
            // 'tall' formula is this worker's historical curve verbatim — 650 at low
            // elevation easing to 1100 at peaks >= 4000m, which reduces apparent
            // steepness on mountain faces so grid points cluster tighter. In LEGACY
            // mode that is exactly what runs, so the world view is unchanged.
            const finalY = landElevToUnits(hMeters, LAND_FORMULA) * VSCALE_LAND;

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
            // desertGlow 0.32 → 0.45 (2026-07-13 map-artist mission 2): deserts
            // rendered GREY — reading as missing data, not sand. Raw desert
            // pixels are bright but nearly achromatic, so the old warm nudges
            // were far too small — and the Natural Earth saturation (1.30)
            // amplifies what little chroma exists even less than 2.10 did.
            // Polar gate added same day: desertGlow had NO latitude gate and was
            // tinting the Antarctic/Greenland coasts tan (visible once the
            // hue-preserving ceiling stopped crushing warm tints to grey).
            const latAbsGate  = Math.abs(z) / (MAP_HEIGHT * 0.5);
            // 0.46 ≈ 63° true latitude (0.70 was ≈77° — useless as a gate).
            const notPolarLat = Math.min(1.0, Math.max(0.0, (0.46 - latAbsGate) / 0.06));
            const desertGlow = Math.pow(warmness, 1.5) * 0.45 * notPolarLat;
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
            // notPolarLat gate added (2026-07-13): (1 - polarIce) only damps 11%
            // at the Antarctic coast (polarIce ramps from 66°S, slowly) — bright
            // low-chroma coastal ice passed every other test and got warmed tan.
            // This was the surviving piece of the ORIGINAL 2026-06-21 diagnosis
            // ("polarIce engages too late"): real, but secondary to the cloud
            // slab + ice-shelf holes that dominated the visual.
            const aridGrey = Math.max(0.0, 0.26 - chroma)
                           * Math.max(0.0, brightness - 0.20)
                           * Math.max(0.0, 0.90 - brightness)
                           * (1.0 - polarIce)
                           * notPolarLat
                           * Math.max(0.0, 1.0 - hMeters / 4000.0)
                           * 10.0;
            satR += aridGrey * 0.35;
            satG += aridGrey * 0.10;
            satB -= aridGrey * 0.15;

            // ── Cloud-shadow healing (2026-07-13 map-artist mission 5) ────────
            // The composite mosaic has BAKED cloud shadows over the tropics
            // (Amazon/Congo/SE Asia) — dark achromatic smudges that render as
            // black blobs on the canopy. Verified live with Jamal: removing the
            // volumetric cloud layer did NOT remove them → source data. Detect
            // dark × colorless × tropical × lowland and heal toward deep canopy
            // green, weight capped so real texture partially survives.
            const tropicsW   = Math.min(1.0, Math.max(0.0, (0.16 - latAbsGate) / 0.05));
            const darkSmudge = Math.max(0.0, (0.30 - brightness) / 0.30)
                             * Math.max(0.0, (0.12 - chroma) / 0.12)
                             * Math.max(0.0, 1.0 - hMeters / 1500.0)
                             * tropicsW;
            const healW = Math.min(0.7, darkSmudge * 2.0);
            if (healW > 0.0) {
                if (rawB >= rawR) {
                    // COOL dark = water: rivers, channels, wetlands. Pull toward
                    // deep channel blue so drainage reads as visible threads
                    // (Jamal: "difficult to see the Amazon river"). Sediment-
                    // laden brown reaches have chroma → low healW → stay brown.
                    satR = satR * (1.0 - healW) + 0.05 * healW;
                    satG = satG * (1.0 - healW) + 0.14 * healW;
                    satB = satB * (1.0 - healW) + 0.28 * healW;
                } else {
                    // NEUTRAL/warm dark = baked cloud shadow: heal to canopy.
                    satR = satR * (1.0 - healW) + 0.10 * healW;
                    satG = satG * (1.0 - healW) + 0.26 * healW;
                    satB = satB * (1.0 - healW) + 0.10 * healW;
                }
            }

            const latAbs      = Math.abs(latNorm);
            // beltFadeIn 0.14 → 0.05 (2026-07-13): 0.14 in mercator-normalized
            // units is ~25°N — the belt EXCLUDED the southern half of the
            // Sahara (15–25°N), which is why only the northern rim warmed.
            // 0.05 ≈ 9°; the lush/chroma gates keep the equatorial band green.
            const beltFadeIn  = Math.min(1.0, Math.max(0.0, (latAbs - 0.05) / 0.06));
            // beltFadeOut 0.64 → 0.42 (2026-07-13): 0.64 mercator-normalized is
            // 74.7° LATITUDE, not 57° — the desert belt reached deep into
            // Antarctica and the sand blend was painting the polar coast tan.
            // 0.42 ≈ 60°; Patagonia's deserts (46-50°S ≈ 0.33-0.37) stay warm.
            const beltFadeOut = Math.min(1.0, Math.max(0.0, (0.42 - latAbs) / 0.06));
            const desertBelt  = beltFadeIn * beltFadeOut;
            const notLush     = Math.max(0.0, 1.0 - lushGlow * 4.0);
            const notAlpineG  = Math.max(0.0, 1.0 - hMeters / 3500.0);
            const notDark     = Math.max(0.0, brightness - 0.22);
            // Desert-belt warmth 1.8 → 2.6 — same geographic gates (belt
            // latitudes, not-lush, not-alpine, not-polar), stronger push.
            const geoWarm     = desertBelt * notLush * notAlpineG * notDark
                              * (1.0 - polarIce) * 2.6;
            satR += geoWarm * 0.16;
            satG += geoWarm * 0.08;
            satB -= geoWarm * 0.07;

            // ── SAND BLEND (2026-07-13 map-artist mission 2, iteration 3) ─────
            // The Sahara/Arabia problem: those pixels are BRIGHT and colorless
            // in the source mosaic, so (a) the aridGrey term's (0.90-brightness)
            // gate zeroed out — it was built for mid-bright steppe — and (b)
            // whiteSuppression then dimmed them into exactly the "missing data"
            // grey Jamal flagged. Detector: high brightness × low chroma ×
            // subtropical desert belt, minus lush/alpine/polar. Response: blend
            // decisively toward real sand (tan/ochre), don't nudge.
            const lowChroma  = Math.max(0.0, (0.30 - chroma) / 0.30);
            const brightArid = Math.max(0.0, (brightness - 0.45) / 0.55);
            const sandW      = Math.min(0.8,
                desertBelt * notLush * notAlpineG * (1.0 - polarIce)
                * lowChroma * brightArid * 2.2);
            satR = satR * (1.0 - sandW) + 0.78 * sandW;
            satG = satG * (1.0 - sandW) + 0.63 * sandW;
            satB = satB * (1.0 - sandW) + 0.42 * sandW;

            const topoRatio  = Math.min(1.0, Math.max(0.0, hMeters / 2500.0));
            const snowGlow   = topoRatio * Math.pow(brightness, 3.0) * 0.22;
            // iceShimmer coefficient reduced 0.90→0.30 to prevent polar blowout.
            // Antarctic/Arctic regions stay bright white but no longer clip to 1.0.
            const iceShimmer = Math.min(polarIce * polarIce * brightness * 0.30, 0.25);

            const polarCap = 1.0 - polarIce * 0.18;
            let r = Math.min(polarCap, Math.max(0.0, satR + snowGlow * 0.65 + iceShimmer * 0.94));
            let g = Math.min(polarCap, Math.max(0.0, satG + snowGlow * 0.80 + iceShimmer * 0.97));
            let b = Math.min(polarCap, Math.max(0.0, satB + snowGlow * 1.00 + iceShimmer * 1.00));

            // ── Polar desaturation (2026-07-13, last piece of the tan-rim fix) ──
            // The Antarctic coastal mosaic contains genuinely WARM pixels
            // (exposed rock/moraine + mosaic artifacts). The old channel-min
            // ceiling crushed them to grey by accident; once hue survived, the
            // rim went tan. No warm-term gate can fix source data — so pull
            // everything south of ~62°S toward cool luminance ice.
            // SOUTH-ONLY (z > 0): 0.44 ≈ 62°S true latitude. Northern tundra at
            // 62-70°N is genuinely green in summer — must not be desaturated.
            const polarDesat = z > 0
                ? Math.min(1.0, Math.max(0.0, (latAbsGate - 0.44) / 0.06))
                : 0.0;
            if (polarDesat > 0.0) {
                const lum = 0.299 * r + 0.587 * g + 0.114 * b;
                r += (lum * 0.96 - r) * polarDesat;
                g += (lum * 1.00 - g) * polarDesat;
                b += (lum * 1.10 - b) * polarDesat;
            }

            // ── Surface normal ────────────────────────────────────────────────
            // Micro-relief boost (2026-07-13 map-artist mission 5): lowland
            // basins (Amazon, Congo, steppes) have gradients so small the
            // hillshade gets no signal — vast areas read as smooth felt. Scale
            // up gradients ONLY where terrain is near-flat (boost fades out by
            // steepness ≈ 0.25 so mountains keep their true proportions). This
            // surfaces drainage textures and subtle undulation as visible grain.
            // 2.5 → 1.6 (2026-07-13): 2.5 amplified DEM noise in lowlands into
            // shading speckle — part of the mid-zoom grain complaint. 1.6 keeps
            // drainage texture visible without the salt-and-pepper.
            const microBoost = 1.0 + 1.6 * Math.exp(-steepness * 12.0);
            let nx = -gradX * microBoost, ny = 1.0, nz = -gradZ * microBoost;
            const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (nLen > 0.0) { nx /= nLen; ny /= nLen; nz /= nLen; }

            // ── Write ─────────────────────────────────────────────────────────
            positions[count * 3]     = x;
            positions[count * 3 + 1] = finalY + curveY;
            positions[count * 3 + 2] = z;
            colors[count * 3]     = q8(r);
            colors[count * 3 + 1] = q8(g);
            colors[count * 3 + 2] = q8(b);
            const jitter = prng() * (0.08 * (1.0 - steepness * 0.85));
            sizes[count]   = Math.max(0.18, 0.20 + steepness * 0.32 + latFactor * 0.22) + jitter;
            heights[count] = finalY;
            normals[count * 3]     = nx;
            normals[count * 3 + 1] = ny;
            normals[count * 3 + 2] = nz;
            ridges[count]  = q8(steepness);
            count++;
        }
    }

    // ════════════════════════════════════════════════════════════════════════════
    // OCEAN PASS — coarse grid, land cells skipped
    // ════════════════════════════════════════════════════════════════════════════
    const cellW_O = MAP_WIDTH  / OCEAN_GRID;
    const cellH_O = MAP_HEIGHT / OCEAN_GRID;

    oceanLoop:
    for (let row = 0; row < OCEAN_GRID; row++) {
        for (let col = 0; col < OCEAN_GRID; col++) {
            if (count >= MAX_ALLOC) {
                if (!overflowWarned) {
                    console.warn(`[terrainWorker] MAX_ALLOC (${MAX_ALLOC.toLocaleString()}) hit during OCEAN pass — some ocean splats dropped. Lower SPLAT_LAND_GRID/SPLAT_OCEAN_GRID or raise MAX_ALLOC.`);
                    overflowWarned = true;
                }
                break oceanLoop;
            }

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
            // "Deep stage" palette (2026-07-13 map-artist mission 3): same band
            // structure ~25% deeper/darker so ocean is a calm backdrop and the
            // DATA (vessels/alerts, all cyan-family) is the brightest thing on
            // screen. Endpoints stay continuous. MUST match terrainBuilder's
            // createSolidOceanFloor bands exactly.
            // ── DEPTH → COLOUR (rebuilt 2026-07-27) ──────────────────────────────
            // Depth is now carried mainly by HUE; brightness is left free to carry FORM.
            //
            // The previous ramp held saturation at 93-96% and varied hue by only 15 deg
            // across 10 km of depth — one colour dimmed, not a colour ramp. Two problems:
            //
            //   1. It looked generated. Real shallows are DESATURATED (sediment and
            //      chlorophyll), not electric — and the land beside it is natural-colour
            //      satellite imagery, so the two halves of the map were built on opposite
            //      philosophies.
            //   2. More seriously, depth and relief were fighting over the same channel.
            //      Hillshade works by modulating brightness, and the old ramp left only 5%
            //      value at hadal depth — a 30% shading darkening there lands at 3.5%,
            //      invisible. The deepest trench walls could not read no matter how good
            //      the geometry was.
            //
            // Hue now rotates 176 deg (coastal teal) -> 264 deg (violet-black), following
            // the order water actually absorbs light: red first, then orange, then green.
            // Not photoreal — the seafloor below ~200 m is unlit, and strictly "realistic"
            // would be black — but principled rather than arbitrary, which is what a
            // bathymetric chart wants.
            //
            // Value floor raised 5% -> 17%: 3.4x more brightness headroom for relief at
            // hadal depth, 1.7x at 6 km.
            //
            // MUST match the other copy exactly (terrainBuilder.createSolidOceanFloor <->
            // terrainWorker). Change both together or the floor mesh and the splat cloud
            // disagree at the seam.
            if (d < 200) {
                // Shelf — coastal teal, low saturation (sediment + chlorophyll).
                const t = d / 200;
                r = 0.279 - t * 0.102;   // 0.279 -> 0.177
                g = 0.620 - t * 0.192;   // 0.620 -> 0.428
                b = 0.597 - t * 0.077;   // 0.597 -> 0.520
            } else if (d < 2000) {
                // Slope — teal rotating into true blue.
                const t = (d - 200) / 1800;
                r = 0.177 - t * 0.109;   // 0.177 -> 0.068
                g = 0.428 - t * 0.266;   // 0.428 -> 0.162
                b = 0.520 - t * 0.140;   // 0.520 -> 0.380
            } else if (d < 6000) {
                // Abyss — blue into indigo.
                const t = (d - 2000) / 4000;
                r = 0.068 - t * 0.014;   // 0.068 -> 0.054
                g = 0.162 - t * 0.123;   // 0.162 -> 0.039
                b = 0.380 - t * 0.120;   // 0.380 -> 0.260
            } else {
                // Hadal — indigo into violet. RED RISES here: that is the hue rotating
                // past blue toward violet, not a sign error.
                const t = Math.min(1.0, (d - 6000) / 5000);
                r = 0.054 + t * 0.043;   // 0.054 -> 0.097
                g = 0.039 + t * 0.009;   // 0.039 -> 0.048
                b = 0.260 - t * 0.090;   // 0.260 -> 0.170
            }

            // ── Write ─────────────────────────────────────────────────────────
            positions[count * 3]     = x;
            positions[count * 3 + 1] = finalY + curveY;
            positions[count * 3 + 2] = z;
            colors[count * 3]     = q8(r);
            colors[count * 3 + 1] = q8(g);
            colors[count * 3 + 2] = q8(b);
            sizes[count]   = 0.28;
            heights[count] = finalY;
            normals[count * 3]     = 0.0;
            normals[count * 3 + 1] = 1.0;
            normals[count * 3 + 2] = 0.0;
            ridges[count]  = 0;
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
