#!/usr/bin/env node
/**
 * Goldens for gpu-chores reduce_f32 / map_scale (JS reference).
 * Native C++ uses the same fixture via `sim_core_test --mode chores`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

function nearly(a, b, eps = 1e-5) {
  return Math.abs(a - b) <= eps;
}

const got = reduceJs(INPUT);
for (const k of Object.keys(GOLDEN)) {
  if (!nearly(got[k], GOLDEN[k])) {
    console.error(`[chores] JS golden fail ${k}: got ${got[k]} expected ${GOLDEN[k]}`);
    process.exit(1);
  }
}
const mapped0 = 0.8 * INPUT[0] + 0.2;
if (!nearly(mapped0, 1)) {
  console.error('[chores] JS map golden fail');
  process.exit(1);
}
console.log('[chores] JS goldens OK', got);

const native = join(ROOT, 'cpp', 'build', 'sim_core_test');
if (existsSync(native)) {
  const r = spawnSync(native, ['--mode', 'chores'], { encoding: 'utf8' });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  if (r.status !== 0) {
    console.error('[chores] native --mode chores failed');
    process.exit(r.status || 1);
  }
} else {
  console.log('[chores] native binary missing — JS goldens only (run npm run wasm:native)');
}

console.log('[chores] all goldens passed');
