/**
 * Plant snapshots (#224 §2) — the lab half: capture / restore the running
 * lab, replay keyframes, and replay take-over. Lazy chunk: `window.lab`
 * (config/lab-api.ts), the telemetry export panel and the replay bar import it
 * on first use, so none of this is in the entry bundle.
 *
 * A snapshot holds every JS device plant (through its `state` layout), the SEG
 * operator, the session clock and seed, the non-default LabConfig share
 * fields, and — when the C++ plant owns the focus device — its `plantSave`
 * vector, read from whichever sim_core instance steps it (in-loop, or the plant
 * worker via `plantSave` / `plantLoad` messages). See docs/SNAPSHOTS.md.
 *
 * Restoring bumps `segOperator.epoch` and cancels the plant worker first, so a
 * batch in flight from before the restore is dropped rather than applied over
 * it. Simulated, not metrology: a snapshot resumes this model's state.
 */
import { segOperator, OPERATOR_STATUS, type OperatorStatus } from '../seg-operator-state';
import { telemetryHub } from '../telemetry-hub';
import { getSimulationSeed, setSimulationSeed } from '../telemetry/deterministic-rng';
import { replayPlayer } from '../telemetry/replay-player';
import { replayStartS } from '../telemetry/replay-parse';
import type { ReplayKeyframe } from '../telemetry/replay-format';
import { segWasm } from '../wasm/seg-physics-bridge';
import { loadPlantState, savePlantState } from '../wasm/plant-state-io';
import { devicePhysics } from './apply-wasm-plant';
import { LabSession } from './lab-session';
import { workerLoadPlantState, workerSavePlantState } from './plant-worker-snapshot';
import {
  DEVICE_CATALOG_HASH,
  DEVICE_STATE_LAYOUT,
  PLANT_STATE_LAYOUT_HASH,
  SNAPSHOT_FORMAT,
  cppStateFromKeys,
  keysFromCppState,
  loadDeviceState,
  parsePlantSnapshot,
  saveDeviceState,
  type OperatorSnapshot,
  type PlantSnapshot,
  type SnapshotBackend
} from './plant-snapshot';

export type { PlantSnapshot } from './plant-snapshot';

/** Sample-clock seconds between replay keyframes while recording. */
export const KEYFRAME_PERIOD_S = 2;

/** `SEGOperatorState`'s smoothed outputs — private there, part of the plant here. */
interface OperatorInternals {
  _efficiency: number;
  _displayRpm: number;
  _displayField: number;
}

const STATUSES = Object.values(OPERATOR_STATUS) as string[];

/** Which plant steps the focus device right now (mirrors `LabSession.stepPlant`). */
function plantBackend(session: LabSession): SnapshotBackend {
  const replay = segOperator.replayMode || telemetryHub.isReplayMode();
  if (!segWasm.enabled || replay || session.wasmPlantError !== null) return 'js';
  return session.plantStats.backend === 'worker' && session.plantStats.wasmInWorker ? 'wasm-worker' : 'wasm';
}

/** The focus plant's C++ vector, from whichever sim_core instance steps it. */
async function saveCpp(session: LabSession, backend: SnapshotBackend, mode: number): Promise<Float32Array | null> {
  if (backend === 'wasm-worker') {
    const port = session.plantWorker?.snapshotPort();
    return port ? workerSavePlantState(port, mode) : null;
  }
  return backend === 'wasm' ? savePlantState(segWasm.rawSim(), mode) : null;
}

async function loadCpp(session: LabSession, backend: SnapshotBackend, mode: number, values: ArrayLike<number>): Promise<boolean> {
  if (backend === 'wasm-worker') {
    const port = session.plantWorker?.snapshotPort();
    return !!port && workerLoadPlantState(port, mode, values, PLANT_STATE_LAYOUT_HASH);
  }
  return backend === 'wasm' && loadPlantState(segWasm.rawSim(), mode, values, PLANT_STATE_LAYOUT_HASH);
}

function captureOperator(): OperatorSnapshot {
  const priv = segOperator as unknown as OperatorInternals;
  return {
    status: segOperator.status,
    isRunning: segOperator.isRunning,
    targetDrive: segOperator.targetDrive,
    magneticFieldStrength: segOperator.magneticFieldStrength,
    loadResistance: segOperator.loadResistance,
    totalEnergy: segOperator.totalEnergy,
    efficiency: priv._efficiency,
    displayRpm: priv._displayRpm,
    displayField: priv._displayField,
    physics: saveDeviceState('seg', segOperator.physics)
  };
}

