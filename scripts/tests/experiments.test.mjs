/**
 * experiments — scripted experiments, headless (#224 §3).
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
 * Usage: npm run test:experiments   (node --test scripts/tests/experiments.test.mjs;
 *        SEG_EXPERIMENTS_VERBOSE=1 or `node scripts/tests/experiments.test.mjs --verbose`
 *        prints every verdict)
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { before, describe, it } from 'node:test';
import { ROOT, bundleTs } from '../test-harness.mjs';

const REF_DIR = join(ROOT, 'src/experiments/reference');
const WASM_DIR = join(ROOT, 'src/wasm/sim-core');
const VERBOSE = process.argv.includes('--verbose') || !!process.env.SEG_EXPERIMENTS_VERBOSE;

/** C++ integrates in float, JS in double; verdict numbers agree far inside this. */
const BACKEND_REL = 2e-3;
const BACKEND_ABS = 1e-9;

const X = await bundleTs({
  contents: `
    export { validateExperiment, sweepGrid, ExperimentError } from './src/experiments/validate';
    export { runExperimentSync, summarizeSweep } from './src/experiments/offline';
    export { ExperimentBench } from './src/experiments/bench';
    export { parsePlantSnapshot, saveDeviceState } from './src/session/plant-snapshot';
    export { ExperimentInterpreter, liveBatch, MAX_LIVE_BATCH_S } from './src/experiments/interpreter';
    export { knobSpec, canonicalKnobId, EXPERIMENT_KNOBS } from './src/experiments/knobs';
    export { meets, conditionText, proportionalFit, reduce } from './src/experiments/expect';
    export { SEGSim } from './src/wasm/sim';
    export { tourExperimentDef } from './src/experiments/tour-def';
  `,
  sourcefile: 'experiments-harness.ts'
});

// ── shipped wasm, no fetch (ENVIRONMENT=web glue + wasmBinary) ──
// ES-module glue (EXPORT_ES6): a plain import, like the page and workers.
const { default: SimCore } = await import(pathToFileURL(join(WASM_DIR, 'sim_core.js')).href);
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

const files = readdirSync(REF_DIR).filter((f) => f.endsWith('.experiment.json')).sort();

describe('reference experiments, offline on wasm + js', () => {
  it('at least four reference experiments', () => {
    assert.ok(files.length >= 4, `found ${files.length}`);
  });

  for (const file of files) {
    describe(file, () => {
      let v;
      const results = {};
      before(() => {
        v = X.validateExperiment(JSON.parse(readFileSync(join(REF_DIR, file), 'utf8')));
        for (const w of v.warnings) console.warn(`[experiments] ${file}: warning: ${w}`);
      });

      it('validates; id matches the file name', () => {
        assert.ok(v, 'validates');
        assert.ok(`${v.def.id}.experiment.json` === file, `id matches the file name: ${v.def.id}`);
      });

      for (const backend of ['wasm', 'js']) {
        it(`[${backend}]: verdicts, rows, no Inf, backend label, every verdict passes`, (t) => {
          const res = runExperiment(v, backend);
          results[backend] = res;
          assert.ok(res.verdicts.length > 0, `[${backend}]: has verdicts`);
          for (const run of res.runs) {
            assert.ok(run.rows.length > 1, `[${backend}]: recorded rows — ${run.rows.length}`);
            const finite = run.rows.every((r) => r.every((x, j) => j === 0 || Number.isFinite(x) || Number.isNaN(x)));
            assert.ok(finite, `[${backend}]: no Inf in the table`);
          }
          const want = backend === 'wasm' ? (v.devices.length > 1 ? 'mixed' : 'wasm') : 'js';
          assert.ok(res.runs.every((r) => r.backend === want), `[${backend}]: backend label — ${res.runs.map((r) => r.backend).join(',')}`);
          for (const e of res.verdicts) {
            if (VERBOSE) t.diagnostic(`${e.pass ? '✓' : '✗'} [${backend}] ${e.label}: ${fmt(e.measured)} (${e.condition})`);
            assert.ok(e.pass, `[${backend}]: ${e.label} — ${e.condition}; measured ${fmt(e.measured)}`);
          }
          t.diagnostic(`${res.verdicts.filter((e) => e.pass).length}/${res.verdicts.length} verdicts pass (${backend})`);
        });
      }

      it('same verdict count and measured numbers on both backends', () => {
        const [a, b] = [results.wasm.verdicts, results.js.verdicts];
        assert.ok(a.length === b.length, 'same verdict count on both backends');
        for (let i = 0; i < Math.min(a.length, b.length); i++) {
          for (const k of Object.keys(a[i].measured)) {
            assert.ok(close(a[i].measured[k], b[i].measured[k]),
              `${a[i].label} — ${k} agrees across backends: wasm ${a[i].measured[k]} vs js ${b[i].measured[k]}`);
          }
        }
      });
    });
  }
});

