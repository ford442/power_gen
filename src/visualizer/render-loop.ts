// Per-frame simulation update. GPU encode (scene + bloom) lives in
// render-encode.ts — split out to keep this file under the 700-line cap.
import { explainerState } from '../seg-explainer/explainer-state';
import { getViewMeshLod, getDeviceParticleScale, getOverviewCullOpts, getMeshDrawDetail, getViewParticleLod } from '../renderers/shared/view-lod.js';
import { shouldSimulateDevice } from '../renderers/shared/device-view.js';
import { resolveScaledParticleCount } from '../devices/particle-budgets';
import { expectedInstanceCount } from '../devices/overview-cull';
import { bindHostMethods } from './bind-host-methods.js';
import { renderEncodeMethods } from './render-encode.js';
import type { MultiDeviceVisualizer } from '../multi-device-visualizer.js';
import type { DeviceInstance } from '../device-instance.js';

type Host = MultiDeviceVisualizer;

/** DeviceInstance plus optional plugin layout flags used by cull / budgets. */
type RenderDevice = DeviceInstance & {
  config: DeviceInstance['config'] & { cullRadius?: number; plugin?: boolean };
};

export const renderLoopMethods: ThisType<Host> & {
  render(timestamp: number): void;
} = {
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

    // FDTD wave slice (ADR-0010): pulse-coil focus at `high` only; uploads its
    // uniforms here so the dispatch and draw below see this frame's drive.
    const fdtdSlice = this.updateFdtdSlice(qualityTier);
    profiler.fdtdActive = !!fdtdSlice;

    renderEncodeMethods._encodeFrame.call(
      this, profiler, globalUniforms, gpuContext, cull, cullActive, isDeviceVisible, fdtdSlice
    );
  }
};

/** WebGPU encode loop. Plant tick lives on LabSession. */
export class WebGpuFrameLoop {
  render: typeof renderLoopMethods.render;
  renderAnomalyWalls: typeof renderEncodeMethods.renderAnomalyWalls;
  _dispatchSsr: typeof renderEncodeMethods._dispatchSsr;
  _encodeTaaResolve: typeof renderEncodeMethods._encodeTaaResolve;

  constructor(host: MultiDeviceVisualizer) {
    const bound = bindHostMethods(renderLoopMethods, host);
    const boundEncode = bindHostMethods(renderEncodeMethods, host);
    this.render = bound.render;
    this.renderAnomalyWalls = boundEncode.renderAnomalyWalls;
    this._dispatchSsr = boundEncode._dispatchSsr;
    this._encodeTaaResolve = boundEncode._encodeTaaResolve;
  }
}
