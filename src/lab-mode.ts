/**
 * Lab mode — ADR-0005's Showroom / Lab / Twin as one switch instead of six flags.
 *
 * `?labMode=showroom|lab|twin` (or the header control, remembered in
 * `localStorage seg-lab-mode`) applies a **preset bundle**: lighting look,
 * explainer/coupling chrome, hardware-twin panel, residual gauges, post-stack
 * floor. The individual flags stay the more specific instruction: at boot an
 * explicit `?look=`, `?audio=`, `?class=`, `?fieldCoupling=` … wins over the
 * bundle. Clicking a mode in the header is an explicit choice and applies the
 * whole bundle.
 *
 * Not a router. Nothing here owns state the flags own — it only calls the same
 * setters the flags and panels already use.
 */
import type { LightingLook } from './seg-lighting-presets';
import { LAB_TOURS } from './seg-explainer/seg-tour-player';
import {
  coerceLabField,
  labConfigResolved,
  persistLabConfig,
  resolveLabConfig,
  restoreStoredLabValues,
  setLabUrlParam,
  snapshotStoredLabValues,
  type LabConfig,
  type ResolvedLabConfig
} from './config/lab-config';

export const LAB_MODES = ['showroom', 'lab', 'twin'] as const;
export type LabMode = (typeof LAB_MODES)[number];

export const LAB_MODE_STORAGE_KEY = 'seg-lab-mode';

/** Flags a user can set by hand that a preset would otherwise decide. */
export type LabModeFlag =
  | 'look' | 'audio' | 'classroom' | 'fieldCoupling' | 'chargeCoupling' | 'energyCoupling';

export interface LabModePreset {
  label: string;
  blurb: string;
  /** Lighting look; null leaves whatever is active (twin is an instrument, not a look). */
  look: LightingLook | null;
  /** Mute lab audio if it is running. Never *starts* audio — that stays `?audio=1` + a gesture. */
  muteAudio: boolean;
  /** Switch all three buses off for the session (stored preferences are left alone). */
  couplingOff: boolean;
  couplingControls: boolean;
  explainer: boolean;
  /** Turn classroom (large labels) off. */
  classroomOff: boolean;
  twinPanelCollapsed: boolean;
  /** Open the scientific panel, where the shadow-residual gauges live. */
  residualGauges: boolean;
  /** Hold the post stack at this tier (the highest the profiler reaches). */
  postFloor: 'high' | null;
  /** Leaving this mode with a live link sends the coils a coast. */
  coastOnLeave: boolean;
}

/**
 * Every field is stated in every row: switching modes must restore chrome the
 * previous mode hid, so "unspecified" would mean "stuck from last time".
 * Lab and Twin leave the dashboard as it is by default; Showroom strips it.
 */
export const LAB_MODE_PRESETS: Readonly<Record<LabMode, LabModePreset>> = {
  showroom: {
    label: 'Showroom',
    blurb: 'Cinematic look, no teaching chrome, couplings off, twin panel folded away',
    look: 'studio',
    muteAudio: true,
    couplingOff: true,
    couplingControls: false,
    explainer: false,
    classroomOff: true,
    twinPanelCollapsed: true,
    residualGauges: false,
    postFloor: 'high',
    coastOnLeave: false
  },
  lab: {
    label: 'Lab',
    blurb: 'Teaching bench: lab lighting, explainer tours and coupling controls visible',
    look: 'lab',
    muteAudio: false,
    couplingOff: false,
    couplingControls: true,
    explainer: true,
    classroomOff: false,
    twinPanelCollapsed: false,
    residualGauges: false,
    postFloor: null,
    coastOnLeave: false
  },
  twin: {
    label: 'Twin',
    blurb: 'Hardware bench: twin panel open, shadow-residual gauges on, coils coast on leave',
    look: null,
    muteAudio: false,
    couplingOff: false,
    couplingControls: true,
    explainer: true,
    classroomOff: false,
    twinPanelCollapsed: false,
    residualGauges: true,
    postFloor: null,
    coastOnLeave: true
  }
};

export function isLabMode(v: unknown): v is LabMode {
  return typeof v === 'string' && (LAB_MODES as readonly string[]).includes(v);
}

/** Parsed explicit values for the flags the user set by hand (URL or share link). */
export type LabModeOverrides = Partial<Pick<LabConfig, LabModeFlag>>;

