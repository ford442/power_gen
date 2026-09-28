/**
 * LabSession — shared plant / mode / telemetry host (ADR-0009).
 *
 * GPU backends consume this object; they do not own operator, WASM apply,
 * energy-network policy, or TelemetryHub.publishFrame.
 */
import { CameraController } from '../camera-controller';
import { HardwareBridge, TWIN_MODES } from '../hardware-bridge';
import type { MultiDeviceCamera } from '../multi-device-camera';
import { getAllSimDeviceIds } from '../devices/device-registry';
import {
  getHeronLayout,
  HERON_LAYOUT_PRESETS,
  parseHeronLayoutPreset,
  type HeronLayoutPresetId
} from '../heron-layout';
import { isDeviceActive as isDeviceVisible } from '../renderers/shared/device-view';
import { EnergyNetwork, syncEnergyCouplingDisclaimer } from '../renderers/shared/energy-network';
import { FieldNetwork, syncFieldCouplingDisclaimer } from '../renderers/shared/field-network';
import {
  CHARGE_COUPLING_EDGES,
  ChargeNetwork,
  syncChargeCouplingDisclaimer
} from '../renderers/shared/charge-network';
import {
  parseAnomalousEffects,
  parsePrototypePreset,
  parseSegLayoutPreset
} from '../renderers/shared/url-params';
import type { PrototypePreset } from '../renderers/shared/url-params';
import { stepDevicePhysics, type HeronLayout } from '../renderers/shared/device-physics';
import { SimRateController, type SimRateLoad } from '../sim-rate-controller';
import { segOperator } from '../seg-operator-state';
import { telemetryHub, TelemetryHub } from '../telemetry-hub';
import { segWasm } from '../wasm/seg-physics-bridge';
import { collectDeviceEnergies, meterLabEnergy, meterScalarFlux, gpuChores } from '../gpu-chores';
import { buildHardwareTwinTelemetry } from '../visualizer/hardware-twin';
import type { HardwareTwinTelemetry } from '../telemetry/types';
import type { PublishFrameScientific } from '../telemetry/types';
import {
  applyWasmPlant,
  type SessionDevice,
  type SessionDeviceMap
} from './apply-wasm-plant';
import { PlantWorkerHost, type PlantStats } from './plant-worker-host';

export type { SessionDevice, SessionDeviceMap } from './apply-wasm-plant';
export type { PlantStats } from './plant-worker-host';

export type LabRendererId = 'webgpu' | 'webgl2';

type HeronLayoutWithMeta = HeronLayout & { name: string; description: string };

export interface LabSessionQuality {
  qualityLevel?: number;
  qualityTier?: string;
  frameTimeMs?: number;
  gpuTimeMs?: number;
}

export class LabSession {
  rendererId: LabRendererId = 'webgpu';

  currentView = 'overview';
  devicesEnabled: Record<string, boolean> = Object.fromEntries(
    getAllSimDeviceIds().map((id) => [id, true])
  );
  /** Plant view — backends register the same object refs as visualizer.devices. */
  devices: SessionDeviceMap = {};

  energyNetwork = new EnergyNetwork();
  /** Optional live B coupling between plants (ADR-0011) — off by default. */
  fieldNetwork = new FieldNetwork();
  /** Optional Kelvin seed from the VdG sphere (ADR-0013) — off by default. */
  chargeNetwork = new ChargeNetwork();
  camera = new CameraController();
  cameraController: MultiDeviceCamera | null = null;
  simRateController = new SimRateController();

  hardwareBridge: HardwareBridge;
  hardwareTargetPhase = 0;
  hardwareTargetSpeed = 0;
  hardwareShadow = { phaseError: 0, rpmError: 0 };
  hardwareTwinTelemetry: HardwareTwinTelemetry | null = null;

  speedMult = 1;
  segOmega = 0;
  corona = 0;
  replayLocked = false;

