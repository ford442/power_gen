/**
 * Plot models for the analysis panel's three views — plain data, no DOM and
 * no uPlot, so `scripts/test-analysis.mjs` can check them in Node.
 *
 * - **time**: selected columns vs `t`, one strip per unit (never two y-scales
 *   on one axis); the overlay run is the same colour, dashed.
 * - **xy**: one column against another as points; main run slot 1, overlay
 *   run slot 2.
 * - **spectrum**: FFT of one column (Hann, dB vs Hz at the run's `hz`).
 *
 * Values are multiplied by the catalog display `scale` (0–1 → %) so the axes
 * match the dashboard readouts; fits are taken on those displayed values.
 */

import { spectrumDb, type SpectrumResult } from '../gpu-chores/fft';
import { evaluateFit, exponentialFit, linearFit, ringDownFit, type Fit } from './fit';
import { axisLabel, columnMeta, unitLabel, type ColumnMeta } from './run-columns';
import { runColumn, type RecordedRun } from './run-types';

export type AnalysisView = 'time' | 'xy' | 'spectrum';
export type FitChoice = 'none' | 'linear' | 'exponential' | 'ringdown';

export interface ViewSelection {
  view: AnalysisView;
  /** Time view columns (≤ 4), in selection order. */
  timeKeys: string[];
  /** Stable categorical slot per time-view column (colour follows the column). */
  colorSlots: Record<string, number>;
  xKey: string;
  yKey: string;
  fit: FitChoice;
  specKey: string;
  hann: boolean;
  removeMean: boolean;
}

export interface PlotSeries {
  /** Legend label (bench · quantity [unit], run). */
  label: string;
  /** Cursor readout name (`F`, `F (overlay)`, `fit`). */
  short: string;
  /** Aligned to the model's `x`; null = no sample there. */
  values: (number | null)[];
  /** Categorical slot 0–7, or −1 for the neutral fit curve. */
  colorSlot: number;
  dashed: boolean;
  /** Markers only (xy scatter). */
  points: boolean;
  meta: ColumnMeta;
}

export interface PlotStrip {
  yLabel: string;
  series: PlotSeries[];
}

export interface PlotModel {
  view: AnalysisView;
  title: string;
  xLabel: string;
  xMeta: ColumnMeta;
  /** Ascending. */
  x: number[];
  strips: PlotStrip[];
  fit: Fit | null;
  /** Equation + R², or why there is no fit. */
  fitText: string | null;
  notes: string[];
  spectra: SpectrumResult[];
}

export const MAX_TIME_SERIES = 4;

const DB_META: ColumnMeta = { key: 'db', label: 'dB', unit: 'dB', scale: 1, digits: 1, deviceId: null, deviceLabel: null };
const HZ_META: ColumnMeta = { key: 'f', label: 'f', unit: 'Hz', scale: 1, digits: 3, deviceId: null, deviceLabel: null };

/** Scaled column values (catalog display scale); null when the run lacks the key. */
export function displayColumn(run: RecordedRun, key: string): number[] | null {
  if (key === 't') return timeColumn(run);
  if (!run.columns.includes(key)) return null;
  const s = columnMeta(key).scale;
  return runColumn(run, key).map((v) => v * s);
}

/** `t`, or sample index / hz when a producer left it out. */
export function timeColumn(run: RecordedRun): number[] {
  if (run.columns.includes('t')) return runColumn(run, 't');
  const hz = run.hz > 0 ? run.hz : 1;
  return run.rows.map((_, i) => i / hz);
}

interface Table {
  x: number[];
  ys: number[][];
}

/**
 * Merge tables onto one ascending x. `dedupe` joins x values within a relative
 * 1e-9 (two runs on the same clock line up even if their float sums differ);
 * without it every sample keeps its own slot, so a scatter with repeated x
 * (a sweep held at a setpoint) loses no points.
 */
