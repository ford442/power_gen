#!/usr/bin/env node
/**
 * test-analysis.mjs — the analysis panel's maths and data plumbing (#224 §4),
 * no browser:
 *
 *   1. fits: linear / exponential on analytic data, degenerate inputs, and the
 *      envelope ring-down fit on the real pulse-coil plant (τ = 2L/R);
 *   2. FFT: the JS kernel against a naive DFT, analytic spectra (sine at bin k
 *      peaks at k, DC, zero-pad sizes, Parseval with the window), then JS ⇄
 *      shipped WASM golden within FFT_GOLDEN_TOL_DB, and the gpuChores
 *      dispatcher (backend choice, kill switch, one-shot WASM → JS fallback);
 *   3. run store: newest first, cap, replace, subscribe / unsubscribe, validation;
 *   4. TelemetrySampler rows → RecordedRun (snake_case → catalog keys, idle drop);
 *   5. CSV export and the panel's view models (alignment, unit strips, fit text,
 *      spectrum peak, plot-hint defaults).
 *
 * Usage: node scripts/test-analysis.mjs   (exit 1 on failure)
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WASM_DIR = process.env.SIM_CORE_DIR ?? join(ROOT, 'src/public/wasm');

/** JS and WASM dB spectra agree to this on every bin (float32 output, double work). */
const FFT_GOLDEN_TOL_DB = 1e-3;

let failures = 0;
let passed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const near = (a, b, eps) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

/** Stub Vite's `?raw` shader-text imports so app-reaching graphs still bundle. */
const viteRawStub = {
  name: 'vite-raw-stub',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({ path: args.path, namespace: 'raw-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'raw-stub' }, () => ({ contents: 'export default "";', loader: 'js' }));
  }
};

const built = await esbuild.build({
  bundle: true,
  plugins: [viteRawStub],
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  write: false,
  logLevel: 'warning',
  stdin: {
    contents: `
      export * from './src/analysis/fit';
      export * from './src/analysis/run-store';
      export * from './src/analysis/run-columns';
      export * from './src/analysis/run-export';
      export * from './src/analysis/telemetry-run';
      export * from './src/analysis/analysis-views';
      export { fftMagnitudeDbJs, fftRadix2, fftSize, hannWeight, FFT_MAX_N } from './src/gpu-chores/fft-js';
      export { fftMagnitudeDbWasm, wasmFftAvailable } from './src/gpu-chores/fft-wasm';
      export { spectrumDb } from './src/gpu-chores/fft';
      export { gpuChores } from './src/gpu-chores/session';
      export { loadSimCore, getSimCore } from './src/wasm/index';
      export { TelemetrySampler } from './src/telemetry/telemetry-sampler';
      export { stepPulseCoilPhysics, PULSE_COIL } from './src/devices/quanta/pulse-coil';
      export { DEVICE_TELEMETRY_FIELDS } from './generated/device-catalog';
    `,
    resolveDir: ROOT,
    sourcefile: 'analysis-harness.ts',
    loader: 'ts'
  }
});

// Browser surface the WASM loader touches (same stubs as test-wasm-abi):
// HEAD probe, a pre-registered SimCore factory, a query string.
globalThis.window = globalThis;
globalThis.location = { search: '', hash: '' };
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k)
};
globalThis.fetch = async () => ({ ok: true });
const SimCore = new Function(`${readFileSync(join(WASM_DIR, 'sim_core.js'), 'utf8')}\n;return SimCore;`)();
const wasmBinary = readFileSync(join(WASM_DIR, 'sim_core.wasm'));
globalThis.SimCore = (opts) => SimCore({ ...opts, wasmBinary });

// A file, not a data: URL — src/wasm/index.ts resolves its URLs off import.meta.url.
const TMP = mkdtempSync(join(tmpdir(), 'analysis-'));
let A;
try {
  const file = join(TMP, 'harness.mjs');
  writeFileSync(file, built.outputFiles[0].text);
  A = await import(pathToFileURL(file).href);
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
/** Deterministic noise in [-1, 1) (LCG) — goldens must not depend on Math.random. */
function lcg(n, seed = 12345) {
  let s = seed >>> 0;
  return range(n, () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 31 - 1;
  });
}

