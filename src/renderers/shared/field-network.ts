/**
 * Shared lab **field** network — optional live B coupling between devices.
 *
 * Sibling of `energy-network.ts`, deliberately on its own switch
 * (`?fieldCoupling=1` / `localStorage seg-field-coupling`) rather than folded
 * into `?energyCoupling=1`: one toggle mixing watts and tesla reads as a single
 * "lab bus is live" claim it cannot honestly make, and a classroom that wants
 * coupled pipe watts should not silently also get a coupled Hall field.
 *
 * Off (the default) every destination keeps the isolated bench parameter it has
 * today. On, the destination's B is `clamp(sourceEstimate, catalog min/max)` and
 * the UI names the source device.
 *
 * **Not Maxwell.** The source numbers are themselves lumped estimates — a
 * dipole-superposition peak from `halbach-viz`, a drive-scaled channel field
 * from `mhd`. Coupling them propagates one simulated estimate into another
 * simulated plant; it adds pedagogy, not metrology. Same voice as the ADR-0004
 * pipes: see ADR-0011 and docs/TELEMETRY.md.
 */

import { HALL, LORENTZ_SLED } from '../../../generated/physics-constants';
import type { DevicePhysicsState } from './device-physics';

const COUPLING_STORAGE_KEY = 'seg-field-coupling';

/** Physics-state keys a coupling edge may read or write (all B, in tesla). */
type FieldKey = keyof Pick<
  DevicePhysicsState,
  'halbachPeakBT' | 'mhdBFieldT' | 'hallFieldT' | 'hallFieldCoupledT' | 'lorentzFieldT' | 'lorentzFieldLocalT'
>;

export interface FieldCouplingEdge {
  /** Device whose simulated field estimate drives the link. */
  from: string;
  /** Device whose plant setpoint is written. */
  to: string;
  /** Source physics-state key (T). */
  sourceKey: FieldKey;
  /** Destination key written by this network (T, or null when uncoupled). */
  destKey: FieldKey;
  /**
   * Destination key holding the *local* bench setpoint restored when coupling
   * is off. Omitted when the destination derives its own local B (Hall takes
   * B from the shared drive control, so there is no slider value to restore).
   */
  localKey?: FieldKey;
  /** Key reporting the B actually in effect on the destination this frame. */
  effectiveKey: FieldKey;
  /** Catalog clamp for the destination plant (T). */
  minT: number;
  maxT: number;
  /** Fallback written to `destKey` when uncoupled and `localKey` is unset. */
  localFallbackT?: number;
  label: string;
}

/**
 * Declarative field graph. Kelvin ↔ VDG is deliberately absent: both are
 * electrostatic and share no B, so a charge/voltage bus is a different model
 * and a later epic (ADR-0011, "Deferred").
 */
export const FIELD_COUPLING_EDGES: FieldCouplingEdge[] = [
  {
    from: 'halbach-viz',
    to: 'hall',
    sourceKey: 'halbachPeakBT',
    destKey: 'hallFieldCoupledT',
    effectiveKey: 'hallFieldT',
    minT: 0,
    maxT: HALL.bMaxT,
    label: 'Halbach peak |B| → Hall strip'
  },
  {
    from: 'mhd',
    to: 'lorentz-sled',
    sourceKey: 'mhdBFieldT',
    destKey: 'lorentzFieldT',
    localKey: 'lorentzFieldLocalT',
    effectiveKey: 'lorentzFieldT',
    minT: 0,
    maxT: LORENTZ_SLED.fieldTMax,
    localFallbackT: LORENTZ_SLED.fieldTDefault,
    label: 'MHD channel B → rail-sled bench field'
  }
];

/** Stable snapshot key for one edge, e.g. `mhd->lorentz-sled`. */
export function fieldLinkKey(from: string, to: string): string {
  return `${from}->${to}`;
}

export interface FieldNetworkDeviceInput {
  physicsState?: Partial<DevicePhysicsState> | null;
  physics?: Partial<DevicePhysicsState> | null;
}

export interface FieldCouplingReading {
  from: string;
  to: string;
  label: string;
  /** Raw source estimate (T) before the destination clamp. */
  sourceT: number;
  /** B in effect on the destination plant this frame (T). */
  appliedT: number;
  /** True when the source estimate fell outside the destination clamp. */
  clamped: boolean;
  /** True when coupling is on *and* both endpoints are enabled. */
  active: boolean;
}

export interface FieldNetworkSnapshot {
  couplingEnabled: boolean;
  links: Record<string, FieldCouplingReading>;
}

export interface FieldNetworkUpdateInput {
  devices: Record<string, FieldNetworkDeviceInput | null | undefined>;
  devicesEnabled: Record<string, boolean>;
}

/** `?fieldCoupling=1|0`, or null when the param is absent so storage decides. */
function readFieldCouplingFromUrl(): boolean | null {
  if (typeof location === 'undefined') return null;
  const v = new URLSearchParams(location.search).get('fieldCoupling');
  if (v === '1') return true;
  if (v === '0') return false;
  return null;
}

