#!/usr/bin/env node
/**
 * test-drop-tube.mjs — the Lenz drop tube settles at its algebraic terminal
 * velocity, and the closed forms behind it are the integrals they claim to be.
 *
 *   1. k = (45/1024)·(Br·V)²·σ·w/a⁴ equals 2π·a·σ·w·∫B_ρ² dz for a point dipole
 *      (numerical quadrature), so the coefficient is the integral, not a typo.
 *   2. The end taper is that integral over the tube only: 0.5 at each end,
 *      → 1 inside, → 0 outside — checked against quadrature at several depths.
 *   3. The eddy-loop currents are ∫σ·w·v·B_ρ dz on each side of the magnet.
 *   4. Mid-tube the plant sits at m·g/k to 0.1%, the drag equals the weight,
 *      and the power the drag takes out equals m·g·v (nothing gained).
 *   5. Terminal velocity forgets the entry speed: every clamp height leaves the
 *      middle of the tube at the same v.
 *   6. σ = 0 is free fall (exit speed √(2g·h)), and reports no terminal velocity.
 *   7. The exponential step agrees with an independent fine RK4 of the same ODE,
 *      and the transit time is dt-independent from 1/30 s to 1/600 s frames.
 *   8. The demo cycles (release → land → re-clamp), drive 0 holds the magnet,
 *      a pinned σ is honoured / clamped / released, and a corrupt state or a
 *      pathological frame is contained.
 *
 * Usage: node scripts/test-drop-tube.mjs   (exit 1 on failure)
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
const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-30);

const dt = await importTsBundle('src/devices/quanta/drop-tube.ts');
const consts = await importTsBundle('generated/physics-constants.ts');
const T = dt.TUBE;
const G = consts.PHYSICAL_CONSTANTS.G;
const MU0 = consts.PHYSICAL_CONSTANTS.MU_0;
const a = T.tubeMeanRadiusM;
const L = T.tubeLengthM;
const V = Math.PI * T.magnetRadiusM ** 2 * T.magnetLengthM;
const p = (T.magnetBrT * V) / MU0; // dipole moment, A·m²
const m = dt.MAGNET_MASS_KG;
const sigma = T.tubeSigmaMSm * 1e6;

/** B_ρ of a point dipole on the axis, at the wall, a distance z along the axis. */
const bRho = (z) => (MU0 * p / (4 * Math.PI)) * 3 * z * a / (z * z + a * a) ** 2.5;
/** Midpoint quadrature of f over [z0, z1]. */
function quad(f, z0, z1, n = 200000) {
  const h = (z1 - z0) / n;
  let s = 0;
  for (let i = 0; i < n; i++) s += f(z0 + (i + 0.5) * h);
  return s * h;
}

// ── 1. The drag coefficient is the integral ─────────────────────────────────
{
  const kQuad = 2 * Math.PI * a * sigma * T.tubeWallM * quad((z) => bRho(z) ** 2, -40 * a, 40 * a);
  const k = dt.dropTubeDragCoeff(T.tubeSigmaMSm);
  check('k = (45/1024)(Br·V)²σw/a⁴ matches 2πaσw∫B_ρ²dz to 1e-6', rel(k, kQuad) < 1e-6, `${k} vs ${kQuad}`);
  check('k is linear in σ', rel(dt.dropTubeDragCoeff(T.tubeSigmaMSm / 2), k / 2) < 1e-12, 'not linear');
  check('catalog copper tube: v_t is a classroom number (0.05–0.5 m/s)',
    dt.dropTubeTerminalVelocity(T.tubeSigmaMSm) > 0.05 && dt.dropTubeTerminalVelocity(T.tubeSigmaMSm) < 0.5,
    String(dt.dropTubeTerminalVelocity(T.tubeSigmaMSm)));
  check('v_t = m·g/k', rel(dt.dropTubeTerminalVelocity(T.tubeSigmaMSm), m * G / k) < 1e-12, 'mismatch');
  check('σ = 0: no terminal velocity (NaN, shown as "—")', Number.isNaN(dt.dropTubeTerminalVelocity(0)), String(dt.dropTubeTerminalVelocity(0)));
}

// ── 2. The end taper is the same integral over the tube only ────────────────
{
  const w2 = (z) => (z * z) / (z * z + a * a) ** 5;
  const full = quad(w2, -40 * a, 40 * a);
  for (const depth of [-5 * a, -a, 0, a / 2, a, 0.3, L - a, L, L + 2 * a]) {
    const want = quad(w2, Math.max(-40 * a, -depth), Math.min(40 * a, L - depth)) / full;
    const got = dt.dropTubeDragFraction(depth);
    check(`taper at depth ${depth.toFixed(4)} m matches quadrature`, Math.abs(got - want) < 1e-6, `${got} vs ${want}`);
  }
  check('taper is exactly 0.5 at the mouth', Math.abs(dt.dropTubeDragFraction(0) - 0.5) < 1e-12, String(dt.dropTubeDragFraction(0)));
}

