/**
 * catalog-fluid.mjs — the `fluid` half of codegen-device-catalog (ADR-0022,
 * docs/FLUIDS.md).
 *
 * A bench whose liquid runs on the MLS-MPM solver says so in
 * physics/devices.json:
 *
 *   "fluid": {
 *     "solver": "mpm",                     the only one there is
 *     "what": "the jet and its fall",      what of the bench is simulated
 *     "tiers": {                           budgets per solver tier (`fluid=`)
 *       "low":     { "grid": 32, "particles": 15000 },
 *       "default": { "grid": 64, "particles": 40000 },
 *       "high":    { "grid": 96, "particles": 120000 }
 *     },
 *     "draw": "surface",                   "surface" (screen-space, from the
 *                                          medium quality tier) | "particles"
 *     "fallback": "…",                     what WebGL2 draws instead
 *     "model": "one line: what is idealised"
 *   }
 *
 * `grid` is a node budget of grid³ — the bench's scene shapes the box
 * (src/fluids/<bench>-liquid.ts). A tier that is left out takes the next
 * lower one's budget, so a bench with one size writes only `low`.
 *
 * Scale and time scale are physics and stay in physics/constants.json; the
 * solver's own limits are checked where the scene is built
 * (`validateMpmConfig`), which knows the cell and the step.
 *
 * Emits generated/device-fluids.ts and the "Liquid solvers" section of
 * docs/MODE_MATRIX.md (emitFluidMatrix).
 */

const FLUID_KEYS = ['solver', 'what', 'tiers', 'draw', 'fallback', 'model'];
export const FLUID_TIERS = ['low', 'default', 'high'];
const SOLVERS = ['mpm'];
const DRAWS = ['surface', 'particles'];
/** Largest grid edge a tier may ask for: 128³ nodes is 100 MB of grid. */
const MAX_GRID = 128;
const MAX_PARTICLES = 500000;

/** Validation errors for every device's `fluid`. */
export function validateFluid(devices) {
  const errors = [];
  for (const d of devices) {
    if (d.fluid === undefined) continue;
    const where = `${d.id}.fluid`;
    const f = d.fluid;
    if (!f || typeof f !== 'object' || Array.isArray(f)) {
      errors.push(`${where}: an object`);
      continue;
    }
    for (const k of Object.keys(f)) if (!FLUID_KEYS.includes(k)) errors.push(`${where}: unknown property "${k}"`);
    if (!SOLVERS.includes(f.solver)) errors.push(`${where}.solver: one of ${SOLVERS.join(', ')}`);
    if (!DRAWS.includes(f.draw)) errors.push(`${where}.draw: one of ${DRAWS.join(', ')}`);
    for (const k of ['what', 'fallback', 'model']) {
      if (typeof f[k] !== 'string' || !f[k]) errors.push(`${where}.${k}: a string`);
    }
    if (!f.tiers || typeof f.tiers !== 'object' || Array.isArray(f.tiers)) {
      errors.push(`${where}.tiers: an object with at least "low"`);
      continue;
    }
    for (const k of Object.keys(f.tiers)) if (!FLUID_TIERS.includes(k)) errors.push(`${where}.tiers: unknown tier "${k}"`);
    if (!f.tiers.low) errors.push(`${where}.tiers.low: required — the other tiers fall back to it`);
    let last = null;
    for (const tier of FLUID_TIERS) {
      const t = f.tiers[tier];
      if (t === undefined) continue;
      const at = `${where}.tiers.${tier}`;
      if (!t || typeof t !== 'object') {
        errors.push(`${at}: { grid, particles }`);
        continue;
      }
      for (const k of Object.keys(t)) if (k !== 'grid' && k !== 'particles') errors.push(`${at}: unknown property "${k}"`);
      if (!Number.isInteger(t.grid) || t.grid < 8 || t.grid > MAX_GRID) errors.push(`${at}.grid: an integer in 8…${MAX_GRID} (a budget of grid³ nodes)`);
      if (!Number.isInteger(t.particles) || t.particles < 1 || t.particles > MAX_PARTICLES) errors.push(`${at}.particles: an integer in 1…${MAX_PARTICLES}`);
      if (last && (t.grid < last.grid || t.particles < last.particles)) errors.push(`${at}: smaller than the tier below it`);
      last = t;
    }
  }
  return errors;
}

