/**
 * twin — the calibrated digital twin, end to end (#257, ADR-0019).
 *
 * Everything here runs the shipped `src/wasm/sim-core/sim_core.wasm` (the C++
 * EKF and the Levenberg–Marquardt fit) through the TypeScript host, against
 * the same ground-truth rig `?mockHardware=1&mockParamError=` uses
 * (src/twin/rig-model.ts: catalog `seg.twin`, ±20 % parameter error, catalog
 * process and sensor noise). The native `--mode twin` run checks the C++ alone
 * (cpp/Makefile → build/twin.txt); this one checks what the app ships.
 *
 *   A. Offline rig, the TS host:
 *      1. true θ: the EKF is χ²-consistent (mean NIS/dof ≈ 1, windows consistent);
 *      2. nominal θ on the ±20 % rig: diagnosed as model mismatch, not noise;
 *      3. a 30 s staircase run: sysid recovers every true parameter within 5 %,
 *         with an honest σ, and the profile round-trips through its text form;
 *      4. a mid-run filter snapshot restores state + covariance bit for bit,
 *         and the filter then continues identically (ADR-0015 amendment).
 *   B. The live lab (`?mockHardware=1&mockParamError=0.2`, headless, fake clock):
 *      the issue's Done-when — the residual drifts outside the 3σ band on
 *      nominal θ, one Calibrate (staircase through the bridge → fit → apply)
 *      brings it inside; the profile survives a `#lab2=` share link and a
 *      JSON plant snapshot (parsePlantSnapshot's `twin` block).
 *
 * Usage: npm run test:twin   (node --test scripts/tests/twin.test.mjs)
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { bundleTs, ROOT } from '../test-harness.mjs';
import { bootLiveLab } from '../lib/live-lab.mjs';
import { loadSimCoreFromDisk } from '../lib/sim-core-shim.mjs';

const WASM_DIR = join(ROOT, 'src/wasm/sim-core');
const SAMPLE_S = 0.008;
const MODE_RUN = 0;

/** Every parameter's |θ̂/θ − 1|. */
const relErrors = (est, truth) => truth.map((t, i) => Math.abs(est[i] / t - 1));

