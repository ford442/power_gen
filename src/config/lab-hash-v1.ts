/**
 * Legacy `#lab=v1;…` share-link codec. New links are `#lab2=` (share-link.ts);
 * v1 links already in the wild keep working — they decode here and map onto
 * LabConfig fields, so they enter the same precedence as everything else.
 *
 * Format: #lab=v1;mode=seg;layout=searl;drive=0.5;field=0.5;bmult=1;class=0;tour=0
 */
import { HALBACH_VIZ, LORENTZ_SLED } from '../../generated/physics-constants';
import { DEVICE_SETPOINTS } from '../../generated/device-catalog';
import type { LabConfig } from '../../generated/lab-config';

export const LAB_URL_VERSION = 1;

/** Decoded/encodable `#lab=` state. All fields besides `version` are optional. */
export interface LabHashState {
  version: number;
  mode?: string;
  layout?: string;
  heronLayout?: string;
  drive?: number;
  field?: number;
  bmult?: number;
  classroom?: boolean;
  tour?: boolean;
  hi?: string;
  step?: number;
  renderer?: string;
  halbachSegments?: number;
  halbachLinear?: boolean;
  pulseCoilCharge?: number;
  lorentzFieldT?: number;
}

export type LabHashOptions = Partial<Omit<LabHashState, 'version'>>;

export function encodeLabHash(opts: LabHashOptions = {}): string {
  const parts = [`v${LAB_URL_VERSION}`];
  if (opts.mode) parts.push(`mode=${opts.mode}`);
  if (opts.layout) parts.push(`layout=${opts.layout}`);
  if (opts.heronLayout) parts.push(`heron=${opts.heronLayout}`);
  if (opts.drive != null) parts.push(`drive=${Number(opts.drive).toFixed(2)}`);
  if (opts.field != null) parts.push(`field=${Number(opts.field).toFixed(2)}`);
  if (opts.bmult != null && opts.bmult !== 1) parts.push(`bmult=${Number(opts.bmult).toFixed(2)}`);
  if (opts.classroom) parts.push('class=1');
  if (opts.tour) parts.push('tour=1');
  if (opts.hi) parts.push(`hi=${opts.hi}`);
  if (opts.step != null && opts.step >= 0) parts.push(`step=${opts.step}`);
  if (opts.renderer) parts.push(`renderer=${opts.renderer}`);
  if (opts.halbachSegments != null) parts.push(`hseg=${opts.halbachSegments}`);
  if (opts.halbachLinear != null) parts.push(`hlin=${opts.halbachLinear ? 1 : 0}`);
  if (opts.pulseCoilCharge != null) parts.push(`pcap=${Number(opts.pulseCoilCharge).toFixed(2)}`);
  if (opts.lorentzFieldT != null) parts.push(`lfield=${Number(opts.lorentzFieldT).toFixed(2)}`);
  return `#lab=${parts.join(';')}`;
}

/**
 * Ranges a decoded value is clamped into — the dashboard controls' own ranges
 * (drive/field sliders 0–100 %, the explainer B× slider) and the catalog
 * constants for the plugin benches.
 */
export const LAB_PARAM_RANGES = {
  drive: [0, 1],
  field: [0, 1],
  bmult: [0.5, 2],
  halbachSegments: [HALBACH_VIZ.segmentMin, HALBACH_VIZ.segmentMax],
  pulseCoilCharge: [0, 1],
  lorentzFieldT: [0, LORENTZ_SLED.fieldTMax],
  step: [0, 999]
} as const satisfies Record<string, readonly [number, number]>;

/**
 * A hand-edited or truncated link (`drive=abc`, `hseg=1e9`) must not push NaN
 * or an out-of-range value into the plant: non-finite → undefined, so the
 * field is simply absent and the live control keeps its previous value.
 */
function finiteIn(raw: number, [lo, hi]: readonly [number, number]): number | undefined {
  return Number.isFinite(raw) ? Math.max(lo, Math.min(hi, raw)) : undefined;
}

