/** Ambient types for SEG frame assembly (implementation stays JS). */

export type SegFrameLevel = 'off' | 'minimal' | 'full';

export const SEG_FRAME_LEVELS: {
  off: 'off';
  minimal: 'minimal';
  full: 'full';
};

export interface FrameDimensions {
  plateY: number;
  baseTopY: number;
  baseBottomY: number;
  standHeight: number;
  statorH: number;
  [key: string]: number;
}

export function parseSegFrameLevel(params?: URLSearchParams): SegFrameLevel;

export function computeFrameDimensions(layout: unknown): FrameDimensions;

export function buildLabBenchMesh(dims: FrameDimensions): unknown;
export function buildStructuralFrameMesh(dims: FrameDimensions, level: SegFrameLevel): unknown;
export function buildControlBoxMesh(dims: FrameDimensions): unknown;
export function buildSafetyCageMesh(dims: FrameDimensions): unknown;

export function createSegFrameBuffers(
  device: GPUDevice,
  layout: unknown,
  level?: SegFrameLevel
): {
  labBench?: { vertexBuffer: GPUBuffer; indexBuffer: GPUBuffer; indexCount: number } | null;
  structural?: { vertexBuffer: GPUBuffer; indexBuffer: GPUBuffer; indexCount: number } | null;
  controlBox?: { vertexBuffer: GPUBuffer; indexBuffer: GPUBuffer; indexCount: number } | null;
  safetyCage?: { vertexBuffer: GPUBuffer; indexBuffer: GPUBuffer; indexCount: number } | null;
  dims?: FrameDimensions;
};

export function makeFrameInstanceBuffer(
  device: GPUDevice,
  materialRole?: number,
  color?: number[]
): GPUBuffer;

export function frameVibrationOffset(
  segOmega: number,
  statorH: number
): [number, number, number];
