#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  VANGUARD  —  Realism Engine Agent                              ║
 * ║                                                                  ║
 * ║  Pushes Vanguard1 toward Unreal Engine 5 visual quality in      ║
 * ║  Three.js / WebGL. Each run selects one rendering domain,       ║
 * ║  researches the UE5 technique AND its best available WebGL      ║
 * ║  equivalent, then generates complete ready-to-apply code.       ║
 * ║                                                                  ║
 * ║  Domains (rotated automatically, never repeated until all done):║
 * ║    volumetric_atmosphere · physically_based_water · terrain_pbr ║
 * ║    screen_space_effects  · dynamic_lighting · particle_vfx      ║
 * ║    post_processing       · lod_and_culling  · environmental_vfx ║
 * ║    holographic_display                                           ║
 * ║                                                                  ║
 * ║  Output: proposed/realism/REALISM_[DOMAIN]_[DATE].md            ║
 * ║          proposed/realism/[domain]/[technique].js               ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Usage:
 *   node realism-engine-agent.js                    ← auto-picks next domain
 *   node realism-engine-agent.js --domain water     ← force a specific domain
 *   node realism-engine-agent.js --fresh            ← ignore research cache
 *
 * Built on generateComplete() — proposals are NEVER truncated.
 */

import Anthropic         from '@anthropic-ai/sdk';
import fs                from 'fs';
import path              from 'path';
import { fileURLToPath } from 'url';
import { generateComplete } from './agent-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT   = path.join(__dirname, '..');
const PROPOSED  = path.join(PROJECT, 'proposed', 'realism');
const CACHE_DIR = path.join(__dirname, 'reports');
const DATE_STR  = new Date().toISOString().slice(0, 10);

const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DOMAIN_FLAG = (() => { const i = process.argv.indexOf('--domain'); return i !== -1 ? process.argv[i+1] : null; })();
const FRESH       = process.argv.includes('--fresh');

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function log(msg)     { console.log(`\x1b[95m[REALISM]\x1b[0m ${msg}`); }
function phase(msg)   { console.log(`\n\x1b[1m\x1b[95m━━ ${msg} ━━\x1b[0m`); }
function ok(msg)      { console.log(`\x1b[32m✓  ${msg}\x1b[0m`); }
function readSafe(p, max = 3000) {
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').slice(0, max) : '';
}

// ── Domain registry ───────────────────────────────────────────────────────────
// Each domain defines: what UE5 calls it, what to search for, and how to
// frame the code-generation prompt for Vanguard1's specific architecture.

