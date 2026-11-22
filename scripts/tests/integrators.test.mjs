/**
 * integrators — the shared ODE integrators (#254 §2), native and TS.
 *
 *   1. native  `sim_core_test --mode integrators` compares every method on
 *      every shared-integrator plant against the reference it replaced (the
 *      jumping ring's 20k-substep RK4) and fails when the catalog's adaptive
 *      method misses its budget: ≥ 10× fewer RHS calls, err ≤ 5e-4 of each
 *      channel's amplitude. Its analytic checks (oscillator, λ = 1e4 stiff
 *      linear, RK4 order) must all pass.
 *   2. TS      src/renderers/shared/integrate.ts over the same schedules,
 *      through the real plant steps: the same budget, and an RHS count
 *      within 3 % of the native run — the float and double plants take the
 *      same adaptive path, not merely land near each other.
 *   3. TS analytic checks, the same closed forms as the native ones.
 *
 * JS ⇄ native *values* per integrator are test:golden's job (the
 * `jumping-ring@dopri5` etc. cases); this file is about cost and accuracy.
 *
 * Usage: npm run test:integrators   (node --test scripts/tests/integrators.test.mjs)
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { bundleTs, ROOT } from '../test-harness.mjs';

const NATIVE = join(ROOT, 'cpp', 'build', 'sim_core_test');
const MIN_RATIO = 10;
const MAX_ERR = 5e-4;

const ENTRY = `
export { createJumpingRingPhysicsState, stepJumpingRingPhysics } from './src/devices/quanta/jumping-ring.ts';
export { createHomopolarPhysicsState, stepHomopolarPhysics } from './src/devices/quanta/homopolar-generator.ts';
export * from './src/renderers/shared/integrate.ts';
export { PLANT_ODE } from './generated/plant-ode.ts';
`;
const js = await bundleTs({ contents: ENTRY, sourcefile: 'integrators-entry.ts' });

// ── 1. native ───────────────────────────────────────────────────────────
const nativeExists = existsSync(NATIVE);
const run = nativeExists ? spawnSync(NATIVE, ['--mode', 'integrators'], { encoding: 'utf8' }) : null;
const native = new Map();
const analytic = [];
for (const line of run?.stdout?.split('\n') ?? []) {
  const c = line.match(/^integrators\.case (\S+) (.*)$/);
  if (c) {
    const kv = Object.fromEntries(c[2].trim().split(/\s+/).map((p) => p.split('=')));
    native.set(`${c[1]}@${kv.method}`, kv);
  }
  const a = line.match(/^integrators\.analytic (\S+) value=(\S+) limit=(\S+) (ok|FAIL)$/);
  if (a) analytic.push({ what: a[1], value: Number(a[2]), limit: Number(a[3]), ok: a[4] === 'ok' });
}

describe('native --mode integrators', () => {
  it('runs and exits 0', () => {
    assert.ok(nativeExists, 'native binary missing at cpp/build/sim_core_test — run `npm run wasm:native` first');
    if (run.status !== 0) process.stderr.write(run.stderr);
    assert.equal(run.status, 0, 'native --mode integrators failed (budget or analytic check — see stderr)');
    assert.ok(/^integrators\.done /m.test(run.stdout), 'no integrators.done line');
  });
  it('every analytic check passes', () => {
    assert.ok(analytic.length >= 6, `expected ≥ 6 analytic checks, got ${analytic.length}`);
    for (const a of analytic) assert.ok(a.ok, `${a.what}: ${a.value} vs limit ${a.limit}`);
  });
  for (const [id, spec] of Object.entries(js.PLANT_ODE)) {
    if (!js.isAdaptive(spec.integrator)) continue;
    it(`${id}: catalog ${spec.integrator} ≥ ${MIN_RATIO}× fewer RHS than the reference, err ≤ ${MAX_ERR}`, () => {
      const kv = native.get(`${id}@${spec.integrator}`);
      assert.ok(kv, `no native case for ${id}@${spec.integrator}`);
      assert.ok(Number(kv.ratio) >= MIN_RATIO, `ratio ${kv.ratio}`);
      assert.ok(Number(kv['err.max']) <= MAX_ERR, `err.max ${kv['err.max']}`);
    });
  }
});

// ── 2. TS plants over the same schedules ─────────────────────────────────
const PLANTS = {
  'jumping-ring': {
    create: js.createJumpingRingPhysicsState,
    step: js.stepJumpingRingPhysics,
    read: (s) => [s.ringPrimaryIA, s.ringCurrentA, s.ringVelocityMps, s.ringHeightM],
  },
  homopolar: {
    create: js.createHomopolarPhysicsState,
    step: js.stepHomopolarPhysics,
    read: (s) => [s.homopolarOmega, s.homopolarCurrentA],
  },
};

function trace(id, method, frames, dt, drive) {
  const p = PLANTS[id];
  const s = p.create();
  s.integratorOverride = method;
  js.resetOdeStats();
  const xs = [];
  for (let i = 0; i < frames; i++) {
    p.step(s, dt, drive);
    xs.push(p.read(s));
  }
  return { xs, rhs: js.odeStats.rhs };
}

function compare(ref, tr) {
  const n = ref.xs[0].length;
  const amp = Array(n).fill(0);
  for (const r of ref.xs) for (let i = 0; i < n; i++) amp[i] = Math.max(amp[i], Math.abs(r[i]));
  let err = 0;
  tr.xs.forEach((x, f) => {
    for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(x[i] - ref.xs[f][i]) / (amp[i] || 1));
  });
  return { err, ratio: ref.rhs / tr.rhs };
}

describe('TS mirror (src/renderers/shared/integrate.ts)', () => {
  for (const id of Object.keys(PLANTS)) {
    const any = native.get(`${id}@rk4`);
    if (!any) continue;
    const frames = Number(any.frames);
    const dt = Number(any.dt);
    const drive = Number(any.drive);
    const ref = trace(id, 'rk4', frames, dt, drive);
    for (const method of ['dopri5', 'ros23']) {
      it(`${id}@${method}: RHS count within 3 % of native, budget when it is the catalog method`, () => {
        const tr = trace(id, method, frames, dt, drive);
        const { err, ratio } = compare(ref, tr);
        const kv = native.get(`${id}@${method}`);
        // Native ros23 takes J from one Dual evaluation (core/dual.h, #257);
        // the TS mirror differences it, n RHS per Jacobian. Same path ⇔ the
        // TS count matches native RHS + n·jacobians.
        const nativeRhs = Number(kv.rhs) + (method === 'ros23' ? Number(kv.n) * Number(kv.jac) : 0);
        assert.ok(Number.isFinite(nativeRhs), `native case line lacks rhs / jac / n: ${JSON.stringify(kv)}`);
        assert.ok(Math.abs(tr.rhs - nativeRhs) <= 0.03 * nativeRhs,
          `TS ${tr.rhs} RHS vs native ${nativeRhs} — the plants left each other's adaptive path`);
        assert.ok(Math.abs(err - Number(kv['err.max'])) <= 0.5 * Number(kv['err.max']) + 1e-6,
          `TS err ${err.toExponential(2)} vs native ${kv['err.max']}`);
        if (js.PLANT_ODE[id].integrator === method) {
          assert.ok(ratio >= MIN_RATIO, `TS ratio ${ratio.toFixed(2)}`);
          assert.ok(err <= MAX_ERR, `TS err ${err.toExponential(2)}`);
        }
      });
    }
  }
});

// ── 3. TS analytic checks ────────────────────────────────────────────────
describe('TS analytic checks', () => {
  const dt = 1 / 60;
  const osc = {
    stateSize: 2,
    derivs(_t, x, u, d) { d[0] = x[1]; d[1] = -u.omega * u.omega * x[0]; },
  };
  for (const [method, rtol, limit] of [['dopri5', 1e-8, 1e-6], ['ros23', 1e-5, 2e-2]]) {
    it(`oscillator, ${method}: dense output keeps phase over 10 periods`, () => {
      const x = new Float64Array([1, 0]);
      const st = { h: 0, errOld: 1e-4 };
      const u = { omega: 2 * Math.PI };
      let errMax = 0;
      for (let f = 1; f <= 600; f++) {
        const s = js.advanceAdaptive(method, osc, x, u, dt, { rtol, atol: [rtol / 10, rtol / 10] }, st);
        assert.ok(s.ok);
        errMax = Math.max(errMax, Math.abs(x[0] - Math.cos(u.omega * f * dt)));
      }
      assert.ok(errMax <= limit, `err ${errMax.toExponential(2)} > ${limit}`);
    });
  }

  it('stiff λ = 1e4: ros23 ≥ 20× fewer steps than dopri5, both accurate', () => {
    const p = {
      stateSize: 1,
      derivs(t, x, u, d) { const tt = u.t0 + t; d[0] = -1e4 * (x[0] - Math.cos(tt)) - Math.sin(tt); },
    };
    const steps = {};
    for (const m of ['dopri5', 'ros23']) {
      const x = new Float64Array([1]);
      const st = { h: 0, errOld: 1e-4 };
      steps[m] = 0;
      for (let f = 0; f < 60; f++) {
        const s = js.advanceAdaptive(m, p, x, { t0: f * dt }, dt, { rtol: 1e-4, atol: [1e-6] }, st);
        steps[m] += s.steps;
        assert.ok(Math.abs(x[0] - Math.cos((f + 1) * dt)) <= 1e-3, `${m} error at frame ${f}`);
      }
    }
    assert.ok(steps.ros23 * 20 <= steps.dopri5, `ros23 ${steps.ros23} vs dopri5 ${steps.dopri5} steps`);
  });

  it('rk4Fixed is fourth order (halving h cuts the error ~16×)', () => {
    const g = { stateSize: 1, derivs(_t, x, _u, d) { d[0] = x[0]; } };
    const errAt = (n) => {
      const x = new Float64Array([1]);
      for (let i = 0; i < n; i++) js.rk4Fixed(g, 0, 2 / n, x, null);
      return Math.abs(x[0] - Math.exp(2));
    };
    const ratio = errAt(8) / errAt(16);
    assert.ok(ratio > 14 && ratio < 17, `ratio ${ratio}`);
  });

  it('eulerFixed / rk4Fixed apply the plant constraint; rk4Fixed refuses a non-finite step', () => {
    const p = { stateSize: 1, derivs(_t, _x, _u, d) { d[0] = -10; }, constrain(x) { const c = x[0] < 0; if (c) x[0] = 0; return c; } };
    const x = new Float64Array([0.5]);
    js.eulerFixed(p, 0, 1, x, null);
    assert.equal(x[0], 0);
    const bad = { stateSize: 1, derivs(_t, _x, _u, d) { d[0] = Infinity; } };
    const y = new Float64Array([1]);
    assert.equal(js.rk4Fixed(bad, 0, 0.1, y, null).ok, false);
    assert.equal(y[0], 1, 'x untouched');
  });
});
