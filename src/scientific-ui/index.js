/**
 * Scientific UI package entry — gauges, utils, and panel manager.
 *
 * Live values come from TelemetryHub only (see src/telemetry-hub.js).
 * Import: import { ScientificUIManager, MagneticFieldGauge, ... } from './scientific-ui/index.js'
 */

export * from './utils/index.js';

export { MagneticFieldGauge } from './gauges/magnetic-field-gauge.js';
export { EnergyDensityGauge } from './gauges/energy-density-gauge.js';
export { TorqueGauge } from './gauges/torque-gauge.js';
export { ParticleFluxGauge } from './gauges/particle-flux-gauge.js';
export { BatteryGauge } from './gauges/battery-gauge.js';
export { SolarPanelGauge } from './gauges/solar-panel-gauge.js';
export { LEDArrayGauge } from './gauges/ledarray-gauge.js';
export { EnergyBalanceDisplay } from './gauges/energy-balance-display.js';
export { WolframStatusPanel } from './gauges/wolfram-status-panel.js';

export { ScientificUIManager } from './manager.js';
export { ScientificUIManager as default } from './manager.js';