// ── 1. Fits ───────────────────────────────────────────────────────────────
console.log('test-analysis\n\n1. Fits');
{
  const xs = range(100, (i) => i / 10);
  const lin = A.linearFit(xs, xs.map((x) => 2.5 * x + 0.1));
  check('linear: exact line → slope 2.5, intercept 0.1, R² 1, n 100',
    near(lin.slope, 2.5, 1e-12) && near(lin.intercept, 0.1, 1e-12) && near(lin.r2, 1, 1e-12) && lin.n === 100, JSON.stringify(lin));
  const ysGap = xs.map((x, i) => (i % 7 === 0 ? NaN : 2.5 * x + 0.1));
  const xsGap = xs.map((x, i) => (i % 11 === 0 ? Infinity : x));
  const gap = A.linearFit(xsGap, ysGap);
  check('linear: non-finite pairs ignored (same line, fewer points)',
    near(gap.slope, 2.5, 1e-12) && gap.n === 100 - 15 - 10 + 2, JSON.stringify(gap));
  const noisy = A.linearFit(xs, xs.map((x, i) => 3 * x - 1 + 0.2 * Math.sin(17 * i)));
  check('linear: noisy line → 0.99 < R² < 1, slope ≈ 3', noisy.r2 > 0.99 && noisy.r2 < 1 && near(noisy.slope, 3, 0.01), JSON.stringify(noisy));
  check('linear: n < 2 / all x equal → NaN slope',
    Number.isNaN(A.linearFit([1], [2]).slope) && Number.isNaN(A.linearFit([1, 1, 1], [1, 2, 3]).slope));
  const flat = A.linearFit([0, 1, 2], [5, 5, 5]);
  check('linear: constant y → slope 0, R² NaN (undefined, not 1)', flat.slope === 0 && Number.isNaN(flat.r2), JSON.stringify(flat));

  const ex = A.exponentialFit(xs, xs.map((x) => 4 * Math.exp(-x / 0.25)));
  check('exponential: 4·e^(−x/0.25) → a 4, b −4, τ 0.25, R²(log) & R²(lin) 1',
    near(ex.a, 4, 1e-9) && near(ex.b, -4, 1e-9) && near(ex.tau, 0.25, 1e-9) && near(ex.r2, 1, 1e-9) && near(ex.r2Linear, 1, 1e-9),
    JSON.stringify(ex));
  const exNeg = A.exponentialFit([0, 1, 2, 3], [2, -1, 2 * Math.exp(2), 0]);
  check('exponential: y ≤ 0 skipped (2 of 4 points used)', exNeg.n === 2 && near(exNeg.b, 1, 1e-9), JSON.stringify(exNeg));

  // Damped sine with a phase: the envelope peaks still decay as e^(−t/τ).
  const t = range(2000, (i) => i / 20000);
  const ring = t.map((s) => 10 * Math.exp(-s / 0.02) * Math.sin(2 * Math.PI * 200 * s + 0.4));
  const env = A.envelopePeaks(t, ring);
  const rd = A.ringDownFit(t, ring);
  check(`ring-down: synthetic τ 20 ms, 200 Hz → τ ${(rd.tau * 1e3).toFixed(3)} ms (±1 %) from ${env.xs.length} peaks`,
    near(rd.tau, 0.02, 0.01) && env.xs.length >= 10, JSON.stringify(rd));

  // The real pulse-coil plant (series RLC, RK4): envelope τ = 1/α = 2L/R.
  const P = A.PULSE_COIL;
  const st = { pulseCoilVCap: 0 };
  for (let i = 0; i < 6000 && !st.pulseCoilFiring; i++) A.stepPulseCoilPhysics(st, 1 / 600, 0.8);
  const hz = 4000;
  const pt = [];
  const pi = [];
  for (let i = 0; i < 0.12 * hz && st.pulseCoilFiring; i++) {
    A.stepPulseCoilPhysics(st, 1 / hz, 0.8);
    pt.push((i + 1) / hz);
    pi.push(st.pulseCoilCurrent);
  }
  const tauRlc = (2 * P.L_H) / P.R_ohm;
  const pc = A.ringDownFit(pt, pi);
  check(`ring-down: pulse-coil plant τ ${(pc.tau * 1e3).toFixed(3)} ms vs 2L/R ${(tauRlc * 1e3).toFixed(3)} ms (±1.5 %)`,
    pt.length > 200 && near(pc.tau, tauRlc, 0.015) && pc.r2 > 0.999, JSON.stringify({ samples: pt.length, ...pc }));
  check('evaluateFit: linear and exponential', A.evaluateFit(lin, 2) === lin.slope * 2 + lin.intercept
    && near(A.evaluateFit(ex, 0.5), 4 * Math.exp(-2), 1e-9));
}

