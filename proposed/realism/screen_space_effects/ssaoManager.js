// ssaoManager.js — Manages N8AO ambient occlusion and SSR integration for Vanguard1
// Coordinates screen-space effects, exposes tuning API, handles quality adaptation.

import * as THREE from 'three';

/**
 * @typedef {Object} SSAOConfig
 * @property {number} aoRadius
 * @property {number} aoIntensity
 * @property {number} distanceFalloff
 * @property {number} aoSamples
 * @property {number} denoiseSamples
 * @property {number} denoiseRadius
 * @property {boolean} halfRes
 * @property {THREE.Color} aoColor
 */

/** @type {SSAOConfig} */
const DEFAULT_CONFIG = {
    aoRadius: 5.0,
    aoIntensity: 3.0,
    distanceFalloff: 1.0,
    aoSamples: 16,
    denoiseSamples: 8,
    denoiseRadius: 12,
    halfRes: true,
    aoColor: new THREE.Color(0.04, 0.04, 0.08), // slight blue tint for sky bounce GI approx
};

/** @type {Object} */
const SSR_DEFAULTS = {
    intensity: 0.55,
    maxSteps: 24,
    stepSize: 0.15,
    thickness: 1.5,
    maxDistance: 150.0,
    waterY: 0.0,
    waterTolerance: 3.0,
    renderScale: 0.5,
};

/**
 * Manages all screen-space lighting effects for Vanguard1.
 *
 * Usage:
 *   const mgr = new SSAOManager();
 *   const { n8aoPass, ssrPass } = await mgr.init(scene, camera, renderer, composer);
 *   // in animation loop:
 *   mgr.update(deltaTime, camera);
 */
class SSAOManager {

    constructor() {
        /** @type {import('n8ao').N8AOPass|null} */
        this.n8aoPass = null;

        /** @type {import('./ssrPass.js').SSRPass|null} */
        this.ssrPass = null;

        this._scene = null;
        this._camera = null;
        this._renderer = null;
        this._enabled = true;
        this._ssaoEnabled = true;
        this._ssrEnabled = true;
        this._adaptiveQuality = true;
        this._lastFrameTime = 0;
        this._frameTimes = new Float32Array(60);
        this._frameIdx = 0;
        this._currentQuality = 'Medium';
    }

    /**
     * Initialize SSAO and SSR passes.
     * N8AO is loaded dynamically so the main bundle doesn't break if it's unavailable.
     *
     * @param {THREE.Scene} scene
     * @param {THREE.PerspectiveCamera} camera
     * @param {THREE.WebGLRenderer} renderer
     * @param {import('three/addons/postprocessing/EffectComposer.js').EffectComposer} composer
     * @param {Object} [options]
     * @returns {Promise<{n8aoPass: object|null, ssrPass: object|null}>}
     */
    async init(scene, camera, renderer, composer, options = {}) {
        this._scene = scene;
        this._camera = camera;
        this._renderer = renderer;

        const width = renderer.domElement.width;
        const height = renderer.domElement.height;

        const config = { ...DEFAULT_CONFIG, ...options.ssao };
        const ssrConfig = { ...SSR_DEFAULTS, ...options.ssr };

        // ── N8AO ──
        try {
            const n8aoModule = await import('https://unpkg.com/n8ao@1.9.2/dist/N8AO.js');
            const N8AOPass = n8aoModule.N8AOPass;

            this.n8aoPass = new N8AOPass(scene, camera, width, height);

            // Apply configuration
            this.n8aoPass.configuration.aoRadius = config.aoRadius;
            this.n8aoPass.configuration.intensity = config.aoIntensity;
            this.n8aoPass.configuration.distanceFalloff = config.distanceFalloff;
            this.n8aoPass.configuration.color = config.aoColor;
            this.n8aoPass.configuration.screenSpaceRadius = false;
            this.n8aoPass.configuration.halfRes = config.halfRes;
            this.n8aoPass.configuration.gammaCorrection = false; // we handle gamma via OutputPass
            this.n8aoPass.configuration.aoSamples = config.aoSamples;
            this.n8aoPass.configuration.denoiseSamples = config.denoiseSamples;
            this.n8aoPass.configuration.denoiseRadius = config.denoiseRadius;

            this.n8aoPass.setQualityMode('Medium');

            console.log('[SSAOManager] N8AO initialized — halfRes:', config.halfRes);
        } catch (err) {
            console.warn('[SSAOManager] N8AO unavailable, falling back to GTAOPass:', err.message);
            await this._initGTAOFallback(scene, camera, renderer, width, height, config);
        }

        // ── SSR ──
        try {
            const { SSRPass } = await import('./ssrPass.js');
            this.ssrPass = new SSRPass(scene, camera, renderer, ssrConfig);
            console.log('[SSAOManager] SSR initialized — renderScale:', ssrConfig.renderScale);
        } catch (err) {
            console.warn('[SSAOManager] SSR unavailable:', err.message);
        }

        // ── Expose console tuning ──
        this._exposeDebugAPI();

        // ── Register with layerManager ──
        window.dispatchEvent(new CustomEvent('vg1:layer:register', {
            detail: {
                id: 'screenSpaceEffects',
                label: 'Screen Space Effects',
                enabled: true,
                onToggle: (on) => { this.setEnabled(on); },
                onOpacity: (v) => {
                    if (this.n8aoPass) this.n8aoPass.configuration.intensity = v * config.aoIntensity;
                    if (this.ssrPass) this.ssrPass.intensity = v * ssrConfig.intensity;
                },
            }
        }));

        return { n8aoPass: this.n8aoPass, ssrPass: this.ssrPass };
    }

