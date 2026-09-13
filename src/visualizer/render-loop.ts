// Per-frame simulation update + GPU encode (scene + bloom).
import { WebGPUManager } from '../webgpu-manager';
import { MAX_ROLLERS } from '../seg-layout';
import { packPostUniforms } from '../seg-lighting-presets';
import { writeQueueBuffer } from '../gpu-buffer-write';
import { getPostQualityGates } from '../post-processing-config';
import { SSR_PARAMS_BYTES, TAA_PARAMS_BYTES } from './scene-setup.js';
import { explainerState } from '../seg-explainer/explainer-state';
import { getViewMeshLod, getDeviceParticleScale, getOverviewCullOpts, getMeshDrawDetail, getViewParticleLod } from '../renderers/shared/view-lod.js';
import { shouldSimulateDevice } from '../renderers/shared/device-view.js';
import { resolveScaledParticleCount } from '../devices/particle-budgets';
import { expectedInstanceCount } from '../devices/overview-cull';
import { bindHostMethods } from './bind-host-methods.js';
import type { MultiDeviceVisualizer } from '../multi-device-visualizer.js';
import type { DeviceInstance } from '../device-instance.js';

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

export const renderLoopMethods: ThisType<Host> & {
  renderAnomalyWalls(
    renderPass: GPURenderPassEncoder,
    globalUniformBuffer: GPUBuffer | null,
    segDevice: DeviceInstance | null | undefined
  ): void;
  _dispatchSsr(encoder: GPUCommandEncoder, msaaActive: boolean): void;
  _encodeTaaResolve(encoder: GPUCommandEncoder, msaaActive: boolean): boolean;
  render(timestamp: number): void;
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

  render(timestamp: number) {
    if (
      this.canvas.clientWidth < 1 ||
      this.canvas.clientHeight < 1 ||
      !this.depthAttachmentView ||
      !this.profiler ||
      !this.cameraController ||
      !this.globalUniformBuffer ||
      !this.lightingUniformBuffer ||
      !this.context
    ) {
      requestAnimationFrame((t) => this.render(t));
      return;
    }

    const profiler = this.profiler;
    const cameraController = this.cameraController;
    const globalUniforms = this.globalUniformBuffer;
    const lightingUniforms = this.lightingUniformBuffer;
    const gpuContext = this.context;

    const deltaTime = (timestamp - this.lastFrameTime) / 1000;
    this.lastFrameTime = timestamp;
    
    if (timestamp % 500 < 20) {
      this.fps = Math.round(1 / (deltaTime || 0.016));
      const fpsEl = document.getElementById('fps');
      if (fpsEl) fpsEl.textContent = String(this.fps);
    }
    
    const speedControlEl = document.getElementById('speedControl') as HTMLInputElement | null;
    const rawSpeed = parseFloat(speedControlEl?.value ?? '') || 50;
    // Logarithmic mapping: 0→0.05×, 50→1.0×, 100→20× (base 400)
    const speed = 0.05 * Math.pow(400, rawSpeed / 100);
    this.speedMult = speed;
    this.session.stepPlant(deltaTime, speed, {
      qualityLevel: profiler.qualityLevel,
      frameTimeMs: profiler.lastFrameTimeMs,
      gpuTimeMs: profiler.lastGpuTimeMs
    });
    profiler.beginFrameCpu();
    this.segOmega = this.session.segOmega;
    this.updateGltfHousingState?.();
    this.corona = this.session.corona;
    this.time += deltaTime * speed;

    // Propagate current speedMult to all devices (needed by GPU compute uniforms)
    for (const device of Object.values(this.devices)) {
      device.speedMult = speed;
    }

    // Update speedVal label so the UI reflects the actual multiplier
    const speedValEl = document.getElementById('speedVal');
    if (speedValEl) speedValEl.textContent = speed.toFixed(2) + '×';

    // Update tachometer overlay
    this.session.updateTachometer();

    // Hardware twin: mirror segOperator plant → coils @ ~60 Hz; closed-loop viz
    this.session.syncHardwareTwin(deltaTime);

    // Update camera
    cameraController.updateCamera(deltaTime);

    // Needed twice: the GPU cull pass frustum and the global uniform upload.
    const viewProj = cameraController.getViewProjMatrix();

    const canvasAspect = (this.canvas.width || 1) / Math.max(1, this.canvas.height || 1);
    const cullCamera = this.camera?.camera;
    // Plugin overview ring is 20 m — cull sphere must cover device extents there.
    const cullOpts = getOverviewCullOpts({ aspect: canvasAspect });

    const isDeviceVisible = (device: RenderDevice) => shouldSimulateDevice(
      this.currentView,
      this.devicesEnabled,
      device.id,
      device.position as number[],
      cullCamera,
      {
        ...cullOpts,
        radius: device.config?.cullRadius ?? cullOpts.radius
      }
    );

    // Update devices with view LOD × auto-quality × per-device tier budgets
    const explainerScale = explainerState.getParticleCapScale();
    const meshLod = getViewMeshLod(this.currentView, profiler.qualityLevel);
    const meshDetail = getMeshDrawDetail(meshLod);
    this._overviewMeshDetail = meshDetail;
    this.refreshSEGLayout(meshLod * explainerScale);

    profiler.beginFrameDraws?.();

    // ── GPU cull / LOD path (ADR-0005 WS4) ───────────────────────────
    // In overview the CPU no longer resolves a particle budget per device:
    // it uploads one flat bounds array with a LOD level, and the cull pass
    // writes the draw-indirect args the particle draw consumes. The CPU
    // prefix path below stays as the fallback (focus views, no pipeline).
    const cull = this.isOverviewMode() && explainerScale >= 1 ? this.overviewCull : null;
    // Measured inside the draw-prep scope: the bounds upload is the CPU cost
    // this path trades the per-device budget ladder for.
    const cullActive = !!(cull?.ready) && profiler.measureDrawPrep(() => cull!.update({
      devices: (Object.values(this.devices) as RenderDevice[]).map((d) => ({
        id: d.id,
        position: Array.from(d.position || [0, 0, 0]),
        particleCount: d.particleCount,
        config: d.config
      })),
      cameraPos: Array.from(cullCamera?.position || [0, 0, 0]),
      currentView: this.currentView,
      qualityLevel: profiler.qualityLevel,
      qualityTier: profiler.qualityTier || 'high',
      defaultRadius: cullOpts.radius,
      isEnabled: (d: { id: string }) => {
        const full = this.devices[d.id] as RenderDevice | undefined;
        return !!full && isDeviceVisible(full);
      },
      viewProj: viewProj as Float32Array,
      margin: cullOpts.margin
    })) > 0;
    if (!cullActive) this.overviewCull?.setInactive();
    this._overviewCullActive = cullActive;
    profiler.overviewCullActive = cullActive;

    let totalParticles = 0;
    const qualityTier = profiler.qualityTier || 'high';
    for (const device of Object.values(this.devices) as RenderDevice[]) {
      if (!isDeviceVisible(device)) continue;

      const viewLod = getViewParticleLod(this.currentView, device.id);
      if (viewLod <= 0) continue;

      let scaledCount = 0;
      let particleScale = 1;
      const slot = cullActive ? cull!.slots[cull!.slotIndex.get(device.id) ?? -1] : null;
      profiler.measureDrawPrep(() => {
        if (slot) {
          // One distance-derived level; the GPU derives both the integration
          // threshold and the instance count from it.
          device.particleBaseCount = slot.baseCount;
          device.particleLodLevel = slot.lodLevel;
          scaledCount = expectedInstanceCount(slot);
        } else {
          device.particleBaseCount = 0;
          device.particleLodLevel = 0;
          scaledCount = resolveScaledParticleCount({
            deviceId: device.id,
            baseCount: device.particleCount,
            qualityLevel: profiler.qualityLevel,
            qualityTier,
            viewLod,
            explainerScale,
            isPlugin: !!device.config?.plugin
          });
        }
        // Keep a scale for effect budgets / legacy paths (avoid 0 when capped).
        particleScale = device.particleCount > 0
          ? Math.max(0.05, scaledCount / device.particleCount)
          : getDeviceParticleScale({
              currentView: this.currentView,
              deviceId: device.id,
              qualityLevel: profiler.qualityLevel,
              explainerScale
            });
      });

      device._meshDrawDetail = this.isOverviewMode?.() ? meshDetail : 'full';

      profiler.measureDevice(device.id, () => {
        device.update(deltaTime * speed, particleScale);
        // CPU path: budget may be below qualityScale*base — enforce resolved
        // count. GPU path: device.update already applied the LOD ladder.
        if (!slot && scaledCount > 0) device.scaledParticleCount = scaledCount;
      });
      totalParticles += device.scaledParticleCount || scaledCount;
    }

    profiler.recordFrame(deltaTime, totalParticles);

    // Update global uniforms with extended lighting data
    const globalData = new Float32Array(128); // 512 bytes / 4 = 128 floats
    
    // Base uniforms (offset 0-23: 96 bytes)
    globalData.set(viewProj, 0);                    // 0-15: viewProj matrix
    globalData[16] = this.time;                     // 16: time
    // padding at 17 (1 float = 4 bytes)
    globalData[18] = this.canvas.width  || 1.0;     // 18-19: resolution (vec2f)
    globalData[19] = this.canvas.height || 1.0;
    globalData[20] = this.camera.camera.position[0];  // 20: cameraPos.x
    globalData[21] = this.camera.camera.position[1];  // 21: cameraPos.y
    globalData[22] = this.camera.camera.position[2];  // 22: cameraPos.z
    globalData[23] = this.speedMult;                  // 23: speedMult
    
    // Key light (offset 24-31: 32 bytes)
    const key = this.lightingConfig.key;
    globalData[24] = key.position[0];
    globalData[25] = key.position[1];
    globalData[26] = key.position[2];
    globalData[27] = key.intensity;
    globalData[28] = key.color[0];
    globalData[29] = key.color[1];
    globalData[30] = key.color[2];
    // padding at 31
    
    // Fill light (offset 32-39: 32 bytes)
    const fill = this.lightingConfig.fill;
    globalData[32] = fill.position[0];
    globalData[33] = fill.position[1];
    globalData[34] = fill.position[2];
    globalData[35] = fill.intensity;
    globalData[36] = fill.color[0];
    globalData[37] = fill.color[1];
    globalData[38] = fill.color[2];
    // padding at 39
    
    // Rim light (offset 40-47: 32 bytes)
    const rim = this.lightingConfig.rim;
    globalData[40] = rim.position[0];
    globalData[41] = rim.position[1];
    globalData[42] = rim.position[2];
    globalData[43] = rim.intensity;
    globalData[44] = rim.color[0];
    globalData[45] = rim.color[1];
    globalData[46] = rim.color[2];
    // padding at 47
    
    // Ground light (offset 48-55: 32 bytes)
    const ground = this.lightingConfig.ground;
    globalData[48] = ground.position[0];
    globalData[49] = ground.position[1];
    globalData[50] = ground.position[2];
    globalData[51] = ground.intensity;
    globalData[52] = ground.color[0];
    globalData[53] = ground.color[1];
    globalData[54] = ground.color[2];
    // padding at 55
    
    this.device.queue.writeBuffer(globalUniforms, 0, globalData);

    // Upload centralized 3-point + environment lighting rig for all lit passes
    const lightingData = new Float32Array(48);
    lightingData[0] = key.position[0]; lightingData[1] = key.position[1]; lightingData[2] = key.position[2]; lightingData[3] = 0;
    lightingData[4] = key.color[0]; lightingData[5] = key.color[1]; lightingData[6] = key.color[2]; lightingData[7] = key.intensity;
    lightingData[8] = fill.position[0]; lightingData[9] = fill.position[1]; lightingData[10] = fill.position[2]; lightingData[11] = 0;
    lightingData[12] = fill.color[0]; lightingData[13] = fill.color[1]; lightingData[14] = fill.color[2]; lightingData[15] = fill.intensity;
    lightingData[16] = rim.position[0]; lightingData[17] = rim.position[1]; lightingData[18] = rim.position[2]; lightingData[19] = 0;
    lightingData[20] = rim.color[0]; lightingData[21] = rim.color[1]; lightingData[22] = rim.color[2]; lightingData[23] = rim.intensity;
    lightingData[24] = ground.position[0]; lightingData[25] = ground.position[1]; lightingData[26] = ground.position[2]; lightingData[27] = 0;
    lightingData[28] = ground.color[0]; lightingData[29] = ground.color[1]; lightingData[30] = ground.color[2]; lightingData[31] = ground.intensity;
    lightingData[32] = this.lightingConfig.ambient;
    lightingData[33] = this.lightingConfig.envMapStrength;
    lightingData[34] = this.lightingConfig.shadowStrength;
    // 0 until the prefiltered chain is uploaded; pbr-eval.wgsl then switches
    // from the analytic approximation to the baked GGX levels.
    lightingData[35] = this.iblLevels || 0;
    this.device.queue.writeBuffer(lightingUniforms, 0, lightingData);

    // Single telemetry write path after device physics (operator panel + gauges subscribe)
    const omega = this.segOmega || 0;
    const scientific = this.session.publishFrame(deltaTime, totalParticles, {
      middleRingTorque: (this.devices.seg?.energyLevel ?? omega) * 12.0
    });
    if (this.integration) {
      this.integration.syncFromVisualizer(scientific);
      this.integration.update(deltaTime * 1000);
      this.integration.writeUniformsToBuffer();
    }

    if (this.isOverviewMode()) {
      const pipeLod = meshLod;
      const pipeTier = profiler.qualityTier || 'high';
      for (const pipe of this.energyPipes) {
        profiler.measureDevice(`pipe:${pipe.config.from}-${pipe.config.to}`, () => {
          pipe.update(deltaTime, this.devices, this.time, {
            lodScale: pipeLod,
            qualityTier: pipeTier
          });
        });
      }
    }

    const enabledDevices = (Object.values(this.devices) as RenderDevice[]).filter((d) => this.isDeviceActive(d.id));
    const targetGlobalEnergy = enabledDevices.length
      ? enabledDevices.reduce((sum, d) => sum + (d.energyLevel || 0), 0) / enabledDevices.length
      : 0.0;
    const globalSmooth = 1.0 - Math.exp(-Math.max(0.0, deltaTime) * 10.0);
    this.globalEnergyLevel += (targetGlobalEnergy - this.globalEnergyLevel) * globalSmooth;
    this._uploadSkyUniforms(this.globalEnergyLevel);

    const annotations = this.segAnnotations as { enabled?: boolean; update?: () => void } | null | undefined;
    if (annotations?.enabled) {
      profiler.measureDevice('annotations', () => annotations.update?.());
    }

    // Begin command encoding
    const encoder = this.device.createCommandEncoder();
    
    // ─── COMPUTE PASS: animate particles on GPU ───
    const computePass = encoder.beginComputePass({ label: 'particle-compute' });

    // Overview frustum cull → draw-indirect. Runs first: the instance render
    // pass below consumes the draw args this dispatch writes.
    if (cullActive) cull.dispatch(computePass);

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
        msaaActive ? this.depthMsaaAttachmentView! : this.depthAttachmentView,
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

/** WebGPU encode loop. Plant tick lives on LabSession. */
export class WebGpuFrameLoop {
  render: typeof renderLoopMethods.render;
  renderAnomalyWalls: typeof renderLoopMethods.renderAnomalyWalls;
  _dispatchSsr: typeof renderLoopMethods._dispatchSsr;
  _encodeTaaResolve: typeof renderLoopMethods._encodeTaaResolve;

  constructor(host: MultiDeviceVisualizer) {
    const bound = bindHostMethods(renderLoopMethods, host);
    this.render = bound.render;
    this.renderAnomalyWalls = bound.renderAnomalyWalls;
    this._dispatchSsr = bound._dispatchSsr;
    this._encodeTaaResolve = bound._encodeTaaResolve;
  }
}