/** Every tier's budget, a missing tier taking the next lower one's. */
export function resolveFluidTiers(fluid) {
  const out = {};
  let last = null;
  for (const tier of FLUID_TIERS) {
    const t = fluid.tiers[tier] ?? last;
    out[tier] = { grid: t.grid, particles: t.particles };
    last = t;
  }
  return out;
}

export function emitDeviceFluidsTs(devices, header) {
  const rows = devices.filter((d) => d.fluid).map((d) => {
    const f = d.fluid;
    return `  ${JSON.stringify(d.id)}: ${JSON.stringify({ solver: f.solver, what: f.what, tiers: resolveFluidTiers(f), draw: f.draw, fallback: f.fallback, model: f.model })}`;
  });
  return `${header}
/** Solver tiers a \`fluid=\` choice resolves to (src/visualizer/heron-liquid-pass.ts → liquidTierFor). */
export type FluidTier = ${FLUID_TIERS.map((t) => `'${t}'`).join(' | ')};

export interface FluidTierBudget {
  /** Node budget: grid³. The bench's scene shapes the box. */
  grid: number;
  /** Particle slots. */
  particles: number;
}

export interface DeviceFluid {
  solver: ${SOLVERS.map((s) => `'${s}'`).join(' | ')};
  /** What of the bench is simulated. */
  what: string;
  tiers: Readonly<Record<FluidTier, FluidTierBudget>>;
  /** \`surface\`: a screen-space surface from the medium quality tier, particles below; \`particles\`: always particles. */
  draw: ${DRAWS.map((s) => `'${s}'`).join(' | ')};
  /** What WebGL2 draws instead. */
  fallback: string;
  /** What is idealised. */
  model: string;
}

/** Benches with a \`fluid\` block in physics/devices.json. */
export type FluidDeviceId = ${devices.filter((d) => d.fluid).map((d) => `'${d.id}'`).join(' | ') || 'never'};

export const DEVICE_FLUIDS: Readonly<Record<FluidDeviceId, DeviceFluid>> = {
${rows.join(',\n')}
};

export const FLUID_DEVICE_IDS: readonly FluidDeviceId[] = ${JSON.stringify(devices.filter((d) => d.fluid).map((d) => d.id))};
`;
}

/** The MODE_MATRIX.md section: which benches have a simulated liquid, and at what size. */
export function emitFluidMatrix(devices) {
  const md = (t) => String(t).replace(/\|/g, '\\|');
  const n = (v) => v.toLocaleString('en-US');
  const rows = devices.filter((d) => d.fluid).map((d) => {
    const f = d.fluid;
    const tiers = resolveFluidTiers(f);
    const same = FLUID_TIERS.every((t) => tiers[t].grid === tiers.low.grid && tiers[t].particles === tiers.low.particles);
    const budget = same
      ? `${tiers.low.grid}³ / ${n(tiers.low.particles)} at every tier`
      : FLUID_TIERS.map((t) => `\`${t}\` ${tiers[t].grid}³ / ${n(tiers[t].particles)}`).join('<br>');
    const draw = f.draw === 'surface' ? 'screen-space surface from the `medium` quality tier; particles below it, and for spray' : 'particles';
    return `| \`${d.id}\` | \`${f.solver}\` — ${md(f.what)} | ${budget} | ${draw} | ${md(f.fallback)} | ${md(f.model)} |`;
  });
  return `## Liquid solvers

A \`fluid\` block puts a bench's liquid on the MLS-MPM solver
([ADR-0022](adr/0022-gpu-liquid-mls-mpm.md), [\`FLUIDS.md\`](FLUIDS.md)):
WebGPU only, and only while that bench is in focus — overview allocates
none of it. \`fluid=auto|off|low|high\` picks the tier; \`auto\` follows the
profiler and steps down, never back up. Budgets are a node budget (grid³,
shaped to the bench by its scene) and particle slots. The MHD duct's
lattice-Boltzmann slice is a solver of its own, with one size and no
particles, and is not in this table ([\`FLUIDS.md\`](FLUIDS.md#the-slice)).
Every other bench's "fluid" is a picture of its plant.

| Device \`id\` | Solver — what is simulated | Grid nodes / particles | Drawn as | WebGL2 instead | Idealised |
|---|---|---|---|---|---|
${rows.join('\n')}
`;
}
