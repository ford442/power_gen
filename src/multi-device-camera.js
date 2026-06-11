/**
 * MultiDeviceCamera - Extracted camera and interaction logic
 * Manages orbital camera controls, device focus transitions, and view animations.
 * Depends on: canvas, camera state, visualizer instance (for devicesEnabled, debugPanel, currentView)
 */
import { DEVICE_CONFIG } from './debug-panel.js';

export class MultiDeviceCamera {
  constructor(canvas, camera, visualizer) {
    this.canvas = canvas;
    this.camera = camera;
    this.visualizer = visualizer;
  }

  /** @deprecated Use focusOnDevice — kept for older call sites */
  focusDevice(deviceId) {
    return this.focusOnDevice(deviceId);
  }

  focusOnDevice(deviceId) {
    const config = DEVICE_CONFIG[deviceId];
    if (!config) return;
    
    this.visualizer.currentView = deviceId;
    document.getElementById('currentView').textContent = deviceId.toUpperCase();
    
    const devicePos = config.position;
    const offset = config.cameraOffset;
    const rotY = config.rotation[1];
    const cosY = Math.cos(rotY);
    const sinY = Math.sin(rotY);
    const rotatedOffset = [offset[0] * cosY - offset[2] * sinY, offset[1], offset[0] * sinY + offset[2] * cosY];
    const endPos = [devicePos[0] + rotatedOffset[0], devicePos[1] + rotatedOffset[1], devicePos[2] + rotatedOffset[2]];
    
    this.startCameraTransition(endPos, devicePos);
  }
  
  showOverview() {
    this.visualizer.currentView = 'overview';
    document.getElementById('currentView').textContent = 'Overview';
    this.startCameraTransition([0, 8, 18], [0, 0, 0]);
  }
  
  startCameraTransition(endPos, endTarget) {
    this.camera.transitionActive = true;
    this.camera.transitionStart = performance.now() / 1000;
    this.camera.startPos = [...this.camera.position];
    this.camera.startTarget = [...this.camera.target];
    this.camera.endPos = endPos;
    this.camera.endTarget = endTarget;
  }
  
  updateCamera(deltaTime) {
    if (!this.camera.transitionActive) return;
    
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
  
  lerp(a, b, t) { return a + (b - a) * t; }
  
  getViewProjMatrix() {
    const aspect = this.canvas.width / this.canvas.height;
    const proj = this.perspectiveMatrix(this.camera.fov * Math.PI / 180, aspect, 0.1, 200);
    const view = this.lookAt(this.camera.position, this.camera.target, [0, 1, 0]);
    return this.multiplyMatrices(proj, view);
  }
  
  perspectiveMatrix(fov, aspect, near, far) {
    const f = 1.0 / Math.tan(fov / 2);
    const nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  }
  
  lookAt(eye, center, up) {
    const z = this.normalize([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]);
    const x = this.normalize(this.cross(up, z));
    const y = this.cross(z, x);
    return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -this.dot(x, eye), -this.dot(y, eye), -this.dot(z, eye), 1]);
  }
  
  normalize(v) { const len = Math.sqrt(v[0]**2 + v[1]**2 + v[2]**2); return len > 0 ? [v[0]/len, v[1]/len, v[2]/len] : [0, 0, 0]; }
  cross(a, b) { return [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]]; }
  dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
  multiplyMatrices(a, b) {
    const out = new Float32Array(16);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let sum = 0; for (let k = 0; k < 4; k++) sum += a[i*4+k] * b[k*4+j]; out[i*4+j] = sum; }
    return out;
  }
}
