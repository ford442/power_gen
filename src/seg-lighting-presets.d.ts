/** Ambient types for lighting / post-process presets (implementation stays JS). */

export type LightingLook = 'studio' | 'lab' | 'drama';

export const LIGHTING_LOOKS: {
  studio: 'studio';
  lab: 'lab';
  drama: 'drama';
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
  preset?: LightingPreset | { post?: Partial<PostPreset> };
  energy?: number;
  speedMult?: number;
  motionBlur?: number;
  qualityGates?: PostQualityGates | null;
  ssrEnabled?: boolean;
}

export function parseLightingLook(params?: URLSearchParams): LightingLook;
export function getLightingPreset(look?: string): LightingPreset;
export function packPostUniforms(opts: PackPostUniformsOpts): Float32Array;
