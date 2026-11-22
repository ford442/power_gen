/**
 * MLS-MPM liquid solver — parameters, layouts and the numbers both sides agree
 * on (ADR-0022). No GPU and no DOM here: the WebGPU host (mpm-solver.ts), the
 * CPU reference (mpm-cpu.ts) and the tests all read this file.
 *
 * Units are SI throughout: metres, seconds, kilograms, pascals. Positions are
 * domain-local, the domain being the box [0, gridN·cellM]. A bench places that
 * box in its scene with its own metres-per-scene-unit scale.
 *
 * One substep is a buffer clear and three passes:
 *
 *   clear        fixed-point grid ← 0
 *   p2g          particle → grid: mass, APIC momentum and the stress impulse
 *   gridUpdate   momentum / mass → velocity, + gravity, walls
 *   g2p          grid → particle velocity and affine matrix, advect, update J
 *
 * Each particle carries J = V/V₀, its own volume ratio, advanced from the
 * velocity divergence it sees. Pressure is Tait's equation in J. Density is
 * therefore not gathered from neighbours, so a jet two cells wide or a lone
 * droplet keeps its volume instead of reading as "under-dense" and collapsing.
 *
 * P2G is a scatter, and WGSL has no float atomics, so grid mass and momentum
 * are accumulated as fixed-point `atomic<i32>`:
 *
 *   mass      w · massScale                                in particle masses
 *   momentum  w · t · momentumScale                        in particle mass · maxSpeed
 *             t = clamp(v/maxSpeed + A·δ, ±MPM_T_MAX)      (velocity + affine + stress)
 *
 * Plain rounding of each of the 27 contributions would have a dead zone: a
 * particle moving slower than about maxSpeed/momentumScale would round to
 * nothing on every node and lose its momentum each step (measured: a settling
 * column creeps, and reads 3 % under hydrostatic). So a particle rounds its
 * 27 contributions in sequence and carries the remainder from one node to the
 * next (error diffusion), starting each momentum channel from a hashed
 * remainder in [−½, ½). The expected value of every contribution is then
 * exact, however small, and a particle's total is off by less than one count.
 * The hash comes from a counter the particle carries (`seed`), so it is the
 * same on every run and on the CPU reference.
 *
 * Integer sums are order-independent, so the scatter is bit-deterministic
 * whatever order the GPU runs the particles in. The scales come from the
 * particle budget (`mpmFixedScales`): with every particle of the budget
 * sitting on one grid node, the sums still fit an i32. There is no branch and
 * nothing to saturate.
 */

/** Floats per particle (common/mpm.wgsl `MpmParticle`). */
export const MPM_PARTICLE_FLOATS = 20;
export const MPM_PARTICLE_BYTES = MPM_PARTICLE_FLOATS * 4;
/**
 * Word offsets in a particle record: position (m), J, velocity (m/s), state
 * (0 = empty slot, 1 = liquid), the three columns of the affine matrix C (1/s),
 * the pressure P2G last computed for it (Pa, diagnostic), and `seed` — a u32
 * counter, the only word that is not a float.
 */
export const MPM_P = Object.freeze({ pos: 0, j: 3, vel: 4, state: 7, c0: 8, pressure: 11, c1: 12, seed: 15, c2: 16 });

/** Fixed-point channels per grid node: mass, momentum x / y / z. */
export const MPM_GRID_CHANNELS = 4;
/** Largest quadratic B-spline weight a particle gives one node: 0.75³, particle on the node. */
export const MPM_W_MAX = 0.421875;
/** Clamp on each component of a particle's momentum transfer, in units of maxSpeed. */
export const MPM_T_MAX = 2;
/** Ceiling on massScale: leaves an f32 five fraction bits under w·scale for the carried remainder. */
export const MPM_MASS_SCALE_MAX = 1048576;
/** J is clamped below 1/maxDensityRatio and above this. */
export const MPM_J_MAX = 1e4;

