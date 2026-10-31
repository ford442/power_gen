/**
 * Tour step `run` (#224 §3) — lazy; the tour player loads it only on a step
 * that has one. The run is live, so the class watches it happen.
 */
import { tourExperimentDef } from './tour-def';

export async function runTourStep(
  run: string | Record<string, unknown>,
  step: { view?: string; title?: string },
  tourId: string,
  index: number,
  note: HTMLElement,
  signal: AbortSignal
): Promise<void> {
  const { runExperiment } = await import('./run');
  try {
    const rec = await runExperiment(tourExperimentDef(run, step, tourId, index), { runner: 'live', signal });
    const ex = rec.expects ?? [];
    note.textContent = `🧪 ${ex.filter((e) => e.pass).length}/${ex.length} checks pass — the run is in Analysis. Simulated, not metrology.`;
  } catch (err) {
    if (!signal.aborted) note.textContent = `🧪 ${err instanceof Error ? err.message : String(err)}`;
  }
}