describe('A. twin estimator + sysid on the shipped sim_core (offline rig)', () => {
  let T, mod;
  before(async () => {
    mod = await loadSimCoreFromDisk(WASM_DIR);
    T = await bundleTs({
      contents: `
        export { TwinEstimatorHost } from './src/twin/estimator-host';
        export * from './src/twin/rig-model';
        export { runTwinSysId, profileFromFit, TWIN_RUN_STRIDE } from './src/twin/sysid-run';
        export { encodeTwinProfile, decodeTwinProfile, SYSID_WARN } from './src/twin/profile';
        export { EXCITATION_LEVELS, EXCITATION_STEP_S, EXCITATION_MAX_RPM } from './src/twin/session-twin';
      `,
      sourcefile: 'twin-offline.ts'
    });
  });

  /**
   * The calibration staircase on a ground-truth rig, sampled like the mock:
   * drive latched at each sample (ZOH), readings at the end of the interval.
   */
  function staircase({ paramError = 0.2, seed = 0x5eed257, seconds = 30 } = {}) {
    const rig = new T.RigTruth({ paramError, seed });
    const samples = [];
    const n = Math.round(seconds / SAMPLE_S);
    let v = 0;
    for (let k = 1; k <= n; k++) {
      rig.advance(v, SAMPLE_S);
      const t = k * SAMPLE_S;
      samples.push({ t, epoch: 0, v, z: rig.read() });
      const level = T.EXCITATION_LEVELS[Math.min(T.EXCITATION_LEVELS.length - 1, Math.floor(t / T.EXCITATION_STEP_S))];
      v = T.rigDriveVolts(level * T.EXCITATION_MAX_RPM, MODE_RUN, false);
    }
    return { rig, samples };
  }

  /** Feed a run through a fresh host with θ; tallies after the first χ² window. */
  function filter(samples, theta) {
    const host = new T.TwinEstimatorHost(mod);
    host.setTheta(theta);
    let nisSum = 0, dofSum = 0, windows = 0;
    const diag = {};
    let inBand = 0, nu = 0;
    for (const s of samples) {
      const nis = host.onSample(s);
      const e = host.estimate;
      if (nis >= 0) { nisSum += nis; dofSum += e.window.dof > 0 ? 3 : 0; }
      if (e.updates > 150) {
        windows++;
        diag[e.window.diagnosis] = (diag[e.window.diagnosis] ?? 0) + 1;
        const r = e.nu[0] / e.nuSigma[0];
        if (Number.isFinite(r)) { nu++; if (Math.abs(r) <= 3) inBand++; }
      }
    }
    return { host, nisPerDof: nisSum / dofSum, diag, windows, inBand: inBand / nu };
  }

  it('1. true θ: the EKF is χ²-consistent on the rig it models', () => {
    const { rig, samples } = staircase();
    const r = filter(samples, rig.theta);
    try {
      assert.ok(r.nisPerDof > 0.85 && r.nisPerDof < 1.15, `mean NIS/dof ≈ 1 on true θ: ${r.nisPerDof.toFixed(3)}`);
      const consistent = (r.diag.consistent ?? 0) / r.windows;
      assert.ok(consistent > 0.9, `≥ 90 % of χ² windows consistent: ${(100 * consistent).toFixed(1)} % ${JSON.stringify(r.diag)}`);
      assert.ok(r.inBand > 0.99, `RPM innovation inside ±3σ: ${(100 * r.inBand).toFixed(2)} %`);
    } finally {
      r.host.dispose();
    }
  });

  it('2. nominal θ on the ±20 % rig: model mismatch, not "sensor noisy"', () => {
    const { samples } = staircase();
    const r = filter(samples, T.rigNominal());
    try {
      assert.ok(r.nisPerDof > 5, `NIS/dof far above 1 on nominal θ: ${r.nisPerDof.toFixed(1)}`);
      const mismatch = (r.diag['model-mismatch'] ?? 0) / r.windows;
      assert.ok(mismatch > 0.6, `mostly diagnosed model-mismatch: ${(100 * mismatch).toFixed(1)} % ${JSON.stringify(r.diag)}`);
      assert.ok(!r.diag['sensor-noisy'] || r.diag['sensor-noisy'] < 0.1 * r.windows,
        `wrong θ is not mistaken for sensor noise: ${JSON.stringify(r.diag)}`);
    } finally {
      r.host.dispose();
    }
  });

  it('3. sysid recovers the true parameters within 5 % from a 30 s run; the profile round-trips', () => {
    const { rig, samples } = staircase();
    const rec = filter(samples, T.rigNominal());
    const rows = rec.host.run.rows();
    rec.host.dispose();
    assert.ok(rows.length / T.TWIN_RUN_STRIDE === samples.length, `the recorder kept the whole 30 s run: ${rows.length / T.TWIN_RUN_STRIDE}`);
    const costs = [];
    const fit = T.runTwinSysId(mod, { samples: rows, theta0: T.rigNominal() }, (p) => costs.push(p.cost));
    assert.ok(fit.status === 'converged', `fit converged: ${fit.status} ${fit.error ?? ''}`);
    const err = relErrors(fit.theta, rig.theta);
    assert.ok(Math.max(...err) < 0.05, `every θ within 5 % of the truth: ${err.map((e) => (100 * e).toFixed(2)).join(', ')} %`);
    const sd = fit.theta.map((th, i) => Math.sqrt(fit.cov[i * fit.theta.length + i]));
    const z = fit.theta.map((th, i) => Math.abs(th - rig.theta[i]) / sd[i]);
    assert.ok(Math.max(...z) < 4, `errors are inside the reported uncertainty (≤ 4σ): ${z.map((v) => v.toFixed(2)).join(', ')}`);
    assert.ok(fit.warnings === 0, `no identifiability / fit warnings: ${fit.warnings}`);
    assert.ok(fit.r2.every((v) => v > 0.99), `R² > 0.99 on every channel: ${fit.r2.join(', ')}`);
    assert.ok(costs.length === fit.iterations && costs[costs.length - 1] < costs[0], `cost curve falls: ${costs.map((c) => c.toPrecision(3)).join(' → ')}`);

    const profile = T.profileFromFit(fit);
    const text = T.encodeTwinProfile(profile);
    assert.match(text, /^tp1;[A-Za-z0-9.;=,_+-]{8,600}$/, 'profile text matches the lab-config pattern');
    const back = T.decodeTwinProfile(text);
    assert.ok(back.profile, `profile decodes: ${back.error}`);
    const tErr = relErrors(back.profile.theta, profile.theta);
    assert.ok(Math.max(...tErr) < 1e-5, `θ survives the text form: ${tErr.join(', ')}`);
    assert.ok(T.encodeTwinProfile(back.profile) === text, 'encode(decode(text)) === text');
    for (const [label, bad] of [
      ['another rig', text.replace(/h=[^;]+/, 'h=deadbeef')],
      ['θ outside the catalog bounds', text.replace(/;d=([^,;]+)/, ';d=1e9')],
      ['truncated', text.slice(0, 20)]
    ]) {
      assert.ok(T.decodeTwinProfile(bad).profile === null, `refused: ${label}`);
    }
  });

  it('3b. RPM only: the fit flags what one channel cannot identify', () => {
    const { samples } = staircase();
    const rpmOnly = samples.map((s) => ({ ...s, z: [s.z[0], null, null] }));
    const rec = filter(rpmOnly, T.rigNominal());
    const rows = rec.host.run.rows();
    rec.host.dispose();
    const fit = T.runTwinSysId(mod, { samples: rows, theta0: T.rigNominal() });
    assert.ok(fit.warnings !== 0, `identifiability warnings set from an RPM-only run: ${fit.warnings}`);
  });

  it('4. a mid-run snapshot restores the filter state and covariance, and it continues identically', () => {
    const { samples } = staircase({ seconds: 8 });
    const half = samples.length >> 1;
    const a = new T.TwinEstimatorHost(mod);
    for (const s of samples.slice(0, half)) a.onSample(s);
    const snap = a.save();
    const snapT = a.lastSampleT;
    const json = JSON.parse(JSON.stringify(snap));
    const tailA = samples.slice(half).map((s) => { a.onSample(s); return [...a.estimate.x, ...a.estimate.P]; });

    const b = new T.TwinEstimatorHost(mod);
    b.setTheta(T.rigTruthParams(0.1)); // something else, which the snapshot must overwrite
    assert.ok(b.load(json, snapT), 'load accepts its own (JSON round-tripped) block');
    assert.deepEqual(b.theta, a.theta, 'θ comes back with the filter');
    assert.deepEqual(b.save(), snap, 'save(load(s)) is s, bit for bit');
    const tailB = samples.slice(half).map((s) => { b.onSample(s); return [...b.estimate.x, ...b.estimate.P]; });
    assert.deepEqual(tailB, tailA, 'the restored filter continues bit-identically (same board clock)');
    // Without the board time (another link): one nominal period, then it tracks.
    const c = new T.TwinEstimatorHost(mod);
    c.load(json);
    for (const s of samples.slice(half)) c.onSample(s);
    const xc = c.estimate.x, xa = a.estimate.x;
    assert.ok(Math.abs(xc[0] - xa[0]) < 0.05 * Math.abs(xa[0]) + 1, `without t the filter still converges to the same ω: ${xc[0]} vs ${xa[0]}`);
    c.dispose();
    assert.ok(!b.load(snap.slice(1)), 'a block of the wrong length is refused');
    const bad = snap.slice();
    bad[0] = 99;
    assert.ok(!b.load(bad), 'a block of another layout version is refused');
    a.dispose();
    b.dispose();
  });
});

