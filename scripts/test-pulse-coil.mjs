#!/usr/bin/env node
/**
 * test-pulse-coil.mjs — the pulse-coil discharge integrates stably at frame dt.
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
 * Usage: node scripts/test-pulse-coil.mjs   (exit 1 on failure)
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Stub Vite's `?raw` shader-text imports so app-reaching graphs still bundle. */
const viteRawStub = {
  name: 'vite-raw-stub',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({ path: args.path, namespace: 'raw-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'raw-stub' }, () => ({ contents: 'export default "";', loader: 'js' }));
  }
};

async function importTsBundle(rel) {
  const result = await esbuild.build({
    entryPoints: [join(ROOT, rel)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    write: false,
    logLevel: 'silent',
    loader: { '.wgsl': 'text', '.glsl': 'text' },
    plugins: [viteRawStub]
  });
  return import(`data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`);
}

const failures = [];
const ok = [];
function check(label, condition, detail) {
  if (condition) ok.push(label);
  else failures.push(`${label}: ${detail}`);
}

// ── 5b. Pulse-coil discharge is stable at frame-sized steps ───────────────
{
  const pcm = await importTsBundle('src/devices/quanta/pulse-coil.ts');
  const P = pcm.PULSE_COIL;
  const w0 = 1 / Math.sqrt(P.L_H * P.C_F);
  const alpha = P.R_ohm / (2 * P.L_H);
  const wd = Math.sqrt(w0 * w0 - alpha * alpha);
  // First current peak of an underdamped series RLC released from V0: tan(wd t) = wd/alpha.
  const analyticPeak = (v0) => {
    const t = Math.atan(wd / alpha) / wd;
    return (v0 / (wd * P.L_H)) * Math.exp(-alpha * t) * Math.sin(wd * t);
  };
  const run = (dt, seconds = 6) => {
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
  const v0 = 0.85 * 0.8 * P.vChargeMax; // fires at fireFraction of drive × V_max
  const ref = analyticPeak(v0);
  for (const dt of [1 / 30, 1 / 60, 1 / 144, 1 / 600]) {
    const r = run(dt);
    const tag = `dt=1/${Math.round(1 / dt)}`;
    check(`pulse-coil ${tag}: stays finite`, r.finite, JSON.stringify({ peak: r.peak, maxV: r.maxV }));
    check(`pulse-coil ${tag}: bank never exceeds its charge (no energy gain)`, r.maxV <= v0 * 1.02 + 1, `${r.maxV} vs ${v0}`);
    check(`pulse-coil ${tag}: latched peak I within 3% of the analytic RLC peak`,
      Math.abs(r.peak - ref) / ref < 0.03, `${r.peak} vs ${ref}`);
    check(`pulse-coil ${tag}: armature travel within 8% of the fine-step reference`,
      Math.abs(r.maxX - run(1 / 4000).maxX) / run(1 / 4000).maxX < 0.08, `${r.maxX}`);
  }
  const a = run(1 / 60);
  check('pulse-coil: ring-down ends — loop is quiet between pulses', Math.abs(a.st.pulseCoilCurrent) < 1 || a.st.pulseCoilFiring, String(a.st.pulseCoilCurrent));
  // A pathological frame must not blow up or spin: 250 ms in one call.
  const big = { pulseCoilVCap: 40, pulseCoilFiring: true, pulseCoilPulseT: 0 };
  pcm.stepPulseCoilPhysics(big, 0.25, 0.8);
  check('pulse-coil: a 250 ms frame stays finite', Number.isFinite(big.pulseCoilVCap) && Number.isFinite(big.pulseCoilCurrent), JSON.stringify(big));
  // Corrupt state is contained, not propagated.
  const nan = { pulseCoilVCap: Number.NaN };
  pcm.stepPulseCoilPhysics(nan, 1 / 60, 0.8);
  check('pulse-coil: a NaN state resets to a quiet bank instead of poisoning telemetry',
    Number.isFinite(nan.pulseCoilVCap) && Number.isFinite(nan.pulseCoilCurrent), JSON.stringify(nan));
}

for (const line of ok) console.log(`  ok: ${line}`);
if (failures.length) {
  for (const line of failures) console.error(`  FAIL: ${line}`);
  console.error(`[pulse-coil] ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`[pulse-coil] ${ok.length} checks passed`);
