/**
 * MLS-MPM liquid step on the CPU — the reference the WGSL passes are checked
 * against (scripts/tests/gpu/golden-mpm.test.mjs) and the place the method is
 * tested without a GPU (scripts/tests/mpm.test.mjs). Same buffers, same
 * layouts, same fixed-point scatter as passes/mpm-p2g.wgsl, mpm-grid.wgsl and
 * mpm-g2p.wgsl; it evaluates in double and rounds on store, where a GPU works
 * in f32 and may fuse multiply-adds, so the two agree to a tolerance, not to
 * the bit.
 *
 * Not used by the app at run time: the WebGL2 fallback has no liquid solver
 * (docs/FLUIDS.md) and this is far too slow to stand in for one.
 */
import {
  MPM_BOUNDARY_FLOATS, MPM_GRID_CHANNELS, MPM_J_MAX, MPM_MAX_SINKS, MPM_P, MPM_PARTICLE_FLOATS, MPM_PROBE_MASS_SCALE, MPM_T_MAX,
  mpmDerived, mpmDither, mpmEmitParticle, mpmFieldAt, mpmFixedScales, mpmHash32, mpmSeedBits, mpmSeedNext, roundTiesEven,
  validateMpmConfig,
  type MpmConductor, type MpmConfig, type MpmEmitter, type MpmSink
} from './mpm-params.js';
import { sampleMpmBoundary } from './mpm-boundary.js';

export interface MpmCpuOptions {
  /**
   * false accumulates the grid in doubles with no rounding — what the scatter
   * would be with float atomics. Only for measuring what the fixed point costs.
   */
  fixedPoint?: boolean;
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

export class MpmCpu {
  config: MpmConfig;
  /** MPM_PARTICLE_FLOATS per record — the GPU particle buffer, byte for byte. */
  readonly particles: Float32Array;
  /** The same bytes as u32, for the one integer word (`MPM_P.seed`). */
  readonly particleBits: Uint32Array;
  /** Mass and momentum per node, fixed point (the GPU's atomic grid). */
  readonly gridFixed: Int32Array;
  /** Same sums before rounding; only filled when `fixedPoint` is false. */
  readonly gridExact: Float64Array;
  /** Velocity (m/s) and mass (particle masses) per node — the GPU's float grid. */
  readonly gridVel: Float32Array;
  count = 0;
  steps = 0;
  readonly fixedPoint: boolean;
  /** Signed-distance field on the nodes (mpm-boundary.ts), or null for the bare box. */
  boundary: Float32Array | null = null;
  /** Particles released by `emit` / removed by sinks since creation. */
  emitted = 0;
  sunk = 0;
  /** `sunk` by sink slot. */
  readonly sunkBy: number[] = new Array<number>(MPM_MAX_SINKS).fill(0);
  /** Conductors charged particles feel (passes/mpm-g2p.wgsl `fieldAt`). */
  conductors: readonly MpmConductor[] = [];

  constructor(config: MpmConfig, options: MpmCpuOptions = {}) {
    const errors = validateMpmConfig(config);
    if (errors.length) throw new Error(`MpmCpu: ${errors.join('; ')}`);
    this.config = config;
    this.fixedPoint = options.fixedPoint ?? true;
    const nodes = mpmDerived(config).nodes;
    this.particles = new Float32Array(config.maxParticles * MPM_PARTICLE_FLOATS);
    this.particleBits = new Uint32Array(this.particles.buffer);
    this.gridFixed = new Int32Array(nodes * MPM_GRID_CHANNELS);
    this.gridExact = new Float64Array(this.fixedPoint ? 0 : nodes * MPM_GRID_CHANNELS);
    this.gridVel = new Float32Array(nodes * 4);
  }

  /** Replace the particle set (records as mpm-seed.ts writes them). */
  setParticles(records: Float32Array): void {
    const n = records.length / MPM_PARTICLE_FLOATS;
    if (!Number.isInteger(n) || n > this.config.maxParticles) throw new Error(`MpmCpu: ${n} particles exceed the budget ${this.config.maxParticles}`);
    this.particles.fill(0);
    // Byte copy: the seed word is an integer and must not pass through a float.
    new Uint8Array(this.particles.buffer).set(new Uint8Array(records.buffer, records.byteOffset, records.byteLength));
    this.count = n;
  }

