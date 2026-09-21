/**
 * Header badge + mute switch for the lab sonification (#203 WS D).
 *
 * Injected **only** under `?audio=1`, so the default dashboard gains no control
 * for a feature it is not running. Its three states are the three honest ones:
 *
 *   waiting — `?audio=1` is set but no user gesture has arrived, so no
 *             `AudioContext` exists yet. Browsers require the gesture, and this
 *             says so rather than looking broken.
 *   on      — graph running, unmuted.
 *   muted   — graph running, bus ramped to zero (and the context suspended).
 *
 * Sits *before* the hardware-twin badge and borrows its shape, so the header
 * stays one row of small status chips. Inserted first rather than appended
 * because `.sci-panel-toggle` is `position: fixed` in the top-right 44 px and
 * would sit on top of anything added at the end of the row — a badge you cannot
 * click is worse than no badge.
 */
import type { LabAudio } from './lab-audio';

const LABELS: Record<string, string> = {
  waiting: 'Audio: tap',
  on: 'Audio on',
  muted: 'Audio muted'
};

export type LabAudioBadgeState = keyof typeof LABELS;

export function labAudioBadgeState(audio: Pick<LabAudio, 'started' | 'muted'>): LabAudioBadgeState {
  if (!audio.started) return 'waiting';
  return audio.muted ? 'muted' : 'on';
}

/** Mount the badge and keep it in sync. No-op when audio is disabled. */
export function initLabAudioBadge(audio: LabAudio): void {
  if (!audio.enabled || typeof document === 'undefined') return;
  if (document.getElementById('lab-audio-badge')) return;

  const host = document.querySelector('.header-right');
  if (!host) return;

  const el = document.createElement('button');
  el.type = 'button';
  el.id = 'lab-audio-badge';
  el.dataset.state = labAudioBadgeState(audio);
  el.title = 'Lab sonification (?audio=1) — click to mute / unmute';
  el.innerHTML = `
    <span class="lab-audio-dot" aria-hidden="true"></span>
    <span id="labAudioBadgeText">${LABELS[el.dataset.state]}</span>
  `;

  const styles = document.createElement('style');
  styles.id = 'lab-audio-badge-styles';
  styles.textContent = `
    #lab-audio-badge {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 10px; border-radius: 4px; cursor: pointer;
      background: rgba(0, 20, 30, 0.85); border: 1px solid #345;
      font: inherit; font-size: 0.72rem; color: #678;
    }
    #lab-audio-badge[data-state="on"] { border-color: #0a8; color: #9fc; }
    #lab-audio-badge[data-state="waiting"] { border-color: #a80; color: #fc6; }
    .lab-audio-dot { width: 7px; height: 7px; border-radius: 50%; background: #456; }
    #lab-audio-badge[data-state="on"] .lab-audio-dot { background: #0f8; box-shadow: 0 0 6px #0f8; }
    #lab-audio-badge[data-state="waiting"] .lab-audio-dot { background: #fa0; box-shadow: 0 0 6px #fa0; }
  `;
  if (!document.getElementById('lab-audio-badge-styles')) document.head.appendChild(styles);

  const sync = (): void => {
    const state = labAudioBadgeState(audio);
    el.dataset.state = state;
    const text = document.getElementById('labAudioBadgeText');
    if (text) text.textContent = LABELS[state];
  };

  // One physical click must not mean two things. `LabAudio` arms a *window*
  // `pointerdown` listener to catch the first gesture anywhere on the page, and
  // window-phase listeners run after this element's own, so by the time `click`
  // arrives the graph has already started and unmuted itself. Toggling here too
  // would mute the audio the same click just switched on.
  //
  // So note, in the element's own pointerdown (which fires first), whether this
  // click is the one that starts things, and let that click do only that.
  // The same reasoning covers the keyboard: this is a <button>, so Enter/Space
  // dispatch a synthetic click, and `LabAudio` arms a window `keydown` too.
  let startingFromThisClick = false;
  el.addEventListener('pointerdown', () => {
    startingFromThisClick = !audio.started;
  });
  el.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && !audio.started) {
      startingFromThisClick = true;
    }
  });
  el.addEventListener('click', () => {
    if (startingFromThisClick) {
      startingFromThisClick = false;
      // Belt and braces: if the window listener somehow missed the gesture
      // (synthetic click, no pointer events), start from here instead.
      if (!audio.started) void audio.start().then(sync);
      sync();
      return;
    }
    audio.toggleMuted();
    sync();
  });

  host.insertBefore(el, host.firstElementChild);
  // The arming gesture may land anywhere on the page, so poll the state cheaply
  // rather than threading a callback through LabAudio for one chip of text.
  setInterval(sync, 500);
}
