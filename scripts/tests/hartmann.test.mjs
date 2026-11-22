/**
 * MHD duct: the analytic Hartmann profile and the parcels that draw it.
 *
 *   1. physics/hartmann.ts against the textbook closed form and its limits
 *   2. the C++ twin (`sim_core_test --mode hartmann`) against the TS one,
 *      and the native parcel check (lanes kept, speed = u(y))
 *   3. devices/core/mhd-parcels.ts: timelines take the profile's shape, travel
 *      integrates the mean speed, a flow change never moves a parcel
 *   4. the plant's Hartmann range for the catalog constants
 *   5. the overlay's curves and readout
 *
 * The WGSL twin (`posMhd`) is held to mhdParcelPosition on a real GPU by
 * scripts/tests/gpu/golden-particles.test.mjs.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ROOT, bundleTs } from '../test-harness.mjs';

const m = await bundleTs({
  contents: `
    export * as H from './src/physics/hartmann.ts';
    export * as P from './src/devices/core/mhd-parcels.ts';
    export * as O from './src/mhd-profile-overlay.ts';
    export { createMhdPhysicsState, stepMhdPhysics } from './src/devices/core/mhd-mesh.ts';
    export { MHD } from './generated/physics-constants.ts';
  `,
  sourcefile: 'hartmann-entry.ts'
});
const { H, P, O, MHD } = m;

/** The formula as the textbooks print it (overflows past Ha ≈ 700; fine here). */
const textbook = (eta, ha) => (Math.cosh(ha) - Math.cosh(ha * eta)) / (Math.cosh(ha) - Math.sinh(ha) / ha);

/** Composite Simpson over η ∈ [−1, 1] with layers resolved: n panels, even. */
function mean(f, n = 20000) {
  let s = f(-1) + f(1);
  for (let i = 1; i < n; i++) s += f(-1 + (2 * i) / n) * (i % 2 ? 4 : 2);
  return (s * (2 / n)) / 3 / 2;
}

