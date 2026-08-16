/**
 * Parse .seg-replay.json / telemetry CSV off the main thread.
 */

import { parseReplayPayload } from '../telemetry/replay-parse';
import type { ReplayWorkerRequest, ReplayWorkerResponse } from '../telemetry/replay-protocol';

self.onmessage = (e: MessageEvent<ReplayWorkerRequest>) => {
  const msg = e.data;
  if (!msg || msg.type !== 'parse') return;
  try {
    const { replay, source } = parseReplayPayload(msg.text, msg.filename);
    const res: ReplayWorkerResponse = { type: 'ok', id: msg.id, replay, source };
    self.postMessage(res);
  } catch (err) {
    const res: ReplayWorkerResponse = {
      type: 'error',
      id: msg.id,
      error: err instanceof Error ? err.message : String(err)
    };
    self.postMessage(res);
  }
};
