/**
 * Core apparatus dashboard layout — owned by the device layer.
 *
 * Positions, particle budgets, camera offsets, and SEG core geometry live here.
 * UI modules (debug-panel) may import this; the reverse must never happen.
 *
 * Entries are mutable: layout preset changes patch `DEVICE_CONFIG.seg.cameraOffset`
 * in place. Registry merge preserves these object references so focus-camera
 * reads see the update without cache invalidation.
 */

/** SEG enhanced-core mesh parameters (shaft / plate / bolts). */
export interface SegCoreGeometryConfig {
  shaftRadius: number;
  shaftHeight: number;
  coreRadius: number;
  coreHeight: number;
  plateRadius: number;
  plateThickness: number;
  plateY: number;
  boltCount: number;
  boltRadius: number;
  boltHeight: number;
  baseColor: [number, number, number];
  coreColor: [number, number, number];
  glowColor: [number, number, number];
}

/**
 * Per-device floor layout + viz defaults.
 * `rotation` is either Euler XYZ (length 3) or quaternion XYZW (length 4).
 */
export interface DeviceDashboardEntry {
  position: [number, number, number];
  rotation: number[];
  cameraOffset: number[];
  particleCount: number;
  color: [number, number, number];
  cullRadius?: number;
  core?: SegCoreGeometryConfig;
}

/** Plugin `defaults` may omit position (auto-layout fills it). */
export type DeviceDashboardDefaults = Partial<DeviceDashboardEntry>;

export const CORE_DEVICE_IDS = ['seg', 'heron', 'kelvin', 'solar', 'peltier', 'mhd'] as const;
export type CoreDeviceId = (typeof CORE_DEVICE_IDS)[number];

export const DEVICE_CONFIG: Record<CoreDeviceId, DeviceDashboardEntry> = {
  seg: {
    position: [0, 0, -8],
    rotation: [0, 0, 0, 1],
    cameraOffset: [0, 3, 8],
    particleCount: 10000,
    color: [0.0, 0.9, 1.0],
    core: {
      shaftRadius: 0.5,
      shaftHeight: 6.0,
      coreRadius: 1.2,
      coreHeight: 3.0,
      plateRadius: 3.0,
      plateThickness: 0.3,
      plateY: 2.5,
      boltCount: 24,
      boltRadius: 0.08,
      boltHeight: 0.25,
      baseColor: [0.53, 0.6, 0.67],
      coreColor: [0.0, 0.8, 0.9],
      glowColor: [0.0, 0.9, 1.0]
    }
  },
  heron: {
    position: [-7, 0, 4],
    rotation: [0, Math.PI / 6, 0],
    cameraOffset: [0, 4, 8],
    particleCount: 10000,
    color: [0.0, 0.6, 1.0]
  },
  kelvin: {
    position: [7, 0, 4],
    rotation: [0, -Math.PI / 6, 0],
    cameraOffset: [0, 4, 8],
    particleCount: 10000,
    color: [0.8, 0.5, 1.0]
  },
  solar: {
    position: [0, 0, 8],
    rotation: [0, 0, 0],
    cameraOffset: [0, 4, 10],
    particleCount: 10000,
    color: [1.0, 0.9, 0.2]
  },
  peltier: {
    position: [15, 0, -15],
    rotation: [0, Math.PI / 4, 0],
    cameraOffset: [0, 4, 15],
    particleCount: 12000,
    color: [0.2, 0.9, 0.4]
  },
  mhd: {
    position: [-15, 0, -15],
    rotation: [0, -Math.PI / 4, 0],
    cameraOffset: [0, 5, 18],
    particleCount: 14000,
    color: [0.7, 0.6, 0.8]
  }
};
