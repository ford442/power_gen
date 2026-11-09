// Pass bodies for the WebGPU frame graph (#225 PR2): compute, scene, depth
// resolve, bloom, composite, history copy. Moved out of render-encode.ts,
// which is now the pass list (reads / writes / gates) that orders these.
// Each body records exactly the GPU work the hand-ordered encoder did; the
// gating that used to sit around them lives in render-encode.ts frameContext().
import { WebGPUManager } from '../webgpu-manager';
import { MAX_ROLLERS } from '../seg-layout';
import { packPostUniforms } from '../seg-lighting-presets';
import { writeQueueBuffer } from '../gpu-buffer-write';
import { postOutputTransfer } from '../webgpu-init/color-pipeline';
import type { PassResources } from './frame-graph';
import type { FrameCtx, RenderDevice } from './render-encode';
import type { MultiDeviceVisualizer } from '../multi-device-visualizer.js';

type Host = MultiDeviceVisualizer;

const CLEAR_BLACK: GPUColor = { r: 0, g: 0, b: 0, a: 1 };

/**
 * G-buffer clear: metallic = 0, roughness = 1 ("non-metal, fully rough"), so
 * every pipeline that masks its second target (MATERIAL_GBUFFER_NO_WRITE —
 * all but seg-enhanced / roller) reads back as non-reflective.
 */
const GBUFFER_CLEAR: GPUColor = { r: 0.0, g: 1.0, b: 0.0, a: 0.0 };

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Particle / roller / flux / FDTD / energy-pipe compute, plus the overview cull. */
export function encodeCompute(host: Host, encoder: GPUCommandEncoder, ctx: FrameCtx, res: PassResources): void {
  const { profiler, isDeviceVisible } = ctx;
  const pass = encoder.beginComputePass({ label: 'particle-compute', timestampWrites: res.timestamps('both') });

  // Overview frustum cull → draw-indirect. Runs first: the scene pass draws
  // from the args this dispatch writes.
  if (ctx.cullActive) ctx.cull!.dispatch(pass);

  // SEG roller kinematics + RK4 flux line tracing, before the scene reads them.
  const segDevice = host.devices['seg'] as RenderDevice | undefined;
  if (segDevice && isDeviceVisible(segDevice)) {
    if (segDevice.rollerComputePipeline && segDevice.rollerComputeBindGroup) {
      pass.setPipeline(segDevice.rollerComputePipeline);
      pass.setBindGroup(0, segDevice.rollerComputeBindGroup);
      pass.dispatchWorkgroups(Math.ceil(MAX_ROLLERS / 64));
    }
    // One thread per flux line (up to 168).
    if (segDevice.fluxTracerPipeline && segDevice.fluxTracerBindGroup && profiler.qualityLevel > 0.32) {
      pass.setPipeline(segDevice.fluxTracerPipeline);
      pass.setBindGroup(0, segDevice.fluxTracerBindGroup);
      pass.dispatchWorkgroups(Math.ceil((host.segLayout?.totalFluxLines ?? 168) / 64));
    }
  }

  const xfmr = host.devices['transformer'] as RenderDevice | undefined;
  if (xfmr && isDeviceVisible(xfmr) && xfmr.transformerFluxPipeline && xfmr.transformerFluxBindGroup
      && profiler.qualityLevel > 0.28) {
    pass.setPipeline(xfmr.transformerFluxPipeline);
    pass.setBindGroup(0, xfmr.transformerFluxBindGroup);
    pass.dispatchWorkgroups(Math.ceil((xfmr.transformerFluxLineCount || 24) / 64));
  }

  ctx.fdtdSlice?.dispatch(pass);

  for (const device of Object.values(host.devices) as RenderDevice[]) {
    if (!isDeviceVisible(device) || !device.computePipeline || !device.computeBindGroup) continue;
    pass.setPipeline(device.computePipeline);
    pass.setBindGroup(0, device.computeBindGroup);
    pass.dispatchWorkgroups(Math.ceil((device.scaledParticleCount || device.particleCount) / 64));
  }

  if (ctx.overview && host.energyPipeComputePipeline) {
    for (const pipe of host.energyPipes) pipe.dispatchCompute(pass);
  }
  pass.end();
}

