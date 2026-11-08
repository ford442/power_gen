import type { DevicePlugin } from '../types';
import { DEVICE_PART } from '../device-render';

/** Solar battery gauge — drawn after panel mesh. */
export const drawSolarGaugeWebgpu: NonNullable<DevicePlugin['drawWebgpuOverlay']> = (instance, renderPass) => {
  if (!instance.gaugeInstanceBuffer || !instance.rollerPipeline) return;

  const v = instance.visualizer;
  const bindGroup = instance._cacheBg(`gauge:${instance.id}`, 'roller', [
    { binding: 1, resource: instance._deviceUniformResource() },
    { binding: 2, resource: { buffer: instance.gaugeInstanceBuffer } },
    { binding: 3, resource: { buffer: instance.materialUniformBuffer } }
  ], 'solar-gauge-bg');

  renderPass.setPipeline(instance.rollerPipeline);
  renderPass.setBindGroup(1, bindGroup, [instance._deviceUniformOffset(DEVICE_PART.rollers)]);
  renderPass.setVertexBuffer(0, v.batteryGaugeVertexBuffer!);
  renderPass.setIndexBuffer(v.batteryGaugeIndexBuffer!, 'uint16');
  renderPass.drawIndexed(v.batteryGaugeIndexCount!, 1);
};
