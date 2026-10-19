// ============================================================================
// SEG Lighting & Post-Processing Presets
// ============================================================================
// Central look definitions: studio (default), lab, drama.
// Toggle via ?look=studio|lab|drama or debug panel / setLightingLook().

import type { ColorPipelineMode } from './webgpu-init/color-pipeline';
import { labConfigFor } from './config/lab-config';

export type LightingLook = 'studio' | 'lab' | 'drama';

export const LIGHTING_LOOKS: Record<LightingLook, LightingLook> = {
  studio: 'studio',
  lab: 'lab',
  drama: 'drama'
};

export interface LightArm {
  position: number[];
  color: number[];
  intensity: number;
}

export interface LightingRig {
  key: LightArm;
  fill: LightArm;
  rim: LightArm;
  ground: LightArm;
  ambient: number;
  envMapStrength: number;
  shadowStrength: number;
}

export interface PostPreset {
  exposure: number;
  bloomThreshold: number;
  bloomKnee: number;
  bloomStrength: number;
  bloomRadius: number;
  coronaBoost: number;
  grain: number;
  aberration: number;
  vignette: number;
  ssaoStrength: number;
  contactShadow: number;
  ssrStrength: number;
}

export interface SkyPreset {
  mode: number;
  top: number[];
  horizon: number[];
  energy: number;
}

export interface LightingPreset {
  name: string;
  lighting: LightingRig;
  post: PostPreset;
  sky: SkyPreset;
}

const PRESETS: Record<LightingLook, LightingPreset> = {
  studio: {
    name: 'Studio',
    lighting: {
      key:    { position: [4.5, 9.0, 6.0],  color: [1.0, 0.97, 0.92], intensity: 1.35 },
      fill:   { position: [-5.0, 4.0, -2.0], color: [0.78, 0.86, 1.0], intensity: 0.48 },
      rim:    { position: [-1.0, 3.0, -9.0], color: [0.55, 0.82, 1.0], intensity: 0.95 },
      ground: { position: [0.0, -6.0, 0.0],  color: [0.38, 0.34, 0.30], intensity: 0.22 },
      ambient: 0.22,
      envMapStrength: 0.78,
      shadowStrength: 0.85
    },
    post: {
      exposure: 1.05,
      bloomThreshold: 0.58,
      bloomKnee: 0.14,
      bloomStrength: 1.15,
      bloomRadius: 1.6,
      coronaBoost: 1.35,
      grain: 0.018,
      aberration: 0.012,
      vignette: 0.22,
      ssaoStrength: 0.55,
      contactShadow: 0.28,
      ssrStrength: 0.85
    },
    sky: { mode: 1, top: [0.42, 0.44, 0.48], horizon: [0.62, 0.64, 0.68], energy: 0.04 }
  },
  lab: {
    name: 'Lab',
    lighting: {
      key:    { position: [2.0, 11.0, 3.0],  color: [0.95, 0.98, 1.0], intensity: 1.55 },
      fill:   { position: [-6.0, 5.0, 4.0],  color: [0.88, 0.92, 0.96], intensity: 0.62 },
      rim:    { position: [0.0, 2.0, -7.0],   color: [0.65, 0.75, 0.85], intensity: 0.45 },
      ground: { position: [0.0, -5.0, 0.0],   color: [0.45, 0.43, 0.40], intensity: 0.28 },
      ambient: 0.28,
      envMapStrength: 0.62,
      shadowStrength: 0.65
    },
    post: {
      exposure: 1.12,
      bloomThreshold: 0.62,
      bloomKnee: 0.12,
      bloomStrength: 0.95,
      bloomRadius: 1.3,
      coronaBoost: 1.15,
      grain: 0.012,
      aberration: 0.006,
      vignette: 0.12,
      ssaoStrength: 0.38,
      contactShadow: 0.18,
      ssrStrength: 0.45
    },
    sky: { mode: 2, top: [0.72, 0.74, 0.78], horizon: [0.82, 0.84, 0.87], energy: 0.02 }
  },
  drama: {
    name: 'Drama',
    lighting: {
      key:    { position: [7.0, 6.0, 2.0],   color: [1.0, 0.88, 0.72], intensity: 1.65 },
      fill:   { position: [-3.0, 2.0, -5.0], color: [0.35, 0.45, 0.75], intensity: 0.22 },
      rim:    { position: [0.0, 1.0, -10.0],  color: [0.25, 0.65, 1.0], intensity: 1.35 },
      ground: { position: [0.0, -5.0, 0.0], color: [0.18, 0.12, 0.10], intensity: 0.12 },
      ambient: 0.14,
      envMapStrength: 0.92,
      shadowStrength: 1.0
    },
    post: {
      exposure: 0.92,
      bloomThreshold: 0.48,
      bloomKnee: 0.18,
      bloomStrength: 1.55,
      bloomRadius: 2.4,
      coronaBoost: 1.85,
      grain: 0.028,
      aberration: 0.022,
      vignette: 0.42,
      ssaoStrength: 0.72,
      contactShadow: 0.38,
      ssrStrength: 0.70
    },
    sky: { mode: 0, top: [0.008, 0.012, 0.04], horizon: [0.04, 0.08, 0.16], energy: 0.10 }
  }
};