  prototypePreset: PrototypePreset;
  anomalousEffectsEnabled: boolean;
  segLayoutPreset: string;
  heronLayoutPreset: string;
  heronLayout: HeronLayoutWithMeta | null = null;

  /**
   * Off-frame plant step (null → always in-loop: no `Worker`, or
   * `?plantWorker=0`). See plant-worker-host.ts for the one-frame delay.
   */
  plantWorker: PlantWorkerHost | null = PlantWorkerHost.create();
  plantStats: PlantStats = {
    backend: 'in-loop',
    fallbackReason: this.plantWorker ? 'worker starting' : PlantWorkerHost.unavailableAtBoot,
    mainMs: 0,
    workerMs: 0,
    latencyFrames: 0,
    pendingSteps: 0,
    droppedResults: 0,
    wasmInWorker: false
  };

  constructor() {
    this.hardwareBridge = new HardwareBridge({
      onError: (e: unknown) => console.error('[HardwareBridge]', e)
    });

    const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
    this.prototypePreset = parsePrototypePreset(params);
    this.anomalousEffectsEnabled = parseAnomalousEffects(this.prototypePreset);
    this.segLayoutPreset = parseSegLayoutPreset(params, this.prototypePreset);
    this.heronLayoutPreset = parseHeronLayoutPreset(params);
    applyStoredHeronLayout(this);
    publishHeronLayoutPreset(this.heronLayoutPreset);
  }

  attachDevices(devices: Record<string, unknown>): void {
    this.devices = devices as SessionDeviceMap;
  }

  isDeviceActive(deviceId: string): boolean {
    return isDeviceVisible(this.currentView, this.devicesEnabled, deviceId);
  }

  isOverviewMode(): boolean {
    return !this.currentView || this.currentView === 'overview';
  }

  plantFocus(): string {
    return this.currentView === 'overview' ? 'seg' : this.currentView;
  }

  /**
   * Operator + optional WASM plant. Backends then run GPU/CPU device visuals.
   *
   * With a plant worker the step itself runs off the animation frame and this
   * applies the *previous* batch's result (one frame of latency); otherwise
   * the operator / C++ plant step in-loop exactly as before.
   */
  stepPlant(deltaTime: number, speed: number, quality: LabSessionQuality = {}): {
    simSteps: number[];
    replayLocked: boolean;
    useWasm: boolean;
    drive: number;
  } {
    const t0 = performance.now();
    this.speedMult = speed;
    const load: SimRateLoad = {
      qualityLevel: quality.qualityLevel,
      frameTimeMs: quality.frameTimeMs,
      gpuTimeMs: quality.gpuTimeMs
    };
    const simSteps = this.simRateController.tick(deltaTime, speed, load);
    const replayLocked = !!(segOperator.replayMode || telemetryHub.isReplayMode?.());
    this.replayLocked = replayLocked;
    const useWasm = segWasm.enabled && !replayLocked;
    const drive = segOperator.getDrive();
    const focus = this.plantFocus();

    // Charge then field coupling run *before* any plant steps, so the C++
    // plants (via syncWasmFocusKnobs below) and the JS fallbacks both see the
    // same seed V and B this frame. With coupling off each restores the
    // device's local bench value, so the default boot is the isolated
    // classroom it has always been. The two buses write disjoint keys and
    // neither reads the other's output. Energy accounting stays in
    // publishFrame, after the step — it reads plants, it never writes them.
    if (!replayLocked) this.stepOffFocusChargeSources(simSteps, drive);
    this.chargeNetwork.update({ devices: this.devices, devicesEnabled: this.devicesEnabled });
    this.fieldNetwork.update({ devices: this.devices, devicesEnabled: this.devicesEnabled });

    const worker = this.plantWorker;
    const fallbackReason = replayLocked
      ? 'replay'
      : (worker ? worker.unavailableReason(useWasm) : PlantWorkerHost.unavailableAtBoot);

    if (worker && fallbackReason === null) {
      worker.step({ devices: this.devices, focus, simSteps, drive, useWasm });
    } else {
      worker?.cancel();
      if (useWasm) {
        applyWasmPlant({ devices: this.devices, focus, simSteps, drive });
      } else if (!replayLocked) {
        for (const subDt of simSteps) {
          if (subDt > 0) segOperator.step(subDt);
        }
      }
    }

    this.segOmega = segOperator.physics.segOmega;
    this.corona = segOperator.physics.corona;
    this.plantStats = {
      backend: fallbackReason === null ? 'worker' : 'in-loop',
      fallbackReason,
      mainMs: performance.now() - t0,
      latencyFrames: fallbackReason === null ? 1 : 0,
      ...(worker
        ? worker.stats()
        : { workerMs: 0, pendingSteps: 0, droppedResults: 0, wasmInWorker: false })
    };
    return { simSteps, replayLocked, useWasm, drive };
  }

