/**
 * Focus-change live region — announces *where you are* (lab mode + focused
 * bench) and one headline number whenever the focus changes, for the projector
 * room and for screen readers. Fed off TelemetryHub like every other panel; it
 * owns no state beyond the last announced view.
 *
 * Deliberately one sentence, once per focus change. Per-frame values would turn
 * a polite live region into a firehose; the instrument panel already carries
 * those.
 */
import { telemetryHub } from './telemetry-hub';
import {
  deviceLabel,
  formatTelemetryValue,
  readTelemetryKey,
  telemetryFieldsForDevice
} from './telemetry/telemetry-fields';
import { LAB_MODE_PRESETS, isLabMode } from './lab-mode';
import type { TelemetrySnapshot } from './telemetry/types';

/** Let the new bench's first frames land so the number isn't the previous bench's 0. */
const SETTLE_MS = 500;
const REGION_ID = 'focusLiveRegion';

/** `Pulse Coil, I 12.40 A` — the focused bench's first catalog telemetry field. */
export function headlineFor(snap: Pick<TelemetrySnapshot, 'view' | 'seg' | 'devices'>): string {
  const view = snap.view || 'overview';
  if (view === 'overview') return 'Overview';
  if (view === 'seg') {
    const rpm = snap.seg?.rpmDisplay;
    return Number.isFinite(rpm) ? `SEG, inner ring ${Math.round(rpm as number)} RPM` : 'SEG';
  }
  const label = deviceLabel(view);
  const field = telemetryFieldsForDevice(view)[0];
  const device = snap.devices?.[view];
  if (!field || !device) return label;
  return `${label}, ${field.label} ${formatTelemetryValue(readTelemetryKey(device, field.key), field)}`;
}

/** Full sentence: lab mode (when one is active) then the focus headline. */
export function announcementFor(
  snap: Pick<TelemetrySnapshot, 'view' | 'seg' | 'devices'>,
  labMode: string | null
): string {
  const mode = isLabMode(labMode) ? `${LAB_MODE_PRESETS[labMode].label} mode. ` : '';
  return `${mode}${headlineFor(snap)}`;
}

function ensureRegion(): HTMLElement {
  let el = document.getElementById(REGION_ID);
  if (el) return el;
  el = document.createElement('div');
  el.id = REGION_ID;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-atomic', 'true');
  // Visually hidden, still in the accessibility tree.
  el.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;'
    + 'clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0;';
  document.body.appendChild(el);
  return el;
}

/** Name the instrument group so a screen reader reads "Pulse Coil readout" not "group". */
function labelReadout(view: string): void {
  const readout = document.getElementById('device-readout');
  if (!readout) return;
  readout.setAttribute('role', 'group');
  readout.setAttribute('aria-label', `${deviceLabel(view)} readout`);
}

export function initFocusLiveRegion(getLabMode: () => string | null = () => null): () => void {
  const region = ensureRegion();
  let announcedView: string | null = null;
  let announcedMode: string | null = null;
  let latest: TelemetrySnapshot | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const announce = (): void => {
    timer = null;
    if (!latest) return;
    const mode = getLabMode();
    announcedView = latest.view;
    announcedMode = mode;
    labelReadout(latest.view);
    region.textContent = announcementFor(latest, mode);
  };

  const schedule = (): void => {
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(announce, SETTLE_MS);
  };

  const unsubscribe = telemetryHub.subscribe((snap) => {
    latest = snap;
    const view = snap.view || 'overview';
    if (view !== announcedView || getLabMode() !== announcedMode) {
      // Mark now so a 60 Hz hub doesn't re-arm the timer every frame.
      announcedView = view;
      announcedMode = getLabMode();
      schedule();
    }
  }, { immediate: false });

  const onMode = (): void => {
    announcedMode = null;
    schedule();
  };
  window.addEventListener('seg-lab-mode', onMode);

  return () => {
    unsubscribe();
    window.removeEventListener('seg-lab-mode', onMode);
    if (timer != null) clearTimeout(timer);
  };
}
