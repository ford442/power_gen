/**
 * Render bundles for scene geometry that does not move inside a frame
 * (#225 §3): the sky + floor grid, the SEG frame / stand / CAD housing, and
 * each bench's resident CAD props. Particles, rollers and the FDTD panel stay
 * immediate — their instance counts and buffers change frame to frame.
 *
 * A bundle is re-recorded when anything it captured changes identity: the
 * pipeline variant (1× / 4× MSAA), the frame group (shadow map allocated or
 * released), geometry buffers (layout preset, glTF load), frame level, or the
 * view. Contents of those buffers — the uniform ring's per-part slots, the
 * lighting rig, the SEG layout uniform — change freely without a re-record;
 * that is why the ring's slots are stable.
 *
 * `executeBundles` resets the pass's pipeline and bind groups, so every
 * bundle binds the frame group itself and the pass rebinds it afterwards.
 */
import { MATERIAL_GBUFFER_FORMAT } from '../pipeline-layout-cache';
import type { DeviceInstanceLike, RenderEncoder } from '../devices/types';
import type { MultiDeviceVisualizer } from '../multi-device-visualizer.js';

type Host = MultiDeviceVisualizer;

/** Attachment shape of the scene pass a bundle will replay in. */
export interface ScenePassShape {
  msaa: boolean;
  gbuffer: boolean;
}

interface Entry {
  bundle: GPURenderBundle;
  deps: unknown[];
  draws: number;
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class StaticBundles {
  private readonly entries = new Map<string, Entry>();
  /** Shape of the scene pass being encoded; set by encodeScene, cleared after it. */
  shape: ScenePassShape | null = null;
  /** Bundles recorded / replayed since boot (getRendererInfo().renderBundles). */
  records = 0;
  replays = 0;

  constructor(private readonly host: Host) {}

  clear(): void {
    this.entries.clear();
  }

  /** Bundle names currently cached (getRendererInfo). */
  names(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Replay `name`, recording it first if `deps` changed. Returns false when
   * the pass shape or frame group is not known yet — the caller draws
   * immediately instead.
   */
  replay(
    pass: GPURenderPassEncoder,
    name: string,
    deps: unknown[],
    record: (encoder: GPURenderBundleEncoder) => void
  ): boolean {
    const frame = this.host.frameBindings?.sceneGroup();
    const shape = this.shape;
    if (!frame || !shape || !this.host.pipelineCache) return false;
    deps.push(frame, shape.msaa, shape.gbuffer);

    let entry = this.entries.get(name);
    if (!entry || !sameDeps(entry.deps, deps)) {
      entry = this.recordBundle(name, deps, frame, shape, record);
      this.entries.set(name, entry);
    }
    pass.executeBundles([entry.bundle]);
    pass.setBindGroup(0, frame);
    this.host.profiler?.recordDraw?.(entry.draws);
    this.replays++;
    return true;
  }

  private recordBundle(
    name: string,
    deps: unknown[],
    frame: GPUBindGroup,
    shape: ScenePassShape,
    record: (encoder: GPURenderBundleEncoder) => void
  ): Entry {
    const cache = this.host.pipelineCache!;
    const colorFormats: GPUTextureFormat[] = shape.gbuffer
      ? [cache.sceneFormat, MATERIAL_GBUFFER_FORMAT]
      : [cache.sceneFormat];
    const encoder = this.host.device.createRenderBundleEncoder({
      label: `bundle:${name}`,
      colorFormats,
      depthStencilFormat: cache.depthFormat,
      sampleCount: shape.msaa ? 4 : 1
    });
    encoder.setBindGroup(0, frame);
    // Draws inside a bundle are counted once per replay, not at record time.
    const profiler = this.host.profiler;
    let draws = 0;
    const realRecord = profiler?.recordDraw;
    if (profiler && realRecord) profiler.recordDraw = (n = 1) => { draws += Math.max(0, n | 0); };
    try {
      record(encoder);
    } finally {
      if (profiler && realRecord) profiler.recordDraw = realRecord;
    }
    this.records++;
    return { bundle: encoder.finish({ label: `bundle:${name}` }), deps, draws };
  }

  /**
   * Static geometry of one bench: SEG's CAD housing + frame / stand, or a
   * non-SEG bench's CAD props. Returns false (draw immediately) when there is
   * nothing to bundle or the pass shape is unknown.
   */
  drawDeviceStatic(pass: GPURenderPassEncoder, device: DeviceInstanceLike): boolean {
    const v = this.host;
    const isSeg = device.id === 'seg';
    const pipeline = device.segEnhancedPipeline;
    if (!pipeline) return false;
    const drawables = v.gltfHousingEnabled ? v.gltfHousingDrawables : null;
    const deps: unknown[] = [
      pipeline, v.uniformRing?.buffer, v.currentView, v.gltfHousingEnabled,
      drawables, drawables?.length ?? 0
    ];
    if (isSeg) {
      deps.push(
        v.segFrameLevel, v.segFrameBuffers, v.standBuffer,
        v.frameStructuralInstanceBuffer, v.frameLabBenchInstanceBuffer,
        v.frameControlInstanceBuffer, v.frameCageInstanceBuffer
      );
    }
    return this.replay(pass, `static:${device.id}`, deps, (enc: RenderEncoder) => {
      if (isSeg) {
        device.renderGltfHousing(enc);
        device.renderFrame(enc);
      } else {
        device.renderGltfDeviceProps(enc);
      }
    });
  }
}
