/**
 * JS FFT — always available; also the golden for the WASM kernel
 * (cpp/src/plant/chores_fft.cpp, same algorithm step for step).
 *
 * Iterative radix-2 Cooley–Tukey on a complex buffer loaded with the real
 * samples (im = 0). Input of any length is zero-padded to the next power of
 * two N; the optional periodic Hann window spans the `count` real samples, not
 * the pad. Output is the one-sided amplitude spectrum, N/2 + 1 bins, in dB:
 *
 *   mag[k] = c_k · |X[k]| / Σw     (c_k = 1 at DC and Nyquist, else 2)
 *   db[k]  = max(20·log10(mag[k]), floorDb)
 *
 * so a sine of amplitude A centred on a bin reads 20·log10(A) dB ("dB re 1 unit
 * of the column"). Non-finite samples count as 0.
 */

/** Largest padded transform (matches CHORES_FFT_MAX_N in sim_core.h). */
export const FFT_MAX_N = 1 << 20;
export const FFT_DEFAULT_FLOOR_DB = -120;

/** Zero-padded transform size for `count` samples; 0 when out of range. */
export function fftSize(count: number): number {
  if (!(count > 0) || count > FFT_MAX_N) return 0;
  let n = 1;
  while (n < count) n <<= 1;
  return n;
}

/** In-place iterative radix-2 DIT FFT; `re.length` must be a power of two. */
export function fftRadix2(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const half = n >> 1;
  const twRe = new Float64Array(Math.max(1, half));
  const twIm = new Float64Array(Math.max(1, half));
  for (let k = 0; k < half; k++) {
    const ang = (-2 * Math.PI * k) / n;
    twRe[k] = Math.cos(ang);
    twIm[k] = Math.sin(ang);
  }
  for (let len = 2; len <= n; len <<= 1) {
    const h = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < h; k++) {
        const wr = twRe[k * step];
        const wi = twIm[k * step];
        const a = i + k;
        const b = a + h;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/** Periodic Hann weight of sample i of `count`. */
export function hannWeight(i: number, count: number): number {
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / count);
}

/**
 * One-sided amplitude spectrum in dB (N/2 + 1 bins), or an empty array when
 * `data` is empty or longer than {@link FFT_MAX_N}.
 */
export function fftMagnitudeDbJs(
  data: ArrayLike<number>,
  hann = true,
  floorDb = FFT_DEFAULT_FLOOR_DB
): Float32Array {
  const count = data.length;
  const n = fftSize(count);
  if (n === 0) return new Float32Array(0);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let windowSum = 0;
  for (let i = 0; i < count; i++) {
    const w = hann ? hannWeight(i, count) : 1;
    // Math.fround: the WASM kernel reads the samples through HEAPF32.
    const x = Math.fround(data[i]);
    re[i] = Number.isFinite(x) ? w * x : 0;
    windowSum += w;
  }
  // A 1-sample Hann window is all zero; fall back to unit gain, not ÷0.
  if (windowSum <= 0) windowSum = 1;

  fftRadix2(re, im);

  const bins = n / 2 + 1;
  const out = new Float32Array(bins);
  for (let k = 0; k < bins; k++) {
    const edge = k === 0 || 2 * k === n ? 1 : 2;
    const mag = (edge * Math.sqrt(re[k] * re[k] + im[k] * im[k])) / windowSum;
    const db = mag > 0 ? 20 * Math.log10(mag) : floorDb;
    out[k] = Math.max(db, floorDb);
  }
  return out;
}
