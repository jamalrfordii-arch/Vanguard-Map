// lightningManager.js — Atmospheric lightning strike visualization
//
// Data sources (real-time, free / low-cost):
//   • Blitzortung.org — community-driven global lightning detection network
//     WebSocket: ws://ws.blitzortung.org  (real-time strike events)
//     HTTP JSON: https://map.blitzortung.org/GEOjson/Data/  (recent strikes)
//   • WWLLN (World Wide Lightning Location Network) — academic, request access
//   • GLM (Geostationary Lightning Mapper) via NASA Earthdata — satellite-based
//   • Vaisala GLD360 — commercial, global coverage (requires license)
//
// Visual design:
//   • Each lightning strike rendered as an instanced mesh (vertical bolt quad)
//   • Bright white-blue core with HDR bloom pickup
//   • Random fork geometry via UV-driven procedural shader noise
//   • Strike flash decays over ~0.4s, then instance is recycled
//   • Subtle ground illumination disc beneath each active strike
//   • Fades out below camera y=30 (atmospheric layer convention)
//
// Architecture:
//   constructor  → initialise state, set up event listeners
//   init(scene)  → register layer, build instanced geometry, start data fetch
//   _fetchData() → poll Blitzortung HTTP endpoint for recent strikes
//   _addStrike() → claim a free instance slot, set position + timing
//   update(cam, dt) → animate active strikes (flash decay), apply altitude fade
//   dispose()    → tear down geometry, materials, timers, listeners

import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT, LIGHTNING } from './config.js';

// ── Module-scope scratch variables (zero allocation in update) ────────────────
const _scratchVec3A = new THREE.Vector3();
const _scratchVec3B = new THREE.Vector3();
const _scratchColor = new THREE.Color();
const _scratchMat4  = new THREE.Matrix4();
const _scratchQuat  = new THREE.Quaternion();
const _scratchScale = new THREE.Vector3();

// ── Coordinate conversion: WGS-84 → scene space ──────────────────────────────
function _toScene(lon, lat) {
    const x    = (lon / 180.0) * (MAP_WIDTH / 2.0);
    const latR = lat * (Math.PI / 180.0);
    const mercY = Math.log(Math.tan(Math.PI / 4.0 + latR / 2.0));
    const z    = -(mercY / Math.PI) * (MAP_HEIGHT / 2.0);
    return { x, z };
}

// ── Strike pool entry ─────────────────────────────────────────────────────────
// Each slot tracks lifetime so we can recycle instances without GC pressure.
function _makeSlot() {
    return {
        active: false,
        age:    0,         // seconds since strike fired
        lon:    0,
        lat:    0,
        intensity: 1.0,    // 0–1 normalised current (kA mapped)
    };
}

export class LightningManager {

