// ============================================================================
// IBL Specular Prefilter (GGX split-sum) — ADR-0005 Workstream 2
// ============================================================================
// Builds a small prefiltered environment "mip-chain" from a lighting preset
// (studio / lab / drama) at startup and uploads it as a 2D **array** texture.
//
// Layout: octahedral projection, one array layer per roughness level.
//   layer 0 .. IBL_SPEC_LEVELS-1 : GGX-prefiltered radiance, roughness = i/(n-1)
//   layer IBL_SPEC_LEVELS        : cosine-convolved irradiance (E/π)
//
// A real mip-chain would need per-level sizes; array layers keep every level at
// IBL_TEX_SIZE² so a single `textureSampleLevel` with a layer index works and
// levels can be blended without mip-selection artefacts. Budget at the defaults
// below is 7 × 64 × 64 × 8 B = 224 KiB — small enough to be always-on.
//
// The split-sum's second term (DFG) is the analytic Karis/Lazarov fit in
// pbr-eval.wgsl, so no BRDF LUT texture is needed.
//
// Keep IBL_TEX_SIZE / IBL_SPEC_LEVELS in sync with the constants of the same
// name in src/shaders/common/pbr-eval.wgsl (asserted by assertIblShaderContract).

import type { LightingPreset } from './seg-lighting-presets';

/** Octahedral face size, per array layer. */
export const IBL_TEX_SIZE = 64;

/** Number of GGX roughness levels (layer i ⇒ roughness i/(IBL_SPEC_LEVELS-1)). */
export const IBL_SPEC_LEVELS = 6;

/** Total array layers: the roughness chain plus one irradiance layer. */
export const IBL_LAYERS = IBL_SPEC_LEVELS + 1;

/** rgba16float is filterable and storage-free in core WebGPU. */
export const IBL_FORMAT: GPUTextureFormat = 'rgba16float';

/**
 * Importance-sample counts per roughness level (level 0 is a single mirror tap).
 * Tuned against a 512-spp reference: RMSE ≈ 3% of mean radiance for a ~280 ms
 * one-time bake at 64². Doubling these roughly doubles the bake for ~1% less
 * error, which is well below a quantisation step after tonemapping.
 */
export const SAMPLES_PER_LEVEL = [1, 32, 48, 48, 32, 24];

/** Cosine-hemisphere samples for the irradiance layer. */
export const IRRADIANCE_SAMPLES = 32;

const TWO_PI = Math.PI * 2;

type Vec3 = [number, number, number];

// ── small math helpers ──────────────────────────────────────────────────────

function normalize3(v: readonly number[]): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (l <= 1e-8) return [0, 1, 0];
  return [v[0] / l, v[1] / l, v[2] / l];
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0 || 1e-6)));
  return t * t * (3 - 2 * t);
}

function signNotZero(x: number): number {
  return x >= 0 ? 1 : -1;
}

/**
 * Octahedral decode — inverse of `octEncodeDir` in pbr-eval.wgsl.
 * Folds about the Y axis so the +Y hemisphere occupies the centre of the map.
 * @param u [0,1]
 * @param v [0,1]
 * @returns unit direction
 */
export function octDecode(u: number, v: number): Vec3 {
  const px = u * 2 - 1;
  const py = v * 2 - 1;
  let x = px;
  let z = py;
  const y = 1 - Math.abs(px) - Math.abs(py);
  if (y < 0) {
    const ax = x;
    x = (1 - Math.abs(z)) * signNotZero(ax);
    z = (1 - Math.abs(ax)) * signNotZero(z);
  }
  return normalize3([x, y, z]);
}

/** Van der Corput radical inverse (base 2) for the Hammersley sequence. */
function radicalInverseVdC(bitsIn: number): number {
  let bits = bitsIn;
  bits = ((bits << 16) | (bits >>> 16)) >>> 0;
  bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
  bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
  bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
  bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
  return bits * 2.3283064365386963e-10;
}

/** Orthonormal basis around `n` (Duff et al., branchless). */
function basisFrom(n: Vec3): [Vec3, Vec3] {
  const s = n[2] >= 0 ? 1 : -1;
  const a = -1 / (s + n[2]);
  const b = n[0] * n[1] * a;
  return [
    [1 + s * n[0] * n[0] * a, s * b, -s * n[0]],
    [b, s + n[1] * n[1] * a, -n[1]]
  ];
}

