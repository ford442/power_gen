/**
 * Embed / classroom message protocol (#224 §5) — pure: no DOM, no globals, so
 * Node unit-tests it (scripts/test-embed.mjs). The same request shapes travel
 * over `postMessage` (an `?embed=1` lab in a parent page's iframe) and over
 * `BroadcastChannel('seg-lab')` (teacher console → student tabs); see
 * docs/EMBED.md for the table.
 *
 *   request  { type: 'lab:<verb>', requestId?, ...fields }
 *   reply    { type: 'lab:<verb>:result', requestId, ok: true, ...payload }
 *          | { type: 'lab:error', requestId, ok: false, request, error }
 *
 * Simulated, not metrology: telemetry values are simulation state.
 */
import { DEVICE_BY_ID, DEVICE_TELEMETRY_FIELDS } from '../../generated/device-catalog';

export const EMBED_PROTOCOL_VERSION = 1;
export const LAB_CHANNEL_NAME = 'seg-lab';
export const LAB_DISCLAIMER = 'Simulated, not metrology';

export const TELEMETRY_HZ_MAX = 10;
export const TELEMETRY_HZ_MIN = 0.2;
export const TELEMETRY_HZ_DEFAULT = 4;

export const LAB_REQUEST_TYPES = [
  'lab:hello',
  'lab:ping',
  'lab:loadConfig',
  'lab:runExperiment',
  'lab:snapshot',
  'lab:subscribe',
  'lab:unsubscribe'
] as const;
export type LabRequestType = (typeof LAB_REQUEST_TYPES)[number];

export type RequestId = string | number | null;

export interface HelloRequest { type: 'lab:hello'; requestId: RequestId }
export interface PingRequest { type: 'lab:ping'; requestId: RequestId }
export interface LoadConfigRequest { type: 'lab:loadConfig'; requestId: RequestId; config: Record<string, unknown> }
export interface RunExperimentRequest {
  type: 'lab:runExperiment';
  requestId: RequestId;
  /** Experiment id, or a whole experiment definition object. */
  experiment: string | Record<string, unknown>;
  sweep?: boolean | Record<string, unknown>;
}
export interface SnapshotRequest { type: 'lab:snapshot'; requestId: RequestId }
export interface SubscribeRequest {
  type: 'lab:subscribe';
  requestId: RequestId;
  /** Telemetry keys; `null` = follow the focused device's catalog keys. */
  keys: string[] | null;
  hz: number;
}
export interface UnsubscribeRequest { type: 'lab:unsubscribe'; requestId: RequestId; subscription: number | null }

export type LabRequest =
  | HelloRequest
  | PingRequest
  | LoadConfigRequest
  | RunExperimentRequest
  | SnapshotRequest
  | SubscribeRequest
  | UnsubscribeRequest;

export interface LabResultReply {
  type: `${LabRequestType}:result`;
  requestId: RequestId;
  ok: true;
  [field: string]: unknown;
}

export interface LabErrorReply {
  type: 'lab:error';
  requestId: RequestId;
  ok: false;
  /** The request type that failed (`'unknown'` when it had none). */
  request: string;
  error: string;
}

export type LabReply = LabResultReply | LabErrorReply;

export interface TelemetryMessage {
  type: 'lab:telemetry';
  subscription: number;
  /** Simulated seconds on the session clock (TelemetryHub sim time). */
  t: number;
  values: Record<string, number>;
}

/** What a student tab / embedded lab reports about itself (roster row). */
export interface LabStatus {
  view: string;
  labMode: string | null;
  renderer: string | null;
  experiment: string | null;
  simTimeS: number;
  title: string;
}

/**
 * Origins
 * ───────
 * An allowlist entry is an exact origin, `scheme://host[:port]`, compared as
 * the browser serializes `MessageEvent.origin` (lowercase, default port
 * dropped). `*`, any wildcard, `null`, paths, queries, credentials and
 * non-http(s) schemes are refused.
 */