/** Effective preference: URL wins over stored, and both default to off. */
export function readFieldCouplingPref(): boolean {
  const fromUrl = readFieldCouplingFromUrl();
  if (fromUrl !== null) return fromUrl;
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(COUPLING_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Remember the toggle across reloads; a storage failure is never fatal. */
export function persistFieldCouplingPref(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(COUPLING_STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {
    /* ignore */
  }
}

/** WebGPU exposes `physicsState`, WebGL2 aliases it as `physics`. */
function physicsOf(dev: FieldNetworkDeviceInput | null | undefined): Partial<DevicePhysicsState> | null {
  return dev?.physicsState ?? dev?.physics ?? null;
}

/** Read a field key only when it holds a usable number (never NaN/Infinity). */
function readNumber(state: Partial<DevicePhysicsState> | null, key: FieldKey): number | null {
  const v = state?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * CPU-side field graph. One instance per LabSession; both GPU backends and the
 * WASM bridge read the setpoints it writes, so `?wasmPhysics=1` and the JS
 * fallback see the same B.
 */
export class FieldNetwork {
  couplingEnabled: boolean;

  private readonly _links = new Map<string, FieldCouplingReading>();

  /** Defaults to the stored/URL preference unless a caller forces the mode. */
  constructor(couplingEnabled?: boolean) {
    this.couplingEnabled = couplingEnabled ?? readFieldCouplingPref();
  }

  /** Flip the bus, persist the choice, and repaint the overview disclaimer. */
  setCouplingEnabled(enabled: boolean): void {
    this.couplingEnabled = !!enabled;
    persistFieldCouplingPref(this.couplingEnabled);
    syncFieldCouplingDisclaimer(this.couplingEnabled, this.getSnapshot());
  }

  /**
   * Write each destination's B for this frame. Call before device physics so
   * the JS plants and the C++ plants step from the same setpoint.
   */
  update(input: FieldNetworkUpdateInput): FieldNetworkSnapshot {
    const { devices, devicesEnabled } = input;

    for (const edge of FIELD_COUPLING_EDGES) {
      const key = fieldLinkKey(edge.from, edge.to);
      const destState = physicsOf(devices[edge.to]);
      const sourceState = physicsOf(devices[edge.from]);
      const endpointsEnabled = devicesEnabled[edge.from] !== false && devicesEnabled[edge.to] !== false;
      const sourceT = readNumber(sourceState, edge.sourceKey) ?? 0;
      const active = this.couplingEnabled && endpointsEnabled && sourceState != null;

      if (destState) {
        if (active) {
          const clampedT = Math.max(edge.minT, Math.min(edge.maxT, sourceT));
          (destState as Record<string, unknown>)[edge.destKey] = clampedT;
        } else if (edge.localKey) {
          const local = readNumber(destState, edge.localKey) ?? edge.localFallbackT ?? 0;
          (destState as Record<string, unknown>)[edge.destKey] = local;
        } else {
          // No local slider to restore — hand the plant back its own local rule.
          (destState as Record<string, unknown>)[edge.destKey] = null;
        }
      }

      const appliedT = readNumber(destState, edge.effectiveKey) ?? 0;
      this._links.set(key, {
        from: edge.from,
        to: edge.to,
        label: edge.label,
        sourceT,
        appliedT,
        clamped: active && (sourceT > edge.maxT || sourceT < edge.minT),
        active
      });
    }

    return this.getSnapshot();
  }

  /** Last computed reading for one edge, or null if it has never run. */
  getLink(from: string, to: string): FieldCouplingReading | null {
    return this._links.get(fieldLinkKey(from, to)) ?? null;
  }

  /** The live coupling feeding a destination device, if any is active. */
  getLinkForDestination(deviceId: string): FieldCouplingReading | null {
    for (const link of this._links.values()) {
      if (link.to === deviceId) return link;
    }
    return null;
  }

  /** Plain-object copy for the telemetry hub and the UI. */
  getSnapshot(): FieldNetworkSnapshot {
    return {
      couplingEnabled: this.couplingEnabled,
      links: Object.fromEntries(this._links)
    };
  }
}

/** Overview disclaimer line — mirrors `syncEnergyCouplingDisclaimer`'s voice. */
export function syncFieldCouplingDisclaimer(
  couplingEnabled?: boolean,
  snapshot?: FieldNetworkSnapshot
): void {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('fieldCouplingDisclaimer');
  if (!el) return;
  const coupled = couplingEnabled ?? readFieldCouplingPref();
  const links = Object.values(snapshot?.links ?? {}).filter((l) => l.active);

  if (coupled && links.length) {
    const parts = links.map((l) => `${l.from}→${l.to} ${l.appliedT.toFixed(2)} T`);
    el.textContent = `Field coupling: on · ${parts.join(' · ')}`
      + ' — simulated estimate propagated between plants, not Maxwell and not metrology';
  } else if (coupled) {
    el.textContent = 'Field coupling: on — destination B follows a simulated source estimate'
      + ' (not Maxwell, not metrology)';
  } else {
    el.textContent = 'Field coupling: off — Hall and rail-sled B are local bench parameters';
  }

  el.dataset.mode = coupled ? 'coupled' : 'local';
  el.dataset.activeLinks = String(links.length);
}

/** Paint the overview line once at boot, before the first frame publishes. */
export function initFieldCouplingDisclaimer(): void {
  syncFieldCouplingDisclaimer(readFieldCouplingPref());
}
