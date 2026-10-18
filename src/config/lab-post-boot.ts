/**
 * LabConfig extras that only matter once the lab is running (#224) — a lazy
 * chunk main.ts imports after boot, so the entry stays flat:
 *
 *   - the `.lab.json` drop target (anywhere on the page);
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

let started = false;

export async function startLabPostBoot(): Promise<void> {
  if (started) return;
  started = true;
  installLabFileDrop();
  await startClassroom();
}
