/**
 * Seeded PRNG for reproducible particle initialization and replay.
 * Mulberry32 — fast, deterministic, no dependencies.
 */

/** @type {number|null} */
let _seed = null;
/** @type {(() => number)|null} */
let _rng = null;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @returns {number|null} */
export function getSimulationSeed() {
  return _seed;
}

/**
 * @param {number} seed  Unsigned 32-bit integer seed
 */
export function setSimulationSeed(seed) {
  _seed = seed >>> 0;
  _rng = mulberry32(_seed);
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem('seg-sim-seed', String(_seed)); } catch (_) { /* ignore */ }
  }
}

export function clearSimulationSeed() {
  _seed = null;
  _rng = null;
  try { localStorage.removeItem('seg-sim-seed'); } catch (_) { /* ignore */ }
}

/** Deterministic [0,1) when seeded; otherwise Math.random(). */
export function simRandom() {
  return _rng ? _rng() : Math.random();
}

/** Restore seed from localStorage if present. */
export function restoreSimulationSeedFromStorage() {
  try {
    const raw = localStorage.getItem('seg-sim-seed');
    if (raw != null && raw !== '') setSimulationSeed(Number(raw) >>> 0);
  } catch (_) { /* ignore */ }
}