  /** Solids as a baked signed-distance field (`bakeMpmBoundary`); null removes them. */
  setBoundary(field: Float32Array | null): void {
    if (field && field.length !== mpmDerived(this.config).nodes * MPM_BOUNDARY_FLOATS) throw new Error('MpmCpu: boundary field does not match the grid');
    this.boundary = field;
  }

  /**
   * passes/mpm-emit.wgsl, once per frame before the substeps: sinks empty the
   * slots of the liquid inside them, and empty slots take the frame's new
   * particles. The GPU hands tickets to empty slots in whatever order it runs
   * them; this takes them in slot order. The particles made are the same set.
   */
  emit(io: { emitters: readonly MpmEmitter[]; counts: readonly number[]; seconds: number; baseId: number; sinks: readonly MpmSink[] }): void {
    const P = this.particles;
    const total = io.counts.reduce((a, n) => a + n, 0);
    const bases: number[] = [];
    let base = io.baseId >>> 0;
    for (const n of io.counts) {
      bases.push(base);
      base = (base + n) >>> 0;
    }
    this.count = this.config.maxParticles;
    let ticket = 0;
    for (let p = 0; p < this.count; p++) {
      const o = p * MPM_PARTICLE_FLOATS;
      if (P[o + MPM_P.state] !== 0) {
        for (const s of io.sinks) {
          if (P[o] >= s.min[0] && P[o] <= s.max[0] && P[o + 1] >= s.min[1] && P[o + 1] <= s.max[1] && P[o + 2] >= s.min[2] && P[o + 2] <= s.max[2]) {
            P[o + MPM_P.state] = 0;
            this.sunk++;
            this.sunkBy[io.sinks.indexOf(s)]++;
            break;
          }
        }
        continue;
      }
      if (ticket >= total) continue;
      let e = 0;
      let local = ticket;
      while (local >= io.counts[e]) local -= io.counts[e++];
      const id = (bases[e] + local) >>> 0;
      const made = mpmEmitParticle(io.emitters[e], id, local, io.counts[e], io.emitters[e].speedMS * io.seconds);
      P.fill(0, o, o + MPM_PARTICLE_FLOATS);
      P[o] = made.pos[0]; P[o + 1] = made.pos[1]; P[o + 2] = made.pos[2];
      P[o + MPM_P.j] = 1;
      P[o + 4] = made.vel[0]; P[o + 5] = made.vel[1]; P[o + 6] = made.vel[2];
      P[o + MPM_P.state] = 1;
      P[o + MPM_P.charge] = io.emitters[e].chargeC ?? 0;
      this.particleBits[o + MPM_P.seed] = mpmHash32(id);
      this.emitted++;
      ticket++;
    }
  }

  step(n = 1): void {
    for (let i = 0; i < n; i++) {
      this.p2g();
      this.gridUpdate();
      this.g2p();
      this.steps++;
    }
  }

