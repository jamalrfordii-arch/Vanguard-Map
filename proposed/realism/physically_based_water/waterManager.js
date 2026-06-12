// waterManager.js — FFT Ocean surface with subsurface scattering, caustics, foam
// Consumes displacement + normal textures from fftOceanCompute.js
import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT, WATER_OPACITY } from './config.js';

// ─── Global uniforms — interface preserved for main.js ───
export const waterUniforms = {
    uTime:             { value: 0.0 },
    uSunDir:           { value: new THREE.Vector3(0.0, 1.0, 0.0) },
    uSunElevation:     { value: 1.0 },
    uHexGridScale:     { value: 18.0 },
    uHexGridIntensity: { value: 3.0  },
};

// Internal uniforms — connected to FFT output
const _fftUniforms = {
    uDisplacement0:   { value: null },
    uDisplacement1:   { value: null },
    uNormalFoam:      { value: null },
    uPatchSize0:      { value: 256.0 },
    uPatchSize1:      { value: 32.0 },
    uChoppiness:      { value: 1.5 },
    uHeightScale:     { value: 1.2 },
    uSSSIntensity:    { value: 0.25 },
    uSSSColor:        { value: new THREE.Vector3(0.1, 0.4, 0.35) },
    uFoamColor:       { value: new THREE.Vector3(0.85, 0.9, 0.95) },
    uFoamIntensity:   { value: 0.7 },
    uCausticsScale:   { value: 12.0 },
    uCausticsSpeed:   { value: 0.8 },
    uFresnelPower:    { value: 4.0 },
    uDeepColor:       { value: new THREE.Vector3(0.004, 0.055, 0.133) },
    uShallowColor:    { value: new THREE.Vector3(0.02, 0.15, 0.22) },
    uSpecularClamp:   { value: 0.89 }, // CRITICAL: must stay below bloomPass.threshold (0.95)
    uCameraPos:       { value: new THREE.Vector3() },
};

// Pre-allocated temporaries for update loop
const _camPos = new THREE.Vector3();