describe('1. Hartmann profile (physics/hartmann.ts)', () => {
  it('is the textbook closed form at Ha = 1, 5, 20', () => {
    for (const ha of [1, 5, 20]) {
      for (let i = 0; i <= 40; i++) {
        const eta = -1 + i / 20;
        assert.ok(Math.abs(H.hartmannProfile(eta, ha) - textbook(eta, ha)) < 1e-12, `Ha ${ha}, η ${eta}`);
      }
    }
  });

  it('Ha → 0 is the Poiseuille parabola 1.5·(1 − η²)', () => {
    for (let i = 0; i <= 20; i++) {
      const eta = -1 + i / 10;
      assert.ok(Math.abs(H.hartmannProfile(eta, 0) - 1.5 * (1 - eta * eta)) < 1e-15);
      assert.ok(Math.abs(H.hartmannShape(eta, 0) - (1 - eta * eta)) < 1e-15);
    }
    assert.equal(H.hartmannCentre(0), 1.5);
    assert.equal(H.hartmannWallShear(0), 3);
  });

  it('integrates to the mean speed at every Ha, 0 to 1895', () => {
    for (const ha of [0, 0.02, 0.24, 0.25, 0.3, 1, 3.79, 5, 11.4, 18.95, 20, 400, 1895]) {
      const got = mean((eta) => H.hartmannProfile(eta, ha), ha > 100 ? 400000 : 20000);
      assert.ok(Math.abs(got - 1) < 2e-6, `Ha ${ha}: mean ${got}`);
    }
  });

  it('is zero on the walls, even, and finite at Ha far past cosh overflow', () => {
    for (const ha of [0, 5, 20, 1895, 1e5]) {
      assert.equal(H.hartmannProfile(1, ha), 0);
      assert.equal(H.hartmannProfile(-1, ha), 0);
      assert.equal(H.hartmannProfile(-0.37, ha), H.hartmannProfile(0.37, ha));
      assert.ok(Number.isFinite(H.hartmannProfile(0.999, ha)));
      // Outside the gap clamps to the wall rather than going negative.
      assert.equal(H.hartmannProfile(1.4, ha), 0);
    }
  });

  it('series and closed form meet at the hand-over', () => {
    const below = H.HARTMANN_SERIES_BELOW * (1 - 1e-9);
    const at = H.HARTMANN_SERIES_BELOW;
    // The series drops its Ha⁴ term: about 7e-6 relative at Ha = 0.25.
    for (const eta of [0, 0.3, 0.7, 0.95]) {
      assert.ok(Math.abs(H.hartmannProfile(eta, below) - H.hartmannProfile(eta, at)) < 2e-5);
      assert.ok(Math.abs(H.hartmannShape(eta, below) - H.hartmannShape(eta, at)) < 2e-5);
    }
    assert.ok(Math.abs(H.hartmannCentre(below) - H.hartmannCentre(at)) < 2e-5);
    assert.ok(Math.abs(H.hartmannWallShear(below) - H.hartmannWallShear(at)) < 2e-4);
  });

  it('raising Ha flattens the core: u(0)/Ū falls 1.5 → 1, u(η)/u(0) rises', () => {
    const has = [0, 1, 3.79, 5, 11.4, 18.95, 50, 400];
    for (let i = 1; i < has.length; i++) {
      assert.ok(H.hartmannCentre(has[i]) < H.hartmannCentre(has[i - 1]), `centre at Ha ${has[i]}`);
      assert.ok(H.hartmannShape(0.8, has[i]) > H.hartmannShape(0.8, has[i - 1]), `shape at Ha ${has[i]}`);
    }
    assert.ok(Math.abs(H.hartmannCentre(400) - 1 / (1 - 1 / 400)) < 1e-9);
    // Over the bench's own range the change is large enough to see.
    assert.ok(H.hartmannCentre(3.79) - H.hartmannCentre(18.95) > 0.2);
    assert.ok(H.hartmannShape(0.8, 18.95) > 0.97 && H.hartmannShape(0.8, 3.79) < 0.6);
  });

  it('shape = profile / centre', () => {
    for (const ha of [0, 0.03, 0.2, 2, 20, 400]) {
      for (const eta of [0, 0.25, 0.9]) {
        // Exact above the hand-over; below it the three series agree to their Ha⁴ terms.
        assert.ok(Math.abs(H.hartmannShape(eta, ha) * H.hartmannCentre(ha) - H.hartmannProfile(eta, ha)) < 1e-5);
      }
    }
  });

  it('wall shear is the slope at the wall: 3 → Ha', () => {
    for (const ha of [0.5, 5, 20]) {
      const d = 1e-6;
      const slope = (H.hartmannProfile(1 - d, ha) - H.hartmannProfile(1, ha)) / d;
      assert.ok(Math.abs(slope - H.hartmannWallShear(ha)) / H.hartmannWallShear(ha) < 1e-4, `Ha ${ha}`);
    }
    assert.ok(Math.abs(H.hartmannWallShear(1000) - 1001) < 0.01);
  });

  it('sampleHartmannProfile spans the gap wall to wall', () => {
    const s = H.sampleHartmannProfile(5, 9);
    assert.equal(s.length, 9);
    assert.equal(s[0], 0);
    assert.equal(s[8], 0);
    assert.ok(Math.abs(s[4] - H.hartmannCentre(5)) < 1e-12);
  });
});

const NATIVE = join(ROOT, 'cpp/build/sim_core_test');
const nativeExists = existsSync(NATIVE);
const native = nativeExists ? spawnSync(NATIVE, ['--mode', 'hartmann'], { encoding: 'utf8' }) : null;

