/**
 * Field volume — CPU reference of the GPU 3-D texture (ADR-0017, #255 §2).
 *
 * The volume is an n³ grid over a bench's AABB in **device-local scene units**
 * (the frame the meshes and flux segments are drawn in; the draw adds the
 * device position). Each texel holds (B.x, B.y, B.z, |B|) in **millitesla**
 * at the texel centre — rgba16float on the GPU, so values are stored in mT
 * to stay clear of f16 subnormals (|B| from 60 nT to 65 T keeps 11 bits).
 *
 *   texel (i, j, k) centre = min + (i + ½, j + ½, k + ½) / n · (max − min)
 *
 * which is exactly where `textureSampleLevel(vol, linear, uvw, 0)` puts texel
 * centres, so {@link sampleFieldVolume} (trilinear, clamp-to-edge) reproduces
 * what the GPU consumers read, and {@link buildFieldVolume} with `f16: true`
 * reproduces what the compute pass stores.
 */

import { evaluateFieldT, type Vec3Out } from './field-eval';

/** Texel value scale: stored = B(T) × FIELD_VOLUME_PER_TESLA (mT). */
export const FIELD_VOLUME_PER_TESLA = 1000;
/** Compute brick edge (texels). One 4³ workgroup per brick. */
export const FIELD_BRICK = 4;
/** FieldVolumeParams uniform (field-volume.wgsl): 4 × vec4. */
export const FIELD_VOLUME_PARAMS_BYTES = 64;

export interface FieldVolumeDesc {
  /** Texels per axis (multiple of FIELD_BRICK). */
  n: number;
  /** Device-local AABB, scene units. */
  min: readonly [number, number, number];
  max: readonly [number, number, number];
  /** Metres per scene unit. */
  unitM: number;
}

export interface FieldVolume extends FieldVolumeDesc {
  /** n³ × 4 floats, x fastest, then y, then z (same as the 3-D texture). */
  data: Float32Array;
}

const f16Buf = new Float32Array(1);
const f16Int = new Uint32Array(f16Buf.buffer);

/** Round a number to the nearest IEEE half (round-to-nearest-even), returned as a number. */
export function roundF16(v: number): number {
  if (!Number.isFinite(v)) return v;
  const a = Math.abs(v);
  if (a >= 65520) return v < 0 ? -Infinity : Infinity;
  if (a < 2 ** -25) return 0 * Math.sign(v);
  f16Buf[0] = v;
  const bits = f16Int[0];
  const exp = ((bits >>> 23) & 0xff) - 127;
  // Mantissa bits to keep: 10 for normals, fewer for subnormals (exp < -14).
  const keep = exp >= -14 ? 10 : Math.max(0, 10 - (-14 - exp));
  const drop = 23 - keep;
  const half = 1 << (drop - 1);
  const mask = (1 << drop) - 1;
  const rem = bits & mask;
  let base = bits & ~mask;
  if (rem > half || (rem === half && ((base >>> drop) & 1) === 1)) base += 1 << drop;
  f16Int[0] = base >>> 0;
  return f16Buf[0];
}

/** Scene-unit centre of texel (i, j, k). */
export function texelCenter(desc: FieldVolumeDesc, i: number, j: number, k: number, out: Vec3Out = [0, 0, 0]): Vec3Out {
  const { n, min, max } = desc;
  out[0] = min[0] + ((i + 0.5) / n) * (max[0] - min[0]);
  out[1] = min[1] + ((j + 0.5) / n) * (max[1] - min[1]);
  out[2] = min[2] + ((k + 0.5) / n) * (max[2] - min[2]);
  return out;
}

/**
 * Fill an n³ volume from packed sources (metres, `unitM` converts scene units).
 * `f16` rounds every component the way the rgba16float store does.
 * `zRange` limits the fill to texel slabs [z0, z1) — the GPU sweep's unit.
 */
