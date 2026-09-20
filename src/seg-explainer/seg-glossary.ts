/**
 * Glossary terms sourced from scientific-data.ts / literature refs.
 */

import { SEG_DATA, PHYSICAL_CONSTANTS } from '../scientific-data';
import { SEG_SPEC } from '../seg-operator-state';

export interface GlossaryEntry {
  title: string;
  body: string;
  unit?: string;
  value?: string;
  source?: string;
}

export const SEG_GLOSSARY: Record<string, GlossaryEntry> = {
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
    source: 'passes/flux-line-tracer.wgsl'
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
  },
  'belt-charge': {
    title: 'Belt charge transfer',
    body: 'An insulating belt physically carries charge from a grounded comb to an upper comb near the sphere — dQ/dt scales with belt speed. Classroom Van de Graaff model, not a metrology instrument.',
    source: 'devices/quanta/van-de-graaff.ts'
  },
  'sphere-capacitance': {
    title: 'Isolated-sphere capacitance',
    body: 'C = 4πε₀r for a sphere far from other conductors. Voltage V = Q/C rises until leakage and corona losses balance the belt current.',
    unit: 'F',
    source: 'Electrostatics — isolated conductor capacitance'
  },
  corona: {
    title: 'Corona / spark discharge',
    body: 'When the sphere field exceeds the classroom air-breakdown estimate (~3×10⁶ V/m × gap), a spark discharges a fraction of the stored charge.',
    source: 'devices/quanta/van-de-graaff.ts spark-gap model'
  },
  'hall-voltage': {
    title: 'Hall voltage (V_H)',
    body: 'Transverse voltage induced across a current-carrying strip in a perpendicular magnetic field: V_H = I·B / (n·e·t).',
    unit: 'V',
    source: 'Hall 1879 / devices/quanta/hall-effect.ts'
  },
  'hall-coefficient': {
    title: 'Hall coefficient (R_H)',
    body: 'R_H = 1 / (n·e) — depends only on the carrier density of the sample, not its geometry or drive current.',
    unit: 'm³/C',
    source: 'devices/quanta/hall-effect.ts'
  },
  'carrier-density': {
    title: 'Charge carrier density (n)',
    body: 'Semiconductors have carrier densities ~1e21 m⁻³ (large Hall voltage); metals ~1e28 m⁻³ (Hall voltage nearly vanishes at the same current and field).',
    unit: 'm⁻³',
    source: 'devices/quanta/hall-effect.ts HALL_CARRIER_PROFILES'
  },
  'lorentz-force': {
    title: 'Lorentz force on a current (F = I ℓ × B)',
    body: 'A straight conductor of length ℓ carrying current I across a uniform transverse field B feels a force F = I·ℓ·B along the rails. Classroom rail-motor force only — not a launcher or weapons model.',
    unit: 'N',
    source: 'Griffiths ch. 5 / devices/quanta/lorentz-sled.ts'
  },
  'armature-current': {
    title: 'Armature current (I)',
    body: 'Current in the series R–L drive loop closed through the sliding armature. It rises toward (V − B·ℓ·v)/R, so it falls as the sled speeds up.',
    unit: 'A',
    source: 'devices/quanta/lorentz-sled.ts'
  },
  'back-emf': {
    title: 'Back-EMF (B·ℓ·v)',
    body: 'The moving armature is itself a rod sweeping through B, so it generates a voltage that opposes the supply. Terminal speed is where back-EMF plus friction balance the drive.',
    unit: 'V',
    source: 'devices/quanta/lorentz-sled.ts'
  },
  'bench-field': {
    title: 'Bench field (B)',
    body: 'The transverse field across the rail gap. By default it is the local B slider on this device; with lab field coupling on it follows the MHD channel\u2019s simulated estimate instead, clamped to this bench\u2019s range.',
    unit: 'T',
    source: 'devices/quanta/lorentz-sled.ts LORENTZ.fieldTDefault'
  },
  'field-coupling': {
    title: 'Lab field coupling',
    body: 'Optional bus that feeds one device\u2019s simulated B estimate into another\u2019s plant (Halbach \u2192 Hall, MHD \u2192 rail sled), clamped to the destination\u2019s catalog range. Off by default. It propagates a simulated estimate \u2014 it is not a Maxwell solve and not metrology.',
    unit: 'T',
    source: 'renderers/shared/field-network.ts (ADR-0011)'
  },
  'primary-current': {
    title: 'Primary current (I_p)',
    body: 'Current in the driven winding. It magnetises the core; the secondary sees only the flux that current produces, never the current itself.',
    unit: 'A',
    source: 'devices/quanta/transformer.ts'
  },
  'mutual-inductance': {
    title: 'Mutual inductance (M)',
    body: 'M = k\u00b7\u221a(L_p\u00b7L_s) \u2014 how much EMF a change of current in one winding induces in the other. Only a changing flux couples: hold the primary current constant and the secondary goes dead.',
    unit: 'H',
    source: 'devices/quanta/transformer.ts'
  },
  'turns-ratio': {
    title: 'Turns ratio (N_s / N_p)',
    body: 'Sets V_s / V_p in the ideal limit. More secondary turns buys voltage and costs current; power out never exceeds power in.',
    source: 'devices/quanta/transformer.ts'
  },
  'coupling-coefficient': {
    title: 'Coupling coefficient (k)',
    body: 'The fraction of primary flux that reaches the secondary, 0\u20131. The Leakage toggle drops k, so V_s falls while I_p does not \u2014 the missing flux closes through air. Here k is a dial, not a number computed from the core geometry.',
    source: 'devices/quanta/transformer.ts leakage toggle'
  },
  'induction-charging': {
    title: 'Charging by induction',
    body: 'Each ring is wired to the opposite bucket, so a ring at one polarity pushes the opposite charge onto every drop that falls through it \u2014 without contact and without rubbing.',
    source: 'Kelvin 1867 water-dropping influence machine'
  },
  'positive-feedback': {
    title: 'Positive feedback',
    body: 'More charge in a bucket strengthens the opposite ring, which charges the next drop harder. dV/dt carries a term proportional to V, so the voltage climbs roughly exponentially until leakage or breakdown caps it.',
    source: 'cpp/src/plant/kelvin_plant.cpp'
  }
};

