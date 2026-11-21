/**
 * Field-source builders — procedural geometry the catalog's `fieldSources`
 * groups name with `"builder"` (ADR-0017, #255 §1).
 *
 * A builder turns live plant state into packed sources (SI) plus streamline
 * seeds (device-local scene units). It never allocates per call beyond small
 * temporaries; the list and seeds are rewound and refilled every rebuild.
 *
 * Geometry follows what the meshes draw (positions from the bench plugins);
 * sizes are physical where the catalog knows them, since every quanta bench
 * draws its parts with one shared r = 0.8, h = 2.5 cylinder (no per-instance
 * scale). codegen:catalog checks every `"builder"` name against
 * FIELD_BUILDER_NAMES.
 */

import { FIELD_MU0, evaluateFieldT } from './field-eval';
import { FieldSourceList, quatRotateInv, yawQuat, type V3 } from './field-sources';
import type { SegLayout } from '../devices/types';

export const FIELD_BUILDER_NAMES = [
  'segRollers',
  'halbachArray',
  'halbachRing',
  'polePair',
  'floaterMagnet',
  'toroidCore',
  'loop',
  'lorentzCircuit'
] as const;
export type FieldBuilderName = typeof FIELD_BUILDER_NAMES[number];

/** Streamline seeds, scene units: (x, y, z, weight) per seed. */
export class FieldSeedList {
  data: Float32Array;
  count = 0;
  constructor(capacity = 256) {
    this.data = new Float32Array(capacity * 4);
  }
  get capacity(): number {
    return this.data.length / 4;
  }
  begin(): this {
    this.count = 0;
    return this;
  }
  push(x: number, y: number, z: number, w = 1): this {
    if (this.count >= this.capacity) return this;
    const o = this.count++ * 4;
    this.data[o] = x; this.data[o + 1] = y; this.data[o + 2] = z; this.data[o + 3] = w;
    return this;
  }
}

export interface FieldBuildContext {
  deviceId: string;
  /** The bench's physicsState (read only). */
  state: Readonly<Record<string, unknown>>;
  /** Visualizer clock (s) — SEG roller kinematics. */
  time: number;
  /** Metres per scene unit (the catalog row's unitM). */
  unitM: number;
  segLayout?: SegLayout | null;
  /** Normalised SEG ω (segOperator.physics.segOmega). */
  segOmega?: number;
}

