// dayNightManager.js — Live day/night terminator with city lights
// Computes real solar position from UTC time, renders a dark overlay on the night side,
// and fades in warm city-light glows where it's dark on the ground.
import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT } from './config.js';
import { simClock } from './simClock.js';

const TWO_PI  = Math.PI * 2;
const DEG2RAD = Math.PI / 180;

// ── Solar position ────────────────────────────────────────────────────────────
// Returns approximate sun lat/lon in radians from current UTC time.
function getSunPosition() {
    const now   = simClock.date();
    const start = new Date(now.getFullYear(), 0, 0);
    const doy   = Math.floor((now - start) / 86400000); // day of year

    // Solar declination: -23.45° at solstice, 0° at equinox
    const decRad = -23.45 * DEG2RAD * Math.cos(TWO_PI * (doy + 10) / 365.25);

    // Sub-solar longitude: directly overhead at lon 0° at 12:00 UTC
    const utcH   = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
    const sunLon = ((12 - utcH) / 24) * TWO_PI;

    return { latRad: decRad, lonRad: sunLon };
}

// ── Mercator helpers ──────────────────────────────────────────────────────────
function latLonToXZ(latDeg, lonDeg) {
    const x  = lonDeg * (MAP_WIDTH / 360);
    const lr = latDeg * DEG2RAD;
    // Clamp lat to avoid log(0) at the poles
    const lr2 = Math.max(-1.48, Math.min(1.48, lr));
    const my = Math.log(Math.tan(Math.PI / 4 + lr2 / 2));
    const z  = -my * (MAP_HEIGHT / TWO_PI);
    return [x, z];
}

// ── City light positions [lat, lon] ───────────────────────────────────────────
const CITIES = [
    // North America
    [40.71, -74.01],  // New York
    [34.05,-118.24],  // Los Angeles
    [41.88, -87.63],  // Chicago
    [43.65, -79.38],  // Toronto
    [19.43, -99.13],  // Mexico City
    [29.76, -95.37],  // Houston
    [25.77, -80.19],  // Miami
    [45.42, -75.70],  // Ottawa
    [49.28,-123.12],  // Vancouver
    [32.78, -96.80],  // Dallas
    [47.61,-122.33],  // Seattle
    [33.45,-112.07],  // Phoenix
    [39.95, -75.17],  // Philadelphia
    // South America
    [-23.55,-46.63],  // São Paulo
    [-34.60,-58.38],  // Buenos Aires
    [-22.91,-43.17],  // Rio de Janeiro
    [-12.05,-77.04],  // Lima
    [  4.71,-74.07],  // Bogotá
    [-33.45,-70.67],  // Santiago
    [ -0.23,-78.52],  // Quito
    [-15.78,-47.93],  // Brasília
    // Europe
    [51.51,  -0.13],  // London
    [48.87,   2.35],  // Paris
    [52.52,  13.40],  // Berlin
    [40.42,  -3.70],  // Madrid
    [41.90,  12.50],  // Rome
    [55.75,  37.62],  // Moscow
    [41.01,  28.98],  // Istanbul
    [50.45,  30.52],  // Kyiv
    [52.37,   4.90],  // Amsterdam
    [52.23,  21.01],  // Warsaw
    [48.21,  16.37],  // Vienna
    [59.33,  18.07],  // Stockholm
    [37.98,  23.73],  // Athens
    [60.17,  24.93],  // Helsinki
    [55.68,  12.57],  // Copenhagen
    [47.38,   8.54],  // Zurich
    [48.14,  11.58],  // Munich
    [45.46,   9.19],  // Milan
    [38.72,  -9.14],  // Lisbon
    [50.85,   4.35],  // Brussels
    [59.91,  10.75],  // Oslo
    // Middle East & Africa
    [30.06,  31.25],  // Cairo
    [25.20,  55.27],  // Dubai
    [24.69,  46.72],  // Riyadh
    [33.34,  44.40],  // Baghdad
    [35.69,  51.39],  // Tehran
    [31.77,  35.22],  // Jerusalem
    [-1.29,  36.82],  // Nairobi
    [ 6.52,   3.38],  // Lagos
    [-26.20,  28.04], // Johannesburg
    [33.59,  -7.62],  // Casablanca
    [15.55,  32.53],  // Khartoum
    [14.69, -17.44],  // Dakar
    [ 9.05,   7.49],  // Abuja
    // Asia
    [35.68, 139.69],  // Tokyo
    [31.23, 121.47],  // Shanghai
    [39.91, 116.39],  // Beijing
    [37.57, 126.98],  // Seoul
    [19.08,  72.88],  // Mumbai
    [28.63,  77.22],  // Delhi
    [12.97,  77.59],  // Bangalore
    [24.86,  67.01],  // Karachi
    [13.75, 100.52],  // Bangkok
    [ 1.29, 103.85],  // Singapore
    [-6.21, 106.85],  // Jakarta
    [14.59, 120.98],  // Manila
    [22.32, 114.17],  // Hong Kong
    [25.04, 121.51],  // Taipei
    [34.69, 135.50],  // Osaka
    [22.57,  88.37],  // Kolkata
    [23.73,  90.41],  // Dhaka
    [31.55,  74.35],  // Lahore
    [55.01,  82.93],  // Novosibirsk
    [43.25,  76.95],  // Almaty
    [41.30,  69.24],  // Tashkent
    [37.95,  58.38],  // Ashgabat
    [33.34, 104.08],  // Lanzhou
    [30.66, 104.06],  // Chengdu
    [23.12, 113.25],  // Guangzhou
    [32.06, 118.78],  // Nanjing
    // Oceania
    [-33.87, 151.21], // Sydney
    [-37.81, 144.96], // Melbourne
    [-36.85, 174.76], // Auckland
    [-27.47, 153.02], // Brisbane
    [-31.95, 115.86], // Perth
];

