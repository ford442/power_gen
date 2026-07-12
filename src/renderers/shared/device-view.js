import { getAllSimDeviceIds } from '../../devices/device-registry.js';
import { isDeviceInCameraFrustum } from './view-lod.js';

/**
 * View-based device visibility for multi-device renderers.
 * Overview shows all enabled devices; single-device focus shows only that device.
 */
export function isDeviceActive(currentView, devicesEnabled, deviceId) {
  if (!devicesEnabled?.[deviceId]) return false;
  if (!currentView || currentView === 'overview') return true;
  return currentView === deviceId;
}

/**
 * Whether a device should receive CPU update + GPU draw this frame.
 * In overview, off-frustum devices are skipped (conservative sphere test).
 * Focus mode always simulates the active device even near the camera edge.
 *
 * @param {string} currentView
 * @param {Record<string, boolean>} devicesEnabled
 * @param {string} deviceId
 * @param {number[] | null | undefined} devicePos
 * @param {{ position?: number[], target?: number[], fov?: number } | null} camera
 * @param {{ aspect?: number, radius?: number, margin?: number }} [cullOpts]
 */
export function shouldSimulateDevice(
  currentView,
  devicesEnabled,
  deviceId,
  devicePos,
  camera,
  cullOpts = {}
) {
  if (!isDeviceActive(currentView, devicesEnabled, deviceId)) return false;
  if (currentView && currentView !== 'overview') return true;
  if (!devicePos || !camera?.position) return true;
  return isDeviceInCameraFrustum(devicePos, camera, cullOpts);
}

/** Device ids that participate in the multi-device simulation loop. */
export const SIM_DEVICE_IDS = getAllSimDeviceIds();
