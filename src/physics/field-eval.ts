/**
 * CPU reference for the field volume (ADR-0017): B (tesla) at a point, summed
 * over a packed FieldSourceList. Mirrors shaders/common/field-sources.wgsl
 * function for function; `npm run test:field-volume` holds the two together
 * (and each kernel against an independent quadrature).
 *
 * Every kernel is exact for its idealised source — no far-field approximation:
 *
 *   dipole     magnetised sphere (core radius rc): dipole outside, uniform
 *              B = μ0·2m / (4π rc³) inside.
 *   segment    finite straight wire, closed-form Biot–Savart, with a wire-radius
 *              core so the field is finite on the wire.
 *   box        uniformly magnetised cuboid via the surface-charge closed form
 *              (H from each charged face), B = μ0 (H + M) inside.
 *   cylinder   axially magnetised cylinder / ideal solenoid, Derby & Olbert
 *              (Am. J. Phys. 78, 229, 2010) with Bulirsch's generalised
 *              complete elliptic integral `cel`.
 *
 * Vacuum only: there is no permeable material anywhere (an iron core is
 * represented by the bench as equivalent ampere-turns — see the catalog row).
 */

import {
  FIELD_KIND_BOX,
  FIELD_KIND_CYLINDER,
  FIELD_KIND_DIPOLE,
  FIELD_KIND_SEGMENT,
  FIELD_SOURCE_FLOATS,
  quatRotate,
  quatRotateInv
} from './field-sources';

/** μ0 (T·m/A). Same literal as ValidatedConstants.MU_0 / generated/constants.wgsl. */
export const FIELD_MU0 = 1.25663706212e-6;
const MU0_4PI = FIELD_MU0 / (4 * Math.PI);
const HALF_PI = Math.PI / 2;

export type Vec3Out = [number, number, number];

function dipoleSphere(px: number, py: number, pz: number, s: Float32Array, o: number, out: Vec3Out): void {
  const rx = px - s[o], ry = py - s[o + 1], rz = pz - s[o + 2];
  const mx = s[o + 4], my = s[o + 5], mz = s[o + 6];
  const rc = s[o + 7];
  const r2 = rx * rx + ry * ry + rz * rz;
  if (r2 < rc * rc) {
    const k = (2 * MU0_4PI) / (rc * rc * rc);
    out[0] += k * mx; out[1] += k * my; out[2] += k * mz;
    return;
  }
  const r = Math.sqrt(r2);
  const inv = 1 / r;
  const ux = rx * inv, uy = ry * inv, uz = rz * inv;
  const mdu = mx * ux + my * uy + mz * uz;
  const k = MU0_4PI / (r2 * r);
  out[0] += k * (3 * mdu * ux - mx);
  out[1] += k * (3 * mdu * uy - my);
  out[2] += k * (3 * mdu * uz - mz);
}

function segment(px: number, py: number, pz: number, s: Float32Array, o: number, out: Vec3Out): void {
  const ax = s[o] - px, ay = s[o + 1] - py, az = s[o + 2] - pz;
  const bx = s[o + 4] - px, by = s[o + 5] - py, bz = s[o + 6] - pz;
  const current = s[o + 7];
  const rw = s[o + 8];
  const la = Math.sqrt(ax * ax + ay * ay + az * az);
  const lb = Math.sqrt(bx * bx + by * by + bz * bz);
  const ab = ax * bx + ay * by + az * bz;
  const lalb = la * lb;
  const den = lalb * (lalb + ab + 2 * rw * rw);
  if (!(den > 1e-30)) return;
  const k = (MU0_4PI * current * (la + lb)) / den;
  out[0] += k * (ay * bz - az * by);
  out[1] += k * (az * bx - ax * bz);
  out[2] += k * (ax * by - ay * bx);
}