  /** passes/mpm-p2g.wgsl. */
  p2g(): void {
    const c = this.config;
    const P = this.particles;
    const [nx, ny] = c.gridN;
    const h = c.cellM;
    const { massScale, momentumScale } = mpmFixedScales(c.maxParticles);
    const fixed = this.fixedPoint;
    const G = this.gridFixed;
    const E = this.gridExact;
    if (fixed) G.fill(0);
    else E.fill(0);
    const invSpeed = 1 / c.maxSpeedMS;
    const minJ = 1 / c.maxDensityRatio;
    const affineK = h * invSpeed;
    const wx = [0, 0, 0];
    const wy = [0, 0, 0];
    const wz = [0, 0, 0];
    const r = [0, 0, 0];
    for (let p = 0; p < this.count; p++) {
      const o = p * MPM_PARTICLE_FLOATS;
      if (P[o + MPM_P.state] === 0) continue;
      const gx = P[o] / h;
      const gy = P[o + 1] / h;
      const gz = P[o + 2] / h;
      const bx = clamp(Math.floor(gx - 0.5), 0, nx - 3);
      const by = clamp(Math.floor(gy - 0.5), 0, ny - 3);
      const bz = clamp(Math.floor(gz - 0.5), 0, c.gridN[2] - 3);
      const fx = gx - bx;
      const fy = gy - by;
      const fz = gz - bz;
      weights(fx, wx);
      weights(fy, wy);
      weights(fz, wz);

      const j = clamp(P[o + MPM_P.j], minJ, MPM_J_MAX);
      const pressure = Math.max(0, c.eosStiffnessPa * (j ** -c.eosGamma - 1));
      P[o + MPM_P.pressure] = pressure;
      // C columns: c0 = ∂v/∂x, c1 = ∂v/∂y, c2 = ∂v/∂z.
      const c00 = P[o + 8], c10 = P[o + 9], c20 = P[o + 10];
      const c01 = P[o + 12], c11 = P[o + 13], c21 = P[o + 14];
      const c02 = P[o + 16], c12 = P[o + 17], c22 = P[o + 18];
      // Cauchy stress σ = −p·I + μ·(C + Cᵀ); impulse on a node is
      // −dt·V·(4/h²)·σ·(x_i − x_p)·w. In units of particle mass · maxSpeed
      // and with δ in cells that is stressK·σ·δ·w.
      const stressK = (-4 * c.dt * j) / (c.restDensity * h * c.maxSpeedMS);
      const mu = c.viscosityPaS;
      // A = C·(h/maxSpeed) + stressK·σ, row-major a[row][col].
      const a00 = c00 * affineK + stressK * (2 * mu * c00 - pressure);
      const a01 = c01 * affineK + stressK * mu * (c01 + c10);
      const a02 = c02 * affineK + stressK * mu * (c02 + c20);
      const a10 = c10 * affineK + stressK * mu * (c10 + c01);
      const a11 = c11 * affineK + stressK * (2 * mu * c11 - pressure);
      const a12 = c12 * affineK + stressK * mu * (c12 + c21);
      const a20 = c20 * affineK + stressK * mu * (c20 + c02);
      const a21 = c21 * affineK + stressK * mu * (c21 + c12);
      const a22 = c22 * affineK + stressK * (2 * mu * c22 - pressure);
      const ux = P[o + 4] * invSpeed;
      const uy = P[o + 5] * invSpeed;
      const uz = P[o + 6] * invSpeed;

      // Carried remainders: mass starts at 0, momentum at the particle's hash.
      let rm = 0;
      mpmDither(mpmSeedBits(this.particleBits[o + MPM_P.seed]), r);
      for (let k = 0; k < 3; k++) {
        const dz = k - fz;
        for (let jj = 0; jj < 3; jj++) {
          const dy = jj - fy;
          const wyz = wy[jj] * wz[k];
          for (let i = 0; i < 3; i++) {
            const dx = i - fx;
            const w = wx[i] * wyz;
            const tx = clamp(ux + a00 * dx + a01 * dy + a02 * dz, -MPM_T_MAX, MPM_T_MAX);
            const ty = clamp(uy + a10 * dx + a11 * dy + a12 * dz, -MPM_T_MAX, MPM_T_MAX);
            const tz = clamp(uz + a20 * dx + a21 * dy + a22 * dz, -MPM_T_MAX, MPM_T_MAX);
            const n = (((bz + k) * ny + by + jj) * nx + bx + i) * MPM_GRID_CHANNELS;
            if (fixed) {
              const xm = w * massScale + rm;
              const qm = roundTiesEven(xm);
              rm = xm - qm;
              const x0 = w * tx * momentumScale + r[0];
              const q0 = roundTiesEven(x0);
              r[0] = x0 - q0;
              const x1 = w * ty * momentumScale + r[1];
              const q1 = roundTiesEven(x1);
              r[1] = x1 - q1;
              const x2 = w * tz * momentumScale + r[2];
              const q2 = roundTiesEven(x2);
              r[2] = x2 - q2;
              G[n] += qm;
              G[n + 1] += q0;
              G[n + 2] += q1;
              G[n + 3] += q2;
            } else {
              E[n] += w * massScale;
              E[n + 1] += w * tx * momentumScale;
              E[n + 2] += w * ty * momentumScale;
              E[n + 3] += w * tz * momentumScale;
            }
          }
        }
      }
    }
  }