export function alignTables(tables: Table[], dedupe: boolean): { x: number[]; ys: (number | null)[][][] } {
  const pts: { x: number; t: number; i: number }[] = [];
  tables.forEach((tab, t) => tab.x.forEach((x, i) => {
    if (Number.isFinite(x)) pts.push({ x, t, i });
  }));
  pts.sort((a, b) => a.x - b.x);
  const x: number[] = [];
  const slot = new Array<number>(pts.length);
  pts.forEach((p, k) => {
    const last = x[x.length - 1];
    const same = dedupe && x.length > 0 && Math.abs(p.x - last) <= 1e-9 * Math.max(1, Math.abs(p.x));
    if (!same) x.push(p.x);
    slot[k] = x.length - 1;
  });
  const ys = tables.map((tab) => tab.ys.map(() => new Array<number | null>(x.length).fill(null)));
  pts.forEach((p, k) => {
    tables[p.t].ys.forEach((col, s) => {
      const v = col[p.i];
      ys[p.t][s][slot[k]] = Number.isFinite(v) ? v : null;
    });
  });
  return { x, ys };
}

/** Compact number: 5 significant digits, exponent outside 1e-3…1e5. */
export function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(4);
  return Number(v.toPrecision(5)).toString();
}

function perUnit(y: string, x: string): string {
  if (!y && !x) return '';
  if (!x) return y;
  return `${y || '1'}/${x}`;
}

function fitFor(choice: FitChoice, xs: number[], ys: number[]): Fit | null {
  switch (choice) {
    case 'linear': return linearFit(xs, ys);
    case 'exponential': return exponentialFit(xs, ys);
    case 'ringdown': return ringDownFit(xs, ys);
    default: return null;
  }
}

/** Equation + R² line for a fit of y (yMeta) against x (xMeta). */
export function describeFit(fit: Fit, choice: FitChoice, xMeta: ColumnMeta, yMeta: ColumnMeta): string {
  const y = yMeta.label;
  const x = xMeta.label;
  if (fit.kind === 'linear') {
    if (!Number.isFinite(fit.slope)) return `Linear fit: not enough distinct points (n = ${fit.n})`;
    const sign = fit.intercept < 0 ? '−' : '+';
    const r2 = Number.isFinite(fit.r2) ? fit.r2.toFixed(5) : 'n/a (constant y)';
    const eq = `${y} = ${fmtNum(fit.slope)} ${perUnit(yMeta.unit, xMeta.unit)} · ${x} ${sign} ${fmtNum(Math.abs(fit.intercept))} ${yMeta.unit}`;
    return `${eq.replace(/ {2,}/g, ' ').trimEnd()} · R² = ${r2} (n = ${fit.n})`;
  }
  const what = choice === 'ringdown' ? 'envelope peaks' : 'points with y > 0';
  if (!Number.isFinite(fit.b)) return `Exponential fit: not enough ${what} (n = ${fit.n})`;
  const lhs = choice === 'ringdown' ? `|${y}| envelope` : y;
  const inv = xMeta.unit ? ` 1/${xMeta.unit}` : '';
  const tau = Number.isFinite(fit.tau) ? `${fmtNum(fit.tau)}${xMeta.unit ? ` ${xMeta.unit}` : ''}` : '∞';
  const r2Log = Number.isFinite(fit.r2) ? fit.r2.toFixed(5) : 'n/a';
  const r2Linear = Number.isFinite(fit.r2Linear) ? fit.r2Linear.toFixed(5) : 'n/a';
  return `${lhs} = ${fmtNum(fit.a)}${yMeta.unit ? ` ${yMeta.unit}` : ''} · e^(b·${x}), b = ${fmtNum(fit.b)}${inv}`
    + ` · τ = −1/b = ${tau} · R²(ln y) = ${r2Log} · R²(y) = ${r2Linear} (n = ${fit.n} ${what})`;
}

