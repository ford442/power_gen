/**
 * AUTO-GENERATED from physics/devices.json — do not edit.
 * Regenerate: npm run codegen:catalog
 */

export interface CircuitPortDecl {
  /** Catalog device id. */
  device: string;
  id: string;
  label: string;
  terminals: readonly [string, string];
  /** Driver in src/circuit/ports.ts. */
  driver: string;
  model: string;
}

export const CIRCUIT_PORTS: readonly CircuitPortDecl[] = [
  {"device":"pulse-coil","id":"coil","label":"Coil","terminals":["coil +","coil −"],"driver":"pulse-coil-coil","model":"The coil's R and L only — your capacitor and switch replace the bench's bank and auto-fire; the armature feels ⟨i²⟩ (pull ∝ I² proxy)"},
  {"device":"homopolar","id":"out","label":"Disc brushes","terminals":["rim +","axle −"],"driver":"homopolar-emf","model":"EMF k·ω (k = ½ B r²) in series with the disc's own R and L; the circuit's current brakes the disc with torque k·ī"},
  {"device":"transformer","id":"sec","label":"Secondary winding","terminals":["s +","s −"],"driver":"transformer-secondary","model":"The bench's 60 Hz generator (28 V pk × drive) through R_p into L_p, coupled (k, leakage toggle) to L_s + R_s; your circuit replaces the 12 Ω load"}
];

/** Devices with at least one port. */
export const CIRCUIT_PORT_DEVICES: readonly string[] = ["pulse-coil","homopolar","transformer"];
