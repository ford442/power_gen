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
import { peltierComputeRawEnergy, peltierUpdateEffects, peltierUpdateMesh, createPeltierPhysicsState, stepPeltierPhysics, buildPeltierMesh } from './peltier-update.js';
import { mhdComputeRawEnergy, mhdUpdateEffects, mhdUpdateMesh, createMhdPhysicsState, stepMhdPhysics, buildMhdMesh } from './mhd-update.js';
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
  needsPhysicsState: true,
  wasmSkipsJsPhysics: true,
  computeRawEnergy: peltierComputeRawEnergy,
  updateEffects: peltierUpdateEffects,
  updateMesh: peltierUpdateMesh,
  createPhysicsState: createPeltierPhysicsState,
  stepPhysics: stepPeltierPhysics,
  meshLayout: {
    cylinders: () => buildPeltierMesh().cylinders()
  },
  telemetrySchema: {
    peltierHotK: { label: 'Hot junction', unit: 'K', source: 'sim' },
    peltierColdK: { label: 'Cold junction', unit: 'K', source: 'sim' },
    peltierDeltaT: { label: 'ΔT', unit: 'K', source: 'sim' },
    peltierVoltage: { label: 'Voltage', unit: 'V', source: 'sim' },
    peltierCurrent: { label: 'Current', unit: 'A', source: 'sim' },
    peltierPowerW: { label: 'Power', unit: 'W', source: 'sim' },
    peltierCOP: { label: 'COP proxy', unit: '', source: 'sim' }
  },
  wantsThermalHaze: true
});

registerDevice({
  id: 'mhd',
  label: 'MHD Channel',
  category: 'core',
  modeIndex: 5,
  wasmMode: 5,
  needsPhysicsState: true,
  wasmSkipsJsPhysics: true,
  computeRawEnergy: mhdComputeRawEnergy,
  updateEffects: mhdUpdateEffects,
  updateMesh: mhdUpdateMesh,
  createPhysicsState: createMhdPhysicsState,
  stepPhysics: stepMhdPhysics,
  meshLayout: {
    cylinders: () => buildMhdMesh().cylinders()
  },
  telemetrySchema: {
    mhdFlowU: { label: 'Flow U', unit: 'm/s', source: 'sim' },
    mhdBFieldT: { label: 'B-field', unit: 'T', source: 'sim' },
    mhdHartmann: { label: 'Hartmann', unit: '', source: 'sim' },
    mhdVoltage: { label: 'Voltage', unit: 'V', source: 'sim' },
    mhdCurrent: { label: 'Current', unit: 'A', source: 'sim' },
    mhdPowerW: { label: 'Power', unit: 'W', source: 'sim' }
  },
  wantsThermalHaze: true
});
