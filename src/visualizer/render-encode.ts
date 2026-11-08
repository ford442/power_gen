// The WebGPU frame as a pass list (#225 PR2). Each pass declares what it
// reads and writes and when it is enabled; frame-graph.ts checks the order,
// allocates / releases the lazy post targets (post-targets.ts) and hands out
// per-pass timestamps. Pass bodies live in render-passes.ts, except TAA and
// SSR, whose parameter uploads stay here next to their gates.
//
//   compute → scene (1× | 4× MSAA) → depth-resolve → taa → ssr → bloom
//           → composite → history
//
// WebGL2 does not use the graph (ADR-0001).
import { getPostQualityGates } from '../post-processing-config';
import { writeQueueBuffer } from '../gpu-buffer-write';
import { SSR_PARAMS_BYTES, TAA_PARAMS_BYTES } from './scene-setup.js';
import { FrameGraph, type FrameGraphReport } from './frame-graph';
import {
  encodeBloom,
  encodeComposite,
  encodeCompute,
  encodeDepthResolve,
  encodeHistoryCopy,
  encodeScene,
  speedMotionBlur
} from './render-passes';
import type { MultiDeviceVisualizer } from '../multi-device-visualizer.js';
import type { DeviceInstance } from '../device-instance.js';
import type { PerformanceProfiler } from '../performance-profiler';

type Host = MultiDeviceVisualizer;

/** DeviceInstance plus optional plugin layout flags used by cull / budgets. */
export type RenderDevice = DeviceInstance & {
  config: DeviceInstance['config'] & { cullRadius?: number; plugin?: boolean };
};

/**
 * History weight for the TAA blend. 0.9 is the usual starting point: enough
 * accumulation to settle SSR and roller chrome within a few frames, low enough
 * that the neighbourhood clamp can still pull a disoccluded pixel back inside
 * one frame.
 */
const TAA_HISTORY_WEIGHT = 0.9;

/**
 * Frames a lazy target may go unused before it is destroyed. Long enough that
 * the auto-quality controller nudging a tier back and forth, or a quick
 * focus → overview → focus, does not reallocate; short enough that leaving
 * the showroom view frees the MSAA set within a couple of seconds.
 */
export const POST_TARGET_RELEASE_FRAMES = 120;

/** Per-frame inputs and gates. Passes may clear a gate when they bail. */
export interface FrameCtx {
  profiler: PerformanceProfiler;
  globalUniforms: GPUBuffer;
  gpuContext: GPUCanvasContext;
  cull: Host['overviewCull'];
  cullActive: boolean;
  isDeviceVisible: (device: RenderDevice) => boolean;
  fdtdSlice: ReturnType<Host['updateFdtdSlice']>;
  overview: boolean;
  postGates: ReturnType<typeof getPostQualityGates>;
  /** 4× MSAA scene: `high` tier + focus (`'ultra'` is never assigned by auto-quality). */
  msaa: boolean;
  taa: boolean;
  ssr: boolean;
  /** Which bloom encode runs, or null when gated off (the composite still tonemaps). */
  bloom: 'chain' | 'legacy' | null;
  composite: boolean;
  /** Motion blur is on this frame (gate and sim speed); the composite reads history. */
  motionBlur: boolean;
  /** Copy this frame into the history (TAA or motion blur needs it next frame). */
  history: boolean;
  /** Single-sample depth downstream passes read this frame. */
  depth: 'depth' | 'depthResolved';
}

