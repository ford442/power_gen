/**
 * In-memory list of recorded runs, newest first, for the analysis panel.
 *
 * Ships in the entry chunk (experiment runners and "analyse current
 * recording" call `addRun`), so it imports nothing but types — never uPlot or
 * the panel. Nothing is persisted: a reload starts empty.
 */

import type { RecordedRun } from './run-types';

/** Oldest runs drop off past this many. */
export const RUN_STORE_CAP = 20;

export type RunStoreListener = (runs: readonly RecordedRun[]) => void;

let runs: RecordedRun[] = [];
const listeners = new Set<RunStoreListener>();

function notify(): void {
  const snapshot = listRuns();
  for (const fn of listeners) {
    try {
      fn(snapshot);
    } catch (err) {
      console.warn('[analysis]', err);
    }
  }
}

/**
 * Add (or replace, same `id`) a run at the front. Throws on an empty id or a
 * row whose width differs from `columns` — a producer bug better caught here
 * than in a plot.
 */
export function addRun(run: RecordedRun): RecordedRun {
  const width = run.columns.length;
  if (!run.id || run.rows.some((r) => r.length !== width)) {
    throw new TypeError(`addRun(${run.id}): needs an id and rows as wide as columns`);
  }
  runs = [run, ...runs.filter((r) => r.id !== run.id)].slice(0, RUN_STORE_CAP);
  notify();
  return run;
}

/** Newest first; a copy, so callers cannot reorder the store. */
export function listRuns(): readonly RecordedRun[] {
  return runs.slice();
}

export function getRun(id: string): RecordedRun | undefined {
  return runs.find((r) => r.id === id);
}

export function clearRuns(): void {
  if (runs.length === 0) return;
  runs = [];
  notify();
}

/** Called with the new list after every change. Returns the unsubscribe. */
export function subscribeRuns(fn: RunStoreListener): () => void {
  listeners.add(fn);
  return () => unsubscribeRuns(fn);
}

export function unsubscribeRuns(fn: RunStoreListener): void {
  listeners.delete(fn);
}