// ── source environment ──────────────────────────────────────────────────────

interface EnvDirs {
  keyDir: Vec3;
  fillDir: Vec3;
  rimDir: Vec3;
}

/**
 * Analytic studio environment sampled by the prefilter.
 *
 * Base hemisphere (ceiling softbox wash → floor bounce) matches the energy of
 * the polynomial this replaces, so exposure is unchanged; the added key / fill
 * / rim lobes are what produce readable mirror highlights on the SEG rollers.
 *
 * @param dir unit direction
 * @param preset lighting preset
 * @param dirs precomputed light directions
 * @param out rgb scratch (written in place)
 */
function envRadiance(dir: Vec3, preset: LightingPreset, dirs: EnvDirs, out: Float64Array): void {
  const L = preset.lighting;
  const sky = preset.sky;
  const up = Math.max(0, Math.min(1, dir[1] * 0.5 + 0.5));

  // Ceiling / floor wash — mirrors the old `envRadiance` in pbr-eval.wgsl.
  const skyMix = 0.55;
  const skyScale = L.fill.intensity * 0.42 + L.key.intensity * 0.28;
  const groundScale = L.ground.intensity * 3.2;

  for (let c = 0; c < 3; c++) {
    const skyCol = (L.fill.color[c] * (1 - skyMix) + L.key.color[c] * skyMix) * skyScale;
    const ceiling = skyCol * 0.65 + [0.92, 0.94, 0.97][c] * 0.35;
    const ground = L.ground.color[c] * groundScale;
    // A touch of the sky-dome gradient keeps reflections coherent with the
    // background the rollers are actually sitting in front of.
    const domeCol = sky ? sky.horizon[c] * (1 - up) + sky.top[c] * up : 0;
    out[c] = (ground * (1 - up) + ceiling * up) * 0.78 + domeCol * 0.28;
  }

  // Directional softboxes. Widths are chosen so the key reads as a broad
  // rectangle-ish blob on chrome and the rim stays a tight edge streak.
  const addLobe = (lightDir: Vec3, color: number[], intensity: number, cosOuter: number, cosInner: number, gain: number) => {
    const d = dir[0] * lightDir[0] + dir[1] * lightDir[1] + dir[2] * lightDir[2];
    const w = smoothstep(cosOuter, cosInner, d) * intensity * gain;
    if (w <= 0) return;
    out[0] += color[0] * w;
    out[1] += color[1] * w;
    out[2] += color[2] * w;
  };

  addLobe(dirs.keyDir, L.key.color, L.key.intensity, 0.82, 0.965, 1.55);
  addLobe(dirs.fillDir, L.fill.color, L.fill.intensity, 0.62, 0.94, 0.85);
  addLobe(dirs.rimDir, L.rim.color, L.rim.intensity, 0.90, 0.995, 1.15);

  // Floor bounce of the key, so the underside of the rollers is not dead black.
  if (dir[1] < 0) {
    const bounce = -dir[1] * L.key.intensity * 0.16;
    for (let c = 0; c < 3; c++) out[c] += L.ground.color[c] * L.key.color[c] * bounce;
  }
}

// ── half-float packing ──────────────────────────────────────────────────────

const f32Scratch = new Float32Array(1);
const u32Scratch = new Uint32Array(f32Scratch.buffer);

/**
 * IEEE-754 binary32 → binary16 (round-toward-zero on the mantissa).
 * Values are radiance ≥ 0 and well inside half range, so denormals/NaN paths
 * only need to be correct, not fast.
 * @returns 16-bit pattern
 */
