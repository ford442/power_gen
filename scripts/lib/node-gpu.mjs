/**
 * node-gpu.mjs — a real WebGPU implementation for tests: Dawn's Node bindings
 * (the `webgpu` npm package). Test-only; ADR-0020 has the why, and ESLint
 * keeps `webgpu` out of `src/` (it never enters the browser bundle).
 *
 *   import { nodeGpu, gpuSkip } from '../../lib/node-gpu.mjs';
 *   const gpu = await nodeGpu();
 *   describe('…', { skip: gpuSkip(gpu) }, () => { … gpu.adapter … });
 *
 * One Dawn instance per test process. The adapter is the
 * software one (Lavapipe / SwiftShader, `forceFallbackAdapter`) whenever the
 * machine has it, so a dev box with a real GPU and a CI runner execute the
 * same rasteriser and the golden tolerances mean the same thing on both.
 * `SEG_GPU_ADAPTER=default` takes Dawn's default adapter instead; any other
 * value is passed to Dawn as an adapter-name filter.
 *
 * No adapter (no Vulkan ICD, unsupported platform, package not installed) is
 * a skip with a visible notice, not a failure — the same contract as
 * scripts/native-san.sh. `REQUIRE_GPU=1` (CI) turns the skip into an error.
 */
import { after } from 'node:test';

/** WebGPU core default limits (the spec's "default" column) the checks compare against. */
export const CORE_DEFAULT_LIMITS = Object.freeze({
  maxBindGroups: 4,
  maxBindingsPerBindGroup: 1000,
  maxDynamicUniformBuffersPerPipelineLayout: 8,
  maxDynamicStorageBuffersPerPipelineLayout: 4,
  maxSampledTexturesPerShaderStage: 16,
  maxSamplersPerShaderStage: 16,
  maxStorageBuffersPerShaderStage: 8,
  maxStorageTexturesPerShaderStage: 4,
  maxUniformBuffersPerShaderStage: 12,
  maxVertexBuffers: 8,
  maxVertexAttributes: 16,
  maxVertexBufferArrayStride: 2048,
  maxColorAttachments: 8,
  maxColorAttachmentBytesPerSample: 32,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupSizeX: 256,
  maxComputeWorkgroupSizeY: 256,
  maxComputeWorkgroupSizeZ: 64,
  maxComputeWorkgroupStorageSize: 16384
});

let cached = null;

async function open() {
  let mod;
  try {
    mod = await import('webgpu');
  } catch (err) {
    return { adapter: null, reason: `the "webgpu" package did not load (${String(err?.message ?? err).split('\n')[0]})` };
  }
  // GPUBufferUsage, GPUShaderStage, … — the app modules read them as globals.
  for (const [k, v] of Object.entries(mod.globals)) {
    if (!(k in globalThis)) globalThis[k] = v;
  }
  const want = process.env.SEG_GPU_ADAPTER ?? '';
  const named = want && want !== 'default';
  let gpu;
  try {
    gpu = mod.create(named ? [`adapter=${want}`] : []);
  } catch (err) {
    return { adapter: null, reason: String(err?.message ?? err).replace(/\s+/g, ' ').trim() };
  }
  // A GPUAdapter is consumed by its first requestDevice (#221), so this one
  // is for reading features / limits only; nodeDevice() requests its own.
  let adapter = null;
  let options;
  try {
    if (!want) {
      options = { forceFallbackAdapter: true };
      adapter = await gpu.requestAdapter(options);
    }
    if (!adapter) {
      options = {};
      adapter = await gpu.requestAdapter(options);
    }
  } catch (err) {
    return { adapter: null, reason: `requestAdapter threw: ${String(err?.message ?? err).split('\n')[0].trim()}` };
  }
  if (!adapter) {
    return { adapter: null, reason: 'Dawn found no adapter (install a Vulkan driver: mesa-vulkan-drivers gives Lavapipe)' };
  }
  const info = adapter.info;
  return {
    gpu,
    adapter,
    adapterOptions: options,
    reason: null,
    description: `${info.description || info.device || info.vendor}${info.isFallbackAdapter ? ' (software)' : ''}`
  };
}

