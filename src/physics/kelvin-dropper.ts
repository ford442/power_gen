/**
 * Kelvin's water dropper — the physics of its drops (docs/FLUIDS.md → Kelvin).
 *
 * Shared by the liquid scene (fluids/kelvin-liquid.ts, the solver on WebGPU)
 * and by the CPU drops of the WebGL2 fallback (`stepKelvinDrops`, below), so
 * both show the same streams and both can say what landed. Pure, SI; the
 * bench's parts come from kelvin-layout.ts at the bench's metres per scene
 * unit.
 *
 * A drop is one Rayleigh–Plateau wavelength of the jet from a drip tip. It
 * forms at the centre of an induction ring and takes the charge of a sphere
 * of its radius at the ring's potential, up to the Rayleigh limit. From there
 * it is a point mass under gravity and the field of four conductors — the two
 * rings and the two collectors' rims, at the potentials the plant computes.
 * Break-up itself is not resolved, the drops do not act on each other, and
 * there is no air.
 */
import { KELVIN_CONSTANTS, PHYSICAL_CONSTANTS } from '../../generated/physics-constants.js';
import { KELVIN_APPARATUS, KELVIN_COLLECTOR_MOUTH_Y } from '../kelvin-layout.js';
import { COULOMB_K, mpmFieldAt, type MpmConductor } from './ring-field.js';

/** Wavelength of the fastest-growing Rayleigh–Plateau mode on a jet, in jet diameters. */
export const RAYLEIGH_PLATEAU_WAVELENGTH = 4.508;
/** Below this drive the tips only weep: nothing is released. */
export const KELVIN_MIN_DRIVE = 0.02;

type Point = [number, number, number];

/** What a tip releases at a drive setting. */
export interface KelvinDrops {
  /** Jet speed at the tip, m/s. */
  jetSpeedMS: number;
  /** Drop radius, m, and volume, m³: one Rayleigh–Plateau wavelength of jet. */
  radiusM: number;
  volumeM3: number;
  massKg: number;
  /** Drops per second from one tip. */
  rateHz: number;
}

/**
 * Rayleigh–Plateau break-up of the jet from a drip tip: a jet of diameter d
 * goes unstable fastest at a wavelength of 4.508 d, and each wavelength closes
 * into one drop — radius 0.945 d, one every 4.508 d / v seconds.
 */
export function kelvinDrops(drive: number, nozzleDiameterM: number = KELVIN_CONSTANTS.NOZZLE_DIAMETER_M): KelvinDrops {
  const d = nozzleDiameterM;
  const jetSpeedMS = KELVIN_CONSTANTS.JET_SPEED_MAX_MS * Math.min(1, Math.max(0, Number.isFinite(drive) ? drive : 0));
  const wavelength = RAYLEIGH_PLATEAU_WAVELENGTH * d;
  const volumeM3 = Math.PI * (d / 2) ** 2 * wavelength;
  const radiusM = Math.cbrt((3 * volumeM3) / (4 * Math.PI));
  return { jetSpeedMS, radiusM, volumeM3, massKg: KELVIN_CONSTANTS.WATER_DENSITY * volumeM3, rateHz: jetSpeedMS / wavelength };
}

/** The Rayleigh limit: the most charge a drop of radius r holds before it flies apart, 8π·√(ε₀·γ·r³), C. */
export function rayleighLimitC(radiusM: number): number {
  const eps0 = 1 / (4 * Math.PI * COULOMB_K);
  return 8 * Math.PI * Math.sqrt(eps0 * KELVIN_CONSTANTS.SURFACE_TENSION_NM * radiusM ** 3);
}

/**
 * Magnitude of the charge a drop takes as it forms at the centre of an
 * induction ring at `volts`: that of an isolated sphere of its radius at the
 * ring's potential, 4πε₀·r·V, and never more than the Rayleigh limit. With the
 * bench's 3.5 mm tip the limit is reached near 10 kV; above that every drop
 * carries the same charge whatever the voltage.
 */
export function kelvinDropChargeC(volts: number, radiusM: number): number {
  const v = Number.isFinite(volts) ? Math.abs(volts) : 0;
  return Math.min((radiusM * v) / COULOMB_K, rayleighLimitC(radiusM));
}

/** The dropper's parts in metres, in whatever frame the three point pairs are given: [left, right]. */
export interface KelvinDropperParts {
  tips: [Point, Point];
  rings: [Point, Point];
  mouths: [Point, Point];
  ringRadiusM: number;
  ringWireM: number;
  collectorRadiusM: number;
}

