/**
 * pulse-coil — the pulse-coil discharge integrates stably at frame dt.
 *
 * The capacitor-bank loop rings at ω₀ = 1/√(LC) ≈ 615 rad/s (a ~10 ms period),
 * which is stiff next to a 16 ms frame. It used to be forward Euler, one step per
 * frame, and went to NaN at 1/60 s. It is now RK4 in substeps, so:
 *
 *   1. Finite at 1/30 s … 1/600 s frames, and the bank never gains energy.
 *   2. The latched peak current is within 3% of the analytic underdamped-RLC
 *      peak at every dt (it is taken over the substeps, not sampled per frame).
 *   3. Armature travel is dt-independent to 8%.
 *   4. A pathological 250 ms frame and a NaN state are contained.
 *
 * Usage: npm run test:pulse-coil   (node --test scripts/tests/pulse-coil.test.mjs)
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { bundleTs } from '../test-harness.mjs';

describe('pulse-coil discharge at frame-sized steps', () => {
  let pcm, P, run, v0, ref, fine;
  before(async () => {
    pcm = await bundleTs('src/devices/quanta/pulse-coil.ts');
    P = pcm.PULSE_COIL;
    const w0 = 1 / Math.sqrt(P.L_H * P.C_F);
    const alpha = P.R_ohm / (2 * P.L_H);
    const wd = Math.sqrt(w0 * w0 - alpha * alpha);
    // First current peak of an underdamped series RLC released from V0: tan(wd t) = wd/alpha.
    const analyticPeak = (v) => {
      const t = Math.atan(wd / alpha) / wd;
      return (v / (wd * P.L_H)) * Math.exp(-alpha * t) * Math.sin(wd * t);
    };
    run = (dt, seconds = 6) => {
      const st = { pulseCoilVCap: 0 };
      let peak = 0, maxV = 0, maxX = 0, finite = true;
      for (let i = 0; i < Math.round(seconds / dt); i++) {
        pcm.stepPulseCoilPhysics(st, dt, 0.8);
        peak = Math.max(peak, st.pulseCoilPeakIA);
        maxV = Math.max(maxV, Math.abs(st.pulseCoilVCap));
        maxX = Math.max(maxX, st.pulseCoilArmatureMm);
        for (const k of ['pulseCoilCurrent', 'pulseCoilVCap', 'pulseCoilArmatureMm', 'pulseCoilBPeakT', 'pulseCoilCurrentA']) {
          if (!Number.isFinite(st[k])) finite = false;
        }
      }
      return { peak, maxV, maxX, finite, st };
    };
    v0 = 0.85 * 0.8 * P.vChargeMax; // fires at fireFraction of drive × V_max
    ref = analyticPeak(v0);
    fine = run(1 / 4000);
  });

  for (const dt of [1 / 30, 1 / 60, 1 / 144, 1 / 600]) {
    const tag = `dt=1/${Math.round(1 / dt)}`;
    it(`${tag}: finite, no energy gain, RLC peak within 3%, travel within 8%`, () => {
      const r = run(dt);
      assert.ok(r.finite, `stays finite: ${JSON.stringify({ peak: r.peak, maxV: r.maxV })}`);
      assert.ok(r.maxV <= v0 * 1.02 + 1, `bank never exceeds its charge: ${r.maxV} vs ${v0}`);
      assert.ok(Math.abs(r.peak - ref) / ref < 0.03, `latched peak I: ${r.peak} vs ${ref}`);
      assert.ok(Math.abs(r.maxX - fine.maxX) / fine.maxX < 0.08, `armature travel: ${r.maxX} vs ${fine.maxX}`);
    });
  }

  it('ring-down ends — loop is quiet between pulses', () => {
    const a = run(1 / 60);
    assert.ok(Math.abs(a.st.pulseCoilCurrent) < 1 || a.st.pulseCoilFiring, String(a.st.pulseCoilCurrent));
  });

  it('a 250 ms frame stays finite', () => {
    const big = { pulseCoilVCap: 40, pulseCoilFiring: true, pulseCoilPulseT: 0 };
    pcm.stepPulseCoilPhysics(big, 0.25, 0.8);
    assert.ok(Number.isFinite(big.pulseCoilVCap) && Number.isFinite(big.pulseCoilCurrent), JSON.stringify(big));
  });

  it('a NaN state resets to a quiet bank instead of poisoning telemetry', () => {
    const nan = { pulseCoilVCap: Number.NaN };
    pcm.stepPulseCoilPhysics(nan, 1 / 60, 0.8);
    assert.ok(Number.isFinite(nan.pulseCoilVCap) && Number.isFinite(nan.pulseCoilCurrent), JSON.stringify(nan));
  });
});