  /**
   * Keep a charge-bus source charging while you look at its destination.
   *
   * In a focus view the backends only step the focused bench, so with Kelvin
   * focused the VdG sphere would sit at whatever voltage it held when the view
   * changed — usually the 0 it was created with — and the "coupled" seed would
   * be a frozen number. While charge coupling is on and a destination is
   * focused, step each live source's JS plant **physics only** (no particles,
   * mesh or GPU work) over the same substeps. No double-stepping: the source is
   * never the focused device here, and in overview the backend loop owns it.
   * The JS VdG plant is golden-matched to the C++ one, so this holds under
   * `?wasmPhysics=1` too, where the C++ plant is busy with the focused bench.
   */
  private stepOffFocusChargeSources(simSteps: number[], drive: number): void {
    if (!this.chargeNetwork.couplingEnabled || this.isOverviewMode()) return;
    for (const edge of CHARGE_COUPLING_EDGES) {
      if (edge.to !== this.currentView || edge.from === this.currentView) continue;
      if (this.devicesEnabled[edge.from] === false) continue;
      const src = this.devices[edge.from];
      const state = src?.physicsState ?? src?.physics;
      if (!state) continue;
      for (const subDt of simSteps) {
        if (subDt > 0) stepDevicePhysics(state, subDt, drive);
      }
    }
  }

  syncHardwareTwin(deltaTime: number): void {
    const hw = this.hardwareBridge;
    if (!hw?.isConnected) {
      this.hardwareTwinTelemetry = null;
      this.hardwareShadow = { phaseError: 0, rpmError: 0 };
      return;
    }

    const tel = segOperator.computeTelemetry(0);
    const simRpm = HardwareBridge.sanitizeRpm(tel.rpmDisplay || 0);
    const simVoltage = Number.isFinite(tel.voltage) ? tel.voltage : 0;
    const simCurrent = Number.isFinite(tel.current) ? tel.current : 0;
    if (!hw.manualMode && hw.controlMode === 0) {
      this.hardwareTargetPhase += simRpm * 6.0 * Math.max(0, deltaTime);
      this.hardwareTargetSpeed = simRpm;
    }
    const simPhase = ((this.hardwareTargetPhase % 360) + 360) % 360;

    if (
      hw.twinMode === TWIN_MODES.OPEN
      || hw.twinMode === TWIN_MODES.SHADOW
      || hw.twinMode === TWIN_MODES.CLOSED
    ) {
      const runMode = segOperator.isRunning ? 0 : 2;
      if (!hw.manualMode) {
        hw.setTarget(simPhase, segOperator.isRunning ? simRpm : 0, runMode);
      }
    }

    hw.update({ simPhase, simRpm, simVoltage, simCurrent });

    if (hw.twinMode === TWIN_MODES.CLOSED && !hw.isSensorStale) {
      const hwRpm = HardwareBridge.sanitizeRpm(hw.actualRpm);
      const wNorm = Math.min(1, Math.abs(hwRpm) / 3000);
      this.segOmega = wNorm;
      this.corona = Math.max(0, Math.min(1, (wNorm - 0.6) / 0.4));
      segOperator.physics.segOmega = wNorm;
      segOperator.physics.corona = this.corona;
    }

    this.hardwareShadow = {
      phaseError: hw.shadow.phaseErrorDeg,
      rpmError: hw.shadow.rpmError
    };
    this.hardwareTwinTelemetry = buildHardwareTwinTelemetry(hw);
  }

