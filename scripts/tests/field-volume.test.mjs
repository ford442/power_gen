/**
 * field-volume — the 3-D magnetostatic field volume (ADR-0017, #255).
 *
 *   1. Kernels against independent physics: the dipole against
 *      magnetic-field.ts, the finite wire / cuboid / cylinder against
 *      brute-force quadrature of Biot–Savart or the surface-charge integral,
 *      plus on-axis closed forms and the far-field dipole limit.
 *   2. Packing: FieldSource stride / kind ids agree between TS, the generated
 *      WGSL and the shader struct; FieldVolumeParams size.
 *   3. Catalog: every bench row builds, has sources, finite fields, seeds
 *      inside its bounds, and the default probe sees a non-zero field.
 *   4. Volume: texel-centre convention, f16 storage, trilinear sampling.
 *   5. WGSL vs CPU: field-sources.wgsl + field-probe.wgsl executed from their
 *      own text (scripts/lib/wgsl-mini.mjs) agree with the CPU reference
 *      within 1 % at 20 points per bench — the `probe` golden — and the
 *      field-volume.wgsl brick kernel reproduces buildFieldVolume texels.
 *
 * Usage: npm run test:field-volume
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { bundleTs, ROOT } from '../test-harness.mjs';

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

let m;
before(async () => {
  m = await bundleTs({
    contents: `
      export * from './src/physics/field-sources.ts';
      export * from './src/physics/field-eval.ts';
      export * from './src/physics/field-volume.ts';
      export * from './src/physics/field-bench.ts';
      export { FIELD_BUILDER_NAMES } from './src/physics/field-builders.ts';
      export { dipoleFieldT } from './src/physics/magnetic-field.ts';
      export { computeSEGLayout } from './src/seg-layout.ts';
    `,
    sourcefile: 'field-volume-entry.ts'
  });
});

const MU0 = 1.25663706212e-6;
const relErr = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / Math.max(1e-30, Math.hypot(b[0], b[1], b[2]));
const evalOne = (list, p) => m.evaluateFieldT(p[0], p[1], p[2], list.data, list.count, [0, 0, 0]);

/** Brute-force Biot–Savart of a polyline (midpoint rule, `n` sub-elements per segment). */
function biotSavart(points, I, p, n = 4000) {
  const B = [0, 0, 0];
  for (let s = 0; s + 1 < points.length; s++) {
    const a = points[s], b = points[s + 1];
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      const dl = [(b[0] - a[0]) / n, (b[1] - a[1]) / n, (b[2] - a[2]) / n];
      const r = [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
      const r3 = Math.hypot(...r) ** 3;
      B[0] += (dl[1] * r[2] - dl[2] * r[1]) / r3;
      B[1] += (dl[2] * r[0] - dl[0] * r[2]) / r3;
      B[2] += (dl[0] * r[1] - dl[1] * r[0]) / r3;
    }
  }
  const k = (MU0 / (4 * Math.PI)) * I;
  return B.map((v) => v * k);
}

/** H of an axis-aligned cuboid (half-size h, magnetisation M) by quadrature of the face charges σ = M·n. */
function boxHQuad(h, M, p, n = 90) {
  const H = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    if (M[axis] === 0) continue;
    const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
    for (const side of [1, -1]) {
      const sigma = M[axis] * side;
      const dA = (2 * h[a1] / n) * (2 * h[a2] / n);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const q = [0, 0, 0];
        q[axis] = side * h[axis];
        q[a1] = -h[a1] + (i + 0.5) * (2 * h[a1] / n);
        q[a2] = -h[a2] + (j + 0.5) * (2 * h[a2] / n);
        const r = [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
        const r3 = Math.hypot(...r) ** 3;
        for (let c = 0; c < 3; c++) H[c] += (sigma * dA * r[c]) / r3;
      }
    }
  }
  return H.map((v) => v / (4 * Math.PI));
}

