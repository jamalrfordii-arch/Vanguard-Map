// tests/_stubs/register.mjs — registers the module-resolution hook that maps
// the bare `three` specifier to our local stub (tests/_stubs/three.mjs).
//
// Loaded once per `node` process via the `--import` flag (see package.json
// "test" script). Harmless to any test that doesn't import THREE-coupled code —
// it only intercepts the `three` specifier and passes everything else through.

import { register } from 'node:module';

register('./resolve-three.mjs', import.meta.url);
