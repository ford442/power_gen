/**
 * Experiment knobs — every value a `set` / `ramp` / `sweep` may write (#224 §3).
 *
 *   drive                         operator throttle 0–1 (the speed slider)
 *   <deviceId>.<setpointId>       each catalog setpoint (physics/devices.json
 *                                 `setpoints`), e.g. `lorentz-sled.lorentzField`
 *   transformer.leakage           0 = ideal k, 1 = leakage k (classroom toggle)
 *   hall.carrierMetal             0 = semiconductor strip, 1 = metal
 *
 * plus a few readable aliases (`lorentz-sled.fieldT`). A knob writes the same
 * `physicsState` field, through the same helper, as the operator control it
 * stands for — so the plant clock picks it up on its next substep, in the
 * C++ plant (syncWasmFocusKnobs) and the JS fallback alike. Live, the runner
 * also calls the `window` API the control owns, so the slider follows.
 */
import { DEVICE_SETPOINTS, type DeviceSetpoint } from '../../generated/device-catalog';
import { setLorentzFieldT } from '../devices/quanta/lorentz-sled';
import { setTransformerLeakage } from '../devices/quanta/transformer';
import { setHallCarrierType } from '../devices/quanta/hall-effect';
import type { DevicePhysicsState } from '../renderers/shared/device-physics';

type PhysicsBag = Partial<DevicePhysicsState> & Record<string, unknown>;

/** What a knob writes into: the session devices and the operator. */
export interface KnobTarget {
  devices: Record<string, { physicsState?: Partial<DevicePhysicsState>; physics?: Partial<DevicePhysicsState> } | undefined>;
  operator: { targetDrive: number };
  /** True while the field bus drives this device's B (its local slider is parked). */
  fieldCoupled?: (deviceId: string) => boolean;
  /** Live only: the `window` function an operator control owns, when present. */
  windowApi?: (name: string) => ((value: never) => void) | undefined;
}

export interface KnobSpec {
  id: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  /** Booleans take 0/1 (or true/false) and read back as 0/1. */
  kind: 'number' | 'boolean';
  integer?: boolean;
  /** Device the knob lives on (null for the operator throttle). */
  deviceId: string | null;
  write(t: KnobTarget, value: number): boolean;
  read(t: KnobTarget): number | null;
}

function physicsOf(t: KnobTarget, deviceId: string): PhysicsBag | null {
  const d = t.devices[deviceId];
  return (d?.physicsState ?? d?.physics ?? null) as PhysicsBag | null;
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function clamp(spec: Pick<KnobSpec, 'min' | 'max' | 'integer'>, v: number): number {
  const c = Math.max(spec.min, Math.min(spec.max, v));
  return spec.integer ? Math.round(c) : c;
}

function setpointKnob(sp: DeviceSetpoint): KnobSpec {
  const spec: KnobSpec = {
    id: `${sp.deviceId}.${sp.id}`,
    label: sp.label,
    unit: sp.unit,
    min: sp.min,
    max: sp.max,
    kind: 'number',
    integer: sp.step >= 1 && Number.isInteger(sp.step),
    deviceId: sp.deviceId,
    write(t, value) {
      const v = clamp(spec, value);
      const api = sp.api ? t.windowApi?.(sp.api) : undefined;
      if (api) {
        (api as (n: number) => void)(v);
        return true;
      }
      const phys = physicsOf(t, sp.deviceId);
      if (!phys) return false;
      if (sp.api === 'setLorentzFieldT') {
        setLorentzFieldT(phys, v, { coupled: !!t.fieldCoupled?.(sp.deviceId) });
      } else {
        phys[sp.stateKey] = v;
      }
      return true;
    },
    read(t) {
      const phys = physicsOf(t, sp.deviceId);
      return finiteOrNull(phys?.[sp.stateKey]) ?? (sp.liveKey ? finiteOrNull(phys?.[sp.liveKey]) : null);
    }
  };
  return spec;
}

const DRIVE: KnobSpec = {
  id: 'drive',
  label: 'Drive',
  unit: '',
  min: 0,
  max: 1,
  kind: 'number',
  deviceId: null,
  write(t, value) {
    t.operator.targetDrive = clamp(DRIVE, value);
    return true;
  },
  read(t) {
    return t.operator.targetDrive;
  }
};

const TRANSFORMER_LEAKAGE: KnobSpec = {
  id: 'transformer.leakage',
  label: 'Leakage coupling',
  unit: '',
  min: 0,
  max: 1,
  kind: 'boolean',
  deviceId: 'transformer',
  write(t, value) {
    const on = value >= 0.5;
    const api = t.windowApi?.('setTransformerLeakage');
    if (api) {
      (api as (b: boolean) => void)(on);
      return true;
    }
    const phys = physicsOf(t, 'transformer');
    if (!phys) return false;
    setTransformerLeakage(phys, on);
    return true;
  },
  read(t) {
    return physicsOf(t, 'transformer')?.transformerLeakage ? 1 : 0;
  }
};

const HALL_CARRIER_METAL: KnobSpec = {
  id: 'hall.carrierMetal',
  label: 'Metal strip',
  unit: '',
  min: 0,
  max: 1,
  kind: 'boolean',
  deviceId: 'hall',
  write(t, value) {
    const carrier = value >= 0.5 ? 'metal' : 'semiconductor';
    const api = t.windowApi?.('setHallCarrierType');
    if (api) {
      (api as (c: string) => void)(carrier);
      return true;
    }
    const phys = physicsOf(t, 'hall');
    if (!phys) return false;
    setHallCarrierType(phys, carrier);
    return true;
  },
  read(t) {
    return physicsOf(t, 'hall')?.hallCarrierType === 'metal' ? 1 : 0;
  }
};

export const EXPERIMENT_KNOBS: readonly KnobSpec[] = [
  DRIVE,
  ...DEVICE_SETPOINTS.map(setpointKnob),
  TRANSFORMER_LEAKAGE,
  HALL_CARRIER_METAL
];

/** Readable alternative names → canonical knob id. */
export const KNOB_ALIASES: Readonly<Record<string, string>> = {
  'lorentz-sled.fieldT': 'lorentz-sled.lorentzField',
  'halbach-viz.segments': 'halbach-viz.halbachSegments',
  'pulse-coil.chargeV': 'pulse-coil.pulseCoilCharge',
  'drop-tube.sigma': 'drop-tube.dropTubeSigma'
};

const KNOB_BY_ID = new Map(EXPERIMENT_KNOBS.map((k) => [k.id, k]));

/** Canonical knob for an id or alias, or undefined. */
export function knobSpec(id: string): KnobSpec | undefined {
  return KNOB_BY_ID.get(KNOB_ALIASES[id] ?? id);
}

/** Canonical id for an id or alias (the id itself when unknown). */
export function canonicalKnobId(id: string): string {
  return KNOB_ALIASES[id] ?? id;
}

/** Number a knob value as written in JSON (`true` → 1). NaN when unusable. */
export function knobNumber(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return typeof value === 'number' ? value : Number.NaN;
}
