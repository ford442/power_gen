/**
 * CPU twin of the MHD slice's compute passes (`passes/mhd-slice-lbm.wgsl`,
 * `mhd-slice-phi.wgsl`): the same buffers, the same order, the same
 * arithmetic in f32 storage. It is what the WGSL is tested against on a GPU
 * (scripts/tests/gpu/golden-mhd-slice.test.mjs) and what the physics tests
 * run on without one — not a runtime fallback.
 *
 * One step:
 *   1. `lbm`    — pull the distributions in (half-way bounce-back at the top
 *                 and bottom rows; inlet and outlet columns, or periodic),
 *                 take the moments with half the force, collide (TRT) with
 *                 the Guo source, write the other buffer and the moments.
 *   2. `sor`    — red then black sweeps of ∇²φ = ∇·(u×B) on the new moments.
 *   3. `reduce` — per column, the mean force for the next step's balance;
 *                 per electrode pair, its current and its voltage through
 *                 the load.
 */
import {
  D2Q9_CX as CX, D2Q9_CY as CY, D2Q9_OPP as OPP, D2Q9_W as W,
  MHD_SLICE_FLAG_PERIODIC, MHD_SLICE_FLAG_POTENTIAL, MHD_SLICE_MAX_SEGMENTS, MHD_SLICE_STATE_EXTRA,
  type MhdSliceConfig
} from './mhd-slice.js';

export class MhdSliceCpu {
  config: MhdSliceConfig;
  readonly nx: number;
  readonly ny: number;
  /** Distributions, 9 per cell; `f` is current. */
  f: Float32Array;
  private g: Float32Array;
  /** Moments per cell: ux, uy, ρ, and the current's stream function once `streamFunction` has run. */
  readonly macro: Float32Array;
  readonly phi: Float32Array;
  /** Column means, then a voltage and a current per segment. */
  readonly state: Float32Array;
  steps = 0;

  constructor(config: MhdSliceConfig) {
    this.config = config;
    this.nx = config.nx;
    this.ny = config.ny;
    const cells = this.nx * this.ny;
    this.f = new Float32Array(cells * 9);
    this.g = new Float32Array(cells * 9);
    this.macro = new Float32Array(cells * 4);
    this.phi = new Float32Array(cells);
    this.state = new Float32Array(this.nx + MHD_SLICE_STATE_EXTRA);
    this.reset();
  }

  /** Fluid at rest density moving at the inlet speed; no potential, no voltages. */
  reset(): void {
    const u0 = this.config.inletU;
    for (let c = 0; c < this.nx * this.ny; c++) {
      for (let q = 0; q < 9; q++) this.f[c * 9 + q] = equilibrium(q, 1, u0, 0);
      this.macro[c * 4] = u0;
      this.macro[c * 4 + 1] = 0;
      this.macro[c * 4 + 2] = 1;
    }
    this.phi.fill(0);
    this.state.fill(0);
    this.steps = 0;
  }

  /** New parameters on the same grid (the plant's field and flow change every frame). */
  configure(config: MhdSliceConfig): void {
    if (config.nx !== this.nx || config.ny !== this.ny) throw new Error('MhdSliceCpu.configure: grid size changed');
    this.config = config;
  }

  step(n = 1): void {
    for (let s = 0; s < n; s++) {
      this.lbm();
      if (this.config.flags & MHD_SLICE_FLAG_POTENTIAL) {
        for (let k = 0; k < this.config.sorSweeps; k++) {
          this.sor(0);
          this.sor(1);
        }
        this.reduce();
      }
      this.steps++;
    }
  }

  private col(i: number, k: number): number {
    return this.config.columns[i * 4 + k];
  }

  /** φ one row beyond (i, j): the neighbour, or the wall's ghost — an electrode at ±V/2 or an insulator. */
  private phiAcross(i: number, j: number, dir: 1 | -1): number {
    const jn = j + dir;
    const here = this.phi[j * this.nx + i];
    if (jn >= 0 && jn < this.ny) return this.phi[jn * this.nx + i];
    const seg = this.col(i, 2);
    return seg >= 0 ? dir * this.state[this.nx + seg] - here : here;
  }

