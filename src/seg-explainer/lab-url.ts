/**
 * Shareable lab links — capture the running lab as LabConfig share fields and
 * apply them back (#224 §1).
 *
 * New links are `#lab2=` (src/config/share-link.ts: deflate-raw + base64url of
 * the non-default share fields, so seed, coupling flags, look, layouts, mode,
 * setpoints and tour step all ride along). Legacy `#lab=v1;…` links still load:
 * they decode in src/config/lab-hash-v1.ts and enter the same LabConfig
 * precedence. Both arrive here as `Partial<LabConfig>` — one apply path.
 *
 * `tour` plays the tour that belongs to `mode` (see TOUR_BY_MODE) — the SEG
 * tour unless the device has one of its own.
 */

import { LAB_TOURS, type LabTourKey, type SEGTourPlayer } from './seg-tour-player';
import { applySetpoint, readSetpoint, setpointById } from '../setpoint-sliders';
<<<<<<< HEAD
import { DEVICE_SETPOINTS } from '../../generated/device-catalog';
import { labConfig, primeShareHash, sanitizeFields, type LabConfig } from '../config/lab-config';
import { currentShareHash, pageUrlWithoutHash, replacePageHash } from '../config/share-url';
import { decodeLabHashV1, labHashV1ToConfig, type LabHashState } from '../config/lab-hash-v1';
import { encodeShareHash } from '../config/share-link';
import { getSimulationSeed, setSimulationSeed } from '../telemetry/deterministic-rng';
=======
import { HALBACH_VIZ, LORENTZ_SLED } from '../../generated/physics-constants';
>>>>>>> origin/main

export {
  LAB_URL_VERSION,
  LAB_PARAM_RANGES,
  encodeLabHash,
  type LabHashState,
  type LabHashOptions
} from '../config/lab-hash-v1';
export { decodeShareHash, encodeShareHash } from '../config/share-link';
export { bootLiveFields } from '../config/lab-config';

