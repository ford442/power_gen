/**
 * Draw-side mixin for WebGL2MultiDeviceVisualizer: per-frame physics/particle
 * stepping (_stepSimulation) and the WebGL2 draw calls (render).
 *
 * Split out of index.js (orchestrator vs draw) to keep that file under the
 * repo's 700-line cap. Stays plain JS per ADR-0001 (WebGL2/GLSL rescue path
 * is intentionally not TypeScript). Mixed onto the prototype in index.js via
 * Object.assign(WebGL2MultiDeviceVisualizer.prototype, renderMethods) so
 * normal `this` binding at call time works automatically.
 */

import { buildMagLevMesh } from '../../devices/quanta/magnetic-levitation';
import { buildHomopolarMesh } from '../../devices/quanta/homopolar-generator';
import { buildHalbachVizMesh, halbachConfigFromState } from '../../devices/quanta/halbach-viz';
import { buildPulseCoilMesh } from '../../devices/quanta/pulse-coil';
import { buildTransformerMesh } from '../../devices/quanta/transformer';
import { buildVdgMesh, VDG_V_BREAK } from '../../devices/quanta/van-de-graaff';
import { buildHallMesh } from '../../devices/quanta/hall-effect';
import { buildLorentzSledMesh, LORENTZ } from '../../devices/quanta/lorentz-sled';
import { buildJumpingRingMesh, RING } from '../../devices/quanta/jumping-ring';
import { buildPeltierMesh } from '../../devices/core/peltier-mesh';
import { buildMhdMesh } from '../../devices/core/mhd-mesh';
import { stepParticles } from '../shared/particle-physics';
import { stepDevicePhysics, deviceModeIndex } from '../shared/device-physics';
import { shouldSimulateDevice } from '../shared/device-view';
import {
  getOverviewCullOpts,
  getViewParticleLod,
  getViewMeshLod,
  getMeshDrawDetail,
  getDeviceParticleScale
} from '../shared/view-lod';
import { resolveScaledParticleCount } from '../../devices/particle-budgets';
import { segLayoutRingsForDraw } from '../shared/url-params';
import { segOperator } from '../../seg-operator-state';
import { wasmOwnsJsDevicePhysics } from '../../session/apply-wasm-plant';

/** Build flat [x,z,...] roller positions from SEG layout + spin. */
function layoutRollerPositions(layout, time, speedMult, segOmega) {
  if (!layout?.rings?.length) return new Float32Array(0);
  const total = layout.totalRollers || 0;
  const out = new Float32Array(total * 2);
  let offset = 0;
  const spin = Math.max(0.05, segOmega || 0) * speedMult;
  for (const ring of layout.rings) {
    const R = ring.orbitRadiusM * layout.worldScale;
    const n = ring.count;
    const speed = (ring.speed ?? 1) * spin * 0.5;
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2 + time * speed + (ring.index ?? 0) * 0.22;
      out[offset * 2] = Math.cos(angle) * R;
      out[offset * 2 + 1] = Math.sin(angle) * R;
      offset++;
    }
  }
  return out;
}

