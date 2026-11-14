/**
 * Share-hash plumbing that only the lazy share / load chunks need — kept out
 * of lab-config.ts so a plain boot (no hash, no Lab Link click) never pays for
 * it. Both hash codecs are decoded here: legacy `#lab=v1;…` synchronously,
 * `#lab2=` via share-link.ts.
 */
import { LAB_CONFIG_FIELDS, type LabConfig, type LabConfigKey } from '../../generated/lab-config';
import { invalidateLabConfig, labFieldSpec } from './lab-config';
import { decodeLabHashV1, labHashV1ToConfig } from './lab-hash-v1';

/** The raw (not yet coerced) fields a share hash carries; `{}` for none. */
export async function decodeHashFields(hash: string): Promise<Record<string, unknown>> {
  if (hash.includes('#lab2=')) {
    const { decodeShareHash } = await import('./share-link');
    return decodeShareHash(hash);
  }
  const v1 = decodeLabHashV1(hash);
  return v1 ? labHashV1ToConfig(v1) : {};
}

/** Fields that differ from their defaults and are share-eligible. */
export function nonDefaultShareFields(config: Partial<LabConfig>): Partial<LabConfig> {
  const out: Partial<Record<LabConfigKey, unknown>> = {};
  for (const spec of LAB_CONFIG_FIELDS) {
    if (!spec.share) continue;
    const v = config[spec.key];
    if (v === undefined || v === null) continue;
    if (JSON.stringify(v) === JSON.stringify(spec.default)) continue;
    if (spec.type === 'setpoints' && Object.keys(v as object).length === 0) continue;
    out[spec.key] = v;
  }
  return out as Partial<LabConfig>;
}

/** The page URL without its hash — the base a share link is built on. */
export function pageUrlWithoutHash(): string {
  if (typeof location === 'undefined') return '';
  return `${location.origin}${location.pathname}${location.search}`;
}

/** Current share hash string (`#lab=…` / `#lab2=…`), or ''. */
export function currentShareHash(): string {
  const h = typeof location !== 'undefined' ? location.hash : '';
  return h.startsWith('#lab=') || h.startsWith('#lab2=') ? h : '';
}

/** Replace the hash without reloading (used when a share link is created). */
export function replacePageHash(hash: string): void {
  try {
    history.replaceState(null, '', hash);
  } catch {
    /* sandboxed frame */
  }
}

/**
 * Make the address bar describe a loaded config: the `#lab2=` hash, minus any
 * query param that would outrank it for one of `keys` (URL beats hash, so a
 * stale `?look=drama` would otherwise undo a loaded `look` on the next
 * reload). `reload` then reloads — for boot-only fields.
 */
export function adoptShareUrl(hash: string, keys: readonly LabConfigKey[], reload = false): void {
  if (typeof location === 'undefined') return;
  try {
    const url = new URL(location.href);
    for (const k of keys) for (const alias of labFieldSpec(k).url) url.searchParams.delete(alias);
    url.hash = hash;
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    invalidateLabConfig();
    if (reload) location.reload();
  } catch {
    /* sandboxed frame / file:// — leave the address bar alone */
  }
}
