/**
 * The MHD duct as a lattice-Boltzmann slice (docs/FLUIDS.md → MHD duct → The
 * slice): sizes, the lattice's units, the per-column tables and the uniform
 * block of `passes/mhd-slice-*.wgsl`. The solver's CPU twin is
 * mhd-slice-cpu.ts; the WebGPU host is mhd-slice-solver.ts.
 *
 * One D2Q9 kernel (two-relaxation-time collision, Guo forcing, half-way
 * bounce-back walls), used two ways:
 *
 * - **Mid-plane** (`mhdSliceConfig`): the plane half-way between the Hartmann
 *   walls, x along the flow and z between the electrodes, field out of the
 *   plane. The velocity is the gap average. Wall friction on the Hartmann
 *   walls is a linear drag (ν/a²)·Φ(Ha) — the same term the plant uses — and
 *   the Lorentz force is σ(−∇φ + u×B)×B with the potential φ solved on the
 *   same grid (∇·j = 0) between electrode segments that are equipotentials
 *   closed through their loads. This is what shows the field's edges: the
 *   wall jets, the current that circulates round the ends of the electrodes.
 * - **Gap** (`mhdGapConfig`): a slice across the gap, field in the plane,
 *   periodic along the flow. Its steady state is the Hartmann profile, which
 *   is what the kernel is tested against.
 *
 * Lattice units: cell = 1, step = 1. Everything physical enters through
 * {@link MhdSliceUnits}. Pure: no GPU, no DOM.
 */
import { MHD } from '../../generated/physics-constants.js';
import { hartmannWallShear } from '../physics/hartmann.js';
import { mhdHartmannNumber, mhdInternalOhm, type MhdDuctParams } from '../physics/mhd-duct.js';

/** D2Q9 velocity set: rest, the four axes, the four diagonals. Mirrored in common/mhd-slice.wgsl. */
export const D2Q9_CX = Object.freeze([0, 1, 0, -1, 0, 1, -1, -1, 1]);
export const D2Q9_CY = Object.freeze([0, 0, 1, 0, -1, 1, 1, -1, -1]);
export const D2Q9_W = Object.freeze([4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36]);
export const D2Q9_OPP = Object.freeze([0, 3, 4, 1, 2, 7, 8, 5, 6]);

/** `MhdSliceParams` in common/mhd-slice.wgsl. */
export const MHD_SLICE_PARAMS_BYTES = 80;
/** f32 offsets into the uniform block. */
export const MHD_SLICE_F = Object.freeze({
  nx: 0, ny: 1, flags: 2, segments: 3,
  omegaPlus: 4, omegaMinus: 5, inletU: 6, gUniform: 7,
  lorentz: 8, dragUniform: 9, sorOmega: 10, circuitGain: 11,
  segLoad: 12
});
export const MHD_SLICE_MAX_SEGMENTS = 8;
/** Periodic along x (the gap slice); otherwise an inlet at x = 0 and an outlet at the far end. */
export const MHD_SLICE_FLAG_PERIODIC = 1;
/** Solve the potential and apply its force (the mid-plane). */
export const MHD_SLICE_FLAG_POTENTIAL = 2;
/** Words after the per-column means in the state buffer: a voltage and a current per segment. */
export const MHD_SLICE_STATE_EXTRA = 2 * MHD_SLICE_MAX_SEGMENTS;
/** Floats per column in the column table: field shape, wall drag, segment index (−1 none), segment length. */
export const MHD_SLICE_COLUMN_FLOATS = 4;
export const MHD_SLICE_WORKGROUP = 8;
export const MHD_SLICE_REDUCE_WORKGROUP = 64;
/** TRT "magic" Λ = 3/16: puts the bounce-back wall exactly half a cell out for a parabolic profile. */
export const MHD_SLICE_MAGIC = 3 / 16;
/** A load at or above this (dimensionless) is an open circuit to the shader's f32. */
export const MHD_SLICE_OPEN_LOAD = 1e9;

