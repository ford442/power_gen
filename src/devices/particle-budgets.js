/**
 * Per-device particle budgets by auto-quality tier (ADR-0005 WS4).
 *
 * Caps `particleCount × viewLod × quality` so overview with 8–12 devices
 * stays near mid-tier FPS. Plugins use lower budgets than SEG / core lab.
 *
 * Tier labels match `PerformanceProfiler.qualityTier`.
 */

/** @typedef {'high'|'medium'|'low'|'critical'} QualityTier */
/** @typedef {{ high: number, medium: number, low: number, critical: number }} TierBudget */

/** @type {TierBudget} */
export const DEFAULT_CORE_PARTICLE_BUDGET = {
  high: 9000,
  medium: 6000,
  low: 3500,
  critical: 1600
};

/** @type {TierBudget} */
export const DEFAULT_PLUGIN_PARTICLE_BUDGET = {
  high: 4500,
  medium: 2800,
  low: 1600,
  critical: 800
};

/**
 * Explicit budgets. Missing ids fall back to core vs plugin defaults.
 * @type {Record<string, TierBudget>}
 */
export const DEVICE_PARTICLE_BUDGETS = {
  seg: { high: 10000, medium: 7000, low: 4000, critical: 2000 },
  heron: { high: 8000, medium: 5200, low: 3000, critical: 1400 },
  kelvin: { high: 8000, medium: 5200, low: 3000, critical: 1400 },
  solar: { high: 7500, medium: 4800, low: 2800, critical: 1200 },
  peltier: { high: 9000, medium: 5500, low: 3000, critical: 1400 },
  mhd: { high: 10000, medium: 6000, low: 3200, critical: 1500 },
  maglev: { high: 4500, medium: 2800, low: 1600, critical: 800 },
  homopolar: { high: 5000, medium: 3200, low: 1800, critical: 900 },
  'halbach-viz': { high: 4000, medium: 2500, low: 1400, critical: 700 },
  'pulse-coil': { high: 4200, medium: 2600, low: 1500, critical: 750 }
};

/** Core / legacy ids that use DEFAULT_CORE when not listed above. */
const CORE_IDS = new Set(['seg', 'heron', 'kelvin', 'solar', 'peltier', 'mhd']);

/**
 * @param {string} deviceId
 * @param {boolean} [isPlugin]
 * @returns {TierBudget}
 */
export function getParticleBudgetTable(deviceId, isPlugin = !CORE_IDS.has(deviceId)) {
  return (
    DEVICE_PARTICLE_BUDGETS[deviceId] ||
    (isPlugin ? DEFAULT_PLUGIN_PARTICLE_BUDGET : DEFAULT_CORE_PARTICLE_BUDGET)
  );
}

/**
 * @param {string} deviceId
 * @param {QualityTier|string} [tier]
 * @param {{ isPlugin?: boolean }} [opts]
 * @returns {number}
 */
export function getDeviceParticleBudget(deviceId, tier = 'high', opts = {}) {
  const table = getParticleBudgetTable(deviceId, opts.isPlugin);
  return table[tier] ?? table.medium ?? table.high;
}

/**
 * Final particle count after view LOD, quality level, and tier budget.
 * @param {object} opts
 * @param {string} opts.deviceId
 * @param {number} opts.baseCount  configured particleCount
 * @param {number} opts.qualityLevel 0..1
 * @param {QualityTier|string} [opts.qualityTier]
 * @param {number} [opts.viewLod] 0..1 from getViewParticleLod
 * @param {number} [opts.explainerScale=1]
 * @param {boolean} [opts.isPlugin]
 */
export function resolveScaledParticleCount({
  deviceId,
  baseCount,
  qualityLevel,
  qualityTier = 'high',
  viewLod = 1,
  explainerScale = 1,
  isPlugin
}) {
  if (viewLod <= 0 || !(baseCount > 0)) return 0;
  const q = Math.max(0, Math.min(1, qualityLevel));
  const raw = Math.floor(baseCount * q * viewLod * explainerScale);
  const budget = getDeviceParticleBudget(deviceId, qualityTier, { isPlugin });
  return Math.max(0, Math.min(raw, budget));
}
