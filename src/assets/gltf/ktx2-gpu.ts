/**
 * Thin KTX2 → WebGPU compressed texture path (ADR-0003 parser-only).
 * Uses ktx-parse; no Basis/UASTC decoder, no scene engine.
 */
import { read } from 'ktx-parse';
import type { AdapterInfoSnapshot } from '../../webgpu-manager';
import type { GltfDoc } from './gltf-loader';

export type TextureCompressionKind = 'bc' | 'etc2' | 'astc' | 'none';

export const TEXTURE_COMPRESSION_FEATURES: Record<Exclude<TextureCompressionKind, 'none'>, GPUFeatureName> = {
  bc: 'texture-compression-bc',
  etc2: 'texture-compression-etc2',
  astc: 'texture-compression-astc'
};

const VK_TO_GPU: Partial<Record<number, { kind: Exclude<TextureCompressionKind, 'none'>; format: GPUTextureFormat }>> = {
  133: { kind: 'bc', format: 'bc1-rgba-unorm' },
  131: { kind: 'bc', format: 'bc1-rgba-unorm' },
  147: { kind: 'etc2', format: 'etc2-rgb8unorm' },
  151: { kind: 'etc2', format: 'etc2-rgba8unorm' },
  157: { kind: 'astc', format: 'astc-4x4-unorm' }
};

const UNORM_RGBA_VK = 37;

export function selectTextureCompression(
  gpu: { features: GPUSupportedFeatures } | null | undefined,
  adapterInfo?: Partial<AdapterInfoSnapshot> | null
): TextureCompressionKind {
  if (!gpu?.features) return 'none';
  if (adapterInfo?.fallback || adapterInfo?.software) return 'none';
  const order: Exclude<TextureCompressionKind, 'none'>[] = ['bc', 'astc', 'etc2'];
  for (const kind of order) {
    if (gpu.features.has(TEXTURE_COMPRESSION_FEATURES[kind])) return kind;
  }
  return 'none';
}

export function readBufferView(doc: GltfDoc, bufferViewIndex: number): Uint8Array {
  const bv = doc.json.bufferViews[bufferViewIndex];
  if (!bv) throw new Error(`[gltf] missing bufferView ${bufferViewIndex}`);
  const offset = bv.byteOffset || 0;
  const length = bv.byteLength;
  if (length == null) throw new Error(`[gltf] bufferView ${bufferViewIndex} missing byteLength`);
  return new Uint8Array(doc.bin, offset, length);
}

interface CompressedAlbedoMap {
  none?: number;
  bc?: number;
  etc2?: number;
  astc?: number;
}

function compressedAlbedoFromDoc(doc: GltfDoc): CompressedAlbedoMap | null {
  const root = doc.json.nodes?.[0]?.extras as { power_gen?: { compressedAlbedo?: CompressedAlbedoMap } } | undefined;
  const map = root?.power_gen?.compressedAlbedo;
  return map && typeof map === 'object' ? map : null;
}

export interface UploadedGltfAlbedo {
  texture: GPUTexture;
  kind: TextureCompressionKind;
  format: GPUTextureFormat;
}

function copyBytesPerRow(blockBytes: number, widthBlocks: number): number {
  const raw = blockBytes * widthBlocks;
  return Math.max(256, Math.ceil(raw / 256) * 256);
}

function uploadLevel(
  device: GPUDevice,
  format: GPUTextureFormat,
  width: number,
  height: number,
  levelData: Uint8Array,
  blockW: number,
  blockH: number,
  blockBytes: number
): GPUTexture {
  const texture = device.createTexture({
    label: `gltf-albedo-${format}`,
    size: { width, height },
    format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
  });
  const widthBlocks = Math.ceil(width / blockW);
  const heightBlocks = Math.ceil(height / blockH);
  const bytesPerRow = copyBytesPerRow(blockBytes, widthBlocks);
  const padded = new Uint8Array(bytesPerRow * heightBlocks);
  const srcRow = blockBytes * widthBlocks;
  for (let row = 0; row < heightBlocks; row++) {
    const src = levelData.subarray(row * srcRow, row * srcRow + srcRow);
    padded.set(src, row * bytesPerRow);
  }
  device.queue.writeTexture(
    { texture },
    padded,
    { bytesPerRow, rowsPerImage: heightBlocks },
    { width, height }
  );
  return texture;
}

function uploadFromKtx2(device: GPUDevice, bytes: Uint8Array): UploadedGltfAlbedo {
  const container = read(bytes);
  const level = container.levels[0];
  if (!level) throw new Error('[gltf] KTX2 has no mip levels');
  const w = container.pixelWidth;
  const h = container.pixelHeight;
  if (container.vkFormat === UNORM_RGBA_VK) {
    return {
      texture: uploadLevel(device, 'rgba8unorm', w, h, level.levelData, 1, 1, 4),
      kind: 'none',
      format: 'rgba8unorm'
    };
  }
  const mapped = VK_TO_GPU[container.vkFormat];
  if (!mapped) {
    throw new Error(`[gltf] unsupported KTX2 vkFormat ${container.vkFormat}`);
  }
  const block = mapped.format.startsWith('astc') ? 16 : 8;
  const blockDim = 4;
  return {
    texture: uploadLevel(device, mapped.format, w, h, level.levelData, blockDim, blockDim, block),
    kind: mapped.kind,
    format: mapped.format
  };
}

/**
 * Upload stand albedo using negotiated BC/ETC2/ASTC, or uncompressed KTX2 fallback.
 */
export function uploadGltfCompressedAlbedo(
  device: GPUDevice,
  doc: GltfDoc,
  adapterInfo?: Partial<AdapterInfoSnapshot> | null
): UploadedGltfAlbedo | null {
  const images = doc.json.images;
  if (!images?.length) return null;
  const map = compressedAlbedoFromDoc(doc);
  const kind = selectTextureCompression(device, adapterInfo);
  const imageIndex = map
    ? (kind === 'none' ? map.none : map[kind])
    : 0;
  if (imageIndex == null || !images[imageIndex]) {
    const fallback = map?.none != null ? images[map.none] : images[0];
    if (!fallback?.bufferView && fallback?.bufferView !== 0) return null;
    const bytes = readBufferView(doc, fallback.bufferView);
    return uploadFromKtx2(device, bytes);
  }
  const img = images[imageIndex];
  if (img.bufferView == null) return null;
  try {
    return uploadFromKtx2(device, readBufferView(doc, img.bufferView));
  } catch (err) {
    console.warn('[gltf] compressed albedo upload failed, trying uncompressed', err);
    if (map?.none != null && map.none !== imageIndex) {
      const fb = images[map.none];
      if (fb?.bufferView != null) {
        return uploadFromKtx2(device, readBufferView(doc, fb.bufferView));
      }
    }
    return null;
  }
}
