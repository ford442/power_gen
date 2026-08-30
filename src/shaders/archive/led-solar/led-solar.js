import ledSolarConstants from './led-solar-constants.wgsl?raw';
import ledSolarStructs from './led-solar-structs.wgsl?raw';
import ledSolarPhysics from './led-solar-physics.wgsl?raw';
import ledSolarCompute from './led-solar-compute.wgsl?raw';
import ledSolarRender from './led-solar-render.wgsl?raw';

export const ledSolarWgsl = [
  ledSolarConstants,
  ledSolarStructs,
  ledSolarPhysics,
  ledSolarCompute,
  ledSolarRender,
].join('\n');
