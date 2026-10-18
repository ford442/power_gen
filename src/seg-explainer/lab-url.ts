/**
 * Shareable lab links — encode mode, layout, and experiment params in the URL hash.
 *
 * Format: #lab=v1;mode=seg;layout=searl;drive=0.5;field=0.5;bmult=1;class=0;tour=0
 *
 * `tour=1` plays the tour that belongs to `mode` (see TOUR_BY_MODE) — the SEG
 * tour unless the device has one of its own.
 */

import { LAB_TOURS, type LabTourKey, type SEGTourPlayer } from './seg-tour-player';
import { applySetpoint, readSetpoint, setpointById } from '../setpoint-sliders';
import { HALBACH_VIZ, LORENTZ_SLED } from '../../generated/physics-constants';

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

export function decodeLabHash(hash: string = typeof location !== 'undefined' ? location.hash : ''): LabHashState | null {
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
 * Devices with their own guided tour, derived from the one tour registry in
 * `seg-tour-player.ts` — a new script does not need editing here. Anything not
 * listed shares the SEG tour, which is also the fallback when the device's own
 * player has not initialised.
 */
const TOUR_BY_MODE: Record<string, LabTourKey> = Object.fromEntries(
  LAB_TOURS.filter((t) => t.mode).map((t) => [t.mode as string, t.key])
);

/** Every tour handle currently on `window`, in registry order. */
function livePlayers(): SEGTourPlayer[] {
  const w = window as Window & Partial<Record<LabTourKey, SEGTourPlayer>>;
  return LAB_TOURS.map((t) => w[t.key]).filter((p): p is SEGTourPlayer => !!p);
}

function tourForMode(mode?: string): SEGTourPlayer | null {
  const key = mode ? TOUR_BY_MODE[mode] : undefined;
  const w = window as Window & Partial<Record<LabTourKey, SEGTourPlayer>>;
  return (key && w[key]) || window.segTour || null;
}

/**
 * Apply decoded lab state to the live dashboard.
 */
export async function applyLabState(lab: LabHashState | null | undefined): Promise<void> {
  if (!lab) return;

  if (lab.renderer && typeof window.setRenderer === 'function') {
    // Renderer requires reload — only apply if already on page without mismatch
  }

  const v = window.multiVisualizer;
  if (lab.layout && v?.setSEGLayoutPreset) {
    await v.setSEGLayoutPreset(lab.layout);
  } else if (lab.layout && typeof window.setSEGLayout === 'function') {
    await window.setSEGLayout(lab.layout);
  }

  if (lab.heronLayout && v?.setHeronLayoutPreset) {
    v.setHeronLayoutPreset(lab.heronLayout);
  }

  if (lab.mode && typeof window.setMode === 'function') {
    window.setMode(lab.mode);
  }

  // Setpoints go through the same catalog path as the sliders, so a shared link
  // pins exactly what the slider would (and shows on it).
  if (lab.mode === 'halbach-viz' && lab.halbachSegments != null) {
    const sp = setpointById('halbachSegments');
    if (sp) applySetpoint(sp, lab.halbachSegments);
  }
  const halbach = window.multiVisualizer?.devices?.['halbach-viz']?.physicsState;
  if (lab.halbachLinear != null && halbach) {
    const layout = lab.halbachLinear ? 'linear' : 'ring';
    if ((halbach.halbachLayout ?? 'ring') !== layout) {
      halbach.halbachLayout = layout;
      halbach.halbachFieldLines = null; // forces a geometry refresh next step
    }
  }
  // `pcap` is a charge *fraction* of the bank. Links captured before pcap was a
  // pinned target carry the instantaneous cap voltage (often 0), so 0 means
  // "unset" rather than "pin the target to 0 V".
  if (lab.mode === 'pulse-coil' && lab.pulseCoilCharge != null && lab.pulseCoilCharge > 0) {
    const sp = setpointById('pulseCoilCharge');
    if (sp) applySetpoint(sp, Math.max(0, Math.min(1, lab.pulseCoilCharge)) * sp.max);
  }
  if (lab.mode === 'lorentz-sled' && lab.lorentzFieldT != null) {
    const sp = setpointById('lorentzField');
    if (sp) applySetpoint(sp, lab.lorentzFieldT);
  }

  const op = window.segOperator;
  if (op) {
    if (lab.drive != null) {
      op.targetDrive = lab.drive;
      const dc = document.getElementById('driveControl') as HTMLInputElement | null;
      const dv = document.getElementById('driveVal');
      if (dc) dc.value = String(Math.round(lab.drive * 100));
      if (dv) dv.textContent = `${Math.round(lab.drive * 100)}%`;
    }
    if (lab.field != null) {
      window.explainerState?.setBaseFieldStrength(lab.field);
      const fc = document.getElementById('fieldControl') as HTMLInputElement | null;
      if (fc) fc.value = String(Math.round(lab.field * 100));
    }
  }

  if (lab.bmult != null && window.explainerState) {
    window.explainerState.setFieldMultiplier(lab.bmult);
    const el = document.getElementById('explainerBMult') as HTMLInputElement | null;
    if (el) el.value = String(lab.bmult);
  }

  if (lab.classroom && window.explainerState) {
    window.explainerState.setClassroomMode(true);
    const cb = document.getElementById('explainerClassroom') as HTMLInputElement | null;
    if (cb) cb.checked = true;
  }

  if (lab.hi && window.explainerState) {
    window.explainerState.setHighlight(lab.hi);
    window.segAnnotations?.setEnabled(true);
  }

  const tour = tourForMode(lab.mode);
  if (lab.tour && tour) {
    const step = Number.isFinite(lab.step) ? (lab.step as number) : 0;
    if (lab.hi) {
      const idx = tour._findStepForHighlight(lab.hi);
      tour.goToStep(idx >= 0 ? idx : step);
    } else {
      tour.goToStep(step);
    }
  } else if (lab.hi && tour) {
    tour.goToStepForHighlight(lab.hi);
  } else if (Number.isFinite(lab.step) && tour) {
    tour.goToStep(lab.step as number);
  }
}

function pinnedValue(id: string): number | undefined {
  const sp = setpointById(id);
  return (sp && readSetpoint(sp)) ?? undefined;
}

function pinnedFraction(id: string): number | undefined {
  const sp = setpointById(id);
  const v = sp ? readSetpoint(sp) : null;
  return sp && v != null ? Math.max(0, Math.min(1, v / sp.max)) : undefined;
}

export function captureLabState(): LabHashOptions {
  const v = window.multiVisualizer;
  const op = window.segOperator;
  const es = window.explainerState;
  const halbach = v?.devices?.['halbach-viz']?.physicsState;
  const sled = v?.devices?.['lorentz-sled']?.physicsState || v?.devices?.['lorentz-sled']?.physics;
  // Capture whichever tour is actually running, so a shared link reopens on the
  // same step of the same device tour rather than always the SEG one.
  const activeTour = livePlayers().find((t) => t.playing) ?? window.segTour;
  return {
    mode: v?.currentView === 'overview' ? 'overview' : (v?.currentView || 'seg'),
    layout: v?.getSEGLayoutPreset?.() ?? v?.segLayoutPreset ?? 'searl',
    heronLayout: v?.heronLayoutPreset,
    drive: op?.targetDrive ?? 0.5,
    field: es?.baseFieldStrength ?? op?.magneticFieldStrength ?? 0.5,
    bmult: es?.fieldMultiplier ?? 1,
    classroom: es?.classroomMode ?? false,
    hi: es?.highlightId || undefined,
    step: activeTour?.playing ? activeTour.stepIndex : undefined,
    tour: activeTour?.playing ?? false,
    renderer: window.currentRenderer ?? undefined,
    // Only a *pinned* target is shareable; the live cap voltage is a transient.
    pulseCoilCharge: pinnedFraction('pulseCoilCharge'),
    halbachSegments: pinnedValue('halbachSegments'),
    lorentzFieldT: sled?.lorentzFieldT,
    halbachLinear: halbach ? halbach.halbachLayout === 'linear' : undefined
  };
}

export function shareLabLink(): string {
  const hash = encodeLabHash(captureLabState());
  const url = `${location.origin}${location.pathname}${location.search}${hash}`;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).catch(() => {});
  }
  history.replaceState(null, '', hash);
  return url;
}
