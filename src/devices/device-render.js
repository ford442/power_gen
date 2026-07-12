import { BindGroupCache } from '../renderers/shared/bind-group-cache.js';
import { cullSegRollerInstances, isCameraInsideSegRing } from '../renderers/shared/view-lod.js';

export const DeviceRenderMixin = {
  _ensureBgCache: function () {
    if (!this._bindGroupCache) this._bindGroupCache = new BindGroupCache();
    return this._bindGroupCache;
  },

  /**
   * Create or reuse a bind group. Keys must change when any underlying buffer is recreated.
   * Prefer this over raw pipelineCache.createBindGroup in hot paths.
   */
  _cacheBg: function (key, layoutName, entries, label) {
    const cache = this.visualizer.pipelineCache;
    if (!cache) {
      throw new Error(`[DeviceRender] pipelineCache missing for layout "${layoutName}"`);
    }
    return this._ensureBgCache().get(key, () =>
      cache.createBindGroup(layoutName, entries, label || key)
    );
  },

  _enhancedBindGroup: function (globalUniformBuffer, instanceBuffer, keySuffix = 'default') {
    const v = this.visualizer;
    const key = `enh:${this.id}:${keySuffix}`;
    return this._cacheBg(key, 'segEnhanced', [
      { binding: 0, resource: { buffer: globalUniformBuffer } },
      { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
      { binding: 2, resource: { buffer: instanceBuffer } },
      { binding: 3, resource: { buffer: this.materialUniformBuffer } },
      { binding: 4, resource: { buffer: v.segLayoutUniformBuffer } },
      { binding: 5, resource: { buffer: v.lightingUniformBuffer } },
      { binding: 6, resource: { buffer: v.materialTableBuffer } }
    ], `seg-enhanced-${this.id}-${keySuffix}`);
  },

  _rollerBindGroup: function (globalUniformBuffer, instanceBuffer, keySuffix = 'default') {
    return this._cacheBg(`roller:${this.id}:${keySuffix}`, 'roller', [
      { binding: 0, resource: { buffer: globalUniformBuffer } },
      { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
      { binding: 2, resource: { buffer: instanceBuffer } },
      { binding: 3, resource: { buffer: this.materialUniformBuffer } },
      { binding: 5, resource: { buffer: this.visualizer.materialTableBuffer } }
    ], `roller-${this.id}-${keySuffix}`);
  },

  renderDeviceMesh: function (renderPass, globalUniformBuffer) {
    const v = this.visualizer;
    if (!v.cylinderBuffer || !this.rollerPipeline || !this.rollerInstances) return;

    this.renderMode = 0;
    const deviceData = this._buildDeviceUniformData(this.renderMode);
    this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, deviceData);

    const cyl = v.cylinderBuffer;
    const count = this.geometry.meshCylinderCount || 0;
    if (count > 0) {
      renderPass.setPipeline(this.rollerPipeline);
      renderPass.setBindGroup(0, this._rollerBindGroup(globalUniformBuffer, this.rollerInstances, 'mesh'));
      renderPass.setVertexBuffer(0, cyl.vertexBuffer);
      renderPass.setIndexBuffer(cyl.indexBuffer, 'uint16');
      renderPass.drawIndexed(cyl.indexCount, count);
    }

    if (this.id === 'kelvin' && this.geometry.ringInstances && v.kelvinRingBuffer) {
      const ring = v.kelvinRingBuffer;
      const ringCount = this.geometry.meshRingCount || 0;
      if (ringCount > 0) {
        renderPass.setBindGroup(0, this._rollerBindGroup(globalUniformBuffer, this.geometry.ringInstances, 'ring'));
        renderPass.setVertexBuffer(0, ring.vertexBuffer);
        renderPass.setIndexBuffer(ring.indexBuffer, 'uint16');
        renderPass.drawIndexed(ring.indexCount, ringCount);
      }
    }

    if (this.geometry.tubeInstances && v.deviceTubeBuffer) {
      const tube = v.deviceTubeBuffer;
      const tubeCount = this.geometry.meshTubeCount || 0;
      if (tubeCount > 0) {
        renderPass.setBindGroup(0, this._rollerBindGroup(globalUniformBuffer, this.geometry.tubeInstances, 'tube'));
        renderPass.setVertexBuffer(0, tube.vertexBuffer);
        renderPass.setIndexBuffer(tube.indexBuffer, 'uint16');
        renderPass.drawIndexed(tube.indexCount, tubeCount);
      }
    }

    if (this.id === 'solar' && this.geometry.panelInstances && v.solarPanelBuffer) {
      const panel = v.solarPanelBuffer;
      const panelCount = this.geometry.meshPanelCount || 0;
      if (panelCount > 0) {
        renderPass.setBindGroup(0, this._rollerBindGroup(globalUniformBuffer, this.geometry.panelInstances, 'panel'));
        renderPass.setVertexBuffer(0, panel.vertexBuffer);
        renderPass.setIndexBuffer(panel.indexBuffer, 'uint16');
        renderPass.drawIndexed(panel.indexCount, panelCount);
      }
    }
  },

  render: function (renderPass, globalUniformBuffer, skipEffects = false) {
    // Prefer per-device scaled count from update(); fall back to quality × view LOD.
    const scaledCount = Math.max(
      0,
      Math.floor(
        this.scaledParticleCount
          ?? (this.particleCount * (this.visualizer.profiler?.qualityLevel ?? 1)
            * (this.visualizer.isOverviewMode?.() ? 0.48 : 1))
      )
    );

    // Render lab bench + frame (SEG structural support)
    if (this.id === 'seg' && !skipEffects) {
      this.renderGltfHousing(renderPass, globalUniformBuffer);
      this.renderFrame(renderPass, globalUniformBuffer);
    }

    // Render base first (for SEG)
    if (this.id === 'seg' && this.geometry.baseBuffer && !skipEffects) {
      this.renderBase(renderPass, globalUniformBuffer);
    }

    // Render stator rings (for SEG)
    if (this.id === 'seg' && this.geometry.statorRingBuffer && !skipEffects) {
      this.renderStatorRings(renderPass, globalUniformBuffer);
    }

    // Render wiring (for SEG) — fallback if enhanced wires not available
    if (this.id === 'seg' && this.geometry.wiringBuffer && !skipEffects && !this.visualizer.wireBuffers) {
      this.renderWiring(renderPass, globalUniformBuffer);
    }

    // Stand is drawn from renderFrame(); skip duplicate call here.

    // Render core (before rollers so rollers appear in front)
    if (this.id === 'seg' && !skipEffects) {
      this.renderCore(renderPass, globalUniformBuffer);
    }

    // Render pickup coils (outside the roller ring)
    if (this.id === 'seg' && !skipEffects) {
      this.renderPickupCoils(renderPass, globalUniformBuffer);
    }

    // Heron / Kelvin / Solar structural meshes (instanced cylinders + extras)
    if (this.id !== 'seg' && this.rollerInstances && this.rollerPipeline) {
      this.renderDeviceMesh(renderPass, globalUniformBuffer);
    }

    // Render wire harnesses between coils
    if (this.id === 'seg' && !skipEffects) {
      this.renderWires(renderPass, globalUniformBuffer);
    }

    if (this.id === 'seg' && this.rollerInstances && this.segEnhancedPipeline && !skipEffects) {
      // Reset renderMode to 0 (rollers)
      this.renderMode = 0;
      const deviceData = this._buildDeviceUniformData(this.renderMode);
      this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, deviceData);

      const layoutRollers = this.visualizer.segLayout?.totalRollers ?? 36;
      // Optional instance cull when the camera is inside the roller cylinder.
      const segPos = this.position || [0, 0, 0];
      const outerR = (this.visualizer.segLayout?.rings?.at?.(-1)?.orbitRadiusM
        ?? 5.5) * (this.visualizer.segLayout?.worldScale ?? 1);
      const cam = this.visualizer.camera?.camera;
      const inside = cam?.position
        ? isCameraInsideSegRing(cam.position, segPos, outerR)
        : false;
      const activeRollers = cullSegRollerInstances(
        layoutRollers,
        inside,
        this.visualizer.rollerInstanceCullEnabled !== false
      );

      const enhancedBindGroup = this._enhancedBindGroup(globalUniformBuffer, this.rollerInstances, 'rollers');

      renderPass.setPipeline(this.segEnhancedPipeline);
      renderPass.setBindGroup(0, enhancedBindGroup);
      renderPass.setVertexBuffer(0, this.visualizer.enhancedRollerBuffer.vertexBuffer);
      renderPass.setIndexBuffer(this.visualizer.enhancedRollerBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(this.visualizer.enhancedRollerBuffer.indexCount, activeRollers);
    }

    // Render electromagnet coils (SEG only) — reuse persistent coilMaterialBuffer
    if (this.id === 'seg' && this.electromagnetInstances && this.coilPipeline && !skipEffects
        && this.coilMaterialBuffer) {
      const deviceData = this._buildDeviceUniformData(this.renderMode);
      this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, deviceData);

      const coilBindGroup = this._cacheBg(`coil-em:${this.id}`, 'coil', [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 2, resource: { buffer: this.electromagnetInstances } },
        { binding: 3, resource: { buffer: this.coilMaterialBuffer } }
      ], 'coil-em-bg');

      renderPass.setPipeline(this.coilPipeline);
      renderPass.setBindGroup(0, coilBindGroup);
      renderPass.setVertexBuffer(0, this.visualizer.cylinderBuffer.vertexBuffer);
      renderPass.setIndexBuffer(this.visualizer.cylinderBuffer.indexBuffer, 'uint16');
      const numCoils = this.visualizer.emController?.numCoils || 8;
      renderPass.drawIndexed(this.visualizer.cylinderBuffer.indexCount, numCoils);
    }

    // Battery gauge (solar device only) — drawn after panel so it sits on top
    if (this.id === 'solar' && this.gaugeInstanceBuffer) {
      const gaugeBindGroup = this._cacheBg(`gauge:${this.id}`, 'roller', [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 2, resource: { buffer: this.gaugeInstanceBuffer } },
        { binding: 3, resource: { buffer: this.materialUniformBuffer } },
        { binding: 5, resource: { buffer: this.visualizer.materialTableBuffer } }
      ], 'solar-gauge-bg');

      renderPass.setPipeline(this.rollerPipeline);
      renderPass.setBindGroup(0, gaugeBindGroup);
      renderPass.setVertexBuffer(0, this.visualizer.batteryGaugeVertexBuffer);
      renderPass.setIndexBuffer(this.visualizer.batteryGaugeIndexBuffer, 'uint16');
      renderPass.drawIndexed(this.visualizer.batteryGaugeIndexCount, 1);
    }

    // Render RK4 flux line segments (physically accurate, |B|-driven color).
    // Replaces the legacy circular-path field line render with physically
    // traced billboard quads.  Falls back gracefully if pipeline is absent.
    if (this.id === 'seg' && this.fluxSegmentRenderBindGroup && this.pipelineManager.fluxSegmentPipeline && this.fieldLineEnabled && !skipEffects) {
      const qualityScale = this.visualizer.profiler.qualityLevel;
      const totalSegments = Math.floor(this.geometry.fluxTotalSegments * qualityScale);

      renderPass.setPipeline(this.pipelineManager.fluxSegmentPipeline);
      renderPass.setBindGroup(0, this.fluxSegmentRenderBindGroup);
      renderPass.draw(4, totalSegments);
    } else if (this.id === 'seg' && this.fieldLineParticles && this.fieldLineEnabled && !skipEffects) {
      // Fallback: legacy circular-path field line particles
      const qualityScale = this.visualizer.profiler.qualityLevel;
      const fieldLineCount = Math.floor(this.fieldLineCount * qualityScale);

      const fieldLineBindGroup = this._cacheBg(`field:${this.id}`, 'fieldParticles', [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 4, resource: { buffer: this.fieldLineParticles } }
      ], 'field-line-bg');

      renderPass.setPipeline(this.fieldLinePipeline);
      renderPass.setBindGroup(0, fieldLineBindGroup);
      renderPass.draw(4, fieldLineCount);
    }

    // Render energy arcs (between nearby rollers)
    if (this.id === 'seg' && this.arcSegments && this.energyArcEnabled && !skipEffects) {
      const qualityScale = this.visualizer.profiler.qualityLevel;
      if (qualityScale > 0.5) {
        const arcCount = Math.floor(this.arcSegmentCount * qualityScale);

        const arcBindGroup = this._cacheBg(`arc:${this.id}`, 'fieldParticles', [
          { binding: 0, resource: { buffer: globalUniformBuffer } },
          { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
          { binding: 4, resource: { buffer: this.arcSegments } }
        ], 'energy-arc-bg');

        renderPass.setPipeline(this.energyArcPipeline);
        renderPass.setBindGroup(0, arcBindGroup);
        renderPass.draw(4, arcCount * 2);
      }
    }

    // Device-specific flow paths (siphon / electrostatic / photon beams)
    if (this.geometry.flowPathParticles && this.fieldLinePipeline && !skipEffects) {
      const flowBindGroup = this._cacheBg(`flow:${this.id}`, 'fieldParticles', [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 4, resource: { buffer: this.geometry.flowPathParticles } }
      ], 'flow-path-bg');
      renderPass.setPipeline(this.fieldLinePipeline);
      renderPass.setBindGroup(0, flowBindGroup);
      renderPass.draw(4, this.geometry.flowPathCount);
    }

    const particleBindGroup = this._cacheBg(`part:${this.id}`, 'particle', [
      { binding: 0, resource: { buffer: globalUniformBuffer } },
      { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
      { binding: 3, resource: { buffer: this.materialUniformBuffer } },
      { binding: 4, resource: { buffer: this.particles } }
    ], 'particle-bg');

    renderPass.setPipeline(this.particlePipeline);
    renderPass.setBindGroup(0, particleBindGroup);
    renderPass.draw(4, scaledCount);

    if (this.effectParticleCount > 0 && this.effectsParticles && !skipEffects) {
      const effectsBindGroup = this._cacheBg(`fx:${this.id}`, 'particle', [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 3, resource: { buffer: this.materialUniformBuffer } },
        { binding: 4, resource: { buffer: this.effectsParticles } }
      ], 'effects-particle-bg');
      renderPass.setPipeline(this.particlePipeline);
      renderPass.setBindGroup(0, effectsBindGroup);
      renderPass.draw(4, this.effectParticleCount);
    }
  },

  renderBase: function (renderPass, globalUniformBuffer) {
    const v = this.visualizer;
    if (!v.basePlateBuffer || !v.baseInstanceBuffer) return;

    this.renderMode = 1;
    const deviceData = this._buildDeviceUniformData(this.renderMode);
    this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, deviceData);

    if (this.segEnhancedPipeline && v.lightingUniformBuffer) {
      const bindGroup = this._enhancedBindGroup(globalUniformBuffer, v.baseInstanceBuffer, 'base');
      renderPass.setPipeline(this.segEnhancedPipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, v.basePlateBuffer.vertexBuffer);
      renderPass.setIndexBuffer(v.basePlateBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(v.basePlateBuffer.indexCount, 1);
    }
  },

  renderGltfHousing: function (renderPass, globalUniformBuffer) {
    const v = this.visualizer;
    if (this.id !== 'seg') return;
    if (!v.gltfHousingEnabled || !v.gltfHousingDrawables?.length) return;
    if (!this.segEnhancedPipeline || !v.lightingUniformBuffer) return;
    // SEG focus only — overview keeps procedural frame without housing shell
    if (v.currentView && v.currentView !== 'seg') return;

    this.renderMode = 0;
    const deviceData = this._buildDeviceUniformData(this.renderMode);
    this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, deviceData);

    for (const drawable of v.gltfHousingDrawables) {
      const bindGroup = this._enhancedBindGroup(
        globalUniformBuffer,
        drawable.instanceBuffer,
        `gltf:${drawable.name}`
      );
      renderPass.setPipeline(this.segEnhancedPipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, drawable.gpu.vertexBuffer);
      renderPass.setIndexBuffer(drawable.gpu.indexBuffer, 'uint16');
      renderPass.drawIndexed(drawable.gpu.indexCount, 1);
    }
  },

  renderFrame: function (renderPass, globalUniformBuffer) {
    const v = this.visualizer;
    if (v.segFrameLevel === 'off' || !this.segEnhancedPipeline || !v.segFrameBuffers) return;

    const drawPart = (geom, instanceBuffer, renderMode = 0, keySuffix = 'frame') => {
      if (!geom || !instanceBuffer) return;
      this.renderMode = renderMode;
      const deviceData = this._buildDeviceUniformData(renderMode);
      this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, deviceData);
      const bindGroup = this._enhancedBindGroup(globalUniformBuffer, instanceBuffer, keySuffix);
      renderPass.setPipeline(this.segEnhancedPipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, geom.vertexBuffer);
      renderPass.setIndexBuffer(geom.indexBuffer, 'uint16');
      renderPass.drawIndexed(geom.indexCount, 1);
    };

    const fb = v.segFrameBuffers;
    const inst = v.frameStructuralInstanceBuffer;
    const benchInst = v.frameLabBenchInstanceBuffer || inst;
    const skipLabBench = v.gltfHousingEnabled && v.gltfHousingDrawables?.length;

    if (!skipLabBench) {
      drawPart(fb.labBench, benchInst, 1, 'labBench');
    }
    this.renderStand(renderPass, globalUniformBuffer);
    drawPart(fb.structural, inst, 0, 'structural');
    if (v.segFrameLevel === 'full') {
      drawPart(fb.controlBox, v.frameControlInstanceBuffer, 0, 'controlBox');
      drawPart(fb.safetyCage, v.frameCageInstanceBuffer, 0, 'safetyCage');
    }
  },

  renderStatorRings: function (renderPass, globalUniformBuffer) {
    if (!this.geometry.statorRingBuffer) return;
    const v = this.visualizer;
    
    // Set renderMode to 2 (stator)
    this.renderMode = 2;
    const deviceData = this._buildDeviceUniformData(this.renderMode);
    this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, deviceData);
    
    // Use enhanced PBR pipeline if available (with UV geometry)
    if (this.segEnhancedPipeline && v.statorRingUVBuffer && v.lightingUniformBuffer) {
      const bindGroup = this._enhancedBindGroup(globalUniformBuffer, this.geometry.statorRingBuffer, 'stator');

      renderPass.setPipeline(this.segEnhancedPipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, v.statorRingUVBuffer.vertexBuffer);
      renderPass.setIndexBuffer(v.statorRingUVBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(v.statorRingUVBuffer.indexCount, 3); // 3 rings
    } else {
      // Fallback to basic Blinn-Phong pipeline
      const bindGroup = this._rollerBindGroup(globalUniformBuffer, this.geometry.statorRingBuffer, 'stator-fb');

      renderPass.setPipeline(this.rollerPipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, v.cylinderBuffer.vertexBuffer);
      renderPass.setIndexBuffer(v.cylinderBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(v.cylinderBuffer.indexCount, 3); // 3 rings
    }
  },

  renderWiring: function (renderPass, globalUniformBuffer) {
    if (!this.geometry.wiringBuffer) return;
    const v = this.visualizer;
    
    // Set renderMode to 3 (wiring)
    this.renderMode = 3;
    const deviceData = this._buildDeviceUniformData(this.renderMode);
    this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, deviceData);
    
    // Use enhanced PBR pipeline if available (with UV geometry)
    if (this.segEnhancedPipeline && v.wiringUVBuffer && v.lightingUniformBuffer) {
      const bindGroup = this._enhancedBindGroup(globalUniformBuffer, this.geometry.wiringBuffer, 'wiring');

      renderPass.setPipeline(this.segEnhancedPipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, v.wiringUVBuffer.vertexBuffer);
      renderPass.setIndexBuffer(v.wiringUVBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(v.wiringUVBuffer.indexCount, 8); // 8 wires
    } else {
      // Fallback to basic Blinn-Phong pipeline
      const bindGroup = this._rollerBindGroup(globalUniformBuffer, this.geometry.wiringBuffer, 'wiring-fb');

      renderPass.setPipeline(this.rollerPipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, v.cylinderBuffer.vertexBuffer);
      renderPass.setIndexBuffer(v.cylinderBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(v.cylinderBuffer.indexCount, 8); // 8 wires
    }
  },

  renderCore: function (renderPass, globalUniformBuffer) {
    if (!this.segEnhancedPipeline || !this.config.core) return;
    const v = this.visualizer;
    if (!v.coreShaftBuffer) return;

    // Helper to draw a component with the enhanced pipeline
    const drawComponent = (geomBuffer, instanceBuffer, keySuffix, instanceCount = 1) => {
      const bindGroup = this._enhancedBindGroup(globalUniformBuffer, instanceBuffer, keySuffix);
      renderPass.setPipeline(this.segEnhancedPipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, geomBuffer.vertexBuffer);
      renderPass.setIndexBuffer(geomBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(geomBuffer.indexCount, instanceCount);
    };

    // Render central bearing shaft
    if (v.coreShaftBuffer && this.shaftInstanceBuffer) {
      drawComponent(v.coreShaftBuffer, this.shaftInstanceBuffer, 'shaft', 1);
    }

    // Render magnetic core (central cylinder)
    if (v.coreMagnetBuffer && this.magnetInstanceBuffer) {
      drawComponent(v.coreMagnetBuffer, this.magnetInstanceBuffer, 'magnet', 1);
    }

    // Render top plate
    if (v.corePlateBuffer && this.topPlateInstanceBuffer) {
      drawComponent(v.corePlateBuffer, this.topPlateInstanceBuffer, 'topPlate', 1);
    }

    // Render bottom plate
    if (v.corePlateBuffer && this.bottomPlateInstanceBuffer) {
      drawComponent(v.corePlateBuffer, this.bottomPlateInstanceBuffer, 'bottomPlate', 1);
    }

    // Render bolts
    if (v.coreBoltBuffer && v.coreBoltInstanceBuffer) {
      drawComponent(v.coreBoltBuffer, v.coreBoltInstanceBuffer, 'bolts', v.coreBoltPositions.length / 3);
    }
  },

  _ensureRingUniformBuffers: function () {
    if (this._topRingUniformBuffer && this._bottomRingUniformBuffer) return;
    this._topRingUniformBuffer = this.device.createBuffer({
      label: `${this.id}-top-ring-uniforms`,
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this._bottomRingUniformBuffer = this.device.createBuffer({
      label: `${this.id}-bottom-ring-uniforms`,
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    // Bind groups key off these buffers — invalidate if recreated.
    this._ensureBgCache().invalidate(`ring-top:${this.id}`);
    this._ensureBgCache().invalidate(`ring-bot:${this.id}`);
  },

  renderPickupCoils: function (renderPass, globalUniformBuffer) {
    if (!this.coilInstances || !this.coilPipeline || !this.ringPipeline) return;
    if (!this.visualizer.connectionRingBuffer || !this.visualizer.coilBuffer) return;
    if (!this.coilMaterialBuffer || !this.ringMaterialBuffer) return;

    this.renderMode = 0;
    const numCoils = 24;
    this._ensureRingUniformBuffers();

    // Render top connection ring (at y = +2.0)
    const topRingDeviceData = new Float32Array(12);
    topRingDeviceData.set(this._buildDeviceUniformData(this.renderMode, 2.0));
    this.device.queue.writeBuffer(this._topRingUniformBuffer, 0, topRingDeviceData);

    const topRingBindGroup = this._cacheBg(`ring-top:${this.id}`, 'segEnhanced', [
      { binding: 0, resource: { buffer: globalUniformBuffer } },
      { binding: 1, resource: { buffer: this._topRingUniformBuffer } },
      { binding: 3, resource: { buffer: this.ringMaterialBuffer } }
    ], 'top-ring-bg');

    renderPass.setPipeline(this.ringPipeline);
    renderPass.setBindGroup(0, topRingBindGroup);
    renderPass.setVertexBuffer(0, this.visualizer.connectionRingBuffer.vertexBuffer);
    renderPass.setIndexBuffer(this.visualizer.connectionRingBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(this.visualizer.connectionRingBuffer.indexCount);

    // Render bottom connection ring (at y = -2.0)
    const bottomRingDeviceData = new Float32Array(12);
    bottomRingDeviceData.set(this._buildDeviceUniformData(this.renderMode, -2.0));
    this.device.queue.writeBuffer(this._bottomRingUniformBuffer, 0, bottomRingDeviceData);

    const bottomRingBindGroup = this._cacheBg(`ring-bot:${this.id}`, 'segEnhanced', [
      { binding: 0, resource: { buffer: globalUniformBuffer } },
      { binding: 1, resource: { buffer: this._bottomRingUniformBuffer } },
      { binding: 3, resource: { buffer: this.ringMaterialBuffer } }
    ], 'bottom-ring-bg');

    renderPass.setBindGroup(0, bottomRingBindGroup);
    renderPass.drawIndexed(this.visualizer.connectionRingBuffer.indexCount);

    // Render coils
    const coilBindGroup = this._cacheBg(`coil-pickup:${this.id}`, 'coil', [
      { binding: 0, resource: { buffer: globalUniformBuffer } },
      { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
      { binding: 2, resource: { buffer: this.coilInstances } },
      { binding: 3, resource: { buffer: this.coilMaterialBuffer } }
    ], 'pickup-coil-bg');

    renderPass.setPipeline(this.coilPipeline);
    renderPass.setBindGroup(0, coilBindGroup);
    renderPass.setVertexBuffer(0, this.visualizer.coilBuffer.vertexBuffer);
    renderPass.draw(this.visualizer.coilBuffer.vertexCount, numCoils);
  },

  renderStand: function (renderPass, globalUniformBuffer) {
    if (!this.segEnhancedPipeline || !this.visualizer.standBuffer) return;
    const v = this.visualizer;
    const inst = v.frameStructuralInstanceBuffer || this.shaftInstanceBuffer;

    this.renderMode = 0;
    const deviceData = this._buildDeviceUniformData(this.renderMode);
    this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, deviceData);

    const bindGroup = this._enhancedBindGroup(globalUniformBuffer, inst, 'stand');
    renderPass.setPipeline(this.segEnhancedPipeline);
    renderPass.setBindGroup(0, bindGroup);
    renderPass.setVertexBuffer(0, v.standBuffer.vertexBuffer);
    renderPass.setIndexBuffer(v.standBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(v.standBuffer.indexCount, 1);
  },

  renderWires: function (renderPass, globalUniformBuffer) {
    if (!this.segEnhancedPipeline || !this.visualizer.wireBuffers) return;
    const v = this.visualizer;

    // Shared bind group (same instance buffer for all wire segments)
    const bindGroup = this._enhancedBindGroup(globalUniformBuffer, this.shaftInstanceBuffer, 'wires');
    renderPass.setPipeline(this.segEnhancedPipeline);
    renderPass.setBindGroup(0, bindGroup);
    for (let i = 0; i < v.wireBuffers.length; i++) {
      const wire = v.wireBuffers[i];
      renderPass.setVertexBuffer(0, wire.vertexBuffer);
      renderPass.setIndexBuffer(wire.indexBuffer, 'uint16');
      renderPass.drawIndexed(wire.indexCount, 1);
    }
  },

};

