/**
 * Classroom video recorder (#224 §5, docs/CLASSROOM.md) — a lazy chunk,
 * imported on the first Record click or `window.recordBench()` call.
 *
 * ```
 *   #gpuCanvas ──drawImage──┐
 *   sim clock + wall clock ─┼─ 2D composite ── captureStream(30) ─┐
 *   "Simulated — not metrology"                                   ├─ MediaRecorder → Blob
 *   LabAudio master ── createRecordingTap() ── audio track ───────┘
 * ```
 *
 * The composite exists so the disclaimer and clocks are *burned into* every
 * frame: a clip that leaves the classroom still says what it is. The recorder
 * reads the WebGPU / WebGL2 canvas from its own `requestAnimationFrame`
 * callback, which runs after the renderer's in the same frame (it registers
 * later), so it reads the frame just drawn without `preserveDrawingBuffer`.
 *
 * No WebCodecs, no muxer: MediaRecorder picks the container. WebM (VP9/VP8,
 * Opus) is preferred; MP4 (H.264, AAC) is the fallback where WebM recording is
 * missing (Safari).
 */
import { telemetryHub } from '../telemetry-hub';

export const RECORD_PRESETS_S = [10, 30, 60] as const;
export const RECORD_FPS = 30;
export const RECORDING_DISCLAIMER = 'Simulated — not metrology';
/** Longest edge of the encoded frame; larger canvases are scaled down. */
const MAX_EDGE_PX = 1920;
const VIDEO_BITS_PER_SECOND = 6_000_000;
/** Upper bound for `recordBench(seconds)` — the UI only offers the presets. */
const MAX_SECONDS = 600;
/**
 * A starved machine (software GL, an overloaded laptop) can reach the
 * deadline — or the Stop click — before the encoder has emitted a byte, and
 * stopping then yields an empty file. Stopping waits (at most this much past
 * the planned end) for the first chunk instead.
 */
const FIRST_CHUNK_GRACE_MS = 20_000;

/** Preference order. With audio, only types that carry (or default) an audio codec. */
const TYPES_WITH_AUDIO = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4'
];
const TYPES_VIDEO_ONLY = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4;codecs=avc1',
  'video/mp4'
];

