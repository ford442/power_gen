/**
 * AUTO-GENERATED from physics/devices.json — do not edit.
 * Regenerate: npm run codegen:catalog
 *
 * The hardware twin's rig (#257, ADR-0019) — the TS twin of
 * generated/twin-rig.h: what the estimator host, the mock rig and the twin
 * panel read about the model, its parameters and its sensors.
 */

export interface TwinRigStateSpec { id: string; label: string; unit: string; q: number }
export interface TwinRigParamSpec { id: string; label: string; unit: string; nominal: number; min: number; max: number }
export interface TwinRigSensorSpec { id: string; label: string; unit: string; sigma: number; model: string }

export interface TwinRigSpec {
  device: string;
  model: string;
  integrator: 'rk4';
  /** Predict-step substep cap, s. */
  hMax: number;
  state: readonly TwinRigStateSpec[];
  params: readonly TwinRigParamSpec[];
  /** Board drive v = vPerRpm · RPM_cmd, |v| ≤ vMax, in RUN only. */
  input: { vPerRpm: number; vMax: number };
  sensors: readonly TwinRigSensorSpec[];
}

export const TWIN_RIG: TwinRigSpec = {
  device: "seg",
  model: "Lumped DC-machine equivalent of the commutated coil array and its rotor: J·dω/dt = k_e·I − b·ω and L·dI/dt = v − R·I − k_e·ω, where the board's drive v = vPerRpm × commanded RPM, clamped to ±vMax, in RUN and 0 in coast, brake or a manual coil override. Commutation ripple, cogging, saturation, temperature and the synchronous pull-in are not modelled; process noise stands in for them.",
  integrator: 'rk4',
  hMax: 0.002,
  state: [
    { id: "omega", label: "ω", unit: "rad/s", q: 1 },
    { id: "currentA", label: "I", unit: "A", q: 0.0001 }
  ],
  params: [
    { id: "inertia", label: "J", unit: "kg·m²", nominal: 0.0025, min: 0.0001, max: 0.05 },
    { id: "friction", label: "b", unit: "N·m·s/rad", nominal: 0.0015, min: 0.00001, max: 0.05 },
    { id: "coilR", label: "R", unit: "Ω", nominal: 2, min: 0.05, max: 50 },
    { id: "coilL", label: "L", unit: "H", nominal: 0.08, min: 0.0001, max: 2 },
    { id: "kE", label: "k_e", unit: "V·s/rad", nominal: 0.1, min: 0.001, max: 1 }
  ],
  input: { vPerRpm: 0.0125, vMax: 12 },
  sensors: [
    { id: "rpm", label: "RPM", unit: "RPM", sigma: 2, model: "ω·30/π (hall-pulse interval on the board)" },
    { id: "current", label: "I", unit: "A", sigma: 0.02, model: "coil current I (a shunt / INA219 channel; the v2 sketch has none)" },
    { id: "voltage", label: "V", unit: "V", sigma: 0.05, model: "pickup back-EMF k_e·ω (the v2 sketch has none)" }
  ]
};

/** Index of each rig state in x. */
export const TwinRigState = { omega: 0, currentA: 1 } as const;
/** Index of each identifiable parameter in θ. */
export const TwinRigParam = { inertia: 0, friction: 1, coilR: 2, coilL: 3, kE: 4 } as const;
/** Index of each sensor channel in y. */
export const TwinRigSensor = { rpm: 0, current: 1, voltage: 2 } as const;