/** `?look=` / `?lighting=` or a share link; then `window.SEG_LIGHTING_LOOK`; then studio. */
export function parseLightingLook(params?: URLSearchParams): LightingLook {
  const r = labConfigFor(params);
  if (r.sources.look !== 'default') return r.config.look;
  const win = typeof window !== 'undefined' ? (window as unknown as { SEG_LIGHTING_LOOK?: string }) : undefined;
  if (win?.SEG_LIGHTING_LOOK && win.SEG_LIGHTING_LOOK in PRESETS) {
    return win.SEG_LIGHTING_LOOK as LightingLook;
  }
  return LIGHTING_LOOKS.studio;
}

/** sRGB-encoded → linear, one channel (IEC 61966-2-1). */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const linearRgb = (rgb: number[]): number[] => rgb.map(srgbToLinear);

/**
 * An authored colour (albedo table, device base colour, glTF prop tint — all
 * picked as on-screen sRGB values against the legacy output) in the working
 * space of `colorMode`: decoded to linear on the linear colour pipeline,
 * untouched on `legacy` / WebGL2.
 */
export function authoredColor(rgb: readonly number[], colorMode: ColorPipelineMode | undefined): number[] {
  return colorMode === 'linear' ? rgb.map(srgbToLinear) : [...rgb];
}

/**
 * Linear colour pipeline retune (#223). The presets above were tuned by eye
 * on the legacy output — tonemapped linear values shown with no sRGB encode,
 * bloom thresholded on an 8-bit scene that clipped at 1.0 — and that is what
 * WebGL2 and `?color=legacy` keep using.
 *
 * On the linear path the bloom threshold is in scene-referred units (scene
 * radiance before exposure; 1.0 ≈ a white diffuse surface under the key
 * light), so only real highlights — corona, emissive plasma, specular — bloom
 * instead of the whole grey backdrop. Colours (light tints, sky dome for the
 * IBL bake) were picked as sRGB values on screen; they are decoded to linear
 * in getLightingPreset(). Exposure drops ~15%: the sRGB encode lifts
 * mid-tones, and at the old exposure saturated albedos rolled off to pastel
 * in the filmic shoulder. See docs/LIGHTING_RIG.md → Colour pipeline.
 */
const LINEAR_RETUNE: Record<LightingLook, {
  post: Partial<PostPreset>;
  lighting?: Partial<Pick<LightingRig, 'ambient' | 'envMapStrength'>>;
}> = {
  studio: {
    post: { exposure: 0.85, bloomThreshold: 1.0, bloomKnee: 0.5, bloomStrength: 0.8 }
  },
  lab: {
    post: { exposure: 0.9, bloomThreshold: 1.1, bloomKnee: 0.5, bloomStrength: 0.6 }
  },
  drama: {
    post: { exposure: 0.85, bloomThreshold: 0.8, bloomKnee: 0.45, bloomStrength: 1.1 }
  }
};

/**
 * Lighting + post look. `colorMode` defaults to `legacy` so callers that
 * never heard of the linear pipeline (WebGL2, ADR-0001) keep the values they
 * were tuned with; the WebGPU path passes its session mode.
 */
