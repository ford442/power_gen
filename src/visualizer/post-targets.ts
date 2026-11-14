// Lazily allocated post-stack targets (#225 PR2). The frame graph
// (frame-graph.ts) calls ensure() the first frame an enabled pass touches one
// of these and release() once nothing has for a while, so the expensive ones
// only exist while a tier and view that uses them is active:
//
//   msaa     4× scene colour + G-buffer, 4× depth, resolved depth
//            (high tier + focus — ADR-0005 WS2)
//   ssr      half-resolution reflection target (high/ultra tier)
//   taa      TAA resolve target (high/ultra tier + focus)
//   history  previous frame (TAA history, motion blur)
//
// The always-on targets (scene colour, G-buffer, single-sample depth, bloom
// chain) stay in scene-post-buffers.ts. Bind groups that would sample a
// released target get a 1×1 placeholder instead (the composite binds SSR and
// history whether or not it weights them).
import { WebGPUManager, DEPTH_FORMAT } from '../webgpu-manager';
import { SSR_FORMAT, MATERIAL_GBUFFER_FORMAT } from '../pipeline-layout-cache';
import type { ResourceLifetime } from './frame-graph';
import type { MultiDeviceVisualizer } from '../multi-device-visualizer.js';

type Host = MultiDeviceVisualizer;

/** SSR runs at half resolution; the composite samples it with linear filtering. */
export const SSR_RESOLUTION_SCALE = 0.5;

export type PostTargetKind = 'msaa' | 'ssr' | 'taa' | 'history';

/** Profiler names per kind — also what getRendererInfo().gpuMemory lists. */
const TRACKED: Record<PostTargetKind, string[]> = {
  msaa: ['sceneMsaa', 'materialGBufferMsaa', 'depthMsaa', 'depthResolved'],
  ssr: ['ssrReflection'],
  taa: ['taaResolve'],
  history: ['prevScene']
};

/**
 * Every profiler-tracked texture of the post stack, lazy or not — what
 * `getRendererInfo().gpuMemory.postTargetBytes` sums.
 */
export const POST_TARGET_TEXTURE_NAMES: readonly string[] = [
  'depthBuffer', 'bloomScene', 'materialGBuffer', 'bloomChain', 'bloomBlur', 'bloomTemp',
  ...Object.values(TRACKED).flat()
];

/** Sum of the post-stack entries in a profiler `gpuMemoryEstimate().textures` map. */
export function postTargetBytes(textures: Record<string, number>): number {
  return POST_TARGET_TEXTURE_NAMES.reduce((sum, name) => sum + (textures[name] ?? 0), 0);
}

/**
 * `GPUTextureUsage.TRANSIENT_ATTACHMENT` where the implementation exposes it:
 * lets a tiler keep a clear-then-discard attachment in tile memory. Valid only
 * with RENDER_ATTACHMENT alone, which is exactly the MSAA colour pair.
 */
function transientUsage(): number {
  const flag = (GPUTextureUsage as unknown as { TRANSIENT_ATTACHMENT?: number }).TRANSIENT_ATTACHMENT;
  return typeof flag === 'number' ? flag : 0;
}

