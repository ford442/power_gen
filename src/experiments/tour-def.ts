/** A tour step's `run` → something `runExperiment` accepts (pure; also used by CI). */
export function tourExperimentDef(
  run: string | Record<string, unknown>,
  step: { view?: string; title?: string },
  tourId: string,
  index: number
): unknown {
  if (typeof run === 'string') return run;
  const slug = `tour-${tourId}-${index}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 64);
  return {
    id: slug,
    title: step.title || 'Tour experiment',
    ...run,
    config: { ...(step.view ? { mode: step.view } : {}), ...(run.config as Record<string, unknown> | undefined) }
  };
}