const BUS_FLAGS = ['fieldCoupling', 'chargeCoupling', 'energyCoupling'] as const;
const OVERRIDE_FLAGS: readonly LabModeFlag[] = ['look', 'audio', 'classroom', ...BUS_FLAGS];

/** The preset-controlled flags a resolved config sets explicitly. */
export function labModeOverridesFrom(r: ResolvedLabConfig): LabModeOverrides {
  const out: Record<string, unknown> = {};
  for (const flag of OVERRIDE_FLAGS) {
    const src = r.sources[flag];
    if ((src === 'url' || src === 'hash') && r.config[flag] != null) out[flag] = r.config[flag];
  }
  return out as LabModeOverrides;
}

/**
 * Which preset-controlled flags the URL sets explicitly. `class` also arrives
 * as `class=1` in a `#lab=` share link (and any of them in `#lab2=`), which is
 * just as explicit — `hashFields` is such a link, decoded. Values are parsed:
 * an unparsable one is not an override.
 */
export function readLabModeOverrides(search: string, hashFields: Record<string, unknown> = {}): LabModeOverrides {
  return labModeOverridesFrom(resolveLabConfig({ search, hashFields }));
}

/** `?labMode=` wins over the remembered choice; anything unrecognised is ignored. */
export function resolveBootLabMode(search: string, stored: string | null): LabMode | null {
  const fromUrl = resolveLabConfig({ search }).config.labMode;
  return fromUrl ?? coerceLabField('labMode', stored) ?? null;
}

/** What actually gets applied once explicit flags have had their say. */
export interface LabModePlan {
  mode: LabMode;
  look: LightingLook | null;
  muteAudio: boolean;
  forceOff: { fieldCoupling: boolean; chargeCoupling: boolean; energyCoupling: boolean };
  showCouplingControls: boolean;
  showExplainer: boolean;
  classroomOff: boolean;
  twinPanelCollapsed: boolean;
  residualGauges: boolean;
  postFloor: 'high' | null;
  coastOnLeave: boolean;
}

/**
 * Preset ∖ explicit overrides. An explicit bus flag keeps that bus out of the
 * force-off; an explicit-on flag also keeps its controls on screen, since a
 * live bus whose switch is hidden would be a lie.
 */
export function planLabMode(mode: LabMode, overrides: LabModeOverrides = {}): LabModePlan {
  const p = LAB_MODE_PRESETS[mode];
  const busOverridden = (f: (typeof BUS_FLAGS)[number]): boolean => overrides[f] != null;
  const anyBusOn = BUS_FLAGS.some((f) => overrides[f] === true);
  return {
    mode,
    look: overrides.look != null ? null : p.look,
    muteAudio: p.muteAudio && overrides.audio == null,
    forceOff: {
      fieldCoupling: p.couplingOff && !busOverridden('fieldCoupling'),
      chargeCoupling: p.couplingOff && !busOverridden('chargeCoupling'),
      energyCoupling: p.couplingOff && !busOverridden('energyCoupling')
    },
    showCouplingControls: p.couplingControls || anyBusOn,
    showExplainer: p.explainer || overrides.classroom === true,
    classroomOff: p.classroomOff && overrides.classroom == null,
    twinPanelCollapsed: p.twinPanelCollapsed,
    residualGauges: p.residualGauges,
    postFloor: p.postFloor,
    coastOnLeave: p.coastOnLeave
  };
}

// ─────────────────────────────────────────────────────────────
// DOM side — everything below touches the page
// ─────────────────────────────────────────────────────────────

let currentMode: LabMode | null = null;
let residualOpenedByTwin = false;

export function getLabMode(): LabMode | null {
  return currentMode;
}

/**
 * Run `fn`, then put the stored coupling preferences back. Forcing a bus off
 * for a showroom session must not rewrite what the next lab session boots with.
 */
function keepingStoredCouplingPrefs(fn: () => void): void {
  const saved = snapshotStoredLabValues(BUS_FLAGS);
  try {
    fn();
  } finally {
    restoreStoredLabValues(saved);
  }
}

function setBodyState(plan: LabModePlan): void {
  const d = document.body.dataset;
  d.labMode = plan.mode;
  d.showExplainer = plan.showExplainer ? '1' : '0';
  d.showCoupling = plan.showCouplingControls ? '1' : '0';
  d.hwPanel = plan.twinPanelCollapsed ? 'collapsed' : 'expanded';
}