// ── 2. FFT ────────────────────────────────────────────────────────────────
console.log('\n2. FFT');
{
  // Kernel vs a naive O(N²) DFT on a complex vector.
  const N = 64;
  const re0 = lcg(N, 1);
  const im0 = lcg(N, 2);
  const re = Float64Array.from(re0);
  const im = Float64Array.from(im0);
  A.fftRadix2(re, im);
  let worst = 0;
  for (let k = 0; k < N; k++) {
    let sr = 0;
    let si = 0;
    for (let n = 0; n < N; n++) {
      const a = (-2 * Math.PI * k * n) / N;
      sr += re0[n] * Math.cos(a) - im0[n] * Math.sin(a);
      si += re0[n] * Math.sin(a) + im0[n] * Math.cos(a);
    }
    worst = Math.max(worst, Math.hypot(sr - re[k], si - im[k]));
  }
  check(`radix-2 FFT matches a naive DFT (N = 64, max |Δ| ${worst.toExponential(1)} < 1e-9)`, worst < 1e-9);

  check('fftSize: 1→1, 100→128, 128→128, 0→0, MAX+1→0',
    A.fftSize(1) === 1 && A.fftSize(100) === 128 && A.fftSize(128) === 128 && A.fftSize(0) === 0 && A.fftSize(A.FFT_MAX_N + 1) === 0);

  const sine = range(128, (i) => 1.5 * Math.sin((2 * Math.PI * 7 * i) / 128));
  for (const hann of [true, false]) {
    const db = A.fftMagnitudeDbJs(sine, hann);
    const peak = db.indexOf(Math.max(...db));
    check(`sine A = 1.5 at bin 7 (${hann ? 'Hann' : 'rect'}) → 65 bins, peak bin 7 at 20·log10(1.5) dB`,
      db.length === 65 && peak === 7 && Math.abs(db[7] - 20 * Math.log10(1.5)) < 1e-4, `peak ${peak} ${db[7]}`);
  }
  const dc = A.fftMagnitudeDbJs(new Array(64).fill(2.5), false);
  check('DC 2.5 (rect) → bin 0 = 20·log10(2.5) dB, bin 1 at the floor',
    Math.abs(dc[0] - 20 * Math.log10(2.5)) < 1e-4 && dc[1] === -120, `${dc[0]} ${dc[1]}`);
  check('non-power-of-two: 100 samples → N 128, 65 bins', A.fftMagnitudeDbJs(lcg(100)).length === 65);
  check('empty input → no bins', A.fftMagnitudeDbJs([]).length === 0);

  // Parseval with the window: Σ (w·x)² = (1/N) Σ_k |X_k|² over all N bins.
  const x = lcg(256, 7);
  const floor = -400;
  const dbP = A.fftMagnitudeDbJs(x, true, floor);
  let sumW = 0;
  let timeEnergy = 0;
  for (let i = 0; i < x.length; i++) {
    const w = A.hannWeight(i, x.length);
    sumW += w;
    timeEnergy += (w * Math.fround(x[i])) ** 2;
  }
  let freqEnergy = 0;
  for (let k = 0; k < dbP.length; k++) {
    const edge = k === 0 || k === dbP.length - 1 ? 1 : 2;
    const mag = (10 ** (dbP[k] / 20) * sumW) / edge; // undo the one-sided amplitude scaling
    freqEnergy += (edge === 1 ? 1 : 2) * mag * mag;
  }
  freqEnergy /= 256;
  check(`Parseval with Hann: Σ(w·x)² ${timeEnergy.toFixed(6)} = Σ|X|²/N ${freqEnergy.toFixed(6)} (1e-5)`,
    near(freqEnergy, timeEnergy, 1e-5));

  // JS ⇄ shipped WASM golden.
  console.info = () => {};
  await A.loadSimCore();
  console.info = console.log;
  check('shipped sim_core has chores_fft_db_scratch', A.wasmFftAvailable());
  const inputs = {
    'sine bin 7 (128)': sine,
    'LCG noise (1000 → 1024)': lcg(1000, 99),
    'chirp (4096)': range(4096, (i) => Math.sin(2 * Math.PI * (0.01 + 0.2 * i / 4096) * i)),
    'DC + NaN (37 → 64)': range(37, (i) => (i === 5 ? NaN : 3.25))
  };
  for (const [label, data] of Object.entries(inputs)) {
    for (const hann of [true, false]) {
      const js = A.fftMagnitudeDbJs(data, hann);
      const wasm = A.fftMagnitudeDbWasm(data, hann, -120);
      let maxDiff = wasm && wasm.length === js.length ? 0 : Infinity;
      for (let k = 0; wasm && k < js.length; k++) maxDiff = Math.max(maxDiff, Math.abs(js[k] - wasm[k]));
      check(`JS ⇄ WASM ${label}, ${hann ? 'Hann' : 'rect'}: max |ΔdB| ${maxDiff.toExponential(1)} ≤ ${FFT_GOLDEN_TOL_DB}`,
        maxDiff <= FFT_GOLDEN_TOL_DB);
    }
  }

  // Dispatcher follows the gpuChores backend.
  const g = A.gpuChores;
  g.adopt({ sessionApi: 'webgl2' });
  const s1 = A.spectrumDb(sine, { sampleHz: 128 });
  check('spectrumDb on a WebGL2 session with sim_core loaded → wasm, peak 7 Hz (bin 7), Δf 1 Hz',
    s1.backend === 'wasm' && s1.peak?.bin === 7 && s1.peak.hz === 7 && s1.binHz === 1 && g.breadcrumb().lastBackend === 'wasm'
    && g.breadcrumb().lastOp === 'fft_db', JSON.stringify({ backend: s1.backend, peak: s1.peak }));
  g.backend = 'webgpu';
  check('…WebGPU session (no WGSL FFT pass) → still the WASM kernel', A.spectrumDb(sine, { sampleHz: 128 }).backend === 'wasm');
  const dcRemoved = A.spectrumDb(new Array(64).fill(4).map((v, i) => v + Math.sin((2 * Math.PI * 3 * i) / 64)), { sampleHz: 64 });
  check('…removeMean (default) → DC at the floor, peak is the tone (bin 3)',
    dcRemoved.db[0] === -120 && dcRemoved.peak?.bin === 3, `${dcRemoved.db[0]} ${dcRemoved.peak?.bin}`);
  globalThis.location.search = '?gpuChores=0';
  g.adopt({ sessionApi: 'webgl2' });
  check('…?gpuChores=0 kill switch → JS golden', A.spectrumDb(sine, { sampleHz: 128 }).backend === 'js');
  globalThis.location.search = '';
  g.adopt({ sessionApi: 'webgl2' });
  const mod = A.getSimCore();
  const real = mod.chores_fft_db_scratch;
  mod.chores_fft_db_scratch = () => { throw new Error('fft boom'); };
  const warn = console.warn;
  console.warn = () => {};
  const s2 = A.spectrumDb(sine, { sampleHz: 128 });
  console.warn = warn;
  mod.chores_fft_db_scratch = real;
  check('…a throwing WASM kernel falls back to JS with the same peak, error in the breadcrumb',
    s2.backend === 'js' && s2.peak?.bin === 7 && g.breadcrumb().wasmError === 'fft boom', JSON.stringify(g.breadcrumb()));
}

