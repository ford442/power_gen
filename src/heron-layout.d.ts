import type { HeronLayout } from '../renderers/shared/device-physics.ts';

export const HERON_LAYOUT_PRESETS: {
  classic: string;
  compact: string;
  tower: string;
  wide: string;
  spiral: string;
};

export const HERON_LAYOUT_DESCRIPTIONS: Record<string, string>;

export function getHeronLayout(presetId?: string): HeronLayout;

export function swameeJainFriction(f: number, Re: number, D: number): number;

export interface HeronHydraulics {
  vExit: number;
  flowLmin: number;
  pressureKPa: number;
  Re: number;
}

export function computeHeronHydraulics(headM: number, layout: HeronLayout): HeronHydraulics;