/** The parts in bench-local metres (origin at the bench's, y up) — the drawn apparatus at its scale. */
export function kelvinDropperParts(): KelvinDropperParts {
  const a = KELVIN_APPARATUS;
  const m = KELVIN_CONSTANTS.METRES_PER_SCENE_UNIT;
  const at = (x: number, y: number): Point => [x * m, y * m, 0];
  return {
    tips: [at(-a.columnX, a.tipY), at(a.columnX, a.tipY)],
    rings: [at(-a.columnX, a.ringY), at(a.columnX, a.ringY)],
    mouths: [at(-a.columnX, KELVIN_COLLECTOR_MOUTH_Y), at(a.columnX, KELVIN_COLLECTOR_MOUTH_Y)],
    ringRadiusM: a.ringRadius * m,
    ringWireM: a.ringWire * m,
    collectorRadiusM: a.collectorRadius * m
  };
}

/**
 * The four conductors at the plant's potential: each induction ring, and the
 * rim of each collector as a ring of its radius. The left ring is the
 * positive one. The cross-connection puts each collector at the potential of
 * the opposite ring — which is the sign of the drops falling into it. A
 * ring's `kq` is V·R: the potential at its centre is then V, the conductor's
 * own.
 */
export function kelvinDropperConductors(parts: KelvinDropperParts, volts: number): MpmConductor[] {
  const v = Number.isFinite(volts) ? Math.max(0, volts) : 0;
  const ring = (centre: Point, sign: number): MpmConductor => ({
    centre, radiusM: parts.ringRadiusM, kq: sign * v * parts.ringRadiusM, softM: parts.ringWireM
  });
  const rim = (centre: Point, sign: number): MpmConductor => ({
    centre, radiusM: parts.collectorRadiusM, kq: sign * v * parts.collectorRadiusM, softM: 0.1 * parts.collectorRadiusM
  });
  return [ring(parts.rings[0], 1), ring(parts.rings[1], -1), rim(parts.mouths[0], -1), rim(parts.mouths[1], 1)];
}

/** Drops over which the landing share is taken at least, and the displayed seconds it looks back. */
export const KELVIN_EFFICIENCY_MIN_DROPS = 12;
export const KELVIN_EFFICIENCY_WINDOW_S = 3;

/**
 * The share of the drops that landed in a collector, over the last few
 * seconds. Fed running totals of what landed and what missed; `value` is null
 * until enough drops have come down to say, and again once the stream has
 * stopped for longer than the window.
 */
export class KelvinEfficiency {
  value: number | null = null;
  private readonly samples: Array<{ t: number; landed: number; missed: number }> = [];

  /** `t` in displayed seconds; `landed` and `missed` are totals since the streams started. */
  update(t: number, landed: number, missed: number): number | null {
    const last = this.samples[this.samples.length - 1];
    // The totals only grow: a smaller one is a new run.
    if (last && (landed < last.landed || missed < last.missed)) this.reset();
    this.samples.push({ t, landed, missed });
    while (this.samples.length > 2 && this.samples[1].t <= t - KELVIN_EFFICIENCY_WINDOW_S) this.samples.shift();
    const first = this.samples[0];
    const dl = landed - first.landed;
    const dm = missed - first.missed;
    if (dl + dm >= KELVIN_EFFICIENCY_MIN_DROPS) this.value = dl / (dl + dm);
    else if (t - first.t >= KELVIN_EFFICIENCY_WINDOW_S && dl + dm === 0) this.value = null;
    return this.value;
  }

  reset(): void {
    this.samples.length = 0;
    this.value = null;
  }
}

// ---------------------------------------------------------------------------
// The stand-in train: drops with no field (overview, or no solver)
// ---------------------------------------------------------------------------

/**
 * Where drop `idx` of the stand-in train is at displayed time `t`, bench-local
 * scene units — the CPU twin of `posKelvin` in passes/particle-compute.wgsl.
 *
 * The train is what a tip makes with no charge on anything: one drop every
 * Rayleigh–Plateau period, falling under gravity alone from the tip to its
 * collector's mouth, shown at the bench's time scale. Even slots are the left
 * tip's, odd the right's; a slot the train has no use for, and a drop that has
 * landed, sit inside the collector, out of sight. Stateless: a function of
 * the time and the jet speed, so it needs no history and cannot show the
 * field's effect — that is what the solver (or the fallback's CPU drops) is for.
 */