// ── 3. Run store ──────────────────────────────────────────────────────────
console.log('\n3. Run store');
{
  const mk = (id, rows = [[0, 1], [0.1, 2]]) => ({
    id, experimentId: null, title: id, startedAt: '2026-10-18T00:00:00.000Z', runner: 'offline', backend: 'js',
    hz: 10, columns: ['t', 'lorentzForceN'], rows
  });
  const seen = [];
  const unsub = A.subscribeRuns((runs) => seen.push(runs.length));
  for (let i = 0; i < 25; i++) A.addRun(mk(`r${i}`));
  const list = A.listRuns();
  check(`cap ${A.RUN_STORE_CAP}, newest first`, list.length === A.RUN_STORE_CAP && list[0].id === 'r24' && list.at(-1).id === 'r5',
    list.map((r) => r.id).join());
  A.addRun(mk('r10', [[0, 9]]));
  check('same id replaces and moves to the front', A.listRuns()[0].rows[0][1] === 9 && A.listRuns().length === A.RUN_STORE_CAP
    && A.listRuns().filter((r) => r.id === 'r10').length === 1);
  check('getRun / unknown id', A.getRun('r12')?.id === 'r12' && A.getRun('nope') === undefined);
  const copy = A.listRuns();
  copy.reverse();
  check('listRuns returns a copy', A.listRuns()[0].id === 'r10');
  let threw = 0;
  try { A.addRun(mk('bad', [[0, 1], [0.1]])); } catch { threw++; }
  try { A.addRun({ ...mk(''), id: '' }); } catch { threw++; }
  check('ragged rows / empty id throw (store unchanged)', threw === 2 && !A.getRun('bad'));
  check('subscriber called once per change', seen.length === 26 && seen[0] === 1, seen.join());
  unsub();
  A.clearRuns();
  check('clearRuns empties; unsubscribed listener not called', A.listRuns().length === 0 && seen.length === 26);
  const ids = new Set(range(1000, () => A.newRunId('rec')));
  check('newRunId: 1000 ids unique', ids.size === 1000);
}

