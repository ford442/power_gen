#!/usr/bin/env node
/**
 * validate.mjs — `npm run validate`, the whole suite CI runs (validate.yml).
 *
 * Steps form a small dependency graph and run as soon as what they need is
 * done, at most one per core. The stage names group the summary table:
 *
 *   codegen  regenerate committed outputs (writes files, so it runs first and
 *            serially; CI's `git diff --exit-code` then catches stale commits)
 *   checks   drift checks, typecheck, lint, file size, contracts — read-only,
 *            after codegen
 *   native   wasm:native (the C++ plant), after codegen — it does not wait for
 *            the checks, so it overlaps lint (the slowest check)
 *   tests    node:test over scripts/tests/*.test.mjs (the goldens and snapshots
 *            need the native build — test:circuit's ten circuit goldens and
 *            their WASM replay among them) + the entry-chunk and
 *            bundle-budget builds
 *   gpu      Dawn-in-Node (scripts/tests/gpu/): test:pipelines compiles every
 *            production pipeline, test:gpu-golden runs the compute passes
 *            against their CPU twins. Both skip with a notice when Dawn has
 *            no adapter; REQUIRE_GPU=1 (CI) makes that a failure
 *
 * Every step runs even after another fails, so one red run shows every
 * problem. Ends with a per-step pass/fail + seconds table and exits non-zero
 * if any step failed.
 *
 * Output: a passing step prints one line; a failing step prints its full
 * output. `--verbose` prints every step's output. Under GitHub Actions each
 * step's output is folded into a `::group::`.
 *
 * Usage: node scripts/validate.mjs [--verbose] [--only=name,name]
 */
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORES = Math.max(1, availableParallelism());
const VERBOSE = process.argv.includes('--verbose');
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',');
const GHA = process.env.GITHUB_ACTIONS === 'true';

const npm = (script, needs = []) => ({ name: script, cmd: 'npm', args: ['run', '--silent', script], needs });

const CODEGEN = ['codegen:constants', 'codegen:catalog', 'codegen:lab-config', 'codegen:wasm-abi'];
const STEPS = [
  // Serial chain: each codegen writes files the next may read.
  { stage: 'codegen', ...npm('codegen:constants') },
  { stage: 'codegen', ...npm('codegen:catalog', ['codegen:constants']) },
  { stage: 'codegen', ...npm('codegen:lab-config', ['codegen:catalog']) },
  { stage: 'codegen', ...npm('codegen:wasm-abi', ['codegen:lab-config']) },
  // Ready steps start in this order, so the long poles come first.
  { stage: 'native', ...npm('wasm:native', CODEGEN) },
  ...['lint', 'typecheck', 'check:constants', 'check:catalog', 'check:lab-config', 'check:wasm-abi', 'check:bindings',
    'check:file-size', 'check:post', 'check:wgsl', 'check:toolchain', 'test:stacked-prs'].map((n) => ({ stage: 'checks', ...npm(n, CODEGEN) })),
  // Direct `node --test` (not the npm alias) so concurrency is the core count.
  {
    stage: 'tests',
    name: 'test:unit',
    cmd: process.execPath,
    args: ['--test', `--test-concurrency=${CORES}`, '--test-reporter=spec', 'scripts/tests/*.test.mjs'],
    needs: ['wasm:native']
  },
  { stage: 'tests', ...npm('check:entry-chunk', CODEGEN) },
  { stage: 'tests', ...npm('check:bundle-budget', CODEGEN) },
  // After the checks' long poles have started: a software rasteriser uses every core.
  { stage: 'gpu', ...npm('test:pipelines', CODEGEN) },
  { stage: 'gpu', ...npm('test:gpu-golden', CODEGEN) }
];

function run(step) {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const child = spawn(step.cmd, step.args, {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? (process.stdout.isTTY ? '1' : '0') },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32'
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const done = (code) => resolve({ ...step, code, out, secs: (performance.now() - t0) / 1000 });
    child.on('error', (err) => { out += `\n${err.stack ?? err}`; done(127); });
    child.on('close', (code, signal) => done(code ?? (signal ? 128 : 1)));
  });
}

