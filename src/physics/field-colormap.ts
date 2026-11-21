/**
 * |B| colour ramp — TS twin of shaders/common/field-colormap.wgsl (same
 * stops, same log mapping), for the CPU slice readout in the field panel
 * (WebGL2, and WebGPU below `medium`). test:field-volume holds the stops equal.
 */
export const FIELD_COLORMAP_STOPS: readonly (readonly [number, number, number])[] = [
  [0.05, 0.07, 0.3],
  [0.05, 0.45, 0.62],
  [0.25, 0.78, 0.38],
  [0.98, 0.7, 0.15],
  [1.0, 0.97, 0.88]
];

/** Ramp colour (0..1 per channel) at t ∈ [0, 1]. */
export function fieldColormap(t: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  const seg = Math.min(3, Math.floor(x * 4));
  const f = x * 4 - seg;
  const a = FIELD_COLORMAP_STOPS[seg], b = FIELD_COLORMAP_STOPS[seg + 1];
  out[0] = a[0] + (b[0] - a[0]) * f;
  out[1] = a[1] + (b[1] - a[1]) * f;
  out[2] = a[2] + (b[2] - a[2]) * f;
  return out;
}

/** |B| (mT) → 0..1 on a log scale between lo and hi (mT). */
export function fieldColorT(mt: number, lo: number, hi: number): number {
  return (Math.log2(Math.max(mt, 1e-9)) - Math.log2(lo)) / Math.max(Math.log2(hi) - Math.log2(lo), 1e-6);
}