export interface MhdSliceConfig {
  nx: number;
  ny: number;
  flags: number;
  /** 1/τ⁺ (sets the viscosity) and 1/τ⁻ (from the magic parameter). */
  omegaPlus: number;
  omegaMinus: number;
  /** Inlet speed, lattice units (cells per step). */
  inletU: number;
  /** Uniform body acceleration along x, lattice units. */
  gUniform: number;
  /** σB²·dt/ρ at the peak field: the Lorentz coefficient. */
  lorentz: number;
  /** Drag applied everywhere, per step. */
  dragUniform: number;
  /** Over-relaxation of the potential's red-black sweeps. */
  sorOmega: number;
  /** Share of the circuit's correction applied to an electrode's voltage per step. */
  circuitGain: number;
  /** Sweeps of the potential per flow step. */
  sorSweeps: number;
  /** Electrode pairs, and each pair's load as R·σ·2a (dimensionless). */
  segments: number;
  segLoad: number[];
  /** Per column: [field shape 0…1, wall drag per step, segment index or −1, cells in that segment]. */
  columns: Float32Array;
}

/** What one lattice unit is worth, for a mid-plane slice. */
export interface MhdSliceUnits {
  cellM: number;
  stepS: number;
  /** Metres per second per lattice speed unit. */
  speedMS: number;
  /** Volts per lattice potential unit (B·c·Δx at the peak field). */
  volts: number;
  /** Amperes per unit of the solver's electrode current sum. */
  amps: number;
  /** The lattice's own (numerical) viscosity across the plane, m²/s. */
  lateralViscosityM2s: number;
}

/** The mid-plane grid: 256 × 40 square cells — the duct's 0.1 m width and 0.64 m of its length. */
export const MHD_SLICE_GRID = Object.freeze({ nx: 256, ny: 40 });
/** Lattice speed c = Δx/Δt, m/s: 2 m/s is 0.064 cells a step. Set so the fastest wall jet stays under Mach 0.2. */
export const MHD_SLICE_LATTICE_SPEED_MS = 31.25;
/** Largest inlet speed the lattice is asked to carry, cells per step. */
export const MHD_SLICE_MAX_INLET = 0.1;
/** τ⁺ of the mid-plane: a numerical lateral viscosity, far above the fluid's (docs/FLUIDS.md → limits). */
export const MHD_SLICE_TAU = 0.6;
/** Cells over which the field falls from its full value to nothing at each end of the pole faces. */
export const MHD_SLICE_FRINGE_CELLS = 4;
/** Electrode pairs along the pole faces, and the insulating gap between neighbours, cells. */
export const MHD_SLICE_ELECTRODES = Object.freeze({ segments: 4, gapCells: 4 });

export interface MhdSliceLayout {
  /** First column under the pole faces, and one past the last. */
  poleStart: number;
  poleEnd: number;
  /** Per segment: first column and length, cells. */
  electrodes: { start: number; cells: number }[];
}

/** Where the pole faces and the electrode segments sit on the grid: centred, the electrodes spanning the poles. */
export function mhdSliceLayout(p: MhdDuctParams = MHD, nx: number = MHD_SLICE_GRID.nx, ny: number = MHD_SLICE_GRID.ny): MhdSliceLayout {
  const cellM = p.widthM / ny;
  const poleCells = Math.min(nx - 16, Math.round(p.lengthM / cellM));
  const poleStart = Math.floor((nx - poleCells) / 2);
  const { segments, gapCells } = MHD_SLICE_ELECTRODES;
  const cells = Math.floor((poleCells - (segments - 1) * gapCells) / segments);
  const slack = poleCells - (segments * cells + (segments - 1) * gapCells);
  const electrodes = [];
  for (let k = 0; k < segments; k++) electrodes.push({ start: poleStart + Math.floor(slack / 2) + k * (cells + gapCells), cells });
  return { poleStart, poleEnd: poleStart + poleCells, electrodes };
}

/** The field's shape along the duct, 0…1: full under the pole faces, a tanh edge at each end. */
export function mhdSliceFieldShape(column: number, layout: MhdSliceLayout, fringeCells: number = MHD_SLICE_FRINGE_CELLS): number {
  const x = column + 0.5;
  return 0.5 * (Math.tanh((x - layout.poleStart) / fringeCells) - Math.tanh((x - layout.poleEnd) / fringeCells));
}