export function createDynamicSeaLevel(scene) {
    const seaLevelGroup = new THREE.Group();
    seaLevelGroup.name = 'dynamicSeaLevel';

    // ─── Ocean mesh — same topology as before ───
    const geo = new THREE.PlaneGeometry(MAP_WIDTH, MAP_HEIGHT, 256, 256);
    geo.rotateX(-Math.PI / 2);

    const mat = new THREE.MeshStandardMaterial({
        name:              'Water',
        color:             0x010e22,
        roughness:         0.1,
        metalness:         0.8,
        transparent:       true,
        opacity:           WATER_OPACITY,
        emissive:          0x04213d,
        emissiveIntensity: 0.38,
    });

    mat.onBeforeCompile = (shader) => {
        // Merge all uniforms into the shader
        Object.assign(shader.uniforms, waterUniforms, _fftUniforms);

        // ─── VERTEX SHADER ───
        shader.vertexShader = /* glsl */ `
            uniform float uTime;
            uniform sampler2D uDisplacement0;
            uniform sampler2D uDisplacement1;
            uniform float uPatchSize0;
            uniform float uPatchSize1;
            uniform float uChoppiness;
            uniform float uHeightScale;

            varying float vWaveHeight;
            varying vec3  vWorldNormal;
            varying vec3  vWorldPos;
            varying vec2  vUv0;
            varying vec2  vUv1;
            varying float vFoam;

            // Standard Three.js includes
            #include <common>
            #include <uv_pars_vertex>
            #include <color_pars_vertex>
            #include <fog_pars_vertex>
            #include <normal_pars_vertex>
            #include <morphtarget_pars_vertex>
            #include <skinning_pars_vertex>
            #include <shadowmap_pars_vertex>
            #include <logdepthbuf_pars_vertex>
            #include <clipping_planes_pars_vertex>

            void main() {
                #include <uv_vertex>
                #include <color_vertex>

                vec3 transformed = vec3(position);

                // Compute UVs for each cascade based on world position
                // Map width/height: position ranges from -150..+150
                vec3 worldBase = (modelMatrix * vec4(transformed, 1.0)).xyz;
                vUv0 = worldBase.xz / uPatchSize0;
                vUv1 = worldBase.xz / uPatchSize1;

                // Sample displacement from FFT cascades
                vec4 disp0 = texture2D(uDisplacement0, vUv0);
                vec4 disp1 = texture2D(uDisplacement1, vUv1);

                // Apply displacement: disp.x = dx, disp.y = height, disp.z = dz, disp.w = foam
                transformed.x += disp0.x * uChoppiness + disp1.x * uChoppiness * 0.5;
                transformed.y += disp0.y * uHeightScale + disp1.y * uHeightScale * 0.4;
                transformed.z += disp0.z * uChoppiness + disp1.z * uChoppiness * 0.5;

                vWaveHeight = transformed.y;
                vFoam = clamp(disp0.w + disp1.w * 0.5, 0.0, 1.0);

                // Compute world-space position and normal
                vec4 worldPos = modelMatrix * vec4(transformed, 1.0);
                vWorldPos = worldPos.xyz;

                // Normal from displacement finite differences (supplemented in fragment)
                vWorldNormal = normalize((modelMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);

                vec4 mvPosition = viewMatrix * worldPos;
                gl_Position = projectionMatrix * mvPosition;

                #include <logdepthbuf_vertex>
                #include <clipping_planes_vertex>
                #include <fog_vertex>
                #include <shadowmap_vertex>
            }
        `;

        // ─── FRAGMENT SHADER ───
        shader.fragmentShader = /* glsl */ `
            precision highp float;

            uniform float uTime;
            uniform vec3  uSunDir;
            uniform float uSunElevation;
            uniform float uHexGridScale;
            uniform float uHexGridIntensity;
            uniform sampler2D uNormalFoam;
            uniform sampler2D uDisplacement0;
            uniform float uPatchSize0;
            uniform float uSSSIntensity;
            uniform vec3  uSSSColor;
            uniform vec3  uFoamColor;
            uniform float uFoamIntensity;
            uniform float uCausticsScale;
            uniform float uCausticsSpeed;
            uniform float uFresnelPower;
            uniform vec3  uDeepColor;
            uniform vec3  uShallowColor;
            uniform float uSpecularClamp;
            uniform vec3  uCameraPos;

            varying float vWaveHeight;
            varying vec3  vWorldNormal;
            varying vec3  vWorldPos;
            varying vec2  vUv0;
            varying vec2  vUv1;
            varying float vFoam;

            #include <common>
            #include <packing>
            #include <fog_pars_fragment>
            #include <logdepthbuf_pars_fragment>
            #include <clipping_planes_pars_fragment>

            // ─── Caustics ───
            // Analytical caustics pattern — two scrolling voronoi-like patterns
            float causticsPattern(vec2 uv, float time) {
                vec2 p = uv * uCausticsScale;
                float t = time * uCausticsSpeed;

                // Two layers scrolling in different directions
                vec2 uv1 = p + vec2(t * 0.3, t * 0.2);
                vec2 uv2 = p * 1.4 + vec2(-t * 0.2, t * 0.35);

                // Simple caustic approximation via overlapping sine patterns
                float c1 = sin(uv1.x * 2.7 + sin(uv1.y * 3.1 + t)) *
                           sin(uv1.y * 2.3 + sin(uv1.x * 2.9 - t * 0.7));
                float c2 = sin(uv2.x * 3.1 + sin(uv2.y * 2.7 - t * 0.5)) *
                           sin(uv2.y * 2.9 + sin(uv2.x * 3.3 + t * 0.3));

                float caustic = clamp((c1 + c2) * 0.5 + 0.5, 0.0, 1.0);
                caustic = pow(caustic, 3.0); // sharpen
                return caustic * 0.15; // subtle
            }

            // ─── Hex grid ───
            vec2 hexCenter(vec2 p) {
                vec2 q = vec2(p.x * 2.0 / 1.7320508, p.y + p.x / 1.7320508);
                vec2 pi = floor(q);
                vec2 pf = fract(q);
                float v = mod(pi.x + pi.y, 3.0);
                float ca = step(1.0, v);
                float cb = step(2.0, v);
                vec2  ma = step(pf.xy, pf.yx);
                return pi + ca - cb * ma;
            }

            float hexGrid(vec2 p, float scale) {
                p *= scale;
                vec2 h = hexCenter(p);
                vec2 q = vec2(p.x * 2.0 / 1.7320508, p.y + p.x / 1.7320508);
                float d = length(q - h);
                // Edge distance
                float edge = smoothstep(0.45, 0.5, d);
                return edge;
            }

            // ─── SSS approximation ───
            float subsurfaceScattering(vec3 viewDir, vec3 lightDir, vec3 normal, float waveHeight) {
                // Light transmitting through thin wave crests
                vec3 H = normalize(lightDir + normal * 0.6);
                float VdotH = pow(clamp(dot(viewDir, -H), 0.0, 1.0), 3.0);
                // Thinner crests transmit more
                float thickness = clamp(1.0 - waveHeight * 2.0, 0.0, 1.0);
                return VdotH * thickness * uSSSIntensity;
            }

            void main() {
                #include <clipping_planes_fragment>
                #include <logdepthbuf_fragment>

                vec3 viewDir = normalize(uCameraPos - vWorldPos);

                // ─── Normal from FFT normal map ───
                vec4 normalFoam = texture2D(uNormalFoam, vUv0);
                vec3 fftNormal = normalFoam.rgb * 2.0 - 1.0;
                fftNormal = normalize(fftNormal);
                // Transform from tangent space (XY=horizontal, Z=up) to world (XZ=horizontal, Y=up)
                vec3 worldNormal = normalize(vec3(fftNormal.x, fftNormal.z, fftNormal.y));

                float foamMask = max(normalFoam.a, vFoam) * uFoamIntensity;

                // ─── Fresnel ───
                float NdotV = clamp(dot(worldNormal, viewDir), 0.0, 1.0);
                float fresnel = pow(1.0 - NdotV, uFresnelPower);
                fresnel = clamp(fresnel, 0.02, 1.0); // F0 ≈ 0.02 for water

                // ─── Depth-based color ───
                float depthFactor = clamp(-vWaveHeight * 0.5 + 0.5, 0.0, 1.0);
                vec3 waterColor = mix(uShallowColor, uDeepColor, depthFactor);

                // ─── Specular (GGX-like approximation) ───
                vec3 halfDir = normalize(uSunDir + viewDir);
                float NdotH = clamp(dot(worldNormal, halfDir), 0.0, 1.0);
                float roughness = 0.08;
                float alpha = roughness * roughness;
                float denom = NdotH * NdotH * (alpha - 1.0) + 1.0;
                float D = alpha / (3.14159 * denom * denom);
                float specular = D * fresnel;
                // CRITICAL: clamp below bloom threshold
                specular = min(specular, uSpecularClamp);

                // Sun color — warm during golden hour, white at noon
                float sunFactor = clamp(uSunElevation, 0.0, 1.0);
                vec3 sunColor = mix(vec3(1.0, 0.6, 0.3), vec3(1.0, 0.98, 0.95), sunFactor);

                // ─── SSS ───
                float sss = subsurfaceScattering(viewDir, uSunDir, worldNormal, vWaveHeight);
                vec3 sssContrib = uSSSColor * sss * sunColor;

                // ─── Caustics ───
                float caustic = causticsPattern(vWorldPos.xz * 0.01, uTime);
                // Caustics strongest at shallow depth, looking down
                caustic *= clamp(NdotV, 0.0, 1.0) * clamp(1.0 - depthFactor, 0.0, 1.0);

                // ─── Hex grid overlay ───
                float hex1 = hexGrid(vWorldPos.xz + vec2(uTime * 0.05), uHexGridScale);
                float hex2 = hexGrid(vWorldPos.xz * 0.7 + vec2(-uTime * 0.03, uTime * 0.04), uHexGridScale * 0.6);
                float hexPattern = max(hex1, hex2 * 0.5) * uHexGridIntensity;
                // Pulse with time
                hexPattern *= 0.5 + 0.5 * sin(uTime * 0.5 + vWorldPos.x * 0.1);
                // Tactical blue glow
                vec3 hexColor = vec3(0.05, 0.3, 0.6) * hexPattern * 0.04;

                // ─── Foam ───
                vec3 foamContrib = uFoamColor * foamMask * 0.5;

                // ─── Compose final color ───
                vec3 ambient = waterColor * 0.15;
                float NdotL = clamp(dot(worldNormal, uSunDir), 0.0, 1.0);
                vec3 diffuse = waterColor * NdotL * sunColor * 0.3;
                vec3 spec = sunColor * specular * 0.5;
                vec3 reflection = mix(waterColor * 0.8, vec3(0.6, 0.75, 0.85), fresnel) * fresnel * 0.3;

                vec3 finalColor = ambient + diffuse + spec + reflection + sssContrib + hexColor + foamContrib;
                finalColor += vec3(caustic * 0.5, caustic * 0.8, caustic);

                // Emissive base — preserve tactical visibility in low light
                vec3 emissive = vec3(0.016, 0.082, 0.149) * 0.38;
                finalColor += emissive;

                // Final alpha
                float alpha_out = mix(0.85, 0.95, fresnel);
                alpha_out = mix(alpha_out, 1.0, foamMask * 0.5);

                gl_FragColor = vec4(finalColor, alpha_out);

                #include <fog_fragment>
            }
        `;
    };

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'oceanSurface';
    mesh.renderOrder = 2;
    mesh.receiveShadow = true;
    seaLevelGroup.add(mesh);

    // Store reference for disposal
    seaLevelGroup.userData._waterMesh = mesh;
    seaLevelGroup.userData._waterMaterial = mat;

    scene.add(seaLevelGroup);
    return seaLevelGroup;
}

