import type { DevicePlugin } from '../types';
import { DEVICE_PART } from '../device-render';

/**
 * WebGPU draw path for SEG — housing, frame, rollers, flux, arcs.
 * Called from DeviceRenderMixin before shared particles / flow paths.
 *
 * Every draw binds its own uniform-ring slot (DEVICE_PART) on @group(1); the
 * frame group(0) was bound once by the scene pass. The static part — CAD
 * housing and SEG frame — is a render bundle (visualizer/render-bundles.ts),
 * replayed here in the same place in the draw order.
 */
export const drawSegWebgpu: NonNullable<DevicePlugin['drawWebgpu']> = (instance, renderPass, skipEffects) => {
  if (skipEffects) return;

  const v = instance.visualizer;
  if (!v.staticBundles?.drawDeviceStatic(renderPass, instance)) {
    instance.renderGltfHousing(renderPass);
    instance.renderFrame(renderPass);
  }

  if (instance.geometry.baseBuffer) {
    instance.renderBase(renderPass);
  }
  if (instance.geometry.statorRingBuffer) {
    instance.renderStatorRings(renderPass);
  }
  if (instance.geometry.wiringBuffer && !v.wireBuffers) {
    instance.renderWiring(renderPass);
  }

  instance.renderCore(renderPass);
  instance.renderPickupCoils(renderPass);
  instance.renderWires(renderPass);

  instance.renderMode = 0;
  const modeZero = [instance._deviceUniformOffset(DEVICE_PART.rollers, 'rollers')];

  instance.renderSegRollers(renderPass);

  if (instance.electromagnetInstances && instance.coilPipeline && instance.coilMaterialBuffer) {
    const coilBindGroup = instance._cacheBg(`coil-em:${instance.id}`, 'coil', [
      { binding: 1, resource: instance._deviceUniformResource() },
      { binding: 2, resource: { buffer: instance.electromagnetInstances } },
      { binding: 3, resource: { buffer: instance.coilMaterialBuffer } }
    ], 'coil-em-bg');

    renderPass.setPipeline(instance.coilPipeline);
    renderPass.setBindGroup(1, coilBindGroup, modeZero);
    renderPass.setVertexBuffer(0, v.cylinderBuffer!.vertexBuffer);
    renderPass.setIndexBuffer(v.cylinderBuffer!.indexBuffer, 'uint16');
    const numCoils = v.emController?.numCoils || 8;
    renderPass.drawIndexed(v.cylinderBuffer!.indexCount, numCoils);
  }

  if (instance.fluxSegmentRenderBindGroup && instance.pipelineManager?.fluxSegmentPipeline && instance.fieldLineEnabled) {
    const qualityScale = v.profiler!.qualityLevel;
    const totalSegments = Math.floor(instance.geometry.fluxTotalSegments! * qualityScale);
    renderPass.setPipeline(instance.pipelineManager.fluxSegmentPipeline);
    renderPass.setBindGroup(1, instance.fluxSegmentRenderBindGroup, modeZero);
    renderPass.draw(4, totalSegments);
  } else if (instance.fieldLineParticles && instance.fieldLineEnabled) {
    const qualityScale = v.profiler!.qualityLevel;
    const fieldLineCount = Math.floor(instance.fieldLineCount * qualityScale);
    const fieldLineBindGroup = instance._cacheBg(`field:${instance.id}`, 'fieldParticles', [
      { binding: 1, resource: instance._deviceUniformResource() },
      { binding: 4, resource: { buffer: instance.fieldLineParticles } }
    ], 'field-line-bg');
    renderPass.setPipeline(instance.fieldLinePipeline!);
    renderPass.setBindGroup(1, fieldLineBindGroup, modeZero);
    renderPass.draw(4, fieldLineCount);
  }

  if (instance.arcSegments && instance.energyArcEnabled) {
    const qualityScale = v.profiler!.qualityLevel;
    if (qualityScale > 0.5) {
      const arcCount = Math.floor(instance.arcSegmentCount! * qualityScale);
      const arcBindGroup = instance._cacheBg(`arc:${instance.id}`, 'fieldParticles', [
        { binding: 1, resource: instance._deviceUniformResource() },
        { binding: 4, resource: { buffer: instance.arcSegments } }
      ], 'energy-arc-bg');
      renderPass.setPipeline(instance.energyArcPipeline!);
      renderPass.setBindGroup(1, arcBindGroup, modeZero);
      renderPass.draw(4, arcCount * 2);
    }
  }
};