/** Evaluate every gate once, before any pass encodes. */
function frameContext(
  host: Host,
  base: Pick<FrameCtx, 'profiler' | 'globalUniforms' | 'gpuContext' | 'cull' | 'cullActive'
    | 'isDeviceVisible' | 'fdtdSlice'>
): FrameCtx {
  const { profiler } = base;
  const overview = host.isOverviewMode();
  // Auto-quality post gates (ADR-0005) — critical skips bloom extract/blur.
  const postGates = getPostQualityGates(profiler.postQualityTier || 'high');
  host._postQualityGates = postGates;

  const msaa = profiler.qualityTier === 'high' && !overview
    && !!host.depthResolvePipeline && !!host.bloomSceneTexture;

  // TAA: high/ultra tier, focus only, `?taa=0` forces it off. Reprojects with
  // the camera's own matrices (no velocity buffer — see passes/taa-resolve.wgsl).
  const taa = !!postGates.taa && !overview && host.taaEnabled !== false
    && !!host.taaPipeline && !!host.taaParamsBuffer && !!host.cameraController
    && !!host.bloomSceneTexture && !!host.bloomSampler && !!host.depthSampleView;
  if (!taa) {
    // Whatever is in the history belongs to a frame the next TAA frame cannot
    // trust, so make the first frame back a reset.
    host._taaHistoryValid = false;
    host._taaPrevViewProj = null;
  }

  // SSR: high/ultra tier; `?ssr=0` forces it off.
  const ssr = host.ssrEnabled !== false && postGates.ssr > 0
    && !!host.ssrPipeline && !!host.ssrParamsBuffer && !!host.materialGBufferView
    && !!host.bloomSceneTexture && !!host.bloomSampler && !!host.depthSampleView;

  const chainReady = !!(host.bloomChain && host.bloomChainPipelines);
  const legacyReady = !!(host.bloomExtractPipeline && host.bloomBlurPipeline
    && host.bloomBlurTexture && host.bloomTempTexture);
  const composite = !!host.bloomCompositePipeline && (chainReady || legacyReady)
    && !!host.bloomSceneTexture && !!host.depthTexture;
  const bloom = composite && postGates.bloom > 0 ? (chainReady ? 'chain' : 'legacy') : null;

  // History: TAA always, motion blur only while it has a non-zero mix (high
  // sim speed). A frame that skips the copy leaves a stale history behind, so
  // the next blur frame waits one copy before blending (motionBlurAmount).
  const motionBlur = postGates.motionBlur > 0.01 && speedMotionBlur(host) > 0;
  const history = taa || motionBlur;
  if (!history) host._historyValid = false;

  return {
    ...base,
    overview,
    postGates,
    msaa,
    taa,
    ssr,
    bloom,
    composite,
    motionBlur,
    history,
    depth: msaa ? 'depthResolved' : 'depth'
  };
}

/** Build the pass list once per visualizer; lifetimes call back into the host. */
export function buildFrameGraph(host: Host): FrameGraph<FrameCtx> {
  const life = host._postTargetLifetimes();
  const graph = new FrameGraph<FrameCtx>({
    label: 'webgpu-frame',
    strict: !!import.meta.env?.DEV,
    releaseAfterFrames: POST_TARGET_RELEASE_FRAMES
  });
  const sceneOut = (ctx: FrameCtx) => (ctx.taa ? 'taaColor' : 'sceneColor');

  graph
    .addResource('simBuffers')
    .addResource('sceneColor')
    .addResource('gbuffer')
    .addResource('depth')
    .addResource('sceneColorMsaa', { lifetime: life.msaa })
    .addResource('gbufferMsaa', { lifetime: life.msaa })
    .addResource('depthMsaa', { lifetime: life.msaa })
    .addResource('depthResolved', { lifetime: life.msaa })
    .addResource('taaColor', { lifetime: life.taa })
    .addResource('ssrColor', { lifetime: life.ssr })
    // Last frame's image: valid at frame start, written at the end.
    .addResource('history', { imported: true, lifetime: life.history })
    .addResource('bloom')
    .addResource('canvas');

  graph.addPass('compute', {
    writes: ['simBuffers'],
    encode: (encoder, res, ctx) => encodeCompute(host, encoder, ctx, res)
  });
  graph.addPass('scene', {
    reads: ['simBuffers'],
    // MSAA resolves colour + G-buffer into the single-sample targets; depth
    // has no resolveTarget, so the plain depth is not written on those frames.
    writes: (ctx) => (ctx.msaa
      ? ['sceneColorMsaa', 'gbufferMsaa', 'depthMsaa', 'sceneColor', 'gbuffer']
      : ['sceneColor', 'gbuffer', 'depth']),
    encode: (encoder, res, ctx) => encodeScene(host, encoder, ctx, res)
  });
  graph.addPass('depth-resolve', {
    enabled: (ctx) => ctx.msaa,
    reads: ['depthMsaa'],
    writes: ['depthResolved'],
    encode: (encoder, res) => encodeDepthResolve(host, encoder, res)
  });
  // Before SSR and bloom, so everything downstream sees the stabilised image.
  graph.addPass('taa', {
    enabled: (ctx) => ctx.taa,
    reads: (ctx) => ['sceneColor', ctx.depth, 'history'],
    writes: ['taaColor'],
    encode: (encoder, res, ctx) => {
      ctx.taa = host._encodeTaaResolve(encoder, ctx.msaa, res.timestamps('both'));
      return ctx.taa;
    }
  });
  graph.addPass('ssr', {
    enabled: (ctx) => ctx.ssr,
    reads: (ctx) => ['sceneColor', 'gbuffer', ctx.depth],
    writes: ['ssrColor'],
    encode: (encoder, res, ctx) => {
      // The composite must not weight a reflection nothing wrote this frame.
      ctx.ssr = host._dispatchSsr(encoder, ctx.msaa, res.timestamps('both'));
      return ctx.ssr;
    }
  });
  graph.addPass('bloom', {
    enabled: (ctx) => ctx.bloom !== null,
    reads: (ctx) => [sceneOut(ctx)],
    writes: ['bloom'],
    encode: (encoder, res, ctx) => {
      const ok = encodeBloom(host, encoder, ctx, res);
      if (!ok) ctx.bloom = null;
      return ok;
    }
  });
  graph.addPass('composite', {
    enabled: (ctx) => ctx.composite,
    reads: (ctx) => [
      sceneOut(ctx),
      ctx.depth,
      ...(ctx.bloom ? ['bloom'] : []),
      ...(ctx.ssr ? ['ssrColor'] : []),
      ...(ctx.motionBlur ? ['history'] : [])
    ],
    writes: ['canvas'],
    encode: (encoder, res, ctx) => encodeComposite(host, encoder, ctx, res)
  });
  graph.addPass('history', {
    enabled: (ctx) => ctx.history,
    reads: (ctx) => [sceneOut(ctx)],
    writes: ['history'],
    encode: (encoder, _res, ctx) => encodeHistoryCopy(host, encoder, ctx)
  });
  return graph;
}

