// routeLayer.js — the 3D STM route layer: centreline, XTD corridor, waypoints.
//
// A thin THREE wrapper. Every number that could be wrong lives in routeRibbon.js
// (pure, no THREE, tested in plain Node); this file only turns those arrays into
// BufferGeometry and keeps one uniform up to date.
//
// ── WHY THE CORRIDOR IS A SHADER AND NOT PLAIN GEOMETRY ─────────────────────
// The corridor's on-screen width has to change with camera distance: legible at
// world view, geometrically true close in (see routeRibbon's header and
// STM.CORRIDOR_MIN_PX). Rebuilding the ribbon every frame to do that is exactly
// the "creating geometry in update()" failure CLAUDE.md lists under "FPS drops
// on map load". So each vertex instead stores its centreline position, a unit
// perpendicular and its TRUE half-width, and the vertex shader computes
//
//     position + aPerp * aWidth * uExag
//
// Changing zoom is then a single uniform write per route. No rebuild, ever.
//
// A plain ShaderMaterial is used rather than onBeforeCompile deliberately:
// CLAUDE.md records that waterManager's vertex shader silently never compiled
// for months because of hook ordering in the onBeforeCompile chunks. There is no
// hook order to get wrong here.
//
// ── BLOOM ───────────────────────────────────────────────────────────────────
// bloomPass.threshold is 0.95 and CLAUDE.md calls it a hairpin. Every material
// here is unlit and translucent — no emissive, no lights, no MeshStandardMaterial
// — so a full-length ribbon across the map cannot tip the bloom pass.
//
// Layer wiring follows the shipped convention: a `.lp-row[data-layer="routes"]`
// in index.html dispatches `layerToggle`, and main.js's switch calls setVisible.
//
// Debug: window.vg1RouteLayer

import * as THREE from 'three';
import { STM } from './config.js';
import { voyagePlanStore } from './voyagePlanStore.js';
import { isSynthetic } from './scenarioRoute.js';
import {
    buildRouteRibbon, ribbonIndices, pixelsPerSceneUnit, corridorExaggeration,
} from './routeRibbon.js';

const CORRIDOR_VERT = `
    attribute vec3 aPerp;
    attribute float aWidth;
    uniform float uExag;
    void main() {
        vec3 p = position + aPerp * (aWidth * uExag);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    }
`;

const CORRIDOR_FRAG = `
    precision mediump float;
    uniform vec3 uColor;
    uniform float uOpacity;
    void main() {
        // Flat, unlit, below the bloom threshold by construction.
        gl_FragColor = vec4(uColor, uOpacity);
    }
`;

function corridorMaterial(colorHex, opacity, { wireframe = false } = {}) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uExag:    { value: 1 },
            uColor:   { value: new THREE.Color(colorHex) },
            uOpacity: { value: opacity },
        },
        vertexShader: CORRIDOR_VERT,
        fragmentShader: CORRIDOR_FRAG,
        transparent: true,
        depthWrite: false,          // translucent overlay — never occlude vessels
        side: THREE.DoubleSide,     // the ribbon is viewed from above and below
        wireframe,
    });
}

export class RouteLayer {
    /**
     * @param {THREE.Scene} scene
     * @param {object} [opts] { store } — the plan source, injected for testability
     */
    constructor(scene, opts = {}) {
        this.scene = scene;
        this.store = opts.store ?? voyagePlanStore;

        this.group = new THREE.Group();
        this.group.name = 'stm-routes';
        this.group.renderOrder = 3;
        if (scene) scene.add(this.group);

        /** uvid → { root, materials[], centroid, maxHalfWidthUnits, state } */
        this._routes = new Map();
        this._waypointMesh = null;
        this._dirty = true;
        this._enabled = true;

        // Tier 1: the store announces, the layer reacts. It does not poll.
        this._onPlanChanged = () => { this._dirty = true; };
        if (typeof window !== 'undefined') {
            for (const ev of ['vg1:voyagePlanReceived', 'vg1:voyagePlanRemoved',
                              'vg1:voyagePlanExpired', 'vg1:voyagePlanEvicted']) {
                window.addEventListener(ev, this._onPlanChanged);
            }
            window.vg1RouteLayer = this;   // Tier 3 debug handle only
        }
    }

    // ── layer contract ───────────────────────────────────────────────────────

    setVisible(on) {
        this._enabled = !!on;
        this.group.visible = this._enabled;
    }

    get visible() { return this._enabled; }

    /**
     * How many vessels are being monitored. The route panel MUST show this
     * against the total vessel count: a map where 12 ships have route ribbons
     * and 400 do not is a map where 400 ships are UNKNOWN, not compliant, and an
     * operator will read bare water as "fine" unless told otherwise
     * (docs/STM_ROUTE_SPEC.md §5.8).
     */
    monitoredCount() { return this._routes.size; }

