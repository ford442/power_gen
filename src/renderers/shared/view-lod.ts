/**
 * View-level LOD and cheap device visibility tests for multi-device scenes.
 *
 * Overview keeps every enabled device visible but at reduced particle/mesh
 * fidelity so mid-tier GPUs stay near 45+ FPS. Focus modes restore full
 * quality for the active device only.
 *
 * Plugin overview ring radius is 20 m (`layout-packer` / registry) — cull
 * sphere defaults are sized for that layout (ADR-0005 WS4).
 */

/** Particle count scale applied on top of auto-quality while in overview. */
export const OVERVIEW_PARTICLE_LOD = 0.48;

/** Layout / roller decimation floor while in overview (keeps rings readable). */
export const OVERVIEW_MESH_LOD = 0.62;

/** Focused device particle scale (full fidelity relative to quality tier). */
export const FOCUS_PARTICLE_LOD = 1.0;

/**
 * Default bounding radius (world units) for device sphere culling.
 * Sized for the auto-layout ring (radius 20) so off-camera plugins skip.
 */
export const DEFAULT_DEVICE_CULL_RADIUS = 16;

/** Matches `applyAutoLayout(..., { radius: 20 })` in device-registry. */
export const OVERVIEW_LAYOUT_RADIUS = 20;

export type MeshDrawDetail = 'full' | 'simplified' | 'proxy' | 'skip';

/** Extra particle LOD for a device given the current view (0..1). */
export function getViewParticleLod(currentView: string | null | undefined, deviceId: string): number {
  if (!currentView || currentView === 'overview') return OVERVIEW_PARTICLE_LOD;
  if (currentView === deviceId) return FOCUS_PARTICLE_LOD;
  return 0;
}

/**
 * Mesh / SEG layout quality scale for the active view.
 * Focus SEG keeps full qualityLevel; overview caps mesh fidelity.
 */
export function getViewMeshLod(currentView: string | null | undefined, qualityLevel: number): number {
  const q = Math.max(0, Math.min(1, qualityLevel));
  if (!currentView || currentView === 'overview') {
    return Math.min(q, OVERVIEW_MESH_LOD);
  }
  return q;
}

/** Overview / quality mesh draw ladder for non-SEG cylinder meshes. */
export function getMeshDrawDetail(meshLod: number): MeshDrawDetail {
  const m = Math.max(0, Math.min(1, meshLod));
  if (m >= 0.55) return 'full';
  if (m >= 0.35) return 'simplified';
  if (m >= 0.18) return 'proxy';
  return 'skip';
}

/** Instance count after mesh LOD (CPU prefix — draw first N instances). */
export function meshLodInstanceCount(fullCount: number, detail: MeshDrawDetail | string): number {
  const n = Math.max(0, fullCount | 0);
  if (n <= 0 || detail === 'skip') return 0;
  if (detail === 'full') return n;
  if (detail === 'simplified') return Math.max(1, Math.ceil(n * 0.5));
  // proxy — single bounding silhouette (or 2 for readability)
  return Math.min(n, Math.max(1, Math.min(2, n)));
}

/**
 * Combined particle scale: auto-quality × view LOD × explainer cap.
 * Prefer resolveScaledParticleCount from particle-budgets.js when a
 * tier budget is available; this remains for callers that only need a scale.
 */
export function getDeviceParticleScale(opts: {
  currentView: string;
  deviceId: string;
  qualityLevel: number;
  explainerScale?: number;
}): number {
  const { currentView, deviceId, qualityLevel, explainerScale = 1 } = opts;
  const viewLod = getViewParticleLod(currentView, deviceId);
  if (viewLod <= 0) return 0;
  return Math.max(0.05, qualityLevel * viewLod * explainerScale);
}

/** Cull options for overview frustum tests (plugin ring aware). */
export function getOverviewCullOpts(opts: {
  aspect?: number;
  radius?: number;
  margin?: number;
  layoutRadius?: number;
} = {}): { aspect: number; margin: number; radius: number } {
  const layoutRadius = opts.layoutRadius ?? OVERVIEW_LAYOUT_RADIUS;
  // Sphere must cover device extent on the layout ring without false-culling.
  const radius = opts.radius ?? Math.max(DEFAULT_DEVICE_CULL_RADIUS, layoutRadius * 0.8);
  return {
    aspect: opts.aspect ?? 1.6,
    margin: opts.margin ?? 1.35,
    radius
  };
}

/**
 * Sphere-vs-camera frustum test (conservative; false negatives avoided via margin).
 */
export function isDeviceInCameraFrustum(
  devicePos: number[],
  camera: { position: number[]; target?: number[]; fov?: number },
  opts: { aspect?: number; radius?: number; margin?: number } = {}
): boolean {
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

/** Coarsest GPU particle LOD level. Level L keeps `baseCount >> L` particles. */
export const OVERVIEW_LOD_MAX = 3;

/**
 * Camera distances (world units) at which the overview particle LOD steps down.
 * Entry i is the distance at which level i+1 takes over.
 */
export const OVERVIEW_LOD_DISTANCES = [22, 38, 60];

/**
 * Particles kept at a LOD level — mirrors `overviewLodCount` in
 * `shaders/common/overview-lod.wgsl`. Both the cull pass (draw-indirect
 * instance count) and the particle compute pass (integration threshold) use
 * this ladder, so a device never draws particles that were not integrated.
 */
export function overviewLodParticleCount(baseCount: number, lodLevel: number): number {
  const base = Math.max(0, Math.floor(baseCount) | 0);
  const lod = Math.max(0, Math.min(OVERVIEW_LOD_MAX, Math.floor(lodLevel) | 0));
  return base >>> lod;
}

/**
 * Per-device LOD level for the GPU particle path.
 *
 * This is the only per-frame CPU particle math left in overview: one distance
 * plus a quality bias, versus the full `resolveScaledParticleCount` ladder.
 * The value is uploaded once per device (compute uniform + cull bounds entry),
 * and the GPU derives both the integration threshold and the draw count.
 */
export function overviewLodLevel(opts: {
  devicePos: number[];
  cameraPos: number[];
  qualityLevel?: number;
  focused?: boolean;
}): number {
  const { devicePos, cameraPos, qualityLevel = 1, focused = false } = opts;
  if (focused) return 0;
  if (!devicePos || !cameraPos) return 0;

  const dist = Math.hypot(
    devicePos[0] - cameraPos[0],
    (devicePos[1] || 0) - (cameraPos[1] || 0),
    devicePos[2] - cameraPos[2]
  );

  let level = 0;
  for (const edge of OVERVIEW_LOD_DISTANCES) {
    if (dist > edge) level += 1;
  }

  // Auto-quality pushes the whole ring one or two steps coarser.
  const q = Math.max(0, Math.min(1, qualityLevel));
  if (q < 0.4) level += 2;
  else if (q < 0.7) level += 1;

  return Math.max(0, Math.min(OVERVIEW_LOD_MAX, level));
}

/**
 * Whether the camera sits inside the SEG roller ring (optional instance culling).
 */
export function isCameraInsideSegRing(
  cameraPos: number[],
  segPos: number[],
  outerOrbitRadius: number
): boolean {
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
 */
export function cullSegRollerInstances(
  totalRollers: number,
  cameraInside: boolean,
  enabled = true
): number {
  if (!enabled || !cameraInside || totalRollers <= 4) return totalRollers;
  return Math.max(4, Math.floor(totalRollers * 0.55));
}
