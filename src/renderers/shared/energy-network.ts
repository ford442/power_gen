/**
 * Shared lab energy network — declarative pipe graph + optional power-budget coupling.
 *
 * Phase A: visual pipes stay driven by per-device energyLevel; when coupling is enabled,
 * outgoing pipe flow is clamped by estimated source watts (SEG uses TelemetryHub power).
 * Phase B: when ?wasmPhysics=1 and coupling is on, budget allocation runs in sim_core.
 *
 * Pipes are **not** metrology — see ADR-0004 and docs/TELEMETRY.md.
 */

import { CIRCUIT_PORT_DEVICES } from '../../../generated/circuit-ports';
import { ENERGY_NETWORK_NAMEPLATES } from '../../../generated/physics-constants';
import { ENERGY_PIPE_CATALOG } from '../../../generated/lab-coupling';
import { labConfig, persistLabConfig } from '../../config/lab-config';

interface SegWasmEnergyBus {
  enabled?: boolean;
  setNetworkEdges?(edges: EnergyPipeEdge[]): void;
  updateEnergyNetwork?(input: {
    couplingEnabled: boolean;
    segPowerW: number;
    segEfficiencyPct: number;
    energyByDevice: Record<string, number>;
    enabledByDevice: Record<string, boolean>;
  }): { labBudgetW: number; totalAllocatedW: number; residualW: number };
  getNetworkEdgeAllocatedW?(edgeIndex: number): number;
  getNetworkDevicePower?(deviceId: string): DevicePowerReading;
}

function getSegWasmBus(): SegWasmEnergyBus | null {
  if (typeof window === 'undefined') return null;
  return (window as Window & { segWasm?: SegWasmEnergyBus }).segWasm ?? null;
}

export interface EnergyPipeEdge {
  from: string;
  to: string;
  /** Nominal pipe capacity (W) used for flow normalization when coupling is on. */
  maxWatts: number;
  speed?: number;
}

/**
 * Declarative overview pipe graph (from / to / maxWatts), generated from
 * `physics/coupling.json` so the native `--mode energy-network` smoke walks
 * the same graph. New pipes take their capacity from a device nameplate in
 * `physics/constants.json`; codegen refuses a nameplate that does not exist, so
 * a bench with no honest watt figure gets no pipe rather than an invented one
 * (pulse-coil's is derived from its recharge constants). Allocation is
 * simulated accounting (ADR-0004), not metrology.
 */
export const ENERGY_PIPE_EDGES: EnergyPipeEdge[] = ENERGY_PIPE_CATALOG.map((row) => ({
  from: row.from,
  to: row.to,
  maxWatts: row.maxWatts,
  speed: row.speed
}));

export const PIPE_COLORS: Record<string, [number, number, number]> = Object.fromEntries(
  ENERGY_PIPE_CATALOG.map((row) => [
    `${row.from}-${row.to}`,
    [row.color[0], row.color[1], row.color[2]] as [number, number, number]
  ])
);

/** Simulated nameplate draw per device when telemetry watts are unavailable. */
export const DEVICE_NOMINAL_WATTS: Record<string, number> = {
  ...ENERGY_NETWORK_NAMEPLATES.deviceNameplateWatts
};

/** True when non-SEG nameplates are order-of-magnitude estimates (not calibrated). */
export const DEVICE_NAMEPLATE_SIMULATED = ENERGY_NETWORK_NAMEPLATES.simulatedOrderOfMagnitude;

export interface DeviceAnchorInput {
  id?: string;
  position?: ArrayLike<number>;
  config?: Record<string, unknown>;
}

export function pipeColorKey(from: string, to: string): string {
  return `${from}-${to}`;
}

export function getPipeColor(from: string, to: string): [number, number, number] {
  return PIPE_COLORS[pipeColorKey(from, to)] ?? [0.4, 0.9, 1.0];
}

export function deviceAnchor(dev: DeviceAnchorInput | null | undefined): [number, number, number] {
  if (!dev) return [0, 2, 0];
  const configPos = dev.config?.position as ArrayLike<number> | undefined;
  const pos = configPos || dev.position || [0, 0, 0];
  const id = dev.id || '';
  const yBoost = id === 'solar' ? 1.5 : id === 'heron' ? 3.0 : 2.2;
  return [pos[0], pos[1] + yBoost, pos[2]];
}

