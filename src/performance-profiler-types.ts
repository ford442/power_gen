/**
 * Public types for {@link PerformanceProfiler}. Split from
 * `performance-profiler.ts` for the 700-line gate; that module re-exports all
 * of them, so import from either.
 */
import type { getPostQualityGates } from './post-processing-config';
import type { AdapterInfoSnapshot } from './webgpu-manager';

export interface PerformanceProfilerOptions {
  /** Pass adapter/info from WebGPUManager — do not call requestAdapter again. */
  adapter?: GPUAdapter | null;
  adapterInfo?: Partial<AdapterInfoSnapshot> | null;
  textureCompression?: string;
}

export interface BufferAllocation {
  name: string;
  size: number;
  usage: GPUBufferUsageFlags;
  timestamp: number;
}

export interface TextureAllocation {
  name: string;
  width: number;
  height: number;
  format: GPUTextureFormat;
  sampleCount: number;
  size: number;
  timestamp: number;
}

export interface BenchmarkSample {
  time: number;
  fps: number;
  particleCount: number;
}

export interface BenchmarkResults {
  duration: number;
  totalFrames: number;
  averageFPS: number;
  minFPS: number;
  maxFPS: number;
  p1FPS: number;
  p99FPS: number;
  onePercentLow: number;
  samples: BenchmarkSample[];
}

export interface FpsGraphPoint {
  x: number;
  y: number;
  fps: number;
}

export interface ParticleFpsCorrelationPoint {
  particles: number;
  fps: number;
  frameTime: number;
}

export type GpuTier = 'unknown' | 'low' | 'medium' | 'high';
export type QualityTier = 'high' | 'medium' | 'low' | 'critical';

export interface ProfilerStats {
  currentFPS: number;
  averageFPS: number;
  minFPS: number;
  maxFPS: number;
  qualityLevel: number;
  qualityTier: QualityTier;
  drawCallsEstimate: number;
  drawPrepMs: number;
  /** Main-thread ms in `LabSession.stepPlant` (drops when the plant worker owns the step). */
  plantMs: number;
  /** Worker wall ms for the last plant batch (0 in-loop). */
  plantWorkerMs: number;
  /** `worker` or `in-loop (<reason>)`. */
  plantBackend: string;
  overviewCullActive: boolean;
  msaaActive: boolean;
  taaActive: boolean;
  fdtdActive: boolean;
  postQualityGates: ReturnType<typeof getPostQualityGates>;
  postQualitySummary: string;
  gpuTier: GpuTier;
  frameTimeMs: number;
  frameCpuMs: number;
  lastGpuTimeMs: number;
  /** GPU ms per frame-graph pass from the last resolved frame (empty unless `?gpuTiming=1` + toggle). */
  gpuPassTimesMs: Record<string, number>;
  deviceTimes: { id: string; ms: number }[];
  deviceTimesMs: Record<string, number>;
  bufferMemoryMB: string;
  textureMemoryMB: string;
  totalMemoryMB: string;
  bufferCount: number;
  textureCount: number;
  timingEnabled: boolean;
  benchmarkMode: boolean;
  autoQualityEnabled: boolean;
  /** Adapter info snippet for documenting mid-tier hardware in acceptance notes */
  adapterSummary: string;
}

/** Bytes per texel for the formats this app allocates (4 for anything unlisted). */
export function bytesPerPixel(format: GPUTextureFormat): number {
  const formatSizes: Record<string, number> = {
    'r8unorm': 1, 'r8uint': 1, 'r8sint': 1,
    'r16uint': 2, 'r16sint': 2, 'r16float': 2,
    'rg8unorm': 2, 'rg8uint': 2, 'rg8sint': 2,
    'r32uint': 4, 'r32sint': 4, 'r32float': 4,
    'rg16uint': 4, 'rg16sint': 4, 'rg16float': 4,
    'rgba8unorm': 4, 'rgba8uint': 4, 'rgba8sint': 4,
    'bgra8unorm': 4, 'rgba8unorm-srgb': 4, 'bgra8unorm-srgb': 4,
    'rgb10a2unorm': 4,
    'rg11b10ufloat': 4,
    'rgba16uint': 8, 'rgba16sint': 8, 'rgba16float': 8,
    'rgba32uint': 16, 'rgba32sint': 16, 'rgba32float': 16,
    'depth24plus': 4, 'depth24plus-stencil8': 4,
    'depth32float': 4, 'depth32float-stencil8': 5
  };
  return formatSizes[format] || 4;
}
