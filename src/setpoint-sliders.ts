/**
 * Catalog-driven setpoint sliders — generated from `physics/devices.json`
 * `setpoints` (via `DEVICE_SETPOINTS`), not hand-wired in index.html.
 *
 * The panel only ever *writes*: through the device's existing `window` API when
 * the catalog names one (`setLorentzFieldT`), otherwise straight into
 * `physicsState[stateKey]`. The plant clock reads it on its next step — nothing
 * here steps a plant from an input handler (ADR-0009). START/STOP/drive are
 * session-level and deliberately not generated.
 */
import { DEVICE_SETPOINTS, type DeviceSetpoint } from '../generated/device-catalog';

const HOST_ID = 'device-setpoints';

type PhysicsBag = Record<string, unknown>;
type WindowLike = {
  multiVisualizer?: { devices?: Record<string, { physicsState?: unknown; physics?: unknown }> } | null;
} & Record<string, unknown>;

export function setpointsForDevice(deviceId: string): DeviceSetpoint[] {
  return DEVICE_SETPOINTS.filter((s) => s.deviceId === deviceId);
}

export function setpointById(id: string): DeviceSetpoint | undefined {
  return DEVICE_SETPOINTS.find((s) => s.id === id);
}

export function clampSetpoint(sp: DeviceSetpoint, value: number): number {
  const v = Number.isFinite(value) ? value : sp.min;
  return Math.max(sp.min, Math.min(sp.max, v));
}

function physicsOf(sp: DeviceSetpoint, w: WindowLike): PhysicsBag | null {
  const dev = w.multiVisualizer?.devices?.[sp.deviceId];
  return ((dev?.physicsState ?? dev?.physics) as PhysicsBag | undefined) ?? null;
}

/** The value the plant is currently pinned to, or null when it is free-running. */
export function readSetpoint(sp: DeviceSetpoint, w: WindowLike = window as unknown as WindowLike): number | null {
  const v = physicsOf(sp, w)?.[sp.stateKey];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** What the slider should show: the pinned value, else the live plant value. */
export function displaySetpoint(sp: DeviceSetpoint, w: WindowLike = window as unknown as WindowLike): number | null {
  const set = readSetpoint(sp, w);
  if (set != null) return set;
  const live = sp.liveKey ? physicsOf(sp, w)?.[sp.liveKey] : undefined;
  return typeof live === 'number' && Number.isFinite(live) ? live : null;
}

/**
 * Write a setpoint (`null` releases a `releasable` one back to the plant).
 * Returns false when there was nothing to write to yet (bench not built).
 */
export function applySetpoint(
  sp: DeviceSetpoint,
  value: number | null,
  w: WindowLike = window as unknown as WindowLike
): boolean {
  if (value == null) {
    if (!sp.releasable) return false;
    const phys = physicsOf(sp, w);
    if (!phys) return false;
    phys[sp.stateKey] = null;
    return true;
  }
  const v = clampSetpoint(sp, value);
  const api = sp.api ? w[sp.api] : undefined;
  if (typeof api === 'function') {
    (api as (n: number) => void)(v);
    return true;
  }
  const phys = physicsOf(sp, w);
  if (!phys) return false;
  phys[sp.stateKey] = v;
  return true;
}

function fmt(sp: DeviceSetpoint, v: number): string {
  return `${v.toFixed(sp.digits)}${sp.unit ? ` ${sp.unit}` : ''}`;
}

function buildRow(sp: DeviceSetpoint): HTMLElement {
  const row = document.createElement('div');
  row.dataset.setpoint = sp.id;

  const sliderRow = document.createElement('div');
  sliderRow.className = 'slider-row';
  const label = document.createElement('label');
  label.htmlFor = `${sp.id}Slider`;
  label.append(`${sp.label} `);
  const value = document.createElement('span');
  value.id = `${sp.id}Value`;
  value.textContent = fmt(sp, sp.min);
  label.append(value);

  const input = document.createElement('input');
  input.type = 'range';
  input.id = `${sp.id}Slider`;
  input.min = String(sp.min);
  input.max = String(sp.max);
  input.step = String(sp.step);
  input.value = String(sp.min);
  input.setAttribute('aria-label', `${sp.label}${sp.unit ? ` (${sp.unit})` : ''}`);
  input.addEventListener('input', () => {
    const v = input.valueAsNumber;
    if (applySetpoint(sp, v)) value.textContent = fmt(sp, clampSetpoint(sp, v));
    syncReleaseState(sp);
  });
  sliderRow.append(label, input);
  row.append(sliderRow);

  const source = document.createElement('div');
  source.id = `${sp.id}Source`;
  source.dataset.coupled = 'false';
  source.style.cssText = 'font-size:0.66rem;color:#8cf;margin-top:6px;line-height:1.4;';
  row.append(source);

  if (sp.releasable) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'layout-btn';
    btn.id = `${sp.id}Release`;
    btn.textContent = 'Auto';
    btn.title = 'Hand this quantity back to the plant';
    btn.addEventListener('click', () => {
      applySetpoint(sp, null);
      syncReleaseState(sp);
      paintSetpoint(sp);
    });
    row.append(btn);
  }

  if (sp.note) {
    const note = document.createElement('div');
    note.style.cssText = 'font-size:0.68rem;color:#0aa;margin-top:6px;line-height:1.4;';
    note.textContent = sp.note;
    row.append(note);
  }
  return row;
}