export function bezierControlPoints(
  p0: [number, number, number],
  p3: [number, number, number]
): { p0: [number, number, number]; p1: [number, number, number]; p2: [number, number, number]; p3: [number, number, number] } {
  const lift = 3.5 + Math.abs(p0[0] - p3[0]) * 0.08 + Math.abs(p0[2] - p3[2]) * 0.08;
  const mid: [number, number, number] = [
    (p0[0] + p3[0]) * 0.5,
    Math.max(p0[1], p3[1]) + lift,
    (p0[2] + p3[2]) * 0.5
  ];
  const p1: [number, number, number] = [
    p0[0] + (mid[0] - p0[0]) * 0.45,
    p0[1] + lift * 0.55,
    p0[2] + (mid[2] - p0[2]) * 0.45
  ];
  const p2: [number, number, number] = [
    p3[0] + (mid[0] - p3[0]) * 0.45,
    p3[1] + lift * 0.55,
    p3[2] + (mid[2] - p3[2]) * 0.45
  ];
  return { p0, p1, p2, p3 };
}

export function isPipeEndpointEnabled(
  from: string,
  to: string,
  devicesEnabled: Record<string, boolean> | null | undefined
): boolean {
  return !!(devicesEnabled?.[from] && devicesEnabled?.[to]);
}

export interface PipeFlowInput {
  sourceEnergy: number;
  enabled: boolean;
  currentFlow: number;
  deltaTime: number;
  /** Multiplier from power-budget clamping (1 = visual-only). */
  budgetScale?: number;
}

/** Smoothed 0–1 pipe intensity from source energy and optional budget scale. */
export function computePipeFlowLevel(input: PipeFlowInput): number {
  const { sourceEnergy, enabled, currentFlow, deltaTime, budgetScale = 1 } = input;
  const target = enabled ? (0.12 + sourceEnergy * 0.88) * Math.max(0, Math.min(1, budgetScale)) : 0;
  const smooth = 1 - Math.exp(-Math.max(0, deltaTime) * 6);
  return currentFlow + (target - currentFlow) * smooth;
}

export interface DevicePowerReading {
  powerInW: number;
  powerOutW: number;
  efficiency: number;
}

export interface EnergyNetworkDeviceInput {
  energyLevel?: number;
  physics?: { energyLevel?: number };
  physicsState?: { energyLevel?: number };
}

export interface EnergyNetworkUpdateInput {
  devices: Record<string, EnergyNetworkDeviceInput | null | undefined>;
  devicesEnabled: Record<string, boolean>;
  /** SEG electrical output (W) from TelemetryHub / segOperator. */
  segPowerW: number;
  /** SEG conversion efficiency (%) when available. */
  segEfficiencyPct?: number;
  deltaTime: number;
}

/** One bench ⇄ circuit edge the Circuit Lab solves (#256): Σ v·i at the port, not an estimate. */
export interface SolvedEnergyEdge {
  from: string;
  to: string;
  /** Mean power over the last second, W (> 0: into the circuit). */
  powerW: number;
  /** rms terminal current over the last substep, A — the cable's flow. */
  currentA: number;
}

/** The Circuit Lab's end of a cable (#256): a bench in front of the overview, not a device. */
export const CIRCUIT_ANCHOR_ID = 'circuit';
export const CIRCUIT_BENCH_POSITION: readonly [number, number, number] = [0, 0, 14];
const CIRCUIT_ANCHOR: DeviceAnchorInput = { id: CIRCUIT_ANCHOR_ID, position: CIRCUIT_BENCH_POSITION };

/** One potential cable per bench with a catalog port; dark until it is wired. */
export const CIRCUIT_CABLE_EDGES: readonly { from: string; to: string; speed: number }[] = CIRCUIT_PORT_DEVICES.map(
  (from) => ({ from, to: CIRCUIT_ANCHOR_ID, speed: 2.2 })
);