/** Uniform block size (common/mpm.wgsl `MpmParams`), bytes. */
export const MPM_PARAMS_BYTES = 96;
/** `MpmParams.flags` bit: the boundary buffer holds a signed-distance field. */
export const MPM_FLAG_BOUNDARY = 1;
/** Floats per grid node in the boundary buffer: outward normal xyz, signed distance (m, negative inside a solid). */
export const MPM_BOUNDARY_FLOATS = 4;

export interface MpmConfig {
  /** Grid nodes per axis. */
  gridN: readonly [number, number, number];
  /** Cell size h, m. */
  cellM: number;
  /** Substep, s. */
  dt: number;
  /** Particle budget: buffer capacity, and what the fixed-point scales are sized for. */
  maxParticles: number;
  /** Rest density ρ₀, kg/m³. */
  restDensity: number;
  /** Particles per cell at rest density — sets the particle mass. */
  particlesPerCell: number;
  /** Tait stiffness B, Pa: p = B·(J^−γ − 1), clamped at 0 (a liquid surface carries no tension here). */
  eosStiffnessPa: number;
  /** Tait exponent γ. */
  eosGamma: number;
  /** Dynamic viscosity μ, Pa·s. */
  viscosityPaS: number;
  /** Gravity, m/s². */
  gravity: readonly [number, number, number];
  /** Compression is capped at this density ratio (J ≥ 1/ratio): a pressure ceiling. */
  maxDensityRatio: number;
  /**
   * Fastest the liquid may move, m/s. Grid velocities are clamped to it and
   * the fixed-point momentum is scaled to it, so a lower value buys finer
   * momentum resolution. At most cellM/dt (one cell per substep).
   */
  maxSpeedMS: number;
}

export interface MpmDerived {
  nodes: number;
  /** kg per particle: ρ₀·h³ / particlesPerCell. */
  particleMass: number;
  /** Rest volume per particle V₀, m³. */
  particleVolume: number;
  /** Numerical sound speed at rest √(γ·B/ρ₀), m/s. */
  soundSpeed: number;
  /** soundSpeed·dt / h. */
  courantSound: number;
  /** maxSpeed·dt / h — cells per substep at the speed limit. */
  courantFlow: number;
}

export function mpmDerived(c: MpmConfig): MpmDerived {
  const soundSpeed = Math.sqrt((c.eosGamma * c.eosStiffnessPa) / c.restDensity);
  const particleVolume = c.cellM ** 3 / c.particlesPerCell;
  return {
    nodes: c.gridN[0] * c.gridN[1] * c.gridN[2],
    particleMass: c.restDensity * particleVolume,
    particleVolume,
    soundSpeed,
    courantSound: (soundSpeed * c.dt) / c.cellM,
    courantFlow: (c.maxSpeedMS * c.dt) / c.cellM
  };
}

export interface MpmFixedScales {
  /** Counts per unit weight in the mass channel. */
  massScale: number;
  /** Counts per unit of weight · (particle mass · maxSpeed) in a momentum channel. */
  momentumScale: number;
}

/**
 * Fixed-point scales for a particle budget. Worst case is every particle on
 * one node: N contributions of at most MPM_W_MAX·massScale + 1 each (½ for
 * the rounding, ½ for the carried remainder). The 1e-4 margin covers f32
 * evaluation of the weight. A momentum contribution is at most MPM_T_MAX
 * times a mass one, hence the ratio. Both channels then stay inside
 * ±(2³¹ − 1) by arithmetic.
 */
export function mpmFixedScales(maxParticles: number): MpmFixedScales {
  const n = Math.max(1, Math.ceil(maxParticles));
  const bound = Math.floor((0.9999 * (2147483647 - n)) / (n * MPM_W_MAX));
  const massScale = Math.max(MPM_T_MAX, Math.min(MPM_MASS_SCALE_MAX, bound));
  return { massScale, momentumScale: massScale / MPM_T_MAX };
}

/** Largest |sum| a grid channel can reach for this budget — the overflow argument, as a number. */
export function mpmWorstCaseSum(maxParticles: number): number {
  const { massScale } = mpmFixedScales(maxParticles);
  return maxParticles * (MPM_W_MAX * 1.0001 * massScale + 1);
}