export function floatToHalf(value: number): number {
  f32Scratch[0] = value;
  const x = u32Scratch[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;

  if (exp === 0xff) {
    // Inf / NaN
    return sign | 0x7c00 | (mant ? 0x200 : 0);
  }
  const e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00; // overflow → Inf
  if (e <= 0) {
    if (e < -10) return sign; // underflow → ±0
    mant |= 0x800000;
    const shift = 14 - e;
    return sign | (mant >>> shift);
  }
  return sign | (e << 10) | (mant >>> 13);
}

// ── prefilter ───────────────────────────────────────────────────────────────

export interface PrefilterEnvironmentOpts {
  size?: number;
  levels?: number;
}

export interface PrefilterEnvironmentResult {
  data: Uint16Array;
  size: number;
  levels: number;
  layers: number;
  bytesPerRow: number;
}

/**
 * Prefilter a lighting preset into octahedral GGX layers + an irradiance layer.
 */
export function prefilterEnvironment(preset: LightingPreset, opts: PrefilterEnvironmentOpts = {}): PrefilterEnvironmentResult {
  const size = opts.size ?? IBL_TEX_SIZE;
  const levels = opts.levels ?? IBL_SPEC_LEVELS;
  const layers = levels + 1;
  const texels = size * size;
  const data = new Uint16Array(texels * layers * 4);

  const dirs: EnvDirs = {
    keyDir: normalize3(preset.lighting.key.position),
    fillDir: normalize3(preset.lighting.fill.position),
    rimDir: normalize3(preset.lighting.rim.position)
  };

  const rgb = new Float64Array(3);
  const acc = new Float64Array(3);

  /** Cache one env evaluation per direction into `acc`. */
  const addEnv = (dir: Vec3, weight: number) => {
    envRadiance(dir, preset, dirs, rgb);
    acc[0] += rgb[0] * weight;
    acc[1] += rgb[1] * weight;
    acc[2] += rgb[2] * weight;
  };

  const writeTexel = (layer: number, texel: number, r: number, g: number, b: number) => {
    const o = (layer * texels + texel) * 4;
    data[o] = floatToHalf(r);
    data[o + 1] = floatToHalf(g);
    data[o + 2] = floatToHalf(b);
    data[o + 3] = 0x3c00; // 1.0
  };

  for (let level = 0; level < levels; level++) {
    const roughness = levels > 1 ? level / (levels - 1) : 0;
    const a = roughness * roughness;
    const sampleCount = SAMPLES_PER_LEVEL[level] ?? 32;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const texel = y * size + x;
        const N = octDecode((x + 0.5) / size, (y + 0.5) / size);

        if (sampleCount <= 1) {
          envRadiance(N, preset, dirs, rgb);
          writeTexel(level, texel, rgb[0], rgb[1], rgb[2]);
          continue;
        }

        // Split-sum approximation: V = R = N.
        const [T, B] = basisFrom(N);
        acc[0] = 0; acc[1] = 0; acc[2] = 0;
        let totalWeight = 0;

        for (let s = 0; s < sampleCount; s++) {
          const u1 = s / sampleCount;
          const u2 = radicalInverseVdC(s);
          const phi = TWO_PI * u1;
          const cosTheta = Math.sqrt((1 - u2) / (1 + (a * a - 1) * u2));
          const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));

          const hx = sinTheta * Math.cos(phi);
          const hy = sinTheta * Math.sin(phi);
          const H: Vec3 = [
            T[0] * hx + B[0] * hy + N[0] * cosTheta,
            T[1] * hx + B[1] * hy + N[1] * cosTheta,
            T[2] * hx + B[2] * hy + N[2] * cosTheta
          ];
          const NdotH = N[0] * H[0] + N[1] * H[1] + N[2] * H[2];
          const Lv = normalize3([
            2 * NdotH * H[0] - N[0],
            2 * NdotH * H[1] - N[1],
            2 * NdotH * H[2] - N[2]
          ]);
          const NdotL = N[0] * Lv[0] + N[1] * Lv[1] + N[2] * Lv[2];
          if (NdotL <= 0) continue;
          addEnv(Lv, NdotL);
          totalWeight += NdotL;
        }

        if (totalWeight > 0) {
          writeTexel(level, texel, acc[0] / totalWeight, acc[1] / totalWeight, acc[2] / totalWeight);
        } else {
          envRadiance(N, preset, dirs, rgb);
          writeTexel(level, texel, rgb[0], rgb[1], rgb[2]);
        }
      }
    }
  }

  // Irradiance layer — cosine-importance-sampled, stored as E/π so the shader
  // can multiply straight by albedo.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const texel = y * size + x;
      const N = octDecode((x + 0.5) / size, (y + 0.5) / size);
      const [T, B] = basisFrom(N);
      acc[0] = 0; acc[1] = 0; acc[2] = 0;

      for (let s = 0; s < IRRADIANCE_SAMPLES; s++) {
        const u1 = s / IRRADIANCE_SAMPLES;
        const u2 = radicalInverseVdC(s);
        const r = Math.sqrt(u1);
        const phi = TWO_PI * u2;
        const cx = r * Math.cos(phi);
        const cy = r * Math.sin(phi);
        const cz = Math.sqrt(Math.max(0, 1 - u1));
        const Lv = normalize3([
          T[0] * cx + B[0] * cy + N[0] * cz,
          T[1] * cx + B[1] * cy + N[1] * cz,
          T[2] * cx + B[2] * cy + N[2] * cz
        ]);
        addEnv(Lv, 1);
      }

      writeTexel(levels, texel,
        acc[0] / IRRADIANCE_SAMPLES,
        acc[1] / IRRADIANCE_SAMPLES,
        acc[2] / IRRADIANCE_SAMPLES);
    }
  }

  return { data, size, levels, layers, bytesPerRow: size * 8 };
}

