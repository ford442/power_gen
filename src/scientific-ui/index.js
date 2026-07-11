/**
 * Scientific UI package entry — gauges + manager.
 *
 * Live values come from TelemetryHub only (see src/telemetry-hub.js).
 * Prefer: import { ScientificUIManager, MagneticFieldGauge, ... } from './scientific-ui/index.js'
 */

// Utilities
export * from './utils/index.js';

// Gauge widgets (fully extracted under gauges/)
export { MagneticFieldGauge } from './gauges/magnetic-field-gauge.js';
export { EnergyDensityGauge } from './gauges/energy-density-gauge.js';
export { TorqueGauge } from './gauges/torque-gauge.js';
export { ParticleFluxGauge } from './gauges/particle-flux-gauge.js';
export { BatteryGauge } from './gauges/battery-gauge.js';
export { SolarPanelGauge } from './gauges/solar-panel-gauge.js';
export { LEDArrayGauge } from './gauges/ledarray-gauge.js';
export { EnergyBalanceDisplay } from './gauges/energy-balance-display.js';
export { WolframStatusPanel } from './gauges/wolfram-status-panel.js';

// Orchestrator (panel + TelemetryHub subscription)
export { ScientificUIManager, LED_SOLAR_CONSTANTS } from '../scientific-ui.js';
export { ScientificUIManager as default } from '../scientific-ui.js';
