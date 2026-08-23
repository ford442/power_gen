import { getAllSimDeviceIds } from '../../devices/device-registry.js';
import { isDeviceInCameraFrustum } from './view-lod.js';

export interface CullCamera {
  position?: number[];
  target?: number[];
  fov?: number;
}

export interface CullOpts {
  aspect?: number;
  radius?: number;
  margin?: number;
}

/**
 * View-based device visibility for multi-device renderers.
 * Overview shows all enabled devices; single-device focus shows only that device.
 */
export function isDeviceActive(
  currentView: string | null | undefined,
  devicesEnabled: Record<string, boolean> | null | undefined,
  deviceId: string
): boolean {
  if (!devicesEnabled?.[deviceId]) return false;
  if (!currentView || currentView === 'overview') return true;
  return currentView === deviceId;
}

/**
 * Whether a device should receive CPU update + GPU draw this frame.
 * In overview, off-frustum devices are skipped (conservative sphere test).
 * Focus mode always simulates the active device even near the camera edge.
 */
export function shouldSimulateDevice(
  currentView: string | null | undefined,
  devicesEnabled: Record<string, boolean> | null | undefined,
  deviceId: string,
  devicePos: number[] | null | undefined,
  camera: CullCamera | null | undefined,
  cullOpts: CullOpts = {}
): boolean {
  if (!isDeviceActive(currentView, devicesEnabled, deviceId)) return false;
  if (currentView && currentView !== 'overview') return true;
  if (!devicePos || !camera?.position) return true;
  return isDeviceInCameraFrustum(devicePos, camera as { position: number[]; target?: number[]; fov?: number }, cullOpts);
}

/**
 * Device ids in the multi-device simulation loop.
 * Prefer calling getAllSimDeviceIds() after register-plugins has run;
 * this snapshot is best-effort at module load.
 */
export const SIM_DEVICE_IDS = getAllSimDeviceIds();