// ── Night overlay shaders ─────────────────────────────────────────────────────
const OVERLAY_VERT = /* glsl */`
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const OVERLAY_FRAG = /* glsl */`
uniform vec2 uSun; // (sunLatRad, sunLonRad)
varying vec2 vUv;

const float PI      = 3.14159265358979323846;
const float TWO_PI  = 6.28318530717958647692;
const float HALF_PI = 1.57079632679489661923;

void main() {
    // UV → Mercator lon/lat in radians
    float lon = (vUv.x - 0.5) * TWO_PI;
    float my  = (0.5 - vUv.y) * TWO_PI;
    float lat = 2.0 * atan(exp(my)) - HALF_PI;

    // Cosine of angular distance from sub-solar point
    float cosD = sin(uSun.x)*sin(lat) + cos(uSun.x)*cos(lat)*cos(lon - uSun.y);

    // smoothstep from ~civil twilight (cosD=0.07) to full dark (cosD=-0.10)
    float night = smoothstep(0.07, -0.10, cosD);

    // Deep navy overlay — subtle starless sky tint
    gl_FragColor = vec4(0.004, 0.012, 0.035, night * 0.48);
}`;

// ── City lights shaders ───────────────────────────────────────────────────────
const CITY_VERT = /* glsl */`
attribute float aLat;  // degrees
attribute float aLon;  // degrees
uniform vec2 uSun;     // (sunLatRad, sunLonRad)
varying float vNight;

const float PI      = 3.14159265358979323846;
const float DEG2RAD = PI / 180.0;

