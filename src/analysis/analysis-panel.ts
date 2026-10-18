/**
 * Analysis panel (#224 §4) — lazy chunk. uPlot, this module and its CSS are
 * fetched by `window.openAnalysis()` (src/analysis/entry.ts) on first open, so
 * the dashboard entry chunk does not carry a chart library.
 *
 * Views (models built in analysis-views.ts): time plot, X–Y plot, spectrum.
 * An optional second run overlays the first ("reference" vs "mine"). Fits
 * print their equation and R²; `expects` verdicts print as PASS / FAIL lines.
 * Every view, the CSV and the PNG carry "Simulated — not metrology": a fitted
 * slope here describes the simulated plant, never a calibrated instrument.
 *
 * Keyboard: Esc closes, Tab stays inside the dialog, arrow keys / Home / End
 * on the focused plot move the cursor one sample (Shift: 5 %).
 */

/// <reference types="vite/client" />
import uPlot from 'uplot';
// Inlined as strings (not CSS assets): no CSS preload map lands in the entry chunk.
import uplotCss from 'uplot/dist/uPlot.min.css?inline';
import panelCss from './analysis-panel.css?inline';
import { telemetryHub } from '../telemetry-hub';
import { downloadText } from '../telemetry/telemetry-schema';
import { composePlotPng } from './analysis-png';
import {
  buildPlotModel,
  defaultSelection,
  fmtNum,
  MAX_TIME_SERIES,
  type AnalysisView,
  type FitChoice,
  type PlotModel,
  type PlotSeries,
  type ViewSelection
} from './analysis-views';
import { ANALYSIS_DISCLAIMER, axisLabel, columnMeta, formatValue } from './run-columns';
import { runsCsvFilename, runsToCsv } from './run-export';
import { addRun, clearRuns, getRun, listRuns, subscribeRuns } from './run-store';
import type { RecordedRun } from './run-types';
import { runFromTelemetryRows } from './telemetry-run';

/**
 * Dark categorical slots in fixed order (dataviz reference palette, dark
 * column), validated on the panel surface #0a1420: adjacent CVD ΔE ≥ 8.4,
 * normal-vision ΔE ≥ 19.8, ≥ 3:1 contrast. Time view uses ≤ 4 (one per
 * column), X–Y / spectrum use slots 1–2 (main, overlay).
 */
export const SERIES_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500'] as const;
const FIT_COLOR = '#c3c2b7';
const SURFACE = '#0a1420';
const INK = '#d6ebf0';
const AXIS_INK = '#9fbcc4';
const WARN_INK = '#f2cf73';
const GRID = 'rgba(159, 188, 196, 0.12)';
const SYNC_KEY = 'seg-analysis';

const VIEW_LABELS: Record<AnalysisView, string> = { time: 'Time', xy: 'X–Y', spectrum: 'Spectrum' };
const FIT_LABELS: Record<FitChoice, string> = {
  none: 'No fit',
  linear: 'Linear',
  exponential: 'Exponential',
  ringdown: 'Ring-down (envelope τ)'
};

