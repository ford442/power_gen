/**
 * Shared lab energy network — declarative pipe graph + optional power-budget coupling.
 *
 * Phase A: visual pipes stay driven by per-device energyLevel; when coupling is enabled,
 * outgoing pipe flow is clamped by estimated source watts (SEG uses TelemetryHub power).
 *
 * Pipes are **not** metrology — see ADR-0004 and docs/TELEMETRY.md.
 */

export interface EnergyPipeEdge {
  from: string;
  to: string;
  /** Nominal pipe capacity (W) used for flow normalization when coupling is on. */
  maxWatts: number;
  speed?: number;
}

/** Declarative overview pipe graph (from / to / maxWatts). */
export const ENERGY_PIPE_EDGES: EnergyPipeEdge[] = [
  { from: 'seg', to: 'heron', maxWatts: 1500, speed: 2.0 },
  { from: 'heron', to: 'kelvin', maxWatts: 800, speed: 1.5 },
  { from: 'kelvin', to: 'seg', maxWatts: 600, speed: 2.5 },
  { from: 'kelvin', to: 'peltier', maxWatts: 400, speed: 1.8 },
  { from: 'peltier', to: 'solar', maxWatts: 500, speed: 2.2 },
  { from: 'seg', to: 'mhd', maxWatts: 1200, speed: 1.6 },
  { from: 'mhd', to: 'peltier', maxWatts: 700, speed: 2.0 },
  { from: 'solar', to: 'maglev', maxWatts: 450, speed: 1.4 },
  { from: 'maglev', to: 'seg', maxWatts: 550, speed: 1.9 }
];

export const PIPE_COLORS: Record<string, [number, number, number]> = {
  'seg-heron': [0.15, 0.92, 0.75],
  'heron-kelvin': [0.25, 0.65, 1.0],
  'kelvin-seg': [0.72, 0.45, 1.0],
  'kelvin-peltier': [0.55, 0.35, 0.95],
  'peltier-solar': [1.0, 0.82, 0.25],
  'seg-mhd': [0.35, 0.88, 1.0],
  'mhd-peltier': [0.45, 0.75, 1.0],
  'solar-maglev': [0.25, 0.92, 1.0],
  'maglev-seg': [0.15, 0.85, 0.95]
};

/** Simulated nameplate draw per device when telemetry watts are unavailable. */
export const DEVICE_NOMINAL_WATTS: Record<string, number> = {
  seg: 2000,
  heron: 400,
  kelvin: 150,
  solar: 300,
  peltier: 120,
  mhd: 350,
  maglev: 200,
  homopolar: 250,
  'halbach-viz': 80
};

const COUPLING_STORAGE_KEY = 'seg-energy-coupling';

export interface DeviceAnchorInput {
  id?: string;
  position?: number[];
  config?: { position?: number[] };
}

export function pipeColorKey(from: string, to: string): string {
  return `${from}-${to}`;
}

export function getPipeColor(from: string, to: string): [number, number, number] {
  return PIPE_COLORS[pipeColorKey(from, to)] ?? [0.4, 0.9, 1.0];
}

export function deviceAnchor(dev: DeviceAnchorInput | null | undefined): [number, number, number] {
  if (!dev) return [0, 2, 0];
  const pos = dev.config?.position || dev.position || [0, 0, 0];
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

export interface EnergyNetworkSnapshot {
  couplingEnabled: boolean;
  labBudgetW: number;
  totalAllocatedW: number;
  residualW: number;
  pipes: Record<string, number>;
  devices: Record<string, DevicePowerReading>;
}

function readEnergyCouplingFromUrl(): boolean | null {
  if (typeof location === 'undefined') return null;
  const v = new URLSearchParams(location.search).get('energyCoupling');
  if (v === '1') return true;
  if (v === '0') return false;
  return null;
}

export function readEnergyCouplingPref(): boolean {
  const fromUrl = readEnergyCouplingFromUrl();
  if (fromUrl !== null) return fromUrl;
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(COUPLING_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function persistEnergyCouplingPref(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(COUPLING_STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {
    /* ignore */
  }
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

  constructor(couplingEnabled?: boolean) {
    this.couplingEnabled = couplingEnabled ?? readEnergyCouplingPref();
  }

  setCouplingEnabled(enabled: boolean): void {
    this.couplingEnabled = enabled;
    persistEnergyCouplingPref(enabled);
    syncEnergyCouplingDisclaimer();
  }

  update(input: EnergyNetworkUpdateInput): EnergyNetworkSnapshot {
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
      devices: Object.fromEntries(this._devicePower)
    };
  }
}

/** Small overview disclaimer — updated when coupling mode changes. */
export function syncEnergyCouplingDisclaimer(couplingEnabled?: boolean): void {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('energyNetworkDisclaimer');
  if (!el) return;
  const coupled = couplingEnabled ?? readEnergyCouplingPref();
  el.textContent = coupled
    ? 'Energy pipes: coupled power budget (simulated — not calibrated metrology)'
    : 'Energy pipes: visual only — glow is not measured watts';
  el.dataset.mode = coupled ? 'coupled' : 'visual';
}

export function initEnergyCouplingDisclaimer(): void {
  syncEnergyCouplingDisclaimer(readEnergyCouplingPref());
}
