/**
 * PlantWorkerHost — main-thread side of the interactive plant worker.
 *
 * `LabSession.stepPlant` hands each frame's substeps here instead of stepping
 * the SEG operator / C++ focus plant on the animation-frame call stack:
 *
 *   frame N:   apply result of batch N−1 → queue frame N's substeps → post
 *   worker:    steps batch N off-thread
 *   frame N+1: apply result of batch N → …
 *
 * So the plant the renderer draws is **one frame behind** the substeps the
 * session clock issued (docs/AGENTS.md → Plant worker). One batch is in flight
 * at a time; substeps issued while it runs queue up and ride the next batch,
 * so sim time is not lost to a slow worker. Pause / `.` / slow-mo stay
 * authoritative because the worker only ever steps what it is sent.
 *
 * Operator actions (START / STOP / E-stop / reset / replay) bump
 * `segOperator.epoch`; a result computed under an older epoch is dropped and
 * its substeps re-queued, so an in-flight batch can never undo a button press.
 *
 * Falls back to the in-loop step (LabSession) when `Worker` is missing,
 * `?plantWorker=0` is set, the worker has not reported ready yet, the worker
 * failed, or `?wasmPhysics=1` is on but the worker could not load sim_core.
 */
import { segOperator } from '../seg-operator-state';
import { segWasm } from '../wasm/seg-physics-bridge';
import { WASM_DEVICE_IDS } from '../../generated/device-catalog';
import {
  applyModePlantToDevices,
  reportKelvinSeedIgnored,
  devicePhysics,
  type SessionDeviceMap
} from './apply-wasm-plant';
import {
  PLANT_FLAG_WASM_STEPPED,
  PLANT_PACK_HEADER,
  PLANT_PACK_KEYS,
  PLANT_PACK_ROLLER_OFFSET,
  unpackModePlant,
  type PlantKnobs,
  type PlantWorkerRequest,
  type PlantWorkerResponse,
  type PlantWorkerResult
} from './plant-worker-protocol';

/** Where the last frame's plant step ran, and what it cost (F3 / getRendererInfo). */
export interface PlantStats {
  backend: 'worker' | 'in-loop';
  /** Why the in-loop path ran (null while the worker owns the step). */
  fallbackReason: string | null;
  /** Main-thread ms inside `LabSession.stepPlant` last frame (field coupling included). */
  mainMs: number;
  /** Worker wall ms for the last completed batch. */
  workerMs: number;
  /** Frames between a substep being issued and its result reaching devices. */
  latencyFrames: number;
  /** Substeps queued behind the in-flight batch. */
  pendingSteps: number;
  /** Results discarded because an operator action landed while they were in flight. */
  droppedResults: number;
  wasmInWorker: boolean;
}

export interface PlantWorkerFrame {
  devices: SessionDeviceMap;
  focus: string;
  simSteps: number[];
  drive: number;
  useWasm: boolean;
}

interface InFlight {
  seq: number;
  epoch: number;
  steps: number[];
  focus: string;
}

const MEAN_OMEGA_INDEX = PLANT_PACK_HEADER + PLANT_PACK_KEYS.indexOf('meanOmega');

/**
 * 4 frames of the SimRateController's maximum substeps. Past this the worker
 * is not keeping up at all; drop the oldest rather than build an unbounded
 * backlog (the same spiral-of-death guard the controller applies in-loop).
 */
const MAX_PENDING_STEPS = 24;

function plantWorkerDisabledByQuery(): boolean {
  if (typeof location === 'undefined') return false;
  return new URLSearchParams(location.search).get('plantWorker') === '0';
}

function wasmRequestedAtBoot(): boolean {
  if (typeof location === 'undefined') return false;
  const params = new URLSearchParams(location.search);
  if (params.get('wasmPhysics') === '1' || params.get('wasm') === '1') return true;
  try {
    return localStorage.getItem('useWasmPhysics') === 'true';
  } catch {
    return false;
  }
}