export function buildFieldVolume(
  desc: FieldVolumeDesc,
  sources: Float32Array,
  count: number,
  opts: { f16?: boolean; zRange?: [number, number]; out?: Float32Array } = {}
): FieldVolume {
  const { n, unitM } = desc;
  const data = opts.out ?? new Float32Array(n * n * n * 4);
  const [z0, z1] = opts.zRange ?? [0, n];
  const c: Vec3Out = [0, 0, 0];
  const b: Vec3Out = [0, 0, 0];
  const s = FIELD_VOLUME_PER_TESLA;
  const round = opts.f16 ? roundF16 : (v: number) => v;
  for (let k = z0; k < z1; k++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        texelCenter(desc, i, j, k, c);
        evaluateFieldT(c[0] * unitM, c[1] * unitM, c[2] * unitM, sources, count, b);
        const o = ((k * n + j) * n + i) * 4;
        data[o] = round(b[0] * s);
        data[o + 1] = round(b[1] * s);
        data[o + 2] = round(b[2] * s);
        data[o + 3] = round(Math.hypot(b[0], b[1], b[2]) * s);
      }
    }
  }
  return { ...desc, data };
}

/**
 * Trilinear sample (clamp-to-edge), scene-unit point → (Bx, By, Bz, |B|) in **tesla**.
 * The |B| channel is interpolated like the GPU's, not recomputed from B.
 */
export function sampleFieldVolume(
  vol: FieldVolume,
  x: number,
  y: number,
  z: number,
  out: [number, number, number, number] = [0, 0, 0, 0]
): [number, number, number, number] {
  const { n, min, max, data } = vol;
  const g = (p: number, a: number, b: number) => Math.max(0, Math.min(n - 1, ((p - a) / (b - a)) * n - 0.5));
  const fx = g(x, min[0], max[0]), fy = g(y, min[1], max[1]), fz = g(z, min[2], max[2]);
  const i0 = Math.floor(fx), j0 = Math.floor(fy), k0 = Math.floor(fz);
  const i1 = Math.min(n - 1, i0 + 1), j1 = Math.min(n - 1, j0 + 1), k1 = Math.min(n - 1, k0 + 1);
  const tx = fx - i0, ty = fy - j0, tz = fz - k0;
  out[0] = out[1] = out[2] = out[3] = 0;
  for (let c = 0; c < 8; c++) {
    const ii = c & 1 ? i1 : i0, jj = c & 2 ? j1 : j0, kk = c & 4 ? k1 : k0;
    const w = (c & 1 ? tx : 1 - tx) * (c & 2 ? ty : 1 - ty) * (c & 4 ? tz : 1 - tz);
    if (w === 0) continue;
    const o = ((kk * n + jj) * n + ii) * 4;
    out[0] += w * data[o]; out[1] += w * data[o + 1]; out[2] += w * data[o + 2]; out[3] += w * data[o + 3];
  }
  const inv = 1 / FIELD_VOLUME_PER_TESLA;
  out[0] *= inv; out[1] *= inv; out[2] *= inv; out[3] *= inv;
  return out;
}

/**
 * FieldVolumeParams (field-volume.wgsl), 16 floats:
 *   [0..3]  min.xyz, unitM
 *   [4..7]  max.xyz, source count
 *   [8..11] n, first z brick of this dispatch, bricks this dispatch, unused
 *   [12..15] FIELD_VOLUME_PER_TESLA, unused ×3
 * Integers travel as f32 (exact below 2^24) and are converted in the shader.
 */
export function packFieldVolumeParams(
  desc: FieldVolumeDesc,
  count: number,
  zBrick0: number,
  zBricks: number,
  out: Float32Array = new Float32Array(FIELD_VOLUME_PARAMS_BYTES / 4)
): Float32Array {
  out[0] = desc.min[0]; out[1] = desc.min[1]; out[2] = desc.min[2]; out[3] = desc.unitM;
  out[4] = desc.max[0]; out[5] = desc.max[1]; out[6] = desc.max[2]; out[7] = count;
  out[8] = desc.n; out[9] = zBrick0; out[10] = zBricks; out[11] = 0;
  out[12] = FIELD_VOLUME_PER_TESLA; out[13] = 0; out[14] = 0; out[15] = 0;
  return out;
}

/** Volume resolution per quality tier: low skips (null), medium 64³, high / ultra 128³. */
export function fieldVolumeResolution(tier: string | null | undefined): number | null {
  if (tier === 'medium') return 64;
  if (tier === 'high' || tier === 'ultra') return 128;
  return null;
}