type Params = Readonly<Record<string, unknown>>;
export type FieldBuilder = (
  ctx: FieldBuildContext,
  params: Params,
  strength: number,
  out: FieldSourceList,
  seeds: FieldSeedList
) => void;

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const v3 = (v: unknown, d: V3): V3 => (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number') ? v as unknown as V3 : d);
const stateNum = (ctx: FieldBuildContext, key: string, d: number) => num(ctx.state[key], d);

/** N52-class remanence used where a bench has no own Br. */
const DEFAULT_BR_T = 1.48;

/**
 * SEG rollers: one magnetised sphere per roller, exactly where
 * seg-roller-compute.wgsl puts the mesh (same phase, ramp and jitter), moment
 * tangential (the tumble axis, so the tumble does not change it), |m| = M·V of
 * the drawn roller (SEG_MAGNET M ≈ 1.12 MA/m). Core radius = roller radius.
 */
const segRollers: FieldBuilder = (ctx, params, strength, out, seeds) => {
  const layout = ctx.segLayout;
  if (!layout) return;
  const ws = layout.worldScale;
  const t = ctx.time;
  const omega = Math.max(num(ctx.segOmega, 0), 0.02);
  const M = num(params.magnetizationAPerM, 1.12166e6) * strength;
  const seedsPerRoller = Math.max(1, Math.round(num(params.seedsPerRoller, 2)));
  let flat = 0;
  const u = ctx.unitM;
  layout.rings.forEach((ring, ringIdx) => {
    const R = ring.orbitRadiusM * ws;
    const rollerR = ring.rollerRadiusM * ws;
    // Everything through unitM, so a preset whose worldScale ≠ 1/unitM stays self-consistent.
    const vol = Math.PI * (rollerR * u) ** 2 * (ring.rollerHeightM * ws * u);
    const ramp = Math.min(t * (0.25 + ringIdx * 0.1), 1) * omega;
    for (let i = 0; i < ring.count; i++, flat++) {
      const jitter = 1 + 0.04 * Math.sin(t * 1.3 + Math.sin(flat * 127.3 + ringIdx * 53.7) * 12.7);
      const a = (i / ring.count) * Math.PI * 2 + t * 0.5 * ring.speed * jitter * ramp + ringIdx * 0.22;
      const x = Math.cos(a) * R, z = Math.sin(a) * R;
      // Alternate poles round the ring, like the mesh's N/S tint.
      const pole = ((i + ringIdx) & 1) === 0 ? 1 : -1;
      const m = M * vol * pole;
      out.dipole([x * u, 0, z * u], [-Math.sin(a) * m, 0, Math.cos(a) * m], rollerR * u);
      for (let s = 0; s < seedsPerRoller; s++) {
        const side = s % 2 === 0 ? 1 : -1;
        const lift = (Math.floor(s / 2) - 0.5 * (seedsPerRoller > 2 ? 1 : 0)) * rollerR * 0.4;
        seeds.push(x - Math.sin(a) * rollerR * 1.05 * side, lift, z + Math.cos(a) * rollerR * 1.05 * side);
      }
    }
  });
};

/**
 * Halbach array from halbach-viz state: N magnetised boxes (t × t × arc,
 * HALBACH_VIZ thickness / radius), magnetisation in the XZ plane at the same
 * angle magnetic-field.ts's dipoles use, at the mesh's y.
 */
const halbachArray: FieldBuilder = (ctx, params, strength, out, seeds) => {
  const n = Math.max(2, Math.min(32, Math.round(stateNum(ctx, 'halbachSegmentCount', 8))));
  const magStep = (stateNum(ctx, 'halbachMagAngleDeg', 360 / n) * Math.PI) / 180;
  const linear = ctx.state.halbachLayout === 'linear';
  const radiusM = num(params.radiusM, 0.14);
  const tM = num(params.thicknessM, 0.028);
  const yU = num(params.y, 0.2);
  const M = (num(params.brT, DEFAULT_BR_T) / FIELD_MU0) * strength;
  const u = ctx.unitM;
  if (linear) {
    const segLen = (radiusM * 2) / n;
    for (let i = 0; i < n; i++) {
      const x = -radiusM + (i + 0.5) * segLen;
      const mA = i * magStep;
      out.box([x, yU * u, 0], [segLen * 0.48, tM / 2, tM / 2], [Math.cos(mA) * M, 0, Math.sin(mA) * M]);
      seeds.push(x / u, yU + tM / u, 0).push(x / u, yU - tM / u, 0);
    }
    return;
  }
  const arc = (2 * Math.PI * radiusM) / n;
  for (let i = 0; i < n; i++) {
    const th = (i / n) * Math.PI * 2;
    const mA = th + Math.PI / 2 + i * magStep;
    const q = yawQuat(-th); // local x = radial, local z = tangential
    const local = quatRotateInv(q, [Math.cos(mA) * M, 0, Math.sin(mA) * M]);
    out.box([Math.cos(th) * radiusM, yU * u, Math.sin(th) * radiusM], [tM / 2, tM / 2, arc * 0.48], local, q);
    const rs = (radiusM - tM) / u;
    seeds.push(Math.cos(th) * rs, yU, Math.sin(th) * rs).push(Math.cos(th) * radiusM / u, yU + tM / u, Math.sin(th) * radiusM / u);
  }
};

/**
 * A ring of `count` boxes at radius `radius` (scene units) whose
 * magnetisation turns by `stepDeg` per segment in the radial–Y plane — a
 * Halbach "wheel" that concentrates field on one face (maglev track).
 */
const halbachRing: FieldBuilder = (ctx, params, strength, out, seeds) => {
  const n = Math.max(2, Math.round(num(params.count, 12)));
  const R = num(params.radius, 2.8);
  const y = num(params.y, 0);
  const [hr, hy, ht] = v3(params.halfSize, [0.5, 0.4, 0.6]);
  const step = (num(params.stepDeg, 90) * Math.PI) / 180;
  const M = (num(params.brT, DEFAULT_BR_T) / FIELD_MU0) * strength;
  const u = ctx.unitM;
  for (let i = 0; i < n; i++) {
    const th = (i / n) * Math.PI * 2;
    const phi = i * step;
    const q = yawQuat(-th);
    out.box([Math.cos(th) * R * u, y * u, Math.sin(th) * R * u], [hr * u, hy * u, ht * u],
      [Math.cos(phi) * M, Math.sin(phi) * M, 0], q);
    seeds.push(Math.cos(th) * R, y + hy * 1.2, Math.sin(th) * R);
  }
};

const unitPairCache = new Map<string, number>();

/**
 * Two identical magnets either side of `center` along Y (pole faces `gap`
 * from the centre, `thickness` thick), both magnetised +Y. The drive is the
 * **target |B| at the centre** (T): the remanence is solved from the exact
 * field of the pair, so the volume reproduces the plant's B where the plant
 * claims it, and the fringe field around it comes for free.
 */
const polePair: FieldBuilder = (ctx, params, strength, out, seeds) => {
  const shape = params.shape === 'cylinder' ? 'cylinder' : 'box';
  const c = v3(params.center, [0, 0, 0]);
  const gap = num(params.gap, 0.3);
  const th = num(params.thickness, 0.2);
  const [hx, hz] = (Array.isArray(params.halfSize) ? params.halfSize : [0.5, 0.5]) as number[];
  const radius = num(params.radius, 0.5);
  const u = ctx.unitM;
  const key = `${shape}:${gap}:${th}:${hx}:${hz}:${radius}:${u}`;
  let perM = unitPairCache.get(key);
  const build = (list: FieldSourceList, M: number, cx: number, cy: number, cz: number) => {
    for (const s of [1, -1]) {
      const y = cy + s * (gap + th / 2) * u;
      if (shape === 'box') list.box([cx, y, cz], [hx * u, (th / 2) * u, hz * u], [0, M, 0]);
      else list.cylinder([cx, y, cz], [0, 1, 0], radius * u, (th / 2) * u, M);
    }
  };
  if (perM === undefined) {
    const probe = new FieldSourceList(2);
    build(probe, 1, 0, 0, 0);
    perM = evaluateFieldT(0, 0, 0, probe.data, probe.count)[1];
    unitPairCache.set(key, perM);
  }
  const M = perM !== 0 ? strength / perM : 0;
  build(out, M, c[0] * u, c[1] * u, c[2] * u);
  const sx = shape === 'box' ? hx : radius, sz = shape === 'box' ? hz : radius;
  for (const fx of [-0.6, 0, 0.6]) for (const fz of [-0.6, 0.6]) seeds.push(c[0] + fx * sx, c[1], c[2] + fz * sz);
};

/** Axially magnetised disc magnet riding at `y0 + state[gapKey]` (maglev floater). */
const floaterMagnet: FieldBuilder = (ctx, params, strength, out, seeds) => {
  const y = num(params.y0, 0.55) + stateNum(ctx, String(params.gapKey ?? 'maglevGap'), 0.018) / num(params.gapUnitM, 1);
  const r = num(params.radius, 0.8);
  const h = num(params.halfLength, 0.1);
  const M = (num(params.brT, 1.2) / FIELD_MU0) * strength * (params.repel === false ? 1 : -1);
  out.cylinder([0, y * ctx.unitM, 0], [0, 1, 0], r * ctx.unitM, h * ctx.unitM, M);
  for (const f of [0.3, 0.7]) for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    seeds.push(Math.cos(a) * r * f, y + h * 1.1, Math.sin(a) * r * f);
  }
};