// ── 4. Telemetry recording → RecordedRun ──────────────────────────────────
console.log('\n4. Telemetry → run');
{
  check('column keys: time_s→t, lorentz_force_n→lorentzForceN, voltage_v→voltage, frame_id/seg_omega→null',
    A.keyForTelemetryColumn('time_s') === 't' && A.keyForTelemetryColumn('lorentz_force_n') === 'lorentzForceN'
    && A.keyForTelemetryColumn('voltage_v') === 'voltage' && A.keyForTelemetryColumn('frame_id') === null
    && A.keyForTelemetryColumn('seg_omega') === null);
  check('every catalog device column maps back to its key',
    A.DEVICE_TELEMETRY_FIELDS.every((f) => A.keyForTelemetryColumn(f.column) === f.key));

  // The real sampler path: 1.05 s of 60 Hz frames recorded at 10 Hz.
  const sampler = new A.TelemetrySampler({ sampleHz: 10 });
  sampler.start(null);
  for (let i = 1; i <= 63; i++) {
    const tNow = i / 60;
    sampler.onFrame({
      frameId: i, view: 'lorentz-sled',
      seg: { status: 'operational', voltage: 12, current: 0.5 + tNow, power: 6, rpmInner: 900, corona: 0, fieldSim: 0.3 },
      devices: { 'lorentz-sled': { id: 'lorentz-sled', lorentzForceN: 2 * tNow, lorentzFieldT: 0.4 } },
      scientific: {}, energyNetwork: null, hardwareTwin: null
    }, 1 / 60);
  }
  const rows = sampler.getRows();
  const run = A.runFromTelemetryRows(rows, { hz: 10, backend: 'js' });
  check(`sampler rows → run: ${rows.length} rows, columns start with t`, rows.length === 10 && run.columns[0] === 't' && run.rows.length === 10,
    run.columns.join());
  const col = (k) => run.rows.map((r) => r[run.columns.indexOf(k)]);
  // The sampler stamps the sample time but reads the frame's snapshot: ≤ 1 frame (2/60 N) apart.
  check('t = time_s (sim seconds), lorentzForceN = 2·t within one frame', near(col('t')[0], 0.1, 1e-9)
    && col('t').every((t, i) => Math.abs(col('lorentzForceN')[i] - 2 * t) <= 2 / 60 + 1e-9),
    JSON.stringify(col('t').map((t, i) => [t, col('lorentzForceN')[i]])));
  check('SEG keys kept (voltage, current, rpm, fieldSim); idle corona + idle benches dropped',
    ['voltage', 'current', 'power', 'rpm', 'fieldSim', 'lorentzFieldT'].every((k) => run.columns.includes(k))
    && !run.columns.includes('corona') && !run.columns.includes('hallVoltage') && !run.columns.includes('frame_id'),
    run.columns.join());
  check('title names the view; runner live; contract fields present',
    run.title.includes('lorentz-sled') && run.runner === 'live' && run.experimentId === null && run.hz === 10 && !!run.startedAt);
  const all = A.runFromTelemetryRows(rows, { hz: 10, keepIdle: true });
  check('keepIdle keeps every mapped column', all.columns.length === 1 + 6 + A.DEVICE_TELEMETRY_FIELDS.length, String(all.columns.length));
  check('empty recording → empty run with no columns', A.runFromTelemetryRows([], { hz: 10 }).columns.length === 0);
}

