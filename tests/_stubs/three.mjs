// tests/_stubs/three.mjs — minimal THREE stub for pure-Node tests.
//
// The browser app imports THREE from a CDN via an HTML import map. Node has no
// such map, so importing any app module that does `import * as THREE from 'three'`
// would fail. This stub stands in for THREE during tests, letting us import the
// *pure math* out of THREE-coupled modules (e.g. aisManager.lonLatToScene) in
// plain Node — no browser, no GPU.
//
// It is intentionally tiny: only add a class/method here when a module under
// test actually touches it at import time or inside the code path being tested.
// If a test starts needing more of THREE than this covers, that is usually a
// sign the logic should be extracted into a pure module instead.

export class Vector3 {
    constructor(x = 0, y = 0, z = 0) {
        this.x = x;
        this.y = y;
        this.z = z;
    }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v)      { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    clone()      { return new Vector3(this.x, this.y, this.z); }
    length()     { return Math.hypot(this.x, this.y, this.z); }
}