/** A pipe endpoint: the device, or the circuit bench anchor. */
export function pipeEndpoint<T extends DeviceAnchorInput>(devices: Record<string, T | undefined>, id: string): T | DeviceAnchorInput | undefined {
  return devices[id] ?? (id === CIRCUIT_ANCHOR_ID ? CIRCUIT_ANCHOR : undefined);
}

/** Cable flow from current: ∝ |I| below ~1 A, saturating above (a glow, not a meter). */
export function cableFlow(currentA: number): number {
  const i = Math.abs(currentA);
  return Number.isFinite(i) ? i / (i + 1) : 0;
}

/** The Circuit Lab's energy books for the wired subset (src/circuit/host.ts). */
export interface SolvedEnergyBooks {
  edges: SolvedEnergyEdge[];
  /** |W_source − W_dissipated − ΔE_stored| / flow over the last second. */
  residual: number;
  sourceW: number;
  dissipatedW: number;
}

export interface EnergyNetworkSnapshot {
  couplingEnabled: boolean;
  labBudgetW: number;
  totalAllocatedW: number;
  residualW: number;
  pipes: Record<string, number>;
  devices: Record<string, DevicePowerReading>;
  /** Present while a circuit is wired: the solved edges and their conservation check. */
  solved?: SolvedEnergyBooks;
}

/** Effective preference: URL (or share link) wins over stored; default off. */
export function readEnergyCouplingPref(): boolean {
  return labConfig().energyCoupling;
}

/** Remember the toggle across reloads; a storage failure is never fatal. */
export function persistEnergyCouplingPref(enabled: boolean): void {
  persistLabConfig('energyCoupling', enabled);
}

function deviceEnergyLevel(dev: EnergyNetworkDeviceInput | null | undefined): number {
  if (!dev) return 0;
  return dev.physicsState?.energyLevel ?? dev.physics?.energyLevel ?? dev.energyLevel ?? 0;
}

function estimateDevicePowerOutW(
  deviceId: string,
  energyLevel: number,
  enabled: boolean,
  segPowerW: number
): number {
  if (!enabled) return 0;
  if (deviceId === 'seg') return Math.max(0, segPowerW);
  const nominal = DEVICE_NOMINAL_WATTS[deviceId] ?? 200;
  return Math.max(0, energyLevel * nominal);
}

/**
 * CPU-side lab power graph. One instance per visualizer (WebGPU / WebGL2).
 */
export class EnergyNetwork {
  couplingEnabled: boolean;
  labBudgetW = 0;
  totalAllocatedW = 0;
  residualW = 0;

  private readonly _pipeFlows = new Map<string, number>();
  private readonly _devicePower = new Map<string, DevicePowerReading>();
  private _wasmEdgesSynced = false;
  /**
   * Set once when the WASM bus throws; from then on the JS bus runs for the
   * rest of the session. A bus error must never take the frame loop down.
   */
  wasmFallbackReason: string | null = null;

  private _solved: (() => SolvedEnergyBooks) | null = null;

  constructor(couplingEnabled?: boolean) {
    this.couplingEnabled = couplingEnabled ?? readEnergyCouplingPref();
  }

  /**
   * The Circuit Lab's solved edges (#256): while a circuit is wired its port
   * powers come from the solver, and its residual is a real conservation
   * check for that subset. Every catalog pipe stays an estimate.
   */
  setSolvedEdges(provider: (() => SolvedEnergyBooks) | null): void {
    this._solved = provider;
  }

  private _useWasmBus(): boolean {
    if (this.wasmFallbackReason !== null) return false;
    const bus = getSegWasmBus();
    return this.couplingEnabled && !!bus?.enabled;
  }

  /** Which allocator ran last frame — `getRendererInfo().energyBus`. */
  busStatus(): { backend: 'wasm' | 'js'; fallbackReason: string | null } {
    return { backend: this._useWasmBus() ? 'wasm' : 'js', fallbackReason: this.wasmFallbackReason };
  }

  private _syncWasmEdges(): void {
    const bus = getSegWasmBus();
    if (!this._useWasmBus() || this._wasmEdgesSynced || !bus?.setNetworkEdges) return;
    bus.setNetworkEdges(ENERGY_PIPE_EDGES);
    this._wasmEdgesSynced = true;
  }