export const renderMethods = {
  /**
   * Physics step: LabSession plant + CPU device/particle visuals.
   */
  _stepSimulation(deltaTime, speed) {
    const { simSteps, replayLocked, useWasm, drive } = this.session.stepPlant(deltaTime, speed, {
      qualityLevel: this.profiler?.qualityLevel,
      frameTimeMs: this.profiler?.lastFrameTimeMs,
      gpuTimeMs: this.profiler?.lastGpuTimeMs
    });
    const focus = this.session.plantFocus();

    const substeps = simSteps.length || 1;
    const subDt = deltaTime / Math.max(substeps, 1);
    let totalParticles = 0;
    const canvasAspect = (this.canvas.width || 1) / Math.max(1, this.canvas.height || 1);
    const cullCamera = this.camera?.camera;
    const cullOpts = getOverviewCullOpts({ aspect: canvasAspect });
    const qualityTier = this.profiler?.qualityTier || 'high';

    for (const device of Object.values(this.devices)) {
      if (!shouldSimulateDevice(
        this.currentView,
        this.devicesEnabled,
        device.id,
        device.config?.position,
        cullCamera,
        cullOpts
      )) continue;

      if (device.id === 'seg') {
        device.physics.segOmega = segOperator.physics.segOmega;
        device.physics.corona = segOperator.physics.corona;
        device.physics.magneticFieldStrength = segOperator.magneticFieldStrength;
        device.physics.energyLevel = segOperator.physics.segOmega;
      } else {
        const wasmOwnsFocus = wasmOwnsJsDevicePhysics(
          device.id, focus, useWasm, device.physics
        );
        if (!wasmOwnsFocus && !replayLocked) {
          for (let s = 0; s < substeps; s++) {
            const heronLayout = device.id === 'heron' ? this.heronLayout : null;
            stepDevicePhysics(device.physics, subDt, drive, { heronLayout });
          }
        }
        if (device.physics._wasmPlantActive) device.physics._wasmPlantActive = false;
      }

      for (let s = 0; s < substeps; s++) {
        const mode = deviceModeIndex(device.id);
        const viewLod = getViewParticleLod(this.currentView, device.id);
        const scaledCount = Math.max(
          64,
          resolveScaledParticleCount({
            deviceId: device.id,
            baseCount: device.particleCount,
            qualityLevel: this.profiler?.qualityLevel ?? 1,
            qualityTier,
            viewLod,
            isPlugin: !!device.config?.plugin
          }) || Math.floor(
            device.particleCount * getDeviceParticleScale({
              currentView: this.currentView,
              deviceId: device.id,
              qualityLevel: this.profiler?.qualityLevel ?? 1
            })
          )
        );
        device.scaledParticleCount = scaledCount;
        totalParticles += scaledCount;
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
          maglevGap: device.physics.maglevGap,
          maglevFieldT: device.physics.maglevFieldT,
          homopolarRpm: device.physics.homopolarRpm,
          homopolarEmfV: device.physics.homopolarEmfV,
          homopolarAngle: device.physics.homopolarAngle,
          halbachSegmentCount: device.physics.halbachSegmentCount,
          halbachPeakBT: device.physics.halbachPeakBT,
          pulseCoilCurrentA: device.physics.pulseCoilCurrentA,
          pulseCoilBPeakT: device.physics.pulseCoilBPeakT,
          pulseCoilArmatureM: device.physics.pulseCoilArmatureM,
          peltierDeltaT: device.physics.peltierDeltaT,
          peltierCOP: device.physics.peltierCOP,
          mhdFlowU: device.physics.mhdFlowU,
          mhdBFieldT: device.physics.mhdBFieldT,
          transformerIpA: device.physics.transformerIpA,
          transformerIsA: device.physics.transformerIsA,
          transformerFluxN: device.physics.transformerFluxN,
          vdgVoltage: device.physics.vdgVoltage,
          vdgSparkHz: device.physics.vdgSparkHz,
          hallCurrent: device.physics.hallCurrent,
          hallFieldT: device.physics.hallFieldT,
          lorentzSledVms: device.physics.lorentzSledVms,
          lorentzCurrentA: device.physics.lorentzCurrentA,
          lorentzFieldT: device.physics.lorentzFieldT,
          lorentzPositionM: device.physics.lorentzPositionM,
          ringHeightM: device.physics.ringHeightM,
          ringCurrentA: device.physics.ringCurrentA,
          ringCouplingK: device.physics.ringCouplingK,
          simClock: this.simClock,
          speedMult: speed
        });
      }
    }

    return totalParticles;
  },

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

    this.time += deltaTime * speed;
    this.simClock += deltaTime;

    const totalParticles = this._stepSimulation(deltaTime, speed);

    this._updateHardwareTwin(deltaTime);

    const speedValEl = document.getElementById('speedVal');
    if (speedValEl) speedValEl.textContent = speed.toFixed(2) + '×';

    this.cameraController.updateCamera(deltaTime);
    const viewProj = this.cameraController.getViewProjMatrix();
    const cameraPos = this.camera.camera.position;

    this.session.publishFrame(deltaTime, totalParticles);

    const gl = this.ctx.gl;
    this.ctx.resize();
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    this.skyGrid.drawSky(this.time, this.lightingPreset?.sky?.mode ?? 1);
    this.skyGrid.drawGrid(viewProj, cameraPos);

    const renderOpts = {
      wireframe: this.debug.wireframe,
      debugMode: this.debug.debugMode,
      cameraPos,
      corona: this.devices.seg?.physics.corona || 0
    };

    const canvasAspect = (this.canvas.width || 1) / Math.max(1, this.canvas.height || 1);
    const cullCamera = this.camera?.camera;
    const cullOpts = getOverviewCullOpts({ aspect: canvasAspect });
    const meshDetail = getMeshDrawDetail(
      getViewMeshLod(this.currentView, this.profiler?.qualityLevel ?? 1)
    );
    this._overviewMeshDetail = meshDetail;

    for (const device of Object.values(this.devices)) {
      if (!shouldSimulateDevice(
        this.currentView,
        this.devicesEnabled,
        device.id,
        device.config?.position,
        cullCamera,
        cullOpts
      )) continue;
      const pos = device.config.position;
      const tint = device.config.color || [0.5, 0.8, 1.0];
      const mode = deviceModeIndex(device.id);
      const scaledCount = device.scaledParticleCount || device.particleCount;

if (device.id === 'seg') {
  const rollers = layoutRollerPositions(
    this.segLayout,
    this.time,
    speed,
    this.segOmega
  );
  this.meshRenderer.drawSegStructure(viewProj, pos, {
    ...renderOpts,
    frameLevel: this.segFrameLevel,
    layout: this.segLayout
  });
  this.meshRenderer.drawStatorRings(viewProj, pos, renderOpts);
  this.meshRenderer.drawRollers(viewProj, pos, rollers, this.time, {
    ...renderOpts,
    corona: device.physics.corona,
    prototypePreset: this.prototypePreset,
    rings: segLayoutRingsForDraw(this.segLayout)
  });
} else if (meshDetail !== 'skip') {
  // Overview mesh LOD: skip barely-visible plugin meshes when quality is critical.
  const drawMeshes = meshDetail !== 'proxy' || this.currentView === device.id;

  if (drawMeshes && (device.id === 'heron' || device.id === 'kelvin' || device.id === 'solar')) {
    this.meshRenderer.drawAlternateDevice(viewProj, pos, device.id, {
      ...renderOpts,
      heronLayoutPreset: device.id === 'heron' ? this.heronLayoutPreset : undefined
    });
  } else if (drawMeshes && device.id === 'peltier') {
    this.meshRenderer.drawPluginDevice(
      viewProj,
      pos,
      buildPeltierMesh(
        device.physics.peltierHotK,
        device.physics.peltierColdK,
        device.physics.peltierDeltaT
      ).cylinders(),
      renderOpts
    );
  } else if (drawMeshes && device.id === 'mhd') {
    this.meshRenderer.drawPluginDevice(
      viewProj,
      pos,
      buildMhdMesh(
        device.physics.mhdFlowU,
        device.physics.mhdBFieldT,
        device.physics.mhdHartmann
      ).cylinders(),
      renderOpts
    );
  } else if (drawMeshes && device.id === 'maglev') {
    const gap = device.physics.maglevGap ?? 0.018;
    this.meshRenderer.drawPluginDevice(
      viewProj, pos, buildMagLevMesh(gap).cylinders(), renderOpts
    );
  } else if (drawMeshes && device.id === 'homopolar') {
    const angle = device.physics.homopolarAngle ?? 0;
    this.meshRenderer.drawPluginDevice(
      viewProj, pos, buildHomopolarMesh(angle).cylinders(), renderOpts
    );
  } else if (drawMeshes && device.id === 'halbach-viz') {
    const config = halbachConfigFromState(device.physics);
    this.meshRenderer.drawPluginDevice(
      viewProj, pos, buildHalbachVizMesh(config).cylinders(), renderOpts
    );
  } else if (drawMeshes && device.id === 'pulse-coil') {
    const travel = device.physics.pulseCoilArmatureM ?? 0;
    const iA = device.physics.pulseCoilCurrentA ?? 0;
    const vCap = device.physics.pulseCoilVCap ?? 0;
    this.meshRenderer.drawPluginDevice(
      viewProj, pos, buildPulseCoilMesh(travel, iA, vCap).cylinders(), renderOpts
    );
  } else if (drawMeshes && device.id === 'transformer') {
    this.meshRenderer.drawPluginDevice(
      viewProj,
      pos,
      buildTransformerMesh(
        device.physics.transformerIpA,
        device.physics.transformerIsA,
        device.physics.transformerFluxN
      ).cylinders(),
      renderOpts
    );
  } else if (drawMeshes && device.id === 'vdg') {
    const chargeNorm = Math.min(1, (device.physics.vdgVoltage ?? 0) / VDG_V_BREAK);
    const sparkGlow = (device.physics.vdgSparkHz ?? 0) > 0 ? 1 : 0;
    this.meshRenderer.drawPluginDevice(
      viewProj, pos, buildVdgMesh(chargeNorm, sparkGlow).cylinders(), renderOpts
    );
  } else if (drawMeshes && device.id === 'hall') {
    const currentNorm = Math.min(1, (device.physics.hallCurrent ?? 0) / 1.2);
    const fieldNorm = Math.min(1, (device.physics.hallFieldT ?? 0) / 0.65);
    this.meshRenderer.drawPluginDevice(
      viewProj, pos, buildHallMesh(currentNorm, fieldNorm).cylinders(), renderOpts
    );
  } else if (drawMeshes && device.id === 'lorentz-sled') {
    const posNorm = ((device.physics.lorentzPositionM ?? 0) % LORENTZ.railLengthM) / LORENTZ.railLengthM;
    const currentNorm = Math.min(1, Math.abs(device.physics.lorentzCurrentA ?? 0) / LORENTZ.iMaxA);
    const fieldNorm = Math.min(1, (device.physics.lorentzFieldT ?? 0) / LORENTZ.fieldTMax);
    this.meshRenderer.drawPluginDevice(
      viewProj, pos, buildLorentzSledMesh(posNorm, currentNorm, fieldNorm).cylinders(), renderOpts
    );
  } else if (drawMeshes && device.id === 'jumping-ring') {
    const heightNorm = Math.min(1, (device.physics.ringHeightM ?? 0) / RING.poleHeightM);
    const ringNorm = Math.min(1, Math.abs(device.physics.ringCurrentA ?? 0) / RING.iRingMaxA);
    const primaryNorm = Math.min(1, Math.abs(device.physics.ringPrimaryIA ?? 0) / RING.iPrimaryMaxA);
    const kNorm = Math.min(1, (device.physics.ringCouplingK ?? RING.couplingK0) / RING.couplingK0);
    this.meshRenderer.drawPluginDevice(
      viewProj, pos, buildJumpingRingMesh(heightNorm, ringNorm, primaryNorm, kNorm).cylinders(), renderOpts
    );
  }

  if (this.currentView === 'halbach-viz' && device.id === 'halbach-viz' && this.halbachFieldRenderer) {
    this.halbachFieldRenderer.draw(
      viewProj,
      pos,
      device.physics.halbachFieldLines,
      device.physics.halbachHeatmap,
      { extent: 3.1, gridSize: 24 }
    );
  }
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

    // Overview energy pipes (line-strip Bézier arcs)
    if (this.isOverviewMode() && this.energyPipeRenderer) {
      this.energyPipeRenderer.draw(viewProj, this.devices, this.time, {
        devicesEnabled: this.devicesEnabled
      });
    }

    if (this.segAnnotations?.enabled) {
      this.segAnnotations.update();
    }

    requestAnimationFrame((t) => this.render(t));
  }
};