/** First MediaRecorder type the browser supports, WebM before MP4; null if none. */
export function pickRecorderMimeType(isTypeSupported: (type: string) => boolean, withAudio: boolean): string | null {
  for (const type of withAudio ? TYPES_WITH_AUDIO : TYPES_VIDEO_ONLY) {
    try {
      if (isTypeSupported(type)) return type;
    } catch { /* treat a throwing probe as unsupported */ }
  }
  return null;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Local wall time as `YYYY-MM-DD HH:MM:SS`. */
export function formatWallClock(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** The burned-in clock line: simulated seconds, then wall time. */
export function formatRecordingClock(simTimeS: number, wall: Date): string {
  const sim = Number.isFinite(simTimeS) ? Math.max(0, simTimeS).toFixed(2) : '—';
  return `sim t = ${sim} s · ${formatWallClock(wall)}`;
}

/** `seg-lab-2026-10-18T10-44-03.webm` (or `.mp4`), local time. */
export function recordingFileName(when: Date, mimeType: string): string {
  const stamp = formatWallClock(when).replace(' ', 'T').replace(/:/g, '-');
  return `seg-lab-${stamp}.${mimeType.startsWith('video/mp4') ? 'mp4' : 'webm'}`;
}

/** Fit `w × h` inside MAX_EDGE_PX, even dimensions (encoders want 4:2:0 macroblocks). */
export function fitRecordingSize(w: number, h: number): { width: number; height: number } {
  if (!(w > 0) || !(h > 0)) return { width: 1280, height: 720 };
  const k = Math.min(1, MAX_EDGE_PX / Math.max(w, h));
  const even = (v: number) => Math.max(2, Math.round((v * k) / 2) * 2);
  return { width: even(w), height: even(h) };
}

export interface RecordOptions {
  seconds: number;
  /** Defaults to `#gpuCanvas`. */
  source?: HTMLCanvasElement | null;
  /** Every composited frame: elapsed wall seconds (capped at `seconds`). */
  onProgress?: (elapsedS: number, totalS: number) => void;
  /** Abort = stop early and keep what was recorded. */
  signal?: AbortSignal;
}

export interface Recording {
  blob: Blob;
  mimeType: string;
  fileName: string;
  /** Wall seconds actually recorded. */
  seconds: number;
  hasAudio: boolean;
}

let active: Promise<Recording> | null = null;

export function isRecording(): boolean {
  return active !== null;
}

/** Record the lab canvas (+ lab audio when it is audible). One at a time. */
export function recordCanvas(opts: RecordOptions): Promise<Recording> {
  if (active) return Promise.reject(new Error('A recording is already running'));
  const run = runRecording(opts);
  active = run;
  const clear = () => { active = null; };
  run.then(clear, clear);
  return run;
}

/** `window.recordBench(seconds)`: record, return the Blob, no download. */
export async function recordBench(seconds = 10): Promise<Blob> {
  return (await recordCanvas({ seconds })).blob;
}

/** Click a temporary link to save the recording. */
export function downloadRecording(rec: Recording): void {
  const url = URL.createObjectURL(rec.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = rec.fileName;
  a.click();
  // Give the download a moment to start before the URL dies.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function drawFrame(ctx: CanvasRenderingContext2D, source: HTMLCanvasElement, w: number, h: number): void {
  ctx.fillStyle = '#050a0f';
  ctx.fillRect(0, 0, w, h);
  // Fit, don't stretch: the canvas can be resized mid-recording.
  const sw = source.width || w;
  const sh = source.height || h;
  const k = Math.min(w / sw, h / sh);
  try {
    ctx.drawImage(source, (w - sw * k) / 2, (h - sh * k) / 2, sw * k, sh * k);
  } catch { /* zero-sized or lost context: keep the clocks running on black */ }

  const fs = Math.max(12, Math.round(h / 36));
  const pad = Math.round(fs * 0.6);
  const clock = formatRecordingClock(telemetryHub.getSimTimeS(), new Date());
  ctx.font = `600 ${fs}px ui-monospace, Menlo, Consolas, monospace`;
  ctx.textBaseline = 'middle';
  const oneLine = ctx.measureText(RECORDING_DISCLAIMER).width + ctx.measureText(clock).width + pad * 4 <= w;
  const line = fs + pad;
  const band = (oneLine ? line : line * 2) + pad;
  ctx.fillStyle = 'rgba(0, 8, 16, 0.75)';
  ctx.fillRect(0, h - band, w, band);
  ctx.fillStyle = '#ffb000';
  ctx.textAlign = 'left';
  ctx.fillText(RECORDING_DISCLAIMER, pad, h - band + pad / 2 + line / 2);
  ctx.fillStyle = '#00e5ff';
  ctx.textAlign = oneLine ? 'right' : 'left';
  ctx.fillText(clock, oneLine ? w - pad : pad, h - pad / 2 - line / 2);
}

async function runRecording(opts: RecordOptions): Promise<Recording> {
  const seconds = Math.min(MAX_SECONDS, Math.max(0.5, Number(opts.seconds) || 0));
  const source = opts.source ?? (document.getElementById('gpuCanvas') as HTMLCanvasElement | null);
  if (!source) throw new Error('No #gpuCanvas to record');
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
    throw new Error('Recording needs MediaRecorder and canvas.captureStream (not available in this browser)');
  }

  const { width, height } = fitRecordingSize(source.width, source.height);
  const composite = document.createElement('canvas');
  composite.width = width;
  composite.height = height;
  const ctx = composite.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('No 2D context for the recording composite');
  drawFrame(ctx, source, width, height); // the stream never starts on a blank frame

  const stream = composite.captureStream(RECORD_FPS);
  const audio = window.labAudio?.createRecordingTap?.() ?? null;
  for (const track of audio?.getAudioTracks() ?? []) stream.addTrack(track);
  const hasAudio = stream.getAudioTracks().length > 0;

  let raf = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    for (const track of stream.getVideoTracks()) track.stop();
    if (audio) window.labAudio?.releaseRecordingTap?.();
  };

  const mimeType = pickRecorderMimeType((t) => MediaRecorder.isTypeSupported(t), hasAudio);
  let recorder: MediaRecorder;
  try {
    if (!mimeType) throw new Error('No supported MediaRecorder video format');
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: VIDEO_BITS_PER_SECOND });
  } catch (err) {
    cleanup();
    throw err;
  }

  const chunks: Blob[] = [];
  let bytes = 0;
  const startedAt = new Date();
  const t0 = performance.now();
  const elapsed = () => Math.min(seconds, (performance.now() - t0) / 1000);

  return new Promise<Recording>((resolve, reject) => {
    const deadline = performance.now() + seconds * 1000 + FIRST_CHUNK_GRACE_MS;
    const stop = () => {
      if (recorder.state === 'inactive') return;
      // Nothing encoded yet: keep going until the first chunk lands (bounded).
      if (!bytes && performance.now() < deadline) {
        timer = setTimeout(stop, 250);
        return;
      }
      recorder.stop();
    };
    recorder.ondataavailable = (e) => {
      if (!e.data.size) return;
      chunks.push(e.data);
      bytes += e.data.size;
    };
    recorder.onerror = (e) => {
      cleanup();
      reject((e as Event & { error?: unknown }).error ?? new Error('MediaRecorder error'));
    };
    recorder.onstop = () => {
      const recorded = (performance.now() - t0) / 1000;
      cleanup();
      const blob = new Blob(chunks, { type: mimeType });
      if (!blob.size) {
        reject(new Error('Recording produced no data'));
        return;
      }
      resolve({ blob, mimeType, fileName: recordingFileName(startedAt, mimeType), seconds: recorded, hasAudio });
    };

    const frame = () => {
      drawFrame(ctx, source, width, height);
      opts.onProgress?.(elapsed(), seconds);
      raf = requestAnimationFrame(frame);
    };
    opts.signal?.addEventListener('abort', stop, { once: true });
    recorder.start(1000);
    timer = setTimeout(stop, seconds * 1000);
    raf = requestAnimationFrame(frame);
    if (opts.signal?.aborted) stop();
  });
}