describe('validator', () => {
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
    it(`validator rejects ${label}`, () => {
      let err = null;
      try {
        X.validateExperiment(def);
      } catch (e) {
        err = e;
      }
      assert.ok(err instanceof X.ExperimentError && (!needle || err.message.includes(needle)), err ? err.message : 'accepted');
    });
  };
  it('validator accepts the minimal def', () => {
    assert.doesNotThrow(() => X.validateExperiment(base));
  });
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

  it('validator rejects a junk snapshot', () => {
    let msg = '';
    try {
      X.validateExperiment({ id: 'bad-snap', title: 'x', config: { mode: 'lorentz-sled' }, steps: [{ at: 0, record: ['lorentzForceN'], until: 1 }], snapshot: { format: 'nope' } });
    } catch (err) { msg = String(err.message); }
    assert.ok(/snapshot/.test(msg), msg);
  });
});

// Tour steps that `run` an experiment must name a shipped one (or carry a valid snippet).
describe('tour steps that run experiments', () => {
  const TOUR_DIR = join(ROOT, 'src/seg-explainer');
  const refIds = new Set(files.map((f) => f.replace(/\.experiment\.json$/, '')));
  let tourRuns = 0;
  for (const f of readdirSync(TOUR_DIR).filter((n) => n.endsWith('-tour.json'))) {
    const tour = JSON.parse(readFileSync(join(TOUR_DIR, f), 'utf8'));
    (tour.steps ?? []).forEach((step, i) => {
      if (step.run === undefined) return;
      tourRuns++;
      if (typeof step.run === 'string') {
        it(`${f} step ${i}: run names a shipped experiment`, () => {
          assert.ok(refIds.has(step.run), step.run);
        });
        return;
      }
      it(`${f} step ${i}: run snippet validates`, () => {
        const def = X.tourExperimentDef(step.run, step, tour.id ?? 'tour', i);
        assert.doesNotThrow(() => X.validateExperiment(def));
      });
    });
  }
  it('at least one tour step runs an experiment', () => {
    assert.ok(tourRuns > 0);
  });
});

describe('knobs, sweep grid, conditions, fits', () => {
  it('alias lorentz-sled.fieldT → lorentzField', () => {
    assert.equal(X.canonicalKnobId('lorentz-sled.fieldT'), 'lorentz-sled.lorentzField');
  });
  it('every catalog setpoint is a knob', () => {
    assert.ok(['pulse-coil.pulseCoilCharge', 'halbach-viz.halbachSegments', 'lorentz-sled.lorentzField', 'drop-tube.dropTubeSigma'].every((k) => X.knobSpec(k)));
  });
  it('sweep grid is the cartesian product', () => {
    const grid = X.sweepGrid({ a: { from: 0, to: 1, n: 3 }, b: { values: [5, 6] } });
    assert.ok(grid.length === 6 && grid[0].a === 0 && grid[0].b === 5 && grid[5].a === 1 && grid[5].b === 6, JSON.stringify(grid));
  });
  it('meets gt', () => {
    assert.ok(X.meets(1, { gt: 0.5 }) && !X.meets(0.5, { gt: 0.5 }));
  });
  it('meets approx (default 1 %)', () => {
    assert.ok(X.meets(1.009, { approx: 1 }) && !X.meets(1.02, { approx: 1 }));
  });
  it('meets approx tol', () => {
    assert.ok(X.meets(1.05, { approx: 1, tol: 0.1 }) && !X.meets(1.2, { approx: 1, tol: 0.1 }));
  });
  it('NaN never meets', () => {
    assert.ok(!X.meets(Number.NaN, { lt: 1 }));
  });
  it('condition text', () => {
    assert.equal(X.conditionText('R²', { gt: 0.98 }), 'R² > 0.98');
  });
  it('proportional fit', () => {
    const pf = X.proportionalFit([1, 2, 3], [2, 4, 6]);
    assert.ok(Math.abs(pf.slope - 2) < 1e-12 && Math.abs(pf.r2 - 1) < 1e-12, JSON.stringify(pf));
  });
  it('rms', () => {
    assert.ok(Math.abs(X.reduce([3, -3, 3, -3], 'rms') - 3) < 1e-12);
  });
});

