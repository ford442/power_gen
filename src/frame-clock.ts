/**
 * One frame clock for UI that repaints on its own cadence.
 *
 * Panels used to run their own `requestAnimationFrame` loops beside the render
 * loop — some forever, some at 60 Hz for a readout nobody reads that fast. They
 * now subscribe here instead. `LabSession.publishFrame` ticks the clock once
 * per rendered frame, after the plant step and the hub publish, so every
 * subscriber sees this frame's telemetry and nothing ticks when no renderer is
 * running (hard-fail page, lost context).
 *
 *   const off = onFrame(({ dt }) => panel.paint(dt), { hz: 10, signal });
 *
 * A hidden panel should unsubscribe (call `off()` or abort `signal`) rather
 * than return early every frame.
 */

export interface FrameTick {
  /** `performance.now()` at the tick. */
  now: number;
  /** Seconds since this subscriber last ran (0 on its first call). */
  dt: number;
}

export interface OnFrameOptions {
  /** Upper bound on calls per second. Omit to run every rendered frame. */
  hz?: number;
  /** Unsubscribes when aborted. */
  signal?: AbortSignal;
}

interface Subscriber {
  fn: (tick: FrameTick) => void;
  minIntervalMs: number;
  last: number;
}

/**
 * Slack so a 10 Hz subscriber on a 60 Hz display runs every 6th frame
 * (100 ms) instead of slipping to every 7th when frame timestamps jitter.
 */
const JITTER_MS = 4;

const subscribers = new Set<Subscriber>();

/** Run `fn` on rendered frames (at most `hz` per second). Returns an unsubscribe. */
export function onFrame(fn: (tick: FrameTick) => void, opts: OnFrameOptions = {}): () => void {
  if (opts.signal?.aborted) return () => {};
  const hz = opts.hz;
  const sub: Subscriber = {
    fn,
    minIntervalMs: hz && hz > 0 && Number.isFinite(hz) ? 1000 / hz : 0,
    last: Number.NaN
  };
  subscribers.add(sub);
  const off = (): void => {
    subscribers.delete(sub);
    opts.signal?.removeEventListener('abort', off);
  };
  opts.signal?.addEventListener('abort', off, { once: true });
  return off;
}

/**
 * Advance the clock. Called by `LabSession.publishFrame`; tests may call it
 * directly. A throwing subscriber is logged and never stops the render loop.
 */
export function tickFrameClock(now: number = performance.now()): void {
  if (subscribers.size === 0) return;
  // Snapshot: a subscriber may unsubscribe itself (or another) mid-tick.
  for (const sub of [...subscribers]) {
    if (!subscribers.has(sub)) continue;
    const first = Number.isNaN(sub.last);
    const elapsed = first ? 0 : now - sub.last;
    if (!first && elapsed < sub.minIntervalMs - JITTER_MS) continue;
    sub.last = now;
    try {
      sub.fn({ now, dt: elapsed / 1000 });
    } catch (err) {
      console.error('[frame-clock] subscriber threw:', err);
    }
  }
}

/** Live subscriber count (debug / tests). */
export function frameClockSubscriberCount(): number {
  return subscribers.size;
}
