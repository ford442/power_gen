/**
 * Post-processing config + quality-tier gates (ADR-0005).
 *
 * Auto-quality maps profiler `qualityTier` → bloom / SSAO / contact shadow /
 * motion blur / SSR multipliers. Critical disables SSAO + motion blur and skips
 * the bloom extract/blur passes (composite still runs for filmic tonemap).
 *
 * Screen-space reflections are a high/ultra-tier feature only: the compute pass
 * is skipped entirely below that, independent of the `?ssr=0` kill switch in
 * renderers/shared/url-params.js (which disables SSR at any tier).
 *
 * The prefiltered IBL chain is deliberately *not* gated — it is a 224 KiB
 * texture read that replaces a longer polynomial, so it is always on.
 */

export {
  parseLightingLook,
  getLightingPreset,
  packPostUniforms,
  LIGHTING_LOOKS
} from './seg-lighting-presets.js';

/** @typedef {'ultra'|'high'|'medium'|'low'|'critical'} QualityTier */

/**
 * @typedef {{
 *   bloom: 0|1,
 *   ssao: number,
 *   contactShadow: number,
 *   motionBlur: number,
 *   ssr: number
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
  ultra: {
    bloom: 1,
    ssao: 1,
    contactShadow: 1,
    motionBlur: 1,
    ssr: 1
  },
  high: {
    bloom: 1,
    ssao: 1,
    contactShadow: 1,
    motionBlur: 1,
    ssr: 1
  },
  medium: {
    bloom: 1,
    ssao: 0.7,
    contactShadow: 0.85,
    motionBlur: 0.7,
    ssr: 0
  },
  low: {
    bloom: 1,
    ssao: 0.3,
    contactShadow: 0.55,
    motionBlur: 0,
    ssr: 0
  },
  critical: {
    bloom: 0,
    ssao: 0,
    contactShadow: 0.35,
    motionBlur: 0,
    ssr: 0
  }
};

/** Tiers that run the SSR compute pass at all. */
export const SSR_QUALITY_TIERS = Object.freeze(['ultra', 'high']);

/**
 * Whether screen-space reflections run for a tier, before the `?ssr=0` override.
 * @param {QualityTier|string} [tier]
 */
export function ssrEnabledForTier(tier = 'high') {
  return (getPostQualityGates(tier).ssr ?? 0) > 0;
}

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
  const ssr = (g.ssr ?? 0) <= 0.01 ? 'off' : `${Math.round(g.ssr * 100)}%`;
  return `bloom ${bloom} · ssao ${ssao} · contact ${cs} · mblur ${mb} · ssr ${ssr}`;
}