  setCouplingEnabled(enabled: boolean): void {
    this.couplingEnabled = enabled;
    persistEnergyCouplingPref(enabled);
    syncEnergyCouplingDisclaimer();
  }

  update(input: EnergyNetworkUpdateInput): EnergyNetworkSnapshot {
    let snap: EnergyNetworkSnapshot | null = null;
    if (this._useWasmBus()) {
      try {
        snap = this._updateWasm(input);
      } catch (err) {
        this.wasmFallbackReason = err instanceof Error ? err.message : String(err);
        console.warn('[EnergyNetwork] WASM energy bus failed — JS bus for the rest of the session:', err);
      }
    }
    snap ??= this._updateJs(input);
    this._updateCables(snap.solved);
    return snap;
  }

  /** Circuit Lab cables: flow from the solved port currents; dark when unwired. */
  private _updateCables(solved: SolvedEnergyBooks | undefined): void {
    for (const c of CIRCUIT_CABLE_EDGES) {
      const edge = solved?.edges.find((e) => e.from === c.from);
      this._pipeFlows.set(pipeColorKey(c.from, c.to), edge ? Math.max(0.05, cableFlow(edge.currentA)) : 0);
    }
  }

  private _updateWasm(input: EnergyNetworkUpdateInput): EnergyNetworkSnapshot {
    const { devices, devicesEnabled, segPowerW, segEfficiencyPct = 0, deltaTime } = input;
    const bus = getSegWasmBus();
    if (!bus?.updateEnergyNetwork) return this._updateJs(input);

    this._syncWasmEdges();

    const energyByDevice: Record<string, number> = {};
    for (const [id, dev] of Object.entries(devices)) {
      if (!dev) continue;
      energyByDevice[id] = deviceEnergyLevel(dev);
    }

    const summary = bus.updateEnergyNetwork({
      couplingEnabled: true,
      segPowerW,
      segEfficiencyPct,
      energyByDevice,
      enabledByDevice: devicesEnabled
    });

    this.labBudgetW = summary.labBudgetW;
    this.totalAllocatedW = summary.totalAllocatedW;
    this.residualW = summary.residualW;

    const powerOutByDevice = new Map<string, number>();
    const energyByDeviceMap = new Map<string, number>();
    for (const [id, dev] of Object.entries(devices)) {
      if (!dev) continue;
      energyByDeviceMap.set(id, deviceEnergyLevel(dev));
      const wasmPower = bus.getNetworkDevicePower?.(id) ?? { powerInW: 0, powerOutW: 0, efficiency: 0 };
      powerOutByDevice.set(id, wasmPower.powerOutW);
    }

    const requestedBySource = new Map<string, number>();
    const allocatedByEdge = new Map<string, number>();

    for (let i = 0; i < ENERGY_PIPE_EDGES.length; i++) {
      const edge = ENERGY_PIPE_EDGES[i];
      const key = pipeColorKey(edge.from, edge.to);
      const enabled = isPipeEndpointEnabled(edge.from, edge.to, devicesEnabled);
      const sourceEnergy = energyByDeviceMap.get(edge.from) ?? 0;
      const visual = 0.12 + sourceEnergy * 0.88;
      const requestedW = enabled ? visual * edge.maxWatts : 0;
      requestedBySource.set(edge.from, (requestedBySource.get(edge.from) ?? 0) + requestedW);
      allocatedByEdge.set(key, bus.getNetworkEdgeAllocatedW?.(i) ?? 0);
    }

    for (const edge of ENERGY_PIPE_EDGES) {
      const key = pipeColorKey(edge.from, edge.to);
      const enabled = isPipeEndpointEnabled(edge.from, edge.to, devicesEnabled);
      const sourceEnergy = energyByDeviceMap.get(edge.from) ?? 0;
      const sourcePower = powerOutByDevice.get(edge.from) ?? 0;
      const totalRequested = requestedBySource.get(edge.from) ?? 0;
      const budgetScale = totalRequested > 1e-6 ? Math.min(1, sourcePower / totalRequested) : 0;

      const prev = this._pipeFlows.get(key) ?? 0;
      const flow = computePipeFlowLevel({
        sourceEnergy,
        enabled,
        currentFlow: prev,
        deltaTime,
        budgetScale
      });
      this._pipeFlows.set(key, flow);
      if (!enabled && flow < 0.02) this._pipeFlows.set(key, 0);
    }

    this._devicePower.clear();
    for (const [id, dev] of Object.entries(devices)) {
      if (!dev) continue;
      this._devicePower.set(id, bus.getNetworkDevicePower?.(id) ?? { powerInW: 0, powerOutW: 0, efficiency: 0 });
    }

    return this.getSnapshot();
  }