/** Largest sound Courant number the explicit step is run at. */
export const MPM_MAX_COURANT = 0.5;

/**
 * Tait stiffness that puts the sound Courant number at `courant` for this
 * cell and step: the stiffest (least compressible) liquid the step can carry.
 */
export function mpmStiffnessForCourant(cellM: number, dt: number, restDensity: number, gamma: number, courant = MPM_MAX_COURANT): number {
  const c = (courant * cellM) / dt;
  return (restDensity * c * c) / gamma;
}

/** Tait pressure at a volume ratio, Pa; never negative. */
export function mpmPressure(c: MpmConfig, j: number): number {
  const jc = Math.min(Math.max(j, 1 / c.maxDensityRatio), MPM_J_MAX);
  return Math.max(0, c.eosStiffnessPa * (jc ** -c.eosGamma - 1));
}

/**
 * How much a column `heightM` deep compresses at its base under gravity:
 * ρ/ρ₀ − 1 from the Tait equation at p = ρ₀·g·H. The honest cost of "weakly
 * compressible" at a given step size.
 */
export function mpmColumnCompression(c: MpmConfig, heightM: number): number {
  const g = Math.hypot(c.gravity[0], c.gravity[1], c.gravity[2]);
  return (1 + (c.restDensity * g * heightM) / c.eosStiffnessPa) ** (1 / c.eosGamma) - 1;
}

/**
 * The liquid's box. Nodes 0, 1 and n−2, n−1 on each axis are wall nodes (no
 * velocity into the wall); the wall planes are at node 1 and node n−2, which
 * keeps every particle's 3×3×3 stencil on the grid.
 */
export function mpmBounds(c: MpmConfig): { min: [number, number, number]; max: [number, number, number] } {
  const h = c.cellM;
  return { min: [h, h, h], max: [(c.gridN[0] - 2) * h, (c.gridN[1] - 2) * h, (c.gridN[2] - 2) * h] };
}

/** Water at a cell size and step: Tait γ = 7 at the stability limit, SI gravity. */
export function mpmWaterConfig(
  gridN: readonly [number, number, number],
  cellM: number,
  dt: number,
  maxParticles: number,
  overrides: Partial<MpmConfig> = {}
): MpmConfig {
  const restDensity = overrides.restDensity ?? 1000;
  const eosGamma = overrides.eosGamma ?? 7;
  return {
    gridN,
    cellM,
    dt,
    maxParticles,
    restDensity,
    particlesPerCell: 8,
    eosStiffnessPa: mpmStiffnessForCourant(cellM, dt, restDensity, eosGamma),
    eosGamma,
    viscosityPaS: 1e-3,
    gravity: [0, -9.80665, 0],
    maxDensityRatio: 1.25,
    maxSpeedMS: (0.5 * cellM) / dt,
    ...overrides
  };
}

/** Why a configuration cannot be stepped, or [] when it can. */
export function validateMpmConfig(c: MpmConfig): string[] {
  const errors: string[] = [];
  const d = mpmDerived(c);
  if (!c.gridN.every((n) => Number.isInteger(n) && n >= 6)) errors.push(`gridN ${c.gridN.join('×')}: each axis needs at least 6 nodes`);
  if (!(c.cellM > 0) || !(c.dt > 0)) errors.push('cellM and dt must be positive');
  if (!(Number.isInteger(c.maxParticles) && c.maxParticles >= 1)) errors.push('maxParticles must be a positive integer');
  if (!(c.particlesPerCell >= 1)) errors.push('particlesPerCell must be ≥ 1');
  if (!(c.maxDensityRatio > 1)) errors.push('maxDensityRatio must be > 1');
  // The speed of sound rises with compression; at the density cap it is this much higher.
  const stiffest = d.courantSound * c.maxDensityRatio ** ((c.eosGamma - 1) / 2);
  if (!(stiffest <= 1)) errors.push(`sound Courant number ${d.courantSound.toFixed(3)} (${stiffest.toFixed(3)} at the density cap) > 1: lower eosStiffnessPa, maxDensityRatio or dt`);
  if (!(c.maxSpeedMS > 0 && d.courantFlow <= 1)) errors.push(`maxSpeedMS ${c.maxSpeedMS} moves ${d.courantFlow.toFixed(3)} cells per substep; the limit is 1`);
  // The viscous term is explicit: ν·dt/h² must stay well under 1/6 in 3-D.
  const visc = ((c.viscosityPaS / c.restDensity) * c.dt) / (c.cellM * c.cellM);
  if (!(visc <= 0.1)) errors.push(`viscous number ν·dt/h² = ${visc.toFixed(3)} > 0.1: lower viscosityPaS or dt`);
  return errors;
}

