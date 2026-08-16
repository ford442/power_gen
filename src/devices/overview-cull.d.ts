/** GPU overview frustum cull → draw-indirect (ADR-0005 WS4). */

export const BOUNDS_STRIDE: number;
export const DRAW_ARGS_STRIDE: number;
export const CULL_OUTPUT_HEADER_BYTES: number;
export const CULL_UNIFORM_BYTES: number;
export const PARTICLE_VERTEX_COUNT: number;
export const CULL_FLAG_ENABLED: number;

export interface CullSlotInput {
  id: string;
  position: number[];
  radius: number;
  baseCount: number;
  lodLevel: number;
  enabled: boolean;
}

export interface CullSlotOptions {
  devices: Array<{
    id: string;
    position: number[];
    particleCount?: number;
    config?: { plugin?: unknown; cullRadius?: number };
  }>;
  cameraPos: number[];
  currentView: string;
  qualityLevel: number;
  qualityTier?: string;
  defaultRadius?: number;
  isEnabled?: (device: { id: string }) => boolean;
}

export function packDeviceBounds(slots: CullSlotInput[], out?: Float32Array): Float32Array;
export function expectedInstanceCount(slot: CullSlotInput): number;
export function buildCullSlots(opts: CullSlotOptions): CullSlotInput[];

export class OverviewCullPass {
  constructor(device: GPUDevice, visualizer: unknown, opts?: { capacity?: number });
  readonly capacity: number;
  readonly slots: CullSlotInput[];
  deviceCount: number;
  ready: boolean;
  active: boolean;
  slotIndex: Map<string, number>;
  drawArgsBuffer: GPUBuffer | null;
  outputBuffer: GPUBuffer | null;
  init(pipeline: GPUComputePipeline): boolean;
  drawArgsOffset(deviceId: string): number;
  lodLevelFor(deviceId: string): number;
  update(opts: CullSlotOptions & { viewProj: Float32Array; margin?: number }): number;
  setInactive(): void;
  dispatch(computePass: GPUComputePassEncoder): boolean;
  destroy(): void;
}