// ── GPU plumbing ────────────────────────────────────────────────────────────

export interface IblResources {
  texture: GPUTexture;
  sampler: GPUSampler;
  view: GPUTextureView;
  size: number;
  layers: number;
  byteLength: number;
  /** True when the texture carries STORAGE_BINDING, i.e. the compute bake can target it. */
  storage: boolean;
}

export interface CreateIblResourcesOpts {
  size?: number;
  layers?: number;
  /** Request STORAGE_BINDING for the compute prefilter (default true). */
  storage?: boolean;
}

/**
 * Create the (always-on) IBL array texture + sampler.
 *
 * STORAGE_BINDING is requested so the compute prefilter can write the layers
 * in place. `rgba16float` is a core write-only storage format, but a device
 * that rejects the combination just loses the compute path — the texture is
 * recreated sampled-only and the CPU bake fills it via `writeTexture`.
 */
export function createIblResources(device: GPUDevice, opts: CreateIblResourcesOpts = {}): IblResources {
  const size = opts.size ?? IBL_TEX_SIZE;
  const layers = opts.layers ?? IBL_LAYERS;
  const wantStorage = opts.storage !== false;
  const sampledUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;

  let storage = wantStorage;
  let texture: GPUTexture;
  const describe = (usage: GPUTextureUsageFlags): GPUTextureDescriptor => ({
    label: 'ibl-specular-array',
    size: [size, size, layers],
    format: IBL_FORMAT,
    dimension: '2d',
    usage
  });
  try {
    texture = device.createTexture(
      describe(wantStorage ? sampledUsage | GPUTextureUsage.STORAGE_BINDING : sampledUsage)
    );
  } catch (e) {
    if (!wantStorage) throw e;
    console.warn('[ibl-prefilter] STORAGE_BINDING rejected — compute bake unavailable:', e);
    storage = false;
    texture = device.createTexture(describe(sampledUsage));
  }
  const sampler = device.createSampler({
    label: 'ibl-sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge'
  });
  return {
    texture,
    sampler,
    view: texture.createView({ dimension: '2d-array' }),
    size,
    layers,
    byteLength: size * size * layers * 8,
    storage
  };
}

/** Prefilter results are cached per look — switching presets is then free. */
const prefilterCache = new Map<string, PrefilterEnvironmentResult>();

export interface UploadIblResult {
  levels: number;
  cached: boolean;
  ms: number;
}

/**
 * Prefilter `preset` (memoised by `look`) and upload it into `resources.texture`.
 *
 * @param look preset id used as the cache key
 */
export function uploadIblForPreset(device: GPUDevice, resources: IblResources, preset: LightingPreset, look: string): UploadIblResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  let baked = prefilterCache.get(look);
  const cached = !!baked;
  if (!baked) {
    baked = prefilterEnvironment(preset, { size: resources.size, levels: IBL_SPEC_LEVELS });
    prefilterCache.set(look, baked);
  }

  device.queue.writeTexture(
    { texture: resources.texture },
    baked.data.buffer as ArrayBuffer,
    { bytesPerRow: baked.bytesPerRow, rowsPerImage: baked.size },
    [baked.size, baked.size, baked.layers]
  );

  const ms = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
  return { levels: IBL_SPEC_LEVELS, cached, ms };
}

/** Test hook — drop memoised bakes (used when presets are edited live). */
export function clearIblCache(): void {
  prefilterCache.clear();
}

