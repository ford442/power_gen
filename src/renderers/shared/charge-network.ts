/**
 * Shared lab **charge** network — optional live voltage coupling between the
 * two electrostatic benches (ADR-0013).
 *
 * Third sibling of `energy-network.ts` (watts, ADR-0004) and `field-network.ts`
 * (tesla, ADR-0011), on its own switch (`?chargeCoupling=1` /
 * `localStorage seg-charge-coupling`). Kelvin and the Van de Graaff share no B,
 * so folding them into `FieldNetwork` would claim a magnetic link that does not
 * exist; and one toggle meaning "watts, tesla and coulombs are all live" would
 * be a claim none of the three buses can make alone.
 *
 * Off (the default) both benches keep their isolated voltages. On, the Van de
 * Graaff sphere's potential *at the Kelvin inductor* is estimated as
 * `V_sphere · r_sphere / d` — the potential of an isolated charged sphere at
 * distance d — clamped to Kelvin's own breakdown voltage, and written into the
 * Kelvin plant as a seed bias on its induction term. The dropper then climbs
 * from a biased start instead of from its own small imbalance.
 *
 * **Not Maxwell, not a spark-gap SPICE net.** `d` is a declared classroom bench
 * separation (`physics/constants.json chargeCoupling`), not the scene layout and
 * not a measurement; the estimate ignores the floor, the dropper's own
 * conductors and every other image charge. The bus copies one lumped number
 * into another lumped plant before it steps — it does not solve Laplace, and
 * the kilovolts it moves are simulated, not calibrated.
 *
 * One direction only in v1: `vdg → kelvin`. A reverse edge would close a loop
 * whose residual nobody accounts for, so `assertChargeGraph` rejects it.
 */

import { CHARGE_COUPLING, VDG } from '../../../generated/physics-constants';
import type { DevicePhysicsState } from './device-physics';

const COUPLING_STORAGE_KEY = 'seg-charge-coupling';

/** Physics-state keys a charge edge may read or write (all volts). */
type ChargeKey = keyof Pick<DevicePhysicsState, 'vdgVoltage' | 'kelvinSeedCoupledV' | 'kelvinVbreak'>;

export interface ChargeCouplingEdge {
  /** Device whose simulated voltage drives the link. */
  from: string;
  /** Device whose plant setpoint is written. */
  to: string;
  /** Source physics-state key (V). */
  sourceKey: ChargeKey;
  /** Destination key written by this network (V, or null when uncoupled). */
  destKey: ChargeKey;
  /**
   * Source V → destination seed V. For `vdg → kelvin` this is r_sphere / d,
   * the isolated-sphere potential fall-off — a lumped estimate, not a solve.
   */
  gain: number;
  /** Lower clamp (V). */
  minV: number;
  /** Destination key holding the upper clamp — the bench's own breakdown V. */
  maxKey: ChargeKey;
  label: string;
}

/**
 * Declarative charge graph. `vdg → kelvin` is the one honest direction: a
 * charged object near the inductor rings is exactly how a Kelvin dropper is
 * seeded in a real classroom. The reverse (dropper terminal feeding belt
 * current) would need a wire and a current path this lab does not model.
 */
export const CHARGE_COUPLING_EDGES: ChargeCouplingEdge[] = [
  {
    from: 'vdg',
    to: 'kelvin',
    sourceKey: 'vdgVoltage',
    destKey: 'kelvinSeedCoupledV',
    gain: VDG.sphereRadiusM / CHARGE_COUPLING.vdgToKelvinSeparationM,
    minV: 0,
    maxKey: 'kelvinVbreak',
    label: 'VdG sphere potential at the Kelvin inductor (V·r/d)'
  }
];

/**
 * Graph invariants: one live source per destination, and no edge whose reverse
 * is also wired (a two-way loop would need its residual shown and labelled
 * simulated accounting, which v1 does not do). Throws with the offending pair.
 */
