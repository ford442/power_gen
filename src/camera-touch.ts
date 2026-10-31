/**
 * Touch / pen camera input (#224 §5, docs/CLASSROOM.md) — a lazy chunk.
 *
 * `CameraController` keeps the mouse path in the entry chunk exactly as it was
 * and hands every non-mouse pointer event here; desktop mouse boots never load
 * this file (touch-capable devices prefetch it at boot). Events that arrive
 * while it loads are queued and replayed in order, so no gesture is lost.
 *
 * | Gesture                 | Camera                                                   |
 * |-------------------------|----------------------------------------------------------|
 * | one-finger drag         | orbit — same rad/px as a mouse drag                      |
 * | two-finger drag         | pan: eye and target slide together; the scene follows the fingers |
 * | pinch                   | dolly: eye–target distance × span ratio, clamped         |
 * | double-tap (overview)   | focus the device nearest the tap; empty space re-frames the overview |
 * | double-tap (device view)| back to the overview                                     |
 *
 * Gesture bookkeeping is in camera-gestures.ts; this file maps intents onto the
 * camera. Both are checked by `npm run test:camera-gestures`.
 */
import { createGestureTracker, type GestureIntent, type PointerSample } from './camera-gestures';
import { ORBIT_RAD_PER_PX, type CameraController, type CameraState } from './camera-controller';
import { getMergedDeviceConfig } from './devices/device-registry';

/** Pinch clamps: nearer clips into a bench, farther leaves the lab (far plane 200). */
export const MIN_DISTANCE = 0.5;
export const MAX_DISTANCE = 150;
/** Double-tap pick radius: this fraction of the canvas's short side, at least 40 px. */
const PICK_RADIUS_FRACTION = 0.12;
const PICK_RADIUS_MIN_PX = 40;

/**
 * What double-tap needs from the scene. `MultiDeviceCamera` provides it: the
 * canvas, the view-projection it renders with, and the visualizer's view state.
 */
export interface FocusPicker {
  canvas: HTMLCanvasElement;
  visualizer: { currentView: string; devicesEnabled?: Record<string, boolean> };
  getViewProjMatrix(): Float32Array;
}

export interface TouchInput {
  handle(e: PointerEvent): void;
}

/**
 * Slide eye and target together across the view plane (two-finger pan).
 * `dx`/`dy` are CSS px on a view `viewportPx` tall; one pixel moves one pixel's
 * worth of world at the target's depth, so the scene tracks the fingers.
 */
export function panCamera(cam: CameraState, dx: number, dy: number, viewportPx: number): void {
  const p = cam.position;
  const t = cam.target;
  const f = [t[0] - p[0], t[1] - p[1], t[2] - p[2]];
  const dist = Math.hypot(f[0], f[1], f[2]);
  // right = forward × worldUp; degenerate when looking straight down.
  const rLen = Math.hypot(f[0], f[2]);
  if (!dist || !rLen || !(viewportPx > 0)) return;
  const right = [-f[2] / rLen, 0, f[0] / rLen];
  const fn = [f[0] / dist, f[1] / dist, f[2] / dist];
  const up = [
    right[1] * fn[2] - right[2] * fn[1],
    right[2] * fn[0] - right[0] * fn[2],
    right[0] * fn[1] - right[1] * fn[0]
  ];
  const worldPerPx = (2 * dist * Math.tan((cam.fov * Math.PI) / 360)) / viewportPx;
  for (let i = 0; i < 3; i++) {
    const d = (-dx * right[i] + dy * up[i]) * worldPerPx;
    p[i] += d;
    t[i] += d;
  }
}

/** Scale the eye–target distance (pinch), clamped to [MIN_DISTANCE, MAX_DISTANCE]. */
export function dollyCamera(cam: CameraState, scale: number): void {
  const p = cam.position;
  const t = cam.target;
  const d = [p[0] - t[0], p[1] - t[1], p[2] - t[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (!len || !(scale > 0) || !Number.isFinite(scale)) return;
  const k = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, len * scale)) / len;
  for (let i = 0; i < 3; i++) p[i] = t[i] + d[i] * k;
}

/**
 * The device whose origin projects nearest to a client-space point, within the
 * pick radius — what double-tap focuses. A screen-space centre pick, not a mesh
 * ray-cast: benches sit well apart in the overview, and this needs no
 * per-backend geometry. Disabled devices and ones behind the eye never match.
 */
export function pickDeviceAt(host: FocusPicker, clientX: number, clientY: number): string | null {
  const rect = host.canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const m = host.getViewProjMatrix();
  const enabled = host.visualizer.devicesEnabled;
  let best: string | null = null;
  let bestPx = Math.max(PICK_RADIUS_MIN_PX, PICK_RADIUS_FRACTION * Math.min(rect.width, rect.height));
  for (const [id, config] of Object.entries(getMergedDeviceConfig())) {
    const p = config.position;
    if (!p || enabled?.[id] === false) continue;
    // Column-major view-projection, as MultiDeviceCamera builds it.
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if (w <= 1e-3) continue;
    const ndcX = (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w;
    const ndcY = (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w;
    const px = Math.hypot(
      rect.left + (ndcX + 1) * 0.5 * rect.width - clientX,
      rect.top + (1 - ndcY) * 0.5 * rect.height - clientY
    );
    if (px < bestPx) {
      bestPx = px;
      best = id;
    }
  }
  return best;
}

export function createTouchInput(
  controller: CameraController,
  canvas: HTMLCanvasElement,
  onModeChange: (mode: string) => void,
  getFocus?: () => FocusPicker | null | undefined
): TouchInput {
  const gestures = createGestureTracker();
  return {
    handle(e) {
      const s: PointerSample = { id: e.pointerId, x: e.clientX, y: e.clientY, type: e.pointerType, t: e.timeStamp };
      let intents: GestureIntent[];
      switch (e.type) {
        case 'pointerdown':
          intents = gestures.down(s);
          break;
        case 'pointermove':
          intents = gestures.move(s);
          break;
        case 'pointerup':
          intents = gestures.up(s);
          break;
        default: // pointercancel / lostpointercapture: dropped, never a tap
          gestures.cancel(e.pointerId);
          return;
      }
      const cam = controller.camera;
      for (const g of intents) {
        switch (g.kind) {
          case 'orbit':
            controller.orbit(g.dx * ORBIT_RAD_PER_PX, g.dy * ORBIT_RAD_PER_PX);
            break;
          case 'pan':
            panCamera(cam, g.dx, g.dy, canvas.clientHeight);
            break;
          case 'zoom':
            dollyCamera(cam, g.scale);
            break;
          case 'doubleTap': {
            const focus = getFocus?.();
            if (!focus) break;
            const inOverview = (focus.visualizer.currentView || 'overview') === 'overview';
            onModeChange(inOverview ? (pickDeviceAt(focus, g.x, g.y) ?? 'overview') : 'overview');
            break;
          }
        }
      }
    }
  };
}