  /** passes/mpm-grid.wgsl. */
  gridUpdate(): void {
    const c = this.config;
    const [nx, ny, nz] = c.gridN;
    const { massScale, momentumScale } = mpmFixedScales(c.maxParticles);
    const G: ArrayLike<number> = this.fixedPoint ? this.gridFixed : this.gridExact;
    const V = this.gridVel;
    const vmax = c.maxSpeedMS;
    const toVel = (vmax * massScale) / momentumScale;
    const gdt = [c.gravity[0] * c.dt, c.gravity[1] * c.dt, c.gravity[2] * c.dt];
    const B = this.boundary;
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const n = (z * ny + y) * nx + x;
          const m = G[n * 4];
          let vx = 0, vy = 0, vz = 0, mass = 0;
          if (m > 0) {
            mass = m / massScale;
            const k = toVel / m;
            vx = G[n * 4 + 1] * k + gdt[0];
            vy = G[n * 4 + 2] * k + gdt[1];
            vz = G[n * 4 + 3] * k + gdt[2];
            // Wall nodes: nothing flows into the wall, tangential motion is free.
            if (x <= 1 && vx < 0) vx = 0;
            if (x >= nx - 2 && vx > 0) vx = 0;
            if (y <= 1 && vy < 0) vy = 0;
            if (y >= ny - 2 && vy > 0) vy = 0;
            if (z <= 1 && vz < 0) vz = 0;
            if (z >= nz - 2 && vz > 0) vz = 0;
            // A node inside a solid: no velocity into it.
            if (B && B[n * 4 + 3] < 0) {
              const vn = Math.min(vx * B[n * 4] + vy * B[n * 4 + 1] + vz * B[n * 4 + 2], 0);
              vx -= B[n * 4] * vn;
              vy -= B[n * 4 + 1] * vn;
              vz -= B[n * 4 + 2] * vn;
            }
            vx = clamp(vx, -vmax, vmax);
            vy = clamp(vy, -vmax, vmax);
            vz = clamp(vz, -vmax, vmax);
          }
          V[n * 4] = vx;
          V[n * 4 + 1] = vy;
          V[n * 4 + 2] = vz;
          V[n * 4 + 3] = mass;
        }
      }
    }
  }

  /** passes/mpm-g2p.wgsl. */
  g2p(): void {
    const c = this.config;
    const P = this.particles;
    const V = this.gridVel;
    const [nx, ny, nz] = c.gridN;
    const h = c.cellM;
    const minJ = 1 / c.maxDensityRatio;
    const lo = h;
    const hiX = (nx - 2) * h, hiY = (ny - 2) * h, hiZ = (nz - 2) * h;
    const wx = [0, 0, 0];
    const wy = [0, 0, 0];
    const wz = [0, 0, 0];
    const k4 = 4 / h;
    const sdf = [0, 0, 0, 0];
    const field = [0, 0, 0];
    const particleMass = mpmDerived(c).particleMass;
    for (let p = 0; p < this.count; p++) {
      const o = p * MPM_PARTICLE_FLOATS;
      if (P[o + MPM_P.state] === 0) continue;
      const gx = P[o] / h;
      const gy = P[o + 1] / h;
      const gz = P[o + 2] / h;
      const bx = clamp(Math.floor(gx - 0.5), 0, nx - 3);
      const by = clamp(Math.floor(gy - 0.5), 0, ny - 3);
      const bz = clamp(Math.floor(gz - 0.5), 0, nz - 3);
      const fx = gx - bx;
      const fy = gy - by;
      const fz = gz - bz;
      weights(fx, wx);
      weights(fy, wy);
      weights(fz, wz);
      let vx = 0, vy = 0, vz = 0;
      let b00 = 0, b01 = 0, b02 = 0, b10 = 0, b11 = 0, b12 = 0, b20 = 0, b21 = 0, b22 = 0;
      for (let k = 0; k < 3; k++) {
        const dz = k - fz;
        for (let jj = 0; jj < 3; jj++) {
          const dy = jj - fy;
          const wyz = wy[jj] * wz[k];
          for (let i = 0; i < 3; i++) {
            const dx = i - fx;
            const w = wx[i] * wyz;
            const n = (((bz + k) * ny + by + jj) * nx + bx + i) * 4;
            const gvx = V[n] * w, gvy = V[n + 1] * w, gvz = V[n + 2] * w;
            vx += gvx; vy += gvy; vz += gvz;
            b00 += gvx * dx; b01 += gvx * dy; b02 += gvx * dz;
            b10 += gvy * dx; b11 += gvy * dy; b12 += gvy * dz;
            b20 += gvz * dx; b21 += gvz * dy; b22 += gvz * dz;
          }
        }
      }
      // C = (4/h)·Σ w·v⊗δ, stored by column.
      P[o + 8] = b00 * k4; P[o + 9] = b10 * k4; P[o + 10] = b20 * k4;
      P[o + 12] = b01 * k4; P[o + 13] = b11 * k4; P[o + 14] = b21 * k4;
      P[o + 16] = b02 * k4; P[o + 17] = b12 * k4; P[o + 18] = b22 * k4;
      // dJ/dt = J·div v, integrated exactly over the step for a constant divergence.
      const div = (b00 + b11 + b22) * k4;
      P[o + MPM_P.j] = clamp(P[o + MPM_P.j] * Math.exp(c.dt * div), minJ, MPM_J_MAX);
      this.particleBits[o + MPM_P.seed] = mpmSeedNext(this.particleBits[o + MPM_P.seed]);
      const charge = P[o + MPM_P.charge];
      if (charge !== 0 && this.conductors.length > 0) {
        // q·E/m, as the shader adds it: after the gather, before the move.
        mpmFieldAt(this.conductors, P[o], P[o + 1], P[o + 2], field);
        const k = (charge / particleMass) * c.dt;
        vx = clamp(vx + field[0] * k, -c.maxSpeedMS, c.maxSpeedMS);
        vy = clamp(vy + field[1] * k, -c.maxSpeedMS, c.maxSpeedMS);
        vz = clamp(vz + field[2] * k, -c.maxSpeedMS, c.maxSpeedMS);
      }
      P[o + 4] = vx; P[o + 5] = vy; P[o + 6] = vz;
      let px = P[o] + vx * c.dt;
      let py = P[o + 1] + vy * c.dt;
      let pz = P[o + 2] + vz * c.dt;
      if (this.boundary) {
        // Ended the step inside a solid: back to its surface, along the normal.
        sampleMpmBoundary(c, this.boundary, px, py, pz, sdf);
        const len = Math.hypot(sdf[0], sdf[1], sdf[2]);
        if (sdf[3] < 0 && len > 1e-6) {
          const k = sdf[3] / len;
          px -= sdf[0] * k;
          py -= sdf[1] * k;
          pz -= sdf[2] * k;
        }
      }
      P[o] = clamp(px, lo, hiX);
      P[o + 1] = clamp(py, lo, hiY);
      P[o + 2] = clamp(pz, lo, hiZ);
    }
  }
}