describe('1. kernels vs independent physics', () => {
  it('dipole outside the core matches magnetic-field.ts dipoleFieldT', () => {
    const list = new m.FieldSourceList().dipole([0.1, -0.2, 0.05], [3, -1, 2], 0.01);
    for (const p of [[0.4, 0.1, 0.2], [-0.3, -0.25, 0.5], [0.12, -0.2, 0.06]]) {
      const ref = m.dipoleFieldT({ x: p[0] - 0.1, y: p[1] + 0.2, z: p[2] - 0.05 }, { x: 3, y: -1, z: 2 });
      assert.ok(relErr(evalOne(list, p), [ref.x, ref.y, ref.z]) < 1e-5, `at ${p}`);
    }
  });

  it('dipole inside the core is the uniform field of a magnetised sphere (2μ0 m / 4π rc³)', () => {
    const rc = 0.05;
    const list = new m.FieldSourceList().dipole([0, 0, 0], [0, 7, 0], rc);
    const B = evalOne(list, [0.01, 0.02, -0.01]);
    const want = (2 * 1e-7 * 7) / rc ** 3;
    assert.ok(Math.abs(B[1] - want) / want < 1e-6 && Math.abs(B[0]) < 1e-12);
  });

  it('finite wire matches brute-force Biot–Savart off the wire', () => {
    const a = [-0.2, 0.05, 0.1], b = [0.3, -0.1, 0.25];
    const list = new m.FieldSourceList().segment(a, b, 12, 1e-5);
    for (const p of [[0.05, 0.2, 0.0], [0.5, 0.0, 0.3], [-0.4, -0.1, 0.1], [0.06, -0.02, 0.22]]) {
      assert.ok(relErr(evalOne(list, p), biotSavart([a, b], 12, p)) < 2e-4, `at ${p}`);
    }
  });

  it('infinite-wire limit: μ0 I / (2π d) with the right-hand sense', () => {
    const list = new m.FieldSourceList().segment([0, 0, -500], [0, 0, 500], 5, 1e-6);
    const B = evalOne(list, [0.1, 0, 0]);
    assert.ok(Math.abs(B[1] - (MU0 * 5) / (2 * Math.PI * 0.1)) / B[1] < 1e-5);
    assert.ok(B[1] > 0 && Math.abs(B[0]) < 1e-12);
  });

  it('wire core keeps the field finite on the wire', () => {
    const list = new m.FieldSourceList().segment([0, 0, -1], [0, 0, 1], 5, 1e-3);
    const B = evalOne(list, [0, 0, 0]);
    assert.ok(B.every(Number.isFinite));
  });

  for (const M of [[0, 0, 9e5], [7e5, 0, 0], [0, -6e5, 0], [3e5, 4e5, -5e5]]) {
    it(`cuboid M = ${M} matches surface-charge quadrature, outside and inside`, () => {
      const h = [0.03, 0.02, 0.05];
      const list = new m.FieldSourceList().box([0, 0, 0], h, M);
      for (const p of [[0.08, 0.01, 0.02], [0.01, -0.06, 0.09], [-0.05, 0.04, -0.07], [0.005, 0.004, -0.01]]) {
        const H = boxHQuad(h, M, p);
        const inside = Math.abs(p[0]) < h[0] && Math.abs(p[1]) < h[1] && Math.abs(p[2]) < h[2];
        const want = H.map((v, c) => MU0 * (v + (inside ? M[c] : 0)));
        assert.ok(relErr(evalOne(list, p), want) < 3e-3, `at ${p}: ${evalOne(list, p)} vs ${want}`);
      }
    });
  }

  it('a rotated cuboid equals the same cuboid evaluated in its own frame', () => {
    const q = m.yawQuat(0.7);
    const h = [0.03, 0.02, 0.05], Ml = [5e5, 0, 2e5];
    const rotated = new m.FieldSourceList().box([0.1, 0, 0], h, Ml, q);
    const plain = new m.FieldSourceList().box([0, 0, 0], h, Ml);
    const pw = [0.16, 0.03, 0.04];
    const pl = m.quatRotateInv(q, [pw[0] - 0.1, pw[1], pw[2]]);
    const want = m.quatRotate(q, evalOne(plain, pl));
    assert.ok(relErr(evalOne(rotated, pw), want) < 1e-5);
  });

  it('cuboid far field → dipole m = M·V', () => {
    const h = [0.01, 0.01, 0.01];
    const list = new m.FieldSourceList().box([0, 0, 0], h, [0, 0, 1e6]);
    const p = [0.3, 0.2, 0.4];
    const ref = m.dipoleFieldT({ x: p[0], y: p[1], z: p[2] }, { x: 0, y: 0, z: 1e6 * 8 * 1e-6 });
    assert.ok(relErr(evalOne(list, p), [ref.x, ref.y, ref.z]) < 2e-3);
  });

  it('cylinder on axis: B = μ0 K/2 · (z+/√(z+² + a²) − z−/√(z−² + a²))', () => {
    const a = 0.04, b = 0.06, K = 8e5;
    const list = new m.FieldSourceList().cylinder([0, 0, 0], [0, 0, 1], a, b, K);
    for (const z of [0, 0.03, 0.08, -0.2]) {
      const zp = z + b, zm = z - b;
      const want = (MU0 * K / 2) * (zp / Math.hypot(zp, a) - zm / Math.hypot(zm, a));
      const B = evalOne(list, [0, 0, z]);
      assert.ok(Math.abs(B[2] - want) / want < 1e-5 && Math.hypot(B[0], B[1]) < 1e-9 * Math.abs(want) + 1e-15, `z=${z}`);
    }
  });

  it('cylinder off axis matches a stack of Biot–Savart loops (solenoid sheet)', () => {
    const a = 0.04, b = 0.05, K = 1e5;
    const list = new m.FieldSourceList().cylinder([0, 0, 0], [0, 1, 0], a, b, K);
    const loops = 200, segs = 96;
    const dI = (K * 2 * b) / loops;
    for (const p of [[0.06, 0.01, 0.02], [0.02, 0.07, -0.01], [0.015, -0.02, 0.01], [0.1, 0.12, 0.05]]) {
      const B = [0, 0, 0];
      for (let L = 0; L < loops; L++) {
        const y = -b + (L + 0.5) * (2 * b / loops);
        const pts = [];
        for (let s = 0; s <= segs; s++) {
          const t = (s / segs) * 2 * Math.PI;
          pts.push([a * Math.cos(t), y, -a * Math.sin(t)]); // +y axis, counter-clockwise seen from +y
        }
        const b1 = biotSavart(pts, dI, p, 3);
        B[0] += b1[0]; B[1] += b1[1]; B[2] += b1[2];
      }
      assert.ok(relErr(evalOne(list, p), B) < 1.5e-2, `at ${p}: ${evalOne(list, p)} vs ${B}`);
    }
  });

  it('cel(1, 1, 1, 1) = π/2 and cel(kc, 1, 1, 1) = K(k)', () => {
    assert.ok(Math.abs(m.cel(1, 1, 1, 1) - Math.PI / 2) < 1e-9);
    // K(k = 0.6) = 1.750753802…, kc = 0.8
    assert.ok(Math.abs(m.cel(0.8, 1, 1, 1) - 1.7507538029157526) < 1e-7);
  });
});

