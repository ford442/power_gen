/**
 * LabConfig extras that only matter once the lab is running (#224) — a lazy
 * chunk main.ts imports after boot, so the entry stays flat:
 *
 *   - the `.lab.json` drop target (anywhere on the page);
 *   - the Experiments button (#224 §3, docs/EXPERIMENTS.md);
 *   - the classroom: student listener on `BroadcastChannel('seg-lab')`, the
 *     `?embed=1` postMessage endpoint and the `?teacher=1` console
 *     (src/embed/, docs/EMBED.md).
 */
import { startClassroom } from '../embed/classroom';
import { setLabStatus } from './lab-status';

/** True for a drag that carries at least one file (we cannot see names until drop). */
function dragHasFiles(e: DragEvent): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
}

function installLabFileDrop(): void {
  document.addEventListener('dragover', (e) => {
    if (dragHasFiles(e)) e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    const file = Array.from(e.dataTransfer?.files ?? []).find((f) => /\.lab\.json$/i.test(f.name));
    if (!file) return;
    e.preventDefault();
    void import('./lab-file')
      .then((m) => m.loadLabFile(file))
      .then((r) => setLabStatus(`Loaded ${file.name}: ${r.applied.length} setting(s)${r.reloading ? ' — reloading' : ''}`))
      .catch((err: unknown) => setLabStatus(`Could not load ${file.name}: ${err instanceof Error ? err.message : String(err)}`));
  });
}

/** "Experiments" beside the Analysis button in the Telemetry Export row. */
function installExperimentsButton(): void {
  if (document.getElementById('experimentsOpenBtn')) return;
  const row = document.getElementById('telemetryBenchExportBtn')?.parentElement;
  if (!row) return;
  const btn = Object.assign(document.createElement('button'), {
    type: 'button',
    id: 'experimentsOpenBtn',
    className: 'ctrl-btn',
    textContent: 'Experiments',
    title: 'Scripted experiments and sweeps (simulated, not metrology)',
    onclick: () => { void window.lab?.openExperiment().catch((err: unknown) => console.warn('[experiments] panel failed to load', err)); }
  });
  btn.style.fontSize = '0.68rem';
  btn.setAttribute('aria-haspopup', 'dialog');
  row.append(btn);
}

let started = false;

export async function startLabPostBoot(): Promise<void> {
  if (started) return;
  started = true;
  installLabFileDrop();
  installExperimentsButton();
  await startClassroom();
}