export function parseOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.includes('*') || s.toLowerCase() === 'null') return null;
  if (!/^https?:\/\/[^/?#@\s]+\/?$/i.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || !u.hostname) return null;
  return u.origin;
}

export interface EmbedAllowlist {
  /** Exact origins whose messages are handled. */
  allowed: ReadonlySet<string>;
  /** Configured entries that were refused (wildcards, paths, junk). */
  refused: string[];
}

/** `embedOrigins` ∪ this page's own origin (an opaque `null` origin is never added). */
export function buildAllowlist(configured: readonly unknown[], selfOrigin: string | null | undefined): EmbedAllowlist {
  const allowed = new Set<string>();
  const refused: string[] = [];
  for (const entry of configured) {
    const o = parseOrigin(entry);
    if (o) allowed.add(o);
    else refused.push(String(entry));
  }
  const self = parseOrigin(selfOrigin ?? '');
  if (self) allowed.add(self);
  return { allowed, refused };
}

export function isAllowedOrigin(list: EmbedAllowlist, origin: unknown): boolean {
  return typeof origin === 'string' && origin !== 'null' && list.allowed.has(origin);
}

/** Telemetry push rate, clamped to [TELEMETRY_HZ_MIN, TELEMETRY_HZ_MAX]. */
export function clampHz(hz: unknown): number {
  const n = typeof hz === 'number' ? hz : typeof hz === 'string' && hz.trim() ? Number(hz) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return TELEMETRY_HZ_DEFAULT;
  return Math.min(TELEMETRY_HZ_MAX, Math.max(TELEMETRY_HZ_MIN, n));
}

/**
 * True when a push is due: at least one period since the last one. `lastMs`
 * is `-Infinity` before the first push.
 */
export function telemetryDue(lastMs: number, nowMs: number, hz: number): boolean {
  return nowMs - lastMs >= 1000 / clampHz(hz) - 0.5;
}

/**
 * Telemetry keys
 * ──────────────
 * Every `DEVICE_TELEMETRY_FIELDS` key (read from that device's snap), plus the
 * SEG catalog keys, which live on the operator telemetry rather than a snap.
 */
const SEG_KEY_SOURCE: Readonly<Record<string, string>> = {
  rpm: 'rpmDisplay',
  omega: 'segOmega',
  corona: 'corona',
  voltage: 'voltage',
  current: 'current',
  power: 'power',
  fieldSim: 'fieldSim'
};

const DEVICE_KEY_OWNER = new Map(DEVICE_TELEMETRY_FIELDS.map((f) => [f.key, f.deviceId]));

export const TELEMETRY_KEYS: readonly string[] = [
  ...Object.keys(SEG_KEY_SOURCE),
  ...DEVICE_TELEMETRY_FIELDS.map((f) => f.key)
];

const TELEMETRY_KEY_SET = new Set(TELEMETRY_KEYS);

export function isTelemetryKey(key: string): boolean {
  return TELEMETRY_KEY_SET.has(key);
}

/** Catalog telemetry keys of the focused view (`overview` / unknown → SEG). */
export function focusTelemetryKeys(view: string | null | undefined): string[] {
  const entry = view ? DEVICE_BY_ID[view] : undefined;
  const keys = entry && entry.id !== 'seg' ? entry.telemetryKeys.filter(isTelemetryKey) : [];
  return keys.length ? keys : Object.keys(SEG_KEY_SOURCE);
}

/** The slice of a TelemetrySnapshot the protocol reads. */
export interface TelemetrySnapshotLike {
  simTimeS: number;
  view?: string;
  seg?: object | null;
  devices?: Record<string, object | undefined>;
}

type Fields = Readonly<Record<string, unknown>> | null | undefined;

/** `{ key: number }` for the requested keys (missing / non-finite values are left out). */
export function pickTelemetry(snap: TelemetrySnapshotLike, keys: readonly string[]): Record<string, number> {
  const values: Record<string, number> = {};
  for (const key of keys) {
    const segField = SEG_KEY_SOURCE[key];
    let v: unknown;
    if (segField !== undefined) {
      v = (snap.seg as Fields)?.[segField];
    } else {
      const owner = DEVICE_KEY_OWNER.get(key);
      v = owner ? (snap.devices?.[owner] as Fields)?.[key] : undefined;
    }
    if (typeof v === 'number' && Number.isFinite(v)) values[key] = v;
  }
  return values;
}

/**
 * Validation
 * ──────────
 * `parseLabRequest` returns `null` for anything that is not addressed to the
 * lab at all (no `lab:` type — other scripts post messages too), so callers
 * stay silent; a malformed `lab:` request becomes an error reply.
 */
const REQUEST_TYPE_SET = new Set<string>(LAB_REQUEST_TYPES);
const EXPERIMENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_KEYS = 128;

export type ParsedRequest =
  | { ok: true; request: LabRequest }
  | { ok: false; reply: LabErrorReply };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function requestIdOf(v: unknown): RequestId | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && v.length <= 128) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