export const renderEncodeMethods: ThisType<Host> & {
  renderAnomalyWalls(
    renderPass: GPURenderPassEncoder,
    globalUniformBuffer: GPUBuffer | null,
    segDevice: DeviceInstance | null | undefined
  ): void;
  _dispatchSsr(encoder: GPUCommandEncoder, msaaActive: boolean,
    timestampWrites?: GPUComputePassTimestampWrites): boolean;
  _encodeTaaResolve(encoder: GPUCommandEncoder, msaaActive: boolean,
    timestampWrites?: GPURenderPassTimestampWrites): boolean;
  _encodeFrame(
    profiler: PerformanceProfiler,
    globalUniforms: GPUBuffer,
    gpuContext: GPUCanvasContext,
    cull: Host['overviewCull'],
    cullActive: boolean,
    isDeviceVisible: (device: RenderDevice) => boolean,
    fdtdSlice: ReturnType<Host['updateFdtdSlice']>
  ): void;
} = {
  renderAnomalyWalls(
    renderPass: GPURenderPassEncoder,
    _globalUniformBuffer: GPUBuffer | null,
    segDevice: DeviceInstance | null | undefined
  ) {
    if (!this.anomalyWallPipeline || !this.magneticWallBuffer || !segDevice) return;
    if (this.anomalousEffectsEnabled === false) return;
    if (!this.profiler || !this.anomalyWallParamsBuffer) return;

    const envelope = (segDevice as RenderDevice)._anomalyT || 0;
    if (envelope <= 0.001) return;

    const quality = this.profiler.qualityLevel;
    const shellCount = quality < 0.6 ? 3 : 5;

    // WallParams: intensity, shellCount, innerRadius, spacing, shellThickness, height
    this.device.queue.writeBuffer(
      this.anomalyWallParamsBuffer, 0,
      new Float32Array([envelope, shellCount, 1.6, 0.55, 0.06, 8.0])
    );

    const bindGroup = this.anomalyWallBindGroup;
    if (!bindGroup) return;
    renderPass.setPipeline(this.anomalyWallPipeline);
    renderPass.setBindGroup(0, bindGroup);
    renderPass.setVertexBuffer(0, this.magneticWallBuffer.vertexBuffer);
    renderPass.setIndexBuffer(this.magneticWallBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(this.magneticWallBuffer.indexCount, 1);
  },

  /**
   * Encode the temporal AA resolve pass (ADR-0005 WS2). The gate lives in
   * frameContext(); this only bails when its bind group or target is missing.
   *
   * @returns true if the pass was encoded, so the composite reads the resolve
   *   target instead of the raw scene.
   */
  _encodeTaaResolve(encoder, msaaActive, timestampWrites) {
    const bindGroup = msaaActive
      ? (this.taaBindGroupResolved || this.taaBindGroup)
      : this.taaBindGroup;
    if (!bindGroup || !this.taaResolveView || !this.taaPipeline || !this.taaParamsBuffer
        || !this.cameraController) {
      this._taaHistoryValid = false;
      return false;
    }

    const camera = this.cameraController;
    const viewProj = camera.getViewProjMatrix();
    const invViewProj = camera.invertMatrix(viewProj);
    const prevViewProj = this._taaPrevViewProj;
    // Without a previous matrix there is nothing to reproject from, whatever
    // the history texture happens to hold.
    const historyValid = this._taaHistoryValid === true && !!prevViewProj;

    const params = new Float32Array(TAA_PARAMS_BYTES / 4);
    params.set(invViewProj, 0);
    params.set(prevViewProj ?? viewProj, 16);
    params[32] = 1 / Math.max(this.canvas.width || 1, 1);   // texelSize
    params[33] = 1 / Math.max(this.canvas.height || 1, 1);
    params[34] = TAA_HISTORY_WEIGHT;                        // alpha
    params[35] = historyValid ? 1 : 0;
    writeQueueBuffer(this.device, this.taaParamsBuffer, params);

    const pass = encoder.beginRenderPass({
      label: 'taa-resolve-pass',
      colorAttachments: [{
        view: this.taaResolveView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear', storeOp: 'store'
      }],
      timestampWrites
    });
    pass.setPipeline(this.taaPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();

    // Cache this frame's matrix for the next reprojection. Copy it: the
    // camera hands back a fresh array today, but this must not depend on that.
    this._taaPrevViewProj = new Float32Array(viewProj);
    return true;
  },

  /**
   * Encode the SSR compute pass. View-space march parameters are in world
   * units; the camera's own projection is uploaded (plus its inverse) so the
   * shader unprojects depth exactly the way the scene pass projected it.
   */
  _dispatchSsr(encoder, msaaActive, timestampWrites) {
    // On an MSAA frame, bind the manually resolved depth (depth-resolve.wgsl
    // ran earlier this frame) instead of the regular single-sample depth —
    // see docs/LIGHTING_RIG.md / docs/BINDINGS.md.
    const bindGroup = msaaActive ? (this.ssrBindGroupResolved || this.ssrBindGroup) : this.ssrBindGroup;
    if (!this.cameraController || !this.ssrParamsBuffer || !this.ssrPipeline || !bindGroup) {
      return false;
    }
    const proj = this.cameraController.getProjMatrix();
    const invProj = this.cameraController.invertMatrix(proj);

    const params = new Float32Array(SSR_PARAMS_BYTES / 4);
    params.set(invProj, 0);
    params.set(proj, 16);
    params[32] = this.ssrWidth || 1;          // outSize
    params[33] = this.ssrHeight || 1;
    params[34] = this.canvas.width || 1;      // depthSize (full-res)
    params[35] = this.canvas.height || 1;
    params[36] = 48;                          // maxSteps
    params[37] = 0.14;                        // marchStride (view-space units)
    params[38] = 24.0;                        // maxDistance
    params[39] = 0.55;                        // thickness
    params[40] = 1.0;                         // strength (gate applied on the composite)
    params[41] = 0.12;                        // edgeFade
    params[42] = 0.85;                        // jitter
    this.device.queue.writeBuffer(this.ssrParamsBuffer, 0, params);

    const pass = encoder.beginComputePass({ label: 'ssr', timestampWrites });
    pass.setPipeline(this.ssrPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(
      Math.ceil((this.ssrWidth || 1) / 8),
      Math.ceil((this.ssrHeight || 1) / 8)
    );
    pass.end();
    return true;
  },

  /** One frame: settle gates, run the graph, submit, schedule the timestamp readback. */
  _encodeFrame(profiler, globalUniforms, gpuContext, cull, cullActive, isDeviceVisible, fdtdSlice) {
    const ctx = frameContext(this, {
      profiler, globalUniforms, gpuContext, cull, cullActive, isDeviceVisible, fdtdSlice
    });
    const graph = (this._frameGraph ??= buildFrameGraph(this));
    const encoder = this.device.createCommandEncoder({ label: 'frame' });
    const report: FrameGraphReport = graph.execute(encoder, ctx, profiler.gpuTimestampTarget());
    this._frameGraphReport = report;

    // What actually ran — passes clear their gate when they bail.
    profiler.msaaActive = ctx.msaa;
    profiler.taaActive = ctx.taa;
    this._taaActive = ctx.taa;
    this._ssrActive = ctx.ssr;

    profiler.endFrameCpu();
    this.device.queue.submit([encoder.finish({ label: 'frame' })]);

    // Resolve timestamps asynchronously (guarded against overlapping map/submit)
    if (profiler.timingEnabled) {
      profiler.scheduleResolveTimestamps(report.timedPasses, report.queriesUsed);
    }

    requestAnimationFrame((t) => this.render(t));
  }
};
