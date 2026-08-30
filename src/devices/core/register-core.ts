/**
 * Register built-in core apparatus update/render strategies into the device registry.
 * Dashboard layout comes from DEVICE_CONFIG via each plugin's `defaults`.
 */

import { catalogIdentity } from '../../../generated/device-catalog';
import { registerDevice } from '../device-registry.js';
import { DEVICE_CONFIG } from '../device-config';
import { DEVICE_MESH_LAYOUTS } from '../../device-mesh-layouts.js';
import type { DevicePlugin } from '../types';
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

const segPlugin: DevicePlugin = {
  ...catalogIdentity('seg'),
  defaults: DEVICE_CONFIG.seg,
  getComputeSpeed: segGetComputeSpeed,
  updateDynamics: segUpdateDynamics,
  computeRawEnergy: segComputeRawEnergy,
  updateEffects: segUpdateEffects,
  wantsThermalHaze: true,
  drawWebgpu: drawSegWebgpu
};
registerDevice(segPlugin);

const heronPlugin: DevicePlugin = {
  ...catalogIdentity('heron'),
  defaults: DEVICE_CONFIG.heron,
  needsPhysicsState: true,
  meshLayout: DEVICE_MESH_LAYOUTS.heron,
  syncAfterPhysics: heronSyncAfterPhysics,
  computeRawEnergy: heronComputeRawEnergy,
  updateFlowPaths: heronUpdateFlowPaths,
  updateEffects: heronUpdateEffects
};
registerDevice(heronPlugin);

const kelvinPlugin: DevicePlugin = {
  ...catalogIdentity('kelvin'),
  defaults: DEVICE_CONFIG.kelvin,
  needsPhysicsState: true,
  meshLayout: DEVICE_MESH_LAYOUTS.kelvin,
  syncAfterPhysics: kelvinSyncAfterPhysics,
  computeRawEnergy: kelvinComputeRawEnergy,
  updateFlowPaths: kelvinUpdateFlowPaths,
  updateEffects: kelvinUpdateEffects
};
registerDevice(kelvinPlugin);

const solarPlugin: DevicePlugin = {
  ...catalogIdentity('solar'),
  defaults: DEVICE_CONFIG.solar,
  needsPhysicsState: true,
  meshLayout: DEVICE_MESH_LAYOUTS.solar,
  syncAfterPhysics: solarSyncAfterPhysics,
  computeRawEnergy: solarComputeRawEnergy,
  buildUniformExtras: solarBuildUniformExtras,
  updateFlowPaths: solarUpdateFlowPaths,
  updateEffects: solarUpdateEffects,
  drawWebgpuOverlay: drawSolarGaugeWebgpu
};
registerDevice(solarPlugin);

const peltierPlugin: DevicePlugin = {
  ...catalogIdentity('peltier'),
  defaults: DEVICE_CONFIG.peltier,
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
};
registerDevice(peltierPlugin);

const mhdPlugin: DevicePlugin = {
  ...catalogIdentity('mhd'),
  defaults: DEVICE_CONFIG.mhd,
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
};
registerDevice(mhdPlugin);
