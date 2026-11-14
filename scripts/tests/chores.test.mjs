/**
 * chores — goldens for gpu-chores reduce_f32 / map_scale (JS reference).
 * Native C++ uses the same fixture via `sim_core_test --mode chores`.
 *
 * Usage: npm run test:chores   (node --test scripts/tests/chores.test.mjs)
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { near, ROOT } from '../test-harness.mjs';

const INPUT = [1, -2, 3, 0, 4];
const GOLDEN = { sum: 6, min: -2, max: 4, sumSq: 30, count: 5 };

function reduceJs(data) {
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let sumSq = 0;
  let count = 0;
  for (const x of data) {
    if (!Number.isFinite(x)) continue;
    sum += x;
    if (x < min) min = x;
    if (x > max) max = x;
    sumSq += x * x;
    count += 1;
  }
  return { sum, min, max, sumSq, count };
}

describe('gpu-chores JS goldens', () => {
  const got = reduceJs(INPUT);
  for (const k of Object.keys(GOLDEN)) {
    it(`reduce_f32 ${k}`, () => {
      assert.ok(near(got[k], GOLDEN[k], 1e-5), `JS golden fail ${k}: got ${got[k]} expected ${GOLDEN[k]}`);
    });
  }

  it('map_scale element 0', () => {
    const mapped0 = 0.8 * INPUT[0] + 0.2;
    assert.ok(near(mapped0, 1, 1e-5), `JS map golden fail: ${mapped0}`);
  });
});

const native = join(ROOT, 'cpp', 'build', 'sim_core_test');
describe('gpu-chores native goldens', () => {
  it('sim_core_test --mode chores', {
    skip: existsSync(native) ? false : 'native binary missing — JS goldens only (run npm run wasm:native)'
  }, () => {
    const r = spawnSync(native, ['--mode', 'chores'], { encoding: 'utf8' });
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    assert.equal(r.status, 0, `native --mode chores failed: ${r.stderr || r.stdout}`);
  });
});
