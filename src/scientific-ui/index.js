/**
 * Scientific UI Module
 * Modular scientific visualization components for SEG WebGPU Visualizer
 * 
 * @module scientific-ui
 */

// Re-export utilities
export * from './utils/index.js';

// Re-export core classes (when extracted)
// export { ScientificUIManager } from './core/ScientificUIManager.js';

// Re-export gauges (when extracted)
// export { MagneticFieldGauge } from './gauges/MagneticFieldGauge.js';
// export { EnergyDensityGauge } from './gauges/EnergyDensityGauge.js';
// export { TorqueGauge } from './gauges/TorqueGauge.js';
// export { ParticleFluxGauge } from './gauges/ParticleFluxGauge.js';
// export { BatteryGauge } from './gauges/BatteryGauge.js';
// export { SolarPanelGauge } from './gauges/SolarPanelGauge.js';
// export { LEDArrayGauge } from './gauges/LEDArrayGauge.js';
// export { EnergyBalanceDisplay } from './gauges/EnergyBalanceDisplay.js';

// Re-export panels (when extracted)
// export { WolframStatusPanel } from './panels/WolframStatusPanel.js';

/**
 * NOTE: During the refactoring phase, the main implementation
 * is still in ../scientific-ui.js. Once all components are
 * extracted, this module will become the primary entry point.
 * 
 * For now, import from '../scientific-ui.js' for the full implementation.
 */

// Temporary re-export from original file for backward compatibility
export { 
  ScientificUIManager,
  MagneticFieldGauge,
  EnergyDensityGauge,
  TorqueGauge,
  ParticleFluxGauge,
  WolframStatusPanel,
  BatteryGauge,
  SolarPanelGauge,
  LEDArrayGauge,
  EnergyBalanceDisplay,
  LED_SOLAR_CONSTANTS
} from '../scientific-ui.js';

// Default export
export { ScientificUIManager as default } from '../scientific-ui.js';
