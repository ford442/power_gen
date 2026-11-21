/**
 * LabConfig extras that only matter once the lab is running (#224) — a lazy
 * chunk main.ts imports after boot, so the entry stays flat:
 *
 *   - the Experiments button (#224 §3, docs/EXPERIMENTS.md);
 *   - the Circuit button (#256, docs/CIRCUIT.md);
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

/** "Circuit" beside Experiments: the Circuit Lab wiring view (#256, docs/CIRCUIT.md). */
function installCircuitButton(): void {
  if (document.getElementById('circuitOpenBtn')) return;
  const row = document.getElementById('telemetryBenchExportBtn')?.parentElement;
  if (!row) return;
  const btn = Object.assign(document.createElement('button'), {
    type: 'button',
    id: 'circuitOpenBtn',
    className: 'ctrl-btn',
    textContent: 'Circuit',
    title: 'Circuit Lab: wire a bench port to R, C, L, diodes and switches (C++ solver; simulated, not metrology)',
    onclick: () => { void window.lab?.openCircuit().catch((err: unknown) => console.warn('[circuit] wiring view failed to load', err)); }
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
  installCircuitButton();
  await startClassroom();
}