/**
 * Pack `MpmParams` (common/mpm.wgsl). `particleCount` is how many records the
 * passes visit; a record whose `state` is 0 is skipped. `flags` is
 * MPM_FLAG_BOUNDARY when a signed-distance field is bound.
 */
export function packMpmParams(
  c: MpmConfig,
  particleCount: number,
  out: ArrayBuffer = new ArrayBuffer(MPM_PARAMS_BYTES),
  flags = 0
): ArrayBuffer {
  const d = mpmDerived(c);
  const s = mpmFixedScales(c.maxParticles);
  const u = new Uint32Array(out);
  const f = new Float32Array(out);
  u[0] = c.gridN[0];
  u[1] = c.gridN[1];
  u[2] = c.gridN[2];
  u[3] = Math.min(particleCount, c.maxParticles);
  f[4] = c.cellM;
  f[5] = c.dt;
  f[6] = c.restDensity;
  f[7] = d.particleMass;
  f[8] = c.eosStiffnessPa;
  f[9] = c.eosGamma;
  f[10] = c.viscosityPaS;
  f[11] = 1 / c.maxDensityRatio;
  f[12] = c.gravity[0];
  f[13] = c.gravity[1];
  f[14] = c.gravity[2];
  f[15] = c.maxSpeedMS;
  f[16] = s.massScale;
  f[17] = s.momentumScale;
  f[18] = MPM_J_MAX;
  f[19] = MPM_T_MAX;
  u[20] = flags;
  u[21] = 0;
  u[22] = 0;
  u[23] = 0;
  return out;
}

/** round-half-to-even, as WGSL `round` does. Valid for |x| < 2⁵¹ (adding 1.5·2⁵² leaves no fraction bits). */
export function roundTiesEven(x: number): number {
  return x + 6755399441055744 - 6755399441055744;
}

/** The particle counter's step (a 32-bit LCG); G2P applies it once per substep. */
export function mpmSeedNext(seed: number): number {
  return (Math.imul(seed, 747796405) + 2891336453) >>> 0;
}

/** PCG output permutation of the counter: 32 well-mixed bits per particle per substep. */
export function mpmSeedBits(seed: number): number {
  const word = Math.imul((seed >>> ((seed >>> 28) + 4)) ^ seed, 277803737);
  return ((word >>> 22) ^ word) >>> 0;
}

/** The three starting remainders in [−½, ½) P2G takes from those bits, 10 bits each. */
export function mpmDither(bits: number, out: number[]): void {
  out[0] = ((bits & 1023) + 0.5) / 1024 - 0.5;
  out[1] = (((bits >>> 10) & 1023) + 0.5) / 1024 - 0.5;
  out[2] = (((bits >>> 20) & 1023) + 0.5) / 1024 - 0.5;
}

/** Quality tiers (`fluid=auto|off|low|high`): grid and particle budget. */
export const MPM_TIERS = Object.freeze({
  low: Object.freeze({ gridN: 32, particles: 15000 }),
  default: Object.freeze({ gridN: 64, particles: 40000 }),
  high: Object.freeze({ gridN: 96, particles: 120000 })
});
export type MpmTier = keyof typeof MPM_TIERS;