    /**
     * Create a new LightningManager.
     * Does NOT touch the scene — call init(scene) once the scene is ready.
     */
    constructor() {
        // ── State ─────────────────────────────────────────────────────────────
        this._visible       = LIGHTNING.DEFAULT_ON;
        this._group         = null;        // THREE.Group — root node
        this._boltMesh      = null;        // THREE.InstancedMesh — bolt quads
        this._flashMesh     = null;        // THREE.InstancedMesh — ground flash discs
        this._material      = null;        // bolt ShaderMaterial
        this._flashMaterial = null;        // ground disc ShaderMaterial
        this._scene         = null;

        // Instance pool
        this._maxStrikes    = LIGHTNING.MAX_STRIKES;
        this._slots         = [];
        for (let i = 0; i < this._maxStrikes; i++) {
            this._slots.push(_makeSlot());
        }
        this._nextSlot      = 0;          // round-robin pointer

        // Data polling
        this._fetchTimer    = null;
        this._lastFetchMs   = 0;

        // Fade uniform — shared by both materials
        this._uFade         = { value: 1.0 };
        this._uTime         = { value: 0.0 };

        // ── Layer toggle listener ─────────────────────────────────────────────
        this._onLayerChanged = this._onLayerChanged.bind(this);
        window.addEventListener('vg1:layerChanged', this._onLayerChanged);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // PUBLIC
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Initialise the layer: register with layerManager, build geometry,
     * start data polling.
     * @param {THREE.Scene} scene — the main Three.js scene
     */
    init(scene) {
        this._scene = scene;

        // ── Register with the layer system ────────────────────────────────────
        if (window.layerManager) {
            window.layerManager.register({
                id:        'lightning',
                label:     'Lightning Strikes',
                category:  'atmosphere',
                defaultOn: LIGHTNING.DEFAULT_ON,
            });
        }

        // ── Build scene graph ─────────────────────────────────────────────────
        this._group = new THREE.Group();
        this._group.name = 'lightning-layer';
        this._group.visible = this._visible;
        scene.add(this._group);

        this._buildBoltMesh();
        this._buildFlashMesh();

        // ── Kick off data fetch loop ──────────────────────────────────────────
        this._fetchData();
        this._fetchTimer = setInterval(() => this._fetchData(), LIGHTNING.REFRESH_MS);
    }

    /**
     * Per-frame update — animate active strikes, decay flashes, apply altitude fade.
     * MUST NOT allocate any THREE objects.
     * @param {THREE.Camera} camera — current camera (camera.position.y drives fade)
     * @param {number} dt — delta time in seconds
     */
    update(camera, dt) {
        if (!this._group) return;

        // ── Altitude fade ─────────────────────────────────────────────────────
        const camY = camera.position.y;
        if (camY >= LIGHTNING.FADE_START) {
            this._uFade.value = 1.0;
        } else if (camY <= LIGHTNING.FADE_END) {
            this._uFade.value = 0.0;
        } else {
            this._uFade.value = (camY - LIGHTNING.FADE_END) /
                                (LIGHTNING.FADE_START - LIGHTNING.FADE_END);
        }

        // Hide group entirely when fully faded
        this._group.visible = this._visible && this._uFade.value > 0.001;
        if (!this._group.visible) return;

        // ── Advance global time ───────────────────────────────────────────────
        this._uTime.value += dt;

        // ── Per-instance animation ────────────────────────────────────────────
        let anyDirty = false;

        for (let i = 0; i < this._maxStrikes; i++) {
            const slot = this._slots[i];
            if (!slot.active) continue;

            slot.age += dt;

            if (slot.age >= LIGHTNING.STRIKE_LIFETIME) {
                // ── Expire: hide instance by scaling to zero ──────────────────
                slot.active = false;
                _scratchMat4.makeScale(0, 0, 0);
                this._boltMesh.setMatrixAt(i, _scratchMat4);
                this._flashMesh.setMatrixAt(i, _scratchMat4);
                anyDirty = true;
                continue;
            }

            // ── Flash envelope: sharp attack, exponential decay ───────────────
            //   0–0.05s  ramp up
            //   0.05–end exponential fall
            const t = slot.age;
            const attackEnd = LIGHTNING.ATTACK_DURATION;
            let envelope;
            if (t < attackEnd) {
                envelope = t / attackEnd;
            } else {
                envelope = Math.exp(-(t - attackEnd) * LIGHTNING.DECAY_RATE);
            }

            const finalAlpha = envelope * slot.intensity;

            // ── Bolt instance matrix ──────────────────────────────────────────
            const pos = _toScene(slot.lon, slot.lat);
            const boltHeight = LIGHTNING.BOLT_HEIGHT * (0.6 + 0.4 * slot.intensity);

            _scratchScale.set(
                LIGHTNING.BOLT_WIDTH * (0.7 + 0.3 * finalAlpha),
                boltHeight * finalAlpha,
                LIGHTNING.BOLT_WIDTH * (0.7 + 0.3 * finalAlpha)
            );
            _scratchQuat.identity();
            _scratchVec3A.set(pos.x, LIGHTNING.BOLT_BASE_Y + boltHeight * 0.5 * finalAlpha, pos.z);
            _scratchMat4.compose(_scratchVec3A, _scratchQuat, _scratchScale);
            this._boltMesh.setMatrixAt(i, _scratchMat4);

            // ── Ground flash disc ─────────────────────────────────────────────
            const flashRadius = LIGHTNING.FLASH_RADIUS * finalAlpha * slot.intensity;
            _scratchScale.set(flashRadius, 1.0, flashRadius);
            _scratchVec3A.set(pos.x, LIGHTNING.FLASH_Y, pos.z);
            _scratchMat4.compose(_scratchVec3A, _scratchQuat, _scratchScale);
            this._flashMesh.setMatrixAt(i, _scratchMat4);

            // ── Per-instance color (alpha encodes flash intensity) ─────────────
            _scratchColor.setRGB(
                LIGHTNING.COLOR_R * finalAlpha,
                LIGHTNING.COLOR_G * finalAlpha,
                LIGHTNING.COLOR_B * finalAlpha
            );
            this._boltMesh.setColorAt(i, _scratchColor);

            _scratchColor.setRGB(
                LIGHTNING.FLASH_COLOR_R * finalAlpha * 0.5,
                LIGHTNING.FLASH_COLOR_G * finalAlpha * 0.5,
                LIGHTNING.FLASH_COLOR_B * finalAlpha * 0.5
            );
            this._flashMesh.setColorAt(i, _scratchColor);

            anyDirty = true;
        }

        if (anyDirty) {
            this._boltMesh.instanceMatrix.needsUpdate = true;
            this._flashMesh.instanceMatrix.needsUpdate = true;
            if (this._boltMesh.instanceColor)  this._boltMesh.instanceColor.needsUpdate = true;
            if (this._flashMesh.instanceColor) this._flashMesh.instanceColor.needsUpdate = true;
        }
    }

    /**
     * Tear down all GPU resources, remove listeners, clear timers.
     */
    dispose() {
        window.removeEventListener('vg1:layerChanged', this._onLayerChanged);

        if (this._fetchTimer) {
            clearInterval(this._fetchTimer);
            this._fetchTimer = null;
        }

        if (this._boltMesh) {
            this._boltMesh.geometry.dispose();
            this._boltMesh.material.dispose();
            this._group.remove(this._boltMesh);
            this._boltMesh = null;
        }

        if (this._flashMesh) {
            this._flashMesh.geometry.dispose();
            this._flashMesh.material.dispose();
            this._group.remove(this._flashMesh);
            this._flashMesh = null;
        }

        if (this._group && this._scene) {
            this._scene.remove(this._group);
            this._group = null;
        }

        this._material      = null;
        this._flashMaterial = null;
        this._scene         = null;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // PRIVATE — event handling
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Handle vg1:layerChanged events to toggle this layer's visibility.
     * @param {CustomEvent} e — detail: { id: string, visible: boolean }
     * @private
     */
    _onLayerChanged(e) {
        if (!e.detail || e.detail.id !== 'lightning') return;
        this._visible = !!e.detail.visible;
        if (this._group) {
            this._group.visible = this._visible && this._uFade.value > 0.001;
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // PRIVATE — geometry builders
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Build the instanced bolt mesh — thin vertical quads with a procedural
     * lightning shader. Instances start at scale 0 (hidden).
     * @private
     */
    _buildBoltMesh() {
        // A simple two-triangle quad oriented vertically (XY plane).
        // The shader will distort UVs to create fork shapes.
        const geo = new THREE.PlaneGeometry(1, 1, 1, LIGHTNING.BOLT_SEGMENTS);

        this._material = new THREE.ShaderMaterial({
            uniforms: {
                uFade: this._uFade,
                uTime: this._uTime,
            },
            vertexShader: /* glsl */ `
                attribute vec3 instanceColor;
                varying vec2 vUv;
                varying vec3 vInstanceColor;
                uniform float uFade;
                uniform float uTime;

                // Simple hash for per-vertex jitter
                float hash(float n) {
                    return fract(sin(n) * 43758.5453123);
                }

                void main() {
                    vUv = uv;
                    vInstanceColor = instanceColor;

                    // Lateral jitter along bolt based on height (uv.y)
                    vec3 pos = position;
                    float vertID = float(gl_InstanceID);
                    float jitter = hash(uv.y * 17.3 + vertID * 7.1 + uTime * 0.5);
                    pos.x += (jitter - 0.5) * 0.3 * uv.y;

                    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(pos, 1.0);
                    gl_Position = projectionMatrix * mvPosition;
                }
            `,
            fragmentShader: /* glsl */ `
                varying vec2 vUv;
                varying vec3 vInstanceColor;
                uniform float uFade;

                void main() {
                    // Core brightness — hot center, falloff to edges
                    float core = 1.0 - abs(vUv.x - 0.5) * 2.0;
                    core = pow(core, 3.0);

                    // Vertical fade — stronger at top (cloud), fades at bottom
                    float vertFade = smoothstep(0.0, 0.15, vUv.y) *
                                     smoothstep(1.0, 0.7, vUv.y);

                    float alpha = core * vertFade * uFade;

                    // HDR-ish