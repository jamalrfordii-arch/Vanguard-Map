// ── DevTools Console Commands ──

// Full status report
vg1SSE.status()

// Toggle effects
vg1SSE.enabled = false          // kill all screen-space effects
vg1SSE.ssaoEnabled = false      // kill only SSAO
vg1SSE.ssrEnabled = false       // kill only SSR

// SSAO tuning
vg1SSE.aoRadius = 8.0           // larger radius = softer, wider AO
vg1SSE.aoIntensity = 4.0        // darkness of AO shadows
vg1SSE.aoColor = 0x0a0a14       // tint color (GI approximation)
vg1SSE.aoSamples = 32           // more samples = cleaner but slower
vg1SSE.halfRes = false          // full-res AO (2× slower, sharper)
vg1SSE.quality = 'Ultra'        // 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra'

// SSR tuning
vg1SSE.ssrIntensity = 0.8       // reflection strength
vg1SSE.ssrSteps = 32            // more steps = longer rays, more GPU
vg1SSE.ssrThickness = 2.0       // depth tolerance for hits
vg1SSE.ssrMaxDistance = 200.0   // max ray travel distance in view space
vg1SSE.ssrWaterY = 0.5          // adjust if water plane Y changes

// Performance monitoring
vg1SSE.aoGpuMs                  // N8AO GPU time in ms (updated each frame)
vg1SSE.adaptiveQuality = false  // disable auto quality scaling

// Recommended presets:
// HIGH QUALITY (< 30fps acceptable):
vg1SSE.quality = 'Ultra'; vg1SSE.halfRes = false; vg1SSE.ssrSteps = 48;

// BALANCED (target 60fps):
vg1SSE.quality = 'Medium'; vg1SSE.halfRes = true; vg1SSE.ssrSteps = 24;

// PERFORMANCE (integrated GPU):
vg1SSE.quality = 'Performance'; vg1SSE.halfRes = true; vg1SSE.ssrSteps = 12;