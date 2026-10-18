import type { FocusPicker, TouchInput } from './camera-touch';

export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  transitionActive: boolean;
  transitionStart: number | null;
  transitionDuration: number;
  startPos: [number, number, number] | null;
  startTarget: [number, number, number] | null;
  endPos: number[] | null;
  endTarget: number[] | null;
}

export type ViewMode = 'seg' | 'heron' | 'kelvin' | 'solar';

/** Radians of orbit per pointer pixel — mouse and finger drags share it. */
export const ORBIT_RAD_PER_PX = 0.01;

/** Keyboard shortcuts must not fire while the user is typing or using a control. */
function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
    || el.isContentEditable;
}

export class CameraController {
  camera: CameraState;
  currentView: ViewMode | 'overview';
  mouseDown: boolean;
  lastMouseX: number;
  lastMouseY: number;
  mouseButtons: number;
  /** Removes every listener `setupInteraction` added (re-setup or dispose). */
  private _interactionAbort: AbortController | null = null;

  constructor() {
    this.camera = {
      position: [0, 8, 18],
      target: [0, 0, 0],
      fov: 45,
      transitionActive: false,
      transitionStart: null,
      transitionDuration: 1.5,
      startPos: null,
      startTarget: null,
      endPos: null,
      endTarget: null
    };

    this.currentView = 'overview';
    this.mouseDown = false;
    this.lastMouseX = 0;
    this.lastMouseY = 0;
    this.mouseButtons = 0;
  }