const DOMAINS = {
    volumetric_atmosphere: {
        label:       'Volumetric Atmosphere & Sky',
        ue5Equiv:    'Sky Atmosphere, Volumetric Clouds, Exponential Height Fog',
        searchFocus: `Search for: three.js atmospheric scattering 2025 precomputed, WebGL volumetric clouds ray marching three.js, GLSL sky shader Rayleigh Mie scattering implementation, three.js r184 sky atmosphere, "@takram/three-atmosphere" three.js, three.js volumetric fog height-based 2025, WebGL god rays crepuscular rays implementation three.js, Bruneton atmospheric scattering WebGL port`,
        codeContext: 'sceneSetup.js,skyManager.js,fogManager.js,cloudManager.js',
        goal:        'Physically correct sky scattering, volumetric clouds with real lighting, height fog that interacts with the sun direction',
    },

    physically_based_water: {
        label:       'Physically Based Water',
        ue5Equiv:    'Water System, FFT Ocean, Caustics',
        searchFocus: `Search for: three.js FFT ocean simulation WebGL2 2025, GLSL Jonswap spectrum ocean waves three.js, WebGL water caustics rendering real-time, three.js ocean subsurface scattering, GLSL water surface foam simulation, three.js water normal map animation, WebGL2 compute shader wave simulation, physically based water rendering WebGL`,
        codeContext: 'waterManager.js',
        goal:        'FFT-based wave spectrum replacing Gerstner, real-time caustics projected on ocean floor, subsurface scattering for shallows',
    },

    terrain_pbr: {
        label:       'Terrain PBR & Surface Detail',
        ue5Equiv:    'Landscape Material, Virtual Heightfield Mesh, Nanite',
        searchFocus: `Search for: three.js terrain PBR material 2025, WebGL triplanar texture mapping terrain GLSL, three.js heightmap tessellation displacement, GLSL terrain splat blending PBR, WebGL2 virtual texture terrain three.js, three.js mesh detail normal map terrain, GLSL macro micro surface detail, real-time terrain rendering WebGL LOD 2025`,
        codeContext: 'terrainBuilder.js,continentMesh.js',
        goal:        'Triplanar PBR with albedo/roughness/normal per biome, macro-detail normal maps, elevation-based biome transitions',
    },

    screen_space_effects: {
        label:       'Screen Space Effects (SSAO, SSR, SSGI)',
        ue5Equiv:    'Lumen (Screen Space), SSAO, Screen Space Reflections',
        searchFocus: `Search for: three.js SSAO screen space ambient occlusion 2025, N8AO three.js implementation, WebGL screen space reflections three.js, three.js HBAO horizon based ambient occlusion, GTAO ground truth ambient occlusion WebGL, three.js screen space global illumination, three.js r184 SSGI, WebGL2 bent normals ambient occlusion`,
        codeContext: 'sceneSetup.js',
        goal:        'N8AO or GTAO ambient occlusion pass, screen space reflections on water surfaces, temporal accumulation for stability',
    },

    dynamic_lighting: {
        label:       'Dynamic Lighting & Shadows',
        ue5Equiv:    'Lumen, Cascaded Shadow Maps, Ray Traced Shadows',
        searchFocus: `Search for: three.js cascaded shadow maps CSM 2025, three-csm package implementation, WebGL soft shadows PCSS three.js, three.js directional light shadow quality improvement, WebGL2 VSM variance shadow maps three.js, three.js area light soft shadows, real-time shadow mapping techniques WebGL 2025, three.js shadow map bias cascade`,
        codeContext: 'sceneSetup.js,main.js',
        goal:        'Cascaded shadow maps for large-scale terrain, PCSS soft shadows, correct shadow cascade seam blending',
    },

    particle_vfx: {
        label:       'Particle VFX & GPU Simulation',
        ue5Equiv:    'Niagara Particle System, GPU Simulation',
        searchFocus: `Search for: three.js GPGPU particle system 2025, WebGL2 transform feedback particles three.js, three.js GPUComputationRenderer advanced techniques, GLSL particle simulation forces WebGL, three.js instanced particles performance, WebGL2 ping pong FBO particle advection, three.js particle trail effect GPU, three.js 65536 particles performance optimization`,
        codeContext: 'gfsWindManager.js,oceanCurrentManager.js',
        goal:        'Turbulent particle forces (curl noise, vorticity), GPU-side collision with terrain, particle LOD based on camera distance',
    },

    post_processing: {
        label:       'Post Processing Stack',
        ue5Equiv:    'Post Process Volume: bloom, lens, color grading, motion blur',
        searchFocus: `Search for: three.js post processing pipeline 2025 r184, three.js UnrealBloomPass selective 2025, WebGL lens flare implementation three.js, three.js chromatic aberration vignette, three.js color grading LUT post process, WebGL temporal anti-aliasing TAA three.js, three.js depth of field bokeh 2025, three.js motion blur post process WebGL`,
        codeContext: 'sceneSetup.js,taaManager.js,fogManager.js',
        goal:        'Selective bloom on emissive-only layer, LUT-based color grading, improved TAA, subtle lens effects (chromatic aberration, vignette)',
    },

    lod_and_culling: {
        label:       'LOD, Culling & Render Performance',
        ue5Equiv:    'Nanite, HLOD, Occlusion Culling',
        searchFocus: `Search for: three.js LOD system 2025, three.js BVH frustum culling three.ez, @three.ez/instanced-mesh LOD, WebGL occlusion culling three.js, three.js instanced mesh LOD levels, three.js mesh BVH three-mesh-bvh, WebGL indirect rendering three.js, three.js render order optimization 2025`,
        codeContext: 'entityBuilder.js,portManager.js,instancedSatManager.js',
        goal:        'BVH-accelerated frustum culling for all instanced meshes, 3-level LOD for vessels, occlusion query culling for buildings',
    },

    environmental_vfx: {
        label:       'Environmental VFX (Weather, Fire, Lightning)',
        ue5Equiv:    'Niagara Weather Effects, Volumetric Lightning',
        searchFocus: `Search for: three.js lightning bolt procedural GLSL 2025, WebGL rain simulation particles three.js, three.js storm cloud volumetric rendering, GLSL procedural lightning arc shader, three.js fire simulation WebGL, WebGL weather effects real-time three.js, three.js snow particle system GPU, three.js aurora borealis shader WebGL 2025`,
        codeContext: 'gfsWindManager.js,lightningManager.js',
        goal:        'Procedural lightning arcs tied to weather data, GPU rain/spray near vessels in storms, aurora borealis geomagnetic storm response',
    },

    holographic_display: {
        label:       'Holographic Display Aesthetics',
        ue5Equiv:    'Custom Post Process, Material Emissive, UI 3D Widgets',
        searchFocus: `Search for: three.js holographic effect GLSL 2025, WebGL scanline CRT shader three.js, three.js data visualization 3D hologram effect, GLSL interference pattern holographic, three.js emissive bloom selective layers, WebGL 3D UI element rendering three.js, sci-fi tactical display three.js shader, WebGL projection hologram distortion GLSL`,
        codeContext: 'sceneSetup.js,uiController.js',
        goal:        'Selective bloom on all emissive data layers, scanline/interference overlay, holographic distortion on 3D UI elements, atmospheric rim glow on globe',
    },
};