// ── 5. CSV export + view models ───────────────────────────────────────────
console.log('\n5. Export + view models');
{
  const B = range(50, (i) => i / 50);
  const run = {
    id: 'exp/1', experimentId: 'lorentz-linearity', title: 'F vs B', startedAt: '2026-10-18T10:00:00.000Z',
    runner: 'offline', backend: 'wasm', hz: 50, columns: ['t', 'lorentzFieldT', 'lorentzForceN'],
    rows: B.map((b, i) => [i / 50, b, i === 3 ? NaN : 2.5 * b + 0.1]),
    sweep: { 'lorentz-sled.lorentzField': 0.3 },
    expects: [{ label: 'fit lorentzForceN ~ lorentzFieldT (linear)', pass: true, measured: { r2: 1 }, condition: 'r2 > 0.98' }],
    plots: [{ x: 'lorentzFieldT', y: 'lorentzForceN', fit: 'linear' }]
  };
  const csv = A.runToCsv(run);
  const lines = csv.split('\n');
  const header = lines.findIndex((l) => !l.startsWith('#'));
  check('CSV: # header carries disclaimer, id, hz, sweep, expect, units',
    lines[0].includes(A.ANALYSIS_DISCLAIMER) && csv.includes('# id: exp/1') && csv.includes('# hz: 50')
    && csv.includes('# sweep: {"lorentz-sled.lorentzField":0.3}') && csv.includes('# expect: PASS fit lorentzForceN')
    && csv.includes('lorentzForceN=F [N]') && csv.includes('t=t [s]'));
  check('CSV: header row = columns, one line per sample, NaN → empty cell',
    lines[header] === 't,lorentzFieldT,lorentzForceN' && lines.length - header - 1 === 50 && lines[header + 4].endsWith(','));
  const two = A.runsToCsv([run, { ...run, id: 'ref' }]);
  check('CSV: two runs → two blocks split by a blank line', two.split('\n\n').length === 2 && A.runsCsvFilename([run]) === 'seg-run-exp_1.csv');

  const m = A.columnMeta('lorentzForceN');
  check('columnMeta: catalog label/unit/device; SEG via its telemetry map; scale; unknown key',
    m.label === 'F' && m.unit === 'N' && m.deviceLabel === 'Lorentz Rail Sled'
    && A.columnMeta('rpm').deviceId === 'seg' && A.columnMeta('kelvinVoltageN').scale === 100
    && A.columnMeta('mystery').unit === '' && A.columnMeta('t').unit === 's');

  const al = A.alignTables([{ x: [0, 0.1, 0.2], ys: [[1, 2, 3]] }, { x: [0.1 + 1e-12, 0.3], ys: [[5, 6]] }], true);
  check('alignTables dedupe: float-equal x share a slot', al.x.length === 4 && al.ys[1][0][1] === 5 && al.ys[0][0][3] === null,
    JSON.stringify(al));
  check('alignTables scatter: repeated x keeps every point', A.alignTables([{ x: [1, 1, 2], ys: [[1, 2, 3]] }], false).x.length === 3);

  const sel = A.defaultSelection(run);
  check('defaultSelection from plot hint → xy, linear fit', sel.view === 'xy' && sel.xKey === 'lorentzFieldT' && sel.fit === 'linear');
  const xy = A.buildPlotModel(run, null, sel);
  check(`xy model: points + fit series, R² printed — "${xy.fitText}"`,
    xy.strips.length === 1 && xy.strips[0].series.length === 2 && xy.fitText.includes('R² = 1.00000')
    && xy.fitText.includes('F = 2.5 N/T · B + 0.1 N') && xy.fit.n === 49);
  const ref = { ...run, id: 'ref', title: 'reference', rows: run.rows.map((r) => [r[0], r[1], 2.4 * r[1]]) };
  check('xy overlay: second run as its own series', A.buildPlotModel(run, ref, sel).strips[0].series.length === 3);

  const tr = {
    ...run, id: 'tr', columns: ['t', 'transformerVp', 'transformerVs', 'transformerIpA'],
    rows: range(200, (i) => [i / 100, Math.sin(i / 10), 0.5 * Math.sin(i / 10), Math.cos(i / 10)]), plots: undefined, expects: undefined
  };
  const tsel = { ...A.defaultSelection(tr), timeKeys: ['transformerVp', 'transformerVs', 'transformerIpA'] };
  const tm = A.buildPlotModel(tr, { ...tr, id: 'tr2' }, tsel);
  check('time model: one strip per unit (V, A), overlay dashed beside each column',
    tm.strips.length === 2 && tm.strips[0].series.length === 4 && tm.strips[0].series[1].dashed && tm.strips[0].yLabel === 'V_p, V_s [V]',
    tm.strips.map((s) => `${s.yLabel}:${s.series.length}`).join());
  const tf = A.buildPlotModel(tr, null, { ...tsel, fit: 'exponential' });
  check('time model fit on a signal with y ≤ 0 still reports (n counts y > 0 only)', /n = \d+ points with y > 0/.test(tf.fitText), tf.fitText);

  const tone = { ...tr, id: 'tone', hz: 100, columns: ['t', 'hallVoltage'], rows: range(256, (i) => [i / 100, 0.2 + Math.sin(2 * Math.PI * 12.5 * i / 100)]) };
  const sm = A.buildPlotModel(tone, null, { ...A.defaultSelection(tone), view: 'spectrum' });
  const sp = sm.spectra[0];
  check(`spectrum model: 12.5 Hz tone at 100 Hz → peak ${sp.peak.hz.toFixed(3)} Hz (±Δf/2), note printed`,
    Math.abs(sp.peak.hz - 12.5) <= sp.binHz / 2 && sm.notes[0].startsWith('Peak') && sm.x.length === 129, sm.notes.join(' | '));
}

console.log(failures === 0 ? `\ntest-analysis: ${passed} checks OK` : `\ntest-analysis: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