describe('2. C++ twin (sim_core_test --mode hartmann)', () => {
  it('native binary exists', () => {
    assert.ok(nativeExists, 'cpp/build/sim_core_test missing. Run `npm run wasm:native` first (npm run validate does).');
  });

  it('exits 0: parcels keep their lanes and advect at u(y)', { skip: !nativeExists }, () => {
    assert.equal(native.status, 0, native.stdout.split('\n').filter((l) => /FAIL/.test(l)).join('\n'));
    assert.match(native.stdout, /^hartmann\.parcels .*moved=\d+ maxErr=/m);
    assert.match(native.stdout, /^Hartmann profile OK$/m);
  });

  it('profile, shape and wall shear agree with the TS twin to float precision', { skip: !nativeExists }, () => {
    let profiles = 0;
    let walls = 0;
    for (const line of native.stdout.split('\n')) {
      const p = line.match(/^hartmann\.profile (\S+) (\S+) (\S+) (\S+)$/);
      if (p) {
        const [ha, eta, profile, shape] = p.slice(1).map(Number);
        // C++ evaluates in float. Worst just above the series hand-over, where
        // 1 − tanh(Ha)/Ha has lost three digits: 5e-5 relative, 5e-6 near the wall.
        const tol = (v) => 5e-6 + 5e-5 * Math.abs(v);
        const tsProfile = H.hartmannProfile(eta, ha);
        const tsShape = H.hartmannShape(eta, ha);
        assert.ok(Math.abs(profile - tsProfile) < tol(tsProfile), `profile Ha ${ha} η ${eta}: ${profile} vs ${tsProfile}`);
        assert.ok(Math.abs(shape - tsShape) < tol(tsShape), `shape Ha ${ha} η ${eta}: ${shape} vs ${tsShape}`);
        profiles++;
      }
      const w = line.match(/^hartmann\.wall (\S+) (\S+)$/);
      if (w) {
        const [ha, shear] = w.slice(1).map(Number);
        const ts = H.hartmannWallShear(ha);
        assert.ok(Math.abs(shear - ts) < 2e-4 * ts, `wall shear Ha ${ha}: ${shear} vs ${ts}`);
        walls++;
      }
    }
    assert.equal(profiles, 13 * 21);
    assert.equal(walls, 13);
  });
});