/** Sky, grid, devices, FDTD panel, anomaly walls, energy pipes — 1× or 4× MSAA. */
export function encodeScene(host: Host, encoder: GPUCommandEncoder, ctx: FrameCtx, res: PassResources): void {
  const { profiler, isDeviceVisible, globalUniforms } = ctx;
  const msaa = ctx.msaa;

  // Swap every scene/device pipeline to its MSAA-4x variant (or back) — a
  // reference reassignment; both variants were built at init.
  if (host.skyPipelineBase) host.skyPipeline = msaa ? (host.skyPipelineMsaa4 || host.skyPipelineBase) : host.skyPipelineBase;
  if (host.gridPipelineBase) host.gridPipeline = msaa ? (host.gridPipelineMsaa4 || host.gridPipelineBase) : host.gridPipelineBase;
  if (host.anomalyWallPipelineBase) host.anomalyWallPipeline = msaa ? (host.anomalyWallPipelineMsaa4 || host.anomalyWallPipelineBase) : host.anomalyWallPipelineBase;
  if (host.energyPipePipelineBase) host.energyPipePipeline = msaa ? (host.energyPipePipelineMsaa4 || host.energyPipePipelineBase) : host.energyPipePipelineBase;
  for (const device of Object.values(host.devices) as RenderDevice[]) {
    device.pipelineManager?.applyMsaaState?.(msaa);
  }

  const sceneView = host.bloomSceneTexture!.createView({ label: 'scene-color' });
  const gbufferView = host.materialGBufferView;
  // MSAA: colour and G-buffer resolve into the single-sample targets via
  // `resolveTarget`; the multisampled copies are discarded (and may be
  // TRANSIENT_ATTACHMENT — post-targets.ts). Bloom / SSR never know.
  const colorAttachments: GPURenderPassColorAttachment[] = [msaa
    ? { view: host.sceneMsaaView!, resolveTarget: sceneView, clearValue: CLEAR_BLACK, loadOp: 'clear', storeOp: 'discard' }
    : { view: sceneView, clearValue: CLEAR_BLACK, loadOp: 'clear', storeOp: 'store' }];
  if (gbufferView) {
    colorAttachments.push(msaa
      ? { view: host.materialGBufferMsaaView!, resolveTarget: gbufferView, clearValue: GBUFFER_CLEAR, loadOp: 'clear', storeOp: 'discard' }
      : { view: gbufferView, clearValue: GBUFFER_CLEAR, loadOp: 'clear', storeOp: 'store' });
  }

  const pass = encoder.beginRenderPass({
    label: msaa ? 'scene-msaa4' : 'scene',
    colorAttachments,
    depthStencilAttachment: WebGPUManager.depthStencilAttachment(
      msaa ? host.depthMsaaAttachmentView! : host.depthAttachmentView!,
      { format: host.depthFormat }
    ),
    timestampWrites: res.timestamps('both')
  });

  // Sky first (fullscreen, before all geometry), then the grid.
  if (host.skyPipeline && host.skyBindGroup) {
    pass.setPipeline(host.skyPipeline);
    pass.setBindGroup(0, host.skyBindGroup);
    pass.draw(3);
  }
  if (host.gridPipeline && host.gridBindGroup) {
    pass.setPipeline(host.gridPipeline);
    pass.setBindGroup(0, host.gridBindGroup);
    pass.setVertexBuffer(0, host.gridVertexBuffer);
    pass.draw(6);
  }

  const quality = profiler.qualityLevel;
  for (const device of Object.values(host.devices) as RenderDevice[]) {
    if (!isDeviceVisible(device)) continue;
    // Skip expensive VFX at low quality — keep core meshes visible.
    const skipEffects = quality < 0.5;
    profiler.measureDevice(`render:${device.id}`, () => {
      device.render(pass, globalUniforms, skipEffects);
    });
  }

  // Transparent panel: after the opaque device meshes it is depth-tested against.
  ctx.fdtdSlice?.draw(pass, globalUniforms, msaa);

  // Roschin–Godin magnetic wall shells overlay the SEG.
  const segDevice = host.devices['seg'] as RenderDevice | undefined;
  if (segDevice && isDeviceVisible(segDevice)) host.renderAnomalyWalls(pass, globalUniforms, segDevice);

  if (ctx.overview && host.energyPipePipeline && quality > 0.35) {
    for (const pipe of host.energyPipes) pipe.render(pass, globalUniforms, host.energyPipePipeline);
  }
  pass.end();
}

