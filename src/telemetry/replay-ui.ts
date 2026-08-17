/**
 * Replay scrubber chrome — file picker, drag-drop, play/pause/step.
 */

import { replayPlayer, type ReplayPlayerState } from './replay-player';

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}:${rem.toFixed(2).padStart(5, '0')}`;
}

export function isReplayQueryEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('replay') === '1';
}

export function setReplayBarVisible(visible: boolean): void {
  const bar = $('replay-bar');
  if (!bar) return;
  bar.hidden = !visible;
  bar.setAttribute('aria-hidden', visible ? 'false' : 'true');
  document.body.classList.toggle('replay-ui-open', visible);
}

export function initReplayUI(): void {
  const bar = $('replay-bar');
  const playBtn = $('replayPlayBtn') as HTMLButtonElement | null;
  const stepBtn = $('replayStepBtn') as HTMLButtonElement | null;
  const exitBtn = $('replayExitBtn') as HTMLButtonElement | null;
  const openBtn = $('replayOpenBtn') as HTMLButtonElement | null;
  const fileInput = $('replayFileInput') as HTMLInputElement | null;
  const scrub = $('replayScrub') as HTMLInputElement | null;
  const timeEl = $('replayTime');
  const nameEl = $('replayFileName');
  const statusEl = $('replayStatus');
  const badge = $('replay-badge');
  const dropTarget = $('canvas-wrapper') || document.body;

  if (!bar) return;

  if (isReplayQueryEnabled()) setReplayBarVisible(true);

  const sync = (s: ReplayPlayerState) => {
    if (badge) {
      badge.hidden = !s.loaded;
      const label = badge.querySelector('#replayBadgeText');
      if (label) label.textContent = s.loaded ? 'REPLAY' : '';
    }
    document.body.classList.toggle('replay-mode', s.loaded);
    if (playBtn) {
      playBtn.textContent = s.playing ? '❚❚' : '▶';
      playBtn.title = s.playing ? 'Pause replay' : 'Play replay';
      playBtn.disabled = !s.loaded;
    }
    if (stepBtn) stepBtn.disabled = !s.loaded;
    if (exitBtn) exitBtn.disabled = !s.loaded;
    if (scrub) {
      const max = Math.max(s.duration, 0.001);
      scrub.max = String(max);
      scrub.step = String(Math.max(0.001, max / 1000));
      if (document.activeElement !== scrub) scrub.value = String(s.t);
      scrub.disabled = !s.loaded;
    }
    if (timeEl) {
      timeEl.textContent = s.loaded ? `${fmtTime(s.t)} / ${fmtTime(s.duration)}` : '— / —';
    }
    if (nameEl) nameEl.textContent = s.filename || 'No file';
    if (statusEl) {
      if (s.parsing) statusEl.textContent = 'Parsing in worker…';
      else if (s.error) statusEl.textContent = s.error;
      else if (s.loaded) statusEl.textContent = s.source === 'csv' ? 'CSV replay (gauges overlay)' : 'Replay loaded';
      else statusEl.textContent = 'Load a .seg-replay.json or telemetry CSV';
      statusEl.classList.toggle('replay-status-error', !!s.error);
    }
  };

  replayPlayer.subscribe(sync);

  playBtn?.addEventListener('click', () => replayPlayer.toggle());
  stepBtn?.addEventListener('click', () => replayPlayer.step());
  exitBtn?.addEventListener('click', () => {
    replayPlayer.exit();
    if (!isReplayQueryEnabled()) setReplayBarVisible(false);
  });

  const pick = () => fileInput?.click();
  openBtn?.addEventListener('click', pick);

  const loadFile = async (file: File) => {
    setReplayBarVisible(true);
    try {
      await replayPlayer.loadFile(file);
    } catch {
      /* status already set */
    }
  };

  fileInput?.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) void loadFile(file);
  });

  let dragDepth = 0;
  dropTarget.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth += 1;
    dropTarget.classList.add('replay-drop-active');
  });
  dropTarget.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  dropTarget.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropTarget.classList.remove('replay-drop-active');
  });
  dropTarget.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropTarget.classList.remove('replay-drop-active');
    const file = e.dataTransfer?.files?.[0];
    if (file) void loadFile(file);
  });

  let scrubbing = false;
  scrub?.addEventListener('pointerdown', () => { scrubbing = true; });
  scrub?.addEventListener('input', () => {
    if (!scrub) return;
    replayPlayer.seek(parseFloat(scrub.value) || 0);
  });
  window.addEventListener('pointerup', () => { scrubbing = false; });
  void scrubbing;
}

export function showReplayBar(): void {
  setReplayBarVisible(true);
}