/** Map annotation / tour highlight ids → glossary keys */
export const HIGHLIGHT_GLOSSARY: Record<string, string> = {
  'inner-ring': 'NdFeB',
  'outer-ring': 'NdFeB',
  stator: 'stator',
  coil: 'pickup-coil',
  flux: 'flux',
  ionization: 'ionization',
  separator: 'air-gap',
  shaft: 'B-field',
  'vdg-belt': 'belt-charge',
  'vdg-sphere': 'sphere-capacitance',
  'vdg-spark': 'corona',
  'hall-strip': 'hall-voltage',
  'hall-probe': 'hall-coefficient',
  'hall-carrier': 'carrier-density',
  'lorentz-rails': 'armature-current',
  'lorentz-armature': 'lorentz-force',
  'lorentz-poles': 'bench-field',
  'xfmr-primary': 'primary-current',
  'xfmr-core': 'mutual-inductance',
  'xfmr-secondary': 'turns-ratio',
  'xfmr-coupling': 'coupling-coefficient',
  'kelvin-ring': 'induction-charging',
  'kelvin-bucket': 'positive-feedback',
  'kelvin-stream': 'sphere-capacitance',
  'kelvin-spark': 'corona'
};

export function glossaryForHighlight(highlightId: string | null | undefined): GlossaryEntry | null {
  const key = highlightId ? HIGHLIGHT_GLOSSARY[highlightId] : undefined;
  return key ? SEG_GLOSSARY[key] : null;
}
