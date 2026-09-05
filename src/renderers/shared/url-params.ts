// Shared URL / window overrides for SEG prototype and layout presets.
// Used by WebGPU (MultiDeviceVisualizer) and WebGL2 fallback so agent/CI
// query strings behave the same on both backends.

import { SEG_LAYOUT_PRESETS } from '../../seg-layout';

export type PrototypePreset = 'showroom' | 'lab';

export interface SegLayoutRingDrawOpts {
  count: number;
  index: number;
  rollerRadius: number;
  scale: number;
}

/** Minimal layout shape consumed by WebGL2 drawRollers. */
export interface SegLayoutForDraw {
  rings?: Array<{
    count: number;
    index: number;
    rollerRadiusM: number;
  }>;
  worldScale?: number;
}

function defaultParams(): URLSearchParams {
  return new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
}

/**
 * Parse SEG prototype preset from URL or window override.
 * Lab aliases: lab, roschin, godin. Showroom aliases: showroom, searl.
 */
export function parsePrototypePreset(params: URLSearchParams = defaultParams()): PrototypePreset {
  const protoParam = params.get('prototype');
  if (protoParam === 'lab' || protoParam === 'roschin' || protoParam === 'godin') {
    return 'lab';
  }
  if (protoParam === 'showroom' || protoParam === 'searl') {
    return 'showroom';
  }
  if (typeof window !== 'undefined' && window.SEG_PROTOTYPE_PRESET) {
    const w = window.SEG_PROTOTYPE_PRESET;
    if (w === 'lab' || w === 'showroom') return w;
  }
  return 'showroom';
}

/**
 * Screen-space reflections kill switch: `?ssr=0` (aliases: off / false / no).
 *
 * Independent of the quality tier — the tier gate in post-processing-config.ts
 * already turns SSR off below high/ultra; this lets a capture or a bug report
 * disable it without also dropping SSAO, bloom and motion blur.
 *
 * @returns true when SSR may run (subject to the tier gate)
 */
export function parseSsrEnabled(params: URLSearchParams = defaultParams()): boolean {
  const raw = params.get('ssr');
  if (raw !== null) {
    return !(raw === '0' || raw === 'off' || raw === 'false' || raw === 'no');
  }
  if (typeof window !== 'undefined' && window.SEG_SSR_ENABLED !== undefined) {
    return !!window.SEG_SSR_ENABLED;
  }
  return true;
}

/** Whether Roschin–Godin anomalous environmental effects (magnetic walls, etc.) are enabled. */
export function parseAnomalousEffects(prototypePreset: PrototypePreset): boolean {
  return prototypePreset === 'lab';
}

/**
 * Literature-grounded SEG layout preset id (searl | roschin | legacy).
 * When prototype=lab and layout is omitted, defaults to Roschin like WebGPU.
 */
export function parseSegLayoutPreset(
  params: URLSearchParams = defaultParams(),
  prototypePreset: PrototypePreset = 'showroom'
): string {
  const layoutParam = params.get('layout');
  if (layoutParam === 'roschin' || layoutParam === 'lab' || layoutParam === 'godin') {
    return SEG_LAYOUT_PRESETS.roschin;
  }
  if (layoutParam === 'legacy') {
    return SEG_LAYOUT_PRESETS.legacy;
  }
  if (layoutParam === 'searl' || layoutParam === 'showroom') {
    return SEG_LAYOUT_PRESETS.searl;
  }
  if (prototypePreset === 'lab') {
    return SEG_LAYOUT_PRESETS.roschin;
  }
  if (typeof window !== 'undefined' && window.SEG_LAYOUT_PRESET) {
    return window.SEG_LAYOUT_PRESET;
  }
  return SEG_LAYOUT_PRESETS.searl;
}

/** Map computed SEG layout rings for WebGL2 drawRollers opts. */
export function segLayoutRingsForDraw(
  layout: SegLayoutForDraw | null | undefined
): SegLayoutRingDrawOpts[] | undefined {
  if (!layout?.rings?.length) return undefined;
  const ws = layout.worldScale ?? 1;
  return layout.rings.map((r) => ({
    count: r.count,
    index: r.index,
    rollerRadius: r.rollerRadiusM * ws,
    scale: (r.rollerRadiusM * ws) / 0.75
  }));
}