/** GPU bytes a solver of this size holds: particles + fixed-point grid + velocity grid. */
export function mpmMemoryBytes(gridN: readonly [number, number, number], particles: number): number {
  const nodes = gridN[0] * gridN[1] * gridN[2];
  return particles * MPM_PARTICLE_BYTES + nodes * MPM_GRID_CHANNELS * 4 + nodes * 16;
}

// ---------------------------------------------------------------------------
// Emitters, sinks and the read-back (passes/mpm-emit.wgsl, mpm-probe.wgsl,
// mpm-export.wgsl; layout `mpmIo`).
// ---------------------------------------------------------------------------

export const MPM_MAX_EMITTERS = 2;
export const MPM_MAX_SINKS = 2;
/** Uniform block size (common/mpm.wgsl `MpmIoParams`), bytes. */
export const MPM_IO_PARAMS_BYTES = 192;
/**
 * Words in the counter buffer: [0] this frame's emission tickets (cleared by
 * the host before each emit pass), [1] particles emitted since creation,
 * [2] particles removed by sinks since creation, [3] spare.
 */
export const MPM_COUNTER_WORDS = 4;
export const MPM_COUNTER = Object.freeze({ tickets: 0, emitted: 1, sunk: 2 });
/** Fixed point of the layer masses in the probe buffer: counts per particle mass. */
export const MPM_PROBE_MASS_SCALE = 256;
/** Words the probe appends after the gridN[1] layer masses: emitted, sunk. */
export const MPM_PROBE_EXTRA_WORDS = 2;

/** A round nozzle: particles enter through a disc, at rest density, moving along `direction`. */
export interface MpmEmitter {
  /** Centre of the disc, m, domain-local. */
  centre: readonly [number, number, number];
  /** Unit vector the liquid leaves along. */
  direction: readonly [number, number, number];
  radiusM: number;
  speedMS: number;
  /**
   * Divergence: tangent of the half-angle at the rim. A particle at radius r
   * leaves along direction + radial·spread·r/R. 0 is a parallel jet.
   */
  spread: number;
}

/** An axis-aligned box that removes any liquid inside it. */
export interface MpmSink {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
}

/** Volume flow of an emitter, m³/s: plug flow through the disc. */
export function mpmEmitterFlow(e: MpmEmitter): number {
  return Math.PI * e.radiusM * e.radiusM * e.speedMS;
}

/**
 * How many particles each emitter owes after `seconds` more of simulated
 * time, at rest density. `carry` holds the fractions between frames and is
 * updated in place, so the long-run count is exact.
 */
export function mpmEmitCounts(c: MpmConfig, emitters: readonly MpmEmitter[], seconds: number, carry: number[]): number[] {
  const v0 = mpmDerived(c).particleVolume;
  return emitters.map((e, i) => {
    const owed = (carry[i] ?? 0) + (mpmEmitterFlow(e) * seconds) / v0;
    const n = Math.floor(owed);
    carry[i] = owed - n;
    return n;
  });
}

export interface MpmIoFrame {
  emitters: readonly MpmEmitter[];
  /** Particles each emitter releases this frame (mpmEmitCounts). */
  counts: readonly number[];
  /** Simulated seconds this frame covers: the new liquid fills speed·seconds of jet. */
  seconds: number;
  /** Id of this frame's first new particle; the host adds every count to it afterwards. */
  baseId: number;
  sinks: readonly MpmSink[];
  /** Read-back transform for mpm-export.wgsl: scene position = origin + metres · scale. */
  exportOrigin: readonly [number, number, number];
  exportScale: number;
}