// Interpreter timing on a hand-driven clock: a set lands on the first batch at
// or after its time; a ramp writes its end value once; rows carry clock time.
describe('interpreter on a ragged clock', () => {
  let interp;
  const writes = [];
  // A ragged frame clock, like a live run with a hitch at t ≈ 1.3 s.
  const clock = [0, 0.3, 0.6, 0.9, 1.0, 1.3, 1.9, 2.1, 2.4, 2.7, 3.0];
  before(() => {
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
    interp = new X.ExperimentInterpreter(v);
    let drive = 0;
    const host = { write: (k, x) => { writes.push([k, x]); drive = x; }, read: () => drive };
    for (let i = 0; i < clock.length; i++) {
      interp.applyDue(clock[i], host);
      if (i + 1 < clock.length) interp.observe(clock[i + 1], host);
    }
  });
  it('set lands on the first batch after its time', () => {
    assert.ok(writes[0][0] === 'drive' && writes[0][1] === 0.25);
  });
  it('ramp values follow the clock', () => {
    const rampWrites = writes.slice(1).map(([, x]) => x);
    assert.ok(JSON.stringify(rampWrites.map((x) => +x.toFixed(3))) === JSON.stringify([0, 0.3, 0.9, 1]), JSON.stringify(rampWrites));
  });
  it('rows carry the clock time', () => {
    assert.ok(interp.rows.every((r) => clock.includes(+r[0].toFixed(6))), JSON.stringify(interp.rows));
  });
  it('at most one row per batch', () => {
    assert.ok(new Set(interp.rows.map((r) => r[0])).size === interp.rows.length);
  });
  it('interpreter done at the end', () => {
    assert.ok(interp.done);
  });
});

// The live runner's batch cut: frames of 10 s (a starved SwiftShader page)
// still land every set, ramp end and record tick on its own time.
describe('live batch cut with slow frames', () => {
  let interp;
  const batches = [];
  before(() => {
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
    interp = new X.ExperimentInterpreter(v);
    let drive = 0;
    const host = { write: (_k, x) => { drive = x; }, read: () => drive };
    let t = 0;
    let frames = 0;
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
  });
  it('slow frames: a sample on every 0.1 s tick', () => {
    const times = interp.rows.map((r) => +r[0].toFixed(9));
    assert.ok(JSON.stringify(times) === JSON.stringify([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]), JSON.stringify(times));
  });
  it('slow frames: no batch over the cap', () => {
    assert.ok(batches.every((b) => b.reduce((a, x) => a + x, 0) <= X.MAX_LIVE_BATCH_S + 1e-12 && b.every((x) => x <= 1 / 60 + 1e-12)));
  });
  it('slow frames: batches end on the ramp start and end', () => {
    const ends = [];
    batches.reduce((acc, b) => { const e = acc + b.reduce((x, y) => x + y, 0); ends.push(+e.toFixed(9)); return e; }, 0);
    assert.ok(ends.includes(0.25) && ends.includes(0.75), JSON.stringify(ends));
  });
  // Knobs are held over a batch: the 0.4 row reads what was written at 0.3.
  it('slow frames: ramp value held from its batch start', () => {
    assert.ok(interp.rows.find((r) => Math.abs(r[0] - 0.4) < 1e-9)?.[1].toFixed(6) === '0.100000', JSON.stringify(interp.rows));
  });
  it('slow frames: expect judged', () => {
    assert.ok(interp.expects.length === 1 && interp.expects[0].pass, JSON.stringify(interp.expects));
  });
  it('liveBatch keeps an uncut frame', () => {
    assert.ok(JSON.stringify(X.liveBatch([1 / 60, 1 / 60], 0.5)) === JSON.stringify([1 / 60, 1 / 60]));
  });
  it('liveBatch keeps a paused frame', () => {
    assert.ok(JSON.stringify(X.liveBatch([], 0.5)) === '[]');
  });
});