// ── Pick next domain ───────────────────────────────────────────────────────────

function pickDomain() {
    if (DOMAIN_FLAG) return DOMAIN_FLAG;
    ensureDir(PROPOSED);
    const done = fs.readdirSync(PROPOSED)
        .filter(f => f.startsWith('REALISM_') && f.endsWith('.md'))
        .map(f => f.replace(/^REALISM_/, '').replace(/_\d{4}-\d{2}-\d{2}\.md$/, ''));
    const keys = Object.keys(DOMAINS);
    // Return first domain not yet done
    const next = keys.find(k => !done.includes(k));
    return next || keys[done.length % keys.length]; // cycle if all done
}

// ── Phase 1: Read codebase context ────────────────────────────────────────────

function readCodeContext(domain) {
    const def = DOMAINS[domain];
    const files = (def.codeContext || '').split(',').map(f => f.trim());
    return files.map(f => {
        const content = readSafe(path.join(PROJECT, f), 3000);
        return content ? `\n// ── ${f} ──\n${content}` : '';
    }).join('\n');
}

// ── Phase 2: Research ─────────────────────────────────────────────────────────

async function research(domain) {
    const def       = DOMAINS[domain];
    const cacheFile = path.join(CACHE_DIR, `realism-cache-${DATE_STR}-${domain}.txt`);
    ensureDir(CACHE_DIR);

    if (!FRESH && fs.existsSync(cacheFile)) {
        const cached = fs.readFileSync(cacheFile, 'utf8');
        log(`  Resuming from cache (${cached.length} chars)`);
        return cached;
    }

    const messages = [{
        role: 'user',
        content: `You are researching how to implement "${def.label}" in Three.js r184 / WebGL2 to match the visual quality of Unreal Engine 5's "${def.ue5Equiv}".

Vanguard1 is a real-time 3D tactical intelligence map. The goal is near-photorealistic quality running at 60fps in a browser.

${def.searchFocus}

Find:
1. The best available Three.js / WebGL implementation (GitHub repos, npm packages, Three.js examples)
2. The key GLSL techniques needed
3. Performance characteristics and GPU cost
4. Any Three.js r184-specific APIs that enable this
5. Real working code examples or demos

Return detailed findings with GitHub URLs, code snippets, and performance notes.`,
    }];

    let text = '';
    let iters = 0;

    while (iters < 5) {
        iters++;
        log(`  Search round ${iters}/5…`);
        const response = await client.messages.create({
            model:      'claude-opus-4-6',
            max_tokens: 6000,
            tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
            messages,
        });
        const blocks = response.content.filter(b => b.type === 'text');
        if (blocks.length) text += blocks.map(b => b.text).join('\n');
        if (response.stop_reason === 'end_turn') break;
        if (response.stop_reason === 'tool_use') {
            messages.push({ role: 'assistant', content: response.content });
            messages.push({
                role: 'user',
                content: response.content
                    .filter(b => b.type === 'tool_use')
                    .map(b => ({ type: 'tool_result', tool_use_id: b.id, content: '' })),
            });
        } else break;
    }

    if (!text.trim()) {
        // Fallback to knowledge base
        const fb = await client.messages.create({
            model:      'claude-opus-4-6',
            max_tokens: 4000,
            messages:   [{ role: 'user', content: `Research ${def.label} techniques for Three.js r184 to match UE5 quality. Provide specific GitHub repos, GLSL techniques, npm packages, and code examples. Be very concrete and technical.` }],
        });
        text = fb.content.filter(b => b.type === 'text').map(b => b.text).join('');
    }

    if (text.trim()) fs.writeFileSync(cacheFile, text, 'utf8');
    return text;
}

