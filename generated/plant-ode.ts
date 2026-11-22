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
  'peltier': {
    wasmMode: 4,
    integrator: 'ros23',
    state: ['nodesK[0]', 'nodesK[1]', 'nodesK[2]', 'nodesK[3]', 'nodesK[4]', 'nodesK[5]', 'nodesK[6]', 'nodesK[7]', 'nodesK[8]', 'nodesK[9]', 'nodesK[10]', 'nodesK[11]', 'nodesK[12]', 'nodesK[13]', 'nodesK[14]', 'nodesK[15]', 'nodesK[16]', 'nodesK[17]', 'nodesK[18]', 'nodesK[19]', 'nodesK[20]', 'nodesK[21]', 'nodesK[22]', 'nodesK[23]', 'nodesK[24]', 'nodesK[25]', 'nodesK[26]', 'nodesK[27]'],
    outputs: ['hotK', 'coldK', 'deltaTK', 'voltageV', 'powerW', 'cop', 'qcW', 'qhW'],
    rtol: 0.00001,
    atol: [0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001],
    hMax: 2
  },
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

/** Peltier: index of each ODE state in x (an array state: its first element). */
export const PeltierState = { nodesK: 0 } as const;

/** Peltier: length of each array ODE state. */
export const PeltierStateCount = { nodesK: 28 } as const;

/** Homopolar Generator: index of each ODE state in x (an array state: its first element). */
export const HomopolarState = { omega: 0, currentA: 1 } as const;

/** Thomson Jumping Ring: index of each ODE state in x (an array state: its first element). */
export const JumpingRingState = { primaryIA: 0, ringCurrentA: 1, velocityMps: 2, heightM: 3 } as const;