    /** Route colour by monitoring state. enhancedMonitor (1.6) drives this. */
    setRouteState(uvid, state) {
        const r = this._routes.get(String(uvid));
        if (!r || r.state === state) return;
        r.state = state;
        const color = new THREE.Color(
            state === 'DEVIATING' ? STM.ROUTE_COLORS.DEVIATING
            : r.synthetic ? STM.ROUTE_COLORS.SYNTHETIC
            : STM.ROUTE_COLORS.CENTRELINE);
        for (const m of r.materials) {
            if (m.uniforms?.uColor) m.uniforms.uColor.value.copy(color);
            else if (m.color) m.color.copy(color);
        }
    }

    // ── build ────────────────────────────────────────────────────────────────

    /** Force a rebuild on the next update(). */
    invalidate() { this._dirty = true; }

    _clear() {
        for (const [, r] of this._routes) {
            this.group.remove(r.root);
            r.root.traverse(o => {
                if (o.geometry) o.geometry.dispose();
                if (o.material) (Array.isArray(o.material) ? o.material : [o.material])
                    .forEach(m => m.dispose());
            });
        }
        this._routes.clear();
        if (this._waypointMesh) {
            this.group.remove(this._waypointMesh);
            this._waypointMesh.geometry.dispose();
            this._waypointMesh.material.dispose();
            this._waypointMesh = null;
        }
    }

    /**
     * Rebuild all route geometry from the store. Event-driven, never per frame.
     * Only MONITORED plans are drawn — a plan at status 2 is an intention nobody
     * is executing, and drawing it would imply a ship is following it.
     */
    rebuild() {
        this._clear();
        const plans = this.store.monitored();
        const waypointPositions = [];

        for (const plan of plans) {
            const built = buildRouteRibbon(plan);
            if (!built.ok) continue;

            const synthetic = isSynthetic(plan);
            const root = new THREE.Group();
            root.name = `route:${plan.uvid ?? plan.routeName ?? 'unnamed'}`;
            const materials = [];

            // A corridor drawn from OUR default rather than the ship's declared
            // XTD is rendered fainter — "we assumed this" has to be visible, not
            // merely recorded in a parse report nobody opens.
            const opacityScale = built.usedDefaultXtd ? STM.DEFAULTED_OPACITY_SCALE : 1;
            const baseColor = synthetic ? STM.ROUTE_COLORS.SYNTHETIC : STM.ROUTE_COLORS.CENTRELINE;

            let cx = 0, cy = 0, cz = 0, n = 0;

            for (const seg of built.segments) {
                const { count, centre, perp, portW, stbdW } = seg;

                // ── corridor ribbon: two rim vertices per station ─────────────
                const pos = new Float32Array(count * 2 * 3);
                const nrm = new Float32Array(count * 2 * 3);
                const wid = new Float32Array(count * 2);
                for (let i = 0; i < count; i++) {
                    for (const [k, sign] of [[0, -1], [1, 1]]) {   // 0 = port, 1 = starboard
                        const v = i * 2 + k;
                        pos[v * 3] = centre[i * 3];
                        pos[v * 3 + 1] = centre[i * 3 + 1];
                        pos[v * 3 + 2] = centre[i * 3 + 2];
                        nrm[v * 3] = perp[i * 3];
                        nrm[v * 3 + 1] = perp[i * 3 + 1];
                        nrm[v * 3 + 2] = perp[i * 3 + 2];
                        wid[v] = sign * (sign < 0 ? portW[i] : stbdW[i]);
                    }
                    cx += centre[i * 3]; cy += centre[i * 3 + 1]; cz += centre[i * 3 + 2]; n++;
                }

                const ribbonGeo = new THREE.BufferGeometry();
                ribbonGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
                ribbonGeo.setAttribute('aPerp', new THREE.BufferAttribute(nrm, 3));
                ribbonGeo.setAttribute('aWidth', new THREE.BufferAttribute(wid, 1));
                ribbonGeo.setIndex(new THREE.BufferAttribute(ribbonIndices(count), 1));

                const ribbonMat = corridorMaterial(
                    STM.ROUTE_COLORS.CORRIDOR, STM.CORRIDOR_OPACITY * opacityScale);
                const ribbon = new THREE.Mesh(ribbonGeo, ribbonMat);
                ribbon.frustumCulled = false;   // vertices move in the shader
                root.add(ribbon);
                materials.push(ribbonMat);

                // ── corridor rims: the two edges of the declared corridor ─────
                for (const [side, widths] of [['port', portW], ['stbd', stbdW]]) {
                    const rw = new Float32Array(count);
                    for (let i = 0; i < count; i++) rw[i] = (side === 'port' ? -1 : 1) * widths[i];
                    const g = new THREE.BufferGeometry();
                    g.setAttribute('position', new THREE.BufferAttribute(centre.slice(), 3));
                    g.setAttribute('aPerp', new THREE.BufferAttribute(perp.slice(), 3));
                    g.setAttribute('aWidth', new THREE.BufferAttribute(rw, 1));
                    const m = corridorMaterial(
                        STM.ROUTE_COLORS.CORRIDOR_RIM, 0.45 * opacityScale);
                    const line = new THREE.Line(g, m);
                    line.frustumCulled = false;
                    root.add(line);
                    materials.push(m);
                }

                // ── centreline: the route axis, drawn at TRUE position ────────
                // No exaggeration applies — the axis is the axis. Only the
                // corridor around it is scaled for legibility.
                const axisGeo = new THREE.BufferGeometry();
                axisGeo.setAttribute('position', new THREE.BufferAttribute(centre.slice(), 3));
                const axisMat = new THREE.LineBasicMaterial({
                    color: new THREE.Color(baseColor),
                    transparent: true,
                    opacity: STM.CENTRELINE_OPACITY,
                    depthWrite: false,
                });
                root.add(new THREE.Line(axisGeo, axisMat));
                materials.push(axisMat);
            }

            for (const w of built.waypoints) waypointPositions.push(w);

            this.group.add(root);
            this._routes.set(String(plan.uvid ?? root.name), {
                root, materials, synthetic,
                maxHalfWidthUnits: built.maxHalfWidthUnits,
                usedDefaultXtd: built.usedDefaultXtd,
                centroid: n ? new THREE.Vector3(cx / n, cy / n, cz / n) : new THREE.Vector3(),
                state: 'ON_TRACK',
            });
        }

        // ── waypoints: ONE Points object for the whole layer ─────────────────
        //
        // Points with sizeAttenuation:false, NOT instanced meshes. A waypoint is
        // a zero-dimensional thing — it has a position and a turn radius, but no
        // extent — so any scene-space size given to its marker is a fiction, and
        // the first version of this layer chose 0.18 units, which is THIRTEEN
        // NAUTICAL MILES across. At full zoom that pip was 23× wider than the
        // very corridor it was supposed to annotate, and it hid it completely.
        // A constant PIXEL size is the honest answer: the marker says "a waypoint
        // is here" and claims nothing about size. Same reasoning as
        // STM.CORRIDOR_MIN_PX, one step further.
        if (waypointPositions.length) {
            const pos = new Float32Array(waypointPositions.length * 3);
            waypointPositions.forEach((w, i) => {
                pos[i * 3] = w.x; pos[i * 3 + 1] = w.y; pos[i * 3 + 2] = w.z;
            });
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            const mat = new THREE.PointsMaterial({
                color: new THREE.Color(STM.ROUTE_COLORS.WAYPOINT),
                size: STM.WAYPOINT_PIP_PX,
                sizeAttenuation: false,      // constant on screen at every zoom
                transparent: true,
                opacity: 0.9,
                depthWrite: false,
            });
            const pts = new THREE.Points(geo, mat);
            pts.frustumCulled = false;
            pts.name = 'stm-waypoints';
            this._waypointMesh = pts;
            this.group.add(pts);
        }

        this._dirty = false;
        return this._routes.size;
    }

