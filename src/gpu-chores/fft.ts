/**
 * Spectrum chore: JS / WASM FFT behind the gpuChores backend choice.
 *
 * - `?gpuChores=0|js` (kill switch) → JS golden.
 * - backend `wasm` → WASM kernel; any failure falls back to JS, the first
 *   error lands in `gpuChores.breadcrumb().wasmError`.
 * - backend `webgpu` → there is **no WGSL FFT pass** (see docs/ANALYSIS.md:
 *   only worth it for N ≥ 4096 with a measured win), so a WebGPU session uses
 *   the WASM kernel when sim_core is loaded, else JS. No GPU work is issued.
 *
 * Not re-exported from the gpu-chores barrel on purpose: only the lazily
 * loaded analysis panel uses it, so it stays out of the entry chunk.
 */

import { FFT_DEFAULT_FLOOR_DB, fftMagnitudeDbJs, fftSize } from './fft-js';
import { fftMagnitudeDbWasm, wasmFftAvailable } from './fft-wasm';
import { gpuChores } from './session';
import type { ChoresBackend } from './types';

export interface SpectrumOpts {
  /** Sample rate of `data`, Hz (a RecordedRun's `hz`). */
  sampleHz: number;
  /** Periodic Hann over the samples (default true). */
  hann?: boolean;
  /** dB floor (default −120). */
  floorDb?: number;
  /** Subtract the finite-sample mean first, so DC leakage cannot win the peak (default true). */
  removeMean?: boolean;
}

export interface SpectrumPeak {
  bin: number;
  hz: number;
  db: number;
}

export interface SpectrumResult {
  /** One-sided amplitude spectrum, dB re 1 unit of the input. */
  db: Float32Array;
  /** Bin centre frequencies, `k · sampleHz / n`. */
  freqsHz: Float32Array;
  /** Padded transform size (power of two). */
  n: number;
  /** Samples actually supplied (`n − inputCount` zeros were appended). */
  inputCount: number;
  /** Bin spacing, Hz. */
  binHz: number;
  hann: boolean;
  floorDb: number;
  backend: Extract<ChoresBackend, 'wasm' | 'js'>;
  /** Largest bin above DC (DC itself only when it is the only bin). */
  peak: SpectrumPeak | null;
}

function demean(data: ArrayLike<number>): Float32Array {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    if (Number.isFinite(data[i])) {
      sum += data[i];
      count++;
    }
  }
  const mean = count > 0 ? sum / count : 0;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = Number.isFinite(data[i]) ? data[i] - mean : 0;
  return out;
}

function wantWasm(): boolean {
  if (gpuChores.killSwitch || gpuChores.backend === 'js') return false;
  return wasmFftAvailable();
}

/** Windowed magnitude spectrum of one column. Empty result for empty / oversize input. */
export function spectrumDb(data: ArrayLike<number>, opts: SpectrumOpts): SpectrumResult {
  const hann = opts.hann ?? true;
  const floorDb = opts.floorDb ?? FFT_DEFAULT_FLOOR_DB;
  const input = opts.removeMean === false ? data : demean(data);
  const n = fftSize(input.length);

  gpuChores.lastOp = 'fft_db';
  gpuChores.lastCount = input.length;
  let db: Float32Array | null = null;
  let backend: SpectrumResult['backend'] = 'js';
  if (n > 0 && wantWasm()) {
    db = fftMagnitudeDbWasm(input, hann, floorDb);
    if (db) backend = 'wasm';
  }
  db ??= fftMagnitudeDbJs(input, hann, floorDb);
  gpuChores.lastBackend = backend;

  const sampleHz = Number.isFinite(opts.sampleHz) && opts.sampleHz > 0 ? opts.sampleHz : 1;
  const binHz = n > 0 ? sampleHz / n : 0;
  const freqsHz = new Float32Array(db.length);
  for (let k = 0; k < db.length; k++) freqsHz[k] = k * binHz;

  let peak: SpectrumPeak | null = null;
  const first = db.length > 1 ? 1 : 0;
  for (let k = first; k < db.length; k++) {
    if (!peak || db[k] > peak.db) peak = { bin: k, hz: k * binHz, db: db[k] };
  }
  return { db, freqsHz, n, inputCount: input.length, binHz, hann, floorDb, backend, peak };
}
