// shaderLint.js — static checks for the GLSL embedded in this codebase.
//
// WHY THIS EXISTS. On 2026-07-24 four separate bugs shipped in the same family:
// the shader compiles-or-fails in a way no existing gate could see.
//
//   1. A stray backtick inside a GLSL comment ("`.visible = false`"). The shader
//      is a template literal, so the backtick ENDED the string and the rest of
//      the shader was parsed as JavaScript. `node --check` passed, because the
//      wreckage was still syntactically valid JS. Cost: a boot failure reading
//      "false is not a function", and a long hunt.
//   2. `uFade` used in the vertex stage, declared only in the fragment stage.
//   3. `uTime` used in the fragment stage, declared only in the vertex stage.
//      (2) and (3) are the same bug: the two stages compile as SEPARATE programs,
//      so a uniform used in each needs a declaration in each. Symptom is a
//      silently non-rendering layer, not an exception.
//   4. `waveNormal` used in a <beginnormal_vertex> injection but declared in the
//      <begin_vertex> injection — three emits beginnormal FIRST, so it was used
//      before it existed. That shader had never compiled, for the entire life of
//      the file, and the failure had been misfiled as a Three.js cache bug.
//
// None of these are catchable by node --check or by any JS linter, and all four
// present as "the thing just doesn't render" rather than as an error. Hence a
// dedicated pass. Pure string analysis — no THREE, no DOM, no GL context.

// three emits these hooks in this order inside the vertex shader. Anything
// injected at an earlier hook cannot reference something declared at a later one.
export const VERTEX_HOOK_ORDER = [
    'beginnormal_vertex',
    'morphnormal_vertex',
    'skinbase_vertex',
    'skinnormal_vertex',
    'defaultnormal_vertex',
    'begin_vertex',
    'morphtarget_vertex',
    'skinning_vertex',
    'displacementmap_vertex',
    'project_vertex',
];

/** Strip GLSL/JS comments so identifier scans don't trip over prose. */
export function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Locate the big shader template literals. Handles both shapes this codebase uses:
 *   vertexShader: `...`            (object literal, e.g. terrainBuilder)
 *   shader.vertexShader = `...`    (onBeforeCompile, e.g. waterManager)
 * Returns [{ stage, startLine, endLine, body }] with 1-based line numbers.
 */
export function findShaderSpans(src) {
    const lines = src.split('\n');
    const spans = [];
    const opener = /(?:^|[\s.])(vertexShader|fragmentShader)\s*[:=]\s*(?:\/\*\s*glsl\s*\*\/\s*)?`/;

    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(opener);
        if (!m) continue;
        // Closing delimiter: a line that is just a backtick, optionally followed
        // by a comma/semicolon, or that begins a .replace() chain.
        let end = -1;
        for (let j = i + 1; j < lines.length; j++) {
            const t = lines[j].trim();
            if (t === '`' || t === '`,' || t === '`;' || t.startsWith('`.replace(')) { end = j; break; }
        }
        if (end === -1) continue;   // unterminated — the backtick check below will catch it
        spans.push({
            stage: m[1],
            startLine: i + 1,
            endLine: end + 1,
            body: lines.slice(i + 1, end).join('\n'),
        });
        i = end;
    }
    return spans;
}

/**
 * CHECK 1 — no backtick inside a shader template except its delimiters.
 * This is the one node --check structurally cannot see.
 */
export function lintStrayBackticks(src, file = '') {
    const lines = src.split('\n');
    const problems = [];
    for (const span of findShaderSpans(src)) {
        // Body lines only. startLine/endLine are 1-based and `lines` is 0-based,
        // so lines[startLine] is the first body line and lines[endLine - 1] is the
        // CLOSING delimiter — which must be excluded or every span self-reports.
        for (let n = span.startLine; n < span.endLine - 1; n++) {
            if (lines[n].includes('`')) {
                problems.push({
                    file, line: n + 1, rule: 'stray-backtick',
                    message: `backtick inside the ${span.stage} template ends the string early; `
                           + `the rest of the shader becomes JavaScript. Text: ${lines[n].trim().slice(0, 70)}`,
                });
            }
        }
    }
    return problems;
}

/**
 * CHECK 2 — every uniform referenced in a stage is declared in THAT stage.
 * Vertex and fragment compile as separate programs; a shared uniform needs a
 * declaration in each. Convention here: uniforms are named uSomething.
 */
export function lintUniformDeclarations(src, file = '') {
    const problems = [];
    for (const span of findShaderSpans(src)) {
        const body = stripComments(span.body);
        const declared = new Set([...body.matchAll(/\buniform\s+\w+\s+(\w+)/g)].map(m => m[1]));
        const used = new Set([...body.matchAll(/\bu[A-Z]\w*/g)].map(m => m[0]));
        for (const name of used) {
            if (!declared.has(name)) {
                problems.push({
                    file, line: span.startLine, rule: 'undeclared-uniform',
                    message: `'${name}' is used in the ${span.stage} but not declared in it. `
                           + `Stages compile separately — declare it in both.`,
                });
            }
        }
    }
    return problems;
}

/**
 * CHECK 3 — injection ordering. An identifier declared in a LATER three include
 * hook cannot be referenced from an EARLIER one. Scans .replace('#include <hook>', `body`)
 * chains and compares against VERTEX_HOOK_ORDER.
 */
export function lintHookOrdering(src, file = '') {
    const problems = [];
    const re = /`#include <(\w+)>`\s*,\s*`([\s\S]*?)`\s*\)/g;
    const injections = [];
    for (const m of src.matchAll(re)) {
        const idx = VERTEX_HOOK_ORDER.indexOf(m[1]);
        if (idx !== -1) injections.push({ hook: m[1], order: idx, body: stripComments(m[2]) });
    }
    for (const inj of injections) {
        // Identifiers this injection DECLARES (vec3 foo = ..., float bar = ...).
        const declares = new Set([...inj.body.matchAll(/\b(?:float|int|vec[234]|mat[234])\s+(\w+)\s*=/g)].map(m => m[1]));
        for (const other of injections) {
            if (other.order <= inj.order) continue;   // only later hooks matter
            const laterDeclares = new Set(
                [...other.body.matchAll(/\b(?:float|int|vec[234]|mat[234])\s+(\w+)\s*=/g)].map(m => m[1]));
            for (const name of laterDeclares) {
                if (declares.has(name)) continue;     // also declared here — fine
                const usedHere = new RegExp(`\\b${name}\\b`).test(inj.body);
                if (usedHere) {
                    problems.push({
                        file, line: 0, rule: 'hook-ordering',
                        message: `'${name}' is used in the <${inj.hook}> injection but declared in `
                               + `<${other.hook}>, which three emits LATER. Move the declaration earlier.`,
                    });
                }
            }
        }
    }
    return problems;
}

/** Run every check over one source string. */
export function lintSource(src, file = '') {
    return [
        ...lintStrayBackticks(src, file),
        ...lintUniformDeclarations(src, file),
        ...lintHookOrdering(src, file),
    ];
}
