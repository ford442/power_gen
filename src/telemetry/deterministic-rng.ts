/**
 * Seeded PRNG for reproducible particle initialization and replay.
 * Mulberry32 — fast, deterministic. The seed is a LabConfig field: `?seed=`,
 * a share link, or the value remembered in `seg-sim-seed`.
 */
import { labConfigResolved, persistLabConfig } from '../config/lab-config';

let _seed: number | null = null;
let _rng: (() => number) | null = null;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function getSimulationSeed(): number | null {
  return _seed;
}

/**
 * Seed the PRNG. `persist` (default) remembers it for the next load; a seed
 * that came from a link is applied without rewriting the remembered one.
 */
export function setSimulationSeed(seed: number, persist = true): void {
  _seed = seed >>> 0;
  _rng = mulberry32(_seed);
  if (persist) persistLabConfig('seed', _seed);
}

export function clearSimulationSeed(): void {
  _seed = null;
  _rng = null;
  persistLabConfig('seed', null);
}

/** Deterministic [0,1) when seeded; otherwise Math.random(). */
export function simRandom(): number {
  return _rng ? _rng() : Math.random();
}

/** Boot: seed from `?seed=` / share link / storage, if any of them has one. */
export function restoreSimulationSeed(): void {
  const { config, sources } = labConfigResolved();
  if (config.seed != null) setSimulationSeed(config.seed, sources.seed === 'storage');
}
