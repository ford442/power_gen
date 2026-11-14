/**
 * Experiment panel (#224 §3) — pick a reference experiment (or one loaded from
 * a `.lab.json`), run it offline or live, read the verdicts, open the runs in
 * the analysis panel. Lazy chunk; non-modal, so a live run stays visible.
 */
import type { ExpectResult, RecordedRun } from '../analysis/run-types';
import { listReferenceExperiments, type ExperimentSummary } from './registry';
import type { RunExperimentOpts } from './run';
import type { ValidatedExperiment } from './validate';

const PANEL_ID = 'lab-experiment-panel';
const DISCLAIMER = 'Simulated, not metrology — a verdict checks what the simulated plant does, not a real bench.';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  style = ''
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  if (style) node.setAttribute('style', style);
  return node;
}

const fmtNum = (x: number) => (Number.isFinite(x) ? String(+x.toPrecision(4)) : String(x));

/** Defs opened from a file or `openExperimentDef`, by id, beside the shipped ones. */
const extraDefs = new Map<string, unknown>();

interface PanelState {
  dialog: HTMLDialogElement;
  select: HTMLSelectElement;
  about: HTMLElement;
  progress: HTMLProgressElement;
  status: HTMLElement;
  results: HTMLElement;
  runOffline: HTMLButtonElement;
  runLive: HTMLButtonElement;
  cancel: HTMLButtonElement;
  analyse: HTMLButtonElement;
  abort: AbortController | null;
  lastRunIds: string[];
}

let state: PanelState | null = null;

function verdictLine(e: ExpectResult): HTMLElement {
  const li = el('li', {}, `margin:2px 0;color:${e.pass ? '#8fe3a1' : '#ff9b8f'};`);
  const measured = Object.entries(e.measured)
    .filter(([k]) => k !== 'n')
    .map(([k, x]) => `${k} = ${fmtNum(x)}`)
    .join(', ');
  li.textContent = `${e.pass ? '✓' : '✗'} ${e.label} — ${measured} (${e.condition})`;
  return li;
}

async function definitionFor(id: string): Promise<unknown> {
  if (extraDefs.has(id)) return extraDefs.get(id);
  return id;
}

async function describe(s: PanelState): Promise<void> {
  const id = s.select.value;
  s.about.replaceChildren();
  if (!id) return;
  const { resolveExperiment } = await import('./run');
  let v: ValidatedExperiment;
  try {
    v = await resolveExperiment(await definitionFor(id));
  } catch (err) {
    s.about.textContent = err instanceof Error ? err.message : String(err);
    s.runOffline.disabled = s.runLive.disabled = true;
    return;
  }
  const lines = [
    v.def.description ?? '',
    `Mode ${v.focus} · ${v.duration.toFixed(1)} s of simulated time` +
      (v.sweepPoints.length ? ` × ${v.sweepPoints.length} sweep runs` : '') +
      (v.devices.length > 1 ? ` · also steps ${v.devices.slice(1).join(', ')} (coupling)` : ''),
    `Records ${v.recordKeys.join(', ')}`
  ].filter(Boolean);
  for (const line of lines) s.about.append(el('p', { textContent: line }, 'margin:4px 0;'));
  for (const w of v.warnings) s.about.append(el('p', { textContent: `⚠ ${w}` }, 'margin:4px 0;color:#ffd27a;'));
  s.runOffline.disabled = false;
  s.runLive.disabled = v.sweepPoints.length > 0;
  s.runLive.title = v.sweepPoints.length ? 'A sweep runs offline only' : 'Run on the lab you are looking at (pause / slow-mo apply)';
}

function setBusy(s: PanelState, busy: boolean): void {
  s.runOffline.disabled = s.runLive.disabled = s.select.disabled = busy;
  s.cancel.hidden = !busy;
}

function showOutcome(s: PanelState, run: RecordedRun, runs: RecordedRun[], warnings: string[]): void {
  const verdicts = [...(runs.length > 1 ? runs.flatMap((r) => r.expects ?? []) : []), ...(run.expects ?? [])];
  const pass = verdicts.filter((e) => e.pass).length;
  s.status.textContent = `${run.runner === 'live' ? 'Live' : 'Offline'} run on the ${run.backend} plant: ${pass}/${verdicts.length} verdicts pass`
    + (runs.length > 1 ? ` across ${runs.length} sweep runs` : '') + '.';
  const list = el('ul', {}, 'margin:6px 0;padding-left:18px;');
  list.append(...verdicts.map(verdictLine));
  s.results.replaceChildren(list, ...warnings.map((w) => el('p', { textContent: `⚠ ${w}` }, 'margin:4px 0;color:#ffd27a;')));
  s.lastRunIds = [run.id, ...runs.filter((r) => r.id !== run.id).map((r) => r.id)];
  s.analyse.disabled = false;
}

