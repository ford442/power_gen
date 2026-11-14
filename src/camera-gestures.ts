/**
 * Camera gestures — pure pointer bookkeeping for orbit / pan / pinch / double-tap.
 *
 * `CameraController` owns the DOM listeners and pointer capture; this file only
 * turns a stream of pointer samples into camera intents, so the arithmetic is
 * checked in Node (`npm run test:camera-gestures`) without a canvas.
 *
 * | Input                              | Intent                                   |
 * |------------------------------------|------------------------------------------|
 * | one pointer (mouse, pen, finger)   | `orbit` by the pointer delta (px)        |
 * | two pointers                       | `pan` by the centroid delta (px) + `zoom` by the span ratio (pinch) |
 * | two quick taps (touch / pen only)  | `doubleTap` at the second tap            |
 *
 * A third finger is tracked but ignored — the first two still down drive. Going
 * from two fingers to one hands back to orbit without a jump: the remaining
 * finger's last sample is the new orbit origin. Mouse never taps, so a mouse
 * double-click does exactly what it did before (nothing).
 */

export interface PointerSample {
  id: number;
  x: number;
  y: number;
  /** `PointerEvent.pointerType`: 'mouse' | 'pen' | 'touch'. */
  type: string;
  /** Milliseconds on any monotonic clock (`PointerEvent.timeStamp`). */
  t: number;
}

export type GestureIntent =
  | { kind: 'orbit'; dx: number; dy: number }
  | { kind: 'pan'; dx: number; dy: number }
  /** Multiply the eye–target distance by `scale` (< 1 = closer: fingers spread). */
  | { kind: 'zoom'; scale: number }
  | { kind: 'doubleTap'; x: number; y: number };

/** A press that strays less than this (px) and lifts within TAP_MS is a tap. */
const TAP_SLOP_PX = 10;
const TAP_MS = 300;
/** The second tap must land within this long (ms) and this close (px) to the first. */
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_SLOP_PX = 32;
/** Per-sample pinch clamp, so one noisy sample cannot fling the camera. */
const MIN_ZOOM_SCALE = 0.5;
const MAX_ZOOM_SCALE = 2;
/** Two fingers closer than this (px) give no usable span ratio. */
const MIN_SPAN_PX = 8;

/** The thresholds above, for tests and docs (tree-shaken out of the app). */
export const GESTURE = {
  tapSlopPx: TAP_SLOP_PX,
  tapMs: TAP_MS,
  doubleTapMs: DOUBLE_TAP_MS,
  doubleTapSlopPx: DOUBLE_TAP_SLOP_PX,
  minZoomScale: MIN_ZOOM_SCALE,
  maxZoomScale: MAX_ZOOM_SCALE,
  minSpanPx: MIN_SPAN_PX
} as const;

export interface GestureTracker {
  /** Pointers currently down. */
  readonly activeCount: number;
  down(p: PointerSample): GestureIntent[];
  move(p: PointerSample): GestureIntent[];
  up(p: PointerSample): GestureIntent[];
  /**
   * `pointercancel` / lost capture: forget the pointer and any pending tap.
   * A no-op for pointers already released — `lostpointercapture` also follows
   * every ordinary `pointerup`, and must not eat the first tap of a pair.
   */
  cancel(id: number): void;
}

interface Tracked {
  x: number;
  y: number;
  x0: number;
  y0: number;
  t0: number;
  type: string;
}

/**
 * A closure rather than a class: this sits in the entry chunk, and closure
 * locals minify where class fields cannot.
 */
export function createGestureTracker(): GestureTracker {
  /** Insertion-ordered, so "the first two still down" is just the first two keys. */
  const pointers = new Map<number, Tracked>();
  /** This press strayed past the tap slop, or was cancelled — not a tap. */
  let moved = false;
  /** This press had a second pointer at some point — not a tap. */
  let multi = false;
  let lastTap: { x: number; y: number; t: number } | null = null;

  return {
    get activeCount() {
      return pointers.size;
    },

    down(p) {
      if (pointers.size === 0) moved = multi = false;
      pointers.set(p.id, { x: p.x, y: p.y, x0: p.x, y0: p.y, t0: p.t, type: p.type });
      if (pointers.size > 1) multi = true;
      return [];
    },

    move(p) {
      const cur = pointers.get(p.id);
      if (!cur) return [];
      if (Math.hypot(p.x - cur.x0, p.y - cur.y0) > TAP_SLOP_PX) moved = true;

      const [a, b] = pointers.keys();
      if (b === undefined) {
        const dx = p.x - cur.x;
        const dy = p.y - cur.y;
        cur.x = p.x;
        cur.y = p.y;
        return dx || dy ? [{ kind: 'orbit', dx, dy }] : [];
      }
      const pa = pointers.get(a)!;
      const pb = pointers.get(b)!;
      const cx0 = pa.x + pb.x;
      const cy0 = pa.y + pb.y;
      const span0 = Math.hypot(pa.x - pb.x, pa.y - pb.y);
      cur.x = p.x;
      cur.y = p.y;
      // A third finger only updates its own sample; the first two drive.
      if (p.id !== a && p.id !== b) return [];
      const span1 = Math.hypot(pa.x - pb.x, pa.y - pb.y);

      const out: GestureIntent[] = [];
      const dx = (pa.x + pb.x - cx0) / 2;
      const dy = (pa.y + pb.y - cy0) / 2;
      if (dx || dy) out.push({ kind: 'pan', dx, dy });
      if (span0 >= MIN_SPAN_PX && span1 >= MIN_SPAN_PX && span1 !== span0) {
        out.push({ kind: 'zoom', scale: Math.min(MAX_ZOOM_SCALE, Math.max(MIN_ZOOM_SCALE, span0 / span1)) });
      }
      return out;
    },

    up(p) {
      const cur = pointers.get(p.id);
      if (!cur || !pointers.delete(p.id) || pointers.size) return [];
      const isTap = !multi && !moved && cur.type !== 'mouse'
        && p.t - cur.t0 <= TAP_MS
        && Math.hypot(p.x - cur.x0, p.y - cur.y0) <= TAP_SLOP_PX;
      const prev = lastTap;
      lastTap = null;
      if (!isTap) return [];
      if (prev && p.t - prev.t <= DOUBLE_TAP_MS && Math.hypot(p.x - prev.x, p.y - prev.y) <= DOUBLE_TAP_SLOP_PX) {
        return [{ kind: 'doubleTap', x: p.x, y: p.y }];
      }
      lastTap = { x: p.x, y: p.y, t: p.t };
      return [];
    },

    cancel(id) {
      if (!pointers.delete(id)) return;
      moved = true;
      lastTap = null;
    }
  };
}
