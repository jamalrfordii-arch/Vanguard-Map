// tests/shaderLint.test.mjs — the guard that would have caught 2026-07-24.
// Run from repo root:  node tests/shaderLint.test.mjs
//
// Two halves:
//   1. Unit tests that REPLAY the four real bugs from 2026-07-24 as synthetic
//      sources, proving the linter actually catches them. A guard nobody has seen
//      fail is not a guard.
//   2. A sweep over every real shader file in the repo, asserting it is clean.
//
// Every one of those four bugs presented as "the layer silently doesn't render",
// passed `node --check`, and was invisible to any JS linter.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    lintSource, lintStrayBackticks, lintUniformDeclarations, lintHookOrdering,
    findShaderSpans, VERTEX_HOOK_ORDER,
} from '../shaderLint.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// ── Span detection ───────────────────────────────────────────────────────────
console.log('span detection');

test('finds both object-literal and assignment shader forms', () => {
    const objForm = 'const m = {\n    vertexShader: /* glsl */`\n    void main() {}\n    `,\n};';
    const asgForm = 'shader.fragmentShader = `\n    void main() {}\n`;';
    assert.equal(findShaderSpans(objForm).length, 1, 'vertexShader: `...` not found');
    assert.equal(findShaderSpans(asgForm).length, 1, 'shader.fragmentShader = `...` not found');
});

test('a span reports the right stage', () => {
    const src = 'shader.vertexShader = `\n uniform float uA;\n`;';
    assert.equal(findShaderSpans(src)[0].stage, 'vertexShader');
});

// ── Bug 1: the stray backtick ────────────────────────────────────────────────
console.log('stray backtick (the one node --check cannot see)');

test('catches a backtick inside a GLSL comment', () => {
    // This is the real shape of the 2026-07-24 boot failure: a comment mentioning
    // a JS expression in backticks, inside the shader template.
    const src = [
        'const m = {',
        '    vertexShader: /* glsl */`',
        '        void main() {',
        '            // the old `.visible = false` cull was buying this',
        '            gl_Position = vec4(0.0);',
        '        }',
        '    `,',
        '};',
    ].join('\n');
    const p = lintStrayBackticks(src, 'synthetic.js');
    assert.equal(p.length, 1, 'should flag exactly one stray backtick');
    assert.equal(p[0].rule, 'stray-backtick');
    assert.match(p[0].message, /becomes JavaScript/);
});

test('does not flag the template delimiters themselves', () => {
    const src = 'shader.vertexShader = `\n    void main() {}\n`;';
    assert.deepEqual(lintStrayBackticks(src, 'ok.js'), []);
});

// ── Bugs 2 and 3: cross-stage uniform declarations ───────────────────────────
console.log('cross-stage uniform declarations');

test('catches a uniform used in the vertex stage but declared only in fragment', () => {
    // The real uFade bug: declared in the fragment prelude, used by new vertex code.
    const src = [
        'const m = {',
        '    vertexShader: `',
        '        uniform float uOther;',
        '        void main() { float f = uFade; }',
        '    `,',
        '    fragmentShader: `',
        '        uniform float uFade;',
        '        void main() { gl_FragColor = vec4(uFade); }',
        '    `,',
        '};',
    ].join('\n');
    const p = lintUniformDeclarations(src, 'synthetic.js');
    assert.equal(p.length, 1);
    assert.match(p[0].message, /'uFade' is used in the vertexShader/);
});

test('catches a uniform used in the fragment stage but declared only in vertex', () => {
    // The real uTime bug in waterManager.
    const src = [
        'shader.vertexShader = `',
        '    uniform float uTime;',
        '    void main() { float t = uTime; }',
        '`;',
        'shader.fragmentShader = `',
        '    uniform vec3 uSunDir;',
        '    void main() { gl_FragColor = vec4(uTime); }',
        '`;',
    ].join('\n');
    const p = lintUniformDeclarations(src, 'synthetic.js');
    assert.equal(p.length, 1);
    assert.match(p[0].message, /'uTime' is used in the fragmentShader/);
});