export function getLightingPreset(
  look: LightingLook = LIGHTING_LOOKS.studio,
  colorMode: ColorPipelineMode = 'legacy'
): LightingPreset {
  const base = PRESETS[look] ?? PRESETS.studio;
  if (colorMode !== 'linear') return base;
  const retune = LINEAR_RETUNE[look] ?? LINEAR_RETUNE.studio;
  const arm = (a: LightArm): LightArm => ({ ...a, color: linearRgb(a.color) });
  return {
    name: base.name,
    lighting: {
      ...base.lighting,
      ...retune.lighting,
      key: arm(base.lighting.key),
      fill: arm(base.lighting.fill),
      rim: arm(base.lighting.rim),
      ground: arm(base.lighting.ground)
    },
    post: { ...base.post, ...retune.post },
    sky: { ...base.sky, top: linearRgb(base.sky.top), horizon: linearRgb(base.sky.horizon) }
  };
}

export interface PostQualityGates {
  bloom?: number;
  ssao?: number;
  contactShadow?: number;
  motionBlur?: number;
  ssr?: number;
}

export interface PackPostUniformsOpts {
  width?: number;
  height?: number;
  preset?: LightingPreset | { post?: Partial<PostPreset>; sky?: Partial<SkyPreset> };
  energy?: number;
  speedMult?: number;
  motionBlur?: number;
  qualityGates?: PostQualityGates | null;
  ssrEnabled?: boolean;
  /** 1 when canvas toneMapping is `extended` (?hdr=1 + HDR display). */
  outputLinearHdr?: boolean;
  /**
   * Mip-chain bloom levels on the linear colour pipeline (the composite scales
   * the summed chain by 1 / levels); 0 = legacy 3-pass bloom.
   */
  bloomChainLevels?: number;
  /** Composite → canvas transfer: 0 legacy (no encode), 1 `-srgb` view, 2 shader OETF. */
  outputTransfer?: 0 | 1 | 2;
}

/**
 * Pack bloom/post uniform (20 floats / 80 bytes) for bloom-shaders.js BloomParams.
 * Optional `qualityGates` scales bloom / SSAO / contact / motionBlur / SSR for
 * auto-quality. `ssrEnabled: false` (from `?ssr=0`) zeroes SSR at any tier.
 */
export function packPostUniforms(opts: PackPostUniformsOpts): Float32Array {
  const {
    width = 1,
    height = 1,
    preset,
    energy = 0,
    speedMult = 1,
    motionBlur = 0,
    qualityGates = null,
    ssrEnabled = true,
    outputLinearHdr = false,
    bloomChainLevels = 0,
    outputTransfer = 0
  } = opts;

  const p = preset?.post ?? PRESETS.studio.post;
  const energyPow = Math.pow(Math.min(1, Math.max(0, energy)), 1.35);
  const speedNorm = Math.min(1, Math.max(0, (speedMult - 1) / 19));

  const bloomMul = qualityGates?.bloom ?? 1;
  const ssaoMul = qualityGates?.ssao ?? 1;
  const contactMul = qualityGates?.contactShadow ?? 1;
  const motionMul = qualityGates?.motionBlur ?? 1;
  const ssrMul = ssrEnabled === false ? 0 : (qualityGates?.ssr ?? 1);

  const bloomStrength =
    bloomMul <= 0
      ? 0
      : (p.bloomStrength ?? 0) * (1.0 + energyPow * 0.42 + speedNorm * 0.12) * bloomMul;

  return new Float32Array([
    1.0 / width,
    1.0 / height,
    Math.max(0.35, (p.bloomThreshold ?? 0) - energyPow * 0.12 - speedNorm * 0.06),
    Math.max(0.06, (p.bloomKnee ?? 0) * (1.0 + energyPow * 0.25)),
    bloomStrength,
    (p.bloomRadius ?? 0) + energyPow * 2.8 + speedNorm * 0.6,
    energyPow,
    p.grain ?? 0,
    (p.aberration ?? 0) * (1.0 + energyPow * 0.5),
    p.vignette ?? 0,
    motionBlur * motionMul,
    p.exposure ?? 1,
    p.coronaBoost ?? 0,
    (p.ssaoStrength ?? 0) * ssaoMul,
    (p.contactShadow ?? 0) * contactMul,
    preset?.sky?.mode ?? 1,
    (p.ssrStrength ?? 0) * ssrMul,
    outputLinearHdr ? 1 : 0,
    bloomChainLevels > 0 ? 1 / bloomChainLevels : 0,
    outputTransfer
  ]);
}