export function assertChargeGraph(edges: readonly ChargeCouplingEdge[] = CHARGE_COUPLING_EDGES): void {
  const destinations = new Set<string>();
  const pairs = new Set<string>();
  for (const e of edges) {
    if (destinations.has(e.to)) throw new Error(`charge bus: '${e.to}' has more than one source`);
    destinations.add(e.to);
    if (pairs.has(chargeLinkKey(e.to, e.from))) {
      throw new Error(`charge bus: ${e.from} ↔ ${e.to} wired both ways`);
    }
    pairs.add(chargeLinkKey(e.from, e.to));
    if (!(e.gain > 0) || !Number.isFinite(e.gain)) throw new Error(`charge bus: ${e.from}→${e.to} gain must be finite and > 0`);
  }
}

/** Stable snapshot key for one edge, e.g. `vdg->kelvin`. */
export function chargeLinkKey(from: string, to: string): string {
  return `${from}->${to}`;
}

export interface ChargeNetworkDeviceInput {
  physicsState?: Partial<DevicePhysicsState> | null;
  physics?: Partial<DevicePhysicsState> | null;
}

export interface ChargeCouplingReading {
  from: string;
  to: string;
  label: string;
  /** Raw source voltage (V), before the gain. */
  sourceV: number;
  /** Seed estimate at the destination (V) = gain × sourceV, before the clamp. */
  estimateV: number;
  /** Seed actually written to the destination plant this frame (V; 0 when inactive). */
  appliedV: number;
  /** Upper clamp in force — the destination's own breakdown voltage (V). */
  maxV: number;
  /** True when the estimate fell outside the destination clamp. */
  clamped: boolean;
  /** True when coupling is on *and* both endpoints are enabled. */
  active: boolean;
}

export interface ChargeNetworkSnapshot {
  couplingEnabled: boolean;
  links: Record<string, ChargeCouplingReading>;
}

export interface ChargeNetworkUpdateInput {
  devices: Record<string, ChargeNetworkDeviceInput | null | undefined>;
  devicesEnabled: Record<string, boolean>;
}

/** `?chargeCoupling=1|0`, or null when the param is absent so storage decides. */
function readChargeCouplingFromUrl(): boolean | null {
  if (typeof location === 'undefined') return null;
  const v = new URLSearchParams(location.search).get('chargeCoupling');
  if (v === '1') return true;
  if (v === '0') return false;
  return null;
}

