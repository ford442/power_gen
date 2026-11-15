/**
 * One key-light shadow map for the focus view (#225 §4).
 *
 * - 2048² `depth32float`, allocated by the frame graph the first frame the
 *   `shadow` pass is enabled (high tier + focus view) and released 120 unused
 *   frames later, like the other lazy post targets.
 * - Orthographic from the preset key light: pbr-eval.wgsl treats the key as
 *   directional (`normalize(key.position)`), so the map is fitted to a sphere
 *   around the focused bench along that direction.
 * - Casters reuse the scene's own vertex shaders. The shadow pass binds a
 *   second frame group whose `Uniforms.viewProj` is the light's matrix, so a
 *   roller / plate / CAD prop lands in light space with no shader variant —
 *   only depth-only pipelines (pipeline-tiers.ts).
 * - Receivers sample it through the frame group (bindings 9–11) with 3×3 PCF
 *   (common/shadow-pcf.wgsl). On frames the pass did not run, the uniform's
 *   `enabled` is 0 and the scene frame group binds a 1×1 placeholder.
 *
 * WebGL2 has no shadow map (listed in its intentionalGaps).
 */
import type { ResourceLifetime } from './frame-graph';
import type { MultiDeviceVisualizer } from '../multi-device-visualizer.js';
import type { RenderDevice } from './render-encode';

type Host = MultiDeviceVisualizer;

export const SHADOW_MAP_SIZE = 2048;
export const SHADOW_FORMAT: GPUTextureFormat = 'depth32float';
/** ShadowUniforms — common/shadow-pcf.wgsl (mat4 + 2 × vec4). */
export const SHADOW_UNIFORM_FLOATS = 24;
/** Receiver depth bias in light NDC (the caster pipelines add a slope bias). */
const RECEIVER_BIAS = 0.0006;
/** Normal offset in shadow texels (scaled by 0.25 + (1 − N·L) in the shader). */
const NORMAL_OFFSET_TEXELS = 1.5;
/** Uniforms block the caster vertex shaders read — the scene's global uniform size. */
const CASTER_UNIFORM_BYTES = 512;

/** Depth-only caster pipeline state: front faces, slope-scaled raster bias. */
export const SHADOW_CASTER_DEPTH: GPUDepthStencilState = {
  format: SHADOW_FORMAT,
  depthWriteEnabled: true,
  depthCompare: 'less',
  depthBias: 0,
  depthBiasSlopeScale: 1.75
};

export interface ShadowFit {
  /** Unit vector towards the key light. */
  toLight: readonly number[];
  target: readonly number[];
  radius: number;
}

/**
 * Column-major world → light clip matrix for an orthographic key light
 * looking at `target`, covering a sphere of `radius`. Clip z is WebGPU's
 * [0, 1]. Pure math so scripts/tests/uniform-ring.test.mjs can check it.
 */
export function fitKeyLightMatrix(fit: ShadowFit, out: Float32Array = new Float32Array(16)): Float32Array {
  const [lx, ly, lz] = fit.toLight;
  const r = Math.max(0.5, fit.radius);
  const dist = 3 * r;
  const eye = [fit.target[0] + lx * dist, fit.target[1] + ly * dist, fit.target[2] + lz * dist];
  // View basis (right-handed, looking down −z): z points from target to eye.
  const zx = lx, zy = ly, zz = lz;
  // `up` = world Y unless the light is (nearly) overhead, then world Z.
  // x = normalize(up × z), y = z × x — the same basis as MultiDeviceCamera.lookAt.
  const overhead = Math.abs(ly) > 0.99;
  const upY = overhead ? 0 : 1;
  const upZ = overhead ? 1 : 0;
  let xx = upY * zz - upZ * zy, xy = upZ * zx, xz = -upY * zx;
  const xl = Math.hypot(xx, xy, xz) || 1;
  xx /= xl; xy /= xl; xz /= xl;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  const tx = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  const ty = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  const tz = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  // Ortho: x, y ∈ [−r, r]; view depth ∈ [near, far] → [0, 1].
  const near = Math.max(0.05, dist - 2.5 * r);
  const far = dist + 1.5 * r;
  const sx = 1 / r;
  const sz = -1 / (far - near);
  const oz = -near / (far - near);
  // out = ortho * view, written directly (ortho is diagonal + z offset).
  out[0] = sx * xx; out[1] = sx * yx; out[2] = sz * zx; out[3] = 0;
  out[4] = sx * xy; out[5] = sx * yy; out[6] = sz * zy; out[7] = 0;
  out[8] = sx * xz; out[9] = sx * yz; out[10] = sz * zz; out[11] = 0;
  out[12] = sx * tx; out[13] = sx * ty; out[14] = sz * tz + oz; out[15] = 1;
  return out;
}

export class ShadowMap {
  texture: GPUTexture | null = null;
  attachmentView: GPUTextureView | null = null;
  private sampleViewReal: GPUTextureView | null = null;
  readonly placeholder: GPUTexture;
  private readonly placeholderView: GPUTextureView;
  readonly sampler: GPUSampler;
  /** ShadowUniforms (frame group binding 11). */
  readonly uniformBuffer: GPUBuffer;
  /** `Uniforms` for caster vertex shaders: viewProj = light matrix (shadow frame group binding 0). */
  readonly casterUniformBuffer: GPUBuffer;
  readonly lightViewProj = new Float32Array(16);
  private readonly uniforms = new Float32Array(SHADOW_UNIFORM_FLOATS);
  private readonly caster = new Float32Array(24);
  /** Whether the last uploaded uniforms had the shadow enabled. */
  enabled = false;