  /**
   * Pointer + keyboard input. Mouse is handled here (left-drag orbit, wheel
   * zoom); touch and pen go to camera-touch.ts (orbit / pan / pinch /
   * double-tap). `getFocus` lets double-tap focus a device — see that file.
   */
  setupInteraction(
    canvas: HTMLCanvasElement,
    onModeChange: (mode: string) => void,
    getFocus?: () => FocusPicker | null | undefined
  ): void {
    // Re-setup (device-loss rebuild, renderer re-init) must not stack handlers.
    this._interactionAbort?.abort();
    this._interactionAbort = new AbortController();
    const { signal } = this._interactionAbort;
    // Touch drags orbit instead of scrolling the page (and cancelling the
    // pointer). The stylesheet says the same for #gpuCanvas before boot.
    canvas.style.touchAction = 'none';

    // Touch and pen: a lazy chunk, so desktop boots never fetch it (touch
    // devices prefetch it now). Events that arrive while it loads are queued
    // and replayed in order, so the first gesture is not lost.
    let touch: TouchInput | null = null;
    let pending: PointerEvent[] | null = null;
    const toTouch = (e: PointerEvent): void => {
      if (touch) touch.handle(e);
      else if (pending) pending.push(e);
      else if (e.type === 'pointerdown') {
        pending = [e];
        import('./camera-touch')
          .then((m) => {
            if (signal.aborted) return;
            touch = m.createTouchInput(this, canvas, onModeChange, getFocus);
            for (const q of pending!) touch.handle(q);
          })
          .catch((err) => console.warn('[camera] touch input unavailable:', err))
          .finally(() => { pending = null; });
      }
    };
    if (navigator.maxTouchPoints > 0) import('./camera-touch').catch(() => { /* retried on first touch */ });

    // Pointer Events + capture: a drag that leaves the canvas (or the window)
    // keeps orbiting and always sees its pointerup, so it can't get stuck
    // "down". Every pointer type is captured; non-mouse ones go to toTouch.
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      if (e.pointerType !== 'mouse') return toTouch(e);
      this.mouseDown = true;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
      this.mouseButtons = e.buttons;
    }, { signal });

    const release = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') toTouch(e);
      else {
        this.mouseDown = false;
        this.mouseButtons = 0;
      }
      if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };
    canvas.addEventListener('pointerup', release, { signal });
    canvas.addEventListener('pointercancel', release, { signal });
    canvas.addEventListener('lostpointercapture', (e) => {
      if (e.pointerType !== 'mouse') return toTouch(e);
      this.mouseDown = false;
      this.mouseButtons = 0;
    }, { signal });

    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return toTouch(e);
      if (!this.mouseDown) return;

      const deltaX = e.clientX - this.lastMouseX;
      const deltaY = e.clientY - this.lastMouseY;

      if (this.mouseButtons & 1) { // Primary button - orbit
        this.orbit(deltaX * ORBIT_RAD_PER_PX, deltaY * ORBIT_RAD_PER_PX);
      }

      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
    }, { signal });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom(e.deltaY * 0.001);
    }, { passive: false, signal });

    // Mode switching with number keys — not while typing in a field
    document.addEventListener('keydown', (e) => {
      if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key >= '1' && e.key <= '4') {
        const modes: ViewMode[] = ['seg', 'heron', 'kelvin', 'solar'];
        const mode = modes[parseInt(e.key) - 1];
        onModeChange(mode);
      }
    }, { signal });

    // Keyboard orbit / zoom (accessibility) — arrow keys, +/- when not typing
    document.addEventListener('keydown', (e) => {
      if (isTypingTarget(e.target)) return;
      const step = e.shiftKey ? 0.04 : 0.02;
      if (e.key === 'ArrowLeft') { this.orbit(step, 0); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { this.orbit(-step, 0); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { this.orbit(0, -step); e.preventDefault(); }
      else if (e.key === 'ArrowDown') { this.orbit(0, step); e.preventDefault(); }
      else if (e.key === '+' || e.key === '=') { this.zoom(-1); e.preventDefault(); }
      else if (e.key === '-' || e.key === '_') { this.zoom(1); e.preventDefault(); }
    }, { signal });
  }

  /** Drop all input listeners. */
  disposeInteraction(): void {
    this._interactionAbort?.abort();
    this._interactionAbort = null;
  }

  orbit(deltaPhi: number, deltaTheta: number): void {
    const radius = Math.sqrt(
      this.camera.position[0] * this.camera.position[0] +
      this.camera.position[2] * this.camera.position[2]
    );

    let phi = Math.atan2(this.camera.position[2], this.camera.position[0]);
    let theta = Math.acos(Math.max(-1, Math.min(1, this.camera.position[1] / radius)));

    phi -= deltaPhi;
    theta = Math.max(0.1, Math.min(Math.PI - 0.1, theta + deltaTheta));

    this.camera.position[0] = radius * Math.sin(theta) * Math.cos(phi);
    this.camera.position[1] = radius * Math.cos(theta);
    this.camera.position[2] = radius * Math.sin(theta) * Math.sin(phi);
  }

  zoom(delta: number): void {
    const direction = [
      this.camera.target[0] - this.camera.position[0],
      this.camera.target[1] - this.camera.position[1],
      this.camera.target[2] - this.camera.position[2]
    ];

    const length = Math.sqrt(direction[0]*direction[0] + direction[1]*direction[1] + direction[2]*direction[2]);
    const normalized = direction.map(d => d / length);

    const zoomSpeed = length * 0.1;
    const zoomDelta = normalized.map(d => d * zoomSpeed * delta);

    this.camera.position[0] += zoomDelta[0];
    this.camera.position[1] += zoomDelta[1];
    this.camera.position[2] += zoomDelta[2];
  }

  getViewMatrix(): number[] {
    const eye = this.camera.position;
    const target = this.camera.target;
    const up = [0, 1, 0];

    const z = [
      eye[0] - target[0],
      eye[1] - target[1],
      eye[2] - target[2]
    ];
    let len = Math.sqrt(z[0]*z[0] + z[1]*z[1] + z[2]*z[2]);
    z[0] /= len; z[1] /= len; z[2] /= len;

    const x = [
      up[1]*z[2] - up[2]*z[1],
      up[2]*z[0] - up[0]*z[2],
      up[0]*z[1] - up[1]*z[0]
    ];
    len = Math.sqrt(x[0]*x[0] + x[1]*x[1] + x[2]*x[2]);
    x[0] /= len; x[1] /= len; x[2] /= len;

    const y = [
      z[1]*x[2] - z[2]*x[1],
      z[2]*x[0] - z[0]*x[2],
      z[0]*x[1] - z[1]*x[0]
    ];

    return [
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -(x[0]*eye[0] + x[1]*eye[1] + x[2]*eye[2]),
      -(y[0]*eye[0] + y[1]*eye[1] + y[2]*eye[2]),
      -(z[0]*eye[0] + z[1]*eye[1] + z[2]*eye[2]), 1
    ];
  }

  getProjectionMatrix(aspect: number): number[] {
    const fov = this.camera.fov * Math.PI / 180;
    const near = 0.1;
    const far = 1000;

    const f = 1 / Math.tan(fov / 2);
    const rangeInv = 1 / (near - far);

    return [
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, far * rangeInv, -1,
      0, 0, near * far * rangeInv, 0
    ];
  }
}
