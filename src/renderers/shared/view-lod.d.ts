/** View LOD + frustum helpers (ADR-0005 WS4). */

export const OVERVIEW_PARTICLE_LOD: number;
export const OVERVIEW_MESH_LOD: number;
export const FOCUS_PARTICLE_LOD: number;
export const DEFAULT_DEVICE_CULL_RADIUS: number;
export const OVERVIEW_LAYOUT_RADIUS: number;

export type MeshDrawDetail = 'full' | 'simplified' | 'proxy' | 'skip';

export function getViewParticleLod(currentView: string, deviceId: string): number;
export function getViewMeshLod(currentView: string, qualityLevel: number): number;
export function getMeshDrawDetail(meshLod: number): MeshDrawDetail;
export function meshLodInstanceCount(fullCount: number, detail: MeshDrawDetail | string): number;
export function getDeviceParticleScale(opts: {
  currentView: string;
  deviceId: string;
  qualityLevel: number;
  explainerScale?: number;
}): number;
export function getOverviewCullOpts(opts?: {
  aspect?: number;
  radius?: number;
  margin?: number;
  layoutRadius?: number;
}): { aspect: number; margin: number; radius: number };
export function isDeviceInCameraFrustum(
  devicePos: number[],
  camera: { position: number[]; target?: number[]; fov?: number },
  opts?: { aspect?: number; radius?: number; margin?: number }
): boolean;
export function isCameraInsideSegRing(
  cameraPos: number[],
  segPos: number[],
  outerOrbitRadius: number
): boolean;
export function cullSegRollerInstances(
  totalRollers: number,
  cameraInside: boolean,
  enabled?: boolean
): number;