/**
 * Manual MSAA depth resolve (ADR-0005 WS2) — WebGPU has no depth
 * resolveTarget. See passes/depth-resolve.wgsl.
 */
export function encodeDepthResolve(host: Host, encoder: GPUCommandEncoder, res: PassResources): boolean {
  if (!host.depthResolvePipeline || !host._depthResolveBindGroup || !host.depthResolvedAttachmentView) return false;
  const pass = encoder.beginRenderPass({
    label: 'depth-resolve',
    colorAttachments: [],
    depthStencilAttachment: WebGPUManager.depthStencilAttachment(host.depthResolvedAttachmentView, {
      format: host.depthFormat
    }),
    timestampWrites: res.timestamps('both')
  });
  pass.setPipeline(host.depthResolvePipeline);
  pass.setBindGroup(0, host._depthResolveBindGroup);
  pass.draw(3);
  pass.end();
  return true;
}

/** Bloom: half-res mip chain (linear) or full-res extract → blurX → blurY (`?color=legacy`). */
export function encodeBloom(host: Host, encoder: GPUCommandEncoder, ctx: FrameCtx, res: PassResources): boolean {
  if (ctx.bloom === 'chain') {
    return host.bloomChain!.encode(encoder, host.bloomChainPipelines!, ctx.taa, res);
  }
  const temp = host.bloomTempTexture!;
  const blur = host.bloomBlurTexture!;
  const extract = ctx.taa ? (host.bloomExtractBindGroupTaa || host.bloomExtractBindGroup) : host.bloomExtractBindGroup;
  if (!extract || !host.bloomBlurXBindGroup || !host.bloomBlurYBindGroup) return false;
  const steps: Array<[string, GPUTexture, GPURenderPipeline, GPUBindGroup, 'begin' | 'end' | null]> = [
    ['bloom-extract', temp, host.bloomExtractPipeline!, extract, 'begin'],
    ['bloom-blur-x', blur, host.bloomBlurPipeline!, host.bloomBlurXBindGroup, null],
    ['bloom-blur-y', temp, host.bloomBlurPipeline!, host.bloomBlurYBindGroup, 'end']
  ];
  for (const [label, target, pipeline, bindGroup, edge] of steps) {
    const pass = encoder.beginRenderPass({
      label,
      colorAttachments: [{ view: target.createView({ label: target.label }), clearValue: CLEAR_BLACK, loadOp: 'clear', storeOp: 'store' }],
      timestampWrites: edge ? res.timestamps(edge) : undefined
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }
  return true;
}

/** Post uniforms (exposure, bloom, gates) for this frame — read by bloom and composite. */
export function uploadPostParams(host: Host, ctx: FrameCtx): void {
  if (!host.bloomParamsBuffer) return;
  const colorTargets = host.pipelineCache!.colorTargets;
  const speedMult = host.simRateController.speedMult;
  const speedEnergy = Math.min(1.0, speedMult / 20.0);
  const coronaBoost = (host.corona || 0) * 0.4;
  const energy = Math.min(1.0, Math.max(speedEnergy, host.globalEnergyLevel) + coronaBoost);
  const preset = {
    ...host.postPreset,
    post: {
      ...host.postPreset.post,
      exposure: host.postExposure ?? host.postPreset.post.exposure,
      bloomStrength: host.postBloomStrength ?? host.postPreset.post.bloomStrength
    }
  };
  writeQueueBuffer(host.device, host.bloomParamsBuffer, packPostUniforms({
    width: host.canvas.width || 1,
    height: host.canvas.height || 1,
    preset,
    energy,
    speedMult,
    // Read here, after the graph settled lifetimes: a history allocated this
    // frame is not valid yet, so it must not be blended.
    motionBlur: motionBlurAmount(host),
    qualityGates: ctx.postGates,
    ssrEnabled: ctx.ssr,
    outputLinearHdr: colorTargets.hdrOutput,
    bloomChainLevels: host.bloomChain?.levels ?? 0,
    outputTransfer: postOutputTransfer(colorTargets)
  }));
}

/** Speed-driven motion-blur mix (0 below 7× sim speed), before the history check. */
export function speedMotionBlur(host: Host): number {
  return smoothstep(7.0, 20.0, host.simRateController.speedMult) * 0.12;
}

/** Motion-blur mix for this frame: 0 until a real history frame exists. */
export function motionBlurAmount(host: Host): number {
  return host._historyValid ? speedMotionBlur(host) : 0;
}

/** Scene + bloom → canvas with tonemap / post FX. */
export function encodeComposite(host: Host, encoder: GPUCommandEncoder, ctx: FrameCtx, res: PassResources): boolean {
  // Two independent axes, so four variants, most specific first:
  //   msaa → depthResolved for the contact-shadow term (plain depth unwritten)
  //   taa  → the TAA resolve target instead of the raw scene
  // Each falls back towards the plain bind group, which is always built.
  const bindGroup =
    (ctx.msaa && ctx.taa ? host.bloomCompositeBindGroupResolvedTaa : null)
    ?? (ctx.taa ? host.bloomCompositeBindGroupTaa : null)
    ?? (ctx.msaa ? host.bloomCompositeBindGroupResolved : null)
    ?? host.bloomCompositeBindGroup;
  if (!bindGroup) return false;

  // queue.writeBuffer lands before this frame's submit, so the bloom passes
  // already encoded above read these values too.
  uploadPostParams(host, ctx);
  const colorTargets = host.pipelineCache!.colorTargets;
  // The view format does the sRGB encode on the linear SDR path (`-srgb`);
  // legacy and the HDR float canvas use the texture's own.
  const pass = encoder.beginRenderPass({
    label: 'composite',
    colorAttachments: [{
      view: ctx.gpuContext.getCurrentTexture().createView({ label: 'canvas-output', format: colorTargets.outputFormat }),
      clearValue: CLEAR_BLACK,
      loadOp: 'clear', storeOp: 'store'
    }],
    timestampWrites: res.timestamps('both')
  });
  pass.setPipeline(host.bloomCompositePipeline!);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
  return true;
}

/**
 * History for the next frame. After the composite, so prevSceneTexture holds a
 * *previous* frame when motion blur reads it. With TAA the history is the
 * resolved frame, so the blend accumulates instead of reaching back one frame.
 */
export function encodeHistoryCopy(host: Host, encoder: GPUCommandEncoder, ctx: FrameCtx): boolean {
  const source = ctx.taa ? host.taaResolveTexture : host.bloomSceneTexture;
  if (!source || !host.prevSceneTexture) return false;
  encoder.copyTextureToTexture(
    { texture: source },
    { texture: host.prevSceneTexture },
    [host.canvas.width || 1, host.canvas.height || 1, 1]
  );
  host._historyValid = true;
  if (ctx.taa) host._taaHistoryValid = true;
  return true;
}
