export class CameraController {
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

  setupInteraction(canvas, onModeChange) {
    canvas.addEventListener('mousedown', (e) => {
      this.mouseDown = true;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
      this.mouseButtons = e.buttons;
    });

    canvas.addEventListener('mouseup', () => {
      this.mouseDown = false;
      this.mouseButtons = 0;
    });

    canvas.addEventListener('mousemove', (e) => {
      if (!this.mouseDown) return;

      const deltaX = e.clientX - this.lastMouseX;
      const deltaY = e.clientY - this.lastMouseY;

      if (this.mouseButtons & 1) { // Left button - orbit
        this.orbit(deltaX * 0.01, deltaY * 0.01);
      }

      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom(e.deltaY * 0.001);
    });

    // Mode switching with number keys
    document.addEventListener('keydown', (e) => {
      if (e.key >= '1' && e.key <= '4') {
        const modes = ['seg', 'heron', 'kelvin', 'solar'];
        const mode = modes[parseInt(e.key) - 1];
        onModeChange(mode);
      }
    });
  }

  orbit(deltaPhi, deltaTheta) {
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

  zoom(delta) {
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

  getViewMatrix() {
    const eye = this.camera.position;
    const target = this.camera.target;
    const up = [0, 1, 0];

    const z = [
      eye[0] - target[0],
      eye[1] - target[1],
      eye[2] - target[2]
    ];
    const len = Math.sqrt(z[0]*z[0] + z[1]*z[1] + z[2]*z[2]);
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

  getProjectionMatrix(aspect) {
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