/** Effective preference: URL wins over stored, and both default to off. */
export function readChargeCouplingPref(): boolean {
  const fromUrl = readChargeCouplingFromUrl();
  if (fromUrl !== null) return fromUrl;
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(COUPLING_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Remember the toggle across reloads; a storage failure is never fatal. */
export function persistChargeCouplingPref(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(COUPLING_STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {
    /* ignore */
  }
}

/** WebGPU exposes `physicsState`, WebGL2 aliases it as `physics`. */
function physicsOf(dev: ChargeNetworkDeviceInput | null | undefined): Partial<DevicePhysicsState> | null {
  return dev?.physicsState ?? dev?.physics ?? null;
}

/** Read a voltage key only when it holds a usable number (never NaN/Infinity). */
function readNumber(state: Partial<DevicePhysicsState> | null, key: ChargeKey): number | null {
  const v = state?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * The seed a destination plant should step from, given a source voltage:
 * `clamp(gain × sourceV, minV, maxV)`. Pure, so the unit test and the bus
 * share one definition.
 */
export function chargeSeedV(edge: Pick<ChargeCouplingEdge, 'gain' | 'minV'>, sourceV: number, maxV: number): number {
  const estimate = edge.gain * (Number.isFinite(sourceV) ? sourceV : 0);
  const hi = Number.isFinite(maxV) ? Math.max(edge.minV, maxV) : edge.minV;
  return Math.max(edge.minV, Math.min(hi, estimate));
}

/**
 * CPU-side charge graph. One instance per LabSession; both GPU backends and the
 * WASM bridge read the seed it writes, so `?wasmPhysics=1` and the JS fallback
 * step Kelvin from the same number.
 */
export class ChargeNetwork {
  couplingEnabled: boolean;

  private readonly _links = new Map<string, ChargeCouplingReading>();

  /** Defaults to the stored/URL preference unless a caller forces the mode. */
  constructor(couplingEnabled?: boolean) {
    assertChargeGraph();
    this.couplingEnabled = couplingEnabled ?? readChargeCouplingPref();
  }

  /** Flip the bus, persist the choice, and repaint the overview disclaimer. */
  setCouplingEnabled(enabled: boolean): void {
    this.couplingEnabled = !!enabled;
    persistChargeCouplingPref(this.couplingEnabled);
    syncChargeCouplingDisclaimer(this.couplingEnabled, this.getSnapshot());
  }

  /**
   * Write each destination's seed for this frame. Call before device physics
   * (and before `FieldNetwork.update`) so the JS and C++ plants step from the
   * same setpoint. A pre-step write, not a second ODE.
   */
  update(input: ChargeNetworkUpdateInput): ChargeNetworkSnapshot {
    const { devices, devicesEnabled } = input;

    for (const edge of CHARGE_COUPLING_EDGES) {
      const key = chargeLinkKey(edge.from, edge.to);
      const destState = physicsOf(devices[edge.to]);
      const sourceState = physicsOf(devices[edge.from]);
      const endpointsEnabled = devicesEnabled[edge.from] !== false && devicesEnabled[edge.to] !== false;
      const sourceV = readNumber(sourceState, edge.sourceKey) ?? 0;
      const maxV = readNumber(destState, edge.maxKey) ?? 0;
      const estimateV = edge.gain * sourceV;
      const active = this.couplingEnabled && endpointsEnabled && sourceState != null && destState != null;

      let appliedV = 0;
      if (destState) {
        if (active) {
          appliedV = chargeSeedV(edge, sourceV, maxV);
          (destState as Record<string, unknown>)[edge.destKey] = appliedV;
        } else {
          // Isolated bench: hand the plant back its own start.
          (destState as Record<string, unknown>)[edge.destKey] = null;
        }
      }

      this._links.set(key, {
        from: edge.from,
        to: edge.to,
        label: edge.label,
        sourceV,
        estimateV,
        appliedV,
        maxV,
        clamped: active && (estimateV > maxV || estimateV < edge.minV),
        active
      });
    }

    return this.getSnapshot();
  }

  /** Last computed reading for one edge, or null if it has never run. */
  getLink(from: string, to: string): ChargeCouplingReading | null {
    return this._links.get(chargeLinkKey(from, to)) ?? null;
  }

  /** The coupling feeding a destination device (one source per destination). */
  getLinkForDestination(deviceId: string): ChargeCouplingReading | null {
    for (const link of this._links.values()) {
      if (link.to === deviceId) return link;
    }
    return null;
  }

  /** Plain-object copy for the telemetry hub and the UI. */
  getSnapshot(): ChargeNetworkSnapshot {
    return {
      couplingEnabled: this.couplingEnabled,
      links: Object.fromEntries(this._links)
    };
  }
}

function formatKv(v: number): string {
  return Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)} kV` : `${v.toFixed(0)} V`;
}

/** Overview disclaimer line — same voice as the field and energy lines. */
export function syncChargeCouplingDisclaimer(
  couplingEnabled?: boolean,
  snapshot?: ChargeNetworkSnapshot
): void {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('chargeCouplingDisclaimer');
  if (!el) return;
  const coupled = couplingEnabled ?? readChargeCouplingPref();
  const links = Object.values(snapshot?.links ?? {}).filter((l) => l.active);

  if (coupled && links.length) {
    const parts = links.map((l) => `${l.from}→${l.to} seed ${formatKv(l.appliedV)}${l.clamped ? ' (clamped)' : ''}`);
    el.textContent = `Charge coupling: on · ${parts.join(' · ')}`
      + ' — simulated V·r/d estimate, not a Laplace solve and not calibrated kilovolts';
  } else if (coupled) {
    el.textContent = 'Charge coupling: on — Kelvin seed follows the VdG sphere estimate'
      + ' (simulated, not calibrated kilovolts)';
  } else {
    el.textContent = 'Charge coupling: off — Kelvin and Van de Graaff keep isolated bench voltages';
  }

  el.dataset.mode = coupled ? 'coupled' : 'local';
  el.dataset.activeLinks = String(links.length);
}

/** Paint the overview line once at boot, before the first frame publishes. */
export function initChargeCouplingDisclaimer(): void {
  syncChargeCouplingDisclaimer(readChargeCouplingPref());
}
