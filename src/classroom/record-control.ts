/**
 * Record control (#224 §5, docs/CLASSROOM.md): "Video ● 10s ● 30s ● 60s" in the
 * Telemetry Export panel, with a progress bar and auto-stop + download.
 *
 * Built from TS so `index.html` stays untouched. Part of the lazy classroom
 * chunk; the recorder itself (`./recorder`) loads on the first click.
 */

/** Same values as `RECORD_PRESETS_S` in ./recorder (importing it would load the recorder). */
const PRESETS_S = [10, 30, 60];

export function mountRecordControl(): HTMLElement | null {
  const existing = document.getElementById('classroomRecord');
  if (existing) return existing;
  // Sits just above the telemetry export status line.
  const anchor = document.getElementById('telemetryExportStatus');
  const host = anchor?.parentElement;
  if (!anchor || !host) return null;

  const wrap = document.createElement('div');
  wrap.id = 'classroomRecord';
  wrap.innerHTML = `
    <div class="ctrl-row" style="flex-wrap:wrap;gap:4px;margin-top:4px;align-items:center;">
      <span style="font-size:0.65rem;color:#0aa;margin-right:2px;">Video</span>
      ${PRESETS_S.map((s) => `<button class="ctrl-btn" type="button" data-rec-seconds="${s}" style="font-size:0.68rem;"
        title="Record ${s} s of the lab view, then download it">● ${s}s</button>`).join('')}
    </div>
    <progress max="1" value="0" hidden aria-label="Recording progress"
      style="display:block;width:100%;height:6px;margin-top:4px;"></progress>
    <div role="status" style="font-size:0.62rem;color:#0aa;margin-top:2px;line-height:1.4;">
      Clips carry “Simulated — not metrology”</div>`;
  host.insertBefore(wrap, anchor);

  const buttons = [...wrap.querySelectorAll<HTMLButtonElement>('[data-rec-seconds]')];
  const progress = wrap.querySelector('progress')!;
  const status = wrap.querySelector<HTMLElement>('[role="status"]')!;
  const say = (text: string, ok = true) => {
    status.textContent = text;
    status.style.color = ok ? '#0aa' : '#f66';
  };

  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
    for (const b of buttons) b.disabled = true;
    say('Video recording is not available in this browser', false);
    return wrap;
  }

  let stop: AbortController | null = null;
  for (const btn of buttons) {
    btn.addEventListener('click', async () => {
      // While recording, the pressed preset is the Stop button (the rest are disabled).
      if (stop) {
        stop.abort();
        return;
      }
      const seconds = Number(btn.dataset.recSeconds);
      stop = new AbortController();
      for (const b of buttons) b.disabled = b !== btn;
      btn.textContent = '■ Stop';
      progress.value = 0;
      progress.hidden = false;
      say(`Recording 0 / ${seconds} s…`);
      let shown = 0;
      try {
        const rec = await import('./recorder');
        const result = await rec.recordCanvas({
          seconds,
          signal: stop.signal,
          onProgress: (t, total) => {
            progress.value = t / total;
            if (Math.floor(t) !== shown) say(`Recording ${(shown = Math.floor(t))} / ${total} s…`);
          }
        });
        rec.downloadRecording(result);
        say(`Saved ${result.fileName} · ${(result.blob.size / 1e6).toFixed(1)} MB${result.hasAudio ? ' · with audio' : ''}`);
      } catch (err) {
        say(`Recording failed: ${err instanceof Error ? err.message : String(err)}`, false);
      } finally {
        stop = null;
        progress.hidden = true;
        for (const b of buttons) {
          b.disabled = false;
          b.textContent = `● ${b.dataset.recSeconds}s`;
        }
      }
    });
  }
  return wrap;
}
