// Shared URL / window overrides for SEG prototype and layout presets.
// Used by WebGPU (MultiDeviceVisualizer) and WebGL2 fallback so agent/CI
// query strings behave the same on both backends.

import { SEG_LAYOUT_PRESETS } from '../../seg-layout';
import { FDTD_DRIVE_SOURCES, type FdtdDriveSource } from '../../physics/fdtd-tmz';
import { labConfigFor, type ResolvedLabConfig } from '../../config/lab-config';

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

/**
 * Each parser takes an optional query for tests and per-call overrides; with
 * none it reads the page's resolved LabConfig (URL > share hash > storage >
 * default — `src/config/lab-config.ts`). A window override (`SEG_*`, set by
 * an embedding page) applies only where nothing on the page chose the field.
 */
function resolved(params?: URLSearchParams): ResolvedLabConfig {
  return labConfigFor(params);
}

/**
 * Parse SEG prototype preset from URL or window override.
 * Lab aliases: lab, roschin, godin. Showroom aliases: showroom, searl.
 */
export function parsePrototypePreset(params?: URLSearchParams): PrototypePreset {
  const r = resolved(params);
  if (r.sources.prototype !== 'default') return r.config.prototype;
  if (typeof window !== 'undefined' && window.SEG_PROTOTYPE_PRESET) {
    const w = window.SEG_PROTOTYPE_PRESET;
    if (w === 'lab' || w === 'showroom') return w;
  }
  return 'showroom';
}

/**
 * Screen-space reflections kill switch: `?ssr=0` (any LabConfig boolean).
 *
 * Independent of the quality tier — the tier gate in post-processing-config.ts
 * already turns SSR off below high/ultra; this lets a capture or a bug report
 * disable it without also dropping SSAO, bloom and motion blur.
 *
 * @returns true when SSR may run (subject to the tier gate)
 */
export function parseSsrEnabled(params?: URLSearchParams): boolean {
  const r = resolved(params);
  if (r.sources.ssr !== 'default') return r.config.ssr;
  if (typeof window !== 'undefined' && window.SEG_SSR_ENABLED !== undefined) {
    return !!window.SEG_SSR_ENABLED;
  }
  return true;
}

/**
 * Temporal AA kill switch: `?taa=0` (any LabConfig boolean).
 *
 * Same shape as {@link parseSsrEnabled}: the quality tier already gates TAA to
 * high/ultra in focus mode, and this lets a capture or a bug report turn it off
 * at any tier without disturbing the rest of the post stack. WebGL2 has no TAA
 * at all, so the flag is WebGPU-only (docs/WEBGL2.md).
 *
 * @returns true when TAA may run (subject to the tier and mode gates)
 */
export function parseTaaEnabled(params?: URLSearchParams): boolean {
  const r = resolved(params);
  if (r.sources.taa !== 'default') return r.config.taa;
  if (typeof window !== 'undefined' && window.SEG_TAA_ENABLED !== undefined) {
    return !!window.SEG_TAA_ENABLED;
  }
  return true;
}

/**
 * FDTD wave-slice kill switch: `?fdtd=0`.
 *
 * The slice is already gated to the pulse-coil focus view at the `high` tier
 * (ADR-0010, `fdtdSliceGateOpen`); this only ever turns it off. WebGPU-only —
 * WebGL2 has no slice (docs/WEBGL2.md).
 */
export function parseFdtdEnabled(params?: URLSearchParams): boolean {
  return resolved(params).config.fdtd;
}

/**
 * FDTD material cells (ADR-0012): `?fdtdMaterials=0` reverts the slice to the
 * ADR-0010 vacuum kernel, so the μ_r armature and copper turns can be switched
 * off to compare the two pictures side by side. Default on.
 */
export function parseFdtdMaterialsEnabled(params?: URLSearchParams): boolean {
  return resolved(params).config.fdtdMaterials;
}

/**
 * Which catalog device modulates the slice's source amplitude (ADR-0012):
 * `?fdtdDrive=transformer` borrows the transformer bench's core flux, anything
 * else (or nothing) keeps the pulse coil's own discharge current.
 *
 * The winding *geometry* is always the pulse coil's — the panel lives in its
 * focus view. Only the modulation changes.
 */
export function parseFdtdDriveSource(params?: URLSearchParams): FdtdDriveSource {
  return resolved(params).config.fdtdDrive === 'transformer'
    ? FDTD_DRIVE_SOURCES.TRANSFORMER
    : FDTD_DRIVE_SOURCES.COIL;
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
  params?: URLSearchParams,
  prototypePreset: PrototypePreset = 'showroom'
): string {
  const layout = resolved(params).config.layout;
  if (layout) return SEG_LAYOUT_PRESETS[layout];
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
