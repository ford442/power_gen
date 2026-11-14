/**
 * The `postMessage` side of an `?embed=1` lab (#224 §5), with its transport
 * injected — no `window` here, so Node tests feed it fake events and sources.
 *
 * Rules (docs/EMBED.md):
 *   - only origins on the allowlist (`embedOrigins` ∪ own origin) are
 *     answered; everything else is dropped with a `console.debug`;
 *   - every reply goes to `event.source` with `targetOrigin = event.origin`,
 *     never `'*'`;
 *   - telemetry pushes are throttled per subscription to ≤ 10 Hz.
 */
import {
  errorReply,
  focusTelemetryKeys,
  isAllowedOrigin,
  parseLabRequest,
  pickTelemetry,
  resultReply,
  telemetryDue,
  type EmbedAllowlist,
  type LabRequest,
  type TelemetryMessage,
  type TelemetrySnapshotLike
} from './embed-protocol';
import { handleLabRequest, type LabHost } from './lab-requests';

export interface MessageSourceLike {
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface MessageEventLike {
  data: unknown;
  origin: string;
  source: MessageSourceLike | null | object;
}

export interface TelemetrySourceLike {
  subscribe(fn: (snap: TelemetrySnapshotLike) => void, opts?: { immediate?: boolean }): () => void;
}

export interface EmbedEndpointOptions {
  allowlist: EmbedAllowlist;
  host: LabHost;
  hub: TelemetrySourceLike;
  /** Wall clock for the push throttle (ms). */
  now?: () => number;
  /** Where dropped messages are noted (default `console.debug`). */
  debug?: (...args: unknown[]) => void;
}

/** Live subscriptions per lab, across all callers. */
export const MAX_SUBSCRIPTIONS = 16;

interface Subscription {
  id: number;
  source: MessageSourceLike;
  origin: string;
  keys: string[] | null;
  hz: number;
  lastMs: number;
}

export interface EmbedEndpoint {
  /** Handle one `message` event; resolves once any reply is posted. */
  onMessage(ev: MessageEventLike): Promise<void>;
  /** Number of live telemetry subscriptions (tests / diagnostics). */
  subscriptionCount(): number;
  dispose(): void;
}

function canPost(source: unknown): source is MessageSourceLike {
  return !!source && typeof (source as MessageSourceLike).postMessage === 'function';
}

export function createEmbedEndpoint(opts: EmbedEndpointOptions): EmbedEndpoint {
  const { allowlist, host, hub } = opts;
  const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const debug = opts.debug ?? ((...args: unknown[]) => console.debug(...args));
  const subs = new Map<number, Subscription>();
  let nextId = 1;
  let unsubscribeHub: (() => void) | null = null;

  function post(source: MessageSourceLike, origin: string, msg: unknown): boolean {
    try {
      source.postMessage(msg, origin);
      return true;
    } catch (err) {
      // A reply that does not structured-clone still gets an answer.
      const m = msg as { type?: string; requestId?: string | number | null };
      if (m && typeof m.type === 'string' && m.type !== 'lab:error') {
        try {
          source.postMessage(errorReply(m.type.replace(/:result$/, ''), m.requestId ?? null,
            `reply could not be sent: ${err instanceof Error ? err.message : String(err)}`), origin);
        } catch { /* source gone */ }
      }
      return false;
    }
  }

  function onFrame(snap: TelemetrySnapshotLike): void {
    const t = now();
    for (const sub of subs.values()) {
      if (!telemetryDue(sub.lastMs, t, sub.hz)) continue;
      sub.lastMs = t;
      const keys = sub.keys ?? focusTelemetryKeys(snap.view);
      const msg: TelemetryMessage = {
        type: 'lab:telemetry',
        subscription: sub.id,
        t: snap.simTimeS,
        values: pickTelemetry(snap, keys)
      };
      if (!post(sub.source, sub.origin, msg)) subs.delete(sub.id);
    }
    syncHub();
  }

  function syncHub(): void {
    if (subs.size && !unsubscribeHub) unsubscribeHub = hub.subscribe(onFrame, { immediate: false });
    else if (!subs.size && unsubscribeHub) {
      unsubscribeHub();
      unsubscribeHub = null;
    }
  }

  function transportRequest(req: LabRequest, source: MessageSourceLike, origin: string): unknown {
    if (req.type === 'lab:subscribe') {
      if (subs.size >= MAX_SUBSCRIPTIONS) return errorReply(req.type, req.requestId, `at most ${MAX_SUBSCRIPTIONS} subscriptions`);
      const sub: Subscription = { id: nextId++, source, origin, keys: req.keys, hz: req.hz, lastMs: -Infinity };
      subs.set(sub.id, sub);
      syncHub();
      return resultReply(req.type, req.requestId, {
        subscription: sub.id,
        keys: req.keys ?? 'focus',
        hz: req.hz
      });
    }
    if (req.type === 'lab:unsubscribe') {
      let removed = 0;
      for (const sub of Array.from(subs.values())) {
        if (sub.source !== source || sub.origin !== origin) continue;
        if (req.subscription !== null && sub.id !== req.subscription) continue;
        subs.delete(sub.id);
        removed++;
      }
      syncHub();
      return resultReply(req.type, req.requestId, { removed });
    }
    return null;
  }

  return {
    async onMessage(ev) {
      if (!isAllowedOrigin(allowlist, ev.origin)) {
        if (ev.data && typeof ev.data === 'object' && typeof (ev.data as { type?: unknown }).type === 'string'
          && (ev.data as { type: string }).type.startsWith('lab:')) {
          debug(`[embed] ignored ${(ev.data as { type: string }).type} from ${String(ev.origin)} (not in embedOrigins)`);
        }
        return;
      }
      const source = ev.source;
      if (!canPost(source)) return;
      const parsed = parseLabRequest(ev.data);
      if (!parsed) return;
      if (!parsed.ok) {
        post(source, ev.origin, parsed.reply);
        return;
      }
      const reply = transportRequest(parsed.request, source, ev.origin)
        ?? await handleLabRequest(parsed.request, host, 'postMessage');
      post(source, ev.origin, reply);
    },
    subscriptionCount: () => subs.size,
    dispose() {
      subs.clear();
      syncHub();
    }
  };
}
