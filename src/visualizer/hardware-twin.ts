// Hardware digital twin snapshot helper (CPU sync lives on LabSession).
import { HardwareBridge } from '../hardware-bridge';
import type { HardwareTwinEstimate, HardwareTwinTelemetry } from '../telemetry/types';
import type { SessionTwin } from '../twin/session-twin';

function estimateTelemetry(twin: SessionTwin | null | undefined): HardwareTwinEstimate | null {
  const host = twin?.host;
  if (!twin || twin.state !== 'ready' || !host || !(host.estimate.updates > 0)) return null;
  const e = host.estimate;
  const w = e.window;
  const perDof = w.dof > 0 ? 1 / w.dof : NaN;
  const rpmPer = 30 / Math.PI;
  return {
    rpm: e.x[0] * rpmPer,
    rpmSd: Math.sqrt(Math.max(0, e.P[0])) * rpmPer,
    currentA: e.x[1],
    currentSd: Math.sqrt(Math.max(0, e.P[3])),
    innovation: { rpm: e.nu[0] / e.nuSigma[0], current: e.nu[1] / e.nuSigma[1], voltage: e.nu[2] / e.nuSigma[2] },
    nisPerDof: w.nis * perDof,
    chi2LoPerDof: w.lo * perDof,
    chi2HiPerDof: w.hi * perDof,
    consistent: w.consistent,
    diagnosis: w.diagnosis,
    updates: e.updates,
    calibrated: twin.profile !== null,
    calibration: twin.calibration.phase
  };
}

/**
 * Build hub-facing hardware twin snapshot (shadowResidual + the estimator).
 */
export function buildHardwareTwinTelemetry(
  hw: HardwareBridge | null | undefined,
  twin?: SessionTwin | null
): HardwareTwinTelemetry | null {
  if (!hw?.isConnected) return null;
  const connectionState = hw.connectionKind as HardwareTwinTelemetry['connectionState'];
  const twinMode = hw.twinMode as HardwareTwinTelemetry['twinMode'];
  return {
    connected: true,
    mock: !!hw.isMock,
    connectionState,
    twinMode,
    sensorRpm: HardwareBridge.sanitizeRpm(hw.actualRpm),
    sensorPhase: hw.actualPhase,
    sensorVoltage: hw.actualVoltage ?? 0,
    sensorCurrent: hw.actualCurrent ?? 0,
    shadowResidual: {
      phaseErrorDeg: hw.shadow.phaseErrorDeg,
      rpmError: hw.shadow.rpmError,
      voltageError: hw.shadow.voltageError ?? 0,
      currentError: hw.shadow.currentError ?? 0
    },
    firmwareProtocol: hw.firmware?.protocol ?? null,
    sampleClock: hw.sampleClock.source,
    estimate: estimateTelemetry(twin)
  };
}
