// oceanCurrentManager.js — GPGPU ocean current particle system
//
// Renders 65 536 luminous particles advected by a synthetic ocean current
// velocity field (Gulf Stream, subtropical gyres, equatorial bands, Antarctic
// Circumpolar Current).  The velocity field is computed analytically in GLSL —
// no external data file needed.  A _fetchData() stub is provided for future
// OSCAR / RTOFS integration.
//
// Architecture:
//   · GPUComputationRenderer ping-pong for particle advection (GPU-side)
//   · THREE.Points + custom ShaderMaterial for rendering
//   · Registered with layerManager under 'surface' category
//   · Communicates via vg1: CustomEvents — no imports from other managers
//
// Live tuning from DevTools:
//   window.oceanCurrentManager.setIntensity(0.5)   // dim / brighten particles
//   window.oceanCurrentManager.setCount(32768)      // halve particle count

import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';
import { MAP_WIDTH } from './config.js';

// ── Config ────────────────────────────────────────────────────────────────────
export const OCEAN_CURRENT = {
    TEXTURE_SIZE:      256,     // sqrt of particle count → 256² = 65 536 particles
    SPEED_SCALE:       0.08,    // scene units per frame — 0.08 moves ~18 units over lifetime
    PARTICLE_LIFETIME: 240,     // frames before a particle is respawned
    FADE_ALPHA:        0.93,
    BASE_OPACITY:      0.50,    // master particle opacity
    ALTITUDE:          0.3,     // Y above sea level — clears wave crests
    FADE_CAM_HI:       250,     // fully visible above this camera Y
    FADE_CAM_LO:       15,      // fully hidden below this camera Y
};

const TEX  = OCEAN_CURRENT.TEXTURE_SIZE;
const N    = TEX * TEX; // 65 536

