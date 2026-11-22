/**
 * MLS-MPM solid boundaries — a signed-distance field sampled on the solver's
 * grid nodes (ADR-0022).
 *
 * A bench describes its solids as a short list of analytic primitives in SI
 * metres, domain-local. `bakeMpmBoundary` evaluates them once on the nodes:
 * four floats each, the outward unit normal and the signed distance (negative
 * inside a solid). The grid pass removes velocity into a solid at nodes inside
 * one; g2p pushes a particle that ended a step inside back to the surface.
 *
 * The field is grid-resolution, so a wall has to be about two cells thick to
 * hold water, and a solid's surface is where the primitive says, to within a
 * fraction of a cell.
 */
import { MPM_BOUNDARY_FLOATS, mpmDerived, type MpmConfig } from './mpm-params.js';

type Vec3 = readonly [number, number, number];

export type MpmSolid =
  /** An axis-aligned block. */
  | { kind: 'box'; min: Vec3; max: Vec3 }
  /** A solid upright cylinder: base centre, radius, height. */
  | { kind: 'cylinder'; base: Vec3; radiusM: number; heightM: number }
  /**
   * An upright vessel open at the top: a floor `floorM` thick under a wall
   * from innerRadiusM to outerRadiusM, `heightM` tall overall. `base` is the
   * centre of its underside.
   */
  | { kind: 'cup'; base: Vec3; innerRadiusM: number; outerRadiusM: number; floorM: number; heightM: number }
  /** An upright pipe: the wall of a tube from innerRadiusM to outerRadiusM. */
  | { kind: 'tube'; base: Vec3; innerRadiusM: number; outerRadiusM: number; heightM: number };

/** Signed distance to an axis-aligned rectangle in 2-D, given its centre offset and half sizes. */
function rect(px: number, py: number, hx: number, hy: number): number {
  const dx = Math.abs(px) - hx;
  const dy = Math.abs(py) - hy;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
}

/** Signed distance (m) from a point to one solid; negative inside. */
export function mpmSolidDistance(s: MpmSolid, x: number, y: number, z: number): number {
  if (s.kind === 'box') {
    const dx = Math.abs(x - (s.min[0] + s.max[0]) / 2) - (s.max[0] - s.min[0]) / 2;
    const dy = Math.abs(y - (s.min[1] + s.max[1]) / 2) - (s.max[1] - s.min[1]) / 2;
    const dz = Math.abs(z - (s.min[2] + s.max[2]) / 2) - (s.max[2] - s.min[2]) / 2;
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dy, dz), 0);
  }
  // The rest are bodies of revolution about a vertical axis: work in (r, y).
  const r = Math.hypot(x - s.base[0], z - s.base[2]);
  const yy = y - s.base[1];
  if (s.kind === 'cylinder') return rect(r, yy - s.heightM / 2, s.radiusM, s.heightM / 2);
  const wall = rect(r - (s.innerRadiusM + s.outerRadiusM) / 2, yy - s.heightM / 2, (s.outerRadiusM - s.innerRadiusM) / 2, s.heightM / 2);
  if (s.kind === 'tube') return wall;
  return Math.min(wall, rect(r, yy - s.floorM / 2, s.outerRadiusM, s.floorM / 2));
}

/** Signed distance to the union of the solids; +∞ for none. */
export function mpmSolidsDistance(solids: readonly MpmSolid[], x: number, y: number, z: number): number {
  let d = Infinity;
  for (const s of solids) d = Math.min(d, mpmSolidDistance(s, x, y, z));
  return d;
}

/**
 * Sample the solids on the grid nodes: MPM_BOUNDARY_FLOATS per node, in the
 * solver's node order. Normals are central differences of the distance over
 * half a cell, so they stay continuous across the seams between primitives.
 * A node far from every surface gets its distance and a zero normal.
 */
export function bakeMpmBoundary(config: MpmConfig, solids: readonly MpmSolid[]): Float32Array {
  const [nx, ny, nz] = config.gridN;
  const h = config.cellM;
  const out = new Float32Array(mpmDerived(config).nodes * MPM_BOUNDARY_FLOATS);
  const e = h / 2;
  let o = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, o += MPM_BOUNDARY_FLOATS) {
        const x = i * h;
        const y = j * h;
        const z = k * h;
        const d = mpmSolidsDistance(solids, x, y, z);
        out[o + 3] = Number.isFinite(d) ? d : 1e9;
        // Only nodes a particle can reach from the surface in a step or two need a normal.
        if (!(Math.abs(d) < 3 * h)) continue;
        const gx = mpmSolidsDistance(solids, x + e, y, z) - mpmSolidsDistance(solids, x - e, y, z);
        const gy = mpmSolidsDistance(solids, x, y + e, z) - mpmSolidsDistance(solids, x, y - e, z);
        const gz = mpmSolidsDistance(solids, x, y, z + e) - mpmSolidsDistance(solids, x, y, z - e);
        const len = Math.hypot(gx, gy, gz);
        if (len > 1e-12) {
          out[o] = gx / len;
          out[o + 1] = gy / len;
          out[o + 2] = gz / len;
        }
      }
    }
  }
  return out;
}

/**
 * The field at a point, trilinear over the eight surrounding nodes — what
 * g2p reads for a particle. Returns [nx, ny, nz, distance]; the normal is not
 * normalised.
 */
export function sampleMpmBoundary(config: MpmConfig, field: Float32Array, x: number, y: number, z: number, out: number[] = [0, 0, 0, 0]): number[] {
  const [nx, ny, nz] = config.gridN;
  const h = config.cellM;
  const gx = x / h;
  const gy = y / h;
  const gz = z / h;
  const i0 = Math.min(Math.max(Math.floor(gx), 0), nx - 2);
  const j0 = Math.min(Math.max(Math.floor(gy), 0), ny - 2);
  const k0 = Math.min(Math.max(Math.floor(gz), 0), nz - 2);
  const tx = gx - i0;
  const ty = gy - j0;
  const tz = gz - k0;
  out[0] = out[1] = out[2] = out[3] = 0;
  for (let c = 0; c < 8; c++) {
    const di = c & 1;
    const dj = (c >> 1) & 1;
    const dk = (c >> 2) & 1;
    const w = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty) * (dk ? tz : 1 - tz);
    const n = (((k0 + dk) * ny + j0 + dj) * nx + i0 + di) * MPM_BOUNDARY_FLOATS;
    out[0] += field[n] * w;
    out[1] += field[n + 1] * w;
    out[2] += field[n + 2] * w;
    out[3] += field[n + 3] * w;
  }
  return out;
}