describe('3. parcels (devices/core/mhd-parcels.ts)', () => {
  const D = P.MHD_DUCT;

  it('every parcel is inside the drawn duct, at any travel and Ha', () => {
    for (const ha of [0, 3.79, 18.95, 1895]) {
      for (const travel of [0, 0.31, 0.999]) {
        for (let idx = 0; idx < 4096; idx += 7) {
          const [x, y, z] = P.mhdParcelPosition(idx, travel, ha);
          assert.ok(x >= D.xIn - 1e-9 && x <= D.xIn + D.lengthU + 1e-9, `x ${x}`);
          assert.ok(Math.abs(y) <= D.halfGapU + 1e-9 && Math.abs(z) <= D.halfWidthU + 1e-9);
        }
      }
    }
  });

  it('lanes are fixed and fill the gap evenly', () => {
    const bins = new Array(10).fill(0);
    for (let idx = 0; idx < 8000; idx++) {
      const a = P.mhdParcelPosition(idx, 0.1, 5);
      const b = P.mhdParcelPosition(idx, 0.6, 19);
      assert.equal(a[1], b[1]);
      assert.equal(a[2], b[2]);
      bins[Math.min(9, Math.floor(((a[1] / D.halfGapU + 1) / 2) * 10))]++;
    }
    for (const n of bins) assert.ok(Math.abs(n - 800) < 40, `uneven lanes: ${bins}`);
  });

  it('a timeline has the shape of the profile: x − xIn = L·τ·u(η)/u(0)', () => {
    for (const ha of [0, 5, 20]) {
      const travel = 0.4;
      for (let idx = 0; idx < 2000; idx++) {
        const { line, eta } = P.mhdParcelLane(idx);
        const tau = (travel + line / D.timelines) % 1;
        const [x] = P.mhdParcelPosition(idx, travel, ha);
        assert.ok(Math.abs(x - (D.xIn + D.lengthU * tau * H.hartmannShape(eta, ha))) < 1e-5);
      }
    }
  });

  it('parcels move at u(y): displacement over a small travel step ∝ the profile', () => {
    const ha = 11.4;
    const dTravel = 1e-3;
    for (let idx = 0; idx < 400; idx++) {
      const { eta } = P.mhdParcelLane(idx);
      const [x0] = P.mhdParcelPosition(idx, 0.01, ha);
      const [x1] = P.mhdParcelPosition(idx, 0.01 + dTravel, ha);
      assert.ok(Math.abs((x1 - x0) - D.lengthU * dTravel * H.hartmannShape(eta, ha)) < 2e-6);
    }
  });

  it('travel integrates Ū·u(0)/Ū / length on the slowed clock', () => {
    const state = { mhdFlowU: 1.8, mhdHartmann: 18.95 };
    assert.equal(P.advanceMhdTravel(state, 10), 0, 'first call only starts the clock');
    let t = 10;
    for (let i = 0; i < 30; i++) { t += 1 / 60; P.advanceMhdTravel(state, t); }
    const expected = (1.8 * H.hartmannCentre(18.95)) / MHD.lengthM / P.MHD_PARCEL_SLOWDOWN * 0.5;
    assert.ok(Math.abs(state._mhdTravel - (expected % 1)) < 1e-9, `${state._mhdTravel} vs ${expected % 1}`);
    assert.ok(Math.abs(P.mhdCentreTransitHz(1.8, 18.95) - expected * 2) < 1e-12);
  });

  it('is idempotent within a frame, ignores time running backwards, and caps a long gap', () => {
    const state = { mhdFlowU: 2, mhdHartmann: 5 };
    P.advanceMhdTravel(state, 0);
    const a = P.advanceMhdTravel(state, 0.016);
    assert.equal(P.advanceMhdTravel(state, 0.016), a);
    assert.equal(P.advanceMhdTravel(state, 0.001), a, 'time went backwards');
    const b = P.advanceMhdTravel(state, 500);
    const capped = (a + P.mhdCentreTransitHz(2, 5) * 0.1) % 1;
    assert.ok(Math.abs(b - capped) < 1e-12, 'a resumed tab advances one capped step');
  });

  it('no flow, no motion; NaN speed is no flow', () => {
    for (const mhdFlowU of [0, -1, Number.NaN]) {
      const state = { mhdFlowU, mhdHartmann: 10 };
      P.advanceMhdTravel(state, 0);
      assert.equal(P.advanceMhdTravel(state, 0.05), 0);
    }
  });

  it('a change of speed changes the rate, not the position', () => {
    const state = { mhdFlowU: 1, mhdHartmann: 10 };
    P.advanceMhdTravel(state, 0);
    const before = P.advanceMhdTravel(state, 1 / 60);
    state.mhdFlowU = 4;
    // Same instant, faster flow: nothing has moved yet.
    assert.equal(P.advanceMhdTravel(state, 1 / 60), before);
    const after = P.advanceMhdTravel(state, 2 / 60);
    assert.ok(Math.abs((after - before) - P.mhdCentreTransitHz(4, 10) / 60) < 1e-12);
  });
});

describe('4. the plant reports a Hartmann number in the range the picture can show', () => {
  const haAt = (drive) => {
    const s = m.createMhdPhysicsState();
    for (let i = 0; i < 600; i++) m.stepMhdPhysics(s, 1 / 60, drive);
    return s;
  };

  it('Ha = B·a·√(σ/ρν): about 3.8 at 0.2 T, about 19 at 1.0 T', () => {
    const perTesla = MHD.halfGapM * Math.sqrt(MHD.sigmaSm / (MHD.rhoKgM3 * MHD.nuM2s));
    assert.ok(Math.abs(perTesla - 18.95) < 0.01, `Ha per tesla ${perTesla}`);
    const lo = haAt(0);
    const hi = haAt(1);
    assert.ok(Math.abs(lo.mhdHartmann - perTesla * MHD.bFieldBaseT) < 1e-9);
    assert.ok(Math.abs(hi.mhdHartmann - perTesla * (MHD.bFieldBaseT + MHD.bFieldSpanT)) < 1e-9);
    assert.ok(lo.mhdHartmann > 3 && hi.mhdHartmann < 25);
  });

  it('the slot duct is laminar where the solution is used: Re/Ha < 250', () => {
    for (const drive of [0.1, 0.25, 0.5, 1]) {
      const s = haAt(drive);
      const re = (s.mhdFlowU * MHD.halfGapM) / MHD.nuM2s;
      assert.ok(re / s.mhdHartmann < 250, `drive ${drive}: Re ${re.toFixed(0)}, Ha ${s.mhdHartmann.toFixed(1)}`);
    }
  });
});

