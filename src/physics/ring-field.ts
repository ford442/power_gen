/**
 * The field of charged rings — conductors held at a potential, as a charged
 * drop feels them (docs/FLUIDS.md → Charge).
 *
 * Shared by the liquid solver (fluids/mpm-params.ts re-exports it; the WGSL
 * twin is `fieldAt` in passes/mpm-g2p.wgsl) and by the CPU drops of the
 * WebGL2 fallback (physics/kelvin-dropper.ts). Pure, SI.
 */

/** Point charges a ring is summed as (`MPM_RING_POINTS` in common/mpm.wgsl). */
export const MPM_RING_POINTS = 12;
/** Coulomb's constant, 1/(4πε₀), V·m/C. */
export const COULOMB_K = 8.9875517923e9;

/**
 * A conductor held at a potential, as the liquid's charged particles feel it:
 * a horizontal ring of charge (axis along y), or a point charge with radius 0.
 * `kq` is Coulomb's constant times its charge — the potential it makes at a
 * distance r is kq / r — so a sphere of radius R at potential V has kq = V·R.
 */
export interface MpmConductor {
  /** m, domain-local. */
  centre: readonly [number, number, number];
  /** Ring radius, m; 0 = a point. */
  radiusM: number;
  /** k·Q, V·m. */
  kq: number;
  /** Softening length, m: the wire's radius. Keeps the sum finite on the ring itself. */
  softM: number;
}

/**
 * Field (V/m) of a set of conductors at a point — `fieldAt` in mpm-g2p.wgsl.
 * A ring is the sum of MPM_RING_POINTS point charges, which is exact on its
 * axis and within a few percent a ring radius away from the wire.
 */
export function mpmFieldAt(conductors: readonly MpmConductor[], x: number, y: number, z: number, out: number[] = [0, 0, 0]): number[] {
  let ex = 0, ey = 0, ez = 0;
  for (const c of conductors) {
    const soft2 = c.softM * c.softM;
    const points = c.radiusM > 0 ? MPM_RING_POINTS : 1;
    const share = c.kq / points;
    for (let i = 0; i < points; i++) {
      const a = (2 * Math.PI * i) / MPM_RING_POINTS;
      const rx = x - (c.centre[0] + (c.radiusM > 0 ? Math.cos(a) * c.radiusM : 0));
      const ry = y - c.centre[1];
      const rz = z - (c.centre[2] + (c.radiusM > 0 ? Math.sin(a) * c.radiusM : 0));
      const d2 = rx * rx + ry * ry + rz * rz + soft2;
      const k = share / (d2 * Math.sqrt(d2));
      ex += rx * k; ey += ry * k; ez += rz * k;
    }
  }
  out[0] = ex; out[1] = ey; out[2] = ez;
  return out;
}

/** Potential (V) of a set of conductors at a point, with the same softening — for energy checks. */
export function mpmPotentialAt(conductors: readonly MpmConductor[], x: number, y: number, z: number): number {
  let v = 0;
  for (const c of conductors) {
    const points = c.radiusM > 0 ? MPM_RING_POINTS : 1;
    for (let i = 0; i < points; i++) {
      const a = (2 * Math.PI * i) / MPM_RING_POINTS;
      const rx = x - (c.centre[0] + (c.radiusM > 0 ? Math.cos(a) * c.radiusM : 0));
      const ry = y - c.centre[1];
      const rz = z - (c.centre[2] + (c.radiusM > 0 ? Math.sin(a) * c.radiusM : 0));
      v += c.kq / points / Math.sqrt(rx * rx + ry * ry + rz * rz + c.softM * c.softM);
    }
  }
  return v;
}