/**
 * Connect FFT compute outputs to water material uniforms.
 * Called once after both fftOceanCompute and waterManager are initialized.
 */
export function connectFFTToWater(fftCompute) {
    if (!fftCompute) return;
    // The textures are updated in-place each frame by fftOceanCompute.update()
    // We just need to point the uniforms at the right objects
    _fftUniforms.uDisplacement0.value = fftCompute.displacementTextures[0];
    _fftUniforms.uDisplacement1.value = fftCompute.displacementTextures[1];
    _fftUniforms.uNormalFoam.value = fftCompute.normalFoamTexture;
}

/**
 * Per-frame update — called from main animation loop.
 * Updates time, camera position, and re-links FFT textures.
 */
export function updateWater(time, camera, fftCompute) {
    waterUniforms.uTime.value = time;

    // Update camera position for fresnel/specular (no allocation)
    camera.getWorldPosition(_camPos);
    _fftUniforms.uCameraPos.value.copy(_camPos);

    // Re-link FFT textures (they're render target textures that get swapped)
    if (fftCompute) {
        _fftUniforms.uDisplacement0.value = fftCompute.displacementTextures[0];
        _fftUniforms.uDisplacement1.value = fftCompute.displacementTextures[1];
        _fftUniforms.uNormalFoam.value = fftCompute.normalFoamTexture;
    }
}

