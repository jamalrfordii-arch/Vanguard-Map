// ── main.js — IMPORTS (add at top with other imports) ──
import { SSAOManager } from './ssaoManager.js';

// ── main.js — INITIALIZATION (after initPostProcessing, before animation loop) ──
const ssaoManager = new SSAOManager();

// After composer is created and renderPass/bloomPass are set up:
(async () => {
    const { n8aoPass, ssrPass } = await ssaoManager.init(
        scene, camera, renderer, composer,
        {
            ssao: {
                aoRadius: 5.0,
                aoIntensity: 3.0,
                distanceFalloff: 1.0,
                halfRes: true,
                aoColor: new THREE.Color(0.04, 0.04, 0.08),
            },
            ssr: {
                intensity: 0.55,
                maxSteps: 24,
                renderScale: 0.5,
                waterY: 0.0,
            },
        }
    );

    // Insert into composer chain — AFTER RenderPass (index 0), BEFORE BloomPass
    // EffectComposer.insertPass(pass, index) shifts existing passes forward
    if (n8aoPass) {
        composer.insertPass(n8aoPass, 1);
    }
    if (ssrPass) {
        const ssrIdx = n8aoPass ? 2 : 1;
        composer.insertPass(ssrPass, ssrIdx);
    }

    console.log('[main] Screen-space effects chain ready');
})();

// ── main.js — ANIMATION LOOP (add inside the animate() function, before composer.render()) ──
// After controls.update() and before composer.render():
ssaoManager.update(delta, camera);

// ── main.js — RESIZE HANDLER (add inside the window resize listener) ──
ssaoManager.resize(window.innerWidth, window.innerHeight);