    /**
     * Fallback: use Three.js built-in GTAOPass if N8AO CDN is unreachable.
     * @private
     */
    async _initGTAOFallback(scene, camera, renderer, width, height, config) {
        try {
            const { GTAOPass } = await import('three/addons/postprocessing/GTAOPass.js');
            const gtaoPass = new GTAOPass(scene, camera, width, height);
            gtaoPass.output = 0; // OUTPUT_DEFAULT — blended AO
            // GTAOPass doesn't have identical API, map what we can
            if (gtaoPass.updateGtaoMaterial) {
                gtaoPass.updateGtaoMaterial({
                    radius: config.aoRadius,
                    distanceExponent: 2,
                    thickness: config.distanceFalloff,
                    scale: config.aoIntensity,
                    samples: config.aoSamples,
                });
            }
            // Wrap in a compatible interface
            this.n8aoPass = gtaoPass;
            this.n8aoPass._isGTAO = true;
            console.log('[SSAOManager] GTAOPass fallback initialized');
        } catch (e2) {
            console.error('[SSAOManager] Both N8AO and GTAO failed:', e2.message);
        }
    }

    /**
     * Per-frame update. Call from the main animation loop.
     * Handles adaptive quality scaling based on frame time.
     *
     * @param {number} deltaTime — seconds since last frame
     * @param {THREE.PerspectiveCamera} camera
     */
    update(deltaTime, camera) {
        if (!this._enabled) return;

        // Track frame times for adaptive quality
        if (this._adaptiveQuality) {
            this._frameTimes[this._frameIdx] = deltaTime * 1000;
            this._frameIdx = (this._frameIdx + 1) % this._frameTimes.length;

            // Every 60 frames, check average
            if (this._frameIdx === 0) {
                this._adaptQuality();
            }
        }

        // Altitude-based intensity adjustment
        // At high altitude (>200), AO is barely visible — save GPU
        const cameraY = camera.position.y;
        if (this.n8aoPass && this._ssaoEnabled) {
            if (cameraY > 300) {
                this.n8aoPass.enabled = false;
            } else if (cameraY > 200) {
                this.n8aoPass.enabled = true;
                if (!this.n8aoPass._isGTAO) {
                    this.n8aoPass.configuration.intensity = 1.5;
                }
            } else {
                this.n8aoPass.enabled = true;
                if (!this.n8aoPass._isGTAO) {
                    this.n8aoPass.configuration.intensity = 3.0;
                }
            }
        }

        // SSR only visible when camera is low enough to see water reflections
        if (this.ssrPass && this._ssrEnabled) {
            if (cameraY > 200) {
                this.ssrPass.enabled = false;
            } else {
                this.ssrPass.enabled = true;
                // Fade SSR intensity with altitude
                const ssrFade = THREE.MathUtils.smoothstep(cameraY, 20, 150);
                this.ssrPass.intensity = THREE.MathUtils.lerp(0.6, 0.15, ssrFade);
            }
        }
    }

