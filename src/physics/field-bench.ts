/**
 * Bench field model — catalog `fieldSources` + live plant state → packed
 * sources and streamline seeds (ADR-0017, #255 §1).
 *
 * One `BenchField` per bench that has a catalog row. `rebuild()` refills the
 * same FieldSourceList / FieldSeedList every call (no reallocation), so the
 * caller can repack each frame and upload in place. `probeT()` is the exact
 * CPU field at a scene-unit point — the value the probe readout, experiment
 * `field.probe.*` keys and the WebGL2 path all use.
 */

import {
  FIELD_SOURCE_CATALOG,
  type FieldDrive,
  type FieldGroupDecl,
  type FieldSourceDecl,
  type FieldV3
} from '../../generated/field-sources';
import { FIELD_MU0, evaluateFieldT, type Vec3Out } from './field-eval';
import { FIELD_BUILDERS, FieldSeedList, type FieldBuildContext, type FieldBuilderName } from './field-builders';
import { FieldSourceList, yawQuat } from './field-sources';
import type { SegLayout } from '../devices/types';

export { FIELD_SOURCE_CATALOG };
export type { FieldSourceDecl };

/** Live inputs a rebuild reads besides the bench's own physicsState. */
export interface BenchFieldInputs {
  state: Readonly<Record<string, unknown>> | null | undefined;
  time?: number;
  segLayout?: SegLayout | null;
  segOmega?: number;
  /** Overrides the catalog unitM (SEG: 1 / layout worldScale, which depends on the preset). */
  unitM?: number;
}

export function hasBenchField(deviceId: string): boolean {
  return Object.prototype.hasOwnProperty.call(FIELD_SOURCE_CATALOG, deviceId);
}

/** Live multiplier for a group: factor · (state[key] (+offset), |·| if abs). 1 without a drive. */
export function driveValue(drive: FieldDrive | undefined, state: Readonly<Record<string, unknown>>): number {
  if (!drive) return 1;
  const raw = state[drive.key];
  let v = typeof raw === 'number' && Number.isFinite(raw) ? raw : typeof raw === 'boolean' ? (raw ? 1 : 0) : 0;
  v += drive.offset ?? 0;
  if (drive.abs) v = Math.abs(v);
  return v * (drive.factor ?? 1);
}

const scaled = (v: FieldV3, u: number): [number, number, number] => [v[0] * u, v[1] * u, v[2] * u];

function addStaticGroup(g: FieldGroupDecl, u: number, k: number, out: FieldSourceList, seeds: FieldSeedList): void {
  switch (g.kind) {
    case 'dipole': {
      const m = g.moment!;
      out.dipole(scaled(g.at!, u), [m[0] * k, m[1] * k, m[2] * k], g.coreM ?? 1e-3);
      const ml = Math.hypot(m[0], m[1], m[2]) || 1;
      const r = (g.coreM ?? 1e-3) / u * 1.3;
      for (const s of [1, -1]) seeds.push(g.at![0] + (s * r * m[0]) / ml, g.at![1] + (s * r * m[1]) / ml, g.at![2] + (s * r * m[2]) / ml);
      return;
    }
    case 'segment': {
      const pts = g.points!.map((p) => scaled(p, u));
      out.polyline(pts, (g.currentA ?? 0) * k, !!g.closed, g.wireM ?? 5e-4);
      const n = g.points!.length;
      const c = g.points!.reduce((a, p) => [a[0] + p[0] / n, a[1] + p[1] / n, a[2] + p[2] / n], [0, 0, 0]);
      seeds.push(c[0], c[1], c[2]);
      return;
    }
    case 'box': {
      const br = Array.isArray(g.brT) ? g.brT : [0, Number(g.brT ?? 0), 0];
      const M: [number, number, number] = [br[0] / FIELD_MU0 * k, br[1] / FIELD_MU0 * k, br[2] / FIELD_MU0 * k];
      const q = yawQuat(((g.yawDeg ?? 0) * Math.PI) / 180);
      out.box(scaled(g.center!, u), scaled(g.halfSize!, u), M, q);
      const h = g.halfSize!;
      for (const s of [1, -1]) seeds.push(g.center![0], g.center![1] + s * h[1] * 1.1, g.center![2]);
      return;
    }
    case 'cylinder': {
      const len = g.halfLength! * 2 * u;
      const K = g.brT != null ? Number(g.brT) / FIELD_MU0 : ((g.turns ?? 0) * (g.currentA ?? 0)) / len;
      out.cylinder(scaled(g.center!, u), g.axis!, g.radius! * u, g.halfLength! * u, K * k);
      const ax = g.axis!, al = Math.hypot(ax[0], ax[1], ax[2]) || 1;
      // Seeds on a ring across the bore at the mid-plane.
      const ux = [ax[0] / al, ax[1] / al, ax[2] / al];
      const t1 = Math.abs(ux[1]) < 0.9 ? [ux[2], 0, -ux[0]] : [1, 0, 0];
      const t1l = Math.hypot(t1[0], t1[1], t1[2]);
      const t2 = [ux[1] * t1[2] - ux[2] * t1[1], ux[2] * t1[0] - ux[0] * t1[2], ux[0] * t1[1] - ux[1] * t1[0]];
      for (const f of [0, 0.5, 0.85]) for (let i = 0; i < (f === 0 ? 1 : 6); i++) {
        const a = (i / 6) * Math.PI * 2;
        const r = g.radius! * f;
        seeds.push(
          g.center![0] + r * (Math.cos(a) * t1[0] / t1l + Math.sin(a) * t2[0] / t1l),
          g.center![1] + r * (Math.cos(a) * t1[1] / t1l + Math.sin(a) * t2[1] / t1l),
          g.center![2] + r * (Math.cos(a) * t1[2] / t1l + Math.sin(a) * t2[2] / t1l)
        );
      }
      return;
    }
  }
}

