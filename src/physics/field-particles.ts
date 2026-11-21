/**
 * Charged-particle settings for the field volume's Boris pusher (ADR-0017,
 * #255 §3). Pure numbers, so test:field-volume checks them and the WebGPU
 * pass only packs what this returns.
 *
 * Time is slowed by many orders of magnitude. The launch speed aims for a
 * gyroradius of `FIELD_GYRO_FRACTION` of the bench diagonal, capped at 5 % of
 * c so the non-relativistic push stays honest, and each frame moves a particle
 * about `FIELD_STEP_FRACTION` of the diagonal:
 *
 *   resolved  — at least FIELD_PUSHES_PER_GYRATION pushes a gyration, and
 *               enough pushes per frame (≤ FIELD_MAX_PUSHES) to cover that step.
 *               Protons and α at bench fields: visible circles and drifts.
 *   guiding   — the speed cap leaves the gyroradius far below a pixel
 *               (an electron at 0.1 T: < 1 mm), so resolving it would need
 *               thousands of pushes a frame. dt is stretched instead; Boris
 *               keeps |v| and the E×B drift exact for any ω·dt, so the
 *               guiding-centre motion along B is right while the gyration
 *               phase is aliased. The UI says which.
 */

export const FIELD_SPECIES = {
  electron: { label: 'electron', qOverM: -1.75882001076e11, charge: -1, massKg: 9.1093837015e-31 },
  proton: { label: 'proton', qOverM: 9.5788331560e7, charge: 1, massKg: 1.67262192369e-27 },
  alpha: { label: 'α (He²⁺)', qOverM: 4.8224e7, charge: 2, massKg: 6.6446573357e-27 }
} as const;
export type FieldSpecies = keyof typeof FIELD_SPECIES;

export const FIELD_SPEED_OF_LIGHT = 299792458;
export const FIELD_PUSHES_PER_GYRATION = 120;
export const FIELD_MAX_PUSHES = 32;
export const FIELD_GUIDING_PUSHES = 8;
export const FIELD_GYRO_FRACTION = 0.06;
export const FIELD_STEP_FRACTION = 0.004;
export const FIELD_MAX_SPEED_FRACTION_C = 0.05;
export const FIELD_PARTICLE_TRAIL = 12;
/** Below this the reference field is treated as this (T) — a dead bench still gets a sane dt. */
export const FIELD_PARTICLE_MIN_B = 1e-4;
/** ParticleParams (field-particles.wgsl): 6 × vec4f. */
export const FIELD_PARTICLE_PARAMS_BYTES = 96;

export interface FieldParticlePlan {
  species: FieldSpecies;
  qOverM: number;
  /** Simulated seconds per push. */
  dt: number;
  pushesPerFrame: number;
  /** Launch speed (m/s). */
  v0: number;
  /** Gyroradius at the reference field (m). */
  gyroRadiusM: number;
  /** ω·dt — < 1 when the gyration is resolved. */
  omegaDt: number;
  /** True when each gyration spans at least FIELD_PUSHES_PER_GYRATION pushes. */
  resolved: boolean;
  /** Simulated seconds per displayed second at 60 Hz. */
  simSecondsPerSecond: number;
  /** E×B drift at the reference field (m/s), for the UI. */
  driftMs: number;
  relativisticCap: boolean;
}

/**
 * @param bRefT reference |B| (T) — the bench probe's field
 * @param diagM bench AABB diagonal (m)
 * @param eVm uniform E magnitude (V/m)
 */
export function fieldParticlePlan(species: FieldSpecies, bRefT: number, diagM: number, eVm = 0): FieldParticlePlan {
  const s = FIELD_SPECIES[species];
  const b = Math.max(Math.abs(bRefT), FIELD_PARTICLE_MIN_B);
  const diag = Math.max(diagM, 1e-6);
  const omega = Math.abs(s.qOverM) * b;
  const vWanted = omega * FIELD_GYRO_FRACTION * diag;
  const vCap = FIELD_MAX_SPEED_FRACTION_C * FIELD_SPEED_OF_LIGHT;
  const v0 = Math.min(vWanted, vCap);
  const step = FIELD_STEP_FRACTION * diag;
  const dtResolved = (2 * Math.PI) / (omega * FIELD_PUSHES_PER_GYRATION);
  const pushesResolved = Math.ceil(step / (v0 * dtResolved));
  const resolved = pushesResolved <= FIELD_MAX_PUSHES;
  const pushesPerFrame = resolved ? Math.max(1, pushesResolved) : FIELD_GUIDING_PUSHES;
  // Exactly `step` per frame; resolved → dt ≤ dtResolved, so still ≥ FIELD_PUSHES_PER_GYRATION a turn.
  const dt = step / (v0 * pushesPerFrame);
  return {
    species,
    qOverM: s.qOverM,
    dt,
    pushesPerFrame,
    v0,
    gyroRadiusM: v0 / omega,
    omegaDt: omega * dt,
    resolved,
    simSecondsPerSecond: dt * pushesPerFrame * 60,
    driftMs: Math.abs(eVm) / b,
    relativisticCap: vWanted > vCap
  };
}

/** One Boris push (SI), the CPU twin of field-particles.wgsl — for tests. */
export function borisPush(
  v: [number, number, number],
  B: readonly [number, number, number],
  E: readonly [number, number, number],
  qOverM: number,
  dt: number
): [number, number, number] {
  const h = qOverM * dt * 0.5;
  const vm = [v[0] + E[0] * h, v[1] + E[1] * h, v[2] + E[2] * h];
  const t = [B[0] * h, B[1] * h, B[2] * h];
  const t2 = t[0] * t[0] + t[1] * t[1] + t[2] * t[2];
  const s = [2 * t[0] / (1 + t2), 2 * t[1] / (1 + t2), 2 * t[2] / (1 + t2)];
  const vp = [vm[0] + (vm[1] * t[2] - vm[2] * t[1]), vm[1] + (vm[2] * t[0] - vm[0] * t[2]), vm[2] + (vm[0] * t[1] - vm[1] * t[0])];
  const vplus = [vm[0] + (vp[1] * s[2] - vp[2] * s[1]), vm[1] + (vp[2] * s[0] - vp[0] * s[2]), vm[2] + (vp[0] * s[1] - vp[1] * s[0])];
  return [vplus[0] + E[0] * h, vplus[1] + E[1] * h, vplus[2] + E[2] * h];
}