/**
 * Toroidal core flux as equivalent ampere-turns on a helix wound round the
 * torus (centre `cy`, major R, minor r, in the XY plane — the transformer's
 * flux metaphor). Vacuum-only model of an iron core: the winding current is
 * chosen so the air-core centre-line field equals the drive (T), i.e.
 * N·I = B·2πR/μ0. Field outside the winding is what such a winding leaks.
 */
const toroidCore: FieldBuilder = (ctx, params, strength, out, seeds) => {
  const R = num(params.majorRadius, 0.55);
  const r = num(params.minorRadius, 0.16);
  const cy = num(params.cy, 0.25);
  const turns = Math.max(4, Math.round(num(params.turns, 24)));
  const pts = Math.max(6, Math.round(num(params.pointsPerTurn, 12)));
  const u = ctx.unitM;
  const current = (strength * 2 * Math.PI * R * u) / (FIELD_MU0 * turns);
  const total = turns * pts;
  const at = (k: number): V3 => {
    const phi = (k / total) * Math.PI * 2;
    const theta = (k / pts) * Math.PI * 2;
    const cr = R + r * Math.cos(theta);
    return [cr * Math.cos(phi) * u, (cy + cr * Math.sin(phi)) * u, r * Math.sin(theta) * u];
  };
  let prev = at(0);
  for (let k = 1; k <= total; k++) {
    const next = at(k % total);
    out.segment(prev, next, current, r * u * 0.15);
    prev = next;
  }
  const lines = Math.max(4, Math.round(num(params.seedLines, 12)));
  for (let i = 0; i < lines; i++) {
    const th = (i / lines) * Math.PI * 2;
    const rr = r * 0.55;
    seeds.push(R + rr * Math.cos(th), cy, rr * Math.sin(th));
  }
};