/** ln(v + r), stable when v is large and negative (r ≈ −v). */
function lnVR(v: number, r: number, uw2: number): number {
  return v >= 0 ? Math.log(v + r + 1e-30) : Math.log(uw2 / (r - v) + 1e-30);
}

/**
 * H/σ of the two charged faces z = ±h.z (σ = +1 on top, −1 on bottom) of a
 * box with half-size h, at local point p: (1/4π) Σ faces Σ corners ±F.
 */
function facePairZ(px: number, py: number, pz: number, hx: number, hy: number, hz: number, out: Vec3Out): void {
  let fx = 0, fy = 0, fz = 0;
  for (let face = 0; face < 2; face++) {
    const sigma = face === 0 ? 1 : -1;
    let w = pz - (face === 0 ? hz : -hz);
    if (Math.abs(w) < 1e-9) w = w < 0 ? -1e-9 : 1e-9;
    for (let i = 0; i < 2; i++) {
      const u = px - (i === 0 ? -hx : hx);
      const si = i === 0 ? 1 : -1;
      for (let j = 0; j < 2; j++) {
        const v = py - (j === 0 ? -hy : hy);
        const sj = j === 0 ? 1 : -1;
        const sgn = sigma * si * sj;
        const r = Math.sqrt(u * u + v * v + w * w);
        fx -= sgn * lnVR(v, r, u * u + w * w);
        fy -= sgn * lnVR(u, r, v * v + w * w);
        fz += sgn * Math.atan2(u * v * Math.sign(w), Math.abs(w) * r);
      }
    }
  }
  const k = 1 / (4 * Math.PI);
  out[0] = fx * k; out[1] = fy * k; out[2] = fz * k;
}

const faceScratch: Vec3Out = [0, 0, 0];

function box(px: number, py: number, pz: number, s: Float32Array, o: number, out: Vec3Out): void {
  const q = [s[o + 8], s[o + 9], s[o + 10], s[o + 11]];
  const [lx, ly, lz] = quatRotateInv(q, [px - s[o], py - s[o + 1], pz - s[o + 2]]);
  const hx = s[o + 4], hy = s[o + 5], hz = s[o + 6];
  const mx = s[o + 12], my = s[o + 13], mz = s[o + 14];
  let Hx = 0, Hy = 0, Hz = 0;
  const f = faceScratch;
  if (mz !== 0) {
    facePairZ(lx, ly, lz, hx, hy, hz, f);
    Hx += mz * f[0]; Hy += mz * f[1]; Hz += mz * f[2];
  }
  if (mx !== 0) {
    // Permute (x, y, z) → (y, z, x): the x faces become the "z" pair.
    facePairZ(ly, lz, lx, hy, hz, hx, f);
    Hx += mx * f[2]; Hy += mx * f[0]; Hz += mx * f[1];
  }
  if (my !== 0) {
    // (x, y, z) → (z, x, y): the y faces become the "z" pair.
    facePairZ(lz, lx, ly, hz, hx, hy, f);
    Hx += my * f[1]; Hy += my * f[2]; Hz += my * f[0];
  }
  if (Math.abs(lx) < hx && Math.abs(ly) < hy && Math.abs(lz) < hz) {
    Hx += mx; Hy += my; Hz += mz;
  }
  const [wx, wy, wz] = quatRotate(q, [Hx, Hy, Hz]);
  out[0] += FIELD_MU0 * wx; out[1] += FIELD_MU0 * wy; out[2] += FIELD_MU0 * wz;
}

/**
 * Bulirsch's generalised complete elliptic integral
 * cel(kc, p, c, s) = ∫₀^{π/2} (c cos²φ + s sin²φ) / ((cos²φ + p sin²φ) √(cos²φ + kc² sin²φ)) dφ.
 * Fixed iteration cap so the WGSL twin has the same loop.
 */
