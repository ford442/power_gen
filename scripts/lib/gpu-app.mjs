/**
 * gpu-app.mjs — the app modules the Dawn-in-Node tests drive, bundled once
 * with real shader text (test-harness `wgslRaw`), plus the session a GPU
 * test starts from: a device requested the way webgpu-manager.ts requests it
 * and the app's own `PipelineLayoutCache` on top.
 *
 * test:pipelines and every test:gpu-golden file import this, so they all
 * reuse one cached bundle. Test-only (ADR-0020).
 */
import { bundleTs, wgslRaw } from '../test-harness.mjs';
import { nodeDevice } from './node-gpu.mjs';

const ENTRY = `
  export { PipelineLayoutCache } from './src/pipeline-layout/index.ts';
  export { MultiDeviceShaders } from './src/multi-device-shaders.ts';
  export { resolveColorTargets } from './src/webgpu-init/color-pipeline.ts';
  export { resolveDepthFormat } from './src/webgpu-init/canvas.ts';
  export {
    OPTIONAL_DEVICE_FEATURES, PREFERRED_LIMITS, negotiateFeatures, negotiateLimits,
    sceneColorAttachmentLimit
  } from './src/webgpu-init/adapter.ts';
  export { colorAttachmentBytesPerSample } from './src/color-attachment-cost.ts';
  export { selectTextureCompression } from './src/assets/gltf/ktx2-gpu.ts';

  export * as fdtd from './src/physics/fdtd-tmz.ts';
  export { pulseCoilFdtdSources, pulseCoilFdtdMaterials } from './src/devices/quanta/pulse-coil.ts';
  export { WebgpuReduce } from './src/gpu-chores/reduce-webgpu.ts';
  export { reduceF32Js, finalizeReduce, CHORES_GOLDEN_INPUT, CHORES_GOLDEN_ACCUM } from './src/gpu-chores/reduce-js.ts';
  export * as segLayout from './src/seg-layout.ts';
  export { buildAllRollerInstances } from './src/seg-roller-model.ts';
  export * as cull from './src/devices/overview-cull.ts';
  export { overviewLodParticleCount } from './src/renderers/shared/view-lod.ts';
  export { MultiDeviceCamera } from './src/multi-device-camera.ts';
  export * as ibl from './src/ibl-prefilter.ts';
  export { IblPrefilterCompute } from './src/ibl-prefilter-gpu.ts';
  export { getLightingPreset, LIGHTING_LOOKS } from './src/seg-lighting-presets.ts';
  export { DEVICE_CATALOG } from './generated/device-catalog.ts';
  export { mhdParcelPosition, MHD_DUCT } from './src/devices/core/mhd-parcels.ts';
  export { integratePeltier } from './src/renderers/shared/particle-orbits.ts';
  export * as mpm from './src/fluids/mpm-params.ts';
  export { MpmCpu, mpmTotals, mpmLayerProfile, mpmProfileTop, mpmProfileMass, mpmDensityRatio } from './src/fluids/mpm-cpu.ts';
  export { bakeMpmBoundary, mpmSolidDistance } from './src/fluids/mpm-boundary.ts';
  export { seedMpmBox, writeMpmParticle } from './src/fluids/mpm-seed.ts';
  export { MpmSolver } from './src/fluids/mpm-solver.ts';
  export { MPM_SHADERS } from './src/fluids/mpm-shaders.ts';
  export * as heronLiquid from './src/fluids/heron-liquid.ts';
  export * as fluidSurface from './src/fluids/fluid-surface.ts';
  export { FLUID_SURFACE_SHADERS } from './src/fluids/fluid-surface-shaders.ts';
  export { ensureFluidSurfacePipelines } from './src/pipeline-layout/factories/fluid-surface-pipelines.ts';
  export { FluidSurfacePass } from './src/visualizer/fluid-surface-pass.ts';
  export { getHeronLayout, computeHeronHydraulics } from './src/heron-layout.ts';
`;

let app = null;

/** The bundled app modules (see ENTRY). Call after nodeGpu(): layouts read GPUShaderStage at import. */
export async function gpuApp() {
  app ??= await bundleTs({ contents: ENTRY, sourcefile: 'gpu-app-entry.ts' }, { plugins: [wgslRaw()] });
  return app;
}

/**
 * A device + the app's pipeline cache on the default colour pipeline.
 * `features: null` negotiates like the app; pass `[]` for a bare device.
 */
export async function gpuSession(gpu, opts = {}) {
  const a = await gpuApp();
  const requiredFeatures = opts.features ?? a.negotiateFeatures(gpu.adapter);
  const colorTargets = a.resolveColorTargets({
    mode: opts.mode ?? 'linear',
    preferredCanvasFormat: opts.canvas ?? 'bgra8unorm',
    features: new Set(requiredFeatures),
    hdrRequested: !!opts.hdr
  });
  const requiredLimits = a.negotiateLimits(gpu.adapter, {
    ...a.PREFERRED_LIMITS,
    ...a.sceneColorAttachmentLimit(colorTargets.sceneFormat)
  });
  const device = await nodeDevice(gpu, { requiredFeatures, requiredLimits, label: opts.label ?? 'test-device' });
  const cache = new a.PipelineLayoutCache(device, {
    colorTargets,
    depthFormat: opts.depthFormat ?? a.resolveDepthFormat(false)
  });
  return { app: a, device, cache, shaders: new a.MultiDeviceShaders(), colorTargets, requiredFeatures, requiredLimits };
}

/**
 * Largest |a[i] - b[i]| and where, for failure messages. A non-finite
 * difference (NaN / Inf in either array) is returned at once as `max: NaN`,
 * so a later finite element cannot hide it; a length mismatch is NaN too.
 */
export function maxAbsDiff(a, b) {
  if (a.length !== b.length) return { max: Number.NaN, at: Math.min(a.length, b.length) };
  let max = 0;
  let at = -1;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (!Number.isFinite(d)) return { max: Number.NaN, at: i };
    if (d > max) { max = d; at = i; }
  }
  return { max, at };
}

/** Largest |v[i]|. */
export function maxAbs(v) {
  let m = 0;
  for (let i = 0; i < v.length; i++) m = Math.max(m, Math.abs(v[i]));
  return m;
}

/** rgba16float texel bytes → Float32Array (IEEE 754 binary16, little-endian). */
export function halfToFloat(bytes) {
  const h = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  const out = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) {
    const sign = h[i] & 0x8000 ? -1 : 1;
    const exp = (h[i] >> 10) & 0x1f;
    const frac = h[i] & 0x3ff;
    if (exp === 0) out[i] = sign * 2 ** -14 * (frac / 1024);
    else if (exp === 31) out[i] = frac ? NaN : sign * Infinity;
    else out[i] = sign * 2 ** (exp - 15) * (1 + frac / 1024);
  }
  return out;
}