/** Legacy `#lab=` decode (defaults to this page's hash, for older callers). */
export function decodeLabHash(hash: string = currentShareHash()): LabHashState | null {
  return decodeLabHashV1(hash);
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

function tourForMode(mode?: string | null): SEGTourPlayer | null {
  const key = mode ? TOUR_BY_MODE[mode] : undefined;
  const w = window as Window & Partial<Record<LabTourKey, SEGTourPlayer>>;
  return (key && w[key]) || window.segTour || null;
}

/**
 * Apply share fields to the live dashboard. Every field is optional and
 * idempotent: what is already on screen is left alone (no layout rebuild for
 * the layout that is showing). The order matters — the lab-mode bundle first,
 * so the link's own flags then win over it; mode before the bench setpoints
 * and the tour that belong to it.
 */
export async function applyLabConfig(c: Partial<LabConfig>): Promise<void> {
  const v = window.multiVisualizer;

  if (c.labMode && typeof window.setLabMode === 'function' && window.getLabMode?.() !== c.labMode) {
    window.setLabMode(c.labMode);
  }

  if (c.layout) {
    const current = v?.getSEGLayoutPreset?.() ?? v?.segLayoutPreset;
    if (current !== c.layout) {
      if (v?.setSEGLayoutPreset) await v.setSEGLayoutPreset(c.layout);
      else if (typeof window.setSEGLayout === 'function') await window.setSEGLayout(c.layout);
    }
  }

  if (c.heronLayout && v?.setHeronLayoutPreset && v.heronLayoutPreset !== c.heronLayout) {
    v.setHeronLayoutPreset(c.heronLayout);
  }

<<<<<<< HEAD
  if (c.look && typeof window.setLightingLook === 'function' && v?.lightingLook !== c.look) {
    window.setLightingLook(c.look);
=======
  const halbachDevice = window.multiVisualizer?.devices?.['halbach-viz'];
  const halbach = halbachDevice?.physicsState ?? halbachDevice?.physics;
  if (lab.mode === 'halbach-viz' && lab.halbachSegments != null && halbach) {
    const sp = setpointById('halbachSegments');
    if (sp) applySetpoint(sp, lab.halbachSegments);
>>>>>>> origin/main
  }
  if (c.frame && typeof window.setSegFrameLevel === 'function' && v?.segFrameLevel !== c.frame) {
    window.setSegFrameLevel(c.frame);
  }

  if (c.fieldCoupling != null) window.setFieldCoupling?.(c.fieldCoupling);
  if (c.chargeCoupling != null) window.setChargeCoupling?.(c.chargeCoupling);
  if (c.energyCoupling != null) v?.energyNetwork?.setCouplingEnabled?.(c.energyCoupling);

  if (c.seed != null && getSimulationSeed() !== c.seed) setSimulationSeed(c.seed, false);

  if (c.mode && typeof window.setMode === 'function') {
    window.setMode(c.mode);
  }

  // Setpoints go through the same catalog path as the sliders, so a shared link
  // pins exactly what the slider would (and shows on it).
  for (const [id, value] of Object.entries(c.setpoints ?? {})) {
    const sp = setpointById(id);
    if (sp) applySetpoint(sp, value);
  }
  const halbach = v?.devices?.['halbach-viz']?.physicsState;
  if (c.halbachLinear != null && halbach) {
    const layout = c.halbachLinear ? 'linear' : 'ring';
    if ((halbach.halbachLayout ?? 'ring') !== layout) {
      halbach.halbachLayout = layout;
      halbach.halbachFieldLines = null; // forces a geometry refresh next step
    }
<<<<<<< HEAD
=======
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
>>>>>>> origin/main
  }

  const op = window.segOperator;
  if (op) {
    if (c.drive != null) {
      op.targetDrive = c.drive;
      const dc = document.getElementById('driveControl') as HTMLInputElement | null;
      const dv = document.getElementById('driveVal');
      if (dc) dc.value = String(Math.round(c.drive * 100));
      if (dv) dv.textContent = `${Math.round(c.drive * 100)}%`;
    }
    if (c.field != null) {
      window.explainerState?.setBaseFieldStrength(c.field);
      const fc = document.getElementById('fieldControl') as HTMLInputElement | null;
      if (fc) fc.value = String(Math.round(c.field * 100));
    }
  }

  if (c.bmult != null && window.explainerState) {
    window.explainerState.setFieldMultiplier(c.bmult);
    const el = document.getElementById('explainerBMult') as HTMLInputElement | null;
    if (el) el.value = String(c.bmult);
  }

  if (c.classroom != null && window.explainerState && window.explainerState.classroomMode !== c.classroom) {
    window.explainerState.setClassroomMode(c.classroom);
    const cb = document.getElementById('explainerClassroom') as HTMLInputElement | null;
    if (cb) cb.checked = c.classroom;
  }

  if (c.highlight && window.explainerState) {
    window.explainerState.setHighlight(c.highlight);
    window.segAnnotations?.setEnabled(true);
  }

  const tour = tourForMode(c.mode);
  const step = c.tourStep ?? null;
  // The scripts are a lazy chunk; the step lookup below needs this one's.
  if (tour && (c.tour || c.highlight || step != null)) await tour.ready().catch(() => undefined);
  if (c.tour && tour) {
    if (c.highlight) {
      const idx = tour._findStepForHighlight(c.highlight);
      tour.goToStep(idx >= 0 ? idx : (step ?? 0));
    } else {
      tour.goToStep(step ?? 0);
    }
  } else if (c.highlight && tour) {
    tour.goToStepForHighlight(c.highlight);
  } else if (step != null && tour) {
    tour.goToStep(step);
  }

  if (c.experiment) window.lab?.openExperiment?.(c.experiment);
}

/** Legacy entry point: apply a decoded `#lab=v1` state. */
export async function applyLabState(lab: LabHashState | null | undefined): Promise<void> {
  if (!lab) return;
  await applyLabConfig(sanitizeFields(labHashV1ToConfig(lab), true));
}

/** Only *pinned* targets are shareable; a free-running live value is a transient. */
function pinnedSetpoints(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const sp of DEVICE_SETPOINTS) {
    const value = readSetpoint(sp);
    if (value != null) out[sp.id] = value;
  }
  return out;
}

/**
 * The running lab as share fields: what is on screen (live state) plus the
 * boot choices that shape the run (backend, prototype, seed). Defaults are
 * dropped by the encoder, so this can be generous.
 */
export function captureShareConfig(): Partial<LabConfig> {
  const v = window.multiVisualizer;
  const op = window.segOperator;
  const es = window.explainerState;
<<<<<<< HEAD
  const boot = labConfig();
  const halbach = v?.devices?.['halbach-viz']?.physicsState;
=======
  const halbachDevice = v?.devices?.['halbach-viz'];
  const halbach = halbachDevice?.physicsState ?? halbachDevice?.physics;
  const sled = v?.devices?.['lorentz-sled']?.physicsState || v?.devices?.['lorentz-sled']?.physics;
>>>>>>> origin/main
  // Capture whichever tour is actually running, so a shared link reopens on the
  // same step of the same device tour rather than always the SEG one.
  const activeTour = livePlayers().find((t) => t.playing) ?? window.segTour;
  const setpoints = pinnedSetpoints();
  const raw: Record<string, unknown> = {
    wasmPhysics: boot.wasmPhysics,
    prototype: boot.prototype,
    seed: getSimulationSeed(),
    labMode: window.getLabMode?.() ?? boot.labMode,
    mode: v?.currentView || 'seg',
    layout: v?.getSEGLayoutPreset?.() ?? v?.segLayoutPreset,
    heronLayout: v?.heronLayoutPreset,
    look: v?.lightingLook ?? boot.look,
    frame: v?.segFrameLevel ?? boot.frame,
    fieldCoupling: v?.fieldNetwork?.couplingEnabled ?? boot.fieldCoupling,
    chargeCoupling: v?.chargeNetwork?.couplingEnabled ?? boot.chargeCoupling,
    energyCoupling: v?.energyNetwork?.couplingEnabled ?? boot.energyCoupling,
    drive: op?.targetDrive ?? 0.5,
    field: es?.baseFieldStrength ?? op?.magneticFieldStrength ?? 0.5,
    bmult: es?.fieldMultiplier ?? 1,
<<<<<<< HEAD
    classroom: es?.classroomMode || undefined,
    highlight: es?.highlightId || undefined,
    tour: activeTour?.playing || undefined,
    tourStep: activeTour?.playing ? activeTour.stepIndex : undefined,
    halbachLinear: halbach ? halbach.halbachLayout === 'linear' : undefined,
    experiment: boot.experiment,
    setpoints
  };
  return sanitizeFields(raw, true);
}

/** @deprecated v1 field names; kept for callers of the old capture. */
export function captureLabState(): Partial<LabHashState> {
  const c = captureShareConfig();
  return {
    mode: c.mode ?? undefined,
    layout: c.layout ?? undefined,
    heronLayout: c.heronLayout,
    drive: c.drive ?? undefined,
    field: c.field ?? undefined,
    bmult: c.bmult ?? undefined,
    classroom: c.classroom ?? false,
    hi: c.highlight ?? undefined,
    step: c.tourStep ?? undefined,
    tour: c.tour ?? false,
    halbachLinear: c.halbachLinear
=======
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
>>>>>>> origin/main
  };
}

/** Put `fields` in the address bar as `#lab2=` (no reload); returns the hash. */
export async function writeShareHash(fields: Partial<LabConfig>): Promise<string> {
  const hash = await encodeShareHash(fields);
  primeShareHash(hash, fields);
  replacePageHash(hash);
  return hash;
}

/**
 * Tours keep the address bar on the step they are showing, so a copied URL
 * reopens there.
 */
export async function syncTourShareHash(patch: Partial<LabConfig>): Promise<void> {
  await writeShareHash({ ...captureShareConfig(), ...patch });
}

/** Build a `#lab2=` link for the running lab, copy it, and return it. */
export async function shareLabLink(): Promise<string> {
  const hash = await writeShareHash(captureShareConfig());
  const url = `${pageUrlWithoutHash()}${hash}`;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).catch(() => {});
  }
  return url;
}