void main() {
    float lat = aLat * DEG2RAD;
    float lon = aLon * DEG2RAD;

    float cosD = sin(uSun.x)*sin(lat) + cos(uSun.x)*cos(lat)*cos(lon - uSun.y);

    // Fully lit when cosD < 0 (night), fades out through twilight
    vNight = clamp(smoothstep(0.05, -0.20, cosD), 0.0, 1.0);

    // Scale point size with night factor; camera perspective handled by sizeAttenuation
    gl_PointSize = mix(0.0, 7.0, vNight);
    gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const CITY_FRAG = /* glsl */`
varying float vNight;

void main() {
    if (vNight < 0.01) discard;

    // Circular glow gradient
    vec2 ctr  = gl_PointCoord - 0.5;
    float d   = length(ctr) * 2.0;
    if (d > 1.0) discard;

    float glow = pow(1.0 - d, 1.8);
    // Warm incandescent yellow-white
    gl_FragColor = vec4(1.0, 0.91, 0.62, glow * vNight * 0.92);
}`;

// ── DayNightManager ───────────────────────────────────────────────────────────
export class DayNightManager {
    constructor(scene) {
        this._scene      = scene;
        this._visible    = true;
        this._lastUpdate = -999;

        // Shared sun uniform — both overlay and city lights reference the same object
        const sun = getSunPosition();
        this._sunUniform = { value: new THREE.Vector2(sun.latRad, sun.lonRad) };

        // _buildOverlay() intentionally not called — the night-side darkening
        // plane was a full-map PlaneGeometry at Y=0.4 with hard rectangular
        // edges, visible as a dark panel at oblique camera angles. The
        // terminator line + city lights below carry the day/night signal.
        this._overlay = null;
        this._buildCityLights();
        this._buildTerminatorLine();
    }

    // ── Night overlay mesh ────────────────────────────────────────────────────
    _buildOverlay() {
        // High-res plane to match the Mercator map exactly
        const geo = new THREE.PlaneGeometry(MAP_WIDTH, MAP_HEIGHT, 256, 128);
        const mat = new THREE.ShaderMaterial({
            uniforms:       { uSun: this._sunUniform },
            vertexShader:   OVERLAY_VERT,
            fragmentShader: OVERLAY_FRAG,
            transparent:    true,
            depthWrite:     false,
            depthTest:      false,
            side:           THREE.DoubleSide,
        });

        this._overlay = new THREE.Mesh(geo, mat);
        this._overlay.rotation.x = -Math.PI / 2;
        this._overlay.position.y = 0.4;  // just above sea level, below ships
        this._overlay.renderOrder = 5;
        this._scene.add(this._overlay);
    }

    // ── City lights point cloud ───────────────────────────────────────────────
    _buildCityLights() {
        const N         = CITIES.length;
        const positions = new Float32Array(N * 3);
        const latArr    = new Float32Array(N);
        const lonArr    = new Float32Array(N);

        CITIES.forEach(([lat, lon], i) => {
            const [x, z] = latLonToXZ(lat, lon);
            positions[i * 3 + 0] = x;
            positions[i * 3 + 1] = 0.6;  // slightly above sea level
            positions[i * 3 + 2] = z;
            latArr[i] = lat;
            lonArr[i] = lon;
        });

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('aLat',     new THREE.BufferAttribute(latArr,    1));
        geo.setAttribute('aLon',     new THREE.BufferAttribute(lonArr,    1));

        const mat = new THREE.ShaderMaterial({
            uniforms:       { uSun: this._sunUniform },
            vertexShader:   CITY_VERT,
            fragmentShader: CITY_FRAG,
            transparent:    true,
            depthWrite:     false,
            blending:       THREE.AdditiveBlending,
        });

        this._cityLights = new THREE.Points(geo, mat);
        this._cityLights.renderOrder = 6;
        this._scene.add(this._cityLights);
    }

    // ── Terminator glow line ──────────────────────────────────────────────────
    // Traces the day/night boundary as a closed curve in Mercator map space.
    // Rendered as a double-layer line: a broad cyan glow (additive, thick) and
    // a sharper bright core, giving a soft luminous terminator edge.
    _buildTerminatorLine() {
        const makeLine = (color, opacity, width) => {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(512 * 3), 3));
            const mat = new THREE.LineBasicMaterial({
                color,
                transparent:  true,
                opacity,
                linewidth:    width,
                blending:     THREE.AdditiveBlending,
                depthWrite:   false,
                depthTest:    false,
            });
            const line = new THREE.Line(geo, mat);
            line.renderOrder = 4;
            this._scene.add(line);
            return line;
        };
        this._terminatorGlow = makeLine(0x1a6fff, 0.35, 2);
        this._terminatorCore = makeLine(0x80d8ff, 0.75, 1);
        // Hidden by default — toggle via UI or: window.dayNightManager.setTerminatorVisible(true)
        this._terminatorGlow.visible = false;
        this._terminatorCore.visible = false;
        this._updateTerminatorLine();
    }

    // Compute the terminator curve and push updated positions into both lines.
    // The terminator is the set of geographic points where the angular distance
    // from the sub-solar point equals exactly 90° — i.e. cos(angularDist) = 0.
    // For each longitude λ the solution is:
    //   lat = atan( -cos(φ₀)·cos(λ - λ₀) / sin(φ₀) )
    // where (φ₀, λ₀) is the sub-solar latitude/longitude.
    _updateTerminatorLine() {
        const { latRad: sunLat, lonRad: sunLon } = getSunPosition();
        const N   = 512;
        const pts = [];
        const sinSunLat = Math.sin(sunLat);
        const cosSunLat = Math.cos(sunLat);

        for (let i = 0; i <= N; i++) {
            const lon = (i / N) * TWO_PI - Math.PI;  // -π … +π
            const dLon = lon - sunLon;

            let lat;
            if (Math.abs(sinSunLat) < 0.005) {
                // Equinox: sun is over the equator, terminator is a meridian
                lat = ((i / N) - 0.5) * Math.PI;  // draw along one meridian
            } else {
                lat = Math.atan(-cosSunLat * Math.cos(dLon) / sinSunLat);
            }

            const lonDeg = lon  * (180 / Math.PI);
            const latDeg = lat  * (180 / Math.PI);
            const [x, z] = latLonToXZ(latDeg, lonDeg);

            // Break the line at the anti-meridian (sharp horizontal jump)
            if (pts.length > 0) {
                const prev = pts[pts.length - 1];
                if (Math.abs(x - prev.x) > MAP_WIDTH * 0.45) {
                    // Insert a NaN point to create a line break (Three.js strips it)
                    pts.push(new THREE.Vector3(NaN, NaN, NaN));
                }
            }
            pts.push(new THREE.Vector3(x, 0.5, z));
        }

        const update = (line) => {
            line.geometry.setFromPoints(pts);
            line.geometry.attributes.position.needsUpdate = true;
        };
        update(this._terminatorGlow);
        update(this._terminatorCore);
    }

    // ── tick: call once per animation frame ───────────────────────────────────
    // Updates the sun position once per minute (no need to recalculate every frame).
    tick(elapsed) {
        if (elapsed - this._lastUpdate > 60) {
            const sun = getSunPosition();
            this._sunUniform.value.set(sun.latRad, sun.lonRad);
            this._updateTerminatorLine();
            this._lastUpdate = elapsed;
        }
    }

    /** Current sub-solar latitude in radians — used by SkyManager. */
    get sunLatRad() { return this._sunUniform.value.x; }
    /** Current sub-solar longitude in radians — used by SkyManager. */
    get sunLonRad() { return this._sunUniform.value.y; }

    get visible() { return this._visible; }
    set visible(v) {
        this._visible = v;
        if (this._overlay)         this._overlay.visible        = v;
        this._cityLights.visible      = v;
        this._terminatorGlow.visible  = v;
        this._terminatorCore.visible  = v;
    }

    dispose() {
        [this._overlay, this._cityLights, this._terminatorGlow, this._terminatorCore]
            .filter(obj => obj)
            .forEach(obj => {
                obj.geometry.dispose();
                obj.material.dispose();
                this._scene.remove(obj);
            });
    }
}