export class BenchField {
  readonly deviceId: string;
  readonly decl: FieldSourceDecl;
  readonly sources = new FieldSourceList(64);
  readonly seeds = new FieldSeedList(256);
  private readonly probeOut: Vec3Out = [0, 0, 0];
  private liveUnitM: number;

  constructor(deviceId: string) {
    const decl = FIELD_SOURCE_CATALOG[deviceId];
    if (!decl) throw new Error(`no fieldSources for ${deviceId}`);
    this.deviceId = deviceId;
    this.decl = decl;
    this.liveUnitM = decl.unitM;
  }

  /** Metres per scene unit for the last rebuild. */
  get unitM(): number {
    return this.liveUnitM;
  }

  /** Refill sources and seeds from the plant. Returns the source count. */
  rebuild(inputs: BenchFieldInputs): number {
    const state = inputs.state ?? {};
    const u = (this.liveUnitM = inputs.unitM && inputs.unitM > 0 ? inputs.unitM : this.decl.unitM);
    this.sources.begin();
    this.seeds.begin();
    const ctx: FieldBuildContext = {
      deviceId: this.deviceId,
      state,
      time: inputs.time ?? 0,
      unitM: u,
      segLayout: inputs.segLayout,
      segOmega: inputs.segOmega
    };
    for (const g of this.decl.groups) {
      const k = driveValue(g.drive, state);
      if (g.builder) {
        FIELD_BUILDERS[g.builder as FieldBuilderName]?.(ctx, g.params ?? {}, k, this.sources, this.seeds);
      } else {
        addStaticGroup(g, u, k, this.sources, this.seeds);
      }
    }
    return this.sources.count;
  }

  /** Uniform E (V/m) for the particle pusher, or zero. */
  efield(state: Readonly<Record<string, unknown>> | null | undefined): [number, number, number] {
    const e = this.decl.efield;
    if (!e) return [0, 0, 0];
    const v = driveValue({ key: e.key, factor: e.factor }, state ?? {});
    const l = Math.hypot(e.dir[0], e.dir[1], e.dir[2]) || 1;
    return [(e.dir[0] / l) * v, (e.dir[1] / l) * v, (e.dir[2] / l) * v];
  }

  /** Exact B (T) at a device-local scene-unit point, from the last rebuild. */
  probeT(x: number, y: number, z: number, out: Vec3Out = this.probeOut): Vec3Out {
    const u = this.liveUnitM;
    return evaluateFieldT(x * u, y * u, z * u, this.sources.data, this.sources.count, out);
  }
}