    /**
     * Adaptive quality — drop AO quality if frame time exceeds budget.
     * @private
     */
    _adaptQuality() {
        if (!this.n8aoPass || this.n8aoPass._isGTAO) return;

        let sum = 0;
        for (let i = 0; i < this._frameTimes.length; i++) sum += this._frameTimes[i];
        const avgMs = sum / this._frameTimes.length;

        const BUDGET_60FPS = 16.67;
        const BUDGET_MARGIN = 2.0;

        if (avgMs > BUDGET_60FPS + BUDGET_MARGIN && this._currentQuality !== 'Performance') {
            // Downgrade
            if (this._currentQuality === 'Ultra' || this._currentQuality === 'High') {
                this.n8aoPass.setQualityMode('Medium');
                this._currentQuality = 'Medium';
            } else if (this._currentQuality === 'Medium') {
                this.n8aoPass.setQualityMode('Low');
                this._currentQuality = 'Low';
            } else {
                this.n8aoPass.setQualityMode('Performance');
                this._currentQuality = 'Performance';
            }
            console.log(`[SSAOManager] Adaptive quality → ${this._currentQuality} (avg: ${avgMs.toFixed(1)}ms)`);
        } else if (avgMs < BUDGET_60FPS - 4.0 && this._currentQuality !== 'Medium') {
            // Upgrade if we have headroom
            if (this._currentQuality === 'Performance') {
                this.n8aoPass.setQualityMode('Low');
                this._currentQuality = 'Low';
            } else if (this._currentQuality === 'Low') {
                this.n8aoPass.setQualityMode('Medium');
                this._currentQuality = 'Medium';
            }
            console.log(`[SSAOManager] Adaptive quality → ${this._currentQuality} (avg: ${avgMs.toFixed(1)}ms)`);
        }
    }

    /**
     * Toggle all screen-space effects.
     * @param {boolean} on
     */
    setEnabled(on) {
        this._enabled = on;
        if (this.n8aoPass) this.n8aoPass.enabled = on && this._ssaoEnabled;
        if (this.ssrPass) this.ssrPass.enabled = on && this._ssrEnabled;
    }

    /**
     * Toggle individual effects.
     * @param {'ssao'|'ssr'} effect
     * @param {boolean} on
     */
    setEffectEnabled(effect, on) {
        if (effect === 'ssao') {
            this._ssaoEnabled = on;
            if (this.n8aoPass) this.n8aoPass.enabled = on && this._enabled;
        } else if (effect === 'ssr') {
            this._ssrEnabled = on;
            if (this.ssrPass) this.ssrPass.enabled = on && this._enabled;
        }
    }

    /**
     * Handle resize.
     * @param {number} width
     * @param {number} height
     */
    resize(width, height) {
        if (this.n8aoPass && this.n8aoPass.setSize) {
            this.n8aoPass.setSize(width, height);
        }
        if (this.ssrPass) {
            this.ssrPass.setSize(width, height);
        }
    }

