/**
 * Automatic overview layout for N devices on the multi-device floor.
 * Legacy devices keep hand-tuned positions; plugin devices without an
 * explicit position receive a slot on an outer ring (default radius 20 m
 * via device-registry — see OVERVIEW_LAYOUT_RADIUS in view-lod.js).
 */

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

/**
 * Quaternion for rotation about Y so the device faces the origin.
 * @param angleRad  Position angle on the layout ring (atan2(x,z)).
 */
export function yawTowardCenter(angleRad: number): [number, number, number, number] {
  const yaw = angleRad + Math.PI;
  return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
}

/**
 * Pack devices that lack `position` into slots on a ring.
 *
 * @param deviceIds  Ordered list of ids needing placement
 */
export function packOverviewLayout(deviceIds: string[], opts: PackOverviewOpts = {}): Record<string, LayoutSlot> {
  const radius = opts.radius ?? 18;
  const y = opts.y ?? 0;
  const startAngle = opts.startAngle ?? -Math.PI / 2;
  const slotSpan = opts.slotSpan ?? Math.PI * 2;
  const n = deviceIds.length;
  const out: Record<string, LayoutSlot> = {};

  for (let i = 0; i < n; i++) {
    const angle = startAngle + (n <= 1 ? 0 : (i / n) * slotSpan);
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    out[deviceIds[i]] = {
      position: [x, y, z],
      rotation: yawTowardCenter(angle)
    };
  }
  return out;
}

/**
 * Merge base device config with auto-packed positions for entries missing `position`.
 */
export function applyAutoLayout<T extends Record<string, { position?: unknown }>>(
  baseConfig: T,
  packOpts: PackOverviewOpts = {}
): T {
  const needsLayout = Object.keys(baseConfig).filter((id) => !baseConfig[id].position);
  if (needsLayout.length === 0) return { ...baseConfig };

  const slots = packOverviewLayout(needsLayout, packOpts);
  const merged: Record<string, unknown> = { ...baseConfig };
  for (const id of needsLayout) {
    merged[id] = { ...(merged[id] as object), ...slots[id] };
  }
  return merged as T;
}
