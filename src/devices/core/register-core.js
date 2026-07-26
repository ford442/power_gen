/**
 * Register built-in core apparatus update/render strategies into the device registry.
 * Legacy DEVICE_CONFIG in debug-panel.js still supplies dashboard positions until full migration.
 */

import { registerDevice } from '../device-registry.js';
import { DEVICE_MESH_LAYOUTS } from '../../device-mesh-layouts.js';
import {
  segGetComputeSpeed,
  segUpdateDynamics,
  segComputeRawEnergy,
  segUpdateEffects
} from './seg-update.js';
import {
  heronSyncAfterPhysics,
  heronComputeRawEnergy,
  heronUpdateFlowPaths,
  heronUpdateEffects
} from './heron-update.js';
import {
  kelvinSyncAfterPhysics,
  kelvinComputeRawEnergy,
  kelvinUpdateFlowPaths,
  kelvinUpdateEffects
} from './kelvin-update.js';
import {
  solarSyncAfterPhysics,
  solarComputeRawEnergy,
  solarBuildUniformExtras,
  solarUpdateFlowPaths,
  solarUpdateEffects
} from './solar-update.js';
import { peltierComputeRawEnergy, peltierUpdateEffects } from './peltier-update.js';
import { mhdComputeRawEnergy, mhdUpdateEffects } from './mhd-update.js';
import { drawSegWebgpu } from './seg-render.js';
import { drawSolarGaugeWebgpu } from './solar-render.js';

registerDevice({
  id: 'seg',
  label: 'SEG',
  category: 'core',
  modeIndex: 0,
  wasmMode: 0,
  getComputeSpeed: segGetComputeSpeed,
  updateDynamics: segUpdateDynamics,
  computeRawEnergy: segComputeRawEnergy,
  updateEffects: segUpdateEffects,
  wantsThermalHaze: true,
  drawWebgpu: drawSegWebgpu
});

registerDevice({
  id: 'heron',
  label: "Heron's Fountain",
  category: 'core',
  modeIndex: 1,
  wasmMode: 1,
  needsPhysicsState: true,
  meshLayout: DEVICE_MESH_LAYOUTS.heron,
  syncAfterPhysics: heronSyncAfterPhysics,
  computeRawEnergy: heronComputeRawEnergy,
  updateFlowPaths: heronUpdateFlowPaths,
  updateEffects: heronUpdateEffects
});

registerDevice({
  id: 'kelvin',
  label: "Kelvin's Thunderstorm",
  category: 'core',
  modeIndex: 2,
  wasmMode: 2,
  needsPhysicsState: true,
  meshLayout: DEVICE_MESH_LAYOUTS.kelvin,
  syncAfterPhysics: kelvinSyncAfterPhysics,
  computeRawEnergy: kelvinComputeRawEnergy,
  updateFlowPaths: kelvinUpdateFlowPaths,
  updateEffects: kelvinUpdateEffects
});

registerDevice({
  id: 'solar',
  label: 'Solar / LED',
  category: 'core',
  modeIndex: 3,
  wasmMode: 3,
  needsPhysicsState: true,
  meshLayout: DEVICE_MESH_LAYOUTS.solar,
  syncAfterPhysics: solarSyncAfterPhysics,
  computeRawEnergy: solarComputeRawEnergy,
  buildUniformExtras: solarBuildUniformExtras,
  updateFlowPaths: solarUpdateFlowPaths,
  updateEffects: solarUpdateEffects,
  drawWebgpuOverlay: drawSolarGaugeWebgpu
});

registerDevice({
  id: 'peltier',
  label: 'Peltier',
  category: 'core',
  modeIndex: 4,
  wasmMode: 4,
  computeRawEnergy: peltierComputeRawEnergy,
  updateEffects: peltierUpdateEffects,
  wantsThermalHaze: true
});

registerDevice({
  id: 'mhd',
  label: 'MHD Channel',
  category: 'core',
  modeIndex: 5,
  wasmMode: 5,
  computeRawEnergy: mhdComputeRawEnergy,
  updateEffects: mhdUpdateEffects,
  wantsThermalHaze: true
});
