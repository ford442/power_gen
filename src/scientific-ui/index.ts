/**
 * Scientific UI package entry — gauges, utils, and panel manager.
 *
 * Live values come from TelemetryHub only (see src/telemetry-hub.ts).
 * Import: import { ScientificUIManager, MagneticFieldGauge, ... } from './scientific-ui/index'
 */

export * from './utils/index';

export { MagneticFieldGauge } from './gauges/magnetic-field-gauge';
export { EnergyDensityGauge } from './gauges/energy-density-gauge';
export { TorqueGauge } from './gauges/torque-gauge';
export { ParticleFluxGauge } from './gauges/particle-flux-gauge';
export { BatteryGauge } from './gauges/battery-gauge';
export { SolarPanelGauge } from './gauges/solar-panel-gauge';
export { LEDArrayGauge } from './gauges/ledarray-gauge';
export { EnergyBalanceDisplay } from './gauges/energy-balance-display';
export { ShadowResidualGauge } from './gauges/shadow-residual-gauge';
export { CatalogGaugeStrip } from './gauges/catalog-gauge-strip';

export { ScientificUIManager } from './manager';
export { ScientificUIManager as default } from './manager';