/** Quadratic B-spline weights of the three nodes at offsets 0, 1, 2 from the stencil base. */
function weights(f: number, out: number[]): void {
  const a = 1.5 - f;
  const b = f - 1;
  const d = f - 0.5;
  out[0] = 0.5 * a * a;
  out[1] = 0.75 - b * b;
  out[2] = 0.5 * d * d;
}

export interface MpmTotals {
  /** Live particles. */
  count: number;
  /** kg. */
  mass: number;
  /** kg·m/s. */
  momentum: [number, number, number];
  /** J. */
  kinetic: number;
  /** Σ J·V₀, m³ — the liquid's own account of its volume. */
  volume: number;
  /** Mass-weighted mean position, m. */
  centre: [number, number, number];
  maxSpeed: number;
  finite: boolean;
}

/** Totals over a particle buffer (CPU or a GPU read-back). */
export function mpmTotals(config: MpmConfig, particles: Float32Array, count: number): MpmTotals {
  const d = mpmDerived(config);
  const t: MpmTotals = { count: 0, mass: 0, momentum: [0, 0, 0], kinetic: 0, volume: 0, centre: [0, 0, 0], maxSpeed: 0, finite: true };
  for (let p = 0; p < count; p++) {
    const o = p * MPM_PARTICLE_FLOATS;
    if (particles[o + MPM_P.state] === 0) continue;
    const vx = particles[o + 4], vy = particles[o + 5], vz = particles[o + 6];
    const v2 = vx * vx + vy * vy + vz * vz;
    for (let k = 0; k < MPM_PARTICLE_FLOATS; k++) if (k !== MPM_P.seed && !Number.isFinite(particles[o + k])) t.finite = false;
    t.count++;
    t.momentum[0] += vx; t.momentum[1] += vy; t.momentum[2] += vz;
    t.kinetic += v2;
    t.volume += particles[o + MPM_P.j];
    t.centre[0] += particles[o]; t.centre[1] += particles[o + 1]; t.centre[2] += particles[o + 2];
    t.maxSpeed = Math.max(t.maxSpeed, Math.sqrt(v2));
  }
  t.mass = t.count * d.particleMass;
  for (let a = 0; a < 3; a++) {
    t.momentum[a] *= d.particleMass;
    t.centre[a] /= Math.max(1, t.count);
  }
  t.kinetic *= 0.5 * d.particleMass;
  t.volume *= d.particleVolume;
  return t;
}