export const postTargetMethods: ThisType<Host> & {
  _postTargetAllocated(kind: PostTargetKind): boolean;
  _ensurePostTarget(kind: PostTargetKind): void;
  _destroyPostTarget(kind: PostTargetKind): void;
  _releasePostTarget(kind: PostTargetKind): void;
  /** Destroy every lazy target without rebinding (resize / device loss; callers rebind). */
  _destroyAllPostTargets(): void;
  _postTargetLifetimes(): Record<PostTargetKind, ResourceLifetime>;
  /** (Re)create the 1×1 stand-ins bind groups use for a released target. */
  _setupPostPlaceholders(): void;
  _rebindPostTargets(): void;
} = {
  _postTargetAllocated(kind) {
    switch (kind) {
      case 'msaa': return !!this.sceneMsaaTexture;
      case 'ssr': return !!this.ssrTexture;
      case 'taa': return !!this.taaResolveTexture;
      case 'history': return !!this.prevSceneTexture;
    }
  },

  _ensurePostTarget(kind) {
    if (this._postTargetAllocated(kind)) return;
    const { width: w, height: h } = WebGPUManager.canvasPixelSize(this.canvas);
    const sceneFormat = this.pipelineCache!.sceneFormat;
    const profiler = this.profiler;

    if (kind === 'msaa') {
      const depthFormat = this.depthFormat || this.webgpu.depthFormat || DEPTH_FORMAT;
      const transient = transientUsage();
      // Render-attachment only: both resolve into the single-sample scene
      // colour / G-buffer via `resolveTarget` and are stored with 'discard'.
      this.sceneMsaaTexture = this.device.createTexture({
        label: 'scene-color-msaa4',
        size: [w, h], format: sceneFormat, sampleCount: 4,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | transient
      });
      this.sceneMsaaView = this.sceneMsaaTexture.createView({ label: 'scene-color-msaa4' });
      this.materialGBufferMsaaTexture = this.device.createTexture({
        label: 'material-gbuffer-msaa4',
        size: [w, h], format: MATERIAL_GBUFFER_FORMAT, sampleCount: 4,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | transient
      });
      this.materialGBufferMsaaView = this.materialGBufferMsaaTexture.createView({ label: 'material-gbuffer-msaa4' });
      // WebGPU has no depth resolveTarget: depth-resolve.wgsl samples this
      // into depthResolvedTexture, which SSR / TAA / contact shadow then read.
      this.depthMsaaTexture = this.device.createTexture({
        label: 'scene-depth-msaa4',
        size: [w, h], format: depthFormat, sampleCount: 4,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
      });
      this.depthMsaaAttachmentView = this.depthMsaaTexture.createView({ label: 'scene-depth-msaa4' });
      this.depthMsaaSampleView = this.depthMsaaTexture.createView({ label: 'scene-depth-msaa4-sample', aspect: 'depth-only' });
      this.depthResolvedTexture = this.device.createTexture({
        label: 'scene-depth-resolved',
        size: [w, h], format: depthFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
      });
      this.depthResolvedAttachmentView = this.depthResolvedTexture.createView({ label: 'scene-depth-resolved' });
      this.depthResolvedSampleView = this.depthResolvedTexture.createView({ label: 'scene-depth-resolved-sample', aspect: 'depth-only' });
      profiler?.trackTexture('sceneMsaa', w, h, sceneFormat, 4);
      profiler?.trackTexture('materialGBufferMsaa', w, h, MATERIAL_GBUFFER_FORMAT, 4);
      profiler?.trackTexture('depthMsaa', w, h, depthFormat, 4);
      profiler?.trackTexture('depthResolved', w, h, depthFormat);
    } else if (kind === 'ssr') {
      const sw = Math.max(1, Math.floor(w * SSR_RESOLUTION_SCALE));
      const sh = Math.max(1, Math.floor(h * SSR_RESOLUTION_SCALE));
      this.ssrWidth = sw;
      this.ssrHeight = sh;
      this.ssrTexture = this.device.createTexture({
        label: 'ssr-reflection',
        size: [sw, sh], format: SSR_FORMAT,
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
      });
      this.ssrTextureView = this.ssrTexture.createView({ label: 'ssr-reflection' });
      profiler?.trackTexture('ssrReflection', sw, sh, SSR_FORMAT);
    } else if (kind === 'taa') {
      // COPY_SRC: the resolved frame becomes next frame's history.
      this.taaResolveTexture = this.device.createTexture({
        label: 'taa-resolve',
        size: [w, h], format: sceneFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC
      });
      this.taaResolveView = this.taaResolveTexture.createView({ label: 'taa-resolve' });
      profiler?.trackTexture('taaResolve', w, h, sceneFormat);
    } else {
      this.prevSceneTexture = this.device.createTexture({
        label: 'prev-scene',
        size: [w, h], format: sceneFormat,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      });
      profiler?.trackTexture('prevScene', w, h, sceneFormat);
      // Uninitialised: neither TAA nor motion blur may blend against it yet.
      this._taaHistoryValid = false;
      this._historyValid = false;
    }
    this._rebindPostTargets();
  },

  _destroyPostTarget(kind) {
    if (kind === 'msaa') {
      this.sceneMsaaTexture?.destroy();
      this.materialGBufferMsaaTexture?.destroy();
      this.depthMsaaTexture?.destroy();
      this.depthResolvedTexture?.destroy();
      this.sceneMsaaTexture = this.materialGBufferMsaaTexture = null;
      this.depthMsaaTexture = this.depthResolvedTexture = null;
      this.sceneMsaaView = this.materialGBufferMsaaView = null;
      this.depthMsaaAttachmentView = this.depthMsaaSampleView = null;
      this.depthResolvedAttachmentView = this.depthResolvedSampleView = null;
    } else if (kind === 'ssr') {
      this.ssrTexture?.destroy();
      this.ssrTexture = null;
      this.ssrTextureView = null;
    } else if (kind === 'taa') {
      this.taaResolveTexture?.destroy();
      this.taaResolveTexture = null;
      this.taaResolveView = null;
    } else {
      this.prevSceneTexture?.destroy();
      this.prevSceneTexture = null;
      this._taaHistoryValid = false;
      this._historyValid = false;
    }
    this.profiler?.untrackTextures(TRACKED[kind]);
  },

  _releasePostTarget(kind) {
    if (!this._postTargetAllocated(kind)) return;
    this._destroyPostTarget(kind);
    this._rebindPostTargets();
  },

  _destroyAllPostTargets() {
    for (const kind of Object.keys(TRACKED) as PostTargetKind[]) this._destroyPostTarget(kind);
  },

  _postTargetLifetimes() {
    const make = (kind: PostTargetKind): ResourceLifetime => ({
      name: kind,
      isAllocated: () => this._postTargetAllocated(kind),
      ensure: () => this._ensurePostTarget(kind),
      release: () => this._releasePostTarget(kind)
    });
    return { msaa: make('msaa'), ssr: make('ssr'), taa: make('taa'), history: make('history') };
  },

  _setupPostPlaceholders() {
    const cache = this.pipelineCache;
    if (!cache) return;
    this._postPlaceholderHistory?.destroy();
    this._postPlaceholderSsr?.destroy();
    this._postPlaceholderHistory = this.device.createTexture({
      label: 'placeholder-history',
      size: [1, 1], format: cache.sceneFormat,
      usage: GPUTextureUsage.TEXTURE_BINDING
    });
    this._postPlaceholderSsr = this.device.createTexture({
      label: 'placeholder-ssr',
      size: [1, 1], format: SSR_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING
    });
  },

  _rebindPostTargets() {
    this._rebuildDepthResolveBindGroup();
    this._rebuildBloomBindGroups();
    this._rebuildSsrBindGroup();
    this._rebuildTaaBindGroups();
  }
};
