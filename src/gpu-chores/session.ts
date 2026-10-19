/**
 * Exclusive chores session: adopt the boot renderer, never open a second GPU API.
 */

import { finalizeReduce, mapScaleF32Js, reduceF32Js } from './reduce-js';
import { reduceF32Wasm, mapScaleF32Wasm, wasmChoresAvailable, wasmChoresError } from './reduce-wasm';
import { WebgpuReduce } from './reduce-webgpu';
import { labConfigResolved } from '../config/lab-config';
import type {
  ChoresAdoptOpts,
  ChoresBackend,
  ChoresBreadcrumb,
  ChoresSessionApi,
  MapScaleOpts,
  ReduceResult
} from './types';

/** `?gpuChores=0|off|js`, or `seg-gpu-chores=off` remembered: JS only. */
export function resolveChoresKillSwitch(): boolean {
  if (typeof window === 'undefined') return false;
  return labConfigResolved().config.gpuChores === 'js';
}

/** `?gpuChores=wasm|webgpu|js` pins a backend; `auto` (or nothing) probes. */
export function resolveForcedBackend(): ChoresBackend | null {
  if (typeof window === 'undefined') return null;
  const { config, sources } = labConfigResolved();
  return sources.gpuChores === 'url' && config.gpuChores !== 'auto' ? config.gpuChores : null;
}

class GpuChoresSession {
  sessionApi: ChoresSessionApi = 'webgpu';
  backend: ChoresBackend = 'js';
  killSwitch = false;
  adoptedDevice = false;
  lastOp: string | null = null;
  lastCount = 0;
  lastBackend: ChoresBackend | null = null;
  private gpu: WebgpuReduce | null = null;

  /**
   * Call once after the visualizer has a session API (and optional GPUDevice).
   * Must not request a new adapter/device.
   */
  adopt(opts: ChoresAdoptOpts): void {
    this.sessionApi = opts.sessionApi;
    this.killSwitch = resolveChoresKillSwitch();
    this.adoptedDevice = false;
    this.gpu = null;

    const forced = resolveForcedBackend();
    if (this.killSwitch || forced === 'js') {
      this.backend = 'js';
      return;
    }

    if (opts.sessionApi === 'webgpu' && opts.device && forced !== 'wasm') {
      this.gpu = new WebgpuReduce(opts.device);
      this.adoptedDevice = true;
      this.backend = 'webgpu';
      const cache = opts.pipelineCache;
      if (cache?.ensureChoresReducePipeline) {
        import('../shaders/generators/compute-shaders.js').then((mod) => {
          const code = (mod as { getChoresReduceShader?: () => string }).getChoresReduceShader?.();
          if (!code) return;
          cache.ensureChoresReducePipeline!(code).then((p) => this.gpu?.init(p)).catch((err) => {
            console.warn('[gpu-chores] pipeline init failed, WASM/JS meters remain', err);
            this.gpu = null;
            this.backend = wasmChoresAvailable() ? 'wasm' : 'js';
          });
        }).catch(() => {
          this.backend = wasmChoresAvailable() ? 'wasm' : 'js';
        });
      }
      return;
    }

    this.backend = wasmChoresAvailable() || forced === 'wasm' ? 'wasm' : 'js';
    if (this.backend === 'wasm' && !wasmChoresAvailable()) this.backend = 'js';
  }

  /**
   * Re-check WASM after async sim_core load (does not open a GPU API). A
   * WebGPU session keeps its GPU reduce unless `?gpuChores=wasm` forced WASM.
   */
  refreshBackend(): void {
    if (this.killSwitch) return;
    if (this.sessionApi === 'webgpu' && resolveForcedBackend() !== 'wasm') return;
    if (wasmChoresAvailable()) this.backend = 'wasm';
  }

  breadcrumb(): ChoresBreadcrumb {
    return {
      sessionApi: this.sessionApi,
      backend: this.backend,
      killSwitch: this.killSwitch,
      adoptedDevice: this.adoptedDevice,
      lastOp: this.lastOp,
      lastCount: this.lastCount,
      lastBackend: this.lastBackend,
      wasmError: wasmChoresError
    };
  }

  reduceF32(data: ArrayLike<number>): ReduceResult {
    this.lastOp = 'reduce_f32';
    this.lastCount = data.length;
    let result: ReduceResult | null = null;
    if (this.backend === 'webgpu' && this.gpu) {
      result = this.gpu.reduce(data);
    } else if (this.backend === 'wasm') {
      result = reduceF32Wasm(data);
    }
    result ??= finalizeReduce(reduceF32Js(data), 'js');
    this.lastBackend = result.backend;
    return result;
  }

  mapScaleF32(data: ArrayLike<number>, opts: MapScaleOpts = {}): Float32Array {
    this.lastOp = 'map_scale_f32';
    this.lastCount = data.length;
    if (this.backend === 'wasm') {
      const w = mapScaleF32Wasm(data, opts);
      if (w) {
        this.lastBackend = 'wasm';
        return w;
      }
    }
    this.lastBackend = 'js';
    return mapScaleF32Js(data, opts);
  }
}

export const gpuChores = new GpuChoresSession();

if (typeof window !== 'undefined') {
  (window as Window & { gpuChores?: GpuChoresSession }).gpuChores = gpuChores;
}
