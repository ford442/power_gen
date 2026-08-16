/**
 * JS reduce / map — always available; also the golden for WASM / WebGPU.
 */

import type { MapScaleOpts, ReduceAccum, ReduceResult } from './types';

export const CHORES_GOLDEN_INPUT = Object.freeze([1, -2, 3, 0, 4]);

/** Fixture expected by native `--mode chores` and scripts/test-gpu-chores.mjs */
export const CHORES_GOLDEN_ACCUM: Readonly<ReduceAccum> = Object.freeze({
  sum: 6,
  min: -2,
  max: 4,
  sumSq: 30,
  count: 5
});

export function emptyAccum(): ReduceAccum {
  return {
    sum: 0,
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
    sumSq: 0,
    count: 0
  };
}

export function reduceF32Js(data: ArrayLike<number>): ReduceAccum {
  const acc = emptyAccum();
  const n = data.length;
  for (let i = 0; i < n; i++) {
    const x = data[i];
    if (!Number.isFinite(x)) continue;
    acc.sum += x;
    if (x < acc.min) acc.min = x;
    if (x > acc.max) acc.max = x;
    acc.sumSq += x * x;
    acc.count += 1;
  }
  if (acc.count === 0) {
    acc.min = 0;
    acc.max = 0;
  }
  return acc;
}

export function finalizeReduce(acc: ReduceAccum, backend: ReduceResult['backend']): ReduceResult {
  const n = acc.count > 0 ? acc.count : 1;
  const energy = 0.5 * acc.sumSq;
  const rms = Math.sqrt(Math.max(0, acc.sumSq / n));
  return {
    ...acc,
    min: acc.count ? acc.min : 0,
    max: acc.count ? acc.max : 0,
    rms,
    energy,
    backend
  };
}

export function mapScaleF32Js(data: ArrayLike<number>, opts: MapScaleOpts = {}): Float32Array {
  const a = opts.scale ?? 1;
  const b = opts.bias ?? 0;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    out[i] = Number.isFinite(x) ? a * x + b : 0;
  }
  return out;
}

export function mergeAccum(into: ReduceAccum, part: ReduceAccum): ReduceAccum {
  into.sum += part.sum;
  into.sumSq += part.sumSq;
  into.count += part.count;
  if (part.count > 0) {
    if (part.min < into.min) into.min = part.min;
    if (part.max > into.max) into.max = part.max;
  }
  return into;
}
