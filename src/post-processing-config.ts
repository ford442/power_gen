/**
 * Post-processing config + quality-tier gates (ADR-0005).
 *
 * Auto-quality maps profiler `qualityTier` → bloom / SSAO / contact shadow /
 * motion blur / SSR / TAA multipliers. Critical disables SSAO + motion blur and
 * skips the bloom extract/blur passes (composite still runs for filmic tonemap).
 *
 * Temporal AA is a high/ultra-tier feature and additionally requires focus mode
 * (it is off in overview); `?taa=0` disables it. WebGL2 does not implement it.
 *
 * Screen-space reflections are a high/ultra-tier feature only: the compute pass
 * is skipped entirely below that, independent of the `?ssr=0` kill switch in
 * renderers/shared/url-params.js (which disables SSR at any tier).
 *
 * The prefiltered IBL chain is skipped on fallback/software adapters
 * (`iblLevels = 0` → analytic PBR). On real GPUs it stays on — 224 KiB.
 */

export {
  parseLightingLook,
  getLightingPreset,
  packPostUniforms,
  LIGHTING_LOOKS
} from './seg-lighting-presets';

export type QualityTier = 'ultra' | 'high' | 'medium' | 'low' | 'critical';

export interface PostQualityGates {
  bloom: 0 | 1;
  ssao: number;
  contactShadow: number;
  motionBlur: number;
  ssr: number;
  /** Temporal AA: 1 only on the tiers that can afford the extra full-res pass. */
  taa: 0 | 1;
}

/**
 * Tier → post cost multipliers.
 * `bloom: 0` skips extract + blur passes in the render loop.
 * Strengths are multiplied onto preset SSAO / contact / motionBlur uniforms.
 */
export const POST_QUALITY_GATES: Record<QualityTier, PostQualityGates> = {
  ultra: {
    taa: 1,
    bloom: 1,
    ssao: 1,
    contactShadow: 1,
    motionBlur: 1,
    ssr: 1
  },
  high: {
    taa: 1,
    bloom: 1,
    ssao: 1,
    contactShadow: 1,
    motionBlur: 1,
    ssr: 1
  },
  medium: {
    taa: 0,
    bloom: 1,
    ssao: 0.7,
    contactShadow: 0.85,
    motionBlur: 0.7,
    ssr: 0
  },
  low: {
    taa: 0,
    bloom: 1,
    ssao: 0.3,
    contactShadow: 0.55,
    motionBlur: 0,
    ssr: 0
  },
  critical: {
    taa: 0,
    bloom: 0,
    ssao: 0,
    contactShadow: 0.35,
    motionBlur: 0,
    ssr: 0
  }
};

/** Tiers that run the TAA resolve pass at all (before the focus-mode gate). */
export const TAA_QUALITY_TIERS = Object.freeze(['ultra', 'high']);

/**
 * Whether temporal AA runs for a tier, before the overview-mode gate and the
 * `?taa=0` override. Overview draws the whole plugin ring, where the extra
 * full-res pass costs more than the shimmer it removes.
 */
export function taaEnabledForTier(tier: QualityTier | string = 'high'): boolean {
  return (getPostQualityGates(tier).taa ?? 0) > 0;
}

/** Tiers that run the SSR compute pass at all. */
export const SSR_QUALITY_TIERS = Object.freeze(['ultra', 'high']);

/** Whether screen-space reflections run for a tier, before the `?ssr=0` override. */
export function ssrEnabledForTier(tier: QualityTier | string = 'high'): boolean {
  return (getPostQualityGates(tier).ssr ?? 0) > 0;
}

export function getPostQualityGates(tier: QualityTier | string = 'high'): PostQualityGates {
  return POST_QUALITY_GATES[tier as QualityTier] ?? POST_QUALITY_GATES.high;
}

/** Human-readable summary for the debug panel. */
export function formatPostQualitySummary(gates: PostQualityGates): string {
  const g = gates || POST_QUALITY_GATES.high;
  const bloom = g.bloom ? 'on' : 'off';
  const ssao = g.ssao <= 0.01 ? 'off' : `${Math.round(g.ssao * 100)}%`;
  const cs = g.contactShadow <= 0.01 ? 'off' : `${Math.round(g.contactShadow * 100)}%`;
  const mb = g.motionBlur <= 0.01 ? 'off' : `${Math.round(g.motionBlur * 100)}%`;
  const ssr = (g.ssr ?? 0) <= 0.01 ? 'off' : `${Math.round(g.ssr * 100)}%`;
  const taa = (g.taa ?? 0) > 0 ? 'on' : 'off';
  return `bloom ${bloom} · ssao ${ssao} · contact ${cs} · mblur ${mb} · ssr ${ssr} · taa ${taa}`;
}
