/**
 * AUTO-GENERATED from physics/coupling.json — do not edit.
 * Regenerate: npm run codegen:constants
 */

export interface EnergyPipeCatalogRow {
  readonly from: string;
  readonly to: string;
  /** Pipe capacity (W) — simulated order-of-magnitude, not metrology. */
  readonly maxWatts: number;
  readonly speed: number;
  readonly color: readonly [number, number, number];
  /** Device whose nameplate set maxWatts, or null for a literal capacity. */
  readonly nameplate: string | null;
}

export const ENERGY_PIPE_CATALOG: readonly EnergyPipeCatalogRow[] = [
  { from: 'seg', to: 'heron', maxWatts: 1500, speed: 2, color: [0.15, 0.92, 0.75], nameplate: null },
  { from: 'heron', to: 'kelvin', maxWatts: 800, speed: 1.5, color: [0.25, 0.65, 1], nameplate: null },
  { from: 'kelvin', to: 'seg', maxWatts: 600, speed: 2.5, color: [0.72, 0.45, 1], nameplate: null },
  { from: 'kelvin', to: 'peltier', maxWatts: 400, speed: 1.8, color: [0.55, 0.35, 0.95], nameplate: null },
  { from: 'peltier', to: 'solar', maxWatts: 500, speed: 2.2, color: [1, 0.82, 0.25], nameplate: null },
  { from: 'seg', to: 'mhd', maxWatts: 1200, speed: 1.6, color: [0.35, 0.88, 1], nameplate: null },
  { from: 'mhd', to: 'peltier', maxWatts: 700, speed: 2, color: [0.45, 0.75, 1], nameplate: null },
  { from: 'solar', to: 'maglev', maxWatts: 450, speed: 1.4, color: [0.25, 0.92, 1], nameplate: null },
  { from: 'maglev', to: 'seg', maxWatts: 550, speed: 1.9, color: [0.15, 0.85, 0.95], nameplate: null },
  { from: 'solar', to: 'transformer', maxWatts: 350, speed: 1.5, color: [0.95, 0.7, 0.25], nameplate: null },
  { from: 'transformer', to: 'halbach-viz', maxWatts: 300, speed: 1.6, color: [0.35, 0.85, 0.95], nameplate: null },
  { from: 'halbach-viz', to: 'homopolar', maxWatts: 320, speed: 1.7, color: [0.55, 0.75, 1], nameplate: null },
  { from: 'homopolar', to: 'seg', maxWatts: 400, speed: 1.8, color: [0.9, 0.55, 0.2], nameplate: null },
  { from: 'mhd', to: 'lorentz-sled', maxWatts: 300, speed: 1.7, color: [0.95, 0.6, 0.3], nameplate: null },
  { from: 'transformer', to: 'jumping-ring', maxWatts: 260, speed: 1.8, color: [0.6, 0.8, 1], nameplate: null },
  { from: 'homopolar', to: 'hall', maxWatts: 30, speed: 1.6, color: [0.95, 0.75, 0.35], nameplate: 'hall' },
  { from: 'transformer', to: 'vdg', maxWatts: 60, speed: 1.5, color: [0.8, 0.85, 0.95], nameplate: 'vdg' },
  { from: 'seg', to: 'pulse-coil', maxWatts: 3.6, speed: 2.1, color: [0.95, 0.45, 0.6], nameplate: 'pulse-coil' },
];