export function kelvinStandInDrop(idx: number, t: number, jetSpeedMS: number, out: number[] = [0, 0, 0]): number[] {
  const F = Math.fround;
  const a = KELVIN_APPARATUS;
  const side = (idx & 1) === 1 ? 1 : -1;
  out[0] = side * a.columnX; out[1] = a.collectorY; out[2] = 0;
  const v0 = F(jetSpeedMS);
  if (!(v0 >= F(KELVIN_STAND_IN_MIN_MS))) return out;
  const g = F(PHYSICAL_CONSTANTS.G);
  const scale = F(KELVIN_CONSTANTS.METRES_PER_SCENE_UNIT);
  const fall = F(F(a.tipY - KELVIN_COLLECTOR_MOUTH_Y) * scale);
  const flight = F(F(F(Math.sqrt(F(F(v0 * v0) + F(F(2 * g) * fall)))) - v0) / g);
  const period = F(F(F(RAYLEIGH_PLATEAU_WAVELENGTH) * F(KELVIN_CONSTANTS.NOZZLE_DIAMETER_M)) / v0);
  const slots = F(Math.ceil(F(flight / period)) + 1);
  const k = Math.floor(idx / 2);
  if (k >= slots) return out;
  const cycle = F(slots * period);
  const phase = F(F(F(t) * F(KELVIN_CONSTANTS.LIQUID_TIME_SCALE)) + F(k * period));
  const tau = F(phase - F(Math.floor(F(phase / cycle)) * cycle));
  if (tau > flight) return out;
  out[1] = F(F(a.tipY) - F(F(F(v0 * tau) + F(F(0.5 * g) * F(tau * tau))) / scale));
  return out;
}

/** Jet speed under which the stand-in train shows nothing, m/s: the tips only weep (`KELVIN_MIN_DRIVE` of full). */
export const KELVIN_STAND_IN_MIN_MS: number = KELVIN_MIN_DRIVE * KELVIN_CONSTANTS.JET_SPEED_MAX_MS;

// ---------------------------------------------------------------------------
// CPU drops for the fallback renderer
// ---------------------------------------------------------------------------

/** Running totals a caller keeps across steps of `stepKelvinDrops`. */
export interface KelvinDropTally {
  landed: number;
  missed: number;
}

export interface KelvinDropStep {
  /** Displayed seconds this step covers; the drops move `LIQUID_TIME_SCALE` of it (1: the plant's clock). */
  dt: number;
  /** Plant drive, 0..1: the tips' flow. */
  drive: number;
  /** What the rings stand at, V: the plant's voltage plus any coupled seed. */
  volts: number;
  /** A clock that differs every step: the release is hashed from it. */
  simClock: number;
  /** Counts what lands and what misses, if given. */
  tally?: KelvinDropTally;
}

/** Tangent of the half-angle the drops leave a tip within (the solver's emitter uses the same). */
export const KELVIN_TIP_SPREAD = 0.02;
/**
 * Half-width of the square that stands in for a collector's round mouth, as a
 * share of its radius: the square of the same area. The solver's sinks are
 * boxes, and the CPU drops use the same footprint so the two agree on what
 * has landed.
 */
export const KELVIN_MOUTH_SQUARE = Math.sqrt(Math.PI) / 2;
/** Longest substep of the CPU drops, simulated seconds: a kick from a ring stays a small step. */
const DROP_SUBSTEP_S = 1e-3;
/** A waiting drop is kept this far under the bench, scene units: out of any view. */
export const KELVIN_PARK_DROP = 1e4;
/** Half-extents of the space the drops live in, around the bench, scene units — the solver's box. */
const BOX_HALF_X = KELVIN_APPARATUS.columnX + KELVIN_APPARATUS.ringRadius + 0.8;
const BOX_HALF_Z = KELVIN_APPARATUS.ringRadius + 0.8;
const BOX_FLOOR_Y = KELVIN_COLLECTOR_MOUTH_Y - 0.9;

function hash01(n: number): number {
  return ((Math.sin(n * 78.233 + 12.9898) * 43758.5453) % 1 + 1) % 1;
}

/**
 * One step of the fallback's drops, in place: 8 floats a particle — position
 * (bench-local scene units), phase, velocity (scene units per simulated
 * second), and `aux`: 0 while it waits in a tip, ±1 in flight with that sign
 * of charge. Even slots are the left tip's, odd the right's.
 *
 * The same law as the solver's lone particles: gravity, and q·E/m from the
 * four conductors. A tip releases its waiting drops at random moments at the
 * Rayleigh–Plateau rate; a drop that reaches its collector's mouth has
 * landed, one that leaves the space around the bench has missed.
 */