/** §1 LabConfig installs `window.lab`; the .lab.json button only shows when it has the exporter. */
interface LabJsonApi {
  exportLabJson?: (opts: { runs: RecordedRun[] }) => unknown;
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

function colorOf(s: PlotSeries): string {
  return s.colorSlot >= 0 ? SERIES_COLORS[s.colorSlot] ?? FIT_COLOR : FIT_COLOR;
}

function runOptionText(run: RecordedRun): string {
  const time = run.startedAt.slice(11, 19);
  return `${run.title}${time ? ` · ${time}` : ''}`;
}

function select(label: string, options: [string, string][], value: string, onChange: (v: string) => void): HTMLLabelElement {
  const sel = h('select');
  for (const [v, text] of options) sel.append(h('option', { value: v, textContent: text, selected: v === value }));
  sel.addEventListener('change', () => onChange(sel.value));
  return h('label', {}, `${label} `, sel);
}

function checkbox(label: string, checked: boolean, onChange: (on: boolean) => void): HTMLLabelElement {
  const box = h('input', { type: 'checkbox', checked });
  box.addEventListener('change', () => onChange(box.checked));
  return h('label', {}, box, ` ${label}`);
}

class AnalysisPanel {
  private readonly root = h('div', { id: 'analysis-panel', className: 'analysis-panel', hidden: true });
  private readonly dialog = h('div', { className: 'analysis-dialog', tabIndex: -1 });
  private readonly closeBtn = h('button', { type: 'button', className: 'analysis-close', textContent: '×' });
  private readonly runSel = h('select');
  private readonly refSel = h('select');
  private readonly statusEl = h('span', { className: 'analysis-meta' });
  private readonly viewBtns = {} as Record<AnalysisView, HTMLButtonElement>;
  private readonly controls = h('div', { className: 'analysis-row' });
  private readonly plotsEl = h('div', { className: 'analysis-plots', tabIndex: 0 });
  private readonly readout = h('output', { className: 'analysis-readout' });
  private readonly fitEl = h('p', { className: 'analysis-fit' });
  private readonly notesEl = h('ul', { className: 'analysis-notes' });
  private readonly expectsEl = h('ul', { className: 'analysis-expects' });
  private readonly metaEl = h('span', { className: 'analysis-meta' });
  private readonly csvBtn = h('button', { type: 'button', textContent: 'CSV' });
  private readonly pngBtn = h('button', { type: 'button', textContent: 'PNG' });
  private readonly labBtn = h('button', { type: 'button', textContent: '.lab.json', hidden: true });

  private plots: uPlot[] = [];
  private model: PlotModel | null = null;
  private runId: string | null = null;
  private refId: string | null = null;
  /** Controls are rebuilt only when the run or view changes (keeps keyboard focus). */
  private controlsFor = '';
  private readonly selections = new Map<string, ViewSelection>();
  private cursorIdx = -1;
  private plotWidth = 0;
  private opener: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;
  private resizeObs: ResizeObserver | null = null;
  private readonly onDocKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    this.close();
  };