// ── 3. Eddy-loop currents ───────────────────────────────────────────────────
{
  const v = 0.2;
  const dI = (z) => sigma * T.tubeWallM * v * bRho(z);
  for (const depth of [0.3, 0.004, L - 0.004, -0.01]) {
    const aheadQ = quad(dI, Math.max(0, -depth), Math.max(0, L - depth));
    const behindQ = -quad(dI, -Math.max(0, depth), -Math.max(0, depth - L));
    const [ahead, behind] = dt.dropTubeEddyLoops(depth, v, T.tubeSigmaMSm);
    check(`loop ahead at depth ${depth} matches ∫σwvB_ρ`, Math.abs(ahead - aheadQ) < 1e-4 * Math.max(1, aheadQ), `${ahead} vs ${aheadQ}`);
    check(`loop behind at depth ${depth} matches ∫σwvB_ρ`, Math.abs(behind - behindQ) < 1e-4 * Math.max(1, behindQ), `${behind} vs ${behindQ}`);
  }
  const [deepA, deepB] = dt.dropTubeEddyLoops(0.3, v, T.tubeSigmaMSm);
  const closed = sigma * T.tubeWallM * v * T.magnetBrT * V / (4 * Math.PI * a * a);
  // 0.3 m is 30 bore radii from either end, not infinity: (0.3²+a²)^{-3/2} is 4e-5 of a^{-3}.
  check('deep inside both loops equal σ·w·v·Br·V/(4π·a²)', rel(deepA, closed) < 1e-4 && rel(deepB, closed) < 1e-4, `${deepA} ${deepB} vs ${closed}`);
}

/** Step the bench at frame `dtS` from a fresh release with `drive` until `until(state, t)`. */
function run(dtS, drive, until, opts = {}) {
  const st = { ...dt.createDropTubePhysicsState(), ...opts };
  let t = 0;
  const limit = opts.limitS ?? 30;
  while (t < limit) {
    dt.stepDropTubePhysics(st, dtS, drive);
    t += dtS;
    if (until(st, t)) break;
  }
  return { st, t };
}

// ── 4. Terminal velocity, force balance, energy ─────────────────────────────
{
  const vt = dt.dropTubeTerminalVelocity(T.tubeSigmaMSm);
  const { st } = run(1 / 60, 0.5, (s) => s.dropTubeStage === dt.STAGE_FALLING && s.dropTubeDepthM > L / 2);
  check('mid-tube speed is m·g/k to 0.1%', rel(st.dropTubeVMps, vt) < 1e-3, `${st.dropTubeVMps} vs ${vt}`);
  check('reported v_t is m·g/k', rel(st.dropTubeTerminalVMps, vt) < 1e-12, String(st.dropTubeTerminalVMps));
  check('mid-tube drag equals the weight to 0.1%', rel(st.dropTubeDragN, m * G) < 1e-3, `${st.dropTubeDragN} vs ${m * G}`);
  check('drag power F·v equals m·g·v (nothing gained, nothing lost)', rel(st.dropTubeDragN * st.dropTubeVMps, m * G * vt) < 2e-3,
    `${st.dropTubeDragN * st.dropTubeVMps} vs ${m * G * vt}`);
  check('the loop ahead carries a classroom current (1–100 A)', st.dropTubeEddyIA > 1 && st.dropTubeEddyIA < 100, String(st.dropTubeEddyIA));
  check('energyLevel is the normalised loop current, in 0..1', st.energyLevel > 0 && st.energyLevel <= 1, String(st.energyLevel));
}