async function start(s: PanelState, runner: 'offline' | 'live'): Promise<void> {
  const id = s.select.value;
  if (!id) return;
  const { runExperimentDetailed } = await import('./run');
  s.abort = new AbortController();
  setBusy(s, true);
  s.progress.value = 0;
  s.results.replaceChildren();
  s.status.textContent = runner === 'live' ? 'Running live — the steps follow the session clock…' : 'Running offline…';
  const opts: RunExperimentOpts = { runner, signal: s.abort.signal, onProgress: (f) => { s.progress.value = f; } };
  try {
    const { run, runs, warnings } = await runExperimentDetailed(await definitionFor(id), opts);
    showOutcome(s, run, runs, warnings);
  } catch (err) {
    const partial = (err as { run?: RecordedRun }).run;
    s.status.textContent = err instanceof Error ? err.message : String(err);
    if (partial) {
      const { addRun } = await import('../analysis/run-store');
      addRun(partial);
      s.lastRunIds = [partial.id];
      s.analyse.disabled = false;
    }
  } finally {
    s.abort = null;
    setBusy(s, false);
  }
}

function build(experiments: ExperimentSummary[]): PanelState {
  const dialog = el('dialog', { id: PANEL_ID },
    'position:fixed;top:56px;right:12px;left:auto;margin:0;width:min(92vw,440px);max-height:80vh;overflow:auto;' +
    'background:#0d1420;color:#d8e6f5;border:1px solid #2a3b52;border-radius:8px;padding:14px;font:13px system-ui,sans-serif;z-index:1000;');
  dialog.setAttribute('aria-label', 'Experiments');
  const title = el('h2', { textContent: 'Experiments' }, 'margin:0 0 8px;font-size:15px;');
  const select = el('select', {}, 'width:100%;padding:4px;background:#081018;color:#d8e6f5;border:1px solid #2a3b52;border-radius:4px;');
  select.setAttribute('aria-label', 'Experiment');
  for (const x of experiments) select.append(el('option', { value: x.id, textContent: `${x.title}${x.sweep ? ' (sweep)' : ''}` }));
  for (const [id, def] of extraDefs) {
    const t = (def as { title?: unknown }).title;
    select.append(el('option', { value: id, textContent: `${typeof t === 'string' ? t : id} (loaded)` }));
  }
  const about = el('div', {}, 'margin:8px 0;font-size:12px;opacity:0.9;');
  const row = el('div', {}, 'display:flex;gap:6px;flex-wrap:wrap;margin:8px 0;');
  const runOffline = el('button', { type: 'button', className: 'ctrl-btn', textContent: 'Run offline' });
  runOffline.title = 'A fresh bench in a worker, faster than real time';
  const runLive = el('button', { type: 'button', className: 'ctrl-btn', textContent: 'Run live' });
  const cancel = el('button', { type: 'button', className: 'ctrl-btn', textContent: 'Cancel', hidden: true });
  const analyse = el('button', { type: 'button', className: 'ctrl-btn', textContent: 'Open in Analysis', disabled: true });
  const close = el('button', { type: 'button', className: 'ctrl-btn', textContent: 'Close' });
  row.append(runOffline, runLive, cancel, analyse, close);
  const progress = el('progress', { max: 1, value: 0 }, 'width:100%;');
  const status = el('p', { textContent: '' }, 'margin:6px 0;font-size:12px;');
  status.setAttribute('role', 'status');
  const results = el('div', {}, 'font-size:12px;');
  const note = el('p', { textContent: DISCLAIMER }, 'margin:8px 0 0;font-size:11px;opacity:0.65;');
  dialog.append(title, select, about, row, progress, status, results, note);

  const s: PanelState = { dialog, select, about, progress, status, results, runOffline, runLive, cancel, analyse, abort: null, lastRunIds: [] };
  select.addEventListener('change', () => { void describe(s); });
  runOffline.addEventListener('click', () => { void start(s, 'offline'); });
  runLive.addEventListener('click', () => { void start(s, 'live'); });
  cancel.addEventListener('click', () => s.abort?.abort());
  analyse.addEventListener('click', () => { void window.openAnalysis?.(s.lastRunIds); });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    s.abort?.abort();
    dialog.remove();
    if (state === s) state = null;
  });
  document.body.appendChild(dialog);
  dialog.show();
  return s;
}

/** Open the panel, optionally on one experiment (shipped id or a loaded def's id). */
export async function openExperimentPanel(id?: string): Promise<void> {
  if (!state) state = build(await listReferenceExperiments());
  if (id) {
    if (![...state.select.options].some((o) => o.value === id)) {
      state.status.textContent = `No experiment "${id}".`;
    } else {
      state.select.value = id;
    }
  }
  await describe(state);
}

/** Add a definition (from a `.lab.json` or the console) and open it. */
export async function openExperimentDefinition(def: unknown): Promise<void> {
  const id = (def as { id?: unknown })?.id;
  if (typeof id !== 'string') throw new Error('an experiment needs an id');
  extraDefs.set(id, def);
  if (state && ![...state.select.options].some((o) => o.value === id)) {
    const t = (def as { title?: unknown }).title;
    state.select.append(el('option', { value: id, textContent: `${typeof t === 'string' ? t : id} (loaded)` }));
  }
  await openExperimentPanel(id);
}