  private _updateJs(input: EnergyNetworkUpdateInput): EnergyNetworkSnapshot {
    const { devices, devicesEnabled, segPowerW, segEfficiencyPct = 0, deltaTime } = input;

    const powerOutByDevice = new Map<string, number>();
    const energyByDevice = new Map<string, number>();
    let labBudgetW = 0;

    for (const [id, dev] of Object.entries(devices)) {
      if (!dev) continue;
      const enabled = devicesEnabled[id] !== false;
      const energy = deviceEnergyLevel(dev);
      energyByDevice.set(id, energy);
      const outW = estimateDevicePowerOutW(id, energy, enabled, segPowerW);
      powerOutByDevice.set(id, outW);
      if (enabled && outW > 0) labBudgetW += outW;
    }

    const allocatedByEdge = new Map<string, number>();
    const requestedBySource = new Map<string, number>();

    for (const edge of ENERGY_PIPE_EDGES) {
      const key = pipeColorKey(edge.from, edge.to);
      const enabled = isPipeEndpointEnabled(edge.from, edge.to, devicesEnabled);
      const sourceEnergy = energyByDevice.get(edge.from) ?? 0;
      const visual = 0.12 + sourceEnergy * 0.88;
      const requestedW = enabled ? visual * edge.maxWatts : 0;
      requestedBySource.set(edge.from, (requestedBySource.get(edge.from) ?? 0) + requestedW);
      allocatedByEdge.set(key, requestedW);
    }

    if (this.couplingEnabled) {
      for (const edge of ENERGY_PIPE_EDGES) {
        const key = pipeColorKey(edge.from, edge.to);
        const sourcePower = powerOutByDevice.get(edge.from) ?? 0;
        const totalRequested = requestedBySource.get(edge.from) ?? 0;
        const scale = totalRequested > 1e-6 ? Math.min(1, sourcePower / totalRequested) : 0;
        const requestedW = allocatedByEdge.get(key) ?? 0;
        allocatedByEdge.set(key, requestedW * scale);
      }
    }

    let totalAllocatedW = 0;
    for (const edge of ENERGY_PIPE_EDGES) {
      const key = pipeColorKey(edge.from, edge.to);
      const allocatedW = allocatedByEdge.get(key) ?? 0;
      totalAllocatedW += allocatedW;

      const enabled = isPipeEndpointEnabled(edge.from, edge.to, devicesEnabled);
      const sourceEnergy = energyByDevice.get(edge.from) ?? 0;
      const sourcePower = powerOutByDevice.get(edge.from) ?? 0;
      const totalRequested = requestedBySource.get(edge.from) ?? 0;
      const budgetScale = !this.couplingEnabled
        ? 1
        : totalRequested > 1e-6
          ? Math.min(1, sourcePower / totalRequested)
          : 0;

      const prev = this._pipeFlows.get(key) ?? 0;
      const flow = computePipeFlowLevel({
        sourceEnergy,
        enabled,
        currentFlow: prev,
        deltaTime,
        budgetScale
      });
      this._pipeFlows.set(key, flow);

      if (!enabled && flow < 0.02) {
        this._pipeFlows.set(key, 0);
      }
    }

    const powerInByDevice = new Map<string, number>();
    for (const edge of ENERGY_PIPE_EDGES) {
      const key = pipeColorKey(edge.from, edge.to);
      const watts = allocatedByEdge.get(key) ?? 0;
      powerInByDevice.set(edge.to, (powerInByDevice.get(edge.to) ?? 0) + watts);
    }

    this._devicePower.clear();
    for (const [id] of Object.entries(devices)) {
      if (!devices[id]) continue;
      const powerInW = powerInByDevice.get(id) ?? 0;
      const powerOutW = powerOutByDevice.get(id) ?? 0;
      let efficiency = 0;
      if (id === 'seg' && segEfficiencyPct > 0) {
        efficiency = segEfficiencyPct;
      } else if (powerInW > 1e-3) {
        efficiency = Math.min(100, (powerOutW / powerInW) * 100);
      }
      this._devicePower.set(id, { powerInW, powerOutW, efficiency });
    }

    this.labBudgetW = labBudgetW;
    this.totalAllocatedW = totalAllocatedW;
    this.residualW = labBudgetW - totalAllocatedW;

    return this.getSnapshot();
  }