/**
 * The process's Dawn adapter, or `{ adapter: null, reason }` when there is
 * none. Throws under `REQUIRE_GPU=1` instead of returning a skip.
 */
export async function nodeGpu() {
  cached ??= await open();
  if (!cached.adapter && process.env.REQUIRE_GPU === '1') {
    throw new Error(`[node-gpu] REQUIRE_GPU=1 but no WebGPU adapter: ${cached.reason}`);
  }
  return cached;
}

/** `skip` value for `describe` / `it`: false with an adapter, else the notice. */
export function gpuSkip(gpu) {
  if (gpu.adapter) return false;
  const notice = `no WebGPU adapter — ${gpu.reason}. Set REQUIRE_GPU=1 to make this an error.`;
  console.log(`[node-gpu] SKIP: ${notice}`);
  return notice;
}

/**
 * A device (on a fresh adapter — one adapter makes one device), destroyed
 * when the scope that called this ends: the test, if called inside `it`; the
 * file, if called at top level — so a device shared by several tests must be
 * created at top level.
 * Every validation / out-of-memory / internal error the device reports
 * outside an error scope lands in `device.uncaptured` — tests assert it is
 * empty, the Node twin of the page's `window.__gpuErrors`.
 */
export async function nodeDevice(gpu, descriptor = {}) {
  const adapter = await gpu.gpu.requestAdapter(gpu.adapterOptions);
  const device = await adapter.requestDevice(descriptor);
  device.uncaptured = [];
  device.addEventListener('uncapturederror', (event) => {
    device.uncaptured.push(event.error?.message ?? String(event.error));
  });
  after(() => device.destroy());
  return device;
}

/**
 * Run `fn` inside validation + internal + out-of-memory error scopes and
 * return the errors Dawn raised (empty when clean). `fn` may be async.
 */
export async function captureGpuErrors(device, fn) {
  const kinds = ['validation', 'internal', 'out-of-memory'];
  for (const k of kinds) device.pushErrorScope(k);
  let thrown = null;
  try {
    await fn();
  } catch (err) {
    thrown = err;
  }
  const errors = [];
  for (const k of [...kinds].reverse()) {
    const e = await device.popErrorScope();
    if (e) errors.push(`${k}: ${e.message}`);
  }
  if (thrown) errors.push(`threw: ${thrown?.message ?? thrown}`);
  return errors;
}

/** Copy a buffer range to the CPU. Returns a detached-safe ArrayBuffer copy. */
export async function readBuffer(device, buffer, offset = 0, size = buffer.size - offset) {
  const padded = Math.ceil(size / 4) * 4;
  const staging = device.createBuffer({
    label: 'test-readback',
    size: padded,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(buffer, offset, staging, 0, padded);
  device.queue.submit([enc.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const copy = staging.getMappedRange().slice(0, size);
  staging.unmap();
  staging.destroy();
  return copy;
}

/**
 * Read one mip / array layer of a texture as tightly packed bytes
 * (`bytesPerPixel` × width × height, rows unpadded).
 */
export async function readTexture(device, texture, { mipLevel = 0, layer = 0, bytesPerPixel }) {
  const width = Math.max(1, texture.width >> mipLevel);
  const height = Math.max(1, texture.height >> mipLevel);
  const rowBytes = width * bytesPerPixel;
  const bytesPerRow = Math.ceil(rowBytes / 256) * 256;
  const staging = device.createBuffer({
    label: 'test-texture-readback',
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture, mipLevel, origin: { x: 0, y: 0, z: layer } },
    { buffer: staging, bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 }
  );
  device.queue.submit([enc.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const mapped = new Uint8Array(staging.getMappedRange());
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) out.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + rowBytes), y * rowBytes);
  staging.unmap();
  staging.destroy();
  return { width, height, data: out };
}
