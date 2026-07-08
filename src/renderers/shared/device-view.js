/**
 * View-based device visibility for multi-device renderers.
 * Overview shows all enabled devices; single-device focus shows only that device.
 */
export function isDeviceActive(currentView, devicesEnabled, deviceId) {
  if (!devicesEnabled?.[deviceId]) return false;
  if (!currentView || currentView === 'overview') return true;
  return currentView === deviceId;
}

/** Device ids that participate in the multi-device simulation loop. */
export const SIM_DEVICE_IDS = ['seg', 'heron', 'kelvin', 'solar', 'peltier', 'mhd'];
