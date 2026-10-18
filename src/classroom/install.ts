/**
 * Classroom delivery (#224 §5, docs/CLASSROOM.md): offline PWA + video
 * recording. (Touch camera input lives with the camera: camera-controller.ts
 * routes touch/pen to camera-touch.ts.)
 *
 * main.ts loads this file as a lazy chunk after boot, so none of it costs the
 * entry bundle; the recorder is a further chunk, fetched on first use.
 */
import { registerServiceWorker, unregisterServiceWorker } from './pwa-register';
import { mountRecordControl } from './record-control';

export interface ClassroomOptions {
  /**
   * Offline service worker. Default on (production http(s) boots only).
   * `false` skips registration *and* unregisters a worker from an earlier
   * visit — the kill switch for a bad deploy.
   */
  serviceWorker?: boolean;
  /** Record control in the Telemetry Export panel. Default on. */
  recordControl?: boolean;
}

export function installClassroom(opts: ClassroomOptions = {}): void {
  // Dev has no sw.js, `file:` boots cannot register one, and plain-http LAN
  // hosts are not secure contexts (no navigator.serviceWorker) — all skip
  // silently.
  if (import.meta.env.PROD && /^https?:$/.test(location.protocol) && 'serviceWorker' in navigator) {
    (opts.serviceWorker === false ? unregisterServiceWorker() : registerServiceWorker())
      .catch((err: unknown) => console.warn('[classroom] service worker skipped:', err));
  }

  // One shared import promise: two separate import() calls may settle in either
  // order, which would let a second recordBench() win the single-flight slot.
  // A failed fetch is not cached, so a later call retries.
  let recorder: Promise<typeof import('./recorder')> | null = null;
  window.recordBench = (seconds = 10) =>
    (recorder ??= import('./recorder').catch((err: unknown) => { recorder = null; throw err; }))
      .then((m) => m.recordBench(seconds));
  if (opts.recordControl !== false) mountRecordControl();
}
