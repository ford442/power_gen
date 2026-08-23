/** Ambient types for overview auto-layout (implementation stays JS). */

export interface LayoutSlot {
  position: [number, number, number];
  rotation: [number, number, number, number];
}

export interface PackOverviewOpts {
  radius?: number;
  y?: number;
  startAngle?: number;
  slotSpan?: number;
}

export function yawTowardCenter(angleRad: number): [number, number, number, number];

export function packOverviewLayout(
  deviceIds: string[],
  opts?: PackOverviewOpts
): Record<string, LayoutSlot>;

export function applyAutoLayout<T extends Record<string, { position?: unknown }>>(
  baseConfig: T,
  packOpts?: PackOverviewOpts
): T;