/** Pinned vs free-running text and the Auto button state for a releasable setpoint. */
function syncReleaseState(sp: DeviceSetpoint): void {
  if (!sp.releasable) return;
  const pinned = readSetpoint(sp) != null;
  const source = document.getElementById(`${sp.id}Source`);
  if (source) {
    source.textContent = pinned ? 'Source: pinned by this slider' : 'Source: plant (follows the drive slider)';
    source.dataset.coupled = pinned ? 'true' : 'false';
  }
  const btn = document.getElementById(`${sp.id}Release`) as HTMLButtonElement | null;
  if (btn) btn.disabled = !pinned;
}

/** Repaint one slider from the plant, unless the user is mid-drag on it. */
export function paintSetpoint(sp: DeviceSetpoint): void {
  const input = document.getElementById(`${sp.id}Slider`) as HTMLInputElement | null;
  const value = document.getElementById(`${sp.id}Value`);
  if (!input || !value || document.activeElement === input) return;
  const v = displaySetpoint(sp);
  if (v == null) return;
  // A coupled slider is owned by syncFieldCouplingUI (it shows the bus value).
  if (input.disabled) return;
  const s = String(v);
  if (input.value !== s) input.value = s;
  value.textContent = fmt(sp, v);
  syncReleaseState(sp);
}

/** Build one panel section per device that declares setpoints. Idempotent. */
export function renderSetpointPanels(host: HTMLElement | null = document.getElementById(HOST_ID)): void {
  if (!host) return;
  const deviceIds = [...new Set(DEVICE_SETPOINTS.map((s) => s.deviceId))];
  host.replaceChildren(
    ...deviceIds.map((deviceId) => {
      const section = document.createElement('div');
      section.className = 'panel-section';
      section.id = `setpoints-${deviceId}`;
      section.dataset.setpointDevice = deviceId;
      section.hidden = true;
      const h = document.createElement('h3');
      h.textContent = 'Bench setpoints';
      section.append(h, ...setpointsForDevice(deviceId).map(buildRow));
      return section;
    })
  );
}

/** Show only the focused device's setpoints (overview and SEG show none). */
export function showSetpointPanel(view: string): void {
  document.querySelectorAll<HTMLElement>('[data-setpoint-device]').forEach((el) => {
    const show = el.dataset.setpointDevice === view;
    el.hidden = !show;
    if (show) setpointsForDevice(view).forEach((sp) => { syncReleaseState(sp); paintSetpoint(sp); });
  });
}

/** Repaint the focused device's sliders from the plant (~4 Hz off the hub). */
export function paintFocusedSetpoints(view: string): void {
  for (const sp of setpointsForDevice(view)) paintSetpoint(sp);
}
