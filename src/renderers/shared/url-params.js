// Shared URL / window overrides for SEG prototype and layout presets.
// Used by WebGPU (MultiDeviceVisualizer) and WebGL2 fallback so agent/CI
// query strings behave the same on both backends.

import { SEG_LAYOUT_PRESETS } from '../../seg-layout.js';

/** @typedef {'showroom'|'lab'} PrototypePreset */

function defaultParams() {
  return new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
}

/**
 * Parse SEG prototype preset from URL or window override.
 * Lab aliases: lab, roschin, godin. Showroom aliases: showroom, searl.
 * @param {URLSearchParams} [params]
 * @returns {PrototypePreset}
 */
export function parsePrototypePreset(params = defaultParams()) {
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
 * Whether Roschin–Godin anomalous environmental effects (magnetic walls, etc.) are enabled.
 * @param {PrototypePreset} prototypePreset
 */
export function parseAnomalousEffects(prototypePreset) {
  return prototypePreset === 'lab';
}

/**
 * Literature-grounded SEG layout preset id (searl | roschin | legacy).
 * When prototype=lab and layout is omitted, defaults to Roschin like WebGPU.
 * @param {URLSearchParams} [params]
 * @param {PrototypePreset} [prototypePreset]
 * @returns {string}
 */
export function parseSegLayoutPreset(params = defaultParams(), prototypePreset = 'showroom') {
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

/**
 * Map computed SEG layout rings for WebGL2 drawRollers opts.
 * @param {import('../../seg-layout.js').SEGLayout | null | undefined} layout
 */
export function segLayoutRingsForDraw(layout) {
  if (!layout?.rings?.length) return undefined;
  const ws = layout.worldScale ?? 1;
  return layout.rings.map((r) => ({
    count: r.count,
    index: r.index,
    rollerRadius: r.rollerRadiusM * ws,
    scale: (r.rollerRadiusM * ws) / 0.75
  }));
}
