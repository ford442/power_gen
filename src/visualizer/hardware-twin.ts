// Hardware digital twin snapshot helper (CPU sync lives on LabSession).
import { HardwareBridge } from '../hardware-bridge';
import type { HardwareTwinTelemetry } from '../telemetry/types';

/**
 * Build hub-facing hardware twin snapshot (includes shadowResidual).
 */
export function buildHardwareTwinTelemetry(
  hw: HardwareBridge | null | undefined
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
    }
  };
}
