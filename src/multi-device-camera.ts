/**
 * MultiDeviceCamera - Extracted camera and interaction logic
 * Manages orbital camera controls, device focus transitions, and view animations.
 * Depends on: canvas, camera state, visualizer instance (for devicesEnabled, debugPanel, currentView)
 */
import { getMergedDeviceConfig } from './devices/device-registry';
import type { CameraState } from './camera-controller';

export interface CameraVisualizerHost {
  currentView: string;
}

export class MultiDeviceCamera {
  canvas: HTMLCanvasElement;
  camera: CameraState;
  visualizer: CameraVisualizerHost;

  constructor(canvas: HTMLCanvasElement, camera: CameraState, visualizer: CameraVisualizerHost) {
    this.canvas = canvas;
    this.camera = camera;
    this.visualizer = visualizer;
  }

  /** @deprecated Use focusOnDevice — kept for older call sites */
  focusDevice(deviceId: string): void {
    return this.focusOnDevice(deviceId);
  }

  focusOnDevice(deviceId: string): void {
    const config = getMergedDeviceConfig()[deviceId];
    if (!config) return;

    this.visualizer.currentView = deviceId;
    const viewEl = document.getElementById('currentView');
    if (viewEl) viewEl.textContent = deviceId.toUpperCase();

    const devicePos = config.position;
    const offset = config.cameraOffset;
    if (!devicePos || !offset) return;
    const rotY = config.rotation?.[1] ?? 0;
    const cosY = Math.cos(rotY);
    const sinY = Math.sin(rotY);
    const rotatedOffset = [offset[0] * cosY - offset[2] * sinY, offset[1], offset[0] * sinY + offset[2] * cosY];
    const endPos = [devicePos[0] + rotatedOffset[0], devicePos[1] + rotatedOffset[1], devicePos[2] + rotatedOffset[2]];

    this.startCameraTransition(endPos, devicePos);
  }

  showOverview(): void {
    this.visualizer.currentView = 'overview';
    const viewEl = document.getElementById('currentView');
    if (viewEl) viewEl.textContent = 'Overview';
    this.startCameraTransition([0, 8, 18], [0, 0, 0]);
  }

  startCameraTransition(endPos: number[], endTarget: number[]): void {
    this.camera.transitionActive = true;
    this.camera.transitionStart = performance.now() / 1000;
    this.camera.startPos = [...this.camera.position];
    this.camera.startTarget = [...this.camera.target];
    this.camera.endPos = endPos;
    this.camera.endTarget = endTarget;
  }

  updateCamera(deltaTime: number): void {
    if (!this.camera.transitionActive) return;
    if (!this.camera.transitionStart || !this.camera.startPos || !this.camera.startTarget || !this.camera.endPos || !this.camera.endTarget) return;

    const now = performance.now() / 1000;
    const elapsed = now - this.camera.transitionStart;
    const t = Math.min(elapsed / this.camera.transitionDuration, 1.0);
    const easeT = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

    this.camera.position[0] = this.lerp(this.camera.startPos[0], this.camera.endPos[0], easeT);
    this.camera.position[1] = this.lerp(this.camera.startPos[1], this.camera.endPos[1], easeT);
    this.camera.position[2] = this.lerp(this.camera.startPos[2], this.camera.endPos[2], easeT);
    this.camera.target[0] = this.lerp(this.camera.startTarget[0], this.camera.endTarget[0], easeT);
    this.camera.target[1] = this.lerp(this.camera.startTarget[1], this.camera.endTarget[1], easeT);
    this.camera.target[2] = this.lerp(this.camera.startTarget[2], this.camera.endTarget[2], easeT);

    if (t >= 1.0) this.camera.transitionActive = false;
  }

  lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

  // Per-frame scratch (these run several times a frame: cull, globals, TAA,
  // SSR). The getters below return these arrays — copy to keep one past the
  // next call. Every caller today consumes or copies the result at once.
  private readonly _proj = new Float32Array(16);
  private readonly _view = new Float32Array(16);
  private readonly _viewProj = new Float32Array(16);
  private readonly _inv = new Float32Array(16);

  /** View-projection (camera-owned scratch — copy to keep). */
  getViewProjMatrix(): Float32Array {
    return this.multiplyMatrices(this.getProjMatrix(), this.getViewMatrix(), this._viewProj);
  }

  /** Projection alone — screen-space passes (SSR) need it without the view. Scratch — copy to keep. */
  getProjMatrix(): Float32Array {
    const aspect = this.canvas.width / Math.max(this.canvas.height, 1);
    return this.perspectiveMatrix(this.camera.fov * Math.PI / 180, aspect, 0.1, 200, this._proj);
  }

  /** View matrix (scratch — copy to keep). */
  getViewMatrix(): Float32Array {
    return this.lookAt(this.camera.position, this.camera.target, [0, 1, 0], this._view);
  }

