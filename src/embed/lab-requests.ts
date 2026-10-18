/**
 * The request handlers shared by both transports (#224 §5): an embedded lab
 * answering its parent over `postMessage`, and a student tab answering the
 * teacher console over `BroadcastChannel`. No DOM — the lab is reached through
 * a {@link LabHost}, so Node tests drive these with a fake one.
 */
import {
  EMBED_PROTOCOL_VERSION,
  LAB_DISCLAIMER,
  errorReply,
  resultReply,
  type LabReply,
  type LabRequest,
  type LabStatus
} from './embed-protocol';

/** The lab as the protocol sees it (browser-host.ts builds the real one). */
export interface LabHost {
  schema: string;
  /** `window.lab.loadConfig` — resolves with a LabLoadResult. */
  loadConfig(config: Record<string, unknown>): Promise<unknown>;
  /** `window.lab.runExperiment`, when the experiments chunk installed it. */
  runExperiment?: (experiment: string | Record<string, unknown>, opts: Record<string, unknown>) => Promise<unknown>;
  /** `window.lab.captureSnapshot`, when the snapshot chunk installed it. */
  captureSnapshot?: () => unknown;
  status(): LabStatus;
}

/** Message types this host can serve right now (for `lab:hello`). */
export function hostCapabilities(host: LabHost, transport: 'postMessage' | 'channel'): string[] {
  const caps = ['lab:hello', 'lab:ping', 'lab:loadConfig'];
  if (typeof host.runExperiment === 'function') caps.push('lab:runExperiment');
  if (transport === 'postMessage') {
    if (typeof host.captureSnapshot === 'function') caps.push('lab:snapshot');
    caps.push('lab:subscribe', 'lab:unsubscribe');
  }
  return caps;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Structured-clone-safe copy (drops functions / class instances' prototypes). */
function plain(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

/**
 * One request → one reply. `lab:subscribe` / `lab:unsubscribe` belong to the
 * transport (they hold a timer per caller) and are answered there.
 */
export async function handleLabRequest(
  req: LabRequest,
  host: LabHost,
  transport: 'postMessage' | 'channel' = 'postMessage'
): Promise<LabReply> {
  const { type, requestId } = req;
  try {
    switch (req.type) {
      case 'lab:hello':
        return resultReply(type, requestId, {
          protocol: EMBED_PROTOCOL_VERSION,
          schema: host.schema,
          capabilities: hostCapabilities(host, transport),
          disclaimer: LAB_DISCLAIMER
        });
      case 'lab:ping':
        return resultReply(type, requestId, { status: host.status() });
      case 'lab:loadConfig':
        return resultReply(type, requestId, { result: plain(await host.loadConfig(req.config)) });
      case 'lab:runExperiment': {
        if (typeof host.runExperiment !== 'function') return errorReply(type, requestId, 'experiments unavailable');
        const opts: Record<string, unknown> = {};
        if (req.sweep !== undefined) opts.sweep = req.sweep;
        return resultReply(type, requestId, { run: plain(await host.runExperiment(req.experiment, opts)) });
      }
      case 'lab:snapshot': {
        if (typeof host.captureSnapshot !== 'function') return errorReply(type, requestId, 'snapshots unavailable');
        const state = await host.captureSnapshot();
        if (state === undefined || state === null) return errorReply(type, requestId, 'no snapshot (plant not running?)');
        // As captured (it may hold typed arrays, which structured clone keeps).
        return resultReply(type, requestId, { state });
      }
      case 'lab:subscribe':
      case 'lab:unsubscribe':
        return errorReply(type, requestId, `${type} is not available on this transport`);
    }
  } catch (err) {
    return errorReply(type, requestId, message(err));
  }
}
