#!/usr/bin/env node
/**
 * validate.mjs — `npm run validate`, the whole suite CI runs (validate.yml).
 *
 * Stages run in order; the steps inside a stage run in parallel (at most one
 * per core). Every step runs even after another fails, so one red run shows
 * every problem. Ends with a per-step pass/fail + seconds table and exits
 * non-zero if any step failed.
 *
 *   codegen  regenerate committed outputs (writes files, so it runs alone and
 *            serially; CI's `git diff --exit-code` then catches stale commits)
 *   checks   drift checks, typecheck, lint, file size, contracts — read-only
 *   native   wasm:native (the C++ plant; the goldens and snapshots need it)
 *   tests    node:test over scripts/tests/*.test.mjs + the entry-chunk build
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

const npm = (script) => ({ name: script, cmd: 'npm', args: ['run', '--silent', script] });

const STAGES = [
  { name: 'codegen', parallel: false, steps: [npm('codegen:constants'), npm('codegen:catalog'), npm('codegen:lab-config')] },
  {
    name: 'checks',
    parallel: true,
    steps: [
      npm('typecheck'),
      npm('lint'),
      npm('check:constants'),
      npm('check:catalog'),
      npm('check:lab-config'),
      npm('check:bindings'),
      npm('check:file-size'),
      npm('check:post'),
      npm('check:wgsl'),
      npm('test:stacked-prs')
    ]
  },
  { name: 'native', parallel: false, steps: [npm('wasm:native')] },
  {
    name: 'tests',
    parallel: true,
    steps: [
      // Direct `node --test` (not the npm alias) so concurrency is the core count.
      { name: 'test:unit', cmd: process.execPath, args: ['--test', `--test-concurrency=${CORES}`, '--test-reporter=spec', 'scripts/tests/*.test.mjs'] },
      npm('check:entry-chunk')
    ]
  }
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

function report(r) {
  const mark = r.code === 0 ? 'ok  ' : 'FAIL';
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
}

/** Run up to `limit` steps at once, reporting each as it finishes. */
async function pool(steps, limit) {
  const results = new Array(steps.length);
  let next = 0;
  const worker = async () => {
    while (next < steps.length) {
      const i = next++;
      results[i] = await run(steps[i]);
      report(results[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, steps.length) }, worker));
  return results;
}

const t0 = performance.now();
const rows = [];
for (const stage of STAGES) {
  const steps = ONLY ? stage.steps.filter((s) => ONLY.includes(s.name)) : stage.steps;
  if (!steps.length) continue;
  const s0 = performance.now();
  console.log(`[validate] ── ${stage.name}: ${steps.map((s) => s.name).join(', ')}`);
  const results = await pool(steps, stage.parallel ? CORES : 1);
  for (const r of results) rows.push({ stage: stage.name, ...r });
  console.log(`[validate] ── ${stage.name} done in ${((performance.now() - s0) / 1000).toFixed(1)} s`);
}
const wall = (performance.now() - t0) / 1000;

const failed = rows.filter((r) => r.code !== 0);
const w = Math.max(...rows.map((r) => r.name.length), 4);
console.log('\n  stage    step' + ' '.repeat(w - 4) + '  result    secs');
console.log('  ' + '─'.repeat(w + 26));
for (const r of rows) {
  console.log(`  ${r.stage.padEnd(8)} ${r.name.padEnd(w)}  ${(r.code === 0 ? 'pass' : `FAIL(${r.code})`).padEnd(8)} ${r.secs.toFixed(1).padStart(6)}`);
}
console.log('  ' + '─'.repeat(w + 26));
const cpu = rows.reduce((a, r) => a + r.secs, 0);
console.log(`  ${rows.length - failed.length}/${rows.length} passed · wall ${wall.toFixed(1)} s · sum of steps ${cpu.toFixed(1)} s · ${CORES} cores`);
if (failed.length) {
  console.log(`\n[validate] FAILED: ${failed.map((r) => r.name).join(', ')}`);
  process.exit(1);
}