    // ── per-frame ────────────────────────────────────────────────────────────

    /**
     * Cheap. Rebuilds only when a plan actually changed; otherwise writes one
     * uniform per route. No geometry, no allocation, no DOM.
     *
     * @param {THREE.Camera} camera
     * @param {number} viewportH renderer drawing-buffer height in pixels
     */
    update(camera, viewportH) {
        if (this._dirty) this.rebuild();
        if (!this._enabled || !camera || !this._routes.size) return;

        const fov = camera.fov ?? 50;
        for (const [, r] of this._routes) {
            const dist = camera.position.distanceTo(r.centroid);
            const pxPerUnit = pixelsPerSceneUnit(viewportH, fov, dist);
            const exag = corridorExaggeration(r.maxHalfWidthUnits, pxPerUnit);
            for (const m of r.materials) {
                if (m.uniforms?.uExag) m.uniforms.uExag.value = exag;
            }
            r.exaggeration = exag;
        }
    }

    /** Current exaggeration for a route — the UI discloses this to the operator. */
    exaggerationFor(uvid) { return this._routes.get(String(uvid))?.exaggeration ?? null; }

    /** Scene-space centroid of a route, for camera framing. Null if unknown. */
    centroidOf(uvid) {
        const c = this._routes.get(String(uvid))?.centroid;
        return c ? c.clone() : null;
    }

    /** Every drawn route's uvid, in draw order. */
    uvids() { return [...this._routes.keys()]; }

    dispose() {
        this._clear();
        if (this.scene) this.scene.remove(this.group);
        if (typeof window !== 'undefined') {
            for (const ev of ['vg1:voyagePlanReceived', 'vg1:voyagePlanRemoved',
                              'vg1:voyagePlanExpired', 'vg1:voyagePlanEvicted']) {
                window.removeEventListener(ev, this._onPlanChanged);
            }
            if (window.vg1RouteLayer === this) delete window.vg1RouteLayer;
        }
    }
}