  /**
   * General 4×4 inverse (column-major, same convention as the matrices above).
   * SSR unprojects depth samples with `inverse(proj)`. Writes `out` (default:
   * camera-owned scratch — copy to keep); `out` must not alias `m`.
   */
  invertMatrix(m: Float32Array | number[], out: Float32Array = this._inv): Float32Array {
    const inv = out;
    inv[0]  =  m[5]*m[10]*m[15] - m[5]*m[11]*m[14] - m[9]*m[6]*m[15] + m[9]*m[7]*m[14] + m[13]*m[6]*m[11] - m[13]*m[7]*m[10];
    inv[4]  = -m[4]*m[10]*m[15] + m[4]*m[11]*m[14] + m[8]*m[6]*m[15] - m[8]*m[7]*m[14] - m[12]*m[6]*m[11] + m[12]*m[7]*m[10];
    inv[8]  =  m[4]*m[9]*m[15]  - m[4]*m[11]*m[13] - m[8]*m[5]*m[15] + m[8]*m[7]*m[13] + m[12]*m[5]*m[11] - m[12]*m[7]*m[9];
    inv[12] = -m[4]*m[9]*m[14]  + m[4]*m[10]*m[13] + m[8]*m[5]*m[14] - m[8]*m[6]*m[13] - m[12]*m[5]*m[10] + m[12]*m[6]*m[9];
    inv[1]  = -m[1]*m[10]*m[15] + m[1]*m[11]*m[14] + m[9]*m[2]*m[15] - m[9]*m[3]*m[14] - m[13]*m[2]*m[11] + m[13]*m[3]*m[10];
    inv[5]  =  m[0]*m[10]*m[15] - m[0]*m[11]*m[14] - m[8]*m[2]*m[15] + m[8]*m[3]*m[14] + m[12]*m[2]*m[11] - m[12]*m[3]*m[10];
    inv[9]  = -m[0]*m[9]*m[15]  + m[0]*m[11]*m[13] + m[8]*m[1]*m[15] - m[8]*m[3]*m[13] - m[12]*m[1]*m[11] + m[12]*m[3]*m[9];
    inv[13] =  m[0]*m[9]*m[14]  - m[0]*m[10]*m[13] - m[8]*m[1]*m[14] + m[8]*m[2]*m[13] + m[12]*m[1]*m[10] - m[12]*m[2]*m[9];
    inv[2]  =  m[1]*m[6]*m[15]  - m[1]*m[7]*m[14]  - m[5]*m[2]*m[15] + m[5]*m[3]*m[14] + m[13]*m[2]*m[7]  - m[13]*m[3]*m[6];
    inv[6]  = -m[0]*m[6]*m[15]  + m[0]*m[7]*m[14]  + m[4]*m[2]*m[15] - m[4]*m[3]*m[14] - m[12]*m[2]*m[7]  + m[12]*m[3]*m[6];
    inv[10] =  m[0]*m[5]*m[15]  - m[0]*m[7]*m[13]  - m[4]*m[1]*m[15] + m[4]*m[3]*m[13] + m[12]*m[1]*m[7]  - m[12]*m[3]*m[5];
    inv[14] = -m[0]*m[5]*m[14]  + m[0]*m[6]*m[13]  + m[4]*m[1]*m[14] - m[4]*m[2]*m[13] - m[12]*m[1]*m[6]  + m[12]*m[2]*m[5];
    inv[3]  = -m[1]*m[6]*m[11]  + m[1]*m[7]*m[10]  + m[5]*m[2]*m[11] - m[5]*m[3]*m[10] - m[9]*m[2]*m[7]   + m[9]*m[3]*m[6];
    inv[7]  =  m[0]*m[6]*m[11]  - m[0]*m[7]*m[10]  - m[4]*m[2]*m[11] + m[4]*m[3]*m[10] + m[8]*m[2]*m[7]   - m[8]*m[3]*m[6];
    inv[11] = -m[0]*m[5]*m[11]  + m[0]*m[7]*m[9]   + m[4]*m[1]*m[11] - m[4]*m[3]*m[9]  - m[8]*m[1]*m[7]   + m[8]*m[3]*m[5];
    inv[15] =  m[0]*m[5]*m[10]  - m[0]*m[6]*m[9]   - m[4]*m[1]*m[10] + m[4]*m[2]*m[9]  + m[8]*m[1]*m[6]   - m[8]*m[2]*m[5];

    const det = m[0]*inv[0] + m[1]*inv[4] + m[2]*inv[8] + m[3]*inv[12];
    if (!det) {
      inv.fill(0);
      inv[0] = inv[5] = inv[10] = inv[15] = 1;
      return inv;
    }
    const d = 1.0 / det;
    for (let i = 0; i < 16; i++) inv[i] *= d;
    return inv;
  }

  perspectiveMatrix(fov: number, aspect: number, near: number, far: number, out = new Float32Array(16)): Float32Array {
    const f = 1.0 / Math.tan(fov / 2);
    const nf = 1 / (near - far);
    out.fill(0);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = (far + near) * nf;
    out[11] = -1;
    out[14] = 2 * far * near * nf;
    return out;
  }

  lookAt(eye: number[], center: number[], up: number[], out = new Float32Array(16)): Float32Array {
    const z = this.normalize([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]);
    const x = this.normalize(this.cross(up, z));
    const y = this.cross(z, x);
    out[0] = x[0]; out[1] = y[0]; out[2] = z[0]; out[3] = 0;
    out[4] = x[1]; out[5] = y[1]; out[6] = z[1]; out[7] = 0;
    out[8] = x[2]; out[9] = y[2]; out[10] = z[2]; out[11] = 0;
    out[12] = -this.dot(x, eye); out[13] = -this.dot(y, eye); out[14] = -this.dot(z, eye); out[15] = 1;
    return out;
  }

  normalize(v: number[]): number[] { const len = Math.sqrt(v[0]**2 + v[1]**2 + v[2]**2); return len > 0 ? [v[0]/len, v[1]/len, v[2]/len] : [0, 0, 0]; }
  cross(a: number[], b: number[]): number[] { return [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]]; }
  dot(a: number[], b: number[]): number { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
  /** a × b into `out` (default: a new array); `out` must not alias `a` or `b`. */
  multiplyMatrices(a: Float32Array, b: Float32Array, out = new Float32Array(16)): Float32Array {
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          sum += a[k * 4 + row] * b[col * 4 + k];
        }
        out[col * 4 + row] = sum;
      }
    }
    return out;
  }
}