// ─── Console tuning ───
window.waterParams = {
    get sssIntensity()    { return _fftUniforms.uSSSIntensity.value; },
    set sssIntensity(v)   { _fftUniforms.uSSSIntensity.value = v; },
    get choppiness()      { return _fftUniforms.uChoppiness.value; },
    set choppiness(v)     { _fftUniforms.uChoppiness.value = v; },
    get heightScale()     { return _fftUniforms.uHeightScale.value; },
    set heightScale(v)    { _fftUniforms.uHeightScale.value = v; },
    get foamIntensity()   { return _fftUniforms.uFoamIntensity.value; },
    set foamIntensity(v)  { _fftUniforms.uFoamIntensity.value = v; },
    get fresnelPower()    { return _fftUniforms.uFresnelPower.value; },
    set fresnelPower(v)   { _fftUniforms.uFresnelPower.value = v; },
    get causticsScale()   { return _fftUniforms.uCausticsScale.value; },
    set causticsScale(v)  { _fftUniforms.uCausticsScale.value = v; },
    get specularClamp()   { return _fftUniforms.uSpecularClamp.value; },
    set specularClamp(v)  { _fftUniforms.uSpecularClamp.value = Math.min(v, 0.94); }, // enforce bloom safety
    get hexGridScale()    { return waterUniforms.uHexGridScale.value; },
    set hexGridScale(v)   { waterUniforms.uHexGridScale.value = v; },
    get hexGridIntensity(){ return waterUniforms.uHexGridIntensity.value; },
    set hexGridIntensity(v){ waterUniforms.uHexGridIntensity.value = v; },
    get normalStrength()  { return 2.0; }, // read-only hint; change via fftOceanParams
};