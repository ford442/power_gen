/**
 * WASM reduce — free functions on sim_core (not a SimMode / not a GPU device).
 *
 * Zero-copy: the input is written into a C++-owned scratch through HEAPF32,
 * then reduced (or mapped in place) there — see chores_scratch_ptr.
 */

import { getSimCore } from '../wasm/index';
import type { SimCoreModule } from '../wasm/types';
import { finalizeReduce, reduceF32Js } from './reduce-js';
import type { MapScaleOpts, ReduceResult } from './types';

type ChoresWasmModule = Pick<
  SimCoreModule,
  'HEAPF32' | 'chores_scratch_ptr' | 'chores_reduce_f32_scratch' | 'chores_map_scale_f32_scratch'
>;

function choresModule(): ChoresWasmModule | null {
  const mod = getSimCore() as ChoresWasmModule | null;
  return typeof mod?.chores_scratch_ptr === 'function' ? mod : null;
}

/**
 * Copy `data` into the chores scratch; returns the HEAPF32 float index, or -1.
 * Shared with fft-wasm.ts (same scratch, same heap-growth rule).
 */
export function writeScratch(
  mod: Pick<SimCoreModule, 'HEAPF32' | 'chores_scratch_ptr'>,
  data: ArrayLike<number>
): number {
  const ptr = Number(mod.chores_scratch_ptr!(data.length));
  // Read HEAPF32 only after the call: a scratch resize can grow the heap.
  const heap = mod.HEAPF32;
  if (!heap || !ptr) return -1;
  const base = ptr >> 2;
  heap.set(data, base);
  return base;
}

/** Last WASM failure (first one only) — surfaced in the chores breadcrumb. */
export let wasmChoresError: string | null = null;

/** Record (and warn about) the first WASM chore failure — reduce, map or FFT. */
export function noteError(err: unknown): void {
  if (wasmChoresError !== null) return;
  wasmChoresError = err instanceof Error ? err.message : String(err);
  console.warn('[gpu-chores] WASM chore failed, falling back to JS:', err);
}

export function wasmChoresAvailable(): boolean {
  const mod = choresModule();
  return !!mod && typeof mod.chores_reduce_f32_scratch === 'function';
}

export function reduceF32Wasm(data: ArrayLike<number>): ReduceResult | null {
  const mod = choresModule();
  if (!mod?.chores_reduce_f32_scratch) return null;
  try {
    if (writeScratch(mod, data) < 0) return null;
    const raw = mod.chores_reduce_f32_scratch(data.length);
    return finalizeReduce({
      sum: raw.sum,
      min: raw.min,
      max: raw.max,
      sumSq: raw.sumSq,
      count: raw.count
    }, 'wasm');
  } catch (err) {
    noteError(err);
    return null;
  }
}

export function mapScaleF32Wasm(data: ArrayLike<number>, opts: MapScaleOpts = {}): Float32Array | null {
  const mod = choresModule();
  if (!mod?.chores_map_scale_f32_scratch) return null;
  try {
    const base = writeScratch(mod, data);
    if (base < 0) return null;
    mod.chores_map_scale_f32_scratch(data.length, opts.scale ?? 1, opts.bias ?? 0);
    // The map does not allocate, so the view taken in writeScratch is still live.
    return mod.HEAPF32!.slice(base, base + data.length);
  } catch (err) {
    noteError(err);
    return null;
  }
}

/** Used when WASM is missing — still tagged so goldens can compare values. */
export function reduceF32JsTagged(data: ArrayLike<number>): ReduceResult {
  return finalizeReduce(reduceF32Js(data), 'js');
}
