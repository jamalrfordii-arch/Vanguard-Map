// ── In the vertex shader of the splat cloud ShaderMaterial ───────────────────
// Add these lines alongside the existing vColor/vElevation outputs:

const splatVertexShaderAdditions = /* glsl */ `
    // ◆ BIOME: pass world-space Z to fragment for latitude computation
    // Add this varying declaration at the top alongside existing ones:
    //   out float vWorldZ;
    //
    // Add this line in main() after computing world position:
    //   vWorldZ = worldPosition.z;
`;