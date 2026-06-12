// ── Where you set up the EffectComposer ──────────────────────────────────────
// Add AFTER the RenderPass, BEFORE bloom/tonemap/final passes.

import { EDLPass } from './edlPass.js';
import { SPLAT_FADE_START, SPLAT_FADE_END } from './config.js';

// ... existing composer setup ...
// const renderPass = new RenderPass(scene, camera);
// composer.addPass(renderPass);

const edlPass = new EDLPass(scene, camera, {
    edlStrength: 0.6,    // 0.3 = subtle, 0.8 = dramatic. Tune in DevTools.
    edlRadius: 1.4,      // px. 1.0–2.0 range. Larger = thicker silhouettes.
    fadeStart: SPLAT_FADE_START,
    fadeEnd: SPLAT_FADE_END,
});
composer.addPass(edlPass);

// Expose for DevTools tuning
window.edlPass = edlPass;

// ... then add bloom pass, etc. ...

// In the resize handler:
// edlPass.setSize(width, height);