/**
 * LabConfig — the one reader for every lab knob (#224 §1).
 *
 * `config/lab-config.json` → `generated/lab-config.ts` declares each field's
 * type, default, range, URL alias(es), localStorage key and whether it rides
 * in share links. This module (with its lazy share-hash half, share-url.ts) is
 * the only code in `src/` that reads `location.search` / `location.hash` /
 * `localStorage` for configuration (`npm run check:lab-config` enforces that),
 * with one precedence for all of it:
 *
 *   URL query  >  share hash (#lab2= / legacy #lab=)  >  localStorage  >  default
 *
 * Parsing is tolerant and uniform: booleans accept 1/0/on/off/true/false/yes/no,
 * enums are case-insensitive with catalogued aliases, numbers are finite-checked
 * and clamped. An unparsable value is *absent* — it falls through to the next
 * layer — so a hand-edited link can never put NaN into a plant.
 *
 * The resolved config is a snapshot of the page's inputs, recomputed only when
 * the URL or a persisted value changes. Live state (the current coupling
 * toggle, the focused bench) stays with the components that own it.
 */
import {
  LAB_CONFIG_DEFAULTS,
  LAB_CONFIG_FIELDS,
  type LabConfig,
  type LabConfigKey,
  type LabFieldSpec
} from '../../generated/lab-config';
import { DEVICE_SETPOINTS } from '../../generated/device-catalog';

export type { LabConfig, LabConfigKey } from '../../generated/lab-config';

export type LabConfigSource = 'url' | 'hash' | 'storage' | 'default';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ResolvedLabConfig {
  config: LabConfig;
  sources: Record<LabConfigKey, LabConfigSource>;
  /** Stored values that were present but refused (e.g. a stored `webgl2`). */
  rejectedStorage: Partial<Record<LabConfigKey, string>>;
}

const SPEC_BY_KEY = new Map<LabConfigKey, LabFieldSpec>(LAB_CONFIG_FIELDS.map((f) => [f.key, f]));

export function labFieldSpec(key: LabConfigKey): LabFieldSpec {
  const spec = SPEC_BY_KEY.get(key);
  if (!spec) throw new Error(`[lab-config] unknown field ${key}`);
  return spec;
}

// ─────────────────────────────────────────────────────────────
// Coercion — one tolerant parser for every layer
// ─────────────────────────────────────────────────────────────

/** `1/0/on/off/true/false/yes/no` (any case), or a real boolean; else undefined. */
export function parseLabBool(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw === 1 ? true : raw === 0 ? false : undefined;
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'on' || v === 'true' || v === 'yes') return true;
  if (v === '0' || v === 'off' || v === 'false' || v === 'no') return false;
  return undefined;
}

function coerceNumber(spec: LabFieldSpec, raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return undefined;
  if (spec.exclusiveMin !== undefined && n <= spec.exclusiveMin) return undefined;
  // Integer fields take the whole value (`1e9`, not parseInt's 1); 4.5 is not an int.
  if (spec.type === 'int' && !Number.isInteger(n)) return undefined;
  return Math.max(spec.min ?? -Infinity, Math.min(spec.max ?? Infinity, n));
}

function coerceEnum(spec: LabFieldSpec, raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  const values = spec.values ?? [];
  const direct = values.find((x) => x.toLowerCase() === v);
  if (direct) return direct;
  return spec.aliases?.[v];
}

function coerceSetpoints(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const sp = DEVICE_SETPOINTS.find((s) => s.id === id);
    const n = typeof value === 'number' ? value : Number(value);
    if (!sp || !Number.isFinite(n)) continue;
    out[id] = Math.max(sp.min, Math.min(sp.max, n));
  }
  return out;
}

/**
 * Coerce one raw value (a URL / storage string, or a JSON value from a share
 * link or `.lab.json`) into the field's type, or undefined when unusable.
 */
