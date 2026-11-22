/**
 * Calibration profile (#257 §3, ADR-0019): what one "Calibrate" produced — the
 * fitted rig parameters as deltas on the catalog nominal, their covariance
 * (relative σ + correlation), the fit R² per sensor — as a compact string the
 * LabConfig `twinProfile` field carries in `#lab2=` links and `.lab.json`.
 *
 *   tp1;h=<rig hash>;d=<θᵢ/θᵢ,nom − 1 …>;s=<σᵢ/θᵢ …>;c=<ρ₀₁,ρ₀₂ … (upper triangle)>;
 *       r=<R² per sensor, n = absent>;x=<χ²_red>;w=<warning bits>;n=<samples>;T=<s>
 *
 * The hash pins the catalog rig (param ids, nominal, bounds; sensor ids): a
 * profile fitted against another rig is refused rather than misapplied. Every
 * θ must sit inside the catalog [min, max]. Simulated, not metrology: the
 * numbers say how well *this model* fits *that run*, nothing more.
 */
import { TWIN_RIG } from '../../generated/twin-rig';

const NP = TWIN_RIG.params.length;
const M = TWIN_RIG.sensors.length;

export const TWIN_PROFILE_PREFIX = 'tp1';

/** Warning bits (cpp/src/twin/sysid.h): bit i = θᵢ not identified, then these. */
export const SYSID_WARN = { SINGULAR: 1 << 16, NOT_CONVERGED: 1 << 17, POOR_FIT: 1 << 18 } as const;

export interface TwinProfile {
  /** Fitted θ, catalog order. */
  theta: number[];
  /** σ(θᵢ)/θᵢ. */
  relSigma: number[];
  /** Correlation matrix, row-major NP×NP. */
  corr: number[];
  /** Fit R² per sensor (NaN: the channel was not in the run). */
  r2: number[];
  reducedChi2: number;
  warnings: number;
  samples: number;
  durationS: number;
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Hash of the catalog rig a profile applies to. */
export const TWIN_RIG_HASH = fnv1a(JSON.stringify({
  p: TWIN_RIG.params.map((p) => [p.id, p.nominal, p.min, p.max]),
  y: TWIN_RIG.sensors.map((s) => s.id)
}));

const num = (v: number, digits = 5): string => (Number.isFinite(v) ? Number(v.toPrecision(digits)).toString() : 'n');

/** Covariance of θ (row-major NP×NP) from a profile's relative σ and correlation. */
export function profileCovariance(p: TwinProfile): number[] {
  const out = new Array<number>(NP * NP).fill(0);
  for (let i = 0; i < NP; i++) {
    for (let j = 0; j < NP; j++) {
      out[i * NP + j] = p.theta[i] * p.theta[j] * p.relSigma[i] * p.relSigma[j] * p.corr[i * NP + j];
    }
  }
  return out;
}

/** Correlation (row-major) from a covariance; diagonal 1, NaN-safe. */
export function correlationOf(cov: readonly number[], n = NP): number[] {
  const out = new Array<number>(n * n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const d = Math.sqrt(cov[i * n + i] * cov[j * n + j]);
      out[i * n + j] = i === j ? 1 : d > 0 && Number.isFinite(d) ? Math.max(-1, Math.min(1, cov[i * n + j] / d)) : 0;
    }
  }
  return out;
}

export function encodeTwinProfile(p: TwinProfile): string {
  const d = p.theta.map((t, i) => num(t / TWIN_RIG.params[i].nominal - 1, 6));
  const s = p.relSigma.map((v) => num(v, 3));
  const c: string[] = [];
  for (let i = 0; i < NP; i++) for (let j = i + 1; j < NP; j++) c.push(num(p.corr[i * NP + j], 3));
  return [
    TWIN_PROFILE_PREFIX,
    `h=${TWIN_RIG_HASH}`,
    `d=${d.join(',')}`,
    `s=${s.join(',')}`,
    `c=${c.join(',')}`,
    `r=${p.r2.map((v) => num(v, 4)).join(',')}`,
    `x=${num(p.reducedChi2, 4)}`,
    `w=${p.warnings >>> 0}`,
    `n=${Math.round(p.samples)}`,
    `T=${num(p.durationS, 4)}`
  ].join(';');
}