describe('B. ?mockHardware=1&mockParamError=0.2 → one Calibrate (headless live lab)', () => {
  let X, session, frame, hw, mock;
  const realNow = performance.now.bind(performance);
  let fakeMs = 0;
  let tickDebt = 0;

  /** dt of lab time: frames at 60 Hz, the mock's 125 Hz ticks in between. */
  function runFor(seconds, each) {
    const dt = 1 / 60;
    for (let f = 0, n = Math.round(seconds / dt); f < n; f++) {
      tickDebt += dt;
      while (tickDebt >= SAMPLE_S) {
        tickDebt -= SAMPLE_S;
        fakeMs += SAMPLE_S * 1000;
        mock._tick();
        each?.();
      }
      frame(dt);
    }
  }

  /**
   * Watch the innovation over `seconds`: per channel (RPM, I, V) the share of
   * |ν/σ| ≤ 3, the worst channel, mean NIS/dof and the χ² verdicts.
   */
  function watch(seconds) {
    const inBand = [0, 0, 0], mean = [0, 0, 0];
    let n = 0, nis = 0;
    const diag = {};
    let last = -1;
    runFor(seconds, () => {
      const e = session.twin.host.estimate;
      if (e.updates === last) return;
      last = e.updates;
      const r = e.nu.map((v, c) => v / e.nuSigma[c]);
      if (!r.every(Number.isFinite)) return;
      n++;
      r.forEach((v, c) => { if (Math.abs(v) <= 3) inBand[c]++; mean[c] += v; });
      nis += e.nis / 3;
      diag[e.window.diagnosis] = (diag[e.window.diagnosis] ?? 0) + 1;
    });
    const share = inBand.map((k) => k / n);
    return { share, worst: Math.min(...share), mean: mean.map((m) => m / n), nisPerDof: nis / n, n, diag };
  }
  const fmt = (w) => `ν/σ in ±3: ${w.share.map((v) => (100 * v).toFixed(1)).join(' / ')} % (RPM / I / V), `
    + `mean ν/σ ${w.mean.map((v) => v.toFixed(2)).join(' / ')}, NIS/dof ${w.nisPerDof.toFixed(2)}, ${JSON.stringify(w.diag)}`;

  before(async () => {
    performance.now = () => fakeMs;
    ({ X, session, frame } = await bootLiveLab({
      backend: 'js',
      search: '?mockHardware=1&mockParamError=0.2',
      exports: `
        export { captureShareConfig, applyLabConfig, encodeShareHash, decodeShareHash } from './src/seg-explainer/lab-url';
        export { parsePlantSnapshot } from './src/session/plant-snapshot';
        export { rigNominal } from './src/twin/rig-model';
      `
    }));
    hw = session.hardwareBridge;
  });

  after(async () => {
    if (hw?.isConnected) await hw.disconnect();
    performance.now = realNow;
  });

  it('connects the ±20 % mock rig and the estimator', async () => {
    await hw.connect();
    mock = hw.transport;
    assert.ok(hw.status === 'mock' && typeof mock?.pinRpm === 'function', `the mock transport — ${hw.status}`);
    mock.stop();
    assert.ok(Math.abs(mock.paramError - 0.2) < 1e-12, `?mockParamError=0.2 reaches the mock: ${mock.paramError}`);
    const host = await session.twin.ensureHost();
    assert.ok(host && session.twin.state === 'ready', `estimator ready — ${session.twin.state} ${session.twin.message}`);
    hw.setTwinMode(X.TWIN_MODES.ESTIMATE); // what maybeConnectMockHardware() does at boot
    X.segOperator.start();
    session.setMode('seg');
    runFor(1);
    assert.ok(hw.firmware?.protocol === 3 && hw.sampleClock.source === 'board-us',
      `the mock negotiates v3 and timestamps: v${hw.firmware?.protocol}, ${hw.sampleClock.source}`);
  });

  let before0;
  it('nominal θ: the residual drifts out of the 3σ band (model mismatch)', () => {
    X.segOperator.targetDrive = 0.8;
    runFor(4);
    before0 = watch(8);
    process.stdout.write(`# before: ${fmt(before0)}\n`);
    assert.ok(before0.worst < 0.9, `nominal θ: a channel's residual drifts out of ±3σ — ${fmt(before0)}`);
    assert.ok((before0.diag['model-mismatch'] ?? 0) > 0.5 * before0.n, `diagnosed model-mismatch — ${fmt(before0)}`);
  });

  let result;
  it('one Calibrate: staircase through the bridge, fit, profile applied', async () => {
    const pending = session.twin.calibrate();
    let state = 'pending';
    pending.then((r) => { state = 'ok'; result = r; }, (e) => { state = 'err'; result = e; });
    let seconds = 0;
    let maxCommanded = 0;
    let excitingTicks = 0;
    while (state === 'pending') {
      await new Promise((r) => setImmediate(r));
      if (state !== 'pending') break;
      assert.ok(seconds < 60, `calibration still running after ${seconds} s of lab time (${session.twin.calibration.phase})`);
      runFor(0.5, () => {
        // Only the staircase: before and after it the operator's own drive
        // commands the rig. Skip its first 100 ms: until the bridge's next
        // throttled P (≤ 50 ms) driveSent is still the operator's last command.
        if (session.twin.calibration.phase !== 'exciting') return;
        if (++excitingTicks > 0.1 / SAMPLE_S) maxCommanded = Math.max(maxCommanded, Math.abs(hw.driveSent.rpm));
      });
      seconds += 0.5;
    }
    if (state === 'err') throw result;
    assert.ok(result && result.status === 'converged', `fit converged: ${result?.status} — ${session.twin.calibration.message}`);
    assert.ok(maxCommanded <= 900 + 1e-9 && maxCommanded > 800, `the staircase went through the bridge, ≤ 900 RPM: ${maxCommanded}`);
    const err = relErrors(result.theta, mock.truth.theta);
    assert.ok(Math.max(...err) < 0.05, `calibrated θ within 5 % of the mock's truth: ${err.map((e) => (100 * e).toFixed(2)).join(', ')} %`);
    assert.ok(session.twin.profile && session.twin.profileText?.startsWith('tp1;'), `profile in use: ${session.twin.profileText}`);
    assert.ok(session.twin.calibration.phase === 'done', `status: ${session.twin.calibration.message}`);
  });

  it('after Calibrate the residual sits inside the 3σ band (Done-when)', () => {
    runFor(3);
    const afterCal = watch(8);
    process.stdout.write(`# after:  ${fmt(afterCal)}\n`);
    assert.ok(afterCal.worst > 0.99, `calibrated: every channel inside ±3σ — ${fmt(afterCal)} (was ${fmt(before0)})`);
    assert.ok((afterCal.diag.consistent ?? 0) > 0.8 * afterCal.n, `diagnosed consistent — ${fmt(afterCal)}`);
    const tele = X.telemetryHub.latest?.hardwareTwin?.estimate ?? null;
    if (tele) assert.ok(tele.calibrated === true, `telemetry says calibrated: ${JSON.stringify(tele)}`);
  });

  it('the profile round-trips through a #lab2= share link', async () => {
    const text = session.twin.profileText;
    const fields = X.captureShareConfig();
    assert.ok(fields.twinProfile === text, `captureShareConfig carries the profile: ${fields.twinProfile}`);
    const hash = await X.encodeShareHash(fields);
    assert.ok(hash.startsWith('#lab2='), `a #lab2= link: ${hash.slice(0, 16)}…`);
    session.twin.applyProfile(null);
    assert.deepEqual(session.twin.host.theta, X.rigNominal(), 'Nominal resets θ');
    const decoded = await X.decodeShareHash(hash);
    assert.ok(decoded.twinProfile === text, `the link decodes to the same profile: ${decoded.twinProfile}`);
    await X.applyLabConfig(decoded);
    assert.ok(session.twin.profileText === text, `applying the link restores the profile: ${session.twin.profileText}`);
    assert.deepEqual(session.twin.host.theta, session.twin.profile.theta, 'and the filter predicts with it');
  });

  it('a JSON plant snapshot carries the filter and the profile', async () => {
    const snap = JSON.parse(JSON.stringify(await X.captureLabSnapshot()));
    const parsed = X.parsePlantSnapshot(snap);
    assert.ok(parsed.snapshot?.twin && parsed.errors.length === 0, `parsePlantSnapshot keeps the twin block: ${parsed.errors} ${parsed.warnings}`);
    assert.ok(parsed.snapshot.twin.profile === session.twin.profileText, 'the snapshot names the profile in use');
    const saved = [...session.twin.host.estimate.x, ...session.twin.host.estimate.P];
    runFor(1);
    session.twin.applyProfile(null);
    assert.ok(await X.restoreLabSnapshot(snap), 'restore resolves true');
    assert.deepEqual([...session.twin.host.estimate.x, ...session.twin.host.estimate.P], saved, 'x̂ and P are the snapshot\'s');
    assert.ok(session.twin.profileText === parsed.snapshot.twin.profile, 'and so is the profile');
    const broken = { ...snap, twin: { version: 1, values: ['x'], profile: null } };
    const p2 = X.parsePlantSnapshot(broken);
    assert.ok(p2.snapshot && !p2.snapshot.twin && p2.warnings.some((w) => w.startsWith('twin:')),
      `a broken twin block is skipped with a warning, the rest loads: ${p2.warnings}`);
  });
});
