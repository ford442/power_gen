/**
 * WebGL2 fallback multi-device visualizer.
 * Shares simulation state, camera, and device layout with the WebGPU path.
 *
 * Architecture mirror:
 *   WebGPUManager          → WebGL2Context
 *   DeviceInstance         → WebGL2DeviceState (CPU particles + physics)
 *   MultiDeviceVisualizer  → WebGL2MultiDeviceVisualizer (this file)
 *   compute.wgsl           → shared/particle-physics.js (CPU)
 */

import { CameraController } from '../../camera-controller.js';
import { MultiDeviceCamera } from '../../multi-device-camera.js';
import { SimRateController } from '../../sim-rate-controller.js';
import { DEVICE_CONFIG } from '../../debug-panel.js';
import { exposeRenderer, RENDERER_WEBGL2 } from '../renderer-selector.js';
import { stepParticles, seedParticles } from '../shared/particle-physics.js';
import {
  createDevicePhysicsState,
  stepDevicePhysics,
  deviceModeIndex,
  computeRollerPositions
} from '../shared/device-physics.js';
import { WebGL2Context } from './webgl2-context.js';
import { SkyGridRenderer } from './sky-grid-renderer.js';
import { MeshRenderer } from './mesh-renderer.js';
import { ParticleRenderer } from './particle-renderer.js';
import { WebGL2DebugControls } from './debug-controls.js';

class WebGL2DeviceState {
  constructor(id, config) {
    this.id = id;
    this.config = config;
    this.particleCount = config.particleCount || 10000;
    this.particles = new Float32Array(this.particleCount * 8);
    this.physics = createDevicePhysicsState(id);
    seedParticles(this.particles, id, this.particleCount);
  }
}

export class WebGL2MultiDeviceVisualizer {
  constructor() {
    console.log('WebGL2MultiDeviceVisualizer starting (debug fallback path)');
    this.canvas = document.getElementById('gpuCanvas');
    this.ctx = new WebGL2Context(this.canvas);
    this.camera = new CameraController();
    this.simRateController = new SimRateController();
    this.debug = new WebGL2DebugControls();

    this.devices = {};
    this.devicesEnabled = { seg: true, heron: true, kelvin: true, solar: true, peltier: true, mhd: true };
    this.currentView = 'overview';
    this.time = 0;
    this.simClock = 0;
    this.lastFrameTime = 0;
    this.fps = 60;
    this.speedMult = 1.0;

    exposeRenderer(this.canvas, RENDERER_WEBGL2);
    this._exposeScreenshotHooks();

    this.init();
  }

  _exposeScreenshotHooks() {
    /** Playwright / agent pixel comparison hook */
    window.captureCanvasFrame = () => {
      const gl = this.ctx.gl;
      const w = this.canvas.width;
      const h = this.canvas.height;
      const pixels = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return { width: w, height: h, pixels };
    };
    window.getRendererInfo = () => ({
      renderer: RENDERER_WEBGL2,
      fps: this.fps,
      particleCount: Object.values(this.devices).reduce((s, d) => s + d.particleCount, 0),
      debug: { ...this.debug }
    });
  }

  async init() {
    try {
      const gl = this.ctx.init();
      this.skyGrid = new SkyGridRenderer(gl);
      this.meshRenderer = new MeshRenderer(gl);
      this.particleRenderer = new ParticleRenderer(gl);
      this.cameraController = new MultiDeviceCamera(this.canvas, this.camera, this);
      this.camera.setupInteraction(this.canvas, (mode) => this.switchMode(mode));

      for (const [id, config] of Object.entries(DEVICE_CONFIG)) {
        this.devices[id] = new WebGL2DeviceState(id, config);
      }

      this.render(0);
      window.addEventListener('resize', () => this.ctx.resize());
      console.log('[webgl2] Ready. Keys: W=wireframe P=particle debug N=normals Space=pause .=step [/]=slow-mo');
    } catch (e) {
      console.error(e);
      alert('WebGL2 init failed: ' + e.message);
    }
  }

  switchMode(mode) {
    this.currentView = mode;
    const el = document.getElementById('currentView');
    if (el) el.textContent = mode.toUpperCase();
    this.cameraController.focusOnDevice(mode);
  }

