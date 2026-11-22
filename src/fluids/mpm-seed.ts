/**
 * MLS-MPM particle seeding — deterministic by construction: a lattice, and a
 * hash-seeded jitter when one is asked for. No Math.random anywhere.
 */
import { MPM_P, MPM_PARTICLE_FLOATS, mpmHash01, mpmHash32, type MpmConfig } from './mpm-params.js';

export interface MpmBoxSeed {
  /** Box corners, m, domain-local. */
  min: readonly [number, number, number];
  max: readonly [number, number, number];
  /** Initial velocity, m/s. */
  velocity?: readonly [number, number, number];
  /** Jitter as a fraction of the particle spacing (0 = perfect lattice). */
  jitter?: number;
  /** Seed for the jitter. */
  seed?: number;
}


/**
 * Write one live particle record at rest volume. `seed` starts the counter
 * its fixed-point dither is drawn from (mpm-params.ts); give two particles
 * the same one and they dither alike, which is harmless but pointless.
 */
export function writeMpmParticle(
  out: Float32Array,
  index: number,
  pos: readonly number[],
  vel: readonly number[] = [0, 0, 0],
  seed: number = index
): void {
  const o = index * MPM_PARTICLE_FLOATS;
  out.fill(0, o, o + MPM_PARTICLE_FLOATS);
  new Uint32Array(out.buffer, out.byteOffset + (o + MPM_P.seed) * 4, 1)[0] = mpmHash32(seed);
  out[o] = pos[0];
  out[o + 1] = pos[1];
  out[o + 2] = pos[2];
  out[o + MPM_P.j] = 1;
  out[o + 4] = vel[0];
  out[o + 5] = vel[1];
  out[o + 6] = vel[2];
  out[o + MPM_P.state] = 1;
}

/**
 * Fill a box at rest density: `particlesPerCell` must be a cube (1, 8, 27),
 * and each cell the box covers gets that many on a regular sub-lattice.
 * Returns the records; throws when they exceed the budget.
 */
export function seedMpmBox(config: MpmConfig, box: MpmBoxSeed): Float32Array {
  const per = Math.round(Math.cbrt(config.particlesPerCell));
  if (per ** 3 !== config.particlesPerCell) throw new Error(`seedMpmBox: particlesPerCell ${config.particlesPerCell} is not a cube`);
  const spacing = config.cellM / per;
  const n = [0, 1, 2].map((a) => Math.max(0, Math.round((box.max[a] - box.min[a]) / spacing)));
  const total = n[0] * n[1] * n[2];
  if (total > config.maxParticles) throw new Error(`seedMpmBox: ${total} particles exceed the budget ${config.maxParticles}`);
  const out = new Float32Array(total * MPM_PARTICLE_FLOATS);
  const jitter = (box.jitter ?? 0) * spacing;
  const seed = box.seed ?? 1;
  let i = 0;
  for (let z = 0; z < n[2]; z++) {
    for (let y = 0; y < n[1]; y++) {
      for (let x = 0; x < n[0]; x++) {
        const pos = [box.min[0] + (x + 0.5) * spacing, box.min[1] + (y + 0.5) * spacing, box.min[2] + (z + 0.5) * spacing];
        if (jitter > 0) {
          for (let a = 0; a < 3; a++) pos[a] += (mpmHash01(seed * 0x9e3779b1 + i * 3 + a) - 0.5) * jitter;
        }
        writeMpmParticle(out, i, pos, box.velocity, Math.imul(seed, 0x9e3779b1) + i);
        i++;
      }
    }
  }
  return out;
}
