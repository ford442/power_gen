/**
 * firmware-safety — "we will not ship firmware that can lock a coil on".
 *
 * Compiles firmware/seg-driver/test/safety_test.cpp with the host C++ compiler
 * against an Arduino shim (firmware/seg-driver/test/shim/) and runs it: the
 * safety core, the coil controller and the sketch's own setup()/loop(), with
 * every pin write recorded and four invariants checked on every simulated
 * millisecond (watchdog, per-coil DC cap, bounded brake, only wired pins).
 *
 * Deliberately NOT part of `npm run validate` or CI: issue #217 keeps firmware
 * out of CI, and the web app never needs a board. It lives in scripts/tests/manual/
 * so the `scripts/tests/*.test.mjs` glob skips it. Run it by hand before
 * flashing anything changed under firmware/. A missing compiler is a skip
 * (reported loudly as skipped), not a pass.
 *
 * Usage: npm run test:firmware-safety   (node --test scripts/tests/manual/firmware-safety.test.mjs)
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ROOT } from '../../test-harness.mjs';

const FW = join(ROOT, 'firmware', 'seg-driver');

const compiler = ['c++', 'g++', 'clang++'].find(
  (cc) => spawnSync(cc, ['--version'], { stdio: 'ignore' }).status === 0
);
const skip = compiler ? false : 'no host C++ compiler (c++ / g++ / clang++) on PATH. Nothing was tested.';

describe('firmware safety core (host build)', { skip }, () => {
  let dir;
  let bin;
  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it(`builds safety_test.cpp with ${compiler ?? 'a host compiler'}`, () => {
    dir = mkdtempSync(join(tmpdir(), 'seg-fw-safety-'));
    bin = join(dir, 'safety_test');
    const build = spawnSync(compiler, [
      '-std=c++17', '-O1', '-Wall', '-Wextra',
      '-I', join(FW, 'test', 'shim'),
      '-o', bin,
      join(FW, 'test', 'safety_test.cpp'),
      join(FW, 'coil_controller.cpp'),
      join(FW, 'sensor_manager.cpp')
    ], { encoding: 'utf8' });
    if (build.stderr) process.stderr.write(build.stderr);
    assert.equal(build.status, 0, `build failed with ${compiler}: ${build.stderr || ''}`);
  });

  it('safety_test passes every invariant on every simulated millisecond', () => {
    assert.ok(bin, 'binary was built');
    const run = spawnSync(bin, [], { encoding: 'utf8', timeout: 120_000 });
    process.stdout.write(run.stdout || '');
    process.stderr.write(run.stderr || '');
    assert.equal(run.status, 0, `safety_test exited ${run.status} (signal ${run.signal}): ${(run.stdout || '').slice(-2000)}`);
  });
});
