export const DeviceRenderMixin = {
  _enhancedBindGroup: function (globalUniformBuffer, instanceBuffer) {
    const v = this.visualizer;
    return this.device.createBindGroup({
      layout: this.segEnhancedPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 2, resource: { buffer: instanceBuffer } },
        { binding: 3, resource: { buffer: this.materialUniformBuffer } },
        { binding: 4, resource: { buffer: v.segLayoutUniformBuffer } },
        { binding: 5, resource: { buffer: v.lightingUniformBuffer } },
        { binding: 6, resource: { buffer: v.materialTableBuffer } }
      ]
    });
  },

  _rollerBindGroup: function (globalUniformBuffer, instanceBuffer) {
    return this.device.createBindGroup({
      layout: this.rollerPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 2, resource: { buffer: instanceBuffer } },
        { binding: 3, resource: { buffer: this.materialUniformBuffer } },
        { binding: 5, resource: { buffer: this.visualizer.materialTableBuffer } }
      ]
    });
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
      renderPass.setBindGroup(0, this._rollerBindGroup(globalUniformBuffer, this.rollerInstances));
      renderPass.setVertexBuffer(0, cyl.vertexBuffer);
      renderPass.setIndexBuffer(cyl.indexBuffer, 'uint16');
      renderPass.drawIndexed(cyl.indexCount, count);
    }

    if (this.id === 'kelvin' && this.geometry.ringInstances && v.kelvinRingBuffer) {
      const ring = v.kelvinRingBuffer;
      const ringCount = this.geometry.meshRingCount || 0;
      if (ringCount > 0) {
        renderPass.setBindGroup(0, this._rollerBindGroup(globalUniformBuffer, this.geometry.ringInstances));
        renderPass.setVertexBuffer(0, ring.vertexBuffer);
        renderPass.setIndexBuffer(ring.indexBuffer, 'uint16');
        renderPass.drawIndexed(ring.indexCount, ringCount);
      }
    }

    if (this.id === 'solar' && this.geometry.panelInstances && v.solarPanelBuffer) {
      const panel = v.solarPanelBuffer;
      const panelCount = this.geometry.meshPanelCount || 0;
      if (panelCount > 0) {
        renderPass.setBindGroup(0, this._rollerBindGroup(globalUniformBuffer, this.geometry.panelInstances));
        renderPass.setVertexBuffer(0, panel.vertexBuffer);
        renderPass.setIndexBuffer(panel.indexBuffer, 'uint16');
        renderPass.drawIndexed(panel.indexCount, panelCount);
      }
    }
  },

  render: function (renderPass, globalUniformBuffer, skipEffects = false) {
    const scaledCount = Math.floor(this.particleCount * this.visualizer.profiler.qualityLevel);

    // Render lab bench + frame (SEG structural support)
    if (this.id === 'seg' && !skipEffects) {
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

      const activeRollers = this.visualizer.segLayout?.totalRollers ?? 36;

      const enhancedBindGroup = this._enhancedBindGroup(globalUniformBuffer, this.rollerInstances);

      renderPass.setPipeline(this.segEnhancedPipeline);
      renderPass.setBindGroup(0, enhancedBindGroup);
      renderPass.setVertexBuffer(0, this.visualizer.enhancedRollerBuffer.vertexBuffer);
      renderPass.setIndexBuffer(this.visualizer.enhancedRollerBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(this.visualizer.enhancedRollerBuffer.indexCount, activeRollers);
    }

    // Render electromagnet coils (SEG only)
    if (this.id === 'seg' && this.electromagnetInstances && this.coilPipeline && !skipEffects) {
      const deviceData = this._buildDeviceUniformData(this.renderMode);
      this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, deviceData);

      // Coil material: copper base with orange glow potential
      const coilMaterialData = new Float32Array([
        0.75, 0.45, 0.25, 0,    // baseColor + pad
        1.0, 0.55, 0.0, 2.5      // glowColor (orange) + emission
      ]);
      const coilMaterialBuffer = this.device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(coilMaterialBuffer, 0, coilMaterialData);

      const coilBindGroup = this.device.createBindGroup({
        layout: this.coilPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: globalUniformBuffer } },
          { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
          { binding: 2, resource: { buffer: this.electromagnetInstances } },
          { binding: 3, resource: { buffer: coilMaterialBuffer } }
        ]
      });

      renderPass.setPipeline(this.coilPipeline);
      renderPass.setBindGroup(0, coilBindGroup);
      renderPass.setVertexBuffer(0, this.visualizer.cylinderBuffer.vertexBuffer);
      renderPass.setIndexBuffer(this.visualizer.cylinderBuffer.indexBuffer, 'uint16');
      const numCoils = this.visualizer.emController?.numCoils || 8;
      renderPass.drawIndexed(this.visualizer.cylinderBuffer.indexCount, numCoils);

      coilMaterialBuffer.destroy();
    }

    // Battery gauge (solar device only) — drawn after panel so it sits on top
    if (this.id === 'solar' && this.gaugeInstanceBuffer) {
      const gaugeBindGroup = this.device.createBindGroup({
        layout: this.rollerPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: globalUniformBuffer } },
          { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
          { binding: 2, resource: { buffer: this.gaugeInstanceBuffer } },
          { binding: 3, resource: { buffer: this.materialUniformBuffer } },
          { binding: 5, resource: { buffer: this.visualizer.materialTableBuffer } }
        ]
      });

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

      const fieldLineBindGroup = this.device.createBindGroup({
        layout: this.fieldLinePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: globalUniformBuffer } },
          { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
          { binding: 4, resource: { buffer: this.fieldLineParticles } }
        ]
      });

      renderPass.setPipeline(this.fieldLinePipeline);
      renderPass.setBindGroup(0, fieldLineBindGroup);
      renderPass.draw(4, fieldLineCount);
    }

    // Render energy arcs (between nearby rollers)
    if (this.id === 'seg' && this.arcSegments && this.energyArcEnabled && !skipEffects) {
      const qualityScale = this.visualizer.profiler.qualityLevel;
      if (qualityScale > 0.5) {
        const arcCount = Math.floor(this.arcSegmentCount * qualityScale);

        const arcBindGroup = this.device.createBindGroup({
          layout: this.energyArcPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: globalUniformBuffer } },
            { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
            { binding: 4, resource: { buffer: this.arcSegments } }
          ]
        });

        renderPass.setPipeline(this.energyArcPipeline);
        renderPass.setBindGroup(0, arcBindGroup);
        renderPass.draw(4, arcCount * 2);
      }
    }

    // Device-specific flow paths (siphon / electrostatic / photon beams)
    if (this.geometry.flowPathParticles && this.fieldLinePipeline && !skipEffects) {
      const flowBindGroup = this.device.createBindGroup({
        layout: this.fieldLinePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: globalUniformBuffer } },
          { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
          { binding: 4, resource: { buffer: this.geometry.flowPathParticles } }
        ]
      });
      renderPass.setPipeline(this.fieldLinePipeline);
      renderPass.setBindGroup(0, flowBindGroup);
      renderPass.draw(4, this.geometry.flowPathCount);
    }

    const particleBindGroup = this.device.createBindGroup({
      layout: this.particlePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 3, resource: { buffer: this.materialUniformBuffer } },
        { binding: 4, resource: { buffer: this.particles } }
      ]
    });

    renderPass.setPipeline(this.particlePipeline);
    renderPass.setBindGroup(0, particleBindGroup);
    renderPass.draw(4, scaledCount);

    if (this.effectParticleCount > 0 && this.effectsParticles && !skipEffects) {
      const effectsBindGroup = this.device.createBindGroup({
        layout: this.particlePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: globalUniformBuffer } },
          { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
          { binding: 3, resource: { buffer: this.materialUniformBuffer } },
          { binding: 4, resource: { buffer: this.effectsParticles } }
        ]
      });
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
      const bindGroup = this._enhancedBindGroup(globalUniformBuffer, v.baseInstanceBuffer);
      renderPass.setPipeline(this.segEnhancedPipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, v.basePlateBuffer.vertexBuffer);
      renderPass.setIndexBuffer(v.basePlateBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(v.basePlateBuffer.indexCount, 1);
    }
  },

  renderFrame: function (renderPass, globalUniformBuffer) {
    const v = this.visualizer;
    if (v.segFrameLevel === 'off' || !this.segEnhancedPipeline || !v.segFrameBuffers) return;

    const drawPart = (geom, instanceBuffer, renderMode = 0) => {
      if (!geom || !instanceBuffer) return;
      this.renderMode = renderMode;
      const deviceData = this._buildDeviceUniformData(renderMode);
      this.device.queue.writeBuffer(this.deviceUniformBuffer, 0, deviceData);
      const bindGroup = this._enhancedBindGroup(globalUniformBuffer, instanceBuffer);
      renderPass.setPipeline(this.segEnhancedPipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, geom.vertexBuffer);
      renderPass.setIndexBuffer(geom.indexBuffer, 'uint16');
      renderPass.drawIndexed(geom.indexCount, 1);
    };

    const fb = v.segFrameBuffers;
    const inst = v.frameStructuralInstanceBuffer;
    const benchInst = v.frameLabBenchInstanceBuffer || inst;

    drawPart(fb.labBench, benchInst, 1);
    this.renderStand(renderPass, globalUniformBuffer);
    drawPart(fb.structural, inst, 0);
    if (v.segFrameLevel === 'full') {
      drawPart(fb.controlBox, v.frameControlInstanceBuffer, 0);
      drawPart(fb.safetyCage, v.frameCageInstanceBuffer, 0);
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
      const bindGroup = this._enhancedBindGroup(globalUniformBuffer, this.geometry.statorRingBuffer);

      renderPass.setPipeline(this.segEnhancedPipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, v.statorRingUVBuffer.vertexBuffer);
      renderPass.setIndexBuffer(v.statorRingUVBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(v.statorRingUVBuffer.indexCount, 3); // 3 rings
    } else {
      // Fallback to basic Blinn-Phong pipeline
      const bindGroup = this.device.createBindGroup({
        layout: this.rollerPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: globalUniformBuffer } },
          { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
          { binding: 2, resource: { buffer: this.geometry.statorRingBuffer } },
          { binding: 3, resource: { buffer: this.materialUniformBuffer } },
          { binding: 5, resource: { buffer: this.visualizer.materialTableBuffer } }
        ]
      });

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
      const bindGroup = this._enhancedBindGroup(globalUniformBuffer, this.geometry.wiringBuffer);

      renderPass.setPipeline(this.segEnhancedPipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, v.wiringUVBuffer.vertexBuffer);
      renderPass.setIndexBuffer(v.wiringUVBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(v.wiringUVBuffer.indexCount, 8); // 8 wires
    } else {
      // Fallback to basic Blinn-Phong pipeline
      const bindGroup = this.device.createBindGroup({
        layout: this.rollerPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: globalUniformBuffer } },
          { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
          { binding: 2, resource: { buffer: this.geometry.wiringBuffer } },
          { binding: 3, resource: { buffer: this.materialUniformBuffer } },
          { binding: 5, resource: { buffer: this.visualizer.materialTableBuffer } }
        ]
      });

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
    const drawComponent = (geomBuffer, instanceBuffer, instanceCount = 1) => {
      const bindGroup = this._enhancedBindGroup(globalUniformBuffer, instanceBuffer);
      renderPass.setPipeline(this.segEnhancedPipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, geomBuffer.vertexBuffer);
      renderPass.setIndexBuffer(geomBuffer.indexBuffer, 'uint16');
      renderPass.drawIndexed(geomBuffer.indexCount, instanceCount);
    };

    // Render central bearing shaft
    if (v.coreShaftBuffer && this.shaftInstanceBuffer) {
      drawComponent(v.coreShaftBuffer, this.shaftInstanceBuffer, 1);
    }

    // Render magnetic core (central cylinder)
    if (v.coreMagnetBuffer && this.magnetInstanceBuffer) {
      drawComponent(v.coreMagnetBuffer, this.magnetInstanceBuffer, 1);
    }

    // Render top plate
    if (v.corePlateBuffer && this.topPlateInstanceBuffer) {
      drawComponent(v.corePlateBuffer, this.topPlateInstanceBuffer, 1);
    }

    // Render bottom plate
    if (v.corePlateBuffer && this.bottomPlateInstanceBuffer) {
      drawComponent(v.corePlateBuffer, this.bottomPlateInstanceBuffer, 1);
    }

    // Render bolts
    if (v.coreBoltBuffer && v.coreBoltInstanceBuffer) {
      drawComponent(v.coreBoltBuffer, v.coreBoltInstanceBuffer, v.coreBoltPositions.length / 3);
    }
  },

  renderPickupCoils: function (renderPass, globalUniformBuffer) {
    if (!this.coilInstances || !this.coilPipeline || !this.ringPipeline) return;
    if (!this.visualizer.connectionRingBuffer || !this.visualizer.coilBuffer) return;

    this.renderMode = 0;
    const numCoils = 24;

    // Render top connection ring (at y = +2.0)
    const topRingDeviceData = new Float32Array(12);
    topRingDeviceData.set(this._buildDeviceUniformData(this.renderMode, 2.0));
    const topRingDeviceBuffer = this.device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(topRingDeviceBuffer, 0, topRingDeviceData);

    const topRingBindGroup = this.device.createBindGroup({
      layout: this.ringPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: topRingDeviceBuffer } },
        { binding: 3, resource: { buffer: this.ringMaterialBuffer } }
      ]
    });

    renderPass.setPipeline(this.ringPipeline);
    renderPass.setBindGroup(0, topRingBindGroup);
    renderPass.setVertexBuffer(0, this.visualizer.connectionRingBuffer.vertexBuffer);
    renderPass.setIndexBuffer(this.visualizer.connectionRingBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(this.visualizer.connectionRingBuffer.indexCount);

    // Render bottom connection ring (at y = -2.0)
    const bottomRingDeviceData = new Float32Array(12);
    bottomRingDeviceData.set(this._buildDeviceUniformData(this.renderMode, -2.0));
    const bottomRingDeviceBuffer = this.device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(bottomRingDeviceBuffer, 0, bottomRingDeviceData);

    const bottomRingBindGroup = this.device.createBindGroup({
      layout: this.ringPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: bottomRingDeviceBuffer } },
        { binding: 3, resource: { buffer: this.ringMaterialBuffer } }
      ]
    });

    renderPass.setBindGroup(0, bottomRingBindGroup);
    renderPass.drawIndexed(this.visualizer.connectionRingBuffer.indexCount);

    // Render coils
    const coilBindGroup = this.device.createBindGroup({
      layout: this.coilPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: this.deviceUniformBuffer } },
        { binding: 2, resource: { buffer: this.coilInstances } },
        { binding: 3, resource: { buffer: this.coilMaterialBuffer } }
      ]
    });

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

    const bindGroup = this._enhancedBindGroup(globalUniformBuffer, inst);
    renderPass.setPipeline(this.segEnhancedPipeline);
    renderPass.setBindGroup(0, bindGroup);
    renderPass.setVertexBuffer(0, v.standBuffer.vertexBuffer);
    renderPass.setIndexBuffer(v.standBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(v.standBuffer.indexCount, 1);
  },

  renderWires: function (renderPass, globalUniformBuffer) {
    if (!this.segEnhancedPipeline || !this.visualizer.wireBuffers) return;
    const v = this.visualizer;

    for (let i = 0; i < v.wireBuffers.length; i++) {
      const wire = v.wireBuffers[i];
      const bindGroup = this._enhancedBindGroup(globalUniformBuffer, this.shaftInstanceBuffer);
      renderPass.setPipeline(this.segEnhancedPipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, wire.vertexBuffer);
      renderPass.setIndexBuffer(wire.indexBuffer, 'uint16');
      renderPass.drawIndexed(wire.indexCount, 1);
    }
  },

};