export function mhdSliceUnits(bFieldT: number, p: MhdDuctParams = MHD, ny: number = MHD_SLICE_GRID.ny): MhdSliceUnits {
  const cellM = p.widthM / ny;
  const stepS = cellM / MHD_SLICE_LATTICE_SPEED_MS;
  const volts = bFieldT * MHD_SLICE_LATTICE_SPEED_MS * cellM;
  return {
    cellM,
    stepS,
    speedMS: MHD_SLICE_LATTICE_SPEED_MS,
    volts,
    amps: p.sigmaSm * 2 * p.halfGapM * volts,
    lateralViscosityM2s: ((MHD_SLICE_TAU - 0.5) / 3) * cellM * MHD_SLICE_LATTICE_SPEED_MS
  };
}

const omegaMinusFor = (tauPlus: number): number => 1 / (MHD_SLICE_MAGIC / (tauPlus - 0.5) + 0.5);

export interface MhdSliceInput {
  /** Peak field under the poles, T. */
  bFieldT: number;
  /** Mean speed the plant reports, m/s: the slice's inflow. */
  flowU: number;
  /** Load across the whole generator, Ω; `Infinity` for open circuit. Shared out to the segments by length. */
  rLoadOhm?: number;
}

/**
 * The mid-plane slice for the plant's present field and flow. The plant stays
 * the authority on how fast the duct runs: its mean speed is the inflow, and
 * the mean drag in each cross-section is balanced by a body force (the
 * pressure gradient the pump supplies) so the lattice only carries the part
 * of the pressure that redistributes the flow.
 */
export function mhdSliceConfig(input: MhdSliceInput, p: MhdDuctParams = MHD, grid: { nx: number; ny: number } = MHD_SLICE_GRID): MhdSliceConfig {
  const { nx, ny } = grid;
  const layout = mhdSliceLayout(p, nx, ny);
  const units = mhdSliceUnits(input.bFieldT, p, ny);
  const b = Number.isFinite(input.bFieldT) ? Math.max(0, input.bFieldT) : 0;
  const u = Number.isFinite(input.flowU) ? Math.max(0, input.flowU) : 0;
  const columns = new Float32Array(nx * MHD_SLICE_COLUMN_FLOATS);
  const wall = p.nuM2s / (p.halfGapM * p.halfGapM) * units.stepS;
  for (let i = 0; i < nx; i++) {
    const shape = mhdSliceFieldShape(i, layout);
    columns[i * 4] = shape;
    columns[i * 4 + 1] = wall * hartmannWallShear(mhdHartmannNumber(b * shape, p));
    columns[i * 4 + 2] = -1;
  }
  const rLoad = input.rLoadOhm ?? p.rLoadOhm;
  const poleCells = layout.poleEnd - layout.poleStart;
  const segLoad = new Array<number>(MHD_SLICE_MAX_SEGMENTS).fill(0);
  layout.electrodes.forEach((e, k) => {
    for (let i = e.start; i < e.start + e.cells; i++) {
      columns[i * 4 + 2] = k;
      columns[i * 4 + 3] = e.cells;
    }
    // The generator's load is shared by the segments in parallel, each in proportion to its length.
    const ohm = rLoad * (poleCells / e.cells);
    segLoad[k] = Number.isFinite(ohm) ? Math.min(MHD_SLICE_OPEN_LOAD, ohm * p.sigmaSm * 2 * p.halfGapM) : MHD_SLICE_OPEN_LOAD;
  });
  return {
    nx,
    ny,
    flags: MHD_SLICE_FLAG_POTENTIAL,
    omegaPlus: 1 / MHD_SLICE_TAU,
    omegaMinus: omegaMinusFor(MHD_SLICE_TAU),
    inletU: Math.min(MHD_SLICE_MAX_INLET, u / units.speedMS),
    gUniform: 0,
    lorentz: (p.sigmaSm * b * b * units.stepS) / p.rhoKgM3,
    dragUniform: 0,
    sorOmega: 1.8,
    circuitGain: 0.5,
    sorSweeps: 2,
    segments: layout.electrodes.length,
    segLoad,
    columns
  };
}