// ── Phase 3: Generate implementation ──────────────────────────────────────────

async function generateImplementation(domain, researchText, codeContext) {
    const def = DOMAINS[domain];

    const claudeMd = readSafe(path.join(PROJECT, 'CLAUDE.md'), 4000);

    return generateComplete(client, {
        model:      'claude-opus-4-6',
        max_tokens: 16000,
        system: `You are a senior graphics engineer implementing UE5-quality rendering in Three.js r184 for Vanguard1, a 3D tactical intelligence map.

ARCHITECTURE RULES (CRITICAL — violations break the codebase):
${claudeMd}

TARGET: Match the visual quality of Unreal Engine 5's "${def.ue5Equiv}" using Three.js + GLSL ES 3.00.
GOAL: ${def.goal}

CURRENT CODE CONTEXT:
${codeContext}

IMPORTANT:
- ES modules only, no bundler
- All GLSL must be valid GLSL ES 3.00
- No new THREE.Vector3() inside update() loops
- New managers must register with layerManager
- Communicate between managers via window.dispatchEvent(new CustomEvent('vg1:...'))
- Always write COMPLETE code — never truncate or use "// ... rest of implementation"`,

        messages: [{
            role: 'user',
            content: `Research findings for "${def.label}":

${researchText.slice(0, 5000)}

---

Generate a complete, production-ready implementation for Vanguard1. Provide:

## Implementation Report: ${def.label}

### UE5 vs WebGL Comparison
(What UE5 does vs what's achievable in WebGL2/Three.js r184 — be honest about the gap)

### Chosen Approach
(The specific technique you're implementing and why it's the best available)

### Performance Budget
(GPU cost estimate, draw calls added, memory usage)

### Risk Assessment
(What could break in Vanguard1's existing pipeline — reference CLAUDE.md warnings)

---

### Complete Code

For each file to create or modify, provide the COMPLETE implementation:

\`\`\`javascript
// filename.js — full content here, no truncation
\`\`\`

If modifying an existing file (e.g. sceneSetup.js, main.js), show ONLY the specific section to replace with clear before/after markers.

### Integration Instructions
(Exact lines to add to main.js — import, instantiation, update call)

### Console Tuning
(window.* properties exposed for live DevTools adjustment)`,
        }],
    });
}

// ── Phase 4: Write outputs ─────────────────────────────────────────────────────