export function cel(kcIn: number, p: number, c: number, s: number): number {
  const errtol = 1e-7;
  let k = Math.max(Math.abs(kcIn), 1e-7);
  let pp = p, cc = c, ss = s;
  let em = 1;
  if (pp > 0) {
    pp = Math.sqrt(pp);
    ss = ss / pp;
  } else {
    let f = k * k;
    let q = 1 - f;
    const g = 1 - pp;
    f = f - pp;
    q = q * (ss - c * pp);
    pp = Math.sqrt(f / g);
    cc = (c - ss) / pp;
    ss = -q / (g * g * pp) + cc * pp;
  }
  let f = cc;
  cc = cc + ss / pp;
  let g = k / pp;
  ss = 2 * (ss + f * g);
  pp = g + pp;
  g = em;
  em = k + em;
  let kk = k;
  for (let it = 0; it < 24; it++) {
    if (!(Math.abs(g - k) > g * errtol)) break;
    k = 2 * Math.sqrt(kk);
    kk = k * em;
    f = cc;
    cc = cc + ss / pp;
    g = kk / pp;
    ss = 2 * (ss + f * g);
    pp = g + pp;
    g = em;
    em = k + em;
  }
  return HALF_PI * (ss + cc * em) / (em * (em + pp));
}

function cylinder(px: number, py: number, pz: number, s: Float32Array, o: number, out: Vec3Out): void {
  const dx = px - s[o], dy = py - s[o + 1], dz = pz - s[o + 2];
  const ax = s[o + 4], ay = s[o + 5], az = s[o + 6];
  const a = s[o + 7];
  const b = s[o + 8];
  const K = s[o + 9];
  const z = dx * ax + dy * ay + dz * az;
  const rxv = dx - z * ax, ryv = dy - z * ay, rzv = dz - z * az;
  const rho = Math.sqrt(rxv * rxv + ryv * ryv + rzv * rzv);
  const B0 = (FIELD_MU0 * K) / Math.PI;
  const zp = z + b, zm = z - b;
  const apr = a + rho, amr = a - rho;
  const dp = Math.sqrt(zp * zp + apr * apr);
  const dm = Math.sqrt(zm * zm + apr * apr);
  const alphaP = a / dp, alphaM = a / dm;
  const betaP = zp / dp, betaM = zm / dm;
  const gamma = amr / apr;
  const kp = Math.sqrt((zp * zp + amr * amr) / (dp * dp));
  const km = Math.sqrt((zm * zm + amr * amr) / (dm * dm));
  const Brho = B0 * (alphaP * cel(kp, 1, 1, -1) - alphaM * cel(km, 1, 1, -1));
  const g2 = gamma * gamma;
  const Bz = ((B0 * a) / apr) * (betaP * cel(kp, g2, 1, gamma) - betaM * cel(km, g2, 1, gamma));
  out[0] += Bz * ax; out[1] += Bz * ay; out[2] += Bz * az;
  if (rho > 1e-9) {
    const inv = Brho / rho;
    out[0] += rxv * inv; out[1] += ryv * inv; out[2] += rzv * inv;
  }
}

/**
 * B (T) at point (x, y, z) in metres from `count` packed sources.
 * Writes into `out` (overwritten) and returns it.
 */
export function evaluateFieldT(
  x: number,
  y: number,
  z: number,
  sources: Float32Array,
  count: number,
  out: Vec3Out = [0, 0, 0]
): Vec3Out {
  out[0] = 0; out[1] = 0; out[2] = 0;
  for (let i = 0; i < count; i++) {
    const o = i * FIELD_SOURCE_FLOATS;
    const kind = sources[o + 3];
    if (kind === FIELD_KIND_DIPOLE) dipoleSphere(x, y, z, sources, o, out);
    else if (kind === FIELD_KIND_SEGMENT) segment(x, y, z, sources, o, out);
    else if (kind === FIELD_KIND_BOX) box(x, y, z, sources, o, out);
    else if (kind === FIELD_KIND_CYLINDER) cylinder(x, y, z, sources, o, out);
  }
  return out;
}
