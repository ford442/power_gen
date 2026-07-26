/** Solar battery gauge — drawn after panel mesh. */
export function drawSolarGaugeWebgpu(instance, renderPass, globalUniformBuffer) {
  if (!instance.gaugeInstanceBuffer) return;

  const v = instance.visualizer;
  const bindGroup = instance._cacheBg(`gauge:${instance.id}`, 'roller', [
    { binding: 0, resource: { buffer: globalUniformBuffer } },
    { binding: 1, resource: { buffer: instance.deviceUniformBuffer } },
    { binding: 2, resource: { buffer: instance.gaugeInstanceBuffer } },
    { binding: 3, resource: { buffer: instance.materialUniformBuffer } },
    { binding: 5, resource: { buffer: v.materialTableBuffer } }
  ], 'solar-gauge-bg');

  renderPass.setPipeline(instance.rollerPipeline);
  renderPass.setBindGroup(0, bindGroup);
  renderPass.setVertexBuffer(0, v.batteryGaugeVertexBuffer);
  renderPass.setIndexBuffer(v.batteryGaugeIndexBuffer, 'uint16');
  renderPass.drawIndexed(v.batteryGaugeIndexCount, 1);
}
