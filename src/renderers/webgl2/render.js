/**
 * Draw side of WebGL2MultiDeviceVisualizer: per-frame physics/particle
 * stepping (stepSimulation) and the WebGL2 draw calls (renderFrame).
 *
 * Split out of index.js (orchestrator vs draw) to keep that file under the
 * repo's 700-line cap. Stays plain JS per ADR-0001 (WebGL2/GLSL rescue path
 * is intentionally not TypeScript). Plain module functions that take the
 * visualizer as `viz`; the class's `_stepSimulation` / `render` methods
 * delegate here (no prototype mixin).
 */

/** @typedef {import('./index.js').WebGL2MultiDeviceVisualizer} WebGL2MultiDeviceVisualizer */

import { buildMagLevMesh } from '../../devices/quanta/magnetic-levitation';
import { buildHomopolarMesh } from '../../devices/quanta/homopolar-generator';
import { buildHalbachVizMesh, halbachConfigFromState } from '../../devices/quanta/halbach-viz';
import { buildPulseCoilMesh } from '../../devices/quanta/pulse-coil';
import { buildTransformerMesh } from '../../devices/quanta/transformer';
import { buildVdgMesh, VDG_V_BREAK } from '../../devices/quanta/van-de-graaff';
import { buildHallMesh } from '../../devices/quanta/hall-effect';
import { buildLorentzSledMesh, LORENTZ } from '../../devices/quanta/lorentz-sled';
import { buildJumpingRingMesh, RING } from '../../devices/quanta/jumping-ring';
import { dropTubeMeshFromState } from '../../devices/quanta/drop-tube';
import { buildPeltierMesh } from '../../devices/core/peltier-mesh';
import { buildMhdMesh } from '../../devices/core/mhd-mesh';
import { stepParticles } from '../shared/particle-physics';
import { deviceModeIndex } from '../shared/device-physics';
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
import { stepJsDevicePlant } from '../../session/apply-wasm-plant';

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

/**
 * Physics step: LabSession plant + CPU device/particle visuals.
 * @param {WebGL2MultiDeviceVisualizer} viz
 * @param {number} deltaTime
 * @param {number} speed
 * @returns {number} total particles stepped this frame
 */