// §2 × §3 — an experiment from a saved operating point. A bench stepped 1 s,
// captured through JSON and restored into a fresh bench steps on bit-identically
// with the original (the C++ vector loads exactly; the JS plants and the
// operator through their layouts).
for (const backend of ['wasm', 'js']) {
  describe(`${backend}: experiment from a saved operating point`, () => {
    let v, mk, a, captured, parsed;
    before(() => {
      v = X.validateExperiment({
        id: 'resume',
        title: 'resume',
        config: { mode: 'lorentz-sled' },
        steps: [{ at: 0, record: ['lorentzForceN', 'lorentzSledVms'], hz: 60, until: 0.5 }]
      });
      mk = () => new X.ExperimentBench(v.focus, v.devices, v.config, backend === 'wasm' ? X.SEGSim.fromModule(wasmMod) : null, wasmMod);
      a = mk();
      X.knobSpec('drive').write(a, 1);
      X.knobSpec('lorentz-sled.fieldT').write(a, 0.3);
      for (let i = 0; i < 60; i++) a.step(1 / 60);
      captured = a.capture(1, 42);
      parsed = X.parsePlantSnapshot(JSON.parse(JSON.stringify(captured)));
    });

    it(`${backend}: bench snapshot parses`, () => {
      assert.ok(parsed.snapshot && !parsed.errors.length, parsed.errors.join('; '));
    });
    it(`${backend}: bench snapshot backend`, () => {
      assert.ok(captured.backend === (backend === 'wasm' ? 'wasm' : 'js') && (backend === 'js') === !captured.wasm, captured.backend);
    });
    it(`${backend}: restore has no warnings; a restored bench steps on bit-identically (2 s)`, () => {
      const b = mk();
      const warnings = b.restore(parsed.snapshot);
      assert.ok(warnings.length === 0, `restore has no warnings — ${warnings.join('; ')}`);
      let worst = '';
      for (let i = 0; i < 120 && !worst; i++) {
        a.step(1 / 60);
        b.step(1 / 60);
        const sa = X.saveDeviceState('lorentz-sled', a.devices['lorentz-sled'].physicsState);
        const sb = X.saveDeviceState('lorentz-sled', b.devices['lorentz-sled'].physicsState);
        for (const k of Object.keys(sa)) {
          if (!Object.is(sa[k], sb[k])) { worst = `step ${i}: ${k} ${sa[k]} vs ${sb[k]}`; break; }
        }
        const oa = X.saveDeviceState('seg', a.operator.physics);
        const ob = X.saveDeviceState('seg', b.operator.physics);
        for (const k of Object.keys(oa)) {
          if (!worst && !Object.is(oa[k], ob[k])) worst = `step ${i}: seg.${k} ${oa[k]} vs ${ob[k]}`;
        }
      }
      assert.ok(!worst, `a restored bench steps on bit-identically (2 s) — ${worst}`);
    });

    // The run itself starts from the operating point (a moving sled), not from rest.
    it(`${backend}: an experiment with a snapshot starts at its operating point`, () => {
      const fresh = runOnce(v, backend);
      const resumed = X.runExperimentSync(X.validateExperiment({ ...v.def, snapshot: captured }), {
        cpp: backend === 'wasm' ? X.SEGSim.fromModule(wasmMod) : null,
        cppModule: wasmMod
      });
      const at0 = (run, k) => run.rows[0][run.columns.indexOf(k)];
      const cap = captured.devices['lorentz-sled'];
      assert.ok(cap.lorentzSledVms > 0.01 && at0(resumed, 'lorentzSledVms') === cap.lorentzSledVms
        && at0(resumed, 'lorentzForceN') === cap.lorentzForceN && at0(fresh, 'lorentzSledVms') === 0,
      `v: resumed ${at0(resumed, 'lorentzSledVms')}, captured ${cap.lorentzSledVms}, fresh ${at0(fresh, 'lorentzSledVms')}`);
    });
  });
}