export function stepKelvinDrops(particles: Float32Array, count: number, o: KelvinDropStep): void {
  const n = Math.min(count, Math.floor(particles.length / 8));
  const scale = KELVIN_CONSTANTS.METRES_PER_SCENE_UNIT;
  const simDt = Math.max(0, o.dt) * KELVIN_CONSTANTS.LIQUID_TIME_SCALE;
  const drops = kelvinDrops(o.drive);
  const parts = kelvinDropperParts();
  const conductors = kelvinDropperConductors(parts, o.volts);
  const qOverM = kelvinDropChargeC(o.volts, drops.radiusM) / drops.massKg;
  const g = PHYSICAL_CONSTANTS.G;
  const mouthY = KELVIN_COLLECTOR_MOUTH_Y;
  const flows = o.drive >= KELVIN_MIN_DRIVE && simDt > 0;

  // How many wait, per tip: a tip owes rate·dt drops and shares that chance among them.
  const waiting = [0, 0];
  for (let i = 0; i < n; i++) if (particles[i * 8 + 7] === 0) waiting[i & 1]++;
  const chance = [0, 1].map((side) => (flows && waiting[side] > 0 ? Math.min(1, (drops.rateHz * simDt) / waiting[side]) : 0));

  const steps = Math.max(1, Math.ceil(simDt / DROP_SUBSTEP_S));
  const h = simDt / steps;
  const e = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const b = i * 8;
    const side = i & 1;
    let sign = particles[b + 7];
    if (sign === 0) {
      if (hash01(i * 0.1031 + o.simClock * 0.37 + 5 * 1.7) >= chance[side]) {
        particles[b] = 0; particles[b + 1] = -KELVIN_PARK_DROP; particles[b + 2] = 0;
        particles[b + 4] = 0; particles[b + 5] = 0; particles[b + 6] = 0;
        continue;
      }
      // Released: at the tip's mouth, within its bore, moving down at the jet's
      // speed and a little outwards — more the nearer the rim, as the solver's
      // nozzle lets them go.
      const angle = 2 * Math.PI * hash01(i * 0.1031 + o.simClock * 0.37 + 1.7);
      const rho = Math.sqrt(hash01(i * 0.1031 + o.simClock * 0.37 + 3.4));
      const r = (0.5 * KELVIN_CONSTANTS.NOZZLE_DIAMETER_M * rho) / scale;
      const out = (KELVIN_TIP_SPREAD * rho * drops.jetSpeedMS) / scale;
      particles[b] = (side === 0 ? -1 : 1) * KELVIN_APPARATUS.columnX + Math.cos(angle) * r;
      particles[b + 1] = KELVIN_APPARATUS.tipY;
      particles[b + 2] = Math.sin(angle) * r;
      particles[b + 4] = Math.cos(angle) * out;
      particles[b + 5] = -drops.jetSpeedMS / scale;
      particles[b + 6] = Math.sin(angle) * out;
      // The left ring is positive, so the left stream is negative.
      sign = side === 0 ? -1 : 1;
      particles[b + 7] = sign;
    }
    // Metres, bench-local, for the field; back to scene units at the end.
    let x = particles[b] * scale, y = particles[b + 1] * scale, z = particles[b + 2] * scale;
    let vx = particles[b + 4] * scale, vy = particles[b + 5] * scale, vz = particles[b + 6] * scale;
    let done: 'landed' | 'missed' | null = null;
    for (let s = 0; s < steps && !done; s++) {
      mpmFieldAt(conductors, x, y, z, e);
      const k = sign * qOverM * h;
      vx += e[0] * k;
      vy += (e[1] * sign * qOverM - g) * h;
      vz += e[2] * k;
      x += vx * h; y += vy * h; z += vz * h;
      const sx = x / scale, sy = y / scale, sz = z / scale;
      if (sy <= mouthY && sy > mouthY - 0.5) {
        // Either collector's mouth counts: a drop thrown across still falls into a collector.
        const half = KELVIN_MOUTH_SQUARE * KELVIN_APPARATUS.collectorRadius;
        if (Math.abs(Math.abs(sx) - KELVIN_APPARATUS.columnX) <= half && Math.abs(sz) <= half) done = 'landed';
      }
      if (!done && (sy < BOX_FLOOR_Y || Math.abs(sx) > BOX_HALF_X || Math.abs(sz) > BOX_HALF_Z || sy > KELVIN_APPARATUS.beamY + 1)) done = 'missed';
    }
    if (done) {
      if (o.tally) o.tally[done]++;
      particles[b] = 0; particles[b + 1] = -KELVIN_PARK_DROP; particles[b + 2] = 0;
      particles[b + 4] = 0; particles[b + 5] = 0; particles[b + 6] = 0;
      particles[b + 7] = 0;
      continue;
    }
    particles[b] = x / scale; particles[b + 1] = y / scale; particles[b + 2] = z / scale;
    particles[b + 4] = vx / scale; particles[b + 5] = vy / scale; particles[b + 6] = vz / scale;
  }
}
