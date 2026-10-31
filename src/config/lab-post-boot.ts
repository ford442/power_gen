/**
 * LabConfig extras that only matter once the lab is running (#224) — a lazy
 * chunk main.ts imports after boot, so the entry stays flat:
 *
 *   - the Experiments button (#224 §3, docs/EXPERIMENTS.md);
 *   - the classroom: student listener on `BroadcastChannel('seg-lab')`, the
 *     `?embed=1` postMessage endpoint and the `?teacher=1` console
 *     (src/embed/, docs/EMBED.md).
 */
import { startClassroom } from '../embed/classroom';

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
  installExperimentsButton();
  await startClassroom();
}
