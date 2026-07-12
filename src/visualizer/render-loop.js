// Per-frame simulation update + GPU encode (scene + bloom).
import { WebGPUManager } from '../webgpu-manager.js';
import { MAX_ROLLERS } from '../seg-layout.js';
import { packPostUniforms } from '../seg-lighting-presets.js';
import { segOperator } from '../seg-operator-state.js';
import { telemetryHub, TelemetryHub } from '../telemetry-hub.js';
import { segWasm } from '../wasm/seg-physics-bridge.js';
import { explainerState } from '../seg-explainer/explainer-state.js';
import { getViewMeshLod, getDeviceParticleScale } from '../renderers/shared/view-lod.js';

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export const renderLoopMethods = {
  renderAnomalyWalls(renderPass, globalUniformBuffer, segDevice) {
    if (!this.anomalyWallPipeline || !this.magneticWallBuffer || !segDevice) return;
    if (this.anomalousEffectsEnabled === false) return;

    const envelope = segDevice._anomalyT || 0;
    if (envelope <= 0.001) return;

    const quality = this.profiler.qualityLevel;
    const shellCount = quality < 0.6 ? 3 : 5;

    // WallParams: intensity, shellCount, innerRadius, spacing, shellThickness, height
    this.device.queue.writeBuffer(
      this.anomalyWallParamsBuffer, 0,
      new Float32Array([envelope, shellCount, 1.6, 0.55, 0.06, 8.0])
    );

    const bindGroup = this.pipelineCache.createBindGroup(
      'anomalyWall',
      [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.anomalyWallParamsBuffer } }
      ],
      'anomaly-wall-bg'
    );

    renderPass.setPipeline(this.anomalyWallPipeline);
    renderPass.setBindGroup(0, bindGroup);
    renderPass.setVertexBuffer(0, this.magneticWallBuffer.vertexBuffer);
    renderPass.setIndexBuffer(this.magneticWallBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(this.magneticWallBuffer.indexCount, 1);
  },

  render(timestamp) {
    if (this.canvas.clientWidth < 1 || this.canvas.clientHeight < 1 || !this.depthAttachmentView) {
      requestAnimationFrame((t) => this.render(t));
      return;
    }

    const deltaTime = (timestamp - this.lastFrameTime) / 1000;
    this.lastFrameTime = timestamp;
    
    if (timestamp % 500 < 20) {
      this.fps = Math.round(1 / (deltaTime || 0.016));
      const fpsEl = document.getElementById('fps');
      if (fpsEl) fpsEl.textContent = this.fps;
    }
    
    const rawSpeed = parseFloat(document.getElementById('speedControl')?.value) ?? 50;
    // Logarithmic mapping: 0→0.05×, 50→1.0×, 100→20× (base 400)
    const speed = 0.05 * Math.pow(400, rawSpeed / 100);
    this.speedMult = speed;
    const simSteps = this.simRateController.tick(deltaTime, speed);
    // Optional C++ WASM plant (?wasmPhysics=1) — drives SEG omega + mode plant
    const useWasm = segWasm.enabled;
    if (useWasm) {
      const drive = segOperator.getDrive();
      const loadT = 0.01 * (1 - drive * 0.5);
      const focus = this.currentView === 'overview' ? 'seg' : this.currentView;
      if (['seg', 'heron', 'kelvin', 'solar'].includes(focus)) {
        segWasm.setMode(focus);
      }
      for (const subDt of simSteps) {
        if (subDt <= 0) continue;
        segOperator.step(subDt); // keep operator status machine in sync
        const wr = segWasm.step(subDt, loadT, drive);
        // Live metric from zero-copy roller buffer / plant
        if (focus === 'seg' || focus === 'overview') {
          // Map WASM ring omega (rad/s) into normalized plant ω used by shaders
          const wNorm = Math.min(1, Math.abs(wr.meanOmega ?? wr.omega) / 50);
          segOperator.physics.segOmega = Math.max(segOperator.physics.segOmega * 0.2, wNorm);
          segOperator.physics.corona = Math.max(0, Math.min(1, (wNorm - 0.6) / 0.4));
        } else if (focus === 'heron') {
          const plant = segWasm.getModePlant();
          const heron = this.devices.heron;
          if (heron?.physicsState && plant) {
            heron.physicsState.heronHead = plant.head ?? heron.physicsState.heronHead;
            heron.physicsState.heronVExit = plant.vExit ?? heron.physicsState.heronVExit;
            heron.physicsState.heronFlowRateLmin = plant.flowLmin ?? 0;
            heron.physicsState.heronPressureKPa = plant.pressureKPa ?? 0;
          }
        } else if (focus === 'kelvin') {
          const plant = segWasm.getModePlant();
          const kelvin = this.devices.kelvin;
          if (kelvin?.physicsState && plant) {
            kelvin.physicsState.kelvinV = plant.voltage ?? 0;
            kelvin.physicsState.kelvinVoltageN = plant.voltageN ?? 0;
            kelvin.physicsState.kelvinE = plant.E ?? 0;
            kelvin.physicsState.kelvinSparkTimer = plant.sparkTimer ?? 0;
          }
        } else if (focus === 'solar') {
          const plant = segWasm.getModePlant();
          const solar = this.devices.solar;
          if (solar && plant && typeof plant.battery === 'number') {
            solar.batteryCharge = plant.battery;
            if (solar.physicsState) solar.physicsState.batteryCharge = plant.battery;
          }
        }
      }
    } else {
      for (const subDt of simSteps) {
        if (subDt > 0) segOperator.step(subDt);
      }
    }
    this.segOmega = segOperator.physics.segOmega;
    this.corona = segOperator.physics.corona;
    this.time += deltaTime * speed;

    // Propagate current speedMult to all devices (needed by GPU compute uniforms)
    for (const device of Object.values(this.devices)) {
      device.speedMult = speed;
    }

    // Update speedVal label so the UI reflects the actual multiplier
    const speedValEl = document.getElementById('speedVal');
    if (speedValEl) speedValEl.textContent = speed.toFixed(2) + '×';

    // Update tachometer overlay
    this._updateTachometer();

    // Hardware twin: mirror segOperator plant → coils @ ~60 Hz; closed-loop viz
    this._updateHardwareTwin(deltaTime);

    // Update camera
    this.cameraController.updateCamera(deltaTime);
    
    // Record frame in profiler
    const totalParticles = Object.values(this.devices).reduce(
      (sum, d) => sum + (this.isDeviceActive(d.id) ? d.particleCount : 0), 0
    );
    this.profiler.recordFrame(deltaTime, totalParticles);

    // Update global uniforms with extended lighting data
    const viewProj = this.cameraController.getViewProjMatrix();
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
    
    this.device.queue.writeBuffer(this.globalUniformBuffer, 0, globalData);

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
    this.device.queue.writeBuffer(this.lightingUniformBuffer, 0, lightingData);

    // Update devices with quality scaling
    const qualityScale = this.profiler.qualityLevel * explainerState.getParticleCapScale();
    this.refreshSEGLayout(qualityScale);
    for (const device of Object.values(this.devices)) {
      if (this.isDeviceActive(device.id)) {
        device.update(deltaTime * speed, qualityScale);
      }
    }

    // Single telemetry write path after device physics (operator panel + gauges subscribe)
    const omega = this.segOmega || 0;
    const particleFlux = totalParticles * Math.max(0.05, this.speedMult);
    const scientific = {
      particleFlux,
      maxFieldMagnitude: 0.7048 * (0.35 + 0.65 * Math.min(1, Math.abs(omega))),
      avgEnergyDensity: 1.976e6 * (0.2 + 0.8 * Math.min(1, Math.abs(omega))),
      middleRingTorque: (this.devices.seg?.energyLevel ?? omega) * 12.0
    };
    telemetryHub.publishFrame({
      dt: deltaTime,
      view: this.currentView || 'overview',
      renderer: 'webgpu',
      devicePhysics: TelemetryHub.collectDevicePhysics(this.devices),
      scientific
    });
    if (this.integration) {
      this.integration.syncFromVisualizer(scientific);
      this.integration.update(deltaTime * 1000);
      this.integration.writeUniformsToBuffer();
    }

    if (this.isOverviewMode()) {
      for (const pipe of this.energyPipes) {
        pipe.update(deltaTime, this.devices, this.time);
      }
    }

    const enabledDevices = Object.values(this.devices).filter((d) => this.isDeviceActive(d.id));
    const targetGlobalEnergy = enabledDevices.length
      ? enabledDevices.reduce((sum, d) => sum + (d.energyLevel || 0), 0) / enabledDevices.length
      : 0.0;
    const globalSmooth = 1.0 - Math.exp(-Math.max(0.0, deltaTime) * 10.0);
    this.globalEnergyLevel += (targetGlobalEnergy - this.globalEnergyLevel) * globalSmooth;
    this._uploadSkyUniforms(this.globalEnergyLevel);

    if (this.segAnnotations?.enabled) {
      this.segAnnotations.update();
    }
    
    // Begin command encoding
    const encoder = this.device.createCommandEncoder();
    
    // ─── COMPUTE PASS: animate particles on GPU ───
    const computePass = encoder.beginComputePass({ label: 'particle-compute' });

    // SEG-specific compute: roller kinematics + RK4 flux line tracing.
    // These run first so rendering reads the freshly updated buffers.
    const segDevice = this.devices['seg'];
    if (segDevice && this.isDeviceActive('seg')) {
      if (segDevice.rollerComputePipeline && segDevice.rollerComputeBindGroup) {
        computePass.setPipeline(segDevice.rollerComputePipeline);
        computePass.setBindGroup(0, segDevice.rollerComputeBindGroup);
        computePass.dispatchWorkgroups(Math.ceil(MAX_ROLLERS / 64));
      }
      // RK4 flux line tracer: one thread per flux line (up to 108).
      if (segDevice.fluxTracerPipeline && segDevice.fluxTracerBindGroup &&
          this.profiler.qualityLevel > 0.32) {
        computePass.setPipeline(segDevice.fluxTracerPipeline);
        computePass.setBindGroup(0, segDevice.fluxTracerBindGroup);
        const fluxLines = this.segLayout?.totalFluxLines ?? 168;
        computePass.dispatchWorkgroups(Math.ceil(fluxLines / 64));
      }
    }

    for (const device of Object.values(this.devices)) {
      if (this.isDeviceActive(device.id) && device.computePipeline && device.computeBindGroup) {
        computePass.setPipeline(device.computePipeline);
        computePass.setBindGroup(0, device.computeBindGroup);
        const workgroups = Math.ceil((device.scaledParticleCount || device.particleCount) / 64);
        computePass.dispatchWorkgroups(workgroups);
      }
    }
    computePass.end();
    
    this.profiler.writeTimestamp(encoder, 0);
    
    const sceneView = (this.bloomSceneTexture)
      ? this.bloomSceneTexture.createView()
      : this.context.getCurrentTexture().createView();

    const renderPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: sceneView,
        clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store'
      }],
      depthStencilAttachment: WebGPUManager.depthStencilAttachment(this.depthAttachmentView)
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
    const scaledQuality = this.profiler.qualityLevel;
    for (const device of Object.values(this.devices)) {
      if (this.isDeviceActive(device.id)) {
        // Skip expensive VFX at low quality — keep core meshes visible.
        const skipEffects = scaledQuality < 0.5;
        device.render(renderPass, this.globalUniformBuffer, skipEffects);
      }
    }

    // Roschin–Godin magnetic wall shells (drawn after SEG so they overlay the scene).
    if (segDevice && this.isDeviceActive('seg')) {
      this.renderAnomalyWalls(renderPass, this.globalUniformBuffer, segDevice);
    }

    // Energy transfer pipes between devices (overview only).
    if (this.isOverviewMode() && this.energyPipePipeline && scaledQuality > 0.35) {
      for (const pipe of this.energyPipes) {
        pipe.render(renderPass, this.globalUniformBuffer, this.energyPipePipeline);
      }
    }

    renderPass.end();

    // Preserve this frame’s scene for next frame’s overdrive motion blur.
    if (this.bloomSceneTexture && this.prevSceneTexture) {
      encoder.copyTextureToTexture(
        { texture: this.bloomSceneTexture },
        { texture: this.prevSceneTexture },
        [this.canvas.width || 1, this.canvas.height || 1, 1]
      );
    }

    // ── Bloom post-processing ─────────────────────────────────────────────
    if (this.bloomExtractPipeline && this.bloomBlurPipeline && this.bloomCompositePipeline &&
        this.bloomSceneTexture && this.bloomBlurTexture && this.bloomTempTexture && this.prevSceneTexture && this.depthTexture) {
      // Update bloom parameters dynamically based on current speed
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
        this.device.queue.writeBuffer(
          this.bloomParamsBuffer, 0,
          packPostUniforms({
            width: w,
            height: h,
            preset,
            energy,
            speedMult: this.simRateController.speedMult,
            motionBlur
          })
        );
      }

      // Pass 1: extract bright areas → bloomTempTexture
      const extractPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.bloomTempTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear', storeOp: 'store'
        }]
      });
      extractPass.setPipeline(this.bloomExtractPipeline);
      extractPass.setBindGroup(0, this.pipelineCache.createBindGroup('bloomExtract', [
        { binding: 0, resource: this.bloomSceneTexture.createView() },
        { binding: 1, resource: this.bloomSampler },
        { binding: 2, resource: { buffer: this.bloomParamsBuffer } }
      ], 'bloom-extract-bg'));
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
      blurXPass.setBindGroup(0, this.pipelineCache.createBindGroup('bloomBlur', [
        { binding: 0, resource: this.bloomTempTexture.createView() },
        { binding: 1, resource: this.bloomSampler },
        { binding: 2, resource: { buffer: this.bloomParamsBuffer } },
        { binding: 3, resource: { buffer: this.bloomBlurDirXBuffer } }
      ], 'bloom-blur-x-bg'));
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
      blurYPass.setBindGroup(0, this.pipelineCache.createBindGroup('bloomBlur', [
        { binding: 0, resource: this.bloomBlurTexture.createView() },
        { binding: 1, resource: this.bloomSampler },
        { binding: 2, resource: { buffer: this.bloomParamsBuffer } },
        { binding: 3, resource: { buffer: this.bloomBlurDirYBuffer } }
      ], 'bloom-blur-y-bg'));
      blurYPass.draw(3);
      blurYPass.end();

      // Pass 4: composite scene + bloom → canvas with tonemap/post FX
      const compositePass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear', storeOp: 'store'
        }]
      });
      compositePass.setPipeline(this.bloomCompositePipeline);
      compositePass.setBindGroup(0, this.pipelineCache.createBindGroup('bloomComposite', [
        { binding: 0, resource: this.bloomSceneTexture.createView() },
        { binding: 1, resource: this.bloomTempTexture.createView() },
        { binding: 2, resource: this.bloomSampler },
        { binding: 3, resource: { buffer: this.bloomParamsBuffer } },
        { binding: 4, resource: this.depthSampleView },
        { binding: 5, resource: this.prevSceneTexture.createView() }
      ], 'bloom-composite-bg'));
      compositePass.draw(3);
      compositePass.end();
    }
    this.profiler.writeTimestamp(encoder, 1);
    
    this.device.queue.submit([encoder.finish()]);
    
    // Resolve timestamps asynchronously (guarded against overlapping map/submit)
    if (this.profiler.timingEnabled) {
      this.profiler.scheduleResolveTimestamps();
    }
    
    requestAnimationFrame((t) => this.render(t));
  }
};
