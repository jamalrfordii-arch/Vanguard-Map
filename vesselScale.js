// vesselScale.js — how big a vessel should render, given how close you are.
//
// THE PROBLEM (measured 2026-07-25, live at z10):
//   hull template longest axis      3.4 scene units at scale 1
//   median instance scale           0.0844
//   → rendered length               0.287 units = 38 KILOMETRES
//   true length of a 200m ship      0.0015 units
//   → exaggeration                  192x
//
// At world view that is not just defensible, it's necessary: MAP_WIDTH=300 spans
// the planet's full circumference, so one scene unit is 133.58 km and a real ship
// is ~0.0015 units — invisible. The fleet has to be legible to be useful, and
// config.js SHIP_RENDER documents that choice honestly.
//
// What changed is the CAMERA. That reasoning was written (2026-07-23) while the
// camera was capped at z9 / minDistance 2.3. Now it descends to ~1.15 with real
// photographic terrain underneath, and a 38 km ship sits across an entire island.
// The exaggeration didn't get worse; the context did.
//
// THE FIX: stop expressing the exaggeration as a constant, and express the thing
// we actually care about instead — "a vessel must never be smaller than MIN_PX
// pixels on screen". Then:
//
//   • Far away  → the pixel floor demands more than true scale, so we clamp to the
//                 EXISTING proportional scale and behaviour is bit-for-bit as it is
//                 today. World and regional views do not change at all.
//   • Close in  → true scale is affordable-ish, so the ship shrinks toward reality
//                 and bottoms out at MIN_PX instead of at 192x.
//
// One tunable, and it means something you can look at ("ships never get smaller
// than N pixels") rather than an opaque multiplier. It is also self-correcting: if
// MAP_WIDTH or the camera limits ever change, the right size falls out of the maths
// instead of needing a re-tune.

/** Scene units per kilometre. MAP_WIDTH(300) spans the equatorial circumference. */
export const KM_PER_SCENE_UNIT = 40075 / 300;   // 133.58

/**
 * Pixels per scene unit for an object `dist` in front of a perspective camera.
 * Standard projection: the vertical extent visible at `dist` is
 * 2*dist*tan(fov/2), and that maps onto viewportH pixels.
 */
export function pixelsPerSceneUnit(viewportH, fovDeg, dist) {
    if (!(dist > 0) || !(viewportH > 0)) return 0;
    return viewportH / (2 * dist * Math.tan((fovDeg * Math.PI / 180) / 2));
}

/** True on-screen size of a real hull, in scene units (no exaggeration at all). */
export function trueScaleFor(lengthM, hullUnits) {
    if (!(lengthM > 0) || !(hullUnits > 0)) return 0;
    return (lengthM / 1000 / KM_PER_SCENE_UNIT) / hullUnits;
}

/**
 * Final instance scale for one vessel.
 *
 * @param baseScale  today's proportional scale (aisManager's v.renderScale) — the
 *                   CEILING. This function only ever shrinks a vessel, never grows
 *                   one, which is what guarantees the far view is untouched.
 * @param lengthM    real hull length in metres
 * @param pxPerUnit  from pixelsPerSceneUnit(), at this vessel's distance
 * @param minPx      on-screen floor: never render shorter than this
 * @param hullUnits  longest axis of the hull template at scale 1 (measured: 3.4)
 */
export function vesselRenderScale(baseScale, lengthM, pxPerUnit, minPx, hullUnits) {
    if (!(baseScale > 0)) return 0;
    // No usable view info (off-screen, degenerate camera) → leave it alone rather
    // than guess. Silently returning 0 here would make the fleet vanish.
    if (!(pxPerUnit > 0) || !(hullUnits > 0)) return baseScale;

    const trueScale = trueScaleFor(lengthM, hullUnits);
    // Scale at which this hull renders exactly minPx tall.
    const floorScale = minPx / (hullUnits * pxPerUnit);
    // Physically correct if that is already big enough to see; otherwise the floor.
    const wanted = Math.max(trueScale, floorScale);
    // Never exceed today's size. Without this the floor would INFLATE distant
    // vessels far beyond their current look, which is a regression in the one
    // regime that was never broken.
    return Math.min(baseScale, wanted);
}

/** On-screen floor for a rendered hull, in pixels. Shared so shipInstancer and
 *  every marker that must sit UNDER a ship agree on how big that ship actually is. */
export const HULL_MIN_PX = 12;

/**
 * The scale a vessel is ACTUALLY rendered at, from its base (proportional) scale.
 *
 * EXISTS BECAUSE (2026-07-25): vesselRenderScale was applied privately inside
 * shipInstancer.update() and never written back, so `userData.renderScale` still
 * held the BASE value. Markers sized from it therefore used the un-reduced scale
 * and did not shrink at all — measured k=1.0000 at every distance, i.e. the
 * marker fix silently did nothing. Anything that needs to sit under a ship must
 * ask the same question the instancer asks, so it lives here rather than being
 * re-derived per caller.
 *
 * Hull length is recovered from the base scale exactly as the instancer does:
 * aisManager built it as BASELINE_SCALE * (lengthM / REFERENCE_LENGTH_M).
 */
export function effectiveShipScale(baseScale, pxPerUnit, hullUnits,
                                   baselineScale, referenceLengthM, minPx = HULL_MIN_PX) {
    if (!(baseScale > 0)) return 0;
    const lengthM = referenceLengthM * (baseScale / baselineScale);
    return vesselRenderScale(baseScale, lengthM, pxPerUnit, minPx, hullUnits);
}

/**
 * Size for a vessel's ground-shadow / marker sprite.
 *
 * THE PROBLEM (2026-07-25): `shadowSprite.scale.set(5, 5, 1)` — a FIXED 5 scene
 * units, which is ~668 km, set once at construction and never touched again. At
 * world view that is 17x the length of the ship it belongs to; at z12 it covers
 * the screen. Measured live: sprites at scale 5 sitting 0.33 units from the
 * camera, an apparent size 15x the viewing distance. Same failure as the hull
 * scale itself — a world-space constant chosen at one zoom, used at all of them.
 *
 * The marker has two jobs that pull in opposite directions, so it needs both
 * bounds rather than one constant:
 *   • FAR — be findable. A true-to-life shadow is invisible, so a pixel floor.
 *   • CLOSE — belong to its ship. Sitting UNDER the vessel, not swallowing it,
 *     which means proportional to the rendered hull.
 *
 * @param shipRenderScale  the vessel's final instance scale (vesselRenderScale)
 * @param hullUnits        hull template length at scale 1 (measured 3.4)
 * @param pxPerUnit        from pixelsPerSceneUnit(), at this vessel's distance
 * @param hullRatio        marker size as a multiple of rendered hull length
 * @param minPx            never smaller than this on screen
 * @param cap              never larger than this (the legacy constant, 5)
 */
export function vesselMarkerScale(shipRenderScale, hullUnits, pxPerUnit,
                                  hullRatio = 2.5, minPx = 40, cap = 5) {
    if (!(pxPerUnit > 0) || !(hullUnits > 0) || !(shipRenderScale > 0)) return cap;
    const hullLenUnits = hullUnits * shipRenderScale;
    const wanted = Math.max(hullRatio * hullLenUnits, minPx / pxPerUnit);
    // Clamped to `cap` so the far view can only ever shrink, never grow — the
    // same one-way guarantee that makes the hull clamp safe to apply blindly.
    return Math.min(cap, wanted);
}