/** Pack `MpmIoParams` (common/mpm.wgsl). */
export function packMpmIoParams(c: MpmConfig, io: MpmIoFrame, out: ArrayBuffer = new ArrayBuffer(MPM_IO_PARAMS_BYTES)): ArrayBuffer {
  if (io.emitters.length > MPM_MAX_EMITTERS) throw new Error(`packMpmIoParams: ${io.emitters.length} emitters, the limit is ${MPM_MAX_EMITTERS}`);
  if (io.sinks.length > MPM_MAX_SINKS) throw new Error(`packMpmIoParams: ${io.sinks.length} sinks, the limit is ${MPM_MAX_SINKS}`);
  const f = new Float32Array(out);
  const u = new Uint32Array(out);
  f.fill(0);
  let base = io.baseId >>> 0;
  for (let i = 0; i < io.emitters.length; i++) {
    const e = io.emitters[i];
    const o = i * 12;
    const len = Math.hypot(e.direction[0], e.direction[1], e.direction[2]) || 1;
    f[o] = e.centre[0];
    f[o + 1] = e.centre[1];
    f[o + 2] = e.centre[2];
    f[o + 3] = e.radiusM;
    f[o + 4] = e.direction[0] / len;
    f[o + 5] = e.direction[1] / len;
    f[o + 6] = e.direction[2] / len;
    f[o + 7] = e.speedMS;
    u[o + 8] = io.counts[i] ?? 0;
    u[o + 9] = base;
    f[o + 10] = e.speedMS * io.seconds;
    f[o + 11] = e.spread;
    base = (base + (io.counts[i] ?? 0)) >>> 0;
  }
  for (let i = 0; i < io.sinks.length; i++) {
    const s = io.sinks[i];
    const o = MPM_MAX_EMITTERS * 12 + i * 8;
    f[o] = s.min[0];
    f[o + 1] = s.min[1];
    f[o + 2] = s.min[2];
    f[o + 3] = 1;
    f[o + 4] = s.max[0];
    f[o + 5] = s.max[1];
    f[o + 6] = s.max[2];
  }
  const o = MPM_MAX_EMITTERS * 12 + MPM_MAX_SINKS * 8;
  f[o] = io.exportOrigin[0];
  f[o + 1] = io.exportOrigin[1];
  f[o + 2] = io.exportOrigin[2];
  f[o + 3] = io.exportScale;
  u[o + 4] = c.maxParticles;
  return out;
}

/** 32-bit integer hash (lowbias32) — `mpmHash32` in common/mpm.wgsl. */
export function mpmHash32(n: number): number {
  let x = n | 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Hash → [0, 1) with 24 bits, exact in f32 — `mpmHash01` in common/mpm.wgsl. */
export function mpmHash01(n: number): number {
  return (mpmHash32(n) >>> 8) / 16777216;
}

/** Position and velocity of the `ticket`-th particle an emitter releases in a frame. */
export function mpmEmitParticle(e: MpmEmitter, id: number, ticket: number, count: number, lengthM: number): { pos: number[]; vel: number[] } {
  const len = Math.hypot(e.direction[0], e.direction[1], e.direction[2]) || 1;
  const d = [e.direction[0] / len, e.direction[1] / len, e.direction[2] / len];
  // Any unit vector not parallel to d, then Gram–Schmidt: the same construction as the shader.
  const a = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let t = [a[1] * d[2] - a[2] * d[1], a[2] * d[0] - a[0] * d[2], a[0] * d[1] - a[1] * d[0]];
  const tl = Math.hypot(t[0], t[1], t[2]);
  t = [t[0] / tl, t[1] / tl, t[2] / tl];
  const b = [d[1] * t[2] - d[2] * t[1], d[2] * t[0] - d[0] * t[2], d[0] * t[1] - d[1] * t[0]];
  const rho = Math.sqrt(mpmHash01(id * 3 + 1));
  const theta = 2 * Math.PI * mpmHash01(id * 3 + 2);
  const along = ((ticket + mpmHash01(id * 3)) / Math.max(1, count)) * lengthM;
  const cx = Math.cos(theta) * rho;
  const cy = Math.sin(theta) * rho;
  const radial = [t[0] * cx + b[0] * cy, t[1] * cx + b[1] * cy, t[2] * cx + b[2] * cy];
  const dir = [d[0] + radial[0] * e.spread, d[1] + radial[1] * e.spread, d[2] + radial[2] * e.spread];
  const dl = Math.hypot(dir[0], dir[1], dir[2]);
  return {
    pos: [0, 1, 2].map((k) => e.centre[k] + d[k] * along + radial[k] * e.radiusM),
    vel: dir.map((x) => (x / dl) * e.speedMS)
  };
}
