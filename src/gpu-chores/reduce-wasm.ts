/**
 * WASM reduce — free functions on sim_core (not a SimMode / not a GPU device).
 */

import { getSimCore } from '../wasm/index';
import { finalizeReduce, reduceF32Js } from './reduce-js';
import type { MapScaleOpts, ReduceResult } from './types';

interface ChoresWasmModule {
  chores_reduce_f32?: (data: number[] | Float32Array) => number[] | { size: () => number; get: (i: number) => number };
  chores_map_scale_f32?: (
    data: number[] | Float32Array,
    scale: number,
    bias: number
  ) => number[] | { size: () => number; get: (i: number) => number };
}

function toArray(raw: unknown): number[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw.map(Number);
  const vec = raw as { size?: () => number; get?: (i: number) => number };
  if (typeof vec.size === 'function' && typeof vec.get === 'function') {
    const n = vec.size();
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = vec.get(i);
    return out;
  }
  return null;
}

export function wasmChoresAvailable(): boolean {
  const mod = getSimCore() as ChoresWasmModule | null;
  return typeof mod?.chores_reduce_f32 === 'function';
}

export function reduceF32Wasm(data: ArrayLike<number>): ReduceResult | null {
  const mod = getSimCore() as ChoresWasmModule | null;
  if (typeof mod?.chores_reduce_f32 !== 'function') return null;
  try {
    const packed = data instanceof Float32Array ? Array.from(data) : Array.from(data as ArrayLike<number>);
    const raw = toArray(mod.chores_reduce_f32(packed));
    if (!raw || raw.length < 5) return null;
    return finalizeReduce({
      sum: raw[0],
      min: raw[1],
      max: raw[2],
      sumSq: raw[3],
      count: raw[4]
    }, 'wasm');
  } catch (err) {
    console.warn('[gpu-chores] WASM reduce failed, caller should fall back', err);
    return null;
  }
}

export function mapScaleF32Wasm(data: ArrayLike<number>, opts: MapScaleOpts = {}): Float32Array | null {
  const mod = getSimCore() as ChoresWasmModule | null;
  if (typeof mod?.chores_map_scale_f32 !== 'function') return null;
  try {
    const packed = data instanceof Float32Array ? Array.from(data) : Array.from(data as ArrayLike<number>);
    const raw = toArray(mod.chores_map_scale_f32(packed, opts.scale ?? 1, opts.bias ?? 0));
    if (!raw) return null;
    return Float32Array.from(raw);
  } catch {
    return null;
  }
}

/** Used when WASM is missing — still tagged so goldens can compare values. */
export function reduceF32JsTagged(data: ArrayLike<number>): ReduceResult {
  return finalizeReduce(reduceF32Js(data), 'js');
}