function applyPlan(plan: LabModePlan, previous: LabMode | null): void {
  setBodyState(plan);
  const v = window.multiVisualizer;

  if (plan.look && v?.lightingLook !== plan.look) window.setLightingLook?.(plan.look);

  if (plan.muteAudio) window.labAudio?.setMuted(true);

  keepingStoredCouplingPrefs(() => {
    if (plan.forceOff.fieldCoupling) window.setFieldCoupling?.(false);
    if (plan.forceOff.chargeCoupling) window.setChargeCoupling?.(false);
    if (plan.forceOff.energyCoupling) v?.energyNetwork?.setCouplingEnabled?.(false);
  });

  if (plan.classroomOff && window.explainerState?.classroomMode) {
    window.explainerState.setClassroomMode(false);
    const cb = document.getElementById('explainerClassroom') as HTMLInputElement | null;
    if (cb) cb.checked = false;
  }

  if (!plan.showExplainer) {
    // A tour keeps its overlay up even when its panel is hidden.
    for (const def of LAB_TOURS) {
      const player = (window as unknown as Record<string, { playing?: boolean; stop?: () => void }>)[def.key];
      if (player?.playing) player.stop?.();
    }
  }

  window.hardwarePanel?.setCollapsed(plan.twinPanelCollapsed);

  const sci = window.sciUI;
  if (plan.residualGauges) {
    if (sci && !sci.isVisible) {
      sci.show?.();
      residualOpenedByTwin = true;
    }
  } else if (residualOpenedByTwin) {
    sci?.hide?.();
    residualOpenedByTwin = false;
  }

  if (v?.profiler) v.profiler.postTierFloor = plan.postFloor;

  // Leaving Twin with a live link: coast, don't leave coils on the last command.
  // (Never disconnects — the link and its safety logic stay the bridge's.)
  if (previous && previous !== plan.mode && LAB_MODE_PRESETS[previous].coastOnLeave) {
    const bridge = v?.hardwareBridge;
    if (bridge?.isConnected) bridge.coast();
  }
}

function paintSwitch(mode: LabMode | null): void {
  document.querySelectorAll<HTMLButtonElement>('[data-lab-mode-btn]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.labModeBtn === mode));
  });
}

/**
 * Activate a mode. `boot` lets explicit URL flags win; `user` (the header
 * control, `window.setLabMode`) applies the whole bundle and remembers it.
 */
export function setLabMode(mode: LabMode, source: 'boot' | 'user' = 'user'): void {
  if (!isLabMode(mode)) return;
  const overrides = source === 'boot' ? labModeOverridesFrom(labConfigResolved()) : {};
  const previous = currentMode;
  currentMode = mode;
  applyPlan(planLabMode(mode, overrides), previous);
  paintSwitch(mode);

  if (source === 'user') {
    persistLabConfig('labMode', mode);
    setLabUrlParam('labMode', mode);
  }
  window.dispatchEvent(new CustomEvent('seg-lab-mode', { detail: { mode } }));
}

function renderSwitch(host: HTMLElement): void {
  host.setAttribute('role', 'group');
  host.setAttribute('aria-label', 'Lab mode');
  host.replaceChildren(
    ...LAB_MODES.map((mode) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lab-mode-btn';
      btn.id = `labmode-${mode}`;
      btn.dataset.labModeBtn = mode;
      btn.textContent = LAB_MODE_PRESETS[mode].label;
      btn.title = LAB_MODE_PRESETS[mode].blurb;
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', () => setLabMode(mode, 'user'));
      return btn;
    })
  );
}

/**
 * Boot: build the header control, then apply the URL/remembered mode (if any).
 * With no mode anywhere nothing is applied and no button is pressed — the page
 * is exactly the flag-driven dashboard it always was.
 *
 * Also honours `?class=1|0` here, independent of mode.
 */
export function initLabMode(): LabMode | null {
  const host = document.getElementById('lab-mode-switch');
  if (host) renderSwitch(host);

  const { config, sources } = labConfigResolved();
  if (sources.classroom === 'url' && config.classroom != null) {
    window.explainerState?.setClassroomMode(config.classroom);
    const cb = document.getElementById('explainerClassroom') as HTMLInputElement | null;
    if (cb) cb.checked = config.classroom;
  }

  const mode = config.labMode;
  if (mode) setLabMode(mode, 'boot');
  return mode;
}
