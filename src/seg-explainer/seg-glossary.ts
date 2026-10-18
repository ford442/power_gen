/**
 * Glossary terms sourced from scientific-data.ts / literature refs.
 */

import { SEG_DATA, PHYSICAL_CONSTANTS } from '../scientific-data';
import { SEG_SPEC } from '../seg-operator-state';
import { HOMOPOLAR, MAGLEV, MHD, PELTIER, PULSE_COIL_CORE } from '../../generated/physics-constants';

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
  'kelvin-ceiling': {
    title: 'Voltage ceiling (Kelvin dropper)',
    body: 'Each bucket is a small capacitor (\u2248 40 pF), so V = Q/C climbs as charged drops land. Two things fight the climb: leakage bleeding charge away, and the bucket\u2019s own rising field doing work against every incoming drop. The plant carries both as the leak term and the drive term in dV/dt.',
    unit: 'V',
    source: 'cpp/src/plant/kelvin_plant.cpp / constants.json kelvin.bucketCapacitanceF'
  },
  'kelvin-breakdown': {
    title: 'Bucket-gap breakdown',
    body: 'At V_break the gap between the oppositely charged buckets ionises and the plant fires a spark, dumping ~98% of the stored charge so the loop restarts from near zero \u2014 the sawtooth in the readout. V_break is the classroom air-breakdown estimate (3\u00d710\u2076 V/m) across the bench gap, not a measured flashover.',
    unit: 'V',
    value: '\u2248 60 kV',
    source: 'cpp/src/plant/kelvin_plant.h vBreak / constants.json kelvin.eBreakdownVm'
  },
  'positive-feedback': {
    title: 'Positive feedback',
    body: 'More charge in a bucket strengthens the opposite ring, which charges the next drop harder. dV/dt carries a term proportional to V, so the voltage climbs roughly exponentially until leakage or breakdown caps it.',
    source: 'cpp/src/plant/kelvin_plant.cpp'
  },
  'heron-head': {
    title: 'Driving head h',
    body: 'The one hydraulic state the Heron bench keeps. The drive tops it up and the jet drains it in proportion to exit speed. Gauge pressure is hydrostatic, p = \u03c1 g h \u2014 not an air pressure inside a sealed vessel.',
    unit: 'm',
    value: 'p = \u03c1 g h',
    source: 'renderers/shared/device-physics.ts, heron-layout.ts'
  },
  'bernoulli-exit': {
    title: 'Bernoulli exit speed',
    body: 'Ideal jet speed from a head h is \u221a(2 g h). The model subtracts pipe head loss and multiplies by the nozzle discharge coefficient, so the exit speed never exceeds the ideal figure.',
    unit: 'm/s',
    value: 'v = C_d \u221a(2 g (h \u2212 h_loss))',
    source: 'heron-layout.ts computeHeronHydraulics'
  },
  'swamee-jain': {
    title: 'Swamee\u2013Jain friction',
    body: 'An explicit fit for the Darcy friction factor at a given Reynolds number and relative roughness. Head loss is h_loss = f (L/D) v\u00b2/2g, so longer or thinner pipe costs more head.',
    value: 'h_loss = f (L/D) v\u00b2/2g',
    source: 'heron-layout.ts swameeJainFriction'
  },
  'capacitor-discharge': {
    title: 'Capacitor-bank charge and fire',
    body: `The bank relaxes toward drive \u00d7 ${PULSE_COIL_CORE.vChargeMax} V with a ${PULSE_COIL_CORE.chargeTauS} s time constant and fires at ${Math.round(PULSE_COIL_CORE.fireFraction * 100)}% of that target.`,
    unit: 'V',
    value: `V_max = ${PULSE_COIL_CORE.vChargeMax} V`,
    source: 'physics/constants.json pulseCoil'
  },
  'rl-time-constant': {
    title: 'L/R time constant',
    body: 'In a series R\u2013L circuit the current cannot jump: L dI/dt = V \u2212 R I. The time constant L/R sets how fast it approaches V/R, and the starting slope is V/L.',
    unit: 's',
    value: `L/R = ${((PULSE_COIL_CORE.lHenry / PULSE_COIL_CORE.rOhm) * 1000).toFixed(1)} ms`,
    source: 'physics/constants.json pulseCoil'
  },
  'ring-down': {
    title: 'Underdamped ring-down',
    body: 'With the capacitor in the loop the circuit is a damped LC: it oscillates at \u03c9\u2080 = 1/\u221a(LC) while the amplitude decays at R/2L, so the current reverses and dies away.',
    value: `\u03c9\u2080 \u2248 ${(1 / Math.sqrt(PULSE_COIL_CORE.lHenry * PULSE_COIL_CORE.capF)).toFixed(0)} rad/s`,
    source: 'devices/quanta/pulse-coil.ts'
  },
  'wave-slice': {
    title: 'FDTD wave slice',
    body: 'A 2D TM_z finite-difference grid in normalized units with light slowed for display. Its source follows the coil current, so a front is launched when the current changes. A qualitative picture, not a field solution.',
    source: 'docs/adr/0010-fdtd-slice.md'
  },
  'faraday-disc-emf': {
    title: 'Faraday disc EMF',
    body: 'A solid disc of radius r spinning at \u03c9 in a uniform axial field B develops \u03b5 = \u00bd B \u03c9 r\u00b2 between axle and rim: motional EMF integrated along the radius.',
    unit: 'V',
    value: `B = ${HOMOPOLAR.bAxialT} T, r = ${HOMOPOLAR.discRadiusM} m`,
    source: 'devices/quanta/homopolar-generator.ts'
  },
  'disc-back-torque': {
    title: 'Back-torque on the disc',
    body: 'Current across the disc in the field feels a force that opposes the spin, \u03c4 = I B r/2. With I = \u03b5/R it grows linearly with speed, like viscous drag, which is what caps the disc speed.',
    unit: 'N\u00b7m',
    value: '\u03c4 = B\u00b2 r\u00b3 \u03c9 / 4R',
    source: 'devices/quanta/homopolar-generator.ts'
  },
  'halbach-rotation': {
    title: 'Halbach rotation step',
    body: 'Neighbouring magnets are turned a fixed angle from each other. At the ideal step (360\u00b0/N in the ring) the orientation rotates twice per lap and the field is steered to one side; the drive slider sweeps 0.65\u00d7 to 1.35\u00d7 of it.',
    source: 'physics/magnetic-field.ts buildHalbachSegments'
  },
  'thermal-two-node': {
    title: 'Two-node thermal model',
    body: `A hot plate (${PELTIER.heatCapHotJK} J/K) and a cold plate (${PELTIER.heatCapColdJK} J/K) joined by ${PELTIER.conductanceWK} W/K; only the cold plate is tied to ambient (${PELTIER.sinkWK} W/K). Each plate has a single temperature.`,
    unit: 'K',
    source: 'physics/constants.json peltier'
  },
  'seebeck-coefficient': {
    title: 'Seebeck voltage',
    body: 'A temperature difference across a thermoelectric junction pair drives a voltage S \u0394T. The stack multiplies a per-couple coefficient by the number of couples.',
    unit: 'V/K',
    value: `S \u2248 ${(PELTIER.seebeckVK * PELTIER.couples).toFixed(3)} V/K`,
    source: 'physics/constants.json peltier'
  },
  'hartmann-braking': {
    title: 'Hartmann braking',
    body: `A conducting fluid moving across B generates current, and that current feels a force opposing the flow. The model lumps it as ${MHD.lorentzK} B\u00b2 u against the pump, so the brake grows with the square of the field.`,
    value: 'du/dt = pump \u2212 (k B\u00b2 + f) u',
    source: 'devices/core/mhd-mesh.ts'
  },
  'hartmann-number': {
    title: 'Hartmann number',
    body: 'Ha = B a \u221a(\u03c3 / \u03c1\u03bd) compares magnetic to viscous force. Large Ha means thin Hartmann layers and a flat core. Reported for the regime; not fed back into the plant.',
    value: `Ha \u2248 ${(MHD.halfGapM * Math.sqrt(MHD.sigmaSm / (MHD.rhoKgM3 * MHD.nuM2s))).toFixed(0)} per tesla`,
    source: 'devices/core/mhd-mesh.ts'
  },
  'gap-spring': {
    title: 'Virtual gap spring',
    body: 'Lift is modelled as F = k (target \u2212 gap), scaled by the drive, rather than computed from the magnet field. The gap settles where lift equals the floater\u2019s weight, a little below the target.',
    unit: 'N/m',
    value: `k = ${MAGLEV.kSpringNm} N/m`,
    source: 'physics/constants.json maglev'
  },
  'eddy-damping': {
    title: 'Eddy-current damping',
    body: 'A conductor moving in a magnetic field is braked by induced currents. Here it is a single damping coefficient on the gap velocity, large enough that the floater settles without oscillating.',
    unit: 'N\u00b7s/m',
    value: `c = ${MAGLEV.cDampNsm} N\u00b7s/m`,
    source: 'physics/constants.json maglev'
  },
  soc: {
    title: 'State of charge',
    body: 'Battery charge as a fraction, 0 to 1. In the LED/solar loop it changes at (gain \u2212 drain), with gain a small fixed fraction of drain, so it only falls.',
    value: 'gain \u2248 6% of drain',
    source: 'renderers/shared/device-physics.ts, cpp/src/plant/solar_plant.cpp'
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
  'kelvin-stream': 'kelvin-ceiling',
  'kelvin-spark': 'kelvin-breakdown'
};

export function glossaryForHighlight(highlightId: string | null | undefined): GlossaryEntry | null {
  const key = highlightId ? HIGHLIGHT_GLOSSARY[highlightId] : undefined;
  return key ? SEG_GLOSSARY[key] : null;
}
