/**
 * Shared protocol constants/helpers for hardware-bridge.ts, mock-serial-transport.ts
 * and hardware-bridge-protocol.ts. Kept dependency-free so none of those three files
 * form an import cycle with each other.
 *
 * Protocol: docs/hardware_connection.md / firmware/seg-driver/protocol.h
 */

/** Twin / digital-twin operating modes */
export const TWIN_MODES = {
  OPEN: 'open',
  CLOSED: 'closed',
  SHADOW: 'shadow'
} as const;

export type TwinMode = (typeof TWIN_MODES)[keyof typeof TWIN_MODES];

export const MODE_RUN = 0;
export const MODE_BRAKE = 1;
export const MODE_COAST = 2;

/** Protocol RPM limits (docs/hardware_connection.md). */
export const RPM_MIN = -999.9;
export const RPM_MAX = 999.9;

export function finiteNum(n: unknown, fallback = 0): number {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

export function clampRpm(rpm: unknown): number {
  return Math.max(RPM_MIN, Math.min(RPM_MAX, finiteNum(rpm, 0)));
}

export function clampPwmDuty(duty: unknown): number {
  return Math.max(0, Math.min(1, finiteNum(duty, 0)));
}

export function pwmDutyToWire(duty: number): number {
  return Math.round(clampPwmDuty(duty) * 255);
}