/** Integer fields: the whole value (`1e9`, not parseInt's `1`); `4.5` → undefined. */
function intIn(v: string, range: readonly [number, number]): number | undefined {
  const raw = v.trim() === '' ? NaN : Number(v);
  return Number.isInteger(raw) ? finiteIn(raw, range) : undefined;
}

export function decodeLabHashV1(hash: string): LabHashState | null {
  const m = hash.match(/#lab=([^&]+)/);
  if (!m) return null;
  const out: LabHashState = { version: LAB_URL_VERSION };
  for (const seg of m[1].split(';')) {
    if (seg === 'v1' || seg.startsWith('v')) {
      out.version = parseInt(seg.slice(1), 10) || 1;
      continue;
    }
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    const k = seg.slice(0, eq);
    const v = seg.slice(eq + 1);
    if (k === 'mode') out.mode = v;
    else if (k === 'layout') out.layout = v;
    else if (k === 'heron') out.heronLayout = v;
    else if (k === 'drive') out.drive = finiteIn(parseFloat(v), LAB_PARAM_RANGES.drive);
    else if (k === 'field') out.field = finiteIn(parseFloat(v), LAB_PARAM_RANGES.field);
    else if (k === 'bmult') out.bmult = finiteIn(parseFloat(v), LAB_PARAM_RANGES.bmult);
    else if (k === 'class') out.classroom = v === '1';
    else if (k === 'tour') out.tour = v === '1';
    else if (k === 'hi') out.hi = v;
    else if (k === 'step') out.step = intIn(v, LAB_PARAM_RANGES.step);
    else if (k === 'renderer') out.renderer = v;
    else if (k === 'hseg') out.halbachSegments = intIn(v, LAB_PARAM_RANGES.halbachSegments);
    else if (k === 'hlin') out.halbachLinear = v === '1';
    else if (k === 'pcap') out.pulseCoilCharge = finiteIn(parseFloat(v), LAB_PARAM_RANGES.pulseCoilCharge);
    else if (k === 'lfield') out.lorentzFieldT = finiteIn(parseFloat(v), LAB_PARAM_RANGES.lorentzFieldT);
  }
  return out;
}

/**
 * v1 state as raw LabConfig values (the caller coerces them like any other
 * layer). Bench setpoints were per-mode in v1 — `hseg` only meant something on
 * the Halbach bench — so they map only alongside their mode. `pcap` was a
 * charge fraction, and 0 meant "unset" (links from before the target was
 * pinned carried the live cap voltage); `renderer` in a v1 hash was never
 * applied and stays out.
 */
export function labHashV1ToConfig(v1: LabHashState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v1.mode) out.mode = v1.mode;
  if (v1.layout) out.layout = v1.layout;
  if (v1.heronLayout) out.heronLayout = v1.heronLayout;
  if (v1.drive != null) out.drive = v1.drive;
  if (v1.field != null) out.field = v1.field;
  if (v1.bmult != null) out.bmult = v1.bmult;
  if (v1.classroom) out.classroom = true;
  if (v1.tour) out.tour = true;
  if (v1.hi) out.highlight = v1.hi;
  if (v1.step != null) out.tourStep = v1.step;
  if (v1.halbachLinear != null) out.halbachLinear = v1.halbachLinear;
  const setpoints: Record<string, number> = {};
  if (v1.mode === 'halbach-viz' && v1.halbachSegments != null) setpoints.halbachSegments = v1.halbachSegments;
  if (v1.mode === 'pulse-coil' && v1.pulseCoilCharge != null && v1.pulseCoilCharge > 0) {
    const sp = DEVICE_SETPOINTS.find((s) => s.id === 'pulseCoilCharge');
    if (sp) setpoints.pulseCoilCharge = Math.min(1, v1.pulseCoilCharge) * sp.max;
  }
  if (v1.mode === 'lorentz-sled' && v1.lorentzFieldT != null) setpoints.lorentzField = v1.lorentzFieldT;
  if (Object.keys(setpoints).length) out.setpoints = setpoints;
  return out;
}
