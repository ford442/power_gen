/**
 * AUTO-GENERATED from physics/devices.json — do not edit.
 * Regenerate: npm run codegen:catalog
 */

/** Solver tiers a `fluid=` choice resolves to (src/visualizer/heron-liquid-pass.ts → liquidTierFor). */
export type FluidTier = 'low' | 'default' | 'high';

export interface FluidTierBudget {
  /** Node budget: grid³. The bench's scene shapes the box. */
  grid: number;
  /** Particle slots. */
  particles: number;
}

export interface DeviceFluid {
  solver: 'mpm';
  /** What of the bench is simulated. */
  what: string;
  tiers: Readonly<Record<FluidTier, FluidTierBudget>>;
  /** `surface`: a screen-space surface from the medium quality tier, particles below; `particles`: always particles. */
  draw: 'surface' | 'particles';
  /** What WebGL2 draws instead. */
  fallback: string;
  /** What is idealised. */
  model: string;
}

/** Benches with a `fluid` block in physics/devices.json. */
export type FluidDeviceId = 'heron' | 'kelvin';

export const DEVICE_FLUIDS: Readonly<Record<FluidDeviceId, DeviceFluid>> = {
  "heron": {"solver":"mpm","what":"the jet above the nozzle, its cap and its fall to the tray","tiers":{"low":{"grid":32,"particles":15000},"default":{"grid":64,"particles":40000},"high":{"grid":96,"particles":120000}},"draw":"surface","fallback":"ballistic droplets under SI gravity, each rising v²/2g","model":"weakly compressible, shown at 1/6 speed; the tray drains instead of filling; no surface tension; the vessels' levels stay the plant's"},
  "kelvin": {"solver":"mpm","what":"the two streams of charged drops between the drip tips and the collectors","tiers":{"low":{"grid":32,"particles":2048},"default":{"grid":32,"particles":2048},"high":{"grid":32,"particles":2048}},"draw":"particles","fallback":"the same drops on the CPU: gravity and q·E in 1 ms steps","model":"one particle per Rayleigh–Plateau drop: no pinch-off, merging or drop–drop force; the conductors are rings of charge at the plant's potential; real time"}
};

export const FLUID_DEVICE_IDS: readonly FluidDeviceId[] = ["heron","kelvin"];
