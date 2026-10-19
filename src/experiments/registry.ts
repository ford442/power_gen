/**
 * Reference experiments shipped with the lab (`reference/*.experiment.json`).
 * Each file is its own lazy chunk; the list of ids costs nothing until opened.
 */
const FILES = import.meta.glob('./reference/*.experiment.json', { import: 'default' }) as Record<
  string,
  () => Promise<unknown>
>;

const BY_ID = new Map(
  Object.entries(FILES).map(([path, load]) => [path.replace(/^.*\//, '').replace(/\.experiment\.json$/, ''), load])
);

export function referenceExperimentIds(): string[] {
  return [...BY_ID.keys()].sort();
}

/** The raw definition (validate before running), or null for an unknown id. */
export async function loadReferenceExperiment(id: string): Promise<unknown | null> {
  const load = BY_ID.get(id);
  return load ? load() : null;
}

export interface ExperimentSummary {
  id: string;
  title: string;
  description?: string;
  mode?: string;
  sweep: boolean;
}

export async function listReferenceExperiments(): Promise<ExperimentSummary[]> {
  const out: ExperimentSummary[] = [];
  for (const id of referenceExperimentIds()) {
    const def = (await loadReferenceExperiment(id)) as Record<string, unknown> | null;
    if (!def) continue;
    out.push({
      id,
      title: typeof def.title === 'string' ? def.title : id,
      ...(typeof def.description === 'string' ? { description: def.description } : {}),
      ...(typeof (def.config as Record<string, unknown> | undefined)?.mode === 'string'
        ? { mode: (def.config as Record<string, string>).mode }
        : {}),
      sweep: def.sweep !== undefined
    });
  }
  return out;
}