export function coerceLabField<K extends LabConfigKey>(key: K, raw: unknown): LabConfig[K] | undefined {
  const spec = labFieldSpec(key);
  let out: unknown;
  switch (spec.type) {
    case 'bool': out = parseLabBool(raw); break;
    case 'enum': out = coerceEnum(spec, raw); break;
    case 'number':
    case 'int': out = coerceNumber(spec, raw); break;
    case 'string':
      out = typeof raw === 'string' && (!spec.pattern || new RegExp(spec.pattern).test(raw)) ? raw : undefined;
      break;
    case 'list': {
      const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : null;
      out = items ? items.map((s) => String(s).trim()).filter(Boolean) : undefined;
      break;
    }
    case 'setpoints': out = coerceSetpoints(raw); break;
  }
  return out as LabConfig[K] | undefined;
}

// ─────────────────────────────────────────────────────────────
// Layers
// ─────────────────────────────────────────────────────────────

function urlLayer(params: URLSearchParams): Partial<LabConfig> {
  const out: Partial<Record<LabConfigKey, unknown>> = {};
  for (const spec of LAB_CONFIG_FIELDS) {
    for (const alias of spec.url) {
      const raw = params.get(alias);
      if (raw === null) continue;
      const v = coerceLabField(spec.key, raw);
      if (v !== undefined) {
        out[spec.key] = v;
        break;
      }
    }
  }
  return out as Partial<LabConfig>;
}

function storageLayer(
  storage: StorageLike | null,
  rejected: Partial<Record<LabConfigKey, string>>
): Partial<LabConfig> {
  const out: Partial<Record<LabConfigKey, unknown>> = {};
  if (!storage) return out as Partial<LabConfig>;
  for (const spec of LAB_CONFIG_FIELDS) {
    const st = spec.storage;
    if (!st) continue;
    let raw: string | null = null;
    try {
      raw = storage.getItem(st.key);
    } catch {
      return out as Partial<LabConfig>; // blocked storage: nothing stored
    }
    if (raw === null || raw === '') continue;
    const v = coerceLabField(spec.key, raw);
    if (v === undefined || (st.values && !st.values.includes(String(v)))) {
      rejected[spec.key] = raw;
      continue;
    }
    out[spec.key] = v;
  }
  return out as Partial<LabConfig>;
}

export interface ResolveLabConfigInput {
  search?: string | URLSearchParams;
  /** Fields carried by the share hash (decoded, not yet coerced). */
  hashFields?: Record<string, unknown>;
  storage?: StorageLike | null;
}

/** Pure resolver: URL > hash > storage > default. Node-safe; used by tests. */
export function resolveLabConfig(input: ResolveLabConfigInput = {}): ResolvedLabConfig {
  const params = typeof input.search === 'string' || input.search === undefined
    ? safeParams(input.search ?? '')
    : input.search;
  const rejectedStorage: Partial<Record<LabConfigKey, string>> = {};
  const layers: Array<[LabConfigSource, Partial<LabConfig>]> = [
    ['url', urlLayer(params)],
    ['hash', sanitizeFields(input.hashFields ?? {}, true)],
    ['storage', storageLayer(input.storage ?? null, rejectedStorage)]
  ];
  const config = { ...LAB_CONFIG_DEFAULTS } as Record<LabConfigKey, unknown>;
  const sources = {} as Record<LabConfigKey, LabConfigSource>;
  for (const spec of LAB_CONFIG_FIELDS) {
    sources[spec.key] = 'default';
    for (const [source, layer] of layers) {
      if (layer[spec.key] !== undefined) {
        config[spec.key] = layer[spec.key];
        sources[spec.key] = source;
        break;
      }
    }
  }
  return { config: config as unknown as LabConfig, sources, rejectedStorage };
}

/**
 * Coerce a bag of JSON-ish values (share payload, `.lab.json`), dropping junk.
 * `shareOnly` keeps just the share-eligible fields — a link describes an
 * experiment, it does not get to pick the renderer or GPU flags.
 */
