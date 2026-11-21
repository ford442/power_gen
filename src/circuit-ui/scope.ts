/**
 * Circuit Lab scope (#256): two channels of `circuit.*` keys, sampled by the
 * host at `scopeHz` on the plant clock (src/circuit/host.ts), drawn on a 2-D
 * canvas with a rising-edge trigger on channel 1, and handed to the uPlot
 * analysis panel as a RecordedRun ("Send to analysis").
 */
import type { RecordedRun } from '../analysis/run-types';
import type { ScopeTrace } from '../circuit/host';

/** Channel colours: dataviz slots 1–2 on the panel surface (as the analysis panel). */
export const SCOPE_COLORS = ['#3987e5', '#d95926'] as const;
const SURFACE = '#0a1420';
const GRID = 'rgba(159, 188, 196, 0.14)';
const INK = '#9fbcc4';

export const SCOPE_SPANS_S = [0.005, 0.02, 0.05, 0.2, 1] as const;

/** First rising crossing of the mean in the oldest part of the trace that still leaves `span`. */
export function triggerIndex(t: Float64Array, ch: Float64Array, span: number): number {
  const n = t.length;
  if (n < 4) return 0;
  const tEnd = t[n - 1];
  // Search the window [tEnd − 2·span, tEnd − span], so the drawn span is full.
  let lo = 0;
  while (lo < n - 1 && t[lo] < tEnd - 2 * span) lo++;
  let mean = 0, count = 0;
  for (let i = lo; i < n; i++) if (Number.isFinite(ch[i])) { mean += ch[i]; count++; }
  if (!count) return lo;
  mean /= count;
  for (let i = lo + 1; i < n && t[i] <= tEnd - span; i++) {
    if (ch[i - 1] < mean && ch[i] >= mean) return i;
  }
  // No edge (DC, or slower than the span): free-run on the latest span.
  let k = n - 1;
  while (k > 0 && t[k] > tEnd - span) k--;
  return k;
}

function niceRange(lo: number, hi: number): [number, number] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [-1, 1];
  if (hi - lo < 1e-12) {
    const pad = Math.max(Math.abs(hi) * 0.1, 1e-6);
    return [lo - pad, hi + pad];
  }
  const pad = (hi - lo) * 0.08;
  return [lo - pad, hi + pad];
}

/** Draw `trace` over `span` seconds; returns per-channel [min, max] of what was drawn. */
export function drawScope(canvas: HTMLCanvasElement, trace: ScopeTrace, span: number): [number, number][] {
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 520, h = canvas.clientHeight || 150;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = SURFACE;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  for (let i = 1; i < 10; i++) {
    ctx.beginPath();
    ctx.moveTo((w * i) / 10, 0);
    ctx.lineTo((w * i) / 10, h);
    ctx.stroke();
  }
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(0, (h * i) / 4);
    ctx.lineTo(w, (h * i) / 4);
    ctx.stroke();
  }
  const ranges: [number, number][] = [];
  if (!trace.t.length || !trace.ch.length) {
    ctx.fillStyle = INK;
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('no samples yet — the scope runs with the plant (START)', 10, h / 2);
    return ranges;
  }
  const start = triggerIndex(trace.t, trace.ch[0], span);
  const t0 = trace.t[start];
  trace.ch.forEach((ch, c) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = start; i < trace.t.length && trace.t[i] <= t0 + span; i++) {
      if (Number.isFinite(ch[i])) { lo = Math.min(lo, ch[i]); hi = Math.max(hi, ch[i]); }
    }
    ranges.push([lo, hi]);
    const [a, b] = niceRange(lo, hi);
    ctx.strokeStyle = SCOPE_COLORS[c];
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let first = true;
    for (let i = start; i < trace.t.length && trace.t[i] <= t0 + span; i++) {
      if (!Number.isFinite(ch[i])) continue;
      const x = ((trace.t[i] - t0) / span) * w;
      // Each channel on its own scale, top half margins kept for labels.
      const y = h - 6 - ((ch[i] - a) / (b - a)) * (h - 12);
      if (first) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      first = false;
    }
    ctx.stroke();
  });
  return ranges;
}

/** The scope's buffer as an analysis run (`t` from 0, one column per channel). */
export function scopeRun(trace: ScopeTrace, title: string, hz: number): RecordedRun {
  const n = trace.t.length;
  const t0 = n ? trace.t[0] : 0;
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) rows.push([trace.t[i] - t0, ...trace.ch.map((ch) => ch[i])]);
  return {
    id: `circuit-scope-${Date.now().toString(36)}`,
    experimentId: null,
    title,
    startedAt: new Date().toISOString(),
    runner: 'live',
    backend: 'wasm',
    hz,
    columns: ['t', ...trace.keys],
    rows
  };
}
