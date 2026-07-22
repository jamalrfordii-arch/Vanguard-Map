// tests/_stubs/resolve-three.mjs — the resolve hook itself.
// Redirects `three` (and any `three/...` subpath) to the local stub so that
// app modules importing THREE can be loaded in Node during tests.

const STUB = new URL('./three.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'three' || specifier.startsWith('three/')) {
        return { url: STUB, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