// ── 5. Terminal velocity forgets the entry speed ────────────────────────────
{
  const exits = [];
  for (const drive of [0.05, 0.5, 1]) {
    const { st } = run(1 / 60, drive, (s) => s.dropTubeStage === dt.STAGE_FALLING && s.dropTubeDepthM > 0.25);
    exits.push(st.dropTubeVMps);
  }
  const spread = Math.max(...exits) - Math.min(...exits);
  check('every clamp height reaches the same mid-tube speed (spread < 0.1% of v_t)',
    spread < 1e-3 * dt.dropTubeTerminalVelocity(T.tubeSigmaMSm), exits.join(', '));
  // And the entry really was different: peak speed rises with the drop height.
  const peak = (drive) => {
    let vmax = 0;
    run(1 / 600, drive, (s) => { vmax = Math.max(vmax, s.dropTubeVMps); return s.dropTubeDepthM > 0.1; });
    return vmax;
  };
  // Free fall from the clamp: √(2g·h), less the little drag the taper adds above the mouth.
  const ff = (drive) => Math.sqrt(2 * G * -dt.dropTubeReleaseDepthM(drive));
  check('a higher clamp enters faster (peak speed ∝ √h, within 10% of free fall)',
    peak(1) > 1.6 * peak(0.05) && rel(peak(1), ff(1)) < 0.1 && rel(peak(0.05), ff(0.05)) < 0.1,
    `${peak(1)} / ${peak(0.05)} vs free fall ${ff(1)} / ${ff(0.05)}`);
}

// ── 6. A non-conducting tube is free fall ───────────────────────────────────
{
  const drop = -dt.dropTubeReleaseDepthM(1); // clamp height above the mouth
  let vExit = 0;
  const { st } = run(1 / 600, 1, (s) => {
    if (s.dropTubeDepthM >= L && vExit === 0) vExit = s.dropTubeVMps;
    return vExit > 0;
  }, { dropTubeSigmaSetpointMSm: 0 });
  const want = Math.sqrt(2 * G * (drop + L));
  check('σ = 0: exit speed is √(2g·h) to 1%', rel(vExit, want) < 0.01, `${vExit} vs ${want}`);
  check('σ = 0: no drag, no loop current', st.dropTubeDragN === 0 && st.dropTubeEddyIA === 0, `${st.dropTubeDragN} ${st.dropTubeEddyIA}`);
  check('σ = 0: v_t is NaN, not a large number', Number.isNaN(st.dropTubeTerminalVMps), String(st.dropTubeTerminalVMps));
}

// ── 7. dt-independence ──────────────────────────────────────────────────────
{
  const transit = (dtS) => {
    let tIn = -1;
    const { t } = run(dtS, 0.5, (s, tt) => {
      if (tIn < 0 && s.dropTubeDepthM >= 0) tIn = tt;
      return s.dropTubeDepthM >= L;
    });
    return t - tIn;
  };
  // Independent reference: classic RK4 at 10 µs on the same ODE, m·dv/dt =
  // m·g − k·f(x)·v, from the clamp at rest — not the plant's exponential step.
  const rk4Transit = (drive) => {
    const k = dt.dropTubeDragCoeff(T.tubeSigmaMSm);
    const acc = (x, v) => G - (k * dt.dropTubeDragFraction(x) * v) / m;
    let x = dt.dropTubeReleaseDepthM(drive);
    let v = 0;
    let t = 0;
    let tIn = -1;
    const h = 1e-5;
    while (x < L) {
      const k1x = v, k1v = acc(x, v);
      const k2x = v + 0.5 * h * k1v, k2v = acc(x + 0.5 * h * k1x, v + 0.5 * h * k1v);
      const k3x = v + 0.5 * h * k2v, k3v = acc(x + 0.5 * h * k2x, v + 0.5 * h * k2v);
      const k4x = v + h * k3v, k4v = acc(x + h * k3x, v + h * k3v);
      x += (h / 6) * (k1x + 2 * k2x + 2 * k3x + k4x);
      v += (h / 6) * (k1v + 2 * k2v + 2 * k3v + k4v);
      t += h;
      if (tIn < 0 && x >= 0) tIn = t;
    }
    return t - tIn;
  };
  const ref = rk4Transit(0.5);
  const vt = dt.dropTubeTerminalVelocity(T.tubeSigmaMSm);
  // Shorter than L/v_t: the magnet arrives fast and only sheds the excess over
  // ~(v_in − v_t)·τ — a few centimetres — so the tube is mostly at v_t.
  check('reference transit is close to, and below, L/v_t', ref < L / vt && ref > 0.9 * L / vt, `${ref} vs ${L / vt}`);
  check('plant at 1/4000 s matches the independent RK4 transit to 0.1%', rel(transit(1 / 4000), ref) < 1e-3, `${transit(1 / 4000)} vs ${ref}`);
  for (const step of [1 / 30, 1 / 60, 1 / 144, 1 / 600]) {
    const tr = transit(step);
    // A frame boundary can only resolve the crossings to ±1 frame each.
    check(`transit at dt=1/${Math.round(1 / step)} within 0.5% + 2 frames of the fine step`,
      Math.abs(tr - ref) < 0.005 * ref + 2 * step, `${tr} vs ${ref}`);
  }
}