export function stepSimulation(viz, deltaTime, speed) {
  const { simSteps, replayLocked, useWasm, drive } = viz.session.stepPlant(deltaTime, speed, {
    qualityLevel: viz.profiler?.qualityLevel,
    frameTimeMs: viz.profiler?.lastFrameTimeMs,
    gpuTimeMs: viz.profiler?.lastGpuTimeMs
  });
  const focus = viz.session.plantFocus();

  const substeps = simSteps.length || 1;
  const subDt = deltaTime / Math.max(substeps, 1);
  let totalParticles = 0;
  const canvasAspect = (viz.canvas.width || 1) / Math.max(1, viz.canvas.height || 1);
  const cullCamera = viz.camera?.camera;
  const cullOpts = getOverviewCullOpts({ aspect: canvasAspect });
  const qualityTier = viz.profiler?.qualityTier || 'high';

  for (const device of Object.values(viz.devices)) {
    if (!shouldSimulateDevice(
      viz.currentView,
      viz.devicesEnabled,
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
      // The session's substeps, not the wall-clock frame: the JS plant
      // follows speed, pause and a live experiment's cut batch exactly like
      // the operator and the C++ plant (particles below stay on frame time —
      // they are visuals).
      const heronLayout = (device.id === 'heron' && viz.heronLayout) || undefined;
      stepJsDevicePlant(device.id, device.physics, focus, { simSteps, drive, useWasm, replayLocked }, { heronLayout });
    }

    for (let s = 0; s < substeps; s++) {
      const mode = deviceModeIndex(device.id);
      const viewLod = getViewParticleLod(viz.currentView, device.id);
      const scaledCount = Math.max(
        64,
        resolveScaledParticleCount({
          deviceId: device.id,
          baseCount: device.particleCount,
          qualityLevel: viz.profiler?.qualityLevel ?? 1,
          qualityTier,
          viewLod,
          isPlugin: !!device.config?.plugin
        }) || Math.floor(
          device.particleCount * getDeviceParticleScale({
            currentView: viz.currentView,
            deviceId: device.id,
            qualityLevel: viz.profiler?.qualityLevel ?? 1
          })
        )
      );
      device.scaledParticleCount = scaledCount;
      totalParticles += scaledCount;
      stepParticles(device.particles, {
        time: viz.time,
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
        dropTubeDepthM: device.physics.dropTubeDepthM,
        dropTubeVMps: device.physics.dropTubeVMps,
        dropTubeEddyIA: device.physics.dropTubeEddyIA,
        dropTubeEddyTrailIA: device.physics.dropTubeEddyTrailIA,
        simClock: viz.simClock,
        speedMult: speed
      });
    }
  }

  return totalParticles;
}

/**
 * One WebGL2 frame: step, draw, schedule the next frame via `viz.render`.
 * @param {WebGL2MultiDeviceVisualizer} viz
 * @param {number} timestamp rAF timestamp (ms)
 */
export function renderFrame(viz, timestamp) {
  const { cameraController, skyGrid, meshRenderer, particleRenderer } = viz;
  const gl = viz.ctx.gl;
  if (!gl || !cameraController || !skyGrid || !meshRenderer || !particleRenderer) {
    // init() builds all of these before its first render(0); keep the loop alive regardless.
    requestAnimationFrame((t) => viz.render(t));
    return;
  }
  const rawDelta = (timestamp - viz.lastFrameTime) / 1000;
  viz.lastFrameTime = timestamp;
  const deltaTime = viz.debug.effectiveDelta(rawDelta || 0.016);

  if (timestamp % 500 < 20 && deltaTime > 0) {
    viz.fps = Math.round(1 / (deltaTime || 0.016));
    const fpsEl = document.getElementById('fps');
    if (fpsEl) fpsEl.textContent = String(viz.fps);
  }

  // parseFloat never returns null/undefined, so `?? 50` never fired: a missing
  // or empty slider gave NaN speed and froze viz.time at NaN. Fall back explicitly.
  const speedEl = /** @type {HTMLInputElement | null} */ (document.getElementById('speedControl'));
  const parsedSpeed = parseFloat(speedEl?.value ?? '');
  const rawSpeed = Number.isFinite(parsedSpeed) ? parsedSpeed : 50;
  const speed = 0.05 * Math.pow(400, rawSpeed / 100);
  viz.speedMult = speed;

  viz.time += deltaTime * speed;
  viz.simClock += deltaTime;

  const totalParticles = viz._stepSimulation(deltaTime, speed);

  viz._updateHardwareTwin(deltaTime);

  const speedValEl = document.getElementById('speedVal');
  if (speedValEl) speedValEl.textContent = speed.toFixed(2) + '×';

  cameraController.updateCamera(deltaTime);
  const viewProj = cameraController.getViewProjMatrix();
  const cameraPos = viz.camera.camera.position;

  viz.session.publishFrame(deltaTime, totalParticles);

  viz.ctx.resize();
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  skyGrid.drawSky(viz.time, viz.lightingPreset?.sky?.mode ?? 1);
  skyGrid.drawGrid(viewProj, cameraPos);

  const renderOpts = {
    wireframe: viz.debug.wireframe,
    debugMode: viz.debug.debugMode,
    cameraPos,
    corona: viz.devices.seg?.physics.corona || 0
  };

  const canvasAspect = (viz.canvas.width || 1) / Math.max(1, viz.canvas.height || 1);
  const cullCamera = viz.camera?.camera;
  const cullOpts = getOverviewCullOpts({ aspect: canvasAspect });
  const meshDetail = getMeshDrawDetail(
    getViewMeshLod(viz.currentView, viz.profiler?.qualityLevel ?? 1)
  );
  viz._overviewMeshDetail = meshDetail;

  for (const device of Object.values(viz.devices)) {
    if (!shouldSimulateDevice(
      viz.currentView,
      viz.devicesEnabled,
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
  viz.segLayout,
  viz.time,
  speed,
  viz.segOmega
  );
  meshRenderer.drawSegStructure(viewProj, pos, {
  ...renderOpts,
  frameLevel: viz.segFrameLevel,
  layout: viz.segLayout
  });
  meshRenderer.drawStatorRings(viewProj, pos, renderOpts);
  meshRenderer.drawRollers(viewProj, pos, rollers, viz.time, {
  ...renderOpts,
  corona: device.physics.corona,
  prototypePreset: viz.prototypePreset,
  rings: segLayoutRingsForDraw(viz.segLayout)
  });
} else if (meshDetail !== 'skip') {
  // Overview mesh LOD: skip barely-visible plugin meshes when quality is critical.
  const drawMeshes = meshDetail !== 'proxy' || viz.currentView === device.id;

  if (drawMeshes && (device.id === 'heron' || device.id === 'kelvin' || device.id === 'solar')) {
  meshRenderer.drawAlternateDevice(viewProj, pos, device.id, {
    ...renderOpts,
    heronLayoutPreset: device.id === 'heron' ? viz.heronLayoutPreset : undefined
  });
  } else if (drawMeshes && device.id === 'peltier') {
  meshRenderer.drawPluginDevice(
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
  meshRenderer.drawPluginDevice(
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
  meshRenderer.drawPluginDevice(
    viewProj, pos, buildMagLevMesh(gap).cylinders(), renderOpts
  );
  } else if (drawMeshes && device.id === 'homopolar') {
  const angle = device.physics.homopolarAngle ?? 0;
  meshRenderer.drawPluginDevice(
    viewProj, pos, buildHomopolarMesh(angle).cylinders(), renderOpts
  );
  } else if (drawMeshes && device.id === 'halbach-viz') {
  const config = halbachConfigFromState(device.physics);
  meshRenderer.drawPluginDevice(
    viewProj, pos, buildHalbachVizMesh(config).cylinders(), renderOpts
  );
  } else if (drawMeshes && device.id === 'pulse-coil') {
  const travel = device.physics.pulseCoilArmatureM ?? 0;
  const iA = device.physics.pulseCoilCurrentA ?? 0;
  const vCap = device.physics.pulseCoilVCap ?? 0;
  meshRenderer.drawPluginDevice(
    viewProj, pos, buildPulseCoilMesh(travel, iA, vCap).cylinders(), renderOpts
  );
  } else if (drawMeshes && device.id === 'transformer') {
  meshRenderer.drawPluginDevice(
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
  meshRenderer.drawPluginDevice(
    viewProj, pos, buildVdgMesh(chargeNorm, sparkGlow).cylinders(), renderOpts
  );
  } else if (drawMeshes && device.id === 'hall') {
  const currentNorm = Math.min(1, (device.physics.hallCurrent ?? 0) / 1.2);
  const fieldNorm = Math.min(1, (device.physics.hallFieldT ?? 0) / 0.65);
  meshRenderer.drawPluginDevice(
    viewProj, pos, buildHallMesh(currentNorm, fieldNorm).cylinders(), renderOpts
  );
  } else if (drawMeshes && device.id === 'lorentz-sled') {
  const posNorm = ((device.physics.lorentzPositionM ?? 0) % LORENTZ.railLengthM) / LORENTZ.railLengthM;
  const currentNorm = Math.min(1, Math.abs(device.physics.lorentzCurrentA ?? 0) / LORENTZ.iMaxA);
  const fieldNorm = Math.min(1, (device.physics.lorentzFieldT ?? 0) / LORENTZ.fieldTMax);
  meshRenderer.drawPluginDevice(
    viewProj, pos, buildLorentzSledMesh(posNorm, currentNorm, fieldNorm).cylinders(), renderOpts
  );
  } else if (drawMeshes && device.id === 'jumping-ring') {
  const heightNorm = Math.min(1, (device.physics.ringHeightM ?? 0) / RING.poleHeightM);
  const ringNorm = Math.min(1, Math.abs(device.physics.ringCurrentA ?? 0) / RING.iRingMaxA);
  const primaryNorm = Math.min(1, Math.abs(device.physics.ringPrimaryIA ?? 0) / RING.iPrimaryMaxA);
  const kNorm = Math.min(1, (device.physics.ringCouplingK ?? RING.couplingK0) / RING.couplingK0);
  meshRenderer.drawPluginDevice(
    viewProj, pos, buildJumpingRingMesh(heightNorm, ringNorm, primaryNorm, kNorm).cylinders(), renderOpts
  );
  } else if (drawMeshes && device.id === 'drop-tube') {
  meshRenderer.drawPluginDevice(
    viewProj, pos, dropTubeMeshFromState(device.physics).cylinders(), renderOpts
  );
  }

  if (viz.currentView === 'halbach-viz' && device.id === 'halbach-viz' && viz.halbachFieldRenderer) {
  viz.halbachFieldRenderer.draw(
    viewProj,
    pos,
    device.physics.halbachFieldLines,
    device.physics.halbachHeatmap,
    { extent: 3.1, gridSize: 24 }
  );
  }
}

    particleRenderer.draw(
      device.particles,
      scaledCount,
      viewProj,
      pos,
      mode,
      tint,
      {
        debugParticles: viz.debug.debugParticles,
        battery: device.physics.batteryCharge,
        particleScale: viz.debug.particleScale
      }
    );
  }

  // Overview energy pipes (line-strip Bézier arcs)
  if (viz.isOverviewMode() && viz.energyPipeRenderer) {
    viz.energyPipeRenderer.draw(viewProj, viz.devices, viz.time, {
      devicesEnabled: viz.devicesEnabled
    });
  }

  if (viz.segAnnotations?.enabled) {
    viz.segAnnotations.update();
  }

  requestAnimationFrame((t) => viz.render(t));
}