    /**
     * Expose window.vg1SSE for DevTools live tuning.
     * @private
     */
    _exposeDebugAPI() {
        const self = this;
        window.vg1SSE = {
            get enabled() { return self._enabled; },
            set enabled(v) { self.setEnabled(v); },

            get ssaoEnabled() { return self._ssaoEnabled; },
            set ssaoEnabled(v) { self.setEffectEnabled('ssao', v); },

            get ssrEnabled() { return self._ssrEnabled; },
            set ssrEnabled(v) { self.setEffectEnabled('ssr', v); },

            get adaptiveQuality() { return self._adaptiveQuality; },
            set adaptiveQuality(v) { self._adaptiveQuality = v; },

            get quality() { return self._currentQuality; },
            set quality(v) {
                if (self.n8aoPass && !self.n8aoPass._isGTAO) {
                    self.n8aoPass.setQualityMode(v);
                    self._currentQuality = v;
                }
            },

            // N8AO direct tunables
            get aoRadius() { return self.n8aoPass?.configuration?.aoRadius ?? 0; },
            set aoRadius(v) { if (self.n8aoPass?.configuration) self.n8aoPass.configuration.aoRadius = v; },

            get aoIntensity() { return self.n8aoPass?.configuration?.intensity ?? 0; },
            set aoIntensity(v) { if (self.n8aoPass?.configuration) self.n8aoPass.configuration.intensity = v; },

            get aoColor() { return self.n8aoPass?.configuration?.color ?? null; },
            /** @param {number} hex — e.g. 0x0a0a14 */
            set aoColor(hex) { if (self.n8aoPass?.configuration) self.n8aoPass.configuration.color.set(hex); },

            get aoSamples() { return self.n8aoPass?.configuration?.aoSamples ?? 0; },
            set aoSamples(v) { if (self.n8aoPass?.configuration) self.n8aoPass.configuration.aoSamples = v; },

            get halfRes() { return self.n8aoPass?.configuration?.halfRes ?? true; },
            set halfRes(v) { if (self.n8aoPass?.configuration) self.n8aoPass.configuration.halfRes = v; },

            // SSR tunables
            get ssrIntensity() { return self.ssrPass?.intensity ?? 0; },
            set ssrIntensity(v) { if (self.ssrPass) self.ssrPass.intensity = v; },

            get ssrSteps() { return self.ssrPass?.maxSteps ?? 0; },
            set ssrSteps(v) { if (self.ssrPass) self.ssrPass.maxSteps = v; },

            get ssrThickness() { return self.ssrPass?.thickness ?? 0; },
            set ssrThickness(v) { if (self.ssrPass) self.ssrPass.thickness = v; },

            get ssrMaxDistance() { return self.ssrPass?.maxDistance ?? 0; },
            set ssrMaxDistance(v) { if (self.ssrPass) self.ssrPass.maxDistance = v; },

            get ssrWaterY() { return self.ssrPass?.waterY ?? 0; },
            set ssrWaterY(v) { if (self.ssrPass) self.ssrPass.waterY = v; },

            /** Print current GPU timing for N8AO */
            get aoGpuMs() { return self.n8aoPass?.lastTime ?? -1; },

            /** Print status */
            status() {
                console.table({
                    'SSAO enabled': self._ssaoEnabled,
                    'SSAO quality': self._currentQuality,
                    'SSAO halfRes': self.n8aoPass?.configuration?.halfRes ?? 'N/A',
                    'SSAO GPU ms': self.n8aoPass?.lastTime?.toFixed(2) ?? 'N/A',
                    'SSR enabled': self._ssrEnabled,
                    'SSR intensity': self.ssrPass?.intensity ?? 'N/A',
                    'SSR steps': self.ssrPass?.maxSteps ?? 'N/A',
                    'Adaptive': self._adaptiveQuality,
                });
            },
        };

        console.log('[SSAOManager] Debug API: window.vg1SSE — try vg1SSE.status()');
    }

    /**
     * Clean up all GPU resources.
     */
    dispose() {
        if (this.n8aoPass && this.n8aoPass.dispose) this.n8aoPass.dispose();
        if (this.ssrPass) this.ssrPass.dispose();
        delete window.vg1SSE;
    }
}

export { SSAOManager, DEFAULT_CONFIG, SSR_DEFAULTS };