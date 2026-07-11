/**
 * Glossary terms sourced from scientific-data.js / literature refs.
 */

import { SEG_DATA, PHYSICAL_CONSTANTS } from '../scientific-data.js';
import { SEG_SPEC } from '../seg-operator-state.js';

/** @type {Record<string, { title: string, body: string, unit?: string, value?: string, source?: string }>} */
export const SEG_GLOSSARY = {
  NdFeB: {
    title: 'NdFeB N52',
    body: 'Neodymium iron boron permanent magnet. High remanence Br drives roller coupling and B-field in the SEG model.',
    unit: 'T',
    value: `${SEG_DATA.MAGNET.Br} T Br`,
    source: 'scientific-data / ValidatedConstants'
  },
  'B-field': {
    title: 'Magnetic flux density (B)',
    body: 'Axial B-field from cylindrical NdFeB rollers. Surface reference used for telemetry gauges.',
    unit: 'T',
    value: `${SEG_SPEC.B_SURFACE_T} T (ref)`,
    source: 'Wolfram-validated SEG_DATA'
  },
  'energy-density': {
    title: 'Magnetic energy density',
    body: 'u = B² / (2μ₀). Scales particle glow and flux-line intensity in the visualizer.',
    unit: 'J/m³',
    value: `${(SEG_SPEC.ENERGY_DENSITY_SURFACE_JM3 / 1e6).toFixed(2)} MJ/m³`,
    source: 'SEG_DATA.ENERGY_DENSITY'
  },
  stator: {
    title: 'Stator rings',
    body: 'Copper-wound annular guides. Rollers orbit over insulated gaps between ring separators.',
    source: 'SEG layout model'
  },
  'pickup-coil': {
    title: 'Pickup coils (C-core)',
    body: 'Outer ring of induction coils. EMF rises when magnetic rollers pass nearest the coil leg.',
    source: 'Operator panel telemetry'
  },
  flux: {
    title: 'RK4 flux lines',
    body: 'Bidirectional magnetic field line traces integrated around roller rings (WebGPU path).',
    source: 'flux-lines.wgsl'
  },
  ionization: {
    title: 'Ionization / corona torus',
    body: 'High-ω regime: air breakdown proxy around outer orbit. Shown as particle corona and green underglow.',
    source: 'Simulation (segOmega > 0.6)'
  },
  'air-gap': {
    title: 'Roller air gap',
    body: 'Mechanical clearance between roller OD and stator ID. Searl layout derives proportions from ~3 mm gap.',
    unit: 'mm',
    value: '≈3',
    source: 'seg-layout.js gap-derived presets'
  },
  mu0: {
    title: 'Vacuum permeability μ₀',
    body: 'Fundamental constant linking B-field to magnetic energy density.',
    unit: 'H/m',
    value: String(PHYSICAL_CONSTANTS.MU_0),
    source: 'CODATA / PHYSICAL_CONSTANTS'
  }
};

/** Map annotation / tour highlight ids → glossary keys */
export const HIGHLIGHT_GLOSSARY = {
  'inner-ring': 'NdFeB',
  'outer-ring': 'NdFeB',
  stator: 'stator',
  coil: 'pickup-coil',
  flux: 'flux',
  ionization: 'ionization',
  separator: 'air-gap',
  shaft: 'B-field'
};

export function glossaryForHighlight(highlightId) {
  const key = HIGHLIGHT_GLOSSARY[highlightId];
  return key ? SEG_GLOSSARY[key] : null;
}