export function sanitizeFields(raw: Record<string, unknown>, shareOnly = false): Partial<LabConfig> {
  const out: Partial<Record<LabConfigKey, unknown>> = {};
  if (!raw || typeof raw !== 'object') return out as Partial<LabConfig>;
  for (const [k, v] of Object.entries(raw)) {
    const spec = SPEC_BY_KEY.get(k as LabConfigKey);
    if (!spec || (shareOnly && !spec.share)) continue;
    const c = coerceLabField(k as LabConfigKey, v);
    if (c !== undefined) out[k as LabConfigKey] = c;
  }
  return out as Partial<LabConfig>;
}

function safeParams(search: string): URLSearchParams {
  try {
    return new URLSearchParams(search);
  } catch {
    return new URLSearchParams();
  }
}

// ─────────────────────────────────────────────────────────────
// Page singleton
// ─────────────────────────────────────────────────────────────

export function pageStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function pageSearch(): string {
  return typeof location !== 'undefined' ? location.search ?? '' : '';
}

function pageHash(): string {
  return typeof location !== 'undefined' ? location.hash ?? '' : '';
}

/**
 * Decoded share hashes (`#lab=` / `#lab2=`), keyed by the hash string. Both
 * codecs live in a lazy chunk (share-url.ts); {@link initLabConfig} fills this
 * before boot reads anything, so a plain boot never loads them.
 */
const hashCache = new Map<string, Record<string, unknown>>();
let cacheKey: string | null = null;
let cached: ResolvedLabConfig | null = null;
let storageGeneration = 0;

function isShareHash(hash: string): boolean {
  return hash.startsWith('#lab=') || hash.startsWith('#lab2=');
}

/**
 * Record what a share hash carries — after decoding the page's own, or when a
 * share link was just written — so `labConfig()` reads it straight away.
 */
export function primeShareHash(hash: string, fields: Record<string, unknown>): void {
  hashCache.set(hash, { ...fields });
  cached = null;
}

/** Forget the resolved snapshot (after an address-bar rewrite). */
export function invalidateLabConfig(): void {
  cached = null;
}

/** This page's resolved config (cheap: recomputed only when inputs change). */
export function labConfigResolved(): ResolvedLabConfig {
  const search = pageSearch();
  const hash = pageHash();
  const key = `${storageGeneration}|${search}|${hash}`;
  if (cached && cacheKey === key) return cached;
  cached = resolveLabConfig({ search, hashFields: hashCache.get(hash) ?? {}, storage: pageStorage() });
  cacheKey = key;
  return cached;
}

export function labConfig(): LabConfig {
  return labConfigResolved().config;
}

export function labConfigSource(key: LabConfigKey): LabConfigSource {
  return labConfigResolved().sources[key];
}

/** Set by the URL or the share hash — the user asked for it on this load. */
export function labConfigExplicit(key: LabConfigKey): boolean {
  const s = labConfigSource(key);
  return s === 'url' || s === 'hash';
}

/**
 * A resolved view for callers that take an injectable query (tests, and the
 * per-prop CAD switches): with `params` it is that query alone over the
 * defaults — no storage, no hash — exactly what such a caller used to see.
 */
export function labConfigFor(params?: URLSearchParams | string): ResolvedLabConfig {
  return params === undefined ? labConfigResolved() : resolveLabConfig({ search: params });
}

/**
 * Decode the page's share hash (if any) so the first `labConfig()` read
 * already includes it. Boot awaits this before choosing a renderer; without a
 * `#lab=` / `#lab2=` hash it resolves immediately and loads nothing.
 */
export async function initLabConfig(): Promise<LabConfig> {
  const hash = pageHash();
  if (isShareHash(hash) && !hashCache.has(hash)) {
    let fields: Record<string, unknown> = {};
    try {
      const { decodeHashFields } = await import('./share-url');
      fields = await decodeHashFields(hash);
    } catch (err) {
      console.warn('[lab-config] could not decode the share link — ignoring it:', err);
    }
    primeShareHash(hash, fields);
  }
  return labConfig();
}