/**
 * Grid mass at a position over the rest mass of a node — `densityRatio` in
 * mpm-export.wgsl, which uses it to tell spray from liquid. `gridVel` is the
 * velocity grid (velocity xyz, mass in particle masses).
 */
export function mpmDensityRatio(config: MpmConfig, gridVel: Float32Array, pos: readonly [number, number, number]): number {
  const F = Math.fround;
  const [nx, ny, nz] = config.gridN;
  const h = F(config.cellM);
  const base = [0, 0, 0];
  const w: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const n = [nx, ny, nz];
  for (let a = 0; a < 3; a++) {
    const g = F(F(pos[a]) / h);
    base[a] = Math.min(Math.max(Math.floor(F(g - 0.5)), 0), n[a] - 3);
    const f = F(g - base[a]);
    const x0 = F(1.5 - f), x1 = F(f - 1), x2 = F(f - 0.5);
    w[0][a] = F(0.5 * x0 * x0);
    w[1][a] = F(0.75 - x1 * x1);
    w[2][a] = F(0.5 * x2 * x2);
  }
  let mass = 0;
  for (let k = 0; k < 3; k++) {
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 3; i++) {
        const node = ((base[2] + k) * ny + base[1] + j) * nx + base[0] + i;
        mass = F(mass + F(F(F(w[i][0] * w[j][1]) * w[k][2]) * gridVel[node * 4 + 3]));
      }
    }
  }
  const d = mpmDerived(config);
  return mass / F(F(F(F(config.restDensity * h) * h) * h) / F(d.particleMass));
}

/** The probe's layer masses from a velocity grid (velocity xyz, mass) — the CPU twin of mpm-probe.wgsl. */
export function mpmLayerProfile(config: MpmConfig, gridVel: Float32Array): Float32Array {
  const [nx, ny, nz] = config.gridN;
  const out = new Float32Array(ny);
  for (let y = 0; y < ny; y++) {
    let mass = 0;
    for (let z = 0; z < nz; z++) {
      const row = (z * ny + y) * nx;
      for (let x = 0; x < nx; x++) mass += gridVel[(row + x) * 4 + 3];
    }
    out[y] = roundTiesEven(mass * MPM_PROBE_MASS_SCALE) / MPM_PROBE_MASS_SCALE;
  }
  return out;
}

export { mpmProfileTop, mpmProfileMass, type MpmProfile } from './mpm-params.js';
