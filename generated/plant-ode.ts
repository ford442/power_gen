/**
 * AUTO-GENERATED from physics/devices.json — do not edit.
 * Regenerate: npm run codegen:catalog
 *
 * Per-plant ODE layout for the shared integrators
 * (src/renderers/shared/integrate.ts) — the TS twin of generated/plant-ode.h.
 */

export type IntegratorName = 'euler' | 'rk4' | 'dopri5' | 'ros23';

export const INTEGRATOR_NAMES: readonly IntegratorName[] = ['euler', 'rk4', 'dopri5', 'ros23'];

export interface PlantOdeSpec {
  wasmMode: number;
  /** Catalog default; `physicsState.integratorOverride` replaces it (benches / goldens). */
  integrator: IntegratorName;
  state: readonly string[];
  outputs: readonly string[];
  rtol: number;
  atol: readonly number[];
  /** Largest adaptive step, s. */
  hMax: number;
}

export const PLANT_ODE: Readonly<Record<string, PlantOdeSpec>> = {
  'homopolar': {
    wasmMode: 7,
    integrator: 'euler',
    state: ['omega', 'currentA'],
    outputs: ['emfV'],
    rtol: 0.0001,
    atol: [0.001, 0.001],
    hMax: Infinity
  },
  'jumping-ring': {
    wasmMode: 12,
    integrator: 'dopri5',
    state: ['primaryIA', 'ringCurrentA', 'velocityMps', 'heightM'],
    outputs: ['forceN', 'couplingK'],
    rtol: 0.0002,
    atol: [0.0034, 0.16, 0.00017, 0.000013],
    hMax: Infinity
  }
};

/** Homopolar Generator: index of each ODE state in x. */
export const HomopolarState = { omega: 0, currentA: 1 } as const;

/** Thomson Jumping Ring: index of each ODE state in x. */
export const JumpingRingState = { primaryIA: 0, ringCurrentA: 1, velocityMps: 2, heightM: 3 } as const;
