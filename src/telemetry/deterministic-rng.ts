/**
 * Seeded PRNG for reproducible particle initialization and replay.
 * Mulberry32 — fast, deterministic, no dependencies.
 */

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

export function setSimulationSeed(seed: number): void {
  _seed = seed >>> 0;
  _rng = mulberry32(_seed);
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem('seg-sim-seed', String(_seed)); } catch { /* ignore */ }
  }
}

export function clearSimulationSeed(): void {
  _seed = null;
  _rng = null;
  try { localStorage.removeItem('seg-sim-seed'); } catch { /* ignore */ }
}

/** Deterministic [0,1) when seeded; otherwise Math.random(). */
export function simRandom(): number {
  return _rng ? _rng() : Math.random();
}

/** Restore seed from localStorage if present. */
export function restoreSimulationSeedFromStorage(): void {
  try {
    const raw = localStorage.getItem('seg-sim-seed');
    if (raw != null && raw !== '') setSimulationSeed(Number(raw) >>> 0);
  } catch { /* ignore */ }
}
