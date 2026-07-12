/**
 * View-level LOD and cheap device visibility tests for multi-device scenes.
 *
 * Overview keeps every enabled device visible but at reduced particle/mesh
 * fidelity so mid-tier GPUs stay near 45+ FPS. Focus modes restore full
 * quality for the active device only.
 */

/** Particle count scale applied on top of auto-quality while in overview. */
export const OVERVIEW_PARTICLE_LOD = 0.48;

/** Layout / roller decimation floor while in overview (keeps rings readable). */
export const OVERVIEW_MESH_LOD = 0.62;

/** Focused device particle scale (full fidelity relative to quality tier). */
export const FOCUS_PARTICLE_LOD = 1.0;

/** Default bounding radius (world units) for device sphere culling. */
export const DEFAULT_DEVICE_CULL_RADIUS = 14;

/**
 * Extra particle LOD for a device given the current view.
 * @param {string} currentView
 * @param {string} deviceId
 * @returns {number} 0..1
 */
export function getViewParticleLod(currentView, deviceId) {
  if (!currentView || currentView === 'overview') return OVERVIEW_PARTICLE_LOD;
  if (currentView === deviceId) return FOCUS_PARTICLE_LOD;
  return 0;
}

/**
 * Mesh / SEG layout quality scale for the active view.
 * Focus SEG keeps full qualityLevel; overview caps mesh fidelity.
 * @param {string} currentView
 * @param {number} qualityLevel 0..1
 * @returns {number}
 */
export function getViewMeshLod(currentView, qualityLevel) {
  const q = Math.max(0, Math.min(1, qualityLevel));
  if (!currentView || currentView === 'overview') {
    return Math.min(q, OVERVIEW_MESH_LOD);
  }
  return q;
}

/**
 * Combined particle scale: auto-quality × view LOD × explainer cap.
 * @param {object} opts
 * @param {string} opts.currentView
 * @param {string} opts.deviceId
 * @param {number} opts.qualityLevel
 * @param {number} [opts.explainerScale=1]
 */
export function getDeviceParticleScale({
  currentView,
  deviceId,
  qualityLevel,
  explainerScale = 1
}) {
  const viewLod = getViewParticleLod(currentView, deviceId);
  if (viewLod <= 0) return 0;
  return Math.max(0.05, qualityLevel * viewLod * explainerScale);
}

/**
 * Sphere-vs-camera frustum test (conservative; false negatives avoided via margin).
 * @param {number[]} devicePos [x,y,z]
 * @param {{ position: number[], target?: number[], fov?: number }} camera
 * @param {{ aspect?: number, radius?: number, margin?: number }} [opts]
 * @returns {boolean}
 */
export function isDeviceInCameraFrustum(devicePos, camera, opts = {}) {
  if (!devicePos || !camera?.position) return true;

  const radius = opts.radius ?? DEFAULT_DEVICE_CULL_RADIUS;
  const aspect = Math.max(0.25, opts.aspect ?? 1.6);
  const margin = opts.margin ?? 1.35;

  const cx = camera.position[0];
  const cy = camera.position[1];
  const cz = camera.position[2];
  const dx = devicePos[0] - cx;
  const dy = devicePos[1] - cy;
  const dz = devicePos[2] - cz;
  const distSq = dx * dx + dy * dy + dz * dz;
  const dist = Math.sqrt(distSq);

  // Always keep devices that intersect the camera or are very close.
  if (dist < radius * 1.25) return true;

  const tx = (camera.target?.[0] ?? 0) - cx;
  const ty = (camera.target?.[1] ?? 0) - cy;
  const tz = (camera.target?.[2] ?? 0) - cz;
  const tLen = Math.hypot(tx, ty, tz) || 1;
  const fx = tx / tLen;
  const fy = ty / tLen;
  const fz = tz / tLen;

  const cosAngle = (dx * fx + dy * fy + dz * fz) / dist;
  const fovDeg = camera.fov ?? 45;
  const halfFov = (fovDeg * Math.PI) / 180 / 2;
  // Expand vertical FOV by aspect so horizontal edges are covered.
  const halfCone = Math.atan(Math.tan(halfFov) * Math.max(1, aspect)) * margin;
  return cosAngle > Math.cos(halfCone);
}

/**
 * Whether the camera sits inside the SEG roller ring (optional instance culling).
 * @param {number[]} cameraPos
 * @param {number[]} segPos device origin
 * @param {number} outerOrbitRadius world units
 * @returns {boolean}
 */
export function isCameraInsideSegRing(cameraPos, segPos, outerOrbitRadius) {
  if (!cameraPos || !segPos || !(outerOrbitRadius > 0)) return false;
  const dx = cameraPos[0] - segPos[0];
  const dz = cameraPos[2] - segPos[2];
  const radial = Math.hypot(dx, dz);
  const dy = Math.abs(cameraPos[1] - (segPos[1] || 0));
  return radial < outerOrbitRadius * 0.92 && dy < outerOrbitRadius * 0.55;
}

/**
 * Instance count for SEG rollers: when the camera is inside the ring, drop the
 * rear half of instances (rough backface / occupancy cull). Layout order is
 * angular, so striding by 2 keeps rings evenly populated.
 * @param {number} totalRollers
 * @param {boolean} cameraInside
 * @param {boolean} [enabled=true]
 */
export function cullSegRollerInstances(totalRollers, cameraInside, enabled = true) {
  if (!enabled || !cameraInside || totalRollers <= 4) return totalRollers;
  return Math.max(4, Math.floor(totalRollers * 0.55));
}
