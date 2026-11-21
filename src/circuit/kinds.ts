/**
 * Circuit Lab element kinds (#256, ADR-0018) — the packed wire format of
 * cpp/src/circuit/circuit.h, mirrored for the netlist compiler.
 *
 * `wire` is the C++ `enum class Kind` value (append-only); `circuit_kind_name`
 * in the shipped binary must agree with `name` for every row
 * (scripts/tests/circuit.test.mjs checks). The schematic adds three pseudo
 * kinds that never reach the solver: `GND` (node 0), `PORT` (a bench port,
 * expanded by src/circuit/ports.ts) and nothing else — meters are real
 * elements (VM reads a voltage, AM is a 0 V source in series).
 */

export type SolverKind = 'R' | 'C' | 'L' | 'V' | 'I' | 'K' | 'E' | 'G' | 'D' | 'S' | 'VM' | 'AM' | 'M';
export type DocKind = SolverKind | 'GND' | 'PORT';

export interface ParamSpec {
  /** Name in the netlist document (`p.<name>`) and in `circuit.elem.<id>.<name>`. */
  name: string;
  /** SI unit shown next to the value ('' for dimensionless). */
  unit: string;
  default: number;
  /** Inclusive lower bound unless `positive`, which also refuses 0. */
  min?: number;
  max?: number;
  positive?: boolean;
  label: string;
}

export interface KindSpec {
  kind: DocKind;
  /** C++ `Kind` value; -1 for schematic-only kinds. */
  wire: number;
  label: string;
  /** Terminal names, in packed order. */
  terminals: readonly string[];
  /** Fixed parameters (V / I carry a waveform instead: see WAVE_PARAMS). */
  params: readonly ParamSpec[];
  /** Has an MNA branch-current row. */
  branch?: boolean;
  /** Shown in the wiring view's palette. */
  palette?: boolean;
}

const R_PARAM: ParamSpec = { name: 'r', unit: 'Ω', default: 1000, positive: true, label: 'resistance' };

export const KIND_SPECS: Readonly<Record<DocKind, KindSpec>> = {
  R: { kind: 'R', wire: 0, label: 'Resistor', terminals: ['a', 'b'], params: [R_PARAM], palette: true },
  C: {
    kind: 'C', wire: 1, label: 'Capacitor', terminals: ['a', 'b'], palette: true,
    params: [
      { name: 'c', unit: 'F', default: 1e-6, positive: true, label: 'capacitance' },
      { name: 'ic', unit: 'V', default: 0, label: 'initial voltage' }
    ]
  },
  L: {
    kind: 'L', wire: 2, label: 'Inductor', terminals: ['a', 'b'], branch: true, palette: true,
    params: [
      { name: 'l', unit: 'H', default: 1e-3, positive: true, label: 'inductance' },
      { name: 'ic', unit: 'A', default: 0, label: 'initial current' }
    ]
  },
  V: { kind: 'V', wire: 3, label: 'Voltage source', terminals: ['p', 'n'], params: [], branch: true, palette: true },
  I: { kind: 'I', wire: 4, label: 'Current source', terminals: ['p', 'n'], params: [], palette: true },
  K: {
    kind: 'K', wire: 5, label: 'Coupling', terminals: [], palette: false,
    params: [{ name: 'k', unit: '', default: 0.97, min: 0, max: 0.999, label: 'coupling coefficient' }]
  },
  E: {
    kind: 'E', wire: 6, label: 'VCVS', terminals: ['p', 'n', 'cp', 'cn'], branch: true,
    params: [{ name: 'gain', unit: '', default: 10, label: 'voltage gain' }]
  },
  G: {
    kind: 'G', wire: 7, label: 'VCCS', terminals: ['p', 'n', 'cp', 'cn'],
    params: [{ name: 'gm', unit: 'S', default: 1e-3, label: 'transconductance' }]
  },
  D: {
    kind: 'D', wire: 8, label: 'Diode', terminals: ['a', 'k'], palette: true,
    params: [
      { name: 'is', unit: 'A', default: 1e-14, positive: true, label: 'saturation current' },
      { name: 'n', unit: '', default: 1, min: 0.5, max: 10, label: 'emission coefficient' },
      { name: 'rs', unit: 'Ω', default: 0, min: 0, label: 'series resistance' }
    ]
  },
  S: {
    kind: 'S', wire: 9, label: 'Switch', terminals: ['a', 'b'], palette: true,
    params: [
      { name: 'ron', unit: 'Ω', default: 1e-3, positive: true, label: 'on resistance' },
      { name: 'roff', unit: 'Ω', default: 1e9, positive: true, label: 'off resistance' },
      { name: 'closed', unit: '', default: 0, min: 0, max: 1, label: 'closed (0/1)' },
      { name: 'period', unit: 's', default: 0, min: 0, label: 'clock period (0 = manual)' },
      { name: 'duty', unit: '', default: 0.5, min: 0, max: 1, label: 'duty cycle' },
      { name: 'delay', unit: 's', default: 0, min: 0, label: 'first closing' }
    ]
  },
  VM: { kind: 'VM', wire: 10, label: 'Voltmeter', terminals: ['+', '−'], params: [], palette: true },
  AM: { kind: 'AM', wire: 11, label: 'Ammeter', terminals: ['in', 'out'], params: [], branch: true, palette: true },
  M: {
    kind: 'M', wire: 12, label: 'MOSFET (level 1)', terminals: ['d', 'g', 's'],
    params: [
      { name: 'pol', unit: '', default: 1, min: -1, max: 1, label: 'polarity (+1 N, −1 P)' },
      { name: 'vt', unit: 'V', default: 1, label: 'threshold' },
      { name: 'kp', unit: 'A/V²', default: 1e-3, positive: true, label: 'transconductance factor' },
      { name: 'lambda', unit: '1/V', default: 0, min: 0, label: 'channel-length modulation' }
    ]
  },
  GND: { kind: 'GND', wire: -1, label: 'Ground', terminals: ['g'], params: [], palette: true },
  PORT: { kind: 'PORT', wire: -1, label: 'Bench port', terminals: ['+', '−'], params: [] }
};