/** [min, max] of the finite values (loop, not spread: runs can be long). */
function finiteRange(values: number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

function fitSeries(fit: Fit, x: number[], domain: number[], meta: ColumnMeta): PlotSeries {
  const [lo, hi] = finiteRange(domain);
  const values = x.map((v) => (v >= lo && v <= hi ? evaluateFit(fit, v) : null));
  return { label: 'fit', short: 'fit', values: values.map((v) => (v != null && Number.isFinite(v) ? v : null)), colorSlot: -1, dashed: true, points: false, meta };
}

function timeModel(main: RecordedRun, ref: RecordedRun | null, sel: ViewSelection): PlotModel {
  const keys = sel.timeKeys.filter((k) => k !== 't' && main.columns.includes(k)).slice(0, MAX_TIME_SERIES);
  const mainCols = keys.map((k) => displayColumn(main, k)!);
  const refKeys = ref ? keys.filter((k) => ref.columns.includes(k)) : [];
  const tables: Table[] = [{ x: timeColumn(main), ys: mainCols }];
  if (ref && refKeys.length) tables.push({ x: timeColumn(ref), ys: refKeys.map((k) => displayColumn(ref, k)!) });
  const al = alignTables(tables, true);

  const strips = new Map<string, PlotStrip>();
  keys.forEach((k, j) => {
    const meta = columnMeta(k);
    const strip = strips.get(meta.unit) ?? { yLabel: '', series: [] };
    strips.set(meta.unit, strip);
    const slot = sel.colorSlots[k] ?? j;
    strip.series.push({ label: axisLabel(meta), short: meta.label, values: al.ys[0][j], colorSlot: slot, dashed: false, points: false, meta });
    const r = refKeys.indexOf(k);
    if (r >= 0) {
      strip.series.push({
        label: `${axisLabel(meta)} (overlay)`, short: `${meta.label} (overlay)`,
        values: al.ys[1][r], colorSlot: slot, dashed: true, points: false, meta
      });
    }
  });
  for (const [unit, strip] of strips) {
    const metas = strip.series.filter((s) => !s.dashed).map((s) => s.meta);
    strip.yLabel = metas.length === 1 ? unitLabel(metas[0]) : `${metas.map((m) => m.label).join(', ')}${unit ? ` [${unit}]` : ''}`;
  }

  const xMeta = columnMeta('t');
  let fit: Fit | null = null;
  let fitText: string | null = null;
  if (sel.fit !== 'none' && keys.length) {
    const yMeta = columnMeta(keys[0]);
    fit = fitFor(sel.fit, tables[0].x, mainCols[0]);
    if (fit) {
      fitText = describeFit(fit, sel.fit, xMeta, yMeta);
      strips.get(yMeta.unit)!.series.push(fitSeries(fit, al.x, tables[0].x, yMeta));
    }
  }
  return {
    view: 'time', title: main.title, xLabel: unitLabel(xMeta), xMeta, x: al.x,
    strips: [...strips.values()], fit, fitText,
    notes: keys.length ? [] : ['Pick at least one column.'], spectra: []
  };
}

function xyModel(main: RecordedRun, ref: RecordedRun | null, sel: ViewSelection): PlotModel {
  const xMeta = columnMeta(sel.xKey);
  const yMeta = columnMeta(sel.yKey);
  const mx = displayColumn(main, sel.xKey);
  const my = displayColumn(main, sel.yKey);
  const notes: string[] = [];
  if (!mx || !my) {
    return {
      view: 'xy', title: main.title, xLabel: axisLabel(xMeta), xMeta, x: [], strips: [], fit: null, fitText: null,
      notes: [`Run has no ${!mx ? sel.xKey : sel.yKey} column.`], spectra: []
    };
  }
  const tables: Table[] = [{ x: mx, ys: [my] }];
  const rx = ref ? displayColumn(ref, sel.xKey) : null;
  const ry = ref ? displayColumn(ref, sel.yKey) : null;
  if (ref && rx && ry) tables.push({ x: rx, ys: [ry] });
  else if (ref) notes.push(`Overlay run has no ${!rx ? sel.xKey : sel.yKey} column.`);
  const al = alignTables(tables, false);
  const series: PlotSeries[] = [
    { label: `${unitLabel(yMeta)} · ${main.title}`, short: yMeta.label, values: al.ys[0][0], colorSlot: 0, dashed: false, points: true, meta: yMeta }
  ];
  if (tables.length > 1) {
    series.push({
      label: `${unitLabel(yMeta)} · ${ref!.title} (overlay)`, short: `${yMeta.label} (overlay)`,
      values: al.ys[1][0], colorSlot: 1, dashed: false, points: true, meta: yMeta
    });
  }
  let fit: Fit | null = null;
  let fitText: string | null = null;
  if (sel.fit !== 'none') {
    fit = fitFor(sel.fit, mx, my);
    if (fit) {
      fitText = describeFit(fit, sel.fit, xMeta, yMeta);
      series.push(fitSeries(fit, al.x, mx, yMeta));
    }
  }
  return {
    view: 'xy', title: main.title, xLabel: axisLabel(xMeta), xMeta, x: al.x,
    strips: [{ yLabel: unitLabel(yMeta), series }], fit, fitText, notes, spectra: []
  };
}

function spectrumModel(main: RecordedRun, ref: RecordedRun | null, sel: ViewSelection): PlotModel {
  const meta = columnMeta(sel.specKey);
  const yLabel = `|${meta.label}| [dB re 1${meta.unit ? ` ${meta.unit}` : ''}]`;
  const runs = [main, ...(ref ? [ref] : [])].filter((r) => r.columns.includes(sel.specKey));
  const notes: string[] = [];
  if (!runs.includes(main)) notes.push(`Run has no ${sel.specKey} column.`);
  if (ref && !runs.includes(ref)) notes.push(`Overlay run has no ${sel.specKey} column.`);
  const spectra = runs.map((r) => spectrumDb(displayColumn(r, sel.specKey)!, {
    sampleHz: r.hz, hann: sel.hann, removeMean: sel.removeMean
  }));
  const al = alignTables(spectra.map((s) => ({ x: Array.from(s.freqsHz), ys: [Array.from(s.db)] })), true);
  const series: PlotSeries[] = spectra.map((_, i) => ({
    label: `${yLabel} · ${runs[i].title}${runs[i] === ref ? ' (overlay)' : ''}`,
    short: `|${meta.label}|${runs[i] === ref ? ' (overlay)' : ''}`,
    values: al.ys[i][0], colorSlot: i, dashed: false, points: false, meta: DB_META
  }));
  spectra.forEach((s, i) => {
    const who = runs[i] === main ? '' : 'Overlay: ';
    if (!(runs[i].hz > 0)) notes.push(`${who}run has no sample rate; frequencies assume 1 Hz.`);
    const pad = s.n > s.inputCount ? `, zero-padded from ${s.inputCount}` : '';
    const peak = s.peak ? `Peak ${fmtNum(s.peak.hz)} Hz (${s.peak.db.toFixed(1)} dB, bin ${s.peak.bin})` : 'No samples';
    notes.push(`${who}${peak} · Δf = ${fmtNum(s.binHz)} Hz · N = ${s.n}${pad} · ${s.hann ? 'Hann' : 'rectangular'}`
      + `${sel.removeMean ? ' · mean removed' : ''} · ${s.backend}`);
  });
  return {
    view: 'spectrum', title: main.title, xLabel: unitLabel(HZ_META), xMeta: HZ_META, x: al.x,
    strips: runs.length ? [{ yLabel, series }] : [], fit: null, fitText: null, notes, spectra
  };
}

export function buildPlotModel(main: RecordedRun, ref: RecordedRun | null, sel: ViewSelection): PlotModel {
  switch (sel.view) {
    case 'xy': return xyModel(main, ref, sel);
    case 'spectrum': return spectrumModel(main, ref, sel);
    default: return timeModel(main, ref, sel);
  }
}

/** Default selection for a run: its first plot hint, else the first data column. */
export function defaultSelection(run: RecordedRun): ViewSelection {
  const data = run.columns.filter((k) => k !== 't');
  const first = data[0] ?? 't';
  const hint = run.plots?.find((p) => run.columns.includes(p.x) && run.columns.includes(p.y));
  return {
    view: hint ? (hint.x === 't' ? 'time' : 'xy') : 'time',
    timeKeys: hint && hint.x === 't' ? [hint.y] : data.slice(0, 1),
    colorSlots: {},
    xKey: hint?.x ?? 't',
    yKey: hint?.y ?? first,
    fit: hint?.fit ?? 'none',
    specKey: hint?.y ?? first,
    hann: true,
    removeMean: true
  };
}