function restoreOperator(op: OperatorSnapshot): void {
  const priv = segOperator as unknown as OperatorInternals;
  if (STATUSES.includes(op.status)) segOperator.status = op.status as OperatorStatus;
  segOperator.isRunning = op.isRunning;
  segOperator.targetDrive = op.targetDrive;
  segOperator.magneticFieldStrength = op.magneticFieldStrength;
  segOperator.loadResistance = op.loadResistance;
  segOperator.totalEnergy = op.totalEnergy;
  priv._efficiency = op.efficiency;
  priv._displayRpm = op.displayRpm;
  priv._displayField = op.displayField;
  loadDeviceState('seg', segOperator.physics, op.physics);
}

/** Inverse of the render loop's log slider map (0→0.05×, 50→1×, 100→20×). */
function restoreSpeed(speed: number): void {
  const slider = document.getElementById('speedControl') as HTMLInputElement | null;
  if (!slider || !(speed > 0)) return;
  const raw = 100 * Math.log(speed / 0.05) / Math.log(400);
  slider.value = String(Math.max(0, Math.min(100, Math.round(raw))));
  slider.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Non-default LabConfig share fields of the running lab (`{}` if that chunk fails to load). */
async function shareConfig(): Promise<Record<string, unknown>> {
  try {
    const [url, share] = await Promise.all([import('../seg-explainer/lab-url'), import('../config/share-url')]);
    return share.nonDefaultShareFields(url.captureShareConfig());
  } catch {
    return {};
  }
}

/** The running lab's plant state — `window.lab.captureSnapshot()`. */
export async function captureLabSnapshot(): Promise<PlantSnapshot> {
  // Await the (lazy) share-config capture first: everything after it up to
  // the C++ read is synchronous, so the plants, operator and clock are read
  // in one frame.
  const config = await shareConfig();
  const session = LabSession.active;
  const focus = session?.plantFocus() ?? 'seg';
  const backend = session ? plantBackend(session) : 'js';

  const devices: PlantSnapshot['devices'] = {};
  for (const [id, dev] of Object.entries(session?.devices ?? {})) {
    const phys = devicePhysics(dev);
    if (!phys || !DEVICE_STATE_LAYOUT[id]) continue;
    devices[id] = saveDeviceState(id, phys);
    // WebGPU solar keeps the live battery on the device, not physicsState.
    if (id === 'solar' && typeof dev.batteryCharge === 'number') devices[id].batteryCharge = dev.batteryCharge;
  }

  const snap: PlantSnapshot = {
    format: SNAPSHOT_FORMAT,
    version: 1,
    layoutHash: PLANT_STATE_LAYOUT_HASH,
    catalogHash: DEVICE_CATALOG_HASH,
    backend,
    focus,
    t: telemetryHub.getSimTimeS(),
    seed: getSimulationSeed(),
    config,
    devices,
    view: session?.currentView ?? 'overview',
    operator: captureOperator(),
    speed: session?.speedMult ?? 1
  };

  const mode = DEVICE_STATE_LAYOUT[focus]?.wasmMode ?? null;
  if (session && backend !== 'js' && mode !== null) {
    const values = await saveCpp(session, backend, mode);
    if (values) {
      snap.wasm = { mode, values: Array.from(values) };
      // The C++ plant owns the focus device: its vector is the truth (the
      // worker's is up to a frame ahead of what the device shows).
      if (devices[focus]) Object.assign(devices[focus], keysFromCppState(focus, values));
    } else {
      snap.backend = 'js';
    }
  }
  return snap;
}

/**
 * Put a snapshot back — `window.lab.restoreSnapshot(state)`. Resolves false
 * when the input is not a snapshot or the C++ plant refused its vector (the
 * JS plants, operator and clock are restored either way). The live loop
 * resumes stepping from the restored state on the next frame.
 *
 * The C++ focus plant loads the snapshot's own vector when the layout hash and
 * mode match; otherwise (a JS snapshot on a `?wasmPhysics=1` lab, or another
 * build's layout) its mapped fields are cross-loaded from the device keys over
 * the live plant's vector.
 */
export async function restoreLabSnapshot(input: unknown): Promise<boolean> {
  const { snapshot: snap, errors, warnings } = parsePlantSnapshot(input);
  if (!snap) {
    console.warn('[snapshot] not restored:', errors.join('; '));
    return false;
  }
  for (const w of warnings) console.warn('[snapshot]', w);
  const session = LabSession.active;
  if (!session) return false;

  if (replayPlayer.state.loaded) replayPlayer.exit();
  const view = snap.view ?? snap.focus;
  if (view !== session.currentView) {
    if (window.setMode) window.setMode(view);
    else session.setMode(view);
  }

  // Drop anything stepped from the pre-restore state.
  segOperator.epoch++;
  session.plantWorker?.cancel();

  if (snap.operator) restoreOperator(snap.operator);
  for (const [id, values] of Object.entries(snap.devices)) {
    const dev = session.devices[id];
    const phys = devicePhysics(dev);
    if (!dev || !phys || !DEVICE_STATE_LAYOUT[id]) continue;
    loadDeviceState(id, phys, values);
    if (id === 'solar' && typeof dev.batteryCharge === 'number' && typeof values.batteryCharge === 'number') {
      dev.batteryCharge = values.batteryCharge;
    }
  }
  if (snap.speed !== undefined) restoreSpeed(snap.speed);
  if (snap.seed !== null) setSimulationSeed(snap.seed, false);
  telemetryHub.setSimTimeS(snap.t);

  let ok = true;
  const focus = session.plantFocus();
  const layout = DEVICE_STATE_LAYOUT[focus];
  const backend = plantBackend(session);
  if (backend !== 'js' && layout?.wasmMode != null) {
    const mode = layout.wasmMode;
    const w = snap.wasm;
    const own = w && w.mode === mode && snap.layoutHash === PLANT_STATE_LAYOUT_HASH && w.values.length === layout.cppSize
      ? w.values
      : null;
    const values = own ?? cppStateFromKeys(focus, snap.devices[focus] ?? {}, await saveCpp(session, backend, mode));
    ok = !!values && (await loadCpp(session, backend, mode, values));
    // A worker batch may have been posted while we awaited: drop it too.
    segOperator.epoch++;
    session.plantWorker?.cancel();
  }
  session.publishModeTelemetry();
  return ok;
}

// ── replay keyframes ───────────────────────────────────────────────────────

let keyframes: ReplayKeyframe[] = [];
let recorderTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Take a snapshot every {@link KEYFRAME_PERIOD_S} of recorded time while the
 * telemetry sampler records (started by the export panel's Record button).
 * `t` is the sampler clock, the same `time_s` the replay samples carry.
 */
export function startKeyframeRecorder(): void {
  if (recorderTimer !== null) clearInterval(recorderTimer);
  keyframes = [];
  let nextT = 0;
  let busy = false;
  const tick = (): void => {
    if (!telemetryHub.isRecording()) {
      if (recorderTimer !== null) clearInterval(recorderTimer);
      recorderTimer = null;
      return;
    }
    const now = telemetryHub.sampler.simTimeS;
    if (busy || now < nextT) return;
    busy = true;
    nextT = now + KEYFRAME_PERIOD_S;
    void captureLabSnapshot()
      .then((snapshot) => {
        // Frames can run while the capture awaits its chunks: place the
        // keyframe at the sample time its plants were read (both clocks
        // advance by the same dt while recording).
        if (!telemetryHub.isRecording()) return;
        const sampleT = telemetryHub.sampler.simTimeS;
        const t = sampleT - (telemetryHub.getSimTimeS() - snapshot.t);
        keyframes.push({ t: Math.max(0, Math.min(sampleT, t)), snapshot });
      })
      .finally(() => { busy = false; });
  };
  recorderTimer = setInterval(tick, 100);
  tick();
}

/** Keyframes from the last recording (for `buildReplayFromRecording`). */
export function recordedKeyframes(): ReplayKeyframe[] {
  return keyframes.slice();
}

/**
 * Replay bar "Take over": restore the keyframe at or before the scrub cursor,
 * leave replay, and run live from there. Returns a status line.
 */
export async function takeOverReplay(): Promise<string> {
  const replay = replayPlayer.replay;
  const frames = replay?.keyframes ?? [];
  if (!replay || !frames.length) return 'This replay has no plant snapshot keyframes to take over from';
  const cursor = replayStartS(replay) + replayPlayer.state.t;
  let best: ReplayKeyframe | null = null;
  for (const k of frames) {
    // Keyframes come from a file: skip any without a finite time.
    if (!k || typeof k.t !== 'number' || !Number.isFinite(k.t)) continue;
    if (k.t <= cursor + 1e-6 && (!best || k.t > best.t)) best = k;
  }
  if (!best) return 'No snapshot keyframe at or before the cursor';
  replayPlayer.exit();
  const ok = await restoreLabSnapshot(best.snapshot);
  return ok
    ? `Took over from the t = ${best.t.toFixed(2)} s keyframe — live (simulated)`
    : `Restored the t = ${best.t.toFixed(2)} s keyframe partly — the C++ plant refused its vector`;
}