// ─────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────

function encodeStored(spec: LabFieldSpec, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  switch (spec.storage?.codec) {
    case 'bool': return value ? 'true' : 'false';
    case 'int': return String(Math.trunc(Number(value)));
    default: return String(value);
  }
}

/**
 * Remember a field across reloads (its `localStorage` key, in its codec);
 * `null` forgets it. A field with no storage key is a no-op.
 */
export function persistLabConfig<K extends LabConfigKey>(key: K, value: LabConfig[K] | null): void {
  const spec = labFieldSpec(key);
  const storage = pageStorage();
  if (spec.storage && storage) {
    const encoded = encodeStored(spec, value);
    try {
      if (encoded === null) storage.removeItem(spec.storage.key);
      else storage.setItem(spec.storage.key, encoded);
    } catch {
      /* private window / blocked storage: the choice lasts this session only */
    }
    storageGeneration++;
  }
}

/**
 * Stored values of `keys`, to put back with {@link restoreStoredLabValues}
 * (Showroom forces the buses off for a session without rewriting prefs).
 */
export function snapshotStoredLabValues(keys: readonly LabConfigKey[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const storage = pageStorage();
  if (!storage) return out;
  try {
    for (const k of keys) {
      const st = labFieldSpec(k).storage;
      if (st) out.set(st.key, storage.getItem(st.key));
    }
  } catch {
    /* no storage — nothing to preserve */
  }
  return out;
}

export function restoreStoredLabValues(saved: Map<string, string | null>): void {
  const storage = pageStorage();
  if (!storage) return;
  try {
    for (const [k, v] of saved) {
      if (v == null) storage.removeItem(k);
      else storage.setItem(k, v);
    }
  } catch {
    /* ignore */
  }
  storageGeneration++;
}

/** This page's URL with `key` set to `value` (canonical alias) or removed. */
export function urlWithLabParam<K extends LabConfigKey>(key: K, value: LabConfig[K] | null): URL | null {
  if (typeof location === 'undefined') return null;
  const spec = labFieldSpec(key);
  try {
    const url = new URL(location.href);
    for (const alias of spec.url) url.searchParams.delete(alias);
    if (value !== null && value !== undefined && spec.url.length) {
      const text = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
      url.searchParams.set(spec.url[0], text);
    }
    return url;
  } catch {
    return null; // non-http origin (file://, sandboxed frame)
  }
}

/** Rewrite a query param in place (history.replaceState; no reload). */
export function setLabUrlParam<K extends LabConfigKey>(key: K, value: LabConfig[K] | null): void {
  const url = urlWithLabParam(key, value);
  if (!url) return;
  try {
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  } catch {
    /* ignore */
  }
}

/** Navigate to this page with `key` set — for boot-only fields (WASM, renderer). */
export function reloadWithLabParam<K extends LabConfigKey>(key: K, value: LabConfig[K] | null): void {
  const url = urlWithLabParam(key, value);
  if (url) location.href = url.toString();
}

/** Live fields only the share-link applier consumes — no boot-time reader owns them. */
const URL_APPLIED: readonly LabConfigKey[] = ['mode', 'experiment'];

/**
 * What to apply once the dashboard exists: every field the share hash set
 * (boot-time readers already took the ones they own, and applying those
 * again is a no-op), plus `?mode=` / `?experiment=` from the query.
 */
export function bootLiveFields(): Partial<LabConfig> {
  const { config, sources } = labConfigResolved();
  const out: Partial<Record<LabConfigKey, unknown>> = {};
  for (const k of Object.keys(sources) as LabConfigKey[]) {
    if (sources[k] === 'hash' || (sources[k] === 'url' && URL_APPLIED.includes(k))) out[k] = config[k];
  }
  return out as Partial<LabConfig>;
}
