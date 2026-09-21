/**
 * Per-device particle budgets by auto-quality tier (ADR-0005 WS4).
 *
 * Caps `particleCount × viewLod × quality` so overview with 8–12 devices
 * stays near mid-tier FPS. Plugins use lower budgets than SEG / core lab.
 *
 * Tier labels match `PerformanceProfiler.qualityTier`.
 */

export type QualityTier = 'high' | 'medium' | 'low' | 'critical';
export interface TierBudget {
  high: number;
  medium: number;
  low: number;
  critical: number;
}

export const DEFAULT_CORE_PARTICLE_BUDGET: TierBudget = {
  high: 9000,
  medium: 6000,
  low: 3500,
  critical: 1600
};

export const DEFAULT_PLUGIN_PARTICLE_BUDGET: TierBudget = {
  high: 4500,
  medium: 2800,
  low: 1600,
  critical: 800
};

/**
 * Explicit budgets. Missing ids fall back to core vs plugin defaults.
 */
export const DEVICE_PARTICLE_BUDGETS: Record<string, TierBudget> = {
  seg: { high: 10000, medium: 7000, low: 4000, critical: 2000 },
  heron: { high: 8000, medium: 5200, low: 3000, critical: 1400 },
  kelvin: { high: 8000, medium: 5200, low: 3000, critical: 1400 },
  solar: { high: 7500, medium: 4800, low: 2800, critical: 1200 },
  peltier: { high: 9000, medium: 5500, low: 3000, critical: 1400 },
  mhd: { high: 10000, medium: 6000, low: 3200, critical: 1500 },
  maglev: { high: 4500, medium: 2800, low: 1600, critical: 800 },
  homopolar: { high: 5000, medium: 3200, low: 1800, critical: 900 },
  'halbach-viz': { high: 4000, medium: 2500, low: 1400, critical: 700 },
  'pulse-coil': { high: 4200, medium: 2600, low: 1500, critical: 750 },
  vdg: { high: 3600, medium: 2400, low: 1400, critical: 700 },
  hall: { high: 3200, medium: 2100, low: 1200, critical: 600 },
  'lorentz-sled': { high: 3400, medium: 2200, low: 1300, critical: 650 },
  'jumping-ring': { high: 3600, medium: 2300, low: 1300, critical: 650 }
};

/** Core / legacy ids that use DEFAULT_CORE when not listed above. */
const CORE_IDS = new Set(['seg', 'heron', 'kelvin', 'solar', 'peltier', 'mhd']);

export function getParticleBudgetTable(deviceId: string, isPlugin: boolean = !CORE_IDS.has(deviceId)): TierBudget {
  return (
    DEVICE_PARTICLE_BUDGETS[deviceId] ||
    (isPlugin ? DEFAULT_PLUGIN_PARTICLE_BUDGET : DEFAULT_CORE_PARTICLE_BUDGET)
  );
}

export interface GetDeviceParticleBudgetOpts {
  isPlugin?: boolean;
}

export function getDeviceParticleBudget(deviceId: string, tier: QualityTier | string = 'high', opts: GetDeviceParticleBudgetOpts = {}): number {
  const table = getParticleBudgetTable(deviceId, opts.isPlugin);
  return table[tier as QualityTier] ?? table.medium ?? table.high;
}

export interface ResolveScaledParticleCountOpts {
  deviceId: string;
  /** configured particleCount */
  baseCount: number;
  /** 0..1 */
  qualityLevel: number;
  qualityTier?: QualityTier | string;
  /** 0..1 from getViewParticleLod */
  viewLod?: number;
  explainerScale?: number;
  isPlugin?: boolean;
}

/**
 * Final particle count after view LOD, quality level, and tier budget.
 */
export function resolveScaledParticleCount({
  deviceId,
  baseCount,
  qualityLevel,
  qualityTier = 'high',
  viewLod = 1,
  explainerScale = 1,
  isPlugin
}: ResolveScaledParticleCountOpts): number {
  if (viewLod <= 0 || !(baseCount > 0)) return 0;
  const q = Math.max(0, Math.min(1, qualityLevel));
  const raw = Math.floor(baseCount * q * viewLod * explainerScale);
  const budget = getDeviceParticleBudget(deviceId, qualityTier, { isPlugin });
  return Math.max(0, Math.min(raw, budget));
}