  render(timestamp) {
    const rawDelta = (timestamp - this.lastFrameTime) / 1000;
    this.lastFrameTime = timestamp;
    const deltaTime = this.debug.effectiveDelta(rawDelta || 0.016);

    if (timestamp % 500 < 20 && deltaTime > 0) {
      this.fps = Math.round(1 / (deltaTime || 0.016));
      const fpsEl = document.getElementById('fps');
      if (fpsEl) fpsEl.textContent = this.fps;
    }

    const rawSpeed = parseFloat(document.getElementById('speedControl')?.value) ?? 50;
    const speed = 0.05 * Math.pow(400, rawSpeed / 100);
    this.speedMult = speed;
    this.simRateController.tick(deltaTime, speed);
    this.time += deltaTime * speed;
    this.simClock += deltaTime;

    const speedValEl = document.getElementById('speedVal');
    if (speedValEl) speedValEl.textContent = speed.toFixed(2) + '×';

    this.cameraController.updateCamera(deltaTime);
    const viewProj = this.cameraController.getViewProjMatrix();
    const cameraPos = this.camera.camera.position;

    const drive = rawSpeed / 100;
    const qualityScale = 1.0;
    const substeps = this.simRateController.substeps || 1;
    const subDt = deltaTime / Math.max(substeps, 1);

    for (const device of Object.values(this.devices)) {
      if (!this.devicesEnabled[device.id]) continue;
      for (let s = 0; s < substeps; s++) {
        stepDevicePhysics(device.physics, subDt, drive);
        const mode = deviceModeIndex(device.id);
        const scaledCount = Math.floor(device.particleCount * qualityScale);
        stepParticles(device.particles, {
          time: this.time,
          mode,
          particleCount: scaledCount,
          dt: subDt,
          segOmega: device.physics.segOmega,
          heronVExit: device.physics.heronVExit,
          kelvinE: device.physics.kelvinE,
          kelvinVoltageN: device.physics.kelvinVoltageN,
          solarN2: device.physics.solarN2,
          corona: device.physics.corona,
          simClock: this.simClock,
          speedMult: speed
        });
      }
    }

    const gl = this.ctx.gl;
    this.ctx.resize();
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    this.skyGrid.drawSky(this.time);
    this.skyGrid.drawGrid(viewProj, cameraPos);

    const renderOpts = {
      wireframe: this.debug.wireframe,
      debugMode: this.debug.debugMode,
      cameraPos,
      corona: this.devices.seg?.physics.corona || 0
    };

    for (const device of Object.values(this.devices)) {
      if (!this.devicesEnabled[device.id]) continue;
      const pos = device.config.position;
      const tint = device.config.color || [0.5, 0.8, 1.0];
      const mode = deviceModeIndex(device.id);
      const scaledCount = Math.floor(device.particleCount * qualityScale);

      if (device.id === 'seg') {
        const rollers = computeRollerPositions(this.time, speed);
        this.meshRenderer.drawSimpleBase(viewProj, pos, [0.08, 0.08, 0.12], renderOpts);
        this.meshRenderer.drawStatorRings(viewProj, pos, renderOpts);
        this.meshRenderer.drawRollers(viewProj, pos, rollers, this.time, {
          ...renderOpts,
          corona: device.physics.corona
        });
      }

      this.particleRenderer.draw(
        device.particles,
        scaledCount,
        viewProj,
        pos,
        mode,
        tint,
        {
          debugParticles: this.debug.debugParticles,
          battery: device.physics.batteryCharge,
          particleScale: this.debug.particleScale
        }
      );
    }

    // Solar battery UI
    const batteryEl = document.getElementById('batteryCharge');
    const batteryStat = document.getElementById('batteryStat');
    if (batteryEl && batteryStat && this.devices.solar) {
      batteryEl.textContent = `${Math.round(this.devices.solar.physics.batteryCharge * 100)}%`;
      batteryStat.style.display = this.currentView === 'solar' ? 'flex' : 'none';
    }

    requestAnimationFrame((t) => this.render(t));
  }
}