// ── Velocity field GLSL ───────────────────────────────────────────────────────
// Returns ocean surface velocity (scene units / frame) at position (x, z).
// Composed of:
//   · Five subtropical gyres (N/S Atlantic, N/S Pacific, Indian Ocean)
//   · Gulf Stream + Kuroshio jets
//   · Equatorial westward currents + eastward countercurrent
//   · Antarctic Circumpolar Current
const VELOCITY_GLSL = /* glsl */`
// Gaussian-tapered vortex — positive strength = counter-clockwise (CCW)
// Southern Hemisphere subtropical gyres are CCW, Northern are CW (negative).
vec2 vortex(vec2 p, vec2 center, float strength, float radius) {
    vec2  d  = p - center;
    float r  = length(d) + 0.001;
    // Solid-body core rises with r, then falls off exponentially
    float s  = strength
             * (r / radius)
             * exp(-0.5 * (r * r) / (radius * radius));
    return vec2(-d.y, d.x) * s / r;
}

// Gaussian jet — flow along 'dir' with Gaussian cross-track falloff
vec2 jet(vec2 p, vec2 origin, vec2 dir, float speed, float width, float len) {
    vec2  perp      = vec2(-dir.y, dir.x);
    float along     = dot(p - origin, dir);
    float crossDist = dot(p - origin, perp);
    float inRange   = smoothstep(-5.0, 5.0, along)
                    * smoothstep(len + 5.0, len - 5.0, along);
    float profile   = exp(-crossDist * crossDist / (width * width));
    return dir * speed * profile * inRange;
}

vec2 oceanVelocity(vec2 p) {
    vec2 v = vec2(0.0);

    // ── Subtropical gyres ─────────────────────────────────────────────────
    // (center_x, center_z, strength, radius)
    // Northern gyres: CW → negative strength in right-hand coords
    v += vortex(p, vec2(-28.0, -44.0),  -0.28, 55.0);  // N. Atlantic
    v += vortex(p, vec2(-128.0, -40.0), -0.24, 60.0);  // N. Pacific
    // Southern gyres: CCW → positive strength
    v += vortex(p, vec2(-14.0,  30.0),   0.22, 48.0);  // S. Atlantic
    v += vortex(p, vec2(-100.0, 28.0),   0.20, 55.0);  // S. Pacific
    v += vortex(p, vec2(  72.0, 22.0),   0.18, 45.0);  // Indian Ocean

    // ── Gulf Stream ───────────────────────────────────────────────────────
    // Origin: ~Gulf of Mexico exit (lon -80, lat 25 → scene -66, -30)
    // Runs NE along US coast then swings east across Atlantic
    v += jet(p, vec2(-66.0, -30.0), normalize(vec2( 0.4,  -1.0)),  0.38, 5.0, 55.0);
    v += jet(p, vec2(-58.0, -50.0), normalize(vec2( 1.0,  -0.3)),  0.30, 6.0, 60.0);

    // ── Kuroshio Current ──────────────────────────────────────────────────
    // Origin: ~Philippines Sea (lon 127, lat 20 → scene 106, -24)
    // Runs north along Japan coast
    v += jet(p, vec2(106.0, -24.0), normalize(vec2(-0.2,  -1.0)),  0.32, 5.0, 50.0);
    v += jet(p, vec2(110.0, -55.0), normalize(vec2( 1.0,   0.0)),  0.22, 6.0, 40.0);

    // ── Equatorial currents ───────────────────────────────────────────────
    // North Equatorial (~lat 10°N → z ≈ -12): westward
    v += jet(p, vec2( 140.0, -12.0), vec2(-1.0, 0.0),              0.18, 7.0, 270.0);
    // South Equatorial (~lat 8°S → z ≈ +10): westward
    v += jet(p, vec2( 140.0,  10.0), vec2(-1.0, 0.0),              0.16, 7.0, 270.0);
    // Equatorial Countercurrent (~lat 5°N → z ≈ -6): eastward
    v += jet(p, vec2(-140.0,  -6.0), vec2( 1.0, 0.0),              0.10, 5.0, 270.0);

    // ── Antarctic Circumpolar Current ─────────────────────────────────────
    // Runs eastward around lat 58°S → z ≈ +80
    v += jet(p, vec2(-150.0,  80.0), vec2( 1.0, 0.0),              0.26, 8.0, 290.0);

    // ── California Current (southward, US West Coast) ─────────────────────
    v += jet(p, vec2(-110.0, -60.0), normalize(vec2(0.05, 1.0)),   0.14, 5.0, 45.0);

    // ── Benguela Current (southward, SW Africa coast) ─────────────────────
    v += jet(p, vec2(  12.0, -20.0), normalize(vec2(0.0,  1.0)),   0.12, 4.0, 40.0);

    return v * ${OCEAN_CURRENT.SPEED_SCALE.toFixed(6)};
}
`;

// ── Advection shader ──────────────────────────────────────────────────────────
// One fragment = one particle.  Reads current XZ + age from input FBO,
// advances by velocity, writes to output FBO.
// NOTE: GPUComputationRenderer auto-injects "uniform sampler2D texturePosition"
// and "uniform vec2 resolution" — do NOT declare them here.
const ADVECTION_SHADER = /* glsl */`
${VELOCITY_GLSL}

uniform float uTime;
uniform float uDeltaTime;

// Simple hash for pseudo-random respawn positions
float hash(float n) { return fract(sin(n) * 43758.5453123); }

void main() {
    vec2 uv   = gl_FragCoord.xy / resolution.xy;
    vec4 data = texture2D(texturePosition, uv);

    float x   = data.x;
    float z   = data.y;
    float age = data.z;      // 0 = just born, 1 = dead
    float idx = data.w;      // unique particle index, used for respawn hash

    age += 1.0 / ${OCEAN_CURRENT.PARTICLE_LIFETIME.toFixed(1)};

    // Respawn dead or out-of-bounds particles at a random ocean position
    if (age >= 1.0 || abs(x) > 148.0 || abs(z) > 148.0) {
        // Distribute respawn points evenly — use unique index for variety
        float seed = idx * 7.3456 + uTime * 0.001;
        x   = (hash(seed)        * 2.0 - 1.0) * 146.0;
        z   = (hash(seed + 3.7)  * 2.0 - 1.0) * 146.0;
        age = hash(seed + 11.1); // stagger ages so they don't all die together
    }

    // Advect by velocity field
    vec2 vel = oceanVelocity(vec2(x, z));
    x += vel.x;
    z += vel.y;

    gl_FragColor = vec4(x, z, age, idx);
}
`;