/** Device-side knobs the C++ focus plant reads (see `syncWasmFocusKnobs`). */
function collectKnobs(devices: SessionDeviceMap, focus: string): PlantKnobs {
  const knobs: PlantKnobs = {};
  if (focus === 'transformer') {
    knobs.transformerLeakage = !!devicePhysics(devices.transformer)?.transformerLeakage;
  } else if (focus === 'hall') {
    const hall = devicePhysics(devices.hall);
    knobs.hallCarrierType = hall?.hallCarrierType;
    knobs.hallFieldCoupledT = hall?.hallFieldCoupledT ?? null;
  } else if (focus === 'lorentz-sled') {
    const fieldT = devicePhysics(devices['lorentz-sled'])?.lorentzFieldT;
    if (fieldT != null) knobs.lorentzFieldT = fieldT;
  } else if (focus === 'kelvin') {
    const seed = devicePhysics(devices.kelvin)?.kelvinSeedCoupledV;
    knobs.kelvinSeedCoupledV = typeof seed === 'number' && Number.isFinite(seed) ? seed : null;
  }
  return knobs;
}

export class PlantWorkerHost {
  private readonly worker: Worker;
  private ready = false;
  private failed = false;
  private wasmAvailable = false;
  private wasmRequested: boolean;
  private seq = 0;
  private inFlight: InFlight | null = null;
  /** In-flight batch whose result must be thrown away (cancelled mid-flight). */
  private discardSeq = -1;
  private completed: { res: PlantWorkerResult; rec: InFlight } | null = null;
  private pending: number[] = [];
  /** Focus whose C++ plant owned its device on the last applied result. */
  private ownedFocus: string | null = null;
  private workerMs = 0;
  private droppedResults = 0;
  /**
   * Roller state `[angle, ω, radius, height]` × N from the last SEG-focus C++
   * batch — the worker-side copy of `segWasm.getRollerStateFloatView()`.
   */
  lastRollerState: Float32Array | null = null;

  /** Why `create()` last returned null (the in-loop fallback reason). */
  static unavailableAtBoot = 'no Worker';

  /** Null when workers are unavailable or disabled — LabSession steps in-loop. */
  static create(): PlantWorkerHost | null {
    if (plantWorkerDisabledByQuery()) {
      PlantWorkerHost.unavailableAtBoot = '?plantWorker=0';
      return null;
    }
    if (typeof Worker === 'undefined') {
      PlantWorkerHost.unavailableAtBoot = 'no Worker';
      return null;
    }
    try {
      const worker = new Worker(
        new URL('../workers/plant-worker.ts', import.meta.url),
        { type: 'module', name: 'plant' }
      );
      return new PlantWorkerHost(worker, wasmRequestedAtBoot());
    } catch (err) {
      console.warn('[PlantWorker] Worker unavailable — stepping the plant in-loop:', err);
      PlantWorkerHost.unavailableAtBoot = 'worker construction failed';
      return null;
    }
  }

  private constructor(worker: Worker, wasm: boolean) {
    this.worker = worker;
    this.wasmRequested = wasm;
    worker.onmessage = (e: MessageEvent<PlantWorkerResponse>) => this.onMessage(e.data);
    worker.onerror = (e: ErrorEvent) => this.fail(e.message || 'worker error');
    this.post({ type: 'init', wasm });
  }

  /**
   * Whether this frame can go to the worker. Returns the fallback reason
   * otherwise (null = worker path). Asks the worker for sim_core the first
   * time a `?wasmPhysics` frame needs it (e.g. the debug-panel toggle).
   */
  unavailableReason(useWasm: boolean): string | null {
    if (this.failed) return 'worker failed';
    if (useWasm && !this.wasmRequested) {
      this.wasmRequested = true;
      this.ready = false;
      this.post({ type: 'init', wasm: true });
    }
    if (!this.ready) return 'worker starting';
    if (useWasm && !this.wasmAvailable) return 'sim_core unavailable in worker';
    return null;
  }

  /** Apply the last completed batch, queue this frame's substeps, post if idle. */
  step(frame: PlantWorkerFrame): void {
    const applied = this.consume(frame.devices);
    if (!applied && frame.useWasm && this.ownedFocus === frame.focus) {
      // No fresh result this frame: keep the C++ plant's last state on screen
      // rather than letting the JS plant step the device once in between.
      const phys = devicePhysics(frame.devices[frame.focus]);
      if (phys) phys._wasmPlantActive = true;
    }

    for (const dt of frame.simSteps) {
      if (dt > 0) this.pending.push(dt);
    }
    if (this.pending.length > MAX_PENDING_STEPS) {
      this.pending.splice(0, this.pending.length - MAX_PENDING_STEPS);
    }
    if (!this.inFlight && this.pending.length) this.dispatch(frame);
  }

