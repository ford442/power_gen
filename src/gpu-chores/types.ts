/**
 * gpu-chores — generic map/reduce for HUD / export meters.
 *
 * Session API (WebGPU | WebGL2) is chosen once at boot.
 * Chores adopt that session's GPUDevice when it is WebGPU; they never
 * call requestAdapter / requestDevice. WebGL2 sessions use WASM or JS.
 */

export type ChoresSessionApi = 'webgpu' | 'webgl2';
export type ChoresBackend = 'webgpu' | 'wasm' | 'js';

export type ReduceOp = 'sum' | 'min' | 'max' | 'sumSq' | 'rms' | 'energy';

export interface ReduceAccum {
  sum: number;
  min: number;
  max: number;
  sumSq: number;
  count: number;
}

export interface ReduceResult extends ReduceAccum {
  rms: number;
  /** ½ Σ x² — RMS-like energy of the packed scalars. */
  energy: number;
  backend: ChoresBackend;
}

export interface MapScaleOpts {
  scale?: number;
  bias?: number;
}

export interface ChoresBreadcrumb {
  sessionApi: ChoresSessionApi;
  backend: ChoresBackend;
  killSwitch: boolean;
  adoptedDevice: boolean;
  lastOp: string | null;
  lastCount: number;
}

export interface ChoresAdoptOpts {
  sessionApi: ChoresSessionApi;
  /** Existing session GPUDevice — never created here. */
  device?: GPUDevice | null;
  pipelineCache?: {
    ensureChoresReducePipeline?: (code: string) => Promise<GPUComputePipeline>;
  } | null;
}