// ── Particle vertex shader ────────────────────────────────────────────────────
const PARTICLE_VERT = /* glsl */`
uniform sampler2D uPositionTexture;
uniform float     uTime;
uniform float     uOpacity;
uniform float     uCameraY;

varying float vAge;
varying float vSpeed;
varying vec4  vColor;

// Velocity field copy for speed colouring (kept tiny to avoid re-declare)
${VELOCITY_GLSL}

void main() {
    // Each vertex maps to one FBO texel
    vec2  uv    = vec2(
        (mod(float(gl_VertexID), ${TEX}.0) + 0.5) / ${TEX}.0,
        (floor(float(gl_VertexID) / ${TEX}.0) + 0.5) / ${TEX}.0
    );
    vec4  data  = texture2D(uPositionTexture, uv);
    float x     = data.x;
    float z     = data.y;
    vAge        = data.z;

    // Speed magnitude for colour ramp — normalise against typical max speed
    vec2 vel    = oceanVelocity(vec2(x, z));
    vSpeed      = clamp(length(vel) / 0.35, 0.0, 1.0);

    // Camera altitude fade
    float camFade = smoothstep(
        ${OCEAN_CURRENT.FADE_CAM_LO.toFixed(1)},
        ${(OCEAN_CURRENT.FADE_CAM_LO + 30).toFixed(1)},
        uCameraY
    );

    // Particle alpha: fade in at birth, fade out at death, camera fade
    float birthFade = smoothstep(0.0, 0.15, vAge);
    float deathFade = smoothstep(1.0, 0.75, vAge);
    float alpha     = birthFade * deathFade * camFade * uOpacity;

    // Colour ramp: slow = dim indigo → fast = bright cyan → very fast = white
    vec3 slowCol  = vec3(0.05, 0.20, 0.45);
    vec3 midCol   = vec3(0.10, 0.70, 0.95);
    vec3 fastCol  = vec3(0.80, 0.95, 1.00);
    float sp      = clamp(vSpeed * 8.0, 0.0, 1.0);
    vec3  col     = sp < 0.5
                  ? mix(slowCol, midCol,  sp * 2.0)
                  : mix(midCol,  fastCol, (sp - 0.5) * 2.0);

    vColor = vec4(col, alpha);

    // Position: x → scene X, z stays, Y fixed just above sea level
    vec3 pos = vec3(x, ${OCEAN_CURRENT.ALTITUDE.toFixed(2)}, z);
    gl_Position  = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);

    // ── Land mask — hide particles over major land masses ─────────────────
    // Approximate continent bounding boxes in scene space (X=lon, Z=Mercator).
    // Particles outside these boxes are over ocean and should render.
    // Boxes: [xMin, xMax, zMin, zMax]  (z negative = north, positive = south)
    bool onLand = false;

    // North America
    if (x > -125.0 && x < -35.0 && z > -75.0 && z < 25.0)  onLand = true;
    // South America
    if (x > -85.0  && x < -30.0 && z >  10.0 && z < 75.0)  onLand = true;
    // Europe + W Russia
    if (x > -15.0  && x <  70.0 && z > -75.0 && z < -15.0) onLand = true;
    // Africa
    if (x > -20.0  && x <  55.0 && z > -15.0 && z <  60.0) onLand = true;
    // Asia (rough)
    if (x >  25.0  && x < 148.0 && z > -80.0 && z < -10.0) onLand = true;
    // Australia
    if (x > 110.0  && x < 155.0 && z >   0.0 && z <  45.0) onLand = true;
    // Greenland
    if (x > -60.0  && x < -15.0 && z > -90.0 && z < -55.0) onLand = true;
    // Antarctica
    if (z > 85.0) onLand = true;

    // Zero-size hides the point without a discard in vertex stage
    float dist    = length(cameraPosition - pos);
    gl_PointSize  = onLand ? 0.0 : clamp((1.2 + vSpeed * 2.0) * 180.0 / dist, 0.5, 4.0);
}
`;

