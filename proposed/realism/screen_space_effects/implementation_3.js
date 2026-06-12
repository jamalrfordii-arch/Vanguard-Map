// ── In sceneSetup.js — initPostProcessing function ──
// REPLACE the existing composer chain assembly with this:

export function initPostProcessing(scene, camera, renderer) {
    const width = window.innerWidth;
    const height = window.innerHeight;

    const composer = new EffectComposer(renderer);

    // 1. Scene render
    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);

    // 2. N8AO and SSR are inserted dynamically by ssaoManager.init()
    //    They go here in the chain — after render, before bloom.
    //    ssaoManager.init() returns the pass objects; caller inserts them:
    //
    //    const { n8aoPass, ssrPass } = await ssaoManager.init(scene, camera, renderer, composer);
    //    if (n8aoPass) composer.insertPass(n8aoPass, 1);  // after RenderPass
    //    if (ssrPass)  composer.insertPass(ssrPass, n8aoPass ? 2 : 1);

    // 3. Bloom — unchanged, DO NOT modify these values
    const bloomPass = new UnrealBloomPass(
        new THREE.Vector2(width, height),
        BLOOM_STRENGTH_BASE,
        BLOOM_RADIUS,
        BLOOM_THRESHOLD
    );
    composer.addPass(bloomPass);

    // 4–6. Fog, Cloud, TAA passes added by their respective managers (unchanged)

    return { composer, renderPass, bloomPass };
}