function numbers(text: string | undefined, n: number, allowNaN: boolean): number[] | null {
  if (text === undefined) return null;
  const parts = text.split(',');
  if (parts.length !== n) return null;
  const out = parts.map((t) => (t === 'n' ? NaN : Number(t)));
  return out.every((v) => Number.isFinite(v) || (allowNaN && Number.isNaN(v))) ? out : null;
}

/** Parse + validate a `tp1;…` profile. */
export function decodeTwinProfile(text: unknown): { profile: TwinProfile | null; error: string | null } {
  const fail = (error: string) => ({ profile: null, error });
  if (typeof text !== 'string' || !text.startsWith(`${TWIN_PROFILE_PREFIX};`)) return fail('not a tp1 calibration profile');
  const f = new Map<string, string>();
  for (const part of text.split(';').slice(1)) {
    const eq = part.indexOf('=');
    if (eq > 0) f.set(part.slice(0, eq), part.slice(eq + 1));
  }
  if (f.get('h') !== TWIN_RIG_HASH) return fail(`profile is for another rig (hash ${f.get('h') ?? 'none'}, this catalog ${TWIN_RIG_HASH})`);
  const d = numbers(f.get('d'), NP, false);
  const s = numbers(f.get('s'), NP, false);
  const c = numbers(f.get('c'), (NP * (NP - 1)) / 2, false);
  const r = numbers(f.get('r'), M, true);
  if (!d || !s || !c || !r) return fail('profile fields d / s / c / r are missing or the wrong length');
  const theta = d.map((v, i) => TWIN_RIG.params[i].nominal * (1 + v));
  for (let i = 0; i < NP; i++) {
    const p = TWIN_RIG.params[i];
    if (!(theta[i] >= p.min * (1 - 1e-6) && theta[i] <= p.max * (1 + 1e-6))) {
      return fail(`${p.id} = ${theta[i]} is outside the catalog range [${p.min}, ${p.max}]`);
    }
  }
  if (s.some((v) => v < 0) || c.some((v) => v < -1 || v > 1)) return fail('profile σ must be ≥ 0 and correlations in [−1, 1]');
  const corr = new Array<number>(NP * NP).fill(0);
  let k = 0;
  for (let i = 0; i < NP; i++) {
    corr[i * NP + i] = 1;
    for (let j = i + 1; j < NP; j++) corr[i * NP + j] = corr[j * NP + i] = c[k++];
  }
  const scalar = (key: string): number => {
    const v = Number(f.get(key));
    return Number.isFinite(v) ? v : NaN;
  };
  return {
    profile: {
      theta,
      relSigma: s,
      corr,
      r2: r,
      reducedChi2: scalar('x'),
      warnings: (scalar('w') >>> 0) || 0,
      samples: scalar('n') || 0,
      durationS: scalar('T') || 0
    },
    error: null
  };
}

/** Plain-language list of the profile's warnings (empty: none). */
export function profileWarnings(warnings: number): string[] {
  const out: string[] = [];
  TWIN_RIG.params.forEach((p, i) => {
    if (warnings & (1 << i)) out.push(`${p.label} (${p.id}) not identified by this run — kept near its start value`);
  });
  if (warnings & SYSID_WARN.SINGULAR) out.push('JᵀJ is near-singular: some parameters trade off against each other (excite the rig more)');
  if (warnings & SYSID_WARN.NOT_CONVERGED) out.push('the fit stopped at its iteration cap');
  if (warnings & SYSID_WARN.POOR_FIT) out.push('poor fit (R² < 0.9 on a channel): the model may not describe this rig');
  return out;
}
