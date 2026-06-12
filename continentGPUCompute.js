// continentGPUCompute.js — WebGPU availability probe + optional GPU normal-map compute
//
// Provides two exports:
//   probeWebGPU()
//       Async.  Returns { supported:true, adapter, device } if the browser exposes
//       a WebGPU device with compute-shader support, otherwise { supported:false }.
//
//   computeNormalsGPU(device, elevF32, gridW, gridH, elevScale, mapWidth)
//       Async.  Runs a WGSL compute shader (one workgroup per 8×8 block of pixels)
//       that converts a Float32 elevation grid → Uint8Array RGBA normal map.
//       The output is byte-for-byte equivalent to what generate_normals.py produces
//       at ELEV_SCALE=5, so callers can feed it straight into THREE.DataTexture.
//
// Usage in main.js / continentMesh.js:
//   import { probeWebGPU, computeNormalsGPU } from './continentGPUCompute.js';
//   const gpu = await probeWebGPU();
//   if (gpu.supported) {
//       const rgba = await computeNormalsGPU(gpu.device, elevGrid, w, h);
//       // create THREE.DataTexture from rgba …
//   }
//   // else: fall back to pre-baked terrain_normals.png

// ── WebGPU probe ──────────────────────────────────────────────────────────────

/**
 * Detect WebGPU + compute-shader support.
 * Always resolves (never rejects) so callers can safely await it without try/catch.
 */
export async function probeWebGPU() {
    if (typeof navigator === 'undefined' || !navigator.gpu) {
        return { supported: false, reason: 'navigator.gpu absent' };
    }
    try {
        const adapter = await navigator.gpu.requestAdapter({
            powerPreference: 'high-performance',
        });
        if (!adapter) return { supported: false, reason: 'No adapter' };

        // Verify compute pipeline is available (all WebGPU adapters support it,
        // but this also lets us confirm device creation works)
        const device = await adapter.requestDevice({
            label: 'vanguard-compute',
        });

        // Listen for device loss so callers can degrade gracefully
        device.lost.then(info => {
            console.warn('[GPUCompute] Device lost:', info.message);
        });

        console.info('[GPUCompute] WebGPU device acquired:', adapter.info?.description ?? 'unknown GPU');
        return { supported: true, adapter, device };
    } catch (err) {
        return { supported: false, reason: String(err) };
    }
}

// ── WGSL compute shader ───────────────────────────────────────────────────────
// Reads a flat Float32 elevation buffer (rowMajor, width*height floats).
// For each texel, runs a 3×3 Sobel to compute surface normals, packs them as
// RGBA8 (packed = comp*0.5+0.5, A=255).  Ocean pixels (elev < -50 m) are
// forced to the flat up-normal (128, 255, 128, 255).

const WGSL_NORMALS = /* wgsl */`
struct Params {
    width    : u32,
    height   : u32,
    hScale   : f32,   // (elevScale * gridW) / (1000 * mapWidth)
    _pad     : u32,
};

@group(0) @binding(0) var<storage, read>       elev   : array<f32>;
@group(0) @binding(1) var<storage, read_write> output : array<u32>; // packed RGBA8
@group(0) @binding(2) var<uniform>             params : Params;

fn sampleElev(x: i32, y: i32) -> f32 {
    let cx = clamp(x, 0, i32(params.width)  - 1);
    let cy = clamp(y, 0, i32(params.height) - 1);
    return elev[u32(cy) * params.width + u32(cx)];
}

fn packRGBA(r: f32, g: f32, b: f32, a: f32) -> u32 {
    let ri = u32(clamp(r * 255.0 + 0.5, 0.0, 255.0));
    let gi = u32(clamp(g * 255.0 + 0.5, 0.0, 255.0));
    let bi = u32(clamp(b * 255.0 + 0.5, 0.0, 255.0));
    let ai = u32(clamp(a * 255.0 + 0.5, 0.0, 255.0));
    return ri | (gi << 8u) | (bi << 16u) | (ai << 24u);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = i32(gid.x);
    let y = i32(gid.y);
    if (x >= i32(params.width) || y >= i32(params.height)) { return; }

    let e  = sampleElev(x, y);

    // Ocean → flat normal
    if (e < -50.0) {
        output[u32(y) * params.width + u32(x)] = packRGBA(0.5, 1.0, 0.5, 1.0);
        return;
    }

    // 3×3 Sobel  (weight sum = 8 for each axis)
    let h = params.hScale / 8.0;
    let dx = (
        -sampleElev(x-1,y-1) + sampleElev(x+1,y-1)
        - 2.0*sampleElev(x-1,y) + 2.0*sampleElev(x+1,y)
        - sampleElev(x-1,y+1) + sampleElev(x+1,y+1)
    ) * h;
    let dz = (
        -sampleElev(x-1,y-1) - 2.0*sampleElev(x,y-1) - sampleElev(x+1,y-1)
        + sampleElev(x-1,y+1) + 2.0*sampleElev(x,y+1) + sampleElev(x+1,y+1)
    ) * h;

    var nx = -dx;
    var ny = 1.0;
    var nz = -dz;
    let len = sqrt(nx*nx + ny*ny + nz*nz);
    nx /= len;  ny /= len;  nz /= len;

    let r = nx * 0.5 + 0.5;
    let g = ny * 0.5 + 0.5;
    let b = nz * 0.5 + 0.5;

    output[u32(y) * params.width + u32(x)] = packRGBA(r, g, b, 1.0);
}
`;

