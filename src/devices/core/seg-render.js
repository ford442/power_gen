import { cullSegRollerInstances, isCameraInsideSegRing } from '../../renderers/shared/view-lod.js';

/**
 * WebGPU draw path for SEG — housing, frame, rollers, flux, arcs.
 * Called from DeviceRenderMixin before shared particles / flow paths.
 */
export function drawSegWebgpu(instance, renderPass, globalUniformBuffer, skipEffects) {
  if (skipEffects) return;

  instance.renderGltfHousing(renderPass, globalUniformBuffer);
  instance.renderFrame(renderPass, globalUniformBuffer);

  if (instance.geometry.baseBuffer) {
    instance.renderBase(renderPass, globalUniformBuffer);
  }
  if (instance.geometry.statorRingBuffer) {
    instance.renderStatorRings(renderPass, globalUniformBuffer);
  }
  if (instance.geometry.wiringBuffer && !instance.visualizer.wireBuffers) {
    instance.renderWiring(renderPass, globalUniformBuffer);
  }

  instance.renderCore(renderPass, globalUniformBuffer);
  instance.renderPickupCoils(renderPass, globalUniformBuffer);
  instance.renderWires(renderPass, globalUniformBuffer);

  if (instance.rollerInstances && instance.segEnhancedPipeline) {
    instance.renderMode = 0;
    const deviceData = instance._buildDeviceUniformData(instance.renderMode);
    instance.device.queue.writeBuffer(instance.deviceUniformBuffer, 0, deviceData);

    const layoutRollers = instance.visualizer.segLayout?.totalRollers ?? 36;
    const segPos = instance.position || [0, 0, 0];
    const outerR = (instance.visualizer.segLayout?.rings?.at?.(-1)?.orbitRadiusM
      ?? 5.5) * (instance.visualizer.segLayout?.worldScale ?? 1);
    const cam = instance.visualizer.camera?.camera;
    const inside = cam?.position
      ? isCameraInsideSegRing(cam.position, segPos, outerR)
      : false;
    const activeRollers = cullSegRollerInstances(
      layoutRollers,
      inside,
      instance.visualizer.rollerInstanceCullEnabled !== false
    );

    const enhancedBindGroup = instance._enhancedBindGroup(globalUniformBuffer, instance.rollerInstances, 'rollers');
    renderPass.setPipeline(instance.segEnhancedPipeline);
    renderPass.setBindGroup(0, enhancedBindGroup);
    renderPass.setVertexBuffer(0, instance.visualizer.enhancedRollerBuffer.vertexBuffer);
    renderPass.setIndexBuffer(instance.visualizer.enhancedRollerBuffer.indexBuffer, 'uint16');
    renderPass.drawIndexed(instance.visualizer.enhancedRollerBuffer.indexCount, activeRollers);
    instance.visualizer.profiler?.recordDraw?.(1);
  }

  if (instance.electromagnetInstances && instance.coilPipeline && instance.coilMaterialBuffer) {
    const deviceData = instance._buildDeviceUniformData(instance.renderMode);
    instance.device.queue.writeBuffer(instance.deviceUniformBuffer, 0, deviceData);

    const coilBindGroup = instance._cacheBg(`coil-em:${instance.id}`, 'coil', [
      { binding: 0, resource: { buffer: globalUniformBuffer } },
      { binding: 1, resource: { buffer: instance.deviceUniformBuffer } },
      { binding: 2, resource: { buffer: instance.electromagnetInstances } },
      { binding: 3, resource: { buffer: instance.coilMaterialBuffer } }
    ], 'coil-em-bg');

    renderPass.setPipeline(instance.coilPipeline);
    renderPass.setBindGroup(0, coilBindGroup);
    renderPass.setVertexBuffer(0, instance.visualizer.cylinderBuffer.vertexBuffer);
    renderPass.setIndexBuffer(instance.visualizer.cylinderBuffer.indexBuffer, 'uint16');
    const numCoils = instance.visualizer.emController?.numCoils || 8;
    renderPass.drawIndexed(instance.visualizer.cylinderBuffer.indexCount, numCoils);
  }

  if (instance.fluxSegmentRenderBindGroup && instance.pipelineManager.fluxSegmentPipeline && instance.fieldLineEnabled) {
    const qualityScale = instance.visualizer.profiler.qualityLevel;
    const totalSegments = Math.floor(instance.geometry.fluxTotalSegments * qualityScale);
    renderPass.setPipeline(instance.pipelineManager.fluxSegmentPipeline);
    renderPass.setBindGroup(0, instance.fluxSegmentRenderBindGroup);
    renderPass.draw(4, totalSegments);
  } else if (instance.fieldLineParticles && instance.fieldLineEnabled) {
    const qualityScale = instance.visualizer.profiler.qualityLevel;
    const fieldLineCount = Math.floor(instance.fieldLineCount * qualityScale);
    const fieldLineBindGroup = instance._cacheBg(`field:${instance.id}`, 'fieldParticles', [
      { binding: 0, resource: { buffer: globalUniformBuffer } },
      { binding: 1, resource: { buffer: instance.deviceUniformBuffer } },
      { binding: 4, resource: { buffer: instance.fieldLineParticles } }
    ], 'field-line-bg');
    renderPass.setPipeline(instance.fieldLinePipeline);
    renderPass.setBindGroup(0, fieldLineBindGroup);
    renderPass.draw(4, fieldLineCount);
  }

  if (instance.arcSegments && instance.energyArcEnabled) {
    const qualityScale = instance.visualizer.profiler.qualityLevel;
    if (qualityScale > 0.5) {
      const arcCount = Math.floor(instance.arcSegmentCount * qualityScale);
      const arcBindGroup = instance._cacheBg(`arc:${instance.id}`, 'fieldParticles', [
        { binding: 0, resource: { buffer: globalUniformBuffer } },
        { binding: 1, resource: { buffer: instance.deviceUniformBuffer } },
        { binding: 4, resource: { buffer: instance.arcSegments } }
      ], 'energy-arc-bg');
      renderPass.setPipeline(instance.energyArcPipeline);
      renderPass.setBindGroup(0, arcBindGroup);
      renderPass.draw(4, arcCount * 2);
    }
  }
}
