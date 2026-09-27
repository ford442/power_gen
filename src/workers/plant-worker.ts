/**
 * Interactive plant step (dedicated worker) — the off-frame half of
 * `LabSession.stepPlant`.
 *
 * Runs the same code the in-loop path runs: its own `segOperator` mirror
 * (adopted from the main thread's snapshot before every batch) and, when
 * asked, its own `sim_core.wasm` instance via `applyWasmPlant`. The worker
 * never free-runs — it steps only the substeps the session clock sends — and
 * never touches WebGPU/WebGL (ADR-0007).
 */
import { segOperator } from '../seg-operator-state';
import { segWasm } from '../wasm/seg-physics-bridge';
import {
  applyWasmPlant,
  hallCouplingIgnoredByWasm,
  type SessionDeviceMap,
  type WasmModePlant
} from '../session/apply-wasm-plant';
import {
  packModePlant,
  type PlantKnobs,
  type PlantWorkerRequest,
  type PlantWorkerResponse,
  type PlantWorkerStep
} from '../session/plant-worker-protocol';
import { WASM_DEVICE_IDS } from '../../generated/device-catalog';

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<PlantWorkerRequest>) => void) | null;
  postMessage(msg: PlantWorkerResponse, transfer?: Transferable[]): void;
};

let wasmReady = false;

/** Device shells carrying only the knobs `syncWasmFocusKnobs` reads. */
function knobDevices(knobs: PlantKnobs): SessionDeviceMap {
  return {
    transformer: { physicsState: { transformerLeakage: !!knobs.transformerLeakage } as never },
    hall: {
      physicsState: {
        hallCarrierType: knobs.hallCarrierType,
        hallFieldCoupledT: knobs.hallFieldCoupledT ?? null
      } as never
    },
    'lorentz-sled': {
      physicsState: (knobs.lorentzFieldT != null ? { lorentzFieldT: knobs.lorentzFieldT } : {}) as never
    }
  };
}

function adoptOperator(msg: PlantWorkerStep): void {
  const op = msg.operator;
  segOperator.replayMode = false;
  segOperator.status = op.status;
  segOperator.isRunning = op.isRunning;
  segOperator.targetDrive = op.targetDrive;
  segOperator.magneticFieldStrength = op.magneticFieldStrength;
  segOperator.loadResistance = op.loadResistance;
  segOperator.physics = op.physics;
}

function step(msg: PlantWorkerStep): void {
  const t0 = performance.now();
  adoptOperator(msg);
  const useWasm = msg.useWasm && wasmReady;
  let plant: WasmModePlant | null = null;
  let rollers: Float32Array | null = null;

  if (useWasm) {
    // Same ladder the in-loop path runs — knobs, then operator + C++ plant per
    // substep. Non-SEG write-back lands in the throwaway knob shells; the main
    // thread applies the decoded plant to the real devices instead.
    applyWasmPlant({ devices: knobDevices(msg.knobs), focus: msg.focus, simSteps: msg.steps, drive: msg.drive });
    plant = segWasm.getModePlant() as WasmModePlant | null;
    if (msg.focus === 'seg' || msg.focus === 'overview') {
      plant = { ...plant, mode: 'seg', meanOmega: segWasm.lastRollerMeanOmega };
      rollers = segWasm.getRollerStateFloatView();
    }
  } else {
    for (const subDt of msg.steps) {
      if (subDt > 0) segOperator.step(subDt);
    }
  }

  const packed = packModePlant(plant, useWasm, WASM_DEVICE_IDS, rollers);
  const res: PlantWorkerResponse = {
    type: 'result',
    seq: msg.seq,
    status: segOperator.status,
    physics: segOperator.physics,
    plant: packed,
    hallCouplingIgnored: useWasm && hallCouplingIgnoredByWasm(),
    stepMs: performance.now() - t0
  };
  ctx.postMessage(res, [packed.buffer]);
}

ctx.onmessage = (e: MessageEvent<PlantWorkerRequest>) => {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === 'init') {
    const init = msg.wasm
      ? segWasm.init().then(() => {
          segWasm.setEnabled(true);
          wasmReady = segWasm.enabled;
        })
      : Promise.resolve();
    init
      .catch(() => { wasmReady = false; })
      .finally(() => ctx.postMessage({ type: 'ready', wasmAvailable: wasmReady }));
    return;
  }
  if (msg.type === 'step') {
    try {
      step(msg);
    } catch (err) {
      ctx.postMessage({
        type: 'error',
        seq: msg.seq,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
};