function writeOutputs(domain, researchText, implementationText) {
    const def     = DOMAINS[domain];
    const dir     = path.join(PROPOSED, domain);
    ensureDir(PROPOSED);
    ensureDir(dir);

    // Research notes
    fs.writeFileSync(
        path.join(dir, `RESEARCH_${DATE_STR}.md`),
        `# ${def.label} — Research Notes\n\n*${DATE_STR}*\n\n${researchText}`,
        'utf8'
    );

    // Full implementation report
    const reportPath = path.join(PROPOSED, `REALISM_${domain}_${DATE_STR}.md`);
    fs.writeFileSync(
        reportPath,
        `# Realism: ${def.label}\n\n*${DATE_STR}*\n\n> UE5 Equivalent: ${def.ue5Equiv}\n\n${implementationText}`,
        'utf8'
    );
    ok(`Report → proposed/realism/REALISM_${domain}_${DATE_STR}.md`);

    // Extract code blocks into separate files
    const codeBlocks = [...implementationText.matchAll(/```(?:javascript|js|glsl)?\n([\s\S]*?)```/g)];
    codeBlocks.forEach((match, i) => {
        const code = match[1].trim();
        if (code.length < 80) return;
        // Try to extract filename from first line comment
        const firstLine = code.split('\n')[0];
        const nameMatch = firstLine.match(/\/\/\s*([\w.-]+\.(js|glsl))/);
        const filename  = nameMatch ? nameMatch[1] : `implementation_${i + 1}.js`;
        fs.writeFileSync(path.join(dir, filename), code, 'utf8');
        ok(`Code → proposed/realism/${domain}/${filename}`);
    });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    if (!process.env.ANTHROPIC_API_KEY) {
        console.error('Error: ANTHROPIC_API_KEY not set.');
        process.exit(1);
    }

    const domain = pickDomain();
    if (!DOMAINS[domain]) {
        console.error(`Unknown domain "${domain}". Available: ${Object.keys(DOMAINS).join(', ')}`);
        process.exit(1);
    }
    const def = DOMAINS[domain];

    console.log('\n╔════════════════════════════════════════════════════╗');
    console.log('║   VANGUARD — Realism Engine Agent                  ║');
    console.log(`║   Domain: ${domain.padEnd(40)}║`);
    console.log(`║   Target: ${def.ue5Equiv.slice(0, 40).padEnd(40)}║`);
    console.log('╚════════════════════════════════════════════════════╝\n');

    phase('PHASE 1 — READING CODEBASE');
    const codeContext = readCodeContext(domain);
    ok(`Code context loaded (${codeContext.length} chars)`);

    phase('PHASE 2 — RESEARCHING TECHNIQUES');
    const researchText = await research(domain);
    ok(`Research complete (${researchText.length} chars)`);

    phase('PHASE 3 — GENERATING IMPLEMENTATION');
    log('Generating complete UE5-quality implementation...');
    const implText = await generateImplementation(domain, researchText, codeContext);
    ok(`Implementation generated (${implText.length} chars)`);

    phase('PHASE 4 — WRITING OUTPUTS');
    writeOutputs(domain, researchText, implText);

    // Determine next domain
    const keys = Object.keys(DOMAINS);
    const idx  = keys.indexOf(domain);
    const next = keys[(idx + 1) % keys.length];

    console.log('\n╔════════════════════════════════════════════════════╗');
    console.log('║   DONE                                             ║');
    console.log(`║   proposed/realism/REALISM_${domain.slice(0,20).padEnd(20)}_${DATE_STR.slice(5)} ║`);
    console.log('╚════════════════════════════════════════════════════╝\n');

    log(`Next run will research: ${next.replace(/_/g, ' ')}`);
    log('Run: node realism-engine-agent.js');
}

main().catch(err => {
    console.error('[REALISM] Fatal:', err.message);
    ensureDir(PROPOSED);
    fs.writeFileSync(
        path.join(PROPOSED, `ERROR_${DATE_STR}.md`),
        `# Realism Agent Error — ${DATE_STR}\n\n${err.message}\n\n${err.stack}`,
        'utf8'
    );
    process.exit(1);
});
