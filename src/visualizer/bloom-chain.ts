// Mip-chain bloom (linear colour pipeline, #223): one half-resolution texture
// with up to BLOOM_CHAIN_MAX_LEVELS mips, a 13-tap prefilter/downsample walk
// and a tent upsample walk back up — see passes/bloom-downsample.wgsl and
// passes/bloom-upsample.wgsl. Replaces the legacy full-resolution
// extract → blurX → blurY on the linear path; `?color=legacy` keeps that one.
//
// Owns its texture, per-level views, level-uniform buffer and bind groups.
// Pipelines live in the PipelineLayoutCache (ensureBloomPipelines).
import type { PipelineLayoutCache } from '../pipeline-layout-cache';

export const BLOOM_CHAIN_MAX_LEVELS = 6;

/** Smallest mip edge worth blurring; below this the tent mostly samples clamp. */
const BLOOM_CHAIN_MIN_EDGE = 4;

/** Floats in the BloomLevel uniform — see common/bloom-level.wgsl. */
export const BLOOM_LEVEL_FLOATS = 8;

/** One level's uniform slot; static bind-group offsets must honour minUniformBufferOffsetAlignment (256). */
export const BLOOM_LEVEL_STRIDE = 256;

export interface MipSize {
  width: number;
  height: number;
}

/** Mip sizes for a `width` × `height` scene: mip 0 is half resolution. */
export function bloomChainSizes(width: number, height: number): MipSize[] {
  const w0 = Math.max(1, Math.floor(width / 2));
  const h0 = Math.max(1, Math.floor(height / 2));
  const sizes: MipSize[] = [{ width: w0, height: h0 }];
  while (sizes.length < BLOOM_CHAIN_MAX_LEVELS) {
    const i = sizes.length;
    const w = Math.max(1, w0 >> i);
    const h = Math.max(1, h0 >> i);
    if (Math.min(w, h) < BLOOM_CHAIN_MIN_EDGE) break;
    sizes.push({ width: w, height: h });
  }
  return sizes;
}

/** Pack one BloomLevel block: source / destination texel sizes + tent radius. */
export function packBloomLevel(src: MipSize, dst: MipSize, upRadius = 1): Float32Array {
  const out = new Float32Array(BLOOM_LEVEL_FLOATS);
  out[0] = 1 / src.width;
  out[1] = 1 / src.height;
  out[2] = 1 / dst.width;
  out[3] = 1 / dst.height;
  out[4] = upRadius;
  return out;
}

export interface BloomChainPipelines {
  prefilter: GPURenderPipeline;
  downsample: GPURenderPipeline;
  upsample: GPURenderPipeline;
}

export class BloomChain {
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  texture: GPUTexture | null = null;
  sizes: MipSize[] = [];
  /** Single-mip views, one per level — attachments and sources alike. */
  private mipViews: GPUTextureView[] = [];
  private levelBuffer: GPUBuffer | null = null;
  private sceneSize: MipSize = { width: 1, height: 1 };
  private prefilterGroup: GPUBindGroup | null = null;
  private prefilterGroupTaa: GPUBindGroup | null = null;
  private downGroups: GPUBindGroup[] = [];
  private upGroups: GPUBindGroup[] = [];

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  get levels(): number {
    return this.sizes.length;
  }

  /** Mip 0 after the up walk: the sum of every level. The composite samples this. */
  get outputView(): GPUTextureView | null {
    return this.mipViews[0] ?? null;
  }

  /** Total bytes across every mip, for the profiler's texture tally. */
  get byteSize(): number {
    const bpp = this.format === 'rgba16float' ? 8 : 4;
    return this.sizes.reduce((sum, s) => sum + s.width * s.height * bpp, 0);
  }