describe('5. profile overlay (mhd-profile-overlay.ts)', () => {
  it('curves: the live profile beside the B = 0 parabola, wall to wall', () => {
    const c = O.mhdProfileCurves(18.95);
    assert.equal(c.eta[0], -1);
    assert.equal(c.eta[c.eta.length - 1], 1);
    const mid = (c.eta.length - 1) / 2;
    assert.equal(c.parabola[mid], 1.5);
    assert.ok(Math.abs(c.live[mid] - H.hartmannCentre(18.95)) < 1e-12);
    assert.equal(c.live[0], 0);
    assert.equal(c.parabola[0], 0);
    // Flatter in the core, steeper at the wall than the parabola.
    assert.ok(c.live[mid] < c.parabola[mid]);
    assert.ok(c.live[2] > c.parabola[2]);
    assert.ok(Math.abs(c.layerM - MHD.halfGapM / 18.95) < 1e-12);
  });

  it('non-finite or negative Ha falls back to a drawable curve', () => {
    for (const ha of [Number.NaN, Infinity, -7]) {
      const c = O.mhdProfileCurves(ha);
      assert.ok(c.live.every(Number.isFinite), `Ha ${ha}`);
    }
    assert.equal(O.mhdProfileCurves(-7).hartmann, 7);
  });

  it('plot mapping: +a at the top, the wall on the axis, 1.5 Ū inside the plot', () => {
    const [x0, yTop] = O.mhdProfilePlotPoint(0, 1);
    const [x15, yBot] = O.mhdProfilePlotPoint(1.5, -1);
    assert.ok(yTop < yBot);
    assert.ok(x15 > x0 && x15 < 208);
    assert.equal(O.mhdProfilePlotPoint(-3, 0)[0], x0, 'negative speed clamps to the axis');
  });

  it('summary reads the regime in words', () => {
    assert.match(O.mhdProfileSummary(O.mhdProfileCurves(18.95), 1.82),
      /^Ha 18\.9: centre speed 1\.06 × the mean 1\.82 m\/s \(1\.50 × at B = 0\), Hartmann layer 26\.4 µm$/);
    assert.match(O.mhdProfileSummary(O.mhdProfileCurves(0), 0), /no distinct Hartmann layer$/);
  });

  it('shows only in MHD focus and redraws only when the plant moves', () => {
    let push;
    const overlay = new O.MhdProfileOverlay({ subscribe: (fn) => { push = fn; return () => {}; } });
    const snap = (view, mhdHartmann, mhdFlowU) => ({ view, devices: { mhd: { mhdHartmann, mhdFlowU } } });
    push(snap('seg', 10, 1));
    assert.equal(overlay.stats().active, false);
    // No DOM in node: the card cannot mount, but the state still tracks the plant.
    push(snap('mhd', 11.4, 1.7));
    assert.equal(overlay.stats().hartmann, 11.4);
    assert.ok(Math.abs(overlay.stats().centre - H.hartmannCentre(11.4)) < 1e-12);
    push(snap('mhd', 11.401, 1.7));
    assert.equal(overlay.stats().hartmann, 11.4, 'a sub-threshold change is not a redraw');
    push(snap('mhd', 18.95, 1.85));
    assert.equal(overlay.stats().hartmann, 18.95);
    overlay.destroy();
  });
});
