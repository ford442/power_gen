/**
 * Share links v2 — `#lab2=<codec><payload>` (#224 §1). Lazy chunk.
 *
 *   payload = base64url( deflate-raw( JSON { v: 2, s: <schema hash>, c: {…} } ) )   codec 'z'
 *           | base64url( JSON … )                                                   codec 'j'
 *
 * `c` holds only share-eligible fields that differ from their defaults, so a
 * typical link is ~100 characters. `j` is the fallback for a browser without
 * CompressionStream; the decoder takes both. The schema hash is metadata —
 * a link from an older schema still loads, field by field, through the same
 * coercion as the URL (unknown keys dropped, ranges clamped).
 */
import { LAB_CONFIG_SCHEMA_HASH, type LabConfig } from '../../generated/lab-config';
import { nonDefaultShareFields } from './share-url';

export const SHARE_LINK_VERSION = 2;
/** Above this many characters the dialog warns that some chat apps truncate. */
export const SHARE_LINK_SOFT_MAX = 1800;

interface SharePayload {
  v: number;
  s: string;
  c: Record<string, unknown>;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const body = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function hasCompression(): boolean {
  return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

/** `#lab2=…` for these fields (defaults and non-share fields are dropped). */
export async function encodeShareHash(fields: Partial<LabConfig>): Promise<string> {
  const payload: SharePayload = { v: SHARE_LINK_VERSION, s: LAB_CONFIG_SCHEMA_HASH, c: nonDefaultShareFields(fields) };
  const json = new TextEncoder().encode(JSON.stringify(payload));
  if (hasCompression()) {
    try {
      return `#lab2=z${toBase64Url(await pipe(json, new CompressionStream('deflate-raw')))}`;
    } catch {
      /* fall through to the uncompressed codec */
    }
  }
  return `#lab2=j${toBase64Url(json)}`;
}

/**
 * The raw fields of a `#lab2=` hash (coerced later by the resolver). Throws
 * on a malformed payload; the caller treats that as "no hash".
 */
export async function decodeShareHash(hash: string): Promise<Record<string, unknown>> {
  const m = hash.match(/#lab2=([zj])([A-Za-z0-9_-]+)/);
  if (!m) return {};
  let bytes = fromBase64Url(m[2]);
  if (m[1] === 'z') {
    if (!hasCompression()) throw new Error('this browser cannot inflate #lab2=z links');
    bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
  }
  const payload = JSON.parse(new TextDecoder().decode(bytes)) as Partial<SharePayload>;
  if (!payload || typeof payload !== 'object' || typeof payload.c !== 'object' || payload.c === null) {
    throw new Error('#lab2= payload has no config');
  }
  if (typeof payload.v === 'number' && payload.v > SHARE_LINK_VERSION) {
    console.warn(`[lab-config] #lab2= link is version ${payload.v}; this build reads ${SHARE_LINK_VERSION} — loading the fields it knows`);
  }
  return payload.c;
}