  /** Drop queued and in-flight work (replay lock, or falling back in-loop). */
  cancel(): void {
    this.pending.length = 0;
    this.completed = null;
    this.ownedFocus = null;
    segWasm.reportRemotePlant(null);
    if (this.inFlight) this.discardSeq = this.inFlight.seq;
  }

  stats(): Pick<PlantStats, 'workerMs' | 'pendingSteps' | 'droppedResults' | 'wasmInWorker'> {
    return {
      workerMs: this.workerMs,
      pendingSteps: this.pending.length,
      droppedResults: this.droppedResults,
      wasmInWorker: this.wasmAvailable
    };
  }

  dispose(): void {
    this.worker.terminate();
    this.failed = true;
  }

  private dispatch(frame: PlantWorkerFrame): void {
    const steps = this.pending;
    this.pending = [];
    const rec: InFlight = { seq: ++this.seq, epoch: segOperator.epoch, steps, focus: frame.focus };
    this.inFlight = rec;
    this.post({
      type: 'step',
      seq: rec.seq,
      steps,
      focus: frame.focus,
      useWasm: frame.useWasm,
      drive: frame.drive,
      operator: {
        status: segOperator.status,
        isRunning: segOperator.isRunning,
        targetDrive: segOperator.targetDrive,
        magneticFieldStrength: segOperator.magneticFieldStrength,
        loadResistance: segOperator.loadResistance,
        physics: segOperator.physics
      },
      knobs: collectKnobs(frame.devices, frame.focus)
    });
  }

  private consume(devices: SessionDeviceMap): boolean {
    const done = this.completed;
    if (!done) return false;
    this.completed = null;
    const { res, rec } = done;

    if (rec.epoch !== segOperator.epoch) {
      // START / STOP / E-stop / reset landed after this batch was posted.
      // Re-run its sim time from the new state instead of losing it.
      this.droppedResults++;
      this.pending.unshift(...rec.steps);
      return false;
    }

    segOperator.status = res.status;
    Object.assign(segOperator.physics, res.physics);

    // Kelvin is a core plant: ownership is the module flag, not `_wasmPlantActive`.
    reportKelvinSeedIgnored(res.kelvinSeedIgnored);

    const packed = res.plant;
    if (packed[0] & PLANT_FLAG_WASM_STEPPED) {
      const plant = unpackModePlant(packed, WASM_DEVICE_IDS);
      // The main-thread sim_core instance is not stepped on this path; make
      // `segWasm.getMode()` / `getModePlant()` report the worker's plant.
      segWasm.reportRemotePlant(plant);
      const meanOmega = packed[MEAN_OMEGA_INDEX];
      if (!Number.isNaN(meanOmega)) segWasm.reportRollerMeanOmega(meanOmega);
      if (rec.focus !== 'seg' && rec.focus !== 'overview') {
        applyModePlantToDevices(
          rec.focus,
          devices,
          plant,
          res.hallCouplingIgnored,
          res.kelvinSeedIgnored
        );
        this.ownedFocus = devicePhysics(devices[rec.focus])?._wasmPlantActive ? rec.focus : null;
      } else {
        this.ownedFocus = null;
        this.lastRollerState = packed.subarray(PLANT_PACK_ROLLER_OFFSET);
      }
    } else {
      this.ownedFocus = null;
      segWasm.reportRemotePlant(null);
    }
    return true;
  }

  private onMessage(msg: PlantWorkerResponse): void {
    if (!msg) return;
    if (msg.type === 'ready') {
      this.ready = true;
      this.wasmAvailable = msg.wasmAvailable;
      return;
    }
    const rec = this.inFlight;
    if (!rec || msg.seq !== rec.seq) return;
    this.inFlight = null;
    if (msg.type === 'error') {
      this.fail(msg.error);
      return;
    }
    this.workerMs = msg.stepMs;
    if (msg.seq === this.discardSeq) return;
    this.completed = { res: msg, rec };
  }

  private fail(reason: string): void {
    if (this.failed) return;
    this.failed = true;
    this.inFlight = null;
    this.completed = null;
    this.pending.length = 0;
    segWasm.reportRemotePlant(null);
    console.warn(`[PlantWorker] ${reason} — stepping the plant in-loop from now on.`);
    try { this.worker.terminate(); } catch { /* ignore */ }
  }

  private post(msg: PlantWorkerRequest): void {
    try {
      this.worker.postMessage(msg);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }
}
