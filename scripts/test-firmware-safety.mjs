#!/usr/bin/env node
/**
 * test-firmware-safety.mjs — "we will not ship firmware that can lock a coil on".
 *
 * Compiles firmware/seg-driver/test/safety_test.cpp with the host C++ compiler
 * against an Arduino shim (firmware/seg-driver/test/shim/) and runs it: the
 * safety core, the coil controller and the sketch's own setup()/loop(), with
 * every pin write recorded and four invariants checked on every simulated
 * millisecond (watchdog, per-coil DC cap, bounded brake, only wired pins).
 *
 * Deliberately NOT part of `npm run validate` or CI: issue #217 keeps firmware
 * out of CI, and the web app never needs a board. Run it by hand before
 * flashing anything changed under firmware/. A missing compiler is a skip
 * (exit 0, loudly), not a pass.
 *
 * Usage: node scripts/test-firmware-safety.mjs   (exit 1 on failure)
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const FW = join(ROOT, 'firmware', 'seg-driver');

const compiler = ['c++', 'g++', 'clang++'].find(
  (cc) => spawnSync(cc, ['--version'], { stdio: 'ignore' }).status === 0
);
if (!compiler) {
  console.log('[firmware-safety] SKIPPED — no host C++ compiler (c++ / g++ / clang++) on PATH. Nothing was tested.');
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'seg-fw-safety-'));
const bin = join(dir, 'safety_test');
try {
  const build = spawnSync(compiler, [
    '-std=c++17', '-O1', '-Wall', '-Wextra',
    '-I', join(FW, 'test', 'shim'),
    '-o', bin,
    join(FW, 'test', 'safety_test.cpp'),
    join(FW, 'coil_controller.cpp'),
    join(FW, 'sensor_manager.cpp')
  ], { encoding: 'utf8' });
  if (build.status !== 0) {
    process.stderr.write(build.stderr || '');
    console.error(`[firmware-safety] build failed with ${compiler}`);
    process.exit(1);
  }
  if (build.stderr) process.stderr.write(build.stderr);

  const run = spawnSync(bin, [], { encoding: 'utf8', timeout: 120_000 });
  process.stdout.write(run.stdout || '');
  process.stderr.write(run.stderr || '');
  process.exit(run.status === 0 ? 0 : 1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