export function errorReply(request: string, requestId: RequestId, error: string): LabErrorReply {
  return { type: 'lab:error', requestId, ok: false, request, error };
}

export function resultReply(type: LabRequestType, requestId: RequestId, payload: Record<string, unknown> = {}): LabResultReply {
  return { ...payload, type: `${type}:result`, requestId, ok: true };
}

export function parseLabRequest(data: unknown): ParsedRequest | null {
  if (!isPlainObject(data) || typeof data.type !== 'string' || !data.type.startsWith('lab:')) return null;
  const type = data.type;
  // Replies, telemetry and announcements are not requests.
  if (type.endsWith(':result') || type === 'lab:error' || type === 'lab:telemetry'
    || type === 'lab:ready' || type === 'lab:bye') return null;
  const rid = requestIdOf(data.requestId);
  const fail = (error: string): ParsedRequest => ({ ok: false, reply: errorReply(type, rid ?? null, error) });
  if (rid === undefined) return fail('requestId must be a string (≤128 chars) or a finite number');
  if (!REQUEST_TYPE_SET.has(type)) return fail(`unknown request type ${JSON.stringify(type)}`);

  switch (type as LabRequestType) {
    case 'lab:hello':
    case 'lab:ping':
    case 'lab:snapshot':
      return { ok: true, request: { type: type as 'lab:hello' | 'lab:ping' | 'lab:snapshot', requestId: rid } };
    case 'lab:loadConfig':
      if (!isPlainObject(data.config)) return fail('config must be an object');
      return { ok: true, request: { type: 'lab:loadConfig', requestId: rid, config: data.config } };
    case 'lab:runExperiment': {
      const def = data.experiment;
      const id = data.id;
      let experiment: string | Record<string, unknown>;
      if (isPlainObject(def)) experiment = def;
      else if (typeof id === 'string' && EXPERIMENT_ID.test(id)) experiment = id;
      else if (typeof def === 'string' && EXPERIMENT_ID.test(def)) experiment = def;
      else return fail('expected id (experiment id) or experiment (definition object)');
      const sweep = data.sweep;
      if (sweep !== undefined && typeof sweep !== 'boolean' && !isPlainObject(sweep)) {
        return fail('sweep must be a boolean or an object');
      }
      const request: RunExperimentRequest = { type: 'lab:runExperiment', requestId: rid, experiment };
      if (sweep !== undefined) request.sweep = sweep;
      return { ok: true, request };
    }
    case 'lab:subscribe': {
      let keys: string[] | null = null;
      if (data.keys !== undefined && data.keys !== null) {
        if (!Array.isArray(data.keys) || data.keys.length > MAX_KEYS || !data.keys.every((k) => typeof k === 'string')) {
          return fail(`keys must be an array of at most ${MAX_KEYS} strings`);
        }
        const unknown = (data.keys as string[]).filter((k) => !isTelemetryKey(k));
        if (unknown.length) return fail(`unknown telemetry key(s): ${unknown.slice(0, 8).join(', ')}`);
        keys = Array.from(new Set(data.keys as string[]));
      }
      return { ok: true, request: { type: 'lab:subscribe', requestId: rid, keys, hz: clampHz(data.hz) } };
    }
    case 'lab:unsubscribe': {
      const sub = data.subscription;
      if (sub !== undefined && sub !== null && !(typeof sub === 'number' && Number.isInteger(sub))) {
        return fail('subscription must be an integer');
      }
      return { ok: true, request: { type: 'lab:unsubscribe', requestId: rid, subscription: typeof sub === 'number' ? sub : null } };
    }
  }
}

/**
 * Classroom channel envelope: every BroadcastChannel message also carries the
 * sender's tab id (`from`) and, from the teacher, an optional `to` list of
 * student ids (absent = everyone).
 */
export interface ChannelEnvelope {
  from: string;
  to?: string[];
}

/** True when a channel message from `from` / to `to` is for tab `self`. */
export function channelAddressedTo(data: unknown, self: string): boolean {
  if (!isPlainObject(data) || typeof data.from !== 'string' || data.from === self) return false;
  if (data.to === undefined) return true;
  return Array.isArray(data.to) && data.to.includes(self);
}

/** Requests a student tab accepts from the teacher channel. */
export const CHANNEL_REQUEST_TYPES: ReadonlySet<string> = new Set<LabRequestType>([
  'lab:hello',
  'lab:ping',
  'lab:loadConfig',
  'lab:runExperiment'
]);
