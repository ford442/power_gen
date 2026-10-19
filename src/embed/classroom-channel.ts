/**
 * Classroom over `BroadcastChannel('seg-lab')` (#224 §5): a teacher console
 * broadcasts requests, every student tab of the lab on the same origin
 * answers through the same handlers an embedded lab uses. The channel is
 * injected, so Node tests run this over Node's own BroadcastChannel.
 *
 * Same-origin only by construction — BroadcastChannel never crosses origins,
 * and a same-origin tab could already script this one. Messages carry `from`
 * (sender tab id) and optionally `to` (student ids); see docs/EMBED.md.
 */
import {
  CHANNEL_REQUEST_TYPES,
  channelAddressedTo,
  errorReply,
  parseLabRequest,
  type LabReply,
  type LabRequest,
  type LabStatus,
  type RequestId
} from './embed-protocol';
import { handleLabRequest, type LabHost } from './lab-requests';

export interface ChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', fn: (ev: MessageEvent) => void): void;
  removeEventListener(type: 'message', fn: (ev: MessageEvent) => void): void;
  close?(): void;
}

/** A short random tab id (not a secret; only routes replies). */
export function newTabId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID().slice(0, 8);
  return Math.random().toString(36).slice(2, 10);
}

// ── Student ──────────────────────────────────────────────────

export interface StudentEndpointOptions {
  channel: ChannelLike;
  tabId: string;
  host: LabHost;
  /** Called after a teacher request was handled (status line in the tab). */
  onHandled?: (req: LabRequest, reply: LabReply) => void;
}

export interface StudentEndpoint {
  tabId: string;
  /** Post this tab's status unasked (on join), so open consoles list it at once. */
  announce(): void;
  /** Tell consoles this tab is leaving (pagehide). */
  bye(): void;
  dispose(): void;
}

export function createStudentEndpoint(opts: StudentEndpointOptions): StudentEndpoint {
  const { channel, tabId, host } = opts;

  const send = (msg: Record<string, unknown>): void => {
    try {
      channel.postMessage({ ...msg, from: tabId });
    } catch (err) {
      console.warn('[classroom] reply not sent:', err);
    }
  };

  const onMessage = (ev: MessageEvent): void => {
    const data: unknown = ev.data;
    if (!channelAddressedTo(data, tabId)) return;
    const teacher = (data as { from: string }).from;
    const parsed = parseLabRequest(data);
    if (!parsed) return;
    if (!parsed.ok) {
      send({ ...parsed.reply, to: [teacher] });
      return;
    }
    const req = parsed.request;
    if (!CHANNEL_REQUEST_TYPES.has(req.type)) {
      send({ ...errorReply(req.type, req.requestId, `${req.type} is not available over the classroom channel`), to: [teacher] });
      return;
    }
    void handleLabRequest(req, host, 'channel').then((reply) => {
      send({ ...reply, to: [teacher] });
      opts.onHandled?.(req, reply);
    });
  };

  channel.addEventListener('message', onMessage);
  return {
    tabId,
    announce: () => send({ type: 'lab:ping:result', requestId: null, ok: true, status: host.status() }),
    bye: () => send({ type: 'lab:bye' }),
    dispose: () => channel.removeEventListener('message', onMessage)
  };
}

// ── Teacher ──────────────────────────────────────────────────

export interface RosterEntry {
  id: string;
  status: LabStatus | null;
  lastSeenMs: number;
  /** Last reply (other than a ping) from this student. */
  last: { request: string; ok: boolean; detail: string } | null;
}

export interface CollectedRun {
  student: string;
  requestId: RequestId;
  run: unknown;
}

export interface TeacherClientOptions {
  channel: ChannelLike;
  tabId: string;
  now?: () => number;
  onChange?: () => void;
}

export interface TeacherClient {
  tabId: string;
  roster(): RosterEntry[];
  runs(): CollectedRun[];
  /** Broadcast a request (`to` = only these student ids). Returns its requestId. */
  send(type: string, fields?: Record<string, unknown>, to?: string[]): string;
  ping(): string;
  /** Drop students not heard from in `maxAgeMs`. */
  prune(maxAgeMs: number): number;
  dispose(): void;
}

function replyDetail(data: Record<string, unknown>): string {
  if (data.ok === false) return String(data.error ?? 'error');
  const result = data.result as { applied?: unknown[]; reloading?: boolean } | undefined;
  if (result && Array.isArray(result.applied)) {
    return `${result.applied.length} setting(s)${result.reloading ? ', reloading' : ''}`;
  }
  const run = data.run as { rows?: unknown[]; expects?: { pass?: boolean }[] } | undefined;
  if (run && Array.isArray(run.rows)) {
    const ex = Array.isArray(run.expects) ? run.expects : [];
    const passed = ex.filter((e) => e?.pass).length;
    return `${run.rows.length} rows${ex.length ? `, expects ${passed}/${ex.length}` : ''}`;
  }
  return 'ok';
}

export function createTeacherClient(opts: TeacherClientOptions): TeacherClient {
  const { channel, tabId } = opts;
  const now = opts.now ?? (() => Date.now());
  const roster = new Map<string, RosterEntry>();
  const runs: CollectedRun[] = [];
  let seq = 0;

  const changed = (): void => opts.onChange?.();
  const entry = (id: string): RosterEntry => {
    let e = roster.get(id);
    if (!e) {
      e = { id, status: null, lastSeenMs: now(), last: null };
      roster.set(id, e);
    }
    e.lastSeenMs = now();
    return e;
  };

  const onMessage = (ev: MessageEvent): void => {
    const data: unknown = ev.data;
    if (!channelAddressedTo(data, tabId)) return;
    const msg = data as Record<string, unknown> & { from: string; type?: unknown };
    if (typeof msg.type !== 'string') return;
    if (msg.type === 'lab:bye') {
      if (roster.delete(msg.from)) changed();
      return;
    }
    if (msg.type === 'lab:ping:result') {
      entry(msg.from).status = (msg.status as LabStatus | undefined) ?? null;
      changed();
      return;
    }
    if (msg.type === 'lab:error' || msg.type.endsWith(':result')) {
      const request = msg.type === 'lab:error' ? String(msg.request ?? 'unknown') : msg.type.replace(/:result$/, '');
      entry(msg.from).last = { request, ok: msg.ok === true, detail: replyDetail(msg) };
      if (msg.type === 'lab:runExperiment:result' && msg.run) {
        runs.push({ student: msg.from, requestId: (msg.requestId as RequestId) ?? null, run: msg.run });
      }
      changed();
    }
  };

  channel.addEventListener('message', onMessage);

  const send = (type: string, fields: Record<string, unknown> = {}, to?: string[]): string => {
    const requestId = `${tabId}:${++seq}`;
    const msg: Record<string, unknown> = { ...fields, type, requestId, from: tabId };
    if (to && to.length) msg.to = to;
    channel.postMessage(msg);
    return requestId;
  };

  return {
    tabId,
    roster: () => Array.from(roster.values()).sort((a, b) => a.id.localeCompare(b.id)),
    runs: () => runs.slice(),
    send,
    ping: () => send('lab:ping'),
    prune(maxAgeMs) {
      const cutoff = now() - maxAgeMs;
      let n = 0;
      for (const [id, e] of roster) {
        if (e.lastSeenMs < cutoff) {
          roster.delete(id);
          n++;
        }
      }
      if (n) changed();
      return n;
    },
    dispose: () => channel.removeEventListener('message', onMessage)
  };
}
