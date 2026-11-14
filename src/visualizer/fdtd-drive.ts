// FDTD wave-slice gate + drive source for MultiDeviceVisualizer (ADR-0010 /
// ADR-0012). Moved out of multi-device-visualizer.ts for the 700-line cap;
// `MultiDeviceVisualizer.updateFdtdSlice` delegates here.
import { FdtdSlicePass } from '../devices/quanta/fdtd-slice-pass';
import { pulseCoilFdtdDrive, transformerFdtdDrive } from '../devices/quanta/pulse-coil';
import {
  FDTD_DRIVE_DEVICE,
  FDTD_DRIVE_SOURCES,
  FDTD_SLICE_OWNER,
  fdtdSliceGateOpen
} from '../physics/fdtd-tmz';
import { stepDevicePhysics, stepDevicePhysicsBatch } from '../renderers/shared/device-physics';
import type { DevicePhysicsState } from '../renderers/shared/device-physics';
import { telemetryHub } from '../telemetry-hub';
import { segWasm } from '../wasm/seg-physics-bridge';
import type { MultiDeviceVisualizer } from '../multi-device-visualizer.js';

type Host = MultiDeviceVisualizer;

/**
 * Per-frame FDTD wave slice gate + uniform upload (ADR-0010). The pass is
 * not built at boot: the first frame on which the gate would open starts
 * an async build, and the slice joins a few frames later. A failed build
 * disables the slice for the session.
 *
 * @returns the pass when it should dispatch and draw this frame, else null
 */
export function updateFdtdSlice(host: Host, qualityTier: string, deltaTime = 0): FdtdSlicePass | null {
  const owner = host.devices[FDTD_SLICE_OWNER];
  const frame = {
    enabled: host.fdtdEnabled && !!owner,
    currentView: host.currentView,
    qualityTier
  };
  if (host.fdtdSlice === undefined) {
    const wouldOpen = fdtdSliceGateOpen({ ...frame, ready: true });
    if (wouldOpen && !host._fdtdSliceInit && host.pipelineCache) {
      const pass = new FdtdSlicePass(host.device, host, {
        materialsEnabled: host.fdtdMaterialsEnabled
      });
      host._fdtdSliceInit = pass.init().then(
        (ok) => { host.fdtdSlice = ok ? pass : null; },
        (err) => {
          console.warn('[fdtd-slice] disabled — pipeline build failed', err);
          pass.destroy();
          host.fdtdSlice = null;
        }
      );
    }
    return null;
  }
  const pass = host.fdtdSlice;
  if (!pass || !owner) return null;
  return pass.update({
    ...frame,
    devicePos: owner.position,
    drive: fdtdDrive(host, owner, deltaTime)
  }) ? pass : null;
}

/**
 * Source amplitude for the slice (ADR-0012). Default: the pulse coil's own
 * discharge current. Under `?fdtdDrive=transformer`, the transformer bench's
 * normalised core flux instead — continuous AC, so the panel shows successive
 * fronts rather than one transient. If that bench isn't in the lab, fall back
 * to the coil rather than showing a dead panel.
 */
function fdtdDrive(
  host: Host,
  owner: { physicsState?: Partial<DevicePhysicsState> | null },
  deltaTime: number
): number {
  if (host.fdtdDriveSource === FDTD_DRIVE_SOURCES.TRANSFORMER) {
    const src = host.devices[FDTD_DRIVE_DEVICE.transformer];
    if (src?.physicsState) {
      stepBorrowedDrivePlant(host, src, deltaTime);
      return transformerFdtdDrive(src.physicsState);
    }
  }
  return pulseCoilFdtdDrive(owner.physicsState);
}

/**
 * Keep a *borrowed* drive device's plant running while the slice reads it.
 *
 * The render loop skips `device.update()` for every device that is not the
 * focused one (`getViewParticleLod` returns 0 off-focus), and the slice only
 * opens in pulse-coil focus. So borrowing the transformer's flux would read a
 * value frozen at whatever it held when the view changed — usually the 0 it was
 * created with, i.e. a dead panel rather than the AC fronts the flag promises.
 *
 * The slice declares an explicit dependency on that bench's plant, so step
 * exactly that: **physics only**, no particles, meshes, uniforms or GPU work.
 * One extra lumped-ODE step per frame, and only while `?fdtdDrive=` is actually
 * pointing somewhere else.
 *
 * No double-stepping: a device is either focused (and updated by the loop) or
 * borrowed here, never both, because the slice requires pulse-coil focus. The
 * WASM and replay paths already refresh every device's state each frame, so
 * they own it and this stands aside.
 */
function stepBorrowedDrivePlant(
  host: Host,
  src: { id: string; physicsState?: Partial<DevicePhysicsState> | null; speedMult?: number },
  deltaTime: number
): void {
  if (!(deltaTime > 0) || src.id === host.currentView) return;
  if (segWasm.enabled || telemetryHub.isReplayMode()) return;
  const state = src.physicsState as DevicePhysicsState | undefined;
  if (!state) return;
  // Same substeps and drive device-update.ts applies, so the borrowed bench
  // behaves exactly as it would if you were looking at it.
  const batch = host.plantBatch;
  if (batch) stepDevicePhysicsBatch(state, batch.simSteps, batch.drive);
  else stepDevicePhysics(state, deltaTime, Math.min(1, Math.log2((src.speedMult || 1) + 1) / Math.log2(21)));
}
