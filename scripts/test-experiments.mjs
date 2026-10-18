#!/usr/bin/env node
/**
 * test-experiments.mjs — scripted experiments, headless (#224 §3).
 *
 *   1. Every `src/experiments/reference/*.experiment.json` validates, runs
 *      offline on the C++ plant (shipped sim_core.wasm) *and* on the JS
 *      fallback, and every `expect` / `summaryExpect` passes on both.
 *   2. The two backends agree on each verdict's measured numbers (the plants
 *      are golden-matched, test-js-wasm-golden.mjs; this holds the whole
 *      experiment pipeline — knobs, buses, recorder — to the same bar).
 *   3. Unit checks: validator errors, interpreter timing, knob aliases, sweep
 *      grid, conditions, proportional fit.
 *
 * Usage: node scripts/test-experiments.mjs [--verbose]   (exit 1 on failure)
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REF_DIR = join(ROOT, 'src/experiments/reference');
const WASM_DIR = join(ROOT, 'src/public/wasm');
const VERBOSE = process.argv.includes('--verbose');

/** C++ integrates in float, JS in double; verdict numbers agree far inside this. */
const BACKEND_REL = 2e-3;
const BACKEND_ABS = 1e-9;

const failures = [];
let passed = 0;
function check(label, cond, detail = '') {
  if (cond) passed++;
  else failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

// ── bundle the runner (file URL: src/wasm/index.ts resolves against import.meta.url) ──
const TMP = mkdtempSync(join(tmpdir(), 'seg-experiments-'));
const built = await esbuild.build({
  stdin: {
    contents: `
      export { validateExperiment, sweepGrid, ExperimentError } from './src/experiments/validate';
      export { runExperimentSync, summarizeSweep } from './src/experiments/offline';
      export { ExperimentInterpreter, liveBatch, MAX_LIVE_BATCH_S } from './src/experiments/interpreter';
      export { knobSpec, canonicalKnobId, EXPERIMENT_KNOBS } from './src/experiments/knobs';
      export { meets, conditionText, proportionalFit, reduce } from './src/experiments/expect';
      export { SEGSim } from './src/wasm/sim';
      export { tourExperimentDef } from './src/experiments/tour-def';
    `,
    resolveDir: ROOT,
    sourcefile: 'experiments-harness.ts',
    loader: 'ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  write: false,
  logLevel: 'warning',
  loader: { '.wgsl': 'text', '.glsl': 'text' },
  plugins: [{
    name: 'raw-stub',
    setup(b) {
      b.onResolve({ filter: /\?raw$/ }, (a) => ({ path: a.path, namespace: 'raw-stub' }));
      b.onLoad({ filter: /.*/, namespace: 'raw-stub' }, () => ({ contents: 'export default ""', loader: 'js' }));
    }
  }]
});
const bundlePath = join(TMP, 'experiments.mjs');
writeFileSync(bundlePath, built.outputFiles[0].text);
const X = await import(pathToFileURL(bundlePath).href);

// ── shipped wasm, no fetch (ENVIRONMENT=web glue + wasmBinary) ──
const SimCore = new Function(`${readFileSync(join(WASM_DIR, 'sim_core.js'), 'utf8')}\n;return SimCore;`)();
const wasmMod = await SimCore({ wasmBinary: readFileSync(join(WASM_DIR, 'sim_core.wasm')) });

function runOnce(v, backend, sweepPoint) {
  const cpp = backend === 'wasm' ? X.SEGSim.fromModule(wasmMod) : null;
  try {
    return X.runExperimentSync(v, { cpp, sweepPoint, startedAt: '2026-01-01T00:00:00.000Z' });
  } finally {
    cpp?.dispose();
  }
}

/** One experiment on one backend → { runs, summary, verdicts }. */
function runExperiment(v, backend) {
  if (v.sweepPoints.length) {
    const runs = v.sweepPoints.map((p) => runOnce(v, backend, p));
    const summary = X.summarizeSweep(v, runs);
    return { runs, summary, verdicts: [...runs.flatMap((r) => r.expects), ...summary.expects] };
  }
  const run = runOnce(v, backend);
  return { runs: [run], summary: null, verdicts: run.expects };
}

function close(a, b) {
  if (!Number.isFinite(a) && !Number.isFinite(b)) return a === b || (Number.isNaN(a) && Number.isNaN(b));
  return Math.abs(a - b) <= Math.max(BACKEND_ABS, BACKEND_REL * Math.max(Math.abs(a), Math.abs(b)));
}

const fmt = (m) => Object.entries(m).map(([k, x]) => `${k}=${Number.isFinite(x) ? +x.toPrecision(5) : x}`).join(' ');

// ── 1 + 2: reference experiments ─────────────────────────────────────────
const files = readdirSync(REF_DIR).filter((f) => f.endsWith('.experiment.json')).sort();
check('at least four reference experiments', files.length >= 4, `found ${files.length}`);
for (const file of files) {
  const raw = JSON.parse(readFileSync(join(REF_DIR, file), 'utf8'));
  let v;
  try {
    v = X.validateExperiment(raw);
  } catch (e) {
    check(`${file}: validates`, false, e.message);
    continue;
  }
  check(`${file}: id matches the file name`, `${v.def.id}.experiment.json` === file, v.def.id);
  for (const w of v.warnings) console.warn(`[experiments] ${file}: warning: ${w}`);
  const t0 = performance.now();
  const results = {};
  for (const backend of ['wasm', 'js']) {
    const res = runExperiment(v, backend);
    results[backend] = res;
    check(`${file} [${backend}]: has verdicts`, res.verdicts.length > 0);
    for (const run of res.runs) {
      check(`${file} [${backend}]: recorded rows`, run.rows.length > 1, `${run.rows.length}`);
      const finite = run.rows.every((r) => r.every((x, j) => j === 0 || Number.isFinite(x) || Number.isNaN(x)));
      check(`${file} [${backend}]: no Inf in the table`, finite);
    }
    const want = backend === 'wasm' ? (v.devices.length > 1 ? 'mixed' : 'wasm') : 'js';
    check(`${file} [${backend}]: backend label`, res.runs.every((r) => r.backend === want), res.runs.map((r) => r.backend).join(','));
    for (const e of res.verdicts) {
      check(`${file} [${backend}]: ${e.label}`, e.pass, `${e.condition}; measured ${fmt(e.measured)}`);
      if (VERBOSE) console.log(`  ${e.pass ? '✓' : '✗'} [${backend}] ${e.label}: ${fmt(e.measured)} (${e.condition})`);
    }
  }
  const [a, b] = [results.wasm.verdicts, results.js.verdicts];
  check(`${file}: same verdict count on both backends`, a.length === b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    for (const k of Object.keys(a[i].measured)) {
      check(
        `${file}: ${a[i].label} — ${k} agrees across backends`,
        close(a[i].measured[k], b[i].measured[k]),
        `wasm ${a[i].measured[k]} vs js ${b[i].measured[k]}`
      );
    }
  }
  console.log(`[experiments] ${file}: ${a.filter((e) => e.pass).length}/${a.length} verdicts pass (wasm), ` +
    `${b.filter((e) => e.pass).length}/${b.length} (js) in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

// ── 3: unit checks ───────────────────────────────────────────────────────
const base = {
  id: 'unit',
  title: 'unit',
  config: { mode: 'lorentz-sled' },
  steps: [
    { at: 0, set: { drive: 1 } },
    { at: 0, record: ['lorentzFieldT'], hz: 10, until: 1 },
    { at: 1, expect: { stat: { key: 'lorentzFieldT', of: 'mean', gt: 0 } } }
  ]
};
const rejects = (label, def, needle) => {
  try {
    X.validateExperiment(def);
    check(`validator rejects ${label}`, false, 'accepted');
  } catch (e) {
    check(`validator rejects ${label}`, e instanceof X.ExperimentError && (!needle || e.message.includes(needle)), e.message);
  }
};
check('validator accepts the minimal def', (() => { try { X.validateExperiment(base); return true; } catch { return false; } })());
rejects('a bad id', { ...base, id: 'Bad Id' }, 'id must match');
rejects('an unknown LabConfig field', { ...base, config: { mode: 'lorentz-sled', bogus: 1 } }, 'not a LabConfig field');
rejects('an unknown mode', { ...base, config: { mode: 'warp-drive' } }, 'config.mode');
rejects('an unknown knob', { ...base, steps: [{ at: 0, set: { 'lorentz-sled.nope': 1 } }, ...base.steps.slice(1)] }, 'unknown knob');
rejects('a knob on a device the run does not step', { ...base, steps: [{ at: 0, set: { 'transformer.leakage': 1 } }, ...base.steps.slice(1)] }, 'does not step');
rejects('an unknown record key', { ...base, steps: [base.steps[0], { at: 0, record: ['warpFactor'] }, base.steps[2]] }, 'not a telemetry key');
rejects('a telemetry key from another device', { ...base, steps: [base.steps[0], { at: 0, record: ['hallVoltage'], until: 1 }, base.steps[2]] }, 'does not step');
rejects('an expect on an unrecorded key', { ...base, steps: [...base.steps.slice(0, 2), { at: 1, expect: { stat: { key: 'lorentzForceN', of: 'mean', gt: 0 } } }] }, 'not recorded');
rejects('an expect with no bound', { ...base, steps: [...base.steps.slice(0, 2), { at: 1, expect: { stat: { key: 'lorentzFieldT', of: 'mean' } } }] }, 'needs a bound');
rejects('overlapping record steps', { ...base, steps: [...base.steps, { at: 0.5, record: ['lorentzForceN'], until: 1 }] }, 'overlap');
rejects('a ramp without over', { ...base, steps: [{ at: 0, ramp: { drive: [0, 1] } }, ...base.steps.slice(1)] }, 'over');
rejects('ramping a switch', { ...base, config: { mode: 'transformer' }, steps: [{ at: 0, ramp: { 'transformer.leakage': [0, 1] }, over: 1 }] }, 'switch');
rejects('a step with two kinds', { ...base, steps: [{ at: 0, set: { drive: 1 }, record: ['lorentzFieldT'] }] }, 'exactly one');
rejects('summaryExpect without a sweep', { ...base, summaryExpect: [{ stat: { key: 'lorentzFieldT', of: 'mean', gt: 0 } }] }, 'needs a sweep');
rejects('a sweep over the cap', { ...base, sweep: { drive: { from: 0, to: 1, n: 65 } } }, 'cap');

rejects('a summaryExpect on an unknown summary column', {
  ...base,
  sweep: { drive: { values: [0.5, 1] } },
  summaryExpect: [{ stat: { key: 'warpFactor', of: 'max', gt: 0 } }]
}, 'not a summary column');

// Tour steps that `run` an experiment must name a shipped one (or carry a valid snippet).
const TOUR_DIR = join(ROOT, 'src/seg-explainer');
const refIds = new Set(files.map((f) => f.replace(/\.experiment\.json$/, '')));
let tourRuns = 0;
for (const f of readdirSync(TOUR_DIR).filter((n) => n.endsWith('-tour.json'))) {
  const tour = JSON.parse(readFileSync(join(TOUR_DIR, f), 'utf8'));
  (tour.steps ?? []).forEach((step, i) => {
    if (step.run === undefined) return;
    tourRuns++;
    if (typeof step.run === 'string') {
      check(`${f} step ${i}: run names a shipped experiment`, refIds.has(step.run), step.run);
      return;
    }
    const def = X.tourExperimentDef(step.run, step, tour.id ?? 'tour', i);
    try { X.validateExperiment(def); check(`${f} step ${i}: run snippet validates`, true); }
    catch (e) { check(`${f} step ${i}: run snippet validates`, false, e.message); }
  });
}
check('at least one tour step runs an experiment', tourRuns > 0);

check('alias lorentz-sled.fieldT → lorentzField', X.canonicalKnobId('lorentz-sled.fieldT') === 'lorentz-sled.lorentzField');
check('every catalog setpoint is a knob', ['pulse-coil.pulseCoilCharge', 'halbach-viz.halbachSegments', 'lorentz-sled.lorentzField', 'drop-tube.dropTubeSigma'].every((k) => X.knobSpec(k)));
const grid = X.sweepGrid({ a: { from: 0, to: 1, n: 3 }, b: { values: [5, 6] } });
check('sweep grid is the cartesian product', grid.length === 6 && grid[0].a === 0 && grid[0].b === 5 && grid[5].a === 1 && grid[5].b === 6, JSON.stringify(grid));

check('meets gt', X.meets(1, { gt: 0.5 }) && !X.meets(0.5, { gt: 0.5 }));
check('meets approx (default 1 %)', X.meets(1.009, { approx: 1 }) && !X.meets(1.02, { approx: 1 }));
check('meets approx tol', X.meets(1.05, { approx: 1, tol: 0.1 }) && !X.meets(1.2, { approx: 1, tol: 0.1 }));
check('NaN never meets', !X.meets(Number.NaN, { lt: 1 }));
check('condition text', X.conditionText('R²', { gt: 0.98 }) === 'R² > 0.98', X.conditionText('R²', { gt: 0.98 }));
const pf = X.proportionalFit([1, 2, 3], [2, 4, 6]);
check('proportional fit', Math.abs(pf.slope - 2) < 1e-12 && Math.abs(pf.r2 - 1) < 1e-12, JSON.stringify(pf));
check('rms', Math.abs(X.reduce([3, -3, 3, -3], 'rms') - 3) < 1e-12);

// Interpreter timing on a hand-driven clock: a set lands on the first batch at
// or after its time; a ramp writes its end value once; rows carry clock time.
{
  const v = X.validateExperiment({
    id: 'clock',
    title: 'clock',
    config: { mode: 'lorentz-sled' },
    steps: [
      { at: 0.5, set: { drive: 0.25 } },
      { at: 1, ramp: { drive: [0, 1] }, over: 1 },
      { at: 0, record: ['drive'], hz: 4, until: 3 }
    ]
  });
  const interp = new X.ExperimentInterpreter(v);
  const writes = [];
  let drive = 0;
  const host = { write: (k, x) => { writes.push([k, x]); drive = x; }, read: () => drive };
  // A ragged frame clock, like a live run with a hitch at t ≈ 1.3 s.
  const clock = [0, 0.3, 0.6, 0.9, 1.0, 1.3, 1.9, 2.1, 2.4, 2.7, 3.0];
  for (let i = 0; i < clock.length; i++) {
    interp.applyDue(clock[i], host);
    if (i + 1 < clock.length) interp.observe(clock[i + 1], host);
  }
  check('set lands on the first batch after its time', writes[0][0] === 'drive' && writes[0][1] === 0.25);
  const rampWrites = writes.slice(1).map(([, x]) => x);
  check('ramp values follow the clock', JSON.stringify(rampWrites.map((x) => +x.toFixed(3))) === JSON.stringify([0, 0.3, 0.9, 1]), JSON.stringify(rampWrites));
  check('rows carry the clock time', interp.rows.every((r) => clock.includes(+r[0].toFixed(6))), JSON.stringify(interp.rows));
  check('at most one row per batch', new Set(interp.rows.map((r) => r[0])).size === interp.rows.length);
  check('interpreter done at the end', interp.done);
}

// The live runner's batch cut: frames of 10 s (a starved SwiftShader page)
// still land every set, ramp end and record tick on its own time.
{
  const v = X.validateExperiment({
    id: 'slow-frames',
    title: 'slow frames',
    config: { mode: 'lorentz-sled' },
    steps: [
      { at: 0, set: { drive: 1 } },
      { at: 0.25, ramp: { drive: [0, 1] }, over: 0.5 },
      { at: 0, record: ['drive'], hz: 10, until: 1 },
      { at: 1, expect: { stat: { key: 'drive', of: 'last', approx: 1 } } }
    ]
  });
  const interp = new X.ExperimentInterpreter(v);
  let drive = 0;
  const host = { write: (_k, x) => { drive = x; }, read: () => drive };
  let t = 0;
  let frames = 0;
  const batches = [];
  interp.applyDue(0, host);
  interp.observe(0, host);
  while (!interp.done && frames < 1000) {
    interp.applyDue(t, host);
    const steps = X.liveBatch([10], interp.nextEvent(t) - t);
    batches.push(steps);
    t += steps.reduce((a, x) => a + x, 0);
    interp.observe(t, host);
    frames++;
  }
  const times = interp.rows.map((r) => +r[0].toFixed(9));
  check('slow frames: a sample on every 0.1 s tick', JSON.stringify(times) === JSON.stringify([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]), JSON.stringify(times));
  check('slow frames: no batch over the cap', batches.every((b) => b.reduce((a, x) => a + x, 0) <= X.MAX_LIVE_BATCH_S + 1e-12 && b.every((x) => x <= 1 / 60 + 1e-12)));
  const ends = [];
  batches.reduce((acc, b) => { const e = acc + b.reduce((x, y) => x + y, 0); ends.push(+e.toFixed(9)); return e; }, 0);
  check('slow frames: batches end on the ramp start and end', ends.includes(0.25) && ends.includes(0.75), JSON.stringify(ends));
  // Knobs are held over a batch: the 0.4 row reads what was written at 0.3.
  check('slow frames: ramp value held from its batch start', interp.rows.find((r) => Math.abs(r[0] - 0.4) < 1e-9)?.[1].toFixed(6) === '0.100000', JSON.stringify(interp.rows));
  check('slow frames: expect judged', interp.expects.length === 1 && interp.expects[0].pass, JSON.stringify(interp.expects));
  check('liveBatch keeps an uncut frame', JSON.stringify(X.liveBatch([1 / 60, 1 / 60], 0.5)) === JSON.stringify([1 / 60, 1 / 60]));
  check('liveBatch keeps a paused frame', JSON.stringify(X.liveBatch([], 0.5)) === '[]');
}

rmSync(TMP, { recursive: true, force: true });
if (failures.length) {
  console.error(`[experiments] ${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`[experiments] OK — ${passed} checks (${files.length} reference experiments × wasm + js)`);