  updateTachometer(): void {
    const el = document.getElementById('tachometer');
    if (!el) return;
    const src = this.simRateController;
    const fill = el.querySelector('.tach-fill') as HTMLElement | null;
    const label = el.querySelector('.tach-label') as HTMLElement | null;
    if (fill) {
      fill.style.width = `${(src.tachFill * 100).toFixed(1)}%`;
      fill.style.background = `hsl(${src.tachHue}, 100%, 50%)`;
      if (src.isOverdrive) fill.classList.add('overdrive');
      else fill.classList.remove('overdrive');
    }
    if (label) {
      label.textContent = `${src.speedMult.toFixed(2)}×`;
      label.style.color = `hsl(${src.tachHue}, 100%, 65%)`;
    }
  }

  /**
   * Energy network + hub publish. Call after backend device physics for the frame.
   */
  publishFrame(dt: number, totalParticles: number, extraScientific: PublishFrameScientific = {}): PublishFrameScientific {
    const omega = this.segOmega || 0;
    const lab = meterLabEnergy(collectDeviceEnergies(this.devices));
    const flux = meterScalarFlux(
      Object.values(this.devices).map((d) => d.scaledParticleCount || d.particleCount || 0),
      this.speedMult
    );
    const particleFlux = flux.particleFlux || (totalParticles * Math.max(0.05, this.speedMult));
    const scientific: PublishFrameScientific = {
      particleFlux,
      maxFieldMagnitude: 0.7048 * (0.35 + 0.65 * Math.min(1, Math.abs(omega))),
      avgEnergyDensity: lab.avgEnergyDensity,
      labEnergySum: lab.labEnergySum,
      labEnergyRms: lab.labEnergyRms,
      choresBackend: gpuChores.breadcrumb().backend,
      ...extraScientific
    };
    const segTelemetry = segOperator.computeTelemetry(dt);
    const netSnap = this.energyNetwork.update({
      devices: this.devices,
      devicesEnabled: this.devicesEnabled,
      segPowerW: segTelemetry.power,
      segEfficiencyPct: segTelemetry.efficiency,
      deltaTime: dt
    });
    if (netSnap) {
      syncEnergyCouplingDisclaimer(netSnap.couplingEnabled, netSnap);
    }
    const fieldSnap = this.fieldNetwork.getSnapshot();
    syncFieldCouplingDisclaimer(fieldSnap.couplingEnabled, fieldSnap);
    const chargeSnap = this.chargeNetwork.getSnapshot();
    syncChargeCouplingDisclaimer(chargeSnap.couplingEnabled, chargeSnap);
    if (this.replayLocked) {
      return scientific;
    }
    telemetryHub.publishFrame({
      dt,
      view: this.currentView || 'overview',
      renderer: this.rendererId,
      devicePhysics: TelemetryHub.collectDevicePhysics(this.devices),
      scientific,
      segTelemetry,
      energyNetwork: netSnap
        ? {
            couplingEnabled: netSnap.couplingEnabled,
            labBudgetW: netSnap.labBudgetW,
            totalAllocatedW: netSnap.totalAllocatedW,
            residualW: netSnap.residualW,
            devices: netSnap.devices
          }
        : null,
      fieldNetwork: fieldSnap,
      chargeNetwork: chargeSnap,
      hardwareTwin: this.hardwareTwinTelemetry ?? null
    });
    return scientific;
  }

  /** Mode-change hub poke (dt=0) so gauges follow focus immediately. */
  publishModeTelemetry(): void {
    telemetryHub.publishFrame({
      dt: 0,
      view: this.currentView || 'overview',
      renderer: this.rendererId,
      devicePhysics: TelemetryHub.collectDevicePhysics(this.devices),
      hardwareTwin: this.hardwareTwinTelemetry ?? null
    });
  }