  constructor() {
    const title = h('h2', { id: 'analysis-title', textContent: 'Analysis' });
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-labelledby', 'analysis-title');
    this.closeBtn.setAttribute('aria-label', 'Close analysis panel (Esc)');
    this.closeBtn.addEventListener('click', () => this.close());
    this.runSel.setAttribute('aria-label', 'Run');
    this.refSel.setAttribute('aria-label', 'Overlay run');
    this.runSel.addEventListener('change', () => this.pickRun(this.runSel.value || null, this.refId));
    this.refSel.addEventListener('change', () => this.pickRun(this.runId, this.refSel.value || null));
    this.statusEl.setAttribute('role', 'status');
    this.plotsEl.setAttribute('aria-label', 'Plot — arrow keys move the cursor, values below');
    this.plotsEl.addEventListener('keydown', (e) => this.onPlotKey(e));
    this.readout.setAttribute('aria-live', 'polite');

    const addRec = h('button', { type: 'button', textContent: '+ Current recording' });
    addRec.title = 'Add the Telemetry Export recording (Record 10s) as a run';
    addRec.addEventListener('click', () => this.addRecording());
    const clear = h('button', { type: 'button', textContent: 'Clear runs' });
    clear.addEventListener('click', () => clearRuns());

    const views = h('div', { className: 'analysis-row' });
    views.setAttribute('role', 'group');
    views.setAttribute('aria-label', 'View');
    for (const v of Object.keys(VIEW_LABELS) as AnalysisView[]) {
      const b = h('button', { type: 'button', textContent: VIEW_LABELS[v] });
      b.addEventListener('click', () => this.setView(v));
      this.viewBtns[v] = b;
      views.append(b);
    }

    this.csvBtn.title = 'Download the run(s) as CSV with a # metadata header';
    this.csvBtn.addEventListener('click', () => this.exportCsv());
    this.pngBtn.title = 'Download the current plot as PNG (title, units and disclaimer included)';
    this.pngBtn.addEventListener('click', () => this.exportPng());
    this.labBtn.addEventListener('click', () => this.exportLabJson());

    this.dialog.append(
      h('div', { className: 'analysis-head' },
        title, h('span', { className: 'analysis-disclaimer', textContent: ANALYSIS_DISCLAIMER }), this.closeBtn),
      h('div', { className: 'analysis-row' },
        h('label', {}, 'Run ', this.runSel), h('label', {}, 'Overlay ', this.refSel), addRec, clear, this.statusEl),
      views,
      this.controls,
      this.plotsEl,
      this.readout,
      this.fitEl,
      this.notesEl,
      this.expectsEl,
      h('div', { className: 'analysis-row analysis-foot' }, this.csvBtn, this.pngBtn, this.labBtn, this.metaEl)
    );
    this.root.append(this.dialog);
    if (!document.getElementById('analysis-panel-styles')) {
      document.head.append(h('style', { id: 'analysis-panel-styles', textContent: `${uplotCss}\n${panelCss}` }));
    }
    // Backdrop click closes; clicks inside the dialog do not.
    this.root.addEventListener('click', (e) => { if (e.target === this.root) this.close(); });
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') this.trapTab(e);
      // Dashboard hotkeys (Space, W, P, [ ], …) listen on window / document.
      e.stopPropagation();
    });
    document.body.append(this.root);
  }

  open(runIds?: string[]): void {
    if (this.root.hidden) {
      this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    if (runIds?.length) {
      const [main, ref] = runIds;
      if (main && getRun(main)) this.runId = main;
      this.refId = ref && ref !== this.runId && getRun(ref) ? ref : null;
    }
    this.root.hidden = false;
    document.addEventListener('keydown', this.onDocKey, true);
    this.unsubscribe ??= subscribeRuns(() => this.refresh());
    if (!this.resizeObs && typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.resize());
      this.resizeObs.observe(this.plotsEl);
    }
    this.controlsFor = '';
    this.refresh();
    this.closeBtn.focus();
  }

  close(): void {
    if (this.root.hidden) return;
    this.root.hidden = true;
    document.removeEventListener('keydown', this.onDocKey, true);
    this.destroyPlots();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.opener?.focus();
  }

  // ── State ──────────────────────────────────────────────────

  private refresh(): void {
    const runs = listRuns();
    if (!this.runId || !getRun(this.runId)) this.runId = runs[0]?.id ?? null;
    if (this.refId && (this.refId === this.runId || !getRun(this.refId))) this.refId = null;
    this.runSel.replaceChildren(...runs.map((r) =>
      h('option', { value: r.id, textContent: runOptionText(r), selected: r.id === this.runId })));
    this.refSel.replaceChildren(h('option', { value: '', textContent: 'none' }), ...runs
      .filter((r) => r.id !== this.runId)
      .map((r) => h('option', { value: r.id, textContent: runOptionText(r), selected: r.id === this.refId })));
    this.runSel.disabled = runs.length === 0;
    this.refSel.disabled = runs.length < 2;
    this.render();
  }

  private pickRun(runId: string | null, refId: string | null): void {
    this.runId = runId;
    this.refId = refId && refId !== runId ? refId : null;
    this.refresh();
  }

  private selection(run: RecordedRun): ViewSelection {
    let sel = this.selections.get(run.id);
    if (!sel) {
      sel = defaultSelection(run);
      sel.timeKeys.forEach((k, i) => { sel!.colorSlots[k] = i; });
      this.selections.set(run.id, sel);
    }
    return sel;
  }

  private setView(view: AnalysisView): void {
    const run = this.runId ? getRun(this.runId) : undefined;
    if (!run) return;
    this.selection(run).view = view;
    this.render();
  }

  private toggleTimeKey(sel: ViewSelection, key: string, on: boolean): void {
    if (on && !sel.timeKeys.includes(key) && sel.timeKeys.length < MAX_TIME_SERIES) {
      // Lowest free slot: a column keeps its colour while others come and go.
      const used = new Set(sel.timeKeys.map((k) => sel.colorSlots[k]));
      let slot = 0;
      while (used.has(slot)) slot++;
      sel.colorSlots[key] = slot;
      sel.timeKeys.push(key);
    } else if (!on) {
      sel.timeKeys = sel.timeKeys.filter((k) => k !== key);
      delete sel.colorSlots[key];
    }
    for (const box of this.controls.querySelectorAll<HTMLInputElement>('input[data-key]')) {
      box.disabled = !box.checked && sel.timeKeys.length >= MAX_TIME_SERIES;
    }
    this.render();
  }

  private addRecording(): void {
    const rows = telemetryHub.getRecordedRows();
    if (rows.length === 0) {
      this.statusEl.textContent = 'No telemetry recorded — Telemetry Export → Record 10s first.';
      return;
    }
    const wasm = (window.segWasm as { enabled?: boolean } | undefined)?.enabled === true;
    const run = runFromTelemetryRows(rows, { hz: telemetryHub.sampler.sampleHz, backend: wasm ? 'mixed' : 'js' });
    this.statusEl.textContent = `Added ${run.rows.length} samples, ${run.columns.length - 1} columns.`;
    this.runId = run.id;
    this.controlsFor = '';
    addRun(run);
  }

  // ── Rendering ──────────────────────────────────────────────

  private render(): void {
    const run = this.runId ? getRun(this.runId) : undefined;
    const ref = this.refId ? getRun(this.refId) ?? null : null;
    const lab = (window as unknown as { lab?: LabJsonApi }).lab;
    this.labBtn.hidden = typeof lab?.exportLabJson !== 'function';
    this.csvBtn.disabled = this.pngBtn.disabled = this.labBtn.disabled = !run;
    if (!run) {
      this.destroyPlots();
      this.model = null;
      this.controls.replaceChildren();
      this.controlsFor = '';
      this.plotsEl.replaceChildren(h('p', {
        className: 'analysis-empty',
        textContent: 'No runs yet. Record telemetry (Telemetry Export → Record 10s), then “+ Current recording” — or run an experiment.'
      }));
      for (const e of [this.readout, this.fitEl, this.notesEl, this.expectsEl, this.metaEl]) e.replaceChildren();
      return;
    }
    const sel = this.selection(run);
    for (const [v, b] of Object.entries(this.viewBtns)) b.setAttribute('aria-pressed', String(v === sel.view));
    const controlsKey = `${run.id}|${sel.view}`;
    if (controlsKey !== this.controlsFor) {
      this.controlsFor = controlsKey;
      this.renderControls(run, sel);
    }

    this.model = buildPlotModel(run, ref, sel);
    this.drawPlots(this.model);
    this.fitEl.textContent = this.model.fitText ?? '';
    this.notesEl.replaceChildren(...this.model.notes.map((n) => h('li', { textContent: n })));
    this.expectsEl.replaceChildren(...(run.expects ?? []).map((e) => {
      const measured = Object.entries(e.measured).map(([k, v]) => `${k} = ${fmtNum(v)}`).join(', ');
      return h('li', { className: e.pass ? 'pass' : 'fail' },
        h('span', { className: 'an-mark', textContent: e.pass ? '✓ PASS' : '✗ FAIL' }),
        ` ${e.label} — ${e.condition}${measured ? ` (${measured})` : ''}`);
    }));
    const sweep = run.sweep ? ` · sweep ${Object.entries(run.sweep).map(([k, v]) => `${k} = ${fmtNum(v)}`).join(', ')}` : '';
    this.metaEl.textContent = `${run.runner} · ${run.backend} plant · ${fmtNum(run.hz)} Hz · ${run.rows.length} samples`
      + ` · started ${run.startedAt}${run.experimentId ? ` · experiment ${run.experimentId}` : ''}${sweep}`;
  }

  private renderControls(run: RecordedRun, sel: ViewSelection): void {
    const data = run.columns.filter((k) => k !== 't');
    const all: [string, string][] = run.columns.map((k) => [k, axisLabel(columnMeta(k))]);
    const fits = (choices: FitChoice[]): HTMLLabelElement =>
      select('Fit', choices.map((c) => [c, FIT_LABELS[c]]), sel.fit, (v) => { sel.fit = v as FitChoice; this.render(); });
    const parts: Node[] = [];
    if (sel.view === 'time') {
      const box = h('fieldset', { className: 'analysis-columns' }, h('legend', { textContent: `Columns (≤ ${MAX_TIME_SERIES})` }));
      for (const k of data) {
        const label = checkbox(axisLabel(columnMeta(k)), sel.timeKeys.includes(k), (on) => this.toggleTimeKey(sel, k, on));
        const input = label.querySelector('input')!;
        input.dataset.key = k;
        input.disabled = !input.checked && sel.timeKeys.length >= MAX_TIME_SERIES;
        box.append(label);
      }
      parts.push(box, fits(['none', 'linear', 'exponential', 'ringdown']),
        h('span', { className: 'analysis-meta', textContent: 'fit: first column vs t' }));
    } else if (sel.view === 'xy') {
      parts.push(
        select('x', all, sel.xKey, (v) => { sel.xKey = v; this.render(); }),
        select('y', all, sel.yKey, (v) => { sel.yKey = v; this.render(); }),
        fits(['none', 'linear', 'exponential', 'ringdown'])
      );
    } else {
      parts.push(
        select('Column', data.map((k) => [k, axisLabel(columnMeta(k))]), sel.specKey, (v) => { sel.specKey = v; this.render(); }),
        checkbox('Hann window', sel.hann, (on) => { sel.hann = on; this.render(); }),
        checkbox('Remove mean', sel.removeMean, (on) => { sel.removeMean = on; this.render(); })
      );
    }
    this.controls.replaceChildren(...parts);
  }

  private destroyPlots(): void {
    for (const p of this.plots) p.destroy();
    this.plots = [];
    this.cursorIdx = -1;
  }

  private stripHeight(count: number): number {
    const total = Math.min(440, Math.max(200, window.innerHeight * 0.45));
    return Math.round(Math.max(130, total / Math.max(1, count)));
  }

  private drawPlots(model: PlotModel): void {
    this.destroyPlots();
    this.readout.textContent = '';
    if (!model.strips.length || !model.x.length) {
      this.plotsEl.replaceChildren(h('p', { className: 'analysis-empty', textContent: model.notes[0] ?? 'Nothing to plot.' }));
      return;
    }
    this.plotsEl.replaceChildren();
    this.plotWidth = Math.max(260, this.plotsEl.clientWidth || this.dialog.clientWidth - 28 || 600);
    const height = this.stripHeight(model.strips.length);
    const axis = (label: string | undefined): uPlot.Axis => ({
      stroke: AXIS_INK,
      grid: { stroke: GRID, width: 1 },
      ticks: { stroke: GRID, width: 1 },
      label,
      labelSize: label ? 22 : 0
    });
    model.strips.forEach((strip, i) => {
      const host = h('div');
      this.plotsEl.append(host);
      const last = i === model.strips.length - 1;
      const opts: uPlot.Options = {
        width: this.plotWidth,
        height,
        scales: { x: { time: false } },
        cursor: { sync: { key: SYNC_KEY }, drag: { x: true, y: false } },
        legend: { show: true, live: false },
        axes: [axis(last ? model.xLabel : undefined), { ...axis(strip.yLabel), size: 64 }],
        series: [
          { label: model.xLabel, value: (_u, v) => formatValue(v, model.xMeta) },
          ...strip.series.map((s): uPlot.Series => ({
            label: s.label,
            stroke: colorOf(s),
            width: s.colorSlot < 0 ? 1.5 : 2,
            dash: s.dashed ? [6, 4] : undefined,
            spanGaps: true,
            paths: s.points ? () => null : undefined,
            points: s.points ? { show: true, size: 6, stroke: colorOf(s), fill: colorOf(s) } : { show: false },
            value: (_u, v) => formatValue(v, s.meta)
          }))
        ],
        hooks: { setCursor: [(u) => this.onCursor(u.cursor.idx ?? null)] }
      };
      const data = [model.x, ...strip.series.map((s) => s.values)] as uPlot.AlignedData;
      this.plots.push(new uPlot(opts, data, host));
    });
  }

  private resize(): void {
    const width = Math.max(260, this.plotsEl.clientWidth);
    // Height never changes here, so a resize cannot feed back into the observer.
    if (!this.plots.length || Math.abs(width - this.plotWidth) < 2) return;
    this.plotWidth = width;
    for (const p of this.plots) p.setSize({ width, height: p.height });
  }

  private onCursor(idx: number | null): void {
    const model = this.model;
    if (!model || idx == null || idx < 0 || idx >= model.x.length) {
      this.readout.textContent = '';
      return;
    }
    this.cursorIdx = idx;
    const parts = [`${model.xMeta.label} = ${formatValue(model.x[idx], model.xMeta)}`];
    for (const strip of model.strips) {
      for (const s of strip.series) parts.push(`${s.short} = ${formatValue(s.values[idx], s.meta)}`);
    }
    this.readout.textContent = parts.join(' · ');
  }

  private onPlotKey(e: KeyboardEvent): void {
    const n = this.model?.x.length ?? 0;
    if (!n || !this.plots.length) return;
    const big = Math.max(1, Math.round(n / 20));
    let idx = this.cursorIdx < 0 ? 0 : this.cursorIdx;
    if (e.key === 'ArrowRight') idx += e.shiftKey ? big : 1;
    else if (e.key === 'ArrowLeft') idx -= e.shiftKey ? big : 1;
    else if (e.key === 'Home') idx = 0;
    else if (e.key === 'End') idx = n - 1;
    else return;
    e.preventDefault();
    idx = Math.max(0, Math.min(n - 1, idx));
    const x = this.model!.x[idx];
    for (const p of this.plots) p.setCursor({ left: p.valToPos(x, 'x'), top: p.over.clientHeight / 2 });
    this.onCursor(idx);
  }

  private trapTab(e: KeyboardEvent): void {
    const focusable = [...this.dialog.querySelectorAll<HTMLElement>('button, select, input, [tabindex="0"]')]
      .filter((n) => !(n as HTMLButtonElement).disabled && !n.hidden && n.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // ── Export ─────────────────────────────────────────────────

  private selectedRuns(): RecordedRun[] {
    return [this.runId, this.refId].map((id) => (id ? getRun(id) : undefined)).filter((r): r is RecordedRun => !!r);
  }

  private exportCsv(): void {
    const runs = this.selectedRuns();
    if (!runs.length) return;
    downloadText(runsCsvFilename(runs), runsToCsv(runs), 'text/csv');
    this.statusEl.textContent = `CSV: ${runs.length} run${runs.length > 1 ? 's' : ''}`;
  }

  private exportPng(): void {
    const model = this.model;
    const run = this.runId ? getRun(this.runId) : undefined;
    if (!model || !run || !this.plots.length) return;
    const ref = this.refId ? getRun(this.refId) : undefined;
    const canvas = composePlotPng({
      title: `${run.title} — ${VIEW_LABELS[model.view]}`,
      subtitle: `x: ${model.xLabel} · y: ${model.strips.map((s) => s.yLabel).join(' | ')}${ref ? ` · overlay: ${ref.title}` : ''}`,
      lines: [model.fitText ?? '', ...(model.view === 'spectrum' ? model.notes : [])].filter(Boolean),
      strips: this.plots.map((p, i) => ({
        canvas: p.ctx.canvas,
        legend: model.strips[i].series.map((s) => ({ label: s.label, color: colorOf(s), dashed: s.dashed }))
      })),
      disclaimer: `${ANALYSIS_DISCLAIMER} — values come from the simulated plant, not a calibrated instrument.`,
      footer: `SEG WebGPU Visualizer · run ${run.id} · ${run.runner} · ${run.backend} plant · ${fmtNum(run.hz)} Hz · ${run.startedAt}`,
      background: SURFACE,
      ink: INK,
      muted: AXIS_INK,
      warn: WARN_INK
    });
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: `seg-analysis-${model.view}-${run.id.replace(/[^\w.-]+/g, '_')}.png` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }, 'image/png');
    this.statusEl.textContent = 'PNG exported';
  }

  private exportLabJson(): void {
    const lab = (window as unknown as { lab?: LabJsonApi }).lab;
    const runs = this.selectedRuns();
    if (!runs.length || typeof lab?.exportLabJson !== 'function') return;
    lab.exportLabJson({ runs });
  }
}

let panel: AnalysisPanel | null = null;

/** Open (creating on first call) the panel; ids = [main run, overlay run]. */
export function openAnalysisPanel(runIds?: string[]): void {
  panel ??= new AnalysisPanel();
  panel.open(runIds);
}

/** Close if open (e2e / console). */
export function closeAnalysisPanel(): void {
  panel?.close();
}