describe('2. packing contracts', () => {
  const wgsl = read('src/shaders/common/field-sources.wgsl');
  const gen = read('src/shaders/generated/field-sources.wgsl');
  it('FieldSource is 4 × vec4f = FIELD_SOURCE_BYTES', () => {
    const body = wgsl.match(/struct FieldSource \{([^}]*)\}/)[1];
    assert.equal((body.match(/: vec4f/g) ?? []).length * 16, m.FIELD_SOURCE_BYTES);
    assert.equal(m.FIELD_SOURCE_FLOATS * 4, m.FIELD_SOURCE_BYTES);
  });
  it('generated WGSL kind ids match TS', () => {
    for (const k of ['DIPOLE', 'SEGMENT', 'BOX', 'CYLINDER']) {
      const v = Number(gen.match(new RegExp(`FIELD_KIND_${k}: f32 = ([\\d.]+)`))[1]);
      assert.equal(v, m[`FIELD_KIND_${k}`], k);
    }
  });
  it('μ0 literal matches', () => {
    assert.equal(Number(wgsl.match(/FIELD_MU0: f32 = ([\de.-]+)/)[1]), m.FIELD_MU0);
  });
  it('FieldSourceList grows and caps at FIELD_MAX_SOURCES', () => {
    const l = new m.FieldSourceList(1);
    for (let i = 0; i < m.FIELD_MAX_SOURCES + 10; i++) l.dipole([i, 0, 0], [0, 1, 0]);
    assert.equal(l.count, m.FIELD_MAX_SOURCES);
    assert.equal(l.data[(m.FIELD_MAX_SOURCES - 1) * 16], m.FIELD_MAX_SOURCES - 1);
  });
});

