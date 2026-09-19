// GPU command encoding: compute dispatch, scene/sky/grid/device draws, MSAA
// depth resolve, TAA, SSR, bloom, and frame history. Split out of
// render-loop.ts (simulation tick vs GPU encode) to keep that file under the
// repo's 700-line cap.
import { WebGPUManager } from '../webgpu-manager';
import { MAX_ROLLERS } from '../seg-layout';
import { packPostUniforms } from '../seg-lighting-presets';
import { writeQueueBuffer } from '../gpu-buffer-write';
import { getPostQualityGates } from '../post-processing-config';
import { SSR_PARAMS_BYTES, TAA_PARAMS_BYTES } from './scene-setup.js';
import type { MultiDeviceVisualizer } from '../multi-device-visualizer.js';
import type { DeviceInstance } from '../device-instance.js';
import type { PerformanceProfiler } from '../performance-profiler';

type Host = MultiDeviceVisualizer;

/** DeviceInstance plus optional plugin layout flags used by cull / budgets. */
type RenderDevice = DeviceInstance & {
  config: DeviceInstance['config'] & { cullRadius?: number; plugin?: boolean };
};

/**
 * History weight for the TAA blend. 0.9 is the usual starting point: enough
 * accumulation to settle SSR and roller chrome within a few frames, low enough
 * that the neighbourhood clamp can still pull a disoccluded pixel back inside
 * one frame.
 */