// ── 8. Cycle, clamp, setpoint, containment ──────────────────────────────────
{
  const held = run(1 / 60, 0, () => false, { limitS: 3 }).st;
  check('drive 0 keeps the clamp shut', held.dropTubeStage === dt.STAGE_HELD && held.dropTubeVMps === 0
    && held.dropTubeDepthM === dt.dropTubeReleaseDepthM(0), JSON.stringify({ stage: held.dropTubeStage, x: held.dropTubeDepthM }));

  const stages = [];
  run(1 / 60, 0.6, (s) => {
    if (stages[stages.length - 1] !== s.dropTubeStage) stages.push(s.dropTubeStage);
    return stages.length >= 5;
  });
  check('the demo cycles held → falling → landed → held → falling', stages.join() === '0,1,2,0,1', stages.join());

  const landed = run(1 / 60, 0.6, (s) => s.dropTubeStage === dt.STAGE_LANDED).st;
  check('a landed magnet rests on the catch pad', landed.dropTubeDepthM === dt.CATCH_DEPTH_M && landed.dropTubeVMps === 0, String(landed.dropTubeDepthM));

  const al = { dropTubeSigmaSetpointMSm: 37.7 };
  check('pinned σ is in effect', dt.dropTubeSigmaMSm(al) === 37.7, String(dt.dropTubeSigmaMSm(al)));
  check('pinned σ clamps to the slider range', dt.dropTubeSigmaMSm({ dropTubeSigmaSetpointMSm: 1e9 }) === T.sigmaMaxMSm
    && dt.dropTubeSigmaMSm({ dropTubeSigmaSetpointMSm: -4 }) === 0, 'not clamped');
  check('released (null) / NaN σ falls back to the catalog copper',
    dt.dropTubeSigmaMSm({ dropTubeSigmaSetpointMSm: null }) === T.tubeSigmaMSm
      && dt.dropTubeSigmaMSm({ dropTubeSigmaSetpointMSm: Number.NaN }) === T.tubeSigmaMSm, 'no fallback');
  const alRun = run(1 / 60, 0.5, (s) => s.dropTubeDepthM > L / 2, { dropTubeSigmaSetpointMSm: 37.7 }).st;
  check('aluminium falls faster than copper, by σ_Cu/σ_Al', rel(alRun.dropTubeVMps, dt.dropTubeTerminalVelocity(T.tubeSigmaMSm) * T.tubeSigmaMSm / 37.7) < 2e-3,
    String(alRun.dropTubeVMps));
  check('the plant reports the σ in effect (slider liveKey)', alRun.dropTubeSigmaMSm === 37.7, String(alRun.dropTubeSigmaMSm));

  const big = { ...dt.createDropTubePhysicsState(), dropTubeStage: dt.STAGE_FALLING, dropTubeDepthM: -0.1, dropTubeVMps: 3 };
  dt.stepDropTubePhysics(big, 1.0, 0.5);
  check('a 1 s frame stays finite and inside the travel', Number.isFinite(big.dropTubeDepthM) && Number.isFinite(big.dropTubeVMps)
    && big.dropTubeDepthM <= dt.CATCH_DEPTH_M, JSON.stringify({ x: big.dropTubeDepthM, v: big.dropTubeVMps }));
  const nan = { dropTubeDepthM: Number.NaN, dropTubeVMps: 1, dropTubeStage: dt.STAGE_FALLING };
  dt.stepDropTubePhysics(nan, 1 / 60, 0.5);
  check('a NaN state goes back into the clamp instead of poisoning telemetry',
    nan.dropTubeStage === dt.STAGE_HELD && Number.isFinite(nan.dropTubeDepthM) && Number.isFinite(nan.dropTubeDragN), JSON.stringify(nan));
  const still = { ...dt.createDropTubePhysicsState() };
  const before = JSON.stringify(still);
  dt.stepDropTubePhysics(still, 0, 0.5);
  dt.stepDropTubePhysics(still, Number.NaN, 0.5);
  check('dt = 0 / NaN steps nothing (pause)', JSON.stringify(still) === before, 'state changed');

  // Particle uniforms stay in range at every point of a cycle.
  let inRange = true;
  run(1 / 60, 1, (s) => {
    for (const u of dt.dropTubeParticleUniforms(s)) if (!(u >= 0 && u <= 1)) inRange = false;
    return s.dropTubeStage === dt.STAGE_LANDED;
  });
  check('particle uniforms stay in 0..1 through a whole drop', inRange, 'out of range');
}

for (const line of ok) console.log(`  ok: ${line}`);
if (failures.length) {
  for (const line of failures) console.error(`  FAIL: ${line}`);
  console.error(`[drop-tube] ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`[drop-tube] ${ok.length} checks passed`);