/** A plausible mid-run plant state for each catalog bench (drives non-zero). */
export const BENCH_STATES = {
  seg: {},
  maglev: { maglevGap: 0.018 },
  homopolar: { homopolarFieldT: 0.55, homopolarCurrentA: 40 },
  'halbach-viz': { halbachSegmentCount: 8, halbachMagAngleDeg: 45, halbachLayout: 'ring' },
  transformer: { transformerFluxN: 0.8, transformerIpA: 0.9, transformerIsA: -1.6 },
  'pulse-coil': { pulseCoilCurrent: 60 },
  hall: { hallFieldT: 0.4, hallCurrent: 0.8, hallVoltage: 0.012 },
  'lorentz-sled': { lorentzFieldT: 0.8, lorentzCurrentA: 15, lorentzPositionM: 0.7 },
  'jumping-ring': { ringPrimaryIA: 12, ringCurrentA: 300, ringHeightM: 0.03 }
};

export function benchInputs(mod, id) {
  return {
    state: BENCH_STATES[id] ?? {},
    time: 3.2,
    segLayout: id === 'seg' ? mod.computeSEGLayout('searl') : null,
    segOmega: 0.6,
    unitM: id === 'seg' ? 0.5 : undefined
  };
}

describe('3. catalog benches', () => {
  it('every builder name in the catalog exists', () => {
    for (const [id, decl] of Object.entries(m.FIELD_SOURCE_CATALOG)) {
      for (const g of decl.groups) if (g.builder) assert.ok(m.FIELD_BUILDER_NAMES.includes(g.builder), `${id}: ${g.builder}`);
    }
  });
  it('the done-when benches all have a row', () => {
    for (const id of ['seg', 'maglev', 'halbach-viz', 'transformer']) assert.ok(m.hasBenchField(id), id);
  });
  for (const id of Object.keys(BENCH_STATES)) {
    it(`${id}: builds, finite, seeds inside bounds, probe non-zero`, () => {
      const bench = new m.BenchField(id);
      const n = bench.rebuild(benchInputs(m, id));
      assert.ok(n > 0 && n <= m.FIELD_MAX_SOURCES, `${n} sources`);
      assert.ok(bench.seeds.count > 0, 'seeds');
      const [lo, hi] = bench.decl.bounds;
      let inside = 0;
      for (let i = 0; i < bench.seeds.count; i++) {
        const s = bench.seeds.data.subarray(i * 4, i * 4 + 3);
        if (s.every((v, c) => v >= lo[c] && v <= hi[c])) inside++;
      }
      assert.ok(inside >= bench.seeds.count * 0.8, `${inside}/${bench.seeds.count} seeds inside`);
      const B = bench.probeT(...bench.decl.probe);
      assert.ok(B.every(Number.isFinite) && Math.hypot(...B) > 1e-7, `probe |B| = ${Math.hypot(...B)}`);
    });
  }
  it('pole pairs reproduce the plant B at the centre', () => {
    for (const [id, key] of [['hall', 'hallFieldT'], ['homopolar', 'homopolarFieldT'], ['lorentz-sled', 'lorentzFieldT']]) {
      const bench = new m.BenchField(id);
      const state = { ...BENCH_STATES[id], [id === 'homopolar' ? 'homopolarCurrentA' : id === 'hall' ? 'hallCurrent' : 'lorentzCurrentA']: 0 };
      bench.rebuild({ state });
      const c = bench.decl.groups[0].params.center;
      const B = bench.probeT(...c);
      assert.ok(Math.abs(B[1] - state[key]) / state[key] < 1e-4, `${id}: ${B[1]} vs ${state[key]}`);
    }
  });
  it('pulse coil: B_z at the centre is linear in the coil current', () => {
    const bench = new m.BenchField('pulse-coil');
    const p = bench.decl.probe;
    const at = (I) => (bench.rebuild({ state: { pulseCoilCurrent: I } }), bench.probeT(...p)[1]);
    const k = at(10) / 10;
    for (const I of [-40, 25, 80]) assert.ok(Math.abs(at(I) - k * I) < 1e-6 * Math.abs(k * I));
    // ideal finite solenoid centre: μ0 N I / √(L² + 4a²)
    const a = 0.8 * bench.unitM, L = 2 * 1.37 * bench.unitM;
    assert.ok(Math.abs(k - (MU0 * 48) / Math.hypot(L, 2 * a)) / k < 1e-5);
  });
});
