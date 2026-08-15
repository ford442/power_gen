import type { HeronLayout } from '../renderers/shared/device-physics';

export const HERON_LAYOUT_PRESETS: {
  classic: string;
  compact: string;
  tower: string;
  wide: string;
  spiral: string;
};

export const HERON_LAYOUT_DESCRIPTIONS: Record<string, string>;

/** getHeronLayout() also spreads the preset's display name/description onto the base HeronLayout shape. */
export function getHeronLayout(presetId?: string): HeronLayout & { name: string; description: string };

export function parseHeronLayoutPreset(params?: URLSearchParams): string;

export function swameeJainFriction(f: number, Re: number, D: number): number;

export interface HeronHydraulics {
  vExit: number;
  flowLmin: number;
  pressureKPa: number;
  Re: number;
}

export function computeHeronHydraulics(headM: number, layout: HeronLayout): HeronHydraulics;