  /** (Re)allocate for a `width` × `height` scene and upload the level uniforms. */
  resize(width: number, height: number): void {
    this.destroy();
    this.sceneSize = { width, height };
    this.sizes = bloomChainSizes(width, height);
    this.texture = this.device.createTexture({
      label: 'bloom-chain',
      size: [this.sizes[0].width, this.sizes[0].height],
      format: this.format,
      mipLevelCount: this.sizes.length,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    this.mipViews = this.sizes.map((_, i) => this.texture!.createView({
      label: `bloom-chain-mip${i}`,
      baseMipLevel: i,
      mipLevelCount: 1
    }));

    // Slots: 0 prefilter, 1..N-1 downsample into mip i, N..2N-2 upsample into mip N-2-k.
    const n = this.sizes.length;
    const slots = Math.max(1, 2 * n - 1);
    this.levelBuffer = this.device.createBuffer({
      label: 'bloom-chain-levels',
      size: slots * BLOOM_LEVEL_STRIDE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    const data = new Float32Array(slots * BLOOM_LEVEL_STRIDE / 4);
    const put = (slot: number, src: MipSize, dst: MipSize) =>
      data.set(packBloomLevel(src, dst), slot * BLOOM_LEVEL_STRIDE / 4);
    put(0, this.sceneSize, this.sizes[0]);
    for (let i = 1; i < n; i++) put(i, this.sizes[i - 1], this.sizes[i]);
    for (let k = 0; k < n - 1; k++) {
      const dst = n - 2 - k;
      put(n + k, this.sizes[dst + 1], this.sizes[dst]);
    }
    this.device.queue.writeBuffer(this.levelBuffer, 0, data);
  }

  /** Bind groups depend on the scene / TAA views and the post params, so rebuild after either resizes. */
  rebuildBindGroups(cache: PipelineLayoutCache, opts: {
    sampler: GPUSampler;
    paramsBuffer: GPUBuffer;
    sceneView: GPUTextureView;
    taaView: GPUTextureView | null;
  }): void {
    if (!this.levelBuffer || !this.mipViews.length) return;
    const level = (slot: number): GPUBindGroupEntry => ({
      binding: 3,
      resource: { buffer: this.levelBuffer!, offset: slot * BLOOM_LEVEL_STRIDE, size: BLOOM_LEVEL_FLOATS * 4 }
    });
    const group = (src: GPUTextureView, slot: number, label: string) =>
      cache.createBindGroup('bloomMip', [
        { binding: 0, resource: src },
        { binding: 1, resource: opts.sampler },
        { binding: 2, resource: { buffer: opts.paramsBuffer } },
        level(slot)
      ], label);

    const n = this.sizes.length;
    this.prefilterGroup = group(opts.sceneView, 0, 'bloom-prefilter-bg');
    this.prefilterGroupTaa = opts.taaView ? group(opts.taaView, 0, 'bloom-prefilter-bg-taa') : null;
    this.downGroups = [];
    for (let i = 1; i < n; i++) this.downGroups.push(group(this.mipViews[i - 1], i, `bloom-down${i}-bg`));
    this.upGroups = [];
    for (let k = 0; k < n - 1; k++) {
      const dst = n - 2 - k;
      this.upGroups.push(group(this.mipViews[dst + 1], n + k, `bloom-up${dst}-bg`));
    }
  }

  /**
   * Encode the whole chain: prefilter, downsample to the smallest mip, then
   * upsample (additive) back to mip 0. `taa` picks the TAA-resolved scene as
   * the prefilter source, mirroring the composite's bind-group choice.
   */
  encode(encoder: GPUCommandEncoder, pipelines: BloomChainPipelines, taa: boolean): void {
    const source = taa ? (this.prefilterGroupTaa ?? this.prefilterGroup) : this.prefilterGroup;
    if (!source || !this.mipViews.length) return;
    const pass = (label: string, view: GPUTextureView, load: GPULoadOp,
      pipeline: GPURenderPipeline, bindGroup: GPUBindGroup) => {
      const p = encoder.beginRenderPass({
        label,
        colorAttachments: [{
          view,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: load,
          storeOp: 'store'
        }]
      });
      p.setPipeline(pipeline);
      p.setBindGroup(0, bindGroup);
      p.draw(3);
      p.end();
    };

    const n = this.sizes.length;
    pass('bloom-prefilter', this.mipViews[0], 'clear', pipelines.prefilter, source);
    for (let i = 1; i < n; i++) {
      pass(`bloom-down${i}`, this.mipViews[i], 'clear', pipelines.downsample, this.downGroups[i - 1]);
    }
    for (let k = 0; k < n - 1; k++) {
      const dst = n - 2 - k;
      pass(`bloom-up${dst}`, this.mipViews[dst], 'load', pipelines.upsample, this.upGroups[k]);
    }
  }

  destroy(): void {
    this.texture?.destroy();
    this.levelBuffer?.destroy();
    this.texture = null;
    this.levelBuffer = null;
    this.mipViews = [];
    this.prefilterGroup = null;
    this.prefilterGroupTaa = null;
    this.downGroups = [];
    this.upGroups = [];
  }
}