/** A circular loop of `turns` turns (one polyline, current × turns), axis +Y, centre y from a state key or fixed. */
const loop: FieldBuilder = (ctx, params, strength, out, seeds) => {
  const R = num(params.radius, 1);
  const segs = Math.max(8, Math.round(num(params.segments, 32)));
  const turns = num(params.turns, 1);
  const yKey = typeof params.yKey === 'string' ? params.yKey : null;
  const y = num(params.y, 0) + (yKey ? stateNum(ctx, yKey, 0) * num(params.yScale, 1) : 0);
  const u = ctx.unitM;
  const pts: V3[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    pts.push([Math.cos(a) * R * u, y * u, Math.sin(a) * R * u]);
  }
  out.polyline(pts, strength * turns, true, num(params.wireM, 2e-3));
  for (const f of [0, 0.45, 0.8]) for (let k = 0; k < (f === 0 ? 1 : 4); k++) {
    const a = (k / 4) * Math.PI * 2;
    seeds.push(Math.cos(a) * R * f, y, Math.sin(a) * R * f);
  }
};

/**
 * Railgun circuit: two rails along X at z = ±halfGap carrying ±I, closed by
 * the armature across Z at x = x0 + state[posKey]·posScale (lorentz-sled).
 */
const lorentzCircuit: FieldBuilder = (ctx, params, strength, out, seeds) => {
  const x0 = num(params.x0, -6), x1 = num(params.x1, 6);
  const zg = num(params.halfGap, 2.6);
  const y = num(params.y, 0);
  const ax = x0 + stateNum(ctx, String(params.posKey ?? 'lorentzPositionM'), 0) * num(params.posScale, 6);
  const u = ctx.unitM;
  const I = strength;
  // Current in along +z rail from the leads (x0), across the armature, back along −z rail.
  out.segment([x0 * u, y * u, zg * u], [ax * u, y * u, zg * u], I, 0.01);
  out.segment([ax * u, (y + 0.5) * u, zg * u], [ax * u, (y + 0.5) * u, -zg * u], I, 0.01);
  out.segment([ax * u, y * u, -zg * u], [x0 * u, y * u, -zg * u], I, 0.01);
  for (const z of [-zg * 0.6, 0, zg * 0.6]) seeds.push(ax + 0.3, y + 0.5, z);
  void x1;
};

export const FIELD_BUILDERS: Readonly<Record<FieldBuilderName, FieldBuilder>> = {
  segRollers,
  halbachArray,
  halbachRing,
  polePair,
  floaterMagnet,
  toroidCore,
  loop,
  lorentzCircuit
};
