// ── After creating the splat cloud, expose biome controls ────────────────────
// Add near the existing window.splatCloud assignment:

window.splatBiome = {
    get strength()       { return _splatCloud.material.uniforms.uBiomeStrength.value; },
    set strength(v)      { _splatCloud.material.uniforms.uBiomeStrength.value = v; },
    get polarLatitude()  { return _splatCloud.material.uniforms.uPolarLatitude.value; },
    set polarLatitude(v) { _splatCloud.material.uniforms.uPolarLatitude.value = v; },
    get desertMaxLat()   { return _splatCloud.material.uniforms.uDesertMaxLat.value; },
    set desertMaxLat(v)  { _splatCloud.material.uniforms.uDesertMaxLat.value = v; },
    get iceSpecPower()   { return _splatCloud.material.uniforms.uIceSpecularPower.value; },
    set iceSpecPower(v)  { _splatCloud.material.uniforms.uIceSpecularPower.value = v; },
};
// Usage in DevTools:
//   window.splatBiome.strength = 0.5;
//   window.splatBiome.polarLatitude = 55;  // extend ice further south