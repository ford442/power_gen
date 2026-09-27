/**
 * Adapter request + device feature / limit negotiation (no canvas, no device
 * lifetime). Split out of webgpu-manager.ts; `WebGPUManager` re-exports these
 * and keeps its static entry points as thin delegates.
 *
 * Feature / limit matrix: docs/WEBGPU.md (and docs/AGENTS.md summary).
 */

import { selectTextureCompression } from '../assets/gltf/ktx2-gpu';
import { MATERIAL_GBUFFER_FORMAT } from '../pipeline-layout';
import {
  DEFAULT_COLOR_ATTACHMENT_BYTES_PER_SAMPLE,
  colorAttachmentBytesPerSample
} from '../color-attachment-cost';

/**
 * Optional device features to enable when the adapter supports them.
 * Never hard-required — missing features are logged and skipped.
 * `timestamp-query` is gated separately (?gpuTiming=1) to avoid blank-canvas bugs.
 * Compression is requested if present so a later CAD path does not need a new device.
 * `float32-filterable` is not requested (no sampled rgba32float targets).
 * `bgra8unorm-storage` is not requested (no compute write to the swapchain).
 */
export const OPTIONAL_DEVICE_FEATURES = [
  'rg11b10ufloat-renderable',
  'texture-compression-bc',
  'texture-compression-etc2',
  'texture-compression-astc',
] as const;

export type AdapterFeatureLevel = 'core' | 'compatibility';

export interface PreferredAdapterResult {
  adapter: GPUAdapter;
  featureLevel: AdapterFeatureLevel;
}

export interface AdapterInfoSnapshot {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  fallback: boolean;
  software: boolean;
  featureLevel: AdapterFeatureLevel | null;
}

/** Device feature required for HDR bloom blur/extract intermediates. */
export const BLOOM_HDR_FEATURE = 'rg11b10ufloat-renderable';

/** GPUTextureFormat used for bloom extract/blur when {@link BLOOM_HDR_FEATURE} is enabled. */
export const BLOOM_HDR_FORMAT: GPUTextureFormat = 'rg11b10ufloat';

/**
 * Soft preferred limits: only requested when the adapter can satisfy them.
 * Defaults already cover current particle compute (workgroup 64); raise here as needed.
 */
export const PREFERRED_LIMITS: Partial<Record<keyof GPUSupportedLimits, number>> = {
  maxStorageBuffersPerShaderStage: 10,
  maxComputeWorkgroupStorageSize: 16384,
  maxBufferSize: 256 * 1024 * 1024,
  maxStorageBufferBindingSize: 128 * 1024 * 1024,
  maxComputeInvocationsPerWorkgroup: 256
};

export { DEFAULT_COLOR_ATTACHMENT_BYTES_PER_SAMPLE, colorAttachmentBytesPerSample };

/**
 * Color targets of the scene render pass: canvas-format scene color plus the
 * metalness/roughness G-buffer (ADR-0005 WS2). The MSAA showroom variant
 * attaches the same two formats at sampleCount 4.
 */
export function sceneColorAttachmentFormats(canvasFormat: GPUTextureFormat): GPUTextureFormat[] {
  return [canvasFormat, MATERIAL_GBUFFER_FORMAT];
}

/**
 * Preferred-limit patch for the scene pass's color attachments.
 *
 * Returns `{}` whenever the pass fits in the guaranteed default, so the common
 * case requests nothing at all (#171's "never ask for what no pass uses"
 * rule). It only becomes a real request if the targets grow past 32 B/sample —
 * e.g. swapping the `rg8unorm` G-buffer for an `rgba16float` one. Merged into
 * {@link PREFERRED_LIMITS} before {@link negotiateLimits}, which
 * drops any key the adapter cannot satisfy, so a low-end adapter still gets a
 * device instead of a `requestDevice` rejection.
 */
export function sceneColorAttachmentLimit(
  canvasFormat: GPUTextureFormat
): Partial<Record<keyof GPUSupportedLimits, number>> {
  const need = colorAttachmentBytesPerSample(sceneColorAttachmentFormats(canvasFormat));
  if (need <= DEFAULT_COLOR_ATTACHMENT_BYTES_PER_SAMPLE) return {};
  return { maxColorAttachmentBytesPerSample: need };
}

export function isSoftwareAdapterText(...parts: Array<string | undefined>): boolean {
  const blob = parts.filter(Boolean).join(' ').toLowerCase();
  return (
    blob.includes('swiftshader')
    || blob.includes('llvmpipe')
    || blob.includes('softpipe')
    || blob.includes('microsoft basic render')
  );
}

/**
 * `?gpuPower=low` (or `low-power`) asks for the integrated / low-power adapter —
 * tablet and projector carts running the lab as a slideshow. Anything else
 * (including no param) keeps the default `high-performance`.
 */
export function gpuPowerPreference(
  search = typeof location !== 'undefined' ? location.search : ''
): GPUPowerPreference {
  try {
    const v = new URLSearchParams(search).get('gpuPower');
    return v === 'low' || v === 'low-power' ? 'low-power' : 'high-performance';
  } catch {
    return 'high-performance';
  }
}

/**
 * Prefer core feature level; retry compatibility for mobile/Safari.
 * Does not request a device — probe and session still own their requestDevice calls.
 */
export async function requestPreferredAdapter(
  gpu: GPU = navigator.gpu,
  powerPreference: GPUPowerPreference = gpuPowerPreference()
): Promise<PreferredAdapterResult | null> {
  const base = {
    powerPreference,
    forceFallbackAdapter: false
  };
  const withLevel = async (
    featureLevel: AdapterFeatureLevel
  ): Promise<{ adapter: GPUAdapter | null; threw: boolean }> => {
    try {
      const adapter = await gpu.requestAdapter({
        ...base,
        featureLevel
      } as GPURequestAdapterOptions);
      return { adapter, threw: false };
    } catch {
      return { adapter: null, threw: true };
    }
  };

  const legacy = async (): Promise<GPUAdapter | null> => {
    try {
      return await gpu.requestAdapter(base);
    } catch {
      return null;
    }
  };

  const core = await withLevel('core');
  if (core.threw) {
    const adapter = await legacy();
    if (adapter) {
      console.log('[WebGPU] requestAdapter (featureLevel unsupported; implicit core)');
      return { adapter, featureLevel: 'core' };
    }
    return null;
  }
  if (core.adapter) {
    console.log('[WebGPU] requestAdapter featureLevel=core');
    return { adapter: core.adapter, featureLevel: 'core' };
  }

  const compat = await withLevel('compatibility');
  if (compat.adapter) {
    console.log('[WebGPU] requestAdapter featureLevel=compatibility (core returned null)');
    return { adapter: compat.adapter, featureLevel: 'compatibility' };
  }
  return null;
}

export function negotiateFeatures(adapter: GPUAdapter, opts: { gpuTiming?: boolean } = {}): string[] {
  const features: string[] = [];
  const available = adapter.features;

  if (opts.gpuTiming && available.has('timestamp-query')) {
    features.push('timestamp-query');
  }

  for (const name of OPTIONAL_DEVICE_FEATURES) {
    if (available.has(name) && !features.includes(name)) {
      features.push(name);
    }
  }
  return features;
}

export function negotiateLimits(
  adapter: GPUAdapter,
  preferred: Partial<Record<keyof GPUSupportedLimits, number>> = PREFERRED_LIMITS
): Record<string, number> {
  const out: Record<string, number> = {};
  const limits = adapter.limits;
  for (const [key, want] of Object.entries(preferred)) {
    const max = limits[key as keyof GPUSupportedLimits];
    if (typeof max === 'number' && max >= want) {
      out[key] = want;
    }
  }
  return out;
}

export function bloomIntermediateFormat(device: GPUDevice, canvasFormat: GPUTextureFormat): GPUTextureFormat {
  if (device?.features?.has(BLOOM_HDR_FEATURE)) {
    return BLOOM_HDR_FORMAT;
  }
  return canvasFormat;
}

export function readAdapterInfo(
  adapter: GPUAdapter,
  featureLevel: AdapterFeatureLevel | null = null
): AdapterInfoSnapshot {
  const info = (adapter.info || {}) as GPUAdapterInfo & { isFallbackAdapter?: boolean };
  const legacyFallback = !!(adapter as GPUAdapter & { isFallbackAdapter?: boolean }).isFallbackAdapter;
  const vendor = info.vendor || 'unknown';
  const architecture = info.architecture || 'unknown';
  const device = info.device || 'unknown';
  const description = info.description || '';
  const fallback = !!(info.isFallbackAdapter || legacyFallback);
  const software = fallback || isSoftwareAdapterText(vendor, architecture, device, description);
  return {
    vendor,
    architecture,
    device,
    description,
    fallback,
    software,
    featureLevel
  };
}

/**
 * Warn (once, at init) if the device cannot afford the scene pass's color
 * targets. Reaching this means a target was widened without raising
 * {@link sceneColorAttachmentLimit} — the pass would fail validation on the
 * first frame, which is much harder to read than this line.
 */
export function checkColorAttachmentBudget(device: GPUDevice, canvasFormat: GPUTextureFormat): void {
  const need = colorAttachmentBytesPerSample(sceneColorAttachmentFormats(canvasFormat));
  const granted = device.limits.maxColorAttachmentBytesPerSample
    ?? DEFAULT_COLOR_ATTACHMENT_BYTES_PER_SAMPLE;
  if (need > granted) {
    console.error(
      `[WebGPU] Scene color attachments need ${need} B/sample but the device granted ` +
      `${granted} B/sample — the scene pass will fail validation.`
    );
  }
}

export function logAdapterSummary(
  adapter: GPUAdapter,
  info: AdapterInfoSnapshot,
  features: string[],
  limits: Record<string, number>
): void {
  const featureList = [...adapter.features].sort();
  console.log('[WebGPU] Adapter:', info);
  console.log('[WebGPU] Adapter features:', featureList);
  console.log('[WebGPU] Requesting device features:', features);
  console.log('[WebGPU] Requesting device limits:', limits);
  const tex = selectTextureCompression(adapter, info);
  console.log('[WebGPU] Texture compression:', tex);
  console.log('[WebGPU] Adapter limit snapshot:', {
    maxColorAttachmentBytesPerSample: adapter.limits.maxColorAttachmentBytesPerSample,
    maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
    maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize,
    maxBufferSize: adapter.limits.maxBufferSize,
    maxComputeWorkgroupSizeX: adapter.limits.maxComputeWorkgroupSizeX,
    maxBindGroups: adapter.limits.maxBindGroups
  });
}
