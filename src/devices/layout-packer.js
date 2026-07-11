/**
 * Automatic overview layout for N devices on the multi-device floor.
 * Legacy devices keep hand-tuned positions; plugin devices without an
 * explicit position receive a slot on an outer ring.
 */

/** @typedef {{ position: [number,number,number], rotation: [number,number,number,number] }} LayoutSlot */

/**
 * Quaternion for rotation about Y so the device faces the origin.
 * @param {number} angleRad  Position angle on the layout ring (atan2(x,z)).
 */
export function yawTowardCenter(angleRad) {
  const yaw = angleRad + Math.PI;
  return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
}

/**
 * Pack devices that lack `position` into slots on a ring.
 *
 * @param {string[]} deviceIds  Ordered list of ids needing placement
 * @param {{ radius?: number, y?: number, startAngle?: number, slotSpan?: number }} [opts]
 * @returns {Record<string, LayoutSlot>}
 */
export function packOverviewLayout(deviceIds, opts = {}) {
  const radius = opts.radius ?? 18;
  const y = opts.y ?? 0;
  const startAngle = opts.startAngle ?? -Math.PI / 2;
  const slotSpan = opts.slotSpan ?? Math.PI * 2;
  const n = deviceIds.length;
  const out = {};

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
 *
 * @param {Record<string, object>} baseConfig
 * @param {{ radius?: number }} [packOpts]
 */
export function applyAutoLayout(baseConfig, packOpts = {}) {
  const needsLayout = Object.keys(baseConfig).filter((id) => !baseConfig[id].position);
  if (needsLayout.length === 0) return { ...baseConfig };

  const slots = packOverviewLayout(needsLayout, packOpts);
  const merged = { ...baseConfig };
  for (const id of needsLayout) {
    merged[id] = { ...merged[id], ...slots[id] };
  }
  return merged;
}