  constructor(private readonly host: Host) {
    const device = host.device;
    this.placeholder = device.createTexture({
      label: 'shadow-map-placeholder',
      size: [1, 1], format: SHADOW_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING
    });
    this.placeholderView = this.placeholder.createView({ label: 'shadow-map-placeholder' });
    this.sampler = device.createSampler({
      label: 'shadow-compare',
      compare: 'less-equal',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge'
    });
    this.uniformBuffer = device.createBuffer({
      label: 'shadow-uniforms',
      size: SHADOW_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.casterUniformBuffer = device.createBuffer({
      label: 'shadow-caster-uniforms',
      size: CASTER_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
  }

  isAllocated(): boolean {
    return !!this.texture;
  }

  /** What the scene frame group binds at 9: the map, or the placeholder while released. */
  sampleView(): GPUTextureView {
    return this.sampleViewReal ?? this.placeholderView;
  }

  /** The shadow pass's own frame group never samples the map it is writing. */
  placeholderSampleView(): GPUTextureView {
    return this.placeholderView;
  }

  lifetime(): ResourceLifetime {
    return {
      name: 'shadow',
      isAllocated: () => this.isAllocated(),
      ensure: () => this.allocate(),
      release: () => this.release()
    };
  }

  private allocate(): void {
    if (this.texture) return;
    this.texture = this.host.device.createTexture({
      label: 'shadow-map',
      size: [SHADOW_MAP_SIZE, SHADOW_MAP_SIZE],
      format: SHADOW_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    this.attachmentView = this.texture.createView({ label: 'shadow-map' });
    this.sampleViewReal = this.texture.createView({ label: 'shadow-map-sample', aspect: 'depth-only' });
    this.host.profiler?.trackTexture('shadowMap', SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, SHADOW_FORMAT);
    this.host.frameBindings?.invalidate();
  }

  release(): void {
    if (!this.texture) return;
    this.texture.destroy();
    this.texture = null;
    this.attachmentView = null;
    this.sampleViewReal = null;
    this.host.profiler?.untrackTextures(['shadowMap']);
    this.host.frameBindings?.invalidate();
  }

  /** Bounds the focused bench's casters sit in. */
  fitFor(device: RenderDevice): ShadowFit {
    const key = this.host.lightingConfig.key.position;
    const len = Math.hypot(key[0], key[1], key[2]) || 1;
    const pos = device.position ?? [0, 0, 0];
    let radius: number;
    if (device.id === 'seg') {
      const layout = this.host.segLayout;
      const rings = layout?.rings;
      const outer = ((rings && rings[rings.length - 1]?.orbitRadiusM) ?? 5.5) * (layout?.worldScale ?? 1);
      radius = outer + 3.0; // stand, bench and frame members outside the ring
    } else {
      const off = (device.config as { cameraOffset?: number[] }).cameraOffset ?? [0, 4, 12];
      radius = Math.min(12, Math.max(3, Math.hypot(off[0], off[1], off[2]) * 0.6));
    }
    return { toLight: [key[0] / len, key[1] / len, key[2] / len], target: [pos[0], pos[1] + 1, pos[2]], radius };
  }

  /**
   * Upload this frame's light matrix and the receivers' switch. Called once
   * per frame after the graph ran, so `enabled` is whether the pass actually
   * encoded (writeBuffer still lands before the submit).
   */
  upload(enabled: boolean, fit: ShadowFit | null): void {
    this.enabled = enabled && !!fit;
    const u = this.uniforms;
    if (this.enabled && fit) {
      fitKeyLightMatrix(fit, this.lightViewProj);
      u.set(this.lightViewProj, 0);
      const texelWorld = (2 * fit.radius) / SHADOW_MAP_SIZE;
      u[16] = 1;
      u[17] = 1 / SHADOW_MAP_SIZE;
      u[18] = RECEIVER_BIAS;
      u[19] = Math.min(1, Math.max(0, this.host.lightingConfig.shadowStrength ?? 1));
      u[20] = texelWorld * NORMAL_OFFSET_TEXELS;
      const c = this.caster;
      c.set(this.lightViewProj, 0);
      c[16] = this.host.time ?? 0;
      c[20] = fit.target[0] + fit.toLight[0] * 1e3;
      c[21] = fit.target[1] + fit.toLight[1] * 1e3;
      c[22] = fit.target[2] + fit.toLight[2] * 1e3;
      this.host.device.queue.writeBuffer(this.casterUniformBuffer, 0, c);
    } else {
      u[16] = 0;
    }
    this.host.device.queue.writeBuffer(this.uniformBuffer, 0, u);
  }

  destroy(): void {
    this.texture?.destroy();
    this.texture = null;
    this.attachmentView = null;
    this.sampleViewReal = null;
    this.placeholder.destroy();
    this.uniformBuffer.destroy();
    this.casterUniformBuffer.destroy();
  }
}