// ── GPU normal computation ────────────────────────────────────────────────────

/**
 * Compute a tangent-space normal map on the GPU from a Float32 elevation grid.
 *
 * @param {GPUDevice}    device      — from probeWebGPU()
 * @param {Float32Array} elevF32     — row-major elevation in metres, length = gridW*gridH
 * @param {number}       gridW       — width of the elevation grid in pixels
 * @param {number}       gridH       — height of the elevation grid in pixels
 * @param {number}       [elevScale=5.0]  — vertical exaggeration (matches generate_normals.py)
 * @param {number}       [mapWidth=300.0] — THREE.js map width (matches config.js MAP_WIDTH)
 * @returns {Promise<Uint8Array>}    — RGBA8 normal map, length = gridW*gridH*4
 */
export async function computeNormalsGPU(
    device,
    elevF32,
    gridW,
    gridH,
    elevScale = 5.0,
    mapWidth  = 300.0,
) {
    const N = gridW * gridH;
    if (elevF32.length !== N) throw new Error(`[GPUCompute] elevF32 size mismatch`);

    // hScale: (elevScale * gridW) / (1000 * mapWidth)  — matches Python script
    const hScale = (elevScale * gridW) / (1000.0 * mapWidth);

    // ── Buffers ───────────────────────────────────────────────────────────────
    const elevBuf = device.createBuffer({
        label: 'elev-input',
        size:  elevF32.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(elevBuf, 0, elevF32);

    const outputBuf = device.createBuffer({
        label: 'normal-output',
        size:  N * 4,   // 4 bytes per RGBA8 pixel
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    const readbackBuf = device.createBuffer({
        label: 'normal-readback',
        size:  N * 4,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    // Uniform: params struct  (width u32, height u32, hScale f32, pad u32)
    const paramData = new ArrayBuffer(16);
    const paramView = new DataView(paramData);
    paramView.setUint32 (0,  gridW,  true);
    paramView.setUint32 (4,  gridH,  true);
    paramView.setFloat32(8,  hScale, true);
    paramView.setUint32 (12, 0,      true);

    const uniformBuf = device.createBuffer({
        label: 'params-uniform',
        size:  16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(uniformBuf, 0, paramData);

    // ── Pipeline ──────────────────────────────────────────────────────────────
    const module = device.createShaderModule({ code: WGSL_NORMALS });

    const pipeline = await device.createComputePipelineAsync({
        label:   'normals-pipeline',
        layout:  'auto',
        compute: { module, entryPoint: 'main' },
    });

    const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: elevBuf    } },
            { binding: 1, resource: { buffer: outputBuf  } },
            { binding: 2, resource: { buffer: uniformBuf } },
        ],
    });

    // ── Dispatch ──────────────────────────────────────────────────────────────
    const encoder = device.createCommandEncoder({ label: 'normals-encoder' });
    const pass    = encoder.beginComputePass({ label: 'normals-pass' });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    // Workgroup size 8×8; ceil(gridW/8) × ceil(gridH/8) workgroups
    pass.dispatchWorkgroups(Math.ceil(gridW / 8), Math.ceil(gridH / 8));
    pass.end();

    encoder.copyBufferToBuffer(outputBuf, 0, readbackBuf, 0, N * 4);
    device.queue.submit([encoder.finish()]);

    // ── Readback ──────────────────────────────────────────────────────────────
    await readbackBuf.mapAsync(GPUMapMode.READ);
    const result = new Uint8Array(readbackBuf.getMappedRange().slice(0));
    readbackBuf.unmap();

    // Cleanup GPU resources
    elevBuf.destroy();
    outputBuf.destroy();
    readbackBuf.destroy();
    uniformBuf.destroy();

    console.info(`[GPUCompute] Normal map computed: ${gridW}×${gridH} px  (hScale=${hScale.toFixed(5)})`);
    return result;  // RGBA8, use as THREE.DataTexture / ImageData
}

// ── Status banner helper ──────────────────────────────────────────────────────
/**
 * Update the optional #gpu-status HUD element.
 * Call after probeWebGPU() resolves.
 */
export function updateGPUStatusBanner(result) {
    const el = document.getElementById('gpu-status');
    if (!el) return;
    if (result.supported) {
        el.textContent   = 'WebGPU ✓';
        el.style.color   = '#40ffaa';
        el.style.opacity = '1';
        setTimeout(() => { el.style.opacity = '0'; }, 4000);
    } else {
        el.textContent   = 'WebGL2';
        el.style.color   = '#4a6b84';
        el.style.opacity = '0.6';
    }
}