  /**
   * Plant half of setMode: view, camera focus, device reset, hub poke.
   * Backends run GPU-only follow-up (glTF, layout uniforms).
   */
  setMode(mode: string): { prev: string; view: string } {
    const prev = this.currentView;
    this.currentView = mode || 'overview';
    if (this.currentView === 'overview') {
      this.cameraController?.showOverview?.();
    } else {
      this.cameraController?.focusOnDevice?.(this.currentView);
    }
    if (this.currentView && this.currentView !== 'overview' && this.currentView !== prev) {
      this.devices[this.currentView]?.resetForModeEntry?.();
    }
    if (isWasmPlantModeSafe(this.plantFocus()) && segWasm.enabled) {
      segWasm.setMode(this.plantFocus());
    }
    this.publishModeTelemetry();
    return { prev, view: this.currentView };
  }

  persistSegLayoutPreset(presetName: string): void {
    this.segLayoutPreset = presetName;
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('layout', presetName);
      window.history.replaceState(null, '', url);
    } catch (_) { /* ignore */ }
  }

  persistHeronLayoutPreset(presetName: string): HeronLayoutWithMeta | null {
    if (!(Object.values(HERON_LAYOUT_PRESETS) as string[]).includes(presetName)) return null;
    this.heronLayoutPreset = presetName;
    this.heronLayout = getHeronLayout(presetName as HeronLayoutPresetId);
    publishHeronLayoutPreset(presetName);
    const heron = this.devices.heron;
    const phys = heron?.physicsState ?? heron?.physics;
    if (phys) {
      phys.heronLayoutId = presetName;
      phys.heronHeadMax = this.heronLayout.headMaxM;
      phys.heronHead = Math.min(phys.heronHead, this.heronLayout.headMaxM);
    }
    try { localStorage.setItem('heron-layout', presetName); } catch (_) { /* ignore */ }
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('heronLayout', presetName);
      window.history.replaceState(null, '', url);
    } catch (_) { /* ignore */ }
    return this.heronLayout;
  }

  async maybeConnectMockHardware(): Promise<void> {
    try {
      if (new URLSearchParams(location.search).get('mockHardware') === '1') {
        await this.hardwareBridge.connectMock();
        this.hardwareBridge.setTwinMode(TWIN_MODES.SHADOW);
      }
    } catch (_) { /* ignore */ }
  }
}

/**
 * Publish the preset the lab actually resolved.
 *
 * The query string alone is not the answer: `applyStoredHeronLayout()` lets a
 * `localStorage` preset override `?heronLayout=` at boot, so anything reading
 * the URL would see the wrong layout until the user switched preset by hand.
 * Consumers that cannot reach the session — `parseHeronLayoutPreset()`, and the
 * `heronVessels` CAD prop, whose GLB is baked for `classic` only — read this
 * instead, so the prop cannot disagree with the geometry on screen.
 */
function publishHeronLayoutPreset(presetName: string): void {
  if (typeof window === 'undefined') return;
  window.HERON_LAYOUT_PRESET = presetName;
}

function applyStoredHeronLayout(session: LabSession): void {
  try {
    const storedHeron = localStorage.getItem('heron-layout');
    const presets: string[] = Object.values(HERON_LAYOUT_PRESETS);
    if (storedHeron && presets.includes(storedHeron)) {
      session.heronLayoutPreset = storedHeron;
    }
  } catch (_) { /* ignore */ }
  session.heronLayout = getHeronLayout(session.heronLayoutPreset as HeronLayoutPresetId);
}

function isWasmPlantModeSafe(id: string): boolean {
  return [
    'seg', 'heron', 'kelvin', 'solar', 'peltier', 'mhd',
    'maglev', 'homopolar', 'transformer', 'vdg', 'hall', 'lorentz-sled',
    'jumping-ring'
  ].includes(id);
}