test('a uniform declared in BOTH stages is fine', () => {
    const src = [
        'shader.vertexShader = `',
        '    uniform float uTime;',
        '    void main() { float t = uTime; }',
        '`;',
        'shader.fragmentShader = `',
        '    uniform float uTime;',
        '    void main() { gl_FragColor = vec4(uTime); }',
        '`;',
    ].join('\n');
    assert.deepEqual(lintUniformDeclarations(src, 'ok.js'), []);
});

test('uniform names appearing only in COMMENTS do not false-positive', () => {
    // An earlier hand-rolled version of this check flagged prose like "uTilt²"
    // and words in comments. Comments must be stripped before scanning.
    const src = [
        'shader.vertexShader = `',
        '    uniform float uReal;',
        '    // uFade is deliberately NOT used here, see uOther in the fragment',
        '    /* uAnother mention of uSomething */',
        '    void main() { float x = uReal; }',
        '`;',
    ].join('\n');
    assert.deepEqual(lintUniformDeclarations(src, 'ok.js'), []);
});

// ── Bug 4: three include-hook ordering ───────────────────────────────────────
console.log('include-hook ordering');

test('three emits beginnormal_vertex before begin_vertex', () => {
    // The whole check rests on this ordering; assert it explicitly so the
    // assumption is visible rather than buried in a constant.
    assert.ok(VERTEX_HOOK_ORDER.indexOf('beginnormal_vertex')
            < VERTEX_HOOK_ORDER.indexOf('begin_vertex'));
});

test('catches an identifier used in an earlier hook but declared in a later one', () => {
    // The real waveNormal bug, which meant waterManager never compiled at all.
    const src = [
        'shader.vertexShader = base',
        '  .replace(`#include <begin_vertex>`, `',
        '      vec3 waveNormal = normalize(cross(b, t));',
        '      vec3 transformed = p;',
        '  `)',
        '  .replace(`#include <beginnormal_vertex>`, `',
        '      vec3 objectNormal = waveNormal;',
        '  `);',
    ].join('\n');
    const p = lintHookOrdering(src, 'synthetic.js');
    assert.equal(p.length, 1);
    assert.match(p[0].message, /'waveNormal'.*<beginnormal_vertex>.*<begin_vertex>.*LATER/s);
});

test('the corrected ordering passes', () => {
    // Declaration moved into the earlier hook — how waterManager reads now.
    const src = [
        'shader.vertexShader = base',
        '  .replace(`#include <beginnormal_vertex>`, `',
        '      vec3 waveNormal = normalize(cross(b, t));',
        '      vec3 objectNormal = waveNormal;',
        '  `)',
        '  .replace(`#include <begin_vertex>`, `',
        '      vec3 transformed = p;',
        '  `);',
    ].join('\n');
    assert.deepEqual(lintHookOrdering(src, 'ok.js'), []);
});

// ── The actual guard: sweep the repo ─────────────────────────────────────────
console.log('repo sweep');

test('every shader file in the repo is clean', () => {
    const files = readdirSync(ROOT).filter(f => f.endsWith('.js'));
    const all = [];
    let scanned = 0;
    for (const f of files) {
        const src = readFileSync(join(ROOT, f), 'utf8');
        if (!findShaderSpans(src).length && !src.includes('#include <')) continue;
        scanned++;
        all.push(...lintSource(src, f));
    }
    assert.ok(scanned > 0, 'no shader files found — the sweep is not actually scanning anything');
    if (all.length) {
        const detail = all.map(p => `    ${p.file}:${p.line} [${p.rule}] ${p.message}`).join('\n');
        assert.fail(`${all.length} shader problem(s) across ${scanned} file(s):\n${detail}`);
    }
    console.log(`      (${scanned} shader-bearing files scanned, all clean)`);
});

console.log(`\n${passed} passed`);