// ── Particle fragment shader ──────────────────────────────────────────────────
const PARTICLE_FRAG = /* glsl */`
varying float vAge;
varying float vSpeed;
varying vec4  vColor;

void main() {
    // Soft circular point sprite
    vec2  c    = gl_PointCoord - 0.5;
    float dist = length(c) * 2.0;
    float mask = 1.0 - smoothstep(0.5, 1.0, dist);

    if (mask < 0.01) discard;

    // Bright core + soft halo
    float core = exp(-dist * dist * 6.0);
    gl_FragColor = vec4(vColor.rgb * (0.6 + core * 0.4), vColor.a * mask);
}
`;

// ── Manager class ─────────────────────────────────────────────────────────────
export class OceanCurrentManager {
    constructor() {
        this._scene      = null;
        this._renderer   = null;
        this._gpu        = null;        // GPUComputationRenderer
        this._posVar     = null;        // position variable (GPUComp)
        this._points     = null;        // THREE.Points
        this._enabled    = true;
        this._opacity    = OCEAN_CURRENT.BASE_OPACITY;
        this._frame      = 0;
        this._layerOn    = true;

        // Module-scope scratch — no in-loop allocation
        this._scratchV3  = new THREE.Vector3();
    }

    // ── Public API ──────────────────────────────────────────────────────────
    setIntensity(v) { this._opacity = Math.max(0, Math.min(1, v)); }
    toggle()        { this._layerOn = !this._layerOn; this._applyVisibility(); }

    // ── Init ────────────────────────────────────────────────────────────────
    async init(scene, renderer) {
        this._scene    = scene;
        this._renderer = renderer;

        // Verify WebGL2 float texture support
        const gl = renderer.getContext();
        if (!gl.getExtension('EXT_color_buffer_float') &&
            !gl.getExtension('OES_texture_float')) {
            console.warn('[OceanCurrentManager] Float textures unavailable — skipping.');
            return;
        }

        this._initGPU();
        this._initPoints();
        this._registerLayer();

        window.addEventListener('vg1:layerChanged', (e) => {
            if (e.detail.id === 'ocean-currents') {
                this._layerOn = e.detail.on;
                this._applyVisibility();
            }
        });

        // Optional: attempt to load real OSCAR data
        // await this._fetchData();

        window.oceanCurrentManager = this;
        console.log(`[OceanCurrentManager] Initialised — ${N} particles`);
    }

    // ── GPGPU setup ─────────────────────────────────────────────────────────
    _initGPU() {
        this._gpu = new GPUComputationRenderer(TEX, TEX, this._renderer);

        // Seed initial particle positions randomly across the map
        const initTex = this._gpu.createTexture();
        const data    = initTex.image.data;

        for (let i = 0; i < N; i++) {
            const i4  = i * 4;
            data[i4 + 0] = (Math.random() * 2 - 1) * 146;  // x
            data[i4 + 1] = (Math.random() * 2 - 1) * 146;  // z
            data[i4 + 2] = Math.random();                    // age
            data[i4 + 3] = i;                                // unique index
        }

        this._posVar = this._gpu.addVariable('texturePosition', ADVECTION_SHADER, initTex);
        this._gpu.setVariableDependencies(this._posVar, [this._posVar]);

        // Advection uniforms
        this._posVar.material.uniforms.uTime      = { value: 0 };
        this._posVar.material.uniforms.uDeltaTime = { value: 1 };

        const err = this._gpu.init();
        if (err) console.error('[OceanCurrentManager] GPUComputationRenderer error:', err);
    }

    // ── Points mesh setup ────────────────────────────────────────────────────
    _initPoints() {
        // BufferGeometry with N vertices — positions are read from FBO in vertex shader
        const geo = new THREE.BufferGeometry();

        // Dummy position attribute required by Three.js — actual positions
        // come from the FBO texture sampled in the vertex shader via gl_VertexID
        const dummy = new Float32Array(N * 3);
        geo.setAttribute('position', new THREE.BufferAttribute(dummy, 3));

        const mat = new THREE.ShaderMaterial({
            vertexShader:   PARTICLE_VERT,
            fragmentShader: PARTICLE_FRAG,
            transparent:    true,
            depthWrite:     false,
            blending:       THREE.AdditiveBlending,
            uniforms: {
                uPositionTexture: { value: null },
                uTime:            { value: 0 },
                uOpacity:         { value: this._opacity },
                uCameraY:         { value: 200 },
            },
        });

        this._points = new THREE.Points(geo, mat);
        this._points.name        = 'oceanCurrentParticles';
        this._points.frustumCulled = false; // particles span the whole map
        this._scene.add(this._points);
    }