/**
 * `[tool] SKIP: reason` lines a step printed while still exiting 0 (no GPU
 * adapter, no naga). Shown even when the step passes: a skipped gate that
 * looks green is how coverage quietly disappears.
 */
function skipNotices(r) {
  if (r.code !== 0) return [];
  return [...new Set(r.out.match(/^\[[\w:-]+\] SKIP: .*$/gm) ?? [])];
}

function report(r) {
  const skips = skipNotices(r);
  const mark = r.code !== 0 ? 'FAIL' : skips.length ? 'skip' : 'ok  ';
  const line = `[validate] ${mark} ${r.name} (${r.secs.toFixed(1)} s)`;
  const show = r.code !== 0 || VERBOSE;
  if (GHA) {
    console.log(`::group::${line}`);
    process.stdout.write(r.out);
    console.log('::endgroup::');
    if (r.code !== 0) console.log(`::error title=validate: ${r.name}::${r.name} exited ${r.code}`);
  } else {
    console.log(line);
  }
  if (show && !GHA && r.out.trim()) process.stdout.write(`${r.out.replace(/^/gm, '  │ ')}\n`);
  else for (const notice of skips) console.log(`${GHA ? '::warning title=validate: skipped::' : '  │ '}${r.name}: ${notice}`);
}

/**
 * Start each step once its `needs` have finished (pass or fail — every step
 * runs), at most CORES at a time, in declaration order among the ready ones.
 */
async function schedule(steps) {
  const done = new Set();
  const started = new Set();
  const results = new Map();
  let running = 0;
  if (!steps.length) return [];
  return new Promise((resolve) => {
    const pump = () => {
      for (const step of steps) {
        if (running >= CORES) break;
        if (started.has(step.name) || !step.needs.every((n) => done.has(n))) continue;
        started.add(step.name);
        running++;
        run(step).then((r) => {
          running--;
          done.add(step.name);
          results.set(step.name, r);
          report(r);
          if (done.size === steps.length) resolve(steps.map((s) => results.get(s.name)));
          else pump();
        });
      }
    };
    pump();
  });
}

const t0 = performance.now();
const selected = ONLY ? STEPS.filter((s) => ONLY.includes(s.name)) : STEPS;
const names = new Set(selected.map((s) => s.name));
// --only drops unselected steps, and with them any ordering on them.
const steps = selected.map((s) => ({ ...s, needs: s.needs.filter((n) => names.has(n)) }));
console.log(`[validate] ${steps.length} steps, up to ${CORES} at once`);
const rows = await schedule(steps);
const wall = (performance.now() - t0) / 1000;

const failed = rows.filter((r) => r.code !== 0);
const w = Math.max(...rows.map((r) => r.name.length), 4);
console.log('\n  stage    step' + ' '.repeat(w - 4) + '  result    secs');
console.log('  ' + '─'.repeat(w + 26));
for (const r of rows) {
  const result = r.code !== 0 ? `FAIL(${r.code})` : skipNotices(r).length ? 'skipped' : 'pass';
  console.log(`  ${r.stage.padEnd(8)} ${r.name.padEnd(w)}  ${result.padEnd(8)} ${r.secs.toFixed(1).padStart(6)}`);
}
console.log('  ' + '─'.repeat(w + 26));
const cpu = rows.reduce((a, r) => a + r.secs, 0);
const skipped = rows.filter((r) => skipNotices(r).length).length;
console.log(`  ${rows.length - failed.length}/${rows.length} passed${skipped ? ` (${skipped} skipped — see notices above)` : ''} · wall ${wall.toFixed(1)} s · sum of steps ${cpu.toFixed(1)} s · ${CORES} cores`);
if (failed.length) {
  console.log(`\n[validate] FAILED: ${failed.map((r) => r.name).join(', ')}`);
  process.exit(1);
}
