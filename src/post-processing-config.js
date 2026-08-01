/**
 * Post-processing config + quality-tier gates (ADR-0005).
 *
 * Auto-quality maps profiler `qualityTier` → bloom / SSAO / contact shadow /
 * motion blur multipliers. Critical disables SSAO + motion blur and skips the
 * bloom extract/blur passes (composite still runs for filmic tonemap).
 */

export {
  parseLightingLook,
  getLightingPreset,
  packPostUniforms,
  LIGHTING_LOOKS
} from './seg-lighting-presets.js';

/** @typedef {'high'|'medium'|'low'|'critical'} QualityTier */

/**
 * @typedef {{
 *   bloom: 0|1,
 *   ssao: number,
 *   contactShadow: number,
 *   motionBlur: number
 * }} PostQualityGates
 */

/**
 * Tier → post cost multipliers.
 * `bloom: 0` skips extract + blur passes in the render loop.
 * Strengths are multiplied onto preset SSAO / contact / motionBlur uniforms.
 *
 * @type {Record<QualityTier, PostQualityGates>}
 */
export const POST_QUALITY_GATES = {
  high: {
    bloom: 1,
    ssao: 1,
    contactShadow: 1,
    motionBlur: 1
  },
  medium: {
    bloom: 1,
    ssao: 0.7,
    contactShadow: 0.85,
    motionBlur: 0.7
  },
  low: {
    bloom: 1,
    ssao: 0.3,
    contactShadow: 0.55,
    motionBlur: 0
  },
  critical: {
    bloom: 0,
    ssao: 0,
    contactShadow: 0.35,
    motionBlur: 0
  }
};

/**
 * @param {QualityTier|string} [tier]
 * @returns {PostQualityGates}
 */
export function getPostQualityGates(tier = 'high') {
  return POST_QUALITY_GATES[tier] ?? POST_QUALITY_GATES.high;
}

/**
 * Human-readable summary for the debug panel.
 * @param {PostQualityGates} gates
 */
export function formatPostQualitySummary(gates) {
  const g = gates || POST_QUALITY_GATES.high;
  const bloom = g.bloom ? 'on' : 'off';
  const ssao = g.ssao <= 0.01 ? 'off' : `${Math.round(g.ssao * 100)}%`;
  const cs = g.contactShadow <= 0.01 ? 'off' : `${Math.round(g.contactShadow * 100)}%`;
  const mb = g.motionBlur <= 0.01 ? 'off' : `${Math.round(g.motionBlur * 100)}%`;
  return `bloom ${bloom} · ssao ${ssao} · contact ${cs} · mblur ${mb}`;
}