/**
 * A slice across the gap at a Hartmann number: walls at the top and bottom
 * rows, periodic along the flow, a uniform push against a drag Ha²·ν/a² on
 * the velocity (electrodes shorted: the field's whole force). Its steady
 * profile is the Hartmann profile whatever the push. τ⁺ = 1 by default: the
 * profile's shape does not depend on the Reynolds number, so the test picks
 * the viscosity that settles fastest.
 */
export function mhdGapConfig(hartmann: number, o: { nx?: number; ny?: number; tau?: number; push?: number } = {}): MhdSliceConfig {
  const nx = o.nx ?? 8;
  const ny = o.ny ?? 64;
  const tau = o.tau ?? 1;
  const nu = (tau - 0.5) / 3;
  const a = ny / 2;
  const columns = new Float32Array(nx * MHD_SLICE_COLUMN_FLOATS);
  for (let i = 0; i < nx; i++) columns[i * 4 + 2] = -1;
  const drag = (hartmann * hartmann * nu) / (a * a);
  return {
    nx,
    ny,
    flags: MHD_SLICE_FLAG_PERIODIC,
    omegaPlus: 1 / tau,
    omegaMinus: omegaMinusFor(tau),
    inletU: 0,
    // Scaled with the drag so the settled speed stays near 0.01 at any Ha.
    gUniform: o.push ?? 1e-6 * (1 + (hartmann * hartmann) / 3),
    lorentz: 0,
    dragUniform: drag,
    sorOmega: 1,
    circuitGain: 0,
    sorSweeps: 0,
    segments: 0,
    segLoad: new Array<number>(MHD_SLICE_MAX_SEGMENTS).fill(0),
    columns
  };
}

/** Mean speed the gap slice settles at, lattice units: (G·a²/ν)·(1 − tanh Ha/Ha)/Ha², G·a²/3ν at Ha = 0. */
export function mhdGapSettledSpeed(c: MhdSliceConfig, hartmann: number): number {
  const nu = (1 / c.omegaPlus - 0.5) / 3;
  const a = c.ny / 2;
  const k = (c.gUniform * a * a) / nu;
  return hartmann < 1e-3 ? k / 3 : (k / (hartmann * hartmann)) * (1 - Math.tanh(hartmann) / hartmann);
}

/** Pack the uniform block (`MhdSliceParams`). */
export function packMhdSliceParams(c: MhdSliceConfig, out: ArrayBuffer = new ArrayBuffer(MHD_SLICE_PARAMS_BYTES)): ArrayBuffer {
  const f = new Float32Array(out);
  const u = new Uint32Array(out);
  const F = MHD_SLICE_F;
  u[F.nx] = c.nx;
  u[F.ny] = c.ny;
  u[F.flags] = c.flags;
  u[F.segments] = c.segments;
  f[F.omegaPlus] = c.omegaPlus;
  f[F.omegaMinus] = c.omegaMinus;
  f[F.inletU] = c.inletU;
  f[F.gUniform] = c.gUniform;
  f[F.lorentz] = c.lorentz;
  f[F.dragUniform] = c.dragUniform;
  f[F.sorOmega] = c.sorOmega;
  f[F.circuitGain] = c.circuitGain;
  for (let k = 0; k < MHD_SLICE_MAX_SEGMENTS; k++) f[F.segLoad + k] = c.segLoad[k] ?? 0;
  return out;
}

/** Bytes a slice holds on the GPU: two distribution buffers, the moments, the potential, columns and state. */
export function mhdSliceBytes(c: { nx: number; ny: number }): number {
  const cells = c.nx * c.ny;
  return cells * (2 * 9 * 4 + 16 + 4) + c.nx * 16 + (c.nx + MHD_SLICE_STATE_EXTRA) * 4;
}

/** The fluid's resistance under one electrode segment, Ω. */
export function mhdSliceSegmentOhm(cells: number, p: MhdDuctParams = MHD, grid: { nx: number; ny: number } = MHD_SLICE_GRID): number {
  const layout = mhdSliceLayout(p, grid.nx, grid.ny);
  return mhdInternalOhm(p) * ((layout.poleEnd - layout.poleStart) / cells);
}