  getPipeFlow(from: string, to: string): number {
    return this._pipeFlows.get(pipeColorKey(from, to)) ?? 0;
  }

  getDevicePower(id: string): DevicePowerReading {
    return this._devicePower.get(id) ?? { powerInW: 0, powerOutW: 0, efficiency: 0 };
  }

  getSnapshot(): EnergyNetworkSnapshot {
    return {
      couplingEnabled: this.couplingEnabled,
      labBudgetW: this.labBudgetW,
      totalAllocatedW: this.totalAllocatedW,
      residualW: this.residualW,
      pipes: Object.fromEntries(this._pipeFlows),
      devices: Object.fromEntries(this._devicePower),
      ...(this._solved ? { solved: this._solved() } : {})
    };
  }
}

/** Small overview disclaimer — updated when coupling mode changes. */
export function syncEnergyCouplingDisclaimer(
  couplingEnabled?: boolean,
  snapshot?: Pick<EnergyNetworkSnapshot, 'labBudgetW' | 'totalAllocatedW' | 'residualW' | 'solved'>
): void {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('energyNetworkDisclaimer');
  if (!el) return;
  const coupled = couplingEnabled ?? readEnergyCouplingPref();
  const budget = snapshot?.labBudgetW ?? 0;
  const allocated = snapshot?.totalAllocatedW ?? 0;
  const residual = snapshot?.residualW ?? (budget - allocated);
  const effPct = budget > 1 ? (allocated / budget) * 100 : 0;
  const warn = coupled && Math.abs(residual) > Math.max(50, budget * 0.15);

  if (coupled && snapshot) {
    el.textContent =
      `Energy pipes: coupled · budget ${budget.toFixed(0)} W · allocated ${allocated.toFixed(0)} W`
      + ` · residual ${residual.toFixed(0)} W · η ${effPct.toFixed(0)}%`
      + ' — simulated order-of-magnitude, not metrology';
  } else if (coupled) {
    el.textContent =
      'Energy pipes: coupled power budget (simulated — not calibrated metrology)';
  } else {
    el.textContent = 'Energy pipes: visual only — glow is not measured watts';
  }

  const solved = snapshot?.solved;
  if (solved?.edges.length) {
    const edges = solved.edges.map((e) => `${e.from} → ${e.to} ${e.powerW.toPrecision(3)} W`).join(', ');
    el.textContent += ` · solved (Circuit Lab, Σ v·i): ${edges}, residual ${(solved.residual * 100).toFixed(3)} %`
      + ` · estimated: ${ENERGY_PIPE_EDGES.map((e) => `${e.from}→${e.to}`).join(', ')}`;
    el.dataset.solvedResidual = String(solved.residual);
  } else {
    delete el.dataset.solvedResidual;
  }

  el.dataset.mode = coupled ? 'coupled' : 'visual';
  el.dataset.residualW = String(residual);
  el.dataset.warn = warn ? 'true' : 'false';
  el.classList.toggle('energy-residual-warn', warn);
  el.dataset.nameplateSimulated = DEVICE_NAMEPLATE_SIMULATED ? 'true' : 'false';
}

export function initEnergyCouplingDisclaimer(): void {
  syncEnergyCouplingDisclaimer(readEnergyCouplingPref());
}