  private lbm(): void {
    const { nx, ny, f, g, macro, config: c } = this;
    const periodic = (c.flags & MHD_SLICE_FLAG_PERIODIC) !== 0;
    const potential = (c.flags & MHD_SLICE_FLAG_POTENTIAL) !== 0;
    const fin = new Float64Array(9);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const cell = j * nx + i;
        for (let q = 0; q < 9; q++) {
          let si = i - CX[q];
          const sj = j - CY[q];
          if (sj < 0 || sj >= ny) {
            fin[q] = f[cell * 9 + OPP[q]];
            continue;
          }
          if (si < 0 || si >= nx) {
            if (!periodic) {
              fin[q] = f[cell * 9 + q];
              continue;
            }
            si = (si + nx) % nx;
          }
          fin[q] = f[(sj * nx + si) * 9 + q];
        }
        if (!periodic && (i === 0 || i === nx - 1)) {
          // Inlet: the plant's speed, the density the interior asks for. Outlet: rest density, the speed that arrives.
          let rho = 1;
          let u = c.inletU;
          if (i === 0) rho = (fin[0] + fin[2] + fin[4] + 2 * (fin[3] + fin[6] + fin[7])) / (1 - u);
          else u = fin[0] + fin[2] + fin[4] + 2 * (fin[1] + fin[5] + fin[8]) - 1;
          for (let q = 0; q < 9; q++) g[cell * 9 + q] = equilibrium(q, rho, u, 0);
          macro[cell * 4] = u;
          macro[cell * 4 + 1] = 0;
          macro[cell * 4 + 2] = rho;
          continue;
        }
        let rho = 0;
        let mx = 0;
        let my = 0;
        for (let q = 0; q < 9; q++) {
          rho += fin[q];
          mx += fin[q] * CX[q];
          my += fin[q] * CY[q];
        }
        // Force per unit mass = (gx, gy) − drag·u. The drag is linear in u, so the half-force velocity is solved, not lagged.
        const shape = this.col(i, 0);
        const nl = c.lorentz * shape;
        const drag = c.dragUniform + this.col(i, 1) + nl * shape;
        let gx = c.gUniform;
        let gy = 0;
        if (potential) {
          const iw = Math.max(i - 1, 0);
          const ie = Math.min(i + 1, nx - 1);
          const dpx = (this.phi[j * nx + ie] - this.phi[j * nx + iw]) / (ie - iw);
          const dpy = (this.phiAcross(i, j, 1) - this.phiAcross(i, j, -1)) / 2;
          gx += nl * dpy - this.state[i];
          gy -= nl * dpx;
        }
        const half = 1 / (1 + drag / 2);
        const u = (mx / rho + gx / 2) * half;
        const v = (my / rho + gy / 2) * half;
        const fx = rho * (gx - drag * u);
        const fy = rho * (gy - drag * v);
        const usq = u * u + v * v;
        const uf = u * fx + v * fy;
        for (let q = 0; q < 9; q++) {
          const o = OPP[q];
          if (q > o) continue;
          const cu = CX[q] * u + CY[q] * v;
          const cf = CX[q] * fx + CY[q] * fy;
          // Symmetric and antisymmetric halves relax at their own rates (TRT); so do the halves of the Guo source.
          const eqP = W[q] * rho * (1 + 4.5 * cu * cu - 1.5 * usq);
          const eqM = W[q] * rho * 3 * cu;
          const fp = 0.5 * (fin[q] + fin[o]);
          const fm = 0.5 * (fin[q] - fin[o]);
          const sp = W[q] * (9 * cu * cf - 3 * uf);
          const sm = W[q] * 3 * cf;
          const outP = fp - c.omegaPlus * (fp - eqP) + (1 - 0.5 * c.omegaPlus) * sp;
          const outM = fm - c.omegaMinus * (fm - eqM) + (1 - 0.5 * c.omegaMinus) * sm;
          g[cell * 9 + q] = q === 0 ? outP : outP + outM;
          if (q !== 0) g[cell * 9 + o] = outP - outM;
        }
        macro[cell * 4] = u;
        macro[cell * 4 + 1] = v;
        macro[cell * 4 + 2] = rho;
      }
    }
    this.f = g;
    this.g = f;
  }

  /** One colour of a red-black sweep of ∇²φ = ∂x(−uy·b) + ∂y(ux·b). No-slip walls: the ghost velocity is −u. */
  private sor(colour: number): void {
    const { nx, ny, macro, phi } = this;
    const om = this.config.sorOmega;
    for (let j = 0; j < ny; j++) {
      for (let i = (j + colour) % 2; i < nx; i += 2) {
        const cell = j * nx + i;
        const iw = Math.max(i - 1, 0);
        const ie = Math.min(i + 1, nx - 1);
        const ddx = (macro[(j * nx + iw) * 4 + 1] * this.col(iw, 0) - macro[(j * nx + ie) * 4 + 1] * this.col(ie, 0)) / (ie - iw);
        const here = macro[cell * 4];
        const un = j < ny - 1 ? macro[(cell + nx) * 4] : -here;
        const us = j > 0 ? macro[(cell - nx) * 4] : -here;
        const rhs = ddx + this.col(i, 0) * (un - us) / 2;
        const next = (phi[j * nx + iw] + phi[j * nx + ie] + this.phiAcross(i, j, 1) + this.phiAcross(i, j, -1) - rhs) / 4;
        phi[cell] += om * (next - phi[cell]);
      }
    }
  }

  private reduce(): void {
    const { nx, ny, macro, phi, state, config: c } = this;
    const mean = new Float64Array(nx);
    for (let i = 1; i < nx - 1; i++) {
      const shape = this.col(i, 0);
      const nl = c.lorentz * shape;
      const drag = c.dragUniform + this.col(i, 1) + nl * shape;
      let sum = 0;
      for (let j = 0; j < ny; j++) {
        const dpy = (this.phiAcross(i, j, 1) - this.phiAcross(i, j, -1)) / 2;
        sum += nl * dpy - drag * macro[(j * nx + i) * 4];
      }
      mean[i] = sum / ny;
    }
    for (let k = 0; k < c.segments; k++) {
      const v = state[nx + k];
      let current = 0;
      let cells = 0;
      for (let i = 0; i < nx; i++) {
        if (this.col(i, 2) !== k) continue;
        cells++;
        // Into the top electrode and out of the bottom one: −∂φ/∂z over the half cell to each wall.
        current += (phi[(ny - 1) * nx + i] - v / 2) + (-v / 2 - phi[i]);
      }
      const r = c.segLoad[k];
      state[nx + k] = v + (c.circuitGain * (r * current - v)) / (1 + r * cells);
      state[nx + MHD_SLICE_MAX_SEGMENTS + k] = current;
    }
    for (let i = 0; i < nx; i++) state[i] = mean[i];
  }

  /**
   * The current's stream function, into the moments' spare component (the
   * WGSL `streamFunction`): on the bottom wall, the current that has entered
   * through it so far; up each column, the current along the flow.
   */
  streamFunction(): void {
    const { nx, ny, macro, phi, state } = this;
    const wall = (i: number): number => {
      const seg = this.col(i, 2);
      return seg >= 0 ? 2 * (-0.5 * state[nx + seg] - phi[i]) : 0;
    };
    let entered = 0;
    for (let i = 0; i < nx; i++) {
      const here = wall(i);
      let psi = -(entered + 0.5 * here);
      entered += here;
      const iw = Math.max(i - 1, 0);
      const ie = Math.min(i + 1, nx - 1);
      let last = 0;
      for (let j = 0; j < ny; j++) {
        const jx = -(phi[j * nx + ie] - phi[j * nx + iw]) / (ie - iw) - macro[(j * nx + i) * 4 + 1] * this.col(i, 0);
        psi += 0.5 * (last + jx);
        last = jx;
        macro[(j * nx + i) * 4 + 3] = psi;
      }
    }
  }

  /** Σ of every distribution: the mass on the lattice. */
  mass(): number {
    let m = 0;
    for (let k = 0; k < this.f.length; k++) m += this.f[k];
    return m;
  }

  /** ux down one column, bottom wall to top. */
  profile(column: number): Float64Array {
    const out = new Float64Array(this.ny);
    for (let j = 0; j < this.ny; j++) out[j] = this.macro[(j * this.nx + column) * 4];
    return out;
  }

  /** Voltage between each electrode pair, lattice units. */
  voltages(): number[] {
    return Array.from(this.state.subarray(this.nx, this.nx + this.config.segments));
  }

  /** Current through each electrode pair, in the solver's sum (× `MhdSliceUnits.amps`). */
  currents(): number[] {
    const at = this.nx + MHD_SLICE_MAX_SEGMENTS;
    return Array.from(this.state.subarray(at, at + this.config.segments));
  }
}

/** D2Q9 equilibrium to second order in the velocity. */
export function equilibrium(q: number, rho: number, u: number, v: number): number {
  const cu = CX[q] * u + CY[q] * v;
  return W[q] * rho * (1 + 3 * cu + 4.5 * cu * cu - 1.5 * (u * u + v * v));
}