    // ── Layer registration ───────────────────────────────────────────────────
    _registerLayer() {
        window.dispatchEvent(new CustomEvent('vg1:requestLayerRegister', {
            detail: {
                id:        'ocean-currents',
                label:     'Ocean Currents',
                category:  'surface',
                color:     '#10b8e0',
                defaultOn: true,
            }
        }));

        // Fallback: try direct import if layerManager is on window
        if (window.layerManager?.register) {
            window.layerManager.register({
                id:        'ocean-currents',
                label:     'Ocean Currents',
                category:  'surface',
                color:     '#10b8e0',
                defaultOn: true,
            });
        }
    }

    _applyVisibility() {
        if (this._points) this._points.visible = this._layerOn;
    }

    // ── Per-frame update ─────────────────────────────────────────────────────
    update(camera, deltaTime = 0.016) {
        if (!this._gpu || !this._points || !this._layerOn) return;

        this._frame++;

        // Advance advection simulation
        this._posVar.material.uniforms.uTime.value      += deltaTime;
        this._posVar.material.uniforms.uDeltaTime.value  = deltaTime * 60; // normalise to 60fps
        this._gpu.compute();

        // Feed updated position texture to the render material
        const mat = this._points.material;
        mat.uniforms.uPositionTexture.value =
            this._gpu.getCurrentRenderTarget(this._posVar).texture;
        mat.uniforms.uTime.value    += deltaTime;
        mat.uniforms.uOpacity.value  = this._opacity;
        mat.uniforms.uCameraY.value  = camera.position.y;
    }

    // ── Dispose ──────────────────────────────────────────────────────────────
    dispose() {
        if (this._points) {
            this._scene.remove(this._points);
            this._points.geometry.dispose();
            this._points.material.dispose();
            this._points = null;
        }
        this._gpu = null;
    }

    // ── _fetchData: OSCAR / RTOFS stub ───────────────────────────────────────
    // Replace the analytical velocity field with real NASA OSCAR u/v data.
    //
    // To activate:
    //   1. Register at https://urs.earthdata.nasa.gov (free)
    //   2. Set localStorage.setItem('nasa_earthdata_token', 'Bearer YOUR_TOKEN')
    //   3. Uncomment the call in init() above
    //
    // The parsed u/v values should be written into a THREE.DataTexture (RGBA32F)
    // and bound as a uniform on the advection material, replacing the analytical
    // oceanVelocity() function with a texture lookup.
    async _fetchData() {
        const token = localStorage.getItem('nasa_earthdata_token');
        if (!token) {
            console.info('[OceanCurrentManager] No NASA Earthdata token — using synthetic currents.');
            return;
        }

        // Spatial subset covering the full map (±80° lat)
        const bbox   = 'lat(-80:80)&subset=lon(-180:180)';
        const url    = `https://harmony.earthdata.nasa.gov/C2102959417-POCLOUD/ogc-api-coverages/1.0.0/collections/all/coverage/rangeset?subset=${bbox}&format=application/x-netcdf4`;

        try {
            const resp = await fetch(url, { headers: { Authorization: token } });
            if (!resp.ok) throw new Error(`OSCAR fetch failed: ${resp.status}`);
            // TODO: parse NetCDF with netcdfjs, extract u/v arrays,
            // build a DataTexture (RG32F, 1440×720), set as velocity uniform.
            console.info('[OceanCurrentManager] OSCAR data loaded — TODO: parse NetCDF.');
        } catch (err) {
            console.warn('[OceanCurrentManager] OSCAR fetch error — falling back to synthetic:', err.message);
        }
    }
}
