/**
 * `window.__gpuErrors` — every WebGPU error the session saw, counted (#258 §4).
 *
 * The WebGPU e2e specs assert on this instead of scraping the console: a
 * validation error is an `uncapturederror` event on the device, not an
 * exception, so a frame can be wrong for a whole session with nothing thrown.
 *
 *   uncaptured  `uncapturederror` events (validation / OOM / internal) — the
 *               count a healthy session keeps at 0
 *   scoped      errors popped from an error scope the app pushed itself
 *               (probes with a fallback, e.g. the IBL storage-texture check);
 *               expected on some adapters, so not an error by themselves
 *   lost        `device.lost` resolutions, the simulated one included
 *
 * Module state, not per device: the log has to survive device-lost recovery,
 * which is exactly when errors are interesting. Free of imports so the
 * device hooks and any pass can record into it.
 */

export type GpuErrorKind = 'uncaptured' | 'scoped' | 'lost';

export interface GpuErrorLog {
  uncaptured: number;
  scoped: number;
  lost: number;
  /** The last {@link MAX_MESSAGES} messages, oldest first, as `kind: text`. */
  messages: string[];
}

const MAX_MESSAGES = 32;

const log: GpuErrorLog = { uncaptured: 0, scoped: 0, lost: 0, messages: [] };

export function recordGpuError(kind: GpuErrorKind, message: string): void {
  log[kind] += 1;
  log.messages.push(`${kind}: ${message}`);
  if (log.messages.length > MAX_MESSAGES) log.messages.shift();
}

/** The live log (also `window.__gpuErrors`). */
export function gpuErrorLog(): Readonly<GpuErrorLog> {
  return log;
}

if (typeof window !== 'undefined') {
  (window as Window & { __gpuErrors?: GpuErrorLog }).__gpuErrors = log;
}