/** C++ `Kind` value → name, for the binary cross-check. */
export const WIRE_KIND_NAMES: readonly SolverKind[] = (Object.values(KIND_SPECS) as KindSpec[])
  .filter((s) => s.wire >= 0)
  .sort((a, b) => a.wire - b.wire)
  .map((s) => s.kind as SolverKind);

/** Waveforms of V / I (`p.w`), with their packed parameter order after the type id. */
export type WaveKind = 'dc' | 'sin' | 'pulse';
export const WAVE_IDS: Readonly<Record<WaveKind, number>> = { dc: 0, sin: 1, pulse: 2 };
export const WAVE_PARAMS: Readonly<Record<WaveKind, readonly ParamSpec[]>> = {
  dc: [{ name: 'dc', unit: '', default: 1, label: 'value' }],
  sin: [
    { name: 'off', unit: '', default: 0, label: 'offset' },
    { name: 'amp', unit: '', default: 1, label: 'amplitude' },
    { name: 'f', unit: 'Hz', default: 60, min: 0, label: 'frequency' },
    { name: 'ph', unit: '°', default: 0, label: 'phase' },
    { name: 'td', unit: 's', default: 0, min: 0, label: 'delay' },
    { name: 'damp', unit: '1/s', default: 0, min: 0, label: 'damping' }
  ],
  pulse: [
    { name: 'v1', unit: '', default: 0, label: 'initial' },
    { name: 'v2', unit: '', default: 1, label: 'pulsed' },
    { name: 'td', unit: 's', default: 0, min: 0, label: 'delay' },
    { name: 'tr', unit: 's', default: 1e-6, min: 0, label: 'rise' },
    { name: 'tf', unit: 's', default: 1e-6, min: 0, label: 'fall' },
    { name: 'pw', unit: 's', default: 1e-3, min: 0, label: 'width' },
    { name: 'per', unit: 's', default: 2e-3, min: 0, label: 'period' }
  ]
};

/** Packed-option order (circuit.h `Options`). A value ≤ 0 keeps the solver default. */
export const OPTION_NAMES = ['maxStep', 'minStep', 'reltol', 'vntol', 'abstol', 'gmin', 'maxNewton', 'lteReltol'] as const;
export type CircuitOptionName = (typeof OPTION_NAMES)[number];

export const CIRCUIT_FORMAT_VERSION = 1;
/** circuit.h limits. */
export const CIRCUIT_MAX_NODES = 96;
export const CIRCUIT_MAX_ELEMENTS = 256;

/** Readout header slots (circuit.h `RO_*`), then node voltages, then READOUT_STRIDE per element. */
export const RO = { time: 0, status: 1, steps: 2, newton: 3, rejected: 4, wSource: 5, wDissipated: 6, stored: 7, storedStart: 8 } as const;
export const RO_HEADER = 9;
export const RE = { i: 0, v: 1, p: 2, wE: 3, wQ: 4, wI2: 5 } as const;
export const READOUT_STRIDE = 6;
/** stat(which) (circuit.h `ST_*`). */
export const ST = {
  steps: 0, rejected: 1, newton: 2, factors: 3, analyses: 4, reused: 5, beSteps: 6,
  minStep: 7, maxStep: 8, unknowns: 9, nonlinear: 10
} as const;
/** step() / load() status codes (circuit.h `Status`). */
export const CIRCUIT_STATUS: Readonly<Record<number, string>> = {
  0: 'ok', [-1]: 'format', [-2]: 'limits', [-3]: 'node', [-4]: 'param',
  [-5]: 'singular', [-6]: 'newton', [-7]: 'not loaded', [-8]: 'step'
};

/** Packed parameters of one element, in C++ order, from its named document values. */
export function packedParamNames(kind: SolverKind, wave?: WaveKind): readonly string[] {
  if (kind === 'V' || kind === 'I') return ['w', ...WAVE_PARAMS[wave ?? 'dc'].map((p) => p.name)];
  return KIND_SPECS[kind].params.map((p) => p.name);
}