const TAA_HISTORY_WEIGHT = 0.9;

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export const renderEncodeMethods: ThisType<Host> & {
  renderAnomalyWalls(
    renderPass: GPURenderPassEncoder,
    globalUniformBuffer: GPUBuffer | null,
    segDevice: DeviceInstance | null | undefined
  ): void;
  _dispatchSsr(encoder: GPUCommandEncoder, msaaActive: boolean): void;
  _encodeTaaResolve(encoder: GPUCommandEncoder, msaaActive: boolean): boolean;
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
   * Encode the temporal AA resolve pass (ADR-0005 WS2).
   *
   * Gated on tier (high/ultra), focus mode, `?taa=0` and the pipeline having
   * been built. Reprojects with the camera's own view-projection and the one
   * cached from last frame — there is no separate TAA camera and no velocity
   * buffer; see passes/taa-resolve.wgsl for why that is sufficient here.
   *
   * @returns true if the pass was encoded, so the caller knows to composite
   *   from the resolve target instead of the raw scene.
   */
  _encodeTaaResolve(encoder: GPUCommandEncoder, msaaActive: boolean): boolean {
    const gates = this._postQualityGates;
    const gateOpen = !!gates?.taa
      && !this.isOverviewMode()
      && this.taaEnabled !== false
      && !!this.taaPipeline
      && !!this.taaParamsBuffer
      && !!this.taaResolveView
      && !!this.cameraController;
    if (!gateOpen) {
      // Whatever is in the history belongs to a frame the next TAA frame
      // cannot trust, so make the first frame back a reset.
      this._taaHistoryValid = false;
      this._taaPrevViewProj = null;
      return false;
    }

    const bindGroup = msaaActive
      ? (this.taaBindGroupResolved || this.taaBindGroup)
      : this.taaBindGroup;
    if (!bindGroup) {
      this._taaHistoryValid = false;
      return false;
    }

    const camera = this.cameraController!;
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
    writeQueueBuffer(this.device, this.taaParamsBuffer!, params);

    const pass = encoder.beginRenderPass({
      label: 'taa-resolve-pass',
      colorAttachments: [{
        view: this.taaResolveView!,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear', storeOp: 'store'
      }]
    });
    pass.setPipeline(this.taaPipeline!);
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
  _dispatchSsr(encoder: GPUCommandEncoder, msaaActive: boolean) {
    // On an MSAA frame, bind the manually resolved depth (depth-resolve.wgsl
    // ran earlier this frame) instead of the regular single-sample depth —
    // see docs/LIGHTING_RIG.md / docs/BINDINGS.md.
    const bindGroup = msaaActive ? (this.ssrBindGroupResolved || this.ssrBindGroup) : this.ssrBindGroup;
    if (!this.cameraController || !this.ssrParamsBuffer || !this.ssrPipeline || !bindGroup) {
      return;
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

    const pass = encoder.beginComputePass({ label: 'ssr' });
    pass.setPipeline(this.ssrPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(
      Math.ceil((this.ssrWidth || 1) / 8),
      Math.ceil((this.ssrHeight || 1) / 8)
    );
    pass.end();
  },

  /** GPU command encoding for one frame: compute, scene/sky/grid/device draws, MSAA depth resolve, TAA, SSR, bloom, history copy. */
  _encodeFrame(
    profiler: PerformanceProfiler,
    globalUniforms: GPUBuffer,
    gpuContext: GPUCanvasContext,
    cull: Host['overviewCull'],
    cullActive: boolean,
    isDeviceVisible: (device: RenderDevice) => boolean,
    fdtdSlice: ReturnType<Host['updateFdtdSlice']>
  ) {
    // Begin command encoding
    const encoder = this.device.createCommandEncoder();

    // ─── COMPUTE PASS: animate particles on GPU ───
    const computePass = encoder.beginComputePass({ label: 'particle-compute' });

    // Overview frustum cull → draw-indirect. Runs first: the instance render
    // pass below consumes the draw args this dispatch writes.
    if (cullActive) cull!.dispatch(computePass);

    // SEG-specific compute: roller kinematics + RK4 flux line tracing.
    // These run first so rendering reads the freshly updated buffers.
    const segDevice = this.devices['seg'] as RenderDevice | undefined;
    if (segDevice && isDeviceVisible(segDevice)) {
      if (segDevice.rollerComputePipeline && segDevice.rollerComputeBindGroup) {
        computePass.setPipeline(segDevice.rollerComputePipeline);
        computePass.setBindGroup(0, segDevice.rollerComputeBindGroup);
        computePass.dispatchWorkgroups(Math.ceil(MAX_ROLLERS / 64));
      }
      // RK4 flux line tracer: one thread per flux line (up to 108).
      if (segDevice.fluxTracerPipeline && segDevice.fluxTracerBindGroup &&
          profiler.qualityLevel > 0.32) {
        computePass.setPipeline(segDevice.fluxTracerPipeline);
        computePass.setBindGroup(0, segDevice.fluxTracerBindGroup);
        const fluxLines = this.segLayout?.totalFluxLines ?? 168;
        computePass.dispatchWorkgroups(Math.ceil(fluxLines / 64));
      }
    }

    const xfmrDevice = this.devices['transformer'] as RenderDevice | undefined;
    if (xfmrDevice && isDeviceVisible(xfmrDevice)
        && xfmrDevice.transformerFluxPipeline && xfmrDevice.transformerFluxBindGroup
        && profiler.qualityLevel > 0.28) {
      computePass.setPipeline(xfmrDevice.transformerFluxPipeline);
      computePass.setBindGroup(0, xfmrDevice.transformerFluxBindGroup);
      computePass.dispatchWorkgroups(Math.ceil((xfmrDevice.transformerFluxLineCount || 24) / 64));
    }

    fdtdSlice?.dispatch(computePass);

    for (const device of Object.values(this.devices) as RenderDevice[]) {
      if (!isDeviceVisible(device)) continue;
      if (device.computePipeline && device.computeBindGroup) {
        computePass.setPipeline(device.computePipeline);
        computePass.setBindGroup(0, device.computeBindGroup);
        const workgroups = Math.ceil((device.scaledParticleCount || device.particleCount) / 64);
        computePass.dispatchWorkgroups(workgroups);
      }
    }

    if (this.isOverviewMode() && this.energyPipeComputePipeline) {
      for (const pipe of this.energyPipes) {
        pipe.dispatchCompute(computePass);
      }
    }
    computePass.end();

    profiler.writeTimestamp(encoder, 0);

    // 4x MSAA (ADR-0005 WS2 showroom pass): `high` tier + focus mode only.
    // `'ultra'` is defined in config/docs but the auto-quality system never
    // assigns it (performance-profiler.ts only ever picks
    // critical/low/medium/high), so gating on `'high'` is the practical
    // ceiling today. Requires the MSAA/resolved-depth textures and both
    // pipeline variants to exist — set up unconditionally at init, so this
    // is just a state check, never an async wait mid-frame.
    const msaaActive = !!(
      profiler.qualityTier === 'high' &&
      !this.isOverviewMode() &&
      this.sceneMsaaView && this.materialGBufferMsaaView &&
      this.depthMsaaAttachmentView && this.depthResolvedAttachmentView &&
      this.depthResolvePipeline && this._depthResolveBindGroup
    );
    profiler.msaaActive = msaaActive;

    // Swap every scene/device pipeline to its MSAA-4x variant (or back) —
    // cheap reference reassignment, no GPU work; the pipelines themselves
    // were created eagerly for both sample counts at init.
    if (this.skyPipelineBase) this.skyPipeline = msaaActive ? (this.skyPipelineMsaa4 || this.skyPipelineBase) : this.skyPipelineBase;
    if (this.gridPipelineBase) this.gridPipeline = msaaActive ? (this.gridPipelineMsaa4 || this.gridPipelineBase) : this.gridPipelineBase;
    if (this.anomalyWallPipelineBase) this.anomalyWallPipeline = msaaActive ? (this.anomalyWallPipelineMsaa4 || this.anomalyWallPipelineBase) : this.anomalyWallPipelineBase;
    if (this.energyPipePipelineBase) this.energyPipePipeline = msaaActive ? (this.energyPipePipelineMsaa4 || this.energyPipePipelineBase) : this.energyPipePipelineBase;
    for (const device of Object.values(this.devices) as RenderDevice[]) {
      device.pipelineManager?.applyMsaaState?.(msaaActive);
    }

    const sceneView = (this.bloomSceneTexture)
      ? this.bloomSceneTexture.createView()
      : gpuContext.getCurrentTexture().createView();

    // Color 1: metalness (r) / roughness (g) G-buffer (ADR-0005 WS2). Cleared
    // to metallic=0, roughness=1 ("non-metal, fully rough") so any pipeline
    // below that declares a `null` second target — everything except
    // seg-enhanced/roller — reads back as non-reflective by default; only
    // those two actually write real values.
    const gbufferView = this.materialGBufferView;
    const gbufferClear = { r: 0.0, g: 1.0, b: 0.0, a: 0.0 };
    let colorAttachments: GPURenderPassColorAttachment[];
    if (msaaActive) {
      // MSAA color resolves automatically into the regular single-sample
      // textures via `resolveTarget` — bloom/SSR downstream never know MSAA
      // happened. `storeOp: 'discard'` on the multisampled view is correct
      // here: only the resolved copy is read afterward.
      colorAttachments = [{
        view: this.sceneMsaaView!,
        resolveTarget: sceneView,
        clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1 },
        loadOp: 'clear',
        storeOp: 'discard'
      }];
      if (gbufferView) {
        colorAttachments.push({
          view: this.materialGBufferMsaaView!,
          resolveTarget: gbufferView,
          clearValue: gbufferClear,
          loadOp: 'clear',
          storeOp: 'discard'
        });
      }
    } else {
      colorAttachments = [{
        view: sceneView,
        clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store'
      }];
      if (gbufferView) {
        colorAttachments.push({
          view: gbufferView,
          clearValue: gbufferClear,
          loadOp: 'clear',
          storeOp: 'store'
        });
      }
    }

    const renderPass = encoder.beginRenderPass({
      colorAttachments,
      depthStencilAttachment: WebGPUManager.depthStencilAttachment(
        msaaActive ? this.depthMsaaAttachmentView! : this.depthAttachmentView!,
        { format: this.depthFormat }
      )
    });

    // Render sky gradient first (fullscreen, before all geometry)
    if (this.skyPipeline && this.skyBindGroup) {
      renderPass.setPipeline(this.skyPipeline);
      renderPass.setBindGroup(0, this.skyBindGroup);
      renderPass.draw(3);
    }

    // Render grid
    if (this.gridPipeline && this.gridBindGroup) {
      renderPass.setPipeline(this.gridPipeline);
      renderPass.setBindGroup(0, this.gridBindGroup);
      renderPass.setVertexBuffer(0, this.gridVertexBuffer);
      renderPass.draw(6);
    }

    // Render devices (scaled by quality)
    const scaledQuality = profiler.qualityLevel;
    for (const device of Object.values(this.devices) as RenderDevice[]) {
      if (!isDeviceVisible(device)) continue;
      // Skip expensive VFX at low quality — keep core meshes visible.
      const skipEffects = scaledQuality < 0.5;
      profiler.measureDevice(`render:${device.id}`, () => {
        device.render(renderPass, globalUniforms, skipEffects);
      });
    }

    // Transparent panel: after the opaque device meshes it is depth-tested against.
    fdtdSlice?.draw(renderPass, globalUniforms, msaaActive);

    // Roschin–Godin magnetic wall shells (drawn after SEG so they overlay the scene).
    if (segDevice && isDeviceVisible(segDevice)) {
      this.renderAnomalyWalls(renderPass, globalUniforms, segDevice);
    }

    // Energy transfer pipes between devices (overview only).
    if (this.isOverviewMode() && this.energyPipePipeline && scaledQuality > 0.35) {
      for (const pipe of this.energyPipes) {
        pipe.render(renderPass, globalUniforms, this.energyPipePipeline);
      }
    }

    renderPass.end();

    // Manual MSAA depth resolve (ADR-0005 WS2) — WebGPU has no automatic
    // resolveTarget for depth. Must run before SSR/bloom below, both of
    // which read a single-sample depth texture. See passes/depth-resolve.wgsl.
    if (msaaActive) {
      const resolvePass = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: WebGPUManager.depthStencilAttachment(this.depthResolvedAttachmentView!, {
          format: this.depthFormat
        })
      });
      resolvePass.setPipeline(this.depthResolvePipeline!);
      resolvePass.setBindGroup(0, this._depthResolveBindGroup!);
      resolvePass.draw(3);
      resolvePass.end();
    }

    // Auto-quality post gates (ADR-0005) — critical skips bloom extract/blur.
    const postGates = getPostQualityGates(profiler.qualityTier || 'high');
    this._postQualityGates = postGates;

    // ── Temporal AA (high/ultra tier, focus mode only) ───────────────────
    // Runs before SSR and bloom so everything downstream sees the stabilised
    // image. `?taa=0` forces it off at any tier. When it does not run, the
    // bloom stack keeps reading the raw scene texture.
    this._taaActive = this._encodeTaaResolve(encoder, msaaActive);
    profiler.taaActive = this._taaActive;

    // ── Screen-space reflections (high/ultra tier only) ───────────────────
    // Runs between the scene pass and bloom so the composite can add the
    // reflection after its SSAO term. `?ssr=0` forces this off at any tier.
    // Tracks whether the pass actually ran: the composite must not weight a
    // reflection texture nothing wrote this frame.
    this._ssrActive =
      this.ssrEnabled !== false &&
      postGates.ssr > 0 &&
      !!this.ssrPipeline &&
      !!this.ssrBindGroup &&
      !!this.ssrParamsBuffer;
    if (this._ssrActive) {
      this._dispatchSsr(encoder, msaaActive);
    }

    // ── Bloom post-processing ─────────────────────────────────────────────
    if (this.bloomExtractPipeline && this.bloomBlurPipeline && this.bloomCompositePipeline &&
        this.bloomSceneTexture && this.bloomBlurTexture && this.bloomTempTexture && this.prevSceneTexture && this.depthTexture) {
      // Update bloom parameters dynamically based on current speed + quality tier
      if (this.bloomParamsBuffer) {
        const w = this.canvas.width || 1;
        const h = this.canvas.height || 1;
        const speedEnergy = Math.min(1.0, this.simRateController.speedMult / 20.0);
        const coronaBoost = (this.corona || 0) * 0.4;
        const energy = Math.min(1.0, Math.max(speedEnergy, this.globalEnergyLevel) + coronaBoost);
        const motionBlur = smoothstep(7.0, 20.0, this.simRateController.speedMult) * 0.12;
        const preset = {
          ...this.postPreset,
          post: {
            ...this.postPreset.post,
            exposure: this.postExposure ?? this.postPreset.post.exposure,
            bloomStrength: this.postBloomStrength ?? this.postPreset.post.bloomStrength
          }
        };
        writeQueueBuffer(
          this.device,
          this.bloomParamsBuffer,
          packPostUniforms({
            width: w,
            height: h,
            preset,
            energy,
            speedMult: this.simRateController.speedMult,
            motionBlur,
            qualityGates: postGates,
            ssrEnabled: this._ssrActive,
            outputLinearHdr: this.webgpu?.toneMappingMode === 'extended'
          })
        );
      }

      // Skip extract + blur when bloom gate is off (composite still tonemaps).
      if (postGates.bloom > 0) {
        // Pass 1: extract bright areas → bloomTempTexture
        const extractPass = encoder.beginRenderPass({
          colorAttachments: [{
            view: this.bloomTempTexture.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear', storeOp: 'store'
          }]
        });
        extractPass.setPipeline(this.bloomExtractPipeline);
        const extractBindGroup = this._taaActive
          ? (this.bloomExtractBindGroupTaa || this.bloomExtractBindGroup)
          : this.bloomExtractBindGroup;
        if (extractBindGroup) {
          extractPass.setBindGroup(0, extractBindGroup);
        }
        extractPass.draw(3);
        extractPass.end();

        // Pass 2: horizontal blur bloomTemp → bloomBlur
        const blurXPass = encoder.beginRenderPass({
          colorAttachments: [{
            view: this.bloomBlurTexture.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear', storeOp: 'store'
          }]
        });
        blurXPass.setPipeline(this.bloomBlurPipeline);
        if (this.bloomBlurXBindGroup) {
          blurXPass.setBindGroup(0, this.bloomBlurXBindGroup);
        }
        blurXPass.draw(3);
        blurXPass.end();

        // Pass 3: vertical blur bloomBlur → bloomTemp
        const blurYPass = encoder.beginRenderPass({
          colorAttachments: [{
            view: this.bloomTempTexture.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear', storeOp: 'store'
          }]
        });
        blurYPass.setPipeline(this.bloomBlurPipeline);
        if (this.bloomBlurYBindGroup) {
          blurYPass.setBindGroup(0, this.bloomBlurYBindGroup);
        }
        blurYPass.draw(3);
        blurYPass.end();
      }

      // Pass 4: composite scene + bloom → canvas with tonemap/post FX
      const compositePass = encoder.beginRenderPass({
        colorAttachments: [{
          view: gpuContext.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear', storeOp: 'store'
        }]
      });
      compositePass.setPipeline(this.bloomCompositePipeline);
      // Two independent axes, so four variants, most specific first:
      //   msaaActive  → bind depthResolvedTexture for the contact-shadow term
      //                 (the single-sample depth was never written this frame)
      //   _taaActive  → read the TAA resolve target instead of the raw scene
      // Each falls back towards the plain bind group, which is always built.
      const compositeBindGroup =
        (msaaActive && this._taaActive ? this.bloomCompositeBindGroupResolvedTaa : null)
        ?? (this._taaActive ? this.bloomCompositeBindGroupTaa : null)
        ?? (msaaActive ? this.bloomCompositeBindGroupResolved : null)
        ?? this.bloomCompositeBindGroup;
      if (compositeBindGroup) {
        compositePass.setBindGroup(0, compositeBindGroup);
      }
      compositePass.draw(3);
      compositePass.end();
    }

    // ── History for the next frame ────────────────────────────────────────
    // This copy must come *after* the composite: it used to run before the
    // bloom stack, which meant prevSceneTexture held the frame currently being
    // composited and the motion-blur mix was a no-op (scene blended with
    // itself). Copying here is what actually makes it a previous frame.
    //
    // When TAA ran, the history is the *resolved* frame, so the next frame's
    // blend accumulates exponentially instead of only reaching back one frame.
    if (this.prevSceneTexture && (this._taaActive || postGates.motionBlur > 0.01)) {
      const source = this._taaActive && this.taaResolveTexture
        ? this.taaResolveTexture
        : this.bloomSceneTexture;
      if (source) {
        encoder.copyTextureToTexture(
          { texture: source },
          { texture: this.prevSceneTexture },
          [this.canvas.width || 1, this.canvas.height || 1, 1]
        );
        // Only now is there a history frame worth reprojecting.
        if (this._taaActive) this._taaHistoryValid = true;
      }
    }

    profiler.writeTimestamp(encoder, 1);

    profiler.endFrameCpu();

    this.device.queue.submit([encoder.finish()]);

    // Resolve timestamps asynchronously (guarded against overlapping map/submit)
    if (profiler.timingEnabled) {
      profiler.scheduleResolveTimestamps();
    }

    requestAnimationFrame((t) => this.render(t));
  }
};