/** Floats in one IblPrefilterParams block — see passes/ibl-prefilter-compute.wgsl. */
export const IBL_PREFILTER_PARAMS_FLOATS = 40;

/** Bytes of the IblPrefilterParams uniform block (10 × vec4f). */
export const IBL_PREFILTER_PARAMS_BYTES = IBL_PREFILTER_PARAMS_FLOATS * 4;

export interface IblPrefilterJob {
  /** Destination array layer. */
  layer: number;
  /** GGX roughness for this layer (ignored by the irradiance layer). */
  roughness: number;
  /** Importance-sample count. */
  samples: number;
  /** True for the cosine-convolved irradiance layer. */
  irradiance: boolean;
}

/**
 * The per-layer dispatch schedule, shared by both bake paths so the compute
 * and CPU results use identical sample counts.
 */
export function iblPrefilterJobs(levels = IBL_SPEC_LEVELS): IblPrefilterJob[] {
  const jobs: IblPrefilterJob[] = [];
  for (let level = 0; level < levels; level++) {
    jobs.push({
      layer: level,
      roughness: levels > 1 ? level / (levels - 1) : 0,
      samples: SAMPLES_PER_LEVEL[level] ?? 32,
      irradiance: false
    });
  }
  jobs.push({ layer: levels, roughness: 1, samples: IRRADIANCE_SAMPLES, irradiance: true });
  return jobs;
}

/**
 * Pack one dispatch's IblPrefilterParams block.
 *
 * Layout must match the struct in passes/ibl-prefilter-compute.wgsl; the float
 * count is asserted by `npm run check:post`. Light directions are normalised
 * here (the shader assumes unit vectors) exactly as the CPU bake does.
 */
export function packIblPrefilterParams(preset: LightingPreset, job: IblPrefilterJob): Float32Array {
  const out = new Float32Array(IBL_PREFILTER_PARAMS_FLOATS);
  const L = preset.lighting;
  const sky = preset.sky;

  const dir = (arm: { position: number[]; intensity: number }, at: number) => {
    const n = normalize3(arm.position);
    out[at] = n[0]; out[at + 1] = n[1]; out[at + 2] = n[2]; out[at + 3] = arm.intensity;
  };
  const rgb = (color: number[], at: number, w = 0) => {
    out[at] = color[0]; out[at + 1] = color[1]; out[at + 2] = color[2]; out[at + 3] = w;
  };

  dir(L.key, 0);
  dir(L.fill, 4);
  dir(L.rim, 8);
  rgb(L.key.color, 12);
  rgb(L.fill.color, 16);
  rgb(L.rim.color, 20);
  // ground.w carries the ground intensity (its direction is never sampled).
  rgb(L.ground.color, 24, L.ground.intensity);
  // skyTop.w doubles as the "preset has a sky block" flag, so the shader can
  // fold the dome term to zero without a branch.
  rgb(sky ? sky.top : [0, 0, 0], 28, sky ? 1 : 0);
  rgb(sky ? sky.horizon : [0, 0, 0], 32);

  out[36] = job.layer;
  out[37] = job.roughness;
  out[38] = job.samples;
  out[39] = job.irradiance ? 1 : 0;
  return out;
}

/**
 * Guard against the JS constants drifting from the WGSL ones in pbr-eval.wgsl.
 */
export function assertIblShaderContract(wgslSource: string): void {
  const sizeMatch = /const\s+IBL_TEX_SIZE\s*:\s*f32\s*=\s*([0-9.]+)/.exec(wgslSource);
  const levelMatch = /const\s+IBL_SPEC_LEVELS\s*:\s*f32\s*=\s*([0-9.]+)/.exec(wgslSource);
  if (!sizeMatch || !levelMatch) {
    throw new Error('[ibl-prefilter] pbr-eval.wgsl is missing IBL_TEX_SIZE / IBL_SPEC_LEVELS');
  }
  if (parseFloat(sizeMatch[1]) !== IBL_TEX_SIZE || parseFloat(levelMatch[1]) !== IBL_SPEC_LEVELS) {
    throw new Error(
      `[ibl-prefilter] WGSL/JS contract drift: shader has ${sizeMatch[1]}²×${levelMatch[1]}, ` +
      `JS has ${IBL_TEX_SIZE}²×${IBL_SPEC_LEVELS}`
    );
  }
}
