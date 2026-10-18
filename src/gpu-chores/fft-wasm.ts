/**
 * WASM FFT — `chores_fft_db_scratch` on sim_core (free function, not a SimMode).
 *
 * Same zero-copy idiom as reduce-wasm: the samples go into the C++-owned
 * chores scratch through HEAPF32, the kernel writes the N/2 + 1 dB bins back
 * over the head of that scratch, and we copy them out.
 */

import { getSimCore } from '../wasm/index';
import type { SimCoreModule } from '../wasm/types';
import { fftSize } from './fft-js';
import { noteError, writeScratch } from './reduce-wasm';

type FftWasmModule = Pick<SimCoreModule, 'HEAPF32' | 'chores_scratch_ptr' | 'chores_fft_db_scratch'>;

function fftModule(): FftWasmModule | null {
  const mod = getSimCore() as FftWasmModule | null;
  return typeof mod?.chores_scratch_ptr === 'function' && typeof mod.chores_fft_db_scratch === 'function'
    ? mod
    : null;
}

/** True once a sim_core build that has the FFT binding is loaded. */
export function wasmFftAvailable(): boolean {
  return fftModule() !== null;
}

/** dB bins from the WASM kernel, or null (not loaded / threw — first error is recorded). */
export function fftMagnitudeDbWasm(
  data: ArrayLike<number>,
  hann: boolean,
  floorDb: number
): Float32Array | null {
  const mod = fftModule();
  if (!mod || fftSize(data.length) === 0) return null;
  try {
    const base = writeScratch(mod, data);
    if (base < 0) return null;
    const bins = mod.chores_fft_db_scratch!(data.length, hann, floorDb);
    if (bins <= 0) return null;
    // The kernel's work buffers are separate vectors that may have grown the
    // heap, so take HEAPF32 again rather than the view writeScratch used.
    return mod.HEAPF32!.slice(base, base + bins);
  } catch (err) {
    noteError(err);
    return null;
  }